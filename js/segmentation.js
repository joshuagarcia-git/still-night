function _log(...args) { if (typeof window !== 'undefined' && window.__DEBUG) console.log(...args); }

/**
 * Segmentation map — loads a hand-painted region map and classifies each pixel
 * to one of 6 regions by nearest-color matching.
 *
 * Region indices:
 *   0 = Default / unmatched
 *   1 = Cypress (green)
 *   2 = Hills & village (brown)
 *   3 = Night sky — deep blue
 *   4 = Swirls — light blue
 *   5 = Stars (yellow)
 */

// Reference RGB centroids for each region (sampled from territory_map_edit.png)
const REGION_COLORS = [
  // index 1: Cypress — dark green
  [28, 82, 20],
  // index 2: Hills & village — warm brown
  [180, 130, 60],
  // index 3: Night sky — deep blue
  [30, 50, 180],
  // index 4: Swirls — light blue
  [100, 170, 230],
  // index 5: Stars — bright yellow
  [240, 220, 40],
];

/**
 * Downsample a region map to half resolution using majority vote per 2×2 block.
 * Avoids nearest-neighbor aliasing at region boundaries — the most common region
 * in each block wins, preserving boundary shapes.
 * @param {Uint8Array} regionMap - Full-res region IDs
 * @param {number} width - Full-res width
 * @param {number} height - Full-res height
 * @returns {{ map: Uint8Array, width: number, height: number }}
 */
export function downsampleRegionMap(regionMap, width, height) {
  const hw = (width + 1) >> 1;
  const hh = (height + 1) >> 1;
  const out = new Uint8Array(hw * hh);
  for (let hy = 0; hy < hh; hy++) {
    const sy = hy * 2;
    for (let hx = 0; hx < hw; hx++) {
      const sx = hx * 2;
      // Gather 2×2 block (clamp at edges)
      const r00 = regionMap[sy * width + sx];
      const r10 = sx + 1 < width ? regionMap[sy * width + sx + 1] : r00;
      const r01 = sy + 1 < height ? regionMap[(sy + 1) * width + sx] : r00;
      const r11 = (sx + 1 < width && sy + 1 < height) ? regionMap[(sy + 1) * width + sx + 1] : r00;
      // Majority vote (most common of 4 samples)
      if (r00 === r10 || r00 === r01 || r00 === r11) { out[hy * hw + hx] = r00; }
      else if (r10 === r01 || r10 === r11) { out[hy * hw + hx] = r10; }
      else { out[hy * hw + hx] = r00; } // tie → top-left wins
    }
  }
  return { map: out, width: hw, height: hh };
}

function colorDistSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr + dg * dg + db * db;
}

/**
 * Classify each pixel to a region index (0–5).
 * @param {Uint8ClampedArray} data - RGBA pixel data from segmentation map
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} Per-pixel region ID
 */
export function buildRegionMap(data, width, height) {
  const n = width * height;
  const regionMap = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const r = data[j];
    const g = data[j + 1];
    const b = data[j + 2];

    let bestRegion = 0;
    let bestDist = Infinity;

    for (let k = 0; k < REGION_COLORS.length; k++) {
      const [cr, cg, cb] = REGION_COLORS[k];
      const dist = colorDistSq(r, g, b, cr, cg, cb);
      if (dist < bestDist) {
        bestDist = dist;
        bestRegion = k + 1; // 1-indexed (0 = unmatched)
      }
    }

    regionMap[i] = bestRegion;
  }

  return regionMap;
}

/**
 * Load segmentation map image and build region map.
 * Uses an offscreen canvas to avoid disturbing the visible canvases.
 * @param {string} path - Path to segmentation map image
 * @returns {Promise<{regionMap: Uint8Array, width: number, height: number}>}
 */
/**
 * Detect star blobs via connected-component analysis on region 5 (yellow).
 * Returns an array of { cx, cy, radius } sorted by area descending.
 * cx, cy are normalized to [0,1]. radius is in UV-diagonal space.
 * @param {Uint8Array} regionMap - Per-pixel region IDs
 * @param {number} width
 * @param {number} height
 * @returns {Array<{cx: number, cy: number, radius: number}>}
 */
export function detectStarBlobs(regionMap, width, height) {
  const STAR_REGION = 5;
  const visited = new Uint8Array(regionMap.length);  // 0 = unvisited
  const blobs = [];
  const diag = Math.sqrt(width * width + height * height);

  for (let i = 0; i < regionMap.length; i++) {
    if (regionMap[i] !== STAR_REGION || visited[i]) continue;

    // BFS flood-fill from this pixel
    const queue = [i];
    visited[i] = 1;
    let sumX = 0, sumY = 0, count = 0;

    while (queue.length > 0) {
      const idx = queue.pop();  // use as stack (DFS) for speed
      const px = idx % width;
      const py = (idx - px) / width;
      sumX += px;
      sumY += py;
      count++;

      // 4-connectivity neighbors
      const neighbors = [
        idx - 1,      // left
        idx + 1,      // right
        idx - width,  // up
        idx + width,  // down
      ];
      for (const ni of neighbors) {
        if (ni >= 0 && ni < regionMap.length && !visited[ni] && regionMap[ni] === STAR_REGION) {
          // Check horizontal wrap: left/right neighbors must be on adjacent columns
          const nx = ni % width;
          if (Math.abs(nx - px) <= 1) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }
    }

    // Compute centroid (normalized 0-1) and radius (in UV-diagonal space)
    const cx = (sumX / count) / width;
    const cy = (sumY / count) / height;
    const radiusPx = Math.sqrt(count / Math.PI);
    const radius = radiusPx / diag;

    blobs.push({ cx, cy, radius, area: count });
  }

  // Sort by area descending (largest = moon first)
  blobs.sort((a, b) => b.area - a.area);

  _log(
    `%c[StarBlobs]%c  Detected ${blobs.length} stars:  ` +
    blobs.map((b, i) => `#${i + 1}: (${b.cx.toFixed(2)}, ${b.cy.toFixed(2)}) r=${b.radius.toFixed(4)} area=${b.area}px`).join('  |  '),
    'color: #ff0; font-weight: bold', 'color: #999'
  );

  return blobs;
}

/**
 * Compute a distance field from locked-region boundaries.
 * Each pixel gets the Euclidean distance (in pixels) to the nearest pixel
 * belonging to a locked region. Pixels inside locked regions get 0.0.
 *
 * Uses multi-source BFS with 8-connectivity (chamfer approximation).
 *
 * @param {Uint8Array} regionMap - Per-pixel region IDs (0–5)
 * @param {number} width
 * @param {number} height
 * @param {number[]} lockedRegions - Region IDs that act as boundaries (e.g. [1, 2])
 * @returns {Float32Array} Per-pixel distance to nearest locked-region pixel
 */
export function computeBoundaryDistanceField(regionMap, width, height, lockedRegions = [1, 2]) {
  const n = width * height;
  const dist = new Float32Array(n);
  // Flat offset arrays — avoids array-of-arrays polymorphic IC that causes V8 deopts
  const SQRT2 = Math.SQRT2;
  const odx = new Float64Array([-1, 1, 0, 0, -1, 1, -1, 1]);
  const ody = new Float64Array([0, 0, -1, 1, -1, -1, 1, 1]);
  const ost = new Float64Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);

  // Initialize: 0 for locked pixels, Infinity for others.
  // Seed BFS queue with all locked-region pixels.
  const queue = new Int32Array(n * 4);  // BFS indices — oversized for re-queuing
  let head = 0, tail = 0;

  // Direct integer comparison instead of Set.has() — avoids polymorphic call deopts
  const lock0 = lockedRegions[0], lock1 = lockedRegions.length > 1 ? lockedRegions[1] : -1;
  for (let i = 0; i < n; i++) {
    const r = regionMap[i];
    if (r === lock0 || r === lock1) {
      dist[i] = 0.0;
      queue[tail++] = i;
    } else {
      dist[i] = Infinity;
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const px = idx % width;
    const py = (idx - px) / width;
    const currentDist = dist[idx];

    for (let k = 0; k < 8; k++) {
      const nx = px + odx[k];
      const ny = py + ody[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      const newDist = currentDist + ost[k];
      if (newDist < dist[ni]) {
        dist[ni] = newDist;
        queue[tail++] = ni;
      }
    }
  }

  _log(
    `%c[Boundary]%c  Distance field computed: ${width}x${height}, ` +
    `${lockedRegions.length} locked regions, queue processed ${tail} entries`,
    'color: #f80; font-weight: bold', 'color: #999'
  );

  return dist;
}

/**
 * Compute a distance field from the edge of region 4 (swirl sky) inward.
 * Each region-4 pixel gets its Euclidean distance (in pixels) to the nearest
 * non-region-4 pixel. Non-region-4 pixels get 0.0.
 *
 * Used for viscous boundary falloff — flow slows near edges.
 *
 * @param {Uint8Array} regionMap - Per-pixel region IDs (0–5)
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array} Per-pixel distance to nearest region-4 edge (0 outside)
 */
export function computeFlowEdgeDistance(regionMap, width, height) {
  // Flow regions: both sky regions (3=night sky, 4=swirl sky) participate in flow.
  // Distance is measured from non-flow boundaries inward into both regions.
  const n = width * height;
  const dist = new Float32Array(n);
  const SQRT2 = Math.SQRT2;
  const odx = new Float64Array([-1, 1, 0, 0, -1, 1, -1, 1]);
  const ody = new Float64Array([0, 0, -1, 1, -1, -1, 1, 1]);
  const ost = new Float64Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);

  const queue = new Int32Array(n * 4);
  let head = 0, tail = 0;

  // Initialize: 0 for non-flow pixels, Infinity for flow pixels.
  // Seed: flow pixels adjacent to a non-flow pixel.
  // Direct integer comparison instead of Set.has() — avoids polymorphic call deopts
  for (let i = 0; i < n; i++) {
    const r = regionMap[i];
    if (r !== 3 && r !== 4) {
      dist[i] = 0.0;
      continue;
    }
    dist[i] = Infinity;

    // Check if this flow pixel borders a non-flow pixel
    const px = i % width;
    const py = (i - px) / width;
    let atEdge = false;
    if (py > 0) { const rn = regionMap[i - width]; if (rn !== 3 && rn !== 4) atEdge = true; }
    if (!atEdge && py < height - 1) { const rn = regionMap[i + width]; if (rn !== 3 && rn !== 4) atEdge = true; }
    if (!atEdge && px > 0) { const rn = regionMap[i - 1]; if (rn !== 3 && rn !== 4) atEdge = true; }
    if (!atEdge && px < width - 1) { const rn = regionMap[i + 1]; if (rn !== 3 && rn !== 4) atEdge = true; }

    if (atEdge) {
      dist[i] = 1.0;  // 1 pixel from edge
      queue[tail++] = i;
    }
  }

  // 8-connectivity BFS inward into flow regions
  while (head < tail) {
    const idx = queue[head++];
    const px = idx % width;
    const py = (idx - px) / width;
    const currentDist = dist[idx];

    for (let k = 0; k < 8; k++) {
      const nx = px + odx[k];
      const ny = py + ody[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      const rn = regionMap[ni];
      if (rn !== 3 && rn !== 4) continue;  // only propagate within flow regions
      const newDist = currentDist + ost[k];
      if (newDist < dist[ni]) {
        dist[ni] = newDist;
        queue[tail++] = ni;
      }
    }
  }

  // Stats
  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i] !== Infinity && dist[i] > maxDist) maxDist = dist[i];
  }
  _log(
    `%c[FlowEdge]%c  Distance field: ${width}x${height}, max depth=${maxDist.toFixed(1)}px`,
    'color: #58f; font-weight: bold', 'color: #999'
  );

  return dist;
}

/**
 * Compute distance from the cypress region boundary inward into cypress.
 * Same BFS algorithm as computeFlowEdgeDistance but for region 1.
 * Returns Float32Array: 0 = outside cypress or at edge, positive = pixels from edge.
 */
export function computeCypressEdgeDistance(regionMap, width, height) {
  const n = width * height;
  const dist = new Float32Array(n);
  const SQRT2 = Math.SQRT2;
  const odx = new Float64Array([-1, 1, 0, 0, -1, 1, -1, 1]);
  const ody = new Float64Array([0, 0, -1, 1, -1, -1, 1, 1]);
  const ost = new Float64Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);

  const queue = new Int32Array(n * 4);
  let head = 0, tail = 0;

  for (let i = 0; i < n; i++) {
    if (regionMap[i] !== 1) {
      dist[i] = 0.0;
      continue;
    }
    dist[i] = Infinity;

    const px = i % width;
    const py = (i - px) / width;
    let atEdge = false;
    if (py > 0 && regionMap[i - width] !== 1) atEdge = true;
    else if (py < height - 1 && regionMap[i + width] !== 1) atEdge = true;
    else if (px > 0 && regionMap[i - 1] !== 1) atEdge = true;
    else if (px < width - 1 && regionMap[i + 1] !== 1) atEdge = true;

    if (atEdge) {
      dist[i] = 1.0;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const px = idx % width;
    const py = (idx - px) / width;
    const currentDist = dist[idx];

    for (let k = 0; k < 8; k++) {
      const nx = px + odx[k];
      const ny = py + ody[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (regionMap[ni] !== 1) continue;
      const newDist = currentDist + ost[k];
      if (newDist < dist[ni]) {
        dist[ni] = newDist;
        queue[tail++] = ni;
      }
    }
  }

  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i] !== Infinity && dist[i] > maxDist) maxDist = dist[i];
  }
  _log(
    `%c[CypressEdge]%c  Distance field: ${width}×${height}, max depth=${maxDist.toFixed(1)}px`,
    'color: #9c3; font-weight: bold', 'color: #999'
  );

  return dist;
}

/**
 * Compute BFS distance from village (region 2) boundary inward.
 * 0 = outside or at edge, positive = pixels from edge into interior.
 * Same algorithm as computeCypressEdgeDistance but for VILLAGE_REGION = 2.
 */
export function computeVillageEdgeDistance(regionMap, width, height) {
  const n = width * height;
  const dist = new Float32Array(n);
  const SQRT2 = Math.SQRT2;
  const odx = new Float64Array([-1, 1, 0, 0, -1, 1, -1, 1]);
  const ody = new Float64Array([0, 0, -1, 1, -1, -1, 1, 1]);
  const ost = new Float64Array([1, 1, 1, 1, SQRT2, SQRT2, SQRT2, SQRT2]);

  const queue = new Int32Array(n * 4);
  let head = 0, tail = 0;

  for (let i = 0; i < n; i++) {
    if (regionMap[i] !== 2) {
      dist[i] = 0.0;
      continue;
    }
    dist[i] = Infinity;

    const px = i % width;
    const py = (i - px) / width;
    let atEdge = false;
    if (py > 0 && regionMap[i - width] !== 2) atEdge = true;
    else if (py < height - 1 && regionMap[i + width] !== 2) atEdge = true;
    else if (px > 0 && regionMap[i - 1] !== 2) atEdge = true;
    else if (px < width - 1 && regionMap[i + 1] !== 2) atEdge = true;

    if (atEdge) {
      dist[i] = 1.0;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const px = idx % width;
    const py = (idx - px) / width;
    const currentDist = dist[idx];

    for (let k = 0; k < 8; k++) {
      const nx = px + odx[k];
      const ny = py + ody[k];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (regionMap[ni] !== 2) continue;
      const newDist = currentDist + ost[k];
      if (newDist < dist[ni]) {
        dist[ni] = newDist;
        queue[tail++] = ni;
      }
    }
  }

  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i] !== Infinity && dist[i] > maxDist) maxDist = dist[i];
  }
  _log(
    `%c[VillageEdge]%c  Distance field: ${width}×${height}, max depth=${maxDist.toFixed(1)}px`,
    'color: #c93; font-weight: bold', 'color: #999'
  );

  return dist;
}

/**
 * Build a click-resolution region map with two reclassifications:
 *   1. Region 3 (night sky) pixels fully enclosed by region 4/5 → region 4
 *   2. Region 4 (swirl) pixels with low flow coherence (sky gust zone) → region 3
 *
 * Uses connected-component flood fill for enclosure + coherence threshold for sky gust.
 *
 * @param {Uint8Array} regionMap - Per-pixel region IDs (0–5)
 * @param {number} width
 * @param {number} height
 * @param {Float32Array} [coherence] - Flow field coherence (0–1), may differ in size
 * @param {number} [cohWidth] - Coherence data width
 * @param {number} [cohHeight] - Coherence data height
 * @returns {Uint8Array} Click-resolved region map (same format as regionMap)
 */
export function buildClickRegionMap(regionMap, width, height, coherence, cohWidth, cohHeight) {
  const n = width * height;
  const clickMap = new Uint8Array(n);
  clickMap.set(regionMap);

  const NIGHT_SKY = 3;
  const SWIRL = 4;
  const STAR = 5;

  const visited = new Uint8Array(n);
  let totalReclassified = 0;
  let componentCount = 0;
  let enclosedCount = 0;

  for (let i = 0; i < n; i++) {
    if (regionMap[i] !== NIGHT_SKY || visited[i]) continue;

    // DFS flood fill to find this connected component
    const component = [];
    const stack = [i];
    visited[i] = 1;
    let enclosed = true;

    while (stack.length > 0) {
      const idx = stack.pop();
      component.push(idx);
      const px = idx % width;
      const py = (idx - px) / width;

      // Canvas edge breaks enclosure
      if (px === 0 || px === width - 1 || py === 0 || py === height - 1) {
        enclosed = false;
      }

      // 4-connectivity neighbors (bounds-checked, no wrap)
      if (px > 0) {
        const ni = idx - 1;
        if (regionMap[ni] === NIGHT_SKY) {
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni); }
        } else if (regionMap[ni] !== SWIRL && regionMap[ni] !== STAR) {
          enclosed = false;
        }
      }
      if (px < width - 1) {
        const ni = idx + 1;
        if (regionMap[ni] === NIGHT_SKY) {
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni); }
        } else if (regionMap[ni] !== SWIRL && regionMap[ni] !== STAR) {
          enclosed = false;
        }
      }
      if (py > 0) {
        const ni = idx - width;
        if (regionMap[ni] === NIGHT_SKY) {
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni); }
        } else if (regionMap[ni] !== SWIRL && regionMap[ni] !== STAR) {
          enclosed = false;
        }
      }
      if (py < height - 1) {
        const ni = idx + width;
        if (regionMap[ni] === NIGHT_SKY) {
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni); }
        } else if (regionMap[ni] !== SWIRL && regionMap[ni] !== STAR) {
          enclosed = false;
        }
      }
    }

    componentCount++;

    if (enclosed && component.length > 0) {
      enclosedCount++;
      totalReclassified += component.length;
      for (let j = 0; j < component.length; j++) {
        clickMap[component[j]] = SWIRL;
      }
    }
  }

  _log(
    `%c[ClickMap]%c  ${componentCount} region-3 components, ${enclosedCount} enclosed → ` +
    `${totalReclassified} pixels reclassified to region 4`,
    'color: #f5a; font-weight: bold', 'color: #999'
  );

  // ── Sky gust reclassification: region 4 with low coherence → region 3 ──
  // Matches shader threshold: skyGustMix = smoothstep(0.25, 0.0, coherence)
  const SKY_GUST_THRESHOLD = 0.25;
  let skyGustCount = 0;
  if (coherence && cohWidth && cohHeight) {
    const scaleX = cohWidth / width;
    const scaleY = cohHeight / height;
    for (let i = 0; i < n; i++) {
      if (clickMap[i] !== SWIRL) continue;
      // UV lookup into coherence data (may be different resolution)
      const px = i % width;
      const py = (i - px) / width;
      const cx = Math.min(cohWidth - 1, (px * scaleX) | 0);
      const cy = Math.min(cohHeight - 1, (py * scaleY) | 0);
      if (coherence[cy * cohWidth + cx] < SKY_GUST_THRESHOLD) {
        clickMap[i] = NIGHT_SKY;
        skyGustCount++;
      }
    }
    _log(
      `%c[ClickMap]%c  ${skyGustCount} region-4 sky gust pixels reclassified to region 3`,
      'color: #0fa; font-weight: bold', 'color: #999'
    );
  }

  return clickMap;
}

/**
 * Compute the Y extent (top/bottom) of a region in UV space.
 * Returns { topY, bottomY } in [0, 1] UV coordinates.
 */
export function computeRegionYExtent(regionMap, width, height, regionId) {
  let minRow = height, maxRow = 0;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      if (regionMap[rowOff + x] === regionId) {
        if (y < minRow) minRow = y;
        if (y > maxRow) maxRow = y;
        break;  // found region in this row, skip to next
      }
    }
  }
  // Convert pixel rows to UV [0, 1]
  const topY = minRow / height;
  const bottomY = maxRow / height;
  _log(
    `%c[RegionExtent]%c  Region ${regionId}: topY=${topY.toFixed(3)} bottomY=${bottomY.toFixed(3)}`,
    'color: #c93; font-weight: bold', 'color: #999'
  );
  return { topY, bottomY };
}

/**
 * Raw curvature via angle gradient magnitude (central finite differences).
 * Returns unblurred Float32Array — shared between curvature and eddy energy.
 */
export function computeRawCurvature(flowAngle, coherence, width, height) {
  const n = width * height;
  const raw = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (coherence[i] <= 0.05) continue;

      const aL = flowAngle[i - 1];
      const aR = flowAngle[i + 1];
      const aU = flowAngle[(y - 1) * width + x];
      const aD = flowAngle[(y + 1) * width + x];
      const a  = flowAngle[i];

      const dxA = aR - a, dxB = aL - a;
      const dadx = Math.atan2(Math.sin(dxA), Math.cos(dxA))
                 - Math.atan2(Math.sin(dxB), Math.cos(dxB));
      const dyA = aD - a, dyB = aU - a;
      const dady = Math.atan2(Math.sin(dyA), Math.cos(dyA))
                 - Math.atan2(Math.sin(dyB), Math.cos(dyB));

      raw[i] = Math.sqrt(dadx * dadx + dady * dady);
    }
  }
  return raw;
}

/**
 * Separable Gaussian blur + 99th-percentile normalization + power curve.
 * Returns Float32Array normalized [0,1].
 */
function blurAndNormalize(raw, width, height, sigma, gamma) {
  const n = width * height;

  // Separable Gaussian blur
  const radius = Math.ceil(3 * sigma);
  const kSize = radius * 2 + 1;
  const kernel = new Float32Array(kSize);
  let kSum = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-0.5 * (k * k) / (sigma * sigma));
    kernel[k + radius] = v;
    kSum += v;
  }
  for (let k = 0; k < kSize; k++) kernel[k] /= kSum;

  // Horizontal pass
  const temp = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.max(0, Math.min(width - 1, x + k));
        sum += raw[y * width + sx] * kernel[k + radius];
      }
      temp[y * width + x] = sum;
    }
  }

  // Vertical pass
  const blurred = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.max(0, Math.min(height - 1, y + k));
        sum += temp[sy * width + x] * kernel[k + radius];
      }
      blurred[y * width + x] = sum;
    }
  }

  // Normalize to [0,1] using 99th percentile of non-zero values
  const nonZero = [];
  for (let i = 0; i < n; i++) {
    if (blurred[i] > 0) nonZero.push(blurred[i]);
  }
  nonZero.sort((a, b) => a - b);
  const p99 = nonZero.length > 0 ? nonZero[Math.floor(nonZero.length * 0.99)] : 1;
  const maxVal = Math.max(p99, 1e-6);

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const linear = Math.min(blurred[i] / maxVal, 1.0);
    result[i] = Math.pow(linear, gamma);
  }
  return { field: result, maxVal };
}

/**
 * 99th-percentile normalization + power curve.
 * Takes a blurred Float32Array and returns normalized [0,1] values.
 * Separated from blurAndNormalize so GPU blur can reuse just this step.
 */
export function normalizeField(blurred, gamma) {
  const n = blurred.length;

  // Pass 1: find max and count non-zero values (O(n))
  let maxRaw = 0, nonZeroCount = 0;
  for (let i = 0; i < n; i++) {
    if (blurred[i] > 0) {
      if (blurred[i] > maxRaw) maxRaw = blurred[i];
      nonZeroCount++;
    }
  }
  if (nonZeroCount === 0) return { field: new Float32Array(n), maxVal: 1e-6 };

  // Pass 2: histogram-based 99th percentile (O(n) — replaces O(n log n) sort)
  const BINS = 10000;
  const binScale = BINS / maxRaw;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < n; i++) {
    if (blurred[i] > 0) {
      hist[Math.min(Math.floor(blurred[i] * binScale), BINS - 1)]++;
    }
  }
  const target = Math.floor(nonZeroCount * 0.99);
  let cumulative = 0, p99Bin = BINS - 1;
  for (let b = 0; b < BINS; b++) {
    cumulative += hist[b];
    if (cumulative >= target) { p99Bin = b; break; }
  }
  const maxVal = Math.max((p99Bin + 0.5) / binScale, 1e-6);

  // Pass 3: normalize + gamma (O(n))
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = Math.pow(Math.min(blurred[i] / maxVal, 1.0), gamma);
  }
  return { field: result, maxVal };
}

/**
 * Compute curvature field from flow angle data (backward-compatible wrapper).
 */
export function computeFlowCurvature(flowAngle, coherence, width, height, sigma = 15) {
  const raw = computeRawCurvature(flowAngle, coherence, width, height);
  const { field, maxVal } = blurAndNormalize(raw, width, height, sigma, 0.5);
  _log(
    `%c[FlowCurv]%c  Curvature field: ${width}×${height}, σ=${sigma}, γ=0.5, 99th-pctl max=${maxVal.toFixed(4)}`,
    'color: #f80; font-weight: bold', 'color: #999'
  );
  return field;
}

/**
 * Compute curvature + eddy energy from flow angle data.
 * Curvature (σ=15): captures all features, drives particle speed.
 * Eddy energy (σ=50): only large-scale swirl structure survives — Kolmogorov energy proxy.
 */
export function computeFlowCurvatureAndEddy(flowAngle, coherence, width, height,
    curvSigma = 15, eddySigma = 50) {
  const raw = computeRawCurvature(flowAngle, coherence, width, height);
  const curv = blurAndNormalize(raw, width, height, curvSigma, 0.5);
  const eddy = blurAndNormalize(raw, width, height, eddySigma, 0.7);
  _log(
    `%c[FlowCurv]%c  Curvature: ${width}×${height}, σ=${curvSigma}, γ=0.5, 99th-pctl=${curv.maxVal.toFixed(4)}`,
    'color: #f80; font-weight: bold', 'color: #999'
  );
  _log(
    `%c[EddyEnrg]%c  Eddy energy: ${width}×${height}, σ=${eddySigma}, γ=0.7, 99th-pctl=${eddy.maxVal.toFixed(4)}`,
    'color: #f60; font-weight: bold', 'color: #999'
  );
  return { curvature: curv.field, eddyEnergy: eddy.field };
}

export async function loadSegmentationMap(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const regionMap = buildRegionMap(imageData.data, canvas.width, canvas.height);

      // Debug: log region distribution
      const counts = new Array(6).fill(0);
      for (let i = 0; i < regionMap.length; i++) counts[regionMap[i]]++;
      const names = ['default', 'cypress', 'hills', 'night sky', 'swirls', 'stars'];
      const total = regionMap.length;
      _log(
        `%c[Segmentation]%c  ${canvas.width}x${canvas.height}  |  ` +
        names.map((n, i) => `${n}: ${((counts[i] / total) * 100).toFixed(1)}%`).join('  |  '),
        'color: #0f0; font-weight: bold', 'color: #999'
      );

      resolve({ regionMap, width: canvas.width, height: canvas.height });
    };
    img.onerror = () => reject(new Error(`Failed to load segmentation map: ${path}`));
    img.src = path;
  });
}

/**
 * Load a precomputed flow field PNG and decode per-pixel strength + flow angle.
 *
 * PNG encoding (from tools/flow-painter.html):
 *   R = flow strength (0–255 → 0.0–1.0)
 *   G = (cos(θ) * 0.5 + 0.5) * 255   — full directional angle
 *   B = (sin(θ) * 0.5 + 0.5) * 255
 *
 * @param {string} path - Path to flow_field.png
 * @returns {Promise<{coherence: Float32Array, flowAngle: Float32Array, width: number, height: number}>}
 */
export async function loadFlowField(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      const n = canvas.width * canvas.height;
      const coherence = new Float32Array(n);
      const flowAngle = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const j = i * 4;
        coherence[i] = data[j] / 255;
        const cosT = (data[j + 1] / 255) * 2 - 1;
        const sinT = (data[j + 2] / 255) * 2 - 1;
        flowAngle[i] = Math.atan2(sinT, cosT);
      }

      _log(
        `%c[FlowField]%c  ${canvas.width}x${canvas.height}  |  ` +
        `strength range: ${Math.min(...coherence.slice(0, 1000)).toFixed(3)}..${Math.max(...coherence.slice(0, 1000)).toFixed(3)} (sampled)`,
        'color: #58f; font-weight: bold', 'color: #999'
      );

      resolve({ coherence, flowAngle, width: canvas.width, height: canvas.height });
    };
    img.onerror = () => reject(new Error(`Failed to load flow field: ${path}`));
    img.src = path;
  });
}
