/**
 * Live runtime performance overlay — ?perfOverlay URL parameter.
 * Shows per-system frame budget breakdown, FPS, and render stats.
 * Works on all devices including mobile (DOM overlay, no dev tools needed).
 */

// ── Timing buckets ──────────────────────────────────────────────────────────

const buckets = {
  starVortexSpeeds: { label: 'Star vortex speeds', sum: 0, count: 0 },
  starVortices:     { label: 'Star vortices',     sum: 0, count: 0 },
  regionColors:     { label: 'Region colors',     sum: 0, count: 0 },
  flowCursor:       { label: 'Flow cursor',       sum: 0, count: 0 },
  starCursor:       { label: 'Star cursor',       sum: 0, count: 0 },
  vortexCursorSpd:  { label: 'Vortex cursor spd', sum: 0, count: 0 },
  nightSkyVisuals:  { label: 'Night Sky visuals', sum: 0, count: 0 },
  nightSkyWake:     { label: 'Night Sky wake',    sum: 0, count: 0 },
  horizonAudio:     { label: 'Horizon audio',     sum: 0, count: 0 },
  cypressAudio:     { label: 'Cypress audio',     sum: 0, count: 0 },
  villageAudio:     { label: 'Village audio',     sum: 0, count: 0 },
  meters:           { label: 'Meters/scope',      sum: 0, count: 0 },
};

let _beforeRenderTotal = { sum: 0, count: 0 };
let _lastAverages = {}; // preserved across resets for snapshot
let _lastBRAvg = 0;
let _enabled = false;
let _panel = null;
let _collapsibleSection = null;
let _fpsLine = null;
let _frameLine = null;
let _renderLine = null;
let _beforeRenderLine = null;
let _bucketLines = {};
let _particleLine = null;
let _regionLine = null;
const REPORT_INTERVAL = 30; // frames between display updates

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Call this to start a timing measurement for a named bucket.
 * Returns a function that, when called, ends the measurement.
 * Usage: const end = perfMark('meters'); doWork(); end();
 */
export function perfMark(name) {
  if (!_enabled) return _noop;
  const t0 = performance.now();
  return () => {
    const elapsed = performance.now() - t0;
    const b = buckets[name];
    if (b) { b.sum += elapsed; b.count++; }
  };
}

function _noop() {}

/**
 * Mark the start of the entire beforeRender callback.
 * Returns end function.
 */
export function perfBeforeRenderStart() {
  if (!_enabled) return _noop;
  const t0 = performance.now();
  return () => {
    _beforeRenderTotal.sum += performance.now() - t0;
    _beforeRenderTotal.count++;
  };
}

/**
 * Receive renderer stats (called from onStatsUpdate callback).
 */
export function perfRendererStats(stats) {
  if (!_enabled || !_panel) return;
  _updateDisplay(stats);
}

let _regionStatesFn = null;

/**
 * Set a callback that returns current region states.
 * Should return an array of { id, name, state } for regions 1-5.
 */
export function perfSetRegionStates(fn) {
  _regionStatesFn = fn;
}

// Running min/max/avg accumulators for snapshot
let _snapshotStats = null;
let _snapshotBuckets = {};

/**
 * Initialize the overlay. Call once from initUI when ?perfOverlay is detected.
 */
export function perfInit() {
  _enabled = true;
  _createPanel();

  // Auto-log snapshot to console every 5 seconds
  setInterval(() => {
    if (!_enabled || !_snapshotStats) return;
    const snap = { timestamp: new Date().toISOString() };
    snap.fps = _snapshotStats.fps;
    snap.frameTime = +_snapshotStats.frameTime.toFixed(1);
    snap.renderTime = +_snapshotStats.renderTime.toFixed(1);
    snap.pointCount = _snapshotStats.pointCount;
    snap.droppedFrames = _snapshotStats.droppedFrames;
    snap.beforeRender = +_lastBRAvg.toFixed(2);
    snap.systems = {};
    for (const [key, avg] of Object.entries(_lastAverages)) {
      snap.systems[buckets[key].label] = +avg.toFixed(2);
    }
    if (_regionStatesFn) {
      const regions = _regionStatesFn();
      const names = ['', 'Cypress', 'Village', 'Sky', 'Horizon', 'Stars'];
      snap.regions = regions.filter(r => r.state !== 'off').map(r => `${names[r.id]}:${r.state}`).join(' ') || 'none';
    }
    // Flatten systems to string for readable console output
    const sysStr = Object.entries(snap.systems).map(([k, v]) => `${k}=${v}ms`).join(', ') || 'none active';
    console.log(
      `%c[Perf]%c FPS:${snap.fps} frame:${snap.frameTime}ms gpu:${snap.renderTime}ms js:${snap.beforeRender}ms | ${sysStr} | regions: ${snap.regions}`,
      'color: #4ade80; font-weight: bold', 'color: #ccc'
    );
  }, 5000);
}

/**
 * Check if perfOverlay is active.
 */
export function perfIsEnabled() {
  return _enabled;
}

// ── Display ─────────────────────────────────────────────────────────────────

function _createPanel() {
  _panel = document.createElement('div');
  // pointer-events: auto so the collapse header is clickable on mobile.
  _panel.style.cssText =
    'position:fixed;top:8px;right:8px;z-index:10000;' +
    'background:rgba(0,0,0,0.85);color:#e0e0e0;' +
    'font:11px/1.5 "SF Mono","Consolas","Monaco",monospace;' +
    'padding:10px 14px;border-radius:6px;pointer-events:auto;' +
    'min-width:240px;backdrop-filter:blur(8px);' +
    '-webkit-backdrop-filter:blur(8px);user-select:none;' +
    '-webkit-user-select:none;touch-action:manipulation;';

  // Header — click/tap to toggle the collapsible section below beforeRender
  const header = document.createElement('div');
  header.style.cssText = 'color:#fff;font-weight:600;margin-bottom:6px;font-size:12px;' +
    'cursor:pointer;display:flex;justify-content:space-between;align-items:center;';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = 'Performance';
  const headerChevron = document.createElement('span');
  headerChevron.textContent = '▾';
  headerChevron.style.cssText = 'color:#888;font-size:10px;transition:transform 120ms;';
  header.appendChild(headerLabel);
  header.appendChild(headerChevron);
  _panel.appendChild(header);

  // ── Always-visible section: FPS, Frame, GPU render, beforeRender, Particles ──
  _fpsLine = _addLine('FPS', '#4ade80');
  _frameLine = _addLine('Frame', '#60a5fa');
  _renderLine = _addLine('GPU render', '#c084fc');
  _beforeRenderLine = _addLine('beforeRender', '#facc15');
  _particleLine = _addLine('Particles', '#888');

  // ── Collapsible section: per-system buckets, regions, GPU diag ──
  const collapsible = document.createElement('div');
  _collapsibleSection = collapsible;

  // Separator
  const sep = document.createElement('hr');
  sep.style.cssText = 'border:none;border-top:1px solid #333;margin:6px 0;';
  collapsible.appendChild(sep);

  // Per-system bucket lines
  for (const [key, b] of Object.entries(buckets)) {
    _bucketLines[key] = _addLine(b.label, '#888', collapsible);
  }

  // Region status
  const sep3 = document.createElement('hr');
  sep3.style.cssText = 'border:none;border-top:1px solid #333;margin:6px 0;';
  collapsible.appendChild(sep3);
  _regionLine = _addLine('Regions', '#888', collapsible);

  // GPU diagnostic test line
  const sep4 = document.createElement('hr');
  sep4.style.cssText = 'border:none;border-top:1px solid #333;margin:6px 0;';
  collapsible.appendChild(sep4);
  _diagLine = _addLine('GPU Diag [G]', '#555', collapsible);
  _diagLine.textContent = 'OFF';

  _panel.appendChild(collapsible);

  // Toggle on header click/tap — hides everything inside `collapsible`.
  // Preference persists across reloads via localStorage so user doesn't
  // have to re-collapse on every load.
  let collapsed = false;
  try { collapsed = localStorage.getItem('perfOverlayCollapsed') === '1'; } catch (_) {}
  const applyCollapsed = () => {
    collapsible.style.display = collapsed ? 'none' : '';
    headerChevron.style.transform = collapsed ? 'rotate(-90deg)' : '';
  };
  applyCollapsed();
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem('perfOverlayCollapsed', collapsed ? '1' : '0'); } catch (_) {}
    applyCollapsed();
  });

  document.body.appendChild(_panel);

  // ── GPU diagnostic keyboard toggle (G key) ──
  // Cycles through bottleneck isolation tests. No console needed.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'g' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    _gpuDiagIdx = (_gpuDiagIdx + 1) % _gpuDiagTests.length;
    _applyGpuDiag();
  });
}

let _diagLine = null;
let _gpuDiagIdx = 0;
const _gpuDiagTests = [
  { name: 'OFF',              particleFrac: null, forceDirect: false },
  { name: 'No composite/FBO', particleFrac: null, forceDirect: true },
  { name: '50% particles',    particleFrac: 0.5,  forceDirect: false },
  { name: '25% particles',    particleFrac: 0.25, forceDirect: false },
  { name: 'No composite + 50% particles', particleFrac: 0.5, forceDirect: true },
];

function _applyGpuDiag() {
  const test = _gpuDiagTests[_gpuDiagIdx];
  window._gpuDiag_particleFrac = test.particleFrac;
  if (test.forceDirect) { window._dvs_forceDirect = true; }
  else { delete window._dvs_forceDirect; }
  if (_diagLine) {
    _diagLine.textContent = test.name;
    _diagLine.style.color = test.name === 'OFF' ? '#555' : '#ff6b6b';
  }
  console.log(`%c[GPU Diag]%c ${test.name}`, 'color: #ff6b6b; font-weight: bold', 'color: #ccc');
}

function _addLine(label, color, parent) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:space-between;gap:16px;';

  const lbl = document.createElement('span');
  lbl.style.color = '#999';
  lbl.textContent = label;

  const val = document.createElement('span');
  val.style.cssText = `color:${color};font-variant-numeric:tabular-nums;`;
  val.textContent = '—';

  row.appendChild(lbl);
  row.appendChild(val);
  (parent || _panel).appendChild(row);

  return val;
}

function _updateDisplay(stats) {
  if (!stats) return;
  _snapshotStats = stats;

  // FPS with color coding
  const fps = stats.fps || 0;
  _fpsLine.textContent = `${fps}`;
  _fpsLine.style.color = fps >= 55 ? '#4ade80' : fps >= 30 ? '#facc15' : '#ef4444';

  // Frame time
  const ft = stats.frameTime || 0;
  _frameLine.textContent = `${ft.toFixed(1)}ms`;
  _frameLine.style.color = ft <= 18 ? '#60a5fa' : ft <= 33 ? '#facc15' : '#ef4444';

  // GPU render time
  const rt = stats.renderTime || 0;
  _renderLine.textContent = `${rt.toFixed(1)}ms`;

  // beforeRender total
  const brAvg = _beforeRenderTotal.count > 0
    ? _beforeRenderTotal.sum / _beforeRenderTotal.count : 0;
  _beforeRenderLine.textContent = `${brAvg.toFixed(1)}ms`;
  _beforeRenderLine.style.color = brAvg <= 4 ? '#facc15' : brAvg <= 8 ? '#fb923c' : '#ef4444';

  // Per-system buckets
  for (const [key, b] of Object.entries(buckets)) {
    const avg = b.count > 0 ? b.sum / b.count : 0;
    const line = _bucketLines[key];
    if (line) {
      if (avg < 0.005) {
        line.textContent = '—';
        line.style.color = '#555';
      } else {
        line.textContent = `${avg.toFixed(2)}ms`;
        line.style.color = avg > 1.0 ? '#fb923c' : avg > 0.3 ? '#facc15' : '#888';
      }
    }
  }

  // Particles
  if (_particleLine && stats.pointCount) {
    _particleLine.textContent = stats.pointCount.toLocaleString();
  }

  // Region states
  if (_regionLine && _regionStatesFn) {
    const regions = _regionStatesFn();
    const names = ['', 'Cy', 'Vi', 'Sk', 'Hz', 'St'];
    const stateColors = { active: '#4ade80', looping: '#60a5fa', building: '#facc15', stopping: '#fb923c', off: '#555' };
    const parts = regions.map(r => {
      const color = stateColors[r.state] || '#555';
      return `<span style="color:${color}">${names[r.id]}</span>`;
    });
    _regionLine.innerHTML = parts.join(' ');
  }

  // Store averages for snapshot before resetting
  _lastBRAvg = brAvg;
  for (const [key, b] of Object.entries(buckets)) {
    const avg = b.count > 0 ? b.sum / b.count : 0;
    if (avg >= 0.005) _lastAverages[key] = avg;
    else delete _lastAverages[key];
  }

  // Reset accumulators
  for (const b of Object.values(buckets)) { b.sum = 0; b.count = 0; }
  _beforeRenderTotal.sum = 0;
  _beforeRenderTotal.count = 0;
}
