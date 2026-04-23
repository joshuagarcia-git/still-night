// Binary format for pre-baked painting payloads (.dvs = Dithering Visual Symphony).
// Shared by tools/prebake.js (writer) and js/prebaked-loader.js (reader).
//
// Layout:
//   [0..3]    magic "DVSB"
//   [4..7]    version  uint32 LE
//   [8..11]   sectionCount uint32 LE
//   [12..15]  paintingW uint32 LE
//   [16..19]  paintingH uint32 LE
//   [20..23]  segW uint32 LE       (= full-res segmentation map width)
//   [24..27]  segH uint32 LE
//   [28..31]  bfsW uint32 LE       (= half-res distance field width)
//   [32..35]  bfsH uint32 LE
//   [36..39]  flowW uint32 LE
//   [40..43]  flowH uint32 LE
//   [44..63]  reserved (zero)
//
//   [64..]    section table: sectionCount entries × 16 bytes
//               sectionId uint32, offset uint32, byteLength uint32, format uint32
//
//   [...]     data blob (each section 4-byte aligned)
//
// Format codes:
//   1 = UINT8
//   2 = UINT16
//   3 = FLOAT16 (IEEE-754 binary16 stored as uint16)
//   4 = FLOAT32
//
// Version history:
//   1 — initial multi-tier format with POINTS + particleCount/particleStride
//   2 — hybrid-only: POINTS removed, particleCount/particleStride retired
//       to reserved zone (bytes 44-51). Runtime dithers at canvas resolution.

export const MAGIC = 0x42535644; // "DVSB" little-endian uint32
export const VERSION = 2;
export const HEADER_SIZE = 64;
export const SECTION_ENTRY_SIZE = 16;

export const FORMAT = Object.freeze({
  UINT8: 1,
  UINT16: 2,
  FLOAT16: 3,
  FLOAT32: 4,
});

export const SECTION = Object.freeze({
  REGION_MAP:       1,   // uint8, segW×segH
  CLICK_REGION_MAP: 2,   // uint8, segW×segH
  BFS_BOUNDARY:     3,   // float16, bfsW×bfsH (normalized [0,1])
  BFS_FLOW_EDGE:    4,   // float16, bfsW×bfsH (full-res pixels, pre-scaled)
  BFS_CYPRESS_EDGE: 5,   // float16, bfsW×bfsH
  BFS_VILLAGE_EDGE: 6,   // float16, bfsW×bfsH
  CURVATURE:        7,   // float16, flowW×flowH
  EDDY_ENERGY:      8,   // float16, flowW×flowH
});

// ── float16 ↔ float32 helpers (IEEE-754 binary16) ─────────────────────────────

const _f32buf = new ArrayBuffer(4);
const _f32view = new Float32Array(_f32buf);
const _u32view = new Uint32Array(_f32buf);

/** Pack a Float32 value as IEEE-754 binary16, returning a uint16. */
export function toFloat16(val) {
  _f32view[0] = val;
  const x = _u32view[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;

  if (exp >= 31) {
    // Inf / NaN / overflow → clamp to max half or Inf
    return sign | 0x7c00 | (mant && ((mant >>> 13) | 1));
  }
  if (exp <= 0) {
    // Subnormal or underflow
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >>> (1 - exp);
    if (mant & 0x1000) mant += 0x2000; // round to nearest
    return sign | (mant >>> 13);
  }
  // Round mantissa to nearest even
  if (mant & 0x1000) {
    mant += 0x2000;
    if (mant & 0x800000) { mant = 0; exp += 1; }
    if (exp >= 31) return sign | 0x7c00;
  }
  return sign | (exp << 10) | (mant >>> 13);
}

/** Unpack a uint16 IEEE-754 binary16 value to Float32. */
export function fromFloat16(h) {
  const sign = (h & 0x8000) << 16;
  let exp = (h >>> 10) & 0x1f;
  let mant = h & 0x3ff;

  if (exp === 0) {
    if (mant === 0) {
      _u32view[0] = sign;
      return _f32view[0];
    }
    // Subnormal: renormalize
    while ((mant & 0x400) === 0) { mant <<= 1; exp -= 1; }
    exp += 1;
    mant &= 0x3ff;
  } else if (exp === 31) {
    _u32view[0] = sign | 0x7f800000 | (mant << 13);
    return _f32view[0];
  }
  _u32view[0] = sign | ((exp + (127 - 15)) << 23) | (mant << 13);
  return _f32view[0];
}

/** Pack a Float32Array into a Uint16Array of float16 values. */
export function packFloat16(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = toFloat16(f32[i]);
  return out;
}

/** Unpack a Uint16Array of float16 values into a Float32Array. */
export function unpackFloat16(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) out[i] = fromFloat16(u16[i]);
  return out;
}

/** Round up to nearest multiple of 4 for section alignment. */
export function align4(n) { return (n + 3) & ~3; }
