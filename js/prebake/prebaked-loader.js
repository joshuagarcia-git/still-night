// Runtime loader for pre-baked .dvs payloads (V2 hybrid format — data only,
// no particles). Mirrors the output of loadDefaultImage's full-path init so
// callers can hand results straight into applyDithering's upload block.
//
// Returns:
//   {
//     segmentationData: { regionMap, width, height, bfsWidth, bfsHeight,
//                         boundaryDistField, flowEdgeDist, cypressEdgeDist,
//                         villageEdgeDist, clickRegionMap,
//                         villageTopY, villageBottomY },
//     flowFieldData:    { coherence, flowAngle, curvature, eddyEnergy,
//                         width, height },
//     paintingW, paintingH,
//   }
//
// The painting ImageData, cypress flow field, and radiant mood image are NOT
// part of the .dvs — they continue to load from their existing asset paths in
// parallel with this fetch. Split is intentional: keeps .dvs from bloating with
// data the browser already decodes efficiently from PNG/JPEG.
// Particles are dithered + extracted by the runtime at canvas resolution
// (ensures pixel-aligned placement on every device — no moiré).

import {
  MAGIC, VERSION, HEADER_SIZE, SECTION_ENTRY_SIZE,
  FORMAT, SECTION, unpackFloat16,
} from './dvs-format.js';

function _log(...args) { if (typeof window !== 'undefined' && window.__DEBUG) console.log(...args); }

class DvsParseError extends Error {
  constructor(msg) { super(`[prebaked] ${msg}`); this.name = 'DvsParseError'; }
}

function _unpackSection(dv, entry) {
  const { offset, byteLength, format } = entry;
  switch (format) {
    case FORMAT.UINT8:
      return new Uint8Array(dv.buffer, dv.byteOffset + offset, byteLength);
    case FORMAT.UINT16: {
      const count = byteLength >>> 1;
      const u16 = new Uint16Array(count);
      for (let i = 0; i < count; i++) u16[i] = dv.getUint16(offset + i * 2, true);
      return u16;
    }
    case FORMAT.FLOAT16: {
      const count = byteLength >>> 1;
      const u16 = new Uint16Array(count);
      for (let i = 0; i < count; i++) u16[i] = dv.getUint16(offset + i * 2, true);
      return unpackFloat16(u16);
    }
    case FORMAT.FLOAT32: {
      const count = byteLength >>> 2;
      // Aligned zero-copy view if offset is 4-byte aligned (it always is via align4)
      if ((dv.byteOffset + offset) % 4 === 0) {
        return new Float32Array(dv.buffer, dv.byteOffset + offset, count);
      }
      const f32 = new Float32Array(count);
      for (let i = 0; i < count; i++) f32[i] = dv.getFloat32(offset + i * 4, true);
      return f32;
    }
    default:
      throw new DvsParseError(`unknown format ${format} at offset ${offset}`);
  }
}

// Manually decompress a Brotli-encoded ArrayBuffer using the browser's
// DecompressionStream. Used as a defensive fallback when the server serves the
// .dvs.br file without a Content-Encoding header — Netlify sets the header via
// netlify.toml, but local dev servers (VSCode Live Server, python http.server,
// etc.) don't, and we'd rather Just Work than require per-environment config.
async function _brotliDecompress(buf) {
  const stream = new Response(buf).body.pipeThrough(new DecompressionStream('br'));
  return new Response(stream).arrayBuffer();
}

export async function loadPrebaked(path) {
  const _t0 = performance.now();
  // Default fetch() uses credentials 'same-origin', which matches the preload
  // hint's `crossorigin="anonymous"` (per HTML spec, that attribute sets
  // credentials mode to 'same-origin', not 'omit' as commonly assumed).
  const res = await fetch(path);
  if (!res.ok) throw new DvsParseError(`fetch ${path} → ${res.status}`);
  let buf = await res.arrayBuffer();
  const _fetchEnd = performance.now();

  if (buf.byteLength < HEADER_SIZE) throw new DvsParseError('file too small');
  let dv = new DataView(buf);

  // Magic check with fallback: if the magic is wrong, the bytes are probably
  // still Brotli-compressed — decompress on the client and retry.
  let magic = dv.getUint32(0, true);
  if (magic !== MAGIC) {
    if (typeof DecompressionStream === 'undefined') {
      throw new DvsParseError(`bad magic 0x${magic.toString(16)} (no DecompressionStream available)`);
    }
    try {
      buf = await _brotliDecompress(buf);
    } catch (err) {
      throw new DvsParseError(`bad magic 0x${magic.toString(16)}, brotli fallback failed: ${err.message}`);
    }
    dv = new DataView(buf);
    if (buf.byteLength < HEADER_SIZE) throw new DvsParseError('file too small after decompress');
    magic = dv.getUint32(0, true);
    if (magic !== MAGIC) throw new DvsParseError(`bad magic 0x${magic.toString(16)} after decompress`);
    _log('%c[prebaked]%c  client-side brotli fallback (server did not set Content-Encoding)',
      'color: #fbbf24; font-weight: bold', 'color: #999');
  }
  const version = dv.getUint32(4, true);
  if (version !== VERSION) throw new DvsParseError(`version ${version} != expected ${VERSION}`);

  const sectionCount = dv.getUint32(8, true);
  const paintingW    = dv.getUint32(12, true);
  const paintingH    = dv.getUint32(16, true);
  const segW         = dv.getUint32(20, true);
  const segH         = dv.getUint32(24, true);
  const bfsW         = dv.getUint32(28, true);
  const bfsH         = dv.getUint32(32, true);
  const flowW        = dv.getUint32(36, true);
  const flowH        = dv.getUint32(40, true);
  // Bytes 44-63 reserved (V1's particleCount/particleStride retired in V2)

  // Parse section table
  const sections = new Map();
  for (let i = 0; i < sectionCount; i++) {
    const entryOffset = HEADER_SIZE + i * SECTION_ENTRY_SIZE;
    const id         = dv.getUint32(entryOffset,      true);
    const offset     = dv.getUint32(entryOffset + 4,  true);
    const byteLength = dv.getUint32(entryOffset + 8,  true);
    const format     = dv.getUint32(entryOffset + 12, true);
    if (offset + byteLength > buf.byteLength) {
      throw new DvsParseError(`section ${id} overflows file`);
    }
    sections.set(id, { offset, byteLength, format });
  }

  function read(sectionId) {
    const entry = sections.get(sectionId);
    if (!entry) throw new DvsParseError(`missing section ${sectionId}`);
    return _unpackSection(dv, entry);
  }

  // Extract all sections. V2 hybrid binary: BFS + curvature + regionMap only.
  const regionMap       = read(SECTION.REGION_MAP);
  const clickRegionMap  = read(SECTION.CLICK_REGION_MAP);
  const boundaryDist    = read(SECTION.BFS_BOUNDARY);
  const flowEdgeDist    = read(SECTION.BFS_FLOW_EDGE);
  const cypressEdgeDist = read(SECTION.BFS_CYPRESS_EDGE);
  const villageEdgeDist = read(SECTION.BFS_VILLAGE_EDGE);
  const curvature       = read(SECTION.CURVATURE);
  const eddyEnergy      = read(SECTION.EDDY_ENERGY);

  const _parseEnd = performance.now();

  // Shape into the structures the live path produces. Flow coherence/angle
  // aren't in the binary — they come from flow_field.png (decoded in parallel).
  // Same for cypress flow + painting image. Caller is responsible for merging.
  const segmentationData = {
    regionMap,
    width: segW,
    height: segH,
    bfsWidth: bfsW,
    bfsHeight: bfsH,
    boundaryDistField: boundaryDist,
    flowEdgeDist,
    cypressEdgeDist,
    villageEdgeDist,
    clickRegionMap,
    // Manual village Y extent — matches live path hardcoded values at ui.js:2024-2025
    villageTopY: 0.55,
    villageBottomY: 0.95,
  };

  const flowFieldData = {
    // coherence + flowAngle filled by caller from parallel flow_field.png decode
    coherence: null,
    flowAngle: null,
    curvature,
    eddyEnergy,
    width: flowW,
    height: flowH,
  };

  _log(
    `%c[prebaked]%c  fetch: ${(_fetchEnd - _t0).toFixed(0)}ms  parse: ${(_parseEnd - _fetchEnd).toFixed(0)}ms  ` +
    `size: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB`,
    'color: #0cf; font-weight: bold', 'color: #999'
  );

  return {
    segmentationData,
    flowFieldData,
    paintingW,
    paintingH,
  };
}
