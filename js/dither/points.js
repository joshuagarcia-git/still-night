/**
 * Point extraction — converts dithered pixel data into a GPU-ready point cloud.
 * Each "on" pixel becomes a point with its position, original source color,
 * and optional region ID from a segmentation map.
 */

/**
 * Look up a region ID from the segmentation map, handling coordinate scaling
 * when the segmentation map and source image have different dimensions.
 */
function lookupRegion(x, y, width, height, regionMap, segWidth, segHeight) {
  if (width === segWidth && height === segHeight) return regionMap[y * segWidth + x];
  const segX = Math.min(Math.floor(x / width * segWidth), segWidth - 1);
  const segY = Math.min(Math.floor(y / height * segHeight), segHeight - 1);
  return regionMap[segY * segWidth + segX];
}

/**
 * Look up boundary distance for a pixel, normalized to canvas-diagonal space.
 * Returns 0.0 for pixels inside locked regions, positive for pixels outside.
 */
function lookupBoundaryDist(x, y, width, height, boundaryDistField, segWidth, segHeight, invDiag) {
  if (width === segWidth && height === segHeight) return boundaryDistField[y * segWidth + x] * invDiag;
  const segX = Math.min(Math.floor(x / width * segWidth), segWidth - 1);
  const segY = Math.min(Math.floor(y / height * segHeight), segHeight - 1);
  return boundaryDistField[segY * segWidth + segX] * invDiag;
}

/**
 * Look up a value from a flow field array, handling coordinate scaling.
 */
function lookupFlowValue(x, y, width, height, field, fieldWidth, fieldHeight) {
  if (width === fieldWidth && height === fieldHeight) return field[y * fieldWidth + x];
  const fx = Math.min(Math.floor(x / width * fieldWidth), fieldWidth - 1);
  const fy = Math.min(Math.floor(y / height * fieldHeight), fieldHeight - 1);
  return field[fy * fieldWidth + fx];
}

/**
 * Extract points from dithered output, paired with original image colors.
 *
 * @param {Uint8ClampedArray} ditheredData - RGBA pixel data from dither engine
 * @param {Uint8ClampedArray} originalData - RGBA pixel data from source image
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number[][]} palette - Palette used for dithering (array of [r,g,b])
 * @param {Uint8Array} [regionMap] - Per-pixel region IDs from segmentation map
 * @param {number} [segWidth] - Segmentation map width
 * @param {number} [segHeight] - Segmentation map height
 * @returns {{ homePos: Float32Array, colors: Float32Array, regions: Float32Array|null, boundaryDists: Float32Array|null, coherences: Float32Array|null, flowAngles: Float32Array|null, count: number, width: number, height: number }}
 */
export function extractPoints(ditheredData, originalData, width, height, palette, regionMap, segWidth, segHeight, boundaryDistField, bfsWidth, bfsHeight, flowCoherence, flowAngle, flowWidth, flowHeight) {
  // Background color is the darkest palette entry (index 0 by convention).
  // Any pixel that doesn't match the background is an "on" point.
  const bgR = palette[0][0];
  const bgG = palette[0][1];
  const bgB = palette[0][2];

  const hasRegion = regionMap != null;
  const hasBoundary = hasRegion && boundaryDistField != null;
  const hasFlow = flowCoherence != null && flowAngle != null;
  // L1: BFS field may be half-res — use BFS dimensions for both lookup and
  // normalization. At half-res, distances are in half-res pixels; normalizing
  // by max(bfsW, bfsH) gives the same [0,1] range as full-res.
  const _bfsW = bfsWidth || segWidth;
  const _bfsH = bfsHeight || segHeight;
  const invDiag = hasBoundary ? 1.0 / Math.max(_bfsW, _bfsH) : 0;

  // First pass: count points so we can allocate exact buffer size
  let count = 0;
  for (let i = 0; i < ditheredData.length; i += 4) {
    if (ditheredData[i] !== bgR || ditheredData[i + 1] !== bgG || ditheredData[i + 2] !== bgB) {
      count++;
    }
  }

  // Allocate separate per-attribute arrays
  const homePos = new Float32Array(count * 2);
  const colors  = new Float32Array(count * 3);
  const regions = hasRegion ? new Float32Array(count) : null;
  const boundaryDists = hasBoundary ? new Float32Array(count) : null;
  const coherences = hasFlow ? new Float32Array(count) : null;
  const flowAngles = hasFlow ? new Float32Array(count) : null;

  // Second pass: fill the arrays
  let idx = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      // Skip background pixels
      if (ditheredData[i] === bgR && ditheredData[i + 1] === bgG && ditheredData[i + 2] === bgB) {
        continue;
      }

      // Normalized position (0 to 1)
      homePos[idx * 2]     = x / width;
      homePos[idx * 2 + 1] = y / height;

      // Original color normalized (0 to 1)
      colors[idx * 3]     = originalData[i] / 255;
      colors[idx * 3 + 1] = originalData[i + 1] / 255;
      colors[idx * 3 + 2] = originalData[i + 2] / 255;

      // Region ID (0–5)
      if (regions) {
        regions[idx] = lookupRegion(x, y, width, height, regionMap, segWidth, segHeight);
      }

      // Boundary distance (normalized by seg map diagonal)
      if (boundaryDists) {
        boundaryDists[idx] = lookupBoundaryDist(x, y, width, height, boundaryDistField, _bfsW, _bfsH, invDiag);
      }

      // Flow field: coherence + angle
      if (coherences) {
        coherences[idx]  = lookupFlowValue(x, y, width, height, flowCoherence, flowWidth, flowHeight);
        flowAngles[idx]  = lookupFlowValue(x, y, width, height, flowAngle, flowWidth, flowHeight);
      }

      idx++;
    }
  }

  return { homePos, colors, regions, boundaryDists, coherences, flowAngles, count, width, height };
}

// ── Per-region density floor weights (G22 adaptive density) ──
// Regions that are naturally sparse under Floyd-Steinberg (dark areas have
// fewer "on" pixels by design) need a higher keep-floor so density reduction
// doesn't disproportionately hurt them. Weight in [0, 1] raises the region's
// effective density above the base:
//   effectiveDensity = base + (1 - base) * weight
// Applied in pass 1 of extractPointsWeighted; importance weighting still runs
// on top so edges are preserved regardless of region.
// Region IDs: 0=bg, 1=cypress, 2=village, 3=nightsky, 4=horizon, 5=stars
const REGION_DENSITY_WEIGHT = [
  0.00,  // 0 background
  0.45,  // 1 cypress — darkest, naturally sparse, preserve most
  0.00,  // 2 village
  0.12,  // 3 night sky — dark but large area, gentle preservation
  0.00,  // 4 horizon / swirls
  0.25,  // 5 stars — detail-critical, noticeable at low density
];

// Simple seeded PRNG (mulberry32) — deterministic for a given seed
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Extract points with importance-weighted density reduction.
 *
 * @param {Uint8ClampedArray} ditheredData
 * @param {Uint8ClampedArray} originalData
 * @param {number} width
 * @param {number} height
 * @param {number[][]} palette
 * @param {Float32Array} importanceMap - Per-pixel importance [0, 1]
 * @param {number} density - Keep ratio [0.1, 1.0]. 1.0 = keep all.
 * @param {Uint8Array} [regionMap] - Per-pixel region IDs from segmentation map
 * @param {number} [segWidth] - Segmentation map width
 * @param {number} [segHeight] - Segmentation map height
 * @returns {{ homePos: Float32Array, colors: Float32Array, regions: Float32Array|null, boundaryDists: Float32Array|null, coherences: Float32Array|null, flowAngles: Float32Array|null, count: number, width: number, height: number, fullCount: number }}
 */
export function extractPointsWeighted(ditheredData, originalData, width, height, palette, importanceMap, density, regionMap, segWidth, segHeight, boundaryDistField, bfsWidth, bfsHeight, flowCoherence, flowAngle, flowWidth, flowHeight) {
  const bgR = palette[0][0];
  const bgG = palette[0][1];
  const bgB = palette[0][2];

  // At density 1.0, skip the probability check entirely
  if (density >= 1.0) {
    const result = extractPoints(ditheredData, originalData, width, height, palette, regionMap, segWidth, segHeight, boundaryDistField, bfsWidth, bfsHeight, flowCoherence, flowAngle, flowWidth, flowHeight);
    result.fullCount = result.count;
    return result;
  }

  const hasRegion = regionMap != null;
  const hasBoundary = hasRegion && boundaryDistField != null;
  const hasFlow = flowCoherence != null && flowAngle != null;
  const _bfsW = bfsWidth || segWidth;
  const _bfsH = bfsHeight || segHeight;
  const invDiag = hasBoundary ? 1.0 / Math.max(_bfsW, _bfsH) : 0;

  const rand = mulberry32(42);

  // First pass: count "on" pixels and which survive the density filter
  let fullCount = 0;
  let count = 0;
  const totalPixels = width * height;
  const keep = new Uint8Array(totalPixels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (ditheredData[i] === bgR && ditheredData[i + 1] === bgG && ditheredData[i + 2] === bgB) {
        continue;
      }
      fullCount++;
      const importance = importanceMap[y * width + x];
      // Region-weighted density floor: sparse regions (cypress, stars, night
      // sky) raise their effective density above the base. No-op when region
      // map is absent or weight is zero — reduces to the original formula.
      let effectiveDensity = density;
      if (hasRegion) {
        const regionId = lookupRegion(x, y, width, height, regionMap, segWidth, segHeight);
        const w = REGION_DENSITY_WEIGHT[regionId] || 0;
        if (w > 0) effectiveDensity = density + (1 - density) * w;
      }
      const keepProb = effectiveDensity + (1 - effectiveDensity) * importance;
      if (rand() < keepProb) {
        keep[y * width + x] = 1;
        count++;
      }
    }
  }

  // Allocate separate per-attribute arrays
  const homePos = new Float32Array(count * 2);
  const colors  = new Float32Array(count * 3);
  const regions = hasRegion ? new Float32Array(count) : null;
  const boundaryDists = hasBoundary ? new Float32Array(count) : null;
  const coherences = hasFlow ? new Float32Array(count) : null;
  const flowAngles = hasFlow ? new Float32Array(count) : null;

  // Second pass: fill arrays
  let idx = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!keep[y * width + x]) continue;
      const i = (y * width + x) * 4;

      homePos[idx * 2]     = x / width;
      homePos[idx * 2 + 1] = y / height;
      colors[idx * 3]     = originalData[i] / 255;
      colors[idx * 3 + 1] = originalData[i + 1] / 255;
      colors[idx * 3 + 2] = originalData[i + 2] / 255;

      if (regions) {
        regions[idx] = lookupRegion(x, y, width, height, regionMap, segWidth, segHeight);
      }

      if (boundaryDists) {
        boundaryDists[idx] = lookupBoundaryDist(x, y, width, height, boundaryDistField, _bfsW, _bfsH, invDiag);
      }

      if (coherences) {
        coherences[idx]  = lookupFlowValue(x, y, width, height, flowCoherence, flowWidth, flowHeight);
        flowAngles[idx]  = lookupFlowValue(x, y, width, height, flowAngle, flowWidth, flowHeight);
      }

      idx++;
    }
  }

  return { homePos, colors, regions, boundaryDists, coherences, flowAngles, count, width, height, fullCount };
}
