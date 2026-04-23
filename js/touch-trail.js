/**
 * Touch Trail — tapered polyline that follows the cursor/finger.
 *
 * Creates a 2D canvas overlay and renders a spring-chain trail with
 * lens/leaf width taper. Purely visual — no interaction with WebGL
 * pipeline or region/vortex state.
 */

const POINT_COUNT = 20;
let spring = 0.06;
let friction = 0.85;
let trailLerp = 0.5;
let baseWidth = 16;             // px at widest (head)
let baseAlpha = 0.25;
let fadeDuration = 400;         // ms
let color = [255, 255, 255];   // white
let speedAlpha = 1.0;           // multiplier from mouse speed (1=still, 0=fast)
let speedWidth = 1.0;           // width multiplier from mouse speed

// ── State ────────────────────────────────────────────────────────────────

const points = [];          // {x, y} screen-space positions
const velocity = { x: 0, y: 0 };
let canvas = null;
let ctx = null;
let active = false;         // pointer is down / on canvas
let fading = false;
let fadeStart = 0;
let fadeAlpha = 1;
let lastPointerX = 0;
let lastPointerY = 0;
let initialized = false;
let enabled = false;            // only draw when at least one region is playing
let wasEnabled = false;         // previous frame's enabled state (for edge #5)
let paintingInset = 23;         // px inset from canvas edge (matches gl-renderer paintingMargin)

// Pre-allocated edge vertex buffers (edge case #8: avoid per-frame GC)
const leftEdge = [];
const rightEdge = [];

// ── Init ─────────────────────────────────────────────────────────────────

function init() {
  canvas = document.getElementById('trail-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  for (let i = 0; i < POINT_COUNT; i++) {
    points.push({ x: 0, y: 0 });
    leftEdge.push({ x: 0, y: 0 });
    rightEdge.push({ x: 0, y: 0 });
  }
  initialized = true;
}

// ── Resize (match gl-canvas internal resolution) ─────────────────────────

function resize(width, height) {
  if (!canvas) return;
  canvas.width = width;
  canvas.height = height;
  // Edge case #6: snap chain to last known pointer to avoid stale coords
  _snapAllPoints(lastPointerX, lastPointerY);
}

// ── Pointer events ───────────────────────────────────────────────────────

function pointerDown(x, y) {
  if (!enabled) return;
  _activate(x, y);
}

function pointerMove(x, y) {
  if (!enabled) return;
  if (!active && !fading) {
    // First move without a preceding pointerDown — treat as implicit start
    _activate(x, y);
    return;
  }
  lastPointerX = x;
  lastPointerY = y;
}

function pointerUp() {
  if (!active) return;
  active = false;
  fading = true;
  fadeStart = performance.now();
}

function pointerLeave() {
  // Same as pointerUp — freeze head, let chain collapse
  pointerUp();
}

// ── Internal helpers ─────────────────────────────────────────────────────

function _activate(x, y) {
  active = true;
  fading = false;
  fadeAlpha = 1;
  lastPointerX = x;
  lastPointerY = y;
  _snapAllPoints(x, y);
  velocity.x = 0;
  velocity.y = 0;
}

function _snapAllPoints(x, y) {
  for (let i = 0; i < points.length; i++) {
    points[i].x = x;
    points[i].y = y;
  }
}

// ── Per-frame update (called from beforeRender) ──────────────────────────

function update(dt) {
  if (!initialized || !ctx) return;

  // Edge case #5: region comes back while pointer is on canvas — auto-resume
  if (enabled && !wasEnabled && !active && !fading && lastPointerX > 0) {
    _activate(lastPointerX, lastPointerY);
  }
  wasEnabled = enabled;

  if (!active && !fading) return;

  const now = performance.now();

  // dt is frame-normalized (1.0 = one 60fps frame). Use it directly for
  // frame-rate-independent lerp: 1 - (1 - rate)^dt
  const springFactor = 1 - Math.pow(1 - spring, dt);
  // During fade, ramp up trail lerp so chain collapses faster (absorption feel)
  const effectiveLerp = fading
    ? trailLerp + (1 - trailLerp) * (1 - fadeAlpha) * 0.8  // lerp→~0.9 as fade completes
    : trailLerp;
  const trailFactor = 1 - Math.pow(1 - effectiveLerp, dt);
  const frictionFactor = Math.pow(friction, dt);

  // --- Physics ---
  if (active) {
    // Edge case #7: detect large jumps (tab switch) and snap instead of streak
    const jumpDist = Math.hypot(lastPointerX - points[0].x, lastPointerY - points[0].y);
    if (jumpDist > 200) {
      _snapAllPoints(lastPointerX, lastPointerY);
      velocity.x = 0;
      velocity.y = 0;
    } else {
      // Head: spring toward pointer
      const dx = lastPointerX - points[0].x;
      const dy = lastPointerY - points[0].y;
      velocity.x += dx * springFactor;
      velocity.y += dy * springFactor;
      velocity.x *= frictionFactor;
      velocity.y *= frictionFactor;
      points[0].x += velocity.x;
      points[0].y += velocity.y;
    }
  }
  // Tail: each point lerps toward the one in front
  for (let i = 1; i < POINT_COUNT; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    curr.x += (prev.x - curr.x) * trailFactor;
    curr.y += (prev.y - curr.y) * trailFactor;
  }

  // --- Fade ---
  if (fading) {
    const elapsed = now - fadeStart;
    const t = Math.min(elapsed / fadeDuration, 1);
    // ease-out quadratic
    fadeAlpha = 1 - t * t;
    if (t >= 1) {
      fading = false;
      fadeAlpha = 0;
      _clear();
      return;
    }
  }

  // --- Draw ---
  _draw();
}

// ── Rendering ────────────────────────────────────────────────────────────

function _clear() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function _draw() {
  _clear();

  // Need at least 2 points with some separation to draw
  const head = points[0];
  const tail = points[POINT_COUNT - 1];
  const totalDist = Math.hypot(tail.x - head.x, tail.y - head.y);
  if (totalDist < 1) return;

  // Points are in canvas pixel space (0..width, 0..height). Trail canvas has
  // the same internal resolution and CSS object-fit:contain as gl-canvas, so
  // coordinates map 1:1 — no offset or scaling needed.

  // Build left and right edge vertices for the tapered shape (pre-allocated)
  const dpr = (typeof window._dvs_getEffectiveDpr === 'function')
    ? window._dvs_getEffectiveDpr()
    : (window.devicePixelRatio || 1);
  const widthScale = baseWidth * dpr * speedWidth * fadeAlpha * 0.5;

  for (let i = 0; i < POINT_COUNT; i++) {
    const p = points[i];

    // Taper: lens/leaf shape — narrow at both ends, widest in middle
    // Matches OGL vertex shader: 1.0 - pow(abs(uv.y - 0.5) * 1.9, 2.0)
    const t = i / (POINT_COUNT - 1);
    const taper = 1 - Math.pow(Math.abs(t - 0.5) * 1.9, 2);
    const halfWidth = widthScale * taper;

    // Normal direction: perpendicular to segment tangent
    let nx = 0, ny = -1; // default up if no tangent
    const next = points[Math.min(i + 1, POINT_COUNT - 1)];
    const prev = points[Math.max(i - 1, 0)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty);
    if (len > 0.001) {
      nx = -ty / len;
      ny = tx / len;
    }

    leftEdge[i].x = p.x + nx * halfWidth;
    leftEdge[i].y = p.y + ny * halfWidth;
    rightEdge[i].x = p.x - nx * halfWidth;
    rightEdge[i].y = p.y - ny * halfWidth;
  }

  // Clip trail to match the gl-renderer's paintingMargin (shadow inset).
  // Particles render inside this inset; the margin is for the drop shadow.
  const inset = paintingInset;
  ctx.save();
  ctx.beginPath();
  ctx.rect(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2);
  ctx.clip();

  // Draw smooth shape using bezier curves through edge vertices
  ctx.beginPath();

  // Start at head of left edge
  ctx.moveTo(leftEdge[0].x, leftEdge[0].y);

  // Left edge forward: smooth bezier through midpoints
  for (let i = 0; i < POINT_COUNT - 1; i++) {
    const mx = (leftEdge[i].x + leftEdge[i + 1].x) * 0.5;
    const my = (leftEdge[i].y + leftEdge[i + 1].y) * 0.5;
    ctx.quadraticCurveTo(leftEdge[i].x, leftEdge[i].y, mx, my);
  }
  // Final point on left
  ctx.lineTo(leftEdge[POINT_COUNT - 1].x, leftEdge[POINT_COUNT - 1].y);

  // Cross to right edge at tail
  ctx.lineTo(rightEdge[POINT_COUNT - 1].x, rightEdge[POINT_COUNT - 1].y);

  // Right edge backward: smooth bezier back to head
  for (let i = POINT_COUNT - 1; i > 0; i--) {
    const mx = (rightEdge[i].x + rightEdge[i - 1].x) * 0.5;
    const my = (rightEdge[i].y + rightEdge[i - 1].y) * 0.5;
    ctx.quadraticCurveTo(rightEdge[i].x, rightEdge[i].y, mx, my);
  }
  ctx.closePath();

  const alpha = baseAlpha * fadeAlpha * speedAlpha;
  ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha.toFixed(3)})`;
  ctx.fill();
  ctx.restore();
}

// ── Setters ──────────────────────────────────────────────────────────────

function setSpring(v)       { spring = v; }
function setFriction(v)     { friction = v; }
function setTrailLerp(v)    { trailLerp = v; }
function setBaseWidth(v)    { baseWidth = v; }
function setBaseAlpha(v)    { baseAlpha = v; }
function setFadeDuration(v) { fadeDuration = v; }
function setColor(r, g, b)  { color = [r, g, b]; }
function setSpeedAlpha(v)   { speedAlpha = v; }
function setSpeedWidth(v)   { speedWidth = v; }
function setPaintingInset(v) { paintingInset = v; }

function setEnabled(v) {
  enabled = v;
  if (!v && active) pointerUp();
}

// ── Public API ───────────────────────────────────────────────────────────

export {
  init,
  resize,
  pointerDown,
  pointerMove,
  pointerUp,
  pointerLeave,
  update,
  setSpring,
  setFriction,
  setTrailLerp,
  setBaseWidth,
  setBaseAlpha,
  setFadeDuration,
  setColor,
  setEnabled,
  setSpeedAlpha,
  setSpeedWidth,
  setPaintingInset,
};
