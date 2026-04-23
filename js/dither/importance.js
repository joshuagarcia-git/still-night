/**
 * Importance map — local variance computed via integral images.
 * High variance = detail-rich area (keep more points).
 * Low variance = uniform area (safe to thin).
 */

/**
 * Compute a per-pixel importance map based on local luminance variance.
 *
 * @param {Uint8ClampedArray} data - RGBA pixel data
 * @param {number} width
 * @param {number} height
 * @param {number} [radius=5] - Half-window size (full window = 2*radius+1)
 * @returns {Float32Array} Importance values [0, 1] for each pixel
 */
export function computeImportanceMap(data, width, height, radius = 5) {
  const n = width * height;

  // Step 1: Convert to grayscale luminance (BT.709)
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    lum[i] = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
  }

  // Step 2: Build integral images for sum and sum-of-squares.
  // Using (width+1) x (height+1) with a zero-padded border for cleaner indexing.
  const w1 = width + 1;
  const h1 = height + 1;
  const intSum = new Float64Array(w1 * h1);
  const intSqSum = new Float64Array(w1 * h1);

  for (let y = 1; y < h1; y++) {
    for (let x = 1; x < w1; x++) {
      const val = lum[(y - 1) * width + (x - 1)];
      const idx = y * w1 + x;
      intSum[idx] = val + intSum[idx - 1] + intSum[idx - w1] - intSum[idx - w1 - 1];
      intSqSum[idx] = val * val + intSqSum[idx - 1] + intSqSum[idx - w1] - intSqSum[idx - w1 - 1];
    }
  }

  // Step 3: Compute variance per pixel using the integral images.
  const variance = new Float32Array(n);
  let maxVar = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Window bounds (clamped to image)
      const x0 = Math.max(0, x - radius);
      const y0 = Math.max(0, y - radius);
      const x1 = Math.min(width - 1, x + radius);
      const y1 = Math.min(height - 1, y + radius);

      // Integral image lookup (offset by 1 for the padding)
      const a = y0 * w1 + x0;
      const b = y0 * w1 + (x1 + 1);
      const c = (y1 + 1) * w1 + x0;
      const d = (y1 + 1) * w1 + (x1 + 1);

      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = intSum[d] - intSum[b] - intSum[c] + intSum[a];
      const sqSum = intSqSum[d] - intSqSum[b] - intSqSum[c] + intSqSum[a];

      const mean = sum / count;
      const v = sqSum / count - mean * mean;

      const idx = y * width + x;
      variance[idx] = Math.max(0, v); // clamp numerical noise
      if (v > maxVar) maxVar = v;
    }
  }

  // Step 4: Normalize to [0, 1]
  if (maxVar > 0) {
    const invMax = 1 / maxVar;
    for (let i = 0; i < n; i++) {
      variance[i] *= invMax;
    }
  }

  return variance;
}
