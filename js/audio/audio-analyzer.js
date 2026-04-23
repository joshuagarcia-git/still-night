/**
 * Audio Analyzer — Real-time spectral feature extraction via Web Audio API.
 *
 * Pure audio signal processing module. No DOM, no renderer dependency.
 * Creates an AnalyserNode (passive read-only tap) that extracts per-frame
 * spectral features: bass/mids/highs, RMS, spectral centroid, and flux.
 *
 * Based on validated crossmodal research (Palmer et al. 2024, Reymore et al. 2023):
 *   Bass (0–250 Hz)    → heavy, thick, deep
 *   Mids (250–2 kHz)   → melody, harmony, body
 *   Highs (2–5 kHz)    → presence, brilliance, clarity (ear's peak sensitivity band)
 */

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Create an audio analyzer that extracts spectral features each frame.
 *
 * @param {AudioContext} audioCtx - The Web Audio context
 * @returns {{ analyserNode: AnalyserNode, analyze: () => void, getFeatures: () => object, setPlaying: (bool) => void }}
 */
export function createAnalyzer(audioCtx) {
  // ── AnalyserNode setup ──
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.3;   // low smoothing for responsive scope display
                                          // (feature extraction has its own lerp smoothing)
  analyser.connect(audioCtx.destination);

  // ── FFT buffers ──
  const freqBinCount = analyser.frequencyBinCount; // 512
  const freqData = new Uint8Array(freqBinCount);
  const timeData = new Uint8Array(analyser.fftSize);
  let prevSpectrum = null;

  // ── Smoothed feature output ──
  const features = {
    bass: 0,       // 0–1, average energy 0–250 Hz
    mids: 0,       // 0–1, average energy 250–2000 Hz
    highs: 0,      // 0–1, average energy 2000 Hz+
    rms: 0,        // 0–1, overall loudness (time-domain)
    rmsNorm: 0,    // 0–1, self-normalized RMS (rms / running peak)
    centroid: 0,   // 0–1, spectral brightness (weighted freq / nyquist)
    flux: 0,       // 0–1, smoothed frame-to-frame spectral change
    rawFlux: 0,    // unsmoothed flux (for transient detection)
    isPlaying: false,

    // ── Perceptual features ──
    onset: 0,              // 0–1, transient spike strength (decays per frame)
    spectralDirection: 0,  // −1 to +1, brightening vs darkening
    envelope: 0,           // 0–1, phase within current energy state
    envelopeState: 'silent', // 'building' | 'sustaining' | 'releasing' | 'silent'
    rhythmStrength: 0,     // 0–1, periodicity confidence of onsets
    spread: 0,             // 0–1, spectral bandwidth (pure tone → noise)
  };

  let playing = false;

  // ── Running peak RMS for self-normalization ──
  // Seeded at –20 dBFS (RMS 0.1), a principled "moderate signal" reference.
  // Early quiet frames see rmsNorm ≈ rms / 0.1, safely << 1.0, preventing
  // the bootstrap spike that occurred when peakRms started at 0.
  // Peak holds steady while signal is present (rms > noise floor), only
  // decaying during true silence. This prevents the looping bug where
  // unconditional decay eroded peakRms to match a quiet loop, pinning
  // rmsNorm at 1.0. After extended silence, peakRms decays to the seed
  // floor (never below), so the next onset gets a clean bootstrap.
  const PEAK_SEED   = 0.1;
  let peakRms = PEAK_SEED;
  const PEAK_ATTACK = 0.03;   // lerp rate toward new peaks (~2s to fully track)
  const PEAK_DECAY  = 0.9993; // per-frame decay during silence only

  // ── Onset detection state ──
  const FLUX_HISTORY_LEN = 30;               // ~0.5s at 60fps for median window
  const fluxHistory = new Float32Array(FLUX_HISTORY_LEN);
  let fluxHistIdx = 0, fluxHistCount = 0;
  const ONSET_MULTIPLIER = 2.0;              // flux must exceed median × this
  const ONSET_DECAY = 0.92;                  // per-frame exponential decay
  let onsetStrength = 0;

  // ── Spectral direction state ──
  let prevCentroid = 0;
  const DIR_SMOOTH = 0.15;

  // ── Energy envelope state machine ──
  const ENV_HISTORY_LEN = 30;                // ~0.5s window for slope
  const rmsHistory = new Float32Array(ENV_HISTORY_LEN);
  let rmsHistIdx = 0, rmsHistCount = 0;
  const ENV_SILENT_THRESH = 0.01;
  const ENV_BUILD_THRESH = 0.002;
  const ENV_RELEASE_THRESH = -0.001;
  let envState = 'silent';
  let envPhase = 0;
  let envStateStart = 0, envFrameCount = 0;

  // ── Rhythm detection state ──
  const ONSET_TS_LEN = 32;
  const onsetTimestamps = new Float64Array(ONSET_TS_LEN);
  let onsetTsIdx = 0, onsetTsCount = 0;
  let lastOnsetFired = false;
  const MAX_IOI = 1600, BIN_SIZE = 50;
  const rhythmBins = new Uint8Array(Math.ceil(MAX_IOI / BIN_SIZE)); // pre-allocated
  const ioiBuf = new Float64Array(ONSET_TS_LEN); // pre-allocated IOI buffer

  // ── Pre-allocated spectrum buffer (avoid per-frame GC) ──
  const currentSpectrum = new Float32Array(freqBinCount);

  // ── Pre-allocated sort buffer for onset median (avoid per-frame alloc) ──
  const fluxSortBuf = new Float32Array(FLUX_HISTORY_LEN);

  /**
   * Run one frame of audio analysis. Call once per rAF frame.
   * Reads FFT data, computes all features, applies smoothing.
   */
  function analyze() {
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);

    const nyquist = audioCtx.sampleRate / 2;
    const binHz = nyquist / freqBinCount;

    // ── Band boundaries ──
    const bassEnd = Math.floor(250 / binHz);
    const midEnd = Math.floor(2000 / binHz);
    const presenceEnd = Math.floor(5000 / binHz);  // 2-5kHz "presence" band (ear most sensitive)

    // ── Fused frequency analysis loop ──
    // Single pass: band energies, centroid, spectral flux, and spread.
    // Spread uses previous frame's centroid (changes <0.1% per frame at 60fps).
    let bassSum = 0, midSum = 0, highSum = 0, presenceSum = 0;
    let totalWeightedFreq = 0, totalMagnitude = 0;
    let flux = 0;
    let spreadSum = 0;
    const prevCentroidHz = prevCentroid * nyquist;
    const hasPrev = !!prevSpectrum;

    for (let i = 0; i < freqBinCount; i++) {
      const mag = freqData[i] / 255;

      // Band energies
      if (i < bassEnd) bassSum += mag;
      else if (i < midEnd) midSum += mag;
      else {
        highSum += mag;
        if (i < presenceEnd) presenceSum += mag;
      }

      // Centroid accumulation
      totalWeightedFreq += mag * i * binHz;
      totalMagnitude += mag;

      // Spectral flux (positive-only, onset detection)
      currentSpectrum[i] = mag;
      if (hasPrev) {
        const diff = mag - prevSpectrum[i];
        if (diff > 0) flux += diff;
      }

      // Spectral spread (using previous frame's centroid)
      const freqHz = i * binHz;
      const spreadDiff = freqHz - prevCentroidHz;
      spreadSum += mag * spreadDiff * spreadDiff;
    }
    flux /= freqBinCount;

    const bass = bassSum / Math.max(bassEnd, 1);
    const mids = midSum / Math.max(midEnd - bassEnd, 1);
    // Highs: use the 2-5kHz presence band (ear's peak sensitivity) instead of
    // full 2-11kHz range. The old calculation averaged across 839 bins, diluting
    // any content to near-zero. Presence band (278 bins) gives a meaningful reading.
    const highs = presenceSum / Math.max(presenceEnd - midEnd, 1);

    const centroid = totalMagnitude > 0
      ? (totalWeightedFreq / totalMagnitude) / nyquist
      : 0;

    // Spread: finalize using accumulated sum
    const rawSpread = totalMagnitude > 0
      ? Math.min(1.0, Math.sqrt(spreadSum / totalMagnitude) / (nyquist * 0.5))
      : 0;

    // Swap spectrum buffers (ping-pong avoids per-frame copy)
    if (!prevSpectrum) {
      prevSpectrum = new Float32Array(freqBinCount);
    }
    prevSpectrum.set(currentSpectrum);

    // ── RMS from time domain ──
    let rmsSum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const sample = (timeData[i] - 128) / 128;
      rmsSum += sample * sample;
    }
    const rms = Math.sqrt(rmsSum / timeData.length);

    // ── Running peak tracking for self-normalization ──
    if (rms > peakRms) {
      peakRms = lerp(peakRms, rms, PEAK_ATTACK);
    } else if (rms < 0.005) {
      peakRms = Math.max(PEAK_SEED, peakRms * PEAK_DECAY);
    }

    const rmsNorm = rms > 0.005 ? Math.min(1.0, rms / peakRms) : 0;

    // ── Onset strength (adaptive-threshold transient detection) ──
    fluxHistory[fluxHistIdx] = flux;
    fluxHistIdx = (fluxHistIdx + 1) % FLUX_HISTORY_LEN;
    if (fluxHistCount < FLUX_HISTORY_LEN) fluxHistCount++;

    let onsetFired = false;
    if (fluxHistCount >= 5) {
      // Copy into pre-allocated buffer and sort in-place (no per-frame alloc)
      fluxSortBuf.set(fluxHistory.subarray(0, fluxHistCount));
      const sorted = fluxSortBuf.subarray(0, fluxHistCount).sort();
      const medianFlux = sorted[Math.floor(fluxHistCount / 2)];
      const threshold = Math.max(0.001, medianFlux * ONSET_MULTIPLIER);

      if (flux > threshold && !lastOnsetFired) {
        const rawOnset = Math.min(1.0, (flux - threshold) / (threshold * 2));
        onsetStrength = Math.max(onsetStrength, 0.3 + rawOnset * 0.7);
        onsetFired = true;

        // Record timestamp for rhythm detection
        onsetTimestamps[onsetTsIdx] = performance.now();
        onsetTsIdx = (onsetTsIdx + 1) % ONSET_TS_LEN;
        if (onsetTsCount < ONSET_TS_LEN) onsetTsCount++;
      }
    }
    lastOnsetFired = onsetFired;
    onsetStrength *= ONSET_DECAY;
    if (onsetStrength < 0.005) onsetStrength = 0;

    // ── Spectral direction (centroid derivative, normalized ±1) ──
    const centroidDelta = centroid - prevCentroid;
    prevCentroid = centroid;
    const rawDirection = Math.max(-1, Math.min(1, centroidDelta / 0.03));

    // ── Energy envelope state machine ──
    rmsHistory[rmsHistIdx] = rmsNorm;
    rmsHistIdx = (rmsHistIdx + 1) % ENV_HISTORY_LEN;
    if (rmsHistCount < ENV_HISTORY_LEN) rmsHistCount++;
    envFrameCount++;

    let envSlope = 0;
    if (rmsHistCount >= 10) {
      const halfLen = Math.floor(rmsHistCount / 2);
      let recentSum = 0, olderSum = 0;
      for (let i = 0; i < halfLen; i++) {
        const recentIdx = (rmsHistIdx - 1 - i + ENV_HISTORY_LEN) % ENV_HISTORY_LEN;
        const olderIdx = (rmsHistIdx - 1 - halfLen - i + ENV_HISTORY_LEN) % ENV_HISTORY_LEN;
        recentSum += rmsHistory[recentIdx];
        olderSum += rmsHistory[olderIdx];
      }
      envSlope = (recentSum - olderSum) / halfLen;
    }

    const prevEnvState = envState;
    if (rmsNorm < ENV_SILENT_THRESH) {
      envState = 'silent';
    } else if (envSlope > ENV_BUILD_THRESH) {
      envState = 'building';
    } else if (envSlope < ENV_RELEASE_THRESH) {
      envState = 'releasing';
    } else {
      envState = 'sustaining';
    }

    if (envState !== prevEnvState) envStateStart = envFrameCount;
    const stateAge = envFrameCount - envStateStart;
    envPhase = Math.min(1.0, stateAge / 120);  // ramps 0→1 over ~2s

    // ── Rhythmic energy (inter-onset interval periodicity) ──
    // Gate: clear stale timestamps when audio is silent
    let rawRhythm = 0;
    if (rmsNorm < 0.01) {
      onsetTsCount = 0;
      onsetTsIdx = 0;
    }
    if (onsetTsCount >= 4) {
      let ioiCount = 0;
      for (let i = 1; i < onsetTsCount; i++) {
        const curr = onsetTimestamps[(onsetTsIdx - 1 - (i - 1) + ONSET_TS_LEN) % ONSET_TS_LEN];
        const prev = onsetTimestamps[(onsetTsIdx - 1 - i + ONSET_TS_LEN) % ONSET_TS_LEN];
        if (curr > prev) ioiBuf[ioiCount++] = curr - prev;
      }
      if (ioiCount >= 3) {
        // Reuse pre-allocated bins array (zero it first)
        rhythmBins.fill(0);
        let maxBinCount = 0, dominantBin = -1;

        for (let i = 0; i < ioiCount; i++) {
          const ioi = ioiBuf[i];
          if (ioi > 0 && ioi < MAX_IOI) {
            const bin = Math.floor(ioi / BIN_SIZE);
            rhythmBins[bin]++;
            if (rhythmBins[bin] > maxBinCount) {
              maxBinCount = rhythmBins[bin];
              dominantBin = bin;
            }
          }
        }

        if (dominantBin >= 0) {
          let matchCount = 0;
          for (let i = 0; i < ioiCount; i++) {
            const bin = Math.floor(ioiBuf[i] / BIN_SIZE);
            if (Math.abs(bin - dominantBin) <= 1) matchCount++;
          }
          rawRhythm = matchCount / ioiCount;
          if (matchCount < 3) rawRhythm *= 0.5;
        }
      }
    }

    // ── Smooth all features (lerp factor 0.3) ──
    const s = 0.3;
    features.bass     = lerp(features.bass, bass, s);
    features.mids     = lerp(features.mids, mids, s);
    features.highs    = lerp(features.highs, highs, s);
    features.rms      = lerp(features.rms, rms, s);
    features.rmsNorm  = lerp(features.rmsNorm, rmsNorm, s);
    features.centroid  = lerp(features.centroid, centroid, s);
    features.flux     = lerp(features.flux, flux * 5.0, s); // amplify flux
    features.rawFlux  = flux;

    // Perceptual features
    features.onset           = onsetStrength;    // own decay, no lerp
    features.spectralDirection = lerp(features.spectralDirection, rawDirection, DIR_SMOOTH);
    features.envelope        = envPhase;         // state machine, no lerp
    features.envelopeState   = envState;         // string
    features.rhythmStrength  = lerp(features.rhythmStrength, rawRhythm, 0.1); // slow
    features.spread          = lerp(features.spread, rawSpread, s);

    features.isPlaying = playing;
  }

  return {
    /** The AnalyserNode — wire your audio chain into this. */
    analyserNode: analyser,

    /** Call once per frame to update features. */
    analyze,

    /** Get the current smoothed feature snapshot (by reference, no copy). */
    getFeatures() { return features; },

    /** Tell the analyzer whether audio is actively playing. */
    setPlaying(val) { playing = val; },

    /** Raw frequency magnitudes (Uint8Array[512], 0–255). Call analyze() first. */
    getFrequencyData() { return freqData; },

    /** Raw time-domain waveform (Uint8Array[1024], 0–255, 128 = center). Call analyze() first. */
    getTimeDomainData() { return timeData; },
  };
}
