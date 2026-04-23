/**
 * Error diffusion matrix definitions.
 * Ported from the Go dither library (github.com/makew0rld/dither).
 *
 * Matrix format:
 *   Row 0: [...zeros for already-processed pixels, *current pixel*, ...right weights]
 *   Row 1+: weights for pixels below
 *
 * The current pixel is the rightmost zero in row 0.
 */

export const FloydSteinberg = {
  name: 'Floyd-Steinberg',
  matrix: [
    [0, 0, 7 / 16],
    [3 / 16, 5 / 16, 1 / 16],
  ],
};

export const FalseFloydSteinberg = {
  name: 'False Floyd-Steinberg',
  matrix: [
    [0, 3 / 8],
    [3 / 8, 2 / 8],
  ],
};

export const SierraLite = {
  name: 'Sierra Lite',
  matrix: [
    [0, 0, 2 / 4],
    [1 / 4, 1 / 4, 0],
  ],
};

/**
 * Registry of all available matrices.
 * UI populates its dropdown from this object.
 */
export const MATRICES = {
  floydSteinberg: FloydSteinberg,
  falseFloydSteinberg: FalseFloydSteinberg,
  sierraLite: SierraLite,
};

/**
 * Find the current pixel position in a matrix.
 * It's the rightmost zero in row 0.
 */
export function currentPixelIndex(matrix) {
  const row0 = matrix[0];
  for (let i = 0; i < row0.length; i++) {
    if (row0[i] !== 0) return i - 1;
  }
  return row0.length - 1;
}
