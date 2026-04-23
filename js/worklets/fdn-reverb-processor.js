/**
 * FDN Reverb AudioWorklet Processor
 *
 * 4-channel Feedback Delay Network reverb with fast-path-on-silence.
 *
 * Replaces the 6 Tone.js reverbs used by Cypress, Village Pulse, Wind Harp,
 * Celestial Strings, and the two shared send/return reverbs (sharedReverb 3s,
 * sharedDeepReverb 12s). Night Sky's multi-tap reverb stays as-is.
 *
 * Architecture adapted from Paul Adenot's padenot/fdn-reverb (Rust):
 *   input → preDelay → [LPF → Allpass → Delay → softclip] × 4 → Hadamard4 → feedback
 *
 *   stereo output = dry*input + wet*(feedback[0..3] summed as L/R pairs)
 *   mid-side widening applied last.
 *
 * DSP primitives from Signalsmith Audio (Hadamard, Householder references) and
 * padenot's fdn-reverb crate (allpass, one-pole LPF, delay line, process loop).
 *
 * Parameter interface: postMessage only (no parameterDescriptors — per padenot
 * "more efficient to NOT use AudioParam if not necessary" and Primozic's
 * AudioWorklet optimization post). Main thread sends
 *   { type: 'params', size, decay, damping, drywet, hardness }
 * when values change; per-sample one-pole smoothing inside process() handles
 * zipper avoidance.
 *
 * Fast-path-on-silence: three-tier. Input RMS + periodic state energy check
 * + T60 grace period. Below 1e-4 amplitude (~-80 dBFS) for all three, zero
 * the output buffer and skip the DSP loop.
 *
 * See docs/phase2-fdn-reverb-design-2026-04-13.md for the full design rationale.
 */

const CHANNELS = 4;
const MAX_PRE_DELAY_MS = 200;
const MAX_DELAY_SECONDS = 2.0;     // 22050 Hz × 2s = 44100 samples per delay line
const MAX_ALLPASS_SECONDS = 0.1;   // short allpass diffusers
const SILENCE_THRESHOLD = 1e-4;    // ~-80 dBFS
const STATE_CHECK_INTERVAL_QUANTA = 32;  // ~186 ms at 22050 Hz
const GRACE_SECONDS = 10;          // keep running this long after last non-silent input
// Headroom compensation for the 4-tap pre-decay wet output. Without it the
// per-instance wet level is ~2.5× the legacy 2-tap-post-decay form, which
// stacks badly when all 5 regions sum into the master limiter. 0.6 brings
// the effective boost to ~1.5× — louder than the original but with master
// headroom intact. Tune by ear; promote to per-preset if regions diverge.
const WET_OUTPUT_GAIN = 0.5;

// ── Math helpers ────────────────────────────────────────────────────────────

function gcd(a, b) {
  a = a | 0; b = b | 0;
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/**
 * Find `count` coprime integers in a geometric progression, starting near `base`
 * with approximate ratio `ratio`. Used to generate delay line lengths that
 * avoid resonant artifacts from matching frequencies.
 */
function coprimeProgression(base, ratio, count) {
  const result = new Int32Array(count);
  let target = Math.max(2, base | 0);
  // Make the first value odd to give more coprime candidates
  if (target % 2 === 0) target++;
  result[0] = target;
  for (let i = 1; i < count; i++) {
    let next = Math.round(result[i - 1] * ratio);
    if (next <= result[i - 1]) next = result[i - 1] + 1;
    // Walk up to next coprime with all previous entries.
    // Walk by 1 (not 2) — walking by 2 preserves parity, so if a previous
    // entry is even, we'd never find a coprime even with small odd numbers.
    let safety = 0;
    while (safety++ < 500) {
      let ok = true;
      for (let j = 0; j < i; j++) {
        if (gcd(next, result[j]) !== 1) { ok = false; break; }
      }
      if (ok) break;
      next++;
    }
    result[i] = next;
  }
  return result;
}

// ── Processor ───────────────────────────────────────────────────────────────

class FDNReverbProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // AudioWorkletGlobalScope provides `sampleRate`
    const sr = sampleRate;
    this.sr = sr;

    // Initial parameters from processorOptions — synchronously available in
    // the constructor, bypassing the port-message race that can lose early
    // postMessage calls in OfflineAudioContext.
    const opts = (options && options.processorOptions) || {};
    // Diagnostic label for debug logging — passed via processorOptions so we
    // can tell which FDN instance is which in the console.
    this._diagLabel = opts._diagLabel || 'fdn';
    this._diagFirstInputLogged = false;
    this._diagFirstOutputLogged = false;

    // ── Pre-delay buffer ──
    const preDelayMax = Math.ceil((MAX_PRE_DELAY_MS / 1000) * sr);
    this.preDelayBuf = new Float32Array(preDelayMax);
    this.preDelayBufLen = preDelayMax;
    this.preDelayIdx = 0;
    this.preDelayLen = Math.max(1, Math.round(0.015 * sr)); // default 15 ms

    // ── Main feedback delay lines (N=4) ──
    const maxDelaySamples = Math.ceil(MAX_DELAY_SECONDS * sr);
    this.delayBufs = new Array(CHANNELS);
    this.delayLens = new Int32Array(CHANNELS);
    this.delayIdx = new Int32Array(CHANNELS);
    for (let i = 0; i < CHANNELS; i++) {
      this.delayBufs[i] = new Float32Array(maxDelaySamples);
    }
    this.delayBufLen = maxDelaySamples;

    // ── Allpass diffusers (N=4, each with 2 delay lines per Schroeder) ──
    const maxApSamples = Math.ceil(MAX_ALLPASS_SECONDS * sr);
    this.apInBufs = new Array(CHANNELS);
    this.apOutBufs = new Array(CHANNELS);
    this.apLens = new Int32Array(CHANNELS);
    this.apInIdx = new Int32Array(CHANNELS);
    this.apOutIdx = new Int32Array(CHANNELS);
    for (let i = 0; i < CHANNELS; i++) {
      this.apInBufs[i] = new Float32Array(maxApSamples);
      this.apOutBufs[i] = new Float32Array(maxApSamples);
    }
    this.apBufLen = maxApSamples;
    this.allpassGain = 0.6;

    // ── One-pole lowpass state (per-channel z1, shared coefficients) ──
    this.lpfZ1 = new Float32Array(CHANNELS);
    this.lpfA0 = 1;
    this.lpfB1 = 0;

    // ── Feedback state ──
    this.feedback = new Float32Array(CHANNELS);

    // ── Per-sample working buffers ──
    this.workA = new Float32Array(CHANNELS);
    this.workB = new Float32Array(CHANNELS);

    // ── Parameter state ──
    // Target values seeded from processorOptions (or defaults if absent).
    // Runtime updates arrive via postMessage and override these.
    this.targetSize = opts.size != null ? opts.size : 10.0;
    this.targetDecay = opts.decay != null ? opts.decay : 0.8;
    this.targetDamping = opts.damping != null ? opts.damping : 2500;
    this.targetDrywet = opts.drywet != null ? opts.drywet : 0.3;
    // Softclip hardness — controls feedback-loop nonlinearity ceiling.
    // Lower = more linear headroom = pulses build up further before
    // tanh compresses. Default 1.25 (padenot reference).
    this.targetHardness = opts.hardness != null ? opts.hardness : 1.25;

    // Smoothed values (updated per-sample inside process)
    this.smoothDecay = this.targetDecay;
    this.smoothDrywet = this.targetDrywet;

    // Damping + hardness are updated once per quantum, not per-sample
    this.currentDamping = this.targetDamping;
    this.currentHardness = this.targetHardness;

    // Smoothing coefficient for ~5 ms time constant at current sample rate
    this.smoothCoeff = 1 - Math.exp(-1 / (0.005 * sr));

    // ── Silence detection state ──
    this.silentQuantaIn = 0;
    this.stateCheckCounter = 0;
    this.graceQuanta = 0;
    this.graceQuantaMax = Math.ceil((GRACE_SECONDS * sr) / 128);
    this.tailDecayed = false;

    // Diagnostic counters — kept lightweight (just integer increments per
    // process() call). Total runtime cost is negligible. Used by the FIRST
    // process() one-shot log and for any external diag_snapshot inspection.
    this._diagProcessCount = 0;
    this._diagFastPathCount = 0;

    // Apply initial parameters (sets delay lengths + damping coefficient)
    this._applyDelayLengths();
    this._applyDampingCoefficient();

    // ── Message handler ──
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;

      switch (msg.type) {
        case 'params': {
          if (typeof msg.size === 'number') this.targetSize = msg.size;
          if (typeof msg.decay === 'number') this.targetDecay = msg.decay;
          if (typeof msg.damping === 'number') this.targetDamping = msg.damping;
          if (typeof msg.drywet === 'number') this.targetDrywet = msg.drywet;
          if (typeof msg.hardness === 'number') this.targetHardness = msg.hardness;
          // Delay lengths recomputed when size changes
          if (typeof msg.size === 'number') this._applyDelayLengths();
          break;
        }
        case 'diag_snapshot': {
          // Lightweight on-demand snapshot — used by future debug paths
          // (e.g. the audioDiag module). Not called per-quantum.
          let maxFb = 0;
          for (let i = 0; i < CHANNELS; i++) {
            const a = Math.abs(this.feedback[i]);
            if (a > maxFb) maxFb = a;
          }
          this.port.postMessage({
            type: 'diag_snapshot_response',
            counts: {
              processCalls: this._diagProcessCount,
              fastPathHits: this._diagFastPathCount,
            },
            state: {
              targetSize: this.targetSize,
              targetDecay: this.targetDecay,
              targetDamping: this.targetDamping,
              targetDrywet: this.targetDrywet,
              targetHardness: this.targetHardness,
              smoothDecay: this.smoothDecay,
              smoothDrywet: this.smoothDrywet,
              currentHardness: this.currentHardness,
              maxFeedback: maxFb,
              graceQuanta: this.graceQuanta,
              tailDecayed: this.tailDecayed,
            },
          });
          break;
        }
      }
    };
  }

  // ── Parameter application helpers ──

  _applyDampingCoefficient() {
    // One-pole lowpass: b1 = exp(-2π * freq / sr), a0 = 1 - b1
    // Clamp to Nyquist-safe range (<= 8 kHz at 22050 Hz sample rate)
    const maxFreq = Math.min(this.sr * 0.36, 8000); // 0.36 * sr leaves headroom from Nyquist/2
    const freq = Math.max(100, Math.min(maxFreq, this.currentDamping));
    const normalized = freq / this.sr;
    this.lpfB1 = Math.exp(-2 * Math.PI * normalized);
    this.lpfA0 = 1 - this.lpfB1;
  }

  _applyDelayLengths() {
    // Map the "size" knob to feedback-loop delay range. Unlike padenot's
    // physical sound-speed formula (which produces very short delays for
    // musically-sized rooms), we use Signalsmith's ambient-reverb range
    // (~50 ms to ~350 ms feedback-loop base delay) so decay=0.8 produces
    // multi-second T60 tails appropriate for pad voices.
    //
    //   size=1   → ~25 ms base → loops short, decays in ~0.7s at d=0.8
    //   size=10  → ~50 ms base → ~1.5s T60 at d=0.8
    //   size=50  → ~170 ms base → ~5s T60 at d=0.8
    //   size=100 → ~320 ms base → ~10s T60 at d=0.8
    //
    // Allpass diffusers stay short (~2–15 ms) — they add density, not length.
    const size = Math.max(1, this.targetSize);
    const mainSec = Math.min(0.35, 0.02 + size * 0.003);
    const apSec = Math.min(0.015, 0.002 + size * 0.00012);
    const mainBase = Math.max(16, Math.round(mainSec * this.sr));
    const apBase = Math.max(4, Math.round(apSec * this.sr));
    const mainDelays = coprimeProgression(mainBase, 1.16, CHANNELS);
    const apDelays = coprimeProgression(apBase, 1.16, CHANNELS);
    for (let i = 0; i < CHANNELS; i++) {
      this.delayLens[i] = Math.min(mainDelays[i], this.delayBufLen - 1);
      this.apLens[i] = Math.min(apDelays[i], this.apBufLen - 1);
    }
  }

  process(inputs, outputs /* , parameters */) {
    this._diagProcessCount++;

    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const outL = output[0];
    const outR = output[1];
    const blockSize = outL.length;
    if (blockSize === 0) return true;

    // ── Get mono input (stereo input is mixed down) ──
    const input = inputs[0];
    let inMono = null;
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      if (input.length >= 2 && input[1] && input[1].length > 0) {
        // Stereo → mono mixdown (reuse workA as scratch is wrong size; allocate once-and-reuse)
        // Scratch buffer for mono mix, allocated lazily and reused.
        if (!this._monoScratch || this._monoScratch.length !== blockSize) {
          this._monoScratch = new Float32Array(blockSize);
        }
        const inL = input[0];
        const inR = input[1];
        for (let s = 0; s < blockSize; s++) {
          this._monoScratch[s] = (inL[s] + inR[s]) * 0.5;
        }
        inMono = this._monoScratch;
      } else {
        inMono = input[0];
      }
    }

    // ── Damping + hardness: updated once per quantum (too expensive per-sample) ──
    // Smooth targets at block rate with ~50 ms time constant so user changes
    // track without audible zipper. The exp() in _applyDampingCoefficient is
    // cheap enough once per 128-sample quantum.
    const dampSmoothBlock = 1 - Math.exp(-128 / (0.050 * this.sr));
    this.currentDamping += (this.targetDamping - this.currentDamping) * dampSmoothBlock;
    this._applyDampingCoefficient();
    this.currentHardness += (this.targetHardness - this.currentHardness) * dampSmoothBlock;

    // ── Silence detection (input) ──
    let inputPeak = 0;
    if (inMono) {
      for (let s = 0; s < blockSize; s++) {
        const a = inMono[s] >= 0 ? inMono[s] : -inMono[s];
        if (a > inputPeak) inputPeak = a;
      }
    }
    const inputSilent = inputPeak < SILENCE_THRESHOLD;

    if (inputSilent) {
      this.silentQuantaIn++;
    } else {
      this.silentQuantaIn = 0;
      this.graceQuanta = this.graceQuantaMax;
    }
    if (this.graceQuanta > 0) this.graceQuanta--;

    // ── Silence detection (internal state, every 32 quanta) ──
    if (++this.stateCheckCounter >= STATE_CHECK_INTERVAL_QUANTA) {
      this.stateCheckCounter = 0;
      let maxState = 0;
      for (let i = 0; i < CHANNELS; i++) {
        const fb = this.feedback[i];
        const afb = fb >= 0 ? fb : -fb;
        if (afb > maxState) maxState = afb;
        if (maxState >= SILENCE_THRESHOLD) break;
        // Sparse scan of delay buffer (every 8th sample across the active length)
        const buf = this.delayBufs[i];
        const len = this.delayLens[i];
        const base = this.delayIdx[i];
        const bufLen = this.delayBufLen;
        for (let j = 0; j < len; j += 8) {
          const idx = (base - j + bufLen) % bufLen;
          const v = buf[idx];
          const a = v >= 0 ? v : -v;
          if (a > maxState) maxState = a;
          if (maxState >= SILENCE_THRESHOLD) break;
        }
        if (maxState >= SILENCE_THRESHOLD) break;
      }
      this.tailDecayed = maxState < SILENCE_THRESHOLD;
    }

    // ── Fast path: silent input + past grace period + tail decayed → skip DSP ──
    if (inputSilent && this.graceQuanta === 0 && this.tailDecayed) {
      this._diagFastPathCount++;
      for (let s = 0; s < blockSize; s++) {
        outL[s] = 0;
        outR[s] = 0;
      }
      return true;
    }

    // ── Main per-sample DSP loop ──
    const workA = this.workA;
    const workB = this.workB;
    const feedback = this.feedback;
    const lpfZ1 = this.lpfZ1;
    const lpfA0 = this.lpfA0;
    const lpfB1 = this.lpfB1;
    const smoothC = this.smoothCoeff;
    const apGain = this.allpassGain;
    const hardness = this.currentHardness;
    const invHardness = 1 / hardness;
    const preDelayBuf = this.preDelayBuf;
    const preDelayBufLen = this.preDelayBufLen;
    const preDelayLen = this.preDelayLen;

    // Cached per-channel state for the hot loop
    const delayBufs = this.delayBufs;
    const delayLens = this.delayLens;
    const delayIdx = this.delayIdx;
    const delayBufLen = this.delayBufLen;
    const apInBufs = this.apInBufs;
    const apOutBufs = this.apOutBufs;
    const apLens = this.apLens;
    const apInIdx = this.apInIdx;
    const apOutIdx = this.apOutIdx;
    const apBufLen = this.apBufLen;

    let preDelayIdx = this.preDelayIdx;

    for (let s = 0; s < blockSize; s++) {
      // Smooth user parameters per-sample (decay, drywet)
      this.smoothDecay += (this.targetDecay - this.smoothDecay) * smoothC;
      this.smoothDrywet += (this.targetDrywet - this.smoothDrywet) * smoothC;

      const inSample = inMono ? inMono[s] : 0;

      // Pre-delay
      const preReadIdx = (preDelayIdx - preDelayLen + preDelayBufLen) % preDelayBufLen;
      const predelayed = preDelayBuf[preReadIdx];
      preDelayBuf[preDelayIdx] = inSample;
      preDelayIdx = (preDelayIdx + 1) % preDelayBufLen;

      // Per-channel LPF(predelayed + feedback) → Allpass → Delay → softclip
      for (let c = 0; c < CHANNELS; c++) {
        // One-pole LPF (damping)
        const lpfIn = predelayed + feedback[c];
        lpfZ1[c] = lpfIn * lpfA0 + lpfZ1[c] * lpfB1;
        workA[c] = lpfZ1[c];

        // Allpass
        const apIn = apInBufs[c];
        const apOut = apOutBufs[c];
        const apLen = apLens[c];
        const apReadInIdx = (apInIdx[c] - apLen + apBufLen) % apBufLen;
        const apReadOutIdx = (apOutIdx[c] - apLen + apBufLen) % apBufLen;
        const delayedIn = apIn[apReadInIdx];
        const delayedOut = apOut[apReadOutIdx];
        const apResult = -apGain * workA[c] + delayedIn + apGain * delayedOut;
        apIn[apInIdx[c]] = workA[c];
        apOut[apOutIdx[c]] = apResult;
        apInIdx[c] = (apInIdx[c] + 1) % apBufLen;
        apOutIdx[c] = (apOutIdx[c] + 1) % apBufLen;

        // Delay line
        const dBuf = delayBufs[c];
        const dLen = delayLens[c];
        const dReadIdx = (delayIdx[c] - dLen + delayBufLen) % delayBufLen;
        const dDelayed = dBuf[dReadIdx];
        dBuf[delayIdx[c]] = apResult;
        delayIdx[c] = (delayIdx[c] + 1) % delayBufLen;

        // Softclip — unity gain for small inputs, soft limit at ±(1/hardness).
        // Lower hardness raises the soft-knee threshold, letting feedback build
        // up further before tanh attenuation kicks in. invHardness is precomputed
        // once per block to replace the per-sample divide with a multiply.
        workB[c] = Math.tanh(dDelayed * hardness) * invHardness;
      }

      // Hadamard4 unrolled (normalized by 1/sqrt(4) = 0.5)
      {
        const b0 = workB[0], b1 = workB[1], b2 = workB[2], b3 = workB[3];
        const t0 = b0 + b1, t1 = b0 - b1;
        const t2 = b2 + b3, t3 = b2 - b3;
        workA[0] = (t0 + t2) * 0.5;
        workA[1] = (t1 + t3) * 0.5;
        workA[2] = (t0 - t2) * 0.5;
        workA[3] = (t1 - t3) * 0.5;
      }

      // Wet path: sum all 4 taps (was 2-of-4) at workA, post-Hadamard but
      // pre-decay (was feedback[], post-decay). Pre-WET_OUTPUT_GAIN this
      // recovers ~2.5× wet level vs the legacy form; the constant scales
      // back for master-mix headroom. L=R because downstream
      // mainGain.channelCount=1 collapses to mono anyway.
      const drywet = this.smoothDrywet;
      const dry = 1 - drywet;
      const tapSum = (workA[0] + workA[1] + workA[2] + workA[3]) * WET_OUTPUT_GAIN;
      const out = inSample * dry + drywet * tapSum;

      // Apply feedback amount → next sample's feedback input
      const decay = this.smoothDecay;
      feedback[0] = workA[0] * decay;
      feedback[1] = workA[1] * decay;
      feedback[2] = workA[2] * decay;
      feedback[3] = workA[3] * decay;

      outL[s] = out;
      outR[s] = out;
    }

    this.preDelayIdx = preDelayIdx;

    return true;
  }
}

registerProcessor('fdn-reverb-processor', FDNReverbProcessor);
