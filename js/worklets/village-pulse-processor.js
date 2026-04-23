/**
 * Village Pulse AudioWorklet Processor
 *
 * 5 sine overtone pairs (10 oscillators total) with 6-cent detuning.
 * Main thread computes per-voice gains (breathing, evolution, Y-axis)
 * and sends them via MessagePort each frame. This processor just
 * does wavetable lookup and amplitude modulation.
 *
 * Replaces 10 Tone.Oscillator + 5 Tone.Gain + 1 Tone.Gain (bus) = 16 nodes.
 */

const TABLE_SIZE = 4096;
const TABLE_MASK = TABLE_SIZE - 1;
const TWO_PI = 6.283185307179586;

// Pre-compute sine wavetable
const sineTable = new Float32Array(TABLE_SIZE);
for (let i = 0; i < TABLE_SIZE; i++) {
  sineTable[i] = Math.sin(TWO_PI * i / TABLE_SIZE);
}

// Fast wavetable lookup with linear interpolation
function tableSin(phase) {
  const idx = (phase * TABLE_SIZE / TWO_PI) % TABLE_SIZE;
  const i0 = idx | 0;
  const frac = idx - i0;
  const a = sineTable[i0 & TABLE_MASK];
  const b = sineTable[(i0 + 1) & TABLE_MASK];
  return a + frac * (b - a);
}

let VOICE_COUNT = 6;  // default, overridden by processorOptions.frequencies.length
const OSCS_PER_VOICE = 2;  // center + detuned

class VillagePulseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const opts = options.processorOptions || {};
    const sr = opts.sampleRate || 44100;
    const frequencies = opts.frequencies || [155.56, 196.00, 233.08, 261.63, 311.13, 466.16];
    const spreadCents = opts.spreadCents || 6;

    this.voiceCount = frequencies.length;

    // Phase accumulators and increments (2 oscillators per voice)
    this.phases = new Float64Array(this.voiceCount * OSCS_PER_VOICE);
    this.increments = new Float64Array(this.voiceCount * OSCS_PER_VOICE);

    // Compute phase increments: center freq + detuned copy
    const detuneRatio = Math.pow(2, spreadCents / 1200);
    for (let i = 0; i < this.voiceCount; i++) {
      const freq = frequencies[i] || 220;
      const freqB = freq * detuneRatio;
      this.increments[i * 2] = TWO_PI * freq / sr;
      this.increments[i * 2 + 1] = TWO_PI * freqB / sr;
    }

    // Per-voice amplitude (smoothed toward targets)
    this.amplitudes = new Float32Array(VOICE_COUNT);
    this.targetAmplitudes = new Float32Array(VOICE_COUNT);

    // Gain smoothing: 5ms time constant
    this.ampSmooth = 1.0 - Math.exp(-1.0 / (0.005 * sr));

    // Active flag
    this.active = false;

    // Diagnostic counters (Phase 0 regression trace — 2026-04-12)
    // VP has no top-level fast path — it always runs the per-sample outer loop
    // but skips inner math when a voice is silent. We count process() calls
    // and quanta where ALL voices were silent as the nearest equivalent.
    this._diagProcessCount = 0;
    this._diagAllSilentCount = 0;

    // MessagePort handler
    this.port.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'gains':
          for (let i = 0; i < this.voiceCount && i < msg.values.length; i++) {
            this.targetAmplitudes[i] = msg.values[i];
          }
          break;
        case 'activate':
          this.active = true;
          break;
        case 'deactivate':
          this.active = false;
          for (let i = 0; i < this.voiceCount; i++) {
            this.targetAmplitudes[i] = 0;
          }
          break;
        case 'config':
          // Update frequencies at runtime (rare — voicing change)
          if (msg.frequencies) {
            const dr = Math.pow(2, (msg.spreadCents || spreadCents) / 1200);
            for (let i = 0; i < this.voiceCount && i < msg.frequencies.length; i++) {
              const f = msg.frequencies[i];
              this.increments[i * 2] = TWO_PI * f / sr;
              this.increments[i * 2 + 1] = TWO_PI * (f * dr) / sr;
            }
          }
          break;

        case 'diag_snapshot': {
          // Phase 0 regression trace — report current counters + state.
          // VP uses amplitudes, not envelopeState.
          let nonZeroAmps = 0;
          let nonZeroTargets = 0;
          for (let i = 0; i < this.voiceCount; i++) {
            if (this.amplitudes[i] > 0.0001) nonZeroAmps++;
            if (this.targetAmplitudes[i] > 0.0001) nonZeroTargets++;
          }
          this.port.postMessage({
            type: 'diag_snapshot_response',
            counts: {
              processCalls: this._diagProcessCount,
              // For VP, "fast path" = all voices silent this quantum (same semantic).
              fastPathHits: this._diagAllSilentCount,
            },
            state: {
              active: this.active,
              voiceCount: this.voiceCount,
              // Report amp-based "active" count since VP has no envelopeState
              activeVoices: nonZeroAmps,
              nonZeroGains: nonZeroTargets,
              nonZeroEnvelopes: nonZeroAmps,
              note: 'VP has no top-level fast path — always runs outer loop',
            },
          });
          break;
        }
      }
    };
  }

  process(inputs, outputs, parameters) {
    this._diagProcessCount++;
    // Cheap "all silent" check so the diagnostic can show what a fast path would catch.
    let _allSilent = true;
    for (let i = 0; i < this.voiceCount; i++) {
      if (this.amplitudes[i] > 0.0001 || this.targetAmplitudes[i] > 0.0001) {
        _allSilent = false;
        break;
      }
    }
    if (_allSilent) this._diagAllSilentCount++;

    const output = outputs[0];
    if (!output || !output[0]) return true;
    const ch = output[0];
    const len = ch.length;

    const phases = this.phases;
    const incs = this.increments;
    const amps = this.amplitudes;
    const targets = this.targetAmplitudes;
    const smooth = this.ampSmooth;

    for (let s = 0; s < len; s++) {
      let sum = 0;

      for (let v = 0; v < this.voiceCount; v++) {
        // Smooth amplitude toward target
        let amp = amps[v];
        amp += (targets[v] - amp) * smooth;
        amps[v] = amp;

        // Skip silent voices
        if (amp < 0.0001) {
          // Still advance phase to avoid discontinuity when voice fades back in
          phases[v * 2] += incs[v * 2];
          phases[v * 2 + 1] += incs[v * 2 + 1];
          continue;
        }

        // Wavetable lookup for both oscillators in the pair
        const base = v * 2;
        const sampleA = tableSin(phases[base]);
        const sampleB = tableSin(phases[base + 1]);

        // Average the pair, apply amplitude
        sum += (sampleA + sampleB) * 0.5 * amp;

        // Advance phases
        phases[base] += incs[base];
        phases[base + 1] += incs[base + 1];
      }

      // Phase wrapping (prevent float64 overflow over long sessions)
      // Check every 128 samples to reduce branch overhead
      if ((s & 127) === 0) {
        for (let i = 0; i < this.voiceCount * OSCS_PER_VOICE; i++) {
          if (phases[i] > TWO_PI * 1e6) phases[i] -= TWO_PI * 1e6;
        }
      }

      ch[s] = sum;
    }

    return true;  // keep alive
  }
}

registerProcessor('village-pulse-processor', VillagePulseProcessor);
