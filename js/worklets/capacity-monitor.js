/**
 * Capacity Monitor V2 — AudioWorklet that estimates render thread load.
 *
 * Uses two complementary metrics:
 *   1. Inter-process() interval distribution (median, not average)
 *   2. Frame gap detection (counts actual dropped quanta)
 *
 * Chrome batches quanta: light load = many 0ms intervals (batched processing),
 * heavy load = uniform ~quantumMs intervals (no batching headroom).
 * The median interval / quantum duration approximates render capacity.
 *
 * Date.now() has ~1ms resolution on Windows with Chrome on AC power
 * (Chrome calls timeBeginPeriod(1) internally). At 22050Hz (5.8ms quantum),
 * that's ~17% per-quantum resolution. Averaged over 1 second (~172 quanta),
 * precision improves to ~2-3% — enough to detect 5-10% changes.
 */
const _now = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

class CapacityMonitor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._prevTime = 0;
    this._prevFrame = 0;
    this._quantumMs = (128 / sampleRate) * 1000;

    // EMA (tau ~1s) for smooth capacity estimate
    const quantaPerSec = sampleRate / 128;
    this._alpha = 1 - Math.exp(-1 / quantaPerSec);
    this._emaLoad = 0;

    // Glitch detection
    this._droppedQuanta = 0;
    this._totalQuanta = 0;

    // Ring buffer for percentile computation (last ~3s of data)
    this._ring = new Float32Array(512);
    this._ringIdx = 0;
    this._ringFilled = 0;

    // Reporting (~every 2 seconds for more stable readings)
    this._reportEvery = Math.round(quantaPerSec * 2);
    this._counter = 0;

    // Batch tracking: count how many intervals are "fast" (<1.5ms = batched)
    this._batchedCount = 0;
    this._measuredCount = 0;

    this._active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._active = false;
      if (e.data === 'start') {
        this._active = true;
        this._prevTime = 0;
        this._prevFrame = 0;
        this._emaLoad = 0;
        this._droppedQuanta = 0;
        this._totalQuanta = 0;
        this._ringFilled = 0;
        this._ringIdx = 0;
        this._counter = 0;
        this._batchedCount = 0;
        this._measuredCount = 0;
      }
    };
  }

  process() {
    if (!this._active) return true;

    const now = _now();
    this._totalQuanta++;

    // Glitch detection via frame gaps
    if (this._prevFrame > 0) {
      const expectedFrame = this._prevFrame + 128;
      if (currentFrame > expectedFrame + 64) {
        this._droppedQuanta += Math.round((currentFrame - expectedFrame) / 128);
      }
    }
    this._prevFrame = currentFrame;

    // Load estimation via inter-call interval
    if (this._prevTime > 0) {
      const intervalMs = now - this._prevTime;
      const load = intervalMs / this._quantumMs;

      // Clamp outliers (OS scheduling hiccups, tab switch, etc.)
      const clamped = Math.min(4.0, Math.max(0, load));

      // EMA for smooth tracking
      this._emaLoad += this._alpha * (clamped - this._emaLoad);

      // Ring buffer for percentiles
      this._ring[this._ringIdx] = clamped;
      this._ringIdx = (this._ringIdx + 1) % 512;
      if (this._ringFilled < 512) this._ringFilled++;

      // Batch tracking
      this._measuredCount++;
      if (intervalMs < 1.5) this._batchedCount++;
    }
    this._prevTime = now;

    // Report every ~2s
    this._counter++;
    if (this._counter >= this._reportEvery) {
      this._counter = 0;
      const n = this._ringFilled;
      if (n < 20) return true;

      // Sort for percentiles
      const sorted = new Float32Array(n);
      for (let i = 0; i < n; i++) sorted[i] = this._ring[i];
      sorted.sort();

      // Batch ratio = fraction of intervals that were "fast" (batched)
      // Low load → high batch ratio (Chrome batches many quanta)
      // High load → low batch ratio (each quantum takes full budget)
      const batchRatio = this._measuredCount > 0
        ? this._batchedCount / this._measuredCount : 0;

      // Capacity estimate: 1 - batchRatio gives rough load
      // When fully batched (0% load), batchRatio → ~0.75 (3 of 4 quanta batched)
      // When saturated, batchRatio → 0
      // Normalize: at idle ~75% are batched, at full load ~0% are batched
      const batchCapacity = Math.min(1.0, Math.max(0, 1 - batchRatio / 0.75));

      this.port.postMessage({
        median: sorted[Math.floor(n * 0.5)],
        p75: sorted[Math.floor(n * 0.75)],
        p95: sorted[Math.floor(n * 0.95)],
        ema: this._emaLoad,
        batchRatio,
        batchCapacity,
        droppedQuanta: this._droppedQuanta,
        totalQuanta: this._totalQuanta,
        quantumMs: this._quantumMs,
        samples: n,
      });

      // Reset batch counters for next window
      this._batchedCount = 0;
      this._measuredCount = 0;
    }

    return true;
  }
}

registerProcessor('capacity-monitor', CapacityMonitor);
