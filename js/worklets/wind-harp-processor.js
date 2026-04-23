/**
 * Wind Harp AudioWorklet Processor
 *
 * Replaces 19 Tone.js nodes (9× Synth + 9× Gain + 1× harpBus Gain) with a
 * single AudioWorkletProcessor that runs 9 fatsine voices in one tight loop.
 *
 * Each voice: 3 detuned sine oscillators (fatsine spread:15 cents) with
 * per-voice gain. All amplitude control is external — the main thread sends
 * per-note gain values via MessagePort each frame.
 *
 * Mono output: all 9 voices sum to a single channel, matching the existing
 * mono harpBus → harpMixBus (channelCount=1) topology. Stereo imaging is
 * created downstream by the region's panner + chorus.
 *
 * Uses pre-computed wavetable lookup instead of Math.sin() for ~4-5x speedup.
 */

const VOICE_COUNT = 9;
const OSCS_PER_VOICE = 3;  // fatsine: center + 2 detuned
const SPREAD_CENTS = 15;   // ±15 cents detuning (wider than CS strings' ±8)
const VOICE_VOLUME_DB = -8;
const VOICE_VOLUME_LINEAR = Math.pow(10, VOICE_VOLUME_DB / 20); // 0.3981
const BUS_GAIN = 0.33;     // 1/sqrt(9) — compensates 9-voice summing
const BASE_AMPLITUDE = VOICE_VOLUME_LINEAR * BUS_GAIN; // ~0.1314

// Detuning multipliers: center, +spread, -spread
const DETUNE_UP = Math.pow(2, SPREAD_CENTS / 1200);    // 1.00868
const DETUNE_DOWN = Math.pow(2, -SPREAD_CENTS / 1200);  // 0.99133

// Envelope constants — faster attack than CS for pluck character
const ATTACK_TIME = 0.05;   // 50ms (CS uses 300ms)
const RELEASE_TIME = 1.5;   // 1.5s (CS uses 2.0s)

// Pre-computed sine wavetable — eliminates Math.sin() calls entirely.
// 4096 samples gives <0.01% THD with linear interpolation.
const TABLE_SIZE = 4096;
const TABLE_MASK = TABLE_SIZE - 1;  // for fast bitwise modulo
const sineTable = new Float32Array(TABLE_SIZE);
for (let i = 0; i < TABLE_SIZE; i++) {
  sineTable[i] = Math.sin(2 * Math.PI * i / TABLE_SIZE);
}

// Fast wavetable sine lookup with linear interpolation
function tableSin(phase) {
  // phase is in radians, convert to table index [0, TABLE_SIZE)
  const idx = (phase * (TABLE_SIZE / (2 * Math.PI))) % TABLE_SIZE;
  const i0 = idx | 0;  // integer part (truncate — phase is always positive)
  const frac = idx - i0;  // fractional part for interpolation
  const i1 = (i0 + 1) & TABLE_MASK;
  return sineTable[i0 & TABLE_MASK] + frac * (sineTable[i1] - sineTable[i0 & TABLE_MASK]);
}

class WindHarpProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const config = options.processorOptions || {};
    const sRate = config.sampleRate || 22050;

    // Per-voice state
    this.phases = new Float64Array(VOICE_COUNT * OSCS_PER_VOICE); // 27 phase accumulators
    this.phaseIncrements = new Float64Array(VOICE_COUNT * OSCS_PER_VOICE);
    this.gains = new Float32Array(VOICE_COUNT);       // current gain per voice (smoothed)
    this.targetGains = new Float32Array(VOICE_COUNT);  // target gain (from main thread)

    // Envelope state per voice
    this.envelopes = new Float32Array(VOICE_COUNT); // 0-1 envelope multiplier
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

    // Initialize frequencies from config
    const notes = config.frequencies || [];

    for (let i = 0; i < VOICE_COUNT; i++) {
      const freq = notes[i] || 440;
      const twoPiOverSr = (2 * Math.PI) / sRate;

      // 3 oscillators: center, +detune, -detune
      const base = i * OSCS_PER_VOICE;
      this.phaseIncrements[base] = freq * twoPiOverSr;
      this.phaseIncrements[base + 1] = freq * DETUNE_UP * twoPiOverSr;
      this.phaseIncrements[base + 2] = freq * DETUNE_DOWN * twoPiOverSr;

      // Random initial phase to avoid constructive interference at start
      this.phases[base] = Math.random() * 2 * Math.PI;
      this.phases[base + 1] = Math.random() * 2 * Math.PI;
      this.phases[base + 2] = Math.random() * 2 * Math.PI;

      // Start with zero gain, off state
      this.gains[i] = 0;
      this.targetGains[i] = 0;
      this.envelopes[i] = 0;
      this.envelopeState[i] = 0; // off
    }

    // Listen for parameter updates from main thread
    this.port.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'gains':
          // Per-note gain values (9 floats)
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

        case 'strumDip':
          // Write to targetGains so per-sample gainSmooth handles transition (avoids click/pop)
          if (msg.index >= 0 && msg.index < VOICE_COUNT) {
            this.targetGains[msg.index] = msg.level || 0.01;
          }
          break;

        case 'frequencies':
          // Live pitch retune for mode swap. Updates phaseIncrements without
          // resetting phase, so currently-playing voices glide. The tiny
          // phase-increment discontinuity is smoothed by the 5ms amplitude
          // envelope (gainSmooth) and should not be audible as a click.
          if (msg.values && Array.isArray(msg.values)) {
            const twoPiOverSr = (2 * Math.PI) / sRate;
            for (let i = 0; i < VOICE_COUNT && i < msg.values.length; i++) {
              const freq = msg.values[i];
              const base = i * OSCS_PER_VOICE;
              this.phaseIncrements[base] = freq * twoPiOverSr;
              this.phaseIncrements[base + 1] = freq * DETUNE_UP * twoPiOverSr;
              this.phaseIncrements[base + 2] = freq * DETUNE_DOWN * twoPiOverSr;
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
      for (let s = 0; s < blockSize; s++) {
        mono[s] = 0;
      }
      return true;
    }

    // Cache references for tight loop
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
        // Update envelope
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

        // Smooth gain toward target
        let gain = gains[i];
        gain += (targetGains[i] - gain) * smooth;
        gains[i] = gain;

        // 3-oscillator fatsine: wavetable lookup (no Math.sin)
        const base = i * OSCS_PER_VOICE;
        const sin0 = tableSin(phases[base]);
        const sin1 = tableSin(phases[base + 1]);
        const sin2 = tableSin(phases[base + 2]);
        const sample = (sin0 + sin1 + sin2) * 0.3333333;

        // Advance phases
        phases[base] += increments[base];
        phases[base + 1] += increments[base + 1];
        phases[base + 2] += increments[base + 2];

        // Combined amplitude: base level × envelope × per-note gain
        sum += BASE_AMPLITUDE * env * gain * sample;
      }

      mono[s] = sum;
    }

    // Phase wrap — prevent float precision loss over long sessions.
    const TWO_PI = 6.283185307179586;
    for (let i = 0; i < VOICE_COUNT * OSCS_PER_VOICE; i++) {
      if (phases[i] > TWO_PI) {
        phases[i] -= TWO_PI * ((phases[i] / TWO_PI) | 0);
      }
    }

    return true;
  }
}

registerProcessor('wind-harp-processor', WindHarpProcessor);
