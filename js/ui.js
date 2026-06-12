/**
 * UI module — DOM events, state management, wiring.
 */

// Debug flag: gates all console.log output. Errors/warnings always visible.
// Add ?debug to URL to enable verbose logging.
window.__DEBUG = typeof location !== 'undefined' && location.search.includes('debug');
function _log(...args) { if (window.__DEBUG) console.log(...args); }

// ── G22: Adaptive particle density (MVP — URL override, no auto-detect) ──
// ?dpr=0.75 → DPR multiplier. Reduces canvas backing store resolution to
// save fragment shader work. 0.75 = 75% of native DPR → ~44% fewer pixels.
// Accepts 0.5–1.0. Visual trade-off: slight softness from browser upscale.
// Mutable: can be set by a future user-facing quality control at runtime.
// `_dprOverridden` tracks whether ?dpr was passed (any value) so the detect-gpu
// auto-downgrade treats it as an explicit escape hatch — e.g. `?dpr=1.0`
// forces full DPR regardless of what detect-gpu thinks.
const _dprOverridden = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('dpr');
let _dprMultiplier = (() => {
  const p = typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('dpr')
    : null;
  if (p != null) {
    const n = parseFloat(p);
    if (!isNaN(n)) {
      const clamped = Math.max(0.5, Math.min(1.0, n));
      _log(`[DPR] Override: ${clamped}× native (effective DPR ${((window.devicePixelRatio || 1) * clamped).toFixed(2)})`);
      return clamped;
    }
  }
  return 1.0;
})();

/** Effective DPR: native × multiplier. Used by canvas resize and touch trail.
 * When _dprMultiplier < 1 (auto or manual downgrade), effective DPR is capped
 * at 2.0. Prevents very high-DPI displays (5K Retina, Pro Display XDR, etc.)
 * from rendering at effective 2.8+ when they've already been flagged as
 * needing a performance downgrade. Tier 3 / full-quality users are unaffected. */
function getEffectiveDpr() {
  const raw = (window.devicePixelRatio || 1) * _dprMultiplier;
  return _dprMultiplier < 1.0 ? Math.min(raw, 2.0) : raw;
}
// Expose for touch-trail.js (separate module, no circular import)
window._dvs_getEffectiveDpr = getEffectiveDpr;

// ?quality=high|medium|low → extractPointsWeighted density parameter.
// high=1.0 (full), medium=0.75 (~75%), low=0.50 (~50%).
// Also accepts a raw numeric density for experimentation: ?quality=0.25
// Importance weighting preserves edges; uniform sky regions thin first.
// Devices below "low" capability get the existing error states, not this tier.
// `_qualityOverridden` tracks whether the param was *set* (regardless of value),
// so `?quality=high` correctly bypasses auto-detection even though its resolved
// name matches the default. Without this, high was indistinguishable from "no
// param" and G22 bench + detect-gpu still fired.
const _qualityOverridden = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('quality');
const _qualityTier = (() => {
  const q = typeof location !== 'undefined'
    ? new URLSearchParams(location.search).get('quality')
    : null;
  if (q === 'low')    return { name: 'low',    density: 0.50 };
  if (q === 'medium') return { name: 'medium', density: 0.75 };
  if (q === 'high')   return { name: 'high',   density: 1.00 };
  // Numeric override for experimentation — clamp to [0.1, 1.0]
  if (q != null) {
    const n = parseFloat(q);
    if (!isNaN(n)) {
      const clamped = Math.max(0.1, Math.min(1.0, n));
      return { name: `custom(${clamped})`, density: clamped };
    }
  }
  return                     { name: 'high',   density: 1.00 };
})();
if (_qualityOverridden) {
  _log(`[G22] Quality tier: ${_qualityTier.name} (density=${_qualityTier.density})`);
}

// ── Touch device detection (for hover-affordance gating) ──
// Pure touchscreens can't hover; synthetic mousemove events from iOS tap
// compatibility must not activate the hover orbit / phantom-cursor path.
const _isTouchDevice = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
  : false;

// ── G22: Pre-visible frame-time benchmark ──
// After shader finalization but BEFORE bloom reveals anything, sample real
// frame times for a short window. If average exceeds the threshold, re-extract
// at fallback density via web worker and swap the buffer. Canvas is held at
// opacity:0 for the entire bench → swap is invisible.
// Skipped entirely if the user manually overrode quality via ?quality=…
const G22_BENCH_THRESHOLD_MS  = 22;   // > 22ms (≈45fps) → drop DPR multiplier
const G22_BENCH_SKIP_FRAMES   = 10;   // skip first N frames (warmup, JIT, GC)
const G22_BENCH_SAMPLE_FRAMES = 20;   // sample window after skip
const G22_BENCH_FALLBACK_DPR  = 0.6;  // _dprMultiplier on bench failure (aggressive — for iPad-class)
// Worker pool entry — ES module worker for extractPointsWeighted off main thread
let _extractWorker = null;
let _extractWorkerWarmup = null;
function spawnExtractWorker() {
  try {
    _extractWorker = new Worker(
      new URL('./workers/extract-worker.js', import.meta.url),
      { type: 'module' }
    );
    // Pre-warm: tiny synthetic dataset to JIT-compile the function path before
    // the real call. Matches the BFS worker pre-warm pattern.
    const W = 16, H = 16;
    const dith = new Uint8ClampedArray(W * H * 4);
    const orig = new Uint8ClampedArray(W * H * 4);
    const imp  = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      // Non-bg color so extractPointsWeighted has pixels to thin
      dith[j] = 100; dith[j+1] = 100; dith[j+2] = 100; dith[j+3] = 255;
      orig[j] = 100; orig[j+1] = 100; orig[j+2] = 100; orig[j+3] = 255;
      imp[i]  = 0.5;
    }
    _extractWorkerWarmup = new Promise((resolve) => {
      _extractWorker.addEventListener('message', () => resolve(), { once: true });
    });
    _extractWorker.postMessage([dith, orig, W, H, [[0,0,0],[255,255,255]], imp, 0.5]);
  } catch (e) {
    console.warn('[G22] Failed to spawn extract worker — benchmark disabled:', e);
    _extractWorker = null;
    _extractWorkerWarmup = null;
  }
}
spawnExtractWorker();

// ── User-perceived load time tracking ──
const _loadTimeline = { navigationStart: performance.now() };

// Moon loader HTML for retry — captured from index.html at init so the SVG
// has a single source of truth. Populated by initUI() once DOM is ready.
let _moonLoaderHTML = '';

import { MATRICES } from './dither/matrices.js';
import { PALETTES } from './dither/palettes.js';
import { ditherErrorDiffusion, ditherBWFast } from './dither/dither-engine.js';
import { loadImageFromPath } from './dither/canvas-renderer.js';
import { extractPointsWeighted } from './dither/points.js';
import { createRenderer } from './gl-renderer.js';
import { perfMark, perfBeforeRenderStart, perfRendererStats, perfInit, perfIsEnabled, perfSetRegionStates } from './debug/perf-overlay.js';
import { computeImportanceMap } from './dither/importance.js';
import { loadSegmentationMap, loadFlowField, computeBoundaryDistanceField, computeFlowEdgeDistance, computeCypressEdgeDistance, computeVillageEdgeDistance, computeFlowCurvatureAndEddy, computeRawCurvature, normalizeField, buildClickRegionMap, downsampleRegionMap } from './segmentation.js';
import { loadPrebaked } from './prebake/prebaked-loader.js';
import { getGPUTier } from './vendor/detect-gpu.esm.js';
import {
  regionMouseDown, regionMouseUp, regionStop, muteAllRegions, playRegion, stopRegion, setRegionIntensity,
  setMouseExprActive, setMouseExprDrag,
  getStarsAudioFeatures, getStarsEffectLevels,
  getHorizonAudioFeatures, getHorizonRawAudio,
  getRegionAudioFeatures, getRegionRawAudio, advanceAnalysisFrame,
  setOnStateChange, getRegionState,
  ensureRegionAudioInit, preBuildAudioNodes, resetAudioInit,
  setWindHarpParam, getWindHarpV3Diag, getHarpEvolutionScales, getHorizonAudioSnapshot, getWindHarpMeters,
  setCypressLivingWoodParam, getCypressLivingWoodDiag,
  getCypressMeters,
  getStarsMeters,
  getCelestialStringsDiag, getCelestialStringsMacro,
  setCelestialStringsParam,
  getCelestialStringsYMacro,
  getCelestialStringsBreathing,
  getCelestialStrumBoosts,
  fireStarsStrum,
  setVillagePulseParam,
  setNightSkyParam,
  getVillagePulseLfoRate,
  isRegionFrozen, getRegionDebugState,
  setMouseExprHover,
  setAudioMode,
} from './audio/region-synths.js';
// audio-scope: loaded conditionally via ?debug (js/debug/audio-scope.js)
import { audioDiag } from './debug/audio-diagnostic.js';
import * as touchTrail from './touch-trail.js';
import * as ambientGlow from './ambient-glow-v2.js';

// ── detect-gpu auto-downgrade (complements G22 bench) ──
// Classifies the GPU (tier 0-3) via pmndrs/detect-gpu. Applied before dither:
//   tier 0         → hard block, show "not supported" error state
//   tier 1 or 2    → _dprMultiplier = 0.7, skip G22 bench (already downgraded)
//   tier 3         → leave at 1.0, G22 bench runs and may escalate to 0.6
// Covers vsync-masked weak devices (MacBook Intel Iris) that G22's idle
// frame-time bench misses; G22 still catches devices detect-gpu mis-tiers
// as strong (iPad A12 → tier 3 but ~33ms frame time).
//
// Skipped entirely when user manually overrode ?dpr= or ?quality= (any value).
// Kicked off at module load so it runs in parallel with asset loads; result
// awaited just before applyDithering(). Fetches a ~50KB (Intel) / 2KB (Apple)
// benchmark JSON from unpkg on first run, browser-cached thereafter.
const _detectGpuEnabled = !_dprOverridden && !_qualityOverridden;
const _detectGpuPromise = _detectGpuEnabled
  ? getGPUTier().catch(err => { console.warn('[detect-gpu] failed:', err); return null; })
  : null;
let _detectGpuResult = null;
// Set when detect-gpu triggered a DPR downgrade — lets G22 bench skip itself
// since the device is already classified. Distinct from `_dprMultiplier < 1.0`
// because manual `?dpr=` overrides shouldn't skip the bench.
let _detectGpuDowngraded = false;

// Debug: window-exposed region triggers for automated measurement scripts.
// Opt-in via ?exposeAudioAPI=1 — used by tools/render-capacity-test.js to
// drive regions directly via CDP Runtime.evaluate instead of synthesizing
// click events (which are unreliable for region 5 / stars). Zero effect on
// normal page loads.
if (typeof location !== 'undefined' && location.search.includes('exposeAudioAPI')) {
  window.__test = {
    play: (id) => regionMouseDown(id),
    stop: (id) => stopRegion(id),
    state: (id) => getRegionState(id),
  };
}
// Vortex: precomputed phyllotaxis spiral targets, blended in vertex shader

// ── BFS Worker Pool ──
// Pre-creates 4 dedicated workers (one per BFS function) and warms V8's JIT
// with a tiny grid before real data arrives. Workers persist for reuse (mood switch).
// V8 deoptimizes blob worker code 8-12× on cold start; pre-warming shifts that
// cost to idle time during shader compilation / image download.
const _bfsWorkerPool = {};

function _createBfsWorker(fn) {
  // Bake __DEBUG as a literal so the worker (which has no `window`) can gate its own logs.
  const workerCode = `
    const __DEBUG = ${window.__DEBUG ? 'true' : 'false'};
    function _log(...args) { if (__DEBUG) console.log(...args); }
    ${fn.toString()}
    self.onmessage = function(e) {
      const t0 = performance.now();
      const result = ${fn.name}(...e.data);
      const elapsed = performance.now() - t0;
      _log('%c[Worker:${fn.name}]%c  ' + elapsed.toFixed(0) + 'ms', 'color: #0af; font-weight: bold', 'color: #999');
      const transfer = result && result.buffer ? [result.buffer] : [];
      self.postMessage(result, transfer);
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  // Prevent blob URL leak — revoke after worker has loaded the script
  worker.addEventListener('message', () => URL.revokeObjectURL(url), { once: true });
  return worker;
}

function warmBfsWorkers() {
  // Tiny 4×4 region map exercises all BFS code paths (loop, typed arrays,
  // offsets, comparisons) so V8 JIT-compiles the functions before real data.
  const warmMap = new Uint8Array([
    0,0,1,1, 0,3,3,4, 2,3,4,4, 2,2,4,5
  ]);
  const fns = [
    ['boundary',    computeBoundaryDistanceField],
    ['flowEdge',    computeFlowEdgeDistance],
    ['cypressEdge', computeCypressEdgeDistance],
    ['villageEdge', computeVillageEdgeDistance],
  ];
  for (const [name, fn] of fns) {
    const w = _createBfsWorker(fn);
    _bfsWorkerPool[name] = { worker: w, ready: false };
    // Warmup: send tiny grid. The result is discarded but V8 compiles the function.
    const _warmupSentAt = performance.now();
    const warmupPromise = new Promise(resolve => {
      w.addEventListener('message', () => {
        _bfsWorkerPool[name].ready = true;
        _bfsWorkerPool[name].warmupMs = performance.now() - _warmupSentAt;
        resolve();
      }, { once: true });
    });
    if (name === 'boundary') {
      w.postMessage([warmMap, 4, 4, [1, 2]]);
    } else {
      w.postMessage([warmMap, 4, 4]);
    }
    _bfsWorkerPool[name].warmup = warmupPromise;
  }
}

async function runOnWarmWorker(name, fn, ...args) {
  const entry = _bfsWorkerPool[name];
  if (!entry || !entry.worker) {
    // Fallback: no pre-warmed worker, create one on the fly (cold path)
    return _runOnColdWorker(fn, ...args);
  }
  // Wait for warmup to finish before sending real data — prevents message interleaving
  const _awaitT0 = performance.now();
  if (entry.warmup) await entry.warmup;
  const _awaitElapsed = performance.now() - _awaitT0;
  _log(`%c[WarmupAwait:${name}]%c  ${_awaitElapsed.toFixed(0)}ms (worker startup+warmup took ${(entry.warmupMs || 0).toFixed(0)}ms)`, 'color: #f80; font-weight: bold', 'color: #999');
  const _sendT = performance.now();
  return new Promise((resolve, reject) => {
    const w = entry.worker;
    w.onmessage = (e) => {
      const _recvT = performance.now();
      _log(`%c[WorkerDelay:${name}]%c  send→receive: ${(_recvT - _sendT).toFixed(0)}ms`, 'color: #fa0; font-weight: bold', 'color: #999');
      resolve(e.data);
    };
    w.onerror = (err) => {
      reject(err);
      entry.worker = null;
    };
    w.postMessage(args);
  });
}

function _runOnColdWorker(fn, ...args) {
  return new Promise((resolve, reject) => {
    const w = _createBfsWorker(fn);
    w.onmessage = (e) => {
      resolve(e.data);
      w.terminate();
    };
    w.onerror = (err) => {
      reject(err);
      w.terminate();
    };
    w.postMessage(args);
  });
}

// ── Spawn BFS workers at module load time ──
// Workers run on separate threads — V8 isolate creation, blob JS parsing, and
// warmup computation happen in background while the main thread evaluates the
// rest of this module + compiles shaders. The earlier we start, the more likely
// the warmup resolves before loadDefaultImage needs the workers.
warmBfsWorkers();

// OffscreenCanvas shader cache warming experiment (April 10): FAILED.
// Worker and main thread share the same ANGLE D3DCompile thread on Firefox —
// compilations serialize, doubling total time (4.2s → 6.4s). Reverted.

// ── Pre-warm region audio ──
// Phase 1: Build all audio nodes during browser idle time after page load.
//   Tone.js nodes work on a suspended AudioContext — the ~300ms of node
//   construction happens in idle time, well before the user interacts.
//   This avoids blocking the render loop (which caused a first-click particle glitch).
// Audio initialization deferred to intro Play button click.
// The 1.5s reveal animation provides ample time for ~300ms node construction.
// This eliminates "AudioContext was prevented from starting automatically" warnings
// since all AudioContext creation happens after a user gesture.
let _audioPreBuilt = false;
let _audioDisabled = false;  // true if Tone.js missing or build failed — disables all audio features
let _contextLost = false;    // true after webglcontextlost — gates all GL and init work

// ── Region update gating: skip inactive systems after grace period ──
// Grace period allows smoothing/easing to wind down to safe values.
const REGION_OFF_GRACE = 3.0; // seconds after 'off' before skipping updates
const _regionOffTimer = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
let _lastRegionState = { 1: 'off', 2: 'off', 3: 'off', 4: 'off', 5: 'off' };

function shouldSkipRegionUpdate(regionId, dtSec) {
  const state = getRegionState(regionId) || 'off';
  if (state !== 'off') {
    _regionOffTimer[regionId] = 0;
    _lastRegionState[regionId] = state;
    return false;
  }
  // Region is 'off' — accumulate grace timer
  if (_lastRegionState[regionId] !== 'off') {
    // Just transitioned to 'off'
    _lastRegionState[regionId] = 'off';
    _regionOffTimer[regionId] = 0;
  }
  _regionOffTimer[regionId] += dtSec;
  return _regionOffTimer[regionId] > REGION_OFF_GRACE;
}

function initAudioOnGesture() {
  audioDiag.mark('initAudioOnGesture:entry', { audioPreBuilt: _audioPreBuilt, audioDisabled: _audioDisabled });
  if (_audioPreBuilt || _audioDisabled) return;
  if (typeof Tone === 'undefined') {
    console.warn('[Audio] Tone.js not loaded — audio disabled');
    _audioDisabled = true;
    return;
  }
  _audioPreBuilt = true;
  const _t0 = performance.now();
  // Tone.start() MUST be called synchronously within the user gesture call
  // stack. iOS Safari rejects it inside .then() chains or synthetic events.
  // This is the only place it's guaranteed to be a real user gesture (Play tap).
  audioDiag.mark('Tone.start:before');
  Tone.start();
  audioDiag.mark('Tone.start:after');
  const _tStart = performance.now();
  _log(`%c[PlayAudio]%c  Tone.start(): ${(_tStart - _t0).toFixed(0)}ms`, 'color: #f0f; font-weight: bold', 'color: #ccc');
  preBuildAudioNodes().then(() => {
    const _tBuild = performance.now();
    _log(`%c[PlayAudio]%c  preBuildAudioNodes: ${(_tBuild - _tStart).toFixed(0)}ms`, 'color: #f0f; font-weight: bold', 'color: #ccc');
    audioDiag.mark('preBuildAudioNodes:resolved (from gesture)');
    return ensureRegionAudioInit();
  }).then(() => {
    const _tInit = performance.now();
    _log(`%c[PlayAudio]%c  ensureRegionAudioInit: ${(_tInit - _t0).toFixed(0)}ms total from click`, 'color: #f0f; font-weight: bold', 'color: #ccc');
    audioDiag.mark('ensureRegionAudioInit:resolved (from gesture)');
  }).catch(e => {
    console.error('[Audio] Audio initialization failed — audio disabled:', e);
    _audioDisabled = true;
  });
}

// Hardcoded defaults
const MATRIX_KEY = 'floydSteinberg';
const PALETTE_KEY = 'bw';
const SERPENTINE = true;

// Hardcoded star vortex preset — 12 vortices with tuned per-vortex art params.
const STAR_PRESET = [
  { x: 0.898, y: 0.167, sign:  1, strength: 2.0,                gravity: 0.00019452257249714033, speed: 0.70,               armTightness: 0.25, armCurl: 2.0,                curlAmount: 0.0004,               trail: 1.0   },
  { x: 0.351, y: 0.532, sign:  1, strength: 1.0478678423790886, gravity: 0.00008082283341594535, speed: 0.63,               armTightness: 0.4,  armCurl: 1.8,                curlAmount: 0.0003,               trail: 0.4521321576209113 },
  { x: 0.610, y: 0.088, sign:  1, strength: 1.13,               gravity: 0.000042071421166656344,speed: 0.425,              armTightness: 0.6,  armCurl: 1.7,                curlAmount: 0.0003,               trail: 0.4   },
  { x: 0.108, y: 0.050, sign:  1, strength: 1.1362726143883308, gravity: 0.00003983719216300221, speed: 0.43,               armTightness: 0.75, armCurl: 1.5,                curlAmount: 0.0003,               trail: 0.35  },
  { x: 0.708, y: 0.229, sign:  1, strength: 1.1441819524999606, gravity: 0.00003617031664232783, speed: 0.437,              armTightness: 0.5,  armCurl: 1.5,                curlAmount: 0.0002,               trail: 0.35  },
  { x: 0.348, y: 0.045, sign:  1, strength: 2.0,                gravity: 0.000034116934707083485,speed: 0.84,               armTightness: 0.75, armCurl: 1.1543672686691502, curlAmount: 0.00030033872463494757,trail: 0.33087345373383004 },
  { x: 0.236, y: 0.173, sign:  1, strength: 1.1695226418949718, gravity: 0.000024422032233680685,speed: 0.461,              armTightness: 0.6,  armCurl: 1.7,                curlAmount: 0.00029905141384134167,trail: 0.3   },
  { x: 0.132, y: 0.479, sign:  1, strength: 1.1839518398013233, gravity: 0.000017732462027044996,speed: 0.42,               armTightness: 0.7,  armCurl: 1.5,                curlAmount: 0.00025215652064569877,trail: 0.31604816019867654 },
  { x: 0.326, y: 0.329, sign:  1, strength: 1.193291523239182,  gravity: 0.000013402459176518924,speed: 0.484,              armTightness: 0.6,  armCurl: 1.5,                curlAmount: 0.0002218025494726584, trail: 0.2   },
  { x: 0.412, y: 0.066, sign: -1, strength: 0.75,               gravity: 0.000013103687522409922,speed: 0.484,              armTightness: 0.7,  armCurl: 1.0303201772999482, curlAmount: 0.00021970811524496628,trail: 0.15  },
  { x: 0.228, y: 0.032, sign:  1, strength: 1.197111016802628,  gravity: 0.000011631690592409477,speed: 0.487,              armTightness: 0.85, armCurl: 1.0144449159868596, curlAmount: 0.0002093891953914588, trail: 0.30288898319737195 },
  { x: 0.046, y: 0.451, sign:  1, strength: 1.2,                gravity: 0.000010292319128379368,speed: 0.49,               armTightness: 0.73, armCurl: 1.0,                curlAmount: 0.0001,               trail: 0.1   },
];

let staggerTimers = [];  // track pending setTimeout IDs for twilight emergence
let starVortexIds = [];  // IDs of pre-placed dormant star vortices (1:1 with STAR_PRESET)
let starVorticesActive = false;   // true once Stars click triggers activation
let activationTimers = [];        // setTimeout IDs for staggered activation
let _pendingStarReset = false;    // true while waiting for removal animation to finish before re-creating dormant
let _starPendingDismiss = false;  // true on mousedown while stars active — cleared on drag, fires dismiss on mouseup tap
let _starStrumTimer = null;       // 300ms deferred dismiss — second tap within window fires strum instead
let _starExprDeferred = false;    // true when expression setup awaits async playRegion resolution

// Delayed spiral: tightness/curl/turbulence start at 0 and ramp to preset
// after gravity reaches target. Per-vortex timestamp tracks when gravity arrived.
const _spiralDelayReached = new Map(); // vortexId → performance.now() timestamp
const SPIRAL_DELAY_RAMP = 3.0; // seconds to ramp from 0 to preset

// ── Hold-to-expand activation ──
let _holdExpandActive = false;     // true while mouse is held and expanding
let _holdExpandOrigin = [0, 0];    // click position in world coords
let _holdExpandStart = 0;          // performance.now() when hold began
const HOLD_EXPAND_INITIAL = 0.08;  // immediate reach radius (normalized)
const HOLD_EXPAND_MAX = 1.5;       // full canvas diagonal reach
const HOLD_EXPAND_DURATION = 2.5;  // seconds to reach max
// yKeyHeld removed — Y is now a simple toggle via u_regionMix (no hold behavior)

let _flowClickHeld = false;                          // true while click-holding on swirl region
let _regionLockId  = 0;                              // 0 = no lock, 1-5 = locked region (L key)
let _lastActivatedRegion = 0;                        // most recently mousedown-activated region
let _horizonAutoPlay = false;                        // true when Play button started region 4
let _horizonPlayBtn = null;                          // reference for state sync
let _nightSkyResetFn = null;                         // called by onStateChange to reset Night Sky play button

const AMBIENT_FLOW_SCALE = 0.25;  // flow speed multiplier during looping (no mouse held)
/** Check whether region 4 is looping and should maintain ambient flow. */
function _isHorizonLooping() { return getRegionState(4) === 'looping'; }

// ── Horizon audio → visual mapping state ──
let _flowSpeedBase = 0;          // slider base values (audio adds on top)
let _flowDriftFracBase = 0.85;
let _skyGustAmpBase = 1.0;
let _gustAmpBase = 0.50;
let _skyMaxDriftBase = 0.008;
let _skySwayBase = 0.35;
let _skyShimmerBase = 0.05;
let _skyShimmerEased = 0.05;   // eased shimmer — prevents abrupt cutoff when onset hard-zeros
let _skyTrailBase = 0.85;
let _swirlTrailBase = 0.70;
let _eddyContrastBase = 0.15;
let _canvasDeformBase = 0.020;
// Smoothed spectral features — separate accumulators per temporal tier
// Inputs: rmsNorm (energy) + spread (timbral complexity). Onset bypasses smoothing.
let _hzSmoothFlow   = { rms: 0, spread: 0, mids: 0 };
const _hzSmoothFlowKeys = ['rms', 'spread', 'mids'];
const _hzSmoothFlowRaw  = { rms: 0, spread: 0, mids: 0 };
// Drift Fraction: slow RMS envelope tracks intensity tier (1.5s atk / 3s rel),
// flow-tier RMS provides the fast signal. Self-normalizing ratio → ±swing oscillation.
let _hzDriftEnvelope = 0;
let _hzFlowSpeedEnv = 0;   // slow mids envelope for flow speed
// Slider refs for all 9 audio-modulated params (animated per-frame)
let _hzSliders = {};  // key → { slider, valSpan, fmt }
// Flow cursor override: mouse direction replaces painted flow near cursor
let _flowCursorDirRaw = [0, 0];    // raw mouse velocity in UV/sec (set per mousemove)
let _flowCursorDirSmooth = [0, 0]; // smoothed direction (exponential)
let _flowCursorLastDir = [1, 0];   // last valid normalized direction (held during decay)
let _flowCursorUV = [0.5, 0.5];    // cursor position in UV space
let _flowCursorSpeed = 0;           // smoothed cursor speed (for influence decay)
let _flowCursorRadiusBase = 0.08;  // slider base (minimum radius)
let _flowCursorRadiusEased = 0.08; // eased effective radius sent to renderer
// Star cursor tidal pull: presence-based vortex deformation
let _starCursorSpeed = 0;
// Per-vortex cursor speed multiplier state (eased independently per vortex)
const _vortexCursorMult = new Float32Array(16).fill(1.0); // current eased multiplier
let _vortexCursorBoost = 2.50;  // extra angular velocity when cursor inside (rad/sec)
let _vortexCursorAtkTau = 0.50; // attack tau (seconds)
let _vortexCursorRelTau = 0.80; // release tau (seconds)
let _vortexCursorPrevUV = [0.5, 0.5]; // previous frame cursor UV (for speed computation)
let _vortexCursorSpeedSmooth = 0;     // smoothed cursor speed in UV/sec
// Cursor bump slider refs for live audio-modulated readouts
let _bumpSliders = {};
// Star cursor push influence: separate slow build so click motion doesn't spike push
let _starPushInfluence = 0;
// Debug: pin bump to vortex 0 center for off-canvas slider tuning
let _starBumpPinned = false;
// Tunable cursor bump params (driven by sidebar sliders)
const _starDisrupt = {
  bumpStrength: 0.008, // push displacement in UV (like Night Sky wake), speed-scaled
  pushRadius: 0.60,    // influence zone as fraction of vortex orbital radius
  influenceAtk: 0.10,
  influenceRel: 0.60,
  trailPersist: 0.90,  // FBO trail persistence near cursor (0-0.98)
};

// Night Sky sky gust: smoothed audio tier for visual modulation
let _nsSmoothSky = { rms: 0, spread: 0 };
const _nsSmoothSkyKeys = ['rms', 'spread'];
const _nsSmoothSkyRaw  = { rms: 0, spread: 0 };
let _nsMidsEnv = 0;  // slow mids envelope for drift distance
let _nsSliders = {};  // sky gust slider refs in Night Sky panel

// ── Cypress audio → visual mapping state ──
let _cySwayBase = 1.5, _cyDistBase = 0.008, _cyCrossBase = 0.6;
let _cyTrailBase = 0.85, _cyCanopyGlowBase = 0.25, _cyBreathBase = 8.0;
let _cyFlowDriftBase = 0.015, _cyFlowGustBase = 0.50;
let _cyRimGlowBase = 0.3, _cyLeafFlashBase = 0.2;
let _cyFlowDriftFracBase = 0.90;
let _cyRawWindVx = 0;           // raw signed horizontal velocity (set per mousemove)
let _cyWindBias = 0;            // smoothed wind direction bias [-1, 1]
const _cySmoothFlow = { rms: 0, mids: 0 };
const _cySmoothFlowKeys = ['rms', 'mids'];
const _cySmoothFlowRaw  = { rms: 0, mids: 0 };
const _cySmoothBass = { bass: 0 };
const _cySmoothBassKeys = ['bass'];
const _cySmoothBassRaw  = { bass: 0 };
const _cySmoothCanopy = { rms: 0 };
const _cySmoothCanopyKeys = ['rms'];
const _cySmoothCanopyRaw  = { rms: 0 };
const _cySmoothFlux = { flux: 0 };
const _cySmoothFluxKeys = ['flux'];
const _cySmoothFluxRaw  = { flux: 0 };
let _cyDriftEnvelope = 0;   // slow bass envelope for drift fraction
let _cyFlowEnv = 0;         // slow mids envelope for flow params
let _cyOnsetEased = 0;      // eased onset (fast attack, slow release)
let _lastCypressFeatures = null;
let _cySliders = {};         // label → { slider, valSpan, deltaSpan, fmt, initial }

// ── Village audio → visual state ──
const _vlSmoothBody       = { rms: 0 };
const _vlSmoothBodyKeys   = ['rms'];
const _vlSmoothBodyRaw    = { rms: 0 };
const _vlSmoothFoundation = { bass: 0 };     // foundation tier (bass → breathing depth)
const _vlSmoothWind       = { mids: 0 };
const _vlSmoothWindKeys   = ['mids'];
const _vlSmoothWindRaw    = { mids: 0 };
const _vlSmoothShimmer    = { rms: 0 };
const _vlSmoothShimmerKeys = ['rms'];
const _vlSmoothShimmerRaw  = { rms: 0 };
let _vlOnsetEased = 0;                        // eased onset for amplitude spike
let _vlBreathPhase = 0.0;                      // accumulated breathing phase (radians)
let _lastVillageFeatures = null;
let _vlAmpBase = 0.001;                       // slider base for orbital amplitude
let _vlBreathDepthBase = 0.5;                  // slider base for breathing depth
let _vlNoiseDriftBase = 0.001;                 // slider base for noise drift
let _vlCrossSwayBase = 0.1;                    // slider base for cross sway
let _vlCursorUV = [0.5, 0.5];                  // cursor position in UV space
let _vlAttractionRaw = 0;                      // 1 when mouse held on village, 0 otherwise
let _vlAttractionSmoothed = 0;                 // eased attraction strength
let _vlSwarmTime = 0;                          // accumulated swarm time (advances proportional to attraction)
let _vlPrevCursorUV = [0.5, 0.5];             // previous frame cursor UV for movement detection
let _vlWindBlend = 0;                         // smoothed 0=cursor in village, 1=cursor outside
let _vlExitPointUV = [0.6, 0.7];             // cursor UV when it last left the village
let _vlRippleRadius = 0.15;                   // expanding participation radius from exit point
let _vlWasInVillage = true;                   // previous frame: was cursor in village?
let _vlDriftFracSmoothed = 0.50;             // independent drift fraction (decays slowly on re-entry)
let _vlCursorMovingSmoothed = 0;              // eased 0→1: cursor still vs moving
let _vlSliders = {};                           // label → { slider, valSpan, deltaSpan, fmt, initial }

const VILLAGE_MAPPING = {
  // Tier time constants — heavier than other regions (grounded)
  bodyAttack:       0.800, bodyRelease:       2.000,
  foundationAttack: 0.150, foundationRelease: 0.400,
  windAttack:       0.600, windRelease:       1.500,
  shimmerAttack:    0.300, shimmerRelease:    0.800,

  // Step 2: rmsNorm → orbital amplitude
  ampDepth:         0.012,  // rms × depth added to base (0.004 + 0.28*0.012 ≈ 0.007 at peak)

  // Step 3: rmsNorm → breathing depth (pulse-level response)
  breathDepthDepth: 0.8,    // rmsNorm × depth added to base (0.5 + 0.75*0.8 ≈ 1.0 at peak)

  // Breathing visual rate cap
  breathRateCap:    1.0,    // max visual breathing Hz (audio LFO goes higher)

  // Step 4: mids → noise drift
  noiseDriftDepth:  0.05,   // mids × depth added to base (0.002 + 0.18*0.05 ≈ 0.011 at peak)

  // Step 5: rmsNorm → cross sway (shimmer tier)
  crossSwayDepth:   0.4,    // rmsNorm × depth added to base (0.1 + 0.75*0.4 ≈ 0.4 at peak)
};
window._villageMapping = VILLAGE_MAPPING;

// ── Audio Scope (bottom overlay, key 3) ──
let _audioScope = null;
let _lastHorizonFeatures = null;
let _lastStarsFeatures = null;
let _lastMappingOutput = null;
let _audioDiagCounter = 0;       // throttle diagnostic logs (~2 Hz)

// ── Stars audio-reactive mapping config ──
// Crossmodal mappings: audio features → vortex visual params.
// Tunable at runtime via window._starsMapping in the console.
const STARS_MAPPING = {
  // Centroid (spectral brightness 0–1) → particle swell
  centroidToSwell: 1.0,
  // Audio-driven speed envelope (heavy flywheel metaphor)
  speedMaxBoost: 0.80,    // max +80% speed at full envelope
  tightnessMaxBoost: 2.0, // max +200% tightness at full envelope (low baselines need bigger range)
  trailBaseline: 0.95,    // resting trail level (visible in slider) — DEBUG: cranked up for testing
  trailMaxBoost: 2.5,     // max +250% trail at full envelope
  speedAttack: 4.0,       // seconds to spin up (slow swell over musical phrases)
  speedRelease: 10.0,     // seconds to coast back down (heavy inertia)
  speedJitterTau: 0.5,    // jitter filter time constant (removes FFT noise)
  gravityMaxBoost: 1.5,   // max +150% gravity at full envelope
  strengthMaxBoost: 1.0,  // max +100% strength at full envelope
  gravityAttack: 8.0,     // seconds — heavier than speed, deep breath in
  gravityRelease: 20.0,   // seconds — graceful settling, like a hot air balloon descending
  flashAttack: 0.3,       // seconds — fast rise to catch each pluck
  flashRelease: 1.5,      // seconds — gentle ring-down like a string decaying
  strumGlowRadius: 1.5,  // strum boost → glow radius multiplier (additive on top of gravity envelope)
  strumGlowIntensity: 0.6, // strum boost → per-star intensity multiplier
};
window._starsMapping = STARS_MAPPING;
window._starBump = _starDisrupt;
window._starEnvelopes = () => ({
  speedEnvelope: _starSpeedEnvelope,
  gravityEnvelope: _starGravityEnvelope,
  flashEnvelope: _starFlashEnvelope,
  audioPhase: _starAudioPhase,
  rmsSmoothed: _starRmsSmoothed,
});

// ── Horizon → Visual mapping config ─────────────────────────────────────────
// Spectral features from Horizon synth (region 4) drive 9 visual params
// additively (base + mod). Three temporal tiers with different attack/release
// envelopes produce layered response: sky first, flow second, deform last.
// Tunable at runtime via window._horizonMapping in the console.
const HORIZON_MAPPING = {
  // Sky Gust tier (responds first — atmosphere is sensitive)
  // Inputs: rmsNorm (energy), spread (timbral complexity), onset (transient)
  gustAmpDepth:   0.6,    // rmsNorm → gust amplitude (UNCHANGED)
  driftDepth:     0.036,  // mids envelope → drift distance
  swayDepth:      0.50,   // spread → cross sway
  shimmerDepth:   0.6,    // onset (raw, bypasses smoothing) → shimmer flash
  trailDepth:     0.35,   // spread → trail persistence (clamped < 0.995)

  // Flow tier (responds second — currents have inertia)
  flowSpeedDepth: 0.50,   // mids envelope → flow speed
  gustIntDepth:   0.80,   // mids envelope → gust intensity (clamped ≤ 1.0)
  eddyDepth:      0.68,   // mids envelope → eddy contrast (peaks ~0.30 at typical mids)
  swirlTrailDepth: 1.5,   // mids envelope → swirl trail persistence (capped at 0.95)
  flowTwinkleDepth: 0.80, // flow-tier RMS → wind twinkle intensity

  // Drift Fraction — two-speed RMS envelope
  // Slow envelope (1.5s/3s) tracks intensity tier → sets center of range.
  // Flow-tier RMS (~0.4s) oscillates around envelope → ±swing breathing.
  // Self-normalizing ratio keeps swing proportional at all intensity levels.
  driftFracFloor:   0.95,   // center at silence (high drift = slow)
  driftFracCeiling: 0.80,   // center at full RMS (low drift = fast)
  driftFracSwing:   0.05,   // ±oscillation half-range around center
  driftFracEnvAtk:  1.5,    // slow envelope attack (seconds) — tier detection
  driftFracEnvRel:  3.0,    // slow envelope release (seconds)
  flowSpeedEnvAtk:  1.0,    // flow speed envelope attack (seconds)
  flowSpeedEnvRel:  3.0,    // flow speed envelope release (seconds)

  // Canvas deform (onset-driven, no tier smoothing)
  deformDepth:    0.012,  // onset (thresholded) → deform amp
  deformThresh:   0.10,   // onset threshold (was 0.30 on rms — never fired)

  // Temporal smoothing time constants (seconds)
  skyAttack:      0.200,  skyRelease:    0.800,
  flowAttack:     0.400,  flowRelease:   1.200,
  deformAttack:   0.800,  deformRelease: 2.000,
};
window._horizonMapping = HORIZON_MAPPING;
window._harpDiag = () => getWindHarpV3Diag();
window._csDiag = () => getCelestialStringsDiag();

// ── Cypress audio → visual mapping config ──
const CYPRESS_MAPPING = {
  // ── Bass group (glacial — trunk inertia, driven by bass 0.50+) ──
  swayAmpDepth:     1.8,    // bass → sway intensity (base 1.5, ceiling 2.8 at bass 0.70)
  swayDistDepth:    0.023,  // bass → sway distance (base 8px, hits 24px at bass ~0.70)
  trailDepth:       0.143,  // bass → trail persistence cap 0.95 (base 85%, hits 95% at bass ~0.70)

  // ── RMS group (canopy energy, driven by rmsNorm 0.01–0.27) ──
  canopyGlowDepth:  2.0,    // rmsNorm → canopy brightness (was 0.50)
  breathPeriodDepth: -20.0, // rmsNorm (inverted) → shorter breathing min 5s (was -4.0)

  // ── Mids group (flow currents, driven by mids envelope 0.07–0.14) ──
  flowDriftDepth:   0.06,   // mids envelope → flow max drift (was 0.025)
  flowGustDepth:    3.0,    // mids envelope → flow gust intensity cap 1.0 (was 0.50)

  // ── Flux group (timbral shimmer, driven by flux ~0.01–0.05) ──
  crossSwayDepth:   8.0,    // flux → cross sway (was 0.4 on spread)
  rimGlowDepth:     12.0,   // gated flux → rim glow pop (was 0.5 on onset)
  fluxThreshold:    0.005,  // flux gate for rimGlow (below = no pop)

  // ── Onset (transient pop, driven by onset spikes) ──
  leafFlashDepth:   1.0,    // onset → leaf flash pop (was 0.5)

  // ── Drift Fraction (bass-driven breathing) ──
  driftFracFloor:   0.95,   // center at silence
  driftFracCeiling: 0.80,   // center at full energy
  driftFracSwing:   0.08,   // ±oscillation (was 0.04)
  driftFracEnvAtk:  2.0,    // slow envelope attack
  driftFracEnvRel:  4.0,    // slow envelope release
  flowEnvAtk:       1.5,    // mids envelope attack
  flowEnvRel:       4.0,    // mids envelope release

  // ── Temporal smoothing — 5 tiers with distinct time constants ──
  bassAttack:       1.200,  bassRelease:   3.500,   // glacial (trunk inertia)
  canopyAttack:     0.400,  canopyRelease: 1.200,   // medium (leaf response)
  flowAttack:       0.500,  flowRelease:   1.500,   // medium-fast (currents)
  fluxAttack:       0.150,  fluxRelease:   0.600,   // fast (timbral shimmer)
};
window._cypressMapping = CYPRESS_MAPPING;

const birthPulses = new Map();  // vortexId → pulse value (1.0 at birth, decays per frame)

// ── Per-region color state (driven by synth lifecycle) ──
const ON_STATE_INTENSITY = 0.50;  // looping region tint (0.25 too subtle, 1.0 = active)
const regionColorState = {};
for (let i = 1; i <= 5; i++) {
  regionColorState[i] = {
    state: 'off',        // 'off' | 'active' | 'on' | 'fading'
    clickX: 0, clickY: 0,
    activationTime: 0,
    intensity: 0,
    targetIntensity: 0,
    radiusNorm: 0,
    onTransitionTime: 0,     // timestamp when Active → On occurred
    onTransitionRadius: 0,   // radiusNorm at the moment of transition
    fadeStartTime: 0,        // timestamp when fading began
    fadeStartIntensity: 0,   // intensity snapshot at fade start
  };
}

// ── Per-star glow data (derived from STAR_PRESET) ──
const STAR_GLOW_DEFAULTS = {
  radiusMin: 0.02,       // smallest star glow radius (UV-height units)
  radiusMax: 0.10,       // largest star glow radius
  modDepth: 1.5,         // audio-reactive modulation multiplier
  centroidScale: 18.0,   // raw centroid rescaler (Stars fundamentals 400-600Hz)
  rmsScale: 6.0,         // RMS amplification
  lfoSpeed: 0.7,         // personal flicker speed (rad/s)
  lfoDepth: 0.15,        // personal flicker amplitude (0 = none, 1 = full)
  breathLfoSpeed: 5.03,  // matches chorus LFO at 0.8Hz (rad/s) — syncs visual breathing to audible ping-pong
  breathLfoDepth: 0.3,   // breathing LFO depth (0 = off, 1 = ±100% of baseRadius)
  breathOnsetSec: 2.0,   // seconds after region activation before breathing LFO starts
  intensityBase: 0.6,    // glow intensity when active but silent
  intensityAudioMix: 0.7,// additional intensity from RMS (intensityBase + rmsNorm * this)
};
const _starGlow = { ...STAR_GLOW_DEFAULTS };
window._starGlow = _starGlow;  // mutate live: _starGlow.modDepth = 3.0
const starGlowData = (() => {
  const gravities = STAR_PRESET.map(s => s.gravity);
  const gMin = Math.min(...gravities);
  const gMax = Math.max(...gravities);
  const logMin = Math.log(gMin || 1e-6);
  const logMax = Math.log(gMax || 1e-6);
  return STAR_PRESET.map(s => {
    const gNorm = logMax > logMin ? (Math.log(s.gravity || 1e-6) - logMin) / (logMax - logMin) : 0.5;
    return {
      cx: s.x,
      cy: s.y,
      baseRadius: _starGlow.radiusMin + gNorm * (_starGlow.radiusMax - _starGlow.radiusMin),
      phaseOffset: Math.random() * Math.PI * 2,
    };
  });
})();
// Raw star world positions (from STAR_PRESET)
const _starWorldPos = new Float32Array(24);
for (let i = 0; i < 12; i++) {
  _starWorldPos[i * 2]     = STAR_PRESET[i].x;
  _starWorldPos[i * 2 + 1] = STAR_PRESET[i].y;
}
// Reusable upload buffers (avoid per-frame allocation)
const _starCenterBuf    = new Float32Array(24);  // vec2 × 12
const _starRadiiBuf     = new Float32Array(12);  // per-star modulated radius
const _starIntensityBuf = new Float32Array(12);  // per-star glow intensity
const _starInnerRadiiBase = new Float32Array(12); // base inner radii from boundary computation
const _starInnerRadiiBuf  = new Float32Array(12); // inner radii from boundary computation
// Upload star centers + inner radii to GPU (for per-star ray system on load / re-dither)
function _uploadStarPositions() {
  if (!renderer) return;
  const baseInner = renderer.getStarInnerRadii();
  for (let i = 0; i < 12; i++) {
    const sd = starGlowData[i];
    _starCenterBuf[i * 2]     = sd.cx;
    _starCenterBuf[i * 2 + 1] = 1.0 - sd.cy;
    _starInnerRadiiBuf[i] = baseInner[i] || 0.03;
  }
  renderer.setStarGlowCenters(_starCenterBuf);
  renderer.setStarInnerRadii(_starInnerRadiiBuf);
}

// Console diagnostic: window._starGlowDump()
window._starGlowDump = () => {
  _log('(zoom/pan removed)');
  _log(`Test mode: ${window._starGlowTest || 0}`);
  _log('─── Star Glow Data ───');
  for (let i = 0; i < 12; i++) {
    const sd = starGlowData[i];
    const cx = _starCenterBuf[i * 2];
    const cy = _starCenterBuf[i * 2 + 1];
    _log(
      `Star ${i.toString().padStart(2)}: ` +
      `world(${sd.cx.toFixed(3)}, ${sd.cy.toFixed(3)}) → ` +
      `canvasUV(${cx.toFixed(4)}, ${cy.toFixed(4)})  ` +
      `radius=${_starRadiiBuf[i].toFixed(4)}  ` +
      `baseR=${sd.baseRadius.toFixed(4)}`
    );
  }
  _log(`Region 5 state: ${regionColorState[5]?.state}, intensity: ${regionColorState[5]?.intensity.toFixed(4)}`);
};

// ── Audio system ──
let isMuted = false;


function toggleMute() {
  isMuted = !isMuted;
  // Mute region synths + hover whisper (Tone.js destination)
  if (typeof Tone !== 'undefined' && Tone.Destination) {
    Tone.Destination.mute = isMuted;
  }
  // Toggle icon + tooltip
  const muteBtn = document.getElementById('mute-btn');
  if (muteBtn) {
    muteBtn.classList.toggle('muted', isMuted);
    muteBtn.setAttribute('data-tooltip', isMuted ? 'Unmute' : 'Mute');
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
  }
}

// ── About overlay ──
let aboutOpen = false;
let _aboutMouseDownTarget = null;  // tracks mousedown origin for scrim-click-to-close

function openAbout() {
  if (aboutOpen) return;
  aboutOpen = true;
  const overlay = document.getElementById('about-overlay');
  if (!overlay) return;

  // Force-release any active drag/region interaction by dispatching
  // a synthetic mouseup — this triggers the existing cleanup code
  // (regionMouseUp, exprHoldState=null, flow deactivation, etc.)
  // which lives inside the init closure and isn't accessible from here.
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));

  // Show overlay: unhide first (display:flex), then trigger transition
  overlay.hidden = false;
  // Force reflow so the transition fires (hidden→flex change must be painted first)
  overlay.offsetHeight; // eslint-disable-line no-unused-expressions
  overlay.classList.add('visible');

  // Lock body scroll on mobile
  document.body.style.overflow = 'hidden';

  // Focus close button for keyboard users
  const closeBtn = document.getElementById('about-close-btn');
  if (closeBtn) closeBtn.focus();

  // Scrim-click-to-close: only if both pointerdown and click land directly
  // on the overlay (not on content that bubbled up). Prevents accidental
  // dismiss during text selection drags that end outside content.
  // Uses pointerdown (works for both mouse and touch) instead of mousedown.
  overlay.addEventListener('pointerdown', _aboutOnPointerDown);
  overlay.addEventListener('click', _aboutOnScrimClick);
}

function _aboutOnPointerDown(e) {
  _aboutMouseDownTarget = e.target;
}

function _aboutOnScrimClick(e) {
  const overlay = document.getElementById('about-overlay');
  // Both pointerdown and click must land directly on the overlay element
  if (e.target === overlay && _aboutMouseDownTarget === overlay) {
    closeAbout();
  }
}

function closeAbout() {
  if (!aboutOpen) return;
  aboutOpen = false;
  const overlay = document.getElementById('about-overlay');
  if (!overlay) return;

  // Remove scrim-click listeners
  overlay.removeEventListener('pointerdown', _aboutOnPointerDown);
  overlay.removeEventListener('click', _aboutOnScrimClick);
  _aboutMouseDownTarget = null;

  overlay.classList.remove('visible');
  // Hide after transition — with safety timeout in case transitionend doesn't fire
  // (e.g., prefers-reduced-motion, browser skips transition, race condition)
  const hide = () => {
    if (!aboutOpen) {
      overlay.hidden = true;
      document.body.style.overflow = '';
    }
  };
  overlay.addEventListener('transitionend', hide, { once: true });
  setTimeout(hide, 400); // slightly longer than the 350ms transition

  // Return focus to the about button
  const aboutBtn = document.getElementById('about-btn');
  if (aboutBtn) aboutBtn.focus();
}


// Offscreen canvases for image downscaling (reused to avoid GC pressure)
let _downscaleCanvas = null;
let _downscaleCtx = null;
let _downscaleOutCanvas = null;
let _downscaleOutCtx = null;

// State
let originalImageData = null;
let radiantImageData = null;    // Radiant mood variant for A/B comparison
let _activePaintingData = null; // currently active painting (original or mood variant)
let _isRadiantActive = false;
let _moodSwitchLock = false;   // debounce guard for M key re-dither
let _radiantLoadStarted = false; // in-flight fetch guard — resets on failure so triggers can retry
let _radiantWorkerUnsupported = false; // decode-worker probe failed — retries go straight to main thread
let _radiantWorker = null;       // in-flight decode worker — module handle so pagehide can terminate it
let _radiantAttempt = 0;         // generation counter — outcomes from superseded attempts must not touch flags
let _playClicked = false;        // visitor pressed Play this page lifetime (survives bfcache restore)
let _nocturneParticleCount = 0; // last Nocturne extracted count — diagnostic baseline
let _moodTuningPanel = null;   // mood tuning panel DOM element

// Radiant density reduction — OPT-IN feature flag. Default OFF.
// Radiant is a brighter re-grade — Floyd-Steinberg turns more pixels "on" →
// more particles (~723K vs Nocturne's ~496K). Thinning via density < 1.0
// uses the importance-weighted keep probability at points.js:217 to preserve
// edges while reducing flat areas, but even importance-weighted thinning
// drops detail a visible amount. Default behavior: no thinning, Radiant keeps
// its full particle count.
// Enable for A/B testing:
//   URL: ?radiantThin
//   Console: window._radiantThin = true
// Uniform thinning via setParticleFraction was also tried and abandoned — it
// drops edge particles at the same rate as flat ones (no importance signal).
const RADIANT_DENSITY_FACTOR = 0.65;
const _radiantThinEnabledByUrl = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('radiantThin');
if (_radiantThinEnabledByUrl) {
  _log(`[Radiant] thinning enabled via ?radiantThin (factor=${RADIANT_DENSITY_FACTOR})`);
}
function _effectiveDensity() {
  const thinEnabled = _radiantThinEnabledByUrl
    || (typeof window !== 'undefined' && window._radiantThin === true);
  if (!_isRadiantActive || !thinEnabled) return _qualityTier.density;
  return _qualityTier.density * RADIANT_DENSITY_FACTOR;
}

// Runs after every renderer.loadPoints call. Captures the Nocturne baseline for
// diagnostic comparison and refreshes the HUD points label (the HUD's innerHTML
// is static at build-time — the pts div needs explicit textContent refresh on
// particle-count changes like resize or mood swap).
function _afterLoadPoints(count) {
  if (!_isRadiantActive) {
    _nocturneParticleCount = count;
  }
  _updateHudPts();
  // Resync toolbar width — loadPoints runs on initial load / resize / mood swap,
  // and before this point the renderer (with getPaintingMargin) may not have
  // been initialized. Now it is, so the margin-aware computation produces the
  // correct painting edge alignment.
  if (typeof _syncToolbarToPaintingWidth === 'function') _syncToolbarToPaintingWidth();
}

function _updateHudPts() {
  if (!_hudPtsEl || !renderer) return;
  const fullCount = renderer.getPointCount();
  const frac = renderer.getParticleFraction();
  const drawnCount = frac >= 1.0 ? fullCount : Math.round(fullCount * frac);
  _hudPtsEl.textContent = frac >= 1.0
    ? `${fullCount.toLocaleString()} pts`
    : `${drawnCount.toLocaleString()} / ${fullCount.toLocaleString()} pts`;
}

// Toolbar width sync — aligns the toolbar's horizontal extent with the
// painting's visible edges, accounting for:
//   1. object-fit: contain letterboxing (canvas element vs painting aspect)
//   2. Shader-side paintingMargin (drop-shadow inset around the painting)
// Module-level so it's callable from init, _afterLoadPoints, and the Shadow
// Spread slider. Looks up DOM + renderer state at call time.
const _PAINTING_ASPECT = 2048 / 1622;
function _syncToolbarToPaintingWidth() {
  const containerEl = document.querySelector('.canvas-container');
  const toolbarEl = document.querySelector('.canvas-toolbar');
  if (!containerEl || !toolbarEl) return;
  const rect = containerEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const canvasEl = document.getElementById('gl-canvas');
  const canvasAR = (canvasEl && canvasEl.width && canvasEl.height)
    ? canvasEl.width / canvasEl.height
    : _PAINTING_ASPECT;
  const elemAR = rect.width / rect.height;
  const contentW = elemAR > canvasAR
    ? rect.height * canvasAR
    : rect.width;

  let marginScreen = 0;
  if (renderer && typeof renderer.getPaintingMargin === 'function' && canvasEl && canvasEl.width) {
    marginScreen = renderer.getPaintingMargin() * (contentW / canvasEl.width);
  }
  const paintingWidth = Math.max(0, contentW - 2 * marginScreen);

  toolbarEl.style.width = `${paintingWidth}px`;
}

// Mood switch — Nocturne ↔ Radiant. Triggered by the segmented-pill click in
// the canvas toolbar. Re-dithers from the mood variant image, re-uploads
// textures, applies per-mood rendering params, activates Radiant visual
// multipliers, and glides the audio mode. Pill state flips instantly on click;
// pills are disabled during the ~500ms re-dither window.
function switchMood(toRadiant) {
  if (_moodSwitchLock) return;
  if (toRadiant === _isRadiantActive) return;
  if (!renderer || !renderer.isRunning || renderer.isIntroMode()) return;
  if (toRadiant && !radiantImageData) {
    // User-driven retry path: reachable because _updatePillStates keeps the
    // pill un-disabled whenever no load is in flight (aria-disabled blocks
    // clicks entirely — pointer-events:none in style.css). No-op if a fetch
    // is somehow already running.
    loadRadiantInBackground();
    console.warn('[Mood] Radiant variant not loaded yet');
    return;
  }

  _moodSwitchLock = true;
  _isRadiantActive = toRadiant;
  _updatePillStates();  // instant flip — active pill updates immediately

  const srcData = _isRadiantActive ? radiantImageData : originalImageData;
  _activePaintingData = srcData;

  // Audio: parallel-major retune (G minor ↔ G major). Glides active voices
  // via detune, sends worklet frequency messages, applies +3 dB Radiant bias.
  // No-ops cleanly if audio isn't initialized yet.
  try { setAudioMode(_isRadiantActive ? 'radiant' : 'nocturne'); } catch (e) {
    console.warn('[Mood] setAudioMode failed:', e);
  }
  _log(`%c[Mood]%c  Switching to ${_isRadiantActive ? 'RADIANT' : 'NOCTURNE'} — re-dithering...`,
    'color: #f80; font-weight: bold', 'color: #999');
  const t0 = performance.now();

  // Re-dither at current canvas target dims, not raw source dims. Using
  // srcData.width/height would bypass _dprMultiplier (G22-downgraded on
  // slower devices) and re-inflate the particle count to ~496K/~720K,
  // blowing past the frame budget that G22 established on first load.
  // Mirrors the block in applyCanvasResize / applyDithering.
  const target = computeCanvasTarget();
  const scale = target ? target.width / _sourceW : 1;
  const useSource = !target || scale >= 0.95;
  const ditherW = useSource ? _sourceW : target.width;
  const ditherH = useSource ? _sourceH : target.height;
  const ditherSrc = useSource ? srcData : downscaleImageData(srcData, ditherW, ditherH);
  const matrixDef = MATRICES[MATRIX_KEY];
  const paletteDef = PALETTES[PALETTE_KEY];

  const newDithered = (paletteDef.colors.length === 2) ?
    ditherBWFast(ditherSrc.data, ditherW, ditherH, SERPENTINE) :
    ditherErrorDiffusion(ditherSrc.data, ditherW, ditherH, matrixDef.matrix, paletteDef.colors, SERPENTINE);
  const newImportance = computeImportanceMap(ditherSrc.data, ditherW, ditherH);
  const newPoints = extractPointsWeighted(
    newDithered, ditherSrc.data, ditherW, ditherH,
    paletteDef.colors, newImportance, _effectiveDensity(), ...getSegArgs()
  );

  // Keep module state in sync with the current dither — applyCanvasResize
  // reads _activePaintingData on re-entry, but _ditherSource / ditheredResult
  // / importanceMap are the cached working set from the most recent dither.
  _ditherSource = ditherSrc;
  ditheredResult = newDithered;
  importanceMap = newImportance;

  // Load new points WITHOUT resetting intro mode
  renderer.loadPoints(newPoints, { resetIntro: false });
  _afterLoadPoints(newPoints.count);
  refreshStarInnerRadii();
  renderer.uploadPaintingTexture(srcData);
  renderer.uploadTonalTexture(srcData);

  // Per-mood rendering tuning
  const lp  = _isRadiantActive ? 0.5  : 0.5;
  const up  = _isRadiantActive ? 0.10 : 0.20;
  renderer.setLuminancePreserve(lp);
  renderer.setAdditiveBlend(true);
  renderer.setBgTonalTarget(up);
  renderer.setRadiantActive(_isRadiantActive);
  syncMoodSliders(lp, up, true);

  _log(`%c[Mood]%c  Re-dithered in ${(performance.now() - t0).toFixed(0)}ms — ${newPoints.count.toLocaleString()} points`,
    'color: #f80; font-weight: bold', 'color: #999');

  requestAnimationFrame(() => {
    _moodSwitchLock = false;
    _updatePillStates();  // re-enable pills after lock releases
  });
}

function _updatePillStates() {
  const minorBtn = document.getElementById('mode-minor-btn');
  const majorBtn = document.getElementById('mode-major-btn');
  if (!minorBtn || !majorBtn) return;

  const isMinor = !_isRadiantActive;
  minorBtn.classList.toggle('is-active', isMinor);
  majorBtn.classList.toggle('is-active', !isMinor);
  minorBtn.setAttribute('aria-checked', String(isMinor));
  majorBtn.setAttribute('aria-checked', String(!isMinor));

  // Disabled during lock; Major also disabled while Radiant image is still loading
  if (_moodSwitchLock) {
    minorBtn.setAttribute('aria-disabled', 'true');
    majorBtn.setAttribute('aria-disabled', 'true');
  } else {
    minorBtn.removeAttribute('aria-disabled');
    if (!radiantImageData && _radiantLoadStarted) {
      // Genuinely in flight — disable for the few seconds it takes.
      majorBtn.setAttribute('aria-disabled', 'true');
      majorBtn.setAttribute('data-tooltip', 'Loading…');
    } else {
      // Loaded, or not currently loading (e.g. a failed attempt reset the
      // flag). The failed state must stay clickable: aria-disabled applies
      // pointer-events:none (style.css .mode-pill[aria-disabled]), which
      // would make the click-to-retry path in switchMood unreachable by
      // mouse/touch.
      majorBtn.removeAttribute('aria-disabled');
      majorBtn.setAttribute('data-tooltip', 'Brighter sound');
    }
  }
}
let _ditherSource = null;     // ImageData at dither resolution (may be downscaled from original)
let ditheredResult = null;    // raw Uint8ClampedArray from dither engine
let importanceMap = null;     // cached Float32Array from importance computation
let segmentationData = null;  // { regionMap: Uint8Array, width, height }
let flowFieldData = null;     // { coherence: Float32Array, flowAngle: Float32Array, width, height }
let cypressFlowData = null;   // { coherence: Float32Array, flowAngle: Float32Array, width, height }
let pointData = null;
let _prebakedPathActive = false;  // sticky flag: true if hybrid prebake binary was used (diagnostic only — shown in ?hud load-path color)
let _hudFpsEl = null;
let _hudG22El = null;
let _hudPtsEl = null;
let renderer = null;

// ── Flashlight ring buffer ──
const FLASH_TRAIL_SIZE = 24;
const flashTrailBuf = new Float32Array(FLASH_TRAIL_SIZE * 4);  // vec4 per slot: (x, y, birthTime, valid)
let flashWriteIndex = 0;
let flashMouseX = 0;        // latest cursor position in canvas pixels (initialized to center in showGLCanvas)
let flashMouseY = 0;
let flashMouseOnCanvas = false;  // true while cursor is over the painting content
let mouseDownInPainting = false; // true while a mousedown that originated inside the painting is held

// ── Night Sky wake trail ring buffer ──
const NS_WAKE_TRAIL_SIZE = 20;
const nsWakeTrailBuf = new Float32Array(NS_WAKE_TRAIL_SIZE * 4);  // vec4: (uvX, uvY, birthTime, valid)
let nsWakeWriteIndex = 0;
let nsWakeCursorInfluence = 0;   // eased 0→1 (still cursor builds slowly over ~1.5s)
let nsWakeLastWriteTime = 0;     // throttle trail writes to ~150ms intervals
// Tunable wake params (driven by sidebar sliders)
let _nsWakeRadius = 0.06;       // influence radius in UV space (~5x cursor size)
let _nsWakeGustBoost = 0.50;    // gust displacement boost fraction (0-1)
let _nsWakeBuildTime = 1.5;     // shimmer build attack tau in seconds
let _nsWakeDecay = 3.0;         // trail decay time in seconds
let _nsWakePushStrength = 0.006; // radial push displacement in UV (base: 3px still, 12px fast)
let _nsWakePrevUV = [0.5, 0.5];  // previous frame cursor UV for speed computation
let _nsWakeCursorSpeed = 0;      // smoothed cursor speed in UV/sec

// ── Flashlight drift: mouse speed tracking ──
let prevFlashMouseX = -1;
let prevFlashMouseY = -1;
let smoothMouseSpeed = 0;  // exponential moving average of per-frame cursor speed
let _glowRms = 0;          // smoothed RMS for ambient glow reactivity
// Ambient glow tuning params (exposed via sidebar sliders)
let _glowBrightBase = 0.15;    // color brightness at silence
let _glowBrightRms = 0.85;     // additional brightness from RMS
let _glowColorCap = 0.60;      // max per-channel color value
let _glowOpacityBase = 0.25;   // shadow opacity at silence
let _glowOpacityRms = 0.35;    // additional opacity from RMS
let _glowRmsSensitivity = 0.05; // RMS divisor (lower = more sensitive)
// Region glow colors — hoisted to avoid per-frame allocation.
// Mode-keyed: Nocturne keeps the original cool-leaning palette tuned against
// the dark blue painting; Radiant uses a warmer earth-tone palette tuned
// against the warm orange painting (2026-04-19).
const GLOW_COLORS = {
  nocturne: {
    1: [0.35, 0.50, 0.20],  // Cypress: warm olive green
    2: [0.35, 0.35, 0.55],  // Village: dusky blue with warmth
    3: [0.30, 0.40, 0.85],  // Sky: vibrant cobalt
    4: [0.35, 0.50, 0.80],  // Horizon: lighter blue, warm hint
    5: [0.80, 0.70, 0.20],  // Stars: warm yellow
  },
  radiant: {
    // Hues from the Radiant painting, luminance-matched to Nocturne per-region
    // max channel so the backlight reads against the bright warm canvas.
    // Scaled proportionally (R:G:B ratio preserved = hue + saturation intact).
    // Source hex (pre-scale): 1 #2d200d, 2 #4c361a, 3 #362e43, 4 #746a7e, 5 #dc9b00
    1: [0.500, 0.355, 0.145],  // Cypress: #7f5b25 — warm amber (was #2d200d ×2.84)
    2: [0.550, 0.391, 0.188],  // Village: #8c6430 — rich terracotta (was #4c361a ×1.85)
    3: [0.685, 0.582, 0.850],  // Night Sky: #af94d9 — pale dusk violet (was #362e43 ×3.23)
    4: [0.736, 0.674, 0.800],  // Horizon: #bcaccc — soft mauve (was #746a7e ×1.62)
    5: [0.863, 0.608, 0.000],  // Stars: #dc9b00 — deep gold (at target, unchanged)
  },
};
// Idle breathing glow — deep night blue pulse when no regions are active
// Idle breathing base color, mode-keyed. Nocturne keeps the original deep
// night-blue (peak 0.40); Radiant uses a dusk-violet of the same peak
// brightness — same source hue as the user's #362e43 reference, scaled ×1.52
// so the max channel lands at 0.40 to match the Nocturne idle intensity.
const IDLE_BREATH_COLOR = {
  nocturne: [0.15,  0.18,  0.40],   // #262e66 — deep night blue
  radiant:  [0.322, 0.274, 0.400],  // #524666 — dusk violet (from #362e43 ×1.52)
};
const IDLE_BREATH_DELAY = 5000;       // ms idle before breathing starts
const IDLE_BREATH_INHALE = 1500;      // ms — faster rise (matches intro)
const IDLE_BREATH_EXHALE = 2500;      // ms — slower fall (matches intro)
const IDLE_BREATH_CYCLE = IDLE_BREATH_INHALE + IDLE_BREATH_EXHALE; // 4s total
const IDLE_BREATH_AMPLITUDE = 0.35;   // ±35% modulation depth
const IDLE_BREATH_RAMP_CYCLES = 1.5;  // cycles to reach full amplitude
const IDLE_BREATH_OPACITY_BASE = 0.32; // base shadow opacity for idle glow
const IDLE_BREATH_FADE_MS = 800;      // ms to ease out breathing on cursor activity
let _idleBreathActive = false;
let _idleBreathStartTime = 0;
let _idleBreathEnvelope = 0;          // 0→1 ramp-in
let _idleBreathFading = false;        // true = cursor moved, easing out
let _idleBreathFadeStart = 0;
let _idleBreathFadeOut = 1;           // 1→0 during fade-out
let _idleBreathIdleStart = 0;         // when idle conditions were last met

// ── Hover highlight (two-layer crossfade) ──
// Layer 0 = current/incoming, Layer 1 = outgoing (fading)
const _hoverLayers = [
  { region: -1, intensity: 0, easeStart: 0, easeDir: 0, easeFrom: 0, centerX: 0, centerY: 0, freezeTime: -1 },
  { region: -1, intensity: 0, easeStart: 0, easeDir: 0, easeFrom: 0, centerX: 0, centerY: 0, freezeTime: -1 },
];
let _hoverStillStart = 0;
let _hoverPendingRegion = -1; // region being waited on (200ms stillness)
const HOVER_EASE_IN_MS  = 800;
const HOVER_EASE_OUT_MS = 2500;

// Diagnostic: reports why hover is blocked right now.
// Call _hoverDiag() in the console while the bug is reproducing.
if (typeof window !== 'undefined') {
  const STATE_CHAR = { off: 'o', on: 'N', active: 'a', fading: 'f', stopping: 's', building: 'b' };

  const collectHoverState = () => {
    const states = {};
    const stateChars = [];
    for (let ri = 1; ri <= 5; ri++) {
      const s = (regionColorState[ri] && regionColorState[ri].state) || 'off';
      states[ri] = s;
      stateChars.push(STATE_CHAR[s] || s[0] || '?');
    }
    const introMode = (typeof renderer !== 'undefined' && renderer && renderer.isIntroMode) ? renderer.isIntroMode() : false;
    const cursorRegion = flashMouseOnCanvas ? lookupClickRegion(lastMouseClientX, lastMouseClientY) : -1;
    const cursorRegionState = (cursorRegion > 0 && regionColorState[cursorRegion]) ? regionColorState[cursorRegion].state : 'off';
    const cursorRegionBusy = cursorRegionState === 'active' || cursorRegionState === 'on' || cursorRegionState === 'fading';
    const blocked = _isTouchDevice || !flashMouseOnCanvas || introMode === true || cursorRegionBusy;
    return { blocked, introMode, cursorRegion, cursorRegionState, cursorRegionBusy, states, stateChars };
  };

  window._hoverDiag = () => {
    const s = collectHoverState();
    // eslint-disable-next-line no-console
    console.log('%c[HoverDiag]', 'color: #6cf; font-weight: bold', {
      blocked: s.blocked,
      conditions: {
        isTouchDevice: _isTouchDevice,
        cursorOffCanvas: !flashMouseOnCanvas,
        isIntroMode: s.introMode,
        cursorRegion: s.cursorRegion,
        cursorRegionState: s.cursorRegionState,
        cursorRegionBusy: s.cursorRegionBusy,
      },
      regionStates: s.states,
    });
    return s;
  };

  // Live accessor for region color state — inspect per-region values directly.
  Object.defineProperty(window, '_regionColorState', {
    get() { return regionColorState; },
    configurable: true,
  });

  // Village fade-out pop diagnostic.
  // Usage:
  //   _villageWatch()             → trace only (no eliminations)
  //   _villageWatch('noTrail')    → + kill FBO trail
  //   _villageWatch('noStagger')  → + kill per-particle pow stagger
  //   _villageWatch('noAttract')  → + force villageAttraction to 0 (kills displacement entirely)
  //   _villageWatch('all')        → all three eliminations on
  //   _villageWatch('off')        → disable everything
  //
  // After enabling, click village to activate → click again to stop → watch console.
  // Each frame during fade-out logs:
  //   rA   = regionActive[1] (color intensity 0-1)
  //   atr  = villageAttraction (cursor-pull strength)
  //   fO   = villageFadeOut flag (1 during 'fading' state)
  //   tF   = computed trailFade value (what the composite shader receives)
  //   mean = avg luminance in 80×80 village sample window
  //   max  = max single-pixel luminance in same window
  //   Δm/Δmx = frame-to-frame deltas
  //   fromBase = delta vs activated baseline (mean/max)
  // Frames flagged with ◀◀ when |Δmean|>2.0 or |Δmax|>8.0.
  //
  // Interpret:
  //   • Big positive max-pop with small mean-pop → bright pixel cluster, suggests pile-up
  //   • Pop early (f<10) → activation/state-transition artifact
  //   • Pop late (f>40) → snap-back / drain artifact
  //   • If 'noAttract' removes pop → displacement snap-back IS the cause (most likely)
  //   • If pop persists with all three off → check region color/intensity path itself
  window._villageWatch = (mode) => {
    if (mode === 'off') {
      delete window._dvs_villageTrace;
      delete window._dvs_noVillageTrail;
      delete window._dvs_noVillageStagger;
      delete window._dvs_noVillageAttraction;
      delete window._dvs_vt;
      console.log('%c[VillageWatch]%c disabled — all toggles cleared', 'color:#f8a;font-weight:bold', 'color:#999');
      return;
    }
    window._dvs_villageTrace = true;
    delete window._dvs_vt;  // reset state so baseline re-captures
    const all = (mode === 'all');
    if (all || mode === 'noTrail') window._dvs_noVillageTrail = true;
    else delete window._dvs_noVillageTrail;
    if (all || mode === 'noStagger') window._dvs_noVillageStagger = true;
    else delete window._dvs_noVillageStagger;
    if (all || mode === 'noAttract') window._dvs_noVillageAttraction = true;
    else delete window._dvs_noVillageAttraction;
    const toggles = [];
    if (window._dvs_noVillageTrail) toggles.push('noTrail');
    if (window._dvs_noVillageStagger) toggles.push('noStagger');
    if (window._dvs_noVillageAttraction) toggles.push('noAttract');
    console.log(
      `%c[VillageWatch]%c armed — fade-out trace will auto-fire on next deactivation` +
      (toggles.length ? ` | toggles: ${toggles.join(', ')}` : ''),
      'color:#f8a;font-weight:bold', 'color:#999'
    );
  };

  // Continuous hover watcher — logs block conditions + layer state every 500ms.
  // Call _hoverWatch() to start, call again to stop.
  let _hoverWatchTimer = null;
  window._hoverWatch = (intervalMs = 500) => {
    if (_hoverWatchTimer) {
      clearInterval(_hoverWatchTimer);
      _hoverWatchTimer = null;
      // eslint-disable-next-line no-console
      console.log('%c[HoverWatch]%c stopped', 'color: #6cf; font-weight: bold', 'color: #999');
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`%c[HoverWatch]%c started (${intervalMs}ms) — call _hoverWatch() again to stop`, 'color: #6cf; font-weight: bold', 'color: #999');
    _hoverWatchTimer = setInterval(() => {
      const now = performance.now();
      const s = collectHoverState();
      const L0 = _hoverLayers[0];
      const L1 = _hoverLayers[1];
      const L0str = L0.region > 0 ? `L0:r${L0.region}/i${L0.intensity.toFixed(2)}/${L0.easeDir > 0 ? 'in' : L0.easeDir < 0 ? 'out' : '-'}` : 'L0:-';
      const L1str = L1.region > 0 ? `L1:r${L1.region}/i${L1.intensity.toFixed(2)}/${L1.easeDir > 0 ? 'in' : L1.easeDir < 0 ? 'out' : '-'}` : 'L1:-';
      const still = _hoverStillStart > 0 ? `still@${(now - _hoverStillStart).toFixed(0)}ms→r${_hoverPendingRegion}` : 'still:-';
      const cursorLabel = s.cursorRegion > 0 ? `r${s.cursorRegion}/${s.cursorRegionState}` : '-';
      // eslint-disable-next-line no-console
      console.log(
        `%c[hover]%c ${s.blocked ? 'BLOCK' : 'OPEN '} | ` +
        `touch=${_isTouchDevice ? 'Y' : 'n'} ` +
        `cursor=${flashMouseOnCanvas ? 'on ' : 'off'} ` +
        `intro=${s.introMode ? 'Y' : 'n'} ` +
        `under=${cursorLabel} ` +
        `states=[${s.stateChars.join('')}] | ` +
        `${L0str} ${L1str} ${still}`,
        s.blocked ? 'color: #f80; font-weight: bold' : 'color: #4c4; font-weight: bold',
        'color: #999'
      );
    }, intervalMs);
  };
}


let lastMouseClientX = 0;      // raw client coords from mousemove (for region lookup)
let lastMouseClientY = 0;

// ── Flashlight drift defaults (CSS pixel units, converted per frame) ──
let driftAmountPx = 9;   // default: 9 CSS pixels
let driftMaxCapPx = 15;  // default: 15 CSS pixels

// ── Intro proximity amplification ──
let introProximity = 0.0;  // 0 = far from center, 1 = at center (smoothed)
let introBloomActive = false; // true = center glow is easing in
let introBloomStart = 0;     // performance.now() when bloom began
const INTRO_BLOOM_DURATION = 600; // ms — smoothstep ease-in-out
let introSettling = false;   // true = Play clicked, drift locked on while easing down
let driftEaseOut = 0;        // 1.0 → 0.0 over DRIFT_EASE_MS when settling ends
const DRIFT_EASE_MS = 500;   // ms to fade drift off after settling completes

// ── Intro vignette breathing (idle invitation) ──
const BREATH_IDLE_DELAY = 3500;   // ms of no mouse movement before breathing starts
const BREATH_INHALE = 1500;       // ms — faster rise
const BREATH_EXHALE = 2500;       // ms — slower fall
const BREATH_CYCLE = BREATH_INHALE + BREATH_EXHALE; // 4s total
const BREATH_AMPLITUDE = 0.25;    // ±25% on glow → ~±10% visible after shader's 0.4 multiplier
const BREATH_RAMP_CYCLES = 1.5;   // cycles to reach full amplitude
const BREATH_FADE_MS = 400;       // ms to fade breathing out when cursor moves
let breathActive = false;         // true = breathing is running
let breathStartTime = 0;          // when breathing started
let breathEnvelope = 0;           // 0→1 ramp-in envelope
let breathFadeOut = 0;            // 1→0 when fading out on activity
let breathFading = false;         // true = cursor moved, fading out
let breathFadeStart = 0;          // when fade-out began
let lastMouseMoveTime = 0;        // last mousemove timestamp
let introBloomDone = false;       // true once center bloom finishes

// DOM elements
let canvas2d;
let glCanvas;
let canvasPlaceholder;
let statsPanel;
let statsGrid;

// ── Resize infrastructure ──
// Source image dimensions (set once on load, used for resolution-independent conversions)
let _sourceW = 0;
let _sourceH = 0;
// Cached content rect (avoids multiple getBoundingClientRect per frame)
let _cachedContentRect = null;
let _contentRectDirty = true;
function invalidateContentRect() { _contentRectDirty = true; }
function computeContentRect() {
  const rect = glCanvas.getBoundingClientRect();
  const canvasAR = glCanvas.width / glCanvas.height;
  const elemAR = rect.width / rect.height;
  let contentW, contentH, offsetX, offsetY;
  if (elemAR > canvasAR) {
    contentH = rect.height;
    contentW = rect.height * canvasAR;
    offsetX = (rect.width - contentW) / 2;
    offsetY = 0;
  } else {
    contentW = rect.width;
    contentH = rect.width / canvasAR;
    offsetX = 0;
    offsetY = (rect.height - contentH) / 2;
  }
  return {
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    width: contentW,
    height: contentH,
    elemOffsetX: offsetX,
    elemOffsetY: offsetY,
  };
}
function getCanvasContentRect() {
  if (_contentRectDirty || !_cachedContentRect) {
    _cachedContentRect = computeContentRect();
    _contentRectDirty = false;
  }
  return _cachedContentRect;
}
// Resize callback list for future steps (re-dither, adaptive density, etc.)
const _resizeCallbacks = [];
let _resizeDebounceTimer = 0;
// Last known display aspect ratio for orientation flip detection
let _lastDisplayAR = 0;

/**
 * Compute optimal canvas resolution for the current display area.
 * Returns dimensions that match display × DPR, capped at source image size,
 * preserving the source aspect ratio.
 */
function computeCanvasTarget() {
  if (!_sourceW || !glCanvas) return null;
  const rect = glCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = getEffectiveDpr();
  const displayW = rect.width * dpr;
  const displayH = rect.height * dpr;
  const sourceAR = _sourceW / _sourceH;
  const displayAR = displayW / displayH;
  let targetW, targetH;
  if (displayAR > sourceAR) {
    // Display is wider than source — height-constrained
    targetH = Math.min(Math.round(displayH), _sourceH);
    targetW = Math.round(targetH * sourceAR);
  } else {
    // Display is taller than source — width-constrained
    targetW = Math.min(Math.round(displayW), _sourceW);
    targetH = Math.round(targetW / sourceAR);
  }
  // Clamp: never exceed source, never go below 256px on short axis
  targetW = Math.max(256, Math.min(targetW, _sourceW));
  targetH = Math.max(256, Math.min(targetH, _sourceH));
  return { width: targetW, height: targetH };
}

/**
 * Resize the GL canvas to match current display area × DPR.
 * Skips if the resolution hasn't changed significantly (< 5% on either axis).
 */
function applyCanvasResize() {
  const srcData = _activePaintingData || originalImageData;
  if (!renderer || !_sourceW || !srcData) return;
  const target = computeCanvasTarget();
  if (!target) return;
  const curW = glCanvas.width, curH = glCanvas.height;
  // Skip if change is < 5% on both axes (avoids thrashing on sub-pixel layout shifts)
  if (curW && curH &&
      Math.abs(target.width - curW) / curW < 0.05 &&
      Math.abs(target.height - curH) / curH < 0.05) return;

  const scale = target.width / _sourceW;
  const useSource = scale >= 0.95;
  const ditherW = useSource ? _sourceW : target.width;
  const ditherH = useSource ? _sourceH : target.height;
  const paletteDef = PALETTES[PALETTE_KEY];
  const matrixDef = MATRICES[MATRIX_KEY];

  // Re-dither at new resolution so particles align with canvas pixels.
  // Use source directly when within 5% to avoid JPEG block artifacts.
  _ditherSource = useSource
    ? srcData
    : downscaleImageData(srcData, ditherW, ditherH);

  ditheredResult = ((paletteDef.colors.length === 2) ?
    ditherBWFast(_ditherSource.data, ditherW, ditherH, SERPENTINE) :
    ditherErrorDiffusion(_ditherSource.data, ditherW, ditherH, matrixDef.matrix, paletteDef.colors, SERPENTINE)
  );
  importanceMap = computeImportanceMap(_ditherSource.data, ditherW, ditherH);

  pointData = extractPointsWeighted(
    ditheredResult, _ditherSource.data, ditherW, ditherH,
    paletteDef.colors, importanceMap, _effectiveDensity(), ...getSegArgs()
  );

  renderer.resize(ditherW, ditherH);
  touchTrail.resize(ditherW, ditherH);
  invalidateContentRect();
  { const _cr = getCanvasContentRect();
    const _cssScale = _cr.width / glCanvas.width;
    const _cssInset = (renderer ? renderer.getPaintingMargin() : 0) * _cssScale;
    const _cssRadius = (renderer ? renderer.getBorderRadius() : 8) * _cssScale;
    ambientGlow.resize(_cr, _cssInset, _cssRadius);
  }
  renderer.setResolutionScale(scale);
  renderer.loadPoints(pointData, { resetIntro: false });
  _afterLoadPoints(pointData.count);
  refreshStarInnerRadii();
  renderer.uploadPaintingTexture(srcData);
  renderer.uploadTonalTexture(srcData);

  _log(
    '%c[Resize]%c  Re-dither %d×%d → %d×%d  (DPR %.1f, scale %.2f, %s points)',
    'color: #3cb8ff; font-weight: bold', 'color: #999',
    curW, curH, ditherW, ditherH,
    getEffectiveDpr(), scale, pointData.count.toLocaleString()
  );
}

function stat(label, value, opts = {}) {
  const item = document.createElement('div');
  item.className = 'stat-item' + (opts.fullWidth ? ' full-width' : '');

  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  valueEl.className = 'stat-value' + (opts.highlight ? ' highlight' : '');
  valueEl.textContent = value;

  item.appendChild(labelEl);
  item.appendChild(valueEl);
  return item;
}

// Live stat elements updated without rebuilding the grid
let fpsStatEl = null;
let frameTimeStatEl = null;
let renderTimeStatEl = null;
let gpuTimeStatEl = null;
let vtxPerSecStatEl = null;
let droppedStatEl = null;
let pointsStatEl = null;
let reductionStatEl = null;

function updateStats(elapsed) {
  const w = originalImageData.width;
  const h = originalImageData.height;
  const totalPixels = w * h;
  const throughput = totalPixels / elapsed / 1000;
  const theoreticalFps = 1000 / elapsed;

  statsGrid.innerHTML = '';
  statsGrid.appendChild(stat('Dither Time', `${elapsed.toFixed(1)} ms`, { highlight: true }));
  statsGrid.appendChild(stat('Dither FPS', `${theoreticalFps.toFixed(1)}`, { highlight: true }));
  statsGrid.appendChild(stat('Throughput', `${throughput.toFixed(1)} Mpx/s`));
  statsGrid.appendChild(stat('Pixels', `${(totalPixels / 1e6).toFixed(2)} MP`));
  statsGrid.appendChild(stat('Dimensions', `${w} x ${h}`));

  if (pointData) {
    const full = pointData.fullCount || pointData.count;
    statsGrid.appendChild(stat('Points (full)', full.toLocaleString()));

    const activeItem = stat('Points (active)', pointData.count.toLocaleString(), { highlight: true });
    pointsStatEl = activeItem.querySelector('.stat-value');
    statsGrid.appendChild(activeItem);

    const pct = full > 0 ? ((1 - pointData.count / full) * 100).toFixed(1) : '0.0';
    const reductionItem = stat('Reduction', `${pct}%`);
    reductionStatEl = reductionItem.querySelector('.stat-value');
    statsGrid.appendChild(reductionItem);
  }

  // Render stats — starts as "--", updated live by the GL renderer callbacks
  const fpsItem = stat('Render FPS', '--', { highlight: true });
  fpsStatEl = fpsItem.querySelector('.stat-value');
  statsGrid.appendChild(fpsItem);

  const frameTimeItem = stat('Frame Time', '--');
  frameTimeStatEl = frameTimeItem.querySelector('.stat-value');
  statsGrid.appendChild(frameTimeItem);

  const renderTimeItem = stat('Render CPU', '--');
  renderTimeStatEl = renderTimeItem.querySelector('.stat-value');
  statsGrid.appendChild(renderTimeItem);

  const gpuTimeItem = stat('GPU Draw', '--');
  gpuTimeStatEl = gpuTimeItem.querySelector('.stat-value');
  statsGrid.appendChild(gpuTimeItem);

  const vtxItem = stat('Vtx/sec', '--');
  vtxPerSecStatEl = vtxItem.querySelector('.stat-value');
  statsGrid.appendChild(vtxItem);

  const droppedItem = stat('Dropped', '0');
  droppedStatEl = droppedItem.querySelector('.stat-value');
  statsGrid.appendChild(droppedItem);

  statsPanel.open = false;
}

function updatePointStats() {
  if (!pointsStatEl || !reductionStatEl || !pointData) return;
  const full = pointData.fullCount || pointData.count;
  pointsStatEl.textContent = pointData.count.toLocaleString();
  const pct = full > 0 ? ((1 - pointData.count / full) * 100).toFixed(1) : '0.0';
  reductionStatEl.textContent = `${pct}%`;
}

function showGLCanvas() {
  canvas2d.style.display = 'none';
  glCanvas.classList.add('active');

  // Show intro overlay shortly after canvas is ready
  const introOverlay = document.getElementById('intro-overlay');
  if (introOverlay) {
    setTimeout(async () => {
      introOverlay.hidden = false;
      _loadTimeline.introVisible = performance.now();
      // Log the full perceived load timeline
      const t0 = _loadTimeline.navigationStart;
      _log(
        '%c[LoadTime]%c Navigation → Intro visible: %c' + ((_loadTimeline.introVisible - t0) / 1000).toFixed(2) + 's',
        'color: #4ade80; font-weight: bold', 'color: #ccc', 'color: #fff; font-weight: bold'
      );
      _log('%c[LoadTime]%c Breakdown:', 'color: #4ade80; font-weight: bold', 'color: #ccc',
        '\n  JS parse → initRenderer: ' + ((_loadTimeline.initRendererStart - t0) | 0) + 'ms' +
        '\n  Shader compilation:       ' + ((_loadTimeline.rendererReady - _loadTimeline.initRendererStart) | 0) + 'ms' +
        '\n  Image download:           ' + ((_loadTimeline.imagesLoaded - _loadTimeline.rendererReady) | 0) + 'ms' +
        '\n  Segmentation + flow:      ' + ((_loadTimeline.preDither - _loadTimeline.imagesLoaded) | 0) + 'ms' +
        '\n  Dithering + extraction:   ' + ((_loadTimeline.postDither - _loadTimeline.preDither) | 0) + 'ms' +
        '\n  Post-dither → intro:      ' + ((_loadTimeline.introVisible - _loadTimeline.postDither) | 0) + 'ms'
      );

      // ── ?hud overlay ─────────────────────────────────────────────────────
      // Mobile-friendly visible readout. No DevTools needed. Shows path, load
      // time, live FPS, particle count. Toggle via URL param ?hud.
      if (new URLSearchParams(location.search).has('hud')) {
        const hud = document.createElement('div');
        hud.style.cssText =
          'position:fixed;top:8px;right:8px;z-index:9999;' +
          'background:rgba(0,0,0,0.72);color:#fff;' +
          'font:600 14px/1.35 -apple-system,system-ui,sans-serif;' +
          'padding:10px 12px;border-radius:8px;' +
          'box-shadow:0 2px 12px rgba(0,0,0,0.4);' +
          'pointer-events:none;min-width:140px;';
        const pathColor = _prebakedPathActive ? '#4ade80' : '#fbbf24';
        const pathLabel = 'LIVE';
        const loadMs = Math.round(_loadTimeline.introVisible - t0);
        const fullCount = (pointData && pointData.count) || 0;
        const frac = (renderer && renderer.getParticleFraction) ? renderer.getParticleFraction() : 1.0;
        const drawnCount = frac >= 1.0 ? fullCount : Math.round(fullCount * frac);
        const ptsLabel = frac >= 1.0
          ? `${fullCount.toLocaleString()} pts`
          : `${drawnCount.toLocaleString()} / ${fullCount.toLocaleString()} pts`;
        const dprLabel = _dprMultiplier < 1.0
          ? `<div style="opacity:.7;font-size:11px;">dpr ${getEffectiveDpr().toFixed(2)} (×${_dprMultiplier})</div>`
          : '';
        hud.innerHTML =
          `<div style="color:${pathColor};font-size:12px;letter-spacing:.5px;">${pathLabel}</div>` +
          `<div style="margin-top:4px;">load <b>${loadMs}ms</b></div>` +
          `<div>fps <b id="_hudFps">--</b></div>` +
          `<div id="_hudPts" style="opacity:.7;font-size:11px;margin-top:2px;">${ptsLabel}</div>` +
          dprLabel +
          `<div id="_hudG22" style="font-size:11px;margin-top:2px;"></div>`;
        document.body.appendChild(hud);
        _hudFpsEl = hud.querySelector('#_hudFps');
        _hudG22El = hud.querySelector('#_hudG22');
        _hudPtsEl = hud.querySelector('#_hudPts');
      }
      // ─────────────────────────────────────────────────────────────────────
      // Finalize ALL deferred shaders before the bench so frame timing
      // reflects the FULL render shader (mini shader skips drawParticles).
      // On Chrome: ~2ms total. On Firefox: ~2s block (ANGLE D3DCompile).
      if (renderer) {
        if (!renderer.renderFinalized) {
          if (!renderer.finalizeRenderProg()) {
            console.error('[Init] Full render shader failed to link');
          } else if (!renderer.testDraw()) {
            console.error('[Init] Test draw failed after deferred shader finalization');
          }
        }
        if (!renderer.otherProgramsFinalized) {
          if (!renderer.finalizeOtherPrograms()) {
            console.error('[Init] One or more support shaders failed to link');
          }
        }
      }

      // ── G22 pre-visible benchmark + swap ──
      // Canvas is at opacity:0 (set in applyDithering). The render loop is
      // running and now drawing the full shader. Sample frame times, decide
      // if downgrade is needed, swap via worker if so. User sees nothing
      // because canvas is invisible. After this block, reveal the canvas.
      await _g22BenchmarkAndSwap();

      // Reveal the canvas now — bench + swap (if any) is complete, the
      // first visible frame will be at the FINAL density. No snap.
      glCanvas.style.opacity = '';

      // Pre-build audio nodes. User reads title during ~677ms construction.
      // Tone.start() stays in Play handler (user gesture required).
      if (typeof Tone !== 'undefined' && !_audioPreBuilt) {
        audioDiag.mark('intro.preBuildAudioNodes:call');
        preBuildAudioNodes().then(() => {
          audioDiag.mark('intro.preBuildAudioNodes:resolved');
        }).catch(e => {
          console.warn('[Audio] Pre-build during intro failed — will retry on Play:', e);
        });
      }

      // Schedule bloom AFTER bench completes — gives the user a brief moment
      // of dark canvas before the center glow ramps up. Was 900ms from
      // showGLCanvas; now 600ms from canvas reveal (visually equivalent in
      // most cases, slightly later on slow devices that needed a swap).
      setTimeout(() => {
        introBloomActive = true;
        introBloomStart = performance.now();
        introProximity = 0.0;
        const diag = Math.sqrt(glCanvas.width ** 2 + glCanvas.height ** 2);
        renderer.setIntroGlowRadius(diag * 0.25);
      }, 600);
    }, 300);
  }

  // Default flashlight to canvas center so early Play clicks reveal from center
  flashMouseX = glCanvas.width * 0.5;
  flashMouseY = glCanvas.height * 0.5;
}

/** Recompute star inner radii after loadPoints or resize. */
function refreshStarInnerRadii() {
  renderer.computeStarInnerRadii(_starWorldPos);
  _uploadStarPositions();
}

/** Build extraction args with optional segmentation + flow field data.
 *  Skips seg/flow if active painting dimensions don't match (mood variants). */
function getSegArgs() {
  const srcData = _activePaintingData || originalImageData;
  const sw = srcData ? srcData.width : 0;
  const sh = srcData ? srcData.height : 0;
  const segOk = segmentationData && segmentationData.width === sw && segmentationData.height === sh;
  // L1: boundaryDistField is at half-res (bfsWidth × bfsHeight). The lookup function
  // in points.js scales pixel coords to the field's dimensions, so we pass the actual
  // field dimensions (half-res), not the full-res segmentation dimensions.
  const bfsW = segmentationData ? (segmentationData.bfsWidth || segmentationData.width) : 0;
  const bfsH = segmentationData ? (segmentationData.bfsHeight || segmentationData.height) : 0;
  const seg = segOk
    ? [segmentationData.regionMap, segmentationData.width, segmentationData.height, segmentationData.boundaryDistField, bfsW, bfsH]
    : [null, 0, 0, null, 0, 0];
  const flowOk = flowFieldData && flowFieldData.width === sw && flowFieldData.height === sh;
  const flow = flowOk
    ? [flowFieldData.coherence, flowFieldData.flowAngle, flowFieldData.width, flowFieldData.height]
    : [null, null, 0, 0];
  return [...seg, ...flow];
}

/**
 * G22 pre-visible benchmark + swap.
 *
 * Run during the intro reveal pipeline (inside showGLCanvas's setTimeout)
 * AFTER `finalizeRenderProg()` so frame timings reflect the full shader,
 * but BEFORE bloom kicks off — so the user never sees the high-density
 * pass on a slow device. The canvas is held at opacity:0 throughout so
 * any drawing during sampling/swap is invisible.
 *
 * Steps:
 *   1. Sample N frame times via requestAnimationFrame
 *   2. If avg > threshold, dispatch worker re-extract at fallback density
 *   3. Wait for worker, swap point cloud (no resetIntro)
 *
 * Aborts silently if worker unavailable, upstream data missing, or worker
 * errors — device stays at High in those cases.
 */
async function _g22BenchmarkAndSwap() {
  // Manual override (?quality=… or ?dpr=, any value) skips the bench entirely.
  // User made an explicit quality choice; don't override it with an auto-tune.
  if (_qualityOverridden || _dprOverridden) return;
  // detect-gpu already classified the device as weak and applied DPR 0.7.
  // Running the bench at a post-downgrade state would only re-confirm what
  // we already know. Skip.
  if (_detectGpuDowngraded) {
    if (_hudG22El) _hudG22El.textContent = 'G22: skipped (detect-gpu)';
    return;
  }
  // Already downgraded (by any path that lowered DPR before this bench ran).
  // G22 only ratchets down, so re-entering at a post-downgrade state can't
  // raise DPR — it would just re-confirm the downgrade. Defensive against
  // re-entry paths that might emerge in the future.
  if (_dprMultiplier < 1.0) {
    if (_hudG22El) _hudG22El.textContent = 'G22: skipped (already downgraded)';
    return;
  }
  // Backgrounded tab throttles requestAnimationFrame to ~1Hz, which would
  // produce a false-positive slow reading. Skip rather than falsely downgrade
  // a fast device. User can refresh when the tab is foreground.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    if (_hudG22El) _hudG22El.textContent = 'G22: skipped (hidden tab)';
    _log('[G22] Skipping bench — tab is backgrounded (would read throttled rAF)');
    return;
  }

  // Sample frame times via raf — render loop is running in parallel, our
  // raf tick interleaves with theirs, so deltas reflect actual frame time.
  const avg = await _g22SampleFrameTimes(G22_BENCH_SKIP_FRAMES, G22_BENCH_SAMPLE_FRAMES);
  _log(
    `%c[G22]%c Bench: avg frame time ${avg.toFixed(1)}ms (threshold ${G22_BENCH_THRESHOLD_MS}ms)`,
    'color: #f80; font-weight: bold', 'color: #ccc'
  );

  // Below threshold → device handles full quality, no swap
  if (avg <= G22_BENCH_THRESHOLD_MS) {
    if (_hudG22El) _hudG22El.textContent = `G22: pass (${avg.toFixed(0)}ms)`;
    return;
  }
  if (_hudG22El) _hudG22El.style.color = '#fbbf24';

  // Above threshold → lower DPR and re-dither. Canvas is at opacity:0, so
  // the re-dither is invisible. Replaces the former particle-reduction path;
  // DPR preserves coverage ratio (each remaining particle in correct spatial
  // spot) instead of leaving density-weighted gaps. See status-log-2026-04-17.
  const oldMultiplier = _dprMultiplier;
  _dprMultiplier = G22_BENCH_FALLBACK_DPR;
  _log(
    `%c[G22]%c Bench failed → _dprMultiplier ${oldMultiplier} → ${G22_BENCH_FALLBACK_DPR}, re-dithering`,
    'color: #f80; font-weight: bold', 'color: #ccc'
  );
  try {
    applyCanvasResize();
    if (_hudG22El) _hudG22El.textContent = `G22: ↓dpr=${G22_BENCH_FALLBACK_DPR} (${avg.toFixed(0)}ms)`;
  } catch (e) {
    console.warn('[G22] Re-dither failed, reverting DPR:', e);
    _dprMultiplier = oldMultiplier;
    if (_hudG22El) _hudG22El.textContent = 'G22: fail';
  }
}

/**
 * Sample frame times via requestAnimationFrame for a fixed window.
 * Skips the first `skipCount` frames (warmup, JIT, GC), then averages
 * the next `sampleCount` deltas. Returns avg frame time in ms.
 */
function _g22SampleFrameTimes(skipCount, sampleCount) {
  return new Promise((resolve) => {
    let lastTime = 0;
    let skipped = 0;
    let samples = 0;
    let sum = 0;
    function tick() {
      const now = performance.now();
      if (lastTime > 0) {
        const ft = now - lastTime;
        if (skipped < skipCount) {
          skipped++;
        } else if (samples < sampleCount) {
          sum += ft;
          samples++;
          if (samples === sampleCount) {
            resolve(sum / sampleCount);
            return;
          }
        }
      }
      lastTime = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function reextractAndUpload() {
  if (!ditheredResult || !_ditherSource || !importanceMap) return;

  const paletteDef = PALETTES[PALETTE_KEY];

  pointData = extractPointsWeighted(
    ditheredResult,
    _ditherSource.data,
    _ditherSource.width,
    _ditherSource.height,
    paletteDef.colors,
    importanceMap,
    _qualityTier.density,
    ...getSegArgs()
  );

  renderer.loadPoints(pointData);
  refreshStarInnerRadii();

  renderer.uploadPaintingTexture(originalImageData);
  renderer.uploadTonalTexture(originalImageData);
  if (segmentationData && segmentationData.boundaryDistField) {
    // L1: Boundary texture at half-res (BFS computed at half-res)
    renderer.uploadBoundaryTexture(
      segmentationData.boundaryDistField,
      segmentationData.bfsWidth || segmentationData.width,
      segmentationData.bfsHeight || segmentationData.height
    );
  }
  if (segmentationData && segmentationData.regionMap) {
    renderer.uploadRegionMapTexture(
      segmentationData.regionMap,
      segmentationData.width,
      segmentationData.height
    );
  }
  if (segmentationData && segmentationData.clickRegionMap) {
    renderer.uploadClickRemapTexture(
      segmentationData.clickRegionMap,
      segmentationData.width,
      segmentationData.height
    );
  }
  if (segmentationData) {
    // L1: distPackTex at half-res (BFS computed at half-res, distances scaled 2×)
    renderer.uploadDistancePackTexture(
      segmentationData.flowEdgeDist || null,
      segmentationData.cypressEdgeDist || null,
      segmentationData.villageEdgeDist || null,
      segmentationData.bfsWidth || segmentationData.width,
      segmentationData.bfsHeight || segmentationData.height
    );
  }
  if (segmentationData && segmentationData.villageTopY !== undefined) {
    renderer.setVillageTopY(segmentationData.villageTopY);
    renderer.setVillageBottomY(segmentationData.villageBottomY);
  }
  if (flowFieldData) {
    renderer.uploadFlowFieldTexture(
      flowFieldData.coherence, flowFieldData.flowAngle,
      flowFieldData.width, flowFieldData.height
    );
    if (flowFieldData.curvature) {
      renderer.uploadFlowCurvatureTexture(
        flowFieldData.curvature, flowFieldData.eddyEnergy, flowFieldData.width, flowFieldData.height
      );
    }
  }
  if (cypressFlowData) {
    renderer.uploadCypressFlowTexture(
      cypressFlowData.coherence, cypressFlowData.flowAngle,
      cypressFlowData.width, cypressFlowData.height
    );
  }

  updatePointStats();
}

/**
 * Downscale an ImageData to target dimensions using browser bilinear filtering.
 * Returns a new ImageData at the target size. Reuses an offscreen canvas.
 */
function downscaleImageData(source, targetW, targetH) {
  if (!_downscaleCanvas) {
    _downscaleCanvas = document.createElement('canvas');
    _downscaleCtx = _downscaleCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!_downscaleOutCanvas) {
    _downscaleOutCanvas = document.createElement('canvas');
    _downscaleOutCtx = _downscaleOutCanvas.getContext('2d', { willReadFrequently: true });
  }
  // Draw source at full size
  _downscaleCanvas.width = source.width;
  _downscaleCanvas.height = source.height;
  _downscaleCtx.putImageData(source, 0, 0);
  // Draw scaled into reusable output canvas (bilinear high-quality)
  _downscaleOutCanvas.width = targetW;
  _downscaleOutCanvas.height = targetH;
  _downscaleOutCtx.imageSmoothingEnabled = true;
  _downscaleOutCtx.imageSmoothingQuality = 'high';
  _downscaleOutCtx.drawImage(_downscaleCanvas, 0, 0, targetW, targetH);
  return _downscaleOutCtx.getImageData(0, 0, targetW, targetH);
}

function applyDithering() {
  const srcData = _activePaintingData || originalImageData;
  if (!srcData) return;

  // Store source dimensions for DPR-aware resize calculations
  _sourceW = srcData.width;
  _sourceH = srcData.height;

  // Constrain canvas container to painting aspect ratio so it centers vertically
  // on portrait devices instead of anchoring to top with black space below.
  const container = glCanvas.closest('.canvas-container');
  if (container) {
    container.style.aspectRatio = `${_sourceW} / ${_sourceH}`;
    container.style.flex = 'none';  // let aspect-ratio control height for centering
  }

  // Ensure canvas is in the layout so getBoundingClientRect returns real
  // dimensions. (CSS starts #gl-canvas as display:none until .active is added.)
  // G22: hold opacity at 0 until the pre-visible benchmark + swap completes.
  // This way any drawing during sampling/swap is invisible to the user.
  glCanvas.classList.add('active');
  glCanvas.style.opacity = '0';

  // Initialize display aspect ratio for orientation flip detection
  const initRect = glCanvas.getBoundingClientRect();
  if (initRect.width && initRect.height) _lastDisplayAR = initRect.width / initRect.height;

  // Compute target canvas resolution (display × DPR, capped at source).
  // When within 5% of source, use source directly — bilinear downscaling
  // amplifies JPEG 8×8 block artifacts that dithering makes visible.
  const target = computeCanvasTarget();
  const scale = target.width / _sourceW;
  const useSource = scale >= 0.95;
  const ditherW = useSource ? _sourceW : target.width;
  const ditherH = useSource ? _sourceH : target.height;
  _ditherSource = useSource
    ? srcData
    : downscaleImageData(srcData, ditherW, ditherH);

  const matrixDef = MATRICES[MATRIX_KEY];
  const paletteDef = PALETTES[PALETTE_KEY];

  const startTime = performance.now();
  let elapsed, impElapsed, extractElapsed;

  {
    ditheredResult = (paletteDef.colors.length === 2) ?
      ditherBWFast(_ditherSource.data, ditherW, ditherH, SERPENTINE) :
      ditherErrorDiffusion(_ditherSource.data, ditherW, ditherH, matrixDef.matrix, paletteDef.colors, SERPENTINE);

    elapsed = performance.now() - startTime;

    // Compute importance map at dither resolution
    const impStart = performance.now();
    importanceMap = computeImportanceMap(_ditherSource.data, ditherW, ditherH);
    impElapsed = performance.now() - impStart;

    // Extract point cloud — particles at correct positions for canvas resolution
    const extractStart = performance.now();
    pointData = extractPointsWeighted(
      ditheredResult,
      _ditherSource.data,
      ditherW,
      ditherH,
      paletteDef.colors,
      importanceMap,
      _effectiveDensity(),
      ...getSegArgs()
    );

    extractElapsed = performance.now() - extractStart;
  }

  // Size the GL canvas to match dither resolution
  renderer.resize(ditherW, ditherH);
  // Trail canvas positioning deferred — content rect not available until initUI()
  touchTrail.resize(ditherW, ditherH);
  renderer.setResolutionScale(scale);

  // Upload points and start rendering
  const uploadStart = performance.now();
  renderer.loadPoints(pointData);
  _afterLoadPoints(pointData.count);
  const _loadPtsEnd = performance.now();
  refreshStarInnerRadii();

  const _texStart = performance.now();
  renderer.uploadPaintingTexture(srcData);
  const _t1 = performance.now();
  renderer.uploadTonalTexture(srcData);
  const _t2 = performance.now();
  if (segmentationData && segmentationData.boundaryDistField) {
    // L1: Boundary texture at half-res (BFS computed at half-res)
    renderer.uploadBoundaryTexture(
      segmentationData.boundaryDistField,
      segmentationData.bfsWidth || segmentationData.width,
      segmentationData.bfsHeight || segmentationData.height
    );
  }
  if (segmentationData && segmentationData.regionMap) {
    renderer.uploadRegionMapTexture(
      segmentationData.regionMap,
      segmentationData.width,
      segmentationData.height
    );
  }
  if (segmentationData && segmentationData.clickRegionMap) {
    renderer.uploadClickRemapTexture(
      segmentationData.clickRegionMap,
      segmentationData.width,
      segmentationData.height
    );
  }
  if (segmentationData) {
    // L1: distPackTex at half-res (BFS computed at half-res, distances scaled 2×)
    renderer.uploadDistancePackTexture(
      segmentationData.flowEdgeDist || null,
      segmentationData.cypressEdgeDist || null,
      segmentationData.villageEdgeDist || null,
      segmentationData.bfsWidth || segmentationData.width,
      segmentationData.bfsHeight || segmentationData.height
    );
  }
  if (segmentationData && segmentationData.villageTopY !== undefined) {
    renderer.setVillageTopY(segmentationData.villageTopY);
    renderer.setVillageBottomY(segmentationData.villageBottomY);
  }
  if (flowFieldData) {
    renderer.uploadFlowFieldTexture(
      flowFieldData.coherence, flowFieldData.flowAngle,
      flowFieldData.width, flowFieldData.height
    );
    if (flowFieldData.curvature) {
      renderer.uploadFlowCurvatureTexture(
        flowFieldData.curvature, flowFieldData.eddyEnergy, flowFieldData.width, flowFieldData.height
      );
    }
  }
  if (cypressFlowData) {
    renderer.uploadCypressFlowTexture(
      cypressFlowData.coherence, cypressFlowData.flowAngle,
      cypressFlowData.width, cypressFlowData.height
    );
  }
  const _texEnd = performance.now();
  _log(
    `%c[TexUpload]%c  Painting: ${(_t1 - _texStart).toFixed(0)}ms | Tonal: ${(_t2 - _t1).toFixed(0)}ms | Rest: ${(_texEnd - _t2).toFixed(0)}ms | Total tex: ${(_texEnd - _texStart).toFixed(0)}ms | loadPoints: ${(_loadPtsEnd - uploadStart).toFixed(0)}ms`,
    'color: #f80; font-weight: bold', 'color: #ccc'
  );

  const uploadElapsed = performance.now() - uploadStart;
  _log(
    `%c[LoadBreakdown]%c  Dither: ${elapsed.toFixed(0)}ms | Importance: ${impElapsed.toFixed(0)}ms | Extract: ${extractElapsed.toFixed(0)}ms | Upload+Sort+Spiral: ${uploadElapsed.toFixed(0)}ms`,
    'color: #ff0; font-weight: bold', 'color: #ccc'
  );

  renderer.setColorMix(0);

  renderer.startLoop();
  prePlaceStarVortices();

  // Audio pre-build is triggered from showGLCanvas() after introVisible is set
  // (300ms after this point). See showGLCanvas → setTimeout → preBuildAudioNodes.

  // Register region synth lifecycle callback → drives per-region color
  setOnStateChange((regionId, newState, oldState) => {
    const cs = regionColorState[regionId];
    if (!cs) return;
    // Stars: audio plays but glow/color visuals are driven by the simpler glow block
    // in updateStarVortexSpeeds(), not by the region color state machine.
    // Allow 'stopping' and 'off' through so the fade-out runs and dance/color reach zero.
    if (regionId === 5 && starVorticesActive
        && newState !== 'stopping' && newState !== 'off') return;
    if (newState === 'building') {
      // Skip if already pre-activated synchronously in mousedown handler —
      // re-setting activationTime here would restart the radius expansion clock.
      if (cs.state === 'active' && cs.targetIntensity === 1.0) {
        // Already activated — don't clobber activationTime
      } else {
        cs.state = 'active';
        cs.targetIntensity = 1.0;
        cs.activationTime = performance.now();
        cs.radiusNorm = 0;
      }
      // clickX/clickY set separately in mousedown handler
    } else if (newState === 'looping') {
      cs.state = 'on';
      cs.targetIntensity = ON_STATE_INTENSITY;
      // Capture current expansion progress — per-frame update continues from here
      cs.onTransitionTime = performance.now();
      cs.onTransitionRadius = cs.radiusNorm;
      // Ambient flow: keep flow drifting at reduced speed while harp loops
      if (regionId === 4 && !_flowClickHeld) {
        renderer.setFlowActive(true);
      }
    } else if (newState === 'reshaping') {
      cs.state = 'active';
      cs.targetIntensity = 1.0;
      // Don't reset radiusNorm — region is already lit from On state.
      // Backdate activationTime so the 2s ease-out curve continues seamlessly.
      if (cs.radiusNorm >= 1.0) {
        cs.activationTime = performance.now();
      } else {
        // Inverse of ease-out: r = 1-(1-t)^2  →  t = 1-sqrt(1-r)
        const t = 1.0 - Math.sqrt(Math.max(0, 1.0 - cs.radiusNorm));
        cs.activationTime = performance.now() - t * 2000;
      }
      // clickX/clickY updated in mousedown handler
    } else if (newState === 'stopping') {
      cs.state = 'fading';
      cs.targetIntensity = 0.0;
      cs.fadeStartTime = performance.now();
      cs.fadeStartIntensity = cs.intensity;
      // Release village cursor attraction when the region stops. Without this,
      // _vlAttractionRaw stays pinned at 1.0 through the full 1400ms color fade
      // (hover mode + mousemove keep re-asserting it), then releases LATER —
      // causing a late displacement snap-back that reads as a bright flash
      // where displaced particles converge to home positions.
      if (regionId === 2) _vlAttractionRaw = 0;
    } else if (newState === 'off') {
      cs.state = 'off';
      cs.targetIntensity = 0.0;
    }

    // Ambient flow shutdown: deactivate flow when region 4 leaves looping
    if (regionId === 4 && (newState === 'stopping' || newState === 'off')) {
      if (!_flowClickHeld) {
        renderer.setFlowActive(false);
      }
    }

    // Sync Play button when region 4 stops externally (X key, muteAll, etc.)
    if (regionId === 4 && _horizonAutoPlay &&
        (newState === 'stopping' || newState === 'off')) {
      _horizonAutoPlay = false;
      if (_regionLockId === 4) _regionLockId = 0;
      _flowClickHeld = false;
      if (_horizonPlayBtn && _horizonPlayBtn.reset) {
        _horizonPlayBtn.reset();
      }
    }

    // Sync Night Sky Play button and clear wake trail when region 3 stops
    if (regionId === 3 && (newState === 'stopping' || newState === 'off')) {
      if (_nightSkyResetFn) _nightSkyResetFn();
      nsWakeTrailBuf.fill(0);
      nsWakeWriteIndex = 0;
      nsWakeCursorInfluence = 0;
    }
  });

  showGLCanvas();

  // Intro: full color ready for flashlight reveal, tonal bg off
  renderer.setColorMix(1.0);
  renderer.setBgTonalStrength(0);

  // Console stats
  const totalPixels = originalImageData.width * originalImageData.height;
  _log(
    `%c[Dither] ${matrixDef.name}%c  |  ${paletteDef.name} (${paletteDef.colors.length} colors)  |  Serpentine: ${SERPENTINE ? 'on' : 'off'}  |  ${originalImageData.width}x${originalImageData.height} (${(totalPixels / 1e6).toFixed(2)}MP)  |  ${elapsed.toFixed(1)}ms  |  ${(totalPixels / elapsed / 1000).toFixed(1)} Mpx/s  |  ${pointData.count.toLocaleString()} points`,
    'color: #fff; font-weight: bold',
    'color: #999'
  );

  updateStats(elapsed);
}

/**
 * Fires a background fetch + decode for the radiant mood variant. Not
 * awaited — callers are fire-and-forget triggers. Deferred until the visitor
 * shows intent (reveal-complete callback, bfcache restore, Vivid pill click):
 * the 1.1 MB download used to start during initial load for every visitor,
 * but most never touch the mood toggle, and bandwidth is billed (June 2026).
 *
 * Decode path: classic worker — fetch, decode, and pixel readback all off
 * the main thread, RGBA buffer transferred back (zero copy) — so arrival
 * never hitches the live canvas. Falls back to the shared loadImageFromPath
 * (same loader as the main painting; synchronous decode) when OffscreenCanvas
 * is unavailable (pre-16.4 Safari) or the worker fails to boot — on those
 * browsers a one-time decode hitch matches the pre-deferral shipped behavior.
 *
 * Idempotent while a fetch is in flight (_radiantLoadStarted). On failure
 * the flag RESETS so the next trigger retries — post-Play loads can hit
 * transient mobile network drops, and a one-shot flag would strand the
 * Vivid pill on "Loading…" forever. A watchdog bounds the in-flight state:
 * a black-holed fetch never rejects, which would otherwise block every
 * retry trigger for the session. This function owns the Vivid pill state —
 * it syncs _updatePillStates on start, success, and failure.
 */
function loadRadiantInBackground() {
  if (radiantImageData || _radiantLoadStarted) return;
  _radiantLoadStarted = true;
  _updatePillStates();  // pill shows "Loading…" while genuinely in flight
  const attempt = ++_radiantAttempt;
  const path = 'assets/starry_night_radiant.webp';
  const t0 = performance.now();

  const finish = (data, how) => {
    radiantImageData = data;
    _log('[Mood] Radiant variant loaded (%s, %dx%d, %dms)',
      how, data.width, data.height, Math.round(performance.now() - t0));
    _updatePillStates();  // re-enable Major pill now that its image is available
  };
  const fail = (err) => {
    // Stale outcome: a watchdog or error from an attempt that was superseded
    // (bfcache restore resets the flag and starts a new attempt; timers
    // survive the freeze and fire late). Resetting the flag here would yank
    // it out from under the live attempt and re-open a duplicate-download
    // window. finish() needs no such guard — same image, last write wins.
    if (attempt !== _radiantAttempt) return;
    console.warn('[Mood] Radiant variant load failed — next trigger retries:', err);
    _radiantLoadStarted = false;  // allow retry (pill click / bfcache restore)
    _updatePillStates();  // pill back to clickable — a click retries via switchMood
  };
  const mainThreadPath = () => {
    loadImageFromPath(document.createElement('canvas'), path)
      .then((d) => finish(d, 'main thread'))
      .catch(fail);
  };

  if (_radiantWorkerUnsupported ||
      typeof OffscreenCanvas === 'undefined' || typeof Worker === 'undefined') {
    mainThreadPath();
    return;
  }
  let worker;
  try {
    worker = new Worker(new URL('./workers/image-decode-worker.js', import.meta.url));
  } catch (e) {
    mainThreadPath();
    return;
  }
  _radiantWorker = worker;  // module handle — pagehide cleanup terminates it
  let settled = false;
  // Returns false if another outcome already settled this attempt.
  const settle = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(watchdog);
    worker.terminate();
    if (_radiantWorker === worker) _radiantWorker = null;
    return true;
  };
  // A fetch on a black-holed connection can hang for minutes without
  // rejecting; without a bound, _radiantLoadStarted stays true and every
  // retry trigger no-ops for the rest of the session. 90s is far beyond
  // any plausible legit download time for 1.1 MB.
  const watchdog = setTimeout(() => {
    if (settle()) fail('timed out after 90s');
  }, 90000);
  worker.onmessage = (e) => {
    if (!settle()) return;
    const msg = e.data;
    if (msg && msg.buffer) {
      finish(new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height), 'worker');
    } else if (msg && msg.unsupported) {
      // Worker environment can't decode (probe ran before any fetch, so no
      // bandwidth was spent). Remember it so retries skip the worker.
      _radiantWorkerUnsupported = true;
      mainThreadPath();
    } else {
      // Worker booted but fetch/decode failed (offline, 404). Don't burn a
      // second download attempt on the fallback path — report failure and
      // let the next trigger retry.
      fail(msg && msg.error);
    }
  };
  worker.onmessageerror = () => {
    if (settle()) fail('worker reply could not be deserialized');
  };
  worker.onerror = () => {
    // Worker itself failed to load/execute — the download never started,
    // so the main-thread path won't double-spend bandwidth.
    if (settle()) mainThreadPath();
  };
  // Absolute URL: the worker resolves relative paths against js/workers/.
  worker.postMessage({ path: new URL(path, document.baseURI).href });
}

async function loadDefaultImage() {
  audioDiag.mark('loadDefaultImage:start');
  try {
    if (new URLSearchParams(location.search).has('loadError')) {
      throw new Error('Simulated load failure');
    }
    // Loading-status text appears below moon if load exceeds 2.5s from
    // navigation start (not from when loadDefaultImage runs; on slow
    // networks, JS module download can be most of the wait). Fires
    // immediately if already past threshold.
    setTimeout(() => {
      if (_loadTimeline.imagesLoaded) return;
      if (canvasPlaceholder && canvasPlaceholder.classList.contains('canvas-error')) return;
      const el = document.getElementById('loading-status');
      if (el) {
        el.textContent = 'Painting Starry Night...';
        el.classList.add('visible');
      }
    }, Math.max(0, 2500 - performance.now()));
    // ?loadDelay=<seconds> — artificial delay to test loading indicator (max 30s)
    const _delayParam = new URLSearchParams(location.search).get('loadDelay');
    if (_delayParam) {
      const delaySec = Math.max(0, Math.min(30, parseFloat(_delayParam) || 0));
      if (delaySec > 0) await new Promise(r => setTimeout(r, delaySec * 1000));
    }
    // Load source image, segmentation map, and flow field in parallel
    // Flow field is optional — project works without it (stride 7 instead of 9)
    const LOAD_TIMEOUT = new URLSearchParams(location.search).has('loadTimeout') ? 1 : 20000;
    const loadPromise = Promise.allSettled([
      loadImageFromPath(canvas2d, 'assets/starry_night.webp'),
      loadSegmentationMap('assets/territory_map_edit.webp'),
      loadFlowField('assets/flow_field.webp'),
      loadFlowField('assets/cypress_flow_field.webp'),
      loadPrebaked('assets/nocturne.data.dvs.br').catch(() => null),
    ]);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Image loading timed out')), LOAD_TIMEOUT)
    );
    const [imageData, segData, flowResult, cypressFlowResult, hybridResult] =
      await Promise.race([loadPromise, timeoutPromise]);
    _loadTimeline.imagesLoaded = performance.now();
    const _segT0 = performance.now();

    // Context lost event processes during the await above. If it fired,
    // the error overlay is already showing — don't continue init.
    if (_contextLost) return;

    if (imageData.status === 'rejected') throw imageData.reason;
    if (segData.status === 'rejected') throw segData.reason;

    originalImageData = imageData.value;
    _activePaintingData = originalImageData;
    _isRadiantActive = false;
    _moodSwitchLock = false;
    // Radiant variant is NOT fetched here — deferred to the reveal-complete
    // callback (Play click) so visitors who bounce without playing never
    // download the 1.1 MB image. See loadRadiantInBackground().

    // Hybrid prebake: if the data-only binary loaded, use its precomputed
    // BFS fields, curvature, eddy, regionMap, and clickRegionMap. Skip the
    // expensive BFS worker orchestration + curvature computation (~700ms).
    // The binary has NO particles — runtime dithers at canvas resolution.
    const hybridData = hybridResult?.status === 'fulfilled' ? hybridResult.value : null;

    if (hybridData) {
      _log('%c[hybrid]%c  data-only binary loaded — skipping BFS + curvature',
        'color: #0cf; font-weight: bold', 'color: #999');
      segmentationData = hybridData.segmentationData;
      window._segData = segmentationData;
    } else {
      segmentationData = segData.value;
      window._segData = segmentationData;
    }
    const { regionMap, width: sw, height: sh } = segmentationData;

    // When hybrid prebake loaded, BFS + curvature + clickRemap are already in
    // the binary. Skip the expensive computation. When the binary isn't available,
    // run the full live computation path.
    if (!hybridData) {
    // Start BFS distance fields in parallel Web Workers.
    // These are pure functions with no DOM deps — perfect for workers.
    // Workers run in background threads while the main thread does curvature.
    //
    // ── Boundary distance field [1, 2] — cypress + village only ──
    // Stars (region 5) are NOT locked in the distance field. This gives star
    // particles natural positive a_boundaryDist values, eliminating the dithering
    // seam artifact at star region boundaries. Same field used for both the
    // per-vertex attribute (a_boundaryDist) and the GPU texture (u_boundaryTex).
    // The shader locks star region particles (regionLock = 0) so they stay inert.
    // ── L1: Half-res BFS — downsample regionMap for 4× faster distance fields ──
    // Distance fields feed into smoothstep zones (8-50px wide). Half-res introduces
    // ±1 pixel uncertainty — imperceptible. Distances in distPackTex are scaled 2×
    // to convert half-res pixels to full-res pixels for shader edge depth comparison.
    const _dsT0 = performance.now();
    const halfReg = downsampleRegionMap(regionMap, sw, sh);
    const hrMap = halfReg.map, hrW = halfReg.width, hrH = halfReg.height;
    segmentationData.bfsWidth = hrW;
    segmentationData.bfsHeight = hrH;
    const _dsElapsed = performance.now() - _dsT0;

    const _workerLaunchT0 = performance.now();
    const boundaryPromise = runOnWarmWorker(
      'boundary', computeBoundaryDistanceField, hrMap, hrW, hrH, [1, 2]
    ).catch(() => {
      console.warn('[Init] Worker failed for boundary — falling back');
      return computeBoundaryDistanceField(hrMap, hrW, hrH, [1, 2]);
    });
    const flowEdgePromise = runOnWarmWorker(
      'flowEdge', computeFlowEdgeDistance, hrMap, hrW, hrH
    ).catch(() => {
      console.warn('[Init] Worker failed for flow edge distance — falling back to main thread');
      return computeFlowEdgeDistance(hrMap, hrW, hrH);
    });
    const cypressEdgePromise = runOnWarmWorker(
      'cypressEdge', computeCypressEdgeDistance, hrMap, hrW, hrH
    ).catch(() => {
      console.warn('[Init] Worker failed for cypress edge distance — falling back to main thread');
      return computeCypressEdgeDistance(hrMap, hrW, hrH);
    });
    const villageEdgePromise = runOnWarmWorker(
      'villageEdge', computeVillageEdgeDistance, hrMap, hrW, hrH
    ).catch(() => {
      console.warn('[Init] Worker failed for village edge distance — falling back to main thread');
      return computeVillageEdgeDistance(hrMap, hrW, hrH);
    });
    const _workerLaunchElapsed = performance.now() - _workerLaunchT0;
    // Curvature runs on main thread (GPU blur, ~85ms) while workers compute BFS
    const _curvT0 = performance.now();
    if (flowResult.status === 'fulfilled') {
      flowFieldData = flowResult.value;
      const { flowAngle, coherence, width: fw, height: fh } = flowFieldData;

      // Raw curvature via finite differences (~86ms CPU — fast, keep on CPU)
      const rawCurv = computeRawCurvature(flowAngle, coherence, fw, fh);

      // Try GPU blur (σ=15 for curvature, σ=50 for eddy energy).
      // Falls back to CPU blurAndNormalize if GPU path unavailable.
      const blurredCurv = renderer.gpuBlur(rawCurv, fw, fh, 15);
      const blurredEddy = renderer.gpuBlur(rawCurv, fw, fh, 50);

      if (blurredCurv && blurredEddy) {
        // GPU blur succeeded — normalize on CPU (p99 + gamma, fast)
        const curv = normalizeField(blurredCurv, 0.5);
        const eddy = normalizeField(blurredEddy, 0.7);
        flowFieldData.curvature = curv.field;
        flowFieldData.eddyEnergy = eddy.field;
        _log(
          `%c[FlowCurv]%c  GPU path: curvature σ=15 γ=0.5 p99=${curv.maxVal.toFixed(4)}, eddy σ=50 γ=0.7 p99=${eddy.maxVal.toFixed(4)}`,
          'color: #f80; font-weight: bold', 'color: #999'
        );
      } else {
        // GPU unavailable — fall back to CPU (slow but correct)
        _log('%c[FlowCurv]%c  GPU blur unavailable, using CPU fallback',
          'color: #fa0; font-weight: bold', 'color: #999');
        const curvEddy = computeFlowCurvatureAndEddy(flowAngle, coherence, fw, fh);
        flowFieldData.curvature = curvEddy.curvature;
        flowFieldData.eddyEnergy = curvEddy.eddyEnergy;
      }

      _log(
        '%c[Init]%c  Flow field loaded: %dx%d',
        'color: #58f; font-weight: bold', 'color: #999',
        flowFieldData.width, flowFieldData.height
      );
    } else {
      flowFieldData = null;
      _log(
        '%c[Init]%c  Flow field not found — running without it (stride 7). Generate via tools/flow-painter.html',
        'color: #fa0; font-weight: bold', 'color: #999'
      );
    }

    // Cypress flow field (optional — no curvature needed, uniform speed)
    if (cypressFlowResult.status === 'fulfilled') {
      cypressFlowData = cypressFlowResult.value;
      _log(
        '%c[Init]%c  Cypress flow field loaded: %dx%d',
        'color: #4a5; font-weight: bold', 'color: #999',
        cypressFlowData.width, cypressFlowData.height
      );
    } else {
      cypressFlowData = null;
      _log(
        '%c[Init]%c  Cypress flow field not found — cypress uses noise-only sway',
        'color: #fa0; font-weight: bold', 'color: #999'
      );
    }

    const _curvElapsed = performance.now() - _curvT0;
    // Await BFS workers (they've been running in parallel with curvature computation)
    const bfsT0 = performance.now();
    const [bfsBoundary, bfsFlowEdge, bfsCypressEdge, bfsVillageEdge] =
      await Promise.all([boundaryPromise, flowEdgePromise, cypressEdgePromise, villageEdgePromise]);
    const _bfsAwaitElapsed = performance.now() - bfsT0;

    // L1: Boundary field stays as-is (normalized [0,1] is resolution-independent).
    // Edge distances need 2× scaling to convert half-res pixels to full-res pixels —
    // the shader compares against edge depth constants tuned for full-res painting pixels.
    const _scaleT0 = performance.now();
    segmentationData.boundaryDistField = bfsBoundary;
    segmentationData.flowEdgeDist = new Float32Array(bfsFlowEdge.length);
    segmentationData.cypressEdgeDist = new Float32Array(bfsCypressEdge.length);
    segmentationData.villageEdgeDist = new Float32Array(bfsVillageEdge.length);
    for (let i = 0; i < bfsFlowEdge.length; i++) {
      segmentationData.flowEdgeDist[i] = bfsFlowEdge[i] * 2;
      segmentationData.cypressEdgeDist[i] = bfsCypressEdge[i] * 2;
      segmentationData.villageEdgeDist[i] = bfsVillageEdge[i] * 2;
    }

    const _scaleElapsed = performance.now() - _scaleT0;
    _log(
      `%c[Init]%c  BFS workers completed at ${hrW}×${hrH} (half-res, wall time: ${_bfsAwaitElapsed.toFixed(0)}ms await, scale: ${_scaleElapsed.toFixed(0)}ms)`,
      'color: #0cf; font-weight: bold', 'color: #999'
    );

    // Click remap: reclassify enclosed region 3 → 4 and sky gust region 4 → 3
    const _clickMapT0 = performance.now();
    const _cohData = flowFieldData ? flowFieldData.coherence : null;
    const _cohW = flowFieldData ? flowFieldData.width : 0;
    const _cohH = flowFieldData ? flowFieldData.height : 0;
    segmentationData.clickRegionMap = buildClickRegionMap(regionMap, sw, sh, _cohData, _cohW, _cohH);
    const _clickMapElapsed = performance.now() - _clickMapT0;

    // Village Y extent: manual values (region 2 has stray pixels across the full canvas,
    // so auto-computed bounds are useless — same approach as cypress manual topY/baseY).
    // These define the gradient zone for trail modulation: horizon → bottom.
    segmentationData.villageTopY = 0.55;
    segmentationData.villageBottomY = 0.95;

    const _segTotal = performance.now() - _segT0;
    _log(
      `%c[SegBreakdown]%c  Total: ${_segTotal.toFixed(0)}ms\n` +
      `  Downsample:        ${_dsElapsed.toFixed(0)}ms\n` +
      `  Worker launch (4): ${_workerLaunchElapsed.toFixed(0)}ms\n` +
      `  Curvature+gpuBlur: ${_curvElapsed.toFixed(0)}ms  (main thread, parallel w/ workers)\n` +
      `  BFS await:         ${_bfsAwaitElapsed.toFixed(0)}ms  (wall time after curvature)\n` +
      `  BFS scale (2×):    ${_scaleElapsed.toFixed(0)}ms\n` +
      `  ClickMap:          ${_clickMapElapsed.toFixed(0)}ms\n` +
      `  Unaccounted:       ${(_segTotal - _dsElapsed - _workerLaunchElapsed - _curvElapsed - _bfsAwaitElapsed - _scaleElapsed - _clickMapElapsed).toFixed(0)}ms`,
      'color: #f0f; font-weight: bold', 'color: #ccc'
    );
    } else {
      // Hybrid path: flow field coherence/angle still come from PNG (not in binary).
      // Curvature + eddy come from the binary via hybridData.flowFieldData.
      if (flowResult.status === 'fulfilled') {
        flowFieldData = hybridData.flowFieldData;
        flowFieldData.coherence = flowResult.value.coherence;
        flowFieldData.flowAngle = flowResult.value.flowAngle;
      } else {
        flowFieldData = null;
      }
      if (cypressFlowResult.status === 'fulfilled') {
        cypressFlowData = cypressFlowResult.value;
      } else {
        cypressFlowData = null;
      }
      const _segTotal = performance.now() - _segT0;
      _log(
        `%c[hybrid]%c  Skipped BFS + curvature (${_segTotal.toFixed(0)}ms to wire prebaked data)`,
        'color: #0cf; font-weight: bold', 'color: #999'
      );
    }

    if (_contextLost) return;

    // ── detect-gpu gate — apply DPR reduction before dither ──
    if (_detectGpuPromise) {
      _detectGpuResult = await _detectGpuPromise;
      if (_detectGpuResult) {
        const { tier, type, gpu } = _detectGpuResult;
        _log(
          `%c[detect-gpu]%c tier=${tier} type=${type} gpu="${gpu || 'unknown'}"`,
          'color: #f90; font-weight: bold', 'color: #999'
        );
        if (tier === 0) {
          // Hard block — SwiftShader / blocklisted / WebGL unsupported.
          // DPR reduction won't save software rendering or unsupported hardware.
          // Fall through to the error catch below by throwing.
          throw new Error('Device not supported (detect-gpu tier 0 — ' + type + ')');
        }
        if (tier <= 2) {
          _dprMultiplier = 0.7;
          _detectGpuDowngraded = true;
          _log(
            `%c[detect-gpu]%c tier ≤ 2 → _dprMultiplier = 0.7, G22 bench will be skipped`,
            'color: #f90; font-weight: bold', 'color: #999'
          );
        }
      }
    }

    _loadTimeline.preDither = performance.now();
    // Begin moon exit — dissolve moon while dithering runs underneath
    const moonEl = canvasPlaceholder.querySelector('.moon-loader');
    if (moonEl) moonEl.classList.add('moon-exit');
    applyDithering();
    _loadTimeline.postDither = performance.now();
    {
      const el = document.getElementById('loading-status');
      if (el) el.classList.remove('visible');
    }
    // Clean up placeholder after moon exit animation completes.
    // .moon-exit dissolves the moon over 0.5s; hide placeholder after 800ms.
    setTimeout(() => { canvasPlaceholder.hidden = true; }, 800);
  } catch (err) {
    console.error('[Init] Failed to load painting:', err);
    const container = glCanvas.closest('.canvas-container');
    if (container) container.style.flex = '1';
    canvasPlaceholder.innerHTML = '';
    canvasPlaceholder.classList.add('canvas-error');

    // detect-gpu tier 0 gets a device-not-supported message instead of the
    // connection retry message. Retry wouldn't help — the hardware/software
    // renderer can't run the experience regardless of network.
    const isDeviceUnsupported = err && err.message && err.message.startsWith('Device not supported');
    const msg = document.createElement('div');
    if (isDeviceUnsupported) {
      msg.innerHTML =
        '<strong>This device isn\u2019t supported</strong><br>' +
        'Still Night needs hardware-accelerated WebGL to render its particle painting. ' +
        'Your browser appears to be using software rendering, or running on unsupported hardware. ' +
        'Try a different browser or a more recent device.';
    } else {
      msg.innerHTML =
        '<strong>The painting couldn\u2019t be reached</strong><br>' +
        'Still Night needs to download its source image to begin. ' +
        'This is usually a temporary connection issue. Try again in a moment.';
    }
    canvasPlaceholder.appendChild(msg);

    // Only show retry for transient errors (network, etc.) — not for
    // device-unsupported cases where retrying won't help.
    if (!isDeviceUnsupported) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'canvas-retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        retryBtn.disabled = true;
        canvasPlaceholder.classList.remove('canvas-error');
        canvasPlaceholder.innerHTML = _moonLoaderHTML;
        loadDefaultImage();
      });
      canvasPlaceholder.appendChild(retryBtn);
    }
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Reusable slider row builder — label + value display + range input.
 * Used by vortex panels and audio tuning panel.
 */
function makeSlider(label, min, max, step, initial, fmt, onChange) {
  const group = document.createElement('div');
  group.className = 'vortex-control-row';
  const lbl = document.createElement('span');
  lbl.className = 'vortex-control-label';
  lbl.textContent = label;
  const valSpan = document.createElement('span');
  valSpan.className = 'vortex-control-value';
  valSpan.textContent = fmt(initial);
  // Delta span: shows +/- difference from default, colored green/red
  const deltaSpan = document.createElement('span');
  deltaSpan.className = 'vortex-control-delta';
  deltaSpan.style.cssText = 'font-size:10px; margin-left:4px; min-width:42px; display:inline-block;';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(initial);
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    onChange(v);
    valSpan.textContent = fmt(v);
    deltaSpan.textContent = '';  // clear delta when user manually adjusts
  });
  const labelRow = document.createElement('div');
  labelRow.className = 'vortex-label-row';
  labelRow.appendChild(lbl);
  labelRow.appendChild(valSpan);
  labelRow.appendChild(deltaSpan);
  group.appendChild(labelRow);
  group.appendChild(slider);
  return { group, slider, valSpan, deltaSpan };
}

/**
 * Mood Tuning panel — live sliders for lumPreserve, underpainting, additive blend.
 * Always visible in sidebar; initial values match Nocturne defaults.
 * Slider refs stored in _moodSliders for programmatic sync on mood switch.
 */
let _moodSliders = {};  // key → { slider, valSpan, fmt }

function createMoodTuningPanel() {
  const details = document.createElement('details');
  details.className = 'audio-tuning-panel';
  details.open = true;

  const summary = document.createElement('summary');
  summary.textContent = 'Mood Tuning';
  details.appendChild(summary);

  const content = document.createElement('div');
  content.className = 'audio-tuning-content';

  const sliderDefs = [
    {
      key: 'lumPreserve',
      label: 'Lum Preserve',
      min: 0, max: 1, step: 0.05, initial: 0.5,
      fmt: v => v.toFixed(2),
      onChange: v => { if (renderer) renderer.setLuminancePreserve(v); },
    },
    {
      key: 'underpainting',
      label: 'Underpainting',
      min: 0, max: 1.0, step: 0.02, initial: 0.20,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => { if (renderer) { renderer.setBgTonalStrength(v); renderer.setBgTonalTarget(v); } },
    },
    {
      key: 'additiveBlend',
      label: 'Additive Blend',
      min: 0, max: 1, step: 1, initial: 1,
      fmt: v => v >= 1 ? 'ON' : 'OFF',
      onChange: v => { if (renderer) renderer.setAdditiveBlend(v >= 1); },
    },
  ];

  for (const def of sliderDefs) {
    const { group, slider, valSpan } = makeSlider(
      def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange
    );
    _moodSliders[def.key] = { slider, valSpan, fmt: def.fmt };
    content.appendChild(group);
  }

  details.appendChild(content);
  return details;
}

/** Sync mood tuning sliders to current programmatic values. */
function syncMoodSliders(lumPreserve, underpainting, additiveBlend) {
  for (const [key, val] of [['lumPreserve', lumPreserve], ['underpainting', underpainting], ['additiveBlend', additiveBlend ? 1 : 0]]) {
    const s = _moodSliders[key];
    if (!s) continue;
    s.slider.value = String(val);
    s.valSpan.textContent = s.fmt(val);
  }
}

// ── Star Glow live meter element references ──
/** Create the Star Glow tuning panel with sliders. */
function createStarGlowPanel() {
  const details = document.createElement('details');
  details.className = 'vortex-group-panel';
  details.open = false;

  const summary = document.createElement('summary');
  summary.textContent = 'Star Glow';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'panel-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy star glow config';
  copyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const json = JSON.stringify(_starGlow, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1000);
    });
  });
  summary.appendChild(copyBtn);
  details.appendChild(summary);

  const content = document.createElement('div');
  content.className = 'audio-tuning-content';

  // ── Sliders ──
  const sliderDefs = [
    { label: 'Radius Min',      key: 'radiusMin',      min: 0.005, max: 0.20, step: 0.005, fmt: v => v.toFixed(3) },
    { label: 'Radius Max',      key: 'radiusMax',      min: 0.02,  max: 0.40, step: 0.01,  fmt: v => v.toFixed(2) },
    { label: 'Mod Depth',       key: 'modDepth',       min: 0,     max: 5.0,  step: 0.1,   fmt: v => v.toFixed(1) },
    { label: 'Centroid Scale',  key: 'centroidScale',  min: 1,     max: 50,   step: 1,     fmt: v => v.toFixed(0) },
    { label: 'RMS Scale',       key: 'rmsScale',       min: 1,     max: 20,   step: 0.5,   fmt: v => v.toFixed(1) },
    { label: 'Flicker Speed',   key: 'lfoSpeed',       min: 0,     max: 5.0,  step: 0.1,   fmt: v => v.toFixed(1) },
    { label: 'Flicker Depth',   key: 'lfoDepth',       min: 0,     max: 1.0,  step: 0.05,  fmt: v => v.toFixed(2) },
    { label: 'Breath Speed',    key: 'breathLfoSpeed', min: 0.1,   max: 5.0,  step: 0.1,   fmt: v => v.toFixed(1) },
    { label: 'Breath Depth',    key: 'breathLfoDepth', min: 0,     max: 1.0,  step: 0.05,  fmt: v => v.toFixed(2) },
    { label: 'Breath Onset (s)',key: 'breathOnsetSec', min: 0,     max: 15,   step: 0.5,   fmt: v => v.toFixed(1) },
    { label: 'Intensity Base',  key: 'intensityBase',  min: 0,     max: 1.0,  step: 0.05,  fmt: v => v.toFixed(2) },
    { label: 'Intensity Audio', key: 'intensityAudioMix', min: 0,  max: 1.0,  step: 0.05,  fmt: v => v.toFixed(2) },
  ];

  for (const def of sliderDefs) {
    const { group } = makeSlider(
      def.label, def.min, def.max, def.step, _starGlow[def.key], def.fmt,
      v => {
        _starGlow[def.key] = v;
        // Recompute baseRadius if min/max changed
        if (def.key === 'radiusMin' || def.key === 'radiusMax') {
          recomputeStarGlowRadii();
        }
      }
    );
    content.appendChild(group);
  }

  details.appendChild(content);
  return details;
}

/** Recompute starGlowData base radii when radiusMin/Max sliders change. */
function recomputeStarGlowRadii() {
  const gravities = STAR_PRESET.map(s => s.gravity);
  const gMin = Math.min(...gravities);
  const gMax = Math.max(...gravities);
  const logMin = Math.log(gMin || 1e-6);
  const logMax = Math.log(gMax || 1e-6);
  for (let i = 0; i < STAR_PRESET.length; i++) {
    const gNorm = logMax > logMin ? (Math.log(STAR_PRESET[i].gravity || 1e-6) - logMin) / (logMax - logMin) : 0.5;
    starGlowData[i].baseRadius = _starGlow.radiusMin + gNorm * (_starGlow.radiusMax - _starGlow.radiusMin);
  }
}

// Shared throttle for per-region slider DOM writes (~100 writes/frame → ~25 avg).
// Renderer state updates run every frame; only DOM display is throttled.
let _sliderDomThrottle = 0;

/** Per-frame: update Tone panel slider deltas from actual computed values. */
let _toneMeterThrottle = 0;
function updateToneMeters() {
  const refs = window._toneSliderRefs;
  if (!refs) return;
  // Throttle to every 6th frame (~10fps) — deltas are slow-moving
  if (++_toneMeterThrottle % 6 !== 0) return;
  const r5 = getRegionState(5);
  if (r5 === 'off') {
    for (const key in refs) refs[key].deltaSpan.textContent = '';
    return;
  }
  // Lightweight macro read — no full diagnostic snapshot
  const mc = getCelestialStringsMacro();
  if (!mc) return;
  const actuals = {
    reverbMix:    mc.reverbWet,
    reverbSize:   mc.roomSize,
    delayMix:     mc.delayWet,
    strumDecay:   mc.strumDecay,
  };

  for (const key in refs) {
    const ref = refs[key];
    const actual = actuals[key];
    if (actual == null) {
      ref.deltaSpan.textContent = '';
      continue;
    }
    const sliderVal = parseFloat(ref.slider.value);
    const delta = actual - sliderVal;
    if (Math.abs(delta) < 0.005) {
      ref.deltaSpan.textContent = '';
    } else {
      const sign = delta > 0 ? '+' : '';
      ref.deltaSpan.textContent = ` ${sign}${delta.toFixed(2)}`;
      ref.deltaSpan.style.color = delta > 0 ? '#6f6' : '#f66';
    }
  }
}

/** Per-frame: hold-duration speed ramp + Horizon live meters. */
/**
 * Per-frame: perceptual audio features from Horizon synth modulate 10 visual params.
 *
 * Feature inputs:
 *   rmsNorm  — self-normalized energy (0–1), drives gust amplitude, flow speed, drift fraction
 *   spread   — spectral bandwidth (FM evolution: pure → rich), drives sway/trail/eddy
 *   onset    — transient spike (own 0.92/frame decay), drives shimmer flash & deform
 *
 * Three temporal layers:
 *   Sky gust  — fast  (0.2s attack, 0.8s release)
 *   Flow      — medium (0.4s attack, 1.2s release)
 *   Drift env — slow  (1.5s attack, 3.0s release) — intensity tier for drift fraction center
 *
 * Drift Fraction uses a two-speed RMS system: slow envelope determines the center
 * of the range (higher sustained energy → higher center), flow-tier RMS oscillates
 * around that center via self-normalizing ratio. This creates organic breathing
 * that scales naturally with intensity — no discrete tier switching.
 *
 * When Horizon synth is silent (features ≈ 0), smoothed values decay to 0
 * and effective values equal base values — sliders work as before.
 */
/**
 * Update sky gust visual parameters from Night Sky audio features.
 * Same mapping depths as the original Horizon sky gust, but driven by region 3 audio.
 */
function updateNightSkyVisuals(dtSec) {
  const f = getRegionAudioFeatures(3);
  const cfg = HORIZON_MAPPING;  // reuse same mapping depths

  let rawRms = 0, rawSpread = 0, rawOnset = 0, rawMids = 0;
  if (f && f.rmsNorm > 0.001) {
    rawRms    = f.rmsNorm;
    rawSpread = f.spread;
    rawOnset  = f.onset;
    rawMids   = f.mids;
  }

  _nsSmoothSkyRaw.rms = rawRms; _nsSmoothSkyRaw.spread = rawSpread;
  smoothTier(_nsSmoothSky, _nsSmoothSkyRaw, _nsSmoothSkyKeys,
    cfg.skyAttack, cfg.skyRelease, dtSec);

  // Slow mids envelope for drift distance
  const midsEnvTau = rawMids > _nsMidsEnv ? cfg.flowSpeedEnvAtk : cfg.flowSpeedEnvRel;
  _nsMidsEnv += (rawMids - _nsMidsEnv) * (1 - Math.exp(-dtSec / midsEnvTau));

  const sky = _nsSmoothSky;

  // ── Sky Gust mappings (5) ──
  const gustAmpEff   = _skyGustAmpBase   + sky.rms * cfg.gustAmpDepth;
  const driftEff     = _skyMaxDriftBase   + _nsMidsEnv * cfg.driftDepth;
  const swayEff      = _skySwayBase       + sky.spread * cfg.swayDepth;
  const shimmerTarget = Math.min(0.30, _skyShimmerBase + rawOnset * cfg.shimmerDepth);
  const shimmerTau = shimmerTarget > _skyShimmerEased ? 0.08 : 0.8;
  _skyShimmerEased += (shimmerTarget - _skyShimmerEased) * (1 - Math.exp(-dtSec / shimmerTau));
  const shimmerEff = _skyShimmerEased;
  const trailEff     = Math.min(0.95, _skyTrailBase + sky.spread * cfg.trailDepth);

  if (renderer) {
    renderer.setSkyGustAmplitude(gustAmpEff);
    renderer.setSkyMaxDrift(driftEff);
    renderer.setSkySwayAmount(swayEff);
    renderer.setSkyStarShimmer(shimmerEff);
    renderer.setSkyGustTrailPersist(trailEff);
  }

  // ── Animate sky gust sliders in Night Sky panel (throttled to ~15fps) ──
  if (_sliderDomThrottle % 4 === 0) {
    const _nsEffective = {
      'Sky Gust Intensity': { eff: gustAmpEff,   base: _skyGustAmpBase,   max: 2.0  },
      'Sky Drift Distance': { eff: driftEff,     base: _skyMaxDriftBase,  max: 0.03 },
      'Gust Trail':         { eff: trailEff,     base: _skyTrailBase,     max: 0.95 },
      'Cross Sway':         { eff: swayEff,      base: _skySwayBase,      max: 1.0  },
      'Star Shimmer':       { eff: shimmerEff,   base: _skyShimmerBase,   max: 1.0  },
    };

    const isModulating = sky.rms > 0.005 || rawOnset > 0.005;
    for (const [label, ref] of Object.entries(_nsSliders)) {
      const info = _nsEffective[label];
      if (!info) continue;
      const displayVal = isModulating ? Math.min(info.max, info.eff) : info.base;
      ref.slider.value = String(displayVal);
      ref.valSpan.textContent = ref.fmt(displayVal);
      const delta = displayVal - ref.initial;
      if (Math.abs(delta) > 0.0005) {
        ref.deltaSpan.textContent = (delta > 0 ? '+' : '') + ref.fmt(delta);
        ref.deltaSpan.style.color = delta > 0 ? '#4f8' : '#f84';
        ref.deltaSpan.style.display = '';
      } else {
        ref.deltaSpan.style.display = 'none';
      }
    }
  }
}

/**
 * Night Sky shimmer wake: cursor proximity drives scintillation + gust boost + radial push.
 * Still cursor → shimmer builds over 1.5s, gentle ~1px push.
 * Drag → instant shimmer + gust along wake trail, strong ~12px push.
 * Audio-modulated: RMS expands radius (+40%), boosts push (+30%).
 */
function updateNightSkyWake(dtSec) {
  if (!renderer) return;
  const cw = glCanvas.width;
  const ch = glCanvas.height;
  if (cw < 1 || ch < 1) return;

  const cursorU = flashMouseX / cw;
  const cursorV = 1.0 - flashMouseY / ch;

  // Region check: cursor in Night Sky (region 3) + region active + cursor on canvas
  let inNightSky = false;
  if (flashMouseOnCanvas && getRegionState(3) !== 'off' && segmentationData) {
    const { clickRegionMap, regionMap, width, height } = segmentationData;
    const map = clickRegionMap || regionMap;
    const px = Math.max(0, Math.min(width - 1, Math.floor(cursorU * width)));
    const py = Math.max(0, Math.min(height - 1, Math.floor(cursorV * height)));
    inNightSky = map[py * width + px] === 3;
  }

  // Influence easing: tunable build time, fixed 0.3s release
  const influenceTarget = inNightSky ? 1.0 : 0.0;
  const influenceTau = influenceTarget > nsWakeCursorInfluence ? _nsWakeBuildTime : 0.3;
  nsWakeCursorInfluence += (influenceTarget - nsWakeCursorInfluence) * (1 - Math.exp(-dtSec / influenceTau));

  // Cursor speed: smooth UV/sec for push damping (fast = no push, still = full push)
  if (dtSec > 0.001) {
    const dU = cursorU - _nsWakePrevUV[0];
    const dV = cursorV - _nsWakePrevUV[1];
    const rawSpeed = Math.sqrt(dU * dU + dV * dV) / dtSec;
    const speedTau = 0.40;  // 400ms smoothing — filters hand tremor
    _nsWakeCursorSpeed += (rawSpeed - _nsWakeCursorSpeed) * (1 - Math.exp(-dtSec / speedTau));
  }
  _nsWakePrevUV[0] = cursorU;
  _nsWakePrevUV[1] = cursorV;

  // Push scales with cursor speed: still = ~1px, fast = ~12px
  const pushSpeedNorm = Math.min(1.0, _nsWakeCursorSpeed / 0.15);
  const pushScale = 0.15 + 1.85 * pushSpeedNorm;  // 0.15x at rest, 2.0x at full speed

  // Trail buffer: write every ~150ms when cursor is in Night Sky
  const simTime = renderer.getSimTime();
  if (inNightSky && simTime - nsWakeLastWriteTime > 0.15) {
    const base = nsWakeWriteIndex * 4;
    nsWakeTrailBuf[base]     = cursorU;
    nsWakeTrailBuf[base + 1] = cursorV;
    nsWakeTrailBuf[base + 2] = simTime;
    nsWakeTrailBuf[base + 3] = 1.0;
    nsWakeWriteIndex = (nsWakeWriteIndex + 1) % NS_WAKE_TRAIL_SIZE;
    nsWakeLastWriteTime = simTime;
  }

  // Audio modulation: RMS expands radius, onset boosts push
  const nsRms = _nsSmoothSky.rms;  // from updateNightSkyVisuals (same frame)
  const audioRadius = _nsWakeRadius * (1.0 + nsRms * 0.4);   // +40% at full RMS
  const audioPush = _nsWakePushStrength * (1.0 + nsRms * 0.3); // +30% at full RMS

  renderer.setNsWakeTrail(nsWakeTrailBuf);
  renderer.setNsWakeCursorUV(cursorU, cursorV);
  renderer.setNsWakeCursorInfluence(nsWakeCursorInfluence);
  renderer.setNsWakeRadius(audioRadius);
  renderer.setNsWakeDecay(_nsWakeDecay);
  renderer.setNsWakeGustBoost(_nsWakeGustBoost);
  renderer.setNsWakePushStrength(audioPush * pushScale);
  renderer.setNsWakePushInfluence(pushSpeedNorm * nsWakeCursorInfluence);
}

/**
 * Smooth and decay the flow cursor override. Called per frame.
 * Raw direction set by mousemove; this function smooths + decays influence.
 * Last valid direction is held during decay so particles ease back to painted
 * flow from the cursor direction — no snap to an arbitrary fallback.
 */
function updateFlowCursorOverride(dtSec) {
  if (!renderer) return;

  // Smooth direction (fast attack for responsiveness, moderate release for stability)
  const dirTau = 0.08; // 80ms — snappy but not jittery
  const alpha = 1 - Math.exp(-dtSec / dirTau);
  _flowCursorDirSmooth[0] += (_flowCursorDirRaw[0] - _flowCursorDirSmooth[0]) * alpha;
  _flowCursorDirSmooth[1] += (_flowCursorDirRaw[1] - _flowCursorDirSmooth[1]) * alpha;

  // Speed = magnitude of smoothed direction
  const speed = Math.sqrt(
    _flowCursorDirSmooth[0] * _flowCursorDirSmooth[0] +
    _flowCursorDirSmooth[1] * _flowCursorDirSmooth[1]
  );

  // Update last valid direction only when speed is above threshold
  // (held frozen during decay so influence fades from the last real direction)
  if (speed > 0.01) {
    _flowCursorLastDir[0] = _flowCursorDirSmooth[0] / speed;
    _flowCursorLastDir[1] = _flowCursorDirSmooth[1] / speed;
  }

  // Influence: ramps up with speed, decays when mouse stops
  const speedThreshold = 0.02; // UV/sec — below this, influence decays
  const influenceTarget = speed > speedThreshold ? 1.0 : 0.0;
  const influenceAtk = 0.15;  // 150ms to reach full influence
  const influenceRel = 1.50;  // 1.5s to decay — slow fade back to painted flow
  const influenceTau = influenceTarget > _flowCursorSpeed ? influenceAtk : influenceRel;
  _flowCursorSpeed += (influenceTarget - _flowCursorSpeed) * (1 - Math.exp(-dtSec / influenceTau));

  // Speed-scaled radius: faster mouse = wider wake, capped at 3x base
  const radiusScale = 8.0; // UV speed → radius multiplier
  const radiusTarget = Math.min(_flowCursorRadiusBase * 1.5, _flowCursorRadiusBase + speed * radiusScale);
  const radiusAtk = 0.20;  // 200ms swell — fast but not instant
  const radiusRel = 1.50;  // 1.5s — matches influence decay so edge retreats together
  const radiusTau = radiusTarget > _flowCursorRadiusEased ? radiusAtk : radiusRel;
  _flowCursorRadiusEased += (radiusTarget - _flowCursorRadiusEased) * (1 - Math.exp(-dtSec / radiusTau));

  renderer.setFlowCursorUV(_flowCursorUV[0], _flowCursorUV[1]);
  renderer.setFlowCursorDir(_flowCursorLastDir[0], _flowCursorLastDir[1]);
  renderer.setFlowCursorInfluence(_flowCursorSpeed);
  renderer.setFlowCursorRadius(_flowCursorRadiusEased);

  // Decay raw input (so smoothed direction winds down when no mousemove events arrive)
  const rawDecay = Math.exp(-dtSec / 0.05); // 50ms tau — consistent across frame rates
  _flowCursorDirRaw[0] *= rawDecay;
  _flowCursorDirRaw[1] *= rawDecay;
}

/**
 * Smooth and decay star cursor disruption. Called per frame.
 * Same pattern as flow cursor override but for star region vortex deformation.
 */
function updateStarCursorDisruption(dtSec) {
  if (!renderer) return;
  if (!starVorticesActive) {
    if (_starCursorSpeed > 0.001) {
      _starCursorSpeed = 0;
      renderer.setStarCursorInfluence(0);
    }
    return;
  }

  const cw = glCanvas.width;
  const ch = glCanvas.height;
  if (cw < 1 || ch < 1) return;
  let cursorU = flashMouseX / cw;
  let cursorV = 1.0 - flashMouseY / ch;

  // Pin mode: lock bump to vortex 0 center for off-canvas slider tuning
  if (_starBumpPinned && starVortexIds.length > 0) {
    const pos0 = renderer.getVortexPosition(starVortexIds[0]);
    if (pos0) { cursorU = pos0.x; cursorV = pos0.y; }
  }

  // Activate when cursor is inside a star (1.2x vortex radius)
  let cursorInsideStar = _starBumpPinned;
  if (!cursorInsideStar && flashMouseOnCanvas) {
    const ar = cw / ch;
    const halfDiag = Math.sqrt(0.25 * ar * ar + 0.25);
    for (let i = 0; i < starVortexIds.length; i++) {
      const pos = renderer.getVortexPosition(starVortexIds[i]);
      if (!pos) continue;
      const dx = (cursorU - pos.x) * ar;
      const dy = cursorV - pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const grav = STAR_PRESET[i] ? STAR_PRESET[i].gravity : 0;
      const gravNorm = Math.min(grav / 0.005, 1.0);
      const vRadius = halfDiag * Math.sqrt(gravNorm);
      if (dist < vRadius * 1.2) { cursorInsideStar = true; break; }
    }
  }

  const sd = _starDisrupt;
  const influenceTarget = cursorInsideStar ? 1.0 : 0.0;
  const influenceTau = influenceTarget > _starCursorSpeed ? sd.influenceAtk : sd.influenceRel;
  _starCursorSpeed += (influenceTarget - _starCursorSpeed) * (1 - Math.exp(-dtSec / influenceTau));

  // Audio modulation: speed envelope expands push radius, flash envelope boosts strength
  const audioRadius = Math.min(sd.pushRadius + _starSpeedEnvelope * sd.pushRadius * 0.6, 1.0);
  const audioStrength = sd.bumpStrength + _starFlashEnvelope * sd.bumpStrength * 0.5;

  // Push influence: slow build (0.8s) so click motion doesn't spike push
  const pushTarget = cursorInsideStar ? 1.0 : 0.0;
  const pushTau = pushTarget > _starPushInfluence ? 0.8 : 0.3;
  _starPushInfluence += (pushTarget - _starPushInfluence) * (1 - Math.exp(-dtSec / pushTau));

  renderer.setStarCursorUV(cursorU, cursorV);
  renderer.setStarCursorInfluence(_starCursorSpeed);
  renderer.setStarBumpStrength(audioStrength * _starPushInfluence);
  renderer.setStarPushRadius(audioRadius);

  // Update slider readouts with effective (audio-modulated) values (throttled to ~15fps)
  if (_sliderDomThrottle % 4 === 0) {
    const isModulating = _starSpeedEnvelope > 0.005 || _starFlashEnvelope > 0.005;
    const effMap = {
      'Bump Strength': { eff: audioStrength, base: sd.bumpStrength },
      'Push Radius': { eff: audioRadius, base: sd.pushRadius },
    };
    for (const [label, ref] of Object.entries(_bumpSliders)) {
      const info = effMap[label];
      if (!info) continue;
      const displayVal = isModulating ? info.eff : info.base;
      ref.slider.value = String(displayVal);
      ref.valSpan.textContent = ref.fmt(displayVal);
      const delta = displayVal - ref.initial;
      if (Math.abs(delta) > 0.0005) {
        const sign = delta > 0 ? '+' : '';
        const deltaText = ref.initial > 0
          ? `${sign}${((delta / ref.initial) * 100).toFixed(0)}%`
          : `${sign}${delta.toFixed(3)}`;
        ref.deltaSpan.textContent = deltaText;
        ref.deltaSpan.style.color = delta > 0 ? '#3cff6e' : '#ff4c4c';
      } else {
        ref.deltaSpan.textContent = '';
      }
    }
  }
}

/**
 * Per-vortex cursor speed modulation via incremental phase accumulation.
 * Each frame: compute cursor proximity, ease angular velocity toward boost
 * or zero, integrate into phase offset. No retroactive angle change — only
 * adds rotation going forward, so no backward snap when cursor leaves.
 */
function updateVortexCursorSpeed(dtSec) {
  if (!renderer || !starVorticesActive) return;

  // Cursor UV from canvas-pixel flashlight coords
  const cw = glCanvas.width;
  const ch = glCanvas.height;
  if (cw < 1 || ch < 1) return;
  const cursorU = flashMouseX / cw;
  const cursorV = 1.0 - flashMouseY / ch; // flip Y back to UV

  // Cursor speed in UV/sec (smoothed)
  if (dtSec > 0.001) {
    const dU = cursorU - _vortexCursorPrevUV[0];
    const dV = cursorV - _vortexCursorPrevUV[1];
    const rawSpeed = Math.sqrt(dU * dU + dV * dV) / dtSec;
    const speedTau = 0.08; // 80ms smoothing
    const speedAlpha = 1 - Math.exp(-dtSec / speedTau);
    _vortexCursorSpeedSmooth += (rawSpeed - _vortexCursorSpeedSmooth) * speedAlpha;
  }
  _vortexCursorPrevUV[0] = cursorU;
  _vortexCursorPrevUV[1] = cursorV;

  // Speed factor: 0.5 at rest, 1.0 at fast cursor (~0.3 UV/sec)
  const cursorSpeedNorm = Math.min(1.0, _vortexCursorSpeedSmooth / 0.3);
  const cursorSpeedFactor = 0.5 + 0.5 * cursorSpeedNorm;

  for (let i = 0; i < starVortexIds.length; i++) {
    const id = starVortexIds[i];
    const pos = renderer.getVortexPosition(id);
    if (!pos) continue;

    const vIdx = renderer.getVortexIndexById(id);
    if (vIdx < 0) continue;

    // Distance from cursor to vortex center (aspect-corrected, matches shader)
    const ar = cw / ch;
    const dx = (cursorU - pos.x) * ar;
    const dy = cursorV - pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Use the vortex's visual radius as the proximity threshold
    const halfDiag = Math.sqrt(0.25 * ar * ar + 0.25);
    const grav = STAR_PRESET[i] ? STAR_PRESET[i].gravity : 0;
    const gravNorm = Math.min(grav / 0.005, 1.0);
    const vRadius = halfDiag * Math.sqrt(gravNorm);

    // Target angular velocity: proximity gradient × cursor speed factor
    const inside = dist < vRadius && flashMouseOnCanvas;
    const proxGradient = inside ? smoothstep(vRadius, 0, dist) : 0;
    const targetAngVel = _vortexCursorBoost * proxGradient * cursorSpeedFactor;

    // Per-vortex independent ease
    const tau = targetAngVel > _vortexCursorMult[vIdx] ? _vortexCursorAtkTau : _vortexCursorRelTau;
    _vortexCursorMult[vIdx] += (targetAngVel - _vortexCursorMult[vIdx]) * (1 - Math.exp(-dtSec / tau));

    renderer.setVortexCursorAngVel(vIdx, _vortexCursorMult[vIdx]);
  }

  // Integrate angular velocity into phase offset (renderer-side accumulation)
  renderer.integrateVortexCursorPhase(dtSec);
}

function updateHorizonAudio(dtSec) {
  const f = getHorizonAudioFeatures();
  _lastHorizonFeatures = f;              // stash for Audio Scope (avoids double analyze())
  const cfg = HORIZON_MAPPING;

  // ── Raw feature extraction ──
  // rmsNorm (0–1, self-normalized), spread (spectral bandwidth), onset (transient spike).
  // Onset has its own 0.92/frame decay — bypasses tier smoothing for punchy transients.
  let rawRms = 0, rawSpread = 0, rawOnset = 0, rawMids = 0;
  if (f && f.rmsNorm > 0.001) {
    rawRms      = f.rmsNorm;
    rawSpread   = f.spread;
    rawOnset    = f.onset;       // bypasses tier smoothing (has own decay)
    rawMids     = f.mids;
  }

  // ── Temporal smoothing (flow tier only — sky gust moved to updateNightSkyVisuals) ──
  _hzSmoothFlowRaw.rms = rawRms; _hzSmoothFlowRaw.spread = rawSpread; _hzSmoothFlowRaw.mids = rawMids;
  smoothTier(_hzSmoothFlow, _hzSmoothFlowRaw, _hzSmoothFlowKeys,
    cfg.flowAttack, cfg.flowRelease, dtSec);

  // ── Drift Fraction: slow RMS envelope (intensity tier detector) ──
  const driftEnvTau = rawRms > _hzDriftEnvelope ? cfg.driftFracEnvAtk : cfg.driftFracEnvRel;
  _hzDriftEnvelope += (rawRms - _hzDriftEnvelope) * (1 - Math.exp(-dtSec / driftEnvTau));

  // ── Flow Speed: slow mids envelope (macro intensity tracker) ──
  const flow = _hzSmoothFlow;
  const flowEnvTau = flow.mids > _hzFlowSpeedEnv ? cfg.flowSpeedEnvAtk : cfg.flowSpeedEnvRel;
  _hzFlowSpeedEnv += (flow.mids - _hzFlowSpeedEnv) * (1 - Math.exp(-dtSec / flowEnvTau));

  // ── Flow mappings (4) ──
  let flowSpeedEff  = _flowSpeedBase     + _hzFlowSpeedEnv * cfg.flowSpeedDepth;
  // Ambient flow: reduce speed when looping but not held
  if (!_flowClickHeld && _isHorizonLooping()) {
    flowSpeedEff *= AMBIENT_FLOW_SCALE;
  }

  // Drift Fraction: two-speed RMS breathing
  // Slider base offsets the floor (default slider=0.85 maps to floor shift of 0).
  const driftFloor  = cfg.driftFracFloor + (_flowDriftFracBase - 0.85);
  const driftRange  = cfg.driftFracCeiling - cfg.driftFracFloor;
  const driftCenter = driftFloor + Math.min(_hzDriftEnvelope, 1.0) * driftRange;
  // Normalized deviation: fast flow-tier RMS vs slow envelope, self-scaling
  const driftRatio  = _hzDriftEnvelope > 0.01
    ? (flow.rms - _hzDriftEnvelope) / _hzDriftEnvelope
    : 0;
  const driftOsc    = Math.max(-1, Math.min(1, driftRatio * 2.0)) * cfg.driftFracSwing;
  const driftFracEff = Math.max(0.80, Math.min(0.995, driftCenter + driftOsc));

  const gustIntEff    = Math.min(1.0, _gustAmpBase + _hzFlowSpeedEnv * cfg.gustIntDepth);
  const eddyEff       = _eddyContrastBase  + _hzFlowSpeedEnv * cfg.eddyDepth;
  const twinkleEff    = Math.min(1.0, flow.rms * cfg.flowTwinkleDepth);
  const swirlTrailEff = Math.min(0.90, _swirlTrailBase + _hzFlowSpeedEnv * cfg.swirlTrailDepth);

  if (renderer) {
    renderer.setFlowSpeed(flowSpeedEff);
    renderer.setFlowDriftFrac(driftFracEff);
    renderer.setGustAmplitude(gustIntEff);
    renderer.setEddyContrast(eddyEff);
    renderer.setFlowTwinkle(twinkleEff);
    renderer.setSwirlTrailPersist(swirlTrailEff);
  }

  // ── Canvas deform (onset-driven, no tier smoothing) ──
  const deformMod = Math.max(0, rawOnset - cfg.deformThresh) * cfg.deformDepth;
  const deformEff = _canvasDeformBase + deformMod;

  if (renderer) {
    renderer.setCanvasDeformAmp(deformEff);
  }

  // ── Animate all 9 modulated sliders in real time (throttled to ~15fps) ──
  // Map effective values to slider labels for per-frame animation
  const _hzEffective = {
    'Flow Speed':         { eff: flowSpeedEff, base: _flowSpeedBase,    max: 0.30 },
    'Drift Fraction':     { eff: driftFracEff, base: driftCenter, max: 0.995 },
    'Gust Intensity':     { eff: gustIntEff,   base: _gustAmpBase,      max: 1.0  },
    'Eddy Contrast':      { eff: eddyEff,      base: _eddyContrastBase, max: 1.0  },
    'Flow Twinkle':       { eff: twinkleEff,   base: 0,                max: 1.0  },
    'Flow Trail':         { eff: swirlTrailEff, base: _swirlTrailBase,  max: 0.90 },
    'Canvas Deform':      { eff: deformEff,    base: _canvasDeformBase, max: 0.03 },
  };

  _lastMappingOutput = _hzEffective;   // stash for Audio Scope mapping panel

  if (_sliderDomThrottle % 4 === 0) {
    const isModulating = flow.rms > 0.005 || rawOnset > 0.005;
    for (const [label, ref] of Object.entries(_hzSliders)) {
      const info = _hzEffective[label];
      if (!info) continue;
      const displayVal = isModulating ? Math.min(info.max, info.eff) : info.base;
      ref.slider.value = String(displayVal);
      ref.valSpan.textContent = ref.fmt(displayVal);

      // Delta from default: green if above, red if below, hidden if ~zero
      const delta = displayVal - ref.initial;
      if (Math.abs(delta) > 0.0005) {
        const sign = delta > 0 ? '+' : '';
        let deltaText;
        if (ref.initial > 0 && Math.abs(ref.initial) >= 0.01) {
          const pct = (delta / ref.initial) * 100;
          deltaText = `${sign}${pct.toFixed(0)}%`;
        } else {
          deltaText = `${sign}${delta.toFixed(4)}`;
        }
        ref.deltaSpan.textContent = deltaText;
        ref.deltaSpan.style.color = delta > 0 ? '#3cff6e' : '#ff4c4c';
      } else {
        ref.deltaSpan.textContent = '';
      }
    }
  }
}


/**
 * Per-frame: reads Cypress (region 1) analyzer features and modulates
 * 11 visual parameters. Heavy & slow character: long attack/release,
 * bass-driven. Follows the exact Horizon pattern: base + modulation.
 */
function updateCypressAudio(dtSec) {
  const f = getRegionAudioFeatures(1);
  _lastCypressFeatures = f;
  const cfg = CYPRESS_MAPPING;

  // Raw feature extraction
  let rawRms = 0, rawOnset = 0, rawMids = 0, rawBass = 0, rawFlux = 0;
  if (f && f.rmsNorm > 0.001) {
    rawRms    = f.rmsNorm;
    rawOnset  = f.onset;
    rawMids   = f.mids;
    rawBass   = f.bass;
    rawFlux   = f.flux;
  }

  // Temporal smoothing per tier — 5 tiers with distinct time constants
  _cySmoothBassRaw.bass = rawBass;
  smoothTier(_cySmoothBass, _cySmoothBassRaw, _cySmoothBassKeys,
    cfg.bassAttack, cfg.bassRelease, dtSec);
  _cySmoothCanopyRaw.rms = rawRms;
  smoothTier(_cySmoothCanopy, _cySmoothCanopyRaw, _cySmoothCanopyKeys,
    cfg.canopyAttack, cfg.canopyRelease, dtSec);
  _cySmoothFlowRaw.rms = rawRms; _cySmoothFlowRaw.mids = rawMids;
  smoothTier(_cySmoothFlow, _cySmoothFlowRaw, _cySmoothFlowKeys,
    cfg.flowAttack, cfg.flowRelease, dtSec);
  _cySmoothFluxRaw.flux = rawFlux;
  smoothTier(_cySmoothFlux, _cySmoothFluxRaw, _cySmoothFluxKeys,
    cfg.fluxAttack, cfg.fluxRelease, dtSec);

  // ── Wind direction bias: smoothed horizontal drag velocity ──
  const windAttackTau = 0.15;   // 150ms — responsive to drag
  const windReleaseTau = 2.5;   // 2.5s — wind subsides slowly
  const windTau = Math.abs(_cyRawWindVx) > Math.abs(_cyWindBias) ? windAttackTau : windReleaseTau;
  _cyWindBias += (_cyRawWindVx - _cyWindBias) * (1 - Math.exp(-dtSec / windTau));
  // Decay raw input toward zero when not dragging (mouseup clears it)
  _cyRawWindVx *= Math.exp(-dtSec / 0.1);  // fast decay of raw signal

  // Onset easing: fast attack (80ms), medium release (800ms) — pop & fade
  const onsetTau = rawOnset > _cyOnsetEased ? 0.08 : 0.8;
  _cyOnsetEased += (rawOnset - _cyOnsetEased) * (1 - Math.exp(-dtSec / onsetTau));

  // Slow envelopes
  const bass = _cySmoothBass;
  const driftEnvTau = bass.bass > _cyDriftEnvelope ? cfg.driftFracEnvAtk : cfg.driftFracEnvRel;
  _cyDriftEnvelope += (bass.bass - _cyDriftEnvelope) * (1 - Math.exp(-dtSec / driftEnvTau));

  const flow = _cySmoothFlow;
  const flowEnvTau = flow.mids > _cyFlowEnv ? cfg.flowEnvAtk : cfg.flowEnvRel;
  _cyFlowEnv += (flow.mids - _cyFlowEnv) * (1 - Math.exp(-dtSec / flowEnvTau));

  const canopy = _cySmoothCanopy;
  const flux = _cySmoothFlux;

  // ── Bass group (glacial — trunk inertia) ──
  const swayAmpEff   = _cySwayBase  + bass.bass * cfg.swayAmpDepth;
  const swayDistEff  = _cyDistBase  + bass.bass * cfg.swayDistDepth;
  const trailEff     = Math.min(0.95, _cyTrailBase + bass.bass * cfg.trailDepth);

  // ── RMS group (canopy energy — leaf response) ──
  const canopyEff    = Math.min(1.0, _cyCanopyGlowBase + canopy.rms * cfg.canopyGlowDepth);
  const breathEff    = Math.max(5, _cyBreathBase + canopy.rms * cfg.breathPeriodDepth);

  // ── Mids group (flow currents) ──
  const flowDriftEff = _cyFlowDriftBase + _cyFlowEnv * cfg.flowDriftDepth;
  const flowGustEff  = Math.min(1.0, _cyFlowGustBase + _cyFlowEnv * cfg.flowGustDepth);

  // ── Flux group (timbral shimmer — fast reactive) ──
  const crossSwayEff = Math.min(1.0, _cyCrossBase + flux.flux * cfg.crossSwayDepth);
  const gatedFlux    = Math.max(0, flux.flux - cfg.fluxThreshold);
  const rimGlowEff   = Math.min(1.0, _cyRimGlowBase + gatedFlux * cfg.rimGlowDepth);

  // ── Onset (transient pop) ──
  const leafFlashEff = Math.min(1.0, _cyLeafFlashBase + _cyOnsetEased * cfg.leafFlashDepth);

  // ── Drift Fraction: bass-driven breathing ──
  const driftFloor  = cfg.driftFracFloor + (_cyFlowDriftFracBase - 0.90);
  const driftRange  = cfg.driftFracCeiling - cfg.driftFracFloor;
  const driftCenter = driftFloor + Math.min(_cyDriftEnvelope, 1.0) * driftRange;
  const driftRatio  = (bass.bass - _cyDriftEnvelope) / Math.max(0.01, _cyDriftEnvelope);
  const driftOsc    = Math.max(-1, Math.min(1, driftRatio * 2.0)) * cfg.driftFracSwing;
  const driftFracEff = Math.max(0.80, Math.min(0.995, driftCenter + driftOsc));

  // ── Push to renderer ──
  if (renderer) {
    renderer.setCypressSwayAmp(swayAmpEff);
    renderer.setCypressMaxDrift(swayDistEff);
    renderer.setCypressCrossSway(crossSwayEff);
    renderer.setCypressTrailPersist(trailEff);
    renderer.setCypressCanopyGlow(canopyEff);
    renderer.setCypressBreathPeriod(breathEff);
    renderer.setCypressFlowMaxDrift(flowDriftEff);
    renderer.setCypressFlowGustAmp(flowGustEff);
    renderer.setCypressRimGlow(rimGlowEff);
    renderer.setCypressLeafFlash(leafFlashEff);
    renderer.setCypressFlowDriftFrac(driftFracEff);
    renderer.setCypressWindBias(_cyWindBias);
  }

  // ── Animate sliders (throttled to ~15fps) ──
  if (_sliderDomThrottle % 4 === 0) {
    const _cyEffective = {
      'Sway Intensity':  { eff: swayAmpEff,   base: _cySwayBase,          max: 3.0   },
      'Sway Distance':   { eff: swayDistEff,  base: _cyDistBase,          max: 0.024 },
      'Cross Sway':      { eff: crossSwayEff, base: _cyCrossBase,         max: 1.0   },
      'Trail Persist':   { eff: trailEff,     base: _cyTrailBase,         max: 0.95  },
      'Canopy Glow':     { eff: canopyEff,    base: _cyCanopyGlowBase,    max: 1.0   },
      'Breath Period':   { eff: breathEff,    base: _cyBreathBase,        max: 40    },
      'Flow Max Drift':  { eff: flowDriftEff, base: _cyFlowDriftBase,     max: 0.050 },
      'Flow Gust':       { eff: flowGustEff,  base: _cyFlowGustBase,      max: 1.0   },
      'Rim Glow':        { eff: rimGlowEff,   base: _cyRimGlowBase,      max: 1.0   },
      'Leaf Flash':      { eff: leafFlashEff, base: _cyLeafFlashBase,     max: 1.0   },
      'Flow Drift Frac': { eff: driftFracEff, base: driftCenter,          max: 0.995 },
    };

    const isModulating = bass.bass > 0.005 || canopy.rms > 0.005 || flux.flux > 0.002 || rawOnset > 0.005;
    for (const [label, ref] of Object.entries(_cySliders)) {
      const info = _cyEffective[label];
      if (!info) continue;
      const displayVal = isModulating ? Math.min(info.max, info.eff) : info.base;
      ref.slider.value = String(displayVal);
      ref.valSpan.textContent = ref.fmt(displayVal);
      const delta = displayVal - ref.initial;
      if (Math.abs(delta) > 0.0005) {
        const sign = delta > 0 ? '+' : '';
        let deltaText;
        if (ref.initial > 0 && Math.abs(ref.initial) >= 0.01) {
          deltaText = `${sign}${((delta / ref.initial) * 100).toFixed(0)}%`;
        } else {
          deltaText = `${sign}${delta.toFixed(4)}`;
        }
        ref.deltaSpan.textContent = deltaText;
        ref.deltaSpan.style.color = delta > 0 ? '#3cff6e' : '#ff4c4c';
      } else {
        ref.deltaSpan.textContent = '';
      }
    }
  }
}

// ── Village audio → visual mapping ──────────────────────────────────────────
// Step 1: scaffold — extract features, run smoothing tiers, log to verify.
// No visual parameters are driven yet — that comes in steps 2-6.
let _swarmSimActive = false;  // toggled by Simulate Swarm button in village panel
function updateVillageAudio(dtSec) {
  if (_swarmSimActive) { _vlAttractionRaw = 1.0; }
  const f = getRegionAudioFeatures(2);
  _lastVillageFeatures = f;
  const cfg = VILLAGE_MAPPING;

  // Raw feature extraction
  let rawRms = 0, rawBass = 0, rawMids = 0, rawFlux = 0, rawOnset = 0;
  if (f && f.rmsNorm > 0.001) {
    rawRms    = f.rmsNorm;
    rawBass   = f.bass;
    rawMids   = f.mids;
    rawFlux   = f.flux;
    rawOnset  = f.onset;
  }

  // Temporal smoothing per tier
  _vlSmoothBodyRaw.rms = rawRms;
  smoothTier(_vlSmoothBody, _vlSmoothBodyRaw, _vlSmoothBodyKeys,
    cfg.bodyAttack, cfg.bodyRelease, dtSec);
  // Foundation tier smoothing handled manually in Step 3 (light jitter filter)
  _vlSmoothWindRaw.mids = rawMids;
  smoothTier(_vlSmoothWind, _vlSmoothWindRaw, _vlSmoothWindKeys,
    cfg.windAttack, cfg.windRelease, dtSec);
  _vlSmoothShimmerRaw.rms = rawRms;
  smoothTier(_vlSmoothShimmer, _vlSmoothShimmerRaw, _vlSmoothShimmerKeys,
    cfg.shimmerAttack, cfg.shimmerRelease, dtSec);

  // Onset easing: fast attack (80ms), medium release (800ms)
  const onsetTau = rawOnset > _vlOnsetEased ? 0.08 : 0.8;
  _vlOnsetEased += (rawOnset - _vlOnsetEased) * (1 - Math.exp(-dtSec / onsetTau));

  // ── Step 2: rmsNorm → orbital amplitude ──
  const body = _vlSmoothBody;
  const ampEff = Math.max(0.001, Math.min(0.008, _vlAmpBase + body.rms * cfg.ampDepth));

  // ── Step 3: bass → breathing depth ──
  // Asymmetric smoothing: fast attack (snaps to peaks), slower release (no flicker).
  // Tracks LFO pulse rhythm without frame-to-frame jitter on the decay side.
  // Breathing depth: static slider value. Phase accumulator handles all rhythm.
  const breathDepthEff = _vlBreathDepthBase;

  // ── Step 4: mids → noise drift ──
  const wind = _vlSmoothWind;
  const noiseDriftEff = Math.max(0.001, Math.min(0.008, _vlNoiseDriftBase + wind.mids * cfg.noiseDriftDepth));

  // ── Step 5: rmsNorm → cross sway (shimmer tier) ──
  const shimmer = _vlSmoothShimmer;
  const crossSwayEff = Math.min(1.0, _vlCrossSwayBase + shimmer.rms * cfg.crossSwayDepth);

  // ── Cursor attraction: ease in on hold, ease out on release ──
  const attractAttackTau = 0.10;   // 100ms — responsive grab
  const attractReleaseTau = 0.40;  // 400ms — soft release, particles drift back
  const attractTau = _vlAttractionRaw > _vlAttractionSmoothed ? attractAttackTau : attractReleaseTau;
  _vlAttractionSmoothed += (_vlAttractionRaw - _vlAttractionSmoothed) * (1 - Math.exp(-dtSec / attractTau));

  // ── Cursor movement detection: idle (wide radius) vs moving (tight radius) ──
  // Smooth the delta itself rather than binary threshold — prevents jitter at slow speeds.
  const cursorDx = _vlCursorUV[0] - _vlPrevCursorUV[0];
  const cursorDy = _vlCursorUV[1] - _vlPrevCursorUV[1];
  const cursorDelta = Math.sqrt(cursorDx * cursorDx + cursorDy * cursorDy);
  _vlPrevCursorUV[0] = _vlCursorUV[0];
  _vlPrevCursorUV[1] = _vlCursorUV[1];
  // Map delta to 0-1: 0.0005 = barely moving, 0.005 = fast drag
  const cursorSpeed = _vlAttractionSmoothed > 0.01
    ? Math.min(1, Math.max(0, (cursorDelta - 0.0002) / 0.004))
    : 0;
  const moveAttackTau = 0.15;   // 150ms — responsive but not twitchy
  const moveReleaseTau = 0.80;  // 800ms — ease back to wide
  const moveTau = cursorSpeed > _vlCursorMovingSmoothed ? moveAttackTau : moveReleaseTau;
  _vlCursorMovingSmoothed += (cursorSpeed - _vlCursorMovingSmoothed) * (1 - Math.exp(-dtSec / moveTau));

  // ── Wind blend: is cursor outside village region? ──
  // Sample region map at cursor UV — region 2 = village, anything else = outside.
  let cursorInVillage = true;
  if (segmentationData && _vlAttractionSmoothed > 0.01) {
    const rm = segmentationData.regionMap;
    const sw = segmentationData.width, sh = segmentationData.height;
    const px = Math.max(0, Math.min(sw - 1, Math.floor(_vlCursorUV[0] * sw)));
    const py = Math.max(0, Math.min(sh - 1, Math.floor(_vlCursorUV[1] * sh)));
    cursorInVillage = (rm[py * sw + px] === 2);
  }

  // Track exit: cursor just left village → seed exit point and radius
  if (_vlWasInVillage && !cursorInVillage) {
    // Don't reset radius — if mid-contraction from a previous exit, keep expanding from current
    if (_vlRippleRadius < (renderer ? renderer.getVillageWindRadius() : 0.15)) {
      _vlRippleRadius = renderer ? renderer.getVillageWindRadius() : 0.15;
    }
  }
  // While outside village: exit point follows cursor (prevents buildup at a fixed spot)
  if (!cursorInVillage && _vlAttractionSmoothed > 0.01) {
    _vlExitPointUV[0] = _vlCursorUV[0];
    _vlExitPointUV[1] = _vlCursorUV[1];
  }
  _vlWasInVillage = cursorInVillage;

  const idleRadius = renderer ? renderer.getVillageWindRadius() : 0.15;
  if (!cursorInVillage && _vlAttractionSmoothed > 0.01) {
    // Outside village: expand radius (capped at 0.15 UV — matches idleRadius so
    // ripple doesn't grow past the resting reach; re-entry no longer feels like
    // village "reaches out" from far away. Previously 0.35 → felt too large).
    _vlRippleRadius += dtSec * 0.08;
    _vlRippleRadius = Math.min(_vlRippleRadius, 0.15);
  } else {
    // Inside village (or not holding): contract radius back to idle
    _vlRippleRadius -= dtSec * 0.12;  // slightly faster contraction
    _vlRippleRadius = Math.max(_vlRippleRadius, idleRadius);
  }

  // Drift fraction: independent smoothing (slow decay on re-entry)
  const driftFracTarget = cursorInVillage ? (renderer ? parseFloat(renderer.getSwarmDriftFrac ? renderer.getSwarmDriftFrac() : 0.50) : 0.50) : 0.98;
  const driftAttackTau = 0.30;   // 300ms to reach wind drift fraction
  const driftReleaseTau = 2.00;  // 2s to settle back to funnel drift fraction
  const driftTau = driftFracTarget > _vlDriftFracSmoothed ? driftAttackTau : driftReleaseTau;
  _vlDriftFracSmoothed += (driftFracTarget - _vlDriftFracSmoothed) * (1 - Math.exp(-dtSec / driftTau));

  const windBlendTarget = cursorInVillage ? 0 : 1;
  const windAttackTau = 0.20;   // 200ms into wind mode
  const windReleaseTau = 0.30;  // 300ms back to funnel
  const windTau = windBlendTarget > _vlWindBlend ? windAttackTau : windReleaseTau;
  _vlWindBlend += (windBlendTarget - _vlWindBlend) * (1 - Math.exp(-dtSec / windTau));

  // ── Accumulate swarm time (frozen when attraction=0, real-time when active) ──
  _vlSwarmTime += dtSec * _vlAttractionSmoothed;
  if (_vlSwarmTime > 1e5) _vlSwarmTime -= 1e5;  // prevent float32 precision loss

  // ── Accumulate breathing phase from LFO rate (VCO-style, no phase jumps) ──
  const lfoRate = getVillagePulseLfoRate();
  const visualRate = Math.min(lfoRate, cfg.breathRateCap);
  if (visualRate > 0.01) {
    _vlBreathPhase += dtSec * visualRate * 6.2832;  // advance phase by dt × freq × 2π
    if (_vlBreathPhase > 6.2832 * 1000) _vlBreathPhase -= 6.2832 * 1000;  // prevent float overflow
  }

  if (renderer) {
    renderer.setVillageWindAmp(ampEff);
    renderer.setVillageBreathDepth(breathDepthEff);
    renderer.setVillageBreathPhase(_vlBreathPhase);
    renderer.setVillageNoiseDrift(noiseDriftEff);
    renderer.setVillageCrossSway(crossSwayEff);
    renderer.setVillageWindCenter(_vlCursorUV[0], _vlCursorUV[1]);
    renderer.setVillageAttraction(window._dvs_noVillageAttraction ? 0 : _vlAttractionSmoothed);
    // Blend radius: idle (slider value) → moving (1/3 of slider value)
    const idleRadius = renderer.getVillageWindRadius();
    const activeRadius = idleRadius * (1 - _vlCursorMovingSmoothed * 0.67);  // 100% → 33% of idle
    renderer.setVillageWindRadiusActive(activeRadius);
    renderer.setVillageWindBlend(_vlWindBlend);
    renderer.setVillageExitPoint(_vlExitPointUV[0], _vlExitPointUV[1]);
    renderer.setVillageWindRippleRadius(_vlRippleRadius);
    renderer.setSwarmDriftFracSmoothed(_vlDriftFracSmoothed);
    // Blend drag strength: boost when moving (2× at full speed)
    const idleStrength = renderer.getVillageAttractionAmp();
    renderer.setVillageAttractionAmpActive(idleStrength * (1 + _vlCursorMovingSmoothed * 0.3));
    renderer.setVillageCursorMoving(_vlCursorMovingSmoothed);
    renderer.setVillageSwarmTime(_vlSwarmTime);
  }

  // ── Animate sliders (throttled to ~15fps) ──
  if (_sliderDomThrottle % 4 === 0) {
    const _vlEffective = {
      'Amplitude': { eff: ampEff, base: _vlAmpBase, max: 0.008 },
      'Noise Drift': { eff: noiseDriftEff, base: _vlNoiseDriftBase, max: 0.008 },
      'Cross Sway': { eff: crossSwayEff, base: _vlCrossSwayBase, max: 1.0 },
    };
    const vlIsModulating = body.rms > 0.005 || wind.mids > 0.005 || shimmer.rms > 0.005;
    for (const [label, ref] of Object.entries(_vlSliders)) {
      const info = _vlEffective[label];
      if (!info) continue;
      const displayVal = vlIsModulating ? Math.min(info.max, info.eff) : info.base;
      ref.slider.value = String(displayVal);
      ref.valSpan.textContent = ref.fmt(displayVal);
      const delta = displayVal - ref.initial;
      if (Math.abs(delta) > 0.0005) {
        const sign = delta > 0 ? '+' : '';
        let deltaText;
        if (ref.initial > 0 && Math.abs(ref.initial) >= 0.01) {
          deltaText = `${sign}${((delta / ref.initial) * 100).toFixed(0)}%`;
        } else {
          deltaText = `${sign}${delta.toFixed(4)}`;
        }
        ref.deltaSpan.textContent = deltaText;
        ref.deltaSpan.style.color = delta > 0 ? '#3cff6e' : '#ff4c4c';
      } else {
        ref.deltaSpan.textContent = '';
      }
    }
  }

  // Debug: log smoothed values (~2 Hz throttle)
  if (window._villageAudioDebug && _audioDiagCounter % 30 === 0) {
    _log(
      `%c[VillageAudio]%c  body=${_vlSmoothBody.rms.toFixed(3)} foundation=${_vlSmoothFoundation.bass.toFixed(3)} wind=${_vlSmoothWind.mids.toFixed(3)} shimmer=${_vlSmoothShimmer.flux.toFixed(3)} onset=${_vlOnsetEased.toFixed(3)}`,
      'color: #c93; font-weight: bold', 'color: #999'
    );
  }
}

/**
 * Spawn a subset of STAR_PRESET vortices by their indices (all at once).
 * Used by the MIDI choreography scheduler to place one group at a time.
 * @param {number[]} indices — STAR_PRESET indices to spawn
 * @param {number} [noteDuration] — Time in seconds for the vortex emergence.
 *   Computed by the choreography scheduler as "time until next note" so each
 *   group's fade fills the musical space before the next event.
 */
/**
 * Pre-place 12 dormant vortices at STAR_PRESET positions on load.
 * All motion params zeroed (invisible, inert). Each vortex stores its
 * STAR_PRESET art targets as presetParams for later activation.
 */
function prePlaceStarVortices() {
  if (!renderer || !renderer.isRunning) return;
  starVortexIds = [];
  for (let i = 0; i < STAR_PRESET.length; i++) {
    const v = STAR_PRESET[i];
    // Dormant: strength=0, gravity=0 → zero radius → invisible
    const id = renderer.addVortex(v.x, v.y, v.sign, 0, 0, { dormant: true });
    if (id === -1) continue;
    renderer.setVortexSpeed(id, 0);
    renderer.setVortexArmTightness(id, 0);
    renderer.setVortexArmCurl(id, 0);
    renderer.setVortexTurbulence(id, 0);
    // Store the STAR_PRESET targets for dormant→active activation
    renderer.setVortexPresetParams(id, {
      strength: v.strength,
      gravity: v.gravity,
      speed: v.speed,
      armTightness: v.armTightness,
      armCurl: v.armCurl,
      curlAmount: v.curlAmount,
      trail: v.trail,
    });
    starVortexIds.push(id);
  }
  _log(
    `%c[Vortex]%c  Pre-placed ${starVortexIds.length} dormant star vortices`,
    'color: #ff0; font-weight: bold', 'color: #999'
  );
}

/**
 * Activate dormant star vortices on Stars region click.
 * Sorts by Euclidean distance from cursor, activates closest first,
 * each separated by 250ms (~2.75s total spread for 12 vortices).
 * @param {number} wx — cursor world-space X
 * @param {number} wy — cursor world-space Y
 */
function activateStarVortices(wx, wy) {
  if (starVorticesActive) return;  // already active, skip re-activation
  starVorticesActive = true;
  _starRmsSmoothed = 0;
  _starSpeedEnvelope = 0;
  _starGravityEnvelope = 0;
  _starFlashEnvelope = 0;

  // Open strum window immediately so the second click can strum (matches Cypress:
  // first tap opens 300ms window, second tap within window fires strum).
  // Timer is a no-op — it just expires the window. Dismiss is NOT deferred here
  // because stars were just activated (nothing to dismiss).
  if (_starStrumTimer) clearTimeout(_starStrumTimer);
  _starStrumTimer = setTimeout(() => { _starStrumTimer = null; }, 300);

  // Start Stars synth (region 5) — only if not already active (region path may have
  // already called regionMouseDown(5) which handles audio init).
  const starsAlreadyActive = getRegionState(5) !== 'off';
  if (!starsAlreadyActive) {
    _lastActivatedRegion = 5;
    playRegion(5, 0).then(() => {
      // Guard: if stars were deactivated while playRegion was awaiting async init,
      // stopRegion(5) would have been a no-op (state was still 'off'). Stop now.
      if (!starVorticesActive) {
        _log('%c[Stars]%c  playRegion resolved after deactivation — calling stopRegion(5)',
          'color: #f66; font-weight: bold', 'color: #999');
        stopRegion(5);
        return;
      }
      // Auto-switch Audio Scope to monitor Stars when programmatically activated
      if (_audioScope && _audioScope.isVisible()) {
        _audioScope.setRegion(5);
      }
      // Deferred expression: playRegion clears mouseExpr.active, so re-activate
      // if the user is still holding the mouse (exprHoldState alive from mousedown).
      if (_starExprDeferred && exprHoldState && exprHoldState.regionId === 5) {
        setMouseExprActive(5, true);
        _starExprDeferred = false;
      }
    }).catch(() => {});
  }

  // Cancel any in-progress activation stagger
  for (const t of activationTimers) clearTimeout(t);
  activationTimers = [];

  // Sort starVortexIds by distance from cursor position
  const sorted = starVortexIds
    .map(id => {
      const pos = renderer.getVortexPosition(id);
      if (!pos) return { id, dist: Infinity };
      const dx = pos.x - wx;
      const dy = pos.y - wy;
      return { id, dist: Math.sqrt(dx * dx + dy * dy) };
    })
    .sort((a, b) => a.dist - b.dist);

  // Cascade acceleration: geometric gap sequence (popcorn effect).
  // First gap is longest (~120ms), each subsequent gap is 82% of the previous.
  // Closest star gets breathing room, then the rest pour in rapidly.
  const cascadeGap0 = 120;   // first gap (ms)
  const cascadeRatio = 0.82; // each gap shrinks by this factor
  const cascadeDelays = [0];
  for (let j = 1; j < sorted.length; j++) {
    cascadeDelays[j] = cascadeDelays[j - 1] + cascadeGap0 * Math.pow(cascadeRatio, j - 1);
  }
  sorted.forEach(({ id }, i) => {
    const delay = cascadeDelays[i];
    const timer = setTimeout(() => {
      if (!renderer || !renderer.isRunning) return;
      renderer.setVortexActive(id, true);
      renderer.resetVortexBirthTime(id);  // rotation starts from zero at activation
      birthPulses.set(id, 1.0);  // birth pulse: brief gravity/speed overshoot
      // Ramp toward preset params — set targets, easeState() handles interpolation
      const p = renderer.getVortexPresetParams(id);
      if (p) {
        renderer.setVortexStrength(id, p.strength);
        renderer.setVortexGravity(id, p.gravity);
        renderer.setVortexSpeed(id, p.speed);
        renderer.setVortexArmTightness(id, 0);
        renderer.setVortexArmCurl(id, 0);
        renderer.setVortexTurbulence(id, 0);
        renderer.setVortexFadeDuration(id, 2.0);  // 2s ramp from dormant to full
      }
    }, delay);
    activationTimers.push(timer);
  });

  _log(
    `%c[Vortex]%c  Stars activation: ${sorted.length} vortices staggered over ${((sorted.length - 1) * 250 / 1000).toFixed(1)}s`,
    'color: #ff0; font-weight: bold', 'color: #999'
  );
}

// ── Hold-to-expand: per-frame reach expansion ────────────────────────────────

function expandStarReach() {
  if (!renderer || !renderer.isRunning) return;
  const elapsed = (performance.now() - _holdExpandStart) / 1000;
  const t = Math.min(1.0, elapsed / HOLD_EXPAND_DURATION);
  const eased = 1 - (1 - t) * (1 - t);  // ease-out quadratic
  const reach = HOLD_EXPAND_INITIAL + (HOLD_EXPAND_MAX - HOLD_EXPAND_INITIAL) * eased;
  const [ox, oy] = _holdExpandOrigin;

  for (const id of starVortexIds) {
    if (renderer.isVortexActive(id)) continue;  // already activated, skip
    const pos = renderer.getVortexPosition(id);
    if (!pos) continue;
    const dx = pos.x - ox, dy = pos.y - oy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= reach) {
      // Activate this star
      renderer.setVortexActive(id, true);
      renderer.resetVortexBirthTime(id);
      birthPulses.set(id, 1.0);
      starVorticesActive = true;
      const p = renderer.getVortexPresetParams(id);
      if (p) {
        renderer.setVortexStrength(id, p.strength);
        renderer.setVortexGravity(id, p.gravity);
        renderer.setVortexSpeed(id, p.speed);
        renderer.setVortexArmTightness(id, 0);
        renderer.setVortexArmCurl(id, 0);
        renderer.setVortexTurbulence(id, 0);
        renderer.setVortexFadeDuration(id, 2.0);
      }
    }
  }
}

// ── Per-frame audio-reactive star vortex update ──────────────────────────────

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Exponential smoothing with asymmetric attack/release per feature key.
 * Attack (faster) when target > current, release (slower) when target < current.
 * Frame-rate-independent via exp(-dt/tau).
 */
function smoothTier(acc, raw, keys, attackSec, releaseSec, dt) {
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const target = raw[key] || 0;
    const tau = target > acc[key] ? attackSec : releaseSec;
    const alpha = 1 - Math.exp(-dt / tau);
    acc[key] += (target - acc[key]) * alpha;
  }
}

// ── Star vortex speed modulation (two-stage smoothed RMS envelope) ──
// Stars are heavy celestial bodies — audio energy slowly swells them faster over
// musical phrases, and they coast back down when energy drops. Heavy flywheel metaphor.
let _starRmsSmoothed = 0;     // Stage 1: jitter-filtered RMS
let _starSpeedEnvelope = 0;   // Stage 2: asymmetric attack/release envelope (the flywheel)
let _starGravityEnvelope = 0; // Separate envelope for gravity/strength — heavier, slower
let _starFlashEnvelope = 0;   // Fast envelope for corona ray flash (pluck response)
let _starAudioPhase = 0;      // Accumulated audio phase for corona ray noise drift

function updateStarVortexSpeeds(dtSec) {
  if (!starVorticesActive) return;

  // Get + cache features for Audio Scope reuse
  _lastStarsFeatures = getStarsAudioFeatures();
  const f = _lastStarsFeatures;
  const config = STARS_MAPPING;

  // Extract raw RMS (gate at 0.001 for silence)
  const rawRms = (f && f.rms > 0.001) ? f.rms : 0;

  // Stage 1: jitter filter — symmetric exponential smoothing removes FFT noise
  const jitterAlpha = 1 - Math.exp(-dtSec / config.speedJitterTau);
  _starRmsSmoothed += (rawRms - _starRmsSmoothed) * jitterAlpha;

  // Stage 2: asymmetric envelope — slow attack (swell), slower release (coast)
  const rmsNorm = Math.min(1.0, _starRmsSmoothed * 6.0); // same normalization as elsewhere
  const envTau = rmsNorm > _starSpeedEnvelope ? config.speedAttack : config.speedRelease;
  const envAlpha = 1 - Math.exp(-dtSec / envTau);
  _starSpeedEnvelope += (rmsNorm - _starSpeedEnvelope) * envAlpha;

  // Gravity/strength envelope — same RMS input, heavier flywheel (slower attack & release)
  const gravTau = rmsNorm > _starGravityEnvelope ? config.gravityAttack : config.gravityRelease;
  const gravAlpha = 1 - Math.exp(-dtSec / gravTau);
  _starGravityEnvelope += (rmsNorm - _starGravityEnvelope) * gravAlpha;

  // Flash envelope — fast response for corona ray pluck flash
  const flashTau = rmsNorm > _starFlashEnvelope ? config.flashAttack : config.flashRelease;
  const flashAlpha = 1 - Math.exp(-dtSec / flashTau);
  _starFlashEnvelope += (rmsNorm - _starFlashEnvelope) * flashAlpha;

  // Accumulate audio phase for corona ray noise drift (monotonic, never resets)
  _starAudioPhase += _starRmsSmoothed * 0.04;

  // Global swell from spectral centroid
  if (f) {
    const centroid = f.centroid * rmsNorm;
    renderer.setSwell(0.25 + centroid * config.centroidToSwell);
  }

  const now = performance.now();

  for (const id of starVortexIds) {
    if (!renderer.isVortexActive(id)) continue;

    const p = renderer.getVortexPresetParams(id);
    if (!p) continue;

    // Speed ramp: smoothstep wind-up delayed after gravity expansion
    const activationTime = renderer.getVortexActivationTime(id);
    const fadeDuration = renderer.getVortexFadeDuration(id);
    const elapsed = (now - activationTime) / 1000;
    const speedDelay = fadeDuration * 0.3;
    const speedDuration = 1.5;
    const speedElapsed = Math.max(0, elapsed - speedDelay);
    const st = Math.min(1.0, speedElapsed / speedDuration);
    const speedRamp = st * st * (3 - 2 * st); // smoothstep ease-in-out

    // Birth pulse: damped spring overshoot/settle (Disney squash & stretch)
    const birthAge = (now - (activationTime || now)) / 1000;
    const springDamping = 4.0;
    const springFreq = 4.5;
    const springAmp = 0.40;
    const envelope = springAmp * Math.exp(-springDamping * birthAge);
    const birthBoost = envelope > 0.005 ? envelope * Math.cos(springFreq * birthAge) : 0;
    const birthSpeedBoost = Math.max(0, birthBoost) * p.speed * 1.5;

    // Final speed: preset × ramp × (1 + audio envelope boost) + birth impulse
    const speed = p.speed * speedRamp * (1.0 + _starSpeedEnvelope * config.speedMaxBoost)
      + birthSpeedBoost;
    renderer.setVortexSpeed(id, speed);

    // Arm tightness: spiral ramp birth animation × audio envelope boost
    const r = smoothstep(0, fadeDuration, elapsed);
    let spiralRamp = 0;
    {
      const gCurrent = renderer.getVortexGravityCurrent(id);
      const gTarget = p.gravity * r;
      if (gTarget > 0 && gCurrent >= gTarget * 0.90) {
        if (!_spiralDelayReached.has(id)) _spiralDelayReached.set(id, now);
        const t = Math.min(1.0, (now - _spiralDelayReached.get(id)) / 1000 / SPIRAL_DELAY_RAMP);
        spiralRamp = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
      }
    }
    const tightness = Math.min(1.0,
      p.armTightness * spiralRamp * (1.0 + _starSpeedEnvelope * config.tightnessMaxBoost));
    renderer.setVortexArmTightness(id, tightness);

    // Gravity & strength: audio boost once ramp-in complete, skip during removal.
    // Boost relative to PRESET (not current) to prevent exponential compounding.
    // Only fires when envelope has meaningful energy — when silent, gravity creep
    // in easeState() handles slow organic growth instead.
    const isRemoving = renderer.isVortexRemoving(id);
    if (r >= 1.0 && !isRemoving && _starGravityEnvelope > 0.005) {
      const gBase = p.gravity;
      const gBoosted = gBase * (1.0 + _starGravityEnvelope * config.gravityMaxBoost);
      renderer.setVortexGravity(id, Math.min(gBoosted, 0.005));
      renderer.setVortexStrength(id, p.strength * (1.0 + _starGravityEnvelope * config.strengthMaxBoost));
    }
  }

  // Global trail: envelope-driven, no per-vortex differentiation
  const trail = Math.min(1.0,
    config.trailBaseline * (1.0 + _starSpeedEnvelope * config.trailMaxBoost));
  renderer.setGlobalVortexTrail(trail);

  // ── Star glow: gravity envelope + per-note strum pulses ──
  // Gravity envelope provides the base glow for all stars.
  // Per-note strum boosts from Celestial Strings add individual pulses:
  // each plucked note lights up its corresponding star.
  // Note-to-star mapping: index 0 (G4, lowest) = star 0 (largest), frequency→mass.
  // Star glow: simple gravity-envelope + strum-boost driven glow.
  // Bloom only fires during strum flash transients (not continuous).
  if (_starGravityEnvelope > 0.005 || getCelestialStrumBoosts()) {
    const strumBoosts = getCelestialStrumBoosts();  // Float32Array(12) or null
    const hasStrum = strumBoosts !== null;
    // Convert star world positions → canvas UV
    for (let i = 0; i < 12; i++) {
      _starCenterBuf[i * 2]     = starGlowData[i].cx;
      _starCenterBuf[i * 2 + 1] = 1.0 - starGlowData[i].cy;
      // Radius: gravity envelope base + strum boost additive pulse
      const strumBoost = hasStrum ? strumBoosts[i] * config.strumGlowRadius : 0;
      _starRadiiBuf[i] = starGlowData[i].baseRadius
        * (1.0 + _starGravityEnvelope * _starGlow.modDepth * (_isRadiantActive ? 1.1 : 1.0) + strumBoost);
      // Per-star intensity: gravity envelope base + strum boost pulse
      const strumIntensity = hasStrum ? strumBoosts[i] * config.strumGlowIntensity : 0;
      _starIntensityBuf[i] = Math.min(1.0, _starGravityEnvelope + strumIntensity);
    }
    renderer.setStarGlowCenters(_starCenterBuf);
    renderer.setStarGlowRadii(_starRadiiBuf);
    renderer.setStarGlowIntensities(_starIntensityBuf);
    const baseInner = renderer.getStarInnerRadii();
    for (let i = 0; i < 12; i++) _starInnerRadiiBuf[i] = baseInner[i] || 0.03;
    renderer.setStarInnerRadii(_starInnerRadiiBuf);
  } else {
    // Silent: ensure glow and corona are off
    renderer.setStarGlowIntensity(0);  // broadcasts 0 to all 12
    renderer.setSinWaveMode(false);
  }
}

/**
 * Per-frame update: reads Stars analyzer features and modulates active
 * star vortex params. Called from the beforeRender callback every frame
 * regardless of whether the synth is playing — when silent, features ≈ 0
 * and vortices sit at their base preset values.
 */
function updateStarVortices() {
  if (!starVorticesActive) return;
  // Reuse cached features from updateStarVortexSpeeds (runs first, same frame)
  const f = _lastStarsFeatures;
  if (!f) return;

  const config = STARS_MAPPING;
  // Single synth voice produces RMS ~0.05–0.15 vs full mix ~0.3–0.7.
  // Normalize: boost features and use RMS as a soft gate rather than a multiplier.
  const rms = f.rms;
  const now = performance.now();

  // Per-vortex modulation
  for (const id of starVortexIds) {
    if (!renderer.isVortexActive(id)) continue;

    // Ramp-in: smoothstep from 0→1 over fadeDuration since activation
    const activationTime = renderer.getVortexActivationTime(id);
    const fadeDuration = renderer.getVortexFadeDuration(id);
    const elapsed = (now - activationTime) / 1000;
    const r = smoothstep(0, fadeDuration, elapsed);

    const p = renderer.getVortexPresetParams(id);
    if (!p) continue;

    // ── Spiral values: tightness, curl, turbulence ──
    // In 'delayed' mode, these stay 0 until gravity reaches target, then ramp over 2s.
    let spiralRamp = 1.0;  // 1.0 = full preset, 0.0 = zeroed
    let spiralRampDone = false;
    {
      const gCurrent = renderer.getVortexGravityCurrent(id);
      const gTarget = p.gravity * r;
      if (gTarget > 0 && gCurrent >= gTarget * 0.90) {
        // Gravity reached — start or continue ramp
        if (!_spiralDelayReached.has(id)) _spiralDelayReached.set(id, now);
        const elapsed = (now - _spiralDelayReached.get(id)) / 1000;
        const t = Math.min(1.0, elapsed / SPIRAL_DELAY_RAMP);
        spiralRamp = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
        if (t >= 1.0) spiralRampDone = true;
      } else {
        spiralRamp = 0;
      }
    }
    // Once ramp completes, stop overriding — let user edit sliders freely
    if (!spiralRampDone) {
      renderer.setVortexArmCurl(id, spiralRamp * p.armCurl);
      renderer.setVortexTurbulence(id, spiralRamp * p.curlAmount * r);
    }
    // Gravity & strength ramp-in only during emergence.
    // Once established (r >= 1.0), audio boost in updateStarVortexSpeeds takes over.
    if (r < 1.0) {
      renderer.setVortexGravity(id, p.gravity * r);
      renderer.setVortexStrength(id, p.strength * r);
    }
  }
}

/**
 * Per-frame update: ease per-region color intensity toward target,
 * advance radial reveal progress, and push values into the renderer.
 */
function updateRegionColors() {
  const now = performance.now();
  for (let i = 1; i <= 5; i++) {
    const cs = regionColorState[i];

    // ── Radius expansion ──
    if (cs.state === 'active' && cs.radiusNorm < 1.0) {
      // Active: 2-second ease-out from click origin
      const elapsed = (now - cs.activationTime) / 1000;
      const expandDuration = 2.0;
      const t = Math.min(1.0, elapsed / expandDuration);
      cs.radiusNorm = 1.0 - Math.pow(1.0 - t, 2);
    } else if (cs.state === 'on' && cs.radiusNorm < 1.0) {
      // On: accelerated expansion from wherever Active left off (0.75s to finish)
      const elapsed = (now - cs.onTransitionTime) / 1000;
      const remaining = 1.0 - cs.onTransitionRadius;
      const duration = 0.75;
      const t = Math.min(1.0, elapsed / duration);
      const eased = 1.0 - Math.pow(1.0 - t, 2);
      cs.radiusNorm = cs.onTransitionRadius + remaining * eased;
    }
    // 'fading': radiusNorm stays at 1.0 (color fades uniformly, doesn't contract)

    // ── Region lock override (L key testing mode) ──
    if (_regionLockId === i) {
      cs.targetIntensity = 1.0;
      if (cs.radiusNorm < 1.0) cs.radiusNorm = 1.0;
    }

    // ── Intensity update ──
    if (cs.state === 'fading') {
      // Time-based ease-out cubic: fast response, gentle settling, exact zero.
      // Replaces exponential decay which asymptotically approaches 0 (never arrives).
      // All visual effects ride region state via master alpha — everything hits
      // zero on the same frame, no thresholds needed.
      const FADE_DURATION = 1400; // ms — Apple-like settle: displacement fades ~290ms, color lingers
      const elapsed = now - cs.fadeStartTime;
      const t = Math.min(1.0, elapsed / FADE_DURATION);
      const oneMinusT = 1.0 - t;
      cs.intensity = cs.fadeStartIntensity * oneMinusT * oneMinusT * oneMinusT;
    } else if (cs.state === 'off') {
      cs.intensity = 0.0;
    } else {
      // active, on: existing per-frame smoothing toward target
      const smoothRate = cs.state === 'on' ? 0.08 : 0.12;
      cs.intensity += (cs.targetIntensity - cs.intensity) * smoothRate;
    }

    // Upload per-region activation uniforms to shader.
    // u_regionActive drives color independently from u_regionMix.
    // Both coexist via max() in the shader — whichever is higher wins.
    // All regions get full intensity — star glow adds warmth via emission, not mix_val
    renderer.setRegionActivation(i, cs.intensity, cs.clickX, cs.clickY, cs.radiusNorm);

    // Village (region 2) gets per-particle fade-out stagger — lets the fade
    // end on slightly different frames per particle instead of snapping all
    // at once. Gated on 'fading' state so fade-in stays uniform/snappy.
    if (i === 2) renderer.setVillageFadeOut(cs.state === 'fading');
    if (i === 3) renderer.setSkyFadeOut(cs.state === 'fading');
    if (i === 4) renderer.setHorizonFadeOut(cs.state === 'fading');

    // First visual frame timing probe
    if (window._clickTiming && cs.state === 'active' && !window._clickTiming.firstVisualFrame) {
      window._clickTiming.firstVisualFrame = performance.now();
      const t0 = window._clickTiming.mousedown || window._clickTiming.preAwait;
      _log(
        `%c[ClickTiming]%c  First visual frame: %c${(window._clickTiming.firstVisualFrame - t0).toFixed(1)}ms%c after click  (intensity: ${cs.intensity.toFixed(3)}, radius: ${cs.radiusNorm.toFixed(3)})`,
        'color: #f80; font-weight: bold', 'color: #999',
        'color: #f00; font-weight: bold', 'color: #999'
      );
    }
  }
}

/**
 * Per-frame update: drive star glow from Stars region audio features.
 * Each of 12 stars glows independently, breathing with the synth's spectral centroid.
 * Glow reveals color in sky (3), horizon (4), and stars (5) particles.
 */
// updateStarGlow removed April 8 — replaced by simpler glow block in
// updateStarVortexSpeeds(). The old function's always-on bloom and persistent
// corona rays conflicted with the silence gate. Star Glow tuning sliders
// still write to _starGlow config which the working glow block reads.

// (Dead updateStarGlow body + telemetry removed)

/**
 * Place the hardcoded star vortex preset (12 vortices with exact art params).
 */
function placeStarVortices() {
  if (!renderer || !renderer.isRunning) return;

  // Cancel any in-progress staggered placement
  for (const t of staggerTimers) clearTimeout(t);
  staggerTimers = [];

  renderer.forceRemoveAll();   // hard wipe so preset slots aren't blocked by dying vortices

  const STAGGER_TOTAL = 5000; // ms total spread
  const step = STAGGER_TOTAL / (STAR_PRESET.length - 1);

  STAR_PRESET.forEach((v, i) => {
    const delay = i * step;  // 0, ~830, ~1660, ...
    const timer = setTimeout(() => {
      if (!renderer || !renderer.isRunning) return;
      const id = renderer.addVortex(v.x, v.y, v.sign, v.strength, v.gravity);
      if (id === -1) return;
      renderer.setVortexSpeed(id, v.speed);
      renderer.setVortexArmTightness(id, 0);
      renderer.setVortexArmCurl(id, 0);
      renderer.setVortexTurbulence(id, 0);
    }, delay);
    staggerTimers.push(timer);
  });

  _log(
    `%c[Vortex]%c  Twilight emergence: ${STAR_PRESET.length} vortices over ${STAGGER_TOTAL / 1000}s`,
    'color: #ff0; font-weight: bold', 'color: #999'
  );
}

export function initUI() {
  canvas2d = document.getElementById('preview-canvas');
  glCanvas = document.getElementById('gl-canvas');
  canvasPlaceholder = document.getElementById('canvas-placeholder');
  // Capture moon loader markup from the initial DOM — reused for retry flow
  // after an error state wipes the placeholder. Must run before any code path
  // can replace canvasPlaceholder contents.
  const _moonEl = canvasPlaceholder && canvasPlaceholder.querySelector('.moon-loader');
  if (_moonEl) _moonLoaderHTML = _moonEl.outerHTML;
  statsPanel = document.getElementById('stats-panel');
  statsGrid = document.getElementById('stats-grid');

  // ?diagnose — full GPU diagnostic, tests each init stage independently
  if (new URLSearchParams(location.search).has('diagnose')) {
    import('./debug/gpu-diagnostic.js').then(mod => {
      glCanvas.classList.add('active');
      canvasPlaceholder.hidden = true;
      const introOverlay = document.getElementById('intro-overlay');
      if (introOverlay) introOverlay.hidden = true;
      mod.runGpuDiagnostic(glCanvas);
    });
    return;
  }

  // ?perfOverlay — live runtime performance profiler
  if (new URLSearchParams(location.search).has('perfOverlay')) {
    perfInit();
    perfSetRegionStates(() => [1, 2, 3, 4, 5].map(id => ({
      id,
      state: getRegionState(id) || 'off',
    })));
  }

  // Defer renderer creation so the browser paints the loading state before
  // the potentially blocking shader compilation.
  // Uses setTimeout (not rAF) because Firefox enforces strict execution
  // time limits on rAF callbacks that _initRenderer's heavy work exceeds.
  setTimeout(_initRenderer, 0);
}

async function _initRenderer() {
  _loadTimeline.initRendererStart = performance.now();
  const _params = new URLSearchParams(location.search);

  // ── Firefox + Intel Mac gate ──
  // Firefox on macOS uses Apple's deprecated OpenGL driver (not ANGLE→Metal
  // like Chrome/Safari). On Intel Macs the driver's register allocator takes
  // tens of seconds on the render shader and runtime hits ~1 FPS under load.
  // Chrome and Safari on the same hardware run fine. Escape: ?allowFirefox=1.
  //
  // detect-gpu distinguishes Intel Mac from Apple Silicon via Firefox's
  // privacy-masked renderer string: Intel → "Intel(R) HD Graphics 400, or
  // similar", Apple Silicon → "Apple M1, or similar" (per Firefox's
  // SanitizeRenderer.cpp). Apple Silicon falls through — untested on our
  // hardware but likely tolerable; widen the rule if reports say otherwise.
  const _ua = navigator.userAgent;
  const _forceFirefoxGate = _params.has('firefoxGate');
  const _uaMatchesGate = /Firefox\//i.test(_ua) && /Macintosh|Mac OS X/i.test(_ua);
  if ((_forceFirefoxGate || _uaMatchesGate) && !_params.has('allowFirefox')) {
    // For the forced-test path (?firefoxGate), skip detect-gpu entirely so
    // the gate UI renders on any device — Windows, Chrome, iPad, anything.
    // For the real gate, await detect-gpu and only show for Intel (Firefox's
    // privacy-masked string on Apple Silicon contains "apple" and falls through).
    let _shouldGate = _forceFirefoxGate;
    if (!_shouldGate && _detectGpuPromise) {
      _detectGpuResult = await _detectGpuPromise;
      const _gpuName = (_detectGpuResult && _detectGpuResult.gpu) || '';
      // Gate if detect-gpu reports Intel, or if it failed entirely (conservative
      // — we can't verify Apple Silicon without a GPU string).
      _shouldGate = /intel/i.test(_gpuName) || !_gpuName;
    }
    if (_shouldGate) {
      _log(
        _forceFirefoxGate
          ? '%c[gate]%c ?firefoxGate — forcing Firefox-on-Intel-Mac message for testing'
          : '%c[gate]%c Firefox on Intel Mac — showing device-not-supported message (override: ?allowFirefox=1)',
        'color: #f90; font-weight: bold', 'color: #999'
      );
      const container = glCanvas.closest('.canvas-container');
      if (container) container.style.flex = '1';
      canvasPlaceholder.innerHTML = '';
      canvasPlaceholder.classList.add('canvas-error');
      canvasPlaceholder.innerHTML =
        '<strong>This browser can\u2019t play the painting smoothly</strong><br>' +
        'Still Night runs too slowly in Firefox. ' +
        'Try opening this page in Chrome or Safari.';
      return;  // bail — nothing else can run without a usable browser
    }
  }

  const rendererResult = _params.has('shaderError')
    ? { error: 'shader', shader: 'render' }
    : _params.has('webglError')
      ? { error: 'webgl2' }
      : createRenderer(glCanvas);

  if (rendererResult && rendererResult.error) {
    // Ensure canvas container has height for the error overlay (aspect-ratio
    // is normally set when the painting loads, which won't happen on error).
    const container = glCanvas.closest('.canvas-container');
    if (container) container.style.flex = '1';
    canvasPlaceholder.innerHTML = '';
    canvasPlaceholder.classList.add('canvas-error');
    if (rendererResult.error === 'webgl2') {
      canvasPlaceholder.innerHTML =
        '<strong>This browser can\u2019t display the painting</strong><br>' +
        'Still Night uses advanced graphics that this browser doesn\u2019t support yet. ' +
        'Try opening this page in an up-to-date version of Chrome, Edge, Firefox, or Safari.';
    } else if (rendererResult.error === 'shader') {
      canvasPlaceholder.innerHTML =
        '<strong>This device can\u2019t run the full experience</strong><br>' +
        'Still Night needs more graphics power than this device can provide. ' +
        'Try opening this page on a different computer, or closing other tabs and reloading.';
    }
    return;  // bail — nothing else can run without the renderer
  }

  renderer = rendererResult;
  window._renderer = renderer;  // debug access

  // Test draw with minimal render shader — catches GPU failures (context lost,
  // ANGLE crash, Intel attribute binding issues) without waiting for the full
  // render shader to compile. Full shader compiles in background.
  if (!renderer.testDraw()) {
    console.error('[Init] Test draw failed — GPU rejected shader at draw time');
    const container = glCanvas.closest('.canvas-container');
    if (container) container.style.flex = '1';
    canvasPlaceholder.innerHTML = '';
    canvasPlaceholder.classList.add('canvas-error');
    canvasPlaceholder.innerHTML =
      '<strong>This device can\u2019t run the full experience</strong><br>' +
      'Still Night needs more graphics power than this device can provide. ' +
      'Try opening this page on a different computer, or closing other tabs and reloading.';
    renderer = null;
    return;
  }

  _loadTimeline.rendererReady = performance.now();
  renderer.setFlashDecay(0.4);  // 400ms flashlight persistence

  // BFS workers already spawned at module load time (line ~153) — they've been
  // warming up during module evaluation + shader compilation.

  // ── WebGL context lost/restored ──
  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();  // allow restoration
    _contextLost = true;
    console.error('[WebGL] Context lost');

    // 1. Stop render loop
    if (renderer) renderer.stopLoop();

    // 2. Mute audio — GPU is dead but Tone.js keeps playing
    if (!_audioDisabled) {
      try { muteAllRegions(); } catch (_) {}
    }

    // 3. Show error overlay
    const introOverlay = document.getElementById('intro-overlay');
    if (introOverlay) introOverlay.hidden = true;
    canvasPlaceholder.hidden = false;
    canvasPlaceholder.innerHTML = '';
    canvasPlaceholder.classList.add('canvas-error');
    canvasPlaceholder.innerHTML =
      '<strong>The painting lost its connection to the GPU</strong><br>' +
      'This can happen when the device is under heavy load or wakes from sleep. ' +
      'Reloading the page should bring it back.';
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'canvas-retry-btn';
    reloadBtn.textContent = 'Reload';
    reloadBtn.addEventListener('click', () => location.reload());
    canvasPlaceholder.appendChild(reloadBtn);
  });

  // Debug: ?contextLost simulates context loss after 2 seconds
  if (new URLSearchParams(location.search).has('contextLost')) {
    const loseCtx = glCanvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    if (loseCtx) setTimeout(() => loseCtx.loseContext(), 2000);
  }

  glCanvas.addEventListener('webglcontextrestored', () => {
    // Don't auto-reload — let the user decide via the Reload button.
    // Auto-reload can be jarring if the browser restores context quickly.
    _log('[WebGL] Context restored — user can reload via button');
  });

  // ── Touch trail: tapered polyline following cursor/finger ──
  touchTrail.init();

  // ── Ambient edge glow: LED backlight effect behind painting ──
  ambientGlow.init();

  // ── Intro overlay: dismiss on Play + forward mouse to flashlight ──
  const introPlayBtn = document.getElementById('intro-play-btn');
  const introOverlay = document.getElementById('intro-overlay');
  if (introPlayBtn && introOverlay) {
    // Forward mouse movement through the overlay to the flashlight system
    introOverlay.style.pointerEvents = 'auto';
    introOverlay.addEventListener('mousemove', (e) => {
      lastMouseMoveTime = performance.now();
      // If breathing, start fade-out
      if (breathActive && !breathFading) {
        breathFading = true;
        breathFadeStart = performance.now();
      }
      const cr = getCanvasContentRect();
      const normX = (e.clientX - cr.left) / cr.width;
      const normY = (e.clientY - cr.top) / cr.height;
      // Track cursor position continuously (even during bloom) so early Play
      // clicks reveal from the correct position. Flashlight visibility is still
      // gated by introBloomDone in the render loop — this just captures position.
      if (normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1) {
        flashMouseX = normX * glCanvas.width;
        flashMouseY = (1.0 - normY) * glCanvas.height;
        if (introBloomDone) flashMouseOnCanvas = true;
      } else {
        flashMouseOnCanvas = false;
      }
    });
    introOverlay.addEventListener('mouseleave', () => {
      flashMouseOnCanvas = false;
    });

    // Touch equivalent for flashlight during intro
    introOverlay.addEventListener('touchmove', (e) => {
      if (!e.touches.length) return;
      const touch = e.touches[0];
      e.preventDefault();
      lastMouseMoveTime = performance.now();
      if (breathActive && !breathFading) {
        breathFading = true;
        breathFadeStart = performance.now();
      }
      const cr = getCanvasContentRect();
      const normX = (touch.clientX - cr.left) / cr.width;
      const normY = (touch.clientY - cr.top) / cr.height;
      if (normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1) {
        flashMouseX = normX * glCanvas.width;
        flashMouseY = (1.0 - normY) * glCanvas.height;
        if (introBloomDone) flashMouseOnCanvas = true;
      } else {
        flashMouseOnCanvas = false;
      }
    }, { passive: false });

    introPlayBtn.addEventListener('click', () => {
      if (introPlayBtn.disabled) return;
      const _playT0 = performance.now();
      introPlayBtn.disabled = true;
      _playClicked = true;  // gates the bfcache radiant-load trigger
      initAudioOnGesture();  // build + resume AudioContext during reveal animation
      _log(`%c[PlayClick]%c  Sync handler: ${(performance.now() - _playT0).toFixed(0)}ms`, 'color: #f0f; font-weight: bold', 'color: #ccc');
      introOverlay.classList.add('fade-out');
      introOverlay.addEventListener('animationend', () => {
        introOverlay.hidden = true;
        const toolbar = document.getElementById('canvas-toolbar');
        if (toolbar) toolbar.classList.add('visible');
      }, { once: true });
      // Start reveal animation from current cursor position
      introBloomActive = false;
      introSettling = true;
      breathActive = false;
      breathFading = false;
      renderer.setIntroGlow(1.0); // restore in case breathing left it mid-cycle
      renderer.startReveal(flashMouseX, flashMouseY, 1.5, () => {
        // Reveal complete — brightness and tonal bg already eased during reveal.
        // Start the radiant variant download now: network is idle post-load,
        // the mood toggle wasn't usable until this point anyway, and only
        // visitors who pressed Play pay for the 1.1 MB. Decode runs in a
        // worker, so arrival doesn't hitch the live canvas. setTimeout keeps
        // the worker bootstrap (~1-2ms) out of this rAF tick — this callback
        // fires inside the render loop on the reveal handoff frame.
        setTimeout(loadRadiantInBackground, 0);
      });
      // Clear phantom-cursor state before main loop takes over. On touch devices,
      // iOS synthesizes mousemove on Play tap → flashMouseOnCanvas=true lingers
      // at the Play-button position and engages drift + hover orbit on Night Sky.
      // Real touches after this point will re-set it via touchstart.
      flashMouseOnCanvas = false;
      // On touch, snap drift off immediately at Play click — no lingering fade
      // at the stale drag position. Desktop keeps smooth-ease via introSettling
      // because the cursor is still there.
      if (_isTouchDevice) {
        driftEaseOut = 0;
        renderer.setDriftActive(0);
      }
    });
  }

  // ── Page unload: close AudioContext so Chrome releases audio thread resources ──
  // Without this, F5 refresh leaves zombie nodes from the previous session processing
  // in Chrome's audio thread, causing 30-40% idle render capacity instead of 1-3%.
  window.addEventListener('pagehide', () => {
    if (typeof Tone !== 'undefined' && Tone.context) {
      try { Tone.context.close(); } catch (_) {}
    }
    // Terminate BFS workers — prevents thread leaks on navigation/reload
    for (const name in _bfsWorkerPool) {
      if (_bfsWorkerPool[name] && _bfsWorkerPool[name].worker) {
        _bfsWorkerPool[name].worker.terminate();
        _bfsWorkerPool[name].worker = null;
      }
    }
    // Terminate G22 extract worker
    if (_extractWorker) {
      _extractWorker.terminate();
      _extractWorker = null;
    }
    // Terminate in-flight radiant decode worker — same no-leak policy as
    // above, and load-bearing for bfcache: a frozen worker would RESUME its
    // fetch on restore, racing the pageshow handler's fresh attempt into a
    // duplicate 1.1 MB download.
    if (_radiantWorker) {
      _radiantWorker.terminate();
      _radiantWorker = null;
    }
  });

  // ── bfcache restoration: skip intro when page is restored from back/forward cache ──
  // User already saw the intro once — go straight to interactive canvas.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      introBloomActive = false;
      introBloomDone = true;
      introSettling = false;
      introProximity = 0;
      breathActive = false;
      breathFading = false;
      if (introOverlay) introOverlay.hidden = true;
      if (introPlayBtn) introPlayBtn.disabled = false;
      const toolbar = document.getElementById('canvas-toolbar');
      if (toolbar) toolbar.classList.add('visible');
      if (renderer) renderer.endIntroMode();
      // Reset audio init state — AudioContext doesn't survive bfcache but
      // module-scoped flags persist. Without this, next click skips Tone.start()
      // and audio is silently broken (tester bug report April 5).
      resetAudioInit();
      _audioPreBuilt = false;
      // Radiant deferral: the reveal callback never fires on this path
      // (endIntroMode cancels it), and any in-flight attempt was torn down
      // by the pagehide handler (worker terminated), possibly leaving
      // _radiantLoadStarted stuck true — so force a fresh attempt. Gated on
      // _playClicked: a visitor who never pressed Play shouldn't pay for
      // the download just because they bounced off the byline link and came
      // back; for them the (clickable) Vivid pill loads it on demand.
      if (_playClicked && !radiantImageData) {
        _radiantLoadStarted = false;
        loadRadiantInBackground();
      }
    }
  });

  // ── Toolbar buttons ──
  const muteBtn = document.getElementById('mute-btn');
  if (muteBtn) muteBtn.addEventListener('click', toggleMute);

  const aboutBtn = document.getElementById('about-btn');
  if (aboutBtn) aboutBtn.addEventListener('click', openAbout);

  // ── Mode pills: Minor / Major segmented control ──
  const minorBtn = document.getElementById('mode-minor-btn');
  const majorBtn = document.getElementById('mode-major-btn');
  if (minorBtn) minorBtn.addEventListener('click', () => switchMood(false));
  if (majorBtn) majorBtn.addEventListener('click', () => switchMood(true));
  // Reflect initial state (Nocturne on load) + disabled state (pre-Radiant-load)
  _updatePillStates();

  // ── Toolbar width = painting's rendered width (aligns buttons with painting edges) ──
  // Container fills its grid cell; canvas inside uses object-fit: contain, so the
  // painting is letterboxed within the container on viewports whose aspect doesn't
  // match the painting's. Compute the painting's true rendered width from the
  // container's dimensions + the known painting aspect ratio, and push it to the
  // toolbar via the --media-width CSS var.
  // Pure CSS can't express "sibling matches another aspect-ratio-derived width" —
  // ResizeObserver + CSS var is the established pattern for this.
  // ── Toolbar width sync (aligns buttons with painting edges) ──
  // _syncToolbarToPaintingWidth is module-level (defined above) so it's also
  // callable from _afterLoadPoints + the Shadow Spread slider.
  _syncToolbarToPaintingWidth();                          // immediate
  requestAnimationFrame(_syncToolbarToPaintingWidth);     // post-layout fallback
  const _canvasContainerElForRO = document.querySelector('.canvas-container');
  if (_canvasContainerElForRO && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(_syncToolbarToPaintingWidth).observe(_canvasContainerElForRO);
  }

  const aboutCloseBtn = document.getElementById('about-close-btn');
  if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', closeAbout);

  // Flashlight drift defaults
  renderer.setDriftSpeed(0.6);
  renderer.setDriftMouseInfluence(0.5);

  // Live FPS updates from GL renderer
  renderer.setOnFpsUpdate((fps) => {
    if (fpsStatEl) fpsStatEl.textContent = `${fps}`;
    if (_hudFpsEl) _hudFpsEl.textContent = `${fps}`;
  });

  // Extended stats: frame time, render CPU, GPU draw, vertices/sec, dropped frames
  renderer.setOnStatsUpdate((stats) => {
    perfRendererStats(stats);
    if (frameTimeStatEl) frameTimeStatEl.textContent = `${stats.frameTime.toFixed(2)} ms`;
    if (renderTimeStatEl) renderTimeStatEl.textContent = `${stats.renderTime.toFixed(2)} ms`;
    if (gpuTimeStatEl) {
      gpuTimeStatEl.textContent = stats.gpuTime >= 0
        ? `${stats.gpuTime.toFixed(2)} ms`
        : 'N/A';
    }
    if (vtxPerSecStatEl) {
      const mvps = stats.verticesPerSec / 1e6;
      vtxPerSecStatEl.textContent = `${mvps.toFixed(1)} M`;
    }
    if (droppedStatEl) {
      droppedStatEl.textContent = `${stats.droppedFrames}/30`;
    }
  });

  // Copy stats button — scrapes all label/value pairs from the stats grid
  const copyStatsBtn = document.getElementById('copy-stats-btn');
  copyStatsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();  // don't toggle the <details>
    const items = statsGrid.querySelectorAll('.stat-item');
    const data = {};
    items.forEach((item) => {
      const label = item.querySelector('.stat-label')?.textContent?.trim();
      const value = item.querySelector('.stat-value')?.textContent?.trim();
      if (label && value) data[label] = value;
    });
    const json = JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      const orig = copyStatsBtn.textContent;
      copyStatsBtn.textContent = 'Copied!';
      setTimeout(() => { copyStatsBtn.textContent = orig; }, 1000);
    }).catch(() => {});
    _log(`%c[Stats]%c  Copied to clipboard:\n${json}`, 'color: #0ff; font-weight: bold', 'color: #ccc');
  });

  // ── Zoom & Pan ──────────────────────────────────────────────────────────
  // Prevent wheel from scrolling the page when cursor is on the canvas
  glCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('mouseup', (e) => {
    if (mouseDownInPainting) {
      mouseDownInPainting = false;
      // Re-evaluate canvas membership now that drag ended
      const cr = getCanvasContentRect();
      const nx = (e.clientX - cr.left) / cr.width;
      const ny = (e.clientY - cr.top) / cr.height;
      flashMouseOnCanvas = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    }
  });

  // computeContentRect + getCanvasContentRect: moved to module scope (near invalidateContentRect)

  // Convert a client (page) mouse position to [0,1] canvas-normalized coords
  // Reuse object to avoid per-frame allocations (callers destructure immediately)
  const _canvasOut = { sx: 0, sy: 0 };
  function clientToCanvas(clientX, clientY) {
    const cr = getCanvasContentRect();
    _canvasOut.sx = (clientX - cr.left) / cr.width;
    _canvasOut.sy = (clientY - cr.top) / cr.height;
    return _canvasOut;
  }

  // ── Per-vortex indicators ──────────────────────────────────────────────
  // ── Per-vortex control panels (vortex placement mode removed, panels no longer created) ──────────────────────────────────────────
  // Dynamic <details> panels in the side bar for direction (CW/CCW) and strength per vortex.
  // Wrapped in a collapsible group, collapsed by default.
  const vortexGroup = document.createElement('details');
  vortexGroup.className = 'vortex-group-panel';
  vortexGroup.open = false;
  const vortexGroupSummary = document.createElement('summary');
  vortexGroupSummary.textContent = 'Vortices';
  const vortexCopyBtn = document.createElement('button');
  vortexCopyBtn.className = 'panel-copy-btn';
  vortexCopyBtn.textContent = 'Copy';
  vortexCopyBtn.title = 'Copy all vortex parameters to clipboard';
  vortexCopyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const vortices = renderer && renderer.isRunning ? renderer.getVortices() : [];
    const json = JSON.stringify(vortices, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      vortexCopyBtn.textContent = 'Copied!';
      setTimeout(() => { vortexCopyBtn.textContent = 'Copy'; }, 1000);
    }).catch(() => {});
    _log(`%c[Vortices]%c  Copied ${vortices.length} vortices:\n${json}`, 'color: #f80; font-weight: bold', 'color: #ccc');
  });
  vortexGroupSummary.appendChild(vortexCopyBtn);
  vortexGroup.appendChild(vortexGroupSummary);

  // ── Star Play / Stop toggle (same pattern as Cypress) ──
  const starPlayRow = document.createElement('div');
  starPlayRow.className = 'vortex-control-row';
  starPlayRow.style.cssText = 'margin-bottom:8px; display:flex; flex-direction:row; align-items:center; gap:4px; flex-wrap:nowrap; padding:4px 8px;';

  const starPlayBtn = document.createElement('button');
  starPlayBtn.className = 'panel-copy-btn';
  starPlayBtn.textContent = '\u25B6 Play';
  starPlayBtn.style.cssText = 'cursor:pointer; color:#ff0; border-color:#ff0; flex:1; padding:0.15rem 0; margin:0;';

  const starStopBtn = document.createElement('button');
  starStopBtn.className = 'panel-copy-btn';
  starStopBtn.textContent = '\u25A0';
  starStopBtn.style.cssText = 'cursor:pointer; color:#999; border-color:#999; padding:0.15rem 0.4rem; font-size:10px; margin:0;';

  function updateStarPlayStyles() {
    if (starVorticesActive) {
      starPlayBtn.textContent = '\u25B6 Playing';
      starPlayBtn.style.color = '#000';
      starPlayBtn.style.background = '#ff0';
      starPlayBtn.style.borderColor = '#ff0';
    } else {
      starPlayBtn.textContent = '\u25B6 Play';
      starPlayBtn.style.color = '#ff0';
      starPlayBtn.style.background = '';
      starPlayBtn.style.borderColor = '#ff0';
    }
  }

  function starActivateAll() {
    if (starVorticesActive) return;
    activateStarVortices(0.5, 0.5);
    updateStarPlayStyles();
  }

  function starDeactivateAll() {
    if (!starVorticesActive && !_pendingStarReset) return;
    _starPendingDismiss = false;
    _starExprDeferred = false;
    if (_starStrumTimer) { clearTimeout(_starStrumTimer); _starStrumTimer = null; }
    _starRmsSmoothed = 0;
    _starSpeedEnvelope = 0;
  _starGravityEnvelope = 0;
  _starFlashEnvelope = 0;
    _lastStarsFeatures = null;
    for (const t of activationTimers) clearTimeout(t);
    activationTimers = [];
    renderer.clearVortices();
    starVorticesActive = false;
    _holdExpandActive = false;
    _pendingStarReset = true;
    // Stop Stars synth (region 5) — 3s fade-out matches vortex removal
    stopRegion(5);
    updateStarPlayStyles();
  }

  starPlayBtn.addEventListener('click', () => {
    if (starVorticesActive) {
      starDeactivateAll();
    } else if (!_pendingStarReset) {
      starActivateAll();
    }
  });

  starStopBtn.addEventListener('click', () => {
    starDeactivateAll();
  });

  starPlayRow.appendChild(starPlayBtn);
  starPlayRow.appendChild(starStopBtn);
  vortexGroup.appendChild(starPlayRow);

  // Delayed spiral is always active — no toggle needed

  // Absorption threshold slider (global — affects all vortices)
  const absGroup = document.createElement('div');
  absGroup.className = 'vortex-control-row';
  absGroup.style.padding = '4px 8px';
  const absLabelRow = document.createElement('div');
  absLabelRow.className = 'vortex-label-row';
  const absLabel = document.createElement('span');
  absLabel.className = 'vortex-control-label';
  absLabel.textContent = 'Absorption';
  const absValSpan = document.createElement('span');
  absValSpan.className = 'vortex-control-value';
  absValSpan.textContent = '0.00';
  absLabelRow.appendChild(absLabel);
  absLabelRow.appendChild(absValSpan);
  absGroup.appendChild(absLabelRow);
  const absSlider = document.createElement('input');
  absSlider.type = 'range';
  absSlider.min = '0';
  absSlider.max = '1';
  absSlider.step = '0.01';
  absSlider.value = '0';
  absSlider.addEventListener('input', () => {
    const val = parseFloat(absSlider.value);
    renderer.setAbsorptionThreshold(val);
    absValSpan.textContent = val.toFixed(2);
  });
  absGroup.appendChild(absSlider);
  vortexGroup.appendChild(absGroup);

  // Global vortex trail slider (applies to all vortices uniformly)
  const trailGroup = document.createElement('div');
  trailGroup.className = 'vortex-control-row';
  trailGroup.style.padding = '4px 8px';
  const trailLabelRow = document.createElement('div');
  trailLabelRow.className = 'vortex-label-row';
  const trailLabel = document.createElement('span');
  trailLabel.className = 'vortex-control-label';
  trailLabel.textContent = 'Vortex Trail';
  const trailValSpan = document.createElement('span');
  trailValSpan.className = 'vortex-control-value';
  trailValSpan.textContent = '0.95';
  trailLabelRow.appendChild(trailLabel);
  trailLabelRow.appendChild(trailValSpan);
  trailGroup.appendChild(trailLabelRow);
  const trailSlider = document.createElement('input');
  trailSlider.type = 'range';
  trailSlider.min = '0';
  trailSlider.max = '1';
  trailSlider.step = '0.01';
  trailSlider.value = '1.00';
  trailSlider.addEventListener('input', () => {
    const val = parseFloat(trailSlider.value);
    renderer.setGlobalVortexTrail(val);
    trailValSpan.textContent = val.toFixed(2);
  });
  // Fire initial value so vortexTrailGlobal is non-zero before audio starts
  renderer.setGlobalVortexTrail(parseFloat(trailSlider.value));
  trailGroup.appendChild(trailSlider);
  vortexGroup.appendChild(trailGroup);

  // Trail multiplier slider (controls streak elongation for slow particles)
  const streakGroup = document.createElement('div');
  streakGroup.className = 'vortex-control-row';
  streakGroup.style.padding = '4px 8px';
  const streakLabelRow = document.createElement('div');
  streakLabelRow.className = 'vortex-label-row';
  const streakLabel = document.createElement('span');
  streakLabel.className = 'vortex-control-label';
  streakLabel.textContent = 'Trail Multiplier';
  const streakValSpan = document.createElement('span');
  streakValSpan.className = 'vortex-control-value';
  streakValSpan.textContent = '0.20';
  streakLabelRow.appendChild(streakLabel);
  streakLabelRow.appendChild(streakValSpan);
  streakGroup.appendChild(streakLabelRow);
  const streakSlider = document.createElement('input');
  streakSlider.type = 'range';
  streakSlider.min = '0';
  streakSlider.max = '1';
  streakSlider.step = '0.01';
  streakSlider.value = '1.00';
  streakSlider.addEventListener('input', () => {
    const val = parseFloat(streakSlider.value);
    renderer.setTrailLinesAlpha(val);
    streakValSpan.textContent = val.toFixed(2);
  });
  streakGroup.appendChild(streakSlider);
  vortexGroup.appendChild(streakGroup);

  // ── Strum Glow Radius slider ──
  const sgrGroup = document.createElement('div');
  sgrGroup.className = 'vortex-control-row';
  sgrGroup.style.padding = '4px 8px';
  const sgrLabelRow = document.createElement('div');
  sgrLabelRow.className = 'vortex-label-row';
  const sgrLabel = document.createElement('span');
  sgrLabel.className = 'vortex-control-label';
  sgrLabel.textContent = 'Strum Glow Radius';
  const sgrVal = document.createElement('span');
  sgrVal.className = 'vortex-control-value';
  sgrVal.textContent = STARS_MAPPING.strumGlowRadius.toFixed(1);
  sgrLabelRow.appendChild(sgrLabel);
  sgrLabelRow.appendChild(sgrVal);
  sgrGroup.appendChild(sgrLabelRow);
  const sgrSlider = document.createElement('input');
  sgrSlider.type = 'range'; sgrSlider.min = '0'; sgrSlider.max = '5'; sgrSlider.step = '0.1';
  sgrSlider.value = String(STARS_MAPPING.strumGlowRadius);
  sgrSlider.addEventListener('input', () => {
    STARS_MAPPING.strumGlowRadius = parseFloat(sgrSlider.value);
    sgrVal.textContent = STARS_MAPPING.strumGlowRadius.toFixed(1);
  });
  sgrGroup.appendChild(sgrSlider);
  vortexGroup.appendChild(sgrGroup);

  // ── Strum Glow Intensity slider ──
  const sgiGroup = document.createElement('div');
  sgiGroup.className = 'vortex-control-row';
  sgiGroup.style.padding = '4px 8px';
  const sgiLabelRow = document.createElement('div');
  sgiLabelRow.className = 'vortex-label-row';
  const sgiLabel = document.createElement('span');
  sgiLabel.className = 'vortex-control-label';
  sgiLabel.textContent = 'Strum Glow Intensity';
  const sgiVal = document.createElement('span');
  sgiVal.className = 'vortex-control-value';
  sgiVal.textContent = '0.3';
  sgiLabelRow.appendChild(sgiLabel);
  sgiLabelRow.appendChild(sgiVal);
  sgiGroup.appendChild(sgiLabelRow);
  const sgiSlider = document.createElement('input');
  sgiSlider.type = 'range'; sgiSlider.min = '0'; sgiSlider.max = '3'; sgiSlider.step = '0.1';
  sgiSlider.value = '0.3';
  sgiSlider.addEventListener('input', () => {
    STARS_MAPPING.strumGlowIntensity = parseFloat(sgiSlider.value);
    sgiVal.textContent = STARS_MAPPING.strumGlowIntensity.toFixed(1);
  });
  sgiGroup.appendChild(sgiSlider);
  vortexGroup.appendChild(sgiGroup);

  // ── Stars category — wraps Vortices, Tone, Star Glow ──
  const starsGroup = document.createElement('details');
  starsGroup.className = 'vortex-group-panel';
  starsGroup.open = false;
  const starsGroupSummary = document.createElement('summary');
  starsGroupSummary.textContent = 'Stars';
  starsGroup.appendChild(starsGroupSummary);
  starsGroup.appendChild(vortexGroup);

  // ── Celestial Strings Tone panel (mixing engineer controls) ──
  const tonePanel = document.createElement('details');
  tonePanel.className = 'vortex-group-panel';
  tonePanel.open = false;
  const toneSummary = document.createElement('summary');
  toneSummary.textContent = 'Tone';
  const toneCopyBtn = document.createElement('button');
  toneCopyBtn.className = 'panel-copy-btn';
  toneCopyBtn.textContent = 'Copy';
  toneCopyBtn.title = 'Copy tone params to clipboard';
  toneCopyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const diag = getCelestialStringsDiag();
    const json = diag ? JSON.stringify(diag, null, 2) : '(no data)';
    navigator.clipboard.writeText(json).then(() => {
      toneCopyBtn.textContent = 'Copied!';
      setTimeout(() => { toneCopyBtn.textContent = 'Copy'; }, 1000);
    });
  });
  toneSummary.appendChild(toneCopyBtn);
  tonePanel.appendChild(toneSummary);
  const toneContent = document.createElement('div');
  toneContent.className = 'audio-tuning-content';

  const csSliders = [
    { label: 'Noise Mix',     key: 'noiseMix',         min: 0,    max: 1,    step: 0.05, initial: 0.2,  fmt: v => v.toFixed(2) },
    { label: 'Pad Mix',       key: 'padMix',           min: 0,    max: 1,    step: 0.05, initial: 0.75, fmt: v => v.toFixed(2) },
    { label: 'String Vol',    key: 'stringVolume',     min: 0,    max: 1,    step: 0.05, initial: 1,    fmt: v => v.toFixed(2) },
    { label: 'Brightness',    key: 'stringBrightness', min: -1,   max: 1,    step: 0.05, initial: 0,    fmt: v => v.toFixed(2) },
    { label: 'Gate Floor',    key: 'gateFloor',        min: 0.01, max: 0.5,  step: 0.01, initial: 0.10, fmt: v => v.toFixed(2) },
    { label: 'Reverb Mix',    key: 'reverbMix',        min: 0,    max: 0.5,  step: 0.01, initial: 0.25, fmt: v => v.toFixed(2) },
    { label: 'Reverb Size',   key: 'reverbSize',       min: 0.1,  max: 0.99, step: 0.01, initial: 0.85, fmt: v => v.toFixed(2) },
    { label: 'Phaser Wet',    key: 'phaserWet',        min: 0,    max: 0.8,  step: 0.01, initial: 0.4,  fmt: v => v.toFixed(2) },
    { label: 'Delay Mix',     key: 'delayMix',         min: 0,    max: 0.3,  step: 0.01, initial: 0.15, fmt: v => v.toFixed(2) },
    { label: 'Strum Intensity', key: 'strumIntensity', min: 0,    max: 1,    step: 0.05, initial: 0.9,  fmt: v => v.toFixed(2) },
    { label: 'Strum Decay',   key: 'strumDecay',       min: 0.5,  max: 10,   step: 0.1,  initial: 2.5,  fmt: v => v.toFixed(1) },
  ];
  const _toneSliderRefs = {};
  for (const def of csSliders) {
    const { group, slider, valSpan, deltaSpan } = makeSlider(
      def.label, def.min, def.max, def.step, def.initial, def.fmt,
      v => { setCelestialStringsParam(def.key, v); }
    );
    toneContent.appendChild(group);
    _toneSliderRefs[def.key] = { slider, valSpan, deltaSpan, fmt: def.fmt };
  }

  // Store refs for per-frame delta update
  window._toneSliderRefs = _toneSliderRefs;

  tonePanel.appendChild(toneContent);
  starsGroup.appendChild(tonePanel);

  // Insert before the stats <details> panel
  const controlPanel = document.querySelector('.control-panel');
  document.querySelector('.app-layout').classList.remove('panel-visible');
  controlPanel.insertBefore(starsGroup, statsPanel);

  // Mute button moved to canvas toolbar (#mute-btn)

  // ── Horizon panel (merged Sky Gust + Flow Tuning + live meters) ──
  const horizonPanel = document.createElement('details');
  horizonPanel.className = 'vortex-group-panel';
  horizonPanel.open = false;

  const horizonSummary = document.createElement('summary');
  horizonSummary.textContent = 'Horizon';
  const horizonCopyBtn = document.createElement('button');
  horizonCopyBtn.className = 'panel-copy-btn';
  horizonCopyBtn.textContent = 'Copy';
  horizonCopyBtn.title = 'Copy all Horizon values to clipboard';
  horizonCopyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const visual = {
      flowSpeed: renderer.getFlowSpeed(),
      flowDriftFrac: renderer.getFlowDriftFrac(),
      flowCyclePeriod: renderer.getFlowCyclePeriod(),
      flowThreshold: renderer.getFlowThreshold(),
      flowMaxDrift: renderer.getFlowMaxDrift(),
      flowEdgeDepth: renderer.getFlowEdgeDepth(),
      flowSpeedFloor: renderer.getFlowSpeedFloor(),
      gustAmplitude: renderer.getGustAmplitude(),
      eddyContrast: renderer.getEddyContrast(),
      canvasDeformAmp: renderer.getCanvasDeformAmp(),
      audioModLevel: _hzSmoothFlow.rms,
    };
    const audio = getHorizonAudioSnapshot();
    const vals = { visual, audio };
    navigator.clipboard.writeText(JSON.stringify(vals, null, 2)).then(() => {
      horizonCopyBtn.textContent = 'Copied!';
      setTimeout(() => { horizonCopyBtn.textContent = 'Copy'; }, 1000);
    });
  });
  horizonSummary.appendChild(horizonCopyBtn);
  horizonPanel.appendChild(horizonSummary);

  const horizonContent = document.createElement('div');
  horizonContent.className = 'audio-tuning-content';

  // ── Playback presets (hands-free looping for slider tuning) ──
  const playRow = document.createElement('div');
  playRow.className = 'vortex-control-row';
  playRow.style.cssText = 'margin-bottom:8px; display:flex; flex-direction:row; align-items:center; gap:4px; flex-wrap:nowrap;';

  const presets = [
    { label: 'Sustain', intensity: 0,   color: '#6c6' },
    { label: 'Mid',     intensity: 0.5, color: '#cc6' },
    { label: 'Peak',    intensity: 1.0, color: '#c66' },
  ];
  const presetBtns = [];
  let _activePresetIdx = -1; // -1 = stopped

  function activateVisualLock() {
    _regionLockId = 4;
    _flowClickHeld = true;
    renderer.setFlowActive(true);
    const cs = regionColorState[4];
    if (cs) {
      cs.state = 'on';
      cs.targetIntensity = 1.0;
      cs.radiusNorm = 1.0;
      if (cs.clickX === undefined) { cs.clickX = 0.5; cs.clickY = 0.5; }
    }
  }

  function clearVisualLock() {
    _regionLockId = 0;
    _flowClickHeld = false;
    if (!_isHorizonLooping()) renderer.setFlowActive(false);
    const cs = regionColorState[4];
    if (cs) { cs.state = 'fading'; cs.targetIntensity = 0; }
  }

  function updatePresetStyles() {
    presetBtns.forEach((btn, i) => {
      const p = presets[i];
      if (i === _activePresetIdx) {
        btn.style.color = '#000';
        btn.style.background = p.color;
        btn.style.borderColor = p.color;
      } else {
        btn.style.color = p.color;
        btn.style.background = '';
        btn.style.borderColor = p.color;
      }
    });
  }

  function resetPresetUI() {
    _activePresetIdx = -1;
    _horizonAutoPlay = false;
    updatePresetStyles();
  }
  _horizonPlayBtn = { reset: resetPresetUI };

  // Stop button
  const stopBtn = document.createElement('button');
  stopBtn.className = 'panel-copy-btn';
  stopBtn.textContent = '\u25A0';
  stopBtn.style.cssText = 'cursor:pointer; color:#999; border-color:#999; padding:0.15rem 0.4rem; font-size:10px; margin:0;';
  stopBtn.addEventListener('click', () => {
    if (!_horizonAutoPlay) return;
    _horizonAutoPlay = false;
    _activePresetIdx = -1;
    stopRegion(4);
    clearVisualLock();
    updatePresetStyles();
  });

  for (let i = 0; i < presets.length; i++) {
    const p = presets[i];
    const btn = document.createElement('button');
    btn.className = 'panel-copy-btn';
    btn.textContent = p.label;
    btn.style.cssText = `cursor:pointer; color:${p.color}; border-color:${p.color}; flex:1; padding:0.15rem 0; margin:0;`;
    presetBtns.push(btn);

    btn.addEventListener('click', async () => {
      if (_horizonAutoPlay && _activePresetIdx === i) {
        // Clicking active preset → stop
        _horizonAutoPlay = false;
        _activePresetIdx = -1;
        stopRegion(4);
        clearVisualLock();
        updatePresetStyles();
        return;
      }

      if (_horizonAutoPlay) {
        // Already playing → switch intensity without restarting
        setRegionIntensity(4, p.intensity);
        _activePresetIdx = i;
        updatePresetStyles();
        return;
      }

      // Start fresh
      const started = await playRegion(4, p.intensity);
      if (!started) return;
      _horizonAutoPlay = true;
      _activePresetIdx = i;
      activateVisualLock();
      updatePresetStyles();
    });
  }

  presetBtns.forEach(btn => playRow.appendChild(btn));
  playRow.appendChild(stopBtn);
  horizonContent.appendChild(playRow);

  // ── Harp Core sliders (shared controls for Wind Harp V3) ──
  const whSlidersDiv = document.createElement('div');

  const whSliderHeader = document.createElement('div');
  whSliderHeader.className = 'audio-meter-label';
  whSliderHeader.style.cssText = 'font-weight:bold; margin:6px 0 2px; color:#0cf; width:auto; white-space:nowrap;';
  whSliderHeader.textContent = '— Harp Core —';
  whSlidersDiv.appendChild(whSliderHeader);

  const whSliderDefs = [
    { label: 'Filter Depth', min: 0, max: 1.0, step: 0.01, initial: 0.60,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('autoFilterOctaves', v * 5) }, // 0→5 octaves
    { label: 'Resonance', min: 0, max: 1.0, step: 0.01, initial: 0.30,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('phaserMaxWet', v * 0.7) }, // 0→0.7
    { label: 'Tremolo Rate', min: 0.1, max: 0.5, step: 0.01, initial: 0.25,
      fmt: v => v.toFixed(2) + ' Hz',
      onChange: v => setWindHarpParam('tremoloRate', v) },
    { label: 'Tremolo Depth', min: 0, max: 1.0, step: 0.01, initial: 0.60,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('tremoloMaxDepth', v) },
    { label: 'Delay Time', min: 0.1, max: 0.8, step: 0.01, initial: 0.375,
      fmt: v => (v * 1000).toFixed(0) + 'ms',
      onChange: v => setWindHarpParam('delayTime', v) },
    { label: 'Delay Feedback', min: 0, max: 0.8, step: 0.01, initial: 0.35,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('delayFeedback', v) },
  ];
  // Track refs for evolution-modulated sliders (readouts update live)
  const _whSliderRefs = [];
  for (const def of whSliderDefs) {
    const result = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    _whSliderRefs.push({ ...result, fmt: def.fmt });
    whSlidersDiv.appendChild(result.group);
  }
  // Indices: 1=Resonance (×lfo), 3=Tremolo Depth (×lfo)
  const _modResonanceRef = _whSliderRefs[1];
  const _modTremoloDepthRef = _whSliderRefs[3];
  horizonContent.appendChild(whSlidersDiv);

  // ── Wind Harp V3 sliders ──
  const whV3SlidersDiv = document.createElement('div');

  // — Pluck group —
  const v3PluckHeader = document.createElement('div');
  v3PluckHeader.className = 'audio-meter-label';
  v3PluckHeader.style.cssText = 'font-weight:bold; margin:6px 0 2px; color:#f7c; width:auto; white-space:nowrap;';
  v3PluckHeader.textContent = '— Pluck —';
  whV3SlidersDiv.appendChild(v3PluckHeader);

  const v3PluckDefs = [
    { label: 'Strum Intensity', min: 0, max: 1, step: 0.05, initial: 0.8,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('v3StrumIntensity', v) },
    { label: 'Strum Decay', min: 1, max: 8, step: 0.5, initial: 3.0,
      fmt: v => v <= 2 ? 'Slow' : v >= 7 ? 'Fast' : v.toFixed(1),
      onChange: v => setWindHarpParam('v3StrumDecay', v) },
    { label: 'Gate Floor', min: 0, max: 0.3, step: 0.01, initial: 0.05,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('v3GateFloor', v) },
  ];
  for (const def of v3PluckDefs) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    whV3SlidersDiv.appendChild(group);
  }

  // — Space group —
  const v3SpaceHeader = document.createElement('div');
  v3SpaceHeader.className = 'audio-meter-label';
  v3SpaceHeader.style.cssText = 'font-weight:bold; margin:6px 0 2px; color:#7cf; width:auto; white-space:nowrap;';
  v3SpaceHeader.textContent = '— Space (Y = intimate / expansive) —';
  whV3SlidersDiv.appendChild(v3SpaceHeader);

  const v3SpaceDefs = [
    // Delay Time & Feedback are in the Harp Core sliders — no duplicates
    { label: 'Reverb Mix (center)', min: 0, max: 1, step: 0.05, initial: 0.35,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('v3ReverbMix', v) },
    { label: 'Reverb Size (center)', min: 0, max: 1, step: 0.05, initial: 0.75,
      fmt: v => v < 0.3 ? 'Small' : v > 0.8 ? 'Hall' : (v * 100).toFixed(0) + '%',
      onChange: v => setWindHarpParam('v3ReverbSize', v) },
  ];
  for (const def of v3SpaceDefs) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    whV3SlidersDiv.appendChild(group);
  }

  // — Tone group —
  const v3ToneHeader = document.createElement('div');
  v3ToneHeader.className = 'audio-meter-label';
  v3ToneHeader.style.cssText = 'font-weight:bold; margin:6px 0 2px; color:#9e9; width:auto; white-space:nowrap;';
  v3ToneHeader.textContent = '— Tone —';
  whV3SlidersDiv.appendChild(v3ToneHeader);

  const _noiseMixFmt = v => (v * 100).toFixed(0) + '%';
  const v3ToneDefs = [
    { label: 'Pad Mix', min: -24, max: 6, step: 1, initial: 0,
      fmt: v => (v > 0 ? '+' : '') + v.toFixed(0) + ' dB',
      onChange: v => setWindHarpParam('v3PadMix', v) },
    { label: 'Harp Volume', min: -24, max: 6, step: 1, initial: 0,
      fmt: v => (v > 0 ? '+' : '') + v.toFixed(0) + ' dB',
      onChange: v => setWindHarpParam('v3HarpVolume', v) },
    { label: 'Harp Brightness', min: -1, max: 1, step: 0.05, initial: 0,
      fmt: v => v < -0.02 ? 'Dark ' + (v * 100).toFixed(0) + '%'
           : v > 0.02 ? 'Bright +' + (v * 100).toFixed(0) + '%'
           : 'Neutral',
      onChange: v => setWindHarpParam('v3HarpBrightness', v) },
    { label: 'Noise Mix', min: 0, max: 1, step: 0.05, initial: 0.66,
      fmt: _noiseMixFmt,
      onChange: v => setWindHarpParam('v3NoiseMix', v) },
  ];
  let _modNoiseMixRef = null;
  for (const def of v3ToneDefs) {
    const result = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    if (def.label === 'Noise Mix') _modNoiseMixRef = { ...result, fmt: def.fmt };
    whV3SlidersDiv.appendChild(result.group);
  }

  horizonContent.appendChild(whV3SlidersDiv);

  // ── Live readout + delta for evolution-modulated audio sliders ──
  // Same pattern as Sky Gust / Flow visual deltas: show effective value + colored ±delta.
  // Modulated sliders: Resonance (×lfo), Tremolo Depth (×lfo), Noise Mix (×secondary)
  function _updateModulatedAudioSlider(ref, multiplier) {
    const sliderVal = parseFloat(ref.slider.value);
    const effective = sliderVal * multiplier;
    ref.valSpan.textContent = ref.fmt(effective);
    // Delta: difference between effective and slider-set value
    const delta = effective - sliderVal;
    if (Math.abs(delta) > 0.005) {
      const pct = sliderVal > 0 ? ((delta / sliderVal) * 100).toFixed(0) : '0';
      ref.deltaSpan.textContent = `${pct}%`;
      ref.deltaSpan.style.color = '#ff4c4c';   // always red — evolution scales down
    } else {
      ref.deltaSpan.textContent = '';
    }
  }

  setInterval(() => {
    const ev = getHarpEvolutionScales();
    if (!ev) return;

    _updateModulatedAudioSlider(_modResonanceRef, ev.lfo);
    _updateModulatedAudioSlider(_modTremoloDepthRef, ev.lfo);

    if (_modNoiseMixRef) {
      _updateModulatedAudioSlider(_modNoiseMixRef, ev.secondary);
    }
  }, 100);

  // Audio-modulated slider labels for Horizon (flow only — sky gust moved to Night Sky)
  const _hzModulatedLabels = new Set([
    'Flow Speed', 'Drift Fraction', 'Gust Intensity', 'Eddy Contrast', 'Flow Trail', 'Canvas Deform',
  ]);

  // ── Flow section ──
  const flowHeader = document.createElement('div');
  flowHeader.className = 'audio-meter-label';
  flowHeader.style.cssText = 'font-weight:bold; margin:10px 0 2px; color:#3cb8ff;';
  flowHeader.textContent = '— Flow —';
  horizonContent.appendChild(flowHeader);

  const flowSliders = [
    { label: 'Flow Speed', min: 0, max: 0.20, step: 0.005, initial: 0,
      fmt: v => v.toFixed(3),
      onChange: v => { _flowSpeedBase = v; if (renderer) renderer.setFlowSpeed(v); } },
    { label: 'Drift Fraction', min: 0.30, max: 1.0, step: 0.05, initial: 0.85,
      fmt: v => v.toFixed(2),
      onChange: v => { _flowDriftFracBase = v; if (renderer) renderer.setFlowDriftFrac(v); } },
    { label: 'Cycle Period', min: 1.0, max: 15.0, step: 0.5, initial: 1.0,
      fmt: v => `${v.toFixed(1)}s`,
      onChange: v => { if (renderer) renderer.setFlowCyclePeriod(v); } },
    { label: 'Coherence Gate', min: 0.01, max: 0.50, step: 0.01, initial: 0.25,
      fmt: v => v.toFixed(2),
      onChange: v => { if (renderer) renderer.setFlowThreshold(v); } },
    { label: 'Spring K', min: 0.5, max: 10.0, step: 0.5, initial: 4.0,
      fmt: v => v.toFixed(1),
      onChange: v => { if (renderer) renderer.setSimSpringK(v); } },
    { label: 'Max Drift', min: 0.001, max: 0.100, step: 0.001, initial: 0.020,
      fmt: v => (v * 100).toFixed(1) + '%',
      onChange: v => { if (renderer) renderer.setFlowMaxDrift(v); } },
    { label: 'Edge Depth', min: 1, max: 100, step: 1, initial: 45,
      fmt: v => `${v.toFixed(0)}px`,
      onChange: v => { if (renderer) renderer.setFlowEdgeDepth(v); } },
    { label: 'Speed Floor', min: 0.0, max: 1.0, step: 0.05, initial: 0.10,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { if (renderer) renderer.setFlowSpeedFloor(v); } },
    { label: 'Gust Intensity', min: 0.0, max: 1.0, step: 0.05, initial: 0.50,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _gustAmpBase = v; if (renderer) renderer.setGustAmplitude(v); } },
    { label: 'Eddy Contrast', min: 0.0, max: 1.0, step: 0.05, initial: 0.15,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _eddyContrastBase = v; if (renderer) renderer.setEddyContrast(v); } },
    { label: 'Canvas Deform', min: 0.0, max: 0.02, step: 0.001, initial: 0.020,
      fmt: v => v.toFixed(3),
      onChange: v => { _canvasDeformBase = v; if (renderer) renderer.setCanvasDeformAmp(v); } },
    { label: 'Flow Trail', min: 0.0, max: 0.90, step: 0.005, initial: 0.70,
      fmt: v => `${(v * 100).toFixed(1)}%`,
      onChange: v => { _swirlTrailBase = v; if (renderer) renderer.setSwirlTrailPersist(v); } },
    { label: 'Cursor Radius', min: 0.01, max: 0.50, step: 0.01, initial: 0.08,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _flowCursorRadiusBase = v; _flowCursorRadiusEased = v; } },
  ];
  for (const def of flowSliders) {
    const { group, slider, valSpan, deltaSpan } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    horizonContent.appendChild(group);
    if (_hzModulatedLabels.has(def.label)) {
      _hzSliders[def.label] = { slider, valSpan, deltaSpan, fmt: def.fmt, initial: def.initial };
    }
  }

  horizonPanel.appendChild(horizonContent);
  controlPanel.insertBefore(horizonPanel, starsGroup);

  // ── Visual Polish panel ──
  const polishPanel = document.createElement('details');
  polishPanel.className = 'vortex-group-panel';
  polishPanel.open = false;

  const polishSummary = document.createElement('summary');
  polishSummary.textContent = 'Visual Polish';
  const polishCopyBtn = document.createElement('button');
  polishCopyBtn.className = 'panel-copy-btn';
  polishCopyBtn.textContent = 'Copy';
  polishCopyBtn.title = 'Copy visual polish values to clipboard';
  polishCopyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const vals = {
      particleDim: renderer.getBaseAlpha(),
      shadowOpacity: renderer.getShadowOpacity(),
      shadowY: renderer.getShadowOffset()[1],
      shadowSpread: renderer.getShadowSpread(),
    };
    navigator.clipboard.writeText(JSON.stringify(vals, null, 2)).then(() => {
      polishCopyBtn.textContent = 'Copied!';
      setTimeout(() => { polishCopyBtn.textContent = 'Copy'; }, 1000);
    });
  });
  polishSummary.appendChild(polishCopyBtn);
  polishPanel.appendChild(polishSummary);

  const polishContent = document.createElement('div');
  polishContent.className = 'audio-tuning-content';

  // Particle Dim slider
  const { group: dimGroup } = makeSlider('Particle Dim', 0, 1.0, 0.01, 1.0, v => v.toFixed(2), v => {
    renderer.setBaseAlpha(v);
  });
  polishContent.appendChild(dimGroup);

  // Intro Dance slider (1.0 = normal dance ~1px, 0.5 = ~0.5px, etc.)
  const { group: introDanceGroup } = makeSlider('Intro Dance', 0, 5.0, 0.01, 0.50, v => v.toFixed(2) + 'px', v => {
    renderer.setIntroDanceScale(0.0005 * v);
  });
  polishContent.appendChild(introDanceGroup);

  // Dropshadow sub-heading
  const shadowHeading = document.createElement('div');
  shadowHeading.style.cssText = 'font-size:0.7rem;text-transform:uppercase;letter-spacing:0.06em;color:#666;margin-top:0.5rem;margin-bottom:0.25rem;';
  shadowHeading.textContent = 'Dropshadow';
  polishContent.appendChild(shadowHeading);

  const shadowSliders = [
    { label: 'Opacity', min: 0, max: 1.0, step: 0.01, initial: 0, fmt: v => v.toFixed(2),
      onChange: v => renderer.setShadowOpacity(v) },
    { label: 'Offset Y', min: -20, max: 0, step: 0.5, initial: -3.0, fmt: v => v.toFixed(1),
      onChange: v => renderer.setShadowOffset(0, v) },
    { label: 'Spread', min: 0.1, max: 5.0, step: 0.1, initial: 0.5, fmt: v => v.toFixed(1),
      onChange: v => {
        renderer.setShadowSpread(v);
        // Shadow spread changes paintingMargin → painting's visible width changes
        // → resync toolbar so buttons stay at painting edges.
        if (typeof _syncToolbarToPaintingWidth === 'function') _syncToolbarToPaintingWidth();
      } },
  ];

  for (const def of shadowSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    polishContent.appendChild(group);
  }
  polishPanel.appendChild(polishContent);
  controlPanel.insertBefore(polishPanel, starsGroup);

  // ── Cypress Sway panel ──
  const cypressPanel = document.createElement('details');
  cypressPanel.className = 'vortex-group-panel';
  cypressPanel.open = false;

  const cypressSummary = document.createElement('summary');
  cypressSummary.textContent = 'Cypress Sway';
  const cypressCopyBtn = document.createElement('button');
  cypressCopyBtn.className = 'panel-copy-btn';
  cypressCopyBtn.textContent = 'Copy';
  cypressCopyBtn.title = 'Copy cypress sway config';
  cypressCopyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const vals = {
      cypressSwayAmp: renderer.getCypressSwayAmp(),
      cypressMaxDrift: renderer.getCypressMaxDrift(),
      cypressTopY: renderer.getCypressTopY(),
      cypressBaseY: renderer.getCypressBaseY(),
      cypressBaseRatio: renderer.getCypressBaseRatio(),
      cypressCrossSway: renderer.getCypressCrossSway(),
      cypressSwayAngle: renderer.getCypressSwayAngle(),
      cypressTrailPersist: renderer.getCypressTrailPersist(),
      cypressBreathPeriod: renderer.getCypressBreathPeriod(),
      cypressEdgeDepth: renderer.getCypressEdgeDepth(),
      cypressRimWidth: renderer.getCypressRimWidth(),
      cypressFlowCyclePeriod: renderer.getCypressFlowCyclePeriod(),
      cypressFlowDriftFrac: renderer.getCypressFlowDriftFrac(),
      cypressFlowMaxDrift: renderer.getCypressFlowMaxDrift(),
      cypressFlowGustAmp: renderer.getCypressFlowGustAmp(),
      cypressCanopyGlow: renderer.getCypressCanopyGlow(),
      cypressLeafFlash: renderer.getCypressLeafFlash(),
      cypressRimGlow: renderer.getCypressRimGlow(),
    };
    navigator.clipboard.writeText(JSON.stringify(vals, null, 2)).then(() => {
      cypressCopyBtn.textContent = 'Copied!';
      setTimeout(() => { cypressCopyBtn.textContent = 'Copy'; }, 1000);
    });
  });
  cypressSummary.appendChild(cypressCopyBtn);
  cypressPanel.appendChild(cypressSummary);

  const cypressContent = document.createElement('div');
  cypressContent.className = 'audio-tuning-content';

  // ── Play / Stop toggle for hands-free tuning ──
  let _cypressAutoPlay = false;
  const cypressPlayRow = document.createElement('div');
  cypressPlayRow.className = 'vortex-control-row';
  cypressPlayRow.style.cssText = 'margin-bottom:8px; display:flex; flex-direction:row; align-items:center; gap:4px; flex-wrap:nowrap;';

  const cypressPlayBtn = document.createElement('button');
  cypressPlayBtn.className = 'panel-copy-btn';
  cypressPlayBtn.textContent = '\u25B6 Play';
  cypressPlayBtn.style.cssText = 'cursor:pointer; color:#6c6; border-color:#6c6; flex:1; padding:0.15rem 0; margin:0;';

  const cypressStopBtn = document.createElement('button');
  cypressStopBtn.className = 'panel-copy-btn';
  cypressStopBtn.textContent = '\u25A0';
  cypressStopBtn.style.cssText = 'cursor:pointer; color:#999; border-color:#999; padding:0.15rem 0.4rem; font-size:10px; margin:0;';

  function cypressActivateVisual() {
    const cs = regionColorState[1];
    if (cs) {
      cs.state = 'on';
      cs.targetIntensity = 1.0;
      cs.radiusNorm = 1.0;
      if (cs.clickX === undefined) { cs.clickX = 0.3; cs.clickY = 0.5; }
    }
  }

  function cypressClearVisual() {
    const cs = regionColorState[1];
    if (cs) { cs.state = 'fading'; cs.targetIntensity = 0; }
  }

  function updateCypressPlayStyles() {
    if (_cypressAutoPlay) {
      cypressPlayBtn.textContent = '\u25B6 Playing';
      cypressPlayBtn.style.color = '#000';
      cypressPlayBtn.style.background = '#6c6';
      cypressPlayBtn.style.borderColor = '#6c6';
    } else {
      cypressPlayBtn.textContent = '\u25B6 Play';
      cypressPlayBtn.style.color = '#6c6';
      cypressPlayBtn.style.background = '';
      cypressPlayBtn.style.borderColor = '#6c6';
    }
  }

  cypressPlayBtn.addEventListener('click', async () => {
    if (_cypressAutoPlay) {
      // Toggle off
      _cypressAutoPlay = false;
      stopRegion(1);
      cypressClearVisual();
      updateCypressPlayStyles();
      return;
    }
    const started = await playRegion(1, 0);
    if (!started) return;
    _cypressAutoPlay = true;
    cypressActivateVisual();
    updateCypressPlayStyles();
  });

  cypressStopBtn.addEventListener('click', () => {
    if (!_cypressAutoPlay) return;
    _cypressAutoPlay = false;
    stopRegion(1);
    cypressClearVisual();
    updateCypressPlayStyles();
  });

  cypressPlayRow.appendChild(cypressPlayBtn);
  cypressPlayRow.appendChild(cypressStopBtn);
  cypressContent.appendChild(cypressPlayRow);

  const cypressSliders = [
    { label: 'Sway Intensity', min: 0, max: 3.0, step: 0.05, initial: 1.5,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _cySwayBase = v; renderer.setCypressSwayAmp(v); } },
    { label: 'Sway Distance', min: 0, max: 0.024, step: 0.001, initial: 0.008,
      fmt: v => `${(v * 1000).toFixed(1)}px`,
      onChange: v => { _cyDistBase = v; renderer.setCypressMaxDrift(v); } },
    { label: 'Top Y', min: 0, max: 0.5, step: 0.01, initial: 0.25,
      fmt: v => v.toFixed(2),
      onChange: v => renderer.setCypressTopY(v) },
    { label: 'Base Y', min: 0.5, max: 1.0, step: 0.01, initial: 1.0,
      fmt: v => v.toFixed(2),
      onChange: v => renderer.setCypressBaseY(v) },
    { label: 'Base Ratio', min: 0, max: 0.5, step: 0.01, initial: 0.15,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => renderer.setCypressBaseRatio(v) },
    { label: 'Cross Sway', min: 0, max: 1.0, step: 0.05, initial: 0.6,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _cyCrossBase = v; renderer.setCypressCrossSway(v); } },
    { label: 'Sway Angle', min: 0, max: 1.0, step: 0.05, initial: 0.5,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => renderer.setCypressSwayAngle(v) },
    { label: 'Trail Persist', min: 0, max: 0.95, step: 0.005, initial: 0.85,
      fmt: v => `${(v * 100).toFixed(1)}%`,
      onChange: v => { _cyTrailBase = v; renderer.setCypressTrailPersist(v); } },
    { label: 'Breath Period', min: 5, max: 40, step: 1, initial: 8,
      fmt: v => `${v.toFixed(0)}s`,
      onChange: v => { _cyBreathBase = v; renderer.setCypressBreathPeriod(v); } },
    { label: 'Edge Depth', min: 5, max: 80, step: 1, initial: 8,
      fmt: v => `${v.toFixed(0)}px`,
      onChange: v => renderer.setCypressEdgeDepth(v) },
    { label: 'Rim Width', min: 5, max: 80, step: 1, initial: 20,
      fmt: v => `${v.toFixed(0)}px`,
      onChange: v => renderer.setCypressRimWidth(v) },
    { label: 'Flow Cycle', min: 1, max: 15, step: 0.5, initial: 1,
      fmt: v => `${v.toFixed(1)}s`,
      onChange: v => renderer.setCypressFlowCyclePeriod(v) },
    { label: 'Flow Drift Frac', min: 0.1, max: 0.9, step: 0.05, initial: 0.90,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _cyFlowDriftFracBase = v; renderer.setCypressFlowDriftFrac(v); } },
    { label: 'Flow Max Drift', min: 0.001, max: 0.050, step: 0.001, initial: 0.015,
      fmt: v => (v * 100).toFixed(1) + '%',
      onChange: v => { _cyFlowDriftBase = v; renderer.setCypressFlowMaxDrift(v); } },
    { label: 'Flow Gust', min: 0, max: 1.0, step: 0.05, initial: 0.50,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _cyFlowGustBase = v; renderer.setCypressFlowGustAmp(v); } },
    { label: 'Canopy Glow', min: 0, max: 1.0, step: 0.05, initial: 0.25,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _cyCanopyGlowBase = v; renderer.setCypressCanopyGlow(v); } },
    { label: 'Leaf Flash', min: 0, max: 1.0, step: 0.05, initial: 0.2,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _cyLeafFlashBase = v; renderer.setCypressLeafFlash(v); } },
    { label: 'Rim Glow', min: 0, max: 1.0, step: 0.05, initial: 0.3,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _cyRimGlowBase = v; renderer.setCypressRimGlow(v); } },
  ];

  // Audio-modulated slider labels — these get captured for per-frame animation
  const _cyModulatedLabels = new Set([
    'Sway Intensity', 'Sway Distance', 'Cross Sway', 'Trail Persist',
    'Flow Max Drift', 'Flow Gust', 'Canopy Glow', 'Rim Glow',
    'Leaf Flash', 'Breath Period', 'Flow Drift Frac',
  ]);
  for (const def of cypressSliders) {
    const { group, slider, valSpan, deltaSpan } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    cypressContent.appendChild(group);
    if (_cyModulatedLabels.has(def.label)) {
      _cySliders[def.label] = { slider, valSpan, deltaSpan, fmt: def.fmt, initial: def.initial };
    }
  }

  // ── Living Wood Audio sliders ──
  const lwHeader = document.createElement('div');
  lwHeader.style.cssText = 'color: #6c6; font-size: 11px; margin: 8px 0 4px; border-top: 1px solid #333; padding-top: 6px;';
  lwHeader.textContent = '── Living Wood Audio ──';
  cypressContent.appendChild(lwHeader);

  const lwSliders = [
    { label: 'Earth Rumble', min: 0, max: 1, step: 0.05, initial: 0.4,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setCypressLivingWoodParam('earthMix', v) },
    { label: 'Sub Bass', min: 0, max: 1, step: 0.05, initial: 0.75,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setCypressLivingWoodParam('subMix', v) },
    { label: 'Pad (G2+Bb2)', min: 0, max: 2, step: 0.05, initial: 2.0,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setCypressLivingWoodParam('padMix', v) },
    { label: 'Pad Harmonicity', min: 0.25, max: 2.0, step: 0.05, initial: 1.0,
      fmt: v => v.toFixed(2),
      onChange: v => setCypressLivingWoodParam('trunkHarmonicity', v) },
    { label: 'Branches (Gm7)', min: 0, max: 1, step: 0.05, initial: 0.1,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setCypressLivingWoodParam('branchVolume', v) },
    { label: 'Bow Sensitivity', min: 0.2, max: 2.0, step: 0.1, initial: 1.0,
      fmt: v => v.toFixed(1),
      onChange: v => setCypressLivingWoodParam('velocitySensitivity', v) },
    { label: 'Reverb Mix', min: 0, max: 1, step: 0.05, initial: 0.75,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setCypressLivingWoodParam('reverbMix', v) },
    { label: 'Phaser Wet', min: 0, max: 0.8, step: 0.05, initial: 0.5,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setCypressLivingWoodParam('phaserWet', v) },
    { label: 'Delay Mix', min: 0, max: 0.6, step: 0.05, initial: 0.15,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setCypressLivingWoodParam('delayMix', v) },
  ];
  for (const def of lwSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    cypressContent.appendChild(group);
  }

  cypressPanel.appendChild(cypressContent);
  controlPanel.insertBefore(cypressPanel, starsGroup);

  // ── Village panel ──
  const villagePanel = document.createElement('details');
  villagePanel.className = 'vortex-group-panel';
  villagePanel.open = false;

  const villageSummary = document.createElement('summary');
  villageSummary.textContent = 'Village';
  villagePanel.appendChild(villageSummary);

  const villageContent = document.createElement('div');
  villageContent.className = 'audio-tuning-content';

  // Play / Stop toggle
  let _villageAutoPlay = false;
  const villagePlayRow = document.createElement('div');
  villagePlayRow.className = 'vortex-control-row';
  villagePlayRow.style.cssText = 'margin-bottom:8px; display:flex; flex-direction:row; align-items:center; gap:4px; flex-wrap:nowrap;';

  const villagePlayBtn = document.createElement('button');
  villagePlayBtn.className = 'panel-copy-btn';
  villagePlayBtn.textContent = '\u25B6 Play';
  villagePlayBtn.style.cssText = 'cursor:pointer; color:#f90; border-color:#f90; flex:1; padding:0.15rem 0; margin:0;';

  const villageStopBtn = document.createElement('button');
  villageStopBtn.className = 'panel-copy-btn';
  villageStopBtn.textContent = '\u25A0';
  villageStopBtn.style.cssText = 'cursor:pointer; color:#999; border-color:#999; padding:0.15rem 0.4rem; font-size:10px; margin:0;';

  function villageActivateVisual() {
    const cs = regionColorState[2];
    if (cs) {
      cs.state = 'on';
      cs.targetIntensity = 1.0;
      cs.radiusNorm = 1.0;
      if (cs.clickX === undefined) { cs.clickX = 0.6; cs.clickY = 0.7; }
    }
  }

  function villageClearVisual() {
    const cs = regionColorState[2];
    if (cs) { cs.state = 'fading'; cs.targetIntensity = 0; }
  }

  function updateVillagePlayStyles() {
    if (_villageAutoPlay) {
      villagePlayBtn.textContent = '\u25B6 Playing';
      villagePlayBtn.style.color = '#000';
      villagePlayBtn.style.background = '#f90';
      villagePlayBtn.style.borderColor = '#f90';
    } else {
      villagePlayBtn.textContent = '\u25B6 Play';
      villagePlayBtn.style.color = '#f90';
      villagePlayBtn.style.background = '';
      villagePlayBtn.style.borderColor = '#f90';
    }
  }

  villagePlayBtn.addEventListener('click', async () => {
    if (_villageAutoPlay) {
      _villageAutoPlay = false;
      stopRegion(2);
      villageClearVisual();
      updateVillagePlayStyles();
      return;
    }
    const started = await playRegion(2, 0);
    if (!started) return;
    _villageAutoPlay = true;
    villageActivateVisual();
    updateVillagePlayStyles();
  });

  villageStopBtn.addEventListener('click', () => {
    if (!_villageAutoPlay) return;
    _villageAutoPlay = false;
    stopRegion(2);
    villageClearVisual();
    updateVillagePlayStyles();
  });

  villagePlayRow.appendChild(villagePlayBtn);
  villagePlayRow.appendChild(villageStopBtn);
  villageContent.appendChild(villagePlayRow);

  // ── Village Wind Sway sliders ──
  const vwHeader = document.createElement('div');
  vwHeader.style.cssText = 'color: #9c6; font-size: 11px; margin: 8px 0 4px; border-top: 1px solid #333; padding-top: 6px;';
  vwHeader.textContent = '── Wind Sway ──';
  villageContent.appendChild(vwHeader);

  const vwSliders = [
    { label: 'Amplitude', min: 0, max: 0.02, step: 0.001, initial: 0.001,
      fmt: v => v.toFixed(3),
      onChange: v => { _vlAmpBase = v; renderer.setVillageWindAmp(v); } },
    { label: 'Frequency', min: 1, max: 60, step: 1, initial: 60,
      fmt: v => v.toFixed(0),
      onChange: v => renderer.setVillageWindFreq(v) },
    { label: 'Speed', min: 0, max: 10, step: 0.1, initial: 0.6,
      fmt: v => v.toFixed(1),
      onChange: v => renderer.setVillageWindSpeed(v) },
    { label: 'Angle', min: -3.14, max: 3.14, step: 0.05, initial: 0,
      fmt: v => `${(v * 180 / Math.PI).toFixed(0)}°`,
      onChange: v => renderer.setVillageWindAngle(v) },
    { label: 'Sway Scatter', min: 0, max: 1, step: 0.05, initial: 0.5,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => renderer.setVillageSwayAngle(v) },
    { label: 'Edge Depth', min: 0, max: 80, step: 1, initial: 20,
      fmt: v => `${v}px`,
      onChange: v => renderer.setVillageEdgeDepth(v) },
    { label: 'Lum Parallax', min: 0, max: 1, step: 0.05, initial: 1.0,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => renderer.setVillageLumParallax(v) },
    { label: 'Twinkle', min: 0, max: 1, step: 0.05, initial: 0,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => renderer.setVillageTwinkle(v) },
    { label: 'Warmth Gate', min: -0.2, max: 0.4, step: 0.01, initial: 0.05,
      fmt: v => v.toFixed(2),
      onChange: v => renderer.setVillageTwinkleWarmth(v) },
    { label: 'Breath Depth', min: 0, max: 1, step: 0.05, initial: 0.5,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _vlBreathDepthBase = v; renderer.setVillageBreathDepth(v); } },
    { label: 'Wind Noise', min: 0, max: 3, step: 0.1, initial: 0.5,
      fmt: v => v.toFixed(1),
      onChange: v => renderer.setVillageNoiseAmp(v) },
    { label: 'Noise Drift', min: 0, max: 0.02, step: 0.001, initial: 0.001,
      fmt: v => v.toFixed(3),
      onChange: v => { _vlNoiseDriftBase = v; renderer.setVillageNoiseDrift(v); } },
    { label: 'Cross Sway', min: 0, max: 1, step: 0.05, initial: 0.1,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { _vlCrossSwayBase = v; renderer.setVillageCrossSway(v); } },
    { label: 'Trail', min: 0, max: 0.95, step: 0.05, initial: 0.95,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => renderer.setVillageTrailPersist(v) },
    { label: 'Drag Radius', min: 0.02, max: 0.30, step: 0.01, initial: 0.15,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => renderer.setVillageWindRadius(v) },
    { label: 'Drag Strength', min: 0, max: 0.05, step: 0.001, initial: 0.005,
      fmt: v => v.toFixed(3),
      onChange: v => renderer.setVillageAttractionAmp(v) },
  ];
  const _vlModulatedLabels = new Set(['Amplitude', 'Noise Drift', 'Cross Sway']);
  for (const def of vwSliders) {
    const { group, slider, valSpan, deltaSpan } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
    if (_vlModulatedLabels.has(def.label)) {
      _vlSliders[def.label] = { slider, valSpan, deltaSpan, fmt: def.fmt, initial: def.initial };
    }
  }

  // ── Village Swarm sliders ──
  const swarmHeader = document.createElement('div');
  swarmHeader.style.cssText = 'color: #f93; font-size: 11px; margin: 8px 0 4px; border-top: 1px solid #333; padding-top: 6px;';
  swarmHeader.textContent = '── Swarm ──';
  villageContent.appendChild(swarmHeader);

  // Simulate Swarm toggle: holds attraction at village center for hands-free tuning
  const swarmSimBtn = document.createElement('button');
  swarmSimBtn.className = 'panel-copy-btn';
  swarmSimBtn.textContent = 'Simulate Swarm';
  swarmSimBtn.style.cssText = 'margin: 2px 4px 6px; width: calc(100% - 8px);';
  swarmSimBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    _swarmSimActive = !_swarmSimActive;
    if (_swarmSimActive) {
      _vlCursorUV[0] = 0.6; _vlCursorUV[1] = 0.7;  // village center
      renderer.setVillageClickOrigin(0.6, 0.7);
      _vlAttractionRaw = 1.0;
      swarmSimBtn.textContent = 'Stop Simulation';
      swarmSimBtn.style.background = '#633';
    } else {
      _vlAttractionRaw = 0;
      swarmSimBtn.textContent = 'Simulate Swarm';
      swarmSimBtn.style.background = '';
    }
  });
  villageContent.appendChild(swarmSimBtn);

  const swarmSliders = [
    { label: 'Cycle Min', min: 0.3, max: 15, step: 0.1, initial: 8.0,
      fmt: v => v.toFixed(1) + 's',
      onChange: v => renderer.setSwarmCyclePeriodMin(v) },
    { label: 'Cycle Max', min: 1, max: 30, step: 0.5, initial: 13.0,
      fmt: v => v.toFixed(1) + 's',
      onChange: v => renderer.setSwarmCyclePeriodMax(v) },
    { label: 'Drift Frac', min: 0.3, max: 0.95, step: 0.05, initial: 0.50,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => renderer.setSwarmDriftFrac(v) },
    { label: 'Early Death %', min: 0, max: 0.8, step: 0.05, initial: 0.30,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => renderer.setSwarmEarlyDeathPct(v) },
    { label: 'Death Fade', min: 0.01, max: 0.5, step: 0.01, initial: 0.50,
      fmt: v => v.toFixed(2),
      onChange: v => renderer.setSwarmDeathFadeWidth(v) },
    { label: 'Max Drift Mul', min: 1, max: 40, step: 1, initial: 7,
      fmt: v => v.toFixed(0) + '×',
      onChange: v => renderer.setSwarmMaxDriftMul(v) },
    { label: 'Fade In', min: 0.01, max: 0.5, step: 0.01, initial: 0.25,
      fmt: v => v.toFixed(2),
      onChange: v => renderer.setSwarmFadeIn(v) },
    { label: 'Fade Out Start', min: 0.4, max: 0.99, step: 0.01, initial: 0.80,
      fmt: v => v.toFixed(2),
      onChange: v => renderer.setSwarmFadeOutStart(v) },
    { label: 'Fixed Period', min: 0, max: 15, step: 0.5, initial: 0,
      fmt: v => v === 0 ? 'OFF' : v.toFixed(1) + 's',
      onChange: v => renderer.setSwarmFixedPeriod(v) },
    { label: 'Phase Spread', min: 0, max: 1, step: 0.05, initial: 1.0,
      fmt: v => v === 0 ? 'SYNC' : (v * 100).toFixed(0) + '%',
      onChange: v => renderer.setSwarmPhaseSpread(v) },
    { label: 'LFO Sync', min: 0, max: 1, step: 1, initial: 0,
      fmt: v => v > 0.5 ? 'ON' : 'OFF',
      onChange: v => renderer.setSwarmLfoSync(v > 0.5) },
  ];
  const _swarmSliderRefs = {};
  for (const def of swarmSliders) {
    const { group, slider, valSpan } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
    _swarmSliderRefs[def.label] = { slider, valSpan, fmt: def.fmt, initial: def.initial };
  }

  // Copy button: snapshot all swarm params as JSON
  const swarmCopyBtn = document.createElement('button');
  swarmCopyBtn.className = 'panel-copy-btn';
  swarmCopyBtn.textContent = 'Copy Swarm';
  swarmCopyBtn.style.cssText = 'margin: 4px 4px 8px;';
  swarmCopyBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const snap = {};
    for (const [label, ref] of Object.entries(_swarmSliderRefs)) {
      snap[label] = +parseFloat(ref.slider.value).toFixed(4);
    }
    snap['Drag Radius'] = renderer.getVillageWindRadius();
    snap['Drag Strength'] = renderer.getVillageAttractionAmp();
    const json = JSON.stringify(snap, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      swarmCopyBtn.textContent = 'Copied!';
      setTimeout(() => { swarmCopyBtn.textContent = 'Copy Swarm'; }, 1000);
    }).catch(() => {});
  });
  villageContent.appendChild(swarmCopyBtn);

  // ── Village Pulse sliders ──
  const vpHeader = document.createElement('div');
  vpHeader.style.cssText = 'color: #0cf; font-size: 11px; margin: 8px 0 4px; border-top: 1px solid #333; padding-top: 6px;';
  vpHeader.textContent = '── Pulse ──';
  villageContent.appendChild(vpHeader);

  // Layer A: Low Foundation
  const vpLowLabel = document.createElement('div');
  vpLowLabel.style.cssText = 'color: #666; font-size: 9px; margin: 4px 0 2px;';
  vpLowLabel.textContent = 'FOUNDATION (FM D2/F2)';
  villageContent.appendChild(vpLowLabel);

  const vpLowSliders = [
    { label: 'Low Vol', min: -30, max: -4, step: 1, initial: -18,
      fmt: v => `${v} dB`,
      onChange: v => setVillagePulseParam('lowPadVol', v) },
    { label: 'Low FM', min: 0, max: 3, step: 0.1, initial: 0.6,
      fmt: v => v.toFixed(1),
      onChange: v => setVillagePulseParam('lowFmDepth', v) },
  ];
  for (const def of vpLowSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
  }

  // Layer B: Pad
  const vpPadLabel = document.createElement('div');
  vpPadLabel.style.cssText = 'color: #666; font-size: 9px; margin: 6px 0 2px;';
  vpPadLabel.textContent = 'PAD (FM D3/F3)';
  villageContent.appendChild(vpPadLabel);

  const vpPadSliders = [
    { label: 'Pad Vol', min: -24, max: -2, step: 1, initial: -7,
      fmt: v => `${v} dB`,
      onChange: v => setVillagePulseParam('padVol', v) },
    { label: 'FM Depth', min: 0, max: 4, step: 0.1, initial: 0.8,
      fmt: v => v.toFixed(1),
      onChange: v => setVillagePulseParam('fmDepth', v) },
    { label: 'Tremolo', min: 0.01, max: 1, step: 0.01, initial: 0.15,
      fmt: v => `${v.toFixed(2)} Hz`,
      onChange: v => setVillagePulseParam('tremoloRate', v) },
  ];
  for (const def of vpPadSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
  }

  // Layer B: Overtones
  const vpOvertoneLabel = document.createElement('div');
  vpOvertoneLabel.style.cssText = 'color: #666; font-size: 9px; margin: 6px 0 2px;';
  vpOvertoneLabel.textContent = 'OVERTONES (Gm sines)';
  villageContent.appendChild(vpOvertoneLabel);

  const vpOvertoneSliders = [
    { label: 'Overtone Mix', min: 0, max: 0.8, step: 0.02, initial: 0.5,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setVillagePulseParam('overtoneVol', v) },
  ];
  for (const def of vpOvertoneSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
  }

  // Effects (phaser + delay)
  const vpFxLabel = document.createElement('div');
  vpFxLabel.style.cssText = 'color: #666; font-size: 9px; margin: 6px 0 2px;';
  vpFxLabel.textContent = 'EFFECTS (through walls)';
  villageContent.appendChild(vpFxLabel);

  const vpFxSliders = [
    { label: 'Ambient Bleed', min: 0, max: 0.5, step: 0.01, initial: 0.3,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setVillagePulseParam('bleed', v) },
    { label: 'Phaser Wet', min: 0, max: 0.6, step: 0.02, initial: 0.25,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setVillagePulseParam('phaserWet', v) },
    { label: 'Phaser Rate', min: 0.01, max: 0.2, step: 0.005, initial: 0.04,
      fmt: v => `${v.toFixed(3)} Hz`,
      onChange: v => setVillagePulseParam('phaserRate', v) },
    { label: 'Delay Time', min: 0.03, max: 0.3, step: 0.005, initial: 0.1,
      fmt: v => `${(v * 1000).toFixed(0)}ms`,
      onChange: v => setVillagePulseParam('delayTime', v) },
    { label: 'Delay Feedback', min: 0, max: 0.5, step: 0.02, initial: 0.2,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setVillagePulseParam('delayFeedback', v) },
    { label: 'Delay Wet', min: 0, max: 0.5, step: 0.02, initial: 0.2,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setVillagePulseParam('delayWet', v) },
  ];
  for (const def of vpFxSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
  }

  // Room (reverb)
  const vpRoomLabel = document.createElement('div');
  vpRoomLabel.style.cssText = 'color: #666; font-size: 9px; margin: 6px 0 2px;';
  vpRoomLabel.textContent = 'ROOM (interior)';
  villageContent.appendChild(vpRoomLabel);

  const vpRoomSliders = [
    { label: 'Room Size', min: 0.05, max: 0.8, step: 0.02, initial: 0.35,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setVillagePulseParam('reverbRoom', v) },
    { label: 'Damping', min: 200, max: 8000, step: 100, initial: 2000,
      fmt: v => `${v} Hz`,
      onChange: v => setVillagePulseParam('reverbDamp', v) },
    { label: 'Wet', min: 0, max: 0.8, step: 0.02, initial: 0.3,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => setVillagePulseParam('reverbWet', v) },
  ];
  for (const def of vpRoomSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
  }

  // LFO (rhythm)
  const vpLfoLabel = document.createElement('div');
  vpLfoLabel.style.cssText = 'color: #666; font-size: 9px; margin: 6px 0 2px;';
  vpLfoLabel.textContent = 'RHYTHM (LFO → amplitude)';
  villageContent.appendChild(vpLfoLabel);

  const vpLfoSliders = [
    { label: 'LFO Shape', min: 0, max: 3, step: 1, initial: 0,
      fmt: v => ['sine', 'triangle', 'sawtooth', 'square'][v],
      onChange: v => setVillagePulseParam('lfoShape', ['sine', 'triangle', 'sawtooth', 'square'][v]) },
    { label: 'Min Rate', min: 0.1, max: 2, step: 0.05, initial: 0.25,
      fmt: v => `${v.toFixed(2)} Hz`,
      onChange: v => setVillagePulseParam('lfoMinRate', v) },
    { label: 'Max Rate', min: 0.5, max: 10, step: 0.25, initial: 4,
      fmt: v => `${v.toFixed(1)} Hz`,
      onChange: v => setVillagePulseParam('lfoMaxRate', v) },
  ];
  for (const def of vpLfoSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    villageContent.appendChild(group);
  }

  villagePanel.appendChild(villageContent);
  controlPanel.insertBefore(villagePanel, starsGroup);

  // ── Night Sky panel (region 3) ──
  const nightSkyPanel = document.createElement('details');
  nightSkyPanel.className = 'vortex-group-panel';
  nightSkyPanel.open = false;

  const nightSkySummary = document.createElement('summary');
  nightSkySummary.textContent = 'Night Sky';
  nightSkyPanel.appendChild(nightSkySummary);

  const nightSkyContent = document.createElement('div');
  nightSkyContent.className = 'audio-tuning-content';

  // Play / Stop toggle
  let _nightSkyAutoPlay = false;
  const nightSkyPlayRow = document.createElement('div');
  nightSkyPlayRow.className = 'vortex-control-row';
  nightSkyPlayRow.style.cssText = 'margin-bottom:8px; display:flex; flex-direction:row; align-items:center; gap:4px; flex-wrap:nowrap;';

  const nightSkyPlayBtn = document.createElement('button');
  nightSkyPlayBtn.className = 'panel-copy-btn';
  nightSkyPlayBtn.textContent = '\u25B6 Play';
  nightSkyPlayBtn.style.cssText = 'cursor:pointer; color:#36d; border-color:#36d; flex:1; padding:0.15rem 0; margin:0;';

  const nightSkyStopBtn = document.createElement('button');
  nightSkyStopBtn.className = 'panel-copy-btn';
  nightSkyStopBtn.textContent = '\u25A0';
  nightSkyStopBtn.style.cssText = 'cursor:pointer; color:#999; border-color:#999; padding:0.15rem 0.4rem; font-size:10px; margin:0;';

  function nightSkyActivateVisual() {
    const cs = regionColorState[3];
    if (cs) {
      cs.state = 'on';
      cs.targetIntensity = 1.0;
      cs.radiusNorm = 1.0;
      if (cs.clickX === undefined) { cs.clickX = 0.5; cs.clickY = 0.3; }
    }
  }

  function nightSkyClearVisual() {
    const cs = regionColorState[3];
    if (cs) { cs.state = 'fading'; cs.targetIntensity = 0; }
  }

  function updateNightSkyPlayStyles() {
    if (_nightSkyAutoPlay) {
      nightSkyPlayBtn.textContent = '\u25B6 Playing';
      nightSkyPlayBtn.style.color = '#000';
      nightSkyPlayBtn.style.background = '#36d';
      nightSkyPlayBtn.style.borderColor = '#36d';
    } else {
      nightSkyPlayBtn.textContent = '\u25B6 Play';
      nightSkyPlayBtn.style.color = '#36d';
      nightSkyPlayBtn.style.background = '';
      nightSkyPlayBtn.style.borderColor = '#36d';
    }
  }

  nightSkyPlayBtn.addEventListener('click', async () => {
    if (_nightSkyAutoPlay) {
      _nightSkyAutoPlay = false;
      stopRegion(3);
      nightSkyClearVisual();
      updateNightSkyPlayStyles();
      return;
    }
    const started = await playRegion(3, 0);
    if (!started) return;
    _nightSkyAutoPlay = true;
    nightSkyActivateVisual();
    updateNightSkyPlayStyles();
  });

  nightSkyStopBtn.addEventListener('click', () => {
    if (!_nightSkyAutoPlay) return;
    _nightSkyAutoPlay = false;
    stopRegion(3);
    nightSkyClearVisual();
    updateNightSkyPlayStyles();
  });

  nightSkyPlayRow.appendChild(nightSkyPlayBtn);
  nightSkyPlayRow.appendChild(nightSkyStopBtn);
  nightSkyContent.appendChild(nightSkyPlayRow);

  // Expose reset function for onStateChange callback (declared at module scope)
  _nightSkyResetFn = () => {
    _nightSkyAutoPlay = false;
    updateNightSkyPlayStyles();
    nightSkyClearVisual();
  };

  // ── Sky Gust section (visual motion — shared with region 4 low-coherence particles) ──
  const skyGustHeader = document.createElement('div');
  skyGustHeader.className = 'audio-meter-label';
  skyGustHeader.style.cssText = 'font-weight:bold; margin:6px 0 2px; color:#6af; width:auto; white-space:nowrap;';
  skyGustHeader.textContent = '— Sky Gust —';
  nightSkyContent.appendChild(skyGustHeader);

  // Audio-modulated slider labels for Night Sky sky gust
  const _nsModulatedLabels = new Set([
    'Sky Gust Intensity', 'Sky Drift Distance', 'Gust Trail', 'Cross Sway', 'Star Shimmer',
  ]);

  const skyGustSliders = [
    { label: 'Sky Gust Intensity', min: 0, max: 2.0, step: 0.05, initial: 1.0,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => { _skyGustAmpBase = v; renderer.setSkyGustAmplitude(v); } },
    { label: 'Sky Drift Distance', min: 0, max: 0.03, step: 0.001, initial: 0.008,
      fmt: v => (v * 1000).toFixed(1) + 'px',
      onChange: v => { _skyMaxDriftBase = v; renderer.setSkyMaxDrift(v); } },
    { label: 'Gust Trail', min: 0, max: 0.95, step: 0.005, initial: 0.85,
      fmt: v => (v * 100).toFixed(1) + '%',
      onChange: v => { _skyTrailBase = v; renderer.setSkyGustTrailPersist(v); } },
    { label: 'Cross Sway', min: 0, max: 1.0, step: 0.025, initial: 0.35,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => { _skySwayBase = v; renderer.setSkySwayAmount(v); } },
    { label: 'Star Shimmer', min: 0, max: 1.0, step: 0.025, initial: 0.05,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => { _skyShimmerBase = v; renderer.setSkyStarShimmer(v); } },
  ];
  for (const def of skyGustSliders) {
    const { group, slider, valSpan, deltaSpan } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    nightSkyContent.appendChild(group);
    if (_nsModulatedLabels.has(def.label)) {
      _nsSliders[def.label] = { slider, valSpan, deltaSpan, fmt: def.fmt, initial: def.initial };
    }
  }

  // ── Cursor Wake section ──
  const wakeHeader = document.createElement('div');
  wakeHeader.className = 'audio-meter-label';
  wakeHeader.style.cssText = 'font-weight:bold; margin:6px 0 2px; color:#6af; width:auto; white-space:nowrap;';
  wakeHeader.textContent = '— Cursor Wake —';
  nightSkyContent.appendChild(wakeHeader);

  const wakeSliders = [
    { label: 'Wake Radius', min: 0.01, max: 0.20, step: 0.005, initial: _nsWakeRadius,
      fmt: v => (v * 100).toFixed(1) + '%',
      onChange: v => { _nsWakeRadius = v; } },
    { label: 'Gust Boost', min: 0, max: 1.0, step: 0.05, initial: _nsWakeGustBoost,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => { _nsWakeGustBoost = v; } },
    { label: 'Shimmer Build', min: 0.1, max: 5.0, step: 0.1, initial: _nsWakeBuildTime,
      fmt: v => v.toFixed(1) + 's',
      onChange: v => { _nsWakeBuildTime = v; } },
    { label: 'Water Push', min: 0, max: 0.02, step: 0.001, initial: 0.006,
      fmt: v => (v * 1000).toFixed(1) + 'px',
      onChange: v => { _nsWakePushStrength = v; } },
    { label: 'Wake Decay', min: 0.5, max: 10.0, step: 0.5, initial: _nsWakeDecay,
      fmt: v => v.toFixed(1) + 's',
      onChange: v => { _nsWakeDecay = v; } },
  ];
  for (const def of wakeSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    nightSkyContent.appendChild(group);
  }

  // ── Night Sky sliders ──
  const nsHeader = document.createElement('div');
  nsHeader.style.cssText = 'color: #36d; font-size: 11px; margin: 8px 0 4px; border-top: 1px solid #333; padding-top: 6px;';
  nsHeader.textContent = 'Voice';
  nightSkyContent.appendChild(nsHeader);

  const nsSliders = [
    { label: 'Noise Mix',       key: 'noiseMix',       min: 0,    max: 1,    step: 0.05, initial: 0.04, fmt: v => v.toFixed(2) },
    { label: 'Pad Mix',         key: 'padMix',          min: 0,    max: 1,    step: 0.05, initial: 0.20, fmt: v => v.toFixed(2) },
    { label: 'Voice Bed',       key: 'voiceVolume',     min: 0,    max: 1,    step: 0.05, initial: 0.10, fmt: v => v.toFixed(2) },
    { label: 'Brightness',      key: 'brightness',      min: -1,   max: 1,    step: 0.05, initial: 0.25, fmt: v => v.toFixed(2) },
    { label: 'Strum Intensity', key: 'strumIntensity',  min: 0,    max: 1,    step: 0.05, initial: 0.85, fmt: v => v.toFixed(2) },
    { label: 'Strum Decay',     key: 'strumDecay',      min: 0.5,  max: 8,    step: 0.1,  initial: 1.0,  fmt: v => v.toFixed(1) },
    { label: 'Reverb Mix',      key: 'reverbMix',       min: 0,    max: 1,    step: 0.01, initial: 0.40, fmt: v => v.toFixed(2) },
    { label: 'Delay Mix',       key: 'delayMix',        min: 0,    max: 0.5,  step: 0.01, initial: 0.20, fmt: v => v.toFixed(2) },
    { label: 'Phaser Wet',      key: 'phaserWet',       min: 0,    max: 0.8,  step: 0.01, initial: 0.40, fmt: v => v.toFixed(2) },
    { label: 'Master Gain',     key: 'baseGain',        min: 0.1,  max: 1.0,  step: 0.05, initial: 0.86, fmt: v => v.toFixed(2) },
  ];
  for (const def of nsSliders) {
    const { group } = makeSlider(
      def.label, def.min, def.max, def.step, def.initial, def.fmt,
      v => { setNightSkyParam(def.key, v); }
    );
    nightSkyContent.appendChild(group);
  }

  nightSkyPanel.appendChild(nightSkyContent);
  controlPanel.insertBefore(nightSkyPanel, starsGroup);

  // ── Sin Wave panel (hidden until DOWN key activates it) ──

  // ── Star Glow tuning panel (nested inside Stars) ──
  const starGlowPanel = createStarGlowPanel();
  starsGroup.appendChild(starGlowPanel);

  // ── Star Cursor Disruption panel ──
  const disruptPanel = document.createElement('details');
  disruptPanel.className = 'vortex-group-panel';
  disruptPanel.open = false;
  const disruptSummary = document.createElement('summary');
  disruptSummary.textContent = 'Cursor Bump';
  const disruptCopyBtn = document.createElement('button');
  disruptCopyBtn.className = 'panel-copy-btn';
  disruptCopyBtn.textContent = 'Copy';
  disruptCopyBtn.title = 'Copy disruption params to clipboard';
  disruptCopyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const copyData = {
      bumpStrength: _starDisrupt.bumpStrength,
      pushRadius: _starDisrupt.pushRadius,
      influenceAtk: _starDisrupt.influenceAtk,
      influenceRel: _starDisrupt.influenceRel,
      cursorSpeedBoost: _vortexCursorBoost,
      cursorSpeedAtk: _vortexCursorAtkTau,
      cursorSpeedRel: _vortexCursorRelTau,
    };
    navigator.clipboard.writeText(JSON.stringify(copyData, null, 2)).then(() => {
      disruptCopyBtn.textContent = 'Copied!';
      setTimeout(() => { disruptCopyBtn.textContent = 'Copy'; }, 1000);
    });
  });
  disruptSummary.appendChild(disruptCopyBtn);
  disruptPanel.appendChild(disruptSummary);
  const disruptContent = document.createElement('div');
  const sd = _starDisrupt;
  const disruptSliders = [
    { label: 'Bump Strength', min: 0, max: 0.02, step: 0.001, initial: sd.bumpStrength,
      fmt: v => (v * 1000).toFixed(1) + 'px',
      onChange: v => { sd.bumpStrength = v; } },
    { label: 'Push Radius', min: 0.05, max: 1.00, step: 0.01, initial: sd.pushRadius,
      fmt: v => `${(v * 100).toFixed(0)}%`,
      onChange: v => { sd.pushRadius = v; renderer.setStarPushRadius(v); } },
    { label: 'Cursor Trail', min: 0, max: 0.98, step: 0.01, initial: sd.trailPersist,
      fmt: v => (v * 100).toFixed(0) + '%',
      onChange: v => { sd.trailPersist = v; renderer.setStarTrailPersist(v); } },
    { label: 'Attack', min: 0.01, max: 0.50, step: 0.01, initial: sd.influenceAtk,
      fmt: v => `${(v * 1000).toFixed(0)}ms`,
      onChange: v => { sd.influenceAtk = v; } },
    { label: 'Release', min: 0.1, max: 3.0, step: 0.1, initial: sd.influenceRel,
      fmt: v => `${(v * 1000).toFixed(0)}ms`,
      onChange: v => { sd.influenceRel = v; } },
  ];
  for (const def of disruptSliders) {
    const { group, slider, valSpan, deltaSpan } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    disruptContent.appendChild(group);
    _bumpSliders[def.label] = { slider, valSpan, deltaSpan, fmt: def.fmt, initial: def.initial };
  }

  // Pin checkbox: lock bump to star 0 for off-canvas tuning
  const pinRow = document.createElement('div');
  pinRow.style.cssText = 'margin: 6px 0; display: flex; align-items: center; gap: 6px;';
  const pinCheck = document.createElement('input');
  pinCheck.type = 'checkbox';
  pinCheck.id = 'star-bump-pin';
  pinCheck.addEventListener('change', () => { _starBumpPinned = pinCheck.checked; });
  const pinLabel = document.createElement('label');
  pinLabel.htmlFor = 'star-bump-pin';
  pinLabel.textContent = 'Pin to Star 0 (for tuning)';
  pinLabel.style.cssText = 'font-size: 11px; color: #aaa; cursor: pointer;';
  pinRow.appendChild(pinCheck);
  pinRow.appendChild(pinLabel);
  disruptContent.appendChild(pinRow);

  // ── Cursor Speed Boost sliders ──
  const speedBoostHeader = document.createElement('div');
  speedBoostHeader.style.cssText = 'color: #fa0; font-size: 11px; margin: 8px 0 2px; border-top: 1px solid #333; padding-top: 6px;';
  speedBoostHeader.textContent = '— Cursor Speed Boost —';
  disruptContent.appendChild(speedBoostHeader);

  const speedBoostSliders = [
    { label: 'Boost', min: 0, max: 1.5, step: 0.05, initial: _vortexCursorBoost,
      fmt: v => `${v.toFixed(2)} rad/s`,
      onChange: v => { _vortexCursorBoost = v; } },
    { label: 'Boost Attack', min: 0.1, max: 2.0, step: 0.05, initial: _vortexCursorAtkTau,
      fmt: v => `${(v * 1000).toFixed(0)}ms`,
      onChange: v => { _vortexCursorAtkTau = v; } },
    { label: 'Boost Release', min: 0.1, max: 3.0, step: 0.1, initial: _vortexCursorRelTau,
      fmt: v => `${(v * 1000).toFixed(0)}ms`,
      onChange: v => { _vortexCursorRelTau = v; } },
  ];
  for (const def of speedBoostSliders) {
    const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
    disruptContent.appendChild(group);
  }

  disruptPanel.appendChild(disruptContent);
  starsGroup.appendChild(disruptPanel);

  // ── Mood tuning panel (always visible) ──
  _moodTuningPanel = createMoodTuningPanel();
  controlPanel.insertBefore(_moodTuningPanel, starsGroup);

  // ── Touch Trail panel ──
  {
    const trailPanel = document.createElement('details');
    trailPanel.className = 'vortex-group-panel';
    trailPanel.open = false;
    const trailSummary = document.createElement('summary');
    trailSummary.textContent = 'Touch Trail';
    trailPanel.appendChild(trailSummary);
    const trailContent = document.createElement('div');
    trailContent.className = 'audio-tuning-content';

    const trailSliders = [
      { label: 'Spring', min: 0.01, max: 0.20, step: 0.01, initial: 0.06,
        fmt: v => v.toFixed(2),
        onChange: v => touchTrail.setSpring(v) },
      { label: 'Friction', min: 0.5, max: 0.99, step: 0.01, initial: 0.85,
        fmt: v => v.toFixed(2),
        onChange: v => touchTrail.setFriction(v) },
      { label: 'Trail Lerp', min: 0.5, max: 0.99, step: 0.01, initial: 0.50,
        fmt: v => v.toFixed(2),
        onChange: v => touchTrail.setTrailLerp(v) },
      { label: 'Width', min: 2, max: 40, step: 1, initial: 16,
        fmt: v => v.toFixed(0) + 'px',
        onChange: v => touchTrail.setBaseWidth(v) },
      { label: 'Opacity', min: 0.05, max: 1.0, step: 0.05, initial: 0.25,
        fmt: v => v.toFixed(2),
        onChange: v => touchTrail.setBaseAlpha(v) },
      { label: 'Fade Duration', min: 100, max: 1500, step: 50, initial: 400,
        fmt: v => v.toFixed(0) + 'ms',
        onChange: v => touchTrail.setFadeDuration(v) },
    ];

    for (const def of trailSliders) {
      const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
      trailContent.appendChild(group);
    }
    trailPanel.appendChild(trailContent);
    controlPanel.insertBefore(trailPanel, starsGroup);
  }

  // ── Ambient Glow panel ──
  {
    const glowPanel = document.createElement('details');
    glowPanel.className = 'vortex-group-panel';
    glowPanel.open = false;
    const glowSummary = document.createElement('summary');
    glowSummary.textContent = 'Ambient Glow';
    glowPanel.appendChild(glowSummary);
    const glowContent = document.createElement('div');
    glowContent.className = 'audio-tuning-content';

    const glowSliders = [
      { label: 'Brightness Base', min: 0, max: 1.0, step: 0.05, initial: 0.15,
        fmt: v => v.toFixed(2),
        onChange: v => { _glowBrightBase = v; } },
      { label: 'Brightness RMS', min: 0, max: 3.0, step: 0.05, initial: 0.85,
        fmt: v => v.toFixed(2),
        onChange: v => { _glowBrightRms = v; } },
      { label: 'Color Cap', min: 0.1, max: 1.0, step: 0.05, initial: 0.60,
        fmt: v => v.toFixed(2),
        onChange: v => { _glowColorCap = v; } },
      { label: 'Opacity Base', min: 0, max: 0.8, step: 0.05, initial: 0.25,
        fmt: v => v.toFixed(2),
        onChange: v => { _glowOpacityBase = v; } },
      { label: 'Opacity RMS', min: 0, max: 1.0, step: 0.05, initial: 0.35,
        fmt: v => v.toFixed(2),
        onChange: v => { _glowOpacityRms = v; } },
      { label: 'RMS Sensitivity', min: 0.01, max: 0.20, step: 0.01, initial: 0.05,
        fmt: v => v.toFixed(2),
        onChange: v => { _glowRmsSensitivity = v; } },
    ];

    for (const def of glowSliders) {
      const { group } = makeSlider(def.label, def.min, def.max, def.step, def.initial, def.fmt, def.onChange);
      glowContent.appendChild(group);
    }
    glowPanel.appendChild(glowContent);
    controlPanel.insertBefore(glowPanel, starsGroup);
  }

  // Audio Scope: lazy-loaded from js/debug/audio-scope.js on first key 3 press (or ?debug)

  // ── Resize infrastructure ──
  // Single handler for all resize concerns: invalidate cached rect, audio scope,
  // and debounced heavy callbacks with adaptive timing.
  function onLayoutResize() {
    invalidateContentRect();
    { const _cr = getCanvasContentRect();
    const _cssScale = _cr.width / glCanvas.width;
    const _cssInset = (renderer ? renderer.getPaintingMargin() : 0) * _cssScale;
    const _cssRadius = (renderer ? renderer.getBorderRadius() : 8) * _cssScale;
    ambientGlow.resize(_cr, _cssInset, _cssRadius);
  }
    if (_audioScope) _audioScope.resize();

    // Detect orientation flip (or window snap) by comparing aspect ratio direction.
    // Discrete events get a fast 100ms debounce; continuous drag gets 500ms.
    const rect = glCanvas.getBoundingClientRect();
    const curAR = rect.width / rect.height;
    const arFlipped = _lastDisplayAR > 0 &&
      ((curAR > 1 && _lastDisplayAR < 1) || (curAR < 1 && _lastDisplayAR > 1));
    _lastDisplayAR = curAR;

    const debounceMs = arFlipped ? 100 : 500;
    clearTimeout(_resizeDebounceTimer);
    _resizeDebounceTimer = setTimeout(() => {
      for (const cb of _resizeCallbacks) cb();
    }, debounceMs);
  }

  // ResizeObserver on the canvas element — fires on window resize, panel toggle,
  // orientation change, or any layout shift that changes the canvas display size.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onLayoutResize);
    ro.observe(glCanvas);
  } else {
    // Fallback for older browsers
    window.addEventListener('resize', onLayoutResize);
  }

  // DPR-aware canvas resize: recompute canvas resolution when layout changes
  _resizeCallbacks.push(applyCanvasResize);

  // DPR change detection (e.g., dragging window to a monitor with different scaling).
  // ResizeObserver doesn't fire for DPR-only changes, so use matchMedia.
  (function watchDpr() {
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mql.addEventListener('change', () => {
      onLayoutResize();  // triggers debounced re-dither at new DPR
      watchDpr();        // re-register for the new DPR value
    }, { once: true });
  })();

  // Region names for debug logging
  const REGION_NAMES = ['Background', 'Cypress', 'Village', 'Sky', 'Horizon', 'Stars'];

  renderer.setBeforeRender((dt) => {
    // Bail if GPU context was lost — all GL writes would be no-ops on dead context
    if (_contextLost) return;
    const _endBR = perfBeforeRenderStart();
    // Invalidate cached content rect once per frame so all per-frame
    // consumers share one getBoundingClientRect() call.
    invalidateContentRect();


    // ── Audio reactivity: analyze spectrum + modulate visual parameters ──
    advanceAnalysisFrame();  // per-region analyze() cache: prevents double-analysis within same frame

    // ── Time-dependent updates (frame-rate-independent dt) ──
    const dtSec = Math.min(dt * (1.0 / 60.0), 1.0 / 30.0);

    // ORDER MATTERS: updateStarVortexSpeeds sets speed, tightness, gravity, strength,
    // and trail via audio envelopes. updateStarVortices then handles armCurl, turbulence,
    // swell, and ramp-in gravity. During ramp-in (r < 1.0), updateStarVortices
    // overwrites gravity/strength with the ramp value — this is correct because audio
    // boost only fires after ramp-in completes (r >= 1.0).
    { const _e = perfMark('starVortexSpeeds'); updateStarVortexSpeeds(dtSec); _e(); }
    { const _e = perfMark('starVortices'); updateStarVortices(); _e(); }
    { const _e = perfMark('regionColors'); updateRegionColors(); _e(); }

    // (Hold-to-expand removed — stars activate all-at-once via activateStarVortices)

    // ── Star vortex cleanup: clear vortices when audio stops ──
    if (starVorticesActive) {
      const _starsState = getRegionState(5);
      if (_starsState === 'stopping' || _starsState === 'off') {
        starDeactivateAll();
      }
    }

    // ── Hover expression cleanup: end hover when region stops ──
    if (exprHoldState && exprHoldState.hoverMode) {
      const _hoverState = getRegionState(exprHoldState.regionId);
      if (_hoverState === 'stopping' || _hoverState === 'off') {
        if (exprHoldState.regionId === 1) _cyRawWindVx = 0;
        setMouseExprActive(exprHoldState.regionId, false);
        exprHoldState = null;
        glCanvas.style.cursor = '';
        touchTrail.pointerUp();
        hideExprDebugOverlay();
      }
    }

    // ── Re-create dormant star vortices after dismiss animation completes ──
    if (_pendingStarReset && renderer.getVortexCount() === 0) {
      _pendingStarReset = false;
      prePlaceStarVortices();
    }

    // Slider DOM throttle: increment once per frame, checked by each region update
    _sliderDomThrottle++;

    // Per-region gating: compute once per frame, reuse for multiple functions
    const _skipR1 = shouldSkipRegionUpdate(1, dtSec);
    const _skipR2 = shouldSkipRegionUpdate(2, dtSec);
    const _skipR3 = shouldSkipRegionUpdate(3, dtSec);
    const _skipR4 = shouldSkipRegionUpdate(4, dtSec);

    if (!_skipR4) {
      const _e = perfMark('flowCursor'); updateFlowCursorOverride(dtSec); _e();
    }
    { const _e = perfMark('starCursor'); updateStarCursorDisruption(dtSec); _e(); }
    { const _e = perfMark('vortexCursorSpd'); updateVortexCursorSpeed(dtSec); _e(); }

    // Night Sky visuals + wake are paired (wake reads _nsSmoothSky.rms from visuals)
    if (!_skipR3) {
      { const _e = perfMark('nightSkyVisuals'); updateNightSkyVisuals(dtSec); _e(); }
      { const _e = perfMark('nightSkyWake'); updateNightSkyWake(dtSec); _e(); }
    }
    if (!_skipR4) {
      { const _e = perfMark('horizonAudio'); updateHorizonAudio(dtSec); _e(); }
    }
    if (!_skipR1) {
      { const _e = perfMark('cypressAudio'); updateCypressAudio(dtSec); _e(); }
    }
    if (!_skipR2) {
      { const _e = perfMark('villageAudio'); updateVillageAudio(dtSec); _e(); }
    }

    // ── Audio debug/tuning per-frame updates ──
    { const _e = perfMark('meters'); updateToneMeters(); _e(); }

    // ── Audio Scope (oscilloscope + spectrum + feature timeline) ──
    if (_audioScope && _audioScope.isVisible()) {
      const scopeId = _audioScope.getRegion();
      let scopeFeatures, scopeRaw;
      if (scopeId === 1) {
        // Cypress: reuse already-computed features (avoid double analyze())
        scopeFeatures = _lastCypressFeatures;
        scopeRaw = getRegionRawAudio(1);
      } else if (scopeId === 4) {
        // Horizon: reuse already-computed features (avoid double analyze())
        scopeFeatures = _lastHorizonFeatures;
        scopeRaw = getHorizonRawAudio();
      } else if (scopeId === 5) {
        // Stars: reuse already-computed features (avoid double analyze())
        scopeFeatures = _lastStarsFeatures;
        scopeRaw = getRegionRawAudio(5);
      } else {
        scopeFeatures = getRegionAudioFeatures(scopeId);
        scopeRaw = getRegionRawAudio(scopeId);
      }
      const levelMeters = (scopeId === 4) ? getWindHarpMeters()
        : (scopeId === 1) ? getCypressMeters()
        : (scopeId === 5) ? getStarsMeters()
        : null;
      _audioScope.update(scopeFeatures, scopeRaw, _lastMappingOutput, levelMeters);

      // ── Periodic diagnostic log (~2 Hz while scope is visible & region held) ──
      _audioDiagCounter++;
      if (_audioDiagCounter % 120 === 0 && scopeFeatures && scopeFeatures.rms > 0.001) {
        const f = scopeFeatures;
        const rn = REGION_NAMES[scopeId] || '?';
        const fix3 = v => (v === undefined || v === null) ? '---' : v.toFixed(3);
        const fix2 = v => (v === undefined || v === null) ? '---' : v.toFixed(2);
        const pct  = v => (v === undefined || v === null) ? '---' : (v * 100).toFixed(1) + '%';
        const sign = v => (v >= 0 ? '+' : '') + v.toFixed(3);

        _log(
          `%c[AudioDiag]%c  Region ${scopeId} — ${rn}  %c(frame ${_audioDiagCounter})`,
          'color: #3cffdb; font-weight: bold',
          'color: #ccc',
          'color: #666'
        );
        console.table({
          'SPECTRAL': {
            bass:     fix3(f.bass),
            mids:     fix3(f.mids),
            highs:    fix3(f.highs),
            rms:      fix3(f.rms),
            rmsNorm:  fix3(f.rmsNorm),
            centroid: fix3(f.centroid),
            flux:     fix3(f.flux),
          },
          'PERCEPTUAL': {
            onset:     fix3(f.onset),
            direction: sign(f.spectralDirection),
            spread:    fix3(f.spread),
            rhythm:    fix3(f.rhythmStrength),
            envelope:  fix3(f.envelope),
            envState:  f.envelopeState || '---',
            rawFlux:   fix3(f.rawFlux),
          },
        });

        // Mapping output (Horizon's visual params) — only when Horizon is the scoped region
        if (_lastMappingOutput && scopeId === 4) {
          const mo = {};
          for (const [label, info] of Object.entries(_lastMappingOutput)) {
            mo[label] = {
              base:  fix3(info.base),
              eff:   fix3(info.eff),
              delta: sign(info.eff - info.base),
              pctOfMax: pct(info.eff / info.max),
            };
          }
          console.table(mo);
        }

        // V3 Wind Harp strum diagnostics (only when Horizon is the scoped region)
        const v3d = scopeId === 4 ? getWindHarpV3Diag() : null;
        if (v3d) {
          _log(
            '%c[HarpV3]%c  Region: %c%s%c  |  Note: %c%s%c  |  Y(macro): %c%s',
            'color: #f7c; font-weight: bold', 'color: #999',
            'color: #ff0', v3d.region.state, 'color: #999',
            'color: #0f0', v3d.strum.lastNote, 'color: #999',
            'color: #0f0', v3d.space.macro
          );
          console.table(v3d.strum);
          console.table(v3d.space);
          console.table(v3d.levels);
          console.table(v3d.notes);
        }

        // Cypress Living Wood bow diagnostics (only when Cypress is the scoped region)
        const lwd = scopeId === 1 ? getCypressLivingWoodDiag() : null;
        if (lwd) {
          const cp = lwd.contactPoint;
          const contactLabel = cp > 0.3 ? 'Bright' : cp < -0.3 ? 'Dark' : 'Neutral';
          _log(
            '%c[LivingWood]%c  Mode: %c%s%c  |  Vel: %c%s%c  |  Contact: %c%s (%s)',
            'color: #8f7; font-weight: bold', 'color: #999',
            'color: #ff0', lwd.mode, 'color: #999',
            'color: #0f0', lwd.smoothedVelocity.toFixed(3), 'color: #999',
            'color: #0f0', cp.toFixed(2), contactLabel
          );
          const bowState = {
            velocity:    fix3(lwd.smoothedVelocity),
            bowPosition: fix3(lwd.bowPosition),
            contactPt:   fix3(lwd.contactPoint),
            contact:     contactLabel,
            scordatura:  fix3(lwd.scordaturaPhase),
            gustPhase:   fix3(lwd.gustPhase),
            gustRate:    fix3(lwd.gustRate),
            modIndex:    fix3(lwd.trunkModIndex),
          };
          console.table({ 'BOW STATE': bowState });
          console.table({
            'METERS (dB)': {
              preFx:       fix2(lwd.meters.preFx),
              postLimiter: fix2(lwd.meters.postLimiter),
              earth:       fix2(lwd.meters.earth),
              pad:         fix2(lwd.meters.pad),
              branch:      fix2(lwd.meters.branch),
            },
            'PEAKS': {
              limiterGR:   fix2(lwd.peaks.limiterGR),
              preFx:       fix2(lwd.peaks.preFx),
              postLimiter: fix2(lwd.peaks.postLimiter),
            },
          });
          // Branch voice gains (7 voices)
          const branchRow = {};
          lwd.branchGains.forEach((g, i) => { branchRow[`v${i}`] = fix3(g); });
          console.table({ 'BRANCH GAINS': branchRow });
          // LFO phases
          const lfoRow = {};
          lwd.lfoPhases.forEach((p, i) => { lfoRow[`lfo${i}`] = fix2(p); });
          console.table({ 'LFO PHASES': lfoRow });
          // User params
          console.table({ 'USER PARAMS': lwd.userParams });
          // Portato pulse state
          {
            const pPhase = lwd.portatoPhase || 0;
            const pPulse = Math.pow(Math.sin(pPhase * 0.5), 2);
            const velDepth = Math.min(1.0, lwd.smoothedVelocity * 3.5);
            const fmMul = (1.0 - 0.12 * velDepth) + 0.37 * velDepth * pPulse;
            const foundMul = (1.0 - 0.25 * velDepth) + 0.25 * velDepth * pPulse;
            const branchMul = (1.0 - 0.50 * velDepth) + 0.60 * velDepth * pPulse;
            console.table({ 'PORTATO': {
              phase: fix2(pPhase),
              pulse: fix3(pPulse),
              velDepth: fix3(velDepth),
              fmMul: fix3(fmMul),
              foundationMul: fix3(foundMul),
              branchMul: fix3(branchMul),
            } });
          }
          // Strum accent state (only show when any boost is active)
          if (lwd.strumVelInjection > 0.001) {
            console.table({ 'STRUM ACCENT': { velInject: fix3(lwd.strumVelInjection) } });
          }
        }

        // Celestial Strings diagnostics (only when Stars is the scoped region)
        const csd = scopeId === 5 ? getCelestialStringsDiag() : null;
        if (csd) {
          _log(
            '%c[CelestialStrings]%c  Region: %c%s%c  |  Note: %c%s%c  |  Y(macro): %c%s',
            'color: #c9f; font-weight: bold', 'color: #999',
            'color: #ff0', csd.region.state, 'color: #999',
            'color: #0f0', csd.strum.lastNote, 'color: #999',
            'color: #0f0', csd.space.macro
          );
          console.table(csd.strum);
          console.table(csd.space);
          console.table(csd.levels);
          console.table(csd.dynamics);
          // String voice gains (12 voices)
          const stringRow = {};
          for (const [note, info] of Object.entries(csd.notes)) {
            stringRow[note] = `g=${info.gain} b=${info.strumBoost}`;
          }
          console.table({ 'STRING NOTES': stringRow });
          // LFO phases
          const csLfoRow = {};
          for (const [note, info] of Object.entries(csd.notes)) {
            csLfoRow[note] = `${info.phase} (${info.rate})`;
          }
          console.table({ 'LFO PHASES': csLfoRow });
          console.table({ 'USER PARAMS': csd.userParams });
        }

      }
    }

    // ── Delayed spiral ramp (runs every frame, independent of audio) ──
    if (starVorticesActive) {
      const now = performance.now();
      for (const id of starVortexIds) {
        if (!renderer.isVortexActive(id)) continue;
        const p = renderer.getVortexPresetParams(id);
        if (!p) continue;
        const gCurrent = renderer.getVortexGravityCurrent(id);
        const gTarget = p.gravity;
        let spiralRamp = 0;
        if (gTarget > 0 && gCurrent >= gTarget * 0.90) {
          if (!_spiralDelayReached.has(id)) _spiralDelayReached.set(id, now);
          const elapsed = (now - _spiralDelayReached.get(id)) / 1000;
          const t = Math.min(1.0, elapsed / SPIRAL_DELAY_RAMP);
          spiralRamp = 1 - (1 - t) * (1 - t) * (1 - t); // ease-out cubic
          // Once ramp completes, stop overriding — let user edit sliders freely
          if (t >= 1.0) continue;
        }
        renderer.setVortexArmTightness(id, spiralRamp * p.armTightness);
        renderer.setVortexArmCurl(id, spiralRamp * p.armCurl);
        renderer.setVortexTurbulence(id, spiralRamp * p.curlAmount);
      }
    }

    // ── Mouse speed for flashlight drift ──
    if (flashMouseOnCanvas && prevFlashMouseX >= 0) {
      const dx = flashMouseX - prevFlashMouseX;
      const dy = flashMouseY - prevFlashMouseY;
      const rawSpeed = Math.sqrt(dx * dx + dy * dy);
      // Exponential moving average: 85% old + 15% new for smooth response
      smoothMouseSpeed = smoothMouseSpeed * 0.85 + rawSpeed * 0.15;
    } else {
      // Decay when cursor leaves canvas
      smoothMouseSpeed *= 0.92;
    }
    prevFlashMouseX = flashMouseOnCanvas ? flashMouseX : -1;
    prevFlashMouseY = flashMouseOnCanvas ? flashMouseY : -1;
    // Normalize to 0–1 (0 = still, 1 = fast swipe ~80+ canvas px/frame)
    renderer.setDriftMouseSpeed(Math.min(smoothMouseSpeed / 80.0, 1.0));

    // ── Flashlight: push one position per frame, then upload ──
    // Writing here (once per frame) instead of in mousemove avoids
    // flicker from threshold-gated irregular writes and timestamp clustering.
    if (flashMouseOnCanvas) {
      const base = flashWriteIndex * 4;
      flashTrailBuf[base]     = flashMouseX;
      flashTrailBuf[base + 1] = flashMouseY;
      flashTrailBuf[base + 2] = renderer.getSimTime();
      flashTrailBuf[base + 3] = 1.0;
      flashWriteIndex = (flashWriteIndex + 1) % FLASH_TRAIL_SIZE;
    }
    const cr = getCanvasContentRect();
    const cssToCanvas = glCanvas.width / cr.width;

    // ── Touch trail: active during direct interaction (building/reshaping) or hover expression ──
    if (!renderer.isIntroMode()) {
      let anyActive = false;
      for (let ri = 1; ri <= 5; ri++) {
        if (regionColorState[ri].state === 'active') { anyActive = true; break; }
      }
      const _hoverTrail = exprHoldState && exprHoldState.hoverMode;
      touchTrail.setEnabled((anyActive || _hoverTrail) && !aboutOpen);
      touchTrail.setPaintingInset(renderer.getPaintingMargin());
      // Speed-based opacity: slow=opaque, fast=ghostly
      const speedNorm = Math.min(smoothMouseSpeed / 80.0, 1.0);
      touchTrail.setSpeedAlpha(1.0 - speedNorm * 0.7);  // floor at 30% opacity
      touchTrail.setSpeedWidth(1.0 - speedNorm * 0.5);  // floor at 50% width
      touchTrail.update(dt);
    }

    // ── Ambient edge glow (canvas backlight) ──
    if (!renderer.isIntroMode()) {
      let r = 0, g = 0, b = 0, totalIntensity = 0;
      for (let ri = 1; ri <= 5; ri++) {
        const intensity = regionColorState[ri].intensity;
        if (intensity < 0.001) continue;
        const c = GLOW_COLORS[_isRadiantActive ? 'radiant' : 'nocturne'][ri];
        r += c[0] * intensity;
        g += c[1] * intensity;
        b += c[2] * intensity;
        totalIntensity += intensity;
      }

      // Per-region RMS: pick the loudest active region
      let maxRms = 0;
      for (let ri = 1; ri <= 5; ri++) {
        if (regionColorState[ri].intensity < 0.001) continue;
        try {
          const f = getRegionAudioFeatures(ri);
          if (f && typeof f.rms === 'number' && f.rms > maxRms) maxRms = f.rms;
        } catch (_) {}
      }
      // Fast attack (80% new), very slow release (5% new) — holds peaks, tracks musical dynamics
      _glowRms = maxRms > _glowRms
        ? _glowRms * 0.2 + maxRms * 0.8
        : _glowRms * 0.95 + maxRms * 0.05;
      const rmsMap = Math.min(1.0, Math.sqrt(_glowRms / _glowRmsSensitivity));

      if (totalIntensity > 0.001) {
        // Region(s) active — kill idle breathing immediately.
        // No fade-out needed here: ambient-glow-v2 easing (~800ms) handles
        // the visual transition from idle blue → region color smoothly.
        _idleBreathActive = false;
        _idleBreathFading = false;
        _idleBreathIdleStart = 0;

        const scale = Math.min(1.0, 1.0 / totalIntensity);
        const rmsBright = _glowBrightBase + rmsMap * _glowBrightRms;
        const gr = Math.min(_glowColorCap, r * scale * rmsBright);
        const gg = Math.min(_glowColorCap, g * scale * rmsBright);
        const gb = Math.min(_glowColorCap, b * scale * rmsBright);
        const opacity = _glowOpacityBase + rmsMap * _glowOpacityRms;
        ambientGlow.setColor(gr, gg, gb, opacity);
      } else {
        _glowRms = 0;

        // ── Idle breathing glow ──
        const now = performance.now();
        const cursorMoving = smoothMouseSpeed > 1.2;

        // Cursor activity: start fade-out, reset idle timer
        if (cursorMoving) {
          if (_idleBreathActive && !_idleBreathFading) {
            _idleBreathFading = true;
            _idleBreathFadeStart = now;
          }
          _idleBreathIdleStart = 0;  // reset — 5s restarts from when cursor stops
        }

        // Start idle timer when cursor is still and no regions active
        if (!cursorMoving && !_idleBreathIdleStart) _idleBreathIdleStart = now;

        // Activate breathing after delay (cursor still for 5s)
        if (!_idleBreathActive && !_idleBreathFading && _idleBreathIdleStart
            && (now - _idleBreathIdleStart) >= IDLE_BREATH_DELAY) {
          _idleBreathActive = true;
          _idleBreathFading = false;
          _idleBreathStartTime = now;
          _idleBreathEnvelope = 0;
          _idleBreathFadeOut = 1;
        }

        // Fade-out envelope
        if (_idleBreathFading) {
          _idleBreathFadeOut = Math.max(0, 1.0 - (now - _idleBreathFadeStart) / IDLE_BREATH_FADE_MS);
          if (_idleBreathFadeOut <= 0) {
            _idleBreathActive = false;
            _idleBreathFading = false;
          }
        }

        if (_idleBreathActive) {
          const elapsed = now - _idleBreathStartTime;

          // Ramp-in envelope: 0→1 over first N cycles
          _idleBreathEnvelope = Math.min(elapsed / (IDLE_BREATH_RAMP_CYCLES * IDLE_BREATH_CYCLE), 1.0);

          // Asymmetric cycle: faster inhale, slower exhale (smoothstep)
          const cyclePos = elapsed % IDLE_BREATH_CYCLE;
          let breathT;
          if (cyclePos < IDLE_BREATH_INHALE) {
            const t = cyclePos / IDLE_BREATH_INHALE;
            breathT = t * t * (3.0 - 2.0 * t);
          } else {
            const t = (cyclePos - IDLE_BREATH_INHALE) / IDLE_BREATH_EXHALE;
            breathT = 1.0 - t * t * (3.0 - 2.0 * t);
          }

          const amp = IDLE_BREATH_AMPLITUDE * _idleBreathEnvelope * _idleBreathFadeOut;
          const breathMod = 1.0 + (breathT * 2.0 - 1.0) * amp;  // 0.65 – 1.35
          const opacity = IDLE_BREATH_OPACITY_BASE * breathMod * _idleBreathFadeOut;
          const _idleColor = IDLE_BREATH_COLOR[_isRadiantActive ? 'radiant' : 'nocturne'];
          ambientGlow.setColor(
            _idleColor[0] * breathMod,
            _idleColor[1] * breathMod,
            _idleColor[2] * breathMod,
            opacity
          );
        } else {
          // Not yet breathing (waiting for delay) or fully faded — dark shadow
          ambientGlow.setColor(0, 0, 0, 0.12);
        }
      }
      // WebGL shadow disabled — glow div handles both idle shadow and active glow
      renderer.setShadowOpacity(0);
      ambientGlow.update(aboutOpen, dt);
    }


    // ── Intro center glow bloom (time-based smoothstep) ──
    if (introBloomActive) {
      const t = Math.min((performance.now() - introBloomStart) / INTRO_BLOOM_DURATION, 1.0);
      // smoothstep: slow in, accelerate, slow out
      introProximity = t * t * (3.0 - 2.0 * t);
      renderer.setIntroGlow(introProximity);
      if (t >= 1.0) {
        introBloomActive = false;
        introBloomDone = true;
        lastMouseMoveTime = performance.now(); // reset idle timer after bloom
      }
    }

    // ── Intro vignette breathing (idle invitation) ──
    // Don't breathe once Play is clicked (introSettling = true)
    if (renderer.isIntroMode() && introBloomDone && !introSettling) {
      const now = performance.now();
      const idleMs = now - lastMouseMoveTime;

      if (!breathActive && !breathFading && idleMs >= BREATH_IDLE_DELAY) {
        // Start breathing
        breathActive = true;
        breathFading = false;
        breathStartTime = now;
        breathEnvelope = 0;
        breathFadeOut = 1;
      }

      if (breathActive) {
        const elapsed = now - breathStartTime;

        // Ramp-in envelope: 0→1 over first N cycles
        const rampDuration = BREATH_RAMP_CYCLES * BREATH_CYCLE;
        breathEnvelope = Math.min(elapsed / rampDuration, 1.0);

        // Fade-out envelope when cursor moves
        if (breathFading) {
          breathFadeOut = Math.max(1.0 - (now - breathFadeStart) / BREATH_FADE_MS, 0.0);
          if (breathFadeOut <= 0) {
            breathActive = false;
            breathFading = false;
            renderer.setIntroGlow(1.0); // restore to base
          }
        }

        if (breathActive) {
          // Asymmetric cycle: faster inhale, slower exhale
          const cyclePos = (elapsed % BREATH_CYCLE);
          let breathT;
          if (cyclePos < BREATH_INHALE) {
            // Inhale phase: 0→1 (ease-in-out)
            const t = cyclePos / BREATH_INHALE;
            breathT = t * t * (3.0 - 2.0 * t); // smoothstep
          } else {
            // Exhale phase: 1→0 (ease-in-out)
            const t = (cyclePos - BREATH_INHALE) / BREATH_EXHALE;
            breathT = 1.0 - t * t * (3.0 - 2.0 * t); // inverted smoothstep
          }

          const amplitude = BREATH_AMPLITUDE * breathEnvelope * breathFadeOut;
          const glowValue = 1.0 + (breathT * 2.0 - 1.0) * amplitude;
          renderer.setIntroGlow(glowValue);
        }
      }
    }

    // ── Intro proximity: amplify flashlight near center ──
    let flashRadiusCss = 128;
    let driftAmp = driftAmountPx;
    let driftCap = driftMaxCapPx;
    if (renderer.isIntroMode() && flashMouseOnCanvas) {
      const cx = glCanvas.width * 0.5;
      const cy = glCanvas.height * 0.5;
      const maxDist = Math.sqrt(cx * cx + cy * cy);
      const dist = Math.sqrt((flashMouseX - cx) ** 2 + (flashMouseY - cy) ** 2);
      const proximityTarget = 1.0 - Math.min(dist / maxDist, 1.0);
      introProximity += (proximityTarget - introProximity) * 0.15;
    } else if (introProximity > 0.001) {
      // Ease down from amplified values — covers both cursor-off-canvas and post-intro
      introProximity *= 0.97;
    }
    // Always apply introProximity to values (eases smoothly in all cases)
    if (introProximity > 0.001) {
      flashRadiusCss = 128 + introProximity * 192;
      driftAmp = driftAmountPx + introProximity * 18;
      driftCap = driftMaxCapPx + introProximity * 25;
    }

    renderer.setFlashRadius(flashRadiusCss * cssToCanvas);
    renderer.setFlashTrail(flashTrailBuf);

    // ── Flashlight drift: convert pixel slider values to home-position-space ──
    // Use source image width (not canvas width) so drift stays consistent
    // regardless of canvas resolution (DPR scaling).
    const pxToHome = 1.0 / (_sourceW || glCanvas.width);
    renderer.setDriftAmount(driftAmp * pxToHome);
    renderer.setDriftMaxCap(driftCap * pxToHome);

    // ── Flashlight drift: pass current cursor position (no trail) ──
    // During settling, keep drift active at last cursor position so dance eases out
    // When settling ends, ease driftActive from 1→0 over DRIFT_EASE_MS (no snap)
    if (flashMouseOnCanvas) {
      renderer.setDriftActive(1.0);
      renderer.setDriftCenter(flashMouseX, flashMouseY);
      driftEaseOut = 0; // reset ease-out if cursor returns
    } else if (introSettling && !_isTouchDevice) {
      // Desktop: keep drift active at last cursor position during settling so
      // the dance eases out smoothly. Skip on touch — the finger is gone after
      // Play tap, so force-active would orbit a stale position for the whole
      // reveal. Touch takes the driftEaseOut path instead (set at Play click).
      renderer.setDriftActive(1.0);
    } else if (driftEaseOut > 0) {
      driftEaseOut = Math.max(0, driftEaseOut - dt / DRIFT_EASE_MS);
      const t = driftEaseOut;
      renderer.setDriftActive(t * t * (3.0 - 2.0 * t)); // smoothstep out
    } else {
      renderer.setDriftActive(0.0);
    }
    // Release settling lock once proximity has eased to near-zero
    if (introSettling && introProximity < 0.001) {
      introSettling = false;
      driftEaseOut = 1.0; // begin smooth fade-out
    }

    // ── Hover orbit: two-layer crossfade (layer 0 = active, layer 1 = outgoing) ──
    {
      const still = smoothMouseSpeed < 1.2;
      const now = performance.now();
      const currentRegion = flashMouseOnCanvas
        ? lookupClickRegion(lastMouseClientX, lastMouseClientY)
        : -1;
      const L0 = _hoverLayers[0]; // active/incoming layer
      const L1 = _hoverLayers[1]; // outgoing layer

      // Hover orbit is a per-region discovery tool: it should appear on
      // inactive regions (telling the user they can click here) and NOT on
      // the region whose audio is currently playing. Only the state of the
      // region under the cursor gates hover — other regions' states are
      // irrelevant to this check.
      const cursorRegionState = (currentRegion > 0 && regionColorState[currentRegion])
        ? regionColorState[currentRegion].state
        : 'off';
      const cursorRegionBusy = cursorRegionState === 'active'
        || cursorRegionState === 'on'
        || cursorRegionState === 'fading';
      // _isTouchDevice: hover-to-discover is a mouse-only affordance. Touch
      // devices have no persistent cursor, so the stillness-triggered hover
      // orbit should never fire on them.
      const blocked = _isTouchDevice || !flashMouseOnCanvas || renderer.isIntroMode() || cursorRegionBusy;
      const L0active = L0.region > 0 && L0.easeDir === 1;

      if (!blocked) {
        if (L0active) {
          if (currentRegion === L0.region) {
            // Still in active region — track cursor
            L0.centerX = flashMouseX;
            L0.centerY = flashMouseY;
          } else {
            // Left region — move L0 to L1 (outgoing), freeze orbit direction
            L1.region = L0.region; L1.intensity = L0.intensity;
            L1.easeFrom = L0.intensity; L1.easeDir = -1; L1.easeStart = now;
            L1.centerX = L0.centerX; L1.centerY = L0.centerY;
            L1.freezeTime = renderer.getSimTime();  // freeze orbit at current direction
            L0.region = -1; L0.easeDir = 0; L0.intensity = 0; L0.freezeTime = -1;
            _hoverStillStart = 0;
            _hoverPendingRegion = -1;
          }
        } else if (still && currentRegion > 0) {
          // Waiting for 200ms stillness to activate
          if (_hoverStillStart === 0 || _hoverPendingRegion !== currentRegion) {
            _hoverStillStart = now;
            _hoverPendingRegion = currentRegion;
          }
          if (now - _hoverStillStart >= 200) {
            // Activate on layer 0 — live orbit (not frozen)
            L0.region = currentRegion;
            L0.easeDir = 1; L0.easeFrom = 0; L0.easeStart = now;
            L0.centerX = flashMouseX; L0.centerY = flashMouseY;
            L0.freezeTime = -1;  // live orbit
          }
        } else {
          _hoverStillStart = 0;
          _hoverPendingRegion = -1;
        }
      } else {
        // Blocked — fade out L0 if active, freeze orbit
        if (L0active) {
          L1.region = L0.region; L1.intensity = L0.intensity;
          L1.easeFrom = L0.intensity; L1.easeDir = -1; L1.easeStart = now;
          L1.centerX = L0.centerX; L1.centerY = L0.centerY;
          L1.freezeTime = renderer.getSimTime();
          L0.region = -1; L0.easeDir = 0; L0.intensity = 0; L0.freezeTime = -1;
        }
        _hoverStillStart = 0;
        _hoverPendingRegion = -1;
      }

      // Update each layer's intensity via smoothstep
      for (const L of _hoverLayers) {
        if (L.easeDir === 1) {
          const t = Math.min((now - L.easeStart) / HOVER_EASE_IN_MS, 1.0);
          const s = t * t * t;  // ease-in cubic: zero velocity start, accelerates
          L.intensity = L.easeFrom + (1.0 - L.easeFrom) * s;
        } else if (L.easeDir === -1) {
          const t = Math.min((now - L.easeStart) / HOVER_EASE_OUT_MS, 1.0);
          const s = 1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t);  // ease-out cubic
          L.intensity = L.easeFrom * (1.0 - s);
          if (t >= 1.0) { L.intensity = 0; L.region = -1; L.easeDir = 0; L.freezeTime = -1; }
        }
      }

      // Upload both layers to renderer
      renderer.setHoverHighlight2(
        L0.region, L0.intensity, L0.centerX, L0.centerY, L0.freezeTime,
        L1.region, L1.intensity, L1.centerX, L1.centerY, L1.freezeTime
      );

      // Cursor style: pointer when hovering over a clickable region
      glCanvas.style.cursor = (currentRegion > 0 && flashMouseOnCanvas && !blocked) ? 'pointer' : '';

    }
    _endBR();
  });

  // Helper: convert client coords to world space
  const _worldOut = { x: 0, y: 0 };
  function clientToWorld(clientX, clientY) {
    const { sx, sy } = clientToCanvas(clientX, clientY);
    _worldOut.x = sx; _worldOut.y = sy;
    return _worldOut;
  }

  // Helper: sample territory map at a click position → region ID (0-5)
  // Uses clickRegionMap when available (reclassifies enclosed region 3 → 4).
  function lookupClickRegion(clientX, clientY) {
    if (!segmentationData) return 0;
    const { x, y } = clientToWorld(clientX, clientY);
    const { clickRegionMap, regionMap, width, height } = segmentationData;
    const px = Math.max(0, Math.min(width - 1, Math.floor(x * width)));
    const py = Math.max(0, Math.min(height - 1, Math.floor(y * height)));
    return (clickRegionMap || regionMap)[py * width + px];
  }

  // ── Mouse expression state (all regions) ────────────────────────────────
  let exprHoldState = null;  // { regionId, originX, originY } while holding on any region

  // ── Expression Debug Overlay ─────────────────────────────────────────────
  // Shows real-time X/Y direction + values near cursor on ANY click-hold drag.
  // No activation needed — appears automatically, hides on release.
  // Press D while dragging to copy current values to clipboard.
  // Set to true to re-enable the red expression debug overlay.
  const _exprDebugEnabled = false;
  let _exprDebugEl = null;
  let _exprDebugOriginEl = null;
  let _exprDebugLastData = null;  // stashed for D-key clipboard copy

  function ensureExprDebugOverlay() {
    if (!_exprDebugEnabled) return;
    if (_exprDebugEl) return;

    // Main readout — follows cursor
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:10000',
      'font-family:Consolas,Monaco,monospace', 'font-size:14px', 'font-weight:bold',
      'color:#ff2222', 'background:rgba(0,0,0,0.88)', 'padding:8px 12px',
      'border-radius:4px', 'border:1px solid #ff4444',
      'white-space:pre', 'display:none', 'line-height:1.5',
      'text-shadow:0 0 4px rgba(255,0,0,0.4)',
    ].join(';');
    document.body.appendChild(el);
    _exprDebugEl = el;

    // Origin crosshair — stays at click origin
    const origin = document.createElement('div');
    origin.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:9999',
      'width:20px', 'height:20px', 'display:none',
      'border:2px solid rgba(255,68,68,0.7)', 'border-radius:50%',
      'transform:translate(-50%,-50%)',
      'box-shadow:0 0 6px rgba(255,0,0,0.4)',
    ].join(';');
    const hLine = document.createElement('div');
    hLine.style.cssText = 'position:absolute;top:50%;left:2px;right:2px;height:1px;background:rgba(255,68,68,0.7);transform:translateY(-50%)';
    const vLine = document.createElement('div');
    vLine.style.cssText = 'position:absolute;left:50%;top:2px;bottom:2px;width:1px;background:rgba(255,68,68,0.7);transform:translateX(-50%)';
    origin.appendChild(hLine);
    origin.appendChild(vLine);
    document.body.appendChild(origin);
    _exprDebugOriginEl = origin;
  }

  function updateExprDebugOverlay(clientX, clientY, data) {
    if (!_exprDebugEnabled || !_exprDebugEl) return;
    _exprDebugLastData = data;  // stash for D-key copy
    const { normX, normY, normDistX, normDistY, rawDx, rawDy, regionName, mode, targetSpread } = data;

    // Canvas edge detection
    const cr = getCanvasContentRect();
    const edgePx = 8;
    const nearLeft   = clientX - cr.left < edgePx;
    const nearRight  = cr.left + cr.width - clientX < edgePx;
    const nearTop    = clientY - cr.top < edgePx;
    const nearBottom = cr.top + cr.height - clientY < edgePx;
    const outside    = clientX < cr.left || clientX > cr.left + cr.width ||
                       clientY < cr.top  || clientY > cr.top + cr.height;
    const atXEdge = nearLeft || nearRight || outside;
    const atYEdge = nearTop || nearBottom || outside;

    // Clipped = normalized value hit ±1.0 (expression maxed)
    const xClipped = Math.abs(normX) >= 0.99;
    const yClipped = Math.abs(normY) >= 0.99;

    // Direction labels
    const xDir = normX >= 0 ? 'Right' : 'Left';
    const yDir = normY >= 0 ? 'Up' : 'Down';
    const xAbs = Math.abs(normX);
    const yAbs = Math.abs(normY);

    // Build display
    const lines = [];
    lines.push(`${regionName}  [${mode}]`);
    lines.push('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

    // X line
    let xLine = `X: ${xDir.padEnd(5)} ${xAbs.toFixed(2)}`;
    if (atXEdge)       xLine += '  CANVAS EDGE';
    else if (xClipped) xLine += '  [MAX]';
    lines.push(xLine);

    // Y line
    let yLine = `Y: ${yDir.padEnd(5)} ${yAbs.toFixed(2)}`;
    if (atYEdge)       yLine += '  CANVAS EDGE';
    else if (yClipped) yLine += '  [MAX]';
    lines.push(yLine);

    // Raw drag distance and normalization range
    lines.push(`Drag: ${rawDx > 0 ? '+' : ''}${rawDx}px, ${rawDy > 0 ? '+' : ''}${rawDy}px`);
    lines.push(`Range: X=${Math.round(normDistX)}px  Y=${Math.round(normDistY)}px`);

    // Living Wood extra: crown position, contact point, bow velocity
    if (data.lwBowPosition != null) {
      lines.push('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
      const cp = data.lwBowPosition;
      const zone = cp < 0.33 ? 'Roots' : cp < 0.66 ? 'Trunk' : 'Canopy';
      lines.push(`Crown: ${cp.toFixed(2)}  [${zone}]`);
      const rd = data.lwRootDepth != null ? data.lwRootDepth : 0;
      const bright = rd > 0.3 ? 'Bright' : rd < -0.3 ? 'Dark' : 'Neutral';
      lines.push(`Brightness: ${rd.toFixed(2)}  [${bright}]`);
      const rawV = data.lwDragVelocity != null ? data.lwDragVelocity : 0;
      const smV = data.lwSmoothedVelocity != null ? data.lwSmoothedVelocity : 0;
      const barLen = Math.round(smV * 12);
      const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(12 - barLen);
      lines.push(`Bow:   ${rawV.toFixed(2)} [${bar}] ${smV.toFixed(2)}`);
    }

    // V3 extra: show current note + space macro
    if (data.v3NoteName != null) {
      lines.push('\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
      lines.push(`Note: ${data.v3NoteName}  [${data.v3NoteIndex}]`);
      lines.push(`Y: ${data.v3SpaceMacro != null ? data.v3SpaceMacro.toFixed(2) : '—'}`);
    }

    _exprDebugEl.textContent = lines.join('\n');
    _exprDebugEl.style.display = '';

    // Position: prefer right+above cursor, flip if near screen edge
    const pad = 18;
    let left = clientX + pad;
    let top  = clientY - 110;
    if (left + 300 > window.innerWidth)  left = clientX - 300 - pad;
    if (top < 10)                        top = clientY + pad;
    _exprDebugEl.style.left = left + 'px';
    _exprDebugEl.style.top  = top + 'px';
  }

  function showExprDebugOrigin(clientX, clientY) {
    if (!_exprDebugEnabled) return;
    ensureExprDebugOverlay();
    _exprDebugOriginEl.style.display = '';
    _exprDebugOriginEl.style.left = clientX + 'px';
    _exprDebugOriginEl.style.top  = clientY + 'px';
  }

  function hideExprDebugOverlay() {
    if (!_exprDebugEnabled) return;
    if (_exprDebugEl)       _exprDebugEl.style.display = 'none';
    if (_exprDebugOriginEl) _exprDebugOriginEl.style.display = 'none';
    _exprDebugLastData = null;
  }

  // ── Touch support ──────────────────────────────────────────────────────
  // Track primary touch to ignore multi-touch fingers.
  // Touch handlers call preventDefault() to suppress synthetic mouse events.
  let _primaryTouchId = null;

  /** Extract clientX/Y from a touch matching our primary ID, or null. */
  function _getPrimaryTouch(e, list) {
    if (list == null) list = e.touches;
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === _primaryTouchId) return list[i];
    }
    return null;
  }

  // Double-tap detection (replaces dblclick which doesn't fire reliably on touch)
  let _lastTapTime = 0;
  let _lastTapX = 0;
  let _lastTapY = 0;
  const DOUBLE_TAP_MS = 300;
  function _doubleTapDist() { return Math.max(15, 30 * getCanvasContentRect().width / 1920); }

  glCanvas.addEventListener('mousedown', (e) => {
    if (!renderer || !renderer.isRunning) return;
    if (renderer.isIntroMode()) return;

    // Check if click is within painting content (not letterbox/pillarbox)
    const cr = getCanvasContentRect();
    const normX = (e.clientX - cr.left) / cr.width;
    const normY = (e.clientY - cr.top) / cr.height;
    const inPainting = normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1;
    if (inPainting) {
      mouseDownInPainting = true;
      touchTrail.pointerDown(normX * glCanvas.width, normY * glCanvas.height);
    }

    // ── Region audio — only inside painting content ──
    // Regions 1, 2, 4 (cypress, village, horizon) always activate on click.
    // Regions 0, 3, 5 (background, sky, stars) fall through to star vortex
    // activation in vortex mode; all regions activate audio in region mode.
    if (e.button === 0 && !e.altKey && inPainting) {
      let regionId = lookupClickRegion(e.clientX, e.clientY);

      // All regions (1-5) use the region activation path for audio, expression,
      // and state machine. Stars (5) additionally activates vortex visuals below.
      const useRegionPath = regionId >= 1 && regionId <= 5;

      // ── Flow field: activate when clicking in the swirl region (4) ──
      if (regionId === 4) {
        _flowClickHeld = true;
        renderer.setFlowActive(true);
      }

      if (useRegionPath) {
        e.preventDefault();
        if (window._clickTiming) window._clickTiming.mousedown = performance.now();
        regionMouseDown(regionId);
        _lastActivatedRegion = regionId;
        // Auto-switch Audio Scope to monitor this region
        if (_audioScope && _audioScope.isVisible()) {
          _audioScope.setRegion(regionId);
        }
        // Track click coords for per-region color radial reveal.
        // Must match shader space: gl_FragCoord.xy / u_resolution (0–1, Y=0 at bottom).
        const rect = glCanvas.getBoundingClientRect();
        const clickU = (e.clientX - rect.left) / rect.width;
        const clickV = 1.0 - (e.clientY - rect.top) / rect.height;  // flip Y for WebGL
        if (regionColorState[regionId]) {
          const cs = regionColorState[regionId];
          cs.clickX = clickU;
          cs.clickY = clickV;
          // Pre-activate region color SYNCHRONOUSLY — don't wait for the async
          // onStateChange('building') callback. This closes the visual gap between
          // pulse death (above) and region activation (after await ensureInit).
          // Without this, 1-3 frames render with BOTH color systems dead.
          if (cs.state === 'off' || cs.state === 'fading') {
            cs.state = 'active';
            cs.targetIntensity = 1.0;
            cs.activationTime = performance.now();
            cs.radiusNorm = 0;
          }
        }
        // Activate star vortex visuals (cascade, orbital motion, trails) as add-on.
        // Audio is already handled by regionMouseDown above.
        if (regionId === 5 && !starVorticesActive) {
          const { x: wx, y: wy } = clientToWorld(e.clientX, e.clientY);
          activateStarVortices(wx, wy);
        }
        // Finalize any existing hover expression before starting new drag
        if (exprHoldState && exprHoldState.hoverMode) {
          if (exprHoldState.regionId === 1) _cyRawWindVx = 0;
          setMouseExprActive(exprHoldState.regionId, false);
          glCanvas.style.cursor = '';
        }
        // Mouse expression: capture click origin for drag control (all regions)
        exprHoldState = {
          regionId, originX: e.clientX, originY: e.clientY,
          lastClientX: e.clientX, lastClientY: e.clientY,
          lastMoveTime: performance.now(),
        };
        // Measure distance from click to each canvas edge (computed once, reused every frame).
        // Each direction gets its own range — drag right 300px to edge = 1.0 rightward,
        // drag left 700px to edge = 1.0 leftward. Full expression reachable from any click position.
        // Floor of 30px prevents division-by-near-zero when clicking very close to an edge.
        {
          const cr = getCanvasContentRect();
          const floor = 30;
          exprHoldState.distLeft  = Math.max(floor, e.clientX - cr.left);
          exprHoldState.distRight = Math.max(floor, cr.left + cr.width - e.clientX);
          exprHoldState.distUp    = Math.max(floor, e.clientY - cr.top);
          exprHoldState.distDown  = Math.max(floor, cr.top + cr.height - e.clientY);
        }
        setMouseExprActive(regionId, true);
        // Village: set initial cursor UV + click origin + attraction on mousedown
        if (regionId === 2 && renderer) {
          const w = clientToWorld(e.clientX, e.clientY);
          _vlCursorUV[0] = w.x;
          _vlCursorUV[1] = w.y;
          _vlPrevCursorUV[0] = w.x;  // sync prev to prevent first-frame delta spike
          _vlPrevCursorUV[1] = w.y;
          renderer.setVillageClickOrigin(w.x, w.y);  // anchor for wind transition
          _vlAttractionRaw = 1.0;
        }
        // Debug overlay: show origin crosshair at click point
        showExprDebugOrigin(e.clientX, e.clientY);
        // ── Debug: verify stars routing ──
        if (regionId === 5 && window.__DEBUG) {
          const _d = getRegionDebugState(5);
          _log('%c[Stars MOUSEDOWN]', 'color: #ff0; font-weight: bold');
          console.table(_d);
        }
        return;
      }
    }
  });

  // ── Touch → synthetic mouse dispatch ──────────────────────────────────
  // Touch handlers translate single-finger gestures into MouseEvents so the
  // existing mouse handlers fire unchanged. preventDefault() suppresses the
  // browser's own synthetic mouse events (ghost clicks).

  glCanvas.addEventListener('touchstart', (e) => {
    if (!renderer || !renderer.isRunning) return;
    if (renderer.isIntroMode()) return;
    if (_primaryTouchId !== null) return; // ignore multi-touch
    const touch = e.touches[0];
    _primaryTouchId = touch.identifier;
    e.preventDefault();

    // Update flashlight position immediately (mousemove won't fire until drag)
    const cr = getCanvasContentRect();
    const normX = (touch.clientX - cr.left) / cr.width;
    const normY = (touch.clientY - cr.top) / cr.height;
    if (normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1) {
      flashMouseX = normX * glCanvas.width;
      flashMouseY = (1.0 - normY) * glCanvas.height;
      flashMouseOnCanvas = true;
    }

    // Double-tap detection (replaces dblclick which is unreliable on touch)
    const now = performance.now();
    const dtDx = touch.clientX - _lastTapX;
    const dtDy = touch.clientY - _lastTapY;
    if (now - _lastTapTime < DOUBLE_TAP_MS &&
        dtDx * dtDx + dtDy * dtDy < _doubleTapDist() * _doubleTapDist()) {
      if (pendingVortexPlace) {
        clearTimeout(pendingVortexPlace);
        pendingVortexPlace = null;
      }
      if (!_starStrumTimer) {
        const nxDbl = (touch.clientX - cr.left) / cr.width;
        const nyDbl = (touch.clientY - cr.top) / cr.height;
        if (nxDbl >= 0 && nxDbl <= 1 && nyDbl >= 0 && nyDbl <= 1) {
          const regionId = lookupClickRegion(touch.clientX, touch.clientY);
          if (regionId >= 1 && regionId <= 5) {
            regionStop(regionId);
            _lastTapTime = 0;
            _primaryTouchId = null;
            return;
          }
        }
      }
    }

    // Dispatch synthetic mousedown — existing handler runs the complex state machine
    glCanvas.dispatchEvent(new MouseEvent('mousedown', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
      bubbles: true,
    }));
  }, { passive: false });

  glCanvas.addEventListener('touchmove', (e) => {
    if (_primaryTouchId === null) return;
    const touch = _getPrimaryTouch(e, e.touches);
    if (!touch) return;
    e.preventDefault();
    // Dispatch on glCanvas — bubbles to window, triggering both the flashlight
    // handler (on glCanvas) and expression/vortex drag handler (on window)
    glCanvas.dispatchEvent(new MouseEvent('mousemove', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
    }));
  }, { passive: false });

  glCanvas.addEventListener('touchend', (e) => {
    const touch = _getPrimaryTouch(e, e.changedTouches);
    if (!touch) return;
    e.preventDefault();
    // Record position for double-tap detection
    _lastTapTime = performance.now();
    _lastTapX = touch.clientX;
    _lastTapY = touch.clientY;
    _primaryTouchId = null;
    // Touch lift = no cursor. Kills flashlight drift cleanly on finger release
    // (desktop mouseleave handles this path separately for mouse users).
    flashMouseOnCanvas = false;
    // Dispatch synthetic mouseup on window (matches where mouse handlers listen)
    window.dispatchEvent(new MouseEvent('mouseup', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
      bubbles: true,
    }));
  }, { passive: false });

  glCanvas.addEventListener('touchcancel', (e) => {
    const touch = _getPrimaryTouch(e, e.changedTouches);
    if (!touch) { _primaryTouchId = null; flashMouseOnCanvas = false; return; }
    _primaryTouchId = null;
    flashMouseOnCanvas = false;
    // Treat as release — clean up all held state
    window.dispatchEvent(new MouseEvent('mouseup', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
      bubbles: true,
    }));
  }, { passive: false });

  window.addEventListener('mousemove', (e) => {
    // Mouse expression: forward dx/dy during hold (before vortex guard)
    if (exprHoldState) {
      // Cancel pending star dismiss once drag exceeds threshold — hold+drag = expression, not toggle
      if (_starPendingDismiss && exprHoldState.regionId === 5) {
        const ddx = e.clientX - exprHoldState.originX;
        const ddy = e.clientY - exprHoldState.originY;
        const dragT = Math.max(2, 4 * getCanvasContentRect().width / 1920);
        if (ddx * ddx + ddy * ddy > dragT * dragT) _starPendingDismiss = false;
      }
      // Deferred star expression: activate as soon as audio is ready.
      // playRegion(5) is async — mouseExpr doesn't exist until it resolves.
      // Poll here so expression kicks in on the next mousemove frame.
      if (_starExprDeferred && exprHoldState.regionId === 5) {
        const r5state = getRegionState(5);
        if (r5state === 'looping' || r5state === 'building' || r5state === 'reshaping') {
          setMouseExprActive(5, true);
          _starExprDeferred = false;
        }
      }
      // Four-directional canvas-responsive normDist (all modes, all regions).
      // Each drag direction normalizes against the distance from click origin to that edge,
      // so value reaches exactly 1.0 at the canvas edge regardless of where the user clicked.
      // Distances were precomputed on mousedown and stored in exprHoldState.
      let edgeNormX, edgeNormY;
      if (exprHoldState.distLeft != null) {
        const dx = e.clientX - exprHoldState.originX;
        const dy = e.clientY - exprHoldState.originY;
        // Pick normalization distance based on drag direction
        edgeNormX = dx >= 0 ? exprHoldState.distRight : exprHoldState.distLeft;
        // Screen Y is inverted: negative dy = mouse moved up = positive musical direction
        edgeNormY = dy <= 0 ? exprHoldState.distUp : exprHoldState.distDown;
      }
      // Compute instantaneous drag velocity (px/sec → normalized 0-1)
      const moveNow = performance.now();
      const mdt = (moveNow - exprHoldState.lastMoveTime) / 1000;
      let normSpeed = 0;
      if (mdt > 0.002) {  // guard against sub-2ms spikes
        const vx = (e.clientX - exprHoldState.lastClientX) / mdt;
        const vy = (e.clientY - exprHoldState.lastClientY) / mdt;
        normSpeed = Math.min(1.0, Math.sqrt(vx * vx + vy * vy) / 800);
        // Signed horizontal velocity for cypress wind direction bias
        // Attenuated 0.5x in hover — gentle breeze, not a gust
        if (exprHoldState.regionId === 1) {
          let windBias = Math.max(-1, Math.min(1, vx / 400));
          if (exprHoldState.hoverMode) windBias *= 0.5;
          _cyRawWindVx = windBias;
        }
        // Horizon flow cursor override: convert pixel velocity to UV direction
        if (exprHoldState.regionId === 4) {
          const cr = getCanvasContentRect();
          // Convert px/sec to UV/sec (screen Y flipped for UV space)
          const uvVx = vx / cr.width;
          const uvVy = -vy / cr.height;
          _flowCursorDirRaw[0] = uvVx;
          _flowCursorDirRaw[1] = uvVy;
          const w = clientToWorld(e.clientX, e.clientY);
          _flowCursorUV[0] = w.x;
          _flowCursorUV[1] = w.y;
        }
      }
      // Village: track cursor UV for particle attraction (outside velocity block —
      // updates even when cursor is held still outside the village region)
      if (exprHoldState.regionId === 2 && renderer) {
        const w = clientToWorld(e.clientX, e.clientY);
        _vlCursorUV[0] = w.x;
        _vlCursorUV[1] = w.y;
        _vlAttractionRaw = 1.0;
      }
      exprHoldState.lastClientX = e.clientX;
      exprHoldState.lastClientY = e.clientY;
      exprHoldState.lastMoveTime = moveNow;

      // Attenuate velocity in hover mode (casual cursor, not gestural drag)
      const _isHover = exprHoldState.hoverMode || false;
      if (_isHover) normSpeed *= 0.4;

      const exprResult = setMouseExprDrag(
        exprHoldState.regionId,
        e.clientX - exprHoldState.originX,
        e.clientY - exprHoldState.originY,
        edgeNormX, edgeNormY,
        normSpeed, _isHover
      );
      // Debug overlay: update with live values (all modes, all regions)
      if (exprResult) {
        // Attach four-directional edge distances for debug display
        if (exprHoldState.distLeft != null) {
          exprResult.edgeDist = {
            left: exprHoldState.distLeft, right: exprHoldState.distRight,
            up: exprHoldState.distUp, down: exprHoldState.distDown,
          };
        }
        updateExprDebugOverlay(e.clientX, e.clientY, exprResult);
      }
    }

  });

  let pendingVortexPlace = null;  // timeout ID for deferred vortex placement

  window.addEventListener('mouseup', (e) => {
    touchTrail.pointerUp();
    // Clear painting drag flag and re-evaluate canvas membership
    if (mouseDownInPainting) {
      mouseDownInPainting = false;
      const cr = getCanvasContentRect();
      const nx = (e.clientX - cr.left) / cr.width;
      const ny = (e.clientY - cr.top) / cr.height;
      flashMouseOnCanvas = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    }
    if (e.button === 0) {
      // Skip flow/region deactivation when region is locked (L key)
      if (_regionLockId > 0) {
        // Let audio transition (building → looping) but keep visual activation locked
        regionMouseUp();
        // Keep flow active if swirl region (4) is locked
        if (_regionLockId !== 4) {
          _flowClickHeld = false;
          if (!_isHorizonLooping()) renderer.setFlowActive(false);
        }
        // Keep exprHoldState alive for locked region
        if (exprHoldState && exprHoldState.regionId !== _regionLockId) {
          if (exprHoldState.regionId === 1) _cyRawWindVx = 0;
          if (exprHoldState.regionId === 2) _vlAttractionRaw = 0;
          setMouseExprActive(exprHoldState.regionId, false);
          exprHoldState = null;
          hideExprDebugOverlay();
        }
        _starExprDeferred = false;
        if (_starPendingDismiss) {
          _starPendingDismiss = false;
          if (_starStrumTimer) {
            // Second tap within 300ms — strum!
            clearTimeout(_starStrumTimer);
            _starStrumTimer = null;
            fireStarsStrum();
          }
          // Defer dismiss: if no second tap within 300ms, deactivate
          _starStrumTimer = setTimeout(() => {
            _starStrumTimer = null;
            // Guard: don't dismiss if user is currently holding/dragging
            if (!exprHoldState || exprHoldState.regionId !== 5) {
              starDeactivateAll();
            }
          }, 300);
        }
      } else {
        _flowClickHeld = false;
        // regionMouseUp MUST fire before the flow check — it may transition
        // building→looping, which makes _isHorizonLooping() true.  If the
        // flow check ran first (old order), setFlowActive(false) would fire
        // while state is still 'building', then onStateChange('looping')
        // would immediately call setFlowActive(true) — but fadeOutRegion's
        // 4-second setState('off') timeout would still be pending, snapping
        // intensity from ~0.50 to 0 in one frame (the black flash).
        regionMouseUp();
        if (!_isHorizonLooping()) renderer.setFlowActive(false);
        // Mouse expression: freeze offsets on release OR enter hover mode
        if (exprHoldState) {
          // ── Debug: verify stars routing ──
          if (exprHoldState.regionId === 5 && window.__DEBUG) {
            const _d = getRegionDebugState(5);
            _log('%c[Stars MOUSEUP] state=' + _d?.state, 'color: #0ff; font-weight: bold');
            console.table(_d);
          }
          const _hoverRegionState = getRegionState(exprHoldState.regionId);
          // Enter hover mode if region is now looping, not a star tap-to-dismiss,
          // and this is a real mouse release (not synthetic from touchend).
          // Touch has no hover — after touchend, no mousemove events fire,
          // so expression would stay alive with stale values and evolution would
          // ramp unchecked. e.isTrusted is false for dispatchEvent'd synthetic events.
          if (_hoverRegionState === 'looping' && !_starPendingDismiss && e.isTrusted) {
            exprHoldState.hoverMode = true;
            setMouseExprHover(exprHoldState.regionId, true);
            glCanvas.style.cursor = 'crosshair';
            // Reactivate touch trail for hover — pointerUp already fired above,
            // so restart at last known cursor position
            const _cr = getCanvasContentRect();
            const _tnx = (e.clientX - _cr.left) / _cr.width;
            const _tny = (e.clientY - _cr.top) / _cr.height;
            if (_tnx >= 0 && _tnx <= 1 && _tny >= 0 && _tny <= 1) {
              touchTrail.pointerDown(_tnx * glCanvas.width, _tny * glCanvas.height);
            }
            // Don't call setMouseExprActive — keep live offsets as-is (L-key pattern)
            // Don't zero cypress wind bias or village attraction — cursor still drives them in hover
          } else {
            if (exprHoldState.regionId === 1) _cyRawWindVx = 0;
            if (exprHoldState.regionId === 2) _vlAttractionRaw = 0;
            setMouseExprActive(exprHoldState.regionId, false);
            exprHoldState = null;
            hideExprDebugOverlay();
          }
        }
        _starExprDeferred = false;
        // Star tap-to-dismiss with strum window: first tap defers dismiss 300ms,
        // second tap within window fires strum instead.
        if (_starPendingDismiss) {
          _starPendingDismiss = false;
          if (_starStrumTimer) {
            // Second tap within 300ms — strum!
            clearTimeout(_starStrumTimer);
            _starStrumTimer = null;
            fireStarsStrum();
          }
          // Defer dismiss: if no second tap within 300ms, deactivate
          _starStrumTimer = setTimeout(() => {
            _starStrumTimer = null;
            if (!exprHoldState || exprHoldState.regionId !== 5) {
              starDeactivateAll();
            }
          }, 300);
        }
      }
    }

  });

  // Double-click: stop active region voice, or reset view
  glCanvas.addEventListener('dblclick', (e) => {
    if (!renderer || !renderer.isRunning) return;
    e.preventDefault();
    // Cancel any pending vortex placement from the first click
    if (pendingVortexPlace) {
      clearTimeout(pendingVortexPlace);
      pendingVortexPlace = null;
    }

    // Stop active region voice if double-click lands inside painting
    // Skip for Stars when strum timer is active — rapid clicks are strum, not stop
    if (_starStrumTimer) return;
    const cr = getCanvasContentRect();
    const nxDbl = (e.clientX - cr.left) / cr.width;
    const nyDbl = (e.clientY - cr.top) / cr.height;
    if (nxDbl >= 0 && nxDbl <= 1 && nyDbl >= 0 && nyDbl <= 1) {
      const regionId = lookupClickRegion(e.clientX, e.clientY);
      if (regionId >= 1 && regionId <= 5) {
        regionStop(regionId);
        return;
      }
    }
  });

  // ── Flashlight: track cursor position (ring buffer written in beforeRender) ─
  // When flashLocked=true: follows mouse on canvas, snaps to center when
  // mouse leaves (so you can adjust sidebar sliders and still see the drift).
  glCanvas.addEventListener('mousemove', (e) => {
    const cr = getCanvasContentRect();
    const normX = (e.clientX - cr.left) / cr.width;
    const normY = (e.clientY - cr.top) / cr.height;
    const inContent = normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1;
    // During intro bloom: track position (for reveal origin) but don't activate flashlight
    if (renderer.isIntroMode() && !introBloomDone) {
      if (inContent) {
        flashMouseX = normX * glCanvas.width;
        flashMouseY = (1.0 - normY) * glCanvas.height;
      }
      return;
    }
    flashMouseX = normX * glCanvas.width;
    flashMouseY = (1.0 - normY) * glCanvas.height;   // flip Y for gl_FragCoord
    flashMouseOnCanvas = inContent || mouseDownInPainting;
    lastMouseClientX = e.clientX;
    lastMouseClientY = e.clientY;

    // Touch trail: feed non-Y-flipped canvas coords
    if (!renderer.isIntroMode() && (inContent || mouseDownInPainting)) {
      touchTrail.pointerMove(normX * glCanvas.width, normY * glCanvas.height);
    }

    // Hover whisper disabled for debugging
    // if (segmentationData) {
    //   const hoveredRegion = lookupClickRegion(e.clientX, e.clientY);
  });

  glCanvas.addEventListener('mouseleave', () => {
    // Keep flashMouseOnCanvas alive during drag that originated inside painting
    if (!mouseDownInPainting) {
      flashMouseOnCanvas = false;
      touchTrail.pointerLeave();
    }
  });

  // ── Keyboard shortcuts & capture ──────────────────────────────────────

  // UP arrow — hold to activate flow (same as click-hold on swirl region)
  // Keyboard handler — region toggles + clipboard capture
  document.addEventListener('keydown', async (e) => {
    // About overlay: Escape closes, Tab trapped, all other keys suppressed
    if (aboutOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closeAbout(); }
      if (e.key === 'Tab') {
        const overlay = document.getElementById('about-overlay');
        if (overlay) {
          const focusable = overlay.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
          if (focusable.length) {
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault(); last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault(); first.focus();
            }
          }
        }
      }
      return;
    }

    const key = e.key.toLowerCase();

    // Mood switch is now a toolbar button (see switchMood / Minor-Major pills);
    // the M-key binding was retired on 2026-04-21.

    // Shift+3 (# on US layout) — pop out / pop in Audio Scope (debug only)
    if (key === '#' && !e.ctrlKey && !e.metaKey && location.search.includes('debug')) {
      e.preventDefault();
      if (_audioScope) {
        if (_audioScope.isPoppedOut()) {
          _audioScope.popin();
        } else {
          _audioScope.popout();
        }
      }
      return;
    }

    // 3 key — toggle Audio Scope (debug only, lazy-loaded from js/debug/)
    if (key === '3' && !e.ctrlKey && !e.metaKey && location.search.includes('debug')) {
      e.preventDefault();
      if (!_audioScope) {
        import('./debug/audio-scope.js').then(mod => {
          _audioScope = mod.createAudioScope(document.body);
          _audioScope.resize();
          _audioScope.toggle();
          if (_lastActivatedRegion >= 1 && _lastActivatedRegion <= 5) {
            _audioScope.setRegion(_lastActivatedRegion);
          }
          _log(`%c[Scope]%c  Audio Scope ON (loaded from debug/)`,
            'color: #3cffdb; font-weight: bold', 'color: #999');
        }).catch(e => console.warn('[Scope] Failed to load:', e));
      } else {
        const on = _audioScope.toggle();
        if (on && _lastActivatedRegion >= 1 && _lastActivatedRegion <= 5) {
          _audioScope.setRegion(_lastActivatedRegion);
        }
        _log(`%c[Scope]%c  Audio Scope ${on ? 'ON' : 'OFF'}`,
          'color: #3cffdb; font-weight: bold', 'color: #999');
      }
      return;
    }

    // Backtick (`) — toggle sidebar (gated to ?debug only; sidebar is dev-only)
    if (key === '`' && !e.ctrlKey && !e.metaKey && window.__DEBUG) {
      e.preventDefault();
      const layout = document.querySelector('.app-layout');
      if (layout) {
        layout.classList.toggle('panel-visible');
      }
      // ResizeObserver on glCanvas handles rect invalidation + audio scope resize
      _log('%c[Panels]%c  Sidebar toggled',
        'color: #3cff6e; font-weight: bold', 'color: #999');
      return;
    }


    // V key — cycle debug visualization mode (gated to ?debug only)
    if (key === 'v' && !e.ctrlKey && !e.metaKey && window.__DEBUG && renderer && renderer.isRunning) {
      e.preventDefault();
      const current = renderer.getDebugMode();
      const debugCycle = [0, 4, 5, 6, 7, 8, 9, 10, 12];  // skip removed modes 1-3
      const idx = debugCycle.indexOf(current);
      const next = debugCycle[(idx + 1) % debugCycle.length];
      renderer.setDebugMode(next);
      const labels = { 0: 'OFF', 4: 'flow field', 5: 'region map', 6: 'effective flow speed', 7: 'speed scintillation', 8: 'sky gust', 9: 'cypress sway', 10: 'region overlap', 12: 'click remap' };
      _log(`%c[Debug]%c  Visual debug: ${labels[next]}`, 'color: #f0f; font-weight: bold', 'color: #999');
      return;
    }

  });

  // Load and auto-dither. The live path dithers at canvas resolution for
  // pixel-aligned particles on every device. The hybrid prebake binary
  // (nocturne.data.dvs.br) provides precomputed BFS/curvature data to skip
  // ~700ms of expensive computation; if it fails, the live path computes
  // everything from scratch as a fallback.
  loadDefaultImage();
}
