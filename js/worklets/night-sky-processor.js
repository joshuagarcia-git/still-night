/**
 * Night Sky AudioWorklet Processor
 *
 * 6-voice wavetable sine processor for the Night Sky region (region 3).
 * Voices: G3, A3, D4, F4, G4, A4 — "Suspended Space" voicing.
 *
 * Each voice: 3 detuned sine oscillators (fatsine spread:10 cents) with
 * per-voice gain. All amplitude control is external — the main thread sends
 * per-note gain values via MessagePort each frame.
 *
 * Mono output: all 6 voices sum to a single channel. Stereo imaging is
 * created downstream by the region's panner + chorus.
 *
 * Uses pre-computed wavetable lookup instead of Math.sin() for ~4-5x speedup.
 */

const VOICE_COUNT = 6;
const OSCS_PER_VOICE = 3;  // fatsine: center + 2 detuned
const SPREAD_CENTS = 2.5;  // ±2.5 cents — sub-1Hz beating, gentle warmth without wobble
const VOICE_VOLUME_DB = -8;
const VOICE_VOLUME_LINEAR = Math.pow(10, VOICE_VOLUME_DB / 20); // 0.3981
const BUS_GAIN = 0.408;    // 1/sqrt(6) — compensates 6-voice summing
const BASE_AMPLITUDE = VOICE_VOLUME_LINEAR * BUS_GAIN; // ~0.1625

// Detuning multipliers: center, +spread, -spread
const DETUNE_UP = Math.pow(2, SPREAD_CENTS / 1200);
const DETUNE_DOWN = Math.pow(2, -SPREAD_CENTS / 1200);

// Envelope constants — slow attack for atmospheric swell
const ATTACK_TIME = 0.20;   // 200ms (between WH 50ms and CS 300ms)
const RELEASE_TIME = 2.0;   // 2.0s gentle fade

// Pre-computed sine wavetable — eliminates Math.sin() calls entirely.
// 4096 samples gives <0.01% THD with linear interpolation.
const TABLE_SIZE = 4096;
const TABLE_MASK = TABLE_SIZE - 1;
const sineTable = new Float32Array(TABLE_SIZE);
for (let i = 0; i < TABLE_SIZE; i++) {
  sineTable[i] = Math.sin(2 * Math.PI * i / TABLE_SIZE);
}

// Fast wavetable sine lookup with linear interpolation
function tableSin(phase) {
  const idx = (phase * (TABLE_SIZE / (2 * Math.PI))) % TABLE_SIZE;
  const i0 = idx | 0;
  const frac = idx - i0;
  const i1 = (i0 + 1) & TABLE_MASK;
  return sineTable[i0 & TABLE_MASK] + frac * (sineTable[i1] - sineTable[i0 & TABLE_MASK]);
}

class NightSkyProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const config = options.processorOptions || {};
    const sRate = config.sampleRate || 22050;

    // Per-voice state
    this.phases = new Float64Array(VOICE_COUNT * OSCS_PER_VOICE);
    this.phaseIncrements = new Float64Array(VOICE_COUNT * OSCS_PER_VOICE);
    this.gains = new Float32Array(VOICE_COUNT);
    this.targetGains = new Float32Array(VOICE_COUNT);

    // Envelope state per voice
    this.envelopes = new Float32Array(VOICE_COUNT);
    this.envelopeState = new Uint8Array(VOICE_COUNT); // 0=off, 1=attack, 2=sustain, 3=release

    // Envelope rates (per-sample)
    this.attackRate = 1.0 / (ATTACK_TIME * sRate);
    this.releaseRate = 1.0 / (RELEASE_TIME * sRate);

    // Gain smoothing (per-sample, ~5ms time constant)
    this.gainSmooth = 1.0 - Math.exp(-1.0 / (0.005 * sRate));

    // Active flag
    this.active = false;

    // Diagnostic counters (Phase 0 regression trace — 2026-04-12)
    this._diagProcessCount = 0;
    this._diagFastPathCount = 0;

    // Detuning evolution: spread in cents drifts over time
    this.currentSpread = SPREAD_CENTS;  // current spread (smoothed)
    this.targetSpread = SPREAD_CENTS;   // target spread from main thread
    // Per-block spread smoothing (~500ms at 22050Hz / 128 block size = ~86 blocks/sec)
    this.spreadSmooth = 1.0 - Math.exp(-1.0 / (0.5 * sRate / 128));

    // Store base frequencies for spread recomputation
    this.baseFreqs = new Float64Array(VOICE_COUNT);
    this.twoPiOverSr = (2 * Math.PI) / sRate;

    // Initialize frequencies from config
    const notes = config.frequencies || [];

    for (let i = 0; i < VOICE_COUNT; i++) {
      const freq = notes[i] || 440;
      this.baseFreqs[i] = freq;

      const base = i * OSCS_PER_VOICE;
      this.phaseIncrements[base] = freq * this.twoPiOverSr;
      this.phaseIncrements[base + 1] = freq * DETUNE_UP * this.twoPiOverSr;
      this.phaseIncrements[base + 2] = freq * DETUNE_DOWN * this.twoPiOverSr;

      this.phases[base] = Math.random() * 2 * Math.PI;
      this.phases[base + 1] = Math.random() * 2 * Math.PI;
      this.phases[base + 2] = Math.random() * 2 * Math.PI;

      this.gains[i] = 0;
      this.targetGains[i] = 0;
      this.envelopes[i] = 0;
      this.envelopeState[i] = 0;
    }

    this.port.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'gains':
          for (let i = 0; i < VOICE_COUNT && i < msg.values.length; i++) {
            this.targetGains[i] = msg.values[i];
          }
          break;

        case 'activate':
          this.active = true;
          for (let i = 0; i < VOICE_COUNT; i++) {
            this.envelopeState[i] = 1; // attack
          }
          break;

        case 'deactivate':
          this.active = false;
          for (let i = 0; i < VOICE_COUNT; i++) {
            if (this.envelopeState[i] !== 0) {
              this.envelopeState[i] = 3; // release
            }
          }
          break;

        case 'spread':
          // Detuning evolution: main thread sends target spread in cents
          this.targetSpread = msg.cents || SPREAD_CENTS;
          break;

        case 'strumDip':
          // Write to targetGains so the per-sample gainSmooth (5ms tau) handles
          // the transition — avoids instant gain jump that causes click/pop.
          if (msg.index >= 0 && msg.index < VOICE_COUNT) {
            this.targetGains[msg.index] = msg.level || 0.01;
          }
          break;

        case 'frequencies':
          // Live pitch retune for mode swap. Updates phaseIncrements without
          // resetting phase, so currently-playing voices glide. Also updates
          // baseFreqs so the spread-evolution recomputation uses the new
          // pitches when detuning drifts.
          if (msg.values && Array.isArray(msg.values)) {
            const up = Math.pow(2, this.currentSpread / 1200);
            const down = Math.pow(2, -this.currentSpread / 1200);
            for (let i = 0; i < VOICE_COUNT && i < msg.values.length; i++) {
              const freq = msg.values[i];
              this.baseFreqs[i] = freq;
              const base = i * OSCS_PER_VOICE;
              this.phaseIncrements[base] = freq * this.twoPiOverSr;
              this.phaseIncrements[base + 1] = freq * up * this.twoPiOverSr;
              this.phaseIncrements[base + 2] = freq * down * this.twoPiOverSr;
            }
          }
          break;

        case 'diag_snapshot': {
          // Phase 0 regression trace — report current counters + state.
          let activeVoices = 0;
          let nonZeroGains = 0;
          let nonZeroEnvelopes = 0;
          for (let i = 0; i < VOICE_COUNT; i++) {
            if (this.envelopeState[i] !== 0) activeVoices++;
            if (this.targetGains[i] > 0.0001 || this.gains[i] > 0.0001) nonZeroGains++;
            if (this.envelopes[i] > 0.0001) nonZeroEnvelopes++;
          }
          this.port.postMessage({
            type: 'diag_snapshot_response',
            counts: {
              processCalls: this._diagProcessCount,
              fastPathHits: this._diagFastPathCount,
            },
            state: {
              active: this.active,
              voiceCount: VOICE_COUNT,
              activeVoices,
              nonZeroGains,
              nonZeroEnvelopes,
              envelopeStates: Array.from(this.envelopeState),
              currentSpread: this.currentSpread,
              targetSpread: this.targetSpread,
            },
          });
          break;
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    this._diagProcessCount++;
    const output = outputs[0];
    if (!output || output.length < 1) return true;

    const mono = output[0];
    const blockSize = mono.length;

    // Fast path: if all envelopes are off, output silence
    let anyActive = false;
    for (let i = 0; i < VOICE_COUNT; i++) {
      if (this.envelopeState[i] !== 0) { anyActive = true; break; }
    }
    if (!anyActive) {
      this._diagFastPathCount++;
      for (let s = 0; s < blockSize; s++) mono[s] = 0;
      return true;
    }

    // Per-block spread evolution: smoothly update detuning if target changed
    if (Math.abs(this.targetSpread - this.currentSpread) > 0.05) {
      this.currentSpread += (this.targetSpread - this.currentSpread) * this.spreadSmooth;
      // Recompute detuning multipliers from current spread
      const up = Math.pow(2, this.currentSpread / 1200);
      const down = Math.pow(2, -this.currentSpread / 1200);
      for (let i = 0; i < VOICE_COUNT; i++) {
        const freq = this.baseFreqs[i];
        const base = i * OSCS_PER_VOICE;
        // Center oscillator unchanged, update detuned pair
        this.phaseIncrements[base + 1] = freq * up * this.twoPiOverSr;
        this.phaseIncrements[base + 2] = freq * down * this.twoPiOverSr;
      }
    }

    const phases = this.phases;
    const increments = this.phaseIncrements;
    const gains = this.gains;
    const targetGains = this.targetGains;
    const envelopes = this.envelopes;
    const envState = this.envelopeState;
    const atkRate = this.attackRate;
    const relRate = this.releaseRate;
    const smooth = this.gainSmooth;

    for (let s = 0; s < blockSize; s++) {
      let sum = 0;

      for (let i = 0; i < VOICE_COUNT; i++) {
        let env = envelopes[i];
        const es = envState[i];
        if (es === 1) {
          env += atkRate;
          if (env >= 1.0) { env = 1.0; envState[i] = 2; }
        } else if (es === 3) {
          env -= relRate;
          if (env <= 0) { env = 0; envState[i] = 0; }
        }
        envelopes[i] = env;

        if (env < 0.0001) continue;

        let gain = gains[i];
        gain += (targetGains[i] - gain) * smooth;
        gains[i] = gain;

        const base = i * OSCS_PER_VOICE;
        const sin0 = tableSin(phases[base]);
        const sin1 = tableSin(phases[base + 1]);
        const sin2 = tableSin(phases[base + 2]);
        const sample = (sin0 + sin1 + sin2) * 0.3333333;

        phases[base] += increments[base];
        phases[base + 1] += increments[base + 1];
        phases[base + 2] += increments[base + 2];

        sum += BASE_AMPLITUDE * env * gain * sample;
      }

      // Soft-clip the voice sum (tanh): tames peaks when strums overlap without
      // squashing individual attacks. Prevents downstream reverb/delay from
      // accumulating excess energy during dense passages.
      mono[s] = Math.tanh(sum);
    }

    // Phase wrap — prevent float precision loss over long sessions
    const TWO_PI = 6.283185307179586;
    for (let i = 0; i < VOICE_COUNT * OSCS_PER_VOICE; i++) {
      if (phases[i] > TWO_PI) {
        phases[i] -= TWO_PI * ((phases[i] / TWO_PI) | 0);
      }
    }

    return true;
  }
}

registerProcessor('night-sky-processor', NightSkyProcessor);
