#!/usr/bin/env node
// Offline pipeline: decode painting + ancillary maps, run the same segmentation /
// dither / point-extraction code the browser runs, emit a binary payload the
// runtime can fetch + mmap. No binary writer yet — this first pass just verifies
// the full Node pipeline runs end-to-end and produces the expected shapes.

import sharp from 'sharp';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import {
  buildRegionMap,
  downsampleRegionMap,
  computeBoundaryDistanceField,
  computeFlowEdgeDistance,
  computeCypressEdgeDistance,
  computeVillageEdgeDistance,
  buildClickRegionMap,
  computeFlowCurvatureAndEddy,
} from '../js/segmentation.js';
import {
  MAGIC, VERSION, HEADER_SIZE, SECTION_ENTRY_SIZE,
  FORMAT, SECTION, packFloat16, align4,
} from '../js/prebake/dvs-format.js';

const MOOD = process.argv.includes('--mood=radiant') ? 'radiant' : 'nocturne';
const PAINTING_PATH = MOOD === 'radiant'
  ? 'assets/moods/starry_night_radiant_V2_1.1.6.jpg'
  : 'assets/starry_night.webp';
const DATA_OUTPUT_PATH = `assets/${MOOD}.data.dvs.br`;
const TERRITORY_PATH = 'assets/territory_map_edit.webp';
const FLOW_PATH = 'assets/flow_field.webp';
const CYPRESS_FLOW_PATH = 'assets/cypress_flow_field.webp';


function t0() { return process.hrtime.bigint(); }
function ms(start) { return Number(process.hrtime.bigint() - start) / 1e6; }

async function decodeRGBA(path) {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

function decodeFlowRGBA(rgba) {
  const { data, width, height } = rgba;
  const n = width * height;
  const coherence = new Float32Array(n);
  const flowAngle = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    coherence[i] = data[j] / 255;
    const cosT = (data[j + 1] / 255) * 2 - 1;
    const sinT = (data[j + 2] / 255) * 2 - 1;
    flowAngle[i] = Math.atan2(sinT, cosT);
  }
  return { coherence, flowAngle, width, height };
}

async function main() {
  console.log(`[prebake] mood=${MOOD} painting=${PAINTING_PATH}`);

  // ── Stage 1: decode all four input images in parallel ──────────────────────
  const _decodeStart = t0();
  const [paintingRGBA, territoryRGBA, flowRGBA, cypressFlowRGBA] = await Promise.all([
    decodeRGBA(PAINTING_PATH),
    decodeRGBA(TERRITORY_PATH),
    decodeRGBA(FLOW_PATH),
    decodeRGBA(CYPRESS_FLOW_PATH),
  ]);
  console.log(`[prebake] decode:      ${ms(_decodeStart).toFixed(0)}ms`);
  console.log(`           painting    ${paintingRGBA.width}×${paintingRGBA.height}`);
  console.log(`           territory   ${territoryRGBA.width}×${territoryRGBA.height}`);
  console.log(`           flow        ${flowRGBA.width}×${flowRGBA.height}`);
  console.log(`           cypressFlow ${cypressFlowRGBA.width}×${cypressFlowRGBA.height}`);

  // ── Stage 2: build the region map (nearest-palette classification) ─────────
  const _segStart = t0();
  const regionMap = buildRegionMap(territoryRGBA.data, territoryRGBA.width, territoryRGBA.height);
  const sw = territoryRGBA.width;
  const sh = territoryRGBA.height;
  console.log(`[prebake] regionMap:   ${ms(_segStart).toFixed(0)}ms (${sw}×${sh})`);

  // ── Stage 3: half-res downsample for BFS fields ────────────────────────────
  const _dsStart = t0();
  const halfReg = downsampleRegionMap(regionMap, sw, sh);
  const hrMap = halfReg.map, hrW = halfReg.width, hrH = halfReg.height;
  console.log(`[prebake] downsample:  ${ms(_dsStart).toFixed(0)}ms (${hrW}×${hrH} half-res)`);

  // ── Stage 4: BFS distance fields (sync in Node — no workers needed) ────────
  const _bfsStart = t0();
  const bfsBoundary = computeBoundaryDistanceField(hrMap, hrW, hrH, [1, 2]);
  const bfsFlowEdge = computeFlowEdgeDistance(hrMap, hrW, hrH);
  const bfsCypressEdge = computeCypressEdgeDistance(hrMap, hrW, hrH);
  const bfsVillageEdge = computeVillageEdgeDistance(hrMap, hrW, hrH);
  console.log(`[prebake] bfs fields:  ${ms(_bfsStart).toFixed(0)}ms (4 fields)`);

  // Live path scales edge fields 2× (half-res px → full-res px). Boundary stays [0,1].
  const flowEdgeDist = new Float32Array(bfsFlowEdge.length);
  const cypressEdgeDist = new Float32Array(bfsCypressEdge.length);
  const villageEdgeDist = new Float32Array(bfsVillageEdge.length);
  for (let i = 0; i < bfsFlowEdge.length; i++) {
    flowEdgeDist[i] = bfsFlowEdge[i] * 2;
    cypressEdgeDist[i] = bfsCypressEdge[i] * 2;
    villageEdgeDist[i] = bfsVillageEdge[i] * 2;
  }

  // ── Stage 5: decode flow field + curvature/eddy (CPU path — no GPU in Node) ─
  const _flowStart = t0();
  const flowField = decodeFlowRGBA(flowRGBA);
  const { curvature, eddyEnergy } = computeFlowCurvatureAndEddy(
    flowField.flowAngle, flowField.coherence, flowField.width, flowField.height
  );
  flowField.curvature = curvature;
  flowField.eddyEnergy = eddyEnergy;
  console.log(`[prebake] flow+curv:   ${ms(_flowStart).toFixed(0)}ms (CPU blur path)`);

  // ── Stage 6: cypress flow field (no curvature needed) ──────────────────────
  const cypressFlow = decodeFlowRGBA(cypressFlowRGBA);

  // ── Stage 7: click remap ───────────────────────────────────────────────────
  const _clickStart = t0();
  const clickRegionMap = buildClickRegionMap(
    regionMap, sw, sh, flowField.coherence, flowField.width, flowField.height
  );
  console.log(`[prebake] clickMap:    ${ms(_clickStart).toFixed(0)}ms`);

  // ── Stage 9: float16-pack derived fields ───────────────────────────────────
  // BFS/curvature/eddy are the expensive derived work this bake eliminates;
  // float16 halves their binary size with no visual impact at the precision
  // ranges involved (distances clamped 0..1, curvature normalized).
  //
  // Flow coherence/angle and cypress flow aren't written — those stay in
  // flow_field.webp / cypress_flow_field.webp and are decoded at runtime.
  //
  // Float16 caveat for future consumers: do NOT pack normalized pixel
  // positions (x/width, y/height) at float16. The 10-bit mantissa collapses
  // adjacent rows at painting-edge scale, producing visible horizontal
  // striations. Use float32 if you ever add per-particle position data.
  const _packStart = t0();
  const boundaryF16    = packFloat16(bfsBoundary);
  const flowEdgeF16    = packFloat16(flowEdgeDist);
  const cypressEdgeF16 = packFloat16(cypressEdgeDist);
  const villageEdgeF16 = packFloat16(villageEdgeDist);
  const curvatureF16   = packFloat16(flowField.curvature);
  const eddyF16        = packFloat16(flowField.eddyEnergy);
  console.log(`[prebake] float16 pack:${ms(_packStart).toFixed(0)}ms`);

  // ── Data-only binary (hybrid prebake) ──────────────────────────────────────
  // Single binary output: BFS + curvature + regionMap + clickRegionMap. The
  // runtime fetches this, then dithers + extracts particles at canvas
  // resolution itself. Canvas-aligned particles on every device (no moire)
  // plus ~700ms saved on the expensive BFS + curvature computation.
  //
  // History: an earlier multi-tier approach (3 resolution-gated binaries with
  // an embedded POINTS section) was superseded in April 2026 — tiered
  // quantization couldn't solve a continuous canvas-size problem. The format
  // spec still reserves V1's POINTS bytes; see js/prebake/dvs-format.js.
  {
    console.log(`\n[prebake] ══ Data-only binary (hybrid) ══`);
    const dataEntries = [
      { id: SECTION.REGION_MAP,       data: regionMap,      format: FORMAT.UINT8   },
      { id: SECTION.CLICK_REGION_MAP, data: clickRegionMap, format: FORMAT.UINT8   },
      { id: SECTION.BFS_BOUNDARY,     data: boundaryF16,    format: FORMAT.FLOAT16 },
      { id: SECTION.BFS_FLOW_EDGE,    data: flowEdgeF16,    format: FORMAT.FLOAT16 },
      { id: SECTION.BFS_CYPRESS_EDGE, data: cypressEdgeF16, format: FORMAT.FLOAT16 },
      { id: SECTION.BFS_VILLAGE_EDGE, data: villageEdgeF16, format: FORMAT.FLOAT16 },
      { id: SECTION.CURVATURE,        data: curvatureF16,   format: FORMAT.FLOAT16 },
      { id: SECTION.EDDY_ENERGY,      data: eddyF16,        format: FORMAT.FLOAT16 },
    ];

    const tableSize = dataEntries.length * SECTION_ENTRY_SIZE;
    let dataStart = align4(HEADER_SIZE + tableSize);
    let cursor = dataStart;
    for (const e of dataEntries) {
      e.offset = cursor;
      e.byteLength = e.data.byteLength;
      cursor = align4(cursor + e.byteLength);
    }
    const fileSize = cursor;

    const out = new ArrayBuffer(fileSize);
    const dv = new DataView(out);
    const u8 = new Uint8Array(out);

    dv.setUint32(0,  MAGIC,             true);
    dv.setUint32(4,  VERSION,           true);
    dv.setUint32(8,  dataEntries.length, true);
    dv.setUint32(12, paintingRGBA.width, true);
    dv.setUint32(16, paintingRGBA.height, true);
    dv.setUint32(20, sw,                true);
    dv.setUint32(24, sh,                true);
    dv.setUint32(28, hrW,               true);
    dv.setUint32(32, hrH,               true);
    dv.setUint32(36, flowField.width,   true);
    dv.setUint32(40, flowField.height,  true);
    // Bytes 44-63 are reserved (zero) in V2 — ArrayBuffer defaults handle it.

    let tCursor = HEADER_SIZE;
    for (const e of dataEntries) {
      dv.setUint32(tCursor,      e.id,         true);
      dv.setUint32(tCursor + 4,  e.offset,     true);
      dv.setUint32(tCursor + 8,  e.byteLength, true);
      dv.setUint32(tCursor + 12, e.format,     true);
      tCursor += SECTION_ENTRY_SIZE;
    }

    for (const e of dataEntries) {
      const src = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      u8.set(src, e.offset);
    }

    const _brStart = t0();
    const compressed = brotliCompressSync(Buffer.from(out), {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: fileSize,
      },
    });

    const dataOutputPath = DATA_OUTPUT_PATH;
    await mkdir(dirname(dataOutputPath), { recursive: true });
    await writeFile(dataOutputPath, compressed);

    const ratio = ((compressed.length / fileSize) * 100).toFixed(0);
    console.log(`[prebake]   wrote ${dataOutputPath}`);
    console.log(`[prebake]   raw size:  ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`[prebake]   brotli-11: ${(compressed.length / 1024 / 1024).toFixed(2)} MB  (${ratio}%, ${ms(_brStart).toFixed(0)}ms)`);
  }

  console.log(`\n[prebake] ✓ All bakes complete`);
}

main().catch((err) => {
  console.error('[prebake] FATAL:', err);
  process.exit(1);
});
