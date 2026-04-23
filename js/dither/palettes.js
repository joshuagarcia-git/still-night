/**
 * Predefined color palettes.
 * Each palette is an array of [r, g, b] tuples in 8-bit sRGB.
 */

export const PALETTES = {
  bw: {
    name: 'Black & White',
    colors: [[0, 0, 0], [255, 255, 255]],
  },
  bw4: {
    name: '4-shade Grayscale',
    colors: [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]],
  },
  bw8: {
    name: '8-shade Grayscale',
    colors: Array.from({ length: 8 }, (_, i) => {
      const v = Math.round(i * 255 / 7);
      return [v, v, v];
    }),
  },
  cga: {
    name: 'CGA',
    colors: [
      [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
      [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
      [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
      [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
    ],
  },
  gameboy: {
    name: 'Game Boy',
    colors: [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]],
  },
};
