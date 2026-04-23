/**
 * Core dithering engine — error diffusion with serpentine scanning.
 * Ported from the Go dither library (github.com/makew0rld/dither).
 *
 * This module is DOM-free. It takes and returns typed arrays,
 * making it suitable for future Web Worker migration.
 */

import { linearize8to16, roundClamp, colorDistanceSq, LUMINANCE_LUT_R, LUMINANCE_LUT_G, LUMINANCE_LUT_B } from './color.js';
import { currentPixelIndex } from './matrices.js';

/**
 * Find the index of the closest palette color in linear space.
 * Uses weighted Euclidean distance (BT.709 luminance coefficients).
 */
function findClosestColor(r, g, b, linearPalette) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < linearPalette.length; i++) {
    const dist = colorDistanceSq(
      r, g, b,
      linearPalette[i][0], linearPalette[i][1], linearPalette[i][2]
    );
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      if (dist === 0) return i;
    }
  }
  return bestIdx;
}

/**
 * Apply error diffusion dithering to an image.
 *
 * @param {Uint8ClampedArray} imageData - RGBA pixel data from canvas (8-bit sRGB)
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number[][]} matrix - Error diffusion matrix (from matrices.js)
 * @param {number[][]} palette - Array of [r,g,b] in 8-bit sRGB
 * @param {boolean} serpentine - Whether to use serpentine (bidirectional) scanning
 * @returns {Uint8ClampedArray} Dithered RGBA pixel data (8-bit sRGB)
 */
export function ditherErrorDiffusion(imageData, width, height, matrix, palette, serpentine) {
  // Pre-compute linear palette
  const linearPalette = palette.map(([r, g, b]) => [
    linearize8to16(r),
    linearize8to16(g),
    linearize8to16(b),
  ]);

  // Build linear image buffer (Float64Array for precision during error accumulation)
  const bufferSize = width * height * 3;
  const linearBuffer = new Float64Array(bufferSize);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = (y * width + x) * 3;
      linearBuffer[dstIdx] = linearize8to16(imageData[srcIdx]);
      linearBuffer[dstIdx + 1] = linearize8to16(imageData[srcIdx + 1]);
      linearBuffer[dstIdx + 2] = linearize8to16(imageData[srcIdx + 2]);
    }
  }

  // Prepare output buffer — copy alpha from input
  const output = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < imageData.length; i += 4) {
    output[i + 3] = imageData[i + 3];
  }

  // Find current pixel position in the matrix
  const curPx = currentPixelIndex(matrix);

  // Main dithering loop
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Serpentine: reverse direction on even rows (matching Go library convention)
      let actualX = x;
      if (serpentine && y % 2 === 0) {
        actualX = width - 1 - x;
      }

      // Read current pixel from linear buffer
      const idx = (y * width + actualX) * 3;
      const oldR = linearBuffer[idx];
      const oldG = linearBuffer[idx + 1];
      const oldB = linearBuffer[idx + 2];

      // Find closest palette color
      const bestIdx = findClosestColor(oldR, oldG, oldB, linearPalette);

      // Write output pixel (8-bit sRGB palette color)
      const outIdx = (y * width + actualX) * 4;
      output[outIdx] = palette[bestIdx][0];
      output[outIdx + 1] = palette[bestIdx][1];
      output[outIdx + 2] = palette[bestIdx][2];

      // Calculate quantization error in linear space
      const errR = oldR - linearPalette[bestIdx][0];
      const errG = oldG - linearPalette[bestIdx][1];
      const errB = oldB - linearPalette[bestIdx][2];

      // Distribute error to neighbors using matrix weights
      for (let my = 0; my < matrix.length; my++) {
        for (let mx = 0; mx < matrix[my].length; mx++) {
          const weight = matrix[my][mx];
          if (weight === 0) continue;

          // Calculate offset from current pixel
          let deltaX = mx - curPx;
          const deltaY = my;

          // Mirror horizontal offset for serpentine on reversed rows
          if (serpentine && y % 2 === 0) {
            deltaX = -deltaX;
          }

          const px = actualX + deltaX;
          const py = y + deltaY;

          // Bounds check
          if (px < 0 || px >= width || py < 0 || py >= height) continue;

          // Apply weighted error to neighbor
          const nIdx = (py * width + px) * 3;
          linearBuffer[nIdx] = roundClamp(linearBuffer[nIdx] + errR * weight);
          linearBuffer[nIdx + 1] = roundClamp(linearBuffer[nIdx + 1] + errG * weight);
          linearBuffer[nIdx + 2] = roundClamp(linearBuffer[nIdx + 2] + errB * weight);
        }
      }
    }
  }

  return output;
}

/**
 * Optimized B&W Floyd-Steinberg dithering — single-channel luminance path.
 *
 * ~10-15× faster than the general-purpose ditherErrorDiffusion for 2-color palettes:
 * - 256-entry LUT replaces Math.pow (eliminates 9.9M transcendental calls)
 * - Single luminance channel instead of 3 RGB channels (3× less arithmetic + memory)
 * - Float32Array instead of Float64Array (halves bandwidth, sufficient precision)
 * - Inlined Floyd-Steinberg weights (no generic matrix loop or function calls)
 * - Threshold comparison replaces findClosestColor palette search
 * - Clamp-on-read instead of per-neighbor roundClamp calls
 *
 * Output is identical in structure (Uint8ClampedArray RGBA) but particle positions
 * differ slightly from 3-channel dithering because luminance thresholding collapses
 * R/G/B into one value before the decision. For Starry Night's color palette, the
 * visual difference is subtle.
 *
 * @param {Uint8ClampedArray} imageData - RGBA pixel data (8-bit sRGB)
 * @param {number} width
 * @param {number} height
 * @param {boolean} serpentine - Bidirectional scanning
 * @returns {Uint8ClampedArray} Dithered RGBA (black or white pixels)
 */
export function ditherBWFast(imageData, width, height, serpentine) {
  const n = width * height;

  // Single-channel luminance buffer (Float32, ~13MB at 2048×1622 vs 79MB for Float64 RGB)
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const si = i * 4;
    lum[i] = LUMINANCE_LUT_R[imageData[si]] + LUMINANCE_LUT_G[imageData[si + 1]] + LUMINANCE_LUT_B[imageData[si + 2]];
  }

  // Output RGBA buffer
  const output = new Uint8ClampedArray(n * 4);
  // Pre-fill alpha from input
  for (let i = 0; i < n; i++) {
    output[i * 4 + 3] = imageData[i * 4 + 3];
  }

  // Threshold: midpoint of 16-bit linear range
  const THRESHOLD = 32768.0;

  // Floyd-Steinberg inlined weights
  const W_RIGHT      = 7 / 16;
  const W_BELOW_LEFT = 3 / 16;
  const W_BELOW      = 5 / 16;
  const W_BELOW_RIGHT = 1 / 16;

  for (let y = 0; y < height; y++) {
    const reversed = serpentine && (y & 1) === 0;
    const dir = reversed ? -1 : 1;
    const startX = reversed ? width - 1 : 0;

    for (let x = 0; x < width; x++) {
      const actualX = startX + x * dir;
      const idx = y * width + actualX;

      // Clamp accumulated luminance (errors can push out of range)
      const oldLum = lum[idx] < 0 ? 0 : (lum[idx] > 65535 ? 65535 : lum[idx]);

      // Threshold: closest to black (0) or white (65535)?
      const isWhite = oldLum >= THRESHOLD;
      const newLum = isWhite ? 65535.0 : 0.0;
      const error = oldLum - newLum;

      // Write output pixel
      const oi = idx * 4;
      if (isWhite) {
        output[oi] = 255; output[oi + 1] = 255; output[oi + 2] = 255;
      }
      // else: already 0,0,0 (Uint8ClampedArray initialized to zero)

      // Distribute error to 4 neighbors (Floyd-Steinberg, inlined)
      const nx = actualX + dir;  // next pixel in scan direction
      const hasRight = nx >= 0 && nx < width;
      const hasBelow = y + 1 < height;
      const belowIdx = idx + width;

      if (hasRight) {
        lum[idx + dir] += error * W_RIGHT;
      }
      if (hasBelow) {
        if (actualX - dir >= 0 && actualX - dir < width) {
          lum[belowIdx - dir] += error * W_BELOW_LEFT;
        }
        lum[belowIdx] += error * W_BELOW;
        if (hasRight) {
          lum[belowIdx + dir] += error * W_BELOW_RIGHT;
        }
      }
    }
  }

  return output;
}
