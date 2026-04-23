/**
 * Ambient Edge Glow v2 — multi-layered CSS box-shadow backlight.
 *
 * A position:fixed <div> sits behind the painting, sized to match it.
 * Three concentric box-shadow layers create depth: tight edge light,
 * mid spread, and wide wall wash. GPU-composited, no canvas.
 *
 * Color and opacity set externally (from ui.js region blend + RMS).
 */

// ── State ────────────────────────────────────────────────────────────────

let _div = null;
let _initialized = false;

// Current target color (set per frame by ui.js)
let _targetR = 0, _targetG = 0, _targetB = 0, _targetOpacity = 0;
// Eased color (smooth transition)
let _easedR = 0, _easedG = 0, _easedB = 0, _easedOpacity = 0;
// Cache last applied shadow string to avoid redundant DOM writes
let _lastShadow = '';

// Shadow layer sizes scaled to painting (set by resize)
let _innerBlur = 30, _innerSpread = 5;
let _midBlur = 80, _midSpread = 20;
let _outerBlur = 160, _outerSpread = 50;

// ── Init ─────────────────────────────────────────────────────────────────

function init() {
  _div = document.createElement('div');
  _div.id = 'glow-div';
  document.body.appendChild(_div);
  _initialized = true;
}

// ── Resize ───────────────────────────────────────────────────────────────

function resize(contentRect, insetCSS, borderRadiusCSS) {
  if (!_div || !contentRect) return;
  const m = insetCSS || 0;
  _div.style.left = (contentRect.left + m) + 'px';
  _div.style.top = (contentRect.top + m) + 'px';
  _div.style.width = (contentRect.width - m * 2) + 'px';
  _div.style.height = (contentRect.height - m * 2) + 'px';
  if (borderRadiusCSS !== undefined) {
    _div.style.borderRadius = borderRadiusCSS + 'px';
  }

  // Scale shadow layers relative to painting's shorter dimension
  // Reference: 800px painting → default sizes. Smaller = proportionally smaller.
  const ref = 800;
  const shortSide = Math.min(contentRect.width - m * 2, contentRect.height - m * 2);
  const s = Math.max(0.3, shortSide / ref);  // floor at 30% to stay visible on tiny screens
  _innerBlur = Math.round(18 * s);
  _innerSpread = Math.round(3 * s);
  _midBlur = Math.round(45 * s);
  _midSpread = Math.round(12 * s);
  _outerBlur = Math.round(90 * s);
  _outerSpread = Math.round(30 * s);

  _lastShadow = '';  // force redraw with new sizes
}

// ── Color (called from ui.js per frame) ──────────────────────────────────

function setColor(r, g, b, opacity) {
  _targetR = r;
  _targetG = g;
  _targetB = b;
  _targetOpacity = opacity;
}

// ── Per-frame update ─────────────────────────────────────────────────────

function update(aboutOpen, dt) {
  if (!_initialized || !_div) return;

  if (aboutOpen) {
    _targetOpacity = 0;
  }

  // Slow ease toward target (~800ms settle) — dt is frame-normalized (1.0 = 16.67ms)
  const ease = 1 - Math.pow(0.95, dt);
  _easedR += (_targetR - _easedR) * ease;
  _easedG += (_targetG - _easedG) * ease;
  _easedB += (_targetB - _easedB) * ease;
  _easedOpacity += (_targetOpacity - _easedOpacity) * ease;

  if (_easedOpacity < 0.003) {
    if (_lastShadow !== 'none') {
      _div.style.boxShadow = 'none';
      _lastShadow = 'none';
    }
    return;
  }

  // Desaturate: pull toward luminance by 35%
  const lum = _easedR * 0.299 + _easedG * 0.587 + _easedB * 0.114;
  const desat = 0.35;
  const fr = Math.round((_easedR + (lum - _easedR) * desat) * 255);
  const fg = Math.round((_easedG + (lum - _easedG) * desat) * 255);
  const fb = Math.round((_easedB + (lum - _easedB) * desat) * 255);
  const o = _easedOpacity;

  // Three-layer depth: inner edge, mid spread, outer wash (sizes scaled to painting)
  const shadow =
    `0 0 ${_innerBlur}px ${_innerSpread}px rgba(${fr},${fg},${fb},${(o * 0.50).toFixed(3)}),` +
    `0 0 ${_midBlur}px ${_midSpread}px rgba(${fr},${fg},${fb},${(o * 0.25).toFixed(3)}),` +
    `0 0 ${_outerBlur}px ${_outerSpread}px rgba(${fr},${fg},${fb},${(o * 0.10).toFixed(3)})`;

  if (shadow !== _lastShadow) {
    _div.style.boxShadow = shadow;
    _lastShadow = shadow;
  }
}

// ── Public API ───────────────────────────────────────────────────────────

export { init, resize, setColor, update };
