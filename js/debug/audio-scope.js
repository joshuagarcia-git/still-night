/**
 * Audio Scope — Real-time diagnostic overlay for audio→visual mapping.
 *
 * Five panels drawn on a 2D Canvas overlay:
 *   1. Oscilloscope     — raw time-domain waveform (2048 samples)
 *   2. Spectrum          — 64 grouped frequency bars, colored by band
 *   3. Feature Timeline  — 10s/60s scrolling history of rmsNorm / mids / highs / centroid
 *   4. Mapping Output / Level Meters — mapping bars OR DAW-style per-layer meters (Wind Harp)
 *   5. Live Readouts     — numeric values of all six features
 *
 * Toggle with key 3. Zero cost when hidden.
 */

// ── Layout ──────────────────────────────────────────────────────────────────

const SCOPE_HEIGHT = 420;                 // logical px (was 300 — room for mapping panel)
const BG            = 'rgba(10, 10, 14, 0.92)';
const FONT          = "'SF Mono','Consolas','Menlo',monospace";

// Vertical split (fractions of drawable area after readout strip)
const TOP_ROW_FRAC    = 0.28;            // waveform + spectrum share this
const TIMELINE_FRAC   = 0.30;            // feature history
const MAPPING_FRAC    = 0.30;            // mapping output bars (NEW)
const READOUT_H       = 22;              // px, numeric strip at bottom
const PAD             = 8;               // px, inter-panel padding

// ── Waveform ────────────────────────────────────────────────────────────────

const WAVE_LINE       = 'rgba(230,230,230,0.9)';
const WAVE_CENTER     = 'rgba(100,100,100,0.35)';
const WAVE_GLOW       = 'rgba(200,200,255,0.25)';

// ── Spectrum ────────────────────────────────────────────────────────────────

const SPEC_BARS       = 64;              // visual bars (1024 bins / 16)
const SPEC_BASS_END   = 10;              // bars 0-9  → bass  (0–250 Hz)
const SPEC_MID_END    = 45;              // bars 10-44 → mids  (250–2 kHz)
const SPEC_BASS_CLR   = '#3cffdb';       // teal
const SPEC_MID_CLR    = '#ffb83c';       // amber
const SPEC_HIGH_CLR   = '#d03cff';       // purple
const SPEC_DIV        = 'rgba(255,255,255,0.15)';

// ── Feature Timeline ────────────────────────────────────────────────────────

const HISTORY_LEN     = 3600;            // frames (~60 s @ 60 fps)
const SHORT_VIEW      = 600;             // frames (~10 s) — default zoom
// All 10 feature colors — shown in timeline by default
const FEAT_COLORS     = {
  rmsNorm:           '#3cff6e',          // green
  mids:              '#ffb83c',          // amber
  highs:             '#d03cff',          // purple
  centroid:          '#3cffdb',          // cyan
  onset:             '#ff3c3c',          // red
  spread:            '#66ccff',          // light blue
  bass:              '#5599ff',          // blue
  flux:              '#ff6666',          // salmon
  spectralDirection: '#ffff66',          // yellow
  rhythmStrength:    '#ff66cc',          // pink
};
const ALL_FEAT_COLORS = FEAT_COLORS;     // alias for solo-mode lookups
const GRID_LINE       = 'rgba(255,255,255,0.06)';
const GRID_TEXT        = 'rgba(255,255,255,0.30)';

// ── Readout ─────────────────────────────────────────────────────────────────

const READOUT_ITEMS = [
  { key: 'rmsNorm',  label: 'RMS',      color: '#3cff6e' },
  { key: 'mids',     label: 'Mids',     color: '#ffb83c' },
  { key: 'highs',    label: 'Highs',    color: '#d03cff' },
  { key: 'centroid', label: 'Centroid', color: '#3cffdb' },
  { key: 'bass',     label: 'Bass',     color: '#5599ff' },
  { key: 'flux',     label: 'Flux',     color: '#ff6666' },
  // Perceptual features
  { key: 'onset',             label: 'Onset',  color: '#ff3c3c' },
  { key: 'spectralDirection', label: 'Dir',    color: '#ffff66' },
  { key: 'spread',            label: 'Spread', color: '#66ccff' },
  { key: 'rhythmStrength',    label: 'Rhythm', color: '#ff66cc' },
];

// ── Mapping Output ────────────────────────────────────────────────────────

const MAPPING_ITEMS = [
  { key: 'Sky Gust Intensity', short: 'Gust Amp',   tier: 'sky'    },
  { key: 'Sky Drift Distance', short: 'Drift',      tier: 'sky'    },
  { key: 'Cross Sway',         short: 'Cross Sway', tier: 'sky'    },
  { key: 'Star Shimmer',       short: 'Shimmer',    tier: 'sky'    },
  { key: 'Gust Trail',         short: 'Trail',      tier: 'sky'    },
  { key: 'Flow Speed',         short: 'Flow Speed', tier: 'flow'   },
  { key: 'Drift Fraction',     short: 'Drift Frac', tier: 'flow'   },
  { key: 'Gust Intensity',     short: 'Gust Int',   tier: 'flow'   },
  { key: 'Eddy Contrast',      short: 'Eddy',       tier: 'flow'   },
  { key: 'Canvas Deform',      short: 'Deform',     tier: 'deform' },
];

const TIER_COLORS = {
  sky:    '#3cff6e',      // green — matches rmsNorm trace
  flow:   '#ffb83c',      // amber — matches mids trace
  deform: '#d03cff',      // purple — matches highs trace
};

const MAP_BAR_BG   = 'rgba(255,255,255,0.06)';
const MAP_BASE_A   = 0.20;   // opacity for base portion of bar
const MAP_DELTA_A  = 0.80;   // opacity for audio contribution portion

// ── Level Meters (DAW-style) ──────────────────────────────────────────────

const METER_CHANNELS_HARP = [
  { key: 'noise',  label: 'NOISE',  color: '#66ccff' },   // blue
  { key: 'pad',    label: 'PAD',    color: '#ffb83c' },   // amber
  { key: 'harp',   label: 'HARP',   color: '#3cff6e' },   // green
  { key: 'master', label: 'MASTER', color: '#ffffff' },   // white
];
const METER_CHANNELS_CYPRESS = [
  { key: 'earth',  label: 'EARTH',  color: '#8b6914' },   // brown — earth rumble
  { key: 'pad',    label: 'PAD',    color: '#ffb83c' },   // amber — trunk resonance
  { key: 'branch', label: 'BRANCH', color: '#3cff6e' },   // green — overtone branches
  { key: 'master', label: 'MASTER', color: '#ffffff' },   // white — post-limiter
];
const METER_CHANNELS_STARS = [
  { key: 'air',     label: 'AIR',     color: '#99ccff' },   // pale blue — cosmic static
  { key: 'pad',     label: 'PAD',     color: '#ffb83c' },   // amber — glassy pad
  { key: 'strings', label: 'STRINGS', color: '#c9aaff' },   // purple — celestial strings
  { key: 'master',  label: 'MASTER',  color: '#ffffff' },   // white — post-limiter
];
// Default for init — will be switched per-frame based on region
const METER_CHANNELS = METER_CHANNELS_HARP;
const METER_MIN_DB    = -60;     // floor of meter
const METER_MAX_DB    =   6;     // ceiling of meter (shows headroom)
const METER_CLIP_DB   =   0;     // 0 dBFS clip threshold
const METER_WARN_DB   =  -6;     // yellow warning threshold
const METER_BAR_BG    = 'rgba(255,255,255,0.06)';
const METER_PEAK_HOLD = 120;     // frames (~2s @ 60fps) to hold peak indicator

// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create the Audio Scope overlay.
 *
 * @param {HTMLElement} parentEl — element to append the canvas to (usually document.body)
 * @returns {{ toggle, isVisible, update, resize, destroy }}
 */
export function createAudioScope(parentEl) {

  // ── State ───────────────────────────────────────────────────────────────

  let visible = false;
  let dpr     = window.devicePixelRatio || 1;

  // Region switching (1-5)
  let _activeRegion = 4;  // default: Horizon (matches legacy behavior)
  const REGION_LABELS = ['', 'Cypress', 'Village', 'Sky', 'Horizon', 'Stars'];

  // Canvas + context (mutable — swapped during popout/popin)
  let canvas = document.createElement('canvas');
  canvas.className = 'audio-scope-canvas';
  canvas.style.display = 'none';
  canvas.style.cursor = 'pointer';
  parentEl.appendChild(canvas);
  let ctx = canvas.getContext('2d');

  // Pop-out window state
  let _popupWindow = null;
  let _popupCanvas = null;
  let _isPopped = false;
  let _popupPollId = null;
  const _overlayCanvas = canvas;
  let _overlayCtx = ctx;

  // Circular history buffers (Float32Array for perf, zero-initialized)
  const history = {
    rmsNorm:           new Float32Array(HISTORY_LEN),
    mids:              new Float32Array(HISTORY_LEN),
    highs:             new Float32Array(HISTORY_LEN),
    centroid:          new Float32Array(HISTORY_LEN),
    onset:             new Float32Array(HISTORY_LEN),
    spread:            new Float32Array(HISTORY_LEN),
    bass:              new Float32Array(HISTORY_LEN),
    flux:              new Float32Array(HISTORY_LEN),
    spectralDirection: new Float32Array(HISTORY_LEN),
    rhythmStrength:    new Float32Array(HISTORY_LEN),
  };
  let hWriteIdx = 0;
  let hCount    = 0;   // how many entries written so far (caps at HISTORY_LEN)

  // Frame throttle: draw scope at 30fps to halve canvas overhead
  let _drawFrame = 0;

  // Solo feature: click a readout label to isolate its trace in the timeline
  let _soloKey = null;  // null = show all traces, string = show only that feature
  const _readoutHits = [];  // [{ key, x, y, w, h }] — updated each frame by drawReadouts()

  // Timeline view toggle: false = 10s (SHORT_VIEW), true = 60s (full HISTORY_LEN)
  let _longView = false;
  let _timeRangeHit = null;  // { x, y, w, h } — click region for 10s/60s toggle

  // Level meter peak-hold state (per channel) — lazily initialized for any key
  const _meterPeaks = {};     // { channelKey: peakDb }
  const _meterPeakAge = {};   // { channelKey: framesRemaining }

  // Cached meter gradients (avoid per-frame createLinearGradient)
  let _cachedGradients = {};  // { channelKey: { grad, barX, barW } }
  let _gradientDpr = 0;       // invalidate when DPR changes
  for (const ch of [...METER_CHANNELS_HARP, ...METER_CHANNELS_CYPRESS, ...METER_CHANNELS_STARS]) {
    _meterPeaks[ch.key] = -Infinity;
    _meterPeakAge[ch.key] = 0;
  }

  // Click handler for solo-toggle on readout labels + time-range toggle
  function handleScopeClick(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Time-range toggle (10s / 60s button in timeline header)
    if (_timeRangeHit &&
        cx >= _timeRangeHit.x && cx < _timeRangeHit.x + _timeRangeHit.w &&
        cy >= _timeRangeHit.y && cy < _timeRangeHit.y + _timeRangeHit.h) {
      _longView = !_longView;
      return;
    }

    for (const hit of _readoutHits) {
      if (cx >= hit.x && cx < hit.x + hit.w &&
          cy >= hit.y && cy < hit.y + hit.h) {
        // Toggle: click same feature again → unsolo
        _soloKey = (_soloKey === hit.key) ? null : hit.key;
        return;
      }
    }
  }

  // Bind click to overlay canvas
  _overlayCanvas.addEventListener('click', handleScopeClick);

  // Initial sizing
  resize();

  // ── Public API ──────────────────────────────────────────────────────────

  function toggle() {
    if (_isPopped) { popin(); return false; }
    visible = !visible;
    _overlayCanvas.style.display = visible ? 'block' : 'none';
    if (visible) resize();
    return visible;
  }

  function isVisible() { return visible || _isPopped; }

  function setRegion(id) {
    if (id >= 1 && id <= 5 && id !== _activeRegion) {
      _activeRegion = id;
      // Reset meter peak holds so stale peaks from previous region don't linger
      for (const k of Object.keys(_meterPeaks)) {
        _meterPeaks[k] = -Infinity;
        _meterPeakAge[k] = 0;
      }
      // Clear history so old region's traces don't bleed into new one
      for (const buf of Object.values(history)) buf.fill(0);
      hWriteIdx = 0;
      hCount = 0;
    }
  }
  function getRegion() { return _activeRegion; }

  /**
   * Draw one frame. Call from the main render loop.
   *
   * @param {object|null} features — smoothed feature snapshot from getHorizonAudioFeatures()
   * @param {{ freqData: Uint8Array, timeData: Uint8Array }|null} rawAudio
   * @param {object|null} mappingOutput — { label: { eff, base, max } } from updateHorizonAudio()
   * @param {object|null} harpMeters — { noise, pad, harp, master (dB), limiterGR } from getWindHarpMeters()
   */
  function update(features, rawAudio, mappingOutput, harpMeters) {
    if (!visible) return;

    const cw = canvas.width;
    const ch = canvas.height;
    if (cw === 0 || ch === 0) return;

    // ── Push to history every frame (don't lose data) ──────────────────
    if (features) {
      history.rmsNorm[hWriteIdx]           = features.rmsNorm           || 0;
      history.mids[hWriteIdx]              = features.mids              || 0;
      history.highs[hWriteIdx]             = features.highs             || 0;
      history.centroid[hWriteIdx]           = features.centroid          || 0;
      history.onset[hWriteIdx]             = features.onset             || 0;
      history.spread[hWriteIdx]            = features.spread            || 0;
      history.bass[hWriteIdx]              = features.bass              || 0;
      history.flux[hWriteIdx]              = features.flux              || 0;
      history.spectralDirection[hWriteIdx] = features.spectralDirection || 0;
      history.rhythmStrength[hWriteIdx]    = features.rhythmStrength    || 0;
      hWriteIdx = (hWriteIdx + 1) % HISTORY_LEN;
      if (hCount < HISTORY_LEN) hCount++;
    }

    // ── Throttle drawing to 30fps (skip odd frames) ────────────────────
    if (++_drawFrame % 2 !== 0) return;

    // ── Clear ──────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cw, ch);

    // Subtle top border
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0.5);
    ctx.lineTo(cw, 0.5);
    ctx.stroke();

    // ── Active region label + key hint ──────────────────────────────────
    ctx.fillStyle = '#3cffdb';
    ctx.font = `bold ${11 * dpr}px ${FONT}`;
    ctx.fillText(`\u25B8 ${REGION_LABELS[_activeRegion]}  [${_activeRegion}]`, cw - 260 * dpr, 14 * dpr);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `${9 * dpr}px ${FONT}`;
    ctx.fillText(`[ ] cycle`, cw - 80 * dpr, 14 * dpr);

    // ── Layout regions (all in device pixels) ──────────────────────────
    const p  = PAD * dpr;
    const rH = READOUT_H * dpr;
    const drawH  = ch - rH - p;            // total drawable height
    const topH   = drawH * TOP_ROW_FRAC;   // waveform + spectrum row
    const timeH  = drawH * TIMELINE_FRAC;  // timeline row
    const mapH   = drawH * MAPPING_FRAC;   // mapping output bars
    const halfW  = (cw - p * 3) / 2;       // each panel in top row

    const topY   = p;
    const timeY  = topY + topH + p;
    const mapY   = timeY + timeH + p;
    const readY  = mapY + mapH + p;

    // ── Draw panels ────────────────────────────────────────────────────
    drawWaveform(rawAudio?.timeData || null, p, topY, halfW, topH);
    drawSpectrum(rawAudio?.freqData || null, p * 2 + halfW, topY, halfW, topH);
    drawTimeline(p, timeY, cw - p * 2, timeH);
    // Show DAW-style level meters when Wind Harp data is available, else mapping output
    if (harpMeters) {
      drawLevelMeters(harpMeters, p, mapY, cw - p * 2, mapH);
    } else {
      drawMappingOutput(mappingOutput, p, mapY, cw - p * 2, mapH);
    }
    drawReadouts(features, p, readY, cw - p * 2);
  }

  function resize() {
    if (_isPopped) { resizePopup(); return; }
    dpr = window.devicePixelRatio || 1;
    _gradientDpr = 0; // invalidate cached gradients on resize
    _cachedGradients = {};
    const area = document.querySelector('.canvas-area');
    const w = area ? area.clientWidth : window.innerWidth;
    canvas.width         = Math.round(w * dpr);
    canvas.height        = Math.round(SCOPE_HEIGHT * dpr);
    canvas.style.width   = w + 'px';
    canvas.style.height  = SCOPE_HEIGHT + 'px';
  }

  function destroy() {
    if (_isPopped) popin();
    _overlayCanvas.removeEventListener('click', handleScopeClick);
    if (_overlayCanvas.parentNode) _overlayCanvas.parentNode.removeChild(_overlayCanvas);
  }

  // ── Pop-out window ────────────────────────────────────────────────────────

  function popout() {
    if (_isPopped) return;

    const popW = 960, popH = 600;
    const left = Math.round((screen.width - popW) / 2);
    const top  = Math.round((screen.height - popH) / 2);
    _popupWindow = window.open('', 'AudioScope',
      `width=${popW},height=${popH},left=${left},top=${top},resizable=yes`);

    if (!_popupWindow) {
      console.warn('[Scope] Popup blocked by browser');
      return;
    }

    const doc = _popupWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html><head>
<title>Audio Scope</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden;
               background: #0a0a0e; }
  canvas { display: block; width: 100%; height: 100%; }
</style>
</head><body><canvas id="scope"></canvas></body></html>`);
    doc.close();

    _popupCanvas = doc.getElementById('scope');
    const popupCtx = _popupCanvas.getContext('2d');

    // Bind click handler on popup canvas for solo-toggle
    _popupCanvas.addEventListener('click', handleScopeClick);

    // Swap internal references
    canvas = _popupCanvas;
    ctx = popupCtx;

    // Hide overlay, force visible
    _overlayCanvas.style.display = 'none';
    visible = true;

    resizePopup();

    _popupWindow.addEventListener('resize', resizePopup);

    // Poll for popup close (onbeforeunload is unreliable)
    _popupPollId = setInterval(() => {
      if (!_popupWindow || _popupWindow.closed) {
        clearInterval(_popupPollId);
        _popupPollId = null;
        popin();
      }
    }, 500);

    _isPopped = true;
    console.log('%c[Scope]%c  Popped out to external window',
      'color: #3cffdb; font-weight: bold', 'color: #999');
  }

  function popin() {
    if (!_isPopped) return;

    // Restore overlay canvas
    canvas = _overlayCanvas;
    ctx = _overlayCtx;

    // Close popup if still open
    if (_popupWindow && !_popupWindow.closed) {
      _popupWindow.close();
    }
    _popupWindow = null;
    _popupCanvas = null;

    if (_popupPollId) { clearInterval(_popupPollId); _popupPollId = null; }

    // Return to overlay-hidden state
    visible = false;
    _overlayCanvas.style.display = 'none';
    resize();

    _isPopped = false;
    console.log('%c[Scope]%c  Returned to overlay mode',
      'color: #3cffdb; font-weight: bold', 'color: #999');
  }

  function resizePopup() {
    if (!_popupWindow || !_popupCanvas) return;
    dpr = _popupWindow.devicePixelRatio || 1;
    _gradientDpr = 0;
    _cachedGradients = {};
    const w = _popupWindow.innerWidth;
    const h = _popupWindow.innerHeight;
    _popupCanvas.width  = Math.round(w * dpr);
    _popupCanvas.height = Math.round(h * dpr);
    _popupCanvas.style.width  = w + 'px';
    _popupCanvas.style.height = h + 'px';
  }

  // ── Drawing helpers ─────────────────────────────────────────────────────

  function drawWaveform(timeData, x, y, w, h) {
    // Panel label
    drawLabel('WAVEFORM', x, y);

    // Center-line (0-amplitude reference)
    ctx.strokeStyle = WAVE_CENTER;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + h / 2);
    ctx.lineTo(x + w, y + h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!timeData) return;

    // Waveform polyline (decimated to ~512 points — more than enough for display)
    ctx.strokeStyle = WAVE_LINE;
    ctx.lineWidth   = 1.5 * dpr;
    ctx.beginPath();

    const len  = timeData.length;          // 2048
    const skip = Math.max(1, Math.floor(len / 512));
    const step = w / len;
    const mid  = y + h / 2;
    const amp  = h / 2 - 4 * dpr;

    for (let i = 0; i < len; i += skip) {
      const s  = (timeData[i] - 128) / 128;
      const py = mid - s * amp;
      if (i === 0) ctx.moveTo(x, py);
      else         ctx.lineTo(x + i * step, py);
    }
    ctx.stroke();
  }

  function drawSpectrum(freqData, x, y, w, h) {
    drawLabel('SPECTRUM', x, y);

    if (!freqData) return;

    const barW   = w / SPEC_BARS;
    const binsPer = Math.floor(freqData.length / SPEC_BARS);  // 16
    const plotTop = y + 16 * dpr;                               // below label
    const plotH   = h - 16 * dpr;

    for (let i = 0; i < SPEC_BARS; i++) {
      // Average the bins in this bar group
      let sum = 0;
      const start = i * binsPer;
      for (let j = start; j < start + binsPer; j++) sum += freqData[j];
      const avg  = sum / binsPer;
      const barH = (avg / 255) * plotH;

      // Color by frequency band
      ctx.fillStyle =
        i < SPEC_BASS_END ? SPEC_BASS_CLR :
        i < SPEC_MID_END  ? SPEC_MID_CLR  :
                            SPEC_HIGH_CLR;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(
        x + i * barW + 1,
        plotTop + plotH - barH,
        Math.max(1, barW - 2),
        barH,
      );
    }
    ctx.globalAlpha = 1.0;

    // Band boundary dividers
    ctx.strokeStyle = SPEC_DIV;
    ctx.setLineDash([2 * dpr, 3 * dpr]);
    ctx.lineWidth = 1;
    for (const b of [SPEC_BASS_END, SPEC_MID_END]) {
      const bx = x + b * barW;
      ctx.beginPath();
      ctx.moveTo(bx, plotTop);
      ctx.lineTo(bx, plotTop + plotH);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Band labels at dividers
    ctx.fillStyle = GRID_TEXT;
    ctx.font = `${8 * dpr}px ${FONT}`;
    ctx.fillText('250', x + SPEC_BASS_END * barW + 2 * dpr, plotTop + 10 * dpr);
    ctx.fillText('2k',  x + SPEC_MID_END  * barW + 2 * dpr, plotTop + 10 * dpr);
  }

  function drawTimeline(x, y, w, h) {
    const viewLen   = _longView ? HISTORY_LEN : SHORT_VIEW;
    const viewSec   = _longView ? '60 s' : '10 s';
    const soloLabel = _soloKey
      ? (READOUT_ITEMS.find(r => r.key === _soloKey) || {}).label || _soloKey
      : null;
    drawLabel(_soloKey ? `SOLO: ${soloLabel}` : `FEATURES  (${viewSec})`, x, y);

    // ── Time-range toggle button (right side of header) ──
    const btnLabel = _longView ? '60s' : '10s';
    ctx.font = `bold ${9 * dpr}px ${FONT}`;
    const btnTextW = ctx.measureText(btnLabel).width;
    const btnPadX  = 6 * dpr;
    const btnPadY  = 3 * dpr;
    const btnW     = btnTextW + btnPadX * 2;
    const btnH     = 13 * dpr;
    const btnX     = x + w - btnW - 2 * dpr;
    const btnY     = y + 1 * dpr;

    // Button background
    ctx.fillStyle = _longView ? 'rgba(60,255,219,0.15)' : 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    const r = 3 * dpr;
    ctx.roundRect(btnX, btnY, btnW, btnH, r);
    ctx.fill();

    // Button border
    ctx.strokeStyle = _longView ? 'rgba(60,255,219,0.5)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, r);
    ctx.stroke();

    // Button text
    ctx.fillStyle = _longView ? '#3cffdb' : 'rgba(255,255,255,0.6)';
    ctx.fillText(btnLabel, btnX + btnPadX, btnY + btnH - btnPadY);

    // Cache hit region in CSS pixels for click detection
    _timeRangeHit = {
      x: btnX / dpr,
      y: btnY / dpr,
      w: btnW / dpr,
      h: btnH / dpr,
    };

    // Plot area below label (legend lives in the readout strip at the bottom)
    const plotY = y + 16 * dpr;
    const plotH = h - 18 * dpr;

    // Horizontal grid at 25 / 50 / 75 %
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75]) {
      const gy = plotY + plotH * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();

      // Small tick label
      ctx.fillStyle = GRID_TEXT;
      ctx.font = `${7 * dpr}px ${FONT}`;
      ctx.fillText((frac * 100).toFixed(0), x + 2 * dpr, gy - 2 * dpr);
    }

    if (hCount < 2) return;

    // ── Draw feature traces ──
    const viewCount = Math.min(hCount, viewLen);
    const xStep = w / (viewLen - 1);
    const tracesToDraw = _soloKey
      ? [[_soloKey, ALL_FEAT_COLORS[_soloKey] || '#ffffff']]
      : Object.entries(FEAT_COLORS);

    // Decimate long traces: in 60s view, skip every other sample (still 1800 pts)
    const traceSkip = (_longView && viewCount > 900) ? 2 : 1;

    for (const [name, color] of tracesToDraw) {
      const buf = history[name];
      if (!buf) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = _soloKey ? 2.5 * dpr : 1.5 * dpr;
      ctx.globalAlpha = _soloKey ? 1.0 : 0.8;
      ctx.beginPath();

      const isDir = (name === 'spectralDirection');

      for (let i = 0; i < viewCount; i += traceSkip) {
        const rIdx = (hWriteIdx - viewCount + i + HISTORY_LEN) % HISTORY_LEN;
        let val = buf[rIdx];
        if (isDir) val = (val + 1) * 0.5;
        val = Math.max(0, Math.min(1, val));
        const px = x + (viewLen - viewCount + i) * xStep;
        const py = plotY + plotH * (1 - val);
        if (i === 0) ctx.moveTo(px, py);
        else         ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // ── Time axis markers (long view only) ──
    if (_longView && viewCount > SHORT_VIEW) {
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.font = `${7 * dpr}px ${FONT}`;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2 * dpr, 4 * dpr]);

      // Mark every 10s from the right edge
      for (let sec = 10; sec <= 60; sec += 10) {
        const framesBack = sec * 60;  // 60 fps
        if (framesBack > viewCount) break;
        const markerX = x + (viewLen - framesBack) * xStep;

        // Dashed vertical line
        ctx.beginPath();
        ctx.moveTo(markerX, plotY);
        ctx.lineTo(markerX, plotY + plotH);
        ctx.stroke();

        // Time label at bottom
        ctx.fillText(`-${sec}s`, markerX + 2 * dpr, plotY + plotH - 2 * dpr);
      }
      ctx.setLineDash([]);
    }
  }

  function drawMappingOutput(mappingOutput, x, y, w, h) {
    drawLabel('MAPPING OUTPUT', x, y);

    const plotY    = y + 16 * dpr;            // below label
    const plotH    = h - 18 * dpr;
    const rowH     = plotH / MAPPING_ITEMS.length;
    const labelW   = 80 * dpr;               // left label column
    const numericW = 90 * dpr;               // right numeric column
    const barX     = x + labelW;
    const barW     = w - labelW - numericW;

    for (let i = 0; i < MAPPING_ITEMS.length; i++) {
      const item = MAPPING_ITEMS[i];
      const ry   = plotY + i * rowH;
      const barY = ry + 2 * dpr;
      const barH = rowH - 4 * dpr;

      // Read mapping values (fallback to zero when no data)
      const info = mappingOutput ? mappingOutput[item.key] : null;
      const base = info ? info.base : 0;
      const eff  = info ? Math.min(info.max, info.eff) : 0;
      const max  = info ? info.max : 1;

      const baseFrac = max > 0 ? base / max : 0;
      const effFrac  = max > 0 ? eff / max  : 0;
      const tierClr  = TIER_COLORS[item.tier] || '#ffffff';

      // ── Background bar ──
      ctx.fillStyle = MAP_BAR_BG;
      ctx.fillRect(barX, barY, barW, barH);

      // ── Base portion (dim fill) ──
      ctx.fillStyle = tierClr;
      ctx.globalAlpha = MAP_BASE_A;
      ctx.fillRect(barX, barY, baseFrac * barW, barH);

      // ── Audio contribution (bright fill, base → effective) ──
      const deltaW = (effFrac - baseFrac) * barW;
      if (deltaW > 0.5) {
        ctx.globalAlpha = MAP_DELTA_A;
        ctx.fillRect(barX + baseFrac * barW, barY, deltaW, barH);
      }
      ctx.globalAlpha = 1.0;

      // ── Base marker (white hairline) ──
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5 * dpr;
      const markerX = barX + baseFrac * barW;
      ctx.beginPath();
      ctx.moveTo(markerX, barY);
      ctx.lineTo(markerX, barY + barH);
      ctx.stroke();

      // ── Label (left) ──
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `${8 * dpr}px ${FONT}`;
      ctx.fillText(item.short, x + 2 * dpr, ry + rowH * 0.65);

      // ── Numeric (right): effective value + delta % ──
      const delta = base > 0.001
        ? ((eff - base) / base * 100)
        : (eff > 0.001 ? 999 : 0);
      const sign    = delta > 0 ? '+' : '';
      const deltaStr = Math.abs(delta) > 999 ? '+∞' : `${sign}${delta.toFixed(0)}%`;

      // Color the delta text: green for strong, dim for weak
      const intensity = Math.min(1, Math.abs(delta) / 50);
      ctx.fillStyle = delta > 5
        ? tierClr
        : `rgba(255,255,255,${0.3 + intensity * 0.4})`;
      ctx.font = `${8 * dpr}px ${FONT}`;
      ctx.fillText(
        `${eff.toFixed(3)}  ${deltaStr}`,
        barX + barW + 4 * dpr,
        ry + rowH * 0.65,
      );
    }
  }

  // ── DAW-style Level Meters ───────────────────────────────────────────────

  function drawLevelMeters(harpMeters, x, y, w, h) {
    // Pick channel definitions based on which keys the meter object has
    const channels = (harpMeters && 'earth' in harpMeters)
      ? METER_CHANNELS_CYPRESS
      : (harpMeters && 'air' in harpMeters)
        ? METER_CHANNELS_STARS
        : METER_CHANNELS_HARP;
    drawLabel('LEVELS', x, y);

    const plotY  = y + 16 * dpr;
    const plotH  = h - 18 * dpr;
    const numCh  = channels.length;
    const rowH   = plotH / numCh;
    const labelW = 56 * dpr;     // left label column
    const dbLblW = 46 * dpr;     // right dB readout
    const barX   = x + labelW;
    const barW   = w - labelW - dbLblW;

    const dbRange = METER_MAX_DB - METER_MIN_DB;  // 66 dB total

    // dB → fraction across the bar
    function dbFrac(db) {
      return Math.max(0, Math.min(1, (db - METER_MIN_DB) / dbRange));
    }

    // ── dB scale ticks ──
    const ticks = [-48, -36, -24, -12, -6, 0];
    ctx.font = `${7 * dpr}px ${FONT}`;
    for (const db of ticks) {
      const tx = barX + dbFrac(db) * barW;
      // Tick line (full height of meter area)
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx, plotY);
      ctx.lineTo(tx, plotY + plotH);
      ctx.stroke();
      // Tick label (only at top)
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillText(db === 0 ? '0' : `${db}`, tx - 6 * dpr, plotY - 2 * dpr);
    }

    // ── Per-channel meters ──
    for (let i = 0; i < numCh; i++) {
      const ch    = channels[i];
      const rawDb = harpMeters ? harpMeters[ch.key] : -Infinity;
      const db    = isFinite(rawDb) ? rawDb : METER_MIN_DB;
      const frac  = dbFrac(db);
      const ry    = plotY + i * rowH;
      const barY  = ry + 3 * dpr;
      const barH  = rowH - 6 * dpr;

      // ── Peak hold logic ──
      if (db > _meterPeaks[ch.key] || _meterPeakAge[ch.key] <= 0) {
        _meterPeaks[ch.key] = db;
        _meterPeakAge[ch.key] = METER_PEAK_HOLD;
      }
      _meterPeakAge[ch.key]--;
      const peakDb   = _meterPeaks[ch.key];
      const peakFrac = dbFrac(peakDb);

      // ── Background bar ──
      ctx.fillStyle = METER_BAR_BG;
      ctx.fillRect(barX, barY, barW, barH);

      // ── 0 dBFS reference line ──
      const zeroX = barX + dbFrac(0) * barW;
      ctx.strokeStyle = 'rgba(255,80,80,0.35)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(zeroX, barY);
      ctx.lineTo(zeroX, barY + barH);
      ctx.stroke();

      // ── Meter fill — gradient green→yellow→red (cached) ──
      if (frac > 0.001) {
        // Cache gradient per channel — invalidate on resize (DPR/barX/barW change)
        const cacheKey = ch.key;
        let cached = _cachedGradients[cacheKey];
        if (!cached || cached.barX !== barX || cached.barW !== barW || _gradientDpr !== dpr) {
          const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
          grad.addColorStop(0,    ch.color);
          grad.addColorStop(dbFrac(METER_WARN_DB), ch.color);
          grad.addColorStop(dbFrac(0),  '#ffcc00');
          grad.addColorStop(1,          '#ff3333');
          cached = { grad, barX, barW };
          _cachedGradients[cacheKey] = cached;
        }
        ctx.fillStyle = cached.grad;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(barX, barY, frac * barW, barH);
        ctx.globalAlpha = 1.0;
      }

      // ── Peak hold indicator (thin bright line) ──
      if (isFinite(peakDb) && peakDb > METER_MIN_DB + 1) {
        const pkX = barX + peakFrac * barW;
        ctx.strokeStyle = peakDb >= METER_CLIP_DB ? '#ff3333' : 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(pkX, barY + 1);
        ctx.lineTo(pkX, barY + barH - 1);
        ctx.stroke();
      }

      // ── Channel label (left) ──
      ctx.fillStyle = ch.color;
      ctx.globalAlpha = 0.7;
      ctx.font = `bold ${9 * dpr}px ${FONT}`;
      ctx.fillText(ch.label, x + 2 * dpr, ry + rowH * 0.62);
      ctx.globalAlpha = 1.0;

      // ── dB readout (right) ──
      const dbStr = db > METER_MIN_DB + 1 ? db.toFixed(1) : '-∞';
      ctx.fillStyle = db >= METER_CLIP_DB ? '#ff3333'
                    : db >= METER_WARN_DB ? '#ffcc00'
                    : 'rgba(255,255,255,0.6)';
      ctx.font = `${9 * dpr}px ${FONT}`;
      ctx.fillText(dbStr, barX + barW + 4 * dpr, ry + rowH * 0.62);
    }

    // ── Limiter GR indicator (bottom) ──
    if (harpMeters && harpMeters.limiterGR < -0.1) {
      const gr = harpMeters.limiterGR;
      const grText = `GR: ${gr.toFixed(1)} dB`;
      ctx.fillStyle = gr < -6 ? '#ff3333' : '#ffcc00';
      ctx.font = `bold ${9 * dpr}px ${FONT}`;
      ctx.fillText(grText, barX + barW - 90 * dpr, plotY + plotH + 12 * dpr);
    }
    _gradientDpr = dpr; // mark gradients as valid for current DPR
  }

  function drawReadouts(features, x, y, w) {
    ctx.font = `${10 * dpr}px ${FONT}`;
    const spacing = w / READOUT_ITEMS.length;
    _readoutHits.length = 0;  // clear previous frame's hit regions

    for (let i = 0; i < READOUT_ITEMS.length; i++) {
      const item = READOUT_ITEMS[i];
      const val  = features ? (features[item.key] || 0) : 0;
      const isSolo = _soloKey === item.key;
      const isDimmed = _soloKey && !isSolo;

      // Show sign for spectralDirection (ranges −1 to +1)
      const fmt = item.key === 'spectralDirection'
        ? `${item.label}:${val >= 0 ? '+' : ''}${val.toFixed(2)}`
        : `${item.label}: ${val.toFixed(3)}`;

      const rx = x + i * spacing;

      // Solo highlight: underline + brighter; dimmed: lower alpha
      if (isSolo) {
        // Highlight background pill
        const tw = ctx.measureText(fmt).width;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(rx - 2 * dpr, y + 2 * dpr, tw + 4 * dpr, 16 * dpr);
        // Underline
        ctx.fillStyle = item.color;
        ctx.fillRect(rx, y + 17 * dpr, tw, 2 * dpr);
      }

      ctx.globalAlpha = isDimmed ? 0.3 : 1.0;
      ctx.fillStyle = item.color;
      ctx.fillText(fmt, rx, y + 14 * dpr);
      ctx.globalAlpha = 1.0;

      // Cache hit region (in CSS pixels, not device pixels)
      _readoutHits.push({
        key: item.key,
        x: rx / dpr,
        y: y / dpr,
        w: spacing / dpr,
        h: (READOUT_H + 4),
      });
    }

    // ── Envelope state badge ──
    if (features && features.envelopeState) {
      const STATE_COLORS = {
        building:   '#3cff6e',
        sustaining: '#ffb83c',
        releasing:  '#d03cff',
        silent:     '#666666',
      };
      const stateColor = STATE_COLORS[features.envelopeState] || '#666';
      const badgeX = x + w - 120 * dpr;

      ctx.fillStyle = stateColor;
      ctx.font = `bold ${10 * dpr}px ${FONT}`;
      ctx.fillText(features.envelopeState.toUpperCase(), badgeX, y + 14 * dpr);

      // Phase bar
      const phaseBarW = 50 * dpr;
      const phaseBarH = 3 * dpr;
      const phaseBarX = badgeX + 80 * dpr;
      const phaseBarY = y + 8 * dpr;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(phaseBarX, phaseBarY, phaseBarW, phaseBarH);
      ctx.fillStyle = stateColor;
      ctx.fillRect(phaseBarX, phaseBarY, phaseBarW * (features.envelope || 0), phaseBarH);
    }
  }

  // Small panel label helper
  function drawLabel(text, x, y) {
    ctx.fillStyle = GRID_TEXT;
    ctx.font = `bold ${9 * dpr}px ${FONT}`;
    ctx.fillText(text, x + 4 * dpr, y + 11 * dpr);
  }

  // ── Return public API ───────────────────────────────────────────────────

  return { toggle, isVisible, update, resize, destroy, popout, popin, isPoppedOut: () => _isPopped, setRegion, getRegion };
}
