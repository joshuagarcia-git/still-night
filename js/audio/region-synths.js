/**
 * Region Synths — Click-based voices with sustain evolution.
 *
 * Sound evolves with hold duration:
 *   0-1s:  Simple tone, filter mostly closed, low volume
 *   1-3s:  Filter opens, harmonics emerge, volume builds
 *   3-7s:  Secondary detuned layer fades in, deep reverb expands
 *   7-15s: Full richness, LFO filter breathing
 *
 * On release → soft loop at ~20% vol, complexity ∝ hold duration.
 *
 * All regions — hold-to-reshape:
 *   Tap inactive → starts soft loop at minimal complexity.
 *   Hold inactive → builds normally, loops on release.
 *   Tap active → fades out over 2-3s.
 *   Hold active → reshapes from current state. Energy decays
 *     back to base loop over ~15-20s. Hold again to push higher.
 *
 * Strum (all regions):
 *   Rapid clicks on active region retrigger attack envelopes.
 *   Fade-out deferred 300ms to detect strum vs single tap.
 *
 * Region map:
 *   1=Cypress G2,Bb2  2=Village D3,F3  3=Sky G3,Bb3,D4
 *   4=Horizon D4,F4   5=Stars G4,D5
 *
 * Combined voicing: Gm7 spread across 3+ octaves.
 * Audio only — no visual changes.
 */

/* global Tone */

import { createAnalyzer } from './audio-analyzer.js';
import { audioDiag } from '../debug/audio-diagnostic.js';

// ── Frequency-dependent fade-in τ ────────────────────────────────────────────
/** Debug log — gated by ?debug URL parameter. Errors/warnings always visible. */
function _log(...args) { if (window.__DEBUG) console.log(...args); }

/** Decay a captured expression value toward zero (frame-rate-independent).
 *  Returns 0 once the value drops below threshold (0.001). */
function decayValue(value, factor) {
  return Math.abs(value) > 0.001 ? value * factor : 0;
}

// ── Voice definitions ────────────────────────────────────────────────────────

const VOICES = {
  1: {
    name: 'Cypress',
    notes: ['G2', 'Bb2'],
    volume: -7,
    filterClosed: 400,
    filterOpen: 3200,
    fmModMin: 0.3,    // near-clean starting FM depth (cross-modulation)
    fmModMax: 8,      // intense FM at full evolution
    pan: -0.25,       // slightly left — cypress tree sits on the left side of the painting
    widthMax: 0.4,    // moderate stereo width — bass stays grounded
    loopGain: 0.24,   // Fletcher-Munson: mild bass boost; effective loop ≈ -19.4 dB
    buildGainMax: 1.0, // full build peak — bass already quietest perceptually
    filterTransient: { overshoot: 1.4, decayMs: 450 }, // heavy pluck — slow decay for bass
    reverbHPF: 280,   // High-pass reverb sends at 280Hz — G2(98)/Bb2(117) fundamentals stay dry
    lfoDepth: 60,
    lfoRate: 0.09,
    reshape: {
      tapThreshold: 0.5,     // seconds — shorter = tap (toggle off), longer = hold (reshape)
      strumWindow: 300,      // ms — rapid clicks within this window retrigger attack (strum)
      energyRise: 0.0015,   // per-frame energy rise during hold (~11s to max from 0)
      energyDecay: 0.003,   // per-frame multiplicative decay after release (~15s drift-back)
      ceiling: {             // absolute param targets at max energy (1.0)
        filter: 0.95,       // filter wide open
        gain: 0.55,         // strong presence
        secondary: 0.75,    // dominant secondary layer
        deepReverb: 0.80,   // expansive space
        lfo: 0.70,          // deep breathing
        width: 0.65,        // moderate stereo push
      },
    },
    buildPrimary(dest) {
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 1.0,
        modulationIndex: 0.3,  // starts subtle — evolution ramps FM depth via fmModMin/fmModMax
        oscillator: { type: 'sawtooth' },
        modulation: { type: 'triangle' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
        modulationEnvelope: { attack: 0.5, decay: 1.0, sustain: 0.6, release: 0.8 },
      }).connect(dest);
    },
    buildSecondary(dest) {
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 25 },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
      }).connect(dest);
    },
    // ── Living Wood config ──
    // Three-layer voice: earth rumble (brown noise + sub) + trunk resonance (FM pad) + 7-voice overtone branches
    // Dark, grounded bass character — replaces basic FMSynth with organic multi-layer architecture.
    livingWood: {
      // Layer C: Overtone branch voices — natural harmonic series of G2 with Bb minor flavor
      branchNotes: ['G2', 'D3', 'G3', 'Bb3', 'D4', 'G4', 'Bb4'],
      // Activation order: fundamental first, then alternating low/high for spread
      activationOrder: [0, 2, 4, 1, 3, 5, 6],
      // Per-note LFO rates (seconds) — prime-derived, never sync
      lfoRates: [7, 11, 13, 17, 19, 23, 29],

      // Layer A: Earth Rumble + Sub
      brownVolume: -10,           // brown noise base volume (dB) — raised from -18
      brownLpfFreq: 180,          // steep lowpass — keeps noise sub-bass only
      subNote: 'G1',              // 49 Hz sub-oscillator (felt, not heard)
      subVolume: -14,             // sub sine volume (dB) — raised from -22
      // Gust LFO: asymmetric 20-30s cycles (slower/heavier than harp's 10-20s)
      gustLfoMinRate: 0.033,      // Hz — 30s full cycle at slowest
      gustLfoMaxRate: 0.05,       // Hz — 20s full cycle at fastest
      gustLfoRiseExp: 0.3,        // < 1 = concave rise (very slow build, heavy)
      gustLfoCutExp: 3.0,         // > 1 = convex fall (sharp cut)

      // Layer B: Trunk Resonance (FM Pad)
      padNotes: ['G2', 'Bb2'],    // same as voice.notes
      padVolume: -8,               // pad base volume (dB) — raised from -14
      padHarmonicity: 0.5,        // subharmonic FM — dark organ-like character
      padModIndexMin: 0.6,        // always some harmonic content for speaker translation
      padModIndexMax: 3.0,        // evolution ceiling (rich but not harsh)
      tremoloRate: 0.12,          // Hz — slower breathing than harp's 0.25
      tremoloMaxDepth: 0.5,

      // Layer C: Branch voice config
      branchVolume: -6,           // per-voice base volume (dB) — raised from -10
      branchSpread: 12,           // fatsine spread
      branchBusGain: 0.5,         // raised from 0.38 — let branches be heard

      // Effects
      phaserFreq: 0.05,           // Hz — very slow organic sweep
      phaserMaxWet: 0.4,
      delayTime: 0.175,           // 175ms — short doubling
      delayFeedback: 0.20,
      delayMaxWet: 0.25,
      // Dark reverb: long decay, heavy dampening
      reverbRoomSize: 0.75,
      reverbDampening: 1500,      // Hz — cuts highs for dark tail
      reverbWetDefault: 0.3,

      // Bow expression: velocity sensitivity power curve
      velocitySensDefault: 1.0,
    },
  },
  2: {
    name: 'Village',
    notes: ['D3', 'F3'],
    volume: -8,
    filterClosed: 400,
    filterOpen: 1800,
    fmModMin: 0.1,    // nearly clean — gentle warmth
    fmModMax: 2.5,    // conservative ceiling — never harsh
    pan: 0.20,        // slightly right — village sits in the lower right of the painting
    widthMax: 0.35,   // moderate stereo width — warm, intimate
    loopGain: 0.43,   // reduced 15% (was 0.50) — Village dominated mix, masking Horizon/Cypress
    buildGainMax: 1.0, // triangle harmonics are naturally quiet — no reduction needed
    filterTransient: { overshoot: 1.3, decayMs: 350 }, // muted guitar string — gentle and warm
    reverbHPF: 200,   // High-pass reverb sends at 200Hz — D3(147)/F3(175) reduced in reverb tails
    lfoDepth: 40,
    lfoRate: 0.07,
    // Triangle harmonics roll off as 1/n² — much weaker than sawtooth.
    // Needs deeper chorus and higher expression sensitivity for perceptible stereo/filter effect.
    chorusConfig: { depth: 0.85, feedback: 0.2, delayTime: 4.0 },
    mouseExprDefaults: {
      vertSensitivity: 1.3, horizSensitivity: 1.3,
      maxFilterFraction: 0.6, maxWidthRange: 0.80, normDistance: 260,
    },
    reshape: {
      tapThreshold: 0.5,
      strumWindow: 300,
      energyRise: 0.0015,
      energyDecay: 0.003,
      ceiling: {
        filter: 0.85,       // warm opening
        gain: 0.50,
        secondary: 0.65,    // sine secondary blends gently
        deepReverb: 0.70,
        lfo: 0.55,
        width: 0.60,        // warm, intimate widening
      },
    },
    buildPrimary(dest) {
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 1.5,
        modulationIndex: 0.1,      // matches fmModMin — starts nearly clean
        oscillator: { type: 'triangle' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
        modulationEnvelope: { attack: 0.3, decay: 0.5, sustain: 0.4, release: 0.5 },
      }).connect(dest);
    },
    buildSecondary(dest) {
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
      }).connect(dest);
    },
  },
  3: {
    name: 'Sky',
    notes: ['G3', 'Bb3', 'D4'],
    volume: -11,
    filterClosed: 5800,   // near-open — no ramp-up, voices present immediately. Y-axis can still darken.
    filterOpen: 6000,
    filterEvoTime: 20,    // 20s filter evolution (default 7s) — glacial brightening, not a rush
    fmModMin: 0.5,    // starts with some harmonics — shimmer from the beginning
    fmModMax: 2.0,    // evolves richer — FM sidebands provide air and upper harmonics
    pan: 0.0,         // centered — sky spans the full painting, anchors the panorama
    widthMax: 0.7,    // widest — expansive, sky opening
    loopGain: 0.33,   // compensates for -11 dB volume; effective loop ≈ -20.6 dB
    buildGainMax: 0.95, // 9 fat oscillators — mild reduction only
    filterTransient: { overshoot: 1.2, decayMs: 200 }, // gentle brightness sweep — atmospheric, not percussive
    lfoDepth: 180,
    lfoRate: 0.13,
    reshape: {
      tapThreshold: 0.5,
      strumWindow: 300,
      energyRise: 0.0015,
      energyDecay: 0.003,
      ceiling: {
        filter: 0.90,       // wide open — lots of harmonics with filterOpen 6000
        gain: 0.50,
        secondary: 0.70,    // FM shimmer layer
        deepReverb: 0.75,
        lfo: 0.65,          // big breathing
        width: 0.85,        // widest — sky opens up
      },
    },
    buildPrimary(dest) {
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 2.0,
        modulationIndex: 0.2,      // matches fmModMin — smooth pad start
        oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
        modulation: { type: 'triangle' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
        modulationEnvelope: { attack: 0.5, decay: 1.0, sustain: 0.5, release: 0.8 },
      }).connect(dest);
    },
    buildSecondary(dest) {
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 2.0,
        modulationIndex: 3,
        oscillator: { type: 'sine' },
        modulation: { type: 'triangle' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
        modulationEnvelope: { attack: 0.5, decay: 1.0, sustain: 0.5, release: 0.8 },
      }).connect(dest);
    },
  },
  4: {
    name: 'Horizon',
    notes: ['D4', 'F4'],
    volume: -10,
    filterClosed: 600,
    filterOpen: 4500,
    fmModMin: 0.1,    // near-pure triangle
    fmModMax: 3.0,    // subtle — crystalline overtones without losing purity
    pan: -0.15,       // slightly left of center — horizon lighter blue concentrates left-center
    widthMax: 0.6,    // wide — ethereal distance
    loopGain: 0.35,   // boosted from 0.28 — Horizon buried at -25.4 LUFS in full mix, needs ~2dB to reach ambient bed zone (-23)
    buildGainMax: 0.95, // triangle at D4/F4 is naturally quiet — mild reduction only
    filterTransient: { overshoot: 1.5, decayMs: 250 }, // tapping crystal — crisp and bell-like
    lfoDepth: 30,
    lfoRate: 0.06,
    // Triangle at D4/F4 — weak upper harmonics need boosted chorus depth and
    // higher expression sensitivity. Slightly longer delay benefits higher pitch.
    chorusConfig: { depth: 0.9, feedback: 0.2, delayTime: 4.5 },
    mouseExprDefaults: {
      vertSensitivity: 1.4, horizSensitivity: 1.4,
      maxFilterFraction: 0.6, maxWidthRange: 0.85, normDistance: 250,
    },
    reshape: {
      tapThreshold: 0.5,
      strumWindow: 600,    // 600ms grace before fadeOut — enough for musical re-clicks
      energyRise: 0.0015,
      energyDecay: 0.003,
      ceiling: {
        filter: 0.85,
        gain: 0.45,         // gentler — triangle stays clean
        secondary: 0.60,
        deepReverb: 0.85,   // highest reverb — vast horizon
        lfo: 0.50,
        width: 0.80,        // wide — ethereal distance
      },
    },
    buildPrimary(dest) {
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 2.0,
        modulationIndex: 0.1,      // matches fmModMin — near-pure triangle
        oscillator: { type: 'triangle' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
        modulationEnvelope: { attack: 0.5, decay: 1.0, sustain: 0.6, release: 0.8 },
      }).connect(dest);
    },
    buildSecondary(dest) {
      return new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'fatsine', count: 2, spread: 8 },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
      }).connect(dest);
    },
    // ── Wind Harp mode config ──
    // Three-layer voice: pink noise background + tonal pad w/ tremolo + 9-voice aeolian harp
    // Produces continuous spectral movement (rms oscillation, centroid sweep, onset events)
    // instead of the base synth's static steady-state.
    windHarp: {
      // Gm pentatonic across 3 octaves — emergent aeolian melody
      harpNotes: ['G3', 'Bb3', 'C4', 'D4', 'F4', 'G4', 'C5', 'D5', 'F5'],
      // Per-note LFO rates (seconds) — prime-number-derived, never sync
      lfoRates: [5.0, 7.0, 11.0, 13.0, 5.5, 8.5, 17.0, 11.5, 19.0],
      // Noise layer — dual source (pink hiss + brown gust)
      pinkVolume: -28,       // hiss texture (constant)
      brownVolume: -22,      // gust body (louder — LFO-modulated)
      autoFilterFreq: 0.07,  // Hz — slow bandpass sweep
      autoFilterBase: 200,   // Hz
      autoFilterOctaves: 3.5,
      autoFilterQ: 3,        // moderate resonant howl (lowered from 8 to reduce +18dB spikes)
      // Brown noise gust envelope — asymmetric: slow rise, fast cut
      gustLfoMinRate: 0.05,  // Hz — 20s full cycle at slowest
      gustLfoMaxRate: 0.10,  // Hz — 10s full cycle at fastest
      gustLfoRiseExp: 0.4,   // < 1 = concave rise (slow build)
      gustLfoCutExp: 2.5,    // > 1 = convex fall (fast cut)
      // Pad layer — tonal pad on D4/F4 (same as voice notes)
      padVolume: -16,
      tremoloRate: 0.25,       // Hz — slow breathing
      tremoloMaxDepth: 0.6,
      // Effects
      phaserFreq: 0.15,      // Hz
      phaserMaxWet: 0.5,
      delayTime: 0.375,      // dotted 8th
      delayFeedback: 0.35,
      delayMaxWet: 0.3,
      // Harp synth config
      harpVolume: -8,
      harpSpread: 15,          // fatsine spread
    },
  },
  5: {
    name: 'Stars',
    notes: ['G4', 'D5'],
    volume: -9,
    filterClosed: 650,
    filterOpen: 9000,
    fmModMin: 0.2,    // nearly clean start
    fmModMax: 2.0,    // most restrained — avoids harshness in high register
    pan: 0.15,        // slightly right of center — counterbalances Horizon's leftward lean
    widthMax: 0.5,    // wide but controlled — clean FM
    loopGain: 0.41,   // reduced 15% (was 0.48) — Stars dominated mix at peak ear sensitivity. Original was 0.24, boosted for LUFS parity then pulled back
    buildGainMax: 1.0, // aligned with Cypress/Village — F-M overcorrection removed per LUFS data
    filterTransient: { overshoot: 1.5, decayMs: 300 }, // crystalline pluck — brighter and longer for strum impact
    lfoDepth: 220,
    lfoRate: 0.18,
    // Sine oscillator has ZERO harmonics above the fundamental — filter expression is
    // inaudible until FM evolution adds sidebands. Needs maximum chorus depth/feedback
    // and highest expression sensitivity for any perceptible stereo/filter effect.
    chorusConfig: { depth: 0.95, feedback: 0.3, delayTime: 5.0 },
    mouseExprDefaults: {
      vertSensitivity: 1.6, horizSensitivity: 1.5,
      maxFilterFraction: 0.65, maxWidthRange: 1.0, normDistance: 220,
    },
    reshape: {
      tapThreshold: 0.5,
      strumWindow: 300,
      energyRise: 0.0015,
      energyDecay: 0.003,
      ceiling: {
        filter: 0.80,       // conservative — FM + high register
        gain: 0.40,         // lower to avoid harsh FM sidebands
        secondary: 0.55,    // careful stacking two FM synths
        deepReverb: 0.70,
        lfo: 0.60,
        width: 0.70,        // wide but controlled
      },
    },
    buildPrimary(dest) {
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3.5,
        modulationIndex: 0.2,      // matches fmModMin — starts nearly clean
        oscillator: { type: 'sine' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
        modulationEnvelope: { attack: 3.0, decay: 1.0, sustain: 0.5, release: 0.8 },
      }).connect(dest);
    },
    buildSecondary(dest) {
      return new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 5.01,
        modulationIndex: 1.2,
        oscillator: { type: 'fatsine', count: 2, spread: 10 },
        modulation: { type: 'sine' },
        envelope: { attack: 0.02, decay: 0.1, sustain: 1.0, release: 0.8 },
        modulationEnvelope: { attack: 2.5, decay: 0.5, sustain: 0.4, release: 0.8 },
      }).connect(dest);
    },
    // ── Celestial Strings config ──
    // Three-layer voice: cosmic static (white noise HPF+LPF) + glassy pad (FM)
    // + 12 individual bowed strings. Distant, cold, vast — Vivaldi Winter 2nd movement.
    celestialStrings: {
      // Layer C: 12 celestial string voices — Gm natural minor across 2 octaves
      stringNotes: ['G4', 'A4', 'Bb4', 'C5', 'D5', 'Eb5', 'F5', 'G5', 'A5', 'Bb5', 'C6', 'D6'],
      // Per-note LFO rates (seconds) — prime numbers, very slow for glacial breathing
      lfoRates: [31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79],
      // Layer A: Cosmic Static — white noise through HPF+LPF band
      noiseVolume: -34,        // whisper-quiet texture
      noiseHpf: 1000,          // Hz — above Horizon's brown noise range
      noiseLpf: 8000,          // Hz — sparkly air
      // Gust LFO: extremely slow 40-60s cycles (cosmic breathing)
      gustLfoMinRate: 0.017,   // Hz — 60s full cycle at slowest
      gustLfoMaxRate: 0.025,   // Hz — 40s full cycle at fastest
      gustLfoRiseExp: 0.3,     // concave rise (glacial build)
      gustLfoCutExp: 2.0,      // convex fall (gentle fade)
      // Layer B: Glassy Pad — FM on G4/D5 (same as voice.notes)
      padVolume: -16,
      padHarmonicity: 2.0,     // octave — clean, glassy
      padModIndexMin: 0.1,     // nearly pure sine
      padModIndexMax: 0.3,     // slight FM shimmer at full evolution
      tremoloRate: 0.08,       // Hz — very slow breathing
      tremoloMaxDepth: 0.4,
      // Layer C: String voice config
      stringVolume: -16,       // per-voice (12 voices summing)
      stringSpread: 8,         // subtle detuning — bowed character
      stringBusGain: 0.29,     // ≈ 1/√12 — compensate for 12-voice summing
      gateFloor: 0.10,         // faintly present floor — notes always audible
      lfoDepth: 0.70,          // deep breathing range (floor → floor + depth ≈ 0.05–0.74)
      // Effects
      phaserFreq: 0.03,        // Hz — extremely slow sweep
      phaserMaxWet: 0.4,
      delayTime: 0.250,        // 250ms — quarter note feel
      delayFeedback: 0.15,     // minimal recirculation
      delayMaxWet: 0.20,
      // Cold Reverb: long decay, heavy dampening
      reverbRoomSize: 0.88,    // vast cathedral
      reverbDampening: 2500,   // Hz — cold, rolled-off highs
      reverbHPF: 400,          // Hz — HPF on reverb output (prevents Horizon masking)
    },
  },
};

// ── Evolution curves ─────────────────────────────────────────────────────────

function smoothstep(x) {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** Target params from hold time (0–15s), with per-voice gain scaling.
 *  Build gain ramps from 0.15 to voice.buildGainMax (default 1.0).
 *  Lower registers peak higher to compensate for Fletcher-Munson:
 *  bass is perceptually quieter at the same gain level.
 */
// Writes evolution values directly into target object (avoids per-frame allocation)
function getEvolution(holdTime, voice, out) {
  const t = Math.min(holdTime, 15);
  const gMax = voice.buildGainMax || 1.0;
  // Per-voice filter evolution rate (default 7s, Night Sky uses 20s for slow brightening)
  const filterT = voice.filterEvoTime || 7;
  // Per-voice gain ramp rate (default 5s). Raised floor from 0.25 to 0.40 and shortened
  // ramp from 7s to 5s so regions sound present on first touch. LUFS audit (April 6)
  // showed 4+ dB gap between active expression and settled loop — too distant at start.
  // Strum is unaffected (operates on per-voice gains, not mainGain).
  const gainT = voice.gainEvoTime || 5;
  out.filter     = smoothstep(t / filterT);
  out.gain       = 0.40 + (gMax - 0.40) * smoothstep(t / gainT);
  out.secondary  = smoothstep((t - 3) / 4);
  out.deepReverb = smoothstep((t - 3) / 7);
  out.lfo        = smoothstep((t - 7) / 8);
  out.width      = smoothstep((t - 1) / 5);
}

/** Loop-state targets from complexity (0–1), with per-voice gain.
 *  Loop gain varies by register (Fletcher-Munson equal-loudness):
 *  bass voices need more gain to feel equally present at loop level.
 */
function getLoopTarget(complexity, voice) {
  return {
    filter:     0.1 + complexity * 0.35,
    gain:       voice.loopGain || 0.2,
    secondary:  complexity > 0.15 ? complexity * 0.4 : 0,
    deepReverb: complexity * 0.4,
    lfo:        complexity * 0.3,
    width:      complexity > 0.1 ? complexity * 0.35 : 0,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

const regions = {};
let buildingRegionId = null;
let mouseUpPending = false;
let sharedReverb = null;
let sharedDeepReverb = null;
let masterLimiter = null;
let peakMasterLimiterGR = 0;  // running peak: worst (most negative) master limiter GR since last diagnostic read
let initPromise = null;
let animFrameId = null;
let onStateChange = null;  // callback: (regionId, newState, oldState) => void

// ── AudioWorklet feature flag ─────────────────────────────────────────────────
// Toggle to A/B test worklet vs Tone.js implementation for CS strings.
// Set window.USE_CS_WORKLET = false in console to use original Tone.js synths.
// Shared effects chain: route all 3 special voice systems through 1 shared Freeverb
// instead of 3 independent Freeverbs. Saves ~16-24 IIR filters of render budget.
// Toggle via window.USE_SHARED_FX (default false for A/B testing).
// Default OFF: per-system Freeverbs with disconnect-on-deactivation are cheaper
// than a shared always-active Freeverb. The shared approach only saves at idle.
const USE_SHARED_FX = window.USE_SHARED_FX !== undefined ? window.USE_SHARED_FX : false;
let sharedSpecialFreeverb = null;  // shared Freeverb for WH/LW/CS send/return

// AudioWorklet with wavetable lookup for CS strings.
// Set window.USE_CS_WORKLET = false to compare with Tone.js native nodes.
const USE_CS_WORKLET = window.USE_CS_WORKLET !== undefined ? window.USE_CS_WORKLET : true;
let _csWorkletReady = false;  // true after audioWorklet.addModule() resolves


// AudioWorklet with wavetable lookup for WH harp voices (9 fatsine → 1 worklet node).
// Set window.USE_WH_WORKLET = false to compare with Tone.js native nodes.
const USE_WH_WORKLET = window.USE_WH_WORKLET !== undefined ? window.USE_WH_WORKLET : true;
let _whWorkletReady = false;  // true after audioWorklet.addModule() resolves

// AudioWorklet with wavetable lookup for LW branch voices (7 fatsine → 1 worklet node).
// Set window.USE_LW_WORKLET = false to compare with Tone.js native nodes.
const USE_LW_WORKLET = window.USE_LW_WORKLET !== undefined ? window.USE_LW_WORKLET : true;
let _lwWorkletReady = false;  // true after audioWorklet.addModule() resolves

// AudioWorklet for Village Pulse overtones (10 sine oscillators → 1 worklet node).
// Set window.USE_VP_WORKLET = false to compare with Tone.js native nodes.
const USE_VP_WORKLET = window.USE_VP_WORKLET !== undefined ? window.USE_VP_WORKLET : true;
let _vpWorkletReady = false;

// AudioWorklet for Night Sky voices (6 fatsine voices → 1 worklet node).
// Set window.USE_NS_WORKLET = false to compare with Tone.js native nodes.
const USE_NS_WORKLET = window.USE_NS_WORKLET !== undefined ? window.USE_NS_WORKLET : true;
let _nsWorkletReady = false;

// Step A.5 (2026-04-12): force the native AudioContext to `suspended` state
// immediately after creation, overriding Chrome's autoplay-resume decision.
// Tests Hypothesis F — that "context came up running via autoplay" is the
// actual determinant of the 12× DSP regression, independent of when we
// accessed it. Opt-in via ?forceSuspend=1. When enabled, the context stays
// suspended until the Play-click handler calls Tone.start(), guaranteeing
// every session goes through an explicit user-gesture resume transition.
// See docs/audio-regression-trace-2026-04-12.md § Phase 0.4 diagnostic run findings.
const FORCE_SUSPEND = (() => {
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get('forceSuspend') === '1') return true;
    if (window._forceSuspend === true) return true;
  } catch (e) {}
  return false;
})();

// ── Phase 2: custom FDN reverb worklet (replaces 6 Tone.js reverbs) ─────────
// Default code path for all 6 reverb positions: Cypress lwDarkReverb, Village
// vpReverb, Wind Harp reverb, Celestial Strings csColdReverb, and both
// sharedReverb + sharedDeepReverb. The existing Tone.Freeverb paths are
// preserved as a graceful fallback if the worklet module fails to load
// (network/CSP/cache edge cases) — the readiness check is `_fdnReverbReady`,
// set true only after `Tone.context.addAudioWorkletModule()` resolves.
// See docs/phase2-fdn-reverb-design-2026-04-13.md.
let _fdnReverbReady = false;            // true after Tone.context.addAudioWorkletModule() resolves

// ── Phase 3: native Phaser factory ──────────────────────────────────────────
// Hand-built mono allpass chain replacing Tone.Phaser. Uses 4 native
// BiquadFilterNode instances in series with k-rate effective frequency
// modulation from a JS rAF LFO updating .frequency.value at ~60 Hz.
//
// Returns a wrapper object (not a Tone node) compatible with the Tone.Phaser
// API surface used at the 5 region call sites:
//   - .input — Tone.Gain that upstream Tone.connect() walks to via .input
//   - .wet — Tone.Signal (crossFade.fade) with .value, .cancelAndHoldAtTime,
//     .setTargetAtTime, .cancelScheduledValues, .rampTo
//   - .frequency — proxy with .value getter/setter (writes back into the LFO state)
//   - .connect(dst) / .disconnect(...) — delegates to crossFade.connect/disconnect
//     so wrapper.connect(downstream) routes the dry+wet sum
//   - .set({ wet }) — only handles wet, the only key passed at call sites
//   - .dispose() — stops the rAF loop and tears down the internal nodes
//
// Crossfade math matches Tone.Effect (equal-power via Tone.CrossFade) so the
// dry/wet mix at any wet value sounds like the original Tone.Phaser, not an
// additive sum that would be louder.
//
// Native → Tone bridge (filters[3] → crossFade.b) uses the same _gainNode
// access pattern as the cypress FDN wiring at region-synths.js:1843, since
// std-audio-context's connect() can't unwrap Tone composites.
//
// See docs/phase3-phaser-research-2026-04-13.md for the architectural
// justification and the empirical cost decomposition that motivated this.
function _makePhaser({ frequency, octaves, baseFrequency, wet }) {
  const initialWet = wet != null ? wet : 0;
  const oct = octaves != null ? octaves : 3;
  const baseFreq = baseFrequency != null ? baseFrequency : 400;
  let _sweepHz = frequency != null ? frequency : 0.05;
  const STAGES = 4;

  // Returning an actual Tone.Gain (not a plain object) is required: Tone's
  // connect chain ultimately hands the destination to std-audio-context's
  // wrapped connect, which can only resolve nodes in its own registry. Plain
  // objects fail with "A value with the given key could not be found" from
  // get-native-audio-param.js. outputGain is the SUM point + the wrapper we
  // return; inputGain is what external upstream connects should land on,
  // exposed via an Object.defineProperty override of outputGain.input.
  const inputGain = new Tone.Gain(1);
  const outputGain = new Tone.Gain(1);
  const crossFade = new Tone.CrossFade(initialWet);

  // BiquadFilter must be created on the same context wrapper as the Tone
  // nodes, otherwise InvalidAccessError on connect. Tone.context.rawContext
  // is the std-audio-context wrapped instance — Tone's own nodes live there.
  const ctx = Tone.context.rawContext;
  const midFreq = baseFreq * Math.pow(2, oct / 2);
  const filters = new Array(STAGES);
  for (let i = 0; i < STAGES; i++) {
    const f = ctx.createBiquadFilter();
    f.type = 'allpass';
    f.Q.value = 1;
    f.frequency.value = midFreq;
    filters[i] = f;
  }

  // ── Internal wiring (before the .input override, so Tone walks normally) ──
  //   inputGain ──┬→ crossFade.a                                  (dry)
  //               └→ filters[0] → … → filters[3] → crossFade.b   (wet)
  //   crossFade.output → outputGain                                (sum)
  inputGain.connect(crossFade.a);
  inputGain.connect(filters[0]);
  for (let i = 0; i < STAGES - 1; i++) filters[i].connect(filters[i + 1]);
  const wetEntryNative = crossFade.b._gainNode || crossFade.b.input || crossFade.b;
  filters[STAGES - 1].connect(wetEntryNative);
  crossFade.connect(outputGain);

  // ── Override outputGain.input so external upstream connects land on inputGain ──
  // Internal connects above used the normal .input (outputGain's own native
  // gain), which is correct for the crossFade → outputGain sum. After this
  // override, only EXTERNAL Tone.connect() calls walking the destination's
  // .input will route to inputGain. outputGain.connect(downstream) still
  // routes from outputGain's underlying gain (the sum point), so the dry+wet
  // mix flows downstream correctly.
  Object.defineProperty(outputGain, 'input', {
    value: inputGain,
    writable: true,
    configurable: true,
  });

  // ── LFO: rAF-driven, ~60 Hz updates to filter.frequency.value ──
  // NOTE: assigning `.value = X` on an AudioParam wrapped by std-audio-context
  // (which Tone.context.rawContext is) internally calls setValueAtTime(X, now)
  // and APPENDS to the native AudioParam automation event list. That list is
  // never pruned, so a ~60 Hz write rate across 4 filters compounds to ~200k
  // events in 2m 45s, at which point every further insertion takes several ms.
  // Profile captured this as a monotonic main-thread leak:
  //   t=1s  : JS per-frame ~2.03 ms
  //   t=60s : JS per-frame ~3.58 ms (plus ~150 ms major GC sweeps)
  // Fix: call cancelScheduledValues(0) before the assignment so the automation
  // list stays bounded at 1 event per param. Native pattern, no allocation,
  // audibly identical to the prior behavior because we're rewriting `.value`
  // immediately afterward at the same time base.
  let lfoPhase = 0;
  let lastTime = performance.now();
  let rafId = null;
  function tick() {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    lfoPhase += 2 * Math.PI * _sweepHz * dt;
    if (lfoPhase > 2 * Math.PI) lfoPhase -= 2 * Math.PI;
    const norm = (Math.sin(lfoPhase) + 1) * 0.5;
    const freq = baseFreq * Math.pow(2, oct * norm);
    for (let i = 0; i < STAGES; i++) {
      const fp = filters[i].frequency;
      fp.cancelScheduledValues(0);
      fp.value = freq;
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  // ── Bolted-on Tone.Phaser-compatible API surface ──
  outputGain.wet = crossFade.fade;
  outputGain.frequency = {
    get value() { return _sweepHz; },
    set value(v) { _sweepHz = v; },
  };
  // .set() override — only handles wet, the only key passed at call sites.
  // Verified via grep before override; if other keys are passed in the
  // future, fall through to Tone.Gain's inherited set() logic.
  outputGain.set = (opts) => {
    if (opts && 'wet' in opts) crossFade.fade.value = opts.wet;
  };

  return outputGain;
}

// Starting parameters for each FDN instance. These are theoretical mappings
// from the original Tone.Freeverb roomSize/dampening values — NOT ear-tuned.
// The tuning panel in the sidebar lets you adjust each in real time; capture
// the final values via the "Copy current" button and hard-code here.
const FDN_PRESETS = {
  cypress:     { size: 6,  decay: 0.90, damping: 5050, drywet: 0.60, hardness: 1.25 },
  village:     { size: 6,  decay: 0.65, damping: 1800, drywet: 0.50, hardness: 1.25 },
  horizon:     { size: 40, decay: 0.92, damping: 8000, drywet: 0.40, hardness: 1.25 },
  stars:       { size: 30, decay: 0.88, damping: 8000, drywet: 0.50, hardness: 1.25 },
  shortShared: { size: 15, decay: 0.80, damping: 4000, drywet: 1.00, hardness: 1.25 },
  deepShared:  { size: 50, decay: 0.92, damping: 3000, drywet: 1.00, hardness: 1.25 },
};

// Registry of live FDN reverb worklet instances, keyed by preset id.
// Populated during preBuildAudioNodes once the FDN worklet module loads.
const _fdnInstances = {
  cypress:     { node: null, params: { ...FDN_PRESETS.cypress },     label: 'Cypress' },
  village:     { node: null, params: { ...FDN_PRESETS.village },     label: 'Village' },
  horizon:     { node: null, params: { ...FDN_PRESETS.horizon },     label: 'Horizon' },
  stars:       { node: null, params: { ...FDN_PRESETS.stars },       label: 'Celestial Strings' },
  shortShared: { node: null, params: { ...FDN_PRESETS.shortShared }, label: 'Shared Short' },
  deepShared:  { node: null, params: { ...FDN_PRESETS.deepShared },  label: 'Shared Deep' },
};

/**
 * Unwrap a Tone composite node down to its innermost std-audio-context
 * wrapped input. Used when calling `.connect()` FROM a std-wrapped source
 * (like an AudioWorkletNode) TO a Tone destination: std-audio-context's
 * connect can only resolve other std-wrapped nodes, so we have to walk
 * down Tone's `.input` chain to find the std-wrapper ourselves.
 *
 * Tone's own module-level connect() does the same thing — this is just a
 * local reimplementation because that function isn't on the public API.
 */
function _unwrapToneInput(dst) {
  let cur = dst;
  for (let i = 0; i < 10; i++) {
    if (!cur || typeof cur !== 'object') return cur;
    const next = cur.input;
    if (next === undefined || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Construct an FDN reverb AudioWorkletNode via `Tone.context.createAudioWorkletNode`,
 * which returns a standardized-audio-context wrapped node that integrates
 * cleanly with Tone.js's signal graph. Callers wire it via standard Tone
 * `.connect()` — no bridges, no manual unwrapping.
 *
 * This is the Tone.js v14 documented pattern used by Tone.BitCrusher and
 * other built-in worklet effects. The 5 voice worklets in this project use
 * a different bare-native pattern because they're source-only; this is the
 * correct pattern for effect worklets that need bidirectional graph integration.
 *
 * Returns null if the worklet module didn't load (e.g. network/CSP failure)
 * or construction failed — callers MUST handle null by falling back to the
 * Tone.Freeverb path.
 */
function _buildFdnReverbNode(presetId) {
  if (!_fdnReverbReady) return null;
  const preset = FDN_PRESETS[presetId];
  if (!preset) {
    console.warn('[FDN] Unknown preset id:', presetId);
    return null;
  }
  try {
    const node = Tone.context.createAudioWorkletNode('fdn-reverb-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { ...preset, _diagLabel: presetId },
    });
    _fdnInstances[presetId].node = node;
    _fdnInstances[presetId].params = { ...preset };
    _log(`%c[FDN]%c  ${presetId} worklet node created (preset: size=${preset.size}, decay=${preset.decay}, damping=${preset.damping})`,
      'color: #9cf; font-weight: bold', 'color: #999');
    return node;
  } catch (e) {
    console.warn(`[FDN] ${presetId} worklet construction failed, falling back to Tone.js path:`, e);
    return null;
  }
}

// ── Audio mode state ────────────────────────────────────────────────────────
// 'nocturne' = G natural minor (baseline). 'radiant' = G major (parallel major).
// Live-retune via setAudioMode(). Three pitch classes swap between modes:
// Bb→B, Eb→E, F→F#. G/A/C/D unchanged. See docs/radiant-audio-mode-plan.md.
let _activeMode = 'nocturne';
// Module-wide gain multiplier applied inside applyParams + worklet gain sends.
// The original Wicker 1968 +3 dB Radiant bias was eaten by the master limiter
// (threshold -1 dB) so listeners perceived no lift — or a slight loss of
// dynamics from added limiter compression. Neutralized to 1.0 (match Nocturne
// level). Infrastructure retained as a scaling hook for future per-mode
// tuning (e.g. if a particular region benefits from asymmetric gain staging).
const MODE_GAIN_MUL = { nocturne: 1.0, radiant: 1.0 };
let _modeGainMul = 1.0;

// Module-wide filter cutoff multiplier applied in applyParams just before
// the Tone write. Radiant opens cutoffs ~20% to support "brighter major"
// character — a composer-orchestration idea. Applied after all per-region
// LW/NS filter adjustments so it's a uniform final shift.
const MODE_FILTER_MUL = { nocturne: 1.0, radiant: 1.2 };
let _modeFilterMul = 1.0;

// ── Night Sky (three-layer voice for region 3) ──────────────────────────────
// Vast, atmospheric, the negative space between the stars.
// Nocturne: G3, A3, D4, F4, G4, A4 — "Suspended Space" (no Bb, never declares minor).
// Radiant: F→F# → Gsus2 add M7, the prettiest mode-swap in the project.
const NS_FREQS = {
  nocturne: [196.00, 220.00, 293.66, 349.23, 392.00, 440.00],  // G3, A3, D4, F4, G4, A4
  radiant:  [196.00, 220.00, 293.66, 369.99, 392.00, 440.00],  // F4 → F#4
};
const NS_VOICE_COUNT = 6;
// Sub-foundation pad — one octave below voices, provides weight without masking
const NS_PAD_NOTES = {
  nocturne: ['A2', 'F3'],
  radiant:  ['A2', 'F#3'],  // F → F#
};
// Per-voice breathing rates (seconds per full cycle). Prime numbers ensure voices
// never sync — at any moment only 3-4 of 6 are prominent, creating spectral gaps
// for other regions to breathe through. Shorter than CS (31-79s) because NS voices
// sit in a tight 196-440 Hz band that needs frequent variation to avoid muddiness.
const NS_LFO_RATES = [5, 7, 11, 8, 13, 6];  // 5-13s cycles — noticeable within a 15-30s play session
const NS_LFO_DEPTH = 0.55;  // voices breathe from ~45% to 100% of hierarchy gain — present but shifting

const NS_FX = {
  phaserFreq: 0.04,      // very slow — glacial shimmer
  phaserMaxWet: 0.45,
  delayTime: 0.500,       // 500ms — longer than other regions for spaciousness
  delayFeedback: 0.30,
  delayMaxWet: 0.25,
  reverbRoomSize: 0.92,   // largest of all regions — vast
  reverbDampening: 3500,   // brighter than Stars (2500) — open sky, not enclosed
  reverbHPF: 300,          // keep sub rumble out of reverb tail
  limiterThreshold: -1,   // safety-only — matches master limiter philosophy
};

// ── Village Pulse (three-layer voice for region 2) ───────────────────────────
// No noise (village is sheltered). Low FM foundation + mid FM pad + fattened overtones.
// Warmth behind walls — the only human element in the painting.
// Nocturne: minor hearth (m6+m3). Radiant: same intervals major-ized (M6+M3).
const VP_LOW_PAD_NOTES = {
  nocturne: ['Eb2', 'Bb1'],
  radiant:  ['E2',  'B1'],
};
const VP_PAD_NOTES = {
  nocturne: ['Eb3', 'Bb3'],
  radiant:  ['E3',  'B3'],
};
const VP_OVERTONE_FREQS = {
  nocturne: [155.56, 196.00, 233.08, 261.63, 311.13, 466.16],  // Eb3, G3, Bb3, C4, Eb4, Bb4
  radiant:  [164.81, 196.00, 246.94, 293.66, 329.63, 493.88],  // E3,  G3, B3,  D4, E4,  B4
  //                                          ^^^^^^
  // Radiant swaps C4 → D4 (the P4 darkens major chord voicings; D4 is the
  // 5th of G major, a stable chord tone, brightens the hearth substantially).
};
const VP_OVERTONE_COUNT = 6;
const VP_OVERTONE_DETUNE = 6;  // cents offset for doubled overtones (fatness)
const VP_OVERTONE_LFO_RATES = [11, 13, 17, 19, 23, 29];  // prime-number breathing periods (seconds)
const VP_OVERTONE_BREATHE_DEPTH = 0.7;  // 0 = constant, 1 = full fade in/out
const VP_FM_DRIFT_PERIOD = 29;    // seconds — prime, won't sync with anything
const VP_FM_DRIFT_MIN = 0.4;     // pure, almost sine
const VP_FM_DRIFT_MAX = 1.5;     // richer overtones, not aggressive
const VP_LFO_MIN_RATE = 0.25;    // Hz at origin (1 pulse per 4 seconds)
const VP_LFO_MAX_RATE = 4.0;     // Hz at full drag (4 pulses per second)
const VP_RATE_DECAY_K = 1.0;     // ~1s to decay captured rate back to min on release

// Freeze-to-buffer tap (captures live output for idle region freezing)
let _freezeTapReady = false;

// Freeze-to-buffer constants
const FREEZE_IDLE_DELAY = 5;      // seconds of idle looping before capture starts
const FREEZE_CAPTURE_DURATION = 10; // seconds of audio to capture
const FREEZE_CROSSFADE_SEC = 2.5;  // seconds for loop crossfade window

// Note frequencies for CS strings. Nocturne = Gm scale. Radiant = G Ionian (full conversion).
// Bb4→B4, Eb5→E5, F5→F#5, Bb5→B5. When CS sounds simultaneously with Wind Harp
// (which stays Mixolydian, keeps F natural), the F/F# coexistence is accepted as
// modal-mixture expressive inflection (user decision 2026-04-18). See plan doc.
const CS_STRING_FREQS = {
  nocturne: [
    392.00,  // G4
    440.00,  // A4
    466.16,  // Bb4
    523.25,  // C5
    587.33,  // D5
    622.25,  // Eb5
    698.46,  // F5
    783.99,  // G5
    880.00,  // A5
    932.33,  // Bb5
    1046.50, // C6
    1174.66, // D6
  ],
  radiant: [
    392.00,  // G4
    440.00,  // A4
    493.88,  // B4   (was Bb4 466.16)
    523.25,  // C5
    587.33,  // D5
    659.26,  // E5   (was Eb5 622.25)
    739.99,  // F#5  (was F5 698.46)
    783.99,  // G5
    880.00,  // A5
    987.77,  // B5   (was Bb5 932.33)
    1046.50, // C6
    1174.66, // D6
  ],
};
const CS_STRING_COUNT = 12;

// Note frequencies for WH harp. Nocturne = Gm pentatonic.
// Radiant was G Mixolydian (2026-04-18, Bb→B only, F kept) as an attempt at
// "golden hour" warmth, but 2026-04-19 listening flipped to full G major
// pentatonic (F→F# both octaves) — cleaner major identity, avoids the
// modal-mixture collision with Stars CS's F#5 when both are active.
// Revert to Mixolydian by restoring F4 = 349.23 and F5 = 698.46 in radiant.
const WH_HARP_FREQS = {
  nocturne: [
    196.00,  // G3
    233.08,  // Bb3
    261.63,  // C4
    293.66,  // D4
    349.23,  // F4
    392.00,  // G4
    523.25,  // C5
    587.33,  // D5
    698.46,  // F5
  ],
  radiant: [
    196.00,  // G3
    246.94,  // B3   (was Bb3 233.08)
    261.63,  // C4
    293.66,  // D4
    369.99,  // F#4  (was F4 349.23 — full major pent, was Mixolydian exception)
    392.00,  // G4
    523.25,  // C5
    587.33,  // D5
    739.99,  // F#5  (was F5 698.46)
  ],
};
const WH_HARP_COUNT = 9;

// Note frequencies for LW branches. Nocturne = G2 harmonic series with Bb minor
// flavor. Radiant = Bb→B in both octaves (Gm → G maj partial).
const LW_BRANCH_FREQS = {
  nocturne: [
    98.00,   // G2
    146.83,  // D3
    196.00,  // G3
    233.08,  // Bb3
    293.66,  // D4
    392.00,  // G4
    466.16,  // Bb4
  ],
  radiant: [
    98.00,   // G2
    146.83,  // D3
    196.00,  // G3
    246.94,  // B3  (was Bb3 233.08)
    293.66,  // D4
    392.00,  // G4
    493.88,  // B4  (was Bb4 466.16)
  ],
};
const LW_BRANCH_COUNT = 7;

// ── Mode retune tables and utilities ────────────────────────────────────────
// Pitch-class cents offsets keyed by mode. Index = MIDI note % 12 (0 = C).
// Used to bend PolySynth _activeVoices (FMSynth detune fans to carrier +
// modulator, preserving FM sideband structure during the bend).
const PITCH_CLASS_CENTS = {
  nocturne: new Int8Array(12),  // all zeros — reference mode
  radiant: (() => {
    const a = new Int8Array(12);
    a[3]  = 100;  // Eb / D#
    a[5]  = 100;  // F
    a[10] = 100;  // Bb / A#
    return a;
  })(),
};

// Per-voice cents offsets for fallback synth arrays (sky.synths, harpSynths,
// stringSynths, branchSynths). Derived from the Hz deltas between nocturne
// and radiant *_FREQS tables so they stay in sync if pitches ever change.
function _buildFallbackCents(nocFreqs, radFreqs) {
  return {
    nocturne: nocFreqs.map(() => 0),
    radiant: nocFreqs.map((nocFreq, i) => {
      const radFreq = radFreqs[i];
      if (!nocFreq || !radFreq || Math.abs(radFreq - nocFreq) < 0.01) return 0;
      return Math.round(1200 * Math.log2(radFreq / nocFreq));
    }),
  };
}
const FALLBACK_CENTS = {
  nightSky:         _buildFallbackCents(NS_FREQS.nocturne,        NS_FREQS.radiant),
  windHarp:         _buildFallbackCents(WH_HARP_FREQS.nocturne,   WH_HARP_FREQS.radiant),
  celestialStrings: _buildFallbackCents(CS_STRING_FREQS.nocturne, CS_STRING_FREQS.radiant),
  livingWood:       _buildFallbackCents(LW_BRANCH_FREQS.nocturne, LW_BRANCH_FREQS.radiant),
};

/** Glide every active voice of a Tone PolySynth to target-mode detune.
 *  Accesses private _activeVoices — safe while Tone is pinned to 14.7.77.
 *  Released voices skipped by default: bending a fading voice produces a
 *  brief "sigh" that some listeners read as a glitch. Set includeReleased
 *  true if the sigh is preferred.
 *  Silent no-op for null / missing-voice PolySynths (pre-init). */
function glidePolySynthToMode(poly, mode, glideSec = 0.04, includeReleased = false) {
  if (!poly || !poly._activeVoices) return;
  const cents = PITCH_CLASS_CENTS[mode] || PITCH_CLASS_CENTS.nocturne;
  const now = Tone.now();
  for (const entry of poly._activeVoices) {
    if (!entry || !entry.voice || !entry.voice.detune) continue;
    if (entry.released && !includeReleased) continue;
    const midi = entry.midi | 0;  // coerce to int
    const pc = ((midi % 12) + 12) % 12;
    entry.voice.detune.cancelScheduledValues(now);
    entry.voice.detune.rampTo(cents[pc], glideSec);
  }
}

/** Glide a bare array of Tone.Synth / FMSynth voices (non-PolySynth fallback
 *  paths) to target-mode detune. `cents` is an Int8Array-like of per-voice
 *  offsets in cents; index i maps to synths[i]. */
function glideSynthArrayToMode(synths, cents, glideSec = 0.04) {
  if (!synths || !Array.isArray(synths) || !cents) return;
  const now = Tone.now();
  for (let i = 0; i < synths.length; i++) {
    const synth = synths[i];
    if (!synth || !synth.detune) continue;
    const c = cents[i] || 0;
    synth.detune.cancelScheduledValues(now);
    synth.detune.rampTo(c, glideSec);
  }
}

// Scratch buffers for Radiant mode-scaled worklet gains. Lazy per-worklet
// allocation via WeakMap avoids adding a field to every region state.
const _scaledGainScratch = new WeakMap();

/** Post a { type: 'gains', values: buf } message to a worklet with the active
 *  mode's gain multiplier applied. Fast path (no copy, no scale) when
 *  `_modeGainMul === 1.0` (Nocturne — the default). Scales into a per-worklet
 *  scratch Float32Array in Radiant to avoid per-frame allocations. */
function postWorkletGains(workletNode, buf) {
  if (!workletNode || !buf) return;
  if (_modeGainMul === 1.0) {
    workletNode.port.postMessage({ type: 'gains', values: buf });
    return;
  }
  let scratch = _scaledGainScratch.get(workletNode);
  if (!scratch || scratch.length !== buf.length) {
    scratch = new Float32Array(buf.length);
    _scaledGainScratch.set(workletNode, scratch);
  }
  for (let i = 0; i < buf.length; i++) scratch[i] = buf[i] * _modeGainMul;
  workletNode.port.postMessage({ type: 'gains', values: scratch });
}

// Per-region string-note overrides for mode swap (Strategy B — mutate VOICES
// in place so the ~23 triggerAttack call sites that read voice.notes /
// whCfg.harpNotes / csCfg.stringNotes / lwCfg.branchNotes etc. pick up the
// new mode without any call-site changes).
// Dot-path key format walks nested fields (e.g. 'livingWood.branchNotes').
// Region 5 (Stars) base notes are mode-neutral — only CelestialStrings swaps.
// Region 4 Wind Harp keeps F natural (Mixolydian) per user decision 2026-04-18.
const VOICES_MODE_OVERRIDES = {
  1: {
    'notes':                  { nocturne: ['G2', 'Bb2'],                                      radiant: ['G2', 'B2'] },
    'livingWood.branchNotes': { nocturne: ['G2', 'D3', 'G3', 'Bb3', 'D4', 'G4', 'Bb4'],       radiant: ['G2', 'D3', 'G3', 'B3', 'D4', 'G4', 'B4'] },
    'livingWood.padNotes':    { nocturne: ['G2', 'Bb2'],                                      radiant: ['G2', 'B2'] },
  },
  2: {
    'notes': { nocturne: ['D3', 'F3'], radiant: ['D3', 'F#3'] },
  },
  3: {
    'notes': { nocturne: ['G3', 'Bb3', 'D4'], radiant: ['G3', 'B3', 'D4'] },
  },
  4: {
    'notes':                { nocturne: ['D4', 'F4'],                                         radiant: ['D4', 'F#4'] },
    // Wind Harp Radiant = full G major pentatonic (2026-04-19 revision from
    // prior Mixolydian "F kept" approach; cleaner major identity, avoids
    // F/F# clash with Stars CS when both active).
    'windHarp.harpNotes':   { nocturne: ['G3', 'Bb3', 'C4', 'D4', 'F4', 'G4', 'C5', 'D5', 'F5'], radiant: ['G3', 'B3',  'C4', 'D4', 'F#4', 'G4', 'C5', 'D5', 'F#5'] },
  },
  5: {
    // 'notes' (G4/D5) unchanged — mode-neutral continuity anchor.
    // Celestial Strings does full Ionian conversion: Bb→B, Eb→E, F→F#.
    'celestialStrings.stringNotes': {
      nocturne: ['G4', 'A4', 'Bb4', 'C5', 'D5', 'Eb5', 'F5',  'G5', 'A5', 'Bb5', 'C6', 'D6'],
      radiant:  ['G4', 'A4', 'B4',  'C5', 'D5', 'E5',  'F#5', 'G5', 'A5', 'B5',  'C6', 'D6'],
    },
  },
};

/** Apply the active-mode string-note values into the VOICES table so that
 *  subsequent strum / retrigger calls read mode-correct note names directly
 *  (no need to touch the ~23 call sites). Walks the dot-path into each
 *  subobject and mutates its array field. Idempotent per mode. */
function _applyModeToVoices(mode) {
  for (const idStr of Object.keys(VOICES_MODE_OVERRIDES)) {
    const id = Number(idStr);
    const voice = VOICES[id];
    if (!voice) continue;
    const overrides = VOICES_MODE_OVERRIDES[id];
    for (const path of Object.keys(overrides)) {
      const values = overrides[path][mode];
      if (!Array.isArray(values)) continue;
      // Walk path into voice, creating nothing — we only mutate existing fields.
      const parts = path.split('.');
      let target = voice;
      for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]];
        if (!target) { target = null; break; }
      }
      if (!target) continue;
      target[parts[parts.length - 1]] = values;
    }
  }
}

// ── Shared FX helpers ──
// For the FDN reverb path (default), reverb wet is controlled via postMessage
// to the FDN worklet's drywet parameter. For the Tone.Freeverb fallback
// (triggered only if the FDN worklet fails to load), reverb wet goes through
// the Freeverb's wet parameter directly. For the legacy USE_SHARED_FX path,
// wet is controlled via send/return gains. These helpers abstract all three.
function _fxSetReverbWet(sys, value) {
  if (sys.useFdn && sys.fdnNode) {
    sys.fdnNode.port.postMessage({ type: 'params', drywet: value });
    if (sys.fdnPresetId && _fdnInstances[sys.fdnPresetId]) {
      _fdnInstances[sys.fdnPresetId].params.drywet = value;
    }
    return;
  }
  if (sys.useSharedFx) {
    if (sys.reverbSend) sys.reverbSend.gain.value = value;
    if (sys.returnGain) sys.returnGain.gain.value = value;
    if (sys.dryGain) sys.dryGain.gain.value = Math.max(0.2, 1 - value);
  } else {
    const rev = sys.reverb || sys.darkReverb || sys.coldReverb;
    if (rev) rev.wet.value = value;
  }
}
function _fxCancelReverb(sys, now) {
  if (sys.useFdn && sys.fdnNode) {
    // FDN worklet doesn't have AudioParam automation to cancel — no-op.
    return;
  }
  if (sys.useSharedFx) {
    if (sys.reverbSend) sys.reverbSend.gain.cancelScheduledValues(now);
    if (sys.returnGain) sys.returnGain.gain.cancelScheduledValues(now);
    if (sys.dryGain) sys.dryGain.gain.cancelScheduledValues(now);
  } else {
    const rev = sys.reverb || sys.darkReverb || sys.coldReverb;
    if (rev) rev.wet.cancelScheduledValues(now);
  }
}
function _fxRampReverbTo(sys, value, time) {
  if (sys.useFdn && sys.fdnNode) {
    // FDN uses its internal one-pole smoother; ignore the time argument and
    // just set the new target. Smoothing happens at ~5 ms inside the worklet.
    sys.fdnNode.port.postMessage({ type: 'params', drywet: value });
    if (sys.fdnPresetId && _fdnInstances[sys.fdnPresetId]) {
      _fdnInstances[sys.fdnPresetId].params.drywet = value;
    }
    return;
  }
  if (sys.useSharedFx) {
    if (sys.reverbSend) sys.reverbSend.gain.rampTo(value, time);
    if (sys.returnGain) sys.returnGain.gain.rampTo(value, time);
    if (sys.dryGain) sys.dryGain.gain.rampTo(Math.max(0.2, 1 - value), time);
  } else {
    const rev = sys.reverb || sys.darkReverb || sys.coldReverb;
    if (rev) rev.wet.rampTo(value, time);
  }
}
function _fxRampReverbDown(sys, now, tau) {
  if (sys.useFdn && sys.fdnNode) {
    sys.fdnNode.port.postMessage({ type: 'params', drywet: 0 });
    if (sys.fdnPresetId && _fdnInstances[sys.fdnPresetId]) {
      _fdnInstances[sys.fdnPresetId].params.drywet = 0;
    }
    return;
  }
  if (sys.useSharedFx) {
    if (sys.reverbSend) { sys.reverbSend.gain.cancelAndHoldAtTime(now); sys.reverbSend.gain.setTargetAtTime(0, now, tau); }
    if (sys.returnGain) { sys.returnGain.gain.cancelAndHoldAtTime(now); sys.returnGain.gain.setTargetAtTime(0, now, tau); }
    if (sys.dryGain) { sys.dryGain.gain.cancelAndHoldAtTime(now); sys.dryGain.gain.setTargetAtTime(1, now, tau); }
  } else {
    const rev = sys.reverb || sys.darkReverb || sys.coldReverb;
    if (rev) { rev.wet.cancelAndHoldAtTime(now); rev.wet.setTargetAtTime(0, now, tau); }
  }
}
function _fxSetReverbTarget(sys, value, now, tau) {
  if (sys.useFdn && sys.fdnNode) {
    sys.fdnNode.port.postMessage({ type: 'params', drywet: value });
    if (sys.fdnPresetId && _fdnInstances[sys.fdnPresetId]) {
      _fdnInstances[sys.fdnPresetId].params.drywet = value;
    }
    return;
  }
  if (sys.useSharedFx) {
    if (sys.reverbSend) { sys.reverbSend.gain.cancelAndHoldAtTime(now); sys.reverbSend.gain.setTargetAtTime(value, now, tau); }
    if (sys.returnGain) { sys.returnGain.gain.cancelAndHoldAtTime(now); sys.returnGain.gain.setTargetAtTime(value, now, tau); }
    if (sys.dryGain) { sys.dryGain.gain.cancelAndHoldAtTime(now); sys.dryGain.gain.setTargetAtTime(Math.max(0.2, 1 - value), now, tau); }
  } else {
    const rev = sys.reverb || sys.darkReverb || sys.coldReverb;
    if (rev) { rev.wet.cancelAndHoldAtTime(now); rev.wet.setTargetAtTime(value, now, tau); }
  }
}

// ── Horizon synth mode (region 4) ─────────────────────────────────────────────
let horizonSynthMode = 'windHarpV3';

function isWindHarpActive() {
  return horizonSynthMode === 'windHarpV3';
}

// ── Cypress synth mode (region 1) ─────────────────────────────────────────────
let cypressSynthMode = 'livingWood';
// Portato (louré) articulation is always active — pressure pulses are velocity-gated
// so they're inert at rest and only engage during active bowing.

function isLivingWoodActive() {
  return cypressSynthMode === 'livingWood';
}

// ── Sky synth mode (region 3) ────────────────────────────────────────────────
let skySynthMode = 'nightSky';

function isNightSkyActive() {
  return skySynthMode === 'nightSky';
}

// ── Stars synth mode (region 5) ──────────────────────────────────────────────
let starsSynthMode = 'celestialStrings';

function isCelestialStringsActive() {
  return starsSynthMode === 'celestialStrings';
}

/**
 * Set region state and fire lifecycle callback.
 * All r.state mutations go through this helper so ui.js can
 * track color transitions without polling.
 */
function setState(r, id, newState) {
  const old = r.state;
  // Guard: once stopping, only 'off' may follow — UNLESS the caller has
  // already canceled r.stopTimeouts (the catch/fresh-build paths in
  // regionMouseDown do this before re-entering 'building' or 'looping').
  // Without this guard, stale async continuations or event-handler race
  // conditions can fire setState('looping') after fadeOutRegion has already
  // set 'stopping', undoing the entire deactivation and causing a black
  // flash when the 4-second setState('off') timeout eventually fires.
  if (old === 'stopping' && newState !== 'off' && r.stopTimeouts) return;
  r.state = newState;
  // Invalidate dirty-flag cache so next applyParams writes all values
  if (old !== newState) r._prev = null;
  if (old !== newState && window._popDebug) {
    const gains = {
      main: r.mainGain ? r.mainGain.gain.value.toFixed(4) : '?',
      sec:  r.secondaryGain ? r.secondaryGain.gain.value.toFixed(4) : '?',
      deep: r.deepSend ? r.deepSend.gain.value.toFixed(4) : '?',
      filter: r.filter ? r.filter.frequency.value.toFixed(0) : '?',
    };
    _log(
      `%c[PopDebug]%c  region ${id}: ${old} → ${newState}  gains: main=${gains.main} sec=${gains.sec} deep=${gains.deep} filter=${gains.filter}Hz`,
      'color: #f44; font-weight: bold', 'color: #999'
    );
  }
  if (onStateChange && old !== newState) onStateChange(Number(id), newState, old);
}

// ── Native node helpers ──────────────────────────────────────────────────────
// Unwrap Tone.js / standardized-audio-context wrappers to get the browser's native AudioNode.
// Used for activation-critical operations where Tone.js wrapper overhead (~10ms/call) is too high.
function _nativeNode(toneNode) {
  // Tone.js wraps nodes in various patterns depending on node type.
  // Walk the chain: Tone wrapper → standardized-audio-context wrapper → native node.
  const inner = toneNode._gainNode      // Tone.Gain
             || toneNode._compressor    // Tone.Limiter / Tone.Compressor
             || toneNode._filters?.[0]  // Tone.Filter (array of BiquadFilterNodes)
             || toneNode.output         // generic Tone.js output
             || toneNode;
  return inner._nativeAudioNode || inner._nativeBiquadFilterNode || inner;
}

// ── Init ─────────────────────────────────────────────────────────────────────

// Pre-build all audio nodes (works on suspended AudioContext — no user gesture needed).
// Called eagerly on first mousemove so nodes are ready before the user clicks.
let buildPromise = null;
function preBuildAudioNodes() {
  if (buildPromise) return buildPromise;
  // Step A defang: prime audioDiag context reads BEFORE the mark fires so the
  // mark itself is the first post-prime ctx read. This is the moment at which
  // the natural (non-diagnostic) code path would have first touched Tone.context
  // (via the _nativeAudioContext access a few lines below). Any diagnostic
  // marks fired before this moment have `ctx=null` and do NOT force early
  // AudioContext creation — that's the whole point of Step A.
  audioDiag.primeContextAccess();
  audioDiag.mark('preBuildAudioNodes:start');
  buildPromise = (async () => {
    const _t0 = performance.now();
    try {

    // ── Load ALL AudioWorklet modules BEFORE building instruments ──
    // Await ensures WH/LW/CS get worklet paths (1 node each) instead of
    // Tone.js fallback (19+15+36 nodes). Adds ~50-100ms but eliminates
    // 34+ Tone.js nodes and dramatically reduces first-click INP.
    const _nativeForWorklet = Tone.context.rawContext._nativeAudioContext
                           || Tone.context.rawContext._nativeContext
                           || Tone.context.rawContext;

    // Step A.5 regression test — force context to suspended state immediately
    // after creation, overriding Chrome's autoplay-resume decision. Opt-in via
    // ?forceSuspend=1. Tests Hypothesis F (autoplay-resume at creation = bad state).
    // When enabled, Tone.start() on the Play click must be the thing that resumes
    // the context, guaranteeing an explicit gesture-resume transition every time.
    if (FORCE_SUSPEND && _nativeForWorklet && typeof _nativeForWorklet.suspend === 'function') {
      if (_nativeForWorklet.state === 'running') {
        _nativeForWorklet.suspend().then(() => {
          _log(
            `%c[ForceSuspend]%c  native AudioContext suspended immediately after creation (was running via autoplay)`,
            'color: #f80; font-weight: bold', 'color: #ccc'
          );
          audioDiag.mark('forceSuspend:suspended', { previousState: 'running' });
        }).catch(e => {
          console.warn('[ForceSuspend] suspend() rejected:', e);
        });
      } else {
        _log(
          `%c[ForceSuspend]%c  native AudioContext already in state=${_nativeForWorklet.state} at first access — no suspend needed`,
          'color: #f80; font-weight: bold', 'color: #ccc'
        );
        audioDiag.mark('forceSuspend:skipped', { state: _nativeForWorklet.state });
      }
    }
    if (_nativeForWorklet.audioWorklet) {
      const moduleLoads = [];
      if (USE_CS_WORKLET) {
        moduleLoads.push(
          _nativeForWorklet.audioWorklet.addModule('js/worklets/celestial-strings-processor.js')
            .then(() => { _csWorkletReady = true;
              _log('%c[AudioWorklet]%c  CelestialStringsProcessor loaded', 'color: #c9f; font-weight: bold', 'color: #999'); })
            .catch(e => { console.warn('[AudioWorklet]  CS processor failed:', e.message); })
        );
      }
      if (USE_WH_WORKLET) {
        moduleLoads.push(
          _nativeForWorklet.audioWorklet.addModule('js/worklets/wind-harp-processor.js')
            .then(() => { _whWorkletReady = true;
              _log('%c[AudioWorklet]%c  WindHarpProcessor loaded', 'color: #0cf; font-weight: bold', 'color: #999'); })
            .catch(e => { console.warn('[AudioWorklet]  WH processor failed:', e.message); })
        );
      }
      if (USE_LW_WORKLET) {
        moduleLoads.push(
          _nativeForWorklet.audioWorklet.addModule('js/worklets/living-wood-processor.js')
            .then(() => { _lwWorkletReady = true;
              _log('%c[AudioWorklet]%c  LivingWoodProcessor loaded', 'color: #6c6; font-weight: bold', 'color: #999'); })
            .catch(e => { console.warn('[AudioWorklet]  LW processor failed:', e.message); })
        );
      }
      if (USE_VP_WORKLET) {
        moduleLoads.push(
          _nativeForWorklet.audioWorklet.addModule('js/worklets/village-pulse-processor.js')
            .then(() => { _vpWorkletReady = true;
              _log('%c[AudioWorklet]%c  VillagePulseProcessor loaded', 'color: #0cf; font-weight: bold', 'color: #999'); })
            .catch(e => { console.warn('[AudioWorklet]  VP processor failed:', e.message); })
        );
      }
      if (USE_NS_WORKLET) {
        moduleLoads.push(
          _nativeForWorklet.audioWorklet.addModule('js/worklets/night-sky-processor.js')
            .then(() => { _nsWorkletReady = true;
              _log('%c[AudioWorklet]%c  NightSkyProcessor loaded', 'color: #36d; font-weight: bold', 'color: #999'); })
            .catch(e => { console.warn('[AudioWorklet]  NS processor failed:', e.message); })
        );
      }
      // Freeze-tap processor (for freeze-to-buffer optimization)
      moduleLoads.push(
        _nativeForWorklet.audioWorklet.addModule('js/worklets/freeze-tap-processor.js')
          .then(() => { _freezeTapReady = true;
            _log('%c[AudioWorklet]%c  FreezeTapProcessor loaded', 'color: #6cf; font-weight: bold', 'color: #999'); })
          .catch(e => { console.warn('[AudioWorklet]  Freeze tap failed:', e.message); })
      );
      // FDN reverb worklet (Phase 2 — default code path for all 6 reverbs).
      // Registered via `Tone.context.addAudioWorkletModule` (not the bare
      // native path) so that subsequent `createAudioWorkletNode` calls return
      // standardized-audio-context wrapped nodes that integrate with Tone.js's
      // signal graph. The bare-native path works for source-only worklets
      // (the 5 voice worklets above) but breaks for effect worklets that
      // need bidirectional Tone integration. If this load fails,
      // `_fdnReverbReady` stays false and the region construction falls
      // through to the Tone.Freeverb safety net at each call site.
      moduleLoads.push(
        Tone.context.addAudioWorkletModule('js/worklets/fdn-reverb-processor.js', 'fdn-reverb')
          .then(() => { _fdnReverbReady = true;
            _log('%c[AudioWorklet]%c  FDNReverbProcessor loaded (via Tone.context)', 'color: #9cf; font-weight: bold', 'color: #999'); })
          .catch(e => { console.warn('[AudioWorklet]  FDN reverb failed:', e && e.message); })
      );
      // Wait for ALL modules to load before building instruments.
      // Modules load in parallel (~50-100ms total). This ensures WH/LW/CS
      // use worklet paths instead of expensive Tone.js fallbacks.
      await Promise.all(moduleLoads);
      // Report worklet load status — failed worklets silently fall back to expensive Tone.js paths
      const failed = [];
      if (USE_CS_WORKLET && !_csWorkletReady) failed.push('CelestialStrings');
      if (USE_WH_WORKLET && !_whWorkletReady) failed.push('WindHarp');
      if (USE_LW_WORKLET && !_lwWorkletReady) failed.push('LivingWood');
      if (USE_VP_WORKLET && !_vpWorkletReady) failed.push('VillagePulse');
      if (USE_NS_WORKLET && !_nsWorkletReady) failed.push('NightSky');
      if (!_freezeTapReady) failed.push('FreezeTap');
      if (failed.length > 0) {
        console.error(`%c[AudioWorklet]%c  ${failed.length} worklet(s) FAILED to load: ${failed.join(', ')}. These regions will use slower Tone.js fallback paths.`,
          'color: #f44; font-weight: bold', 'color: #fc0');
      } else {
        _log(`%c[AudioWorklet]%c  All modules loaded (${moduleLoads.length} modules)`,
          'color: #0f0; font-weight: bold', 'color: #999');
      }
    }

    const _tWorklets = performance.now();
    _log(`%c[AudioBuild]%c  Worklet modules loaded: ${(_tWorklets - _t0).toFixed(0)}ms`, 'color: #0af; font-weight: bold', 'color: #ccc');
    audioDiag.mark('workletModules:loaded', { elapsedMs: (_tWorklets - _t0).toFixed(0) });

    // Master limiter — prevents clipping when multiple regions sum together.
    // Threshold -1dB gives headroom; catches peaks from reverb accumulation.
    masterLimiter = new Tone.Limiter(-1);
    masterLimiter.toDestination();

    // Short reverb — pure return (wet=1.0).
    // Each region has an explicit dry path (×0.7) and send path (×0.3),
    // equivalent to the previous inline wet=0.3 mix. Separated so bass
    // voices can high-pass the reverb send without affecting their dry signal.
    //
    // Phase 2: swap Tone.Reverb (ConvolverNode) for the custom FDN worklet
    // when the worklet has loaded successfully. sharedReverb / sharedDeepReverb
    // remain as references for code paths that access them directly, but
    // they're unconnected dummy nodes in the FDN case.
    sharedReverb = new Tone.Reverb({ decay: 3, wet: 1.0 });
    sharedDeepReverb = new Tone.Reverb({ decay: 12, wet: 1.0 });

    // Try FDN construction atomically: EITHER both succeed (FDN path) OR
    // fall back to Tone.Reverb for both. Mixing causes orphaned worklet nodes
    // and broken sends, so we pick one path for both shared instances together.
    let _sharedShortFdn = null;
    let _sharedDeepFdn = null;
    if (_fdnReverbReady) {
      _sharedShortFdn = _buildFdnReverbNode('shortShared');
      _sharedDeepFdn = _buildFdnReverbNode('deepShared');
      if (!_sharedShortFdn || !_sharedDeepFdn) {
        _sharedShortFdn = null;
        _sharedDeepFdn = null;
        _fdnInstances.shortShared.node = null;
        _fdnInstances.deepShared.node = null;
        console.warn('[FDN] Shared reverb worklet construction partially failed — reverting both to Tone.Reverb');
      }
    }
    if (_sharedShortFdn && _sharedDeepFdn) {
      // std-worklet → Tone: unwrap the destination's .input chain so
      // standardized-audio-context's connect() sees a std-wrapped destination.
      _sharedShortFdn.connect(_unwrapToneInput(masterLimiter));
      _sharedDeepFdn.connect(_unwrapToneInput(masterLimiter));
      _log('%c[FDN]%c  Shared reverbs wired to FDN worklet nodes (short + deep)',
        'color: #9cf; font-weight: bold', 'color: #999');
    } else {
      sharedReverb.connect(masterLimiter);
      sharedDeepReverb.connect(masterLimiter);
    }
    // Expose the FDN node refs so the per-voice send-gain wiring below can
    // route send-path signal to the FDN when active.
    sharedReverb._fdnNode = _sharedShortFdn;
    sharedDeepReverb._fdnNode = _sharedDeepFdn;

    // Shared Freeverb for special voice systems (WH/LW/CS send/return bus).
    // Median parameters from the 3 per-system Freeverbs: room 0.80, damp 2200.
    // Pure return (wet=1.0) — each system controls its own send/return gain.
    if (USE_SHARED_FX) {
      sharedSpecialFreeverb = new Tone.Freeverb({ roomSize: 0.80, dampening: 2200, wet: 1.0 });
      sharedSpecialFreeverb.channelCount = 1;
      sharedSpecialFreeverb.channelCountMode = 'explicit';
      // NOT connected to masterLimiter — routed back to per-system limiters via return gains
      _log('%c[SharedFX]%c  Shared Freeverb created (replaces 3 per-system Freeverbs)',
        'color: #0f0; font-weight: bold', 'color: #999');
    } else {
      _log('%c[SharedFX]%c  Per-system Freeverbs (original path)',
        'color: #f80; font-weight: bold', 'color: #999');
    }

    // Generate impulse responses in parallel, non-blocking.
    // Before generate() completes, ConvolverNode outputs silence (no buffer) —
    // harmless because all mainGain starts at 0 and takes ~200ms to ramp up,
    // so buffers are ready before audible signal reaches the reverb sends.
    Promise.all([
      sharedReverb.generate(),
      sharedDeepReverb.generate(),
    ]).then(() => {
      _log(
        '%c[RegionSynth]%c  Reverb impulse responses ready',
        'color: #f0a; font-weight: bold', 'color: #999'
      );
    });

    for (const [id, voice] of Object.entries(VOICES)) {
      // Chain (send/return architecture):
      //   synths → filter → mainGain → panner → chorus → dryGain(0.7) → masterLimiter  (dry)
      //                                         chorus → [HPF?] → shortSend(0.3) → sharedReverb
      //                      mainGain → [HPF?] → deepSend → sharedDeepReverb → masterLimiter
      //
      // Panner sets each region's home stereo position. Chorus widens around it.
      // Deep reverb taps pre-panner (from mainGain) so long tails stay centered.
      // Bass voices (Cypress, Village) have HPF on reverb sends to prevent low-end mud.
      const mainGain = new Tone.Gain(0);
      // Force mono pre-panner — synths are inherently mono. This ensures
      // filter, mainGain, and deepSend all process mono. Panner converts
      // to stereo downstream.
      mainGain.channelCount = 1;
      mainGain.channelCountMode = 'explicit';

      const deepSend = new Tone.Gain(0);
      // Route to FDN worklet if active, otherwise to Tone.Reverb.
      if (sharedDeepReverb._fdnNode) {
        deepSend.connect(sharedDeepReverb._fdnNode);
      } else {
        deepSend.connect(sharedDeepReverb);
      }

      // Static pan position — places each region in a distinct stereo location.
      // Inserted before chorus so stereo width expands around the home position.
      const panner = new Tone.Panner(voice.pan || 0);
      mainGain.connect(panner);

      // Insert Chorus between panner and dry/send paths (all regions).
      // Per-voice tuning: simpler waveforms (triangle, sine) need deeper chorus
      // for perceptible stereo width — sawtooth voices use defaults.
      const cc = voice.chorusConfig || {};
      const chorus = new Tone.Chorus({
        frequency: 0.8,                  // slow LFO for gentle stereo motion
        delayTime: cc.delayTime || 3.5,  // ms — subtle chorus, not flanging
        depth: cc.depth || 0.7,
        wet: 0,                          // starts dry — evolution + expression opens it
        feedback: cc.feedback || 0.1,
      });
      // Chorus LFO is NOT started here — deferred to first non-zero wet in applyParams.
      // Chrome processes started LFO oscillators every quantum even at wet=0.
      // The dry signal path through Chorus works without .start() (wet/dry crossfade
      // is independent of the LFO). If dry passthrough fails, applyParams falls back
      // to starting it immediately.
      panner.connect(chorus);

      // Dry path: chorus → dryGain(0.7) → masterLimiter
      // Gain 0.7 compensates for removing the reverb's inline dry passthrough
      // (was wet=0.3, so 70% dry passed through the reverb node).
      const dryGain = new Tone.Gain(0.7);
      chorus.connect(dryGain);
      dryGain.connect(masterLimiter);

      // Short reverb send: 0.3 matches the previous wet=0.3 mix level.
      const shortReverbSend = new Tone.Gain(0.3);
      // Route to FDN worklet if active, otherwise to Tone.Reverb.
      if (sharedReverb._fdnNode) {
        shortReverbSend.connect(sharedReverb._fdnNode);
      } else {
        shortReverbSend.connect(sharedReverb);
      }

      if (voice.reverbHPF) {
        // Bass voices: high-pass reverb sends to prevent low-end mud in tails.
        // 12dB/octave rolloff — gentle, reduces bass energy without sounding thin.
        // Dry signal remains full-range and unaffected.
        const hpfShort = new Tone.Filter({
          frequency: voice.reverbHPF,
          type: 'highpass',
          rolloff: -12,
        });
        chorus.connect(hpfShort);
        hpfShort.connect(shortReverbSend);

        const hpfDeep = new Tone.Filter({
          frequency: voice.reverbHPF,
          type: 'highpass',
          rolloff: -12,
        });
        mainGain.connect(hpfDeep);
        hpfDeep.connect(deepSend);
      } else {
        // Mid/high voices: unfiltered reverb sends
        chorus.connect(shortReverbSend);
        mainGain.connect(deepSend);  // deepSend taps dry signal, not chorused
      }

      const filter = new Tone.Filter({
        frequency: voice.filterClosed,
        type: 'lowpass',
      }).connect(mainGain);

      // Secondary synth blends through its own gain before joining the filter
      const secondaryGain = new Tone.Gain(0).connect(filter);

      const primarySynth = voice.buildPrimary(filter);
      primarySynth.volume.value = voice.volume;

      const secondarySynth = voice.buildSecondary(secondaryGain);
      secondarySynth.volume.value = voice.volume - 3;  // sit behind primary

      // Per-voice mouse expression defaults — simpler waveforms (triangle, sine)
      // need higher sensitivity to produce perceptible filter/width changes during drag.
      const med = voice.mouseExprDefaults || {};

      // Precompute transient decay rate: reach ~5% in decayMs at 60fps
      // Per-frame multiplier = exp(-16.67ms * 3 / decayMs)
      const ftDecay = voice.filterTransient
        ? Math.exp(-50 / voice.filterTransient.decayMs)
        : 0.9;

      regions[id] = {
        state: 'off',
        primarySynth, secondarySynth, secondaryGain,
        filter, mainGain, deepSend, shortReverbSend, chorus,
        buildStartTime: 0,
        effectiveBuildTime: 0,
        lastTickTime: 0,
        holdDuration: 0,
        loopTarget: null,
        energy: 0,
        currentParams: { filter: 0, gain: 0, secondary: 0, deepReverb: 0, lfo: 0, width: 0 },
        stopTimeouts: null,
        strumTimer: null,
        // Filter transient: additive offset in normalized filter space, decays exponentially
        filterTransient: { offset: 0, decayPerFrame: ftDecay },
        // Inter-region ducking: when another region is actively interacted with,
        // this region's gain and filter pull back slightly to make room.
        // Smoothed per-frame in evolutionTick, applied as offsets in applyParams.
        duck: {
          gainTarget: 1.0,       // 1.0 = no duck, <1.0 = ducked (multiplier on gain)
          filterTarget: 0,       // 0 = no duck, negative = filter closure offset
          gainCurrent: 1.0,
          filterCurrent: 0,
          strumRecovery: false,  // true = use faster strum recovery rate
          strumTimer: null,
        },
        // Mouse expression state (all regions — drag during hold modulates filter/chorus/reverb)
        mouseExpr: {
          active: false,
          filterOffset: 0,
          chorusWet: 0,
          reverbOffset: 0,
          capturedFilter: 0,
          capturedChorusWet: 0,
          capturedReverbOffset: 0,
          // V3 wind harp strum expression
          v3StrumBoosts: new Float32Array(9),  // per-note additive strum gain spike
          v3LastStrumIndex: -1,                // last triggered note index (-1 = none)
          v3SpaceMacro: 0,                       // Y-axis macro control [-1, 1]: intimate ↔ expansive
          capturedV3SpaceMacro: 0,               // decaying captured macro on release
          // Living Wood bow expression (Cypress region 1)
          lwBowPosition: 0.5,                    // X-drag string register [0, 1]
          lwRootDepth: 0,                        // Y-drag bow contact point [-1, 1]
          lwDragVelocity: 0,                     // raw drag speed [0, 1] (smoothed per-frame)
          capturedLwBowPosition: 0,              // decaying captured bow on release
          capturedLwRootDepth: 0,                // decaying captured root depth on release
          // Celestial Strings strum expression (Stars region 5)
          csStrumBoosts: new Float32Array(12),   // per-note additive strum gain spike
          csLastStrumIndex: -1,                  // last triggered note index (-1 = none)
          csSpaceMacro: 0,                       // Y-axis macro control [-1, 1]
          capturedCsSpaceMacro: 0,               // decaying captured macro on release
          vhWindowFocus: 0,                        // live X — window attention [-1,1] (legacy, kept for captured decay)
          capturedVhWindowFocus: 0,                // decaying captured window focus on release (legacy)
          vhXFilterExpr: 0,                        // live X — filter sweep position [-1,1]
          capturedVhXFilter: 0,                    // decaying captured filter on release
          vhDragVelocity: 0,                       // raw drag speed [0,1] for breathing rate + delay
          vertSensitivity: med.vertSensitivity || 1.0,
          horizSensitivity: med.horizSensitivity || 1.0,
          maxFilterFraction: med.maxFilterFraction || 0.5,
          maxWidthRange: med.maxWidthRange || 0.65,
          normDistance: med.normDistance || 300,
        },
      };
    }

    // ── Stars analyzer tap (region 5) ──────────────────────────────────────────
    // Passive read-only AnalyserNode on the Stars mainGain (post-filter,
    // post-gain, pre-panner) so spectral features track synth evolution
    // without reverb tails muddying the signal.
    const starsCtx = Tone.context.rawContext || Tone.context._context;
    const starsAnalyzer = createAnalyzer(starsCtx);
    starsAnalyzer.analyserNode.disconnect();               // don't double-route to destination
    regions[5].mainGain.connect(starsAnalyzer.analyserNode); // fan-out tap, existing chain untouched
    regions[5].analyzer = starsAnalyzer;

    // ── Horizon analyzer tap (region 4) ──────────────────────────────────────
    // Same passive AnalyserNode pattern as Stars: tap on mainGain post-filter
    // so spectral features track Horizon synth evolution (D4/F4 voices).
    const horizonAnalyzer = createAnalyzer(starsCtx);
    horizonAnalyzer.analyserNode.disconnect();                 // don't double-route
    regions[4].mainGain.connect(horizonAnalyzer.analyserNode); // fan-out tap
    regions[4].analyzer = horizonAnalyzer;

    // ── Wind Harp nodes (Horizon region 4) ──────────────────────────────────
    // Build all three layers + effects. Connected to regions[4].filter so
    // the signal flows through the existing filter → mainGain → analyzer chain.
    // Wind harp nodes are activated/deactivated via activateWindHarp/deactivateWindHarp.
    {
      const wh = VOICES[4].windHarp;
      const r4 = regions[4];

      // Mix bus — all three layers merge here
      const harpMixBus = new Tone.Gain(0);
      // Force mono processing through the entire WH effects chain (Phaser, Delay,
      // Freeverb, Limiter). Halves Freeverb cost (8 filters instead of 16).
      // Stereo image is created downstream by the region's panner + chorus.
      harpMixBus.channelCount = 1;
      harpMixBus.channelCountMode = 'explicit';

      // Effects chain: harpMixBus → Phaser → FeedbackDelay → Reverb → filter
      const phaser = _makePhaser({
        frequency: wh.phaserFreq,
        octaves: 3,
        baseFrequency: 400,
        wet: 0,
      });
      const delay = new Tone.FeedbackDelay({
        delayTime: wh.delayTime,
        feedback: wh.delayFeedback,
        wet: 0,
      });
      let reverb = null;
      let whFdnNode = null;  // Phase 2: std-audio-context wrapped AudioWorkletNode
      let whReverbSend = null, whReturnGain = null, whDryGain = null;
      // Limiter: catches peaks when Y-macro pushes reverb/delay/pad gains high
      const harpLimiter = new Tone.Limiter(-6);
      // Meters deferred
      const meterPreFx = null;
      const meterPostLimiter = null;
      const meterNoise = null;
      const meterPad = null;
      const meterHarp = null;
      harpMixBus.connect(phaser);
      phaser.connect(delay);

      // FDN reverb path (Phase 2) takes precedence over Tone.Freeverb / shared-FX.
      if (_fdnReverbReady) {
        whFdnNode = _buildFdnReverbNode('horizon');
      }
      if (whFdnNode) {
        delay.connect(whFdnNode);
        whFdnNode.connect(_unwrapToneInput(harpLimiter));
        _log('%c[FDN]%c  Wind Harp wired to FDN reverb worklet', 'color: #9cf; font-weight: bold', 'color: #999');
      } else if (USE_SHARED_FX && sharedSpecialFreeverb) {
        // Send/return bus: delay splits to dry + shared reverb
        whDryGain = new Tone.Gain(1);
        whReverbSend = new Tone.Gain(0);
        whReturnGain = new Tone.Gain(0);
        delay.connect(whDryGain);
        whDryGain.connect(harpLimiter);
        delay.connect(whReverbSend);
        whReverbSend.connect(sharedSpecialFreeverb);
        sharedSpecialFreeverb.connect(whReturnGain);
        whReturnGain.connect(harpLimiter);
      } else {
        // Per-system Freeverb (original path)
        reverb = new Tone.Freeverb({ roomSize: 0.75, dampening: 3000, wet: 0 });
        delay.connect(reverb);
        reverb.connect(harpLimiter);
      }
      // Limiter → filter deferred to activateWindHarp() (not connected at build).
      // Pre-triggered pads push audio through the effects chain; connecting at build
      // causes Chrome to process Phaser→Delay→Freeverb→Limiter every quantum at idle.

      // Layer A: Wind Noise — dual source through shared AutoFilter → harpMixBus
      //   Pink noise: constant hiss texture
      //   Brown noise: gust body with slow asymmetric amplitude envelope
      const pinkNoise = new Tone.Noise('pink');
      pinkNoise.volume.value = wh.pinkVolume;
      const pinkGain = new Tone.Gain(0);

      const brownNoise = new Tone.Noise('brown');
      brownNoise.volume.value = wh.brownVolume;
      const brownGain = new Tone.Gain(0);

      // Shared master noise gain (secondary evolution controls overall level)
      const noiseGain = new Tone.Gain(0);

      const autoFilter = new Tone.AutoFilter({
        frequency: wh.autoFilterFreq,
        baseFrequency: wh.autoFilterBase,
        octaves: wh.autoFilterOctaves,
        type: 'sine', // smooth sweep — avoids sawtooth reset click
        wet: 1.0,
        filter: { type: 'bandpass', rolloff: -12, Q: wh.autoFilterQ },
      });

      pinkNoise.connect(pinkGain);
      brownNoise.connect(brownGain);
      pinkGain.connect(noiseGain);
      brownGain.connect(noiseGain);
      noiseGain.connect(autoFilter);
      // EQ: low-pass ceiling on noise — keeps it below upper harp notes (C5/D5/F5)
      const noiseLPF = new Tone.Filter({ frequency: 600, type: 'lowpass', rolloff: -12 });
      // Compressor: tame noise peaks that cause clipping while keeping attack presence
      const noiseComp = new Tone.Compressor({ threshold: -18, ratio: 6, attack: 0.003, release: 0.08 });
      autoFilter.connect(noiseLPF);
      noiseLPF.connect(noiseComp);
      noiseComp.connect(harpMixBus);

      // Layer B: Tonal Pad — fatsine FM on D4/F4 → Tremolo → harpMixBus
      const harpPad = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 2.0,
        modulationIndex: 0.8,
        oscillator: { type: 'fatsine', spread: 15 },
        modulation: { type: 'sine' },
        envelope: { attack: 0.08, decay: 0.3, sustain: 1.0, release: 1.5 },
        modulationEnvelope: { attack: 0.3, decay: 0.5, sustain: 0.5, release: 1.0 },
      });
      harpPad.volume.value = wh.padVolume;
      const tremolo = new Tone.Tremolo({
        frequency: wh.tremoloRate,
        depth: 0, // evolves 0→tremoloMaxDepth
        wet: 1.0,
      });
      tremolo.start();
      harpPad.connect(tremolo);
      // EQ: high-pass on pad — lifts FM fundamentals above lower harp range (G3/Bb3)
      const padHPF = new Tone.Filter({ frequency: 250, type: 'highpass', rolloff: -12 });
      tremolo.connect(padHPF);
      padHPF.connect(harpMixBus);

      // Layer C: Aeolian Harp — 9 fatsine voices
      // Route: worklet/synths → harpBus → harpMixBus (mono)
      // (Per-voice Freeverb removed — reverb via main system effects chain.)
      let harpBus = null;
      let whWorkletNode = null;

      // Path A: AudioWorklet (1 node replaces 9 Synths + 9 Gains + 1 harpBus = 19 nodes)
      if (USE_WH_WORKLET && _whWorkletReady) {
        try {
          const nativeCtx = Tone.context.rawContext._nativeAudioContext
                         || Tone.context.rawContext._nativeContext
                         || Tone.context.rawContext;
          whWorkletNode = new AudioWorkletNode(nativeCtx, 'wind-harp-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],  // mono — stereo created downstream by panner + chorus
            processorOptions: {
              sampleRate: nativeCtx.sampleRate || 22050,
              frequencies: WH_HARP_FREQS[_activeMode],
            },
          });
          // Connect worklet to harpMixBus via native node unwrapping.
          // NOTE: native connect() bypasses standardized-audio-context tracking.
          // harpMixBus renders because noise+pad provide tracked Tone.js inputs.
          // Do NOT remove those layers without adding an explicit keep-alive.
          const mixBusNative = harpMixBus._gainNode || harpMixBus.input || harpMixBus;
          const nativeMixBus = mixBusNative._nativeAudioNode || mixBusNative;
          whWorkletNode.connect(nativeMixBus);
          _log('%c[AudioWorklet]%c  WH harp: 1 worklet node (replaces 19 Tone.js nodes)',
            'color: #0cf; font-weight: bold', 'color: #999');
          audioDiag.registerWorklet('WH', whWorkletNode);
        } catch (e) {
          console.warn('[AudioWorklet]  WH worklet node creation failed, using Tone.js fallback:', e.message);
          whWorkletNode = null;
        }
      }

      // Path B: Tone.js fallback (original 19-node chain)
      const harpSynths = [];
      const harpGains = [];
      if (!whWorkletNode) {
        harpBus = new Tone.Gain(0.33); // 1/sqrt(9) — compensate for 9-voice summing
        harpBus.connect(harpMixBus);
        for (let i = 0; i < wh.harpNotes.length; i++) {
          const synth = new Tone.Synth({
            oscillator: { type: 'fatsine', spread: wh.harpSpread },
            envelope: { attack: 0.05, decay: 0.3, sustain: 1.0, release: 1.5 },
          });
          synth.volume.value = wh.harpVolume;
          const noteGain = new Tone.Gain(0);
          synth.connect(noteGain);
          noteGain.connect(harpBus);
          harpSynths.push(synth);
          harpGains.push(noteGain);
        }
        _log('%c[AudioWorklet]%c  WH harp: Tone.js fallback (19 nodes)',
          'color: #f80; font-weight: bold', 'color: #999');
      }

      r4.windHarp = {
        active: false,
        harpMixBus,
        harpBus,
        padHPF,
        noiseLPF,
        noiseComp,
        harpLimiter,
        meterPreFx,
        meterPostLimiter,
        meterNoise,
        meterPad,
        meterHarp,
        // Running-peak tracking (reset on diagnostic read)
        peakLimiterGR: 0,       // worst (most negative) limiter GR since last read
        peakPreFx: -Infinity,   // peak dB before effects
        peakPostLimiter: -Infinity, // peak dB after limiter
        phaser,
        delay,
        reverb,  // null when USE_SHARED_FX path or FDN path is active
        fdnNode: whFdnNode,
        fdnPresetId: whFdnNode ? 'horizon' : null,
        reverbSend: whReverbSend, returnGain: whReturnGain, dryGain: whDryGain,
        useSharedFx: USE_SHARED_FX && !!sharedSpecialFreeverb,
        useFdn: !!whFdnNode,
        pinkNoise,
        pinkGain,
        brownNoise,
        brownGain,
        noiseGain,
        autoFilter,
        // Gust LFO state (asymmetric amplitude envelope for brown noise)
        gustPhase: Math.random() * Math.PI * 2,
        gustRate: wh.gustLfoMinRate + Math.random() * (wh.gustLfoMaxRate - wh.gustLfoMinRate),
        harpPad,
        tremolo,
        harpSynths,
        harpGains,
        useWorklet: !!(USE_WH_WORKLET && whWorkletNode),
        workletNode: whWorkletNode,
        _workletGainBuf: new Float32Array(9),  // pre-allocated buffer for MessagePort gains
        // Per-note LFO phase accumulators (start with random offsets for immediate variety)
        lfoPhases: wh.lfoRates.map(() => Math.random() * Math.PI * 2),
        strumPadDuck: 0,  // 0-1, per-frame decay — ducks pad on click-strum for harp clarity
        // User-adjustable params (set via UI sliders)
        userParams: {
          autoFilterOctaves: wh.autoFilterOctaves,
          phaserMaxWet: wh.phaserMaxWet,
          tremoloRate: wh.tremoloRate,
          tremoloMaxDepth: wh.tremoloMaxDepth,
          delayTime: wh.delayTime,
          delayFeedback: wh.delayFeedback,
          // V3 strum expression — pluck intensity, decay, delay control
          v3StrumIntensity: 1.0,    // additive gain spike per pluck [0, 1.25]
          v3StrumDecay: 3.0,        // exponential decay rate (higher = faster fade) [1, 8]
          v3GateFloor: 0.05,        // LFO breathing floor — how audible notes are between plucks [0, 0.3]
          v3NoiseMix: 0.66,         // noise layer volume multiplier [0, 1]
          // V3 mix — per-layer volume + register balance
          v3PadMix: 0,              // pad volume in dB (base is padVolume=-12) [-24, 6]
          v3HarpVolume: 0,          // harp voice volume offset in dB (base is harpVolume=-14) [-24, 6]
          v3HarpBrightness: 0,      // per-note tilt: -1=dark (highs attenuated), +1=bright (lows attenuated) [-1, 1]
          v3ReverbMix: 0.35,        // reverb wet amount [0, 1]
          v3ReverbSize: 0.75,       // room size — how long the tail rings [0, 1]
        },
        lastDeactivateTime: 0,
        // Freeze-to-buffer state
        freezeTap: null, freezeState: 'live', freezeIdleTime: 0,
        frozenSource: null, frozenGain: null,
      };

      // Sources are NOT pre-triggered — they start lazily in activateWindHarp()
      // on first Horizon activation. Chrome's audio renderer has a strict per-quantum
      // budget (~2.9ms at 44100Hz). Pre-triggering 23+ oscillators at gain=0 consumes
      // 45-80% of the budget at idle, leaving no headroom for active regions.
      _log(
        '%c[RegionSynth]%c  Wind Harp nodes built (deferred activation) — 3 layers + Phaser + Delay',
        'color: #f0a; font-weight: bold', 'color: #0cf'
      );
    }

    // ── Living Wood nodes (Cypress region 1) ───────────────────────────────
    // Three-layer voice: earth rumble (brown noise + sub) + trunk resonance
    // (FM pad) + 7-voice overtone branches. Connected to regions[1].filter
    // so signal flows through existing filter → mainGain → analyzer chain.
    {
      const lw = VOICES[1].livingWood;
      const r1 = regions[1];

      // Mix bus — all three layers merge here
      const cypressMixBus = new Tone.Gain(0);
      // Force mono — same rationale as Wind Harp.
      cypressMixBus.channelCount = 1;
      cypressMixBus.channelCountMode = 'explicit';

      // Effects chain: cypressMixBus → Phaser → Delay → DarkReverb → Limiter → r1.filter
      const lwPhaser = _makePhaser({
        frequency: lw.phaserFreq,
        octaves: 3,
        baseFrequency: 200,   // lower base for dark character
        wet: 0,
      });
      const lwDelay = new Tone.FeedbackDelay({
        delayTime: lw.delayTime,
        feedback: lw.delayFeedback,
        wet: 0,
      });
      let lwDarkReverb = null;
      let lwFdnNode = null;  // Phase 2: standardized-audio-context wrapped AudioWorkletNode
      let lwReverbSend = null, lwReturnGain = null, lwDryGain = null;
      const lwLimiter = new Tone.Limiter(-6);
      // Meters deferred
      const lwMeterPreFx = null;
      const lwMeterPostLimiter = null;
      const lwMeterEarth = null;
      const lwMeterPad = null;
      const lwMeterBranch = null;
      cypressMixBus.connect(lwPhaser);
      lwPhaser.connect(lwDelay);

      // FDN reverb path (Phase 2) is the default; takes precedence over
      // Tone.Freeverb / shared-FX paths when the worklet module loaded cleanly.
      if (_fdnReverbReady) {
        lwFdnNode = _buildFdnReverbNode('cypress');
      }
      if (lwFdnNode) {
        // Tone → std-worklet: Tone's connect handles the destination side.
        // std-worklet → Tone: unwrap the destination's .input chain manually
        // because std-audio-context's connect() can't unwrap Tone composites.
        lwDelay.connect(lwFdnNode);
        lwFdnNode.connect(_unwrapToneInput(lwLimiter));
        _log('%c[FDN]%c  Cypress wired to FDN reverb worklet', 'color: #9cf; font-weight: bold', 'color: #999');
      } else if (USE_SHARED_FX && sharedSpecialFreeverb) {
        lwDryGain = new Tone.Gain(1);
        lwReverbSend = new Tone.Gain(0);
        lwReturnGain = new Tone.Gain(0);
        lwDelay.connect(lwDryGain);
        lwDryGain.connect(lwLimiter);
        lwDelay.connect(lwReverbSend);
        lwReverbSend.connect(sharedSpecialFreeverb);
        sharedSpecialFreeverb.connect(lwReturnGain);
        lwReturnGain.connect(lwLimiter);
      } else {
        lwDarkReverb = new Tone.Freeverb({ roomSize: lw.reverbRoomSize, dampening: lw.reverbDampening, wet: 0 });
        lwDelay.connect(lwDarkReverb);
        lwDarkReverb.connect(lwLimiter);
      }

      // Freeze-to-buffer tap: lwLimiter → freezeTap → r1.filter
      // When not capturing, tap is a zero-cost pass-through.
      // Limiter → filter deferred to activateCypressLivingWood() (not connected at build).
      // Freeze tap is attached lazily when capture starts.

      // Layer A: Earth Rumble — brown noise through steep lowpass + sine sub-oscillator
      const lwBrownNoise = new Tone.Noise('brown');
      lwBrownNoise.volume.value = lw.brownVolume;
      const lwBrownGain = new Tone.Gain(0);

      const lwEarthGain = new Tone.Gain(0);
      const lwBrownLPF = new Tone.Filter({
        frequency: lw.brownLpfFreq,
        type: 'lowpass',
        rolloff: -24,   // steep — keeps rumble firmly sub-bass
      });

      lwBrownNoise.connect(lwBrownGain);
      lwBrownGain.connect(lwEarthGain);
      lwEarthGain.connect(lwBrownLPF);
      lwBrownLPF.connect(cypressMixBus);

      // Sub-oscillator: pure sine at G1 (49Hz) — physical weight
      const lwSubSynth = new Tone.Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.1, decay: 0.3, sustain: 1.0, release: 2.0 },
      });
      lwSubSynth.volume.value = lw.subVolume;
      const lwSubGain = new Tone.Gain(0);
      lwSubSynth.connect(lwSubGain);
      lwSubGain.connect(cypressMixBus);

      // Layer B: Trunk Resonance — FM pad with low harmonicity (dark, organ-like)
      const lwTrunkPad = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: lw.padHarmonicity,
        modulationIndex: lw.padModIndexMin,
        oscillator: { type: 'triangle' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.08, decay: 0.3, sustain: 1.0, release: 1.5 },
        modulationEnvelope: { attack: 0.5, decay: 0.5, sustain: 0.5, release: 1.0 },
      });
      lwTrunkPad.volume.value = lw.padVolume;
      const lwTremolo = new Tone.Tremolo({
        frequency: lw.tremoloRate,
        depth: 0,   // evolves 0→tremoloMaxDepth
        wet: 1.0,
      });
      lwTremolo.start();
      const lwPadGain = new Tone.Gain(0);
      lwTrunkPad.connect(lwTremolo);
      lwTremolo.connect(lwPadGain);
      lwPadGain.connect(cypressMixBus);

      // Layer C: Overtone Branches — 7 fatsine voices
      // Route: worklet/synths → branchBus → cypressMixBus (mono)
      // (Per-voice Freeverb removed — reverb via main system effects chain.)
      let lwBranchBus = null;
      let lwWorkletNode = null;

      // Path A: AudioWorklet (1 node replaces 7 Synths + 7 Gains + 1 branchBus = 15 nodes)
      if (USE_LW_WORKLET && _lwWorkletReady) {
        try {
          const nativeCtx = Tone.context.rawContext._nativeAudioContext
                         || Tone.context.rawContext._nativeContext
                         || Tone.context.rawContext;
          lwWorkletNode = new AudioWorkletNode(nativeCtx, 'living-wood-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],  // mono — stereo created downstream by panner + chorus
            processorOptions: {
              sampleRate: nativeCtx.sampleRate || 22050,
              frequencies: LW_BRANCH_FREQS[_activeMode],
            },
          });
          // Connect worklet to cypressMixBus via native node unwrapping.
          // NOTE: native connect() bypasses standardized-audio-context tracking.
          // cypressMixBus renders because earth noise+pad provide tracked Tone.js inputs.
          // Do NOT remove those layers without adding an explicit keep-alive.
          const mixBusNative = cypressMixBus._gainNode || cypressMixBus.input || cypressMixBus;
          const nativeMixBus = mixBusNative._nativeAudioNode || mixBusNative;
          lwWorkletNode.connect(nativeMixBus);
          _log('%c[AudioWorklet]%c  LW branches: 1 worklet node (replaces 15 Tone.js nodes)',
            'color: #6c6; font-weight: bold', 'color: #999');
          audioDiag.registerWorklet('LW', lwWorkletNode);
        } catch (e) {
          console.warn('[AudioWorklet]  LW worklet node creation failed, using Tone.js fallback:', e.message);
          lwWorkletNode = null;
        }
      }

      // Path B: Tone.js fallback (original 15-node chain)
      const lwBranchSynths = [];
      const lwBranchGains = [];
      if (!lwWorkletNode) {
        lwBranchBus = new Tone.Gain(lw.branchBusGain);
        lwBranchBus.connect(cypressMixBus);
        for (let i = 0; i < lw.branchNotes.length; i++) {
          const synth = new Tone.Synth({
            oscillator: { type: 'fatsine', spread: lw.branchSpread },
            envelope: { attack: 0.05, decay: 0.3, sustain: 1.0, release: 1.5 },
          });
          synth.volume.value = lw.branchVolume;
          const noteGain = new Tone.Gain(0);
          synth.connect(noteGain);
          noteGain.connect(lwBranchBus);
          lwBranchSynths.push(synth);
          lwBranchGains.push(noteGain);
        }
        _log('%c[AudioWorklet]%c  LW branches: Tone.js fallback (15 nodes)',
          'color: #f80; font-weight: bold', 'color: #999');
      }

      r1.livingWood = {
        active: false,
        cypressMixBus,
        phaser: lwPhaser,
        delay: lwDelay,
        darkReverb: lwDarkReverb,  // null when USE_SHARED_FX path or FDN path is active
        fdnNode: lwFdnNode,
        fdnPresetId: lwFdnNode ? 'cypress' : null,
        reverbSend: lwReverbSend, returnGain: lwReturnGain, dryGain: lwDryGain,
        useSharedFx: USE_SHARED_FX && !!sharedSpecialFreeverb,
        useFdn: !!lwFdnNode,
        limiter: lwLimiter,
        meterPreFx: lwMeterPreFx,
        meterPostLimiter: lwMeterPostLimiter,
        meterEarth: lwMeterEarth,
        meterPad: lwMeterPad,
        meterBranch: lwMeterBranch,
        // Running-peak tracking
        peakLimiterGR: 0,
        peakPreFx: -Infinity,
        peakPostLimiter: -Infinity,
        // Layer A
        brownNoise: lwBrownNoise,
        brownGain: lwBrownGain,
        brownLPF: lwBrownLPF,
        earthGain: lwEarthGain,
        subSynth: lwSubSynth,
        subGain: lwSubGain,
        // Gust LFO state (asymmetric amplitude envelope — heavier than Wind Harp)
        gustPhase: Math.random() * Math.PI * 2,
        gustRate: lw.gustLfoMinRate + Math.random() * (lw.gustLfoMaxRate - lw.gustLfoMinRate),
        // Layer B
        trunkPad: lwTrunkPad,
        tremolo: lwTremolo,
        padGain: lwPadGain,
        trunkModIndex: 0,   // current FM depth (evolves per-frame)
        // Layer C
        branchSynths: lwBranchSynths,
        branchGains: lwBranchGains,
        branchBus: lwBranchBus,
        useWorklet: !!(USE_LW_WORKLET && lwWorkletNode),
        workletNode: lwWorkletNode,
        _workletGainBuf: new Float32Array(7),  // pre-allocated buffer for MessagePort gains
        // Per-note LFO phase accumulators (random start for immediate variety)
        lfoPhases: lw.lfoRates.map(() => Math.random() * Math.PI * 2),
        // Bow expression state
        smoothedVelocity: 0,
        scordaturaPhase: Math.random() * Math.PI * 2,
        // Strum (bow accent / martelé) state
        strumVelInjection: 0,  // velocity floor injection (decays to 0)
        portatoPhase: 0,       // portato pulse phase accumulator (radians)
        yFilterMul: 1.0,       // Y-axis filter frequency multiplier (read in applyParams)
        yGainScale: 1.0,       // Y-axis overall gain scale (read in applyParams)
        // Freeze-to-buffer state
        freezeTap: null,       // created lazily on first capture
        freezeState: 'live',   // 'live' | 'capturing' | 'frozen' | 'thawing'
        freezeIdleTime: 0,     // seconds since last interaction
        frozenSource: null,    // AudioBufferSourceNode (when frozen)
        frozenGain: null,      // native GainNode for crossfade (when frozen)
        // User-adjustable params (set via UI sliders)
        userParams: {
          earthMix: 0.4,
          subMix: 0.75,
          padMix: 2.0,
          trunkHarmonicity: 1.0,
          branchVolume: 0.3,
          velocitySensitivity: 1.0,
          reverbMix: 0.75,
          phaserWet: 0.5,
          delayMix: 0.15,
        },
        lastDeactivateTime: 0,
        // Freeze-to-buffer state
        freezeTap: null, freezeState: 'live', freezeIdleTime: 0,
        frozenSource: null, frozenGain: null,
      };

      // Sources are NOT pre-triggered — they start lazily in activateCypressLivingWood()
      // on first Cypress activation. Same rationale as Wind Harp: Chrome's audio
      // renderer budget is too tight for 23+ idle oscillators at gain=0.
      _log(
        '%c[RegionSynth]%c  Living Wood nodes built (deferred activation) — earth + trunk + 7 branch voices + Phaser + Delay + DarkReverb',
        'color: #f0a; font-weight: bold', 'color: #6c6'
      );
    }

    // Celestial Strings nodes are built LAZILY on first Stars activation
    // (see _buildCelestialStringsNodes below). Chrome's Web Audio renderer
    // crashes permanently when too many nodes (~150+) exist simultaneously.
    // Wind Harp + Living Wood already create ~130 nodes. Adding CS's ~50
    // nodes at build time pushes past the limit. Deferring CS construction
    // to first activation keeps the idle count safe.

    // ── Analyzer taps for regions 1-3 (Cypress, Village, Sky) ────────────
    // Same passive AnalyserNode pattern: tap mainGain post-filter.
    // Each gets its own independent createAnalyzer() instance with
    // self-normalizing rmsNorm (seeded peakRms) and perceptual features.
    for (const id of [1, 2, 3]) {
      const a = createAnalyzer(starsCtx);
      a.analyserNode.disconnect();
      regions[id].mainGain.connect(a.analyserNode);
      regions[id].analyzer = a;
    }

    // ── Master bus analyzer tap (lazy) ─────────────────────────────────
    // Only connects when profiling is requested. An always-connected
    // AnalyserNode (FFT 2048) costs ~20-30% render capacity at idle.
    window._masterAnalyzer = null;
    window._connectMasterAnalyzer = () => {
      if (window._masterAnalyzer) return window._masterAnalyzer;
      const a = createAnalyzer(starsCtx);
      a.analyserNode.disconnect();
      _nativeNode(masterLimiter).connect(a.analyserNode);
      window._masterAnalyzer = a;
      return a;
    };

    // ── Eager CS build ──
    // Build Celestial Strings now (was lazy on first star click).
    // Worklet modules are loaded, so CS gets the 1-node worklet path.
    _buildCelestialStringsNodes();

    // ── Village Pulse (three-layer voice — warmth behind walls) ─────────────────
    // No noise (sheltered). Low FM foundation + mid FM pad + fattened overtones.
    // Layer A: FMSynth D2/F2 (foundation — walls resonating, felt not heard)
    // Layer B: FMSynth D3/F3 → tremolo (tonal body, organ-like)
    // Layer C: 6 doubled sine overtones on Gm chord tones (fattened with detuning)
    // All layers → mix → LFO-gated gain → warm reverb → limiter → r2.filter
    {
      const r2 = regions[2];

      // ── Layer A: Low FM Foundation (the walls) ──
      // Same organ-like FM as the mid pad but an octave down. Quiet — felt more than heard.
      const vpLowPad = new Tone.PolySynth(Tone.FMSynth, {
        maxPolyphony: 2,
        voice: {
          harmonicity: 0.5,
          modulationIndex: 0.6,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: { attack: 0.5, decay: 0.3, sustain: 1.0, release: 2.0 },
          modulationEnvelope: { attack: 0.8, decay: 0.5, sustain: 0.7, release: 1.5 },
        },
      });
      vpLowPad.volume.value = -18;      // pulled back — foundation felt, not dominant
      const vpLowPadGain = new Tone.Gain(0.35);
      vpLowPad.connect(vpLowPadGain);

      // ── Layer B: Mid FM Pad (the hearth) ──
      // Harmonicity 0.5 = subharmonic FM → dark, organ-like. Same approach as cypress trunk.
      const vpPad = new Tone.PolySynth(Tone.FMSynth, {
        maxPolyphony: 2,
        voice: {
          harmonicity: 1.5,       // brighter, bell-like (low pad stays at 0.5 = organ-like)
          modulationIndex: 0.8,
          oscillator: { type: 'sine' },
          modulation: { type: 'sine' },
          envelope: { attack: 0.3, decay: 0.3, sustain: 1.0, release: 1.5 },
          modulationEnvelope: { attack: 0.5, decay: 0.5, sustain: 0.8, release: 1.0 },
        },
      });
      vpPad.volume.value = -7;         // pushed forward — bell-like harmonics lead
      const vpTremolo = new Tone.Tremolo({ frequency: 0.15, depth: 0.3 });
      const vpPadGain = new Tone.Gain(0.8);
      vpPad.connect(vpTremolo);
      vpTremolo.connect(vpPadGain);

      // ── Layer C: Fattened sine overtones (5 × 2 voices, Gm chord tones) ──
      // Path A (worklet): single AudioWorkletNode replaces 10 oscillators + 5 gains
      // Path B (fallback): Tone.js oscillators with per-voice gain nodes
      let vpWorkletNode = null;
      const vpOvertoneGains = [];
      const vpOvertoneOscs = [];
      const vpOvertoneOscsB = [];
      const vpOvertoneBus = new Tone.Gain(0.5);

      if (USE_VP_WORKLET && _vpWorkletReady) {
        try {
          const nativeCtx = Tone.context.rawContext._nativeAudioContext
                         || Tone.context.rawContext._nativeContext
                         || Tone.context.rawContext;
          vpWorkletNode = new AudioWorkletNode(nativeCtx, 'village-pulse-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
              sampleRate: nativeCtx.sampleRate || 22050,
              frequencies: VP_OVERTONE_FREQS[_activeMode],
              spreadCents: VP_OVERTONE_DETUNE,
            },
          });
          // Connect worklet output to overtone bus via native node unwrapping
          const busNative = vpOvertoneBus._gainNode || vpOvertoneBus.input || vpOvertoneBus;
          const nativeBus = busNative._nativeAudioNode || busNative;
          vpWorkletNode.connect(nativeBus);
          // No keep-alive needed — FM pads provide Tone.js graph tracking on vpMix
          _log('%c[AudioWorklet]%c  VP overtones: 1 worklet node (replaces 16 Tone.js nodes)',
            'color: #0cf; font-weight: bold', 'color: #999');
          audioDiag.registerWorklet('VP', vpWorkletNode);
        } catch (e) {
          console.warn('[AudioWorklet]  VP worklet creation failed, using Tone.js fallback:', e.message);
          vpWorkletNode = null;
        }
      }

      // Path B: Tone.js fallback (10 oscillators + 5 gains)
      if (!vpWorkletNode) {
        for (let i = 0; i < VP_OVERTONE_FREQS[_activeMode].length; i++) {
          const freq = VP_OVERTONE_FREQS[_activeMode][i];
          const freqB = freq * Math.pow(2, VP_OVERTONE_DETUNE / 1200);

          const oscA = new Tone.Oscillator({ type: 'sine', frequency: freq });
          const oscB = new Tone.Oscillator({ type: 'sine', frequency: freqB });
          oscA.volume.value = -14;
          oscB.volume.value = -14;

          const g = new Tone.Gain(0);
          oscA.connect(g);
          oscB.connect(g);
          g.connect(vpOvertoneBus);

          vpOvertoneOscs.push(oscA);
          vpOvertoneOscsB.push(oscB);
          vpOvertoneGains.push(g);
        }
        _log('%c[AudioWorklet]%c  VP overtones: Tone.js fallback (16 nodes)',
          'color: #f80; font-weight: bold', 'color: #999');
      }

      // ── LFO → master gain (rhythm engine) ──
      // Sine LFO for smooth audio-rate amplitude modulation.
      const vpLFO = new Tone.LFO({
        frequency: VP_LFO_MIN_RATE,
        min: 0,
        max: 1,
        type: 'sine',
      });
      const vpGain = new Tone.Gain(0);

      // ── Proximity filter (X-axis drives this — closer = brighter) ──
      const vpProxFilter = new Tone.Filter({
        frequency: 400,
        type: 'lowpass',
        rolloff: -12,
      });

      // ── Room tone: quiet pink noise through bandpass (the sound of interior stillness) ──
      // Not wind (sky's domain), not rumble (cypress). Just the ambient hum of a building.
      // Adds spectral flux — the difference between "synth patch" and "a place."
      const vpRoomNoise = new Tone.Noise('pink');
      vpRoomNoise.volume.value = -24;
      const vpRoomBP = new Tone.Filter({ frequency: 400, type: 'bandpass', Q: 0.8 });
      const vpRoomGain = new Tone.Gain(0.3);
      vpRoomNoise.connect(vpRoomBP);
      vpRoomBP.connect(vpRoomGain);

      // ── Mix bus: all layers merge → proximity filter → LFO gate ──
      // Initial gain is 0, not the 2.0 steady-state target. The FM pads are
      // pre-triggered at gain=0.35 during init so their oscillators are always
      // running, but until vpMix opens up their signal is zeroed here. Without
      // this, the sustained pad output accumulates into the FDN reverb's
      // internal state before activation, and when vpLimiter connects to
      // r.filter the accumulated signal reflects out as an audible click at
      // process call #1. Activation ramps vpMix smoothly from 0 up to 2.0.
      const vpMix = new Tone.Gain(0);    // +6dB (2.0) reached on activation
      vpLowPadGain.connect(vpMix);
      vpPadGain.connect(vpMix);
      vpOvertoneBus.connect(vpMix);
      vpRoomGain.connect(vpMix);
      vpMix.connect(vpProxFilter);

      // ── Phaser (sound passing through window glass / stone walls) ──
      // Very slow rate — matches other special voices (cypress 0.05, stars 0.03)
      const vpPhaser = _makePhaser({
        frequency: 0.04,      // slowest of all regions — unhurried, interior
        octaves: 2,           // narrower sweep than cypress (3) — more contained
        baseFrequency: 300,
        wet: 0.25,
      });

      // ── Delay (short echoes — sound bouncing off interior walls) ──
      const vpDelay = new Tone.FeedbackDelay({
        delayTime: 0.1,       // 100ms — tighter than cypress (175ms), small room
        feedback: 0.2,        // gentle — a few reflections, not a long tail
        wet: 0.2,
      });

      // ── Warm reverb (interior of a building — more wet for density) ──
      const vpReverb = new Tone.Freeverb({
        roomSize: 0.45,
        dampening: 1800,
        wet: 0.5,
      });

      // ── Phase 2: FDN reverb worklet ──
      // Default path when the worklet module loaded successfully; replaces
      // vpReverb in the signal graph. vpReverb is still constructed for graph
      // state consistency but isn't wired in when the FDN path is active.
      let vpFdnNode = null;
      if (_fdnReverbReady) {
        vpFdnNode = _buildFdnReverbNode('village');
      }

      // ── Limiter (matches other special voices) ──
      const vpLimiter = new Tone.Limiter(-1);  // looser than before (-4) — let peaks through

      // Signal split: mix feeds two paths
      // Path 1 (pulsed): mix → LFO gate → phaser → delay → reverb → limiter
      // Path 2 (ambient bleed): mix → quiet gain → reverb (bypasses LFO + phaser + delay)
      // The bleed keeps the reverb alive between pulses — the room is never silent.
      const vpBleed = new Tone.Gain(0.3);  // 30% constant bed, 70% pulsed — village always hums

      vpProxFilter.connect(vpGain);       // pulsed path (mix → filter → LFO gate)
      vpProxFilter.connect(vpBleed);      // ambient bleed (mix → filter → bleed)
      vpLFO.connect(vpGain.gain);         // smooth audio-rate pulse
      vpGain.connect(vpPhaser);           // LFO gate → effects
      vpPhaser.connect(vpDelay);
      if (vpFdnNode) {
        // FDN path: both vpDelay and vpBleed feed the worklet directly;
        // Web Audio natively sums multiple connections into a single input.
        vpDelay.connect(vpFdnNode);
        vpBleed.connect(vpFdnNode);
        vpFdnNode.connect(_unwrapToneInput(vpLimiter));
        _log('%c[FDN]%c  Village Pulse wired to FDN reverb worklet (delay + bleed inputs)',
          'color: #9cf; font-weight: bold', 'color: #999');
      } else {
        // Tone.Freeverb path (original)
        vpDelay.connect(vpReverb);
        vpBleed.connect(vpReverb);      // bleed feeds reverb directly
        vpReverb.connect(vpLimiter);
      }

      // Night shelf removed — proximity filter + r2.filter already provide
      // sufficient darkening. Triple lowpass was crushing the signal (highs=0.000,
      // centroid 0.016-0.045, rmsNorm capped at 0.7).
      // Disconnect pattern: limiter ↔ r2.filter (same as WH/LW/CS).

      r2.villagePulse = {
        active: false,
        // Layer A: Low foundation
        lowPad: vpLowPad,
        lowPadGain: vpLowPadGain,
        // Layer B: Mid pad
        pad: vpPad,
        tremolo: vpTremolo,
        padGain: vpPadGain,
        // Layer C: Fattened overtones (worklet or Tone.js fallback)
        useWorklet: !!vpWorkletNode,
        workletNode: vpWorkletNode,
        _workletGainBuf: new Float32Array(VP_OVERTONE_FREQS[_activeMode].length),
        overtoneOscs: vpOvertoneOscs,      // empty if worklet
        overtoneOscsB: vpOvertoneOscsB,    // empty if worklet
        overtoneGains: vpOvertoneGains,    // empty if worklet
        overtoneBus: vpOvertoneBus,
        // Room tone
        roomNoise: vpRoomNoise,
        roomBP: vpRoomBP,
        roomGain: vpRoomGain,
        // Proximity filter (X-axis)
        proxFilter: vpProxFilter,
        // Effects
        bleed: vpBleed,
        phaser: vpPhaser,
        delay: vpDelay,
        reverb: vpReverb,
        fdnNode: vpFdnNode,
        fdnPresetId: vpFdnNode ? 'village' : null,
        useFdn: !!vpFdnNode,
        limiter: vpLimiter,
        // LFO + output
        lfo: vpLFO,
        gain: vpGain,
        mix: vpMix,
        // Strum state
        strumInjection: 0,            // additive gain boost, decays exponentially
        // Per-overtone breathing phases (randomized on activation)
        overtonePhases: new Float32Array(VP_OVERTONE_FREQS[_activeMode].length),
        // FM depth drift phase
        fmDriftPhase: 0,
        // Expression-driven rate
        liveRate: 0,
        capturedRate: 0,
        currentRate: VP_LFO_MIN_RATE,
        // Freeze-to-buffer state
        freezeState: 'live',
        freezeIdleTime: 0,
        frozenSource: null,
        frozenGain: null,
        _freezeBridge: null,
      };

      _log('%c[RegionSynth]%c  Village Pulse built — FM pad + overtones → reverb → r2.filter',
        'color: #0cf; font-weight: bold', 'color: #999');
    }

    // ── Night Sky nodes (region 3) ──────────────────────────────────────────
    // Three-layer voice: cosmic wind noise + FM pad drone + 6 suspended voices.
    // Vast, atmospheric — the negative space between stars.
    {
      const r3 = regions[3];
      const nativeCtx = _nativeForWorklet;
      const ns = NS_FX;

      // Mix bus — all layers merge here (mono)
      const nsMixBus = new Tone.Gain(0);
      nsMixBus.channelCount = 1;
      nsMixBus.channelCountMode = 'explicit';

      // ── Effects chain: mixBus → Phaser → Delay → Reverb → Limiter → r3.filter ──
      const nsPhaser = _makePhaser({
        frequency: ns.phaserFreq, octaves: 3, baseFrequency: 400, wet: 0,
      });
      const nsDelay = new Tone.FeedbackDelay({
        delayTime: ns.delayTime, feedback: ns.delayFeedback, wet: 0,
      });
      const nsLimiter = new Tone.Limiter(ns.limiterThreshold);

      // Send/return reverb (avoids Freeverb comb filter issues on pure sines)
      const nsDryGain = new Tone.Gain(1);
      const nsReverbSend = new Tone.Gain(0);
      const nsReturnGain = new Tone.Gain(1);
      const nsRevTap1 = new Tone.FeedbackDelay({ delayTime: 0.083, feedback: 0.38, wet: 1.0 });
      const nsRevTap2 = new Tone.FeedbackDelay({ delayTime: 0.127, feedback: 0.32, wet: 1.0 });
      const nsRevLPF = new Tone.Filter({ frequency: ns.reverbDampening, type: 'lowpass', rolloff: -12 });
      const nsRevHPF = new Tone.Filter({ frequency: ns.reverbHPF, type: 'highpass', rolloff: -12 });

      nsMixBus.connect(nsPhaser);
      nsPhaser.connect(nsDelay);
      // Dry path
      nsDelay.connect(nsDryGain);
      nsDryGain.connect(nsLimiter);
      // Reverb send path
      nsDelay.connect(nsReverbSend);
      nsReverbSend.connect(nsRevTap1);
      nsRevTap1.connect(nsRevLPF);
      nsRevLPF.connect(nsRevTap2);
      nsRevTap2.connect(nsRevHPF);
      nsRevHPF.connect(nsReturnGain);
      nsReturnGain.connect(nsLimiter);
      // Limiter → filter deferred to activateNightSky() (not connected at build).

      // ── Layer A: Cosmic Wind (3 noise bands) ──
      // Deep space rumble (brown noise, LPF 180Hz)
      const nsDeepNoise = new Tone.Noise('brown');
      const nsDeepGain = new Tone.Gain(0);
      const nsDeepLPF = new Tone.Filter({ frequency: 180, type: 'lowpass', rolloff: -24 });
      nsDeepNoise.connect(nsDeepGain);
      nsDeepGain.connect(nsDeepLPF);
      nsDeepLPF.connect(nsMixBus);

      // Stellar wind (pink noise, BPF 500-900Hz)
      const nsWindNoise = new Tone.Noise('pink');
      const nsWindGain = new Tone.Gain(0);
      const nsWindBPF = new Tone.Filter({ frequency: 700, type: 'bandpass', Q: 1.2 });
      nsWindNoise.connect(nsWindGain);
      nsWindGain.connect(nsWindBPF);
      nsWindBPF.connect(nsMixBus);

      // High atmosphere (white noise, HPF 5kHz)
      const nsAirNoise = new Tone.Noise('white');
      const nsAirGain = new Tone.Gain(0);
      const nsAirHPF = new Tone.Filter({ frequency: 5000, type: 'highpass', rolloff: -12 });
      nsAirNoise.connect(nsAirGain);
      nsAirGain.connect(nsAirHPF);
      nsAirHPF.connect(nsMixBus);

      // ── Layer B: Tonal Pad (FM drone, sub-foundation A2+F3) ──
      // Higher mod index creates FM sidebands that reach into the mids/highs,
      // providing shimmer and air that the pure-sine voices lack.
      const nsPad = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 1.5,
        modulationIndex: 0.5,
        oscillator: { type: 'fatsine', count: 3, spread: 8 },
        modulation: { type: 'triangle' },
        envelope: { attack: 0.3, decay: 0.3, sustain: 1.0, release: 1.5 },
        modulationEnvelope: { attack: 0.5, decay: 1.0, sustain: 0.5, release: 0.8 },
      });
      const nsTremolo = new Tone.Tremolo({ frequency: 0.06, depth: 0, wet: 1.0 });
      nsTremolo.start();
      const nsPadGain = new Tone.Gain(0);
      nsPad.connect(nsTremolo);
      nsTremolo.connect(nsPadGain);
      nsPadGain.connect(nsMixBus);

      // ── Layer C: 6 Suspended Voices (worklet or Tone.js fallback) ──
      let nsWorkletNode = null;
      let nsSynths = [];
      let nsGains = [];

      if (USE_NS_WORKLET && _nsWorkletReady) {
        try {
          nsWorkletNode = new AudioWorkletNode(nativeCtx, 'night-sky-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
              sampleRate: nativeCtx.sampleRate || 22050,
              frequencies: NS_FREQS[_activeMode],
            },
          });
          // Connect native worklet node to Tone.js mix bus
          const mixBusNative = nsMixBus._nativeAudioNode || nsMixBus.input._nativeAudioNode || nsMixBus.input;
          nsWorkletNode.connect(mixBusNative);
          audioDiag.registerWorklet('NS', nsWorkletNode);
        } catch (err) {
          console.warn('[NightSky] Worklet creation failed, falling back to Tone.js:', err.message);
          nsWorkletNode = null;
        }
      }

      // Tone.js fallback path (if worklet unavailable)
      if (!nsWorkletNode) {
        const nsBus = new Tone.Gain(0.408);  // 1/sqrt(6) bus compensation
        nsBus.connect(nsMixBus);
        for (let i = 0; i < NS_VOICE_COUNT; i++) {
          const synth = new Tone.Synth({
            oscillator: { type: 'fatsine', count: 3, spread: 10 },
            envelope: { attack: 0.2, decay: 0.1, sustain: 1.0, release: 2.0 },
            volume: -8,
          });
          const gain = new Tone.Gain(0);
          synth.connect(gain);
          gain.connect(nsBus);
          nsSynths.push(synth);
          nsGains.push(gain);
        }
      }

      r3.nightSky = {
        active: false,
        // Mix + FX
        mixBus: nsMixBus,
        phaser: nsPhaser,
        delay: nsDelay,
        limiter: nsLimiter,
        dryGain: nsDryGain,
        reverbSend: nsReverbSend,
        returnGain: nsReturnGain,
        revTap1: nsRevTap1,
        revTap2: nsRevTap2,
        revLPF: nsRevLPF,
        revHPF: nsRevHPF,
        // Layer A: Noise
        deepNoise: nsDeepNoise,
        deepGain: nsDeepGain,
        windNoise: nsWindNoise,
        windGain: nsWindGain,
        airNoise: nsAirNoise,
        airGain: nsAirGain,
        // Gust LFO state (3 independent gusts)
        deepGustPhase: Math.random() * Math.PI * 2,
        deepGustRate: 0.025 + Math.random() * 0.010,   // 30-50s cycles
        windGustPhase: Math.random() * Math.PI * 2,
        windGustRate: 0.020 + Math.random() * 0.015,
        airGustPhase: Math.random() * Math.PI * 2,
        airGustRate: 0.030 + Math.random() * 0.012,
        // Layer B: Pad
        pad: nsPad,
        tremolo: nsTremolo,
        padGain: nsPadGain,
        _padPreTriggered: false,
        // Layer C: Voices
        useWorklet: !!nsWorkletNode,
        workletNode: nsWorkletNode,
        _workletGainBuf: new Float32Array(NS_VOICE_COUNT),
        synths: nsSynths,
        voiceGains: nsGains,
        // Per-voice breathing LFO (creates spectral gaps for mix clarity)
        lfoPhases: NS_LFO_RATES.map(() => Math.random() * Math.PI * 2),
        _lfoBreathing: new Float32Array(NS_VOICE_COUNT),
        // Strum state
        strumPadDuck: 0,
        strumShimmer: 0,  // phaser wet boost on strum, decays per-frame
        yFilterOffset: 0, // Y-axis filter darkening (set per-frame in applyNightSkyParams)
        // User-tunable params
        userParams: {
          noiseMix: 0.04,       // barely perceptible texture
          padMix: 0.20,         // sub-foundation — felt more than heard
          voiceVolume: 0.10,    // melodic layer volume — quiet bed so strums stand out
          brightness: 0.25,     // per-voice tilt — slight upper-register bias
          strumIntensity: 0.85, // strum spike amplitude
          strumDecay: 1.0,      // slow ring — notes sustain and overlap
          reverbMix: 0.40,      // reverb send level
          reverbSize: 0.92,     // room size (maps to delay feedback)
          delayMix: 0.20,       // delay wet
          phaserWet: 0.40,      // phaser depth
          baseGain: 0.78,       // r3.mainGain passthrough level (bypasses evolution pump). Reduced from 0.86 — limiter overdrive fix
        },
        // Freeze-to-buffer state
        freezeState: 'live',
        freezeIdleTime: 0,
        frozenSource: null,
        frozenGain: null,
        _freezeBridge: null,
      };

      _log(
        '%c[RegionSynth]%c  Night Sky built — 3 noise bands + pad + 6 voices → reverb → r3.filter',
        'color: #36d; font-weight: bold', 'color: #999'
      );
    }

    // ── Layer 2: Pre-trigger pads at gain=0 ──
    // PolySynth.triggerAttack is the most expensive Tone.js call (~100-200ms).
    // Pre-triggering during the 1200ms intro reveal eliminates this cost from clicks.
    // Only pads — NOT noise (cheap to start natively) or worklets (already fast).
    // ~13 idle oscillators at gain=0 costs ~2-3% render capacity — negligible.
    const preNow = Tone.now();
    const r4pre = regions[4];
    if (r4pre && r4pre.windHarp) {
      r4pre.windHarp.harpPad.triggerAttack(VOICES[4].notes, preNow);
      r4pre.windHarp._padPreTriggered = true;
    }
    const r1pre = regions[1];
    if (r1pre && r1pre.livingWood) {
      const lwCfg = VOICES[1].livingWood;
      r1pre.livingWood.subSynth.triggerAttack(lwCfg.subNote, preNow);
      r1pre.livingWood.trunkPad.triggerAttack(lwCfg.padNotes, preNow);
      r1pre.livingWood._padPreTriggered = true;
    }
    const r5pre = regions[5];
    if (r5pre && r5pre.celestialStrings) {
      r5pre.celestialStrings.glassyPad.triggerAttack(VOICES[5].notes, preNow);
      r5pre.celestialStrings._padPreTriggered = true;
    }
    const r2pre = regions[2];
    if (r2pre && r2pre.villagePulse) {
      r2pre.villagePulse.lowPad.triggerAttack(VP_LOW_PAD_NOTES[_activeMode], preNow);
      r2pre.villagePulse.pad.triggerAttack(VP_PAD_NOTES[_activeMode], preNow);
      r2pre.villagePulse._padPreTriggered = true;
    }
    const r3pre = regions[3];
    if (r3pre && r3pre.nightSky) {
      r3pre.nightSky.pad.triggerAttack(NS_PAD_NOTES[_activeMode], preNow);
      r3pre.nightSky._padPreTriggered = true;
    }

    const _tDone = performance.now();
    _log(
      `%c[AudioBuild]%c  Node construction: ${(_tDone - _tWorklets).toFixed(0)}ms (total preBuild: ${(_tDone - _t0).toFixed(0)}ms)`,
      'color: #0af; font-weight: bold', 'color: #ccc'
    );
    _log(
      `%c[RegionSynth]%c  Ready — worklets loaded, CS eager, pads pre-triggered [${(_tDone - _t0).toFixed(0)}ms]`,
      'color: #f0a; font-weight: bold', 'color: #999'
    );
    audioDiag.mark('preBuildAudioNodes:done', { totalMs: (_tDone - _t0).toFixed(0) });
    } catch (e) {
      console.error('[RegionSynth] Audio node construction failed:', e);
      // Clear the cached promise so a retry is possible on next user gesture
      buildPromise = null;
      throw e;  // Re-throw so ensureInit/initAudioOnGesture can handle it
    }
  })();
  return buildPromise;
}

let _initComplete = false;
async function ensureInit() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // Tone.start() resumes the audio context — requires user gesture.
      // Node construction (preBuildAudioNodes) may already be done from mousemove pre-warm.
      await Tone.start();
      await preBuildAudioNodes();
      _initComplete = true;
    } catch (e) {
      // Clear the cached promise so next click retries instead of re-awaiting
      // the same rejected promise forever. Without this, one Tone.start() failure
      // (quota, permission, suspended context) permanently breaks audio.
      console.error('%c[Audio]%c  Init failed — will retry on next click:', 'color: #f44; font-weight: bold', 'color: #999', e);
      initPromise = null;
      _initComplete = false;
      throw e;  // Re-throw so callers know it failed
    }
  })();
  return initPromise;
}

/**
 * Reset audio init state — called on bfcache restore (pageshow persisted).
 * AudioContext doesn't survive bfcache, but _initComplete/initPromise persist
 * in module scope. Without reset, the next click skips Tone.start() and audio
 * is silently broken (tester bug report April 5).
 */
export function resetAudioInit() {
  _initComplete = false;
  initPromise = null;
  buildPromise = null;
  _log('%c[Audio]%c  Init state reset (bfcache restore)',
    'color: #f80; font-weight: bold', 'color: #999');
}

// ── Wind Harp helpers ─────────────────────────────────────────────────────────

/**
 * Activate wind harp layers for region 4.
 * Starts noise, triggers pad + harp notes, sets initial gains to 0.
 * Evolution params will ramp them up via applyWindHarpV3Params().
 */
function activateWindHarp(r) {
  const wh = r.windHarp;
  if (!wh) return;
  const whCfg = VOICES[4].windHarp;
  const _t = window._clickTiming;
  if (_t) _t._whStart = performance.now();

  // If frozen or capturing, thaw/abort first
  if (wh.freezeState === 'frozen') {
    _thawRegion(r, wh, FREEZE_CFG[4]);
  } else if (wh.freezeState === 'capturing') {
    _abortFreezeCapture(wh, 'Wind Harp');
  }
  wh.freezeIdleTime = 0;

  // Layer 3: Native reconnect
  try { _nativeNode(wh.harpLimiter).connect(_nativeNode(r.filter)); } catch (e) {
    wh.harpLimiter.connect(r.filter);
  }

  wh.active = true;

  // Warm restart: if re-activating within 5s of deactivation, preserve
  // LFO phases, gust state, and effect buffers for musical continuity.
  const timeSinceDeactivate = (performance.now() - (wh.lastDeactivateTime || 0)) / 1000;
  const warmRestart = timeSinceDeactivate < 5;

  // Cancel any pending noise stop from a previous deactivation
  if (wh.noiseStopTimeout) {
    clearTimeout(wh.noiseStopTimeout);
    wh.noiseStopTimeout = null;
  }

  const nowFlush = Tone.now();

  if (warmRestart) {
    // Warm: cancel deactivation ramps but DON'T zero effect wet —
    // reverb tails and delay echoes contain musically relevant content.
    // Evolution loop will reassert proper values on next tick.
    _fxCancelReverb(wh, nowFlush);
    wh.delay.wet.cancelScheduledValues(nowFlush);
    wh.delay.feedback.cancelScheduledValues(nowFlush);
    // LFO phases + gust state preserved — rhythmic continuity maintained
    if (window._regionSynthDebug) _log(
      `%c[WindHarp]%c  Warm restart (${timeSinceDeactivate.toFixed(1)}s since deactivate)`,
      'color: #0cf; font-weight: bold', 'color: #999'
    );
  } else {
    // Cold: flush stale effect buffers — ghost tails from old session
    _fxCancelReverb(wh, nowFlush);
    _fxSetReverbWet(wh, 0);
    wh.delay.wet.cancelScheduledValues(nowFlush);
    wh.delay.wet.value = 0;
    wh.delay.feedback.cancelScheduledValues(nowFlush);
    wh.delay.feedback.value = 0;
    // Cold: randomize LFO phases + gust for fresh character
    wh.lfoPhases = whCfg.lfoRates.map(() => Math.random() * Math.PI * 2);
    wh.gustPhase = Math.random() * Math.PI * 2;
    wh.gustRate = VOICES[4].windHarp.gustLfoMinRate +
      Math.random() * (VOICES[4].windHarp.gustLfoMaxRate - VOICES[4].windHarp.gustLfoMinRate);
  }
  if (_t) _t._whFlush = performance.now();

  // Set gains to floor values IMMEDIATELY — no waiting for rAF tick.
  // Noise is the "instant response" layer: audible within one audio buffer (~3ms).
  const noiseMix = wh.userParams.v3NoiseMix != null ? wh.userParams.v3NoiseMix : 0.66;
  wh.noiseGain.gain.value = 0.25 * noiseMix;  // floor level, audible from frame 1
  wh.pinkGain.gain.value = 1.0;               // instant (was 10ms delay + 15ms ramp)
  wh.brownGain.gain.value = 0;

  // Layer 1: Defer noise start to next frame (not in click handler)
  // User hears pad tone first (musically important), noise fades in ~16ms later.
  if (wh._deferredNoiseTimeout) clearTimeout(wh._deferredNoiseTimeout);
  wh._deferredNoiseTimeout = setTimeout(() => {
    if (!wh.active) return;  // region deactivated before timeout fired
    if (wh.pinkNoise.state !== 'started') wh.pinkNoise.start();
    if (wh.brownNoise.state !== 'started') wh.brownNoise.start();
    if (wh.autoFilter.state !== 'started') wh.autoFilter.start();
    wh._deferredNoiseTimeout = null;
  }, 0);
  if (_t) _t._whNoise = performance.now();

  const now = Tone.now();

  // Layer 2: Pad already pre-triggered at gain=0 during init — skip triggerAttack
  if (!wh._padPreTriggered && wh.harpPad.activeVoices === 0) {
    wh.harpPad.triggerAttack(VOICES[4].notes, now);
  }
  if (_t) _t._whPad = performance.now();

  // Set harp gains to floor values — instantly audible
  const initGateFloor = 0.15;
  const initVolEnv = 0.45;
  const initHarpGain = initGateFloor * initVolEnv;  // ~0.0675 per note
  if (wh.useWorklet && wh.workletNode) {
    // Worklet path: send activate + initial gains via MessagePort
    wh.workletNode.port.postMessage({ type: 'activate' });
    for (let i = 0; i < 9; i++) wh._workletGainBuf[i] = initHarpGain;
    postWorkletGains(wh.workletNode, wh._workletGainBuf);
  } else {
    // Tone.js fallback path
    const defaultSpread = whCfg.harpSpread;
    for (let i = 0; i < whCfg.harpNotes.length; i++) {
      wh.harpGains[i].gain.value = initHarpGain;  // audible immediately
      wh.harpSynths[i].oscillator.spread = defaultSpread;
      // Re-trigger only if envelope completed release (safety fallback)
      if (wh.harpSynths[i].envelope.value < 0.001) {
        wh.harpSynths[i].triggerAttack(whCfg.harpNotes[i], now);
      }
    }
  }
  if (_t) _t._whHarp = performance.now();

  // Mix bus at unity immediately — individual layer gains are low enough, no pop risk
  wh.harpMixBus.gain.cancelScheduledValues(now);
  wh.harpMixBus.gain.value = 1.0;

  if (window._regionSynthDebug) _log(
    '%c[WindHarp]%c  Activated — noise + pad + 9 harp notes',
    'color: #0cf; font-weight: bold', 'color: #999'
  );
}

/**
 * Deactivate wind harp layers.
 * Mutes all gains to 0 but keeps oscillators alive (no triggerRelease/stop).
 * Oscillators at gain=0 have negligible CPU cost, and keeping them alive
 * avoids the 1+ second triggerAttack penalty on re-activation (Tone.js must
 * recreate FatOscillator sub-oscillators from scratch after release/stop).
 * Called during fade-out — gains are already ramped to 0 externally.
 */
function deactivateWindHarp(r) {
  const wh = r.windHarp;
  if (!wh || !wh.active) return;
  const now = Tone.now();

  wh.active = false;
  wh.lastDeactivateTime = performance.now();  // warm restart tracking

  // Cancel any pending noise stop from a prior deactivation
  if (wh.noiseStopTimeout) {
    clearTimeout(wh.noiseStopTimeout);
    wh.noiseStopTimeout = null;
  }

  // Mute all layer gains instantly
  wh.harpMixBus.gain.cancelScheduledValues(now);
  wh.harpMixBus.gain.value = 0;
  wh.noiseGain.gain.cancelScheduledValues(now);
  wh.noiseGain.gain.value = 0;

  if (wh.useWorklet && wh.workletNode) {
    // Worklet path: send deactivate message (triggers release envelope in processor)
    wh.workletNode.port.postMessage({ type: 'deactivate' });
  } else {
    // Tone.js fallback: mute gains + stop oscillators
    for (const g of wh.harpGains) {
      g.gain.cancelScheduledValues(now);
      g.gain.value = 0;
    }
  }

  // Stop noise oscillators — removes them from Chrome's audio thread processing.
  // Pads stay running at gain=0 for instant reactivation (Layer 2 optimization).
  try { wh.pinkNoise.stop(); } catch (e) { /* already stopped */ }
  try { wh.brownNoise.stop(); } catch (e) { /* already stopped */ }
  // Keep harpPad running — don't releaseAll. Muted via harpMixBus.gain=0.
  if (!wh.useWorklet) {
    for (const s of wh.harpSynths) {
      try { s.triggerRelease(now); } catch (e) { /* not playing */ }
    }
  }

  // Ramp effects wet to 0 over release tail
  const rampDown = 2.0;
  wh.phaser.wet.cancelAndHoldAtTime(now);
  wh.phaser.wet.setTargetAtTime(0, now, rampDown / 4);
  wh.delay.wet.cancelAndHoldAtTime(now);
  wh.delay.wet.setTargetAtTime(0, now, rampDown / 4);
  _fxRampReverbDown(wh, now, rampDown / 4);
  wh.tremolo.depth.cancelAndHoldAtTime(now);
  wh.tremolo.depth.setTargetAtTime(0, now, rampDown / 4);

  // Layer 3: Native disconnect
  try { _nativeNode(wh.harpLimiter).disconnect(_nativeNode(r.filter)); } catch (e) {
    try { wh.harpLimiter.disconnect(r.filter); } catch (e2) { /* already disconnected */ }
  }
  // Disconnect freeze tap bridge if it exists
  if (wh._freezeBridge) {
    try { wh.harpLimiter.disconnect(wh._freezeBridge); } catch (e) {}
  }

  // Reset freeze state on deactivation
  if (wh.freezeState !== 'live') {
    if (wh.freezeState === 'capturing') _abortFreezeCapture(wh, 'Wind Harp');
    if (wh.frozenSource) {
      try { wh.frozenSource.stop(); } catch (e) {}
      try { wh.frozenSource.disconnect(); } catch (e) {}
      try { wh.frozenSource.dispose(); } catch (e) {}
      wh.frozenSource = null;
    }
    if (wh.frozenGain) {
      try { wh.frozenGain.disconnect(); } catch (e) {}
      try { wh.frozenGain.dispose(); } catch (e) {}
      wh.frozenGain = null;
    }
    wh.freezeState = 'live';
  }
  wh.freezeIdleTime = 0;

  if (window._regionSynthDebug) _log(
    '%c[WindHarp]%c  Deactivated — oscillators stopped, subgraph disconnected',
    'color: #0cf; font-weight: bold', 'color: #999'
  );
}

// ── Night Sky helpers (region 3) ──────────────────────────────────────────────

/**
 * Activate Night Sky layers for region 3.
 * Starts 3 noise bands, triggers pad, sets initial voice gains.
 * Evolution params ramp layers up via applyNightSkyParams().
 */
function activateNightSky(r) {
  const sky = r.nightSky;
  if (!sky) return;

  // Thaw if frozen
  if (sky.freezeState !== 'live') {
    if (sky.freezeState === 'capturing') _abortFreezeCapture(sky, 'Night Sky');
    if (sky.frozenSource) {
      try { sky.frozenSource.stop(); } catch (e) {}
      try { sky.frozenSource.disconnect(); } catch (e) {}
      try { sky.frozenSource.dispose(); } catch (e) {}
      sky.frozenSource = null;
    }
    if (sky.frozenGain) {
      try { sky.frozenGain.disconnect(); } catch (e) {}
      try { sky.frozenGain.dispose(); } catch (e) {}
      sky.frozenGain = null;
    }
    sky.freezeState = 'live';
  }

  const warmRestart = sky.active && sky._lastDeactivateTime &&
    (Tone.now() - sky._lastDeactivateTime < 5);
  sky.active = true;

  // Cold start: randomize gust phases
  if (!warmRestart) {
    sky.deepGustPhase = Math.random() * Math.PI * 2;
    sky.windGustPhase = Math.random() * Math.PI * 2;
    sky.airGustPhase = Math.random() * Math.PI * 2;
    sky.deepGustRate = 0.025 + Math.random() * 0.010;
    sky.windGustRate = 0.020 + Math.random() * 0.015;
    sky.airGustRate = 0.030 + Math.random() * 0.012;
    // Reset detuning to tight focus on cold start
    if (sky.useWorklet && sky.workletNode) {
      sky.workletNode.port.postMessage({ type: 'spread', cents: 2.5 });
    }
    if (sky._prev) sky._prev.spread = 2.5;
  }

  // Start noise oscillators (deferred to avoid click-handler cost)
  setTimeout(() => {
    try { sky.deepNoise.start(); } catch (e) {}
    try { sky.windNoise.start(); } catch (e) {}
    try { sky.airNoise.start(); } catch (e) {}
  }, 0);

  // Pad: trigger if not pre-triggered
  if (!sky._padPreTriggered) {
    sky.pad.triggerAttack(NS_PAD_NOTES[_activeMode], Tone.now());
  }

  // Randomize breathing LFO phases on activation (voices start at different points in cycle)
  for (let i = 0; i < NS_VOICE_COUNT; i++) sky.lfoPhases[i] = Math.random() * Math.PI * 2;

  // Voice layer: set initial gains (based on lowest hierarchy value)
  const initGain = 0.20 * 0.4;
  if (sky.useWorklet && sky.workletNode) {
    sky.workletNode.port.postMessage({ type: 'activate' });
    const buf = sky._workletGainBuf;
    for (let i = 0; i < NS_VOICE_COUNT; i++) buf[i] = initGain;
    postWorkletGains(sky.workletNode, buf);
  } else {
    const now = Tone.now();
    for (let i = 0; i < sky.synths.length; i++) {
      sky.voiceGains[i].gain.setTargetAtTime(initGain, now, 0.05);
      if (sky.synths[i].state !== 'started') {
        const noteHz = NS_FREQS[_activeMode][i];
        sky.synths[i].triggerAttack(noteHz, now);
      }
    }
  }

  // Mix bus on — set below unity for headroom (dry + reverb return sum into limiter)
  sky.mixBus.gain.setTargetAtTime(0.70, Tone.now(), 0.05);  // reduced from 0.85 — was overdriving limiter, causing crackling

  // Connect limiter to filter (deferred from build — not connected until activation)
  try { _nativeNode(sky.limiter).connect(_nativeNode(r.filter)); } catch (e) {
    try { sky.limiter.connect(r.filter); } catch (e2) {}
  }

  sky.freezeIdleTime = 0;

  if (window._regionSynthDebug) _log(
    '%c[NightSky]%c  Activated — 3 noise bands + pad + 6 voices',
    'color: #36d; font-weight: bold', 'color: #999'
  );
}

/**
 * Deactivate Night Sky layers.
 * Mutes gains, stops noise, sends worklet deactivate, disconnects subgraph.
 */
function deactivateNightSky(r) {
  const sky = r.nightSky;
  if (!sky || !sky.active) return;

  sky.active = false;
  sky._lastDeactivateTime = Tone.now();
  const now = Tone.now();

  // Mute mix bus
  sky.mixBus.gain.setTargetAtTime(0, now, 0.1);

  // Mute noise gains
  sky.deepGain.gain.setTargetAtTime(0, now, 0.05);
  sky.windGain.gain.setTargetAtTime(0, now, 0.05);
  sky.airGain.gain.setTargetAtTime(0, now, 0.05);

  // Stop noise oscillators
  setTimeout(() => {
    try { sky.deepNoise.stop(); } catch (e) {}
    try { sky.windNoise.stop(); } catch (e) {}
    try { sky.airNoise.stop(); } catch (e) {}
  }, 200);

  // Deactivate voices
  if (sky.useWorklet && sky.workletNode) {
    sky.workletNode.port.postMessage({ type: 'deactivate' });
  } else {
    for (let i = 0; i < sky.synths.length; i++) {
      sky.voiceGains[i].gain.setTargetAtTime(0, now, 0.05);
      try { sky.synths[i].triggerRelease(now + 0.1); } catch (e) {}
    }
  }

  // Pad stays running at gain=0 (pre-triggered pattern)
  sky.padGain.gain.setTargetAtTime(0, now, 0.1);

  // Ramp effects wet to 0
  sky.phaser.set({ wet: 0 });
  sky.delay.set({ wet: 0 });
  sky.reverbSend.gain.setTargetAtTime(0, now, 0.3);

  // Disconnect from filter
  try { _nativeNode(sky.limiter).disconnect(_nativeNode(r.filter)); } catch (e) {
    try { sky.limiter.disconnect(r.filter); } catch (e2) {}
  }

  // Clean up freeze state
  if (sky.freezeState !== 'live') {
    if (sky.freezeState === 'capturing') _abortFreezeCapture(sky, 'Night Sky');
    if (sky.frozenSource) {
      try { sky.frozenSource.stop(); } catch (e) {}
      try { sky.frozenSource.disconnect(); } catch (e) {}
      try { sky.frozenSource.dispose(); } catch (e) {}
      sky.frozenSource = null;
    }
    if (sky.frozenGain) {
      try { sky.frozenGain.disconnect(); } catch (e) {}
      try { sky.frozenGain.dispose(); } catch (e) {}
      sky.frozenGain = null;
    }
    sky.freezeState = 'live';
  }
  sky.freezeIdleTime = 0;

  if (window._regionSynthDebug) _log(
    '%c[NightSky]%c  Deactivated — oscillators stopped, subgraph disconnected',
    'color: #36d; font-weight: bold', 'color: #999'
  );
}

// ── Living Wood helpers (Cypress region 1) ────────────────────────────────────

/**
 * Activate Living Wood layers for region 1.
 * Sets gains to floor values, randomizes LFO phases on cold start.
 * Evolution params ramp layers up via applyCypressLivingWoodParams().
 */
function activateCypressLivingWood(r) {
  const lwState = r.livingWood;
  if (!lwState) return;
  const lwCfg = VOICES[1].livingWood;

  // If frozen or capturing, thaw/abort first
  if (lwState.freezeState === 'frozen') {
    _thawRegion(r, lwState, FREEZE_CFG[1]);
  } else if (lwState.freezeState === 'capturing') {
    _abortFreezeCapture(lwState, 'Cypress');
  }
  lwState.freezeIdleTime = 0;

  // Layer 3: Native reconnect (limiter → r.filter)
  try { _nativeNode(lwState.limiter).connect(_nativeNode(r.filter)); } catch (e) {
    lwState.limiter.connect(r.filter);
  }

  lwState.active = true;

  // Warm restart: preserve LFO phases, gust state, effect buffers
  const timeSinceDeactivate = (performance.now() - (lwState.lastDeactivateTime || 0)) / 1000;
  const warmRestart = timeSinceDeactivate < 5;

  const nowFlush = Tone.now();

  if (warmRestart) {
    // Cancel deactivation ramps but preserve effect content
    _fxCancelReverb(lwState, nowFlush);
    lwState.delay.wet.cancelScheduledValues(nowFlush);
    lwState.delay.feedback.cancelScheduledValues(nowFlush);
    if (window._regionSynthDebug) _log(
      `%c[LivingWood]%c  Warm restart (${timeSinceDeactivate.toFixed(1)}s since deactivate)`,
      'color: #6c6; font-weight: bold', 'color: #999'
    );
  } else {
    // Cold: flush stale effect buffers
    _fxCancelReverb(lwState, nowFlush);
    _fxSetReverbWet(lwState, 0);
    lwState.delay.wet.cancelScheduledValues(nowFlush);
    lwState.delay.wet.value = 0;
    lwState.delay.feedback.cancelScheduledValues(nowFlush);
    lwState.delay.feedback.value = 0;
    // Cold: randomize LFO phases + gust for fresh character
    lwState.lfoPhases = lwCfg.lfoRates.map(() => Math.random() * Math.PI * 2);
    lwState.gustPhase = Math.random() * Math.PI * 2;
    lwState.gustRate = lwCfg.gustLfoMinRate +
      Math.random() * (lwCfg.gustLfoMaxRate - lwCfg.gustLfoMinRate);
    lwState.trunkModIndex = 0;
    lwState.portatoPhase = 0;
  }

  // Set gains to floor values IMMEDIATELY — audible from frame 1
  const earthMix = lwState.userParams.earthMix;
  lwState.earthGain.gain.value = 0.15 * earthMix;
  lwState.brownGain.gain.value = 0;  // gust LFO will drive this
  lwState.subGain.gain.value = 0;    // evolution will ramp this
  lwState.padGain.gain.value = 0.1;  // trunk pad floor — quiet start

  // Layer 1: Defer noise start to next frame
  if (lwState._deferredNoiseTimeout) clearTimeout(lwState._deferredNoiseTimeout);
  lwState._deferredNoiseTimeout = setTimeout(() => {
    if (!lwState.active) return;
    if (lwState.brownNoise.state !== 'started') lwState.brownNoise.start();
    lwState._deferredNoiseTimeout = null;
  }, 0);

  // Layer 2: Pads already pre-triggered at gain=0 during init — skip triggerAttack
  if (!lwState._padPreTriggered) {
    if (lwState.subSynth.envelope.value < 0.001) {
      lwState.subSynth.triggerAttack(lwCfg.subNote, Tone.now());
    }
    if (lwState.trunkPad.activeVoices === 0) {
      lwState.trunkPad.triggerAttack(lwCfg.padNotes, Tone.now());
    }
  }
  // Branches always activate as sustained drones
  const initBranchGain = 0.05 * lwState.userParams.branchVolume;
  if (lwState.useWorklet && lwState.workletNode) {
    // Worklet path: send activate + initial gains via MessagePort
    lwState.workletNode.port.postMessage({ type: 'activate' });
    for (let i = 0; i < 7; i++) lwState._workletGainBuf[i] = initBranchGain;
    postWorkletGains(lwState.workletNode, lwState._workletGainBuf);
  } else {
    // Tone.js fallback path
    for (let i = 0; i < lwCfg.branchNotes.length; i++) {
      if (lwState.branchSynths[i].envelope.value < 0.001) {
        lwState.branchSynths[i].triggerAttack(lwCfg.branchNotes[i], Tone.now());
      }
    }
    for (const g of lwState.branchGains) {
      g.gain.value = initBranchGain;
    }
  }

  // Tremolo rate is constant — set once here, not per-frame
  lwState.tremolo.frequency.value = lwCfg.tremoloRate;

  // Mix bus — push signal into usable range below limiter (-6dB threshold).
  // ×2.5 (+8 dB) makeup gain: keeps peaks below 0 dBFS at full strum build
  // while giving dynamics room to breathe.
  lwState.cypressMixBus.gain.cancelScheduledValues(Tone.now());
  lwState.cypressMixBus.gain.value = 2.5;

  if (window._regionSynthDebug) _log(
    '%c[LivingWood]%c  Activated — earth + trunk + 7 branch voices',
    'color: #6c6; font-weight: bold', 'color: #999'
  );
}

/**
 * Deactivate Living Wood layers.
 * Mutes all gains to 0 but keeps oscillators alive (same pattern as Wind Harp).
 */
function deactivateCypressLivingWood(r) {
  const lwState = r.livingWood;
  if (!lwState || !lwState.active) return;
  const now = Tone.now();

  lwState.active = false;
  lwState.lastDeactivateTime = performance.now();

  // Mute all layer gains instantly
  lwState.cypressMixBus.gain.cancelScheduledValues(now);
  lwState.cypressMixBus.gain.value = 0;
  lwState.earthGain.gain.cancelScheduledValues(now);
  lwState.earthGain.gain.value = 0;
  lwState.subGain.gain.cancelScheduledValues(now);
  lwState.subGain.gain.value = 0;
  lwState.padGain.gain.cancelScheduledValues(now);
  lwState.padGain.gain.value = 0;
  if (lwState.useWorklet && lwState.workletNode) {
    // Worklet path: send deactivate message (triggers release envelope in processor)
    lwState.workletNode.port.postMessage({ type: 'deactivate' });
  } else {
    // Tone.js fallback: mute gains
    for (const g of lwState.branchGains) {
      g.gain.cancelScheduledValues(now);
      g.gain.value = 0;
    }
  }
  // Reset bow velocity and strum state
  lwState.smoothedVelocity = 0;
  lwState.strumVelInjection = 0;

  // Stop noise — removes from Chrome's audio thread.
  // Keep sub + trunkPad running at gain=0 for instant reactivation (Layer 2).
  try { lwState.brownNoise.stop(); } catch (e) { /* already stopped */ }
  // Don't release subSynth or trunkPad — muted via cypressMixBus.gain=0.
  if (!lwState.useWorklet) {
    for (const s of lwState.branchSynths) {
      try { s.triggerRelease(now); } catch (e) { /* not playing */ }
    }
  }

  // Ramp effects wet to 0 over release tail
  const rampDown = 2.0;
  lwState.phaser.wet.cancelAndHoldAtTime(now);
  lwState.phaser.wet.setTargetAtTime(0, now, rampDown / 4);
  lwState.delay.wet.cancelAndHoldAtTime(now);
  lwState.delay.wet.setTargetAtTime(0, now, rampDown / 4);
  _fxRampReverbDown(lwState, now, rampDown / 4);
  lwState.tremolo.depth.cancelAndHoldAtTime(now);
  lwState.tremolo.depth.setTargetAtTime(0, now, rampDown / 4);

  // Layer 3: Native disconnect
  try { _nativeNode(lwState.limiter).disconnect(_nativeNode(r.filter)); } catch (e) {
    try { lwState.limiter.disconnect(r.filter); } catch (e2) { /* already disconnected */ }
  }
  // Also disconnect freeze tap bridge if it exists
  if (lwState._freezeBridge) {
    try { lwState.limiter.disconnect(lwState._freezeBridge); } catch (e) {}
  }

  // Reset freeze state on deactivation
  if (lwState.freezeState !== 'live') {
    if (lwState.freezeState === 'capturing') _abortFreezeCapture(lwState, 'Cypress');
    if (lwState.frozenSource) {
      try { lwState.frozenSource.stop(); } catch (e) {}
      try { lwState.frozenSource.disconnect(); } catch (e) {}
      try { lwState.frozenSource.dispose(); } catch (e) {}
      lwState.frozenSource = null;
    }
    if (lwState.frozenGain) {
      try { lwState.frozenGain.disconnect(); } catch (e) {}
      try { lwState.frozenGain.dispose(); } catch (e) {}
      lwState.frozenGain = null;
    }
    lwState.freezeState = 'live';
  }
  lwState.freezeIdleTime = 0;

  if (window._regionSynthDebug) _log(
    '%c[LivingWood]%c  Deactivated — noise stopped, pads muted, subgraph disconnected',
    'color: #6c6; font-weight: bold', 'color: #999'
  );
}

// ── Celestial Strings helpers (Stars region 5) ─────────────────────────────────

/**
 * Build Celestial Strings audio nodes on first activation (lazy init).
 * Chrome's Web Audio renderer crashes when ~150+ nodes exist simultaneously.
 * Deferring CS construction (~50 nodes) from preBuildAudioNodes to first
 * Stars activation keeps the idle node count within Chrome's limit.
 * Idempotent — returns immediately if already built.
 */
function _buildCelestialStringsNodes() {
  const r5 = regions[5];
  if (!r5 || r5.celestialStrings) return;  // already built or region missing
  const cs = VOICES[5].celestialStrings;

  const starsMixBus = new Tone.Gain(0);
  // Force mono — same rationale as Wind Harp.
  starsMixBus.channelCount = 1;
  starsMixBus.channelCountMode = 'explicit';
  const csPhaser = _makePhaser({
    frequency: cs.phaserFreq, octaves: 2, baseFrequency: 600, wet: 0,
  });
  const csDelay = new Tone.FeedbackDelay({
    delayTime: cs.delayTime, feedback: cs.delayFeedback, wet: 0,
  });
  let csColdReverb = null;
  let csFdnNode = null;  // Phase 2: std-audio-context wrapped AudioWorkletNode
  let csReverbHPF = null;
  let csReverbSend = null, csReturnGain = null, csDryGain = null;
  const csLimiter = new Tone.Limiter(-8);
  // Meters deferred
  const csMeterPreFx = null;
  const csMeterPostLimiter = null;
  const csMeterAir = null;
  const csMeterPad = null;
  const csMeterStrings = null;
  starsMixBus.connect(csPhaser);
  csPhaser.connect(csDelay);

  if (_fdnReverbReady) {
    csFdnNode = _buildFdnReverbNode('stars');
  }
  if (csFdnNode) {
    // FDN path: csDelay → FDN → HPF → limiter. The FDN → HPF hop is a
    // std-worklet → Tone.Filter connection that needs .input unwrapping.
    csReverbHPF = new Tone.Filter({ frequency: cs.reverbHPF, type: 'highpass', rolloff: -12 });
    csDelay.connect(csFdnNode);
    csFdnNode.connect(_unwrapToneInput(csReverbHPF));
    csReverbHPF.connect(csLimiter);
    _log('%c[FDN]%c  Celestial Strings wired to FDN reverb worklet',
      'color: #9cf; font-weight: bold', 'color: #999');
  } else if (USE_SHARED_FX && sharedSpecialFreeverb) {
    csDryGain = new Tone.Gain(1);
    csReverbSend = new Tone.Gain(0);
    csReturnGain = new Tone.Gain(0);
    // CS has an HPF on its reverb return to prevent Horizon masking
    csReverbHPF = new Tone.Filter({ frequency: cs.reverbHPF, type: 'highpass', rolloff: -12 });
    csDelay.connect(csDryGain);
    csDryGain.connect(csLimiter);
    csDelay.connect(csReverbSend);
    csReverbSend.connect(sharedSpecialFreeverb);
    sharedSpecialFreeverb.connect(csReverbHPF);
    csReverbHPF.connect(csReturnGain);
    csReturnGain.connect(csLimiter);
  } else {
    csColdReverb = new Tone.Freeverb({ roomSize: cs.reverbRoomSize, dampening: cs.reverbDampening, wet: 0 });
    csReverbHPF = new Tone.Filter({ frequency: cs.reverbHPF, type: 'highpass', rolloff: -12 });
    csDelay.connect(csColdReverb);
    csColdReverb.connect(csReverbHPF);
    csReverbHPF.connect(csLimiter);
  }
  // Limiter → filter deferred to activateCelestialStrings() (not connected at build).

  // Layer A: Cosmic Static
  const csWhiteNoise = new Tone.Noise('white');
  csWhiteNoise.volume.value = cs.noiseVolume;
  const csNoiseGain = new Tone.Gain(0);
  const csNoiseHPF = new Tone.Filter({ frequency: cs.noiseHpf, type: 'highpass', rolloff: -12 });
  const csNoiseLPF = new Tone.Filter({ frequency: cs.noiseLpf, type: 'lowpass', rolloff: -12 });
  csWhiteNoise.connect(csNoiseGain);
  csNoiseGain.connect(csNoiseHPF);
  csNoiseHPF.connect(csNoiseLPF);
  csNoiseLPF.connect(starsMixBus);

  // Layer B: Glassy Pad
  const csGlassyPad = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: cs.padHarmonicity,
    modulationIndex: cs.padModIndexMin,
    oscillator: { type: 'fatsine', spread: 6 },
    modulation: { type: 'sine' },
    envelope: { attack: 0.3, decay: 0.3, sustain: 1.0, release: 1.5 },
    modulationEnvelope: { attack: 0.5, decay: 0.5, sustain: 0.5, release: 1.0 },
  });
  csGlassyPad.volume.value = cs.padVolume;
  const csTremolo = new Tone.Tremolo({ frequency: cs.tremoloRate, depth: 0, wet: 1.0 });
  csTremolo.start();
  const csPadGain = new Tone.Gain(0);
  csGlassyPad.connect(csTremolo);
  csTremolo.connect(csPadGain);
  csPadGain.connect(starsMixBus);

  // Layer C: 12 Celestial Strings
  // Two implementations: AudioWorklet (1 node) or Tone.js fallback (36 nodes).
  // Toggle via window.USE_CS_WORKLET (default true).
  let csStringSynths = [];
  let csStringGains = [];
  let csStringPanners = [];
  let csStringBus = null;
  let csWorkletNode = null;

  if (USE_CS_WORKLET && _csWorkletReady) {
    // AudioWorklet path: 1 node replaces 36.
    // Must use the NATIVE AudioContext for AudioWorkletNode constructor —
    // standardized-audio-context wrapper is not accepted by the native constructor.
    const rawCtx = Tone.context.rawContext;
    const nativeCtx = rawCtx._nativeAudioContext || rawCtx._nativeContext || rawCtx;
    const panPositions = [];
    for (let i = 0; i < cs.stringNotes.length; i++) {
      panPositions.push(-0.6 + (i / (cs.stringNotes.length - 1)) * 1.2);
    }
    try {
      csWorkletNode = new AudioWorkletNode(nativeCtx, 'celestial-strings-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],  // stereo output (pan applied internally)
        processorOptions: {
          sampleRate: nativeCtx.sampleRate || 22050,
          frequencies: CS_STRING_FREQS[_activeMode],
          panPositions: panPositions,
        },
      });
      // Connect worklet to the native GainNode inside starsMixBus.
      // Tone.Gain._gainNode is the standardized-audio-context wrapper.
      // ._nativeAudioNode is the actual native browser GainNode.
      // Both the worklet and this node are on the same native AudioContext.
      // NOTE: native connect() bypasses standardized-audio-context tracking.
      // starsMixBus renders because noise+pad provide tracked Tone.js inputs.
      // Do NOT remove those layers without adding an explicit keep-alive.
      const wrapped = starsMixBus._gainNode || starsMixBus.output;
      const nativeGain = wrapped._nativeAudioNode || wrapped;
      csWorkletNode.connect(nativeGain);
      _log('%c[AudioWorklet]%c  CS strings: 1 worklet node (replaces 36 Tone.js nodes)',
        'color: #c9f; font-weight: bold', 'color: #999');
      audioDiag.registerWorklet('CS', csWorkletNode);
    } catch (e) {
      console.warn('[AudioWorklet]  CS worklet node creation failed, using Tone.js fallback:', e.message);
      csWorkletNode = null;
    }
  }

  // Tone.js fallback: if worklet was not used or failed, build the 36-node chain
  if (!csWorkletNode) {
    csStringBus = new Tone.Gain(cs.stringBusGain);
    csStringBus.connect(starsMixBus);
    for (let i = 0; i < cs.stringNotes.length; i++) {
      const synth = new Tone.Synth({
        oscillator: { type: 'fatsine', spread: cs.stringSpread },
        envelope: { attack: 0.3, decay: 0.5, sustain: 1.0, release: 2.0 },
      });
      synth.volume.value = cs.stringVolume;
      const noteGain = new Tone.Gain(0);
      const panPos = -0.6 + (i / (cs.stringNotes.length - 1)) * 1.2;
      const panner = new Tone.Panner(panPos);
      synth.connect(noteGain);
      noteGain.connect(panner);
      panner.connect(csStringBus);
      csStringSynths.push(synth);
      csStringGains.push(noteGain);
      csStringPanners.push(panner);
    }
    _log('%c[AudioWorklet]%c  CS strings: Tone.js fallback (36 nodes)',
      'color: #f80; font-weight: bold', 'color: #999');
  }

  r5.celestialStrings = {
    active: false,
    starsMixBus,
    phaser: csPhaser, delay: csDelay, coldReverb: csColdReverb,  // null when USE_SHARED_FX path or FDN path is active
    fdnNode: csFdnNode,
    fdnPresetId: csFdnNode ? 'stars' : null,
    reverbSend: csReverbSend, returnGain: csReturnGain, dryGain: csDryGain,
    useSharedFx: USE_SHARED_FX && !!sharedSpecialFreeverb,
    useFdn: !!csFdnNode,
    reverbHPF: csReverbHPF, limiter: csLimiter,
    meterPreFx: csMeterPreFx, meterPostLimiter: csMeterPostLimiter,
    meterAir: csMeterAir, meterPad: csMeterPad, meterStrings: csMeterStrings,
    peakLimiterGR: 0, peakPreFx: -Infinity, peakPostLimiter: -Infinity,
    whiteNoise: csWhiteNoise, noiseGain: csNoiseGain, noiseHPF: csNoiseHPF, noiseLPF: csNoiseLPF,
    gustPhase: Math.random() * Math.PI * 2,
    gustRate: cs.gustLfoMinRate + Math.random() * (cs.gustLfoMaxRate - cs.gustLfoMinRate),
    glassyPad: csGlassyPad, tremolo: csTremolo, padGain: csPadGain, padModIndex: 0,
    stringSynths: csStringSynths, stringGains: csStringGains, stringPanners: csStringPanners,
    stringBus: csStringBus, workletNode: csWorkletNode,
    useWorklet: !!(USE_CS_WORKLET && csWorkletNode),
    _workletGainBuf: new Float32Array(12),  // pre-allocated buffer for MessagePort gains
    lfoPhases: cs.lfoRates.map(() => Math.random() * Math.PI * 2),
    _lfoBreathing: new Float32Array(cs.stringNotes.length),
    userParams: {
      noiseMix: 0.2, padMix: 0.75, stringVolume: 1, stringBrightness: 0,
      reverbMix: 0.25, reverbSize: 0.85, phaserWet: 0.4, delayMix: 0.15,
      strumIntensity: 0.9, strumDecay: 2.5, gateFloor: 0.10,
    },
    lastDeactivateTime: 0,
    // Freeze-to-buffer state
    freezeTap: null, freezeState: 'live', freezeIdleTime: 0,
    frozenSource: null, frozenGain: null,
  };

  _log(
    '%c[RegionSynth]%c  Celestial Strings nodes built (lazy, on first activation)',
    'color: #f0a; font-weight: bold', 'color: #c9f'
  );
}

/**
 * Activate Celestial Strings layers for region 5.
 * Sets gains to floor values, randomizes LFO phases on cold start.
 * Evolution params ramp layers up via applyCelestialStringsParams().
 */
function activateCelestialStrings(r) {
  // Lazy init: build CS nodes on first activation (deferred from preBuildAudioNodes
  // to stay under Chrome's ~150 Web Audio node limit)
  if (!r.celestialStrings) _buildCelestialStringsNodes();
  const csState = r.celestialStrings;
  if (!csState) return;

  // If frozen or capturing, thaw/abort first
  if (csState.freezeState === 'frozen') {
    _thawRegion(r, csState, FREEZE_CFG[5]);
  } else if (csState.freezeState === 'capturing') {
    _abortFreezeCapture(csState, 'Celestial Strings');
  }
  csState.freezeIdleTime = 0;

  // Layer 3: Native reconnect
  try { _nativeNode(csState.limiter).connect(_nativeNode(r.filter)); } catch (e) {
    csState.limiter.connect(r.filter);
  }
  const csCfg = VOICES[5].celestialStrings;

  csState.active = true;

  // Warm restart: preserve LFO phases, gust state, effect buffers
  const timeSinceDeactivate = (performance.now() - (csState.lastDeactivateTime || 0)) / 1000;
  const warmRestart = timeSinceDeactivate < 5;

  const nowFlush = Tone.now();

  if (warmRestart) {
    _fxCancelReverb(csState, nowFlush);
    csState.delay.wet.cancelScheduledValues(nowFlush);
    csState.delay.feedback.cancelScheduledValues(nowFlush);
    if (window._regionSynthDebug) _log(
      `%c[CelestialStrings]%c  Warm restart (${timeSinceDeactivate.toFixed(1)}s since deactivate)`,
      'color: #c9f; font-weight: bold', 'color: #999'
    );
  } else {
    // Cold: flush stale effect buffers
    _fxCancelReverb(csState, nowFlush);
    _fxSetReverbWet(csState, 0);
    csState.delay.wet.cancelScheduledValues(nowFlush);
    csState.delay.wet.value = 0;
    csState.delay.feedback.cancelScheduledValues(nowFlush);
    csState.delay.feedback.value = 0;
    // Cold: randomize LFO phases + gust for fresh character
    csState.lfoPhases = csCfg.lfoRates.map(() => Math.random() * Math.PI * 2);
    csState.gustPhase = Math.random() * Math.PI * 2;
    csState.gustRate = csCfg.gustLfoMinRate +
      Math.random() * (csCfg.gustLfoMaxRate - csCfg.gustLfoMinRate);
    csState.padModIndex = 0;
  }

  // Set gains to floor values IMMEDIATELY
  const noiseMix = csState.userParams.noiseMix != null ? csState.userParams.noiseMix : 0.5;
  csState.noiseGain.gain.value = 0.15 * noiseMix;  // floor level
  csState.padGain.gain.value = 0.08;  // glassy pad floor — quiet start

  // Layer 1: Defer noise start to next frame
  if (csState._deferredNoiseTimeout) clearTimeout(csState._deferredNoiseTimeout);
  csState._deferredNoiseTimeout = setTimeout(() => {
    if (!csState.active) return;
    if (csState.whiteNoise.state !== 'started') csState.whiteNoise.start();
    csState._deferredNoiseTimeout = null;
  }, 0);

  // Layer 2: Pad already pre-triggered at gain=0 during init
  if (!csState._padPreTriggered && csState.glassyPad.activeVoices === 0) {
    csState.glassyPad.triggerAttack(VOICES[5].notes, Tone.now());
  }
  // Strings: activate via worklet or Tone.js fallback
  if (csState.useWorklet && csState.workletNode) {
    csState.workletNode.port.postMessage({ type: 'activate' });
  } else {
    // Tone.js fallback: trigger all 12 string synths
    const initGateFloor = csState.userParams.gateFloor;
    const initVolEnv = 0.35;
    const initStringGain = initGateFloor * initVolEnv;
    for (let i = 0; i < csCfg.stringNotes.length; i++) {
      csState.stringGains[i].gain.value = initStringGain;
      if (csState.stringSynths[i].envelope.value < 0.001) {
        csState.stringSynths[i].triggerAttack(csCfg.stringNotes[i], Tone.now());
      }
    }
  }

  // Tremolo rate — set once
  csState.tremolo.frequency.value = csCfg.tremoloRate;

  // Mix bus — push signal into usable range below limiter (-8dB threshold).
  // ×1.0 (0 dB) — filter floor at 3000Hz passes full bandwidth, no makeup needed
  csState.starsMixBus.gain.cancelScheduledValues(Tone.now());
  csState.starsMixBus.gain.value = 1.0;

  if (window._regionSynthDebug) _log(
    '%c[CelestialStrings]%c  Activated — air + pad + 12 string voices',
    'color: #c9f; font-weight: bold', 'color: #999'
  );
}

/**
 * Deactivate Celestial Strings layers.
 * Mutes all gains to 0 but keeps oscillators alive (same pattern as Wind Harp/LW).
 */
function deactivateCelestialStrings(r) {
  const csState = r.celestialStrings;
  if (!csState || !csState.active) return;
  const now = Tone.now();

  csState.active = false;
  csState.lastDeactivateTime = performance.now();

  // Mute all layer gains instantly
  csState.starsMixBus.gain.cancelScheduledValues(now);
  csState.starsMixBus.gain.value = 0;
  csState.noiseGain.gain.cancelScheduledValues(now);
  csState.noiseGain.gain.value = 0;
  csState.padGain.gain.cancelScheduledValues(now);
  csState.padGain.gain.value = 0;
  // Stop strings: worklet or Tone.js fallback
  if (csState.useWorklet && csState.workletNode) {
    csState.workletNode.port.postMessage({ type: 'deactivate' });
  } else {
    for (const g of csState.stringGains) {
      g.gain.cancelScheduledValues(now);
      g.gain.value = 0;
    }
    for (const s of csState.stringSynths) {
      try { s.triggerRelease(now); } catch (e) { /* not playing */ }
    }
  }

  // Stop noise — keep glassyPad running at gain=0 for instant reactivation (Layer 2)
  try { csState.whiteNoise.stop(); } catch (e) { /* already stopped */ }

  // Ramp effects wet to 0 over release tail
  const rampDown = 2.0;
  csState.phaser.wet.cancelAndHoldAtTime(now);
  csState.phaser.wet.setTargetAtTime(0, now, rampDown / 4);
  csState.delay.wet.cancelAndHoldAtTime(now);
  csState.delay.wet.setTargetAtTime(0, now, rampDown / 4);
  _fxRampReverbDown(csState, now, rampDown / 4);
  csState.tremolo.depth.cancelAndHoldAtTime(now);
  csState.tremolo.depth.setTargetAtTime(0, now, rampDown / 4);

  // Layer 3: Native disconnect
  try { _nativeNode(csState.limiter).disconnect(_nativeNode(r.filter)); } catch (e) {
    try { csState.limiter.disconnect(r.filter); } catch (e2) { /* already disconnected */ }
  }
  // Disconnect freeze tap bridge if it exists
  if (csState._freezeBridge) {
    try { csState.limiter.disconnect(csState._freezeBridge); } catch (e) {}
  }

  // Reset freeze state on deactivation
  if (csState.freezeState !== 'live') {
    if (csState.freezeState === 'capturing') _abortFreezeCapture(csState, 'Celestial Strings');
    if (csState.frozenSource) {
      try { csState.frozenSource.stop(); } catch (e) {}
      try { csState.frozenSource.disconnect(); } catch (e) {}
      try { csState.frozenSource.dispose(); } catch (e) {}
      csState.frozenSource = null;
    }
    if (csState.frozenGain) {
      try { csState.frozenGain.disconnect(); } catch (e) {}
      try { csState.frozenGain.dispose(); } catch (e) {}
      csState.frozenGain = null;
    }
    csState.freezeState = 'live';
  }
  csState.freezeIdleTime = 0;

  if (window._regionSynthDebug) _log(
    '%c[CelestialStrings]%c  Deactivated — noise stopped, pad muted, subgraph disconnected',
    'color: #c9f; font-weight: bold', 'color: #999'
  );
}

/**
 * Wind Harp V3: Strum Mode.
 * Horizontal drag strums through the 9 harp notes — crossing a note boundary
 * triggers a percussive "pluck" (additive gain spike that decays exponentially).
 * Vertical drag controls delay wet + feedback for sustain/echo.
 * The autonomous LFO breathing continues underneath — strum sits on top.
 *
 * Inspired by Kaoss pads, XY controllers, and Teenage Engineering philosophy:
 * simple gesture → immediate musical result.
 */
let _v3ApplyLogCounter = 0;

function applyWindHarpV3Params(r, params, dt) {
  const wh = r.windHarp;
  if (!wh || !wh.active) return;
  const whCfg = VOICES[4].windHarp;
  const up = wh.userParams;
  const now = Tone.now();
  const tau = 0.015;
  const me = r.mouseExpr;

  // ── Shared layers: noise + pad + effects (V3 uses v3NoiseMix for noise level) ──

  // Noise layer: secondary controls overall volume, scaled by user noise mix
  // (final noiseGain is set below in the Y-axis macro section, which scales this base)
  // pinkGain is set to 1.0 once at activation — no per-frame write needed
  const noiseMix = up.v3NoiseMix != null ? up.v3NoiseMix : 0.66;
  // Floor of 0.25 so wind is audible from the first frame
  // (secondary is 0 for the first 3s of evolution — without floor, silence)
  const noiseLevel = Math.max(0.25, params.secondary) * noiseMix;

  // Brown gust: asymmetric amplitude LFO
  wh.gustPhase = (wh.gustPhase + (2 * Math.PI * dt) * wh.gustRate) % (2 * Math.PI);
  const rawSin = Math.sin(wh.gustPhase);
  let gustEnv;
  if (rawSin >= 0) {
    gustEnv = Math.pow(rawSin, whCfg.gustLfoRiseExp);
  } else {
    gustEnv = -Math.pow(-rawSin, whCfg.gustLfoCutExp);
  }
  const gustGain = (gustEnv + 1) * 0.5;
  if (!wh._prevFx) wh._prevFx = { gust: -1, phWet: -1, dlWet: -1, noise: -1, revWet: -1 };
  if (Math.abs(gustGain - wh._prevFx.gust) > 0.002) {
    wh.brownGain.gain.cancelAndHoldAtTime(now);
    wh.brownGain.gain.setTargetAtTime(gustGain, now, tau);
    wh._prevFx.gust = gustGain;
  }
  if (Math.abs(rawSin) < 0.02) {
    wh.gustRate = whCfg.gustLfoMinRate +
      Math.random() * (whCfg.gustLfoMaxRate - whCfg.gustLfoMinRate);
  }

  if (wh.autoFilter.octaves !== up.autoFilterOctaves)
    wh.autoFilter.octaves = up.autoFilterOctaves;

  // Tremolo
  const tremoloDepth = params.lfo * up.tremoloMaxDepth;
  if (wh.tremolo.depth.value !== tremoloDepth)
    wh.tremolo.depth.value = tremoloDepth;
  if (wh.tremolo.frequency.value !== up.tremoloRate)
    wh.tremolo.frequency.value = up.tremoloRate;

  // Phaser
  const phaserWet = params.lfo * up.phaserMaxWet;
  if (Math.abs(phaserWet - wh._prevFx.phWet) > 0.001) {
    wh.phaser.wet.cancelAndHoldAtTime(now);
    wh.phaser.wet.setTargetAtTime(phaserWet, now, 0.03);
    wh._prevFx.phWet = phaserWet;
  }

  // Pad volume: set below in Y-axis macro section (macro offsets from base + slider)

  // Harp base volume: base (-14dB) + user offset (Tone.js fallback only — worklet handles internally)
  if (!wh.useWorklet) {
    const harpVol = whCfg.harpVolume + (up.v3HarpVolume || 0);
    for (let i = 0; i < whCfg.harpNotes.length; i++) {
      if (wh.harpSynths[i] && wh.harpSynths[i].volume.value !== harpVol) wh.harpSynths[i].volume.value = harpVol;
    }
  }

  // ── V3: Y-axis MACRO — intimate (down) ↔ expansive (up) ──
  // Combines live + captured macro value, clamped to [-1, 1]
  const spaceMacro = me ? (me.v3SpaceMacro + me.capturedV3SpaceMacro) : 0;
  const y = Math.max(-1, Math.min(1, spaceMacro));

  // Response curves
  const yQ = y * Math.abs(y);            // quadratic: subtle center, dramatic extremes
  const yCubePos = y > 0 ? y * y * y : 0; // cubic positive-only: up only

  // — Tier 1: Spatial Envelope (primary) —

  // Harp reverb wet: slider center ± quadratic offset
  const reverbCenter = up.v3ReverbMix != null ? up.v3ReverbMix : 0.35;
  const reverbOffset = y >= 0 ? yQ * 0.45 : yQ * 0.35;
  const finalReverbWet = Math.max(0, Math.min(0.40, reverbCenter + reverbOffset));

  // Harp reverb room size: slider center ± linear offset
  const roomCenter = up.v3ReverbSize != null ? up.v3ReverbSize : 0.75;
  const roomOffset = y >= 0 ? y * 0.25 : y * 0.2;
  const finalRoomSize = Math.max(0.1, Math.min(0.99, roomCenter + roomOffset));

  // Delay wet: evolution base ± quadratic offset (reduced: 0.40→0.25 to tame buildup)
  const baseDelayWet = params.width * whCfg.delayMaxWet;
  const delayWetOffset = y >= 0 ? yQ * 0.25 : yQ * 0.15;
  const finalDelayWet = Math.max(0, Math.min(0.25, baseDelayWet + delayWetOffset));

  // Delay feedback: slider center ± linear offset (reduced: 0.15→0.10 to tame recirculation)
  const baseFeedback = up.delayFeedback;
  const fbOffset = y * 0.10;
  const finalFeedback = Math.max(0, Math.min(0.40, baseFeedback + fbOffset));

  // harpReverb removed (B2 consolidation) — main system reverb provides room sound

  if (Math.abs(finalDelayWet - wh._prevFx.dlWet) > 0.001) {
    wh.delay.wet.cancelAndHoldAtTime(now);
    wh.delay.wet.setTargetAtTime(finalDelayWet, now, 0.03);
    wh._prevFx.dlWet = finalDelayWet;
  }
  if (wh.delay.delayTime.value !== up.delayTime)
    wh.delay.delayTime.value = up.delayTime;
  if (wh.delay.feedback.value !== finalFeedback)
    wh.delay.feedback.value = finalFeedback;

  // — Tier 2: Tonal Depth (ambient bed) —

  // Universal reverb: cubic positive-only — only activates dragging UP (expansive wash)
  const finalUniversalReverb = yCubePos * 0.15;
  if (Math.abs(finalUniversalReverb - wh._prevFx.revWet) > 0.001) {
    _fxSetReverbTarget(wh, finalUniversalReverb, now, 0.03);
    wh._prevFx.revWet = finalUniversalReverb;
  }

  // Pad volume: Y offsets from slider center (linear dB, asymmetric: -6dB down, +2dB up)
  // Strum duck: brief pad dip so harp pluck cuts through, decays ~300ms
  if (wh.strumPadDuck > 0.001) {
    wh.strumPadDuck *= Math.exp(-5 * dt);
    if (wh.strumPadDuck < 0.001) wh.strumPadDuck = 0;
  }
  const padDuckDb = wh.strumPadDuck * -8;  // up to -8dB duck (gentler, no click artifacts)
  const padBase = whCfg.padVolume + (up.v3PadMix || 0);
  const padOffset = y >= 0 ? y * 2 : y * 6;
  const finalPadVol = Math.max(-30, Math.min(6, padBase + padOffset + padDuckDb));
  // Ramp pad volume instead of instant .value = to prevent pop on strum duck
  if (Math.abs(wh.harpPad.volume.value - finalPadVol) > 0.1) {
    wh.harpPad.volume.cancelAndHoldAtTime(now);
    wh.harpPad.volume.setTargetAtTime(finalPadVol, now, 0.02);  // ~20ms ramp — fast but click-free
  }

  // Noise: Y scales the evolution-driven noise level (0.4x down to 1.3x up)
  const noiseScale = 1.0 + (y >= 0 ? y * 0.3 : y * 0.6);
  const finalNoiseMix = Math.max(0, Math.min(1, noiseLevel * noiseScale));
  // Use longer ramp when noise gain changes significantly (strum/re-click) to prevent pop
  const noiseDelta = Math.abs(wh.noiseGain.gain.value - finalNoiseMix);
  const noiseTau = noiseDelta > 0.1 ? 0.03 : tau;  // 30ms for big jumps, 15ms for smooth evolution
  if (Math.abs(finalNoiseMix - wh._prevFx.noise) > 0.001) {
    wh.noiseGain.gain.cancelAndHoldAtTime(now);
    wh.noiseGain.gain.setTargetAtTime(finalNoiseMix, now, noiseTau);
    wh._prevFx.noise = finalNoiseMix;
  }

  // — Tier 3: Articulation —
  // Strum decay rate: inverted — up = slower (notes ring), down = faster (tight plucks)
  const decayCenter = up.v3StrumDecay != null ? up.v3StrumDecay : 3.0;
  const decayOffset = y >= 0 ? -y * 1.5 : -y * 2.5;
  const effectiveDecay = Math.max(0.5, Math.min(12, decayCenter + decayOffset));

  // Cache macro-derived values for diagnostics (getWindHarpV3Diag reads these)
  wh._macroCache = {
    y, noiseScale, effectiveDecay,
    finalReverbWet, finalRoomSize,
    finalDelayWet, finalFeedback,
    finalUniversalReverb, finalPadVol, finalNoiseMix,
  };

  // ── V3: Per-note harp — strum spikes ──
  const noteCount = whCfg.harpNotes.length;
  const strumDecayRate = effectiveDecay;
  const gateFloor = up.v3GateFloor != null ? up.v3GateFloor : 0.15;

  // Volume envelope: starts audible (~0.45), builds to full
  const secClamped = Math.min(1.0, params.secondary * 1.5);
  const volEnv = 0.45 + 0.55 * secClamped;

  // Brightness tilt: -1=dark (highs attenuated), +1=bright (lows attenuated)
  // ±6dB linear ramp across the 9 notes
  const brightness = up.v3HarpBrightness || 0;

  for (let i = 0; i < noteCount; i++) {
    // Advance LFO phase (autonomous breathing continues)
    const baseRate = whCfg.lfoRates[i];
    wh.lfoPhases[i] = (wh.lfoPhases[i] + (2 * Math.PI * dt) / baseRate) % (2 * Math.PI);

    // LFO phase advances for per-note breathing rhythm but
    // does NOT drive gain — strum is the only note trigger.

    // Decay strum boost for this note (exponential: *= exp(-rate * dt))
    if (me && me.v3StrumBoosts[i] > 0.001) {
      me.v3StrumBoosts[i] *= Math.exp(-strumDecayRate * dt);
      if (me.v3StrumBoosts[i] < 0.001) me.v3StrumBoosts[i] = 0;
    }

    // Combine: gate floor (ambient murmur) + strum spike only, capped at 1.0
    const strumBoost = me ? me.v3StrumBoosts[i] : 0;
    const combinedGain = Math.min(1.55, gateFloor + strumBoost);

    // Brightness tilt: per-note dB offset, converted to linear gain multiplier
    // t=0 (G3 lowest) to t=1 (F5 highest), tilt pivots around center
    const t = i / (noteCount - 1);
    const tiltDb = brightness * (t - 0.5) * 12; // ±6dB at extremes
    const tiltGain = Math.pow(10, tiltDb / 20);

    const finalGain = combinedGain * volEnv * tiltGain;

    if (wh.useWorklet) {
      // Buffer gain for batched MessagePort send below
      wh._workletGainBuf[i] = finalGain;
    } else {
      wh.harpGains[i].gain.cancelAndHoldAtTime(now);
      wh.harpGains[i].gain.setTargetAtTime(finalGain, now, tau);
    }
  }

  // Send batched gains to worklet (once per loop, not per-note)
  if (wh.useWorklet && wh.workletNode) {
    postWorkletGains(wh.workletNode, wh._workletGainBuf);
  }

  // Running-peak tracking (every frame, read & reset via diagnostics)
  const curGR = wh.harpLimiter ? wh.harpLimiter.reduction : 0;
  if (curGR < wh.peakLimiterGR) wh.peakLimiterGR = curGR;
  const curMasterGR = masterLimiter ? masterLimiter.reduction : 0;
  if (curMasterGR < peakMasterLimiterGR) peakMasterLimiterGR = curMasterGR;
  if (wh.meterPreFx) {
    const lvl = wh.meterPreFx.getValue();
    if (lvl > wh.peakPreFx) wh.peakPreFx = lvl;
  }
  if (wh.meterPostLimiter) {
    const lvl = wh.meterPostLimiter.getValue();
    if (lvl > wh.peakPostLimiter) wh.peakPostLimiter = lvl;
  }

  // Throttled per-frame log (~4x/sec at 60fps)
  // Enable: window._regionSynthDebug = true
  if (window._regionSynthDebug && ++_v3ApplyLogCounter % 15 === 0) {
    const boostStr = me
      ? Array.from(me.v3StrumBoosts).map((v, i) =>
          v > 0.001 ? `${whCfg.harpNotes[i]}=${v.toFixed(2)}` : null
        ).filter(Boolean).join(' ')
      : '';
    const activeNote = me && me.v3LastStrumIndex >= 0 ? whCfg.harpNotes[me.v3LastStrumIndex] : '—';
    const mouseActive = me ? me.active : false;
    _log(
      `%c[V3Apply]%c  note=%c${activeNote}%c  Y=${y.toFixed(2)}  rev=${finalReverbWet.toFixed(2)} room=${finalRoomSize.toFixed(2)} dly=${finalDelayWet.toFixed(3)} uniRev=${finalUniversalReverb.toFixed(2)} pad=${finalPadVol.toFixed(0)}dB decay=${effectiveDecay.toFixed(1)}  mouse=${mouseActive}  boosts=[${boostStr || 'none'}]`,
      'color: #c7a; font-weight: bold', 'color: #999', 'color: #ff0', 'color: #999'
    );
  }
}

// ── Living Wood per-frame update ──────────────────────────────────────────────

let _lwApplyLogCounter = 0;

function applyCypressLivingWoodParams(r, params, dt) {
  const lwState = r.livingWood;
  if (!lwState || !lwState.active) return;
  const lwCfg = VOICES[1].livingWood;
  const up = lwState.userParams;
  const now = Tone.now();
  const tau = 0.03;  // 30ms time constant — heavier than Wind Harp's 15ms
  const me = r.mouseExpr;
  // ── Bow velocity envelope ──
  // Mouse drag speed drives dynamics: still = quiet baseline, movement = full voice.
  // Asymmetric smoothing: fast attack (100ms) so strokes respond instantly,
  // slower release (300ms) so sound lingers briefly when bow slows.
  const targetVel = me && me.active ? (me.lwDragVelocity || 0) : 0;
  const velTau = targetVel > lwState.smoothedVelocity ? 0.10 : 0.30;
  lwState.smoothedVelocity += (targetVel - lwState.smoothedVelocity) * (1 - Math.exp(-dt / velTau));
  const vel = lwState.smoothedVelocity;

  // Velocity sensitivity: power curve reshaping (>1 = more responsive, <1 = forgiving)
  const velSens = up.velocitySensitivity || 1.0;
  const velScaled = Math.pow(vel, 1 / velSens);

  // ── Strum velocity injection — adds floor when strumming from stillness ──
  if (lwState.strumVelInjection > 0.001) {
    lwState.strumVelInjection *= Math.exp(-2.5 * dt);  // ~400ms decay — strum rings longer
    if (lwState.strumVelInjection < 0.001) lwState.strumVelInjection = 0;
  }
  const effectiveVelScaled = Math.max(velScaled, lwState.strumVelInjection);

  // Master velocity gain: static hold = velFloor, full drag = 1.0
  // Uses effectiveVelScaled so strum injection drives ALL layers (including pad)
  // Low floor (0.15) widens dynamic range — still bow is quiet, strums/movement are dramatic
  const velFloor = 0.15;
  const velGain = velFloor + effectiveVelScaled * (1 - velFloor);

  // ── Portato articulation pulse ──
  // Always active — velocity-gated so inert at rest, engages during active bowing
  const portatoPulseRate = 1.5 + lwState.smoothedVelocity * 3.0;

  // ── Layer A: Earth Rumble Gust LFO ──
  // Asymmetric amplitude envelope: slow concave rise, sharp convex cut
  lwState.gustPhase = (lwState.gustPhase + 2 * Math.PI * dt * lwState.gustRate) % (2 * Math.PI);
  const rawSin = Math.sin(lwState.gustPhase);
  const gustEnv = rawSin >= 0
    ? Math.pow(rawSin, lwCfg.gustLfoRiseExp)
    : -Math.pow(-rawSin, lwCfg.gustLfoCutExp);
  const gustRaw = (gustEnv + 1) * 0.5;   // map [-1,1] → [0,1]
  const gustGain = 0.4 + gustRaw * 0.6;  // floor at 40% so earth never goes silent
  // Dirty-flag: skip write if unchanged (saves Tone.js wrapper overhead)
  if (!lwState._prevFx) lwState._prevFx = { gust: -1, trem: -1, phWet: -1, dlWet: -1, dlFb: -1, earth: -1, sub: -1, pad: -1, revWet: -1, fmIdx: -1 };
  if (Math.abs(gustGain - lwState._prevFx.gust) > 0.002) {
    lwState.brownGain.gain.cancelAndHoldAtTime(now);
    lwState.brownGain.gain.setTargetAtTime(gustGain, now, tau);
    lwState._prevFx.gust = gustGain;
  }

  // Rate-switch near zero crossing for organic variation
  if (Math.abs(rawSin) < 0.02) {
    lwState.gustRate = lwCfg.gustLfoMinRate +
      Math.random() * (lwCfg.gustLfoMaxRate - lwCfg.gustLfoMinRate);
  }

  // Earth noise level — sits within ~8 dB of pad so bass foundation is felt
  // Low floor (0.15) so earth is nearly silent at rest, swells dramatically with bow/strum
  const earthLevel = Math.max(0.25, params.secondary) * up.earthMix * 1.8 * (0.15 + 0.85 * effectiveVelScaled);

  // Sub-oscillator — evolution × velocity (always present as foundation)
  // Low floor (0.20) to widen dynamics while keeping sub as a gentle anchor
  const subLevel = params.secondary * up.subMix * 0.7 * (0.20 + 0.80 * effectiveVelScaled);

  // ── Layer B: Trunk Resonance ──
  // FM depth: velocity opens harmonic richness — still bow = gentle FM, moving = full FM
  const fmVelFloor = 0.15;  // always some timbral movement even at rest
  const targetModIndex = lwCfg.padModIndexMin +
    (fmVelFloor + (1 - fmVelFloor) * effectiveVelScaled) * params.filter * (lwCfg.padModIndexMax - lwCfg.padModIndexMin);
  // ~150ms settling (was 0.005/frame ≈ multi-second crawl)
  const fmTau = 0.15;
  lwState.trunkModIndex += (targetModIndex - lwState.trunkModIndex) * (1 - Math.exp(-dt / fmTau));

  // Pad gain base level — velocity gain × user pad mix slider
  const padLevel = Math.max(0.2, params.gain) * velGain * up.padMix;

  // Tremolo depth — evolves with LFO param (frequency set once at activation)
  const lwTremDepth = params.lfo * lwCfg.tremoloMaxDepth;
  if (Math.abs(lwTremDepth - lwState._prevFx.trem) > 0.001) {
    lwState.tremolo.depth.value = lwTremDepth;
    lwState._prevFx.trem = lwTremDepth;
  }

  // ── Y-axis: Brightness / Energy Macro (Palmer et al. 2024) ──
  // Up = brighter, lighter, more energetic
  // Down = darker, heavier, more subdued — asymmetric (down 3-6× stronger)
  const contactMacro = me ? (me.lwRootDepth + me.capturedLwRootDepth) : 0;
  const y = Math.max(-1, Math.min(1, contactMacro));
  const yQ = y * Math.abs(y);  // quadratic: subtle center, dramatic extremes

  // Pad gain: Y-axis energy scaling (dominant lever — pad is loudest layer)
  // Down: ×0.35 at y=-1 (≈-9dB), Up: ×1.15 at y=+1 (+1.2dB)
  const padYScale = 1.0 + (y >= 0 ? y * 0.15 : y * 0.65);

  // FM mod index: down = simpler harmonics (darker), up = richer (brighter)
  const fmContactMul = 1.0 + (y >= 0 ? yQ * 0.25 : yQ * 0.6);

  // Branch overtone level: down = fewer (darker), up = more (brighter)
  const branchYScale = 1.0 + (y >= 0 ? y * 0.2 : y * 0.6);

  // Earth/sub: mild reduction (overall energy drops, but less than pad — mix tilts heavier)
  const earthYScale = 1.0 + (y >= 0 ? y * 0.15 : y * 0.15);
  const subYScale   = 1.0 + (y >= 0 ? y * 0.10 : y * 0.10);

  // Dark reverb: down = tighter/drier, up = more expansive
  const reverbCenter = up.reverbMix;
  const reverbOffset = y >= 0 ? yQ * 0.25 : yQ * 0.35;
  const finalReverbWet = Math.max(0, Math.min(0.6, reverbCenter + reverbOffset));
  if (Math.abs(finalReverbWet - lwState._prevFx.revWet) > 0.002) {
    _fxSetReverbTarget(lwState, finalReverbWet, now, tau);
    lwState._prevFx.revWet = finalReverbWet;
  }

  // Delay feedback: down = echoes die faster, up = sustain longer
  const baseFb = lwCfg.delayFeedback;
  const fbOffset = y >= 0 ? y * 0.10 : y * 0.15;
  const finalFeedback = Math.max(0, Math.min(0.35, baseFb + fbOffset));
  if (Math.abs(finalFeedback - lwState._prevFx.dlFb) > 0.001) {
    lwState.delay.feedback.cancelAndHoldAtTime(now);
    lwState.delay.feedback.setTargetAtTime(finalFeedback, now, tau);
    lwState._prevFx.dlFb = finalFeedback;
  }

  // Delay wet: Y-modulated (was evolution-only)
  const baseDelayWet = params.width * lwCfg.delayMaxWet * (up.delayMix / 0.15);
  const delayYOffset = y >= 0 ? yQ * 0.10 : yQ * 0.15;
  const finalDelayWet = Math.max(0, Math.min(0.6, baseDelayWet + delayYOffset));
  if (Math.abs(finalDelayWet - lwState._prevFx.dlWet) > 0.001) {
    lwState.delay.wet.cancelAndHoldAtTime(now);
    lwState.delay.wet.setTargetAtTime(finalDelayWet, now, tau);
    lwState._prevFx.dlWet = finalDelayWet;
  }

  // Phaser wet: Y-modulated (was evolution-only)
  const phaserBase = params.lfo * up.phaserWet;
  const phaserYOffset = y >= 0 ? y * 0.08 : y * 0.12;
  const finalPhaserWet = Math.max(0, Math.min(0.6, phaserBase + phaserYOffset));
  if (Math.abs(finalPhaserWet - lwState._prevFx.phWet) > 0.001) {
    lwState.phaser.wet.cancelAndHoldAtTime(now);
    lwState.phaser.wet.setTargetAtTime(finalPhaserWet, now, tau);
    lwState._prevFx.phWet = finalPhaserWet;
  }

  // Store Y-derived values for applyParams (filter + mainGain)
  lwState.yFilterMul = 1.0 + (y >= 0 ? y * 0.30 : y * 0.50);
  lwState.yGainScale = 1.0 + (y >= 0 ? y * 0.08 : y * 0.35);

  // ── Root-to-Crown Layer Crossfade (X-axis expression) ──
  // bowPos 0 = roots (earth/sub dominate), 0.5 = trunk (pad), 1.0 = canopy (branches)
  const bowPos = me ? me.lwBowPosition + me.capturedLwBowPosition : 0.5;
  const crown = Math.max(0, Math.min(1, bowPos));

  // Layer A multiplier: peaks at crown=0 (roots), fades out by crown=0.6
  const earthXfade = Math.max(0, 1 - crown / 0.6);
  // Layer B multiplier: bell curve peaking at crown=0.5 (trunk center)
  const trunkXfade = 1 - 2 * Math.abs(crown - 0.5);
  const trunkBell = Math.max(0, trunkXfade);
  // Layer C multiplier: silent at crown=0, rises from 0.4 onward
  const branchXfade = Math.max(0, (crown - 0.4) / 0.6);

  // Apply crossfade to earth + sub (Layer A) — multiply onto evolution-driven levels
  const xfEarth = 0.3 + 0.7 * earthXfade;  // floor 30% so roots never fully vanish

  // Portato velocity depth — computed once, reused across all pulse blocks
  const portatoVelDepth = Math.min(1.0, lwState.smoothedVelocity * 3.5);

  // Portato: gentle pressure pulse on foundation layers (body of the instrument resonates)
  // Velocity-scaled: at rest = no pulsing, faster drag = deeper pulse
  const foundationPulse = Math.pow(Math.sin(lwState.portatoPhase * 0.5), 2);
  const portatoFoundationMul = (1.0 - 0.25 * portatoVelDepth) + 0.25 * portatoVelDepth * foundationPulse;
  // rest: 1.0 (flat), full speed: 0.75–1.0

  const finalEarth = earthLevel * earthYScale * xfEarth * portatoFoundationMul;
  if (Math.abs(finalEarth - lwState._prevFx.earth) > 0.001) {
    lwState.earthGain.gain.cancelAndHoldAtTime(now);
    lwState.earthGain.gain.setTargetAtTime(finalEarth, now, tau);
    lwState._prevFx.earth = finalEarth;
  }
  const finalSub = subLevel * subYScale * xfEarth * portatoFoundationMul;
  if (Math.abs(finalSub - lwState._prevFx.sub) > 0.001) {
    lwState.subGain.gain.cancelAndHoldAtTime(now);
    lwState.subGain.gain.setTargetAtTime(finalSub, now, tau);
    lwState._prevFx.sub = finalSub;
  }

  // Apply crossfade to trunk pad (Layer B)
  const xfTrunk = 0.25 + 0.75 * trunkBell;  // floor 25% — always some body
  const finalPad = padLevel * padYScale * xfTrunk * portatoFoundationMul;
  if (Math.abs(finalPad - lwState._prevFx.pad) > 0.001) {
    lwState.padGain.gain.cancelAndHoldAtTime(now);
    lwState.padGain.gain.setTargetAtTime(finalPad, now, tau);
    lwState._prevFx.pad = finalPad;
  }

  // Apply crossfade to FM depth — crown + contact point + velocity all interact
  const fmXfadeBoost = crown * 0.4;  // dragging right adds up to +40% FM depth
  let fmBoostedIndex = lwState.trunkModIndex * (1 + fmXfadeBoost) * fmContactMul;

  // Portato: pulse FM modulation index — simulates bow pressure cycling into the string.
  // More pressure = more harmonics (higher mod index). This is the primary timbral effect.
  // Velocity-scaled: inert at rest, tighter range to prevent FM sideband energy spikes.
  // Reuse foundationPulse — identical sin²(phase/2) shape
  const fmFloor = 1.0 - 0.12 * portatoVelDepth;   // 1.0 at rest → 0.88 at speed
  const fmSwing = 0.37 * portatoVelDepth;           // 0.0 at rest → 0.37 at speed
  fmBoostedIndex *= (fmFloor + fmSwing * foundationPulse);

  // Clamp final FM index to padModIndexMax — crown boost + contact + portato can overshoot
  fmBoostedIndex = Math.min(fmBoostedIndex, lwCfg.padModIndexMax);

  // Harmonicity wobble: shift the carrier:modulator ratio at each pressure pulse.
  // This moves WHERE sidebands land, not just how many — creates shifting formant emphasis
  // and subtle beating patterns that make the timbre feel alive ("growl" quality).
  const harmPulse = Math.sin(lwState.portatoPhase);  // bipolar [-1, +1] for symmetric wobble
  const baseHarm = lwState.userParams.trunkHarmonicity;
  const wobbleAmount = baseHarm * 0.05 * portatoVelDepth;

  // ── Scordatura veil — slow pitch wobble simulating detuned string ──
  // 22-second period (prime-ish, won't sync with branch LFOs), ±4 cents
  lwState.scordaturaPhase = (lwState.scordaturaPhase + dt * (2 * Math.PI / 22)) % (2 * Math.PI);
  const detuneAmount = Math.sin(lwState.scordaturaPhase) * 4;

  // Single .set() call — avoids 3× object allocation + Tone.js diffing per frame
  // Dirty-flag: skip if FM index hasn't changed meaningfully
  if (Math.abs(fmBoostedIndex - lwState._prevFx.fmIdx) > 0.005) {
    lwState.trunkPad.set({
      modulationIndex: fmBoostedIndex,
      harmonicity: baseHarm + wobbleAmount * harmPulse,
      detune: detuneAmount,
    });
    lwState._prevFx.fmIdx = fmBoostedIndex;
  }

  // ── Layer C: Branch Voices — Crossfade + LFO + Activation + Velocity ──
  for (let i = 0; i < lwCfg.branchNotes.length; i++) {
    // Advance LFO phase (autonomous breathing)
    const baseRate = lwCfg.lfoRates[i];
    lwState.lfoPhases[i] = (lwState.lfoPhases[i] + 2 * Math.PI * dt / baseRate) % (2 * Math.PI);

    // ── Sustained LFO breathing + crossfade ──
    // sin² LFO envelope (0 to 1, smooth swells)
    const halfPhase = lwState.lfoPhases[i] * 0.5;
    const lfoVal = Math.pow(Math.sin(halfPhase), 2);

    // Activation: voice activates when secondary crosses threshold
    // Thresholds lowered (÷3 → more voices earlier) so portato has harmonic material to pulse
    const activationIdx = lwCfg.activationOrder.indexOf(i);
    const voiceThreshold = activationIdx / lwCfg.branchNotes.length;
    const activationT = Math.max(0, Math.min(1, (params.secondary - voiceThreshold) * 6));
    let voiceEnv = activationT * activationT * (3 - 2 * activationT);
    if (activationIdx <= 1) voiceEnv = Math.max(0.35, voiceEnv);
    else if (activationIdx <= 3) voiceEnv = Math.max(0.15, voiceEnv);
    else if (activationIdx <= 5) voiceEnv = Math.max(0.05, voiceEnv);

    // Crown crossfade + Y-axis brightness scaling
    const xfBranch = 0.2 + 0.8 * branchXfade;
    const branchVelMix = 0.2 + 0.8 * effectiveVelScaled;
    const branchVol = up.branchVolume;  // full range 0–1, no floor
    const finalGain = Math.max(0, xfBranch * branchYScale) * (0.3 + 0.7 * lfoVal) * voiceEnv * branchVelMix * branchVol;

    // Portato: sin² pressure pulse per branch (staggered phases for organic feel)
    // Velocity-scaled: inert at rest, tighter ceiling to avoid clipping
    const branchOffset = i * Math.PI / 7;  // slight stagger between voices
    const pulse = Math.pow(Math.sin((lwState.portatoPhase + branchOffset) * 0.5), 2);
    // rest: flat 1.0, full speed: 0.50–1.10
    const portatoMul = (1.0 - 0.50 * portatoVelDepth) + 0.60 * portatoVelDepth * pulse;

    if (lwState.useWorklet) {
      // Buffer gain for batched MessagePort send below
      lwState._workletGainBuf[i] = finalGain * portatoMul;
    } else {
      lwState.branchGains[i].gain.setTargetAtTime(finalGain * portatoMul, now, tau);
    }
  }

  // Send batched gains to worklet (once per loop, not per-note)
  if (lwState.useWorklet && lwState.workletNode) {
    postWorkletGains(lwState.workletNode, lwState._workletGainBuf);
  }

  // Advance portato phase accumulator (after loop)
  lwState.portatoPhase = (lwState.portatoPhase + 2 * Math.PI * portatoPulseRate * dt) % (2 * Math.PI);

  // branchReverb removed (B2 consolidation) — branches get reverb from main system chain

  // Running-peak tracking
  const curGR = lwState.limiter ? lwState.limiter.reduction : 0;
  if (curGR < lwState.peakLimiterGR) lwState.peakLimiterGR = curGR;
  const curMasterGR = masterLimiter ? masterLimiter.reduction : 0;
  if (curMasterGR < peakMasterLimiterGR) peakMasterLimiterGR = curMasterGR;
  if (lwState.meterPreFx) {
    const lvl = lwState.meterPreFx.getValue();
    if (lvl > lwState.peakPreFx) lwState.peakPreFx = lvl;
  }
  if (lwState.meterPostLimiter) {
    const lvl = lwState.meterPostLimiter.getValue();
    if (lvl > lwState.peakPostLimiter) lwState.peakPostLimiter = lvl;
  }

  // Throttled per-frame log (~4x/sec at 60fps)
  if (window._regionSynthDebug && ++_lwApplyLogCounter % 15 === 0) {
    const zone = crown < 0.33 ? 'ROOTS' : crown < 0.66 ? 'TRUNK' : 'CANOPY';
    const bright = y > 0.3 ? 'BRIGHT' : y < -0.3 ? 'DARK' : 'NEUTRAL';
    _log(
      `%c[LWBow]%c  crown=${crown.toFixed(2)}[${zone}] Y=${y.toFixed(2)}[${bright}] padY=${padYScale.toFixed(2)} vel=${vel.toFixed(2)} xf:e=${xfEarth.toFixed(2)}/t=${xfTrunk.toFixed(2)}/b=${branchXfade.toFixed(2)} fm=${fmBoostedIndex.toFixed(2)}`,
      'color: #6c6; font-weight: bold', 'color: #999'
    );
  }
}

// ── Celestial Strings per-frame update ────────────────────────────────────────

let _csApplyLogCounter = 0;
let _csWriteSkip = 0;  // throttle: write to Web Audio nodes every 3rd frame

function applyCelestialStringsParams(r, params, dt) {
  const csState = r.celestialStrings;
  if (!csState || !csState.active) return;
  const csCfg = VOICES[5].celestialStrings;
  const up = csState.userParams;
  const me = r.mouseExpr;
  // Throttle Web Audio .value writes to every 3rd frame (~20fps).
  // LFO phases and strum decay still advance every frame (they accumulate dt).
  // But writing 12+ gain values to the audio thread 60×/sec is unnecessary
  // for 31-79 second LFO periods and causes CPU pressure.
  const writeThisFrame = (++_csWriteSkip % 3 === 0) || (me && me.active);

  // ── Noise layer: gust-modulated cosmic static ──
  const noiseMix = up.noiseMix != null ? up.noiseMix : 0.5;
  const noiseLevel = Math.max(0.15, params.secondary) * noiseMix;  // noiseMix=0 → off

  // Gust LFO: asymmetric amplitude
  csState.gustPhase = (csState.gustPhase + (2 * Math.PI * dt) * csState.gustRate) % (2 * Math.PI);
  const rawSin = Math.sin(csState.gustPhase);
  let gustEnv;
  if (rawSin >= 0) {
    gustEnv = Math.pow(rawSin, csCfg.gustLfoRiseExp);
  } else {
    gustEnv = -Math.pow(-rawSin, csCfg.gustLfoCutExp);
  }
  const gustGain = (gustEnv + 1) * 0.5;
  // Noise gain = base level × gust modulation
  const finalNoiseGain = noiseLevel * (0.3 + 0.7 * gustGain);
  if (writeThisFrame) csState.noiseGain.gain.value = finalNoiseGain;
  // Re-randomize gust rate near zero-crossing
  if (Math.abs(rawSin) < 0.02) {
    csState.gustRate = csCfg.gustLfoMinRate +
      Math.random() * (csCfg.gustLfoMaxRate - csCfg.gustLfoMinRate);
  }

  // ── Tremolo ──
  const tremoloDepth = params.lfo * csCfg.tremoloMaxDepth;
  if (writeThisFrame && csState.tremolo.depth.value !== tremoloDepth)
    csState.tremolo.depth.value = tremoloDepth;

  // ── Phaser ──
  const phaserWet = params.lfo * up.phaserWet;
  if (writeThisFrame) csState.phaser.wet.value = phaserWet;

  // ── Pad: evolving FM depth ──
  const targetModIndex = csCfg.padModIndexMin + params.secondary * (csCfg.padModIndexMax - csCfg.padModIndexMin);
  csState.padModIndex += (targetModIndex - csState.padModIndex) * 0.02;
  csState.glassyPad.set({ modulationIndex: csState.padModIndex });

  // Pad gain: evolution-driven, scaled by user padMix (0=off, 1=full)
  const padMix = up.padMix != null ? up.padMix : 1;
  const padBase = params.gain * 0.7 * padMix;  // no hardcoded floor — 0 = off
  if (writeThisFrame) csState.padGain.gain.value = padBase;

  // ── Y-axis MACRO — intimate (down) ↔ expansive (up) ──
  const spaceMacro = me ? (me.csSpaceMacro + me.capturedCsSpaceMacro) : 0;
  const y = Math.max(-1, Math.min(1, spaceMacro));
  const yQ = y * Math.abs(y);

  // String reverb: slider center ± quadratic offset
  const reverbCenter = up.reverbMix != null ? up.reverbMix : 0.25;
  const reverbOffset = y >= 0 ? yQ * 0.25 : yQ * 0.15;
  const finalReverbWet = Math.max(0, Math.min(0.35, reverbCenter + reverbOffset));

  // Room size: slider center ± linear offset
  const roomCenter = up.reverbSize != null ? up.reverbSize : 0.85;
  const roomOffset = y >= 0 ? y * 0.15 : y * 0.12;
  const finalRoomSize = Math.max(0.1, Math.min(0.99, roomCenter + roomOffset));

  // Delay wet — user delayMix scales the evolution-driven base (0=off)
  const delayScale = up.delayMix != null ? up.delayMix : 0.15;
  const baseDelayWet = params.width * (delayScale / 0.15) * csCfg.delayMaxWet;
  const delayWetOffset = y >= 0 ? yQ * 0.20 : yQ * 0.12;
  const finalDelayWet = Math.max(0, Math.min(0.25, baseDelayWet + delayWetOffset));

  // Delay feedback
  const baseFeedback = csCfg.delayFeedback;
  const fbOffset = y * 0.08;
  const finalFeedback = Math.max(0, Math.min(0.35, baseFeedback + fbOffset));

  // Cold reverb wet (computed every frame for diagnostics, written on throttle)
  const coldReverbWet = params.deepReverb * 0.35;

  if (writeThisFrame) {
    // stringReverb removed (B2 consolidation) — strings get reverb from main system chain

    csState.delay.wet.value = finalDelayWet;
    if (csState.delay.feedback.value !== finalFeedback)
      csState.delay.feedback.value = finalFeedback;

    _fxSetReverbWet(csState, coldReverbWet);

    // ── Filter floor: let CS string fundamentals through r5.filter ──
    // Base applyParams sets the filter from filterClosed(650Hz) which cuts 8 of 12 notes.
    // Floor at 1500Hz lets G4(392Hz) and first harmonics through for warmth from the start.
    // Was 3000Hz — too dark, made Stars sound distant during first 5-10s of expression.
    const csFilterFloor = 1500;
    if (r.filter.frequency.value < csFilterFloor) {
      r.filter.frequency.value = csFilterFloor;
    }
  }

  // ── Strum decay rate ── Y inverts: up = slower (ring), down = faster (tight)
  const decayCenter = up.strumDecay != null ? up.strumDecay : 2.5;
  const decayYOffset = y >= 0 ? -y * 1.2 : -y * 2.0;
  const effectiveDecay = Math.max(0.5, Math.min(10, decayCenter + decayYOffset));

  // Cache macro-derived values for diagnostics
  csState._macroCache = {
    y, finalReverbWet, finalRoomSize, finalDelayWet, finalFeedback, effectiveDecay, coldReverbWet,
  };

  // ── Per-note strings: LFO breathing + strum spikes ──
  const noteCount = csCfg.stringNotes.length;
  const strumDecayRate = effectiveDecay;
  const gateFloor = up.gateFloor != null ? up.gateFloor : csCfg.gateFloor;
  const lfoDepth = csCfg.lfoDepth || 0.70;
  const brightness = up.stringBrightness || 0;

  // Volume envelope: starts present (~0.55), builds to full.
  // Was 0.35 — strings started at -38dB (inaudible). Raised for ~50% more initial presence.
  const secClamped = Math.min(1.0, params.secondary * 1.5);
  const volEnv = 0.55 + 0.45 * secClamped;

  for (let i = 0; i < noteCount; i++) {
    // Advance LFO phase (autonomous breathing)
    const baseRate = csCfg.lfoRates[i];
    csState.lfoPhases[i] = (csState.lfoPhases[i] + (2 * Math.PI * dt) / baseRate) % (2 * Math.PI);

    // sin² LFO for gentle breathing — ranges 0 to 1
    const lfoVal = Math.pow(Math.sin(csState.lfoPhases[i] * 0.5), 2);

    // Decay strum boost
    if (me && me.csStrumBoosts[i] > 0.001) {
      me.csStrumBoosts[i] *= Math.exp(-strumDecayRate * dt);
      if (me.csStrumBoosts[i] < 0.001) me.csStrumBoosts[i] = 0;
    }

    // Combine: gate floor + LFO breathing + strum spike
    // Deep breathing: notes swell from near-silence (0.05) to full presence (0.74).
    // Prime-number LFO rates ensure shifting voicings — only 3-4 notes prominent at any moment.
    const strumBoost = me ? me.csStrumBoosts[i] : 0;
    // Ensure a minimum pre-strum gain to avoid click/pop when strumming a near-silent note
    const strumLift = strumBoost > 0.01 ? Math.max(0.08, gateFloor) : gateFloor;
    const lfoComponent = strumLift + (1.0 - strumLift) * lfoVal * lfoDepth;
    const combinedGain = Math.min(1.55, lfoComponent + strumBoost);

    // Brightness tilt: ±6dB across the 12 notes
    const t = i / (noteCount - 1);
    const tiltDb = brightness * (t - 0.5) * 12;
    const tiltGain = Math.pow(10, tiltDb / 20);

    // stringVolume: user mix control (0=off, 1=full)
    const stringMix = up.stringVolume != null ? up.stringVolume : 1;
    const finalGain = combinedGain * volEnv * tiltGain * stringMix;

    if (writeThisFrame) {
      if (csState.useWorklet) {
        // Gains buffered and sent in batch below
        csState._workletGainBuf[i] = finalGain;
      } else {
        csState.stringGains[i].gain.value = finalGain;
      }
    }
    // Store pure LFO breathing value (0–1) for visual speed mapping.
    // Excludes strum/brightness/volume so speed tracks organic breathing only.
    csState._lfoBreathing[i] = lfoVal;
  }

  // Send batched gains to worklet (once per writeThisFrame, not per-note)
  if (writeThisFrame && csState.useWorklet && csState.workletNode) {
    postWorkletGains(csState.workletNode, csState._workletGainBuf);
  }

  // Running-peak tracking
  const curGR = csState.limiter ? csState.limiter.reduction : 0;
  if (curGR < csState.peakLimiterGR) csState.peakLimiterGR = curGR;
  const curMasterGR = masterLimiter ? masterLimiter.reduction : 0;
  if (curMasterGR < peakMasterLimiterGR) peakMasterLimiterGR = curMasterGR;
  if (csState.meterPreFx) {
    const lvl = csState.meterPreFx.getValue();
    if (lvl > csState.peakPreFx) csState.peakPreFx = lvl;
  }
  if (csState.meterPostLimiter) {
    const lvl = csState.meterPostLimiter.getValue();
    if (lvl > csState.peakPostLimiter) csState.peakPostLimiter = lvl;
  }

  // Throttled log (~4x/sec at 60fps)
  if (window._regionSynthDebug && ++_csApplyLogCounter % 15 === 0) {
    const boostStr = me
      ? Array.from(me.csStrumBoosts).map((v, i) =>
          v > 0.001 ? `${csCfg.stringNotes[i]}=${v.toFixed(2)}` : null
        ).filter(Boolean).join(' ')
      : '';
    _log(
      `%c[CSApply]%c  Y=${y.toFixed(2)}  rev=${finalReverbWet.toFixed(2)} room=${finalRoomSize.toFixed(2)} dly=${finalDelayWet.toFixed(3)} decay=${effectiveDecay.toFixed(1)}  boosts=[${boostStr || 'none'}]`,
      'color: #c9f; font-weight: bold', 'color: #999'
    );
  }
}

// ── Night Sky per-frame update ─────────────────────────────────────────────────
// 3 independent noise gust LFOs, per-voice breathing + strum, Y-macro space.
function applyNightSkyParams(r, params, dt) {
  const sky = r.nightSky;
  if (!sky || !sky.active) return;

  const me = r.mouseExpr || {};
  const up = sky.userParams;

  // Dirty-flag cache: skip unchanged AudioParam writes (same pattern as applyParams)
  if (!sky._prev) sky._prev = { deep: -1, wind: -1, air: -1, pad: -1, rev: -1, ph: -1, dlWet: -1, spread: -1 };
  const prev = sky._prev;
  const now = Tone.now();

  // ── Detuning evolution: spread widens as sound evolves ──
  // 2.5 cents (tight, warm) → 6 cents (slightly hazier) over evolution
  const spreadCents = 2.5 + params.secondary * 3.5;
  if (sky.useWorklet && sky.workletNode && Math.abs(spreadCents - prev.spread) > 0.1) {
    sky.workletNode.port.postMessage({ type: 'spread', cents: spreadCents });
    prev.spread = spreadCents;
  }

  // ── Noise layer: secondary controls overall noise level ──
  // Noise is icing — ambient texture only. Brown noise has huge low-frequency
  // energy density, so the deep band gets an extra 0.15 attenuation.
  const noiseLevel = Math.min(1, params.secondary) * up.noiseMix * 0.06;

  // Deep space gust (asymmetric: slow rise exp 0.3, fast fall exp 2.5)
  sky.deepGustPhase += sky.deepGustRate * dt;
  if (sky.deepGustPhase > 1) {
    sky.deepGustPhase -= 1;
    sky.deepGustRate = 0.025 + Math.random() * 0.010;
  }
  const deepRaw = sky.deepGustPhase < 0.5
    ? Math.pow(sky.deepGustPhase * 2, 0.3)
    : 1 - Math.pow((sky.deepGustPhase - 0.5) * 2, 2.5);
  const deepEnv = (0.3 + 0.7 * Math.max(0, deepRaw)) * 0.15;

  // Stellar wind gust
  sky.windGustPhase += sky.windGustRate * dt;
  if (sky.windGustPhase > 1) {
    sky.windGustPhase -= 1;
    sky.windGustRate = 0.020 + Math.random() * 0.015;
  }
  const windRaw = sky.windGustPhase < 0.5
    ? Math.pow(sky.windGustPhase * 2, 0.4)
    : 1 - Math.pow((sky.windGustPhase - 0.5) * 2, 2.0);
  const windEnv = (0.2 + 0.8 * Math.max(0, windRaw)) * 0.5;

  // High atmosphere gust
  sky.airGustPhase += sky.airGustRate * dt;
  if (sky.airGustPhase > 1) {
    sky.airGustPhase -= 1;
    sky.airGustRate = 0.030 + Math.random() * 0.012;
  }
  const airRaw = sky.airGustPhase < 0.5
    ? Math.pow(sky.airGustPhase * 2, 0.5)
    : 1 - Math.pow((sky.airGustPhase - 0.5) * 2, 2.0);
  const airEnv = (0.15 + 0.85 * Math.max(0, airRaw)) * 0.3;
  // Tremolo depth from LFO evolution
  const tremoloDepth = params.lfo * 0.4;
  if (Math.abs(sky.tremolo.depth.value - tremoloDepth) > 0.01) {
    sky.tremolo.depth.value = tremoloDepth;
  }

  // ── Phaser + delay from evolution ──
  // Strum shimmer: phaser wet boosts briefly on pluck, decays ~150ms
  if (sky.strumShimmer > 0.001) {
    sky.strumShimmer *= Math.exp(-8.0 * dt); // fast decay (~125ms to 10%)
    if (sky.strumShimmer < 0.001) sky.strumShimmer = 0;
  }
  const phaserWet = Math.min(0.5, params.lfo * up.phaserWet + sky.strumShimmer * 0.3);
  if (Math.abs(phaserWet - prev.ph) > 0.001) {
    sky.phaser.set({ wet: phaserWet });
    prev.ph = phaserWet;
  }

  // ── Y-axis space macro — intimate (down) ↔ expansive (up) ──
  // Matches Wind Harp / Celestial Strings pattern: 3-tier modulation
  const yRaw = (me.v3SpaceMacro || 0) + (me.capturedV3SpaceMacro || 0);
  const y = Math.max(-1, Math.min(1, yRaw));
  const yQ = y * Math.abs(y); // quadratic: subtle center, dramatic extremes

  // — Tier 1: Spatial Envelope (primary) —

  // Reverb send: slider center ± quadratic offset, gated by evolution.
  // Ducked on strum (same strumDuck as delay) so pluck attack stays dry and articulate.
  const strumDuck = 1.0 - Math.min(1.0, sky.strumShimmer * 1.5);
  const reverbCenter = up.reverbMix * Math.min(1, params.secondary * 1.5);
  const reverbOffset = y >= 0 ? yQ * 0.45 : yQ * 0.35;
  const reverbWet = Math.max(0, Math.min(0.8, (reverbCenter + reverbOffset) * strumDuck));
  if (Math.abs(reverbWet - prev.rev) > 0.001) {
    sky.reverbSend.gain.cancelAndHoldAtTime(now);
    sky.reverbSend.gain.setTargetAtTime(reverbWet, now, 0.08);
    prev.rev = reverbWet;
  }

  // Delay wet: ± quadratic offset, ducked on strum (same strumDuck as reverb above)
  const baseDelayWet = Math.min(0.5, params.width * up.delayMix);
  const delayWetOffset = y >= 0 ? yQ * 0.25 : yQ * 0.15;
  const finalDelayWet = Math.max(0, Math.min(0.5, (baseDelayWet + delayWetOffset) * strumDuck));
  if (Math.abs(finalDelayWet - prev.dlWet) > 0.001) {
    sky.delay.set({ wet: finalDelayWet });
    prev.dlWet = finalDelayWet;
  }

  // Delay feedback: center ± linear offset
  const delayFb = Math.max(0, Math.min(0.55, NS_FX.delayFeedback + y * 0.12));
  if (Math.abs(sky.delay.feedback.value - delayFb) > 0.01) {
    sky.delay.feedback.value = delayFb;
  }

  // — Tier 2: Tonal Depth (ambient bed) —

  // Pad volume: asymmetric dB offset (down = -8dB darker, up = +3dB fuller)
  // Strum duck: brief pad dip so voice pluck cuts through
  if (sky.strumPadDuck > 0.001) {
    sky.strumPadDuck *= Math.exp(-5 * dt);
    if (sky.strumPadDuck < 0.001) sky.strumPadDuck = 0;
  }
  const padDuckScale = 1.0 - sky.strumPadDuck * 0.7;
  const padYScale = y >= 0 ? (1.0 + y * 0.5) : (1.0 + y * 0.8); // up = +50%, down = -80%
  const padLevel = Math.min(1, params.secondary * 1.5) * up.padMix * padYScale * padDuckScale;
  if (Math.abs(padLevel - prev.pad) > 0.001) {
    sky.padGain.gain.cancelAndHoldAtTime(now);
    sky.padGain.gain.setTargetAtTime(padLevel, now, 0.08);
    prev.pad = padLevel;
  }

  // Noise: Y scales the noise floor (0.3x down to 1.5x up)
  const noiseYScale = 1.0 + (y >= 0 ? y * 0.5 : y * 0.7);
  // Apply deferred noise gains (gust envelopes computed above, Y-scale applied here)
  const deepVal = noiseLevel * deepEnv * noiseYScale;
  const windVal = noiseLevel * windEnv * noiseYScale;
  const airVal  = noiseLevel * airEnv * noiseYScale;
  if (Math.abs(deepVal - prev.deep) > 0.0001) {
    sky.deepGain.gain.cancelAndHoldAtTime(now);
    sky.deepGain.gain.setTargetAtTime(deepVal, now, 0.05);
    prev.deep = deepVal;
  }
  if (Math.abs(windVal - prev.wind) > 0.0001) {
    sky.windGain.gain.cancelAndHoldAtTime(now);
    sky.windGain.gain.setTargetAtTime(windVal, now, 0.05);
    prev.wind = windVal;
  }
  if (Math.abs(airVal - prev.air) > 0.0001) {
    sky.airGain.gain.cancelAndHoldAtTime(now);
    sky.airGain.gain.setTargetAtTime(airVal, now, 0.05);
    prev.air = airVal;
  }

  // — Tier 3: Articulation + Voice Dynamics —

  // Brightness tilt: Y shifts the spectral balance (down = dark/low notes, up = bright/high notes)
  const yBrightness = up.brightness + y * 0.6; // ±0.6 tilt (stronger than before)

  // Voice volume: Y dims voices on drag-down (intimate/close), brightens on drag-up
  // Asymmetric: down = -60% volume (dramatic darkening), up = +20% (gentle lift)
  const voiceYScale = y >= 0 ? (1.0 + y * 0.2) : (1.0 + y * 0.6);

  // Filter: Y closes the region filter on drag-down for audible timbral darkening
  // This affects ALL Night Sky audio (voices + pad + noise) through r.filter
  const yFilterOffset = y >= 0 ? y * 0.15 : y * 0.4; // down = close filter significantly
  sky.yFilterOffset = yFilterOffset;

  // Strum decay: inverted — up = slower (notes ring), down = faster (tight plucks)
  const effectiveStrumDecay = up.strumDecay * (1.0 + (y >= 0 ? -y * 0.5 : -y * 1.0));

  // ── Per-voice gains: LFO breathing + strum + brightness tilt ──
  // No params.gain — voices start at stable volume, filter brightening provides the evolution.
  const voiceScale = up.voiceVolume * voiceYScale;
  const brightness = yBrightness; // Y-axis shifts brightness tilt

  // Strum decay (Y-modulated: up = ring longer, down = tight)
  if (me.v3StrumBoosts) {
    const decayRate = effectiveStrumDecay;
    for (let i = 0; i < NS_VOICE_COUNT; i++) {
      if (me.v3StrumBoosts[i] > 0.001) {
        me.v3StrumBoosts[i] *= Math.exp(-decayRate * dt);
      } else {
        me.v3StrumBoosts[i] = 0;
      }
    }
  }

  const buf = sky._workletGainBuf;
  // Voice hierarchy: quiet bed — strum stands out by contrast, not by ducking
  // G3=root, A3=sus2(color), D4=fifth, F4=m7(color), G4=octave(bridge), A4=sus2(color)
  const voiceHierarchy = [0.32, 0.20, 0.29, 0.20, 0.25, 0.20];

  for (let i = 0; i < NS_VOICE_COUNT; i++) {
    // Advance breathing LFO phase (autonomous, per-voice prime-number rates)
    sky.lfoPhases[i] = (sky.lfoPhases[i] + (2 * Math.PI * dt) / NS_LFO_RATES[i]) % (2 * Math.PI);
    // sin² for gentle breathing — ranges 0 to 1
    const lfoVal = Math.pow(Math.sin(sky.lfoPhases[i] * 0.5), 2);
    sky._lfoBreathing[i] = lfoVal;
    // Breathing: voice swings from (1 - NS_LFO_DEPTH) to 1.0 of hierarchy gain
    const breathMul = (1 - NS_LFO_DEPTH) + NS_LFO_DEPTH * lfoVal;

    // Brightness tilt: -1 → low notes louder, +1 → high notes louder
    const tiltNorm = (i / (NS_VOICE_COUNT - 1)) * 2 - 1; // -1 to +1
    const tiltDb = brightness * tiltNorm * 6; // ±6dB
    const tiltLin = Math.pow(10, tiltDb / 20);

    // Strum lifts voice to full hierarchy gain — pluck always lands at full presence
    // regardless of where the breathing cycle is. Lift decays with the strum boost.
    const strumBoost = me.v3StrumBoosts ? me.v3StrumBoosts[i] : 0;
    const strumActive = strumBoost > 0.01;
    const effBreathMul = strumActive ? 1.0 : breathMul;
    const finalGain = (voiceHierarchy[i] * effBreathMul * voiceScale + strumBoost * up.strumIntensity) * tiltLin;
    buf[i] = Math.min(1.0, finalGain);
  }

  // Send to worklet or apply to Tone.js gains
  if (sky.useWorklet && sky.workletNode) {
    postWorkletGains(sky.workletNode, buf);
  } else {
    // Direct .value assignment (same pattern as Celestial Strings, line 3846).
    // Avoids cancelAndHoldAtTime/setTargetAtTime collisions with strum dip ramps.
    // At 60fps, 16ms between writes is smooth enough — no audible stepping.
    for (let i = 0; i < sky.voiceGains.length; i++) {
      sky.voiceGains[i].gain.value = buf[i];
    }
  }
}

// ── Village Pulse: per-frame LFO rate + overtone breathing + evolution ────────
// X-axis controls master LFO rate. Each overtone breathes independently at
// its own prime-number period. Evolution params drive complexity over hold time.
function applyVillagePulse(r, params, dt) {
  const vp = r.villagePulse;
  if (!vp) return;
  const me = r.mouseExpr;

  // X-axis expression → rate (0 = min, 1 = max)
  const liveRate = me && me.active ? Math.abs(me.vhXFilterExpr + me.capturedVhXFilter) : 0;
  vp.liveRate = Math.min(1, liveRate);

  // Decay captured rate on release
  if (me && !me.active && vp.capturedRate > 0.001) {
    vp.capturedRate *= Math.exp(-VP_RATE_DECAY_K * dt);
    if (vp.capturedRate < 0.001) vp.capturedRate = 0;
  } else if (me && me.active) {
    vp.capturedRate = vp.liveRate;
  }

  const rate = me && me.active ? vp.liveRate : vp.capturedRate;

  // Exponential mapping: small movements near origin = subtle, big drags = dramatic
  const minRate = vp.lfoMinRate || VP_LFO_MIN_RATE;
  const maxRate = vp.lfoMaxRate || VP_LFO_MAX_RATE;
  const targetRate = minRate + (maxRate - minRate) * rate * rate;

  // Only update LFO rate when it changes meaningfully
  if (Math.abs(targetRate - vp.currentRate) > 0.01) {
    vp.currentRate = targetRate;
    vp.lfo.frequency.value = targetRate;
  }

  // X-axis proximity: rate + filter brightness + reverb wetness
  // Faster pulse = brighter, drier, more urgent (closer to village)
  // Slower pulse = darker, wetter, more distant (further away)
  const filterMin = 900;   // warm but FM harmonics audible (at origin)
  const filterMax = 3000;  // bright, present (at full drag)
  const reverbWetMax = 0.55;  // wet, distant (at origin)
  const reverbWetMin = 0.2;   // drier, closer (at full drag)

  // ── Y-axis: window macro ──────────────────────────────────────────────────
  // Up (+1) = window opens: brighter, richer, more audible, more room bleed
  // Down (-1) = window closes: darker, purer, quieter, muffled behind stone
  // Asymmetric: closing is 3× stronger than opening (matches cypress Y)
  const yRaw = me ? (me.filterOffset + (me.capturedFilter || 0)) : 0;
  const yUp = Math.max(0, yRaw);                // 0→1 (opening)
  const yDown = Math.min(0, yRaw);              // -1→0 (closing)
  const yWindow = yUp * 0.4 + yDown * 1.2;     // asymmetric: -1.2 → +0.4

  // Combined filter: X proximity + Y window
  const yFilterMul = 1 + yWindow * 0.6;        // ×0.28 (closed) to ×1.24 (open)
  const targetFilter = (filterMin + (filterMax - filterMin) * rate) * yFilterMul;
  // Only set from X/Y when not strumming — strum bloom takes control.
  // Ramp to smooth out the first-activation discontinuity (see lowPadGain note).
  if ((vp.strumInjection || 0) < 0.01) {
    const _filterTarget = Math.max(150, Math.min(3000, targetFilter));
    if (Math.abs(_filterTarget - vp.proxFilter.frequency.value) > 1) {
      const _now = Tone.now();
      vp.proxFilter.frequency.cancelScheduledValues(_now);
      vp.proxFilter.frequency.setTargetAtTime(_filterTarget, _now, 0.02);
    }
  }

  // Combined reverb: X proximity + Y window
  const yReverbOffset = yWindow * 0.15;         // up = wetter (+0.06), down = drier (-0.18)
  const targetReverb = reverbWetMax + (reverbWetMin - reverbWetMax) * rate + yReverbOffset;
  vp.reverb.wet.value = Math.max(0.05, Math.min(0.7, targetReverb));

  // Y → FM depth offset (richer harmonics when window opens)
  const yFmOffset = yWindow * 0.5;              // up = +0.2 mod index, down = -0.6
  // (applied below in the FM drift section)
  vp._yFmOffset = yFmOffset;

  // Y → overtone bus level (more voices audible when window opens)
  const yOvertoneScale = 1 + yWindow * 0.5;     // ×0.4 (closed) to ×1.2 (open)
  // (applied below in the per-overtone loop)
  vp._yOvertoneScale = Math.max(0.1, yOvertoneScale);

  // Y → delay wet (more reflections when window opens)
  const yDelayWet = 0.2 + yWindow * 0.12;       // 0.06 (closed) to 0.25 (open)
  const _delayWetTarget = Math.max(0, Math.min(0.5, yDelayWet));
  if (Math.abs(_delayWetTarget - vp.delay.wet.value) > 0.001) {
    const _now = Tone.now();
    vp.delay.wet.cancelScheduledValues(_now);
    vp.delay.wet.setTargetAtTime(_delayWetTarget, _now, 0.02);
  }

  // Y → ambient bleed (more room tone when window opens)
  // Only set from Y-axis when not strumming — strum takes control of bleed.
  // Ramp to smooth out the first-activation discontinuity (see lowPadGain note).
  // This path feeds the FDN reverb directly, so a raw step is especially audible.
  const yBleed = 0.3 + yWindow * 0.15;           // 0.12 (closed) to 0.36 (open)
  if ((vp.strumInjection || 0) < 0.01) {
    const _bleedTarget = Math.max(0, Math.min(0.2, yBleed));
    if (Math.abs(_bleedTarget - vp.bleed.gain.value) > 0.001) {
      const _now = Tone.now();
      vp.bleed.gain.cancelScheduledValues(_now);
      vp.bleed.gain.setTargetAtTime(_bleedTarget, _now, 0.02);
    }
  }

  // ── Strum: boost bleed + open proximity filter briefly ──
  // Pressing hand against the glass — interior brightens for a moment, then darkens back.
  if (vp.strumInjection > 0.001) {
    vp.strumInjection *= Math.exp(-2.5 * dt);
    if (vp.strumInjection < 0.001) vp.strumInjection = 0;
    // Gentle mix boost: just enough to feel, not a volume spike
    vp.mix.gain.value = 2.0 + vp.strumInjection * 0.4;  // 2.0→2.4 (+1.6dB, was +5dB)
    // Bleed boost: bypass path for presence between LFO cycles
    const normalBleed = Math.max(0, Math.min(0.5, yBleed));
    vp.bleed.gain.value = normalBleed + vp.strumInjection * (0.5 - normalBleed);
    // Filter bloom: the main strum impact — brightness change, not volume change
    // Opens proximity filter dramatically (+1500Hz at peak) so the timbre shifts
    const strumFilterBoost = vp.strumInjection * 1500;
    vp.proxFilter.frequency.value = Math.min(4000, targetFilter + strumFilterBoost);
  } else {
    vp.mix.gain.value = 2.0;
  }

  // ── Hold-duration evolution (doesn't touch LFO rate) ──
  // params.filter  (0→1 over 7s):  FM depth ceiling — timbre richness
  // params.secondary (0→1 from 3s): overtone level — voices emerge
  // params.width   (0→1 from 1s):  low pad presence — foundation grows
  // params.lfo     (0→1 from 7s):  effects depth — space develops
  const evo = params || { filter: 0.5, secondary: 0.3, width: 0.3, lfo: 0 };

  // Low pad grows with hold — foundation becomes felt (subtle, not dominant).
  // Ramp rather than instant set: the FM pads are pre-triggered and sustaining
  // from init, so a raw .value assignment on activation creates a step in the
  // output and produces an audible click at the FDN reverb input (~-18 dBFS
  // peak in process call #1). setTargetAtTime with a short tau smooths it.
  const _lowPadTarget = 0.1 + (evo.width || 0) * 0.25;
  if (Math.abs(_lowPadTarget - vp.lowPadGain.gain.value) > 0.001) {
    const _now = Tone.now();
    vp.lowPadGain.gain.cancelScheduledValues(_now);
    vp.lowPadGain.gain.setTargetAtTime(_lowPadTarget, _now, 0.02);
  }

  // Per-overtone independent breathing (prime-number periods)
  // Overtone ceiling scales with evolution — voices emerge over time
  const overtoneMax = 0.03 + (evo.secondary || 0) * 0.15;
  const depth = VP_OVERTONE_BREATHE_DEPTH;
  const floor = 1 - depth;
  const yOS = vp._yOvertoneScale || 1;
  for (let i = 0; i < vp.overtonePhases.length; i++) {
    vp.overtonePhases[i] += dt / VP_OVERTONE_LFO_RATES[i];
    if (vp.overtonePhases[i] > 1) vp.overtonePhases[i] -= 1;
    const breath = Math.pow(Math.sin(vp.overtonePhases[i] * Math.PI), 2);
    const gain = floor + depth * breath;
    const finalGain = gain * overtoneMax * yOS;

    if (vp.useWorklet) {
      vp._workletGainBuf[i] = finalGain;
    } else {
      vp.overtoneGains[i].gain.value = finalGain;
    }
  }
  // Send batched gains to worklet once per frame
  if (vp.useWorklet && vp.workletNode) {
    postWorkletGains(vp.workletNode, vp._workletGainBuf);
  }

  // FM depth drift — ceiling scales with evolution (richer over time)
  // Short hold: drifts 0.3→0.6 (simple, dark)
  // Long hold: drifts 0.4→1.5 (rich, complex)
  const evoFm = evo.filter || 0.5;
  const fmCeiling = VP_FM_DRIFT_MIN + (VP_FM_DRIFT_MAX - VP_FM_DRIFT_MIN) * evoFm;
  const fmFloor = VP_FM_DRIFT_MIN * (0.7 + evoFm * 0.3);
  vp.fmDriftPhase += dt / VP_FM_DRIFT_PERIOD;
  if (vp.fmDriftPhase > 1) vp.fmDriftPhase -= 1;
  const fmBreath = Math.pow(Math.sin(vp.fmDriftPhase * Math.PI), 2);
  const fmBase = fmFloor + (fmCeiling - fmFloor) * fmBreath;
  const fmMod = Math.max(0.1, fmBase + (vp._yFmOffset || 0));
  vp.pad.set({ modulationIndex: fmMod });
  vp.lowPad.set({ modulationIndex: Math.max(0.1, fmMod * 0.75) });

  // Effects deepen with hold — space develops around the village.
  // Ramp to smooth out the first-activation discontinuity (see lowPadGain note).
  const evoLfo = evo.lfo || 0;
  const _phaserWetTarget = Math.max(0, Math.min(0.4, 0.05 + evoLfo * 0.2));
  if (Math.abs(_phaserWetTarget - vp.phaser.wet.value) > 0.001) {
    const _now = Tone.now();
    vp.phaser.wet.cancelScheduledValues(_now);
    vp.phaser.wet.setTargetAtTime(_phaserWetTarget, _now, 0.02);
  }

}

// ── Performance instrumentation ──────────────────────────────────────────────
// Enable: window._perfAudit = true   (in console)
// Read:   window._perfStats()        (snapshot)
// Reset:  window._perfReset()

const _perf = {
  evolTick: 0, evolTickCount: 0,
  applyParams: 0, applyParamsCount: 0,
  toneWrites: 0, toneWritesFrame: 0,
  allocEntries: 0, allocEvolution: 0, allocAssign: 0,
  _lastLog: 0, _logInterval: 120,  // frames between logs
};

function _perfToneWrite() {
  if (window._perfAudit) _perf.toneWritesFrame++;
}

window._perfStats = () => {
  const n = _perf.evolTickCount || 1;
  const ap = _perf.applyParamsCount || 1;
  return {
    evolTickAvgMs:    (_perf.evolTick / n).toFixed(3),
    applyParamsAvgMs: (_perf.applyParams / ap).toFixed(3),
    toneWritesPerFrame: (_perf.toneWrites / n).toFixed(1),
    allocsPerFrame: {
      objectEntries: (_perf.allocEntries / n).toFixed(1),
      getEvolution:  (_perf.allocEvolution / n).toFixed(1),
      objectAssign:  (_perf.allocAssign / n).toFixed(1),
    },
    frames: n,
  };
};

window._perfReset = () => {
  _perf.evolTick = 0; _perf.evolTickCount = 0;
  _perf.applyParams = 0; _perf.applyParamsCount = 0;
  _perf.toneWrites = 0; _perf.toneWritesFrame = 0;
  _perf.allocEntries = 0; _perf.allocEvolution = 0; _perf.allocAssign = 0;
  _perf._lastLog = 0;
  _log('%c[Perf]%c  Counters reset', 'color: #f80; font-weight: bold', 'color: #999');
};

// ── Evolution loop ───────────────────────────────────────────────────────────

const LOOP_SMOOTH = 0.02;  // interpolation rate per frame (~3s settling at 60fps)

function applyParams(r, id, params, dt) {
  const _t0 = window._perfAudit ? performance.now() : 0;
  const voice = VOICES[id];

  // ── Mouse expression offset ──
  const me = r.mouseExpr;
  let filterExprNorm = 0;   // normalized filter param offset (applied before log mapping)
  let reverbExtraGain = 0;
  if (me) {
    filterExprNorm = me.filterOffset + me.capturedFilter;
    reverbExtraGain = me.reverbOffset + me.capturedReverbOffset;
  }

  // Filter: apply mouse expression + attack transient + duck offset in parameter
  // space (before log mapping), so darkening works even at low filter states.
  // Allows going slightly below filterClosed (−0.3) for sub-bass darkening and
  // above filterOpen (+1.3) for brightness.  Transient rides on top and decays
  // in evolutionTick.  Duck is a negative offset from other-region interaction.
  const transientOffset = r.filterTransient ? r.filterTransient.offset : 0;
  const duckFilterOffset = r.duck ? r.duck.filterCurrent : 0;
  // Night Sky Y-axis filter: drag-down closes filter for timbral darkening
  const nsFilterOffset = (id == 3 && r.nightSky && r.nightSky.active) ? r.nightSky.yFilterOffset : 0;
  const adjustedFilter = Math.max(-0.3, Math.min(1.3, params.filter + filterExprNorm + transientOffset + duckFilterOffset + nsFilterOffset));
  const freq = voice.filterClosed * Math.pow(
    voice.filterOpen / voice.filterClosed, adjustedFilter
  );
  // Night Sky: disable base region LFO filter sweep (Night Sky has its own FX chain)
  const nsLfoScale = (id == 3 && r.nightSky && r.nightSky.active) ? 0 : 1.0;
  const lfoMod = params.lfo * voice.lfoDepth * nsLfoScale *
    Math.sin(Tone.now() * voice.lfoRate * Math.PI * 2);

  // Gain compensation for expression darkening:
  // During the building ramp, the evolution continuously pushes filter + gain upward,
  // counteracting downward expression offsets. The filter barely moves and gain keeps
  // rising, making drag-down imperceptible. Compensate with gain attenuation keyed to
  // the raw expression offset (filterExprNorm) so drag-down always produces an audible
  // darkening effect regardless of evolution state.
  let exprGainScale = 1.0;
  if (me && filterExprNorm < 0) {
    // Linear ramp: offset 0 → scale 1.0, offset -0.5 → scale 0.25 (floor)
    exprGainScale = Math.max(0.25, 1 + filterExprNorm * 1.5);
  }

  // Dirty-flag optimization: only call Tone.js when computed value has changed
  // beyond a perceptual threshold. Keeps cancelAndHoldAtTime + setTargetAtTime
  // (smooth exponential ramps) for audio timeline consistency — needed for clean
  // rampTo() transitions on stop. The big win is skipping unchanged writes (87%
  // fewer calls in steady-state looping), not the write mechanism itself.
  const tau = 0.015;  // 15ms time constant — 95% settling in ~45ms
  // Lazy Tone.now(): only call if we actually need to write
  let _now = 0, _nowValid = false;
  function getNow() { if (!_nowValid) { _now = Tone.now(); _nowValid = true; } return _now; }

  // Initialize dirty-flag cache on first call (no cancelScheduledValues —
  // cancelAndHoldAtTime in each write handles cancellation naturally)
  if (!r._prev) r._prev = { freq: -1, gain: -1, secondary: -1, reverb: -1, chorus: -1, modIndex: -1 };
  const prev = r._prev;

  const filterCeil = voice.filterOpen * 1.5;
  let finalFreq = Math.max(20, Math.min(filterCeil, freq + lfoMod));
  // Living Wood needs mid-range harmonics to translate on small speakers.
  // Floor the filter at 800 Hz so FM partials always pass through,
  // while still allowing expression/duck to darken below that.
  if (r.livingWood && r.livingWood.active) {
    // Portato: gentle filter brightening at pulse peaks (bow sinks deeper into string)
    if (r.livingWood.portatoPhase !== undefined) {
      const filterPulse = Math.pow(Math.sin(r.livingWood.portatoPhase * 0.5), 2);
      finalFreq *= (1.0 + 0.25 * filterPulse);
    }
    // Y-axis brightness/energy filter
    const yFM = r.livingWood.yFilterMul !== undefined ? r.livingWood.yFilterMul : 1.0;
    finalFreq *= yFM;
    // Adaptive floor: 800 Hz at rest, lowers to 500 Hz when Y drags dark
    const filterFloor = 500 + 300 * Math.min(1, Math.max(0, yFM));
    finalFreq = Math.max(filterFloor, finalFreq);
  }
  // Mode-scaled filter bias — Radiant opens cutoffs ~20% to support brighter
  // major character ("open strings / sul ponticello" orchestration analog).
  // Applied after all per-region filter adjustments so it's a uniform final
  // shift. Evolution tick's setTargetAtTime(tau=15ms) smooths the mode step.
  finalFreq *= _modeFilterMul;
  // Filter: ~1 Hz threshold (inaudible at any frequency)
  if (Math.abs(finalFreq - prev.freq) > 1.0) {
    const now = getNow();
    r.filter.frequency.cancelAndHoldAtTime(now);
    r.filter.frequency.setTargetAtTime(finalFreq, now, tau); _perfToneWrite();
    prev.freq = finalFreq;
  }

  const duckGainMul = r.duck ? r.duck.gainCurrent : 1.0;
  // During fade-out ('stopping'), don't override mainGain — let the rampTo(0) work.
  // Otherwise the per-frame setTargetAtTime fights the ramp, and when lw.active flips
  // to false at the end, mainGain jumps to a non-zero value causing an audible blip.
  if (r.state !== 'stopping') {
    // Living Wood has its own velocity-driven gain staging — bypass evolution gain
    // to avoid double-gating (params.gain applied in both padLevel AND mainGain).
    // Keep duck and expression scaling so inter-region interaction still works.
    const isLW = (r.livingWood && r.livingWood.active);
    const isNSActive = (id == 3 && r.nightSky && r.nightSky.active);
    const lwYGain = isLW && r.livingWood.yGainScale !== undefined ? r.livingWood.yGainScale : 1.0;
    const isWHActive = (id == 4 && r.windHarp && r.windHarp.active);
    // `_modeGainMul` injects the Radiant +3 dB region-wide bias here, not via
    // a rampTo on mainGain.gain — evolution tick overwrites mainGain every
    // frame, so a rampTo would be blown away within 16 ms. Multiplying inside
    // applyParams lets the existing setTargetAtTime(tau=15ms) smooth the
    // mode-change transition naturally.
    const mainGainLevel = _modeGainMul * (isLW
      ? 0.85 * duckGainMul * lwYGain                // near-unity, let LW control its own dynamics; Y dims overall
      : isNSActive
      ? r.nightSky.userParams.baseGain * duckGainMul  // Night Sky: fixed passthrough, no evolution pump
      : isWHActive
      ? 0.55 * duckGainMul                           // Wind Harp: fixed passthrough — evolution drop buried it at loopGain 0.35
      : params.gain * exprGainScale * duckGainMul);
    // Gain: 0.001 threshold (~0.1% = -60dB, inaudible)
    if (Math.abs(mainGainLevel - prev.gain) > 0.001) {
      const now = getNow();
      r.mainGain.gain.cancelAndHoldAtTime(now);
      r.mainGain.gain.setTargetAtTime(mainGainLevel, now, tau); _perfToneWrite();
      prev.gain = mainGainLevel;
    }
  }
  // Secondary: FM depth (all regions) — params.secondary drives modulation index
  if (voice.fmModMax) {
    // FM-depth voice: params.secondary drives modulation index
    const targetMod = voice.fmModMin + params.secondary * (voice.fmModMax - voice.fmModMin);
    // ModIndex: 0.001 threshold
    if (Math.abs(targetMod - prev.modIndex) > 0.001) {
      r.primarySynth.set({ modulationIndex: targetMod });
      prev.modIndex = targetMod;
      _perfToneWrite();
    }
    // secondaryGain stays at 0 — secondary synth is silent for FM voices
  } else {
    const secGain = params.secondary * exprGainScale;
    if (Math.abs(secGain - prev.secondary) > 0.001) {
      const now = getNow();
      r.secondaryGain.gain.cancelAndHoldAtTime(now);
      r.secondaryGain.gain.setTargetAtTime(secGain, now, tau); _perfToneWrite();
      prev.secondary = secGain;
    }
  }

  // Deep reverb: base + mouse expression offset
  const baseDeepReverb = params.deepReverb * 0.5;
  const finalDeepReverb = Math.max(0, Math.min(0.8, baseDeepReverb + reverbExtraGain));
  r._cachedReverb = finalDeepReverb;
  if (Math.abs(finalDeepReverb - prev.reverb) > 0.001) {
    const now = getNow();
    r.deepSend.gain.cancelAndHoldAtTime(now);
    r.deepSend.gain.setTargetAtTime(finalDeepReverb, now, tau); _perfToneWrite();
    prev.reverb = finalDeepReverb;
  }

  // Chorus wet: evolution base width + mouse expression offset
  if (r.chorus) {
    const baseWidth = params.width * (voice.widthMax || 0);
    let exprOffset = 0;
    if (me) exprOffset = me.chorusWet + me.capturedChorusWet;
    const finalChorus = Math.max(0, Math.min(1.0, baseWidth + exprOffset));
    r._cachedChorus = finalChorus;
    // Lazy-start chorus LFO on first non-zero wet (deferred from preBuildAudioNodes
    // to avoid 5 idle LFO oscillators consuming Chrome's render budget).
    if (finalChorus > 0 && !r._chorusStarted) {
      try { r.chorus.start(); } catch (e) { /* already started */ }
      r._chorusStarted = true;
    }
    if (Math.abs(finalChorus - prev.chorus) > 0.001) {
      const now = getNow();
      r.chorus.wet.cancelAndHoldAtTime(now);
      r.chorus.wet.setTargetAtTime(finalChorus, now, 0.03); _perfToneWrite();
      prev.chorus = finalChorus;
    }

  }

  // Wind harp V3: per-frame updates for harp-specific nodes
  if (id == 4 && r.windHarp && r.windHarp.active) {
    applyWindHarpV3Params(r, params, dt);
  }

  // Living Wood: per-frame updates for cypress-specific nodes
  if (id == 1 && r.livingWood && r.livingWood.active) {
    applyCypressLivingWoodParams(r, params, dt);
  }

  // Celestial Strings: per-frame updates for stars-specific nodes
  if (id == 5 && r.celestialStrings && r.celestialStrings.active) {
    applyCelestialStringsParams(r, params, dt);
  }

  // Village Pulse: rhythmic note scheduler
  if (id == 2 && r.villagePulse && r.villagePulse.active) {
    applyVillagePulse(r, params, dt);
  }

  // Night Sky: per-frame updates for sky-specific nodes
  if (id == 3 && r.nightSky && r.nightSky.active) {
    applyNightSkyParams(r, params, dt);
  }

  if (window._perfAudit) { _perf.applyParams += performance.now() - _t0; _perf.applyParamsCount++; }
}

// ── Freeze-to-buffer system ─────────────────────────────────────────────────
// Captures idle region output into a looping AudioBuffer, then disconnects
// the live synthesis chain to free render capacity.

function _prepareLoopBuffer(rawBuffer, sampleRate) {
  // Apply cosine crossfade at loop boundaries to prevent clicks.
  // Blend the first N samples with the last N samples.
  const fadeSamples = Math.round(FREEZE_CROSSFADE_SEC * sampleRate);
  const len = rawBuffer.length;
  if (fadeSamples * 2 >= len) return rawBuffer;  // buffer too short for crossfade

  const result = new Float32Array(len);
  result.set(rawBuffer);

  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples;  // 0 → 1
    // Cosine crossfade: equal-power
    const fadeIn = Math.sin(t * Math.PI * 0.5);
    const fadeOut = Math.cos(t * Math.PI * 0.5);
    // Blend start with end
    result[i] = rawBuffer[i] * fadeIn + rawBuffer[len - fadeSamples + i] * fadeOut;
  }

  // Trim the loop to exclude the crossfade tail (it's baked into the start)
  return result.slice(0, len - fadeSamples);
}

// Generic freeze functions — work for any region's special voice system.
// Each takes a freezeConfig: { state, regionId, limiterField, mixBusField, mixBusGain,
//   noiseSources[], name }

function _startFreezeCapture(voiceState, cfg) {
  if (voiceState.freezeState !== 'live' || !_freezeTapReady) return;

  // Create tap lazily on first capture
  if (!voiceState.freezeTap) {
    const rawCtx = Tone.context.rawContext;
    const nativeCtx = rawCtx._nativeAudioContext || rawCtx._nativeContext || rawCtx;
    try {
      const tap = new AudioWorkletNode(nativeCtx, 'freeze-tap-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sampleRate: nativeCtx.sampleRate || 22050 },
      });
      const bridge = new Tone.Gain(1);
      voiceState[cfg.limiterField].connect(bridge);
      _nativeNode(bridge).connect(tap);
      voiceState.freezeTap = tap;
      voiceState._freezeBridge = bridge;
      _log(`%c[Freeze]%c  ${cfg.name} tap created`, 'color: #6cf; font-weight: bold', 'color: #999');
    } catch (e) {
      console.warn(`[Freeze]  Failed to create ${cfg.name} tap:`, e.message);
      return;
    }
  } else {
    try { voiceState[cfg.limiterField].connect(voiceState._freezeBridge); } catch (e) {}
  }

  voiceState.freezeState = 'capturing';
  voiceState.freezeTap.port.onmessage = (e) => {
    if (e.data.type === 'captureComplete') {
      _onFreezeComplete(voiceState, cfg, e.data.buffer, e.data.sampleRate);
    }
  };
  voiceState.freezeTap.port.postMessage({ type: 'startCapture', duration: FREEZE_CAPTURE_DURATION });
  _log(`%c[Freeze]%c  ${cfg.name} capture started (${FREEZE_CAPTURE_DURATION}s)`, 'color: #6cf; font-weight: bold', 'color: #999');
}

function _onFreezeComplete(voiceState, cfg, rawBuffer, captureSampleRate) {
  if (voiceState.freezeState !== 'capturing') return;
  // Guard: if region stopped/deactivated during capture, abort — don't create frozen
  // nodes on a disconnected chain. The capture callback can arrive after deactivation
  // if the worklet message was in-flight when the abort was sent.
  const r = regions[cfg.regionId];
  if (!r || r.state === 'off' || r.state === 'stopping') {
    voiceState.freezeState = 'live';
    voiceState.freezeIdleTime = 0;
    return;
  }

  let maxAmp = 0, nonZero = 0;
  for (let i = 0; i < rawBuffer.length; i++) {
    const abs = Math.abs(rawBuffer[i]);
    if (abs > maxAmp) maxAmp = abs;
    if (abs > 0.0001) nonZero++;
  }
  _log(
    `%c[Freeze]%c  ${cfg.name} capture: ${rawBuffer.length} samples, peak=${maxAmp.toFixed(6)}, nonZero=${(nonZero/rawBuffer.length*100).toFixed(1)}%`,
    'color: #6cf; font-weight: bold', 'color: #999'
  );

  const loopBuffer = _prepareLoopBuffer(rawBuffer, captureSampleRate);
  const rawCtx = Tone.context.rawContext;
  const nativeCtx = rawCtx._nativeAudioContext || rawCtx._nativeContext || rawCtx;
  const audioBuffer = nativeCtx.createBuffer(1, loopBuffer.length, captureSampleRate);
  audioBuffer.getChannelData(0).set(loopBuffer);

  const toneBuffer = new Tone.ToneAudioBuffer(audioBuffer);
  const player = new Tone.Player(toneBuffer);
  player.loop = true;
  const frozenGain = new Tone.Gain(0);
  player.connect(frozenGain);
  frozenGain.connect(regions[cfg.regionId].mainGain);
  player.start();

  voiceState.frozenSource = player;
  voiceState.frozenGain = frozenGain;

  // Equal-power crossfade
  const now = Tone.now();
  const fadeDuration = 2.0;
  const curveLen = 64;
  const fadeInCurve = new Float32Array(curveLen);
  const fadeOutCurve = new Float32Array(curveLen);
  const mixBus = voiceState[cfg.mixBusField];
  const liveMixBusValue = mixBus.gain.value || cfg.mixBusGain;
  for (let i = 0; i < curveLen; i++) {
    const t = i / (curveLen - 1);
    fadeInCurve[i] = Math.sin(t * Math.PI * 0.5);
    fadeOutCurve[i] = Math.cos(t * Math.PI * 0.5) * liveMixBusValue;
  }
  frozenGain.gain.cancelScheduledValues(now);
  frozenGain.gain.setValueAtTime(0, now);
  frozenGain.gain.setValueCurveAtTime(fadeInCurve, now, fadeDuration);
  mixBus.gain.cancelScheduledValues(now);
  mixBus.gain.setValueCurveAtTime(fadeOutCurve, now, fadeDuration);

  setTimeout(() => {
    if (voiceState.freezeState !== 'capturing') return;
    voiceState.freezeState = 'frozen';

    const r = regions[cfg.regionId];
    try { _nativeNode(voiceState[cfg.limiterField]).disconnect(_nativeNode(r.filter)); } catch (e) {
      try { voiceState[cfg.limiterField].disconnect(r.filter); } catch (e2) {}
    }
    if (voiceState._freezeBridge) {
      try { voiceState[cfg.limiterField].disconnect(voiceState._freezeBridge); } catch (e) {}
    }
    // Stop noise sources
    for (const ns of cfg.noiseSources) {
      try { voiceState[ns].stop(); } catch (e) {}
    }
    if (voiceState.useWorklet && voiceState.workletNode) {
      voiceState.workletNode.port.postMessage({ type: 'deactivate' });
    }
    _log(`%c[Freeze]%c  ${cfg.name} FROZEN — live chain disconnected`, 'color: #6cf; font-weight: bold', 'color: #999');
  }, fadeDuration * 1000 + 100);
}

function _thawRegion(r, voiceState, cfg) {
  if (!voiceState || voiceState.freezeState !== 'frozen') return;
  voiceState.freezeState = 'thawing';

  const now = Tone.now();
  const fadeDuration = 2.5;

  // Reconnect limiter → r.filter
  try { _nativeNode(voiceState[cfg.limiterField]).connect(_nativeNode(r.filter)); } catch (e) {
    try { voiceState[cfg.limiterField].connect(r.filter); } catch (e2) {}
  }

  // Restart noise sources
  for (const ns of cfg.noiseSources) {
    try {
      if (voiceState[ns].state !== 'started') voiceState[ns].start();
    } catch (e) {
      // Tone.LFO/Oscillator can't restart after stop — recreate if needed
      if (ns === 'lfo' && cfg.regionId === 2 && voiceState.gain) {
        voiceState.lfo.dispose();
        voiceState.lfo = new Tone.LFO({ frequency: VP_LFO_MIN_RATE, min: 0, max: 1, type: 'sine' });
        voiceState.lfo.connect(voiceState.gain.gain);
        voiceState.lfo.start();
      }
    }
  }
  if (voiceState.useWorklet && voiceState.workletNode) {
    voiceState.workletNode.port.postMessage({ type: 'activate' });
  }

  // Equal-power crossfade: thaw
  const curveLen = 64;
  const thawInCurve = new Float32Array(curveLen);
  const thawOutCurve = new Float32Array(curveLen);
  for (let i = 0; i < curveLen; i++) {
    const t = i / (curveLen - 1);
    thawInCurve[i] = Math.sin(t * Math.PI * 0.5) * cfg.mixBusGain;
    thawOutCurve[i] = Math.cos(t * Math.PI * 0.5);
  }
  voiceState[cfg.mixBusField].gain.cancelScheduledValues(now);
  voiceState[cfg.mixBusField].gain.setValueCurveAtTime(thawInCurve, now, fadeDuration);
  if (voiceState.frozenGain) {
    voiceState.frozenGain.gain.cancelScheduledValues(now);
    voiceState.frozenGain.gain.setValueCurveAtTime(thawOutCurve, now, fadeDuration);
  }

  setTimeout(() => {
    voiceState.freezeState = 'live';
    voiceState.freezeIdleTime = 0;
    if (voiceState.frozenSource) {
      try { voiceState.frozenSource.stop(); } catch (e) {}
      try { voiceState.frozenSource.disconnect(); } catch (e) {}
      try { voiceState.frozenSource.dispose(); } catch (e) {}
      voiceState.frozenSource = null;
    }
    if (voiceState.frozenGain) {
      try { voiceState.frozenGain.disconnect(); } catch (e) {}
      try { voiceState.frozenGain.dispose(); } catch (e) {}
      voiceState.frozenGain = null;
    }
    _log(`%c[Freeze]%c  ${cfg.name} THAWED`, 'color: #6cf; font-weight: bold', 'color: #999');
  }, fadeDuration * 1000 + 100);
}

function _abortFreezeCapture(voiceState, name) {
  if (voiceState.freezeState === 'capturing' && voiceState.freezeTap) {
    voiceState.freezeTap.port.postMessage({ type: 'abortCapture' });
    voiceState.freezeState = 'live';
    voiceState.freezeIdleTime = 0;
    if (window._regionSynthDebug) _log(
      `%c[Freeze]%c  ${name || 'Region'} capture aborted`,
      'color: #6cf; font-weight: bold', 'color: #999'
    );
  }
}

// Freeze configs per region
const FREEZE_CFG = {
  1: { regionId: 1, limiterField: 'limiter', mixBusField: 'cypressMixBus', mixBusGain: 2.5, noiseSources: ['brownNoise'], name: 'Cypress' },
  2: { regionId: 2, limiterField: 'limiter', mixBusField: 'mix', mixBusGain: 2.0, noiseSources: ['roomNoise', 'lfo', 'tremolo'], name: 'Village Pulse' },
  3: { regionId: 3, limiterField: 'limiter', mixBusField: 'mixBus', mixBusGain: 0.85, noiseSources: ['deepNoise', 'windNoise', 'airNoise'], name: 'Night Sky' },
  4: { regionId: 4, limiterField: 'harpLimiter', mixBusField: 'harpMixBus', mixBusGain: 1.0, noiseSources: ['pinkNoise', 'brownNoise', 'autoFilter'], name: 'Wind Harp' },
  5: { regionId: 5, limiterField: 'limiter', mixBusField: 'starsMixBus', mixBusGain: 1.0, noiseSources: ['whiteNoise'], name: 'Celestial Strings' },
};

function evolutionTick() {
  const _t0 = window._perfAudit ? performance.now() : 0;
  if (window._perfAudit) { _perf.toneWritesFrame = 0; }
  let anyActive = false;
  const tickNow = Tone.now();  // cache once per frame (fix #5)

  for (const id in regions) { const r = regions[id];
    // ── Filter transient decay (all active states) ──
    // Exponential: offset *= decayPerFrame each frame, reaches ~5% in decayMs
    const ftr = r.filterTransient;
    if (ftr && ftr.offset > 0.001) {
      ftr.offset *= ftr.decayPerFrame;
      if (ftr.offset < 0.001) ftr.offset = 0;
    }

    // ── Inter-region duck smoothing ──
    // Gain and filter duck offsets smooth toward their targets each frame.
    // Onset (ducking down) uses a fast rate; recovery uses a slower rate.
    // Strum recovery uses an intermediate rate.
    const dk = r.duck;
    if (dk) {
      // Gain duck smoothing
      const gDiff = dk.gainTarget - dk.gainCurrent;
      if (Math.abs(gDiff) > 0.001) {
        const gRate = gDiff < 0 ? DUCK_ONSET_RATE
          : (dk.strumRecovery ? DUCK_STRUM_RECOVERY_RATE : DUCK_RECOVERY_RATE);
        dk.gainCurrent += gDiff * gRate;
      } else {
        dk.gainCurrent = dk.gainTarget;
      }

      // Filter duck smoothing
      const fDiff = dk.filterTarget - dk.filterCurrent;
      if (Math.abs(fDiff) > 0.001) {
        const fRate = fDiff < 0 ? DUCK_ONSET_RATE
          : (dk.strumRecovery ? DUCK_STRUM_RECOVERY_RATE : DUCK_RECOVERY_RATE);
        dk.filterCurrent += fDiff * fRate;
      } else {
        dk.filterCurrent = dk.filterTarget;
      }
    }

    if (r.state === 'building') {
      anyActive = true;
      const dt = tickNow - r.lastTickTime;
      r.lastTickTime = tickNow;

      // Damp evolution when dragging down — slow the ramp so it doesn't fight the drag
      const me = r.mouseExpr;
      let filterExprNorm = 0;
      if (me) filterExprNorm = me.filterOffset + me.capturedFilter;

      // At filterExprNorm = -0.5 (full drag-down): factor = 0.5 (half speed).
      // Floor 0.05 prevents freeze. Positive expression does NOT accelerate.
      const dampFactor = filterExprNorm < 0
        ? Math.max(0.05, 1 + filterExprNorm)
        : 1.0;

      r.effectiveBuildTime += dt * dampFactor;

      getEvolution(r.effectiveBuildTime, VOICES[id], r.currentParams);
      applyParams(r, id, r.currentParams, dt);

    } else if ((r.state === 'looping' || r.state === 'reshaping') && r.loopTarget) {
      anyActive = true;
      const dt = tickNow - r.lastTickTime;
      r.lastTickTime = tickNow;
      const voice = VOICES[id];
      const rs = voice.reshape;

      // ── Hover evolution flag: computed once, used for both energy and targets ──
      // Snapshot effectiveBuildTime at hover start to detect skipped builds (Stars).
      // Stars skip building (effectiveBuildTime=15 immediately), so their loopTarget
      // is already at full complexity — evolution would amplify them 3-8× beyond intent.
      const me = r.mouseExpr;
      const _hoverEngaged = r.state === 'looping' && me && me.active && me.hoverMode;
      if (_hoverEngaged && r._hoverStartBuildTime === undefined) {
        r._hoverStartBuildTime = r.effectiveBuildTime || 0;
      } else if (!_hoverEngaged) {
        r._hoverStartBuildTime = undefined;
      }
      const _useHoverEvolution = _hoverEngaged && (r._hoverStartBuildTime || 0) < 14;

      // Energy: rises during reshaping hold, decays during idle looping.
      // Frozen when hover evolution is active (short-build regions) — evolution drives targets instead.
      if (rs) {
        if (r.state === 'reshaping') {
          r.energy = Math.min(1.0, r.energy + rs.energyRise);
        } else if (r.energy > 0 && !_useHoverEvolution) {
          r.energy *= (1 - rs.energyDecay);
          if (r.energy < 0.001) r.energy = 0;
        }
      }

      // Mouse expression captured offset decay (frame-rate-independent)
      // k=0.18 gives ~15-20s drift-back (matches old 0.003/frame at 60fps)
      if (me && !me.active) {
        const df = Math.exp(-0.18 * dt);
        me.capturedFilter       = decayValue(me.capturedFilter, df);
        me.capturedChorusWet    = decayValue(me.capturedChorusWet, df);
        me.capturedReverbOffset = decayValue(me.capturedReverbOffset, df);
        me.capturedV3SpaceMacro = decayValue(me.capturedV3SpaceMacro, df);
        me.capturedCsSpaceMacro = decayValue(me.capturedCsSpaceMacro, df);
        me.capturedLwBowPosition = decayValue(me.capturedLwBowPosition, df);
        me.capturedLwRootDepth   = decayValue(me.capturedLwRootDepth, df);
        me.capturedVhWindowFocus = decayValue(me.capturedVhWindowFocus, df);
        me.capturedVhXFilter     = decayValue(me.capturedVhXFilter, df);
      }

      // Effective target: either evolution (hover) or loopTarget+energy (normal)
      const p = r.currentParams;
      let effFilter, effGain, effSecondary, effDeepReverb, effLfo, effWidth;

      if (_useHoverEvolution) {
        // Hover expression: continue building evolution — same curve as click-and-hold
        // Don't advance while frozen — prevents param jump on thaw
        const _voiceFrozen = (id == 1 ? r.livingWood : id == 2 ? r.villagePulse : id == 4 ? r.windHarp : id == 5 ? r.celestialStrings : null)?.freezeState === 'frozen';
        if (!_voiceFrozen) r.effectiveBuildTime = (r.effectiveBuildTime || 0) + dt;
        if (!r._hoverEvo) r._hoverEvo = {};
        getEvolution(r.effectiveBuildTime, voice, r._hoverEvo);
        effFilter     = r._hoverEvo.filter;
        effGain       = r._hoverEvo.gain;
        effSecondary  = r._hoverEvo.secondary;
        effDeepReverb = r._hoverEvo.deepReverb;
        effLfo        = r._hoverEvo.lfo;
        effWidth      = r._hoverEvo.width;
      } else {
        // Normal: loopTarget interpolated toward ceiling by energy
        const e = r.energy || 0;
        const ec = rs ? rs.ceiling : null;
        const t = r.loopTarget;
        effFilter     = ec ? t.filter     + e * (ec.filter     - t.filter)     : t.filter;
        effGain       = ec ? t.gain       + e * (ec.gain       - t.gain)       : t.gain;
        effSecondary  = ec ? t.secondary  + e * (ec.secondary  - t.secondary)  : t.secondary;
        effDeepReverb = ec ? t.deepReverb + e * (ec.deepReverb - t.deepReverb) : t.deepReverb;
        effLfo        = ec ? t.lfo        + e * (ec.lfo        - t.lfo)        : t.lfo;
        effWidth      = ec ? t.width      + e * (ec.width      - t.width)      : t.width;
      }

      p.filter     += (effFilter     - p.filter)     * LOOP_SMOOTH;
      p.gain       += (effGain       - p.gain)       * LOOP_SMOOTH;
      p.secondary  += (effSecondary  - p.secondary)  * LOOP_SMOOTH;
      p.deepReverb += (effDeepReverb - p.deepReverb) * LOOP_SMOOTH;
      p.lfo        += (effLfo        - p.lfo)        * LOOP_SMOOTH;
      p.width      += (effWidth      - p.width)      * LOOP_SMOOTH;
      applyParams(r, id, p, dt);

      // ── Freeze-to-buffer: idle timer for special voice regions (1, 2, 4, 5) ──
      if (_freezeTapReady) {
        const freezeCfg = FREEZE_CFG[id];
        const voiceState = id == 1 ? r.livingWood : id == 2 ? r.villagePulse : id == 3 ? r.nightSky : id == 4 ? r.windHarp : id == 5 ? r.celestialStrings : null;
        if (freezeCfg && voiceState && voiceState.active) {
          // Hover-idle: cursor hasn't moved for FREEZE_IDLE_DELAY despite me.active being true.
          // Without this, hover expression keeps me.active=true forever, blocking freeze.
          const _hoverQuiet = me && me.hoverMode && (performance.now() - (me.lastDragTime || 0)) > FREEZE_IDLE_DELAY * 1000;
          const isIdle = r.state === 'looping' && (!me || !me.active || _hoverQuiet);
          if (isIdle && voiceState.freezeState === 'live') {
            voiceState.freezeIdleTime += dt;
            if (window._regionSynthDebug && Math.floor(voiceState.freezeIdleTime) > Math.floor(voiceState.freezeIdleTime - dt)) {
              _log(`%c[Freeze]%c  ${freezeCfg.name} idle: ${Math.floor(voiceState.freezeIdleTime)}s / ${FREEZE_IDLE_DELAY}s`,
                'color: #6cf; font-weight: bold', 'color: #999');
            }
            if (voiceState.freezeIdleTime >= FREEZE_IDLE_DELAY) {
              _startFreezeCapture(voiceState, freezeCfg);
            }
          } else if (!isIdle && voiceState.freezeState === 'live') {
            voiceState.freezeIdleTime = 0;
          }
          if (!isIdle && voiceState.freezeState === 'capturing') {
            _abortFreezeCapture(voiceState, freezeCfg.name);
          }
          // Auto-thaw: cursor moved during hover while region was frozen
          if (!isIdle && voiceState.freezeState === 'frozen') {
            _thawRegion(r, voiceState, freezeCfg);
          }
        }
      }
    } else if (r.state === 'stopping') {
      // Continue per-frame updates during fade-out so Living Wood / Wind Harp
      // internal state (velocity, LFO, modIndex) decays naturally instead of
      // freezing at the moment of stop.  mainGain is already ramping to 0.
      anyActive = true;
      const dt = tickNow - r.lastTickTime;
      r.lastTickTime = tickNow;
      if (r.currentParams) {
        applyParams(r, id, r.currentParams, dt);
      }
    }
  }

  if (window._perfAudit) {
    _perf.evolTick += performance.now() - _t0;
    _perf.evolTickCount++;
    _perf.toneWrites += _perf.toneWritesFrame;
    if (++_perf._lastLog >= _perf._logInterval) {
      const n = _perf.evolTickCount || 1;
      const ap = _perf.applyParamsCount || 1;
      _log(
        `%c[Perf]%c  evolTick: ${(_perf.evolTick / n).toFixed(3)}ms avg | applyParams: ${(_perf.applyParams / ap).toFixed(3)}ms avg | toneWrites: ${(_perf.toneWrites / n).toFixed(1)}/frame | allocs: entries=${(_perf.allocEntries / n).toFixed(1)} getEvol=${(_perf.allocEvolution / n).toFixed(1)} assign=${(_perf.allocAssign / n).toFixed(1)} | ${n} frames`,
        'color: #f80; font-weight: bold', 'color: #999'
      );
      window._perfReset();
    }
  }

  if (anyActive) {
    animFrameId = requestAnimationFrame(evolutionTick);
  } else {
    animFrameId = null;
  }
}

function startEvolutionLoop() {
  if (animFrameId !== null) return;
  animFrameId = requestAnimationFrame(evolutionTick);
}

// ── Fade-out helper ─────────────────────────────────────────────────────────

/**
 * Initiate a graceful fade-out for a looping or reshaping region.
 * Ramps gain to 0 over 3s, releases notes at 3s, resets state at 4s.
 */
function fadeOutRegion(r, id) {
  const voice = VOICES[id];
  unduckOtherRegions(id);

  if (buildingRegionId == id) buildingRegionId = null;
  // Preserve energy + loopTarget for reshape voices (allows catch during fade)
  if (!voice.reshape) {
    r.loopTarget = null;
    r.energy = 0;
  }
  if (r.strumTimer) { clearTimeout(r.strumTimer); r.strumTimer = null; }

  if (window._popDebug) {
    _log(
      `%c[PopDebug]%c  fadeOut region ${id}: scheduling rampTo(0, 3.0)  current gains: main=${r.mainGain.gain.value.toFixed(4)} sec=${r.secondaryGain.gain.value.toFixed(4)} deep=${r.deepSend.gain.value.toFixed(4)}`,
      'color: #f80; font-weight: bold', 'color: #999'
    );
  }
  r.mainGain.gain.rampTo(0, 3.0);
  r.secondaryGain.gain.rampTo(0, 3.0);
  r.deepSend.gain.rampTo(0, 3.0);
  if (voice.fmModMax) {
    r.primarySynth.set({ modulationIndex: voice.fmModMin });
  }

  // Wind harp: ramp down harp-specific nodes
  if (r.windHarp && r.windHarp.active) {
    r.windHarp.harpMixBus.gain.rampTo(0, 3.0);
    r.windHarp.noiseGain.gain.rampTo(0, 3.0);
    r.windHarp.phaser.wet.rampTo(0, 3.0);
    r.windHarp.delay.wet.rampTo(0, 3.0);
    _fxRampReverbTo(r.windHarp, 0, 3.0);
    for (const g of r.windHarp.harpGains) g.gain.rampTo(0, 3.0);
  }

  // Living Wood: ramp down cypress-specific nodes
  if (r.livingWood && r.livingWood.active) {
    r.livingWood.cypressMixBus.gain.rampTo(0, 3.0);
    r.livingWood.earthGain.gain.rampTo(0, 3.0);
    r.livingWood.subGain.gain.rampTo(0, 3.0);
    r.livingWood.padGain.gain.rampTo(0, 3.0);
    r.livingWood.phaser.wet.rampTo(0, 3.0);
    r.livingWood.delay.wet.rampTo(0, 3.0);
    _fxRampReverbTo(r.livingWood, 0, 3.0);
    for (const g of r.livingWood.branchGains) g.gain.rampTo(0, 3.0);
  }

  // Celestial Strings: ramp down stars-specific nodes
  if (r.celestialStrings && r.celestialStrings.active) {
    r.celestialStrings.starsMixBus.gain.rampTo(0, 3.0);
    r.celestialStrings.noiseGain.gain.rampTo(0, 3.0);
    r.celestialStrings.padGain.gain.rampTo(0, 3.0);
    r.celestialStrings.phaser.wet.rampTo(0, 3.0);
    r.celestialStrings.delay.wet.rampTo(0, 3.0);
    _fxRampReverbTo(r.celestialStrings, 0, 3.0);
    if (!r.celestialStrings.useWorklet) {
      for (const g of r.celestialStrings.stringGains) g.gain.rampTo(0, 3.0);
    }
  }

  // Reset mouse expression — for reshape voices, freeze state into captured
  // fields so the catch path can resume the spatial position on quick re-click.
  if (r.mouseExpr) {
    const me = r.mouseExpr;
    me.active = false;
    if (voice.reshape) {
      // Freeze live → captured so catch path inherits spatial position
      me.capturedFilter += me.filterOffset;
      me.capturedChorusWet += me.chorusWet;
      me.capturedReverbOffset += me.reverbOffset;
      me.capturedV3SpaceMacro += me.v3SpaceMacro;
      me.capturedCsSpaceMacro += me.csSpaceMacro;
      me.capturedLwBowPosition += me.lwBowPosition - 0.5;  // capture offset from center
      me.capturedLwRootDepth += me.lwRootDepth;
      me.capturedVhWindowFocus += me.vhWindowFocus;
      me.capturedVhXFilter += me.vhXFilterExpr;
      me.filterOffset = 0;
      me.chorusWet = 0;
      me.reverbOffset = 0;
      me.v3SpaceMacro = 0;
      me.csSpaceMacro = 0;
      me.vhWindowFocus = 0;
      me.vhXFilterExpr = 0;
      me.vhDragVelocity = 0;
      me.lwBowPosition = 0.5;
      me.lwRootDepth = 0;
      me.lwDragVelocity = 0;
      // Strum boosts decay naturally — don't hard-zero
      me.v3LastStrumIndex = -1;
      me.csLastStrumIndex = -1;
    } else {
      me.filterOffset = 0;
      me.chorusWet = 0;
      me.reverbOffset = 0;
      me.capturedFilter = 0;
      me.capturedChorusWet = 0;
      me.capturedReverbOffset = 0;
      me.v3StrumBoosts.fill(0);
      me.v3LastStrumIndex = -1;
      me.v3SpaceMacro = 0;
      me.capturedV3SpaceMacro = 0;
      me.csStrumBoosts.fill(0);
      me.csLastStrumIndex = -1;
      me.csSpaceMacro = 0;
      me.capturedCsSpaceMacro = 0;
      me.vhWindowFocus = 0;
      me.capturedVhWindowFocus = 0;
      me.vhXFilterExpr = 0;
      me.capturedVhXFilter = 0;
      me.vhDragVelocity = 0;
      me.lwBowPosition = 0.5;
      me.lwRootDepth = 0;
      me.lwDragVelocity = 0;
      me.capturedLwBowPosition = 0;
      me.capturedLwRootDepth = 0;
    }
  }
  if (r.chorus) r.chorus.wet.rampTo(0, 3.0);

  const t1 = setTimeout(() => {
    if (window._popDebug) {
      const lwGains = r.livingWood && r.livingWood.active ? {
        mixBus: r.livingWood.cypressMixBus.gain.value.toFixed(4),
        earth: r.livingWood.earthGain.gain.value.toFixed(4),
        pad: r.livingWood.padGain.gain.value.toFixed(4),
      } : null;
      const whGains = r.windHarp && r.windHarp.active ? {
        mixBus: r.windHarp.harpMixBus.gain.value.toFixed(4),
      } : null;
      _log(
        `%c[PopDebug]%c  T+3s deactivation region ${id}: main=${r.mainGain.gain.value.toFixed(6)} sec=${r.secondaryGain.gain.value.toFixed(6)} deep=${r.deepSend.gain.value.toFixed(6)}` +
        (lwGains ? `  LW: mixBus=${lwGains.mixBus} earth=${lwGains.earth} pad=${lwGains.pad}` : '') +
        (whGains ? `  WH: mixBus=${whGains.mixBus}` : ''),
        'color: #f0f; font-weight: bold', 'color: #999'
      );
    }
    r.primarySynth.triggerRelease(voice.notes, Tone.now());
    r.secondarySynth.triggerRelease(voice.notes, Tone.now());
    // Wind harp: deactivate at same time as base synth release
    if (r.windHarp && r.windHarp.active) deactivateWindHarp(r);
    // Night Sky: deactivate at same time as base synth release
    if (r.nightSky && r.nightSky.active) deactivateNightSky(r);
    // Living Wood: deactivate at same time as base synth release
    if (r.livingWood && r.livingWood.active) deactivateCypressLivingWood(r);
    // Celestial Strings: deactivate at same time as base synth release
    if (r.celestialStrings && r.celestialStrings.active) deactivateCelestialStrings(r);
    // Village Pulse: deactivate
    if (r.villagePulse && r.villagePulse.active) {
      const vp = r.villagePulse;
      vp.active = false;
      vp.capturedRate = 0;
      const stopT = Tone.now() + 0.5;
      try { vp.lowPad.triggerRelease(VP_LOW_PAD_NOTES[_activeMode], Tone.now()); } catch (e) {}
      try { vp.pad.triggerRelease(VP_PAD_NOTES[_activeMode], Tone.now()); } catch (e) {}
      try { vp.tremolo.stop(stopT); } catch (e) {}
      try { vp.roomNoise.stop(stopT); } catch (e) {}
      if (vp.useWorklet && vp.workletNode) {
        vp.workletNode.port.postMessage({ type: 'deactivate' });
      } else {
        for (const osc of vp.overtoneOscs) { try { osc.stop(stopT); } catch (e) {} }
        for (const osc of vp.overtoneOscsB) { try { osc.stop(stopT); } catch (e) {} }
        for (const g of vp.overtoneGains) { g.gain.value = 0; }
      }
      try { vp.lfo.stop(stopT); } catch (e) {}
      // Disconnect effects chain from output — Chrome stops processing idle nodes
      try { _nativeNode(vp.limiter).disconnect(_nativeNode(r.filter)); } catch (e) {
        try { vp.limiter.disconnect(r.filter); } catch (e2) {}
      }
      // Restore base synth volumes for potential future use
      r.primarySynth.volume.value = VOICES[2].volume;
      r.secondarySynth.volume.value = VOICES[2].volume - 3;
    }
  }, 3000);

  const t2 = setTimeout(() => {
    setState(r, id, 'off');
    r.mainGain.gain.value = 0;
    r.energy = 0;
    r.loopTarget = null;
  }, 4000);

  r.stopTimeouts = [t1, t2];
  setState(r, id, 'stopping');

  if (window._regionSynthDebug) _log(
    `%c[RegionSynth]%c  ${voice.name} → fading out`,
    'color: #f0a; font-weight: bold', 'color: #999'
  );
}

// ── Filter attack transient ──────────────────────────────────────────────

/**
 * Fire a filter cutoff transient — a brief overshoot above the current
 * evolution level that decays exponentially back to baseline.
 *
 * The overshoot is multiplicative in Hz (e.g. 1.4× current cutoff) which
 * converts to a constant additive offset in normalized filter-param space:
 *   offset = ln(overshoot) / ln(filterOpen / filterClosed)
 *
 * Capped so the total filter param (base + expression + transient) stays
 * at or below 1.0 (filterOpen), preventing the transient from exceeding
 * the voice's natural timbral range.
 *
 * The offset is stored in r.filterTransient.offset and decayed per-frame
 * in evolutionTick().  applyParams() adds it to the filter calculation.
 */
function fireFilterTransient(r, id) {
  const voice = VOICES[id];
  const ft = voice.filterTransient;
  if (!ft) return;

  // Multiplicative Hz overshoot → additive offset in log-frequency param space
  const logRange = Math.log(voice.filterOpen / voice.filterClosed);
  const rawOffset = Math.log(ft.overshoot) / logRange;

  // Cap: don't push total filter param past 1.0 (filterOpen).
  // Floor at 0.03 so there's always a perceptible spike even at high filter states.
  const room = Math.max(0.03, 1.0 - r.currentParams.filter);
  r.filterTransient.offset = Math.min(rawOffset, room);

  if (window._regionSynthDebug) _log(
    `%c[FilterTransient]%c  ${voice.name} → spike +${r.filterTransient.offset.toFixed(3)} ` +
    `(base ${r.currentParams.filter.toFixed(3)}, decay ${ft.decayMs}ms)`,
    'color: #fa0; font-weight: bold', 'color: #888'
  );
}

// ── Inter-region ducking ─────────────────────────────────────────────────
//
// When actively interacting with one region (building, reshaping, strum),
// other looping regions pull back in gain and filter to make room.
// Onset is fast (~100ms), recovery is slow (~1.4s exponential ease-out).
// Strum gets a lighter, shorter duck pulse with faster recovery.
// Applied as offsets in applyParams — never overwrites evolution state.

const DUCK_HOLD_GAIN     = 0.75;   // gain multiplier when ducked (≈ -2.5 dB)
const DUCK_HOLD_FILTER   = -0.12;  // filter param offset when ducked (-12% closure)
const DUCK_STRUM_GAIN    = 0.82;   // lighter gain duck for strum (≈ -1.7 dB)
const DUCK_STRUM_FILTER  = -0.08;  // lighter filter duck for strum (-8%)
const DUCK_STRUM_DURATION = 250;   // ms before strum auto-releases duck
const DUCK_ONSET_RATE    = 0.4;    // per-frame smoothing → ~95% in 100ms at 60fps
const DUCK_RECOVERY_RATE = 0.035;  // per-frame smoothing → ~95% in 1.4s
const DUCK_STRUM_RECOVERY_RATE = 0.08; // per-frame smoothing → ~95% in 600ms

/**
 * Duck all other looping/reshaping regions when interacting with one.
 * @param {number|string} activeId — the region being interacted with (excluded from ducking)
 * @param {'hold'|'strum'} type — 'hold' for building/reshaping, 'strum' for retrigger
 */
function duckOtherRegions(activeId, type) {
  const gainTarget   = type === 'strum' ? DUCK_STRUM_GAIN   : DUCK_HOLD_GAIN;
  const filterTarget = type === 'strum' ? DUCK_STRUM_FILTER : DUCK_HOLD_FILTER;
  const duckedNames = [];

  for (const id in regions) { const r = regions[id];
    if (id == activeId) continue;
    if (r.state !== 'looping' && r.state !== 'reshaping') continue;
    if (!r.duck) continue;

    // Clear any pending strum auto-release
    if (r.duck.strumTimer) { clearTimeout(r.duck.strumTimer); r.duck.strumTimer = null; }
    r.duck.strumRecovery = false;

    r.duck.gainTarget = gainTarget;
    r.duck.filterTarget = filterTarget;

    if (type === 'strum') {
      // Strum: auto-release duck after brief pulse
      r.duck.strumTimer = setTimeout(() => {
        r.duck.strumTimer = null;
        r.duck.gainTarget = 1.0;
        r.duck.filterTarget = 0;
        r.duck.strumRecovery = true;
      }, DUCK_STRUM_DURATION);
    }

    duckedNames.push(VOICES[id].name);
  }

  if (duckedNames.length > 0 && window._regionSynthDebug) {
    _log(
      `%c[Duck]%c  ${duckedNames.join(', ')} ducked${type === 'strum' ? ` (${DUCK_STRUM_DURATION}ms pulse)` : ''} — ${VOICES[activeId].name} ${type === 'strum' ? 'strum' : 'active'}`,
      'color: #c80; font-weight: bold', 'color: #888'
    );
  }
}

/**
 * Release duck on all other regions (begins slow recovery).
 * @param {number|string} activeId — the region that finished interacting
 */
function unduckOtherRegions(activeId) {
  const releasedNames = [];

  for (const id in regions) { const r = regions[id];
    if (id == activeId) continue;
    if (!r.duck) continue;
    // Only log regions that were actually ducked
    if (r.duck.gainTarget < 1.0 || r.duck.filterTarget < 0) {
      releasedNames.push(VOICES[id].name);
    }

    if (r.duck.strumTimer) { clearTimeout(r.duck.strumTimer); r.duck.strumTimer = null; }
    r.duck.gainTarget = 1.0;
    r.duck.filterTarget = 0;
    r.duck.strumRecovery = false;
  }

  if (releasedNames.length > 0 && window._regionSynthDebug) {
    _log(
      `%c[Duck]%c  ${releasedNames.join(', ')} recovering — ${VOICES[activeId].name} released`,
      'color: #c80; font-weight: bold', 'color: #888'
    );
  }
}

// ── Strum retrigger ──────────────────────────────────────────────────────

/**
 * Retrigger the synth envelopes for a strum hit.
 * Release then re-attack with a 15ms gap for clean envelope restart.
 * 5ms was too tight — FM/AM envelopes need time to fully release
 * before re-attacking or the overlap causes amplitude spikes.
 * The audio chain (filter, gain, reverb) keeps its current state —
 * only the synth envelopes restart, so the strum inherits current complexity.
 */
function retriggerAttack(r, voice) {
  const now = Tone.now();
  r.primarySynth.triggerRelease(voice.notes, now);
  r.secondarySynth.triggerRelease(voice.notes, now);
  r.primarySynth.triggerAttack(voice.notes, now + 0.015);
  r.secondarySynth.triggerAttack(voice.notes, now + 0.015);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called on mousedown. Starts building a voice, or stops a looping one.
 * @param {number} regionId — 1-5
 */
export async function regionMouseDown(regionId) {
  if (regionId < 1 || regionId > 5) return;

  // If another region is mid-build/reshape, release it first to prevent
  // buildingRegionId clobbering (orphaned 'building' state with no mouseUp).
  if (buildingRegionId !== null && buildingRegionId !== regionId) {
    const prev = regions[buildingRegionId];
    if (prev && prev.state === 'building') {
      // Promote to looping at current complexity
      const prevVoice = VOICES[buildingRegionId];
      prev.holdDuration = prev.effectiveBuildTime;
      const complexity = Math.min(prev.holdDuration / 15, 1);
      prev.loopTarget = getLoopTarget(complexity, prevVoice);
      setState(prev, buildingRegionId, 'looping');
      unduckOtherRegions(buildingRegionId);
    } else if (prev && prev.state === 'reshaping') {
      setState(prev, buildingRegionId, 'looping');
      unduckOtherRegions(buildingRegionId);
    }
  }

  // Synchronous before await — prevents mouseUp race condition
  buildingRegionId = regionId;
  mouseUpPending = false;

  if (window._clickTiming) window._clickTiming.preAwait = performance.now();
  // Skip await when init is already complete — keeps the entire handler synchronous,
  // so the evolution tick runs in the NEXT frame instead of piling onto this event's INP.
  // Ensure audio context is initialized AND running. The _initComplete check handles
  // first-time init. The context state check handles bfcache restore where _initComplete
  // persists but AudioContext reverts to suspended.
  try {
    if (!_initComplete) await ensureInit();
    else if (Tone.context && Tone.context.state === 'suspended') await Tone.start();
  } catch (e) {
    console.error('%c[Audio]%c  Audio init failed in regionMouseDown:', 'color: #f44; font-weight: bold', 'color: #999', e);
    buildingRegionId = null;
    return;  // Bail gracefully — region stays off, no crash
  }
  if (window._clickTiming) window._clickTiming.postAwait = performance.now();

  // After await: verify we still own buildingRegionId. Another click during the await
  // could have clobbered it — if so, that click is now the owner and we bail.
  if (buildingRegionId !== regionId) return;

  const r = regions[regionId];
  if (!r) return;
  if (window._clickTiming) window._clickTiming._regionState = r.state;

  const voice = VOICES[regionId];

  const quickRelease = mouseUpPending;
  mouseUpPending = false;

  if (window._clickTiming) window._clickTiming._preCatch = performance.now();

  // ── Catch: resume a fading voice instead of restarting ──
  // If click lands during the 3s fade-out, cancel the fade and jump back to
  // 'looping' with energy/loopTarget intact, then fall through to the
  // looping branch for normal strum/reshape handling.
  // mouseExpr activation is DEFERRED until after catch check so the catch
  // path can inherit the frozen captured state from fadeOutRegion.
  if (r.state === 'stopping' && voice.reshape) {
    if (r.stopTimeouts) {
      r.stopTimeouts.forEach(tid => clearTimeout(tid));
      r.stopTimeouts = null;
    }
    if (r.strumTimer) { clearTimeout(r.strumTimer); r.strumTimer = null; }

    // Clean up freeze state before restoring live chain — prevents doubled audio
    // (frozen + live playing simultaneously) if catch fires while region is frozen.
    for (const voiceType of ['windHarp', 'livingWood', 'celestialStrings', 'nightSky']) {
      const vs = r[voiceType];
      if (!vs) continue;
      if (vs.freezeState === 'capturing') _abortFreezeCapture(vs, FREEZE_CFG[regionId]?.name || voiceType);
      if (vs.freezeState === 'frozen') {
        if (vs.frozenSource) { try { vs.frozenSource.stop(); } catch (_) {} try { vs.frozenSource.disconnect(); } catch (_) {} }
        if (vs.frozenGain) { try { vs.frozenGain.disconnect(); } catch (_) {} }
        vs.frozenSource = null;
        vs.frozenGain = null;
        vs.freezeState = 'live';
      }
    }

    // Restore audio chain (gain was ramping to 0)
    const now = Tone.now();
    const cp = r.currentParams;
    r.mainGain.gain.cancelScheduledValues(now);
    r.mainGain.gain.rampTo(cp.gain, 0.05);
    r.filter.frequency.rampTo(
      voice.filterClosed * Math.pow(voice.filterOpen / voice.filterClosed, cp.filter), 0.05
    );
    r.secondaryGain.gain.rampTo(cp.secondary, 0.05);
    r.deepSend.gain.rampTo(cp.deepReverb * 0.5, 0.05);

    // Wind harp: cancel ramp-downs from fadeOutRegion and restore to evolved values.
    // applyWindHarpV3Params will reassert correct targets on the next frame;
    // here we just unfreeze all nodes so they don't stay at mid-fade values.
    // Guard uses isWindHarpActive() (mode flag) instead of wh.active (runtime flag)
    // because deactivateWindHarp may have already run if catch happens after T+3s.
    if (r.windHarp && isWindHarpActive()) {
      // If deactivateWindHarp already fired (T+3s passed), re-activate first
      if (!r.windHarp.active) {
        try { activateWindHarp(r); } catch (e) { console.warn('[Catch] WH re-activation failed:', e); }
      }
      const wh = r.windHarp;
      if (wh.active && wh.harpMixBus) {
        const tau = 0.05;
        wh.harpMixBus.gain.cancelScheduledValues(now);
        wh.harpMixBus.gain.rampTo(1.0, tau);
        wh.noiseGain.gain.cancelScheduledValues(now);
        wh.noiseGain.gain.rampTo(cp.secondary * 0.6, tau);
        wh.phaser.wet.cancelScheduledValues(now);
        wh.phaser.wet.rampTo(cp.lfo * wh.userParams.phaserMaxWet, tau);
        wh.delay.wet.cancelScheduledValues(now);
        wh.delay.wet.rampTo(cp.width * VOICES[4].windHarp.delayMaxWet, tau);
        // Tremolo: cancel ramp-to-0 so per-frame .value assignment works again
        wh.tremolo.depth.cancelScheduledValues(now);
        wh.tremolo.depth.value = cp.lfo * wh.userParams.tremoloMaxDepth;
        if (!wh.useWorklet) {
          for (const g of wh.harpGains) {
            g.gain.cancelScheduledValues(now);
            // Per-note LFO will reassert correct gain on the next tick
          }
        }
      }
    }

    // Night Sky: cancel ramp-downs from fadeOutRegion and restore to evolved values
    if (r.nightSky && isNightSkyActive()) {
      if (!r.nightSky.active) {
        try { activateNightSky(r); } catch (e) { console.warn('[Catch] NS re-activation failed:', e); }
      }
      // Re-suppress base synths (may have leaked back during fade-out)
      r.primarySynth.volume.value = -Infinity;
      r.secondarySynth.volume.value = -Infinity;
      const skyC = r.nightSky;
      if (skyC.active && skyC.mixBus) {
        const tauCatch = 0.05;
        skyC.mixBus.gain.cancelScheduledValues(now);
        skyC.mixBus.gain.rampTo(0.70, tauCatch);
        skyC.deepGain.gain.cancelScheduledValues(now);
        skyC.windGain.gain.cancelScheduledValues(now);
        skyC.airGain.gain.cancelScheduledValues(now);
        skyC.padGain.gain.cancelScheduledValues(now);
        skyC.padGain.gain.rampTo(cp.secondary * skyC.userParams.padMix, tauCatch);
        skyC.phaser.wet.cancelScheduledValues(now);
        skyC.phaser.wet.rampTo(cp.lfo * skyC.userParams.phaserWet, tauCatch);
        skyC.delay.wet.cancelScheduledValues(now);
        skyC.delay.wet.rampTo(cp.width * skyC.userParams.delayMix, tauCatch);
        skyC.tremolo.depth.cancelScheduledValues(now);
        skyC.tremolo.depth.value = cp.lfo * 0.4;
        skyC.reverbSend.gain.cancelScheduledValues(now);
        skyC.reverbSend.gain.rampTo(skyC.userParams.reverbMix, tauCatch);
      }
    }

    // Living Wood: cancel ramp-downs from fadeOutRegion and restore to evolved values
    if (r.livingWood && isLivingWoodActive()) {
      if (!r.livingWood.active) {
        try { activateCypressLivingWood(r); } catch (e) { console.warn('[Catch] LW re-activation failed:', e); }
      }
      const lwS = r.livingWood;
      if (lwS.active && lwS.cypressMixBus) {
        const tauCatch = 0.05;
        lwS.cypressMixBus.gain.cancelScheduledValues(now);
        lwS.cypressMixBus.gain.rampTo(2.5, tauCatch);  // match activation makeup gain
        lwS.earthGain.gain.cancelScheduledValues(now);
        lwS.earthGain.gain.rampTo(cp.secondary * 0.4, tauCatch);
        lwS.padGain.gain.cancelScheduledValues(now);
        lwS.padGain.gain.rampTo(Math.max(0.1, cp.gain) * 0.8, tauCatch);
        lwS.phaser.wet.cancelScheduledValues(now);
        lwS.phaser.wet.rampTo(cp.lfo * lwS.userParams.phaserWet, tauCatch);
        lwS.delay.wet.cancelScheduledValues(now);
        lwS.delay.wet.rampTo(cp.width * VOICES[1].livingWood.delayMaxWet, tauCatch);
        lwS.tremolo.depth.cancelScheduledValues(now);
        lwS.tremolo.depth.value = cp.lfo * VOICES[1].livingWood.tremoloMaxDepth;
        _fxCancelReverb(lwS, now);
        _fxRampReverbTo(lwS, lwS.userParams.reverbMix, tauCatch);
        if (!lwS.useWorklet) {
          for (const g of lwS.branchGains) g.gain.cancelScheduledValues(now);
        }
      }
    }

    // Celestial Strings: cancel ramp-downs from fadeOutRegion and restore
    // (activateCelestialStrings handles lazy init if nodes don't exist yet)
    if (isCelestialStringsActive()) {
      if (!r.celestialStrings || !r.celestialStrings.active) {
        try { activateCelestialStrings(r); } catch (e) { console.warn('[Catch] CS re-activation failed:', e); }
      }
      const csS = r.celestialStrings;
      if (csS && csS.active) {
        const tauCatch = 0.05;
        csS.starsMixBus.gain.cancelScheduledValues(now);
        csS.starsMixBus.gain.rampTo(1.0, tauCatch);
        csS.noiseGain.gain.cancelScheduledValues(now);
        csS.noiseGain.gain.rampTo(cp.secondary * 0.3, tauCatch);
        csS.padGain.gain.cancelScheduledValues(now);
        csS.padGain.gain.rampTo(Math.max(0.08, cp.gain) * 0.7, tauCatch);
        csS.phaser.wet.cancelScheduledValues(now);
        csS.phaser.wet.rampTo(cp.lfo * csS.userParams.phaserWet, tauCatch);
        csS.delay.wet.cancelScheduledValues(now);
        csS.delay.wet.rampTo(cp.width * VOICES[5].celestialStrings.delayMaxWet, tauCatch);
        csS.tremolo.depth.cancelScheduledValues(now);
        csS.tremolo.depth.value = cp.lfo * VOICES[5].celestialStrings.tremoloMaxDepth;
        _fxCancelReverb(csS, now);
        _fxRampReverbTo(csS, csS.userParams.reverbMix, tauCatch);
        if (!csS.useWorklet) {
          for (const g of csS.stringGains) g.gain.cancelScheduledValues(now);
        }
      }
    }

    // Village Pulse: re-activate on catch (same as fresh activation)
    if (regionId === 2 && r.villagePulse && !r.villagePulse.active) {
      r.primarySynth.volume.value = -Infinity;
      r.secondarySynth.volume.value = -Infinity;
      const vp = r.villagePulse;
      vp.active = true;
      vp.liveRate = 0;
      vp.capturedRate = 0;
      vp.currentRate = VP_LFO_MIN_RATE;
      // Reconnect effects chain
      try { _nativeNode(vp.limiter).connect(_nativeNode(r.filter)); } catch (e) {
        try { vp.limiter.connect(r.filter); } catch (e2) {}
      }
      const ct = Tone.now();
      try { vp.lfo.start(ct); } catch (e) {
        vp.lfo.dispose();
        vp.lfo = new Tone.LFO({ frequency: VP_LFO_MIN_RATE, min: 0, max: 1, type: 'sine' });
        vp.lfo.connect(vp.gain.gain);
        vp.lfo.start(ct);
      }
      // Catch path: pads may have been released — re-trigger
      if (!vp._padPreTriggered) {
        vp.lowPad.triggerAttack(VP_LOW_PAD_NOTES[_activeMode], ct);
        vp.pad.triggerAttack(VP_PAD_NOTES[_activeMode], ct);
      }
      vp._padPreTriggered = false;
      try { vp.tremolo.start(ct); } catch (e) {}
      try { vp.roomNoise.start(ct); } catch (e) {}
      for (let i = 0; i < vp.overtonePhases.length; i++) {
        vp.overtonePhases[i] = Math.random();
      }
      if (vp.useWorklet && vp.workletNode) {
        vp.workletNode.port.postMessage({ type: 'activate' });
      } else {
        for (let i = 0; i < vp.overtoneOscs.length; i++) {
          try { vp.overtoneOscs[i].start(ct); } catch (e) {
            vp.overtoneOscs[i].dispose();
            const newOsc = new Tone.Oscillator({ type: 'sine', frequency: VP_OVERTONE_FREQS[_activeMode][i] });
            newOsc.volume.value = -14;
            newOsc.connect(vp.overtoneGains[i]);
            newOsc.start(ct);
            vp.overtoneOscs[i] = newOsc;
          }
          try { vp.overtoneOscsB[i].start(ct); } catch (e) {
            vp.overtoneOscsB[i].dispose();
            const freqB = VP_OVERTONE_FREQS[_activeMode][i] * Math.pow(2, VP_OVERTONE_DETUNE / 1200);
            const newOsc = new Tone.Oscillator({ type: 'sine', frequency: freqB });
            newOsc.volume.value = -14;
            newOsc.connect(vp.overtoneGains[i]);
            newOsc.start(ct);
            vp.overtoneOscsB[i] = newOsc;
          }
          vp.overtoneGains[i].gain.setTargetAtTime(0.15, ct + i * 0.4, 0.15);
        }
      }
    }

    // Only retrigger base synths if not in special mode (harp/LW/CS/pulse notes are already active)
    if (!(regionId === 4 && isWindHarpActive() && r.windHarp && r.windHarp.active) &&
        !(regionId === 3 && isNightSkyActive() && r.nightSky && r.nightSky.active) &&
        !(regionId === 1 && isLivingWoodActive() && r.livingWood && r.livingWood.active) &&
        !(regionId === 5 && isCelestialStringsActive() && r.celestialStrings && r.celestialStrings.active) &&
        !(regionId === 2 && r.villagePulse && r.villagePulse.active)) {
      retriggerAttack(r, voice);
    }
    fireFilterTransient(r, regionId);
    setState(r, regionId, 'looping');
    startEvolutionLoop();

    // Activate mouseExpr for catch — inherit frozen captured state from fadeOutRegion
    if (r.mouseExpr) {
      const me = r.mouseExpr;
      me.active = true;
      me.filterOffset = 0;
      me.chorusWet = 0;
      me.reverbOffset = 0;
      me.v3SpaceMacro = 0;
      me.csSpaceMacro = 0;
      // capturedV3SpaceMacro, capturedCsSpaceMacro, capturedFilter etc. are KEPT — frozen by fadeOutRegion
      // Strum boosts: kept (may still be decaying from previous session)
      if (window._regionSynthDebug) _log(
        `%c[MouseExpr]%c  ${voice.name} — Active (catch — preserved captured state, macro=${me.capturedV3SpaceMacro.toFixed(2)})`,
        'color: #0c6; font-weight: bold', 'color: #999'
      );
    }

    if (window._regionSynthDebug) _log(
      `%c[RegionSynth]%c  ${voice.name} → caught (energy: ${r.energy.toFixed(2)})`,
      'color: #f0a; font-weight: bold', 'color: #0cf'
    );
    // Catch is a pure "resume" — consume the click so mouseUp doesn't
    // schedule a strumTimer fade-out or trigger tap-to-stop via reshaping.
    buildingRegionId = null;
    return;
  }

  // Activate mouseExpr for non-catch paths — full reset from scratch
  if (r.mouseExpr && !r.mouseExpr.active) {
    const me = r.mouseExpr;
    me.active = true;
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
    me.capturedFilter = 0;
    me.capturedChorusWet = 0;
    me.capturedReverbOffset = 0;
    me.v3StrumBoosts.fill(0);
    me.v3LastStrumIndex = -1;
    me.v3SpaceMacro = 0;
    me.capturedV3SpaceMacro = 0;
    me.csStrumBoosts.fill(0);
    me.csLastStrumIndex = -1;
    me.csSpaceMacro = 0;
    me.capturedCsSpaceMacro = 0;
    me.lwBowPosition = 0.5;
    me.lwRootDepth = 0;
    me.lwDragVelocity = 0;
    me.capturedLwBowPosition = 0;
    me.capturedLwRootDepth = 0;
    if (window._regionSynthDebug) _log(
      `%c[MouseExpr]%c  ${voice.name} — Active (fresh start)`,
      'color: #0c6; font-weight: bold', 'color: #999'
    );
  }

  if (window._clickTiming) window._clickTiming._preFresh = performance.now();

  if (r.state === 'off' || r.state === 'stopping') {
    // ── Start fresh (cancel any pending stop) ──
    if (r.state === 'stopping') {
      if (r.stopTimeouts) {
        r.stopTimeouts.forEach(tid => clearTimeout(tid));
        r.stopTimeouts = null;
      }
      r.primarySynth.triggerRelease(voice.notes, Tone.now());
      r.secondarySynth.triggerRelease(voice.notes, Tone.now());
    }
    if (r.strumTimer) { clearTimeout(r.strumTimer); r.strumTimer = null; }

    // Initialize params at evolution t=0
    const now = Tone.now();
    r.buildStartTime = now;
    r.effectiveBuildTime = 0;
    r.lastTickTime = now;
    r.energy = 0;
    getEvolution(0, voice, r.currentParams);

    // Set mainGain to target immediately — synth envelopes handle the attack shape,
    // no need for a separate gain ramp from 0 (which added 100-300ms of perceived delay)
    r.mainGain.gain.cancelScheduledValues(now);
    r.mainGain.gain.value = r.currentParams.gain;
    r.filter.frequency.value = voice.filterClosed;
    r.secondaryGain.gain.value = 0;
    r.deepSend.gain.value = 0;
    if (voice.fmModMax) {
      r.primarySynth.set({ modulationIndex: voice.fmModMin });
    }

    // Living Wood: activate three-layer voice instead of base synths
    if (isLivingWoodActive() && regionId === 1) {
      activateCypressLivingWood(r);
    // Village Pulse: activate rhythmic pulse instead of base synths
    } else if (regionId === 2) {
      if (r.villagePulse) {
        const vp = r.villagePulse;
        vp.active = true;
        vp.liveRate = 0;
        vp.capturedRate = 0;
        vp.currentRate = VP_LFO_MIN_RATE;
        const t = Tone.now();

        // Zero the mix before connecting. vpMix is initialized to 0 at module
        // load (see its constructor), so on first activation this is a 0 → 0
        // no-op. Kept as defense against re-activation paths that might leave
        // vpMix partway through a deactivation fade-down.
        vp.mix.gain.value = 0;

        // Connect effects chain to output (A2 pattern — disconnect on deactivation)
        try { _nativeNode(vp.limiter).connect(_nativeNode(r.filter)); } catch (e) {
          try { vp.limiter.connect(r.filter); } catch (e2) {}
        }

        // Ramp mix up after connection — smooth onset, no click
        vp.mix.gain.setTargetAtTime(2.0, t + 0.01, 0.02);  // match build-time mix gain

        // Start LFO — recreate if stopped (Tone.LFO can't restart after stop)
        try { vp.lfo.start(t); } catch (e) {
          vp.lfo.dispose();
          vp.lfo = new Tone.LFO({ frequency: VP_LFO_MIN_RATE, min: 0, max: 1, type: 'sine' });
          vp.lfo.connect(vp.gain.gain);
          vp.lfo.start(t);
        }
        vp.lfo.frequency.value = VP_LFO_MIN_RATE;
        vp.fmDriftPhase = Math.random();  // start FM drift at random point

        // Layer A + B: FM pads — pre-triggered at gain=0 during init.
        // On first activation, pads are already running. Just ramp gains.
        // On re-activation (after deactivation released them), re-trigger.
        if (!vp._padPreTriggered) {
          vp.lowPad.triggerAttack(VP_LOW_PAD_NOTES[_activeMode], t);
          vp.pad.triggerAttack(VP_PAD_NOTES[_activeMode], t);
        }
        vp._padPreTriggered = false;  // next activation will need triggerAttack
        try { vp.tremolo.start(t); } catch (e) {}

        // Room tone: deferred start (cheap, no INP impact)
        setTimeout(() => { try { vp.roomNoise.start(); } catch (e) {} }, 0);

        // Layer C: Fattened overtones
        // Randomize breathing phases so voices don't start in sync
        for (let i = 0; i < vp.overtonePhases.length; i++) {
          vp.overtonePhases[i] = Math.random();
        }
        if (vp.useWorklet && vp.workletNode) {
          // Worklet: just activate — oscillators run continuously, gains control amplitude
          vp.workletNode.port.postMessage({ type: 'activate' });
        } else {
          // Tone.js fallback: recreate oscillators if stopped (can't restart after stop)
          for (let i = 0; i < vp.overtoneOscs.length; i++) {
            try { vp.overtoneOscs[i].start(t); } catch (e) {
              vp.overtoneOscs[i].dispose();
              const newOsc = new Tone.Oscillator({ type: 'sine', frequency: VP_OVERTONE_FREQS[_activeMode][i] });
              newOsc.volume.value = -14;
              newOsc.connect(vp.overtoneGains[i]);
              newOsc.start(t);
              vp.overtoneOscs[i] = newOsc;
            }
            try { vp.overtoneOscsB[i].start(t); } catch (e) {
              vp.overtoneOscsB[i].dispose();
              const freqB = VP_OVERTONE_FREQS[_activeMode][i] * Math.pow(2, VP_OVERTONE_DETUNE / 1200);
              const newOsc = new Tone.Oscillator({ type: 'sine', frequency: freqB });
              newOsc.volume.value = -14;
              newOsc.connect(vp.overtoneGains[i]);
              newOsc.start(t);
              vp.overtoneOscsB[i] = newOsc;
            }
            vp.overtoneGains[i].gain.setTargetAtTime(0.15, t + i * 0.4, 0.15);
          }
        }
      }
      // Suppress base synths — mute at source so nothing leaks through
      r.primarySynth.volume.value = -Infinity;
      r.secondarySynth.volume.value = -Infinity;
      r.secondaryGain.gain.value = 0;
      try { r.primarySynth.triggerRelease(voice.notes, now); } catch (e) {}
      try { r.secondarySynth.triggerRelease(voice.notes, now); } catch (e) {}
    // Wind harp: activate harp layers instead of base synths
    } else if (isWindHarpActive() && regionId === 4) {
      activateWindHarp(r);
    // Night Sky: activate sky layers instead of base synths
    } else if (isNightSkyActive() && regionId === 3) {
      activateNightSky(r);
      // Suppress base synths — Night Sky has its own audio chain
      r.primarySynth.volume.value = -Infinity;
      r.secondarySynth.volume.value = -Infinity;
      r.secondaryGain.gain.value = 0;
      try { r.primarySynth.triggerRelease(voice.notes, now); } catch (e) {}
      try { r.secondarySynth.triggerRelease(voice.notes, now); } catch (e) {}
    // Celestial Strings: activate string layers instead of base synths
    } else if (isCelestialStringsActive() && regionId === 5) {
      activateCelestialStrings(r);
    } else {
      r.primarySynth.triggerAttack(voice.notes, now);
      r.secondarySynth.triggerAttack(voice.notes, now);
    }
    if (window._clickTiming) window._clickTiming.synthTriggered = performance.now();
    fireFilterTransient(r, regionId);

    if (quickRelease) {
      r.holdDuration = 0.1;
      r.loopTarget = getLoopTarget(0.1 / 15, voice);
      setState(r, regionId, 'looping');
      buildingRegionId = null;
      // Quick release: mouse already up, deactivate expression immediately
      if (r.mouseExpr) {
        r.mouseExpr.active = false;
      }
      if (window._regionSynthDebug) _log(
        `%c[RegionSynth]%c  ${voice.name} → looping (quick click)`,
        'color: #f0a; font-weight: bold', 'color: #999'
      );
    } else if (regionId === 5) {
      // Stars: skip building, go straight to looping at full complexity.
      // The vortex cascade animation provides the visual build drama —
      // audio stays at stable looping levels with full reverb/delay/shimmer.
      r.effectiveBuildTime = 15;
      r.holdDuration = 15;
      r.loopTarget = getLoopTarget(1.0, voice);
      setState(r, regionId, 'looping');
      buildingRegionId = null;
    } else {
      setState(r, regionId, 'building');
      if (window._clickTiming) {
        window._clickTiming.stateSet = performance.now();
        const t = window._clickTiming;
        const t0 = t.mousedown || t.preAwait;
        _log(
          `%c[ClickTiming]%c  state=%c${t._regionState}%c  ` +
          `mousedown→preAwait: %c${(t.preAwait - t0).toFixed(1)}ms%c  ` +
          `await: %c${(t.postAwait - t.preAwait).toFixed(1)}ms%c  ` +
          `postAwait→catch: %c${((t._preCatch || t.postAwait) - t.postAwait).toFixed(1)}ms%c  ` +
          `catch→fresh: %c${((t._preFresh || t._preCatch || t.postAwait) - (t._preCatch || t.postAwait)).toFixed(1)}ms%c  ` +
          `fresh→synth: %c${(t.synthTriggered - (t._preFresh || t.postAwait)).toFixed(1)}ms%c  ` +
          `TOTAL: %c${(t.stateSet - t0).toFixed(1)}ms`,
          'color: #f80; font-weight: bold', 'color: #999',
          'color: #0ff', 'color: #999',
          'color: #0f0', 'color: #999',
          'color: #ff0', 'color: #999',
          'color: #0f0', 'color: #999',
          'color: #0f0', 'color: #999',
          'color: #0f0', 'color: #999',
          'color: #f00; font-weight: bold'
        );
        // Wind harp internal breakdown
        if (t._whStart) {
          _log(
            `%c[ClickTiming]%c  WindHarp internals:  ` +
            `flush: %c${(t._whFlush - t._whStart).toFixed(1)}ms%c  ` +
            `noise: %c${(t._whNoise - t._whFlush).toFixed(1)}ms%c  ` +
            `pad: %c${(t._whPad - t._whNoise).toFixed(1)}ms%c  ` +
            `harp×9: %c${(t._whHarp - t._whPad).toFixed(1)}ms`,
            'color: #f80; font-weight: bold', 'color: #999',
            'color: #0f0', 'color: #999',
            'color: #0f0', 'color: #999',
            'color: #0f0', 'color: #999',
            'color: #0f0'
          );
        }
      }
      duckOtherRegions(regionId, 'hold');
      if (window._regionSynthDebug) _log(
        `%c[RegionSynth]%c  ${voice.name} → building (${voice.notes.join(', ')})`,
        'color: #f0a; font-weight: bold', 'color: #999'
      );
    }

    startEvolutionLoop();

  } else if (r.state === 'looping') {

    // Thaw frozen region if user interacts
    const freezeCfg = FREEZE_CFG[regionId];
    const voiceState = regionId == 1 ? r.livingWood : regionId == 2 ? r.villagePulse : regionId == 3 ? r.nightSky : regionId == 4 ? r.windHarp : regionId == 5 ? r.celestialStrings : null;
    if (window._regionSynthDebug) {
      _log(`%c[Freeze]%c  Click on looping R${regionId}: cfg=${!!freezeCfg} vs=${!!voiceState} fs=${voiceState?.freezeState}`,
        'color: #f80; font-weight: bold', 'color: #999');
    }
    if (freezeCfg && voiceState) {
      if (voiceState.freezeState === 'frozen') {
        _thawRegion(r, voiceState, freezeCfg);
        voiceState.freezeIdleTime = 0;
        // Fall through to normal click handling — thaw is transparent, click still stops/strums
      } else if (voiceState.freezeState === 'capturing') {
        _abortFreezeCapture(voiceState, freezeCfg.name);
        voiceState.freezeIdleTime = 0;
        // don't return — let the click proceed as normal interaction
      }
      // 'thawing' state: fall through to normal click handling (strum, reshape, etc.)
      voiceState.freezeIdleTime = 0;
    }

    if (voice.reshape) {
      // Strum detection: if second click within strum window, retrigger attack
      const sw = voice.reshape.strumWindow;
      if (sw && r.strumTimer) {
        clearTimeout(r.strumTimer);
        r.strumTimer = null;
        // Only retrigger base synths if not in special mode (harp/LW voices are always active)
        if (regionId === 1 && isLivingWoodActive() && r.livingWood && r.livingWood.active) {
          // Living Wood strum: velocity injection accent.
          // No AudioParam dip (conflicts with per-frame gain updates).
          // No branch boost or FM spike (pushes high-frequency overtones).
          // Accent = strong velocity injection + filter transient (already fires below).
          // Velocity drives all layer dynamics — strum = "inject high velocity momentarily."
          const lw = r.livingWood;
          if (lw) {
            lw.strumVelInjection = Math.min(1.5, lw.strumVelInjection + 0.5);  // additive — builds intensity with rapid strums
          }
        } else if (regionId === 4 && isWindHarpActive() && r.windHarp && r.windHarp.active) {
          // Wind Harp strum: gain-dip pluck on root note (G3)
          // Envelope retrigger doesn't work (sustain=1.0 → attack 1→1, no transient).
          // Instead: dip gain to near-zero, let applyWindHarpV3Params ramp back
          // to ~0.95 on next frame (15ms tau) — creates a ~40dB percussive onset.
          const me = r.mouseExpr;
          const wh = r.windHarp;
          if (me) {
            const up = wh.userParams;
            const intensity = up && up.v3StrumIntensity != null ? up.v3StrumIntensity : 0.8;
            me.v3StrumBoosts[0] = intensity;
            // Gain dip: fast ramp to near-silence → applyWindHarpV3Params ramps up
            if (wh.useWorklet && wh.workletNode) {
              wh.workletNode.port.postMessage({ type: 'strumDip', index: 0, level: 0.01 });
            } else if (wh.harpGains[0]) {
              const now = Tone.now();
              wh.harpGains[0].gain.cancelAndHoldAtTime(now);
              wh.harpGains[0].gain.setTargetAtTime(0.01, now, 0.005);  // 5ms ramp — percussive but click-free
            }
            // Duck pad so harp pluck cuts through
            wh.strumPadDuck = 1.0;
          }
        } else if (regionId === 3 && isNightSkyActive() && r.nightSky && r.nightSky.active) {
          // Night Sky strum: gain-dip pluck on root note (G3) + phaser shimmer
          const me = r.mouseExpr;
          const skyS = r.nightSky;
          if (me) {
            const up = skyS.userParams;
            const intensity = up && up.strumIntensity != null ? up.strumIntensity : 0.85;
            me.v3StrumBoosts[0] = intensity;
            skyS.strumShimmer = Math.min(0.6, skyS.strumShimmer + 0.3);  // soft boost, avoid cancelAndHoldAtTime spam
            if (skyS.useWorklet && skyS.workletNode) {
              skyS.workletNode.port.postMessage({ type: 'strumDip', index: 0, level: 0.01 });
            } else if (skyS.voiceGains[0]) {
              // Direct .value assignment — no scheduled ramps to collide with per-frame writes
              skyS.voiceGains[0].gain.value = 0.01;
            }
            skyS.strumPadDuck = 1.0;
          }
        } else if (regionId === 5 && isCelestialStringsActive() && r.celestialStrings && r.celestialStrings.active) {
          // Celestial Strings strum: gain-dip pluck on root note (G4)
          const me = r.mouseExpr;
          const csS = r.celestialStrings;
          if (me) {
            const up = csS.userParams;
            const intensity = up && up.strumIntensity != null ? up.strumIntensity : 0.8;
            me.csStrumBoosts[0] = intensity;
            if (csS.useWorklet && csS.workletNode) {
              csS.workletNode.port.postMessage({ type: 'strumDip', index: 0, level: 0.01 });
            } else if (csS.stringGains[0]) {
              const now = Tone.now();
              csS.stringGains[0].gain.cancelAndHoldAtTime(now);
              csS.stringGains[0].gain.setTargetAtTime(0.01, now, 0.005);
            }
          }
        } else if (regionId === 2 && r.villagePulse && r.villagePulse.active) {
          // Village Pulse strum: boost bleed (bypasses LFO) for immediate hit
          const vp = r.villagePulse;
          vp.strumInjection = Math.min(1.0, (vp.strumInjection || 0) + 0.4);
        } else {
          retriggerAttack(r, voice);
        }
        fireFilterTransient(r, regionId);
        duckOtherRegions(regionId, 'strum');
        if (window._regionSynthDebug) _log(
          `%c[RegionSynth]%c  ${voice.name} ♪ strum`,
          'color: #f0a; font-weight: bold', 'color: #0cf'
        );
        // Strum is the complete action — start a new strumTimer for the next strum,
        // don't fall through to reshaping (which would fire re-breathe + 2s block).
        buildingRegionId = regionId;
        startEvolutionLoop();
        return;
      }

      if (quickRelease) {
        buildingRegionId = null;
        if (sw) {
          // ── Defer fade-out — might be a strum ──
          r.strumTimer = setTimeout(() => {
            r.strumTimer = null;
            if (r.state === 'looping') fadeOutRegion(r, regionId);
          }, sw);
        } else {
          // ── Tap on active → fade out ──
          fadeOutRegion(r, regionId);
        }
      } else {
        // ── Hold on active → reshape (tap vs hold decided in mouseUp) ──
        r.reshapeStartTime = Tone.now();
        setState(r, regionId, 'reshaping');
        duckOtherRegions(regionId, 'hold');
        fireFilterTransient(r, regionId);
        // Village Pulse: boost bleed on reshape entry
        if (regionId === 2 && r.villagePulse && r.villagePulse.active) {
          const vp = r.villagePulse;
          vp.strumInjection = Math.min(1.0, (vp.strumInjection || 0) + 0.4);
          if (r.loopTarget) r.loopTarget.gain = 1.0;
        }
        // buildingRegionId stays set → mouseUp handles release
        startEvolutionLoop();
        if (window._regionSynthDebug) _log(
          `%c[RegionSynth]%c  ${voice.name} → reshaping (energy: ${r.energy.toFixed(2)})`,
          'color: #f0a; font-weight: bold', 'color: #fa0'
        );
      }
    } else {
      // ── Non-reshape voice: stop looping ──
      buildingRegionId = null;
      fadeOutRegion(r, regionId);
    }
  }
  // 'building' — ignore (user is still holding)
}

/**
 * Called on mouseup. Transitions building voice to looping.
 * Captures hold duration → loop complexity.
 */
export function regionMouseUp() {
  if (buildingRegionId === null) return;

  const r = regions[buildingRegionId];

  if (!r) {
    mouseUpPending = true;
    return;
  }

  const voice = VOICES[buildingRegionId];

  if (r.state === 'building') {
    // ── Building → Looping ──
    r.holdDuration = r.effectiveBuildTime;
    const complexity = Math.min(r.holdDuration / 15, 1);
    r.loopTarget = getLoopTarget(complexity, voice);
    setState(r, buildingRegionId, 'looping');
    unduckOtherRegions(buildingRegionId);

    if (window._regionSynthDebug) _log(
      `%c[RegionSynth]%c  ${voice.name} → looping ` +
      `(held ${r.holdDuration.toFixed(1)}s, complexity ${(complexity * 100).toFixed(0)}%)`,
      'color: #f0a; font-weight: bold', 'color: #999'
    );

  } else if (r.state === 'reshaping') {
    unduckOtherRegions(buildingRegionId);
    const holdTime = Tone.now() - r.reshapeStartTime;

    if (holdTime < voice.reshape.tapThreshold) {
      const sw = voice.reshape.strumWindow;
      if (sw) {
        // ── Defer fade-out — strum window ──
        setState(r, buildingRegionId, 'looping');
        const rid = buildingRegionId;
        r.strumTimer = setTimeout(() => {
          r.strumTimer = null;
          if (r.state === 'looping') fadeOutRegion(r, rid);
        }, sw);
        if (window._regionSynthDebug) _log(
          `%c[RegionSynth]%c  ${voice.name} → strum window (${sw}ms)`,
          'color: #f0a; font-weight: bold', 'color: #0cf'
        );
      } else {
        // ── Tap on active → fade out ──
        fadeOutRegion(r, buildingRegionId);
        if (window._regionSynthDebug) _log(
          `%c[RegionSynth]%c  ${voice.name} → tap off`,
          'color: #f0a; font-weight: bold', 'color: #999'
        );
      }
    } else {
      // ── Hold release → back to looping, energy decays naturally ──
      setState(r, buildingRegionId, 'looping');
      if (window._regionSynthDebug) _log(
        `%c[RegionSynth]%c  ${voice.name} → looping (reshaped, energy: ${r.energy.toFixed(2)})`,
        'color: #f0a; font-weight: bold', 'color: #fa0'
      );
    }
  } else if (r.state === 'looping') {
    // Strum follow-up: mouseUp after a strum (region stayed looping).
    // Set a new strumTimer so the next quick click can also strum.
    const sw = voice.reshape ? voice.reshape.strumWindow : 0;
    if (sw) {
      const rid = buildingRegionId;
      r.strumTimer = setTimeout(() => {
        r.strumTimer = null;
        if (r.state === 'looping') fadeOutRegion(r, rid);
      }, sw);
    }
  }
  // else: not in a holdable state — just clear tracking

  buildingRegionId = null;
}

/**
 * Immediately silence all region voices and reset state.
 */
export function muteAllRegions() {
  buildingRegionId = null;
  mouseUpPending = false;

  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  for (const id in regions) { const r = regions[id];
    if (r.stopTimeouts) {
      r.stopTimeouts.forEach(tid => clearTimeout(tid));
      r.stopTimeouts = null;
    }
    if (r.strumTimer) { clearTimeout(r.strumTimer); r.strumTimer = null; }
    if (r.state === 'off') continue;
    const voice = VOICES[id];

    // Clean up freeze state before deactivating — frozenSource/frozenGain would
    // otherwise stay connected, and freezeState would be inconsistent on reactivation.
    for (const voiceType of ['windHarp', 'livingWood', 'celestialStrings', 'nightSky']) {
      const vs = r[voiceType];
      if (!vs) continue;
      if (vs.freezeState === 'capturing') _abortFreezeCapture(vs, FREEZE_CFG[id]?.name || voiceType);
      if (vs.freezeState === 'frozen') {
        if (vs.frozenSource) { try { vs.frozenSource.stop(); } catch (_) {} try { vs.frozenSource.disconnect(); } catch (_) {} }
        if (vs.frozenGain) { try { vs.frozenGain.disconnect(); } catch (_) {} }
        vs.frozenSource = null;
        vs.frozenGain = null;
        vs.freezeState = 'live';
      }
    }

    r.mainGain.gain.cancelScheduledValues(Tone.now());
    r.mainGain.gain.value = 0;
    r.secondaryGain.gain.value = 0;
    r.deepSend.gain.value = 0;
    r.primarySynth.triggerRelease(voice.notes, Tone.now());
    r.secondarySynth.triggerRelease(voice.notes, Tone.now());
    // Wind harp: immediate deactivation
    if (r.windHarp && r.windHarp.active) {
      r.windHarp.harpMixBus.gain.value = 0;
      r.windHarp.noiseGain.gain.value = 0;
      for (const g of r.windHarp.harpGains) g.gain.value = 0;
      deactivateWindHarp(r);
    }
    // Night Sky: immediate deactivation
    if (r.nightSky && r.nightSky.active) {
      r.nightSky.mixBus.gain.value = 0;
      r.nightSky.deepGain.gain.value = 0;
      r.nightSky.windGain.gain.value = 0;
      r.nightSky.airGain.gain.value = 0;
      r.nightSky.padGain.gain.value = 0;
      deactivateNightSky(r);
    }
    // Living Wood: immediate deactivation
    if (r.livingWood && r.livingWood.active) {
      r.livingWood.cypressMixBus.gain.value = 0;
      r.livingWood.earthGain.gain.value = 0;
      r.livingWood.subGain.gain.value = 0;
      r.livingWood.padGain.gain.value = 0;
      for (const g of r.livingWood.branchGains) g.gain.value = 0;
      deactivateCypressLivingWood(r);
    }
    // Celestial Strings: immediate deactivation
    if (r.celestialStrings && r.celestialStrings.active) {
      r.celestialStrings.starsMixBus.gain.value = 0;
      r.celestialStrings.noiseGain.gain.value = 0;
      r.celestialStrings.padGain.gain.value = 0;
      if (!r.celestialStrings.useWorklet) {
        for (const g of r.celestialStrings.stringGains) g.gain.value = 0;
      } else if (r.celestialStrings.workletNode) {
        r.celestialStrings.workletNode.port.postMessage({ type: 'deactivate' });
      }
      deactivateCelestialStrings(r);
    }
    r.loopTarget = null;
    r.energy = 0;
    r.effectiveBuildTime = 0;
    r.lastTickTime = 0;
    if (r.filterTransient) r.filterTransient.offset = 0;
    // Reset duck state
    if (r.duck) {
      if (r.duck.strumTimer) { clearTimeout(r.duck.strumTimer); r.duck.strumTimer = null; }
      r.duck.gainTarget = 1.0;
      r.duck.filterTarget = 0;
      r.duck.gainCurrent = 1.0;
      r.duck.filterCurrent = 0;
      r.duck.strumRecovery = false;
    }
    setState(r, id, 'off');

    // Reset mouse expression
    if (r.mouseExpr) {
      r.mouseExpr.active = false;
      r.mouseExpr.filterOffset = 0;
      r.mouseExpr.chorusWet = 0;
      r.mouseExpr.reverbOffset = 0;
      r.mouseExpr.capturedFilter = 0;
      r.mouseExpr.capturedChorusWet = 0;
      r.mouseExpr.capturedReverbOffset = 0;
      r.mouseExpr.v3StrumBoosts.fill(0);
      r.mouseExpr.v3LastStrumIndex = -1;
      r.mouseExpr.v3SpaceMacro = 0;
      r.mouseExpr.capturedV3SpaceMacro = 0;
      r.mouseExpr.csStrumBoosts.fill(0);
      r.mouseExpr.csLastStrumIndex = -1;
      r.mouseExpr.csSpaceMacro = 0;
      r.mouseExpr.capturedCsSpaceMacro = 0;
      r.mouseExpr.lwBowPosition = 0.5;
      r.mouseExpr.lwRootDepth = 0;
      r.mouseExpr.lwDragVelocity = 0;
      r.mouseExpr.capturedLwBowPosition = 0;
      r.mouseExpr.capturedLwRootDepth = 0;
    }
    if (r.chorus) r.chorus.wet.value = 0;
  }

  if (window._regionSynthDebug) _log(
    '%c[RegionSynth]%c  All regions muted',
    'color: #f0a; font-weight: bold', 'color: #999'
  );
}

/**
 * Stop a specific region (fade out). Called by ui.js on double-click.
 * Only acts on regions that are looping or reshaping.
 * @param {number} regionId — 1-5
 * @returns {boolean} — true if the region was stopped
 */
export function regionStop(regionId) {
  const r = regions[regionId];
  if (!r) return false;
  if (r.state !== 'looping' && r.state !== 'reshaping') return false;

  // Strum-enabled voices stop via single isolated tap, not double-click.
  // Double-click on Cypress is a strum, not a kill.
  const voice = VOICES[regionId];
  if (voice.reshape && voice.reshape.strumWindow) {
    if (window._regionSynthDebug) _log(
      `%c[RegionSynth]%c  ${voice.name} — ignoring dblclick stop (strum-enabled)`,
      'color: #f0a; font-weight: bold', 'color: #666'
    );
    return false;
  }

  if (r.strumTimer) { clearTimeout(r.strumTimer); r.strumTimer = null; }
  fadeOutRegion(r, regionId);
  return true;
}

// ── Programmatic play/stop (hands-free looping) ─────────────────────────────

/**
 * Compute param targets for a given intensity level.
 * Three stops: 0 → loopTarget (sustain), 0.5 → ceiling (reshape max), 1.0 → absolute max.
 * @param {object} loopTarget — base sustain params from getLoopTarget
 * @param {object|null} ceiling — reshape ceiling from voice config
 * @param {number} intensity — 0-1
 * @param {object} voice — voice config (for buildGainMax)
 * @returns {object} interpolated params
 */
function getIntensityParams(loopTarget, ceiling, intensity, voice) {
  const t = Math.max(0, Math.min(1, intensity));
  if (t === 0) return { ...loopTarget };

  const peak = {
    filter: 1.0, gain: voice.buildGainMax || 1.0, secondary: 1.0,
    deepReverb: 1.0, lfo: 1.0, width: 1.0,
  };
  const mid = ceiling || peak;

  // 0→0.5: loopTarget → ceiling, 0.5→1.0: ceiling → peak
  let a, b, u;
  if (t <= 0.5) {
    a = loopTarget; b = mid; u = t * 2;        // 0-1 within first half
  } else {
    a = mid;        b = peak; u = (t - 0.5) * 2; // 0-1 within second half
  }

  return {
    filter:     a.filter     + u * (b.filter     - a.filter),
    gain:       a.gain       + u * (b.gain       - a.gain),
    secondary:  a.secondary  + u * (b.secondary  - a.secondary),
    deepReverb: a.deepReverb + u * (b.deepReverb - a.deepReverb),
    lfo:        a.lfo        + u * (b.lfo        - a.lfo),
    width:      a.width      + u * (b.width      - a.width),
  };
}

/**
 * Snap a region's audio chain to the given params instantly.
 * Used by playRegion/setRegionIntensity for immediate audibility.
 */
function snapAudioChain(r, regionId, params) {
  const voice = VOICES[regionId];
  const now = Tone.now();
  Object.assign(r.currentParams, params);
  // Also update loopTarget so evolutionTick sustains at this level
  if (r.loopTarget) Object.assign(r.loopTarget, params);
  applyParams(r, regionId, r.currentParams, 1 / 60);
  // Night Sky: use baseGain passthrough, not evolution pump
  const isNSSnap = regionId === 3 && r.nightSky && r.nightSky.active;
  const snapGain = isNSSnap ? r.nightSky.userParams.baseGain : params.gain;
  // Override setTargetAtTime ramps with instant values
  r.mainGain.gain.cancelScheduledValues(now);
  r.mainGain.gain.setValueAtTime(snapGain, now);
  r.filter.frequency.cancelScheduledValues(now);
  r.filter.frequency.setValueAtTime(
    voice.filterClosed * Math.pow(voice.filterOpen / voice.filterClosed, params.filter), now
  );
  r.secondaryGain.gain.cancelScheduledValues(now);
  r.secondaryGain.gain.setValueAtTime(isNSSnap ? 0 : params.secondary, now);
  r.deepSend.gain.cancelScheduledValues(now);
  r.deepSend.gain.setValueAtTime(params.deepReverb * 0.5, now);
}

/**
 * Start a region at max complexity and enter looping state.
 * Simulates a full 15s click-hold-release cycle instantly.
 * The region loops indefinitely until stopRegion() is called.
 * @param {number} regionId — 1-5
 * @param {number} [intensity=0] — 0=sustain, 0.5=mid, 1.0=ceiling
 * @returns {Promise<boolean>} true if playback started
 */
export async function playRegion(regionId, intensity = 0) {
  if (regionId < 1 || regionId > 5) return false;

  // Ensure audio context is initialized AND running.
  try {
    if (!_initComplete) await ensureInit();
    else if (Tone.context && Tone.context.state === 'suspended') await Tone.start();
  } catch (e) {
    console.error('%c[Audio]%c  Audio init failed in playRegion:', 'color: #f44; font-weight: bold', 'color: #999', e);
    return false;  // Bail gracefully
  }
  const r = regions[regionId];
  if (!r) return false;

  // Already active — don't restart
  if (r.state === 'looping' || r.state === 'building' || r.state === 'reshaping') {
    return false;
  }

  // If stopping, let it finish first — don't fight the fade
  if (r.state === 'stopping') return false;

  // Start the build (initializes audio chain, triggers synth attack)
  await regionMouseDown(regionId);

  // Fast-forward to max complexity
  r.effectiveBuildTime = 15;

  // Transition building → looping at complexity 1.0
  regionMouseUp();

  // Snap to requested intensity level
  const voice = VOICES[regionId];
  const ceiling = voice.reshape ? voice.reshape.ceiling : null;
  if (r.loopTarget) {
    const params = getIntensityParams(r.loopTarget, ceiling, intensity, voice);
    snapAudioChain(r, regionId, params);
  }

  // Clean up mouse expression — no physical mouse involved
  const me = r.mouseExpr;
  if (me) {
    me.active = false;
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
    me.capturedFilter = 0;
    me.capturedChorusWet = 0;
    me.capturedReverbOffset = 0;
    me.v3StrumBoosts.fill(0);
    me.v3LastStrumIndex = -1;
    me.v3SpaceMacro = 0;
    me.capturedV3SpaceMacro = 0;
    me.csStrumBoosts.fill(0);
    me.csLastStrumIndex = -1;
    me.csSpaceMacro = 0;
    me.capturedCsSpaceMacro = 0;
  }

  const labels = ['sustain', 'mid', 'ceiling'];
  const label = intensity <= 0 ? labels[0] : intensity >= 1 ? labels[2] : labels[1];
  if (window._regionSynthDebug) _log(
    `%c[RegionSynth]%c  ${voice.name} → playRegion (${label}, intensity=${intensity.toFixed(2)})`,
    'color: #f0a; font-weight: bold', 'color: #0f0'
  );

  return true;
}

/**
 * Change intensity of an already-playing region without restarting.
 * @param {number} regionId — 1-5
 * @param {number} intensity — 0=sustain, 0.5=mid, 1.0=ceiling
 * @returns {boolean} true if intensity changed
 */
export function setRegionIntensity(regionId, intensity) {
  const r = regions[regionId];
  if (!r || r.state !== 'looping') return false;

  const voice = VOICES[regionId];
  const baseLoop = getLoopTarget(1.0, voice);
  const ceiling = voice.reshape ? voice.reshape.ceiling : null;
  const params = getIntensityParams(baseLoop, ceiling, intensity, voice);
  snapAudioChain(r, regionId, params);

  return true;
}

/**
 * Stop a region with graceful fade-out.
 * Works on any active state (building, looping, reshaping).
 * @param {number} regionId — 1-5
 * @returns {boolean} true if stop initiated
 */
export function stopRegion(regionId) {
  const r = regions[regionId];
  if (!r) return false;
  if (r.state === 'off' || r.state === 'stopping') return false;

  // Cancel any pending strum timer
  if (r.strumTimer) { clearTimeout(r.strumTimer); r.strumTimer = null; }

  // If still building, clear the building ID so regionMouseUp doesn't fire later
  if (r.state === 'building' && buildingRegionId === regionId) {
    buildingRegionId = null;
  }

  fadeOutRegion(r, regionId);

  if (window._regionSynthDebug) _log(
    `%c[RegionSynth]%c  ${VOICES[regionId].name} → stopRegion (fading out)`,
    'color: #f0a; font-weight: bold', 'color: #f66'
  );

  return true;
}

// ── Mouse expression (all regions) ───────────────────────────────────────────

/**
 * Activate / deactivate mouse expression tracking for a region.
 * On activate: resets live offsets to 0 so expression starts from neutral.
 * On deactivate: freezes live offsets into captured fields for decay.
 * @param {number} regionId — 1-5
 * @param {boolean} active
 */
export function setMouseExprActive(regionId, active) {
  const r = regions[regionId];
  if (!r || !r.mouseExpr) return;
  const me = r.mouseExpr;
  const name = VOICES[regionId]?.name || regionId;

  if (active) {
    me.active = true;
    me.hoverMode = false;  // fresh activation is always drag mode
    me.lastDragTime = performance.now();  // prevent stale lastDragTime on first frame
    // Reset live offsets — fresh mouse movement starts from neutral
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
    me.v3SpaceMacro = 0;
    me.v3LastStrumIndex = -1;
    me.csSpaceMacro = 0;
    me.csLastStrumIndex = -1;

    // For reshape voices still playing: preserve captured state so re-click
    // continues from the previous spatial position (warm continuation).
    // For fresh starts (state='off'): full reset.
    const voice = VOICES[regionId];
    const isWarm = voice && voice.reshape && r.state && r.state !== 'off';
    if (isWarm) {
      // Scale down captured macro so drag-up gesture still has expressive range.
      // Without this, Y starts near ceiling and drag-up barely changes the sound.
      // 0.5x gives: from Y=1.0 → starts at 0.5 → full sweep to 1.0 on drag-up.
      // Floor of 0.25 prevents near-zero feel on low captures.
      me.capturedV3SpaceMacro = Math.max(
        me.capturedV3SpaceMacro > 0 ? 0.25 : -0.25,
        me.capturedV3SpaceMacro * 0.5
      );
      me.capturedCsSpaceMacro = Math.max(
        me.capturedCsSpaceMacro > 0 ? 0.25 : -0.25,
        me.capturedCsSpaceMacro * 0.5
      );
      // Strum boosts: kept (may still be decaying)
      if (window._regionSynthDebug) _log(
        `%c[MouseExpr]%c  ${name} — Active (warm — captured macro=${me.capturedV3SpaceMacro.toFixed(2)})`,
        'color: #0c6; font-weight: bold', 'color: #999'
      );
    } else {
      me.capturedFilter = 0;
      me.capturedChorusWet = 0;
      me.capturedReverbOffset = 0;
      me.v3StrumBoosts.fill(0);
      me.capturedV3SpaceMacro = 0;
      me.csStrumBoosts.fill(0);
      me.capturedCsSpaceMacro = 0;
      if (window._regionSynthDebug) _log(
        `%c[MouseExpr]%c  ${name} — Active — offsets reset`,
        'color: #0c6; font-weight: bold', 'color: #999'
      );
    }
  } else {
    me.active = false;
    me.hoverMode = false;
    const voice = VOICES[regionId];
    const isWarm = voice && voice.reshape && r.state && r.state !== 'off';

    if (isWarm) {
      // Warm release: ACCUMULATE live into captured so spatial position is preserved
      // across release → re-click cycles. Clamp to prevent unbounded growth.
      me.capturedFilter = Math.max(-1, Math.min(1, me.capturedFilter + me.filterOffset));
      me.capturedChorusWet = Math.max(0, Math.min(1, me.capturedChorusWet + me.chorusWet));
      me.capturedReverbOffset = Math.max(-1, Math.min(1, me.capturedReverbOffset + me.reverbOffset));
      me.capturedV3SpaceMacro = Math.max(-1, Math.min(1, me.capturedV3SpaceMacro + me.v3SpaceMacro));
      me.capturedCsSpaceMacro = Math.max(-1, Math.min(1, me.capturedCsSpaceMacro + me.csSpaceMacro));
    } else {
      // Cold release: overwrite (no previous state to preserve)
      me.capturedFilter = me.filterOffset;
      me.capturedChorusWet = me.chorusWet;
      me.capturedReverbOffset = me.reverbOffset;
      me.capturedV3SpaceMacro = me.v3SpaceMacro;
      me.capturedCsSpaceMacro = me.csSpaceMacro;
    }
    // Zero the live offsets (captured takes over for decay)
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
    me.v3SpaceMacro = 0;
    me.v3LastStrumIndex = -1;
    me.csSpaceMacro = 0;
    me.csLastStrumIndex = -1;
    // Note: strum boosts are NOT zeroed — they decay naturally via per-frame decay
    if (window._regionSynthDebug) _log(
      `%c[MouseExpr]%c  ${name} — Released (${isWarm ? 'warm' : 'cold'}) — captured macro=${me.capturedV3SpaceMacro.toFixed(2)}`,
      'color: #0c6; font-weight: bold', 'color: #999'
    );
  }
}

/**
 * Mark a region's mouse expression as hover mode (cursor released, expression persists).
 * Distinguishes hover from L-key lock — both keep me.active=true, but only hover
 * drives evolution and hover-idle freeze detection.
 */
export function setMouseExprHover(regionId, isHover) {
  const r = regions[regionId];
  if (r && r.mouseExpr) r.mouseExpr.hoverMode = !!isHover;
}

/**
 * Per-mousemove update during a region hold.
 * Returns expression debug data for the overlay (all modes, all regions).
 * @param {number} regionId — 1-5
 * @param {number} dx — raw pixel offset from click origin (positive = right)
 * @param {number} dy — raw pixel offset from click origin (positive = down)
 * @param {number} [edgeNormDistX] — max horizontal drag to canvas edge (px)
 * @param {number} [edgeNormDistY] — max vertical drag to canvas edge (px)
 * @param {number} [dragVelocity] — normalized drag speed 0-1 (0=still, 1=fast)
 * @param {boolean} [isHover] — true when in hover expression mode (button released)
 */
export function setMouseExprDrag(regionId, dx, dy, edgeNormDistX, edgeNormDistY, dragVelocity, isHover) {
  const r = regions[regionId];
  if (!r || !r.mouseExpr || !r.mouseExpr.active) return;
  const me = r.mouseExpr;
  me.lastDragTime = performance.now();  // freeze idle detection: track last cursor activity

  // Normalize to [-1, 1] range (negate dy: screen-up = negative pixels, but "up = brighter")
  // Canvas-responsive normDist: per-axis distance from click origin to canvas edge (passed from ui.js).
  // Cursor at canvas edge = exactly 1.0. Falls back to fixed normDistance if not provided.
  const isV3 = regionId === 4 && horizonSynthMode === 'windHarpV3';
  const isCS = regionId === 5 && starsSynthMode === 'celestialStrings';
  const isLW = regionId === 1 && cypressSynthMode === 'livingWood';
  const isNS = regionId === 3 && skySynthMode === 'nightSky';
  const normDistX = edgeNormDistX || me.normDistance;
  const normDistY = edgeNormDistY || me.normDistance;
  const normX = Math.max(-1, Math.min(1, (dx * me.horizSensitivity) / normDistX));
  const normY = Math.max(-1, Math.min(1, (-dy * me.vertSensitivity) / normDistY));

  if (isLW) {
    // Living Wood: X → Root-to-Crown layer crossfade, Y → root depth macro
    // Left = earth/roots, Center = trunk, Right = canopy/branches
    me.lwBowPosition = (normX + 1) * 0.5;  // map [-1,1] → [0,1]  (0=roots, 0.5=trunk, 1=canopy)
    me.lwRootDepth = normY;                  // map [-1,1] → sul tasto↔sul ponticello
    me.lwDragVelocity = dragVelocity || 0;   // bow speed (smoothed per-frame in apply function)

    // Zero classic expression params so they don't leak
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
  } else if (isV3) {
    // V3: X → strum note selection, Y → delay/echo control
    // Strum triggering: map normX to note index (0-8)
    // In hover mode, require minimum velocity to prevent idle cursor drift from plucking
    const noteIndex = Math.max(0, Math.min(8, Math.floor((normX + 1) / 2 * 9)));
    const lastIdx = me.v3LastStrumIndex;
    const whCfg = VOICES[4] ? VOICES[4].windHarp : null;
    const _canStrum = !isHover || (dragVelocity || 0) > 0.15;

    if (lastIdx === -1) {
      // First drag frame — trigger the note at current position
      if (_canStrum) {
        const up = r.windHarp ? r.windHarp.userParams : null;
        const intensity = up && up.v3StrumIntensity != null ? up.v3StrumIntensity : 0.8;
        me.v3StrumBoosts[noteIndex] = intensity;
        const noteName = whCfg ? whCfg.harpNotes[noteIndex] : noteIndex;
        if (window._regionSynthDebug) _log(
          `%c[V3Strum]%c  FIRST PLUCK  %c${noteName}%c [${noteIndex}]  intensity=${intensity.toFixed(2)}  normX=${normX.toFixed(3)}  delayMix=${normY.toFixed(3)}`,
          'color: #f7c; font-weight: bold', 'color: #999', 'color: #ff0; font-weight: bold', 'color: #999'
        );
      }
      me.v3LastStrumIndex = noteIndex;
    } else if (noteIndex !== lastIdx) {
      // Crossed a note boundary — trigger all intermediate notes (glissando)
      if (_canStrum) {
        const up = r.windHarp ? r.windHarp.userParams : null;
        const intensity = up && up.v3StrumIntensity != null ? up.v3StrumIntensity : 0.8;
        const step = noteIndex > lastIdx ? 1 : -1;
        const triggeredNotes = [];
        for (let i = lastIdx + step; ; i += step) {
          me.v3StrumBoosts[i] = intensity;
          triggeredNotes.push(whCfg ? whCfg.harpNotes[i] : i);
          if (i === noteIndex) break;
        }
        const prevName = whCfg ? whCfg.harpNotes[lastIdx] : lastIdx;
        const dir = step > 0 ? '→ ASC' : '← DESC';
        if (window._regionSynthDebug) _log(
          `%c[V3Strum]%c  ${dir}  %c${prevName}%c → %c${triggeredNotes.join(' → ')}%c  [${lastIdx}→${noteIndex}]  intensity=${intensity.toFixed(2)}  normX=${normX.toFixed(3)}  delayMix=${normY.toFixed(3)}`,
          'color: #f7c; font-weight: bold', 'color: #999',
          'color: #aaa', 'color: #999',
          'color: #ff0; font-weight: bold', 'color: #999'
        );
      }
      me.v3LastStrumIndex = noteIndex;
    }

    // Y → delay mix control
    me.v3SpaceMacro = normY;

    // Zero base expression params so they don't leak into harp
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
  } else if (isCS) {
    // Celestial Strings: X → strum note selection (12 notes), Y → space macro
    const noteIndex = Math.max(0, Math.min(11, Math.floor((normX + 1) / 2 * 12)));
    const lastIdx = me.csLastStrumIndex;
    const csCfg = VOICES[5] ? VOICES[5].celestialStrings : null;
    const _canStrumCS = !isHover || (dragVelocity || 0) > 0.15;

    if (lastIdx === -1) {
      if (_canStrumCS) {
        const up = r.celestialStrings ? r.celestialStrings.userParams : null;
        const intensity = up && up.strumIntensity != null ? up.strumIntensity : 0.8;
        me.csStrumBoosts[noteIndex] = intensity;
        const noteName = csCfg ? csCfg.stringNotes[noteIndex] : noteIndex;
        if (window._regionSynthDebug) _log(
          `%c[CSStrum]%c  FIRST PLUCK  %c${noteName}%c [${noteIndex}]  intensity=${intensity.toFixed(2)}`,
          'color: #c9f; font-weight: bold', 'color: #999', 'color: #ff0; font-weight: bold', 'color: #999'
        );
      }
      me.csLastStrumIndex = noteIndex;
    } else if (noteIndex !== lastIdx) {
      if (_canStrumCS) {
        const up = r.celestialStrings ? r.celestialStrings.userParams : null;
        const intensity = up && up.strumIntensity != null ? up.strumIntensity : 0.8;
        const step = noteIndex > lastIdx ? 1 : -1;
        const triggeredNotes = [];
        for (let i = lastIdx + step; ; i += step) {
          me.csStrumBoosts[i] = intensity;
          triggeredNotes.push(csCfg ? csCfg.stringNotes[i] : i);
          if (i === noteIndex) break;
        }
        const dir = step > 0 ? '→ ASC' : '← DESC';
        if (window._regionSynthDebug) _log(
          `%c[CSStrum]%c  ${dir}  %c${triggeredNotes.join(' → ')}%c  [${lastIdx}→${noteIndex}]`,
          'color: #c9f; font-weight: bold', 'color: #999',
          'color: #ff0; font-weight: bold', 'color: #999'
        );
      }
      me.csLastStrumIndex = noteIndex;
    }

    me.csSpaceMacro = normY;
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
  } else if (isNS) {
    // Night Sky: X → strum note selection (6 notes), Y → space macro
    const noteIndex = Math.max(0, Math.min(NS_VOICE_COUNT - 1, Math.floor((normX + 1) / 2 * NS_VOICE_COUNT)));
    const lastIdx = me.v3LastStrumIndex;
    const _canStrumNS = !isHover || (dragVelocity || 0) > 0.15;
    const NS_NOTE_NAMES = ['G3', 'A3', 'D4', 'F4', 'G4', 'A4'];

    if (lastIdx === -1) {
      if (_canStrumNS) {
        const up = r.nightSky ? r.nightSky.userParams : null;
        const intensity = up && up.strumIntensity != null ? up.strumIntensity : 0.85;
        me.v3StrumBoosts[noteIndex] = intensity;
        // Phaser shimmer on pluck — soft boost to avoid cancelAndHoldAtTime spam
        if (r.nightSky) r.nightSky.strumShimmer = Math.min(0.6, r.nightSky.strumShimmer + 0.3);
        const _nsHier = [0.32, 0.20, 0.29, 0.20, 0.25, 0.20];
        const _baseG = _nsHier[noteIndex] || 0.25, _peakG = _baseG + intensity;
        _log(
          `%c[NSStrum]%c  PLUCK %c${NS_NOTE_NAMES[noteIndex]}%c  base=${_baseG.toFixed(2)} → peak=${_peakG.toFixed(2)} (${(_peakG/_baseG).toFixed(1)}× / +${(20*Math.log10(_peakG/_baseG)).toFixed(1)}dB)  intensity=${intensity.toFixed(2)}  decay=${up?.strumDecay?.toFixed(1) || '?'}`,
          'color: #36d; font-weight: bold', 'color: #999', 'color: #ff0; font-weight: bold', 'color: #999'
        );
      }
      me.v3LastStrumIndex = noteIndex;
    } else if (noteIndex !== lastIdx) {
      if (_canStrumNS) {
        const up = r.nightSky ? r.nightSky.userParams : null;
        const intensity = up && up.strumIntensity != null ? up.strumIntensity : 0.85;
        const step = noteIndex > lastIdx ? 1 : -1;
        const triggeredNotes = [];
        for (let i = lastIdx + step; ; i += step) {
          me.v3StrumBoosts[i] = intensity;
          triggeredNotes.push(NS_NOTE_NAMES[i]);
          if (i === noteIndex) break;
        }
        // Phaser shimmer: soft boost, don't hard-reset on every crossing.
        // Resetting to 0.6 on each note boundary caused cancelAndHoldAtTime spam
        // on phaser wet (100+ crossings/sec during fast drag → crackling).
        // Instead, nudge toward 0.6 — shimmer builds during drag, decays after.
        if (r.nightSky) r.nightSky.strumShimmer = Math.min(0.6, r.nightSky.strumShimmer + 0.15);
        const dir = step > 0 ? '→ ASC' : '← DESC';
        const _nsHier2 = [0.32, 0.20, 0.29, 0.20, 0.25, 0.20];
        const _baseG = _nsHier2[noteIndex] || 0.25, _peakG = _baseG + intensity;
        _log(
          `%c[NSStrum]%c  ${dir} %c${triggeredNotes.join(' → ')}%c  base=${_baseG.toFixed(2)} → peak=${_peakG.toFixed(2)} (+${(20*Math.log10(_peakG/_baseG)).toFixed(1)}dB)`,
          'color: #36d; font-weight: bold', 'color: #999',
          'color: #ff0; font-weight: bold', 'color: #999'
        );
      }
      me.v3LastStrumIndex = noteIndex;
    }

    me.v3SpaceMacro = normY;
    me.filterOffset = 0;
    me.chorusWet = 0;
    me.reverbOffset = 0;
  } else if (regionId === 2) {
    // Village Pulse: Y → proximity, X → rate/filter sweep
    me.filterOffset = normY * me.maxFilterFraction;
    me.vhXFilterExpr = normX;  // [-1,1] left=dark/closed, right=bright/open
    me.vhDragVelocity = dragVelocity || 0;

    me.chorusWet = 0;
    me.reverbOffset = 0;
  } else {
    // Classic expression: Y → filter, X → chorus/reverb
    me.filterOffset = normY * me.maxFilterFraction;
    me.chorusWet = Math.max(0, normX) * me.maxWidthRange;
    me.reverbOffset = normX * me.maxWidthRange * 0.5;
  }

  // Always return debug data for the expression overlay (all modes, all regions)
  const voice = VOICES[regionId];
  const result = {
    normX, normY, normDistX, normDistY, rawDx: dx, rawDy: dy,
    regionId,
    regionName: voice ? voice.name : `Region ${regionId}`,
    mode: isLW ? 'livingWood' : isCS ? 'celestialStrings' : regionId === 4 ? 'windHarpV3' : regionId === 3 ? 'nightSky' : 'standard',
  };
  // Living Wood extra: show crown position + root depth + active blooms
  if (isLW) {
    result.lwBowPosition = me.lwBowPosition;
    result.lwRootDepth = me.lwRootDepth;
    result.lwDragVelocity = me.lwDragVelocity || 0;
    const r1 = regions[1];
    if (r1 && r1.livingWood) {
      result.lwSmoothedVelocity = r1.livingWood.smoothedVelocity || 0;
    }
  }
  // V3 extra: show current note
  if (isV3) {
    const whCfg = VOICES[4].windHarp;
    const noteIndex = me.v3LastStrumIndex;
    result.v3NoteIndex = noteIndex;
    result.v3NoteName = noteIndex >= 0 && whCfg ? whCfg.harpNotes[noteIndex] : '—';
    result.v3SpaceMacro = me.v3SpaceMacro;
  }
  // CS extra: show current note
  if (isCS) {
    const csCfg = VOICES[5].celestialStrings;
    const noteIndex = me.csLastStrumIndex;
    result.csNoteIndex = noteIndex;
    result.csNoteName = noteIndex >= 0 && csCfg ? csCfg.stringNotes[noteIndex] : '—';
    result.csSpaceMacro = me.csSpaceMacro;
  }
  return result;
}

/**
// ── Horizon synth param exports ───────────────────────────────────────────────


/**
 * Set a wind harp user-adjustable parameter from UI sliders.
 * @param {string} name — one of: autoFilterOctaves, phaserMaxWet, tremoloRate,
 *                         tremoloMaxDepth, delayTime, delayFeedback
 * @param {number} value
 */
const WIND_HARP_BOUNDS = {
  autoFilterOctaves:     [0, 5],
  phaserMaxWet:          [0, 0.7],
  tremoloRate:           [0.05, 2.0],
  tremoloMaxDepth:       [0, 1],
  delayTime:             [0.05, 1.0],
  delayFeedback:         [0, 0.85],
  // V3 strum expression
  v3StrumIntensity:      [0, 1],
  v3StrumDecay:          [1, 8],
  v3GateFloor:           [0, 0.3],
  v3NoiseMix:            [0, 1],
  v3PadMix:              [-24, 6],
  v3HarpVolume:          [-24, 6],
  v3HarpBrightness:      [-1, 1],
  v3ReverbMix:           [0, 1],
  v3ReverbSize:          [0, 1],
};

export function setWindHarpParam(name, value) {
  const r = regions[4];
  if (!r || !r.windHarp) return;
  const up = r.windHarp.userParams;
  if (!(name in up)) return;
  const bounds = WIND_HARP_BOUNDS[name];
  if (bounds) value = Math.max(bounds[0], Math.min(bounds[1], value));
  up[name] = value;
}

// ── Night Sky param setter ──────────────────────────────────────────────────

const NIGHT_SKY_BOUNDS = {
  noiseMix:        [0, 1],
  padMix:          [0, 1],
  voiceVolume:     [0, 1],
  brightness:      [-1, 1],
  strumIntensity:  [0, 1],
  strumDecay:      [0.5, 8],
  reverbMix:       [0, 1],
  reverbSize:      [0, 1],
  delayMix:        [0, 0.5],
  phaserWet:       [0, 0.8],
  baseGain:        [0.1, 1.0],
};

export function setNightSkyParam(name, value) {
  const r = regions[3];
  if (!r || !r.nightSky) return;
  const up = r.nightSky.userParams;
  if (!(name in up)) return;
  const bounds = NIGHT_SKY_BOUNDS[name];
  if (bounds) value = Math.max(bounds[0], Math.min(bounds[1], value));
  up[name] = value;
}

/**
 * Diagnostic snapshot for Night Sky — per-layer gain levels.
 * Call from console: window._nsDiag()
 */
export function getNightSkyDiag() {
  const r = regions[3];
  if (!r || !r.nightSky) return null;
  const sky = r.nightSky;
  const me = r.mouseExpr;
  const NS_NOTE_NAMES = ['G3', 'A3', 'D4', 'F4', 'G4', 'A4'];

  const voiceGains = {};
  for (let i = 0; i < NS_VOICE_COUNT; i++) {
    voiceGains[NS_NOTE_NAMES[i]] = {
      workletBuf: sky._workletGainBuf[i].toFixed(4),
      strumBoost: me && me.v3StrumBoosts ? me.v3StrumBoosts[i].toFixed(3) : '0',
    };
  }

  return {
    active: sky.active,
    layers: {
      deepNoise: sky.deepGain.gain.value.toFixed(5),
      windNoise: sky.windGain.gain.value.toFixed(5),
      airNoise: sky.airGain.gain.value.toFixed(5),
      pad: sky.padGain.gain.value.toFixed(4),
      mixBus: sky.mixBus.gain.value.toFixed(3),
    },
    fx: {
      phaserWet: sky.phaser.wet.value.toFixed(3),
      delayWet: sky.delay.wet.value.toFixed(3),
      reverbSend: sky.reverbSend.gain.value.toFixed(3),
    },
    voices: voiceGains,
    userParams: { ...sky.userParams },
    gusts: {
      deep: { phase: sky.deepGustPhase.toFixed(3), rate: sky.deepGustRate.toFixed(4) },
      wind: { phase: sky.windGustPhase.toFixed(3), rate: sky.windGustRate.toFixed(4) },
      air: { phase: sky.airGustPhase.toFixed(3), rate: sky.airGustRate.toFixed(4) },
    },
  };
}

// Console shortcut: _nsDiag() for single snapshot
// Console shortcut: _nsWatch() to start 1/sec continuous logging, _nsWatch() again to stop
if (typeof window !== 'undefined') {
  window._nsDiag = () => {
    const d = getNightSkyDiag();
    if (!d) { _log('[NightSky] Not active'); return; }
    _log('%c[NightSky Diag]', 'color: #36d; font-weight: bold');
    _log('  Layers:', d.layers);
    _log('  FX:', d.fx);
    _log('  Voices:', d.voices);
    _log('  Gusts:', d.gusts);
    _log('  Params:', d.userParams);
    return d;
  };

  let _nsWatchTimer = null;
  window._nsWatch = () => {
    if (_nsWatchTimer) {
      clearInterval(_nsWatchTimer);
      _nsWatchTimer = null;
      _log('%c[NightSky]%c  Watch stopped', 'color: #36d; font-weight: bold', 'color: #999');
      return;
    }
    _log('%c[NightSky]%c  Watch started (1/sec) — call _nsWatch() again to stop', 'color: #36d; font-weight: bold', 'color: #999');
    _nsWatchTimer = setInterval(() => {
      const r = regions[3];
      if (!r || !r.nightSky || !r.nightSky.active) return;
      const sky = r.nightSky;
      const mixBus = sky.mixBus.gain.value;
      const mainGain = r.mainGain.gain.value;
      const filterHz = r.filter.frequency.value;
      const BASE_AMP = 0.1625;  // worklet BASE_AMPLITUDE

      // Effective output per layer (what actually reaches the speaker)
      const v = sky._workletGainBuf;
      const voiceSum = Array.from({length: 6}, (_, i) => v[i]).reduce((a, b) => a + b, 0);
      const voiceOut = voiceSum * BASE_AMP * mixBus * mainGain;
      const padOut = sky.padGain.gain.value * mixBus * mainGain;
      const noiseOut = (sky.deepGain.gain.value + sky.windGain.gain.value + sky.airGain.gain.value) * mixBus * mainGain;
      const totalOut = voiceOut + padOut + noiseOut;

      // Per-voice effective levels
      const vEff = ['G3','A3','D4','F4','G4','A4'].map((n, i) => {
        const eff = v[i] * BASE_AMP * mixBus * mainGain;
        return `${n}:${(eff * 1000).toFixed(1)}`;
      }).join(' ');

      // Layer percentages
      const vPct = totalOut > 0 ? (voiceOut / totalOut * 100).toFixed(0) : '0';
      const pPct = totalOut > 0 ? (padOut / totalOut * 100).toFixed(0) : '0';
      const nPct = totalOut > 0 ? (noiseOut / totalOut * 100).toFixed(0) : '0';

      _log(
        `%c[NS MIX]%c  voices=${voiceOut.toFixed(3)}(${vPct}%)  pad=${padOut.toFixed(3)}(${pPct}%)  noise=${noiseOut.toFixed(4)}(${nPct}%)  total=${totalOut.toFixed(3)}  filter=${filterHz.toFixed(0)}Hz  main=${mainGain.toFixed(2)}  mix=${mixBus.toFixed(2)}`,
        'color: #36d; font-weight: bold', 'color: #aaa'
      );
      _log(
        `%c[NS VOICES]%c  effective(×1000): ${vEff}`,
        'color: #369; font-weight: bold', 'color: #888'
      );
    }, 1000);
  };

  // Live accessor for the Night Sky state object — handy for console tuning.
  // Example: _ns.voiceComp.threshold.value = -10
  Object.defineProperty(window, '_ns', {
    get() { return regions[3] && regions[3].nightSky ? regions[3].nightSky : null; },
    configurable: true,
  });

  // Toggle-mute layers via graph disconnect/reconnect (diagnostic).
  //   _nsMute('pad')    — Layer B (FM sub-pad)
  //   _nsMute('noise')  — Layer A (all 3 noise bands)
  //   _nsMute('deep' | 'wind' | 'air')  — individual noise band
  window._nsMute = (layer) => {
    const r = regions[3];
    if (!r || !r.nightSky) { _log('[NightSky] Not active'); return; }
    const sky = r.nightSky;
    const state = window._nsMuteState || (window._nsMuteState = {});
    const nodes = {
      pad:  [sky.padGain,  sky.mixBus],
      deep: [sky.deepNoise, sky.deepGain],
      wind: [sky.windNoise, sky.windGain],
      air:  [sky.airNoise,  sky.airGain],
    };
    const flip = (key) => {
      const [src, dst] = nodes[key];
      if (state[key]) { src.connect(dst); state[key] = false; }
      else            { src.disconnect(dst); state[key] = true; }
    };
    if (layer === 'noise') {
      ['deep','wind','air'].forEach(flip);
      _log(`[_nsMute] noise → deep:${state.deep?'muted':'on'} wind:${state.wind?'muted':'on'} air:${state.air?'muted':'on'}`);
    } else if (nodes[layer]) {
      flip(layer);
      _log(`[_nsMute] ${layer} → ${state[layer] ? 'MUTED' : 'UNMUTED'}`);
    } else {
      _log('[_nsMute] usage: _nsMute("pad" | "noise" | "deep" | "wind" | "air")');
    }
  };
}

// ── Living Wood param setter ──────────────────────────────────────────────────

const LIVING_WOOD_BOUNDS = {
  earthMix:         [0, 1],
  subMix:           [0, 1],
  padMix:           [0, 2],
  trunkHarmonicity: [0.25, 2.0],
  branchVolume:     [0, 1],
  velocitySensitivity: [0.2, 2.0],
  reverbMix:        [0, 1],
  phaserWet:        [0, 0.8],
  delayMix:         [0, 0.6],
};

export function setCypressLivingWoodParam(name, value) {
  const r = regions[1];
  if (!r || !r.livingWood) return;
  const up = r.livingWood.userParams;
  if (!(name in up)) return;
  const bounds = LIVING_WOOD_BOUNDS[name];
  if (bounds) value = Math.max(bounds[0], Math.min(bounds[1], value));
  up[name] = value;
  // Special: harmonicity needs direct synth update
  if (name === 'trunkHarmonicity' && r.livingWood.trunkPad) {
    r.livingWood.trunkPad.set({ harmonicity: value });
  }
}

// ── Celestial Strings param setter (parallel to Wind Harp / Living Wood) ──

const CELESTIAL_STRINGS_BOUNDS = {
  noiseMix:         [0, 1],
  padMix:           [0, 1],
  stringVolume:     [0, 1],
  stringBrightness: [-1, 1],
  reverbMix:        [0, 0.5],
  reverbSize:       [0.1, 0.99],
  phaserWet:        [0, 0.8],
  delayMix:         [0, 0.3],
  strumIntensity:   [0, 1],
  strumDecay:       [0.5, 10],
  gateFloor:        [0.01, 0.5],
};

export function setCelestialStringsParam(name, value) {
  const r = regions[5];
  if (!r || !r.celestialStrings) return;
  const up = r.celestialStrings.userParams;
  if (!(name in up)) return;
  const bounds = CELESTIAL_STRINGS_BOUNDS[name];
  if (bounds) value = Math.max(bounds[0], Math.min(bounds[1], value));
  up[name] = value;
}

export function setVillagePulseParam(name, value) {
  const r = regions[2];
  if (!r || !r.villagePulse) return;
  const vp = r.villagePulse;
  switch (name) {
    // Layer A: Low foundation
    case 'lowPadVol':
      vp.lowPad.volume.value = value;
      break;
    case 'lowFmDepth':
      vp.lowPad.set({ modulationIndex: value });
      break;
    // Layer B: Pad
    case 'padVol':
      vp.pad.volume.value = value;
      break;
    case 'fmDepth':
      vp.pad.set({ modulationIndex: value });
      break;
    case 'tremoloRate':
      vp.tremolo.frequency.value = value;
      break;
    // Layer C: Overtones
    case 'overtoneVol':
      vp.overtoneBus.gain.value = Math.max(0, Math.min(1, value));
      break;
    // Ambient bleed
    case 'bleed':
      vp.bleed.gain.value = Math.max(0, Math.min(0.3, value));
      break;
    // Phaser
    case 'phaserWet':
      vp.phaser.wet.value = Math.max(0, Math.min(1, value));
      break;
    case 'phaserRate':
      vp.phaser.frequency.value = Math.max(0.01, Math.min(0.5, value));
      break;
    // Delay
    case 'delayTime':
      vp.delay.delayTime.value = Math.max(0.01, Math.min(0.5, value));
      break;
    case 'delayFeedback':
      vp.delay.feedback.value = Math.max(0, Math.min(0.8, value));
      break;
    case 'delayWet':
      vp.delay.wet.value = Math.max(0, Math.min(1, value));
      break;
    // Reverb (room)
    case 'reverbRoom':
      vp.reverb.roomSize.value = Math.max(0.05, Math.min(0.8, value));
      break;
    case 'reverbDamp':
      vp.reverb.dampening.value = Math.max(200, Math.min(8000, value));
      break;
    case 'reverbWet':
      vp.reverb.wet.value = Math.max(0, Math.min(1, value));
      break;
    // LFO
    case 'lfoShape':
      vp.lfo.type = value;
      break;
    case 'lfoMinRate':
      vp.lfoMinRate = Math.max(0.1, value);
      break;
    case 'lfoMaxRate':
      vp.lfoMaxRate = Math.max(0.5, value);
      break;
  }
}

export function getVillagePulseLfoRate() {
  const r = regions[2];
  if (!r || !r.villagePulse) return 0;
  return r.villagePulse.currentRate || 0;
}

/**
 * Test whether worklet audio reaches the output by muting Tone.js layers.
 * Run while a region is active. If sound vanishes, the worklet bridge is broken.
 *
 * Usage: _workletBridgeTest('wh')   — mutes WH noise + pad, leaves worklet harp
 *        _workletBridgeTest('lw')   — mutes LW earth + pad, leaves worklet branches
 *        _workletBridgeTest('cs')   — mutes CS noise + pad, leaves worklet strings
 *        _workletBridgeTest('restore') — restores all muted layers
 */
export function workletBridgeTest(region) {
  if (region === 'restore') {
    const r4 = regions[4];
    if (r4 && r4.windHarp) {
      r4.windHarp.noiseGain.gain.value = 1.0;
      r4.windHarp.harpPad.volume.value = -12;
    }
    const r1 = regions[1];
    if (r1 && r1.livingWood) {
      r1.livingWood.earthGain.gain.value = 1.0;
      r1.livingWood.padGain.gain.value = 1.0;
    }
    const r5 = regions[5];
    if (r5 && r5.celestialStrings) {
      r5.celestialStrings.noiseGain.gain.value = 1.0;
      r5.celestialStrings.padGain.gain.value = 1.0;
    }
    _log('%c[BridgeTest]%c  All Tone.js layers restored', 'color: #0f0; font-weight: bold', 'color: #999');
    return;
  }
  if (region === 'wh') {
    const wh = regions[4] && regions[4].windHarp;
    if (!wh) return console.warn('[BridgeTest] Wind Harp not built');
    if (!wh.active) return console.warn('[BridgeTest] Wind Harp not active — activate Horizon first');
    wh.noiseGain.gain.value = 0;
    wh.harpPad.volume.value = -Infinity;
    _log('%c[BridgeTest]%c  WH noise + pad MUTED. If harp notes vanish → worklet bridge broken.',
      'color: #f80; font-weight: bold', 'color: #999');
    _log('  Run _workletBridgeTest("restore") to undo.');
  } else if (region === 'lw') {
    const lw = regions[1] && regions[1].livingWood;
    if (!lw) return console.warn('[BridgeTest] Living Wood not built');
    if (!lw.active) return console.warn('[BridgeTest] Living Wood not active — activate Cypress first');
    lw.earthGain.gain.value = 0;
    lw.padGain.gain.value = 0;
    _log('%c[BridgeTest]%c  LW earth + pad MUTED. If branch overtones vanish → worklet bridge broken.',
      'color: #f80; font-weight: bold', 'color: #999');
    _log('  Run _workletBridgeTest("restore") to undo.');
  } else if (region === 'cs') {
    const cs = regions[5] && regions[5].celestialStrings;
    if (!cs) return console.warn('[BridgeTest] Celestial Strings not built');
    if (!cs.active) return console.warn('[BridgeTest] Celestial Strings not active — activate a star first');
    cs.noiseGain.gain.value = 0;
    cs.padGain.gain.value = 0;
    _log('%c[BridgeTest]%c  CS noise + pad MUTED. If string notes vanish → worklet bridge broken.',
      'color: #f80; font-weight: bold', 'color: #999');
    _log('  Run _workletBridgeTest("restore") to undo.');
  } else {
    _log('Usage: _workletBridgeTest("wh" | "lw" | "cs" | "restore")');
  }
}

/**
 * Diagnostic snapshot for Living Wood (Cypress) — parallel to getWindHarpV3Diag().
 */

export function getCypressLivingWoodDiag() {
  const r = regions[1];
  if (!r || !r.livingWood) return null;
  const lw = r.livingWood;
  const me = r.mouseExpr;
  const snap = {
    active: lw.active,
    mode: cypressSynthMode,
    bowPosition: me ? me.lwBowPosition + me.capturedLwBowPosition : 0.5,
    contactPoint: me ? me.lwRootDepth + me.capturedLwRootDepth : 0,
    smoothedVelocity: lw.smoothedVelocity,
    scordaturaPhase: lw.scordaturaPhase,
    gustPhase: lw.gustPhase,
    gustRate: lw.gustRate,
    trunkModIndex: lw.trunkModIndex,
    branchGains: lw.branchGains.map(g => g.gain.value),
    lfoPhases: [...lw.lfoPhases],
    userParams: { ...lw.userParams },
    meters: {
      preFx: lw.meterPreFx ? lw.meterPreFx.getValue() : -Infinity,
      postLimiter: lw.meterPostLimiter ? lw.meterPostLimiter.getValue() : -Infinity,
      earth: lw.meterEarth ? lw.meterEarth.getValue() : -Infinity,
      pad: lw.meterPad ? lw.meterPad.getValue() : -Infinity,
      branch: lw.meterBranch ? lw.meterBranch.getValue() : -Infinity,
    },
    peaks: {
      limiterGR: lw.peakLimiterGR,
      preFx: lw.peakPreFx,
      postLimiter: lw.peakPostLimiter,
    },
    // Strum (bow accent) state
    strumVelInjection: lw.strumVelInjection,
    // Portato state
    portatoPhase: lw.portatoPhase || 0,
  };
  // Reset peaks after read (per-window, not session-cumulative)
  lw.peakLimiterGR = 0;
  lw.peakPreFx = -Infinity;
  lw.peakPostLimiter = -Infinity;
  return snap;
}

/** Lightweight per-frame getter: returns the 12-element Float32Array of per-note LFO values (0–1), or null. */
export function getCelestialStringsBreathing() {
  const r = regions[5];
  if (!r || !r.celestialStrings || !r.celestialStrings.active) return null;
  return r.celestialStrings._lfoBreathing;
}

/**
 * Fire a Celestial Strings strum from external code (e.g., star click).
 * Plucks the root note (G4), fires filter transient, and ducks other regions.
 * Safe to call when CS is inactive — early-returns with no effect.
 */
export function fireStarsStrum() {
  const r = regions[5];
  if (!r) return;
  const state = r.state;
  if (state !== 'looping' && state !== 'building' && state !== 'reshaping') return;

  // CS chord strum: pluck root (G4) + fifth (D5) + octave (G5) for an
  // impactful percussive hit across the register. Each string gets a strum
  // boost that decays independently via the per-frame apply function.
  if (isCelestialStringsActive() && r.celestialStrings && r.celestialStrings.active) {
    const me = r.mouseExpr;
    const csS = r.celestialStrings;
    if (me) {
      const up = csS.userParams;
      const intensity = up && up.strumIntensity != null ? up.strumIntensity : 0.8;
      const now = Tone.now();
      // Pluck root (G4=0), fifth (D5=4), octave (G5=7) — Gm power chord
      const pluckIndices = [0, 4, 7];
      for (const idx of pluckIndices) {
        me.csStrumBoosts[idx] = intensity;
        if (csS.useWorklet && csS.workletNode) {
          csS.workletNode.port.postMessage({ type: 'strumDip', index: idx, level: 0.01 });
        } else if (csS.stringGains[idx]) {
          csS.stringGains[idx].gain.cancelAndHoldAtTime(now);
          csS.stringGains[idx].gain.setTargetAtTime(0.01, now, 0.005);
        }
      }
    }
  }

  fireFilterTransient(r, 5);
  duckOtherRegions(5, 'strum');
  if (window._regionSynthDebug) _log(
    `%c[RegionSynth]%c  Stars ♪ strum (external)`,
    'color: #f0a; font-weight: bold', 'color: #0cf'
  );
}

/** Lightweight per-frame getter: returns the live Float32Array(12) of per-note strum boosts, or null. Zero-copy. */
export function getCelestialStrumBoosts() {
  const r = regions[5];
  if (!r || !r.mouseExpr) return null;
  return r.mouseExpr.csStrumBoosts;
}

/** Lightweight per-frame getter: returns the computed Y-macro value (-1 to 1), or 0 if inactive. */
export function getCelestialStringsYMacro() {
  const r = regions[5];
  if (!r || !r.celestialStrings || !r.celestialStrings.active) return 0;
  const mc = r.celestialStrings._macroCache;
  return mc ? mc.y : 0;
}

/**
 * Lightweight macro cache for Tone panel deltas — avoids full diagnostic build.
 * Returns { reverbWet, roomSize, delayWet, strumDecay } or null.
 */
export function getCelestialStringsMacro() {
  const r = regions[5];
  if (!r || !r.celestialStrings) return null;
  const mc = r.celestialStrings._macroCache;
  if (!mc) return null;
  return {
    reverbWet:  mc.finalReverbWet || 0,
    roomSize:   mc.finalRoomSize || 0.85,
    delayWet:   mc.finalDelayWet || 0,
    strumDecay: mc.effectiveDecay || 2.5,
  };
}

/**
 * Diagnostic snapshot for Celestial Strings (Stars) — parallel to getWindHarpV3Diag().
 */
export function getCelestialStringsDiag() {
  const r = regions[5];
  if (!r || !r.celestialStrings || starsSynthMode !== 'celestialStrings') return null;
  const cs = r.celestialStrings;
  const me = r.mouseExpr;
  const csCfg = VOICES[5].celestialStrings;
  const up = cs.userParams;

  // Strum state
  const strumBoosts = me ? Array.from(me.csStrumBoosts).map(v => v.toFixed(3)) : new Array(12).fill('0');
  const lastStrumIndex = me ? me.csLastStrumIndex : -1;
  const lastNoteName = lastStrumIndex >= 0 ? csCfg.stringNotes[lastStrumIndex] : '—';

  // Macro-derived values
  const mc = cs._macroCache || {};

  // Per-note state
  const notes = {};
  for (let i = 0; i < csCfg.stringNotes.length; i++) {
    const gain = cs.useWorklet ? cs._workletGainBuf[i] : (cs.stringGains[i] ? cs.stringGains[i].gain.value : 0);
    const phase = cs.lfoPhases[i];
    const boost = me ? me.csStrumBoosts[i] : 0;
    notes[csCfg.stringNotes[i]] = {
      gain: gain.toFixed(3),
      strumBoost: boost.toFixed(3),
      rate: csCfg.lfoRates[i] + 's',
      phase: (phase / Math.PI).toFixed(2) + 'π',
    };
  }

  // Region evolution state
  const cp = r.currentParams || {};
  const secondary = cp.secondary || 0;
  const secClamped = Math.min(1.0, secondary * 1.5);
  const volEnv = 0.35 + 0.65 * secClamped;

  const result = {
    strum: {
      lastNote:    lastNoteName,
      lastIndex:   lastStrumIndex,
      intensity:   (up.strumIntensity || 0.8).toFixed(2),
      decayRate:   (up.strumDecay || 2.5).toFixed(1),
      boosts:      strumBoosts,
      mouseActive: me ? me.active : false,
    },
    space: {
      macro:          (mc.y || 0).toFixed(3),
      reverbWet:      (mc.finalReverbWet || 0).toFixed(3),
      reverbRoom:     (mc.finalRoomSize || 0.85).toFixed(3),
      delayWet:       (mc.finalDelayWet || 0).toFixed(3),
      delayFeedback:  (mc.finalFeedback || 0).toFixed(3),
      coldReverbWet:  (mc.coldReverbWet || 0).toFixed(3),
      strumDecay:     (mc.effectiveDecay || 2.5).toFixed(2),
    },
    levels: {
      airDb:          cs.meterAir ? cs.meterAir.getValue().toFixed(1) + 'dB' : '—',
      padDb:          cs.meterPad ? cs.meterPad.getValue().toFixed(1) + 'dB' : '—',
      stringsDb:      cs.meterStrings ? cs.meterStrings.getValue().toFixed(1) + 'dB' : '—',
      limiterGR:      cs.limiter ? cs.limiter.reduction.toFixed(1) + 'dB' : '—',
      peakLimiterGR:  cs.peakLimiterGR.toFixed(1) + 'dB',
      meterPreFx:     cs.meterPreFx ? cs.meterPreFx.getValue().toFixed(1) + 'dB' : '—',
      peakPreFx:      isFinite(cs.peakPreFx) ? cs.peakPreFx.toFixed(1) + 'dB' : '—',
      meterPostLimiter: cs.meterPostLimiter ? cs.meterPostLimiter.getValue().toFixed(1) + 'dB' : '—',
      peakPostLimiter: isFinite(cs.peakPostLimiter) ? cs.peakPostLimiter.toFixed(1) + 'dB' : '—',
      masterLimiterGR: masterLimiter ? masterLimiter.reduction.toFixed(1) + 'dB' : '—',
      peakMasterLimiterGR: peakMasterLimiterGR.toFixed(1) + 'dB',
      noiseGain:      cs.noiseGain.gain.value.toFixed(3),
      padGain:        cs.padGain.gain.value.toFixed(3),
      mixBus:         cs.starsMixBus.gain.value.toFixed(3),
    },
    region: {
      state:       r.state,
      secondary:   secondary.toFixed(3),
      volEnvelope: volEnv.toFixed(3),
      filter:      (cp.filter || 0).toFixed(3),
      width:       (cp.width || 0).toFixed(3),
    },
    dynamics: {
      gustPhase:   cs.gustPhase.toFixed(3),
      gustRate:    cs.gustRate.toFixed(4),
      padModIndex: cs.padModIndex.toFixed(3),
    },
    notes,
    userParams: { ...up },
  };

  // Reset running peaks after read
  cs.peakLimiterGR = 0;
  cs.peakPreFx = -Infinity;
  cs.peakPostLimiter = -Infinity;
  peakMasterLimiterGR = 0;

  return result;
}

// ── Shared node access ───────────────────────────────────────────────────────

/** Return the master limiter node so other audio modules can connect to it. */
export function getMasterLimiter() { return masterLimiter; }

/** Current audio mode: 'nocturne' | 'radiant'. Toggled by setAudioMode(). */
export function getActiveMode() { return _activeMode; }

/** Invalidate all freeze-tap buffers on mode change. A captured buffer holds
 *  audio baked in the old mode; playing it post-swap would loop wrong-key
 *  content. Two paths:
 *   - 'capturing': abort the in-flight capture (the buffer being recorded
 *     mid-swap would contain mixed-mode audio — discard it).
 *   - 'frozen' / 'thawing': fade the live playback down over 50 ms before
 *     resetting state, so the transition back to live-synth playback doesn't
 *     click. The next idle cycle (FREEZE_IDLE_DELAY seconds) will start a
 *     fresh capture in the new mode. */
function _invalidateFreezeTaps() {
  const now = (typeof Tone !== 'undefined' && Tone.now) ? Tone.now() : 0;
  for (let id = 1; id <= 5; id++) {
    const r = regions[id];
    if (!r) continue;
    const subs = ['livingWood', 'villagePulse', 'nightSky', 'windHarp', 'celestialStrings'];
    for (const key of subs) {
      const vs = r[key];
      if (!vs || !vs.freezeState) continue;
      if (vs.freezeState === 'capturing') {
        if (vs.freezeTap) {
          try { vs.freezeTap.port.postMessage({ type: 'abortCapture' }); } catch (e) {}
        }
        vs.freezeState = 'live';
        vs.freezeIdleTime = 0;
      } else if (vs.freezeState === 'frozen' || vs.freezeState === 'thawing') {
        if (vs.frozenGain) {
          try {
            vs.frozenGain.gain.cancelScheduledValues(now);
            vs.frozenGain.gain.rampTo(0, 0.05);
          } catch (e) {}
        }
        vs.freezeState = 'live';
        vs.freezeIdleTime = 0;
      }
    }
  }
}

/** Live-retune audio from Nocturne (G minor) to Radiant (G major) or back.
 *  - Mutates VOICES note arrays so the ~23 triggerAttack call sites pick up
 *    new-mode notes automatically (Strategy B).
 *  - Glides every active PolySynth voice via FMSynth.detune (fans to
 *    carrier + modulator, preserving sideband structure).
 *  - Glides every per-synth voice in non-worklet fallback arrays
 *    (sky.synths, harpSynths, stringSynths, branchSynths) via their own
 *    detune signals.
 *  - Sends 'frequencies' retune messages to all 5 worklets. VP uses its
 *    existing 'config' message shape (same payload field name).
 *  - Sets `_modeGainMul` which feeds into applyParams' mainGainLevel + the
 *    worklet gain-send multiplier; evolution tick smooths the transition
 *    via its existing setTargetAtTime tau=15 ms.
 *  - Invalidates freeze-tap buffers so old-mode loops don't bleed through.
 *
 *  `glideSec = 0.04` is psychoacoustic sweet spot — smooth bend (not a
 *  digital edit), under the ~80 ms "deliberate portamento" threshold.
 *
 *  Idempotent — calling with the same mode is a no-op. */
export function setAudioMode(newMode, glideSec = 0.04) {
  if (newMode !== 'nocturne' && newMode !== 'radiant') return;
  if (newMode === _activeMode) return;

  _activeMode = newMode;
  _modeGainMul = MODE_GAIN_MUL[newMode] || 1.0;
  _modeFilterMul = MODE_FILTER_MUL[newMode] || 1.0;

  // Mutate VOICES note tables (Strategy B — no call-site changes required).
  _applyModeToVoices(newMode);

  // Glide all PolySynth + fallback voices in every region.
  for (let id = 1; id <= 5; id++) {
    const r = regions[id];
    if (!r) continue;
    glidePolySynthToMode(r.primarySynth, newMode, glideSec);
    glidePolySynthToMode(r.secondarySynth, newMode, glideSec);
    // Region-specific sub-voice PolySynths (pads, sub-bass, etc.).
    if (r.livingWood) {
      glidePolySynthToMode(r.livingWood.subSynth, newMode, glideSec);
      glidePolySynthToMode(r.livingWood.trunkPad, newMode, glideSec);
      // Fallback branches (non-worklet path) — precomputed per-index cents.
      if (r.livingWood.branchSynths) {
        glideSynthArrayToMode(r.livingWood.branchSynths, FALLBACK_CENTS.livingWood[newMode], glideSec);
      }
    }
    if (r.villagePulse) {
      glidePolySynthToMode(r.villagePulse.lowPad, newMode, glideSec);
      glidePolySynthToMode(r.villagePulse.pad, newMode, glideSec);
    }
    if (r.nightSky) {
      glidePolySynthToMode(r.nightSky.pad, newMode, glideSec);
      if (r.nightSky.synths) {
        glideSynthArrayToMode(r.nightSky.synths, FALLBACK_CENTS.nightSky[newMode], glideSec);
      }
    }
    if (r.windHarp) {
      glidePolySynthToMode(r.windHarp.harpPad, newMode, glideSec);
      if (r.windHarp.harpSynths) {
        glideSynthArrayToMode(r.windHarp.harpSynths, FALLBACK_CENTS.windHarp[newMode], glideSec);
      }
    }
    if (r.celestialStrings) {
      glidePolySynthToMode(r.celestialStrings.glassyPad, newMode, glideSec);
      if (r.celestialStrings.stringSynths) {
        glideSynthArrayToMode(r.celestialStrings.stringSynths, FALLBACK_CENTS.celestialStrings[newMode], glideSec);
      }
    }
  }

  // Send frequency retune to each worklet. Uninitialized worklets are silent
  // no-ops (no port, skipped). VP handler expects 'config'+frequencies; the
  // others expect 'frequencies'+values (see Phase 2 worklet handlers).
  const r1 = regions[1];
  if (r1 && r1.livingWood && r1.livingWood.workletNode) {
    r1.livingWood.workletNode.port.postMessage({ type: 'frequencies', values: LW_BRANCH_FREQS[newMode] });
  }
  const r2 = regions[2];
  if (r2 && r2.villagePulse && r2.villagePulse.workletNode) {
    r2.villagePulse.workletNode.port.postMessage({ type: 'config', frequencies: VP_OVERTONE_FREQS[newMode] });
  }
  const r3 = regions[3];
  if (r3 && r3.nightSky && r3.nightSky.workletNode) {
    r3.nightSky.workletNode.port.postMessage({ type: 'frequencies', values: NS_FREQS[newMode] });
  }
  const r4 = regions[4];
  if (r4 && r4.windHarp && r4.windHarp.workletNode) {
    r4.windHarp.workletNode.port.postMessage({ type: 'frequencies', values: WH_HARP_FREQS[newMode] });
  }
  const r5 = regions[5];
  if (r5 && r5.celestialStrings && r5.celestialStrings.workletNode) {
    r5.celestialStrings.workletNode.port.postMessage({ type: 'frequencies', values: CS_STRING_FREQS[newMode] });
  }

  _invalidateFreezeTaps();
}

/** Alias for ensureInit — lets external modules trigger shared audio setup. */
export { ensureInit as ensureRegionAudioInit };

/** Pre-build audio nodes without user gesture — call on first mousemove to pre-warm. */
export { preBuildAudioNodes as preBuildAudioNodes };

// ── Per-region analyzer access ───────────────────────────────────────────────

// ── Per-frame analysis cache ──
// Prevents double-analyze() within the same frame. Without this guard,
// the ambient glow loop + audio scope re-analyze regions already processed
// by their update functions, causing: double-smoothed features (lerp applied
// twice), onset decay 15% too fast (0.92² per frame), flux history pollution
// (zero-flux ghost entries), and RMS envelope corruption.
//
// Phase 1 A2 (2026-04-13): analyze() runs at most once every 2 frames per
// region (30fps instead of 60fps). Lerp smoothing on features handles the
// inter-frame interpolation; saves ~half the AnalyserNode FFT work.
let _analysisFrame = 0;
const _lastAnalyzedFrame = {};
const _ANALYZER_FRAME_INTERVAL = 2;

/** Call once at the start of beforeRender to advance the analysis frame counter. */
export function advanceAnalysisFrame() { _analysisFrame++; }

/**
 * Generic audio feature getter for any region (1-5).
 * Calls analyze() at most once per _ANALYZER_FRAME_INTERVAL frames (30fps).
 */
export function getRegionAudioFeatures(id) {
  const r = regions[id];
  if (!r || !r.analyzer) return null;
  const last = _lastAnalyzedFrame[id];
  if (last === undefined || (_analysisFrame - last) >= _ANALYZER_FRAME_INTERVAL) {
    r.analyzer.analyze();
    _lastAnalyzedFrame[id] = _analysisFrame;
  }
  return r.analyzer.getFeatures();
}

/**
 * Get the Stars region's per-frame spectral features.
 * Delegates to getRegionAudioFeatures for per-frame cache.
 * @returns {{ bass: number, mids: number, highs: number, rms: number, centroid: number, flux: number, rawFlux: number, isPlaying: boolean } | null}
 */
export function getStarsAudioFeatures() {
  return getRegionAudioFeatures(5);
}

/** Spectral features for Horizon region (region 4). Delegates to getRegionAudioFeatures for per-frame cache. */
export function getHorizonAudioFeatures() {
  return getRegionAudioFeatures(4);
}

/**
 * Raw FFT buffers for Horizon (region 4) — Audio Scope visualization.
 * IMPORTANT: call getHorizonAudioFeatures() first so analyze() has run this frame.
 * Returns buffer references (no copy, no analyze() call).
 */
export function getHorizonRawAudio() {
  const r = regions[4];
  if (!r || !r.analyzer) return null;
  return {
    freqData: r.analyzer.getFrequencyData(),
    timeData: r.analyzer.getTimeDomainData(),
  };
}

/**
 * Generic raw FFT buffer getter for any region (1-5).
 * IMPORTANT: call getRegionAudioFeatures(id) first so analyze() has run this frame.
 */
export function getRegionRawAudio(id) {
  const r = regions[id];
  if (!r || !r.analyzer) return null;
  return {
    freqData: r.analyzer.getFrequencyData(),
    timeData: r.analyzer.getTimeDomainData(),
  };
}

/** Get live synth params for a region, including mouse expression offsets.
 *  Returns the effective values actually driving Tone.js, not raw evolution. */
export function getRegionLiveParams(id) {
  const r = regions[id];
  if (!r) return null;
  const me = r.mouseExpr;
  const filterExprNorm = me ? (me.filterOffset + me.capturedFilter) : 0;

  // Replicate gain compensation from applyParams():
  // When dragging down (filterExprNorm < 0), gain is attenuated
  let exprGainScale = 1.0;
  if (me && filterExprNorm < 0) {
    exprGainScale = Math.max(0.25, 1 + filterExprNorm * 1.5);
  }
  const duckGainMul = r.duck ? r.duck.gainCurrent : 1.0;

  return {
    filter:     Math.max(0, Math.min(1, r.currentParams.filter + filterExprNorm)),
    gain:       r.currentParams.gain * exprGainScale * duckGainMul,
    secondary:  r.currentParams.secondary,
    deepReverb: r._cachedReverb != null ? Math.min(1, r._cachedReverb / 0.8) : r.currentParams.deepReverb,
    lfo:        r.currentParams.lfo,
    width:      r._cachedChorus != null ? r._cachedChorus : r.currentParams.width,
    state:      r.state,
    energy:     r.energy || 0,
  };
}


/**
 * Return current evolution multipliers for Horizon (region 4).
 * UI uses these to show effective slider values in real-time.
 * Returns null when Horizon audio isn't active.
 */
export function getHarpEvolutionScales() {
  const r = regions[4];
  if (!r || !r.currentParams) return null;
  const cp = r.currentParams;
  return { lfo: cp.lfo, secondary: cp.secondary, width: cp.width };
}

/**
 * Snapshot of all Horizon audio state for clipboard copy.
 * Returns synth mode, userParams, evolution scales, and effective values.
 */
export function getHorizonAudioSnapshot() {
  const mode = horizonSynthMode;
  const r = regions[4];
  if (!r) return { synthMode: mode };

  const cp = r.currentParams || {};
  const evolution = { lfo: cp.lfo || 0, secondary: cp.secondary || 0, width: cp.width || 0 };
  const state = r.state || 'idle';

  if (!r.windHarp || !isWindHarpActive()) {
    return { synthMode: mode, state, evolution };
  }

  const up = { ...r.windHarp.userParams };

  // Compute effective values for modulated params
  const effective = {
    tremoloDepth: (up.tremoloMaxDepth || 0) * evolution.lfo,
    phaserWet: (up.phaserMaxWet || 0) * evolution.lfo,
    noiseMix: (up.v3NoiseMix != null ? up.v3NoiseMix : 0.66) * evolution.secondary,
    delayWet: evolution.width * (VOICES[4].windHarp.delayMaxWet || 0.3),
  };

  return { synthMode: mode, state, evolution, userParams: up, effective };
}

export function getWindHarpV3Diag() {
  const r = regions[4];
  if (!r || !r.windHarp || horizonSynthMode !== 'windHarpV3') return null;
  const wh = r.windHarp;
  const me = r.mouseExpr;
  const whCfg = VOICES[4].windHarp;
  const up = wh.userParams;

  // V3 strum state
  const strumBoosts = me ? Array.from(me.v3StrumBoosts).map(v => v.toFixed(3)) : new Array(9).fill('0');
  const lastStrumIndex = me ? me.v3LastStrumIndex : -1;
  const lastNoteName = lastStrumIndex >= 0 ? whCfg.harpNotes[lastStrumIndex] : '—';

  // Read macro-derived values cached by applyWindHarpV3Params (avoids ~30 lines of duplicated math)
  const mc = wh._macroCache || {};
  const y = mc.y || 0;
  const noiseScale = mc.noiseScale || 1;
  const effectiveDecay = mc.effectiveDecay || 3;
  const finalReverbWet = mc.finalReverbWet || 0;
  const finalRoomSize = mc.finalRoomSize || 0.75;
  const finalDelayWet = mc.finalDelayWet || 0;
  const finalFeedback = mc.finalFeedback || 0;
  const finalUniversalReverb = mc.finalUniversalReverb || 0;
  const finalPadVol = mc.finalPadVol || -12;
  const finalNoiseMix = mc.finalNoiseMix || 0;

  // Per-note state
  const notes = {};
  for (let i = 0; i < whCfg.harpNotes.length; i++) {
    const gain = wh.useWorklet ? wh._workletGainBuf[i] : (wh.harpGains[i] ? wh.harpGains[i].gain.value : 0);
    const phase = wh.lfoPhases[i];
    const boost = me ? me.v3StrumBoosts[i] : 0;
    notes[whCfg.harpNotes[i]] = {
      gain: gain.toFixed(3),
      strumBoost: boost.toFixed(3),
      rate: whCfg.lfoRates[i].toFixed(1) + 's',
      phase: (phase / Math.PI).toFixed(2) + 'π',
    };
  }

  // Region state
  const cp = r.currentParams || {};
  const secondary = cp.secondary || 0;
  const secClamped = Math.min(1.0, secondary * 1.5);
  const volEnv = 0.25 + 0.75 * secClamped;

  const result = {
    strum: {
      lastNote:       lastNoteName,
      lastIndex:      lastStrumIndex,
      intensity:      (up.v3StrumIntensity || 0.8).toFixed(2),
      decayRate:      (up.v3StrumDecay || 3.0).toFixed(1),
      boosts:         strumBoosts,
      mouseActive:    me ? me.active : false,
    },
    space: {
      macro:           y.toFixed(3),
      harpReverbWet:   finalReverbWet.toFixed(3),
      harpReverbRoom:  finalRoomSize.toFixed(3),
      delayWet:        finalDelayWet.toFixed(3),
      delayFeedback:   finalFeedback.toFixed(3),
      universalReverb: finalUniversalReverb.toFixed(3),
      padVolume:       finalPadVol.toFixed(1) + 'dB',
      noiseScale:      noiseScale.toFixed(2) + 'x',
      noiseMix:        finalNoiseMix.toFixed(3),
      strumDecay:      effectiveDecay.toFixed(2),
    },
    levels: {
      noiseDb:         wh.meterNoise ? wh.meterNoise.getValue().toFixed(1) + 'dB' : '—',
      padDb:           wh.meterPad ? wh.meterPad.getValue().toFixed(1) + 'dB' : '—',
      harpDb:          wh.meterHarp ? wh.meterHarp.getValue().toFixed(1) + 'dB' : '—',
      limiterGR:       wh.harpLimiter ? wh.harpLimiter.reduction.toFixed(1) + 'dB' : '—',
      peakLimiterGR:   wh.peakLimiterGR.toFixed(1) + 'dB',
      meterPreFx:      wh.meterPreFx ? wh.meterPreFx.getValue().toFixed(1) + 'dB' : '—',
      peakPreFx:       isFinite(wh.peakPreFx) ? wh.peakPreFx.toFixed(1) + 'dB' : '—',
      meterPostLimiter: wh.meterPostLimiter ? wh.meterPostLimiter.getValue().toFixed(1) + 'dB' : '—',
      peakPostLimiter: isFinite(wh.peakPostLimiter) ? wh.peakPostLimiter.toFixed(1) + 'dB' : '—',
      masterLimiterGR: masterLimiter ? masterLimiter.reduction.toFixed(1) + 'dB' : '—',
      peakMasterLimiterGR: peakMasterLimiterGR.toFixed(1) + 'dB',
      noiseGain:       wh.noiseGain.gain.value.toFixed(3),
      padVolume:       wh.harpPad.volume.value.toFixed(1) + 'dB',
      universalRevWet: wh.reverb ? wh.reverb.wet.value.toFixed(3) : (wh.reverbSend ? wh.reverbSend.gain.value.toFixed(3) : '—'),
      delayWet:        wh.delay.wet.value.toFixed(3),
      delayFb:         wh.delay.feedback.value.toFixed(3),
      mixBus:          wh.harpMixBus.gain.value.toFixed(3),
    },
    region: {
      state:       r.state,
      secondary:   secondary.toFixed(3),
      volEnvelope: volEnv.toFixed(3),
      filter:      (cp.filter || 0).toFixed(3),
      width:       (cp.width || 0).toFixed(3),
    },
    notes,
  };

  // Reset running peaks after read (next D-key press shows peaks since this read)
  wh.peakLimiterGR = 0;
  wh.peakPreFx = -Infinity;
  wh.peakPostLimiter = -Infinity;
  peakMasterLimiterGR = 0;

  return result;
}

/** Get Stars region's current chorus/reverb effect levels (cached from applyParams). */
export function getStarsEffectLevels() {
  const r = regions[5];
  if (!r) return null;
  return { chorus: r._cachedChorus || 0, reverb: r._cachedReverb || 0 };
}

// ── Lifecycle callback registration ──────────────────────────────────────────

/**
 * Register a callback fired on every region state transition.
 * @param {(regionId: number, newState: string, oldState: string) => void} cb
 */
export function setOnStateChange(cb) { onStateChange = cb; }

/** Real-time meter readings for DAW-style level display in Audio Scope. */
export function getWindHarpMeters() {
  const r = regions[4];
  if (!r || !r.windHarp) return null;
  const wh = r.windHarp;
  // Return silence once deactivated — prevents stale meter readings from
  // exponential asymptotes or smoothing inertia in Tone.Meter.
  if (!wh.active) return {
    noise: -Infinity, pad: -Infinity, harp: -Infinity,
    master: -Infinity, limiterGR: 0,
  };
  return {
    noise:    wh.meterNoise ? wh.meterNoise.getValue() : -Infinity,
    pad:      wh.meterPad ? wh.meterPad.getValue() : -Infinity,
    harp:     wh.meterHarp ? wh.meterHarp.getValue() : -Infinity,
    master:   wh.meterPostLimiter ? wh.meterPostLimiter.getValue() : -Infinity,
    limiterGR: wh.harpLimiter ? wh.harpLimiter.reduction : 0,
  };
}

export function getCypressMeters() {
  const r = regions[1];
  if (!r || !r.livingWood) return null;
  const lw = r.livingWood;
  if (!lw.active) return {
    earth: -Infinity, pad: -Infinity, branch: -Infinity,
    master: -Infinity, limiterGR: 0,
  };
  return {
    earth:    lw.meterEarth ? lw.meterEarth.getValue() : -Infinity,
    pad:      lw.meterPad ? lw.meterPad.getValue() : -Infinity,
    branch:   lw.meterBranch ? lw.meterBranch.getValue() : -Infinity,
    master:   lw.meterPostLimiter ? lw.meterPostLimiter.getValue() : -Infinity,
    limiterGR: lw.limiter ? lw.limiter.reduction : 0,
  };
}

export function getStarsMeters() {
  const r = regions[5];
  if (!r || !r.celestialStrings) return null;
  const cs = r.celestialStrings;
  if (!cs.active) return {
    air: -Infinity, pad: -Infinity, strings: -Infinity,
    master: -Infinity, limiterGR: 0,
  };
  return {
    air:      cs.meterAir ? cs.meterAir.getValue() : -Infinity,
    pad:      cs.meterPad ? cs.meterPad.getValue() : -Infinity,
    strings:  cs.meterStrings ? cs.meterStrings.getValue() : -Infinity,
    master:   cs.meterPostLimiter ? cs.meterPostLimiter.getValue() : -Infinity,
    limiterGR: cs.limiter ? cs.limiter.reduction : 0,
  };
}

/**
 * Get the current lifecycle state of a region.
 * @param {number|string} id — region ID (1-5)
 * @returns {'off'|'building'|'looping'|'reshaping'|'stopping'}
 */
export function getRegionState(id) {
  const r = regions[id];
  return r ? r.state : 'off';
}

/** Debug: snapshot of region state for console logging */
export function getRegionDebugState(id) {
  const r = regions[id];
  if (!r) return null;
  const me = r.mouseExpr;
  const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse : id == 4 ? r.windHarp : id == 5 ? r.celestialStrings : null;
  return {
    state: r.state,
    'me.active': me?.active,
    effectiveBuildTime: r.effectiveBuildTime?.toFixed(2),
    'voice.active': vs?.active,
    buildingRegionId: buildingRegionId,
  };
}

export function isRegionFrozen(id) {
  const r = regions[id];
  if (!r) return false;
  const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse : id == 3 ? r.nightSky : id == 4 ? r.windHarp : id == 5 ? r.celestialStrings : null;
  return vs ? (vs.freezeState === 'frozen' || vs.freezeState === 'capturing') : false;
}

// ── Debug audio profiler: loaded conditionally via ?debug URL parameter ──
if (typeof location !== 'undefined' && location.search.includes('debug')) {
  import('../debug/audio-profiler.js').then(({ setupAudioProfiler }) => {
    setupAudioProfiler({
      regions, masterLimiter, sharedReverb, sharedDeepReverb, sharedSpecialFreeverb,
      _nativeNode, getRegionAudioFeatures, NS_VOICE_COUNT, VOICES,
    });
  }).catch(e => console.warn('[AudioProfile] Failed to load profiler:', e));
}

