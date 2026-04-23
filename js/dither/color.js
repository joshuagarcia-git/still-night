/**
 * Color math utilities — sRGB/linear RGB conversion and color distance.
 * Ported from the Go dither library (github.com/makew0rld/dither).
 */

/**
 * sRGB channel value [0,1] -> linear channel value [0,1].
 * Uses the standard sRGB transfer function.
 */
export function linearize(v) {
  if (v <= 0.04045) return v / 12.92;
  return Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Linear channel value [0,1] -> sRGB channel value [0,1].
 * Inverse of linearize().
 */
export function delinearize(v) {
  if (v <= 0.0031308) return v * 12.92;
  return 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055;
}

/**
 * 8-bit sRGB [0,255] -> 16-bit linear [0,65535].
 */
export function linearize8to16(val8) {
  return _linearLUT[val8];
}

// Pre-computed LUT: eliminates 9.9M+ Math.pow calls during dithering.
// 256 entries × 2 bytes = 512 bytes (fits in L1 cache).
const _linearLUT = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255.0;
  const linear = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  _linearLUT[i] = Math.round(linear * 65535.0);
}

/**
 * Pre-computed BT.709 luminance LUT: sRGB byte → 16-bit linear luminance.
 * Used by the B&W fast-path dithering (single-channel error diffusion).
 */
export const LUMINANCE_LUT_R = new Float32Array(256);
export const LUMINANCE_LUT_G = new Float32Array(256);
export const LUMINANCE_LUT_B = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const lin = _linearLUT[i];
  LUMINANCE_LUT_R[i] = lin * 0.2126;
  LUMINANCE_LUT_G[i] = lin * 0.7152;
  LUMINANCE_LUT_B[i] = lin * 0.0722;
}

/**
 * 16-bit linear [0,65535] -> 8-bit sRGB [0,255].
 */
export function delinearize16to8(val16) {
  return Math.round(delinearize(val16 / 65535.0) * 255.0);
}

/**
 * Clamp value to [0, 65535] and round.
 * Matches Go library's RoundClamp.
 */
export function roundClamp(val) {
  if (val < 0) return 0;
  if (val > 65535) return 65535;
  return Math.round(val);
}

/**
 * Weighted Euclidean distance squared in linear RGB space.
 * Uses ITU-R BT.709 luminance coefficients for perceptual accuracy.
 * All inputs are 16-bit linear values [0,65535].
 */
export function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return 0.2126 * (dr * dr) + 0.7152 * (dg * dg) + 0.0722 * (db * db);
}
