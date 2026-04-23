function _log(...args) { if (window.__DEBUG) console.log(...args); }

/**
 * WebGL 2 point cloud renderer with multi-vortex stateless rotation.
 *
 * Each particle has a home position (painting). The vertex shader computes
 * displacement via rotate-then-blend across up to 16 vortices using
 * Biot-Savart kernel weights. NO transform feedback — purely stateless.
 *
 * Optional FBO ping-pong for motion trail persistence.
 */

const NUM_REGIONS = 6;

// ────────────────────────────────────────────────────────────────────────────
// Shader sources
// ────────────────────────────────────────────────────────────────────────────

const RENDER_VERT = `#version 300 es
precision highp float;

// Explicit locations — must match minimal render shader for VAO compatibility
layout(location = 0) in vec2 a_homePos;
layout(location = 1) in vec2 a_spiralPos;
layout(location = 2) in vec3 a_color;
layout(location = 3) in float a_regionId;
layout(location = 4) in float a_boundaryDist;   // 0.0 = inside locked region, positive = distance to nearest boundary
layout(location = 5) in vec2  a_simPos;         // sim-advected position (from transform feedback ping-pong)
// location 6 retired — was a_starBoundary, unimplemented debug viz
layout(location = 7) in float a_coherence;      // brushstroke coherence (0 = isotropic, 1 = directional)
layout(location = 8) in float a_flowAngle;      // brushstroke orientation angle (radians)

uniform float u_pointSize;
uniform float u_aspectRatio;
uniform float u_time;
uniform vec2  u_resolution;        // canvas size in pixels (for streak length calculation)
uniform float u_swell;
uniform float u_wobbleAmt;
uniform float u_trembleAmt;        // boundary tremble strength (0 = off)
uniform float u_trembleFreq;       // boundary tremble frequency (time speed)
uniform sampler2D u_paintingTex;   // original painting for color advection
uniform float u_colorAdvect;       // 0 = static color, 1 = fully advected
uniform sampler2D u_boundaryTex;   // boundary distance field (R16F, 0 = locked)
uniform sampler2D u_flowFieldTex;  // R=strength, G=cos(θ)*0.5+0.5, B=sin(θ)*0.5+0.5
uniform int   u_debugMode;

// Multi-vortex data: xy=center, z=sign, w=strength
uniform vec4 u_vortexData[12];
// Per-vortex params: x=radius, y=speed, z=birthTime, w=armTightness
uniform vec4 u_vortexParams[12];
// Per-vortex art: x=armCurl, y=fadeDuration, z=curlAmount, w=reserved
uniform vec4 u_vortexArt[12];
uniform int  u_vortexCount;

// ── Per-region activation (shared with frag shader) ──
uniform float u_regionActive[5];       // smoothed intensity per region (0=off, 0.5=on, 1.0=active)
uniform vec2  u_regionClickOrigin[5];  // UV click position (0–1, Y=0 at bottom)
uniform float u_regionRadius[5];       // eased radial expansion (0→1, 1=fully expanded)

// ── Star glow (shared with frag shader — same uniform locations) ──
uniform vec2  u_starCenter[12];
uniform float u_starCurrentRadius[12];
uniform float u_starInnerRadius[12];
uniform float u_starScintillation;

// ── Flashlight drift ──
uniform vec4  u_flashTrail[24];      // ring buffer (shared with frag shader)
uniform float u_flashRadius;          // radius in canvas pixels (shared with frag)
uniform float u_flashDecay;           // persistence in seconds (shared with frag)
uniform vec2  u_canvasSize;           // canvas dimensions for screen-space conversion
uniform float u_driftAmount;          // base drift amplitude (home-space units)
uniform float u_driftSpeed;           // noise frequency multiplier
uniform float u_driftMouseSpeed;      // smoothed normalized mouse speed 0–1
uniform float u_driftMouseInfluence;  // mouse speed amplification factor
uniform vec2  u_driftCenter;          // current cursor position in canvas pixels
uniform float u_driftActive;          // 1.0 when cursor on canvas, 0.0 when off
uniform float u_driftMaxCap;          // absolute max displacement (home-space units)

// Hover highlight — two layers for crossfade
uniform float u_hoverRegion0;
uniform float u_hoverIntensity0;
uniform vec2  u_hoverCenter0;
uniform float u_hoverRegion1;
uniform float u_hoverIntensity1;
uniform vec2  u_hoverCenter1;
uniform float u_hoverFreezeTime0;  // -1 = live orbit, >=0 = frozen orbit time (fade-out)
uniform float u_hoverFreezeTime1;
// ── Star cursor bump ──
uniform vec2  u_starCursorUV;       // cursor position in UV space
uniform float u_starCursorInfluence;// 0 = no effect, 1 = full bump
uniform float u_starBumpStrength;   // orbital radius push amount
uniform float u_starPushRadius;     // influence zone as fraction of vortex radius
// Star cursor shimmer (lifecycle removed — shimmer replaces it)

uniform float u_flowDriftFrac;     // fraction of cycle spent drifting (0.3-1.0)
uniform float u_flowCyclePeriod;   // total cycle length in seconds (1.0-15.0)
uniform float u_flowThreshold;     // minimum coherence to participate (0.01-0.50)
uniform float u_flowMaxDrift;     // max UV visual offset from home (0.001-0.02)
uniform vec2  u_flowCursorUV;   // cursor position in UV space (flow override)
uniform vec2  u_flowCursorDir;  // normalized mouse velocity direction in UV space
uniform float u_flowCursorInfluence; // 0 = no override, 1 = full cursor direction
uniform float u_flowCursorRadius;    // influence radius in UV space
uniform float u_flowMix;         // 0 = all visible (no lifecycle), 1 = full cycling
uniform sampler2D u_distPackTex; // RGBA16F: R=flowEdge, G=cypressEdge, B=villageEdge (G4 packed)
uniform float u_flowEdgeDepth;   // depth threshold (pixels) for full drift
uniform float u_flowSpeedFloor;  // minimum speed at max curvature (0.0-1.0)
uniform sampler2D u_flowCurvatureTex; // RG16F: R=curvature, G=eddy energy
uniform float u_gustPeriod;     // gust cycle time in seconds (default 10.0)
uniform float u_gustAmplitude;  // gust intensity 0-0.5 (0 = off, 0.3 = ±30%)
uniform float u_eddyMinScale;   // eddy scale floor for small curls (default 0.6)
uniform float u_eddyMaxScale;   // eddy scale ceiling for large swirls (default 1.6)
uniform float u_canvasDeformAmp; // UV displacement amplitude (0 = off, 0.003 = subtle)
uniform float u_skyGustAmplitude;    // sky gust intensity 0-2.0
uniform float u_skyMaxDrift;         // max sky sway displacement in UV
uniform float u_skySwayAmount;      // cross-wind sway fraction of max drift (0-1)
uniform float u_skyStarShimmer;     // shimmer intensity near stars (0-1)
uniform float u_skyFadeOut;          // 1.0 while region 3 is fading — enables per-particle gate stagger
uniform float u_horizonFadeOut;      // 1.0 while region 4 is fading — enables per-particle gate stagger
// Night Sky cursor wake
uniform vec4  u_nsWakeTrail[20];       // ring buffer (uvX, uvY, birthTime, valid)
uniform vec2  u_nsWakeCursorUV;        // current cursor UV
uniform float u_nsWakeCursorInfluence; // 0-1 eased influence (1.5s build)
uniform float u_nsWakeRadius;          // influence radius in UV space
uniform float u_nsWakeDecay;           // trail decay time in seconds (3.0)
uniform float u_nsWakeGustBoost;      // gust displacement boost fraction (0-1)
uniform float u_nsWakePushStrength;  // radial push displacement (0-0.02 UV)
uniform float u_flowTwinkle;        // audio-driven wind shimmer in flow (0-1)
uniform float u_cypressSwayAmp;     // cypress sway noise intensity 0-2.0
uniform float u_cypressMaxDrift;    // cypress max displacement in UV (0-0.015)
uniform float u_cypressSwayMix;    // eased activation gate (0=off, 1=full sway)
uniform float u_cypressTopY;      // UV Y of treetop (small = near canvas top)
uniform float u_cypressBaseY;     // UV Y of tree base (large = near canvas bottom)
uniform float u_cypressBaseRatio; // fraction of sway at tree base (0=still, 0.5=half)
uniform float u_cypressCrossSway; // cross-sway fraction of max drift (0-1)
uniform float u_cypressBreathPeriod; // breathing cycle length in seconds
uniform float u_cypressSwayAngle;   // per-particle angle spread (0=horizontal, 1=±90°)
uniform float u_cypressEdgeDepth;   // edge constraint zone width in pixels (5-80)

// Village wind sway (grass-in-wind effect for region 2)
uniform float u_villageWindAmp;    // displacement amplitude in UV (0-0.02)
uniform float u_villageWindAngle;  // wind direction in radians
uniform float u_villageSwayAngle;  // per-particle angle scatter (0=uniform, 1=±180°)
uniform float u_villageEdgeDepth;  // edge fade zone width in pixels (0-80)
uniform float u_villageLumParallax; // luminance parallax strength (0=off, 1=full)
uniform float u_villageTwinkle;      // warm twinkle intensity (0=off, 1=full)
uniform float u_villageTwinkleWarmth; // color warmth threshold for eligibility
uniform float u_villageBreathPhase;  // accumulated breathing phase (0-2π, JS-driven)
uniform float u_villageBreathDepth; // breathing depth (0=off, 1=full range)
uniform float u_villageFadeOut;    // 1.0 while region 2 is fading — enables per-particle gate stagger
uniform float u_breatheWave;       // global 25s breathing cycle: 0.7 + 0.3*sin(t*0.2513), JS-computed
uniform float u_villageNoiseAmp;   // wind noise intensity multiplier (0-2)
uniform float u_villageNoiseDrift; // wind noise max displacement in UV (0-0.02)
uniform float u_villageCrossSway;  // cross-wind sway fraction (0-1)
uniform vec2  u_villageWindCenter;    // cursor position in UV space
uniform float u_villageWindRadius;   // influence radius in UV space
uniform float u_villageAttraction;   // attraction strength (0=none, 1=full pull)
uniform float u_villageWindRadiusActive; // blended radius (tight when moving, wide when idle)
uniform float u_villageAttractionAmpActive; // blended strength (boosted when moving)
uniform float u_villageSwarmTime;      // accumulated swarm time (frozen when attraction=0)
uniform float u_swarmCyclePeriodMin;  // fastest cycle (close particles), seconds
uniform float u_swarmCyclePeriodMax;  // slowest cycle (far particles), seconds
// u_swarmDriftFrac removed — superseded by u_swarmDriftFracSmoothed
uniform float u_swarmEarlyDeathPct;   // fraction of particles that die en route (0-1)
uniform float u_swarmDeathFadeWidth;  // softness of death fade (0-0.5)
uniform float u_swarmMaxDriftMul;     // multiplier on attractionAmp for funnel length
uniform float u_swarmFadeIn;          // fade-in width as fraction of drift (0-0.5)
uniform float u_swarmFadeOutStart;    // fade-out start as fraction of drift (0.5-1)
uniform float u_swarmFixedPeriod;    // >0 = all particles use this period (ignores distance), 0 = variable
uniform float u_swarmPhaseSpread;   // 0 = all sync (sharp wave), 1 = fully random (no wave)
uniform float u_swarmLfoSync;      // 1 = lifecycle synced to audio LFO, 0 = use swarm time
uniform float u_villageWindBlend;   // 0 = cursor in village (funnel), 1 = outside (wind) — JS-computed
uniform vec2  u_villageExitPoint;    // cursor UV when it last left the village (ripple center)
uniform float u_villageWindRippleRadius; // expanding participation radius from exit point
uniform float u_swarmDriftFracSmoothed; // JS-smoothed drift fraction (independent from windBlend)
uniform vec2  u_villageClickOrigin;  // UV where user first clicked (anchor for wind transition)
// u_villageEdgeTex and u_cypressEdgeTex packed into u_distPackTex (G4)
uniform float u_cypressCanopyGlow;   // canopy luminance breathing intensity (0 = off)
uniform float u_cypressLeafFlash;   // 1.0 = leaf flash enabled, 0.0 = disabled
uniform float u_cypressRimWidth;    // rim glow zone width in pixels (separate from edge constraint)
uniform float u_cypressRimGlow;     // 1.0 = enabled, 0.0 = disabled (console flag)
uniform sampler2D u_cypressFlowTex;    // RGB8: R=coherence, G=cos(θ), B=sin(θ)
uniform float u_cypressFlowCyclePeriod; // lifecycle period in seconds
uniform float u_cypressFlowDriftFrac;   // visible fraction of lifecycle
uniform float u_cypressFlowMaxDrift;    // max UV displacement
uniform float u_cypressFlowGustAmp;     // gust intensity (0-1)
uniform float u_cypressWindBias;        // horizontal wind direction bias [-1, 1]
uniform float u_introDanceScale;    // global intro dance amplitude (25% of normal)
uniform sampler2D u_regionMapTex;    // R8: region ID per pixel (for edge fade)
uniform float u_absorptionThreshold; // proximity threshold for vortex absorption (default 0.15)

out vec3 v_rawColor;
out vec4 v_vortexPack;   // x=proximity, y=edgeLock, z=fadeAge, w=fadeDuration
out vec4 v_metaPack;     // x=regionId, y=effectiveRegion, z=pointSize, w=particleHash
out vec2 v_homePos;
out vec4 v_skyScintPack; // x=skyGustIntensity, y=scintActivation, z=speedScintActivation, w=coherence
out vec4 v_flowPack;     // x=flowAlpha, y=coherenceSpeed, z=driftScale, w=flowAngle
out vec4 v_cypressPack;  // x=swayIntensity, y=edgeProximity, z=leafFlash, w=rimGlow
out vec4 v_villagePack;  // x=edgeFade, y=twinkle, z=villageSwarmAlpha(1.0!), w=cypressFlowAlpha(1.0!)
out vec4 v_miscPack;     // x=blinkPulse, y=unused, z=unused, w=unused

// ── Noise via pre-computed texture (replaces 30-line Ashima simplex + 3 helpers) ──
// 512×512 RGB16F baked on CPU. R = raw simplex noise. G = ∂n/∂x, B = ∂n/∂y
// (central-difference gradient at eps=0.01). Sampled with GL_REPEAT + LINEAR
// filtering. Removes complex function inlining from D3DCompile analysis.
uniform sampler2D u_noiseTex;
float snoise(vec2 v) {
  return texture(u_noiseTex, v * (1.0 / 64.0)).r * 2.0 - 1.0;
}

// ── Curl of 2D noise field (1 texture fetch via pre-baked gradient) ──
// Returns (∂n/∂y, -∂n/∂x) — the divergence-free 2D curl of scalar noise n.
// In 2D this is the provably minimal form; bitangent noise's advantage is
// 3D-only. Pre-baked gradients replace 4 runtime snoise() finite-difference
// calls with 1 fetch of the G/B channels.
vec2 curlNoise(vec2 p, float t) {
  vec3 grad = texture(u_noiseTex, (p + t) * (1.0 / 64.0)).rgb;
  return vec2(grad.b, -grad.g);
}

// ── G3: Fast atan2 — polynomial approximation (Lagarde) ──
// 14 instructions vs 23-48 for hardware atan. Max error <0.005 rad.
// Intel extended math unit is SIMD2 (8× slower than ALU), so replacing
// atan in the 12-iteration vortex loop saves ~276-576 EM instructions/particle.
float fastAtan2(float y, float x) {
  float ax = abs(x), ay = abs(y);
  float mn = min(ax, ay), mx = max(ax, ay);
  float a = mn / (mx + 1e-8);  // [0, 1], epsilon avoids div-by-zero
  // Minimax polynomial for atan(a) on [0, 1]
  float s = a * a;
  float r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  // Reconstruct full range from quadrant
  if (ay > ax) r = 1.5707963 - r;  // π/2 - r
  if (x < 0.0) r = 3.1415927 - r;  // π - r
  if (y < 0.0) r = -r;
  return r;
}

void main() {
  // ── Edge lock (border particles resist displacement) ──
  float borderThickness = 0.01;
  float edgeDist = min(min(a_homePos.x, 1.0 - a_homePos.x),
                       min(a_homePos.y, 1.0 - a_homePos.y));
  float edgeLock = smoothstep(0.0, borderThickness, edgeDist);

  // ── Region boundary lock (only particles INSIDE locked regions get suppressed) ──
  // a_boundaryDist == 0 → inside locked region → fully locked
  // a_boundaryDist > 0 → outside locked region → free (displacement clamp handles overshoot)
  float regionLock = (a_boundaryDist > 0.0) ? 1.0 : 0.0;
  edgeLock *= regionLock;

  // Phase seed from spiral position (for per-particle variation)
  float phase = a_spiralPos.x * 6.283 + a_spiralPos.y * 6.283;

  // ── Multi-vortex position blending ──
  // Each vortex computes a final position. Positions are weighted-averaged
  // using Biot-Savart kernel weights. This is gap-free because averaging
  // positions always produces a valid intermediate position.
  vec2 blendedPos = vec2(0.0);
  float totalWeight = 0.0;

  // Track max proximity for color reveal + fragment bleed
  float maxProx = 0.0;
  float maxSuppressProx = 0.0;  // wider proximity for gust suppression
  float minDynamicEdgePx = 1e9; // min distance (px) from suppress zone edge — for viscous layer
  float maxProxDist = 0.0;
  float maxProxRadius = 0.0;
  float maxFadeAge = 0.0;       // fade age of dominant inner vortex
  float maxFadeDuration = 1.2;  // fade duration of dominant inner vortex
  float dominantCurlAmount = 0.0; // curlAmount of dominant inner vortex
  int dominantIdx = 0;          // index of dominant vortex (for per-vortex blink variance)

  // Star-to-star absorption: track home vortex for particles in overlap zones.
  // "Home vortex" = closest vortex center to a_homePos.
  // For rid=5: the star this particle belongs to.
  // For rid=0/3/4: the small star that absorbed this particle — if a larger
  // vortex dominates, the small vortex's pull should be suppressed so the
  // absorbed sky/night/horizon particles follow the consuming star too.
  int homeRid = int(a_regionId + 0.5);
  int homeVortexIdx = -1;
  float homeVortexMinDist = 1e9;
  float homeVortexW = 0.0;
  vec2  homeVortexPos = vec2(0.0);
  // Absorption dominance: proximity weighted by radius so larger vortices
  // dominate smaller ones even when the small vortex has higher raw proximity.
  float maxAbsorbProx = 0.0;
  int dominantAbsorbIdx = 0;

  // ── G6: Skip vortex loop for distant particles ──
  // Pre-check: squared distance to each vortex center vs suppress reach (1.6× radius).
  // ~90% of particles are far from all vortices — skip the entire heavy loop for them.
  // Cost: 12 iterations of subtract + dot + compare (~7 ALU each) vs full loop body
  // (~50+ ALU + EM ops including atan, sin, cos, pow per iteration).
  bool _nearAnyVortex = false;
  if (u_vortexCount > 0) {
    for (int i = 0; i < 12; i++) {
      if (i >= u_vortexCount) break;
      vec2 _off = a_homePos - u_vortexData[i].xy;
      _off.x *= u_aspectRatio;
      float _reach = u_vortexParams[i].x * 1.6;  // suppressLimit = radius × 1.6
      if (dot(_off, _off) < _reach * _reach) { _nearAnyVortex = true; break; }
    }
  }

  for (int i = 0; i < 12 && _nearAnyVortex; i++) {
    if (i >= u_vortexCount) break;

    vec2  center_i   = u_vortexData[i].xy;
    float sign_i     = u_vortexData[i].z;
    float strength_i = u_vortexData[i].w;

    // Per-vortex params
    float vortexRadius_i  = u_vortexParams[i].x;  // pre-computed radius
    float speed_i         = u_vortexParams[i].y;   // rotation speed
    float birthTime_i     = u_vortexParams[i].z;   // when this vortex was created
    float fadeAge_i       = u_time - birthTime_i;   // seconds since birth
    float armTightness_i  = u_vortexParams[i].w;   // per-vortex arm compression

    // Per-vortex art params
    float armCurl_i        = u_vortexArt[i].x;     // spiral revolutions
    float fadeDuration_i   = u_vortexArt[i].y;     // per-vortex fade-in duration
    float curlAmount_i     = u_vortexArt[i].z;     // turbulence strength
    float cursorPhase_i    = u_vortexArt[i].w;     // cursor-driven rotation offset (radians)

    // Per-vortex sigma (Biot-Savart regularization)
    float sigma_i = vortexRadius_i * 0.15;
    float sigmaSq_i = sigma_i * sigma_i + 0.0001;

    // Aspect-corrected offset from this vortex center
    vec2 homeOffset = a_homePos - center_i;
    homeOffset.x *= u_aspectRatio;
    float homeDist_i = length(homeOffset);

    // ── Proximity: linear core with soft tail beyond radius ──
    // Extends 20% past the hard radius so all downstream effects
    // (position, size, color, density) fade smoothly instead of snapping.
    float softEdge = 0.20;  // fraction of radius for the outer blend zone
    float outerLimit = vortexRadius_i * (1.0 + softEdge);
    float proximity_i = 0.0;
    if (vortexRadius_i > 0.001) {
      if (homeDist_i <= vortexRadius_i) {
        // Inside core: linear 1.0 → softEdge/(1+softEdge) at boundary
        proximity_i = 1.0 - homeDist_i / outerLimit;
      } else if (homeDist_i < outerLimit) {
        // Soft tail: smoothstep fade from boundary to zero
        float t = (homeDist_i - vortexRadius_i) / (outerLimit - vortexRadius_i);
        proximity_i = (softEdge / (1.0 + softEdge)) * (1.0 - smoothstep(0.0, 1.0, t));
      }
    }

    // ── Suppress proximity: wider zone for gust suppression ──
    // Extends 60% past the hard radius (vs 20% for rotation proximity).
    // Gust fades out BEFORE the rotation edge, creating a smooth transition.
    float suppressEdge = 0.60;
    float suppressLimit = vortexRadius_i * (1.0 + suppressEdge);
    float suppressProx_i = 0.0;
    if (vortexRadius_i > 0.001) {
      if (homeDist_i <= vortexRadius_i) {
        suppressProx_i = 1.0 - homeDist_i / suppressLimit;
      } else if (homeDist_i < suppressLimit) {
        float st = (homeDist_i - vortexRadius_i) / (suppressLimit - vortexRadius_i);
        suppressProx_i = (suppressEdge / (1.0 + suppressEdge)) * (1.0 - smoothstep(0.0, 1.0, st));
      }
    }
    maxSuppressProx = max(maxSuppressProx, suppressProx_i);

    // Dynamic viscous boundary: distance from absorption edge (pixels).
    // outerLimit = radius * 1.2 (the red ring in debug mode 10).
    // Particles at or inside get 0 → driftScale = 0.2. Gradient extends
    // ~25px outward (u_flowEdgeDepth), matching static viscous layer shape.
    if (vortexRadius_i > 0.001) {
      float distFromEdge = max(0.0, homeDist_i - outerLimit);
      float distPx = distFromEdge * max(u_canvasSize.x, u_canvasSize.y);
      minDynamicEdgePx = min(minDynamicEdgePx, distPx);
    }

    // ── Galaxy spiral arm rotation (proximity-gated) ──
    //
    // Gate: skip expensive trig (fastAtan2, cos, sin, spiral compression)
    // when proximity_i == 0. The Biot-Savart weight w (line below) is also
    // zero in that case, so pos_i is multiplied by zero downstream — the
    // expensive result would be discarded anyway. On Intel Iris Plus 645
    // (SIMD-8 vertex shaders), uniform branches are truly skipped, saving
    // ~40+ EM cycles per iteration. With 12 vortices and particles typically
    // near only 1-2, this skips ~85-90% of the loop's heavy math.
    //
    // All tracking variables (maxSuppressProx, homeVortexIdx, maxAbsorbProx,
    // maxProx) depend on proximity_i and homeDist_i, both computed above —
    // they are unaffected by this gate.

    vec2 pos_i;
    if (proximity_i > 0.0) {
    // 1. Polar coordinates of particle relative to vortex center.
    float rNorm = homeDist_i / max(vortexRadius_i, 0.001);
    float particleAngle = fastAtan2(homeOffset.y, homeOffset.x);

    // 2. Arm geometry constants.
    const float ARM_COUNT = 3.0;
    const float ARM_SPACING = 6.283185 / ARM_COUNT;
    const float HALF_SPACING = ARM_SPACING * 0.5;

    // 3. Spiral wind — static curl that defines arm shape (more wind at center).
    float spiralWind = armCurl_i * 6.283185 * (1.0 - clamp(rNorm, 0.0, 1.0));

    // ── STEP A: STATIC ARM STRUCTURE ──
    // Compute each particle's position on a FIXED spiral,
    // independent of time. This defines the shape that never changes.

    // 4. Find where this particle sits in the static spiral pattern.
    //    Subtract spiralWind to align the arms into straight radial slices,
    //    then find offset within the nearest arm slice.
    float staticAngle = particleAngle - spiralWind;
    float sliceOffset = mod(staticAngle + HALF_SPACING, ARM_SPACING) - HALF_SPACING;

    // 5. Compress toward arm spine — this creates the visible arm/gap structure.
    //    Spatial gradient: center particles compress first, edges lag behind.
    //    This makes the spiral appear to tighten from within rather than all at once.
    //    The effect fades as the vortex matures (fadeAge approaches fadeDuration).
    float armYouth = clamp(1.0 - fadeAge_i / max(fadeDuration_i, 0.1), 0.0, 1.0);
    float spatialTightness = armTightness_i * mix(1.0, proximity_i, armYouth * 0.7);
    float armFocus = 1.0 - spatialTightness * 0.98;
    float compressedOffset = sliceOffset * armFocus;

    // 6. Reconstruct the static compressed angle (add spiralWind back).
    //    This is the particle's "home on the spiral" — never changes over time.
    float armAngle = (staticAngle - sliceOffset) + compressedOffset + spiralWind;

    // ── STEP B: FLOW ALONG THE SPIRAL ──
    // Speed only adds uniform rigid rotation — the entire spiral pattern
    // spins as one piece. Inner particles DON'T lap outer ones,
    // so the shape is perfectly preserved at any speed for any duration.

    // 7. Uniform rigid rotation — same angular rate at all radii.
    //    Use (u_time - birthTime) so rotation starts from zero at activation,
    //    preventing mod-boundary jumps when speed ramps from 0 on dormant vortices.
    float wobble = 1.0 + u_wobbleAmt * 0.8 * sin(phase * 7.0 + homeDist_i * 15.0);
    float vortexAge = u_time - birthTime_i;
    float timeRotation = (vortexAge * speed_i * wobble + phase * 0.15) * sign_i + cursorPhase_i;

    // ── STEP C: ANGULAR BLEND (arm-periodic wrapping) ──
    //
    // The mix() blends particleAngle toward targetAngle using armEnvelope.
    // At fractional envelope, particles get fractional rotation — creating
    // differential shear that destroys the spiral at high speed.
    //
    // FIX: Wrap timeRotation to ARM_SPACING (120°) instead of 2π.
    // The 3-arm spiral has 3-fold symmetry, so rotating by ARM_SPACING
    // maps each arm to the next (visually identical). This caps the
    // maximum differential across the envelope gradient to HALF_SPACING
    // (60° = 1.047 rad) — less than one arm width, so the compression
    // easily survives it even at fractional envelope values.

    float armEnvelope = proximity_i * edgeLock;

    // 8. Wrap time rotation to one arm period (120°).
    //    Visually identical due to 3-fold symmetry, but keeps
    //    the mix() differential bounded to < 60°.
    float wrappedRotation = mod(timeRotation, ARM_SPACING);

    // 9. Target angle = compressed arm + bounded rotation.
    float targetAngle = armAngle + wrappedRotation;

    // 10. Blend from home toward spiral position.
    float finalAngle = mix(particleAngle, targetAngle, armEnvelope);

    // 11. Radial inward pull — fixed, independent of speed.
    float pullStrength = armEnvelope * armEnvelope * 0.15;
    float contractedDist = homeDist_i / (1.0 + pullStrength);

    // 12. Reconstruct position (contracted distance, new angle).
    vec2 rotatedOffset = vec2(cos(finalAngle), sin(finalAngle)) * contractedDist;

    // Final position from this vortex (un-correct aspect ratio)
    pos_i = center_i + vec2(rotatedOffset.x / u_aspectRatio, rotatedOffset.y);
    } else {
    // Particle outside this vortex's influence — skip all trig.
    // pos_i is only used in blendedPos += pos_i * w, and w = 0
    // when proximity_i == 0, so this value is never visible.
    pos_i = a_homePos;
    }

    // Biot-Savart kernel weight for position blending (INNER ZONE ONLY).
    // Gate by proximity so particles outside the vortex radius stay exactly
    // at home — prevents subtle displacement rays in the static painting.
    float rSq = dot(homeOffset, homeOffset);
    float w = (proximity_i > 0.0) ? strength_i / (rSq + sigmaSq_i) : 0.0;

    blendedPos += pos_i * w;
    totalWeight += w;

    // Track home vortex: closest vortex center to a_homePos (for absorption suppression)
    if (homeDist_i < homeVortexMinDist) {
      homeVortexMinDist = homeDist_i;
      homeVortexIdx = i;
      homeVortexW = w;
      homeVortexPos = pos_i;
    }

    // Absorption dominance: proximity × radius so larger vortices win
    float weightedProx_i = proximity_i * vortexRadius_i;
    if (weightedProx_i > maxAbsorbProx) {
      maxAbsorbProx = weightedProx_i;
      dominantAbsorbIdx = i;
    }

    // Color reveal: max proximity wins (clean color in overlap zone)
    if (proximity_i > maxProx) {
      maxProx = proximity_i;
      maxProxDist = homeDist_i;
      maxProxRadius = vortexRadius_i;
      maxFadeAge = fadeAge_i;
      maxFadeDuration = fadeDuration_i;
      dominantCurlAmount = curlAmount_i;
      dominantIdx = i;
    }

  }

  // ── Vortex dominance suppression: suppress home vortex when foreign vortex dominates ──
  // Applies to rid=5 (star particles consumed by a larger star) AND rid=0/3/4
  // (sky/night/horizon particles absorbed by a small star whose gravity well
  // is inside a larger star's well). Cypress (1) and village (2) are never
  // in vortex gravity wells, so they're excluded.
  // Remove the home vortex's contribution so the particle cleanly follows the
  // consuming vortex instead of being in a tug-of-war.
  bool canSuppress = (homeRid == 5 || homeRid == 0 || homeRid == 3 || homeRid == 4);
  if (canSuppress && homeVortexIdx >= 0 && dominantAbsorbIdx != homeVortexIdx) {
    // Only suppress if remaining weight is sufficient to pull the particle.
    // Otherwise the particle snaps to a_homePos, leaving a visible ring artifact.
    float remainingWeight = totalWeight - homeVortexW;
    if (remainingWeight > 0.0001) {
      blendedPos -= homeVortexPos * homeVortexW;
      totalWeight = remainingWeight;
    }
  }

  // ── Final position: weighted average of per-vortex positions ──
  vec2 pos;
  if (u_vortexCount > 0 && totalWeight > 0.0001) {
    pos = blendedPos / totalWeight;
  } else {
    pos = a_homePos;
  }

  // ── Proximity for color reveal ──
  float proximity = maxProx;
  float homeDist = maxProxDist;

  // ── Effective region: vortex absorption ──
  // When a particle is inside a star vortex's gravity well, it becomes
  // "part of the star" for all visual/behavioral decisions.
  // Only absorbable regions: 0 (bg), 3 (night sky), 4 (horizon).
  // Cypress (1) and village (2) are never absorbed. Stars (5) are already star.
  float effectiveRegion = a_regionId;
  bool absorbable = (homeRid == 0 || homeRid == 3 || homeRid == 4);
  float absorptionThreshold = u_absorptionThreshold;
  if (absorbable && proximity > absorptionThreshold) {
    // Binary flip — region IDs are discrete, can't be interpolated.
    // mix(3.0, 5.0, 0.5) = 4.0 which rounds to horizon, not star.
    effectiveRegion = 5.0;
  }

  // Sky gust unification: low-coherence region 4 particles behave as region 3
  // (Night Sky) for all downstream systems — dance, flow gate, hover, color.
  // Mirrors the click remap (April 5) which reclassified these for click routing.
  // Without this, Horizon activation displaces sky gust particles.
  if (int(effectiveRegion + 0.5) == 4) {
    float sgCoherence = texture(u_flowFieldTex, a_homePos).r;
    if (sgCoherence < 0.25) effectiveRegion = 3.0;
  }

  // ── Curl noise turbulence (only inside active vortex) ──
  if (dominantCurlAmount > 0.0 && proximity > 0.0) {
    vec2 noisePos = pos * 8.0;              // spatial frequency
    float timeOffset = u_time * 0.3;        // slow organic drift
    vec2 curl = curlNoise(noisePos, timeOffset);
    pos += curl * dominantCurlAmount * proximity * edgeLock;
  }

  // ── Cursor bump: push particles away from cursor ──
  // Speed-scaled in JS (still = gentle, fast = strong) so no void forms.
  // Per-particle scatter for organic feel.
  float starPushRadius = maxProxRadius * u_starPushRadius;
  if (u_starCursorInfluence > 0.001 && u_regionActive[4] > 0.01 && proximity > 0.001 && starPushRadius > 0.001) {
    vec2 awayFromCursor = pos - u_starCursorUV;
    awayFromCursor.x *= u_aspectRatio;
    float dist = length(awayFromCursor);
    if (dist > 0.001) {
      vec2 pushDir = awayFromCursor / dist;
      float localPush = smoothstep(starPushRadius, 0.0, dist);
      float bumpGuard = smoothstep(0.0, 0.15, proximity);
      // Per-particle scatter: some resist more, others flow easily (0.6–1.4)
      float starPushScatter = 0.6 + fract(sin(dot(a_homePos, vec2(53.71, 197.23))) * 31847.3) * 0.8;
      float pushAmount = localPush * u_starBumpStrength * bumpGuard * u_starCursorInfluence * starPushScatter;
      // Scale displacement gently with star size so larger stars push more
      float starSizeScale = 0.5 + 0.5 * smoothstep(0.03, 0.15, maxProxRadius);
      pos += vec2(pushDir.x / u_aspectRatio, pushDir.y) * pushAmount * starSizeScale;
    }
  }

  // ── Star cursor shimmer: smooth scintillation near cursor ──
  // Same pattern as Night Sky wake — all particles pulse, no sparse selection.
  float starCursorProx = 0.0;
  if (u_starCursorInfluence > 0.001 && u_regionActive[4] > 0.01 && proximity > 0.001 && starPushRadius > 0.001) {
    vec2 scOff = a_homePos - u_starCursorUV;
    scOff.x *= u_aspectRatio;
    float scDist = length(scOff);
    starCursorProx = smoothstep(starPushRadius * 1.5, 0.0, scDist)
                   * smoothstep(0.0, 0.15, proximity)
                   * u_starCursorInfluence;
    if (starCursorProx > 0.01) {
      float scPhase = fract(sin(dot(a_homePos, vec2(93.97, 214.63))) * 29187.413);
      float scFreq = mix(2.0, 5.0, fract(scPhase * 7.0));
      float scPulse = sin(u_time * scFreq + scPhase * 6.283);
      float scSizeMul = 1.0 + (scPulse * 0.5 + 0.5) * 0.4 * starCursorProx;
      gl_PointSize *= scSizeMul;
    }
  }

  // ── Boundary tremble: particles at the vortex edge jitter before committing ──
  // Strongest near the boundary (low proximity), decays toward the center.
  // Fades out over time so only freshly-captured particles tremble.
  if (u_trembleAmt > 0.0 && proximity > 0.0 && proximity < 0.5 && maxFadeAge < maxFadeDuration) {
    float edgeness = 1.0 - proximity * 2.0;             // 1.0 at edge, 0.0 at proximity=0.5
    float youth = 1.0 - maxFadeAge / maxFadeDuration;   // 1.0 at birth, 0.0 when fully faded in
    float trembleStrength = edgeness * edgeness * youth * u_trembleAmt * maxProxRadius;
    vec2 trembleNoise = curlNoise(pos * 20.0, u_time * u_trembleFreq);
    pos += trembleNoise * trembleStrength * edgeLock;
  }

  // ── Per-particle pseudo-random seeds (shared by flashlight + hover orbit) ──
  vec2 seed = a_homePos * 127.1 + a_spiralPos * 311.7;
  float h1 = fract(sin(dot(seed, vec2(12.9898, 78.233))) * 43758.5453);
  float h2 = fract(sin(dot(seed + 1.0, vec2(39.346, 11.135))) * 28573.329);
  float h3 = fract(sin(dot(seed + 2.0, vec2(17.651, 83.917))) * 51379.713);

  // ── Flashlight drift: dust-like floating under cursor (single-point, no trail) ──
  if (u_driftAmount > 0.001 && u_flashRadius > 0.0 && u_driftActive > 0.5) {
    // Convert particle position to canvas-pixel space (matching driftCenter coords)
    vec2 screenDrift = vec2(pos.x * u_canvasSize.x,
                            (1.0 - pos.y) * u_canvasSize.y);

    // Per-particle jittered radius: each particle has a unique effective radius
    // between 30% and 70% of flashRadius.  This breaks up the circular boundary
    // so no coherent ring is visible — the cutoff is different for every particle.
    float driftRadius = u_flashRadius * (0.3 + h3 * 0.4);

    // Single-point check: drift only at the current cursor position, no trail
    float dist = length(screenDrift - u_driftCenter);
    float raw = clamp(1.0 - dist / driftRadius, 0.0, 1.0);
    float driftInfluence = raw * raw;

    if (driftInfluence > 0.001) {
      // Time-varying organic motion (two harmonics -> non-circular paths)
      float t = u_time * u_driftSpeed;
      float phase1 = h1 * 6.2832;
      float phase2 = h2 * 6.2832;
      // Primary slow orbit
      float angle1 = phase1 + sin(t * 0.7 + phase2) * 3.14159;
      vec2 drift = vec2(cos(angle1), sin(angle1));
      // Secondary faster wobble (40% amplitude)
      float angle2 = phase2 + sin(t * 1.3 + phase1) * 1.5;
      drift += vec2(cos(angle2), sin(angle2)) * 0.4;
      // Amplitude breathing (30% variation)
      drift *= 0.7 + 0.3 * sin(t * 0.3 + h1 * 6.28);
      drift = normalize(drift);

      // Scale by influence, amount, and mouse speed
      float speedBoost = 1.0 + u_driftMouseSpeed * u_driftMouseInfluence;
      float disp = driftInfluence * u_driftAmount * speedBoost;
      disp = min(disp, u_driftMaxCap);

      pos += drift * disp;
    }
  }

  // ── Intro global dance: subtle static across all particles ──
  if (u_introDanceScale > 0.0) {
    float idxT = u_time;
    float idx = sin(idxT * 0.8 + h1 * 6.2832)
              * cos(idxT * 0.5 + h2 * 6.2832);
    float idy = cos(idxT * 0.6 + h2 * 6.2832)
              * sin(idxT * 0.9 + h1 * 6.2832);
    // Per-particle stagger on fade-out only: normalize to active level,
    // apply stagger to the fade ratio, then scale back. During active
    // intro (value at or above baseline), all particles get uniform shimmer.
    float introBase = 0.00025;
    float introAmp = u_introDanceScale;
    if (u_introDanceScale < introBase * 0.99) {
      float fadeRatio = u_introDanceScale / introBase;
      introAmp = introBase * pow(fadeRatio, 1.0 + h1 * 2.0);
    }
    pos.x += idx * introAmp;
    pos.y += idy * introAmp;
  }

  // ── Cypress branch sway: noise-driven displacement for region 1 ──
  // Spatially coherent simplex noise creates emergent branch clusters.
  // Additive with ambient dance. Visual-only (render pass, no sim feedback).
  v_cypressPack = vec4(0.0);  // default: swayIntensity, edgeProximity, leafFlash, rimGlow
  v_villagePack = vec4(0.0, 0.0, 1.0, 1.0);  // x=edgeFade, y=twinkle, z=swarmAlpha(1.0!), w=cypFlowAlpha(1.0!)
  {
    int cypRIdx = int(a_regionId + 0.5);
    if (cypRIdx == 1 && u_cypressSwayAmp > 0.001 && u_cypressSwayMix > 0.001) {
      // u_cypressSwayMix: own eased gate (0→1), decoupled from regionActive.
      // Slow ease-out (~2s) prevents snap-back when region deactivates.
      float cypRegionGate = u_cypressSwayMix;

      // Height gradient: top sways more, base is grounded.
      // a_homePos.y: small = canvas top (treetop), large = canvas bottom (trunk base)
      float cypNormHeight = 1.0 - smoothstep(u_cypressTopY, u_cypressBaseY, a_homePos.y);
      float cypHeightFactor = mix(u_cypressBaseRatio, 1.0, cypNormHeight);

      // ── Wind-aligned noise: project onto rightward wind direction ──
      // Matches the sky gust base direction (1,0) so gusts arrive at the
      // cypress at the same time as the surrounding sky.
      // Projection along X creates left→right wavefronts; Y is cross-wind.
      float cypProj = a_homePos.x;  // rightward wind projection

      // 3-octave simplex noise aligned to wind direction
      // Octave 1: broad gust masses (matches sky gust layer 1 rate)
      // Octave 2: medium branch clusters
      // Octave 3: fine sub-branch detail
      float cypNoise1 = snoise(vec2(cypProj * 2.0 + u_time * 0.10, a_homePos.y * 3.0 + 11.3));
      float cypNoise2 = snoise(vec2(cypProj * 5.0 + u_time * 0.25 + 3.7, a_homePos.y * 7.0 + 23.1));
      float cypNoise3 = snoise(vec2(cypProj * 11.0 + u_time * 0.55 + 7.1, a_homePos.y * 12.0));
      float cypNoise = 0.50 * cypNoise1 + 0.30 * cypNoise2 + 0.20 * cypNoise3;

      // Global breathing: shared 25-second inhale/exhale with sky gust
      // Unifies the entire canvas — wind builds and fades together.
      cypNoise *= u_breatheWave;

      // Asymmetric tree breathing: slow load (branches bend), quick snap-back (elastic recoil)
      // Layered ON TOP of global wind — gives the tree its own organic character.
      float cypBreathRaw = sin(u_time * (6.2832 / u_cypressBreathPeriod));
      float cypBreathShaped = cypBreathRaw > 0.0
        ? cypBreathRaw * mix(1.0, cypBreathRaw, 0.4)    // ≈ pow(x, 1.4) — slow load
        : -(-cypBreathRaw) * mix(1.0, -cypBreathRaw, -0.3); // ≈ pow(x, 0.7) — quick snap-back
      float cypBreath = 0.8 + 0.2 * cypBreathShaped;  // narrower range — wind is now the main driver
      cypNoise *= cypBreath;

      // Luminance parallax: bright foliage edges displace more,
      // dark interior displaces less — implicit depth layering (BT.601)
      float cypLum = dot(a_color, vec3(0.299, 0.587, 0.114));
      float cypLumScale = 0.4 + 0.6 * cypLum;

      // Drift scatter: per-particle variation (0.7–1.3×) prevents convergence pile-ups
      float cypDriftScatter = 0.7 + h2 * 0.6;

      // Combined per-particle scale
      float cypParticleScale = cypDriftScatter * cypLumScale;

      // Per-particle directional jitter: each particle sways at its own angle.
      // h1 gives a stable random in [0,1]. Map to angle spread: ±(swayAngle * PI/2).
      // At swayAngle=0: pure horizontal. At swayAngle=1: full ±90° spread.
      float cypAngle = (h1 - 0.5) * 3.14159 * u_cypressSwayAngle;
      float cypCosA = cos(cypAngle);
      float cypSinA = sin(cypAngle);

      // Primary displacement magnitude
      float cypMag = cypNoise * u_cypressSwayAmp * u_cypressMaxDrift * cypRegionGate * cypHeightFactor * cypParticleScale;

      // Cross-sway: perpendicular (vertical) Lissajous component
      // Phase varies along wind direction so sway ripples L→R through the tree
      float cypCrossWave = sin(u_time * 0.3 + h1 * 6.2832 + cypProj * 4.0);
      float cypCrossMag = cypCrossWave * u_cypressMaxDrift * u_cypressCrossSway * cypRegionGate * cypHeightFactor * cypParticleScale;

      // Noise-driven displacement vector (primary + cross-sway, rotated by per-particle angle)
      vec2 cypNoiseDisp = vec2(
        cypMag * cypCosA + cypCrossMag * (-cypSinA),
        cypMag * cypSinA + cypCrossMag * cypCosA
      );

      // Wind direction bias: mouse horizontal drag velocity pushes particles
      // Scaled by maxDrift, height, and region gate — same factors as sway
      vec2 cypWindPush = vec2(
        u_cypressWindBias * u_cypressMaxDrift * 1.5 * cypRegionGate * cypHeightFactor * cypParticleScale,
        0.0
      );
      cypNoiseDisp += cypWindPush;

      // ── Cypress flow field: blend painted direction with noise ──
      vec3 cypFlowSamp = texture(u_cypressFlowTex, a_homePos).rgb;
      float cypFlowCoherence = cypFlowSamp.r;

      // Decode painted flow direction
      float cypFlowCosA = cypFlowSamp.g * 2.0 - 1.0;
      float cypFlowSinA = cypFlowSamp.b * 2.0 - 1.0;
      vec2 cypFlowDir = vec2(cypFlowCosA, cypFlowSinA);

      // ── Lifecycle cycling (when flow coherence > 0) ──
      vec2 totalCypDisp;
      float cypLifecycleAlpha = 1.0;

      if (cypFlowCoherence > 0.01) {
        // Per-particle phase (deterministic from home position)
        float cypFlowPhase = fract(sin(dot(a_homePos, vec2(12.9898, 78.233))) * 43758.5453);
        float cypFlowT = fract((u_time + cypFlowPhase * u_cypressFlowCyclePeriod) / u_cypressFlowCyclePeriod);
        float cypDriftFrac = u_cypressFlowDriftFrac;

        if (cypFlowT < cypDriftFrac) {
          float cypDriftT = cypFlowT / cypDriftFrac;

          // Fade in/out envelope
          float cypFadeIn  = smoothstep(0.0, 0.08, cypDriftT);
          float cypFadeOut = 1.0 - smoothstep(0.80, 1.0, cypDriftT);
          cypLifecycleAlpha = cypFadeIn * cypFadeOut;

          // S-curve drift progress
          float cypProgress = smoothstep(0.0, 1.0, smoothstep(0.0, 1.0, cypDriftT));

          // Per-particle drift scatter (±40%)
          float cypDriftScatter = 0.6 + 0.8 * fract(sin(dot(a_homePos, vec2(53.14, 91.73))) * 28461.3);

          // ── Temporal gusts along painted flow direction ──
          float cypGustFactor = 1.0;
          if (u_cypressFlowGustAmp > 0.001) {
            float cypGustProj = dot(a_homePos, cypFlowDir);
            float cypGustPerp = dot(a_homePos, vec2(-cypFlowSinA, cypFlowCosA));
            float cypG1 = snoise(vec2(cypGustProj * 1.2 - u_time * 0.10, cypGustPerp * 1.2));
            float cypG2 = snoise(vec2(cypGustProj * 2.0 - u_time * 0.18 + 3.7, cypGustPerp * 2.0));
            float cypG3 = snoise(vec2(cypGustProj * 2.8 - u_time * 0.25 + 7.1, cypGustPerp * 2.8));
            cypGustFactor = 1.0 + (cypG1 * 0.5 + cypG2 * 0.3 + cypG3 * 0.2) * u_cypressFlowGustAmp;
          }

          // Flow displacement: painted direction × max drift × progress × modifiers
          vec2 cypFlowDisp = cypFlowDir * u_cypressFlowMaxDrift * cypProgress
            * cypRegionGate * cypHeightFactor * cypParticleScale
            * cypDriftScatter * cypGustFactor;

          // Blend: coherence controls mix between noise and flow displacement
          // coherence=1.0 → pure flow, coherence=0.0 → pure noise
          totalCypDisp = mix(cypNoiseDisp, cypFlowDisp, cypFlowCoherence);

        } else {
          // Dead phase: particle invisible, at home
          cypLifecycleAlpha = 0.0;
          totalCypDisp = vec2(0.0);
        }

        // Blend lifecycle alpha by coherence (low coherence = less lifecycle effect)
        v_villagePack.w = mix(1.0, cypLifecycleAlpha, cypFlowCoherence * cypRegionGate);

      } else {
        // No flow painted here — pure noise displacement (existing behavior)
        totalCypDisp = cypNoiseDisp;
      }

      // ── One-sided edge constraint ──
      // Precomputed BFS distance from cypress boundary inward (same as flow edge).
      // u_distPackTex.g: cypress edge distance (0 = at edge or outside, positive = pixels from edge)
      float cypEdgeDist = texture(u_distPackTex, a_homePos).g;
      float cypEdgeFactor = smoothstep(0.0, u_cypressEdgeDepth, cypEdgeDist);
      // Invert: 1.0 at edge, 0.0 deep inside
      float cypEdgeProximity = 1.0 - cypEdgeFactor;

      // Outward normal from gradient of the edge distance field (central differences)
      float cypEps = 1.0 / max(u_canvasSize.x, u_canvasSize.y);
      float cypEdR = texture(u_distPackTex, a_homePos + vec2(cypEps, 0.0)).g;
      float cypEdL = texture(u_distPackTex, a_homePos - vec2(cypEps, 0.0)).g;
      float cypEdU = texture(u_distPackTex, a_homePos + vec2(0.0, cypEps)).g;
      float cypEdD = texture(u_distPackTex, a_homePos - vec2(0.0, cypEps)).g;
      // Gradient points inward (toward increasing distance). Negate for outward normal.
      vec2 edgeNormal = -vec2(cypEdR - cypEdL, cypEdU - cypEdD);
      float enLen = length(edgeNormal);
      edgeNormal = enLen > 0.001 ? edgeNormal / enLen : vec2(0.0);

      // Suppress inward displacement only, proportional to edge proximity.
      // Outward and tangential motion pass through freely — tree breathes outward.
      float inwardComponent = -dot(totalCypDisp, edgeNormal);
      if (inwardComponent > 0.0 && cypEdgeProximity > 0.0) {
        totalCypDisp += edgeNormal * inwardComponent * cypEdgeProximity;
      }

      pos.xy += totalCypDisp;

      v_cypressPack.y = cypEdgeProximity;

      v_cypressPack.x = (abs(cypNoise) + abs(cypCrossWave) * u_cypressCrossSway * 0.5)
                       * u_cypressSwayAmp * cypRegionGate * cypHeightFactor * cypParticleScale;

      // ── Specular leaf flash: sparse brightness pops on wind-turned leaves ──
      // Displacement magnitude = how far the "leaf" has turned from rest.
      // High displacement → crossed specular angle → brief bright glint.
      if (u_cypressLeafFlash > 0.5) {
        float cypDispMag = length(totalCypDisp);
        float cypDispNorm = cypDispMag / max(u_cypressMaxDrift * 0.5, 0.0001);

        // Gate 1: displacement threshold — only actively swaying particles
        if (cypDispNorm > 0.4) {
          // Gate 2: sparse hash selection — ~5% of eligible particles
          // (at any instant, roughly half are in the "flash" phase of
          //  their sine pulse → effective density ~2.5%)
          float cypFlashHash = fract(sin(dot(a_homePos, vec2(41.31, 142.89))) * 29174.5);
          if (cypFlashHash < 0.05) {
            // Per-particle phase and frequency
            float cypFlashPhase = fract(sin(dot(a_homePos, vec2(93.97, 214.63))) * 29187.413);
            float cypFlashFreq = mix(3.0, 7.0, cypFlashPhase);  // 3-7 Hz (brief glint)

            // Sine pulse: positive half = flash, negative half = dark (no flash)
            float cypFlashPulse = max(0.0, sin(u_time * cypFlashFreq + cypFlashPhase * 6.283));

            // Activation: pulse × displacement strength × height factor
            // Treetop flashes more (more exposed to light), base barely flashes
            float cypFlashActivation = cypFlashPulse
              * smoothstep(0.4, 0.8, cypDispNorm)
              * cypHeightFactor
              * cypRegionGate;

            // Subtle size pop (1.0 → 1.3x at peak)
            gl_PointSize *= 1.0 + cypFlashActivation * 0.3;

            v_cypressPack.z = cypFlashActivation;
          }
        }
      }

      // ── Edge rim glow proximity (wider zone than edge constraint) ──
      // Backlight bleed through thinned canopy at silhouette edges.
      // Uses cypEdgeDist (raw pixel distance, already sampled) with a separate
      // rim width parameter so glow zone is independent of edge constraint depth.
      if (u_cypressRimGlow > 0.5) {
        float cypRimProximity = 1.0 - smoothstep(0.0, u_cypressRimWidth, cypEdgeDist);
        v_cypressPack.w = cypRimProximity * v_cypressPack.x * cypRegionGate;

        // Size pop: edge particles grow during gusts (wind spreads branches apart)
        // 1.0x deep inside → up to 1.8x at silhouette edge during peak gust
        gl_PointSize *= 1.0 + v_cypressPack.w * 0.8;
      }
    }
  }

  // ── Sim-pass displacement ──
  // The sim shader integrates tiny per-frame increments via transform feedback,
  // so displacement is always continuous — no ring artifact.
  pos += a_simPos - a_homePos;

  // ── Boundary collision: sample distance field at displaced position ──
  // If the displaced position lands inside a locked region (boundaryDist=0),
  // binary-search along the displacement ray to find the boundary edge.
  // Locked regions: cypress (1) and village (2). Stars (5) are unlocked
  // in the [1,2] distance field so particles pass through freely.
  // G10: Skip boundary check when particle hasn't been displaced.
  // Undisplaced particles are at their home position, which is always safe
  // (they were extracted from the painting there). Saves 1 VTF per particle.
  if (a_boundaryDist > 0.0 && dot(pos - a_homePos, pos - a_homePos) > 0.0000001) {
    float destBD = texelFetch(u_boundaryTex, ivec2(pos * vec2(textureSize(u_boundaryTex, 0))), 0).r;
    if (destBD < 0.001) {
      // Displaced pos is inside locked region — pull back via binary search.
      // Find the furthest point along home→pos that's still outside.
      vec2 safePos = a_homePos;
      vec2 testPos = pos;
      for (int s = 0; s < 8; s++) {
        vec2 mid = (safePos + testPos) * 0.5;
        float midBD = texelFetch(u_boundaryTex, ivec2(mid * vec2(textureSize(u_boundaryTex, 0))), 0).r;
        if (midBD > 0.001) {
          safePos = mid;  // midpoint is safe, push further
        } else {
          testPos = mid;  // midpoint is locked, pull back
        }
      }
      pos = safePos;
    }
  }

  // ── Point size with swell (gated by edgeLock so locked regions don't swell) ──
  float proxLocked = proximity * edgeLock;
  float basePS = u_pointSize * (1.0 + smoothstep(0.0, 0.3, proxLocked) * proxLocked * u_swell);
  gl_PointSize = basePS;

  // ── Star scintillation: sparse sparkle (seeing flashes) ──
  // Density eases from 0% → 1% as intensity ramps, with chromatic color shifts.
  // Size boost + brightness flicker + gold↔blue-white chroma in fragment shader.
  v_skyScintPack = vec4(0.0, 0.0, 0.0, a_coherence);  // x=skyGust, y=scint, z=speedScint, w=coherence
  if (u_starScintillation > 0.001) {
    int rIdx = int(a_regionId + 0.5) - 1;
    if (rIdx == 4) {  // region 5 (Stars) only
      vec2 homeUV = a_homePos;
      homeUV.y = 1.0 - homeUV.y;
      float maxStar = 0.0;
      for (int i = 0; i < 12; i++) {
        vec2 diff = homeUV - u_starCenter[i];
        diff.x *= u_aspectRatio;
        float dist = length(diff);
        if (dist < u_starCurrentRadius[i]) {
          float t = dist / u_starCurrentRadius[i];
          float falloff = 1.0 - t;
          maxStar = max(maxStar, falloff);
        }
      }
      if (maxStar > 0.0) {
        float scintPhase = fract(sin(dot(a_homePos, vec2(93.97, 214.63))) * 29187.413);
        // Density eases from 0% → 1.25% as scintillation intensity ramps up
        float scintThreshold = 0.0125 * smoothstep(0.0, 0.15, u_starScintillation);
        if (scintPhase < scintThreshold) {
          float pulse = sin(u_time * 2.8 + scintPhase * 6.283);
          float sizeMax = mix(1.0, 3.0, u_starScintillation);
          float sizeMul = 1.0 + (pulse * 0.5 + 0.5) * (sizeMax - 1.0) * maxStar;
          gl_PointSize = basePS * sizeMul;
          v_skyScintPack.y = maxStar;
        }
      }
    }
  }

  // ── Shooting star blinks (sparse per-particle scale pulses) ──
  float blink = 0.0;
  if (proxLocked > 0.3) {  // only inner unlocked particles can blink
    float blinkSeed = fract(sin(phase * 127.1 + 311.7) * 43758.5453);
    // Per-vortex variance: hash the dominant index for natural unevenness
    float vortexHash = fract(sin(float(dominantIdx) * 73.17) * 43758.5453);
    // Size-scaled threshold: bigger vortices contain more particles,
    // so they need a stricter threshold to keep star count similar.
    // maxProxRadius ~0.05 (small) to ~0.5 (huge). Map to threshold:
    //   small vortex → 0.9990 (more stars per particle count)
    //   large vortex → 0.9998 (fewer stars per particle count)
    float sizeScale = smoothstep(0.03, 0.4, maxProxRadius);  // 0=small, 1=huge
    float blinkThreshold = 0.9990 + sizeScale * 0.0008 + vortexHash * 0.0002;
    if (blinkSeed > blinkThreshold) {
      // Gradual onset: each particle waits 1–4s after vortex birth
      float onsetDelay = 1.0 + blinkSeed * 3.0;
      if (maxFadeAge > onsetDelay) {
        // Varied cycle length per particle: 6–14s
        float blinkCycle = 6.0 + blinkSeed * 8.0;
        float blinkT = mod(u_time + blinkSeed * blinkCycle, blinkCycle);
        blink = smoothstep(0.0, 2.5, blinkT) * smoothstep(7.5, 2.5, blinkT);
        gl_PointSize = gl_PointSize * (1.0 + blink * 4.0);
      }
    }
  }
  v_miscPack.x = blink;

  // ── Flow lifecycle + visual-only offset (no sim displacement) ──
  // Viscous boundary layer: flow strength fades smoothly at painted edges.
  // Staggered births/deaths across particles create a traveling wave illusion.
  v_flowPack = vec4(1.0, 0.0, 0.0, a_flowAngle);  // x=flowAlpha(1.0!), y=coherenceSpeed, z=driftScale, w=flowAngle
  // v_skyScintPack defaults set earlier (0.0, 0.0, 0.0, coherence)
  // v_cypressPack is set earlier in the cypress sway block
  // Region gate: sky regions (3=night sky, 4=swirl sky) can flow.
  // Locked regions (1=cypress, 2=village) and stars (5) are blocked.
  int flowRid = int(effectiveRegion + 0.5);
  bool isFlowRegion = (flowRid == 3 || flowRid == 4);

  // ── Vortex suppression: when a vortex is active, suppress gust/flow in the
  // overlap zone so the vortex dominates. This creates a "dynamic boundary"
  // that shifts outward with the vortex instead of staying at the fixed star edge.
  // Gust suppression uses the WIDER suppress proximity so gust fades out
  // before the rotation edge — no hard seam between gust and vortex.
  float vortexSuppress = 1.0 - maxSuppressProx;

  // Suppress sim-pass displacement inside vortex zones — the sim shader
  // has no vortex awareness, its flow advection conflicts with rotation.
  pos -= (a_simPos - a_homePos) * (1.0 - vortexSuppress);

  // Sample flow texture once — reused by gust, drift, and canvas deformation blocks
  vec3 flowSamp = isFlowRegion ? texture(u_flowFieldTex, a_homePos).rgb : vec3(0.0);

  // Sky gust mix: coherence-based blend (moved here for GPU LOD access)
  float skyGustMix = (flowRid == 5) ? 0.0 : smoothstep(0.25, 0.0, flowSamp.r);

  if (u_flowMix > 0.001 && isFlowRegion) {
    // Master alpha gate per region:
    // Region 4 (Horizon swirls): gated by Horizon activation.
    // Region 3 (Night Sky + sky gust): gated by Night Sky activation.
    // Sky gust particles (low-coherence region 4) have effectiveRegion = 3.0
    // via the unification above, so they naturally take the Night Sky path.
    // Per-particle fade-out stagger for Night Sky (region 3) and Horizon (region 4):
    // spreads the "return to home" convergence across ~15 frames when the region
    // fades, avoiding the brightness pop from every particle snapping together.
    // Gated on u_skyFadeOut / u_horizonFadeOut so active/looping behavior is unchanged.
    // Different hash seeds so the two regions decorrelate.
    float skyFadeHash3 = fract(sin(dot(a_homePos, vec2(78.43, 213.91))) * 27594.713);
    float skyGateShift3 = u_skyFadeOut * (skyFadeHash3 - 0.5) * 0.10;
    float hzFadeHash = fract(sin(dot(a_homePos, vec2(113.29, 58.77))) * 41893.523);
    float hzGateShift = u_horizonFadeOut * (hzFadeHash - 0.5) * 0.10;
    float regionFlowGate = (flowRid == 4)
      ? smoothstep(0.25, 0.55, u_regionActive[3] + hzGateShift)
      : smoothstep(0.25, 0.55, u_regionActive[2] + skyGateShift3);

    // Unified flow gate: one decay signal for all flow visual effects.
    // Region 4 (Horizon): regionFlowGate IS the master alpha — rides regionActive.
    // Region 3 (Night Sky + sky gust): also multiplied by flowMixCubic to suppress
    //   lifecycle wrapping pops during release.
    float flowMixCubic = u_flowMix * u_flowMix * u_flowMix;
    float unifiedFlowGate = (flowRid == 4) ? regionFlowGate : regionFlowGate * flowMixCubic;

    float texCoherence = flowSamp.r;

    // Smooth falloff: tighter band — defined edge with soft boundary, not fuzzy
    float flowStrength = smoothstep(u_flowThreshold * 0.5, u_flowThreshold, texCoherence);

    if (flowStrength > 0.001) {
      // Curvature-driven speed: particles on straight flow paths move fast,
      // tight curves (swirl centers) slow down — like driving through mountains.
      // Grounded in centripetal deceleration from real fluid dynamics.
      vec2 curvData = texture(u_flowCurvatureTex, a_homePos).rg;
      float curvature = curvData.r;
      float eddyEnergy = curvData.g;
      float curvatureSpeed = mix(u_flowSpeedFloor, 1.0, 1.0 - curvature);

      // Kolmogorov eddy energy scale: large swirls push harder, small curls gentle.
      // eddyEnergy high = large rotational structure, low = small/no rotation.
      float eddyScale = mix(u_eddyMinScale, u_eddyMaxScale, eddyEnergy);

      // Per-particle speed personality (overlapping action): each particle has a
      // permanent slight speed offset — some naturally drift faster, some slower,
      // like starlings in a flock with different individual momentum.
      float particleSpeed = 0.75 + 0.5 * fract(sin(dot(a_homePos, vec2(94.17, 23.63))) * 71932.1);
      curvatureSpeed *= particleSpeed;

      // Viscous boundary layer: distance from nearest boundary region.
      // boundaryTex [1,2] = cypress/village (normalized, denormalized here).
      // distPackTex.r = all non-flow boundaries including stars (raw pixels).
      // min() picks the closest boundary from either source.
      float edgeDistNorm = texelFetch(u_boundaryTex, ivec2(a_homePos * vec2(textureSize(u_boundaryTex, 0))), 0).r;
      float edgeDistBnd = edgeDistNorm * max(u_canvasSize.x, u_canvasSize.y);
      float edgeDistFlow = texture(u_distPackTex, a_homePos).r;
      float edgeDist = min(min(edgeDistBnd, edgeDistFlow), minDynamicEdgePx);
      float edgeFactor = smoothstep(0.0, u_flowEdgeDepth, edgeDist);
      float driftScale = mix(0.2, 1.0, edgeFactor);

      // Coherence edge fade: near the outer perimeter of painted flow,
      // coherence drops toward the threshold. Fade speed down at painted edges
      // to create a soft blue fringe where brushstrokes thin out.
      float coherenceEdge = smoothstep(u_flowThreshold, u_flowThreshold + 0.19, texCoherence);
      driftScale *= mix(0.3, 1.0, coherenceEdge);
      v_flowPack.z = driftScale * eddyScale; // includes eddy energy for debug mode 6

      // ── Temporal gusts: wind blobs traveling along local flow direction ──
      // Gust wave is aligned with the painted flow so the surge visually
      // travels in the same direction the particles are moving.
      float gustFactor = 1.0;
      if (u_gustAmplitude > 0.001) {
        // Project position onto local flow direction + perpendicular
        float fCosA = flowSamp.g * 2.0 - 1.0;
        float fSinA = flowSamp.b * 2.0 - 1.0;
        float flowProj = dot(a_homePos, vec2(fCosA, fSinA));
        float flowPerp = dot(a_homePos, vec2(-fSinA, fCosA));

        // Layer 1: largest, slowest — covers ~60% of canvas
        float g1 = snoise(vec2(flowProj * 1.2 - u_time / u_gustPeriod, flowPerp * 1.2));
        // Layer 2: medium, slightly faster — ~40% coverage
        float g2 = snoise(vec2(flowProj * 2.0 - u_time / u_gustPeriod * 1.4, flowPerp * 2.0 + 3.7));
        // Layer 3: smallest, fastest drift — ~30% coverage
        float g3 = snoise(vec2(flowProj * 2.8 - u_time / u_gustPeriod * 1.8, flowPerp * 2.8 + 7.3));
        float gustNoise = g1 * 0.5 + g2 * 0.3 + g3 * 0.2;

        gustFactor = 1.0 + gustNoise * u_gustAmplitude;
      }

      float gustedSpeed = curvatureSpeed * gustFactor;
      v_flowPack.y = gustedSpeed;  // for debug mode 6

      float phase = fract(sin(dot(a_spiralPos, vec2(12.9898, 78.233))) * 43758.5453);
      float t = fract((u_time + phase * u_flowCyclePeriod) / u_flowCyclePeriod);
      float driftFrac = u_flowDriftFrac;

      // Cursor proximity (computed once, used for direction override + drift damping)
      float cursorMix = 0.0;
      if (flowRid == 4 && u_flowCursorInfluence > 0.001) {
        float cursorDist = length(a_homePos - u_flowCursorUV);
        cursorMix = smoothstep(u_flowCursorRadius, 0.0, cursorDist)
                  * u_flowCursorInfluence;
        // Dampen drift fraction near cursor: particles take shorter trips
        driftFrac = mix(driftFrac, driftFrac * 0.25, cursorMix);
      }

      float lifecycleAlpha;
      if (t < driftFrac) {
        float driftT = t / driftFrac;
        float fadeIn  = smoothstep(0.0, 0.08, driftT);
        float fadeOut = 1.0 - smoothstep(0.80, 1.0, driftT);
        lifecycleAlpha = fadeIn * fadeOut;

        float cosA = flowSamp.g * 2.0 - 1.0;
        float sinA = flowSamp.b * 2.0 - 1.0;
        vec2 flowDir = vec2(cosA, sinA);
        // Cursor flow override: mouse direction replaces painted flow near cursor (Horizon only)
        if (cursorMix > 0.001) {
          vec2 blended = mix(flowDir, u_flowCursorDir, cursorMix);
          float bLen = length(blended);
          flowDir = bLen > 0.001 ? blended / bLen : flowDir;
        }
        // Compound S-curve: dramatic ease-in/ease-out — particles linger at home,
        // snap through the middle, settle at max drift. Each journey feels intentional.
        float progress = smoothstep(0.0, 1.0, smoothstep(0.0, 1.0, driftT));

        // Per-particle drift distance scatter (±40%) — prevents convergence pile-ups
        // by giving each particle a different endpoint so seams blur out
        float driftScatter = 0.6 + 0.8 * fract(sin(dot(a_homePos, vec2(53.14, 91.73))) * 28461.3);

        // Unified gate for displacement: suppresses lifecycle progress oscillation
        // during release decay. Without this, particles at high progress snap back
        // to home when their lifecycle wraps (progress 1→0), causing a visible pop.
        float flowMixDisp = unifiedFlowGate;
        pos += flowDir * u_flowMaxDrift * progress * flowMixDisp * flowStrength * driftScale * gustedSpeed * driftScatter * eddyScale * vortexSuppress;

        // ── Speed scintillation: sparse sparkle on fast particles ──
        // Adapts star scintillation pattern: 25% of high-speed particles pulse in size.
        // Sparse enough not to blow out brightness, visible enough to give motion weight.
        // eddyScale included: large eddies scintillate more readily (reinforces energy hierarchy).
        float effectiveSpeed = gustedSpeed * driftScale * eddyScale;
        if (effectiveSpeed > 0.5) {
          float speedScintHash = fract(sin(dot(a_homePos, vec2(41.31, 67.97))) * 29174.5);
          if (speedScintHash < 0.50) {
            float speedScintPhase = fract(sin(dot(a_homePos, vec2(93.97, 214.63))) * 29187.413);
            // Kolmogorov temporal scaling: small eddies flicker fast, large flows pulse slow
            float scintFreq = mix(1.5, 6.0, curvature);
            float pulse = sin(u_time * scintFreq + speedScintPhase * 6.283);
            // Size range 1x to 2x
            float sizeMul = 1.0 + (pulse * 0.5 + 0.5) * 1.0 * smoothstep(0.5, 1.0, effectiveSpeed);
            // Scintillation envelope: fade out BEFORE lifecycleAlpha starts (0.80)
            // so red transitions back to painting color while particle is still opaque.
            float sizeEnvelope = smoothstep(0.0, 0.20, driftT) * (1.0 - smoothstep(0.45, 0.75, driftT));
            // Gate by unifiedFlowGate so lifecycle oscillation can't create
            // visible pulses during the release decay. Region 4: rides regionActive
            // (master alpha). Region 3: rides u_flowMix³ (UP-key release).
            float scintGate = sizeEnvelope * unifiedFlowGate;
            gl_PointSize *= mix(1.0, sizeMul, scintGate);
            // Activation carries envelope + flowMix so fragment color/brightness
            // fades in/out with drift lifecycle AND with flow on/off.
            v_skyScintPack.z = smoothstep(0.5, 1.0, effectiveSpeed) * scintGate;
          }
        }

        // ── Wind twinkle: audio-driven shimmer along flow direction ──
        // Flow-aligned noise selects which particles shimmer; density scales with RMS.
        if (u_flowTwinkle > 0.001) {
          float twCosA = flowSamp.g * 2.0 - 1.0;
          float twSinA = flowSamp.b * 2.0 - 1.0;
          float twProj = dot(a_homePos, vec2(twCosA, twSinA));
          float twPerp = dot(a_homePos, vec2(-twSinA, twCosA));

          // High-freq noise drifting along flow — organic wind ripple
          float twNoise = snoise(vec2(twProj * 30.0 + u_time * 2.5, twPerp * 30.0));

          // Threshold: louder audio = more particles eligible
          float twThresh = 1.0 - u_flowTwinkle * 0.7;
          float twActivation = smoothstep(twThresh, twThresh + 0.15, twNoise);

          // Lifecycle + unified flow gating (same pattern as speed scintillation)
          float twEnvelope = smoothstep(0.0, 0.20, driftT) * (1.0 - smoothstep(0.45, 0.75, driftT));
          float twGate = twEnvelope * unifiedFlowGate;

          // Size pulse — per-particle phase for variation
          float twPhase = fract(sin(dot(a_homePos, vec2(127.1, 311.7))) * 43758.5453);
          float twFreq = mix(2.0, 5.0, twPhase);
          float twPulse = sin(u_time * twFreq + twPhase * 6.283);
          float twSizeMul = 1.0 + (twPulse * 0.5 + 0.5) * 0.8 * twActivation;
          gl_PointSize *= mix(1.0, twSizeMul, twGate);

          // Combine with speed scintillation via max
          v_skyScintPack.z = max(v_skyScintPack.z, twActivation * twGate);
        }
      } else {
        lifecycleAlpha = 0.0;
      }
      // Blend: edges (low flowStrength + driftScale) barely cycle, center = full lifecycle.
      // Unified gate suppresses lifecycle oscillation during release decay —
      // same reason as speed scintillation: lifecycle wraps cause visible alpha pops
      // when the gate is still high enough to let lifecycleAlpha dominate.
      float flowAlphaMix = unifiedFlowGate * flowStrength * driftScale;
      // Coherence-driven alpha: fringe particles go semi-transparent (watercolor edge)
      float coherenceAlpha = mix(0.3, 1.0, coherenceEdge);
      v_flowPack.x = mix(1.0, lifecycleAlpha * coherenceAlpha, flowAlphaMix);
    }
  }

  // ── Sky gust: atmospheric displacement for low-coherence sky particles ──
  // Applies to both region 3 (night sky) and region 4 (swirls) with low flow coherence.
  // Gated by Night Sky activation (region 3).
  // (skyGustMix declared above, before GPU LOD block)
  if (skyGustMix > 0.001 && isFlowRegion
      && u_skyGustAmplitude > 0.001 && u_regionActive[2] > 0.001
      ) {

    // Displacement gate: displacement must reach zero BEFORE color glow
    // vanishes, so the remaining glow masks the dithered painting
    // snapping from "soft" (displaced dots) to "sharp" (exact dots).
    // smoothstep(0.25, 0.55): displacement zero at regionActive 0.25
    // where ~45% of color glow remains — plenty of visual cover.
    // Per-particle stagger during fade-out spreads the return-to-home
    // convergence across ~15 frames (same seed as regionFlowGate above so
    // both gates fade coherently for any given particle).
    float skyFadeHashG = fract(sin(dot(a_homePos, vec2(78.43, 213.91))) * 27594.713);
    float skyGateShiftG = u_skyFadeOut * (skyFadeHashG - 0.5) * 0.10;
    float skyRegionGate = smoothstep(0.25, 0.55, u_regionActive[2] + skyGateShiftG);

    // ── Per-particle turbulent jitter (Reynolds decomposition) ──
    vec2 skyFlowDir = vec2(1.0, 0.0);  // default rightward; jitter rotation adds per-particle variation
    float skyJitterSeed = fract(sin(dot(a_homePos, vec2(67.31, 142.89))) * 29187.413);
    float skyJitterAngle = (skyJitterSeed - 0.5) * 0.50;  // ±14° static scatter
    float skyJitterDrift = sin(u_time * 0.7 + skyJitterSeed * 6.283) * 0.30;  // ±17° time-varying
    float skyJitterTotal = skyJitterAngle + skyJitterDrift;
    float jCos = cos(skyJitterTotal), jSin = sin(skyJitterTotal);
    skyFlowDir = vec2(skyFlowDir.x * jCos - skyFlowDir.y * jSin,
                      skyFlowDir.x * jSin + skyFlowDir.y * jCos);
    vec2 skyPerpDir = vec2(-skyFlowDir.y, skyFlowDir.x);  // 90° rotation

    // ── 3-layer simplex noise (same as flow gusts) ──
    float skyProj = dot(a_homePos, skyFlowDir);
    float skyGustNoise;
    {
      float sn1 = snoise(vec2(skyProj * 2.0  + u_time * 0.10, a_homePos.y * 1.5));
      float sn2 = snoise(vec2(skyProj * 5.0  + u_time * 0.25 + 3.7, a_homePos.x * 3.0));
      float sn3 = snoise(vec2(skyProj * 11.0 + u_time * 0.55 + 7.1, a_homePos.y * 6.0));
      skyGustNoise = 0.50 * sn1 + 0.30 * sn2 + 0.20 * sn3;
    }

    // Global breathing cycle: 25-second inhale/exhale unifies all sky gust effects
    skyGustNoise *= u_breatheWave;

    float skyGustFactor = max(0.0, 1.0 + skyGustNoise * u_skyGustAmplitude);
    v_skyScintPack.x = skyGustFactor * skyGustMix;

    // ── Cursor wake proximity: shimmer + gust boost near cursor trail ──
    float nsWakeProx = 0.0;
    float nsCursorProx = 0.0;  // cursor-only proximity (for radial push)
    vec2 nsCursorOff = vec2(0.0);  // aspect-corrected offset (reused by push)
    float nsCursorDist = 0.0;
    if (u_nsWakeCursorInfluence > 0.001) {
      // Current cursor position (eased influence for slow build)
      nsCursorOff = a_homePos - u_nsWakeCursorUV;
      nsCursorOff.x *= u_aspectRatio;
      nsCursorDist = length(nsCursorOff);
      nsCursorProx = smoothstep(u_nsWakeRadius, 0.0, nsCursorDist) * u_nsWakeCursorInfluence;
      nsWakeProx = nsCursorProx;

      // Trail points (instant — no influence ramp). Loop bound must match NS_WAKE_TRAIL_SIZE in JS.
      for (int i = 0; i < 20; i++) {
        vec4 trail = u_nsWakeTrail[i];
        if (trail.w < 0.5) continue;
        float age = u_time - trail.z;
        if (age < 0.0 || age > u_nsWakeDecay) continue;
        float decay = 1.0 - age / u_nsWakeDecay;
        vec2 trailOff = a_homePos - trail.xy;
        trailOff.x *= u_aspectRatio;
        float trailDist = length(trailOff);
        float trailProx = smoothstep(u_nsWakeRadius, 0.0, trailDist) * decay;
        nsWakeProx = max(nsWakeProx, trailProx);
      }
    }
    float nsGustBoost = 1.0 + u_nsWakeGustBoost * nsWakeProx;

    // ── Boundary fade: taper displacement near all boundaries ──
    // boundaryTex [1,2] = cypress/village. distPackTex.r = all non-flow incl. stars.
    // min() picks the closest boundary from either source.
    float skyBndDistNorm = texelFetch(u_boundaryTex, ivec2(a_homePos * vec2(textureSize(u_boundaryTex, 0))), 0).r;
    float skyBndDistBnd = skyBndDistNorm * max(u_canvasSize.x, u_canvasSize.y);
    float skyBndDistFlow = texture(u_distPackTex, a_homePos).r;
    // Include dynamic vortex boundary so gust fades at the gravity well edge,
    // matching the static behavior (distPackTex.r fades gust near painted stars).
    // Both flow (driftScale) and gust (skyBndFade) reposition together.
    float skyBndDist = min(min(skyBndDistBnd, skyBndDistFlow), minDynamicEdgePx);
    float skyBndFade = smoothstep(0.0, max(u_canvasSize.x, u_canvasSize.y) * 0.0195, skyBndDist);

    // ── Cursor wake radial push: particles part like water ──
    // Uses cursor-only proximity (not trail) — push direction is from current cursor,
    // so trail contributions would cause incoherent forces.
    // Push scales with cursor speed in JS (still = ~1px gentle, fast = ~12px strong).
    if (nsCursorProx > 0.001 && u_nsWakePushStrength > 0.0001) {
      // Reuse nsCursorOff/nsCursorDist from proximity computation above
      if (nsCursorDist > 0.001) {
        vec2 nsPushDir = nsCursorOff / nsCursorDist;
        // Per-particle scatter: some resist more, others flow easily (0.6–1.4)
        float nsPushScatter = 0.6 + fract(sin(dot(a_homePos, vec2(53.71, 197.23))) * 31847.3) * 0.8;
        pos += vec2(nsPushDir.x / u_aspectRatio, nsPushDir.y) * u_nsWakePushStrength * nsCursorProx * nsPushScatter * skyRegionGate * skyBndFade;
      }
    }

    // ── Displacement ──
    float skyDriftScatter = 0.6 + skyJitterSeed * 0.8;  // per-particle drift variation
    // Luminance-driven parallax: bright sky (swirl centers, near stars) moves more,
    // dark sky (deep navy between swirls) moves less — implicit depth layering
    float skyLum = dot(a_color, vec3(0.299, 0.587, 0.114));
    float skyLumScale = 0.3 + 0.7 * skyLum;  // dark=30% movement, bright=100%
    pos += skyFlowDir * skyGustNoise * u_skyMaxDrift * skyRegionGate * skyBndFade * skyDriftScatter * skyLumScale * skyGustMix * vortexSuppress * nsGustBoost;
    // Cross-wind Lissajous sway
    float skySwayPhase = skyJitterSeed * 6.283;
    float skySwayWave = sin(u_time * 0.5 + skySwayPhase + skyProj * 3.0);
    pos += skyPerpDir * skySwayWave * u_skyMaxDrift * u_skySwayAmount * skyRegionGate * skyBndFade * skyDriftScatter * skyLumScale * skyGustMix * vortexSuppress * nsGustBoost;

    // ── Star proximity: shared for shimmer + scintillation ──
    // GPU LOD: skip 12-iter star proximity + shimmer + scintillation when reduced
    vec2 shimmerUV = a_homePos;
    shimmerUV.y = 1.0 - shimmerUV.y;  // match star center coordinate space
    float skyStarProx = 0.0;
    for (int i = 0; i < 12; i++) {
      vec2 sDiff = shimmerUV - u_starCenter[i];
      sDiff.x *= u_aspectRatio;
      float sDist = length(sDiff);
      float shimmerRadius = u_starInnerRadius[i] * 3.0;
      skyStarProx = max(skyStarProx, smoothstep(shimmerRadius, 0.0, sDist));
    }

    // Atmospheric refraction: positional jitter near stars
    if (u_skyStarShimmer > 0.001 && skyStarProx > 0.001) {
      float shimmerNoise1 = snoise(vec2(a_homePos.x * 40.0 + u_time * 3.0, a_homePos.y * 40.0));
      float shimmerNoise2 = snoise(vec2(a_homePos.y * 40.0 - u_time * 2.7, a_homePos.x * 40.0 + 5.0));
      vec2 shimmerOffset = vec2(shimmerNoise1, shimmerNoise2) * 0.004 * skyStarProx * u_skyStarShimmer;
      pos += shimmerOffset * skyRegionGate * vortexSuppress;
    }

    // Atmospheric scintillation: brightness/size flicker near stars
    // 25% of eligible particles rotate in/out over time via sliding hash window.
    if (skyStarProx > 0.01) {
      float skyScintHash = fract(sin(dot(a_homePos, vec2(41.31, 67.97))) * 29174.5);
      float skyScintWindow = fract(skyScintHash + u_time * 0.1);
      if (skyScintWindow < 0.25) {
        float skyScintPhase = fract(sin(dot(a_homePos, vec2(93.97, 214.63))) * 29187.413);
        float scintFreq = mix(2.0, 5.0, fract(skyScintPhase * 7.0));
        float pulse = sin(u_time * scintFreq + skyScintPhase * 6.283);
        float sizeMul = 1.0 + (pulse * 0.5 + 0.5) * 1.0 * skyStarProx * skyRegionGate;
        gl_PointSize *= sizeMul;
        v_skyScintPack.z = skyStarProx * skyGustMix * skyRegionGate;
      }
    }

    // ── Cursor wake shimmer: smooth scintillation near cursor trail ──
    // All particles in wake zone pulse (no sparse selection) — nsWakeProx
    // falloff provides spatial variation. Reduced amplitude to compensate.
    if (nsWakeProx > 0.01) {
      float nsScintPhase = fract(sin(dot(a_homePos, vec2(93.97, 214.63))) * 29187.413);
      float nsScintFreq = mix(2.0, 5.0, fract(nsScintPhase * 7.0));
      float nsPulse = sin(u_time * nsScintFreq + nsScintPhase * 6.283);
      float nsSizeMul = 1.0 + (nsPulse * 0.5 + 0.5) * 0.4 * nsWakeProx * skyRegionGate;
      gl_PointSize *= nsSizeMul;
      // No v_speedScintActivation write — cursor wake is size-only, no chromatic shift
    }
  }


  // ── Vortex speed for debug mode 6: proximity × speed ──
  // Flow particles use curvatureSpeed × gustFactor (physics-derived, 0–1).
  // Absorbed particles use proximity × normalized speed.
  // proximity = depth in gravity well: 1.0 at center, 0.0 at edge (linear).
  // speedNorm = vortex angular velocity / max (0–1).
  // Result: center + fast = red, edge + slow = blue. Speed slider controls heat.
  // Fixed floor 0.13: matches flow boundary effectiveSpeed (gustedSpeed × driftScaleFloor).
  // Vortex edge seamlessly continues the flow edge color regardless of speed.
  // Speed only differentiates the interior gradient (proximity × speedNorm).
  if (flowRid == 5 && v_flowPack.y < 0.001 && proximity > 0.0) {
    float vortexSpeed = u_vortexParams[dominantIdx].y;
    float speedNorm = vortexSpeed / 2.5;
    float edgeFloor = 0.13;
    v_flowPack.y = max(proximity * speedNorm, edgeFloor);
    v_flowPack.z = 1.0;
  }

  // ── Hover orbit: two-layer crossfade (like cypress sway) ──
  if (u_hoverIntensity0 > 0.001 || u_hoverIntensity1 > 0.001) {
    vec2 hSeed = a_homePos * 127.1 + a_spiralPos * 311.7;
    float hh1 = fract(sin(dot(hSeed, vec2(12.9898, 78.233))) * 43758.5453);
    float hh2 = fract(sin(dot(hSeed + 1.0, vec2(39.346, 11.135))) * 28573.329);
    float hPhase1 = hh1 * 6.2832;
    float hPhase2 = hh2 * 6.2832;
    vec2 hoverSP = vec2(pos.x * u_canvasSize.x, (1.0 - pos.y) * u_canvasSize.y);
    float _cRef = max(u_canvasSize.x, u_canvasSize.y);
    float _hoverR = _cRef * 0.0625;
    float _hoverBase = _cRef * 0.00146;  // ~3px at 2048
    float _hoverBoost = _cRef * 0.0088;

    // Per-layer orbit: each layer uses its own time (live or frozen).
    // When fading out, the orbit direction freezes so particles retrace
    // straight back to home instead of wobbling along a rotating path.
    float totalHover = 0.0;
    vec2 totalDrift = vec2(0.0);

    // Per-particle stagger: each particle fades at a different rate.
    // Breaks the coherent snap of 513K particles all transitioning together.
    float staggerIn  = 1.0 + hh1 * 1.0;  // fade-in: gentle range 1.0-2.0
    float staggerOut = 1.0 + hh1 * 2.0;  // fade-out: wider range 1.0-3.0

    // Layer 0
    float hm0raw = (u_hoverRegion0 > -0.5)
      ? step(abs(effectiveRegion - u_hoverRegion0), 0.5) * u_hoverIntensity0 : 0.0;
    float hm0 = (u_hoverFreezeTime0 >= 0.0) ? pow(hm0raw, staggerOut) : pow(hm0raw, staggerIn);
    if (hm0 > 0.0) {
      float ht0 = (u_hoverFreezeTime0 >= 0.0 ? u_hoverFreezeTime0 : u_time) * 0.6;
      float a1 = hPhase1 + sin(ht0 * 0.7 + hPhase2) * 3.14159;
      vec2 d0dir = vec2(cos(a1), sin(a1));
      float a2 = hPhase2 + sin(ht0 * 1.3 + hPhase1) * 1.5;
      d0dir += vec2(cos(a2), sin(a2)) * 0.4;
      d0dir *= 0.7 + 0.3 * sin(ht0 * 0.3 + hh1 * 6.28);
      d0dir = normalize(d0dir);
      float dist0 = length(hoverSP - u_hoverCenter0);
      float boost0 = smoothstep(_hoverR, 0.0, dist0);
      float mag0 = (_hoverBase + _hoverBoost * boost0) / u_canvasSize.x * hm0;
      totalDrift += d0dir * mag0;
    }
    // Layer 1
    float hm1raw = (u_hoverRegion1 > -0.5)
      ? step(abs(effectiveRegion - u_hoverRegion1), 0.5) * u_hoverIntensity1 : 0.0;
    float hm1 = (u_hoverFreezeTime1 >= 0.0) ? pow(hm1raw, staggerOut) : pow(hm1raw, staggerIn);
    if (hm1 > 0.0) {
      float ht1 = (u_hoverFreezeTime1 >= 0.0 ? u_hoverFreezeTime1 : u_time) * 0.6;
      float a1 = hPhase1 + sin(ht1 * 0.7 + hPhase2) * 3.14159;
      vec2 d1dir = vec2(cos(a1), sin(a1));
      float a2 = hPhase2 + sin(ht1 * 1.3 + hPhase1) * 1.5;
      d1dir += vec2(cos(a2), sin(a2)) * 0.4;
      d1dir *= 0.7 + 0.3 * sin(ht1 * 0.3 + hh1 * 6.28);
      d1dir = normalize(d1dir);
      float dist1 = length(hoverSP - u_hoverCenter1);
      float boost1 = smoothstep(_hoverR, 0.0, dist1);
      float mag1 = (_hoverBase + _hoverBoost * boost1) / u_canvasSize.x * hm1;
      totalDrift += d1dir * mag1;
    }
    pos += totalDrift;

    // Cursor hotspot: swell with same per-particle stagger during fade-out
    float hoverSwell = 0.0;
    if (hm0 > 0.0) hoverSwell += smoothstep(_hoverR, 0.0, length(hoverSP - u_hoverCenter0)) * hm0;
    if (hm1 > 0.0) hoverSwell += smoothstep(_hoverR, 0.0, length(hoverSP - u_hoverCenter1)) * hm1;
    if (hoverSwell > 0.0) {
      float swellFactor = 1.0 + hoverSwell * 0.4;
      gl_PointSize *= swellFactor;
    }
  }

  // ── Village wind sway: COMMENTED OUT — testing orbital approach instead ──
  // if (int(a_regionId + 0.5) == 2 && u_villageWindAmp > 0.0001) {
  //   vec2 vWindDir = vec2(cos(u_villageWindAngle), sin(u_villageWindAngle));
  //   vec2 vCrossDir = vec2(-vWindDir.y, vWindDir.x);
  //   float vWindProj = dot(a_homePos, vWindDir);
  //   float vCrossProj = dot(a_homePos, vCrossDir);
  //   float vNoise =
  //     0.50 * snoise(vec2(vWindProj * u_villageWindFreq       + u_time * u_villageWindSpeed,       vCrossProj * u_villageWindFreq * 1.5)) +
  //     0.30 * snoise(vec2(vWindProj * u_villageWindFreq * 2.5 + u_time * u_villageWindSpeed * 1.3 + 3.7, vCrossProj * u_villageWindFreq * 3.0)) +
  //     0.20 * snoise(vec2(vWindProj * u_villageWindFreq * 6.0 + u_time * u_villageWindSpeed * 1.8 + 7.1, vCrossProj * u_villageWindFreq * 5.0));
  //   float vCrossNoise =
  //     0.50 * snoise(vec2(vCrossProj * u_villageWindFreq       + u_time * u_villageWindSpeed * 0.7 + 11.3, vWindProj * u_villageWindFreq * 1.5)) +
  //     0.30 * snoise(vec2(vCrossProj * u_villageWindFreq * 2.5 + u_time * u_villageWindSpeed * 0.9 + 17.9, vWindProj * u_villageWindFreq * 3.0));
  //   float vHash = fract(sin(dot(a_homePos, vec2(53.14, 91.73))) * 28461.3);
  //   float vScatter = 0.7 + 0.6 * vHash;
  //   pos += vWindDir  * vNoise      * u_villageWindAmp * vScatter;
  //   pos += vCrossDir * vCrossNoise * u_villageWindAmp * vScatter * 0.3;
  // }

  // ── Village orbital sway: Lissajous-based per-particle motion for region 2 ──
  // v_villagePack defaults set earlier (0.0, 0.0, 1.0, 1.0)
  if (int(a_regionId + 0.5) == 2 && u_regionActive[1] > 0.001) {
    // Per-particle fade-out stagger: shift each particle's gate threshold by
    // up to ±0.05 rA units based on hash. Without this, every displaced
    // particle rides the same vGate → they all converge to home positions
    // on the same frame sequence → convergence pile-up creates a visible
    // brightness pop. The shift spreads "return to home" across ~15 frames.
    // u_villageFadeOut = 0 during active/looping, so unified gate is preserved.
    float vFadeHash = fract(sin(dot(a_homePos, vec2(45.31, 197.81))) * 33791.419);
    float vGateShift = u_villageFadeOut * (vFadeHash - 0.5) * 0.10;
    float vGate = smoothstep(0.0, 0.3, u_regionActive[1] + vGateShift);

    // Per-particle orbit seeds (same hash approach as ambient dance)
    vec2 vSeed = a_homePos * 127.1 + a_spiralPos * 311.7;
    float vh1 = fract(sin(dot(vSeed, vec2(12.9898, 78.233))) * 43758.5453);
    float vh2 = fract(sin(dot(vSeed + 1.0, vec2(39.346, 11.135))) * 28573.329);

    // Orbital time — slightly different rate from ambient dance so they don't sync
    float vt = u_time * 0.5;
    float vPhase1 = vh1 * 6.2832;
    float vPhase2 = vh2 * 6.2832;

    // Two-harmonic Lissajous orbit
    float vAngle1 = vPhase1 + sin(vt * 0.7 + vPhase2) * 3.14159;
    vec2 vDrift = vec2(cos(vAngle1), sin(vAngle1));
    float vAngle2 = vPhase2 + sin(vt * 1.3 + vPhase1) * 1.5;
    vDrift += vec2(cos(vAngle2), sin(vAngle2)) * 0.4;

    // Breathing amplitude modulation
    vDrift *= 0.7 + 0.3 * sin(vt * 0.3 + vh1 * 6.28);
    vDrift = normalize(vDrift);

    // Per-particle angle jitter — rotates each particle's orbit axis
    // Uses a different hash seed than orbit phases to avoid correlation
    float vAngleHash = fract(sin(dot(vSeed + 2.0, vec2(71.917, 153.247))) * 41623.871);
    float vJitterAngle = (vAngleHash - 0.5) * 6.2832 * u_villageSwayAngle;  // 0=none, 1=±180°
    float vjCos = cos(vJitterAngle), vjSin = sin(vJitterAngle);
    vDrift = vec2(vDrift.x * vjCos - vDrift.y * vjSin,
                  vDrift.x * vjSin + vDrift.y * vjCos);

    // Edge fade: taper displacement near village boundary
    float vEdgeDist = texture(u_distPackTex, a_homePos).b;
    float vEdgeFade = smoothstep(0.0, u_villageEdgeDepth, vEdgeDist);

    v_villagePack.x = vEdgeFade;

    // Luminance parallax: bright particles (lit windows) move more,
    // dark particles (stone walls, shadows) stay heavier (BT.601)
    float vLum = dot(a_color, vec3(0.299, 0.587, 0.114));
    float vLumScale = mix(1.0, 0.4 + 0.6 * vLum, u_villageLumParallax);

    // Drift scatter: per-particle amplitude variation (0.7–1.3×)
    float vDriftScatter = 0.7 + vh2 * 0.6;

    // Breathing: phase-accumulated oscillator (no phase jumps on rate change)
    // Floor of 0.3 so the village never goes fully still
    float vBreathRaw = sin(u_villageBreathPhase);
    float vBreath = 1.0 - u_villageBreathDepth * 0.7 * (1.0 - (vBreathRaw * 0.5 + 0.5));

    // Cursor proximity boost: orbital sway intensifies near cursor
    float vCursorBoost = 1.0;
    if (u_villageAttraction > 0.001) {
      float vCBDist = length(a_homePos - u_villageWindCenter);
      float vCBFalloff = 1.0 / (1.0 + (vCBDist * vCBDist) / (u_villageWindRadius * u_villageWindRadius));
      vCursorBoost = 1.0 + vCBFalloff * u_villageAttraction * 3.0;
    }

    float vAmp = u_villageWindAmp * vGate * vEdgeFade * vLumScale * vDriftScatter * vBreath * vCursorBoost;
    pos += vDrift * vAmp;

    // ── Wind noise: coordinated directional waves (cypress-style architecture) ──
    if (u_villageNoiseAmp > 0.001) {
      vec2 vWindDir = vec2(cos(u_villageWindAngle), sin(u_villageWindAngle));
      vec2 vCrossDir = vec2(-vWindDir.y, vWindDir.x);
      float vWindProj = dot(a_homePos, vWindDir);

      // 3-octave simplex noise — hardcoded per-octave frequencies (cypress pattern)
      // All octaves maintain ~0.05 spatial velocity (speed/freq) so they travel together
      float vNoise =
        0.50 * snoise(vec2(vWindProj * 2.0  + u_time * 0.10,       a_homePos.y * 3.0 + 17.3)) +
        0.30 * snoise(vec2(vWindProj * 5.0  + u_time * 0.25 + 3.7, a_homePos.x * 7.0 + 29.1)) +
        0.20 * snoise(vec2(vWindProj * 11.0 + u_time * 0.55 + 7.1, a_homePos.y * 12.0));

      // Global 25-second breathing: shared with cypress and sky gust
      vNoise *= u_breatheWave;

      // Primary wind displacement
      float vNoiseMag = vNoise * u_villageNoiseAmp * u_villageNoiseDrift * vGate * vEdgeFade * vLumScale * vDriftScatter;

      // Cross-wind Lissajous sway (perpendicular ripple, not a second noise sample)
      float vCrossWave = sin(u_time * 0.3 + vh1 * 6.2832 + vWindProj * 4.0);
      float vCrossMag = vCrossWave * u_villageNoiseDrift * u_villageCrossSway * vGate * vEdgeFade * vLumScale * vDriftScatter;

      pos += vWindDir  * vNoiseMag;
      pos += vCrossDir * vCrossMag;
    }

    // ── Warm twinkle: sparse candlelight flicker on warm-toned particles ──
    if (u_villageTwinkle > 0.01) {
      // Color warmth gate: red-dominant particles are eligible (windows, warm stone)
      float vWarmth = a_color.r - a_color.b;
      if (vWarmth > u_villageTwinkleWarmth) {
        // Sparse hash selection: percentage of warm particles
        float vTwinkleHash = fract(sin(dot(a_homePos, vec2(83.41, 197.53))) * 31547.9);
        if (vTwinkleHash < 0.15) {  // 15% for debugging — tune down once confirmed working
          // Per-particle phase and frequency: 1-3 Hz (slow candlelight gutter)
          float vTwinklePhase = fract(sin(dot(a_homePos, vec2(117.29, 63.71))) * 24891.3);
          float vTwinkleFreq = mix(1.0, 3.0, vTwinklePhase);

          // Sine pulse: positive half = glow, negative = dark
          float vTwinklePulse = max(0.0, sin(u_time * vTwinkleFreq + vTwinklePhase * 6.283));

          float vTwinkleActivation = vTwinklePulse * u_villageTwinkle * vGate;

          // Subtle size pop (1.0 → 1.15x at peak)
          gl_PointSize *= 1.0 + vTwinkleActivation * 0.15;

          v_villagePack.y = vTwinkleActivation;
        }
      }
    }

    // ── Swarm lifecycle: funnel → wind transition with birth/death cycle ──
    // Close cursor: particles funnel toward cursor (convergent).
    // Far cursor: particles flow in direction of cursor (parallel wind).
    // Blend based on cursor distance from click origin.
    // When attraction=0, no displacement, alpha stays 1.0.
    {
      vec2 vToCursor = u_villageWindCenter - a_homePos;
      float vDistToCursor = length(vToCursor);
      vec2 vFunnelDir = vDistToCursor > 0.001 ? vToCursor / vDistToCursor : vec2(0.0);

      // Wind direction: blend anchor from clickOrigin → exitPoint as cursor
      // separates from exit. Prevents zero-length dir on first exit while
      // giving smooth re-entry angles when cursor sweeps around the boundary.
      vec2 vOriginToCursor = u_villageWindCenter - u_villageClickOrigin;
      vec2 vExitToCursor   = u_villageWindCenter - u_villageExitPoint;
      float vExitSep = length(vExitToCursor);
      float vAnchorBlend = smoothstep(0.0, 0.08, vExitSep);
      vec2 vAnchorDir = mix(vOriginToCursor, vExitToCursor, vAnchorBlend);
      float vAnchorLen = length(vAnchorDir);
      vec2 vWindDir = vAnchorLen > 0.001 ? vAnchorDir / vAnchorLen : vec2(0.0);

      // Wind blend: JS-computed from region map (cursor in/out of village), smoothed
      float vWindBlend = u_villageWindBlend;

      // Direction: convergent funnel → parallel wind
      vec2 vSwarmDir = mix(vFunnelDir, vWindDir, vWindBlend);

      // Participation falloff: active radius (idle falloff computed only in variable-period branch)
      float vFunnelFalloff = 1.0 / (1.0 + (vDistToCursor * vDistToCursor) / (u_villageWindRadiusActive * u_villageWindRadiusActive));
      // Wind participation: inverse-square falloff centered on exit point, radius expanding over time
      // Outer gate cuts off beyond ripple radius so distant particles aren't affected by the tail
      float vDistFromExit = length(a_homePos - u_villageExitPoint);
      float vWindFalloff = 1.0 / (1.0 + (vDistFromExit * vDistFromExit) / (u_villageWindRippleRadius * u_villageWindRippleRadius));
      float vWindGate = 1.0 - smoothstep(u_villageWindRippleRadius * 0.7, u_villageWindRippleRadius, vDistFromExit);
      float vWindParticipation = vWindFalloff * vWindGate * vEdgeFade;
      float vSwarmFalloff = mix(vFunnelFalloff, vWindParticipation, vWindBlend);
      float vSwarmParticipation = vSwarmFalloff * u_villageAttraction;

      if (vSwarmParticipation > 0.01) {
        // Per-particle deterministic hashes for lifecycle staggering
        float vSwH1 = fract(sin(dot(a_homePos, vec2(127.1, 311.7))) * 43758.5453);
        float vSwH2 = fract(sin(dot(a_homePos + 1.0, vec2(269.5, 183.3))) * 28573.329);
        float vSwH3 = fract(sin(dot(a_homePos, vec2(53.14, 91.73))) * 28461.3);
        float vSwH4 = fract(sin(dot(a_homePos + 2.0, vec2(37.17, 159.83))) * 51493.7);

        // Cycle period: fixed (repeating wave) or variable (one-time bunching)
        float vCyclePeriod;
        float vPhaseHash;
        if (u_swarmLfoSync > 0.5) {
          vCyclePeriod = 1.0;
          vPhaseHash = vSwH4 * u_swarmPhaseSpread;
        } else if (u_swarmFixedPeriod > 0.01) {
          vCyclePeriod = u_swarmFixedPeriod;
          vPhaseHash = vSwH4 * u_swarmPhaseSpread;
        } else {
          // Variable: use idle-radius falloff for speed — close particles cycle faster
          float vIdleFalloff = 1.0 / (1.0 + (vDistToCursor * vDistToCursor) / (u_villageWindRadius * u_villageWindRadius));
          vCyclePeriod = mix(u_swarmCyclePeriodMax, u_swarmCyclePeriodMin, vIdleFalloff) * (0.7 + vSwH1 * 0.6);
          // Funnel: correlated hash (H1) creates the one-time phase bunching wave.
          // Wind: decorrelated hash (H4) keeps phases uniform — no bunching.
          vPhaseHash = mix(vSwH1, vSwH4, vWindBlend);
        }

        // Phase-staggered lifecycle time
        float vSwarmT;
        if (u_swarmLfoSync > 0.5) {
          vSwarmT = fract(u_villageBreathPhase / 6.2832 + vPhaseHash);
        } else {
          vSwarmT = fract((u_villageSwarmTime + vPhaseHash * vCyclePeriod) / vCyclePeriod);
        }

        // Drift fraction: JS-smoothed independently from windBlend.
        // Decays slowly on re-entry (2s) so particles don't snap from 98% to 50%.
        float vDriftFrac = u_swarmDriftFracSmoothed;
        float vWindFadeIn = mix(u_swarmFadeIn, 0.05, vWindBlend);          // quick appear in wind
        float vWindFadeOut = mix(u_swarmFadeOutStart, 0.92, vWindBlend);   // late fade in wind
        float vWindDeathFade = mix(u_swarmDeathFadeWidth, 0.05, vWindBlend); // tight death in wind
        float vWindEarlyDeath = mix(u_swarmEarlyDeathPct, 0.0, vWindBlend); // no early death in wind
        float vSwarmLifecycleAlpha;

        if (vSwarmT < vDriftFrac) {
          float vDriftT = vSwarmT / vDriftFrac;

          // Fade envelope (gentler in wind mode)
          float vFadeIn  = smoothstep(0.0, vWindFadeIn, vDriftT);
          float vFadeOut = 1.0 - smoothstep(vWindFadeOut, 1.0, vDriftT);
          vSwarmLifecycleAlpha = vFadeIn * vFadeOut;

          // S-curve drift progress
          float vProgress = smoothstep(0.0, 1.0, smoothstep(0.0, 1.0, vDriftT));

          // Stochastic death
          float vDeathFrac = vSwH2 < vWindEarlyDeath
            ? mix(0.30, 0.85, vSwH2 / max(0.001, vWindEarlyDeath))
            : mix(0.85, 1.00, (vSwH2 - vWindEarlyDeath) / max(0.001, 1.0 - vWindEarlyDeath));

          float vClampedProgress = min(vProgress, vDeathFrac);
          float vDeathFade = 1.0 - smoothstep(vDeathFrac - vWindDeathFade, vDeathFrac, vProgress);
          vSwarmLifecycleAlpha *= vDeathFade;

          // Displacement: blend between funnel (distance-limited) and wind (uniform drift)
          float vDriftScatter = 0.7 + 0.6 * vSwH3;
          float vFunnelMaxDrift = min(vDistToCursor, u_villageAttractionAmpActive * u_swarmMaxDriftMul);
          float vWindMaxDrift = u_villageAttractionAmpActive * u_swarmMaxDriftMul;
          float vMaxDrift = mix(vFunnelMaxDrift, vWindMaxDrift, vWindBlend);
          pos += vSwarmDir * vMaxDrift * vClampedProgress * vDriftScatter * vSwarmParticipation * vGate;

        } else {
          // Dead phase: invisible, snapped to home
          vSwarmLifecycleAlpha = 0.0;
        }

        // Blend lifecycle alpha by participation
        v_villagePack.z = mix(1.0, vSwarmLifecycleAlpha, vSwarmParticipation);
      }
    }
  }

  // ── Position to NDC ──
  vec2 ndc = pos * 2.0 - 1.0;
  ndc.y = -ndc.y;

  gl_Position = vec4(ndc, 0.0, 1.0);

  // ── Pass data to fragment shader ──

  // ── Living canvas deformation: subtle UV warp along flow direction ──
  vec2 canvasDeform = vec2(0.0);

  if (u_canvasDeformAmp > 0.0001 && u_flowMix > 0.01 && isFlowRegion) {
    // Gate per region: flowRid 4 by Horizon, flowRid 3 by Night Sky.
    // Sky gust particles already have effectiveRegion/flowRid = 3 from unification.
    float deformGate = (flowRid == 4)
      ? smoothstep(0.0, 0.3, u_regionActive[3])
      : smoothstep(0.0, 0.3, u_regionActive[2]);
    float dfCos = flowSamp.g * 2.0 - 1.0;
    float dfSin = flowSamp.b * 2.0 - 1.0;
    vec2 dfDir = vec2(dfCos, dfSin);

    float spatialPhase = dot(a_homePos, dfDir) * 8.0;
    float wave = sin(u_time * 1.05 + spatialPhase);
    canvasDeform = dfDir * wave * u_canvasDeformAmp * flowSamp.r * u_flowMix * deformGate;
  }

  // Color advection + canvas deformation
  if (u_colorAdvect > 0.001 && proximity > 0.0) {
    vec2 displacement = pos - a_homePos;
    vec2 lookupUV = a_homePos + canvasDeform + displacement * u_colorAdvect;
    vec3 advectedColor = texture(u_paintingTex, lookupUV).rgb;
    v_rawColor = mix(a_color, advectedColor, proximity);
  } else if (length(canvasDeform) > 0.00001) {
    // No vortex — color delta preserves a_color base
    vec2 baseUV = a_homePos + canvasDeform;
    vec3 homeColor = texture(u_paintingTex, a_homePos).rgb;
    vec3 deformColor = texture(u_paintingTex, baseUV).rgb;
    v_rawColor = a_color + (deformColor - homeColor);
  } else {
    v_rawColor = a_color;
  }
  v_vortexPack   = vec4(proximity, edgeLock, maxFadeAge, maxFadeDuration);
  // Per-particle deterministic hash in .w (0-1 range) — used by fragment-shader
  // fade-out staggering so particles don't all snap together at the end of a
  // region color fade. See u_villageFadeOut in frag shader.
  float particleHash = fract(sin(dot(a_homePos, vec2(12.9898, 78.233))) * 43758.5453);
  v_metaPack     = vec4(a_regionId, effectiveRegion, basePS, particleHash);

  v_homePos      = a_homePos;

  // Debug mode 4: boost flow particles so directional arrows are visible
  if (u_debugMode == 4 && a_coherence > 0.01) {
    gl_PointSize = max(gl_PointSize, 8.0);
  }

}
`;

const RENDER_FRAG = `#version 300 es
precision highp float;
precision highp int;

in vec3 v_rawColor;
in vec4 v_vortexPack;   // x=proximity, y=edgeLock, z=fadeAge, w=fadeDuration
in vec4 v_metaPack;     // x=regionId, y=effectiveRegion, z=pointSize, w=particleHash
// v_blinkPulse in v_miscPack.x
in vec2 v_homePos;
in vec4 v_skyScintPack; // x=skyGustIntensity, y=scintActivation, z=speedScintActivation, w=coherence
in vec4 v_flowPack;    // x=flowAlpha, y=coherenceSpeed, z=driftScale, w=flowAngle
in vec4 v_cypressPack;  // x=swayIntensity, y=edgeProximity, z=leafFlash, w=rimGlow
in vec4 v_villagePack;  // x=edgeFade, y=twinkle, z=villageSwarmAlpha, w=cypressFlowAlpha
in vec4 v_miscPack;     // x=blinkPulse, y=unused, z=unused, w=unused
// v_effectiveRegion in v_metaPack.y

uniform float u_regionMix[6];
uniform float u_regionActive[5];       // per-region smoothed intensity (0=off, 0.25=on, 1.0=active)
uniform vec2  u_regionClickOrigin[5];  // UV click position that activated each region
uniform float u_regionRadius[5];       // eased radial expansion (0→1, 1=fully expanded)
uniform float u_villageFadeOut;        // 1.0 while region 2 is fading out — enables per-particle stagger
// Per-star glow uniforms (12 stars, audio-reactive breathing)
uniform vec2  u_starCenter[12];        // star positions in canvas UV (updated per frame)
uniform float u_starCurrentRadius[12]; // per-star modulated glow radius (base × (1 + mod))
uniform float u_starInnerRadius[12];  // per-star boundary radius (corona starts outside this)
uniform float u_starGlowIntensity[12]; // per-star glow brightness (0–1, strum + envelope driven)
uniform float u_starGlowActive;       // 1.0 = any star glowing (skip loop when 0)
uniform float u_starScintillation;    // chorus-driven per-particle twinkle (0 = calm, 1 = max)
uniform float u_starHaloSoftness;     // reverb-driven edge softness (0 = sharp, 1 = diffuse)
uniform float u_luminancePreserve;
uniform float u_baseAlpha;            // global particle opacity (0 = invisible, 1 = full)
uniform float u_cypressCanopyGlow;   // canopy luminance breathing intensity (0 = off)
uniform float u_cypressLeafFlash;   // 1.0 = leaf flash enabled, 0.0 = disabled
uniform float u_cypressRimGlow;     // 1.0 = enabled, 0.0 = disabled (console flag)
uniform int   u_debugMode;
uniform float u_vignetteStrength;   // 0 = off, 0.3 = corners dim to 70%
uniform vec2  u_resolution;         // canvas size for vignette UV
uniform float u_borderWidth;        // painting border width in pixels (0 = off)
uniform float u_borderRadius;      // corner radius in pixels (0 = sharp)
uniform vec3  u_borderColor;        // border line color
uniform float u_introMode;          // 1.0 = intro (only flashlight visible), 0.0 = normal
uniform float u_introGlow;          // fixed center glow intensity (0-1), independent of flashlight
uniform float u_introGlowRadius;    // center glow radius in canvas pixels
uniform float u_revealBrightness;   // eases 0.4 → 1.0 during reveal
uniform float u_margin;             // painting inset from canvas edge in pixels
uniform sampler2D u_clickRemapTex;  // R8: click-resolved region ID (enclosed region 3 → 4)

// Flashlight color-reveal
uniform float u_time;               // shared with vertex shader (same program)
uniform vec4  u_flashTrail[24];     // ring buffer: (x, y, birthTime, valid)
uniform float u_flashRadius;        // radius in canvas pixels
uniform float u_flashDecay;         // persistence duration in seconds

// RENDER_DEBUG_FRAG replaces the next line with debug helper functions.
// Keeping them out of the main fragment shader eliminates ~190 lines + 2 fbm
// loops from D3DCompile, saving ~10-15% link time.
// <DEBUG_HELPERS_INJECTION>

out vec4 fragColor;

void main() {
  // ── Soft circular point / streak shape ──
  float edge = 1.0;
  float halfPx = v_metaPack.z * 0.5;

  if (v_metaPack.z > 1.5) {
    vec2 uv = gl_PointCoord - 0.5;
    float dist = length(uv);
    if (dist > 0.5) discard;
    edge = smoothstep(0.5, 0.35, dist);
  }

  // (CME alpha fade removed)

  // RENDER_DEBUG_FRAG replaces the next line with u_debugMode branches. Leave
  // the marker intact; in the main program it's a no-op comment.
  // <DEBUG_MODES_INJECTION>

  // ── Color computation ──
  float peak = max(v_rawColor.r, max(v_rawColor.g, v_rawColor.b));
  vec3 boosted = v_rawColor / max(peak, 0.001);
  vec3 colorRef = mix(boosted, v_rawColor, u_luminancePreserve);

  // Per-region color reveal (uses effective region — absorbed particles get star behavior)
  int region = int(v_metaPack.y + 0.5);
  float rawRegionMix = u_regionMix[clamp(region, 0, 5)];
  float mix_val = rawRegionMix;

  // Fade-in: color blooms from center outward like ink bleeding from a source.
  // Outer particles are delayed so color appears at the core first, then
  // spreads toward the edges over the fade duration.
  float spatialDelay = (1.0 - v_vortexPack.x) * v_vortexPack.w * 0.5;
  float innerFade = smoothstep(0.0, v_vortexPack.w, v_vortexPack.z - spatialDelay);

  // Gravity-based color reveal (low threshold to prevent white flash at boundary)
  float colorFromGravity = smoothstep(0.0, 0.08, v_vortexPack.x) * v_vortexPack.y * innerFade;
  mix_val = max(mix_val, colorFromGravity);

  // ── Flashlight reveal ──────────────────────────────────────────────────
  // Penumbra model: bright hotspot at center (75%) fades to ~50% at mid-range,
  // then falls to 0% at the edge. Two components blended:
  //   - linear falloff (0.6 weight): smooth base penumbra across full radius
  //   - squared falloff (0.4 weight): concentrates brightness at center (hotspot)
  float flashlight = 0.0;
  if (u_flashRadius > 0.0) {
    for (int i = 0; i < 24; i++) {
      vec4 trail = u_flashTrail[i];
      if (trail.w < 0.5) continue;                        // slot empty
      float age = u_time - trail.z;
      if (age < 0.0 || age > u_flashDecay) continue;      // expired
      float decay = 1.0 - age / u_flashDecay;
      float dist = length(gl_FragCoord.xy - trail.xy);
      float raw = smoothstep(u_flashRadius, 0.0, dist);
      float spot = (raw * 0.6 + raw * raw * 0.4) * decay; // penumbra + hotspot
      flashlight = max(flashlight, spot);
    }
  }
  mix_val = max(mix_val, flashlight);

  // ── Per-region color activation (radial reveal from click origin) ──
  int rIdx = region - 1;
  if (rIdx >= 0 && rIdx < 5) {
    float regionIntensity = u_regionActive[rIdx];

    // Per-particle stagger on village (rIdx=1) fade-out only. Each particle
    // follows its own exponent curve (1.0–2.0, seeded by v_metaPack.w hash)
    // so they don't all snap to invisible on the same frame at the end of a
    // uniform-intensity fade. Fade-in remains uniform for snappy activation.
    if (rIdx == 1 && u_villageFadeOut > 0.5) {
      float staggerOut = 1.0 + v_metaPack.w;  // range 1.0–2.0 per particle
      regionIntensity = pow(regionIntensity, staggerOut);
    }

    if (regionIntensity > 0.001) {
      // Radial expansion from click origin
      vec2 clickOrigin = u_regionClickOrigin[rIdx];
      float regionRadius = u_regionRadius[rIdx];

      // Distance from this particle to the click origin (in UV space)
      vec2 particleUV = gl_FragCoord.xy / u_resolution;
      float distToClick = length(particleUV - clickOrigin);

      // Max possible distance in UV space is ~1.4 (diagonal), normalize
      // Use a generous max so the radius comfortably covers any region
      float maxDist = 1.5;
      float normDist = distToClick / maxDist;

      // Particle is "reached" if within the expanding radius
      float reached = smoothstep(regionRadius, regionRadius - 0.05, normDist);

      // Final region color contribution
      float regionColor = reached * regionIntensity;

      // Combine with existing mix_val — region activation takes precedence
      mix_val = max(mix_val, regionColor);
    }
  }

  // ── Star glow: per-star radiant breathing ──
  // Each star is a point light source that reveals color in nearby particles.
  // Bleeds into sky (3) and horizon (4) only — not cypress (1) or village (2).
  // ── Star glow debug: set window._starGlowTest = 1 to force ALL region 3/4/5 bright,
  //    = 2 to test distance logic with large radius, = 0 (default) for normal behavior.
  float starColor = 0.0;
  if (u_starGlowActive > 0.5) {
    vec2 starUV = gl_FragCoord.xy / u_resolution;
    float aspect = u_resolution.x / u_resolution.y;

    float starInfluence = 0.0;

    float falloffExp = mix(1.5, 0.4, u_starHaloSoftness);
    float radiusExtend = 1.0 + u_starHaloSoftness * 0.2;

    // Per-star glow with individual intensity
    for (int i = 0; i < 12; i++) {
      if (u_starGlowIntensity[i] < 0.001) continue;
      vec2 diff = starUV - u_starCenter[i];
      diff.x *= aspect;
      float distSq = dot(diff, diff);
      float glowRadius = u_starCurrentRadius[i] * radiusExtend;
      float glowRadiusSq = glowRadius * glowRadius;
      if (distSq >= glowRadiusSq) continue;
      float dist = sqrt(distSq);
      float t = dist / glowRadius;
      // G15: Approximate pow(1-t, falloffExp) with ALU blend.
      // falloffExp ∈ [0.4, 1.5]. blend maps n=1→linear, n=2→quadratic.
      // Max ~14% error at n=0.4 midpoint — imperceptible for glow falloff.
      float x = 1.0 - t;
      float falloff = x * mix(1.0, x, falloffExp - 1.0) * u_starGlowIntensity[i];
      starInfluence = max(starInfluence, falloff);
    }

    // Scintillation sparkle — density eases 0%→1.25% (matches vertex shader mask)
    float scintillation = 1.0;
    if (u_starScintillation > 0.001 && starInfluence > 0.0) {
      float scintPhase = fract(sin(dot(v_homePos, vec2(93.97, 214.63))) * 29187.413);
      float scintThreshold = 0.0125 * smoothstep(0.0, 0.15, u_starScintillation);
      if (scintPhase < scintThreshold) {
        float flicker = sin(u_time * 3.0 + scintPhase * 6.283)
                      * sin(u_time * 3.0 * 1.73 + scintPhase * 3.14);
        float depth = mix(0.0, 0.5, u_starScintillation);
        float edgeBias = 1.0 - starInfluence * 0.5;
        scintillation = 1.0 + (flicker * 0.5 + 0.5) * depth * edgeBias;
      }
    }

    starColor = starInfluence * scintillation;
    mix_val = max(mix_val, starColor);
  }

  // Simplified saturation: active regions → full color, hover → half color.
  // u_regionActive ramps to 1.0 during building/hold, 0 during hover.
  vec3 halfColor = mix(vec3(1.0), colorRef, 0.5);
  float sat = 0.0;
  if (rIdx >= 0 && rIdx < 5) {
    sat = max(sat, u_regionActive[rIdx]);
  }
  sat = max(sat, starColor);  // star glow drives full saturation
  sat = max(sat, rawRegionMix);
  vec3 finalColor = mix(halfColor, colorRef, sat);

  // Brightness boost: blinking stars flare toward white at peak
  finalColor = mix(finalColor, vec3(1.0), v_miscPack.x * 0.7);

  // Final: white (no gravity/regions) -> colored (full reveal)
  vec3 color = mix(vec3(1.0), finalColor, mix_val);

  // Star glow additive emission: brightens particles near stars instead of
  // just revealing dark painting colors. Uses warm tint (matches corona palette).
  if (starColor > 0.0) {
    vec3 warmTint = vec3(1.0, 0.92, 0.75);  // warm white — matches star corona temperature
    color += warmTint * starColor * 0.3;
  }

  // ── Village warm twinkle: candlelight glow on warm-toned particles ──
  if (region == 2 && v_villagePack.y > 0.01) {
    // Warm additive tint: amber/orange candlelight
    vec3 candleTint = vec3(0.5, 0.3, 0.08);  // boosted for debugging
    color += candleTint * v_villagePack.y;
    color *= 1.0 + v_villagePack.y * 0.8;   // boosted for debugging
  }

  // ── Cypress canopy luminance breathing ──
  // Wind-driven brightness: canopy brightens during gusts as leaves turn and
  // expose lighter undersides, darkens when calm. Driven by cypressPack.x
  // (wind noise × height factor) — treetop glows more than base.
  // Console toggle: window._dvs_noCypressGlow = true to disable.
  if (region == 1 && u_cypressCanopyGlow > 0.001 && v_cypressPack.x > 0.001) {
    float canopyGlow = v_cypressPack.x * u_cypressCanopyGlow;
    color *= 1.0 + canopyGlow;
  }

  // ── Cypress specular leaf flash: sparse bright pops on wind-turned leaves ──
  // Console toggle: window._dvs_noCypressFlash = true to disable.
  if (region == 1 && v_cypressPack.z > 0.01) {
    // Peak: 1.5x brightness. Subtle — reads as light catching a glossy
    // leaf surface, not a star-like flare.
    color *= 1.0 + v_cypressPack.z * 0.5;
  }

  // ── Cypress edge rim glow: backlight bleed at silhouette edges during gusts ──
  // Console toggle: window._dvs_noCypressRim = true to disable.
  if (region == 1 && v_cypressPack.w > 0.01) {
    // Peak: 1.3x brightness. Subtle backlit edge.
    color *= 1.0 + v_cypressPack.w * 0.3;
  }

  // ── Chromatic scintillation: warm gold ↔ cool blue-white color shifts ──
  // Real atmospheric scintillation refracts different wavelengths at
  // different angles — stars flash colors, not just brightness.
  // Purely additive: nothing darkens, just brief warm/cool tints.
  if (v_skyScintPack.y > 0.01) {
    float scintPhase = fract(sin(dot(v_homePos, vec2(93.97, 214.63))) * 29187.413);
    // Chromatic oscillation — different speed than brightness flicker
    // so color and brightness don't peak in lockstep
    float chromaPhase = sin(u_time * 4.5 + scintPhase * 628.3);
    // Warm gold ↔ cool blue-white additive tints
    vec3 warmAdd = vec3(0.30, 0.18, 0.0);    // gold
    vec3 coolAdd = vec3(0.0,  0.12, 0.30);   // blue-white
    vec3 chromaShift = mix(coolAdd, warmAdd, chromaPhase * 0.5 + 0.5);
    color += chromaShift * v_skyScintPack.y * u_starScintillation;
  }

  // Rectangular vignette — darkens outer edges for depth
  vec2 vignetteUV = gl_FragCoord.xy / u_resolution;
  vec2 vignetteD = abs(vignetteUV - 0.5) * 2.0;  // 0 at center, 1 at edges
  float vignette = 1.0 - dot(vignetteD * vignetteD, vignetteD * vignetteD); // quartic falloff
  vignette = smoothstep(0.0, 1.0, vignette);
  vignette = mix(1.0 - u_vignetteStrength, 1.0, vignette);
  color *= vignette;

  // Rounded rectangle SDF — distance from painting edge (negative = outside)
  {
    vec2 halfSize = u_resolution * 0.5 - u_margin;
    vec2 p = gl_FragCoord.xy - u_resolution * 0.5;
    vec2 d = abs(p) - (halfSize - u_borderRadius);
    float sdf = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - u_borderRadius;
    // sdf < 0 = inside, sdf > 0 = outside rounded rect

    // Discard pixels outside the rounded corners
    if (sdf > 0.0) discard;

    // Border line + inner glow using distance from edge
    float edgeDist = -sdf; // positive = pixels inside from edge
    if (u_borderWidth > 0.0) {
      float borderLine = 1.0 - smoothstep(0.0, u_borderWidth, edgeDist);
      float innerGlow = 1.0 - smoothstep(0.0, u_borderWidth * 3.0, edgeDist);
      innerGlow *= 0.15;
      color = mix(color, u_borderColor, borderLine + innerGlow * (1.0 - borderLine));
    }
  }


  // (Shock front glow removed)

  // ── Speed scintillation: brightness flicker + painting-color chromatic shift ──
  if (v_skyScintPack.z > 0.01) {
    float speedScintPhase = fract(sin(dot(v_homePos, vec2(93.97, 214.63))) * 29187.413);

    // Brightness flicker — dual beating sinusoids (irregular, non-mechanical)
    float flicker = sin(u_time * 3.5 + speedScintPhase * 6.283)
                  * sin(u_time * 3.5 * 1.61 + speedScintPhase * 3.14);
    float depth = 0.8;  // 80% brightness variation
    float brightnessBoost = 1.0 + (flicker * 0.5 + 0.5) * depth * v_skyScintPack.z;
    color *= brightnessBoost;

    // Chromatic shift — warm/cool oscillation of the particle's OWN color.
    // No foreign hues introduced; the painting palette just breathes.
    // Different frequency than brightness (5.0 vs 3.5) so they don't peak in lockstep.
    float chromaPhase = sin(u_time * 5.0 + speedScintPhase * 628.3);
    vec3 warmMul = vec3(1.15, 1.05, 0.85);   // lift reds/greens, cool blues
    vec3 coolMul = vec3(0.85, 0.95, 1.15);   // suppress reds, lift blues
    vec3 chromaMul = mix(coolMul, warmMul, chromaPhase * 0.5 + 0.5);
    color *= mix(vec3(1.0), chromaMul, v_skyScintPack.z);
  }

  // Flow lifecycle: fade particles in/out during drift, invisible during rest
  float finalAlpha = edge * v_flowPack.x * v_villagePack.w * v_villagePack.z * u_baseAlpha;

  // ── Intro mode: vignette + flashlight visibility gating ──
  // u_introMode eases from 1.0 → 0.0 so vignette dissolves smoothly
  if (u_introMode > 0.001) {
    float centerDist = length(gl_FragCoord.xy - u_resolution * 0.5);
    float centerGlow = smoothstep(u_introGlowRadius, u_introGlowRadius * 0.3, centerDist) * u_introGlow;
    float dimming = u_revealBrightness;
    float introVis = max(centerGlow * dimming, flashlight * 0.4);
    // Blend between vignette-gated alpha and full alpha as intro fades out
    finalAlpha *= mix(1.0, introVis, u_introMode);
  }

  fragColor = vec4(color, finalAlpha);
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Debug render fragment — RENDER_FRAG + debug helper functions + 9 debug mode
// blocks. Compiled on first V-key press, not at init. Same vertex shader.
// ────────────────────────────────────────────────────────────────────────────

const _DEBUG_FRAG_HELPERS = `
vec3 regionDebugColor(int rid) {
  if      (rid == 0) return vec3(0.12);
  else if (rid == 1) return vec3(0.1, 0.4, 0.1);
  else if (rid == 2) return vec3(0.6, 0.4, 0.2);
  else if (rid == 3) return vec3(0.08, 0.12, 0.35);
  else if (rid == 4) return vec3(0.35, 0.6, 1.0);
  else if (rid == 5) return vec3(1.0, 0.9, 0.2);
  else               return vec3(1.0, 0.0, 0.0);
}
`;

const _DEBUG_FRAG_MODES = `
  if (u_debugMode == 4) {
    if (v_skyScintPack.w > 0.01) {
      vec2 pc = gl_PointCoord * 2.0 - 1.0; pc.y = -pc.y;
      float ca = cos(-v_flowPack.w), sa = sin(-v_flowPack.w);
      vec2 r = vec2(pc.x*ca - pc.y*sa, pc.x*sa + pc.y*ca);
      float lineW = 0.2;
      float isBody = step(abs(r.y), lineW) * step(-0.8, r.x) * step(r.x, 0.3);
      float headProgress = clamp((r.x - 0.3) / 0.6, 0.0, 1.0);
      float headW = 0.5 * (1.0 - headProgress);
      float isHead = step(0.3, r.x) * step(r.x, 0.9) * step(abs(r.y), headW);
      if (max(isBody, isHead) < 0.5) discard;
      float hue = fract(v_flowPack.w / 6.2832 + 0.5);
      float val = 0.5 + 0.5 * v_skyScintPack.w;
      vec3 c = clamp(abs(mod(hue*6.0+vec3(0,4,2),6.0)-3.0)-1.0, 0.0, 1.0);
      fragColor = vec4(val * mix(vec3(1.0), c, 0.85), 1.0);
    } else { float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard; fragColor = vec4(vec3(0.12),0.5); }
    return;
  }
  if (u_debugMode == 5) {
    float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard;
    fragColor = vec4(regionDebugColor(int(v_metaPack.x+0.5)), 1.0); return;
  }
  if (u_debugMode == 6) {
    float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard;
    if (v_flowPack.y > 0.001) {
      float s = clamp(v_flowPack.y * v_flowPack.z, 0.0, 1.0); vec3 c;
      if(s<0.25) c=mix(vec3(0.1,0.2,0.9),vec3(0,0.8,0.9),s/0.25);
      else if(s<0.50) c=mix(vec3(0,0.8,0.9),vec3(0.1,0.9,0.1),(s-0.25)/0.25);
      else if(s<0.75) c=mix(vec3(0.1,0.9,0.1),vec3(1,0.9,0),(s-0.50)/0.25);
      else c=mix(vec3(1,0.9,0),vec3(1,0.1,0),(s-0.75)/0.25);
      fragColor = vec4(c, 1.0);
    } else { fragColor = vec4(vec3(0.10), 0.4); } return;
  }
  if (u_debugMode == 7) {
    float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard;
    float a = v_skyScintPack.z;
    if(a>0.001) fragColor = vec4(a,a*0.2,0,1);
    else if(v_flowPack.y>0.001) fragColor = vec4(0,0.15,0,0.6);
    else fragColor = vec4(vec3(0.05),0.3); return;
  }
  if (u_debugMode == 8) {
    float t = v_skyScintPack.x;
    if(t>0.0001) { vec3 h;
      if(t<0.25) h=mix(vec3(0,0,1),vec3(0,1,1),t/0.25);
      else if(t<0.5) h=mix(vec3(0,1,1),vec3(0,1,0),(t-0.25)/0.25);
      else if(t<0.75) h=mix(vec3(0,1,0),vec3(1,1,0),(t-0.5)/0.25);
      else h=mix(vec3(1,1,0),vec3(1,0,0),(t-0.75)/0.25);
      fragColor=vec4(h,1);
    } else if(v_flowPack.y>0.001) fragColor=vec4(0,0.15,0,0.6);
    else fragColor=vec4(vec3(0.05),0.3); return;
  }
  if (u_debugMode == 9) {
    float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard;
    int cypRid = int(v_metaPack.x+0.5);
    if(cypRid==1) { float ep=v_cypressPack.y;
      if(ep>0.01) { fragColor=vec4(mix(vec3(0,0.8,0.8),vec3(0,0.2,1),ep),1); }
      else { float t=v_cypressPack.x; vec3 col=mix(vec3(0,0.15,0.15),vec3(1,0,1),min(t*2.0,1.0));
        if(t>0.5) col=mix(vec3(1,0,1),vec3(1,1,1),(t-0.5)*2.0); fragColor=vec4(col,1); }
    } else fragColor=vec4(vec3(0.08),1); return;
  }
  if (u_debugMode == 10) {
    float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard;
    int homeRid=int(v_metaPack.x+0.5), effRid=int(v_metaPack.y+0.5);
    fragColor = vec4(effRid!=homeRid ? vec3(1,0,0) : regionDebugColor(homeRid), 1); return;
  }
  if (u_debugMode == 11) {
    float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard;
    int rid=int(v_metaPack.x+0.5);
    if(rid==2) fragColor=vec4(mix(vec3(0.1,0.2,0.9),vec3(0.1,0.9,0.2),v_villagePack.x),1);
    else fragColor=vec4(vec3(0.08),0.3); return;
  }
  if (u_debugMode == 12) {
    float d = length(gl_PointCoord*2.0-1.0); if(d>1.0)discard;
    int homeRid=int(v_metaPack.x+0.5);
    int clickRid=int(texelFetch(u_clickRemapTex,ivec2(v_homePos*vec2(textureSize(u_clickRemapTex,0))),0).r*255.0+0.5);
    fragColor = vec4(homeRid==3&&clickRid==4 ? vec3(1,0,0) : regionDebugColor(homeRid), 1); return;
  }
`;

// Build debug fragment shader by injecting helpers + mode blocks into RENDER_FRAG.
// Both replacements are keyed to explicit marker comments so surrounding shader
// refactors can't silently break the injection (a previous cleanup did exactly
// that by removing the star-boundary block the mode-injection was keyed to).
const RENDER_DEBUG_FRAG = RENDER_FRAG
  .replace('// <DEBUG_HELPERS_INJECTION>', _DEBUG_FRAG_HELPERS)
  .replace('// <DEBUG_MODES_INJECTION>',   _DEBUG_FRAG_MODES);

// ────────────────────────────────────────────────��───────────────────────────
// Minimal render shader — fast-compiling (~30ms) subset used during loading.
// Same attribute layout as full shader so VAO works with both programs.
// Includes only: edge lock, region lock, intro dance, base color, intro mode.
// Compiled synchronously at init while the full shader compiles in background.
// ────────────────────────────────────────────────────────────────────────────

const RENDER_MINI_VERT = `#version 300 es
precision highp float;

// Explicit locations — must match full render shader for VAO compatibility
layout(location = 0) in vec2 a_homePos;
layout(location = 1) in vec2 a_spiralPos;
layout(location = 2) in vec3 a_color;
layout(location = 3) in float a_regionId;
layout(location = 4) in float a_boundaryDist;
layout(location = 5) in vec2  a_simPos;
// location 6 retired — was a_starBoundary, unimplemented debug viz
layout(location = 7) in float a_coherence;
layout(location = 8) in float a_flowAngle;

uniform float u_pointSize;
uniform float u_time;
uniform float u_introDanceScale;
uniform float u_baseAlpha;

// Same 9 varyings as full shader — fragment shader interface must match
out vec3 v_rawColor;
out vec4 v_vortexPack;
out vec4 v_metaPack;
out vec2 v_homePos;
out vec4 v_skyScintPack;
out vec4 v_flowPack;
out vec4 v_cypressPack;
out vec4 v_villagePack;
out vec4 v_miscPack;

void main() {
  // Edge lock
  float borderThickness = 0.01;
  float edgeDist = min(min(a_homePos.x, 1.0 - a_homePos.x),
                       min(a_homePos.y, 1.0 - a_homePos.y));
  float edgeLock = smoothstep(0.0, borderThickness, edgeDist);
  float regionLock = (a_boundaryDist > 0.0) ? 1.0 : 0.0;
  edgeLock *= regionLock;

  vec2 pos = a_homePos;
  float basePS = u_pointSize;
  gl_PointSize = basePS;

  // Intro dance
  if (u_introDanceScale > 0.0) {
    vec2 seed = a_homePos * 127.1 + a_spiralPos * 311.7;
    float h1 = fract(sin(dot(seed, vec2(12.9898, 78.233))) * 43758.5453);
    float h2 = fract(sin(dot(seed + 1.0, vec2(39.346, 11.135))) * 28573.329);
    float idxT = u_time;
    float idx = sin(idxT * 0.8 + h1 * 6.2832) * cos(idxT * 0.5 + h2 * 6.2832);
    float idy = cos(idxT * 0.6 + h2 * 6.2832) * sin(idxT * 0.9 + h1 * 6.2832);
    float introBase = 0.00025;
    float introAmp = u_introDanceScale;
    if (u_introDanceScale < introBase * 0.99) {
      float fadeRatio = u_introDanceScale / introBase;
      introAmp = introBase * pow(fadeRatio, 1.0 + h1 * 2.0);
    }
    pos.x += idx * introAmp;
    pos.y += idy * introAmp;
  }

  // Position to NDC
  vec2 ndc = pos * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);

  // Varyings — defaults for inactive systems
  v_rawColor = a_color;
  v_vortexPack = vec4(0.0, edgeLock, 0.0, 1.2);
  v_metaPack = vec4(a_regionId, a_regionId, basePS, 0.0);
  v_homePos = a_homePos;
  v_skyScintPack = vec4(0.0);
  v_flowPack = vec4(1.0, 0.0, 0.0, 0.0);  // x=flowAlpha=1 (visible)
  v_cypressPack = vec4(0.0);
  v_villagePack = vec4(0.0, 0.0, 1.0, 1.0);  // z,w=1 (no lifecycle fade)
  v_miscPack = vec4(0.0);
}
`;

const RENDER_MINI_FRAG = `#version 300 es
precision highp float;
precision highp int;

// Same varyings as full shader
in vec3 v_rawColor;
in vec4 v_vortexPack;
in vec4 v_metaPack;
in vec2 v_homePos;
in vec4 v_skyScintPack;
in vec4 v_flowPack;
in vec4 v_cypressPack;
in vec4 v_villagePack;
in vec4 v_miscPack;

uniform float u_regionMix[6];
uniform float u_baseAlpha;
uniform float u_introMode;
uniform float u_introGlow;
uniform float u_introGlowRadius;
uniform vec2  u_resolution;
uniform float u_revealBrightness;
uniform float u_vignetteStrength;
uniform float u_borderWidth;
uniform float u_borderRadius;
uniform vec3  u_borderColor;
uniform float u_margin;
uniform float u_luminancePreserve;

out vec4 fragColor;

void main() {
  float proximity = v_vortexPack.x;
  float edgeLock = v_vortexPack.y;
  int region = int(v_metaPack.x + 0.5);
  float edge = 1.0;

  // Border mask
  if (u_borderWidth > 0.0) {
    vec2 fc = gl_FragCoord.xy;
    vec2 inner = vec2(u_margin + u_borderWidth, u_margin + u_borderWidth);
    vec2 outer = u_resolution - inner;
    float r = u_borderRadius;
    vec2 q = max(inner + r - fc, vec2(0.0)) + max(fc - (outer - r), vec2(0.0));
    float d = length(max(q - r, vec2(0.0)));
    edge = 1.0 - smoothstep(0.0, 1.5, d);
  }

  // Base color: static painting color (no region blending in minimal shader)
  vec3 color = v_rawColor;
  float lumPreserve = u_luminancePreserve;
  float lum = dot(color, vec3(0.299, 0.587, 0.114));

  // Region mix → grayscale for inactive regions
  float regionMixVal = (region >= 0 && region < 6) ? u_regionMix[region] : 0.0;
  vec3 gray = vec3(lum);
  color = mix(gray, color, regionMixVal);
  if (lumPreserve > 0.0) {
    float newLum = dot(color, vec3(0.299, 0.587, 0.114));
    color *= (newLum > 0.001) ? mix(1.0, lum / newLum, lumPreserve) : 1.0;
  }

  // Vignette
  if (u_vignetteStrength > 0.0) {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float vig = uv.x * (1.0 - uv.x) * uv.y * (1.0 - uv.y);
    color *= mix(1.0, smoothstep(0.0, 0.15, vig), u_vignetteStrength);
  }

  float finalAlpha = edge * v_flowPack.x * v_villagePack.w * v_villagePack.z * u_baseAlpha;

  // Intro mode: vignette + glow
  if (u_introMode > 0.001) {
    float centerDist = length(gl_FragCoord.xy - u_resolution * 0.5);
    float centerGlow = smoothstep(u_introGlowRadius, u_introGlowRadius * 0.3, centerDist) * u_introGlow;
    float dimming = u_revealBrightness;
    float introVis = centerGlow * dimming;
    finalAlpha *= mix(1.0, introVis, u_introMode);
  }

  fragColor = vec4(color, finalAlpha);
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Tonal background shader — fullscreen quad drawing a heavily downsampled
// source image at very low brightness behind the particle field.
// Uses gl_VertexID trick: no vertex buffer needed.
// ────────────────────────────────────────────────────────────────────────────

const TONAL_VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // Two-triangle fullscreen quad from gl_VertexID (0..5)
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, -y) * 0.5 + 0.5; // flip Y: canvas image data is top-down, GL is bottom-up
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const TONAL_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tonalMap;
uniform float u_strength;
uniform float u_vignetteStrength;
uniform float u_borderWidth;
uniform float u_borderRadius;
uniform vec3  u_borderColor;
uniform vec2  u_resolution;
uniform float u_margin;
uniform vec3  u_canvasColor;
out vec4 fragColor;
void main() {
  vec3 col = max(texture(u_tonalMap, v_uv).rgb * u_strength, u_canvasColor);
  // Match particle vignette so background doesn't halo at edges
  vec2 vignetteD = abs(v_uv - 0.5) * 2.0;
  float vignette = 1.0 - dot(vignetteD * vignetteD, vignetteD * vignetteD);
  vignette = smoothstep(0.0, 1.0, vignette);
  vignette = mix(1.0 - u_vignetteStrength, 1.0, vignette);
  // Rounded rectangle SDF
  vec2 halfSize = u_resolution * 0.5 - u_margin;
  vec2 p = gl_FragCoord.xy - u_resolution * 0.5;
  vec2 d = abs(p) - (halfSize - u_borderRadius);
  float sdf = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - u_borderRadius;
  if (sdf > 0.0) discard;
  float edgeDist = -sdf;
  // Fade tonal bg to zero near edges so it never peeks through sparse particles
  // Uses a wide fade zone (10% of the shorter dimension) for a natural falloff
  float edgeFade = smoothstep(0.0, min(u_resolution.x, u_resolution.y) * 0.1, edgeDist);
  col *= edgeFade * vignette;
  if (u_borderWidth > 0.0) {
    float borderLine = 1.0 - smoothstep(0.0, u_borderWidth, edgeDist);
    float innerGlow = 1.0 - smoothstep(0.0, u_borderWidth * 3.0, edgeDist);
    innerGlow *= 0.15;
    col = mix(col, u_borderColor, borderLine + innerGlow * (1.0 - borderLine));
  }
  fragColor = vec4(col, 1.0);
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Shadow shader — Apple-style multi-layered depth shadow around painting
// ────────────────────────────────────────────────────────────────────────────
const SHADOW_VERT = `#version 300 es
out vec2 v_uv;
void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, -y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const SHADOW_FRAG = `#version 300 es
precision mediump float;

in vec2 v_uv;

uniform vec2  u_resolution;
uniform float u_borderRadius;
uniform float u_margin;
uniform vec3  u_canvasColor;
uniform vec3  u_shadowColor;
uniform float u_shadowOpacity;
// u_shadowSpread removed — never read in shader (paintingMargin used instead)
uniform vec2  u_shadowOffset;

out vec4 fragColor;

void main() {
  vec2 center = u_resolution * 0.5;
  vec2 halfSize = center - u_margin;

  // Un-shifted SDF — matches the actual painting rect
  vec2 p0 = gl_FragCoord.xy - center;
  vec2 d0 = abs(p0) - (halfSize - u_borderRadius);
  float paintingSdf = length(max(d0, 0.0)) + min(max(d0.x, d0.y), 0.0) - u_borderRadius;

  // Inside the painting: output canvas color (seamless with clear)
  if (paintingSdf <= 0.0) {
    fragColor = vec4(u_canvasColor, 1.0);
    return;
  }

  // Shifted SDF — offset creates bottom-heavy shadow
  vec2 p1 = (gl_FragCoord.xy - u_shadowOffset) - center;
  vec2 d1 = abs(p1) - (halfSize - u_borderRadius);
  float shadowSdf = length(max(d1, 0.0)) + min(max(d1.x, d1.y), 0.0) - u_borderRadius;
  float sdf = max(shadowSdf, 0.0);

  // Outside: soft shadow — fade over the full margin
  float shadow = 1.0 - smoothstep(0.0, u_margin, sdf);

  // Directional bias: stronger below painting, weaker above (gravity light)
  // In GL coords y=0 is bottom, so below painting = lower y = positive bias
  float vertNorm = (center.y - gl_FragCoord.y) / (u_resolution.y * 0.5);
  float dirBias = 0.3 + 0.7 * clamp(vertNorm * 0.5 + 0.5, 0.0, 1.0);
  shadow *= dirBias;

  shadow *= u_shadowOpacity;

  // Fade toward canvasColor (matches page bg) so canvas edge is seamless
  vec3 color = mix(u_canvasColor, u_shadowColor, shadow);
  fragColor = vec4(color, 1.0);
}
`;

// ────────────────────────────────────────────────────────────────────────────
// ── Bloom shaders REMOVED (GPU optimization, April 2026) ──
// Star corona bloom + flow bloom + Kawase blur + bloom composite all removed.
// Measured +1-2 FPS on MacBook Intel Iris Plus 645, user confirmed no visible
// difference with _gpuDiag_noBloom=true. Saves 3 shader compilations at startup
// and 3 half-res FBOs in VRAM. See docs/gpu-round4-research-2026-04-14.md.


// ────────────────────────────────────────────────────────────────────────────
// Trail composite shader — fullscreen quad that blends previous frame
// (faded toward white) with the current particle render.
// When trail = 0, this pass is skipped entirely.
// ────────────────────────────────────────────────────────────────────────────

const COMPOSITE_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;  // [-1,1] -> [0,1]
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Composite: blends current particle render with faded trail buffer.
// Background is black, particles are bright dots. Trail = afterimages.
// Region-aware: flow regions (3,4) use u_flowPersistence, rest use u_persistence.
const COMPOSITE_FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_currentTex;    // fresh particle render this frame
uniform sampler2D u_prevTex;       // accumulated trail buffer from last frame
uniform sampler2D u_regionMapTex;  // R8: region ID per pixel (0-5)
uniform sampler2D u_flowCurvatureTex; // RG16F: R=curvature, G=eddy energy
uniform float u_persistence;       // vortex/default persistence
uniform float u_flowPersistence;   // flow region persistence (higher for visible trails)
uniform float u_trailSubtract;     // per-frame floor drain (0 = off, star trails uses ~0.008)
uniform float u_eddyMinScale;      // eddy scale floor (matches render shader)
uniform float u_eddyMaxScale;      // eddy scale ceiling (matches render shader)
uniform float u_flowSpeedFloor;    // minimum speed at max curvature (matches render shader)
uniform sampler2D u_flowFieldTex;   // R=coherence, G=cos, B=sin
uniform float u_skyGustPersistence; // sky gust trail persistence (0-0.995)
uniform float u_skyGustFade;        // regionActive[2] (Night Sky) — fades isSkyGust so persistence transitions gradually
uniform float u_cypressTrailPersistence; // cypress trail persistence (0-0.95)
uniform float u_cypressTrailFade;        // cypressSwayMix — fades trail during deactivation
uniform float u_vortexTrailPersistence; // vortex-only trail persistence (star region 5)
uniform vec2  u_cStarCursorUV;         // cursor position in painting UV
uniform float u_cStarCursorInfluence;  // 0 = no cursor, 1 = full
uniform float u_cStarPushRadius;       // cursor trail zone radius (aspect-corrected UV)
uniform float u_cStarTrailPersist;    // cursor trail FBO persistence (0-0.98)
// Night Sky cursor wake — drain persistence in push zone
uniform vec2  u_cNsWakeCursorUV;       // cursor position in painting UV
uniform float u_cNsWakeCursorInfluence;// push influence (speed-damped, 0-1)
uniform float u_cNsWakeRadius;         // wake radius in UV
uniform float u_villageTrailPersistence; // village trail persistence (region 2)
uniform float u_villageTrailFade;        // village region activation — fades trail during deactivation
uniform vec2  u_villageTrailCenter;      // cursor position in painting UV
uniform float u_villageTrailRadius;      // cursor influence radius
uniform float u_villageTrailAttraction;  // attraction strength (0-1)
uniform float u_villageWindBlend;       // 0 = funnel (cursor close), 1 = wind (cursor far)
uniform float u_villageCursorMoving;   // 0 = idle, 1 = fast drag (smoothed)
uniform float u_villageTopY;           // UV Y of village top (small = near canvas top)
uniform float u_villageBottomY;        // UV Y of village bottom (large = near canvas bottom)
uniform float u_villageBaseTrailRatio; // trail persistence at bottom (0-1, like cypressBaseRatio)
uniform float u_swirlTrailPersistence; // swirl/flow trail persistence (regions 3,4)
uniform float u_swirlTrailFade;        // flowMixEased — fades trail during deactivation
uniform vec4  u_cVortexData[12];       // xy=center, z=sign, w=strength
uniform vec4  u_cVortexParams[12];     // x=radius
uniform int   u_cVortexCount;
uniform float u_cAspectRatio;
uniform float u_cTrailMultiplier;  // vortex trail intensity multiplier (0 = off, 1 = full)

out vec4 fragColor;
void main() {
  vec3 current = texture(u_currentTex, v_uv).rgb;
  vec3 prev    = texture(u_prevTex, v_uv).rgb;

  // Painting UV (Y-flipped for texture coordinate alignment)
  vec2 paintingUV = vec2(v_uv.x, 1.0 - v_uv.y);

  // Region gate: only flow regions (3=night sky, 4=swirl sky) are trail-eligible.
  float regionId = texelFetch(u_regionMapTex, ivec2(paintingUV * vec2(textureSize(u_regionMapTex, 0))), 0).r * 255.0;
  int rid = int(regionId + 0.5);

  // ── G11: Vortex orbit ring override, gated on count ──
  // When no vortices are active (u_cVortexCount == 0), skip the 12-iteration
  // loop entirely. cVortexProx stays 0 — all downstream code handles this:
  // no rid override, no trail gradient, no cursor trail boost, effectiveSubtract
  // reduces to u_trailSubtract.
  float cVortexProx = 0.0;
  if (u_cVortexCount > 0) {
    for (int i = 0; i < 12; i++) {
      if (i >= u_cVortexCount) break;
      float radius_i = u_cVortexParams[i].x;
      if (radius_i < 0.001) continue;
      vec2 off = paintingUV - u_cVortexData[i].xy;
      off.x *= u_cAspectRatio;
      float distSq = dot(off, off);
      float outerLimit = radius_i * 1.25;
      if (distSq > outerLimit * outerLimit) continue;
      float dist = sqrt(distSq);
      float prox_i = smoothstep(outerLimit, radius_i * 0.3, dist);
      cVortexProx = max(cVortexProx, prox_i);
    }
    if ((rid == 3 || rid == 4) && cVortexProx > 0.05) {
      rid = 5;
    }
  }

  // Speed-gated trail persistence: only flow regions (3, 4) use the curvature
  // texture. For other regions flowInfluence=0 collapses mix() to u_persistence,
  // so skip the fetch + ALU entirely. Mirrors the u_flowFieldTex gating below
  // and the render vertex shader's flowStrength gate (line ~1092).
  float persistence = u_persistence;
  if (rid == 3 || rid == 4) {
    vec2 curvData = texture(u_flowCurvatureTex, paintingUV).rg;
    float curvatureSpeed = mix(u_flowSpeedFloor, 1.0, 1.0 - curvData.r);
    float eddyScale = mix(u_eddyMinScale, u_eddyMaxScale, curvData.g);
    float approxSpeed = curvatureSpeed * eddyScale;
    // Streak-line persistence: trail length proportional to velocity (PIV
    // principle). Power curve (gamma=2) emphasizes fast particles while keeping
    // the gradient smooth — slow regions fade imperceptibly, fast regions build
    // visible afterimages.
    float _sf = clamp(approxSpeed, 0.0, 1.0);
    float speedFactor = _sf * _sf;  // pow(x, 2) = x*x
    persistence = mix(u_persistence, u_flowPersistence, speedFactor);
  }

  // Star trail: region 5 pixels (star body + orbit ring override) get
  // dedicated vortex trail persistence, independent of all other regions.
  // Radial gradient: orbit ring (edge) gets full trail, center gets half.
  // cVortexProx = 1.0 at center, 0.0 at edge — invert for trail strength.
  if (rid == 5) {
    // pow(x, 0.6) ≈ x * mix(1.0, x, -0.4) for x in [0,1]
    float _tg = 1.0 - cVortexProx;
    float trailGradient = mix(0.5, 1.0, _tg * mix(1.0, _tg, -0.4));
    persistence = u_vortexTrailPersistence * u_cTrailMultiplier * trailGradient;
  }

  // Swirl trail: flow regions (3,4) get user-controlled trail persistence.
  if (rid == 3 || rid == 4) {
    float isSwirlTrail = smoothstep(0.0, 0.35, u_swirlTrailFade);
    persistence = mix(persistence, u_swirlTrailPersistence, isSwirlTrail);
  }

  // Sky gust persistence: low coherence in flow regions = sky gust territory.
  // u_skyGustFade (regionActive[2], Night Sky) scales isSkyGust so persistence
  // transitions gradually from sky gust (0.92) toward base during deactivation —
  // prevents FBO bright-pixel pop near star edges when trail system shuts off.
  if (rid == 3 || rid == 4) {
    vec2 flowCheck = texture(u_flowFieldTex, paintingUV).rg;
    float skyCoherence = flowCheck.r;
    float isSkyGust = smoothstep(0.25, 0.0, skyCoherence)
                    * smoothstep(0.0, 0.35, u_skyGustFade);
    persistence = mix(persistence, u_skyGustPersistence, isSkyGust);
  }

  // Night Sky cursor wake: reduce persistence in push zone so displaced
  // particles don't ghost. Faster drain near cursor center, normal at edge.
  if ((rid == 3 || rid == 4) && u_cNsWakeCursorInfluence > 0.001) {
    vec2 nsWakeOff = paintingUV - u_cNsWakeCursorUV;
    nsWakeOff.x *= u_cAspectRatio;
    float nsWakeDist = length(nsWakeOff);
    float nsWakeDrain = smoothstep(u_cNsWakeRadius, 0.0, nsWakeDist) * u_cNsWakeCursorInfluence;
    // Reduce persistence by up to 40% at cursor center
    persistence *= mix(1.0, 0.6, nsWakeDrain);
  }

  // Cypress trail persistence: region 1, gated by cypressSwayMix.
  // Same architecture as sky gust trails — particles leave afterimages
  // as they sway, giving visual weight to the sparse cypress region.
  if (rid == 1) {
    float isCypress = smoothstep(0.0, 0.35, u_cypressTrailFade);
    persistence = mix(persistence, u_cypressTrailPersistence, isCypress);
  }

  // Village trail persistence: region 2, gated by region activation.
  // Inside village (funnel mode): full trail everywhere.
  // Outside village (wind mode): height gradient — top = full, bottom = reduced.
  if (rid == 2) {
    float isVillage = smoothstep(0.0, 0.35, u_villageTrailFade);

    // Height gradient only applies during wind mode (cursor far from village)
    // Power curve (1.5): bottom half drops faster, upper portion stays near full
    float vlNormHeight = 1.0 - smoothstep(u_villageTopY, u_villageBottomY, paintingUV.y);
    float vlHeightCurve = vlNormHeight * mix(1.0, vlNormHeight, 0.5);  // ≈ pow(x, 1.5)
    float vlHeightScale = mix(u_villageBaseTrailRatio, 1.0, vlHeightCurve);
    float vlWindScale = mix(1.0, vlHeightScale, u_villageWindBlend);

    // Moving cursor reduces trail — funnel mode only (in wind mode you're always moving)
    float vlMoveScale = mix(1.0, 0.5, u_villageCursorMoving * (1.0 - u_villageWindBlend));

    persistence = mix(persistence, u_villageTrailPersistence * vlWindScale * vlMoveScale, isVillage);
  }

  // Star cursor trail: persistence boost at push zone so displaced
  // particles leave visible trails as they shift.
  if (u_cStarCursorInfluence > 0.001 && cVortexProx > 0.01) {
    vec2 cursorOff = paintingUV - u_cStarCursorUV;
    cursorOff.x *= u_cAspectRatio;
    float cursorDist = length(cursorOff);
    float pr = u_cStarPushRadius;
    float starTrailBoost = smoothstep(pr, 0.0, cursorDist) * u_cStarCursorInfluence * cVortexProx;
    persistence = mix(persistence, u_cStarTrailPersist, starTrailBoost);
  }

  // Fade previous frame toward black (the background color).
  // Multiplicative decay keeps bright streak heads alive.
  // Subtractive drain ensures dim gray values reach true zero quickly,
  // preventing gray wash buildup in the gaps of the dithered painting.
  // Suppress drain in vortex core so afterimages survive.
  float effectiveSubtract = mix(u_trailSubtract, 0.0, cVortexProx);
  vec3 fadedPrev = max(prev * persistence - effectiveSubtract, vec3(0.0));

  // Master alpha gate: region 4 trail brightness dies with regionActive.
  // Trail buffer holds ghost images of particles at their OLD displaced
  // positions.  When ghosts fade, particles visually "snap" from ghost
  // position to current position — a displacement pop.
  // Fix: drain ghosts BEFORE displacement starts changing.
  // Displacement gate: smoothstep(0, 0.15) — kicks in at regionActive 0.15.
  // Trail drain gate: smoothstep(0, 0.45) — starts draining at regionActive 0.45.
  // This gives ~12 frames of drain before displacement begins fading,
  // so ghost images are nearly gone when particles start moving.
  if (rid == 3 || rid == 4) {
    // Both sky gust (Night Sky) and swirl flow (Horizon) trails drain here.
    float drainGate = smoothstep(0.0, 0.45, max(u_skyGustFade, u_swirlTrailFade));
    fadedPrev *= drainGate;
  }

  // Cypress trail drain: same ghost prevention as sky gust.
  // Drain ghosts before displacement fades to prevent snap-back.
  if (rid == 1) {
    fadedPrev *= smoothstep(0.0, 0.45, u_cypressTrailFade);
  }

  // Village trail drain: same pattern.
  if (rid == 2) {
    fadedPrev *= smoothstep(0.0, 0.45, u_villageTrailFade);
  }

  // Take the brighter of current frame and faded afterimage.
  vec3 result = max(current, fadedPrev);

  fragColor = vec4(result, 1.0);
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Sim shader — transform feedback position integration
//
// Integrates Biot-Savart velocity + spring-back into particle positions.
// Spring-back force (exponential decay toward home) ensures particles
// return to their painting positions when displacement sources fade.
// ────────────────────────────────────────────────────────────────────────────

const SIM_VERT = `#version 300 es
precision highp float;

in vec2 a_currentPos;   // current advected position (from ping-pong buffer)
in vec2 a_homePos;       // static home position (painting)
in vec2 a_spiralPos;     // used as per-particle phase seed
in float a_regionId;     // region ID for locked-region enforcement

uniform float u_dt;              // frame delta in seconds
uniform float u_time;            // simulation time (seconds)
uniform float u_driftSpeed;      // noise frequency multiplier

uniform vec2  u_canvasSize;         // canvas dimensions
uniform float u_flashRadius;        // for cursor-centered boost
uniform float u_springK;            // spring constant for return-to-home
uniform float u_driftMaxCap;        // absolute max displacement (home-space units)

// ── Flow field advection ──
uniform sampler2D u_flowFieldTex;  // R=strength, G=cos(θ)*0.5+0.5, B=sin(θ)*0.5+0.5
uniform float u_flowSpeed;         // advection speed (home-space units/sec)
uniform float u_flowDriftFrac;    // fraction of cycle spent drifting (0.3-1.0)
uniform float u_flowCyclePeriod;  // total cycle length in seconds (1.0-15.0)
uniform float u_flowThreshold;    // minimum flow strength to participate (0.01-0.50)
uniform float u_flowMaxDrift;    // max UV displacement from home (0.001-0.02)

// ── Territory boundary enforcement ──
uniform sampler2D u_regionMapTex;  // R8: region ID per pixel (0-5), NEAREST filtered
uniform sampler2D u_boundaryTex;   // R16F: boundary distance field (0 = locked region)
out vec2 v_newPos;   // captured by transform feedback

void main() {
  vec2 pos = a_currentPos;

  // ── Flow field: determine lifecycle state BEFORE spring ──
  // We need to know if this particle is drifting so we can suppress the spring.
  float flowDriftGate = 0.0;  // 0 = not drifting (spring active), >0 = drifting (spring suppressed)
  float flowStrHome = 0.0;

  // Flow advection is visual-only (render shader) — sim keeps particles at home.
  // flowDriftGate stays 0.0 so spring works normally.

  // ── Spring-back ──
  float springAlpha = 1.0 - exp(-u_springK * u_dt);
  pos = mix(pos, a_homePos, springAlpha);

  // ── Locked-region enforcement (cypress/village) ──
  // After ALL displacement sources, check if position landed in a locked region.
  // Binary search along home→pos ray to find the boundary edge (same as render shader).
  {
    float destBD = texelFetch(u_boundaryTex, ivec2(pos * vec2(textureSize(u_boundaryTex, 0))), 0).r;
    if (destBD < 0.001 && length(pos - a_homePos) > 0.0001) {
      vec2 safePos = a_homePos;
      vec2 testPos = pos;
      for (int s = 0; s < 8; s++) {
        vec2 mid = (safePos + testPos) * 0.5;
        float midBD = texelFetch(u_boundaryTex, ivec2(mid * vec2(textureSize(u_boundaryTex, 0))), 0).r;
        if (midBD > 0.001) {
          safePos = mid;   // midpoint is safe, push further
        } else {
          testPos = mid;   // midpoint is locked, pull back
        }
      }
      pos = safePos;
    }
  }

  // Clamp displacement from home to prevent runaway
  float maxDisp = u_driftMaxCap * 2.0;
  vec2 offset = pos - a_homePos;
  float offsetLen = length(offset);
  if (offsetLen > maxDisp) {
    pos = a_homePos + offset * (maxDisp / offsetLen);
  }

  v_newPos = pos;
}
`;

const SIM_FRAG = `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }
`;

// ────────────────────────────────────────────────────────────────────────────
// Shader sources export (for GPU diagnostic — does not affect normal init)
// ────────────────────────────────────────────────────────────────────────────
export const SHADER_SOURCES = {
  RENDER_VERT, RENDER_FRAG,
  COMPOSITE_VERT, COMPOSITE_FRAG,
  TONAL_VERT, TONAL_FRAG,
  SHADOW_VERT, SHADOW_FRAG,
  SIM_VERT, SIM_FRAG,
};

// ────────────────────────────────────────────────────────────────────────────
// Helper functions
// ────────────────────────────────────────────────────────────────────────────

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    console.error('Source:', source);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

const _shaderTimings = [];

function createProgram(gl, vertSrc, fragSrc, _label, _defer) {
  const t0 = performance.now();
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const tVert = performance.now();
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const tFrag = performance.now();
  if (!vert || !frag) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);

  gl.linkProgram(program);

  if (!_defer) {
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
  }
  const tLink = performance.now();

  gl.deleteShader(vert);
  gl.deleteShader(frag);

  if (_label) {
    const vertLines = vertSrc.split('\n').length;
    const fragLines = fragSrc.split('\n').length;
    _shaderTimings.push({
      label: _label,
      vert: tVert - t0,
      frag: tFrag - tVert,
      link: _defer ? 0 : (tLink - tFrag),
      total: tLink - t0,
      vertLines,
      fragLines,
      deferred: !!_defer,
    });
  }
  return program;
}

// ────────────────────────────────────────────────────────────────────────────
// Phyllotaxis spiral computation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute phyllotaxis spiral target positions for N particles.
 *
 * Uses the Bostock formula: r = spacing * sqrt(rank)
 * This guarantees equal-area Voronoi cells and visible spiral arms,
 * regardless of the original point distribution.
 *
 * Particles are sorted by distance from center so inner painting
 * particles map to inner spiral positions (smooth center-outward
 * transition as gravity slider increases).
 *
 * Aspect ratio correction ensures the spiral appears circular on
 * non-square canvases.
 *
 * Returns { positions: Float32Array(count*2), distances: Float32Array(count) }
 * where distances[i] is in [0,1] — normalized rank-based spiral distance
 * (0 = center, 1 = outermost). The gravity slider compares against this.
 */
function computeSpiralPositions(homePos, count, centerX, centerY, aspectRatio) {
  const ar = aspectRatio || 1;

  // ── Approximate ranking via quantized bins (O(n), replaces O(n log n) sort) ──
  // Particles need distance-from-center ranking for spiral assignment.
  // Exact ordering isn't needed — a_spiralPos is used as a hash seed, not
  // for intro animation ordering. Bin-based ranking with ~4096 bins gives
  // max rank error of ~120 particles (t error ~0.00024) — sub-pixel.
  const NUM_BINS = 4096;

  // Compute squared distances (skip Math.sqrt — only need monotonic ordering)
  let maxDistSq = 0;
  const distsSq = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const dx = (homePos[i * 2] - centerX) * ar;
    const dy = homePos[i * 2 + 1] - centerY;
    const d2 = dx * dx + dy * dy;
    distsSq[i] = d2;
    if (d2 > maxDistSq) maxDistSq = d2;
  }

  // Bin particles by distance
  const binScale = maxDistSq > 0 ? (NUM_BINS - 1) / maxDistSq : 0;
  const binCounts = new Uint32Array(NUM_BINS);
  for (let i = 0; i < count; i++) {
    binCounts[(distsSq[i] * binScale) | 0]++;
  }

  // Prefix sum → rank offsets per bin
  const binStarts = new Uint32Array(NUM_BINS);
  let sum = 0;
  for (let b = 0; b < NUM_BINS; b++) {
    binStarts[b] = sum;
    sum += binCounts[b];
  }

  // Assign approximate rank per particle
  const binPos = new Uint32Array(binStarts);
  const ranks = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const b = (distsSq[i] * binScale) | 0;
    ranks[i] = binPos[b]++;
  }

  // ── Logarithmic spiral arms ──────────────────────────────────────
  const NUM_ARMS = 4;
  const MAX_WINDS = 2.5;
  const ARM_SPREAD = 0.12;
  const R = Math.sqrt(0.25 * ar * ar + 0.25);
  const TWO_PI = Math.PI * 2;
  const invCount = 1.0 / count;

  const spiralPos = new Float32Array(count * 2);

  // Pre-computed LUT for pow(t, 0.6) — eliminates 495K Math.pow calls
  const POW06_SIZE = 1024;
  const pow06LUT = new Float32Array(POW06_SIZE + 1);
  for (let j = 0; j <= POW06_SIZE; j++) {
    pow06LUT[j] = Math.pow(j / POW06_SIZE, 0.6);
  }

  // Fast integer hash (replaces Math.sin-based hash — 3× faster)
  function hash(n) {
    n = ((n >> 16) ^ n) * 0x45d9f3b | 0;
    n = ((n >> 16) ^ n) * 0x45d9f3b | 0;
    n = (n >> 16) ^ n;
    return (n >>> 0) / 4294967296;
  }

  // Interpolated sin/cos: compute exact every 16th particle, lerp between
  const TRIG_STEP = 16;

  for (let i = 0; i < count; i++) {
    const rank = ranks[i];
    const t = (rank + 0.5) * invCount;
    const r = R * Math.sqrt(t);

    const arm = rank % NUM_ARMS;
    const armOffset = (arm / NUM_ARMS) * TWO_PI;

    // LUT for pow(t, 0.6)
    const lutIdx = t * POW06_SIZE;
    const lo = lutIdx | 0;
    const frac = lutIdx - lo;
    const pow06 = pow06LUT[lo] + (pow06LUT[lo + 1] - pow06LUT[lo]) * frac;
    const angle = MAX_WINDS * TWO_PI * pow06 + armOffset;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const h1 = hash(rank * 3 + 1);
    const h2 = hash(rank * 3 + 2);
    const spreadAmount = ARM_SPREAD * r * (h1 * 2 - 1);
    const px = r * cosA - spreadAmount * sinA;
    const py = r * sinA + spreadAmount * cosA;

    const radialJitter = r * 0.03 * (h2 * 2 - 1);
    const finalX = px + radialJitter * cosA;
    const finalY = py + radialJitter * sinA;

    spiralPos[i * 2]     = finalX / ar + centerX;
    spiralPos[i * 2 + 1] = finalY + centerY;
  }

  return { positions: spiralPos };
}

// ────────────────────────────────────────────────────────────────────────────
// GPU separable Gaussian blur — used at init time to replace the expensive
// CPU blur in curvature precomputation (~9s → ~30ms).
// ────────────────────────────────────────────────────────────────────────────

const GPU_BLUR_VERT = `#version 300 es
out vec2 v_uv;
void main() {
  float x = float((gl_VertexID & 1) << 2) - 1.0;
  float y = float((gl_VertexID & 2) << 1) - 1.0;
  v_uv = vec2(x, y) * 0.5 + 0.5;
  gl_Position = vec4(x, y, 0.0, 1.0);
}
`;

const GPU_BLUR_FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_dir;       // (1,0) for horizontal, (0,1) for vertical
uniform float u_sigma;
uniform int u_radius;
out vec4 o_color;

void main() {
  ivec2 sz = textureSize(u_src, 0);
  vec2 texel = u_dir / vec2(sz);
  float inv2s2 = 0.5 / (u_sigma * u_sigma);
  float sum = 0.0, wt = 0.0;
  for (int k = -u_radius; k <= u_radius; k++) {
    float w = exp(-float(k * k) * inv2s2);
    vec2 sUV = clamp(v_uv + texel * float(k), vec2(0.0), vec2(1.0));
    sum += texture(u_src, sUV).r * w;
    wt += w;
  }
  o_color = vec4(sum / wt, 0.0, 0.0, 1.0);
}
`;

// ────────────────────────────────────────────────────────────────────────────
// Main renderer
// ────────────────────────────────────────────────────────────────────────────

// ── Experiment: warm ANGLE D3D shader cache from a worker OffscreenCanvas ──
// Compiles all shader programs on a background WebGL2 context. If ANGLE shares
// the D3D bytecode cache across contexts, the main thread's compilation becomes
// near-instant. If not, this is a no-op (worker blocks, main thread unaffected).
export function warmShaderCacheInWorker() {
  // Collect all shader sources to send to the worker
  const sources = [
    { label: 'render', vert: RENDER_VERT, frag: RENDER_FRAG },
    { label: 'renderMini', vert: RENDER_MINI_VERT, frag: RENDER_MINI_FRAG },
    { label: 'composite', vert: COMPOSITE_VERT, frag: COMPOSITE_FRAG },
    { label: 'tonal', vert: TONAL_VERT, frag: TONAL_FRAG },
    { label: 'shadow', vert: SHADOW_VERT, frag: SHADOW_FRAG },
  ];

  const workerCode = `
    self.onmessage = function(e) {
      const t0 = performance.now();
      try {
        const canvas = new OffscreenCanvas(1, 1);
        const gl = canvas.getContext('webgl2');
        if (!gl) { self.postMessage({ error: 'no webgl2' }); return; }

        const results = [];
        for (const src of e.data) {
          const st = performance.now();
          const vs = gl.createShader(gl.VERTEX_SHADER);
          gl.shaderSource(vs, src.vert);
          gl.compileShader(vs);
          const fs = gl.createShader(gl.FRAGMENT_SHADER);
          gl.shaderSource(fs, src.frag);
          gl.compileShader(fs);
          const prog = gl.createProgram();
          gl.attachShader(prog, vs);
          gl.attachShader(prog, fs);
          gl.linkProgram(prog);
          // Force D3DCompile by checking link status
          const ok = gl.getProgramParameter(prog, gl.LINK_STATUS);
          results.push({ label: src.label, ms: performance.now() - st, ok });
          gl.deleteProgram(prog);
          gl.deleteShader(vs);
          gl.deleteShader(fs);
        }
        // Destroy context
        gl.getExtension('WEBGL_lose_context').loseContext();
        self.postMessage({ results, totalMs: performance.now() - t0 });
      } catch (err) {
        self.postMessage({ error: err.message });
      }
    };
  `;

  return new Promise(resolve => {
    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      worker.onmessage = (e) => {
        URL.revokeObjectURL(url);
        worker.terminate();
        if (e.data.error) {
          _log(`%c[ShaderCacheWarm]%c  Worker failed: ${e.data.error}`, 'color: #f80; font-weight: bold', 'color: #999');
        } else {
          const lines = e.data.results.map(r => `  ${r.label}: ${r.ms.toFixed(0)}ms ${r.ok ? '✓' : '✗'}`).join('\n');
          _log(`%c[ShaderCacheWarm]%c  Worker compiled ${e.data.results.length} programs in ${e.data.totalMs.toFixed(0)}ms\n${lines}`, 'color: #0f0; font-weight: bold', 'color: #ccc');
        }
        resolve();
      };
      worker.onerror = () => {
        URL.revokeObjectURL(url);
        worker.terminate();
        _log(`%c[ShaderCacheWarm]%c  Worker error — falling back`, 'color: #f80; font-weight: bold', 'color: #999');
        resolve();
      };
      worker.postMessage(sources);
    } catch (err) {
      _log(`%c[ShaderCacheWarm]%c  Not available: ${err.message}`, 'color: #f80; font-weight: bold', 'color: #999');
      resolve();
    }
  });
}

// ── Pre-compute 512×512 simplex noise texture on CPU (RGB16F) ──
// Same Ashima Arts algorithm as the removed GLSL function. Baked once at
// module load. R=raw noise, G=∂n/∂x, B=∂n/∂y (pre-baked central-difference
// gradient at eps=0.01 in snoise input-space). The gradient channels let
// curlNoise() resolve to a single texture fetch instead of 4.
function generateNoiseTexture(size) {
  // Ashima Arts simplex noise (JS port)
  function mod289(x) { return x - Math.floor(x / 289) * 289; }
  function permute(x) { return mod289(((x * 34) + 1) * x); }
  function snoise2D(vx, vy) {
    const C0 = 0.211324865405187, C1 = 0.366025403784439;
    const C2 = -0.577350269189626, C3 = 0.024390243902439;
    const s = (vx + vy) * C1;
    const ix = Math.floor(vx + s), iy = Math.floor(vy + s);
    const t = (ix + iy) * C0;
    const x0x = vx - ix + t, x0y = vy - iy + t;
    const i1x = x0x > x0y ? 1 : 0, i1y = x0x > x0y ? 0 : 1;
    const x1x = x0x - i1x + C0, x1y = x0y - i1y + C0;
    const x2x = x0x - 1 + 2 * C0, x2y = x0y - 1 + 2 * C0;
    const ii = mod289(ix), jj = mod289(iy);
    const p0 = permute(permute(jj) + ii);
    const p1 = permute(permute(jj + i1y) + ii + i1x);
    const p2 = permute(permute(jj + 1) + ii + 1);
    let m0 = Math.max(0.5 - (x0x*x0x + x0y*x0y), 0); m0 = m0*m0*m0*m0;
    let m1 = Math.max(0.5 - (x1x*x1x + x1y*x1y), 0); m1 = m1*m1*m1*m1;
    let m2 = Math.max(0.5 - (x2x*x2x + x2y*x2y), 0); m2 = m2*m2*m2*m2;
    const px0 = 2 * ((p0 * C3) - Math.floor(p0 * C3)) - 1;
    const px1 = 2 * ((p1 * C3) - Math.floor(p1 * C3)) - 1;
    const px2 = 2 * ((p2 * C3) - Math.floor(p2 * C3)) - 1;
    const h0 = Math.abs(px0) - 0.5, h1 = Math.abs(px1) - 0.5, h2 = Math.abs(px2) - 0.5;
    const ox0 = Math.floor(px0 + 0.5), ox1 = Math.floor(px1 + 0.5), ox2 = Math.floor(px2 + 0.5);
    const a0x = px0 - ox0, a1x = px1 - ox1, a2x = px2 - ox2;
    const f0 = 1.79284291400159 - 0.85373472095314 * (a0x*a0x + h0*h0);
    const f1 = 1.79284291400159 - 0.85373472095314 * (a1x*a1x + h1*h1);
    const f2 = 1.79284291400159 - 0.85373472095314 * (a2x*a2x + h2*h2);
    return 130 * (m0*f0*(a0x*x0x + h0*x0y) + m1*f1*(a1x*x1x + h1*x1y) + m2*f2*(a2x*x2x + h2*x2y));
  }
  // RGB output: R=raw noise [0,1] (shader maps to [-1,1]), G=∂n/∂x, B=∂n/∂y
  // at eps=0.01 — matches the eps curlNoise() used historically. Gradient of
  // the shader-facing noise equals gradient of raw snoise2D (the shader's
  // `* 2 - 1` shift is linear, so *0.5+0.5 storage → *2-1 read cancels cleanly).
  const data = new Float32Array(size * size * 3);
  const eps = 0.01;
  const invTwoEps = 1.0 / (2.0 * eps);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 0.125 spacing = 8 samples per simplex period (well above Nyquist)
      // 512 × 0.125 = 64 units covered, matching the GLSL 1/64 scale factor
      const px = x * 0.125, py = y * 0.125;
      const n0 = snoise2D(px, py) * 0.5 + 0.5; // raw noise [0, 1]
      // Central-difference gradient at eps matching the former runtime
      // curlNoise() exactly. snoise2D is defined for any input (no wrap
      // needed) — REPEAT wrap on the texture handles cross-boundary sampling
      // at read time.
      const nxp = snoise2D(px + eps, py);
      const nxm = snoise2D(px - eps, py);
      const nyp = snoise2D(px, py + eps);
      const nym = snoise2D(px, py - eps);
      const dnx = (nxp - nxm) * invTwoEps; // ∂n/∂x
      const dny = (nyp - nym) * invTwoEps; // ∂n/∂y

      const idx = (y * size + x) * 3;
      data[idx]     = n0;  // R: raw noise
      data[idx + 1] = dnx; // G: ∂n/∂x
      data[idx + 2] = dny; // B: ∂n/∂y
    }
  }
  return data;
}

const _noiseTexSize = 512;
const _noiseTexData = generateNoiseTexture(_noiseTexSize);

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    console.error('WebGL2 not supported');
    return { error: 'webgl2' };
  }

  // ── Path A TBDR diagnostic: URL param toggle for devices without console ──
  // ?directOnly=1 → skip composite (direct render only)
  if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('directOnly')) {
    window._gpuDiag_directOnlyUrl = true;
    _log('[GPU Diag] directOnly=1 — skipping composite');
  }

  // ── Upload pre-computed noise texture (TEXTURE6, RGB16F, 512×512) ──
  // RGB16F: R=raw simplex noise, G=∂n/∂x, B=∂n/∂y (pre-baked gradients at
  // eps=0.01). Used by render vertex shader snoise() for cypress sway, village,
  // sky gust, and curlNoise() for vortex turbulence + boundary tremble.
  // 512×512: covers 64 simplex noise units (0.125 spacing), matching GLSL 1/64 scale.
  const noiseTex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE6);
  gl.bindTexture(gl.TEXTURE_2D, noiseTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, _noiseTexSize, _noiseTexSize, 0, gl.RGB, gl.FLOAT, _noiseTexData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  // ── Compile shader programs ──
  // 1. Minimal render shader: compiled synchronously (fast, ~30ms). Used for
  //    intro animation and loading frames. Same attribute layout as full shader.
  const miniRenderProg = createProgram(gl, RENDER_MINI_VERT, RENDER_MINI_FRAG, 'renderMini');
  if (!miniRenderProg) {
    console.error('Failed to compile minimal render shader');
    return { error: 'shader', shader: 'render' };
  }
  // Mini shader uniform locations removed — drawParticles skips rendering when
  // !_renderFinalized (intro overlay covers canvas). No mini shader draw path needed.

  // 2. Full render shader: compile+link DEFERRED. The driver compiles in the
  //    background while images download and BFS workers run (~2.4s). Status is
  //    checked in _finalizeRenderProg() before first interactive use.
  const renderProg = createProgram(gl, RENDER_VERT, RENDER_FRAG, 'render', true);
  if (!renderProg) {
    console.error('Failed to compile render shader');
    return { error: 'shader', shader: 'render' };
  }

  const compositeProg = createProgram(gl, COMPOSITE_VERT, COMPOSITE_FRAG, 'composite', true);
  if (!compositeProg) { console.error('Failed to compile composite shader'); return { error: 'shader', shader: 'composite' }; }

  // ── Tonal background program ──
  const tonalProg = createProgram(gl, TONAL_VERT, TONAL_FRAG, 'tonal', true);
  if (!tonalProg) { console.error('Failed to compile tonal shader'); return { error: 'shader', shader: 'tonal' }; }
  let uTonalMap = null; // deferred
  let uTonalStrength = null; // deferred
  let uTonalVignetteStr = null; // deferred
  let uTonalBorderWidth = null; // deferred
  let uTonalBorderRadius = null; // deferred
  let uTonalBorderColor = null; // deferred
  let uTonalResolution = null; // deferred
  let uTonalMargin = null; // deferred
  let uTonalCanvasColor = null; // deferred
  const vaoTonal = gl.createVertexArray(); // empty VAO for gl_VertexID draw

  // ── Shadow program ──
  const shadowProg = createProgram(gl, SHADOW_VERT, SHADOW_FRAG, 'shadow', true);
  if (!shadowProg) { console.error('Failed to compile shadow shader'); return { error: 'shader', shader: 'shadow' }; }
  let uShadowResolution = null; // deferred
  let uShadowBorderRadius = null; // deferred
  let uShadowMargin = null; // deferred
  let uShadowCanvasColor = null; // deferred
  let uShadowColor = null; // deferred
  let uShadowOpacity = null; // deferred
  let uShadowOffset = null; // deferred
  const vaoShadow = gl.createVertexArray(); // empty VAO for gl_VertexID draw

  // ── Bloom pipeline removed (GPU optimization, April 2026) ──

  // ── Sim program (vestigial — skipped at runtime by G7) ──
  // Compilation deferred: runSimStep() early-returns unless window._forceSimPass.
  // Saves one compile+link (~200ms uncached). Infrastructure (buffers, VAOs, TF
  // object) retained for potential future use. To re-enable for debugging:
  //   window._forceSimPass = true  (will compile on first use)
  let simProg = null;
  const usDt = null, usTime = null, usDriftSpeed = null, usCanvasSize = null;
  const usFlashRadius = null, usSpringK = null, usDriftMaxCap = null;
  const usFlowFieldTex = null, usFlowSpeed = null, usFlowDriftFrac = null;
  const usFlowCyclePeriod = null, usFlowThreshold = null, usFlowMaxDrift = null;
  const usRegionMapTex = null, usBoundaryTex = null;
  const asCurrentPos = -1, asHomePos = -1, asSpiralPos = -1, asRegionId = -1;

  // ── Log per-program shader compilation breakdown ──
  const _uniformT0 = performance.now();
  if (_shaderTimings.length > 0) {
    let compileTotal = 0;
    const lines = _shaderTimings.map(t => {
      compileTotal += t.total;
      return `  ${t.label.padEnd(12)} vert: ${t.vert.toFixed(0)}ms (${t.vertLines} lines)  frag: ${t.frag.toFixed(0)}ms (${t.fragLines} lines)  link: ${t.link.toFixed(0)}ms  total: ${t.total.toFixed(0)}ms`;
    });
    _log(
      `%c[ShaderBreakdown]%c  ${_shaderTimings.length} programs, ${compileTotal.toFixed(0)}ms compile+link\n${lines.join('\n')}`,
      'color: #f0f; font-weight: bold', 'color: #ccc'
    );
  }

  // ── Transform feedback object ──
  const tfObj = gl.createTransformFeedback();

  // ── Render shader uniform locations ──
  let uPointSize = null; // deferred — resolved in _finalizeRenderProg()
  let uAspectRatio = null; // deferred — resolved in _finalizeRenderProg()
  let uTime = null; // deferred — resolved in _finalizeRenderProg()
  let uDebugMode = null; // deferred — resolved in _finalizeRenderProg()
  let uSwell = null; // deferred — resolved in _finalizeRenderProg()
  let uLumPreserve = null; // deferred — resolved in _finalizeRenderProg()
  let uBaseAlpha = null; // deferred — resolved in _finalizeRenderProg()

  let uWobbleAmt = null; // deferred — resolved in _finalizeRenderProg()
  let uTrembleAmt = null; // deferred — resolved in _finalizeRenderProg()
  let uTrembleFreq = null; // deferred — resolved in _finalizeRenderProg()
  let uVortexData = null; // deferred — resolved in _finalizeRenderProg()
  let uVortexParams = null; // deferred — resolved in _finalizeRenderProg()
  let uVortexArt = null; // deferred — resolved in _finalizeRenderProg()
  let uVortexCount = null; // deferred — resolved in _finalizeRenderProg()
  let uPaintingTex = null; // deferred — resolved in _finalizeRenderProg()
  let uColorAdvect = null; // deferred — resolved in _finalizeRenderProg()
  let uBoundaryTex = null; // deferred — resolved in _finalizeRenderProg()
  let uNoiseTex = null; // deferred
  let uFlowFieldTexR = null; // deferred — resolved in _finalizeRenderProg()
  let uVignetteStr = null; // deferred — resolved in _finalizeRenderProg()
  let uResolution = null; // deferred — resolved in _finalizeRenderProg()
  let uBorderWidth = null; // deferred — resolved in _finalizeRenderProg()
  let uBorderRadius = null; // deferred — resolved in _finalizeRenderProg()
  let uBorderColor = null; // deferred — resolved in _finalizeRenderProg()
  let uIntroMode = null; // deferred — resolved in _finalizeRenderProg()
  let uIntroGlow = null; // deferred — resolved in _finalizeRenderProg()
  let uIntroGlowRadius = null; // deferred — resolved in _finalizeRenderProg()
  let uRevealBrightness = null; // deferred — resolved in _finalizeRenderProg()
  let uMargin = null; // deferred — resolved in _finalizeRenderProg()
  let uFlashTrail = null; // deferred — resolved in _finalizeRenderProg()
  let uFlashRadius = null; // deferred — resolved in _finalizeRenderProg()
  let uFlashDecay = null; // deferred — resolved in _finalizeRenderProg()
  // Flashlight drift
  let uCanvasSize = null; // deferred — resolved in _finalizeRenderProg()
  let uDriftAmount = null; // deferred — resolved in _finalizeRenderProg()
  let uDriftSpeed = null; // deferred — resolved in _finalizeRenderProg()
  let uDriftMouseSpeed = null; // deferred — resolved in _finalizeRenderProg()
  let uDriftMouseInfluence = null; // deferred — resolved in _finalizeRenderProg()
  let uDriftCenter = null; // deferred — resolved in _finalizeRenderProg()
  let uDriftActive = null; // deferred — resolved in _finalizeRenderProg()
  let uDriftMaxCap = null; // deferred — resolved in _finalizeRenderProg()
  // Hover orbit (two-layer crossfade)
  let uHoverRegion0 = null; // deferred — resolved in _finalizeRenderProg()
  let uHoverIntensity0 = null; // deferred — resolved in _finalizeRenderProg()
  let uHoverCenter0 = null; // deferred — resolved in _finalizeRenderProg()
  let uHoverRegion1 = null; // deferred — resolved in _finalizeRenderProg()
  let uHoverIntensity1 = null; // deferred — resolved in _finalizeRenderProg()
  let uHoverCenter1 = null; // deferred — resolved in _finalizeRenderProg()
  let uHoverFreezeTime0 = null; // deferred — resolved in _finalizeRenderProg()
  let uHoverFreezeTime1 = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowDriftFrac = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowCyclePeriod = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowThreshold = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowMaxDrift = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowCursorUV = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowCursorDir = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowCursorInfluence = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowCursorRadius = null; // deferred — resolved in _finalizeRenderProg()
  let urStarCursorUV = null; // deferred — resolved in _finalizeRenderProg()
  let urStarCursorInfluence = null; // deferred — resolved in _finalizeRenderProg()
  let urStarBumpStrength = null; // deferred — resolved in _finalizeRenderProg()
  let urStarPushRadius = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowMix = null; // deferred — resolved in _finalizeRenderProg()
  let urDistPackTex = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowEdgeDepth = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowSpeedFloor = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowCurvatureTex = null; // deferred — resolved in _finalizeRenderProg()
  let urGustPeriod = null; // deferred — resolved in _finalizeRenderProg()
  let urGustAmplitude = null; // deferred — resolved in _finalizeRenderProg()
  let urEddyMinScale = null; // deferred — resolved in _finalizeRenderProg()
  let urEddyMaxScale = null; // deferred — resolved in _finalizeRenderProg()
  let urCanvasDeformAmp = null; // deferred — resolved in _finalizeRenderProg()
  let urSkyGustAmplitude = null; // deferred — resolved in _finalizeRenderProg()
  let urSkyMaxDrift = null; // deferred — resolved in _finalizeRenderProg()
  let urSkySwayAmount = null; // deferred — resolved in _finalizeRenderProg()
  let urSkyStarShimmer = null; // deferred — resolved in _finalizeRenderProg()
  let urNsWakeTrail = null; // deferred — resolved in _finalizeRenderProg()
  let urNsWakeCursorUV = null; // deferred — resolved in _finalizeRenderProg()
  let urNsWakeCursorInfluence = null; // deferred — resolved in _finalizeRenderProg()
  let urNsWakeRadius = null; // deferred — resolved in _finalizeRenderProg()
  let urNsWakeDecay = null; // deferred — resolved in _finalizeRenderProg()
  let urNsWakeGustBoost = null; // deferred — resolved in _finalizeRenderProg()
  let urNsWakePushStrength = null; // deferred — resolved in _finalizeRenderProg()
  let urFlowTwinkle = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressSwayAmp = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressMaxDrift = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressSwayMix = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressTopY = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressBaseY = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressBaseRatio = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressCrossSway = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressBreathPeriod = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressSwayAngle = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressEdgeDepth = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageWindAmp = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageWindAngle = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageSwayAngle = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageEdgeDepth = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageLumParallax = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageTwinkle = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageTwinkleWarmth = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageBreathPhase = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageBreathDepth = null; // deferred — resolved in _finalizeRenderProg()
  let urBreatheWave = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageNoiseAmp = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageNoiseDrift = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageCrossSway = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageWindCenter = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageWindRadius = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageAttraction = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageWindRadiusActive = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageAttractionAmpActive = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageSwarmTime = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmCyclePeriodMin = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmCyclePeriodMax = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmEarlyDeathPct = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmDeathFadeWidth = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmMaxDriftMul = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmFadeIn = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmFadeOutStart = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmFixedPeriod = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmPhaseSpread = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmLfoSync = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageWindBlend = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageExitPoint = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageWindRippleRadius = null; // deferred — resolved in _finalizeRenderProg()
  let urSwarmDriftFracSmoothed = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageClickOrigin = null; // deferred — resolved in _finalizeRenderProg()
  // urVillageEdgeTex and urCypressEdgeTex replaced by urDistPackTex (G4)
  let urCypressCanopyGlow = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressLeafFlash = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressRimWidth = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressRimGlow = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressFlowTex = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressFlowCyclePeriod = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressFlowDriftFrac = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressFlowMaxDrift = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressFlowGustAmp = null; // deferred — resolved in _finalizeRenderProg()
  let urCypressWindBias = null; // deferred — resolved in _finalizeRenderProg()
  let urIntroDanceScale = null; // deferred — resolved in _finalizeRenderProg()
  let urRegionMapTex = null; // deferred — resolved in _finalizeRenderProg()
  let urClickRemapTex = null; // deferred — resolved in _finalizeRenderProg()
  let urAbsorptionThreshold = null; // deferred — resolved in _finalizeRenderProg()
  let urVillageFadeOut = null; // deferred — resolved in _finalizeRenderProg()
  let villageFadeOut = 0;  // 1 while region 2 is fading out (enables per-particle stagger)
  let urSkyFadeOut = null; // deferred — resolved in _finalizeRenderProg()
  let skyFadeOut = 0;  // 1 while region 3 (Night Sky) is fading out (enables per-particle stagger)
  let urHorizonFadeOut = null; // deferred — resolved in _finalizeRenderProg()
  let horizonFadeOut = 0;  // 1 while region 4 (Horizon) is fading out (enables per-particle stagger)
  // Array uniforms — deferred, populated in _finalizeRenderProg()
  const uRegionMix = [];
  const uRegionActive = [];
  const uRegionClickOrigin = [];
  const uRegionRadius = [];
  const uStarCenter = [];
  const uStarCurrentRadius = [];
  const uStarInnerRadius = [];
  const uStarGlowIntensity = [];
  let uStarGlowActive = null; // deferred — resolved in _finalizeRenderProg()
  let uStarScintillation = null; // deferred — resolved in _finalizeRenderProg()
  let uStarHaloSoftness = null; // deferred — resolved in _finalizeRenderProg()

  // ── Deferred render shader finalization ──
  // Called before first use (in loadPoints). By this point the driver has had
  // ~2.4s to compile the render shader in the background (image download + BFS +
  // dithering). The LINK_STATUS check blocks only if compilation isn't done yet.
  let _renderFinalized = false;

  // ── Debug render program (lazy — compiled on first V-key press) ──
  let _debugRenderProg = null;
  let _activeRenderProg = null; // tracks which program uniforms are currently resolved for

  function _ensureDebugRenderProg() {
    if (_debugRenderProg) return true;
    if (!_renderFinalized) return false;
    const t0 = performance.now();
    _debugRenderProg = createProgram(gl, RENDER_VERT, RENDER_DEBUG_FRAG, 'renderDebug');
    _log(`%c[DebugShader]%c  Compiled in ${(performance.now() - t0).toFixed(0)}ms`, 'color: #f0f; font-weight: bold', 'color: #ccc');
    return !!_debugRenderProg;
  }

  // Resolve all 153 uniforms + 9 attributes from a given program.
  // Called from _finalizeRenderProg (renderProg) and when switching to/from debug program.
  function _resolveRenderUniforms(prog) {
    uPointSize = gl.getUniformLocation(prog, 'u_pointSize');
    uAspectRatio = gl.getUniformLocation(prog, 'u_aspectRatio');
    uTime = gl.getUniformLocation(prog, 'u_time');
    uDebugMode = gl.getUniformLocation(prog, 'u_debugMode');
    uSwell = gl.getUniformLocation(prog, 'u_swell');
    uLumPreserve = gl.getUniformLocation(prog, 'u_luminancePreserve');
    uBaseAlpha = gl.getUniformLocation(prog, 'u_baseAlpha');
    uWobbleAmt = gl.getUniformLocation(prog, 'u_wobbleAmt');
    uTrembleAmt = gl.getUniformLocation(prog, 'u_trembleAmt');
    uTrembleFreq = gl.getUniformLocation(prog, 'u_trembleFreq');
    uVortexData = gl.getUniformLocation(prog, 'u_vortexData');
    uVortexParams = gl.getUniformLocation(prog, 'u_vortexParams');
    uVortexArt = gl.getUniformLocation(prog, 'u_vortexArt');
    uVortexCount = gl.getUniformLocation(prog, 'u_vortexCount');
    uPaintingTex = gl.getUniformLocation(prog, 'u_paintingTex');
    uColorAdvect = gl.getUniformLocation(prog, 'u_colorAdvect');
    uBoundaryTex = gl.getUniformLocation(prog, 'u_boundaryTex');
    uNoiseTex = gl.getUniformLocation(prog, 'u_noiseTex');
    uFlowFieldTexR = gl.getUniformLocation(prog, 'u_flowFieldTex');
    uVignetteStr = gl.getUniformLocation(prog, 'u_vignetteStrength');
    uResolution = gl.getUniformLocation(prog, 'u_resolution');
    uBorderWidth = gl.getUniformLocation(prog, 'u_borderWidth');
    uBorderRadius = gl.getUniformLocation(prog, 'u_borderRadius');
    uBorderColor = gl.getUniformLocation(prog, 'u_borderColor');
    uIntroMode = gl.getUniformLocation(prog, 'u_introMode');
    uIntroGlow = gl.getUniformLocation(prog, 'u_introGlow');
    uIntroGlowRadius = gl.getUniformLocation(prog, 'u_introGlowRadius');
    uRevealBrightness = gl.getUniformLocation(prog, 'u_revealBrightness');
    uMargin = gl.getUniformLocation(prog, 'u_margin');
    uFlashTrail = gl.getUniformLocation(prog, 'u_flashTrail');
    uFlashRadius = gl.getUniformLocation(prog, 'u_flashRadius');
    uFlashDecay = gl.getUniformLocation(prog, 'u_flashDecay');
    uCanvasSize = gl.getUniformLocation(prog, 'u_canvasSize');
    uDriftAmount = gl.getUniformLocation(prog, 'u_driftAmount');
    uDriftSpeed = gl.getUniformLocation(prog, 'u_driftSpeed');
    uDriftMouseSpeed = gl.getUniformLocation(prog, 'u_driftMouseSpeed');
    uDriftMouseInfluence = gl.getUniformLocation(prog, 'u_driftMouseInfluence');
    uDriftCenter = gl.getUniformLocation(prog, 'u_driftCenter');
    uDriftActive = gl.getUniformLocation(prog, 'u_driftActive');
    uDriftMaxCap = gl.getUniformLocation(prog, 'u_driftMaxCap');
    uHoverRegion0 = gl.getUniformLocation(prog, 'u_hoverRegion0');
    uHoverIntensity0 = gl.getUniformLocation(prog, 'u_hoverIntensity0');
    uHoverCenter0 = gl.getUniformLocation(prog, 'u_hoverCenter0');
    uHoverRegion1 = gl.getUniformLocation(prog, 'u_hoverRegion1');
    uHoverIntensity1 = gl.getUniformLocation(prog, 'u_hoverIntensity1');
    uHoverCenter1 = gl.getUniformLocation(prog, 'u_hoverCenter1');
    uHoverFreezeTime0 = gl.getUniformLocation(prog, 'u_hoverFreezeTime0');
    uHoverFreezeTime1 = gl.getUniformLocation(prog, 'u_hoverFreezeTime1');
    urFlowDriftFrac = gl.getUniformLocation(prog, 'u_flowDriftFrac');
    urFlowCyclePeriod = gl.getUniformLocation(prog, 'u_flowCyclePeriod');
    urFlowThreshold = gl.getUniformLocation(prog, 'u_flowThreshold');
    urFlowMaxDrift = gl.getUniformLocation(prog, 'u_flowMaxDrift');
    urFlowCursorUV = gl.getUniformLocation(prog, 'u_flowCursorUV');
    urFlowCursorDir = gl.getUniformLocation(prog, 'u_flowCursorDir');
    urFlowCursorInfluence = gl.getUniformLocation(prog, 'u_flowCursorInfluence');
    urFlowCursorRadius = gl.getUniformLocation(prog, 'u_flowCursorRadius');
    urStarCursorUV = gl.getUniformLocation(prog, 'u_starCursorUV');
    urStarCursorInfluence = gl.getUniformLocation(prog, 'u_starCursorInfluence');
    urStarBumpStrength = gl.getUniformLocation(prog, 'u_starBumpStrength');
    urStarPushRadius = gl.getUniformLocation(prog, 'u_starPushRadius');
    urFlowMix = gl.getUniformLocation(prog, 'u_flowMix');
    urDistPackTex = gl.getUniformLocation(prog, 'u_distPackTex');
    urFlowEdgeDepth = gl.getUniformLocation(prog, 'u_flowEdgeDepth');
    urFlowSpeedFloor = gl.getUniformLocation(prog, 'u_flowSpeedFloor');
    urFlowCurvatureTex = gl.getUniformLocation(prog, 'u_flowCurvatureTex');
    urGustPeriod = gl.getUniformLocation(prog, 'u_gustPeriod');
    urGustAmplitude = gl.getUniformLocation(prog, 'u_gustAmplitude');
    urEddyMinScale = gl.getUniformLocation(prog, 'u_eddyMinScale');
    urEddyMaxScale = gl.getUniformLocation(prog, 'u_eddyMaxScale');
    urCanvasDeformAmp = gl.getUniformLocation(prog, 'u_canvasDeformAmp');
    urSkyGustAmplitude = gl.getUniformLocation(prog, 'u_skyGustAmplitude');
    urSkyMaxDrift = gl.getUniformLocation(prog, 'u_skyMaxDrift');
    urSkySwayAmount = gl.getUniformLocation(prog, 'u_skySwayAmount');
    urSkyStarShimmer = gl.getUniformLocation(prog, 'u_skyStarShimmer');
    urNsWakeTrail = gl.getUniformLocation(prog, 'u_nsWakeTrail');
    urNsWakeCursorUV = gl.getUniformLocation(prog, 'u_nsWakeCursorUV');
    urNsWakeCursorInfluence = gl.getUniformLocation(prog, 'u_nsWakeCursorInfluence');
    urNsWakeRadius = gl.getUniformLocation(prog, 'u_nsWakeRadius');
    urNsWakeDecay = gl.getUniformLocation(prog, 'u_nsWakeDecay');
    urNsWakeGustBoost = gl.getUniformLocation(prog, 'u_nsWakeGustBoost');
    urNsWakePushStrength = gl.getUniformLocation(prog, 'u_nsWakePushStrength');
    urFlowTwinkle = gl.getUniformLocation(prog, 'u_flowTwinkle');
    urCypressSwayAmp = gl.getUniformLocation(prog, 'u_cypressSwayAmp');
    urCypressMaxDrift = gl.getUniformLocation(prog, 'u_cypressMaxDrift');
    urCypressSwayMix = gl.getUniformLocation(prog, 'u_cypressSwayMix');
    urCypressTopY = gl.getUniformLocation(prog, 'u_cypressTopY');
    urCypressBaseY = gl.getUniformLocation(prog, 'u_cypressBaseY');
    urCypressBaseRatio = gl.getUniformLocation(prog, 'u_cypressBaseRatio');
    urCypressCrossSway = gl.getUniformLocation(prog, 'u_cypressCrossSway');
    urCypressBreathPeriod = gl.getUniformLocation(prog, 'u_cypressBreathPeriod');
    urCypressSwayAngle = gl.getUniformLocation(prog, 'u_cypressSwayAngle');
    urCypressEdgeDepth = gl.getUniformLocation(prog, 'u_cypressEdgeDepth');
    urVillageWindAmp = gl.getUniformLocation(prog, 'u_villageWindAmp');
    urVillageWindAngle = gl.getUniformLocation(prog, 'u_villageWindAngle');
    urVillageSwayAngle = gl.getUniformLocation(prog, 'u_villageSwayAngle');
    urVillageEdgeDepth = gl.getUniformLocation(prog, 'u_villageEdgeDepth');
    urVillageLumParallax = gl.getUniformLocation(prog, 'u_villageLumParallax');
    urVillageTwinkle = gl.getUniformLocation(prog, 'u_villageTwinkle');
    urVillageTwinkleWarmth = gl.getUniformLocation(prog, 'u_villageTwinkleWarmth');
    urVillageBreathPhase = gl.getUniformLocation(prog, 'u_villageBreathPhase');
    urVillageBreathDepth = gl.getUniformLocation(prog, 'u_villageBreathDepth');
    urBreatheWave = gl.getUniformLocation(prog, 'u_breatheWave');
    urVillageNoiseAmp = gl.getUniformLocation(prog, 'u_villageNoiseAmp');
    urVillageNoiseDrift = gl.getUniformLocation(prog, 'u_villageNoiseDrift');
    urVillageCrossSway = gl.getUniformLocation(prog, 'u_villageCrossSway');
    urVillageWindCenter = gl.getUniformLocation(prog, 'u_villageWindCenter');
    urVillageWindRadius = gl.getUniformLocation(prog, 'u_villageWindRadius');
    urVillageAttraction = gl.getUniformLocation(prog, 'u_villageAttraction');
    urVillageWindRadiusActive = gl.getUniformLocation(prog, 'u_villageWindRadiusActive');
    urVillageAttractionAmpActive = gl.getUniformLocation(prog, 'u_villageAttractionAmpActive');
    urVillageSwarmTime = gl.getUniformLocation(prog, 'u_villageSwarmTime');
    urSwarmCyclePeriodMin = gl.getUniformLocation(prog, 'u_swarmCyclePeriodMin');
    urSwarmCyclePeriodMax = gl.getUniformLocation(prog, 'u_swarmCyclePeriodMax');
    urSwarmEarlyDeathPct = gl.getUniformLocation(prog, 'u_swarmEarlyDeathPct');
    urSwarmDeathFadeWidth = gl.getUniformLocation(prog, 'u_swarmDeathFadeWidth');
    urSwarmMaxDriftMul = gl.getUniformLocation(prog, 'u_swarmMaxDriftMul');
    urSwarmFadeIn = gl.getUniformLocation(prog, 'u_swarmFadeIn');
    urSwarmFadeOutStart = gl.getUniformLocation(prog, 'u_swarmFadeOutStart');
    urSwarmFixedPeriod = gl.getUniformLocation(prog, 'u_swarmFixedPeriod');
    urSwarmPhaseSpread = gl.getUniformLocation(prog, 'u_swarmPhaseSpread');
    urSwarmLfoSync = gl.getUniformLocation(prog, 'u_swarmLfoSync');
    urVillageWindBlend = gl.getUniformLocation(prog, 'u_villageWindBlend');
    urVillageExitPoint = gl.getUniformLocation(prog, 'u_villageExitPoint');
    urVillageWindRippleRadius = gl.getUniformLocation(prog, 'u_villageWindRippleRadius');
    urSwarmDriftFracSmoothed = gl.getUniformLocation(prog, 'u_swarmDriftFracSmoothed');
    urVillageClickOrigin = gl.getUniformLocation(prog, 'u_villageClickOrigin');
    urCypressCanopyGlow = gl.getUniformLocation(prog, 'u_cypressCanopyGlow');
    urCypressLeafFlash = gl.getUniformLocation(prog, 'u_cypressLeafFlash');
    urCypressRimWidth = gl.getUniformLocation(prog, 'u_cypressRimWidth');
    urCypressRimGlow = gl.getUniformLocation(prog, 'u_cypressRimGlow');
    urCypressFlowTex = gl.getUniformLocation(prog, 'u_cypressFlowTex');
    urCypressFlowCyclePeriod = gl.getUniformLocation(prog, 'u_cypressFlowCyclePeriod');
    urCypressFlowDriftFrac = gl.getUniformLocation(prog, 'u_cypressFlowDriftFrac');
    urCypressFlowMaxDrift = gl.getUniformLocation(prog, 'u_cypressFlowMaxDrift');
    urCypressFlowGustAmp = gl.getUniformLocation(prog, 'u_cypressFlowGustAmp');
    urCypressWindBias = gl.getUniformLocation(prog, 'u_cypressWindBias');
    urIntroDanceScale = gl.getUniformLocation(prog, 'u_introDanceScale');
    urRegionMapTex = gl.getUniformLocation(prog, 'u_regionMapTex');
    urClickRemapTex = gl.getUniformLocation(prog, 'u_clickRemapTex');
    urAbsorptionThreshold = gl.getUniformLocation(prog, 'u_absorptionThreshold');
    uStarGlowActive = gl.getUniformLocation(prog, 'u_starGlowActive');
    uStarScintillation = gl.getUniformLocation(prog, 'u_starScintillation');
    uStarHaloSoftness = gl.getUniformLocation(prog, 'u_starHaloSoftness');
    // Array uniforms
    uRegionMix.length = 0;
    for (let i = 0; i < NUM_REGIONS; i++) uRegionMix.push(gl.getUniformLocation(prog, `u_regionMix[${i}]`));
    uRegionActive.length = 0;
    uRegionClickOrigin.length = 0;
    uRegionRadius.length = 0;
    for (let i = 0; i < 5; i++) {
      uRegionActive.push(gl.getUniformLocation(prog, `u_regionActive[${i}]`));
      uRegionClickOrigin.push(gl.getUniformLocation(prog, `u_regionClickOrigin[${i}]`));
      uRegionRadius.push(gl.getUniformLocation(prog, `u_regionRadius[${i}]`));
    }
    urVillageFadeOut = gl.getUniformLocation(prog, 'u_villageFadeOut');
    urSkyFadeOut = gl.getUniformLocation(prog, 'u_skyFadeOut');
    urHorizonFadeOut = gl.getUniformLocation(prog, 'u_horizonFadeOut');
    uStarCenter.length = 0;
    uStarCurrentRadius.length = 0;
    uStarInnerRadius.length = 0;
    for (let i = 0; i < 12; i++) {
      uStarCenter.push(gl.getUniformLocation(prog, `u_starCenter[${i}]`));
      uStarCurrentRadius.push(gl.getUniformLocation(prog, `u_starCurrentRadius[${i}]`));
      uStarInnerRadius.push(gl.getUniformLocation(prog, `u_starInnerRadius[${i}]`));
    }
    uStarGlowIntensity.length = 0;
    for (let i = 0; i < 12; i++) uStarGlowIntensity.push(gl.getUniformLocation(prog, `u_starGlowIntensity[${i}]`));
    // Attribute locations (explicit layout = always 0-8, but resolve for safety)
    aRenderHome = gl.getAttribLocation(prog, 'a_homePos');
    aRenderSpiral = gl.getAttribLocation(prog, 'a_spiralPos');
    aRenderColor = gl.getAttribLocation(prog, 'a_color');
    aRenderRegion = gl.getAttribLocation(prog, 'a_regionId');
    aRenderBoundaryDist = gl.getAttribLocation(prog, 'a_boundaryDist');
    aRenderSimPos = gl.getAttribLocation(prog, 'a_simPos');
    aRenderCoherence = gl.getAttribLocation(prog, 'a_coherence');
    aRenderFlowAngle = gl.getAttribLocation(prog, 'a_flowAngle');
    _activeRenderProg = prog;
  }

  function _finalizeRenderProg() {
    if (_renderFinalized) return true;
    const _ft0 = performance.now();
    if (!gl.getProgramParameter(renderProg, gl.LINK_STATUS)) {
      console.error('Render program link error:', gl.getProgramInfoLog(renderProg));
      return false;
    }
    const _ftLink = performance.now();
    _resolveRenderUniforms(renderProg);
    _renderFinalized = true;
    const _ftDone = performance.now();
    _log(
      `%c[RenderFinalize]%c  Link check: ${(_ftLink - _ft0).toFixed(0)}ms | Uniforms+attribs: ${(_ftDone - _ftLink).toFixed(0)}ms | Total: ${(_ftDone - _ft0).toFixed(0)}ms`,
      'color: #f0f; font-weight: bold', 'color: #ccc'
    );
    return true;
  }

  // ── Deferred finalization for all 7 non-render programs ──
  // Called from showGLCanvas setTimeout alongside _finalizeRenderProg.
  // On Chrome: instant (driver compiled in background). On Firefox: blocks
  // for the full D3DCompile time (~2s) but painting is already visible.
  let _otherProgramsFinalized = false;
  function _finalizeOtherPrograms() {
    if (_otherProgramsFinalized) return true;
    const _ft0 = performance.now();
    // Check LINK_STATUS for all 7 programs
    const progs = [
      [compositeProg, 'composite'], [tonalProg, 'tonal'], [shadowProg, 'shadow'],
    ];
    for (const [prog, name] of progs) {
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error(`[Finalize] ${name} program link error:`, gl.getProgramInfoLog(prog));
        return false;
      }
    }
    const _ftLink = performance.now();
    // Resolve all uniform + attribute locations
    ucCurrentTex = gl.getUniformLocation(compositeProg, 'u_currentTex');
    ucPrevTex = gl.getUniformLocation(compositeProg, 'u_prevTex');
    ucPersistence = gl.getUniformLocation(compositeProg, 'u_persistence');
    ucFlowPersistence = gl.getUniformLocation(compositeProg, 'u_flowPersistence');
    ucRegionMapTex = gl.getUniformLocation(compositeProg, 'u_regionMapTex');
    ucFlowCurvatureTex = gl.getUniformLocation(compositeProg, 'u_flowCurvatureTex');
    ucEddyMinScale = gl.getUniformLocation(compositeProg, 'u_eddyMinScale');
    ucEddyMaxScale = gl.getUniformLocation(compositeProg, 'u_eddyMaxScale');
    ucTrailSubtract = gl.getUniformLocation(compositeProg, 'u_trailSubtract');
    ucFlowFieldTex = gl.getUniformLocation(compositeProg, 'u_flowFieldTex');
    ucSkyGustPersistence = gl.getUniformLocation(compositeProg, 'u_skyGustPersistence');
    ucSkyGustFade = gl.getUniformLocation(compositeProg, 'u_skyGustFade');
    ucNsWakeCursorUV = gl.getUniformLocation(compositeProg, 'u_cNsWakeCursorUV');
    ucNsWakeCursorInfluence = gl.getUniformLocation(compositeProg, 'u_cNsWakeCursorInfluence');
    ucNsWakeRadius = gl.getUniformLocation(compositeProg, 'u_cNsWakeRadius');
    ucVillageTrailPersistence = gl.getUniformLocation(compositeProg, 'u_villageTrailPersistence');
    ucVillageTrailFade = gl.getUniformLocation(compositeProg, 'u_villageTrailFade');
    ucVillageTrailCenter = gl.getUniformLocation(compositeProg, 'u_villageTrailCenter');
    ucVillageTrailRadius = gl.getUniformLocation(compositeProg, 'u_villageTrailRadius');
    ucVillageTrailAttraction = gl.getUniformLocation(compositeProg, 'u_villageTrailAttraction');
    ucVillageWindBlend = gl.getUniformLocation(compositeProg, 'u_villageWindBlend');
    ucVillageCursorMoving = gl.getUniformLocation(compositeProg, 'u_villageCursorMoving');
    ucVillageTopY = gl.getUniformLocation(compositeProg, 'u_villageTopY');
    ucVillageBottomY = gl.getUniformLocation(compositeProg, 'u_villageBottomY');
    ucVillageBaseTrailRatio = gl.getUniformLocation(compositeProg, 'u_villageBaseTrailRatio');
    ucCypressTrailPersistence = gl.getUniformLocation(compositeProg, 'u_cypressTrailPersistence');
    ucCypressTrailFade = gl.getUniformLocation(compositeProg, 'u_cypressTrailFade');
    ucVortexTrailPersistence = gl.getUniformLocation(compositeProg, 'u_vortexTrailPersistence');
    ucStarCursorUV = gl.getUniformLocation(compositeProg, 'u_cStarCursorUV');
    ucStarCursorInfluence = gl.getUniformLocation(compositeProg, 'u_cStarCursorInfluence');
    ucStarPushRadius = gl.getUniformLocation(compositeProg, 'u_cStarPushRadius');
    ucStarTrailPersist = gl.getUniformLocation(compositeProg, 'u_cStarTrailPersist');
    ucSwirlTrailPersistence = gl.getUniformLocation(compositeProg, 'u_swirlTrailPersistence');
    ucSwirlTrailFade = gl.getUniformLocation(compositeProg, 'u_swirlTrailFade');
    ucFlowSpeedFloor = gl.getUniformLocation(compositeProg, 'u_flowSpeedFloor');
    ucCVortexData = gl.getUniformLocation(compositeProg, 'u_cVortexData');
    ucCVortexParams = gl.getUniformLocation(compositeProg, 'u_cVortexParams');
    ucCVortexCount = gl.getUniformLocation(compositeProg, 'u_cVortexCount');
    ucCAspectRatio = gl.getUniformLocation(compositeProg, 'u_cAspectRatio');
    ucCTrailMultiplier = gl.getUniformLocation(compositeProg, 'u_cTrailMultiplier');
    acPos = gl.getAttribLocation(compositeProg, 'a_pos');
    uTonalMap = gl.getUniformLocation(tonalProg, 'u_tonalMap');
    uTonalStrength = gl.getUniformLocation(tonalProg, 'u_strength');
    uTonalVignetteStr = gl.getUniformLocation(tonalProg, 'u_vignetteStrength');
    uTonalBorderWidth = gl.getUniformLocation(tonalProg, 'u_borderWidth');
    uTonalBorderRadius = gl.getUniformLocation(tonalProg, 'u_borderRadius');
    uTonalBorderColor = gl.getUniformLocation(tonalProg, 'u_borderColor');
    uTonalResolution = gl.getUniformLocation(tonalProg, 'u_resolution');
    uTonalMargin = gl.getUniformLocation(tonalProg, 'u_margin');
    uTonalCanvasColor = gl.getUniformLocation(tonalProg, 'u_canvasColor');
    uShadowResolution = gl.getUniformLocation(shadowProg, 'u_resolution');
    uShadowBorderRadius = gl.getUniformLocation(shadowProg, 'u_borderRadius');
    uShadowMargin = gl.getUniformLocation(shadowProg, 'u_margin');
    uShadowCanvasColor = gl.getUniformLocation(shadowProg, 'u_canvasColor');
    uShadowColor = gl.getUniformLocation(shadowProg, 'u_shadowColor');
    uShadowOpacity = gl.getUniformLocation(shadowProg, 'u_shadowOpacity');
    // uShadowSpread removed (dead uniform)
    uShadowOffset = gl.getUniformLocation(shadowProg, 'u_shadowOffset');
    // Set up composite quad VAO now that acPos is resolved
    vaoQuad = gl.createVertexArray();
    gl.bindVertexArray(vaoQuad);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(acPos);
    gl.vertexAttribPointer(acPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    _otherProgramsFinalized = true;
    const _ftDone = performance.now();
    _log(
      `%c[OtherFinalize]%c  Link check: ${(_ftLink - _ft0).toFixed(0)}ms | Uniforms: ${(_ftDone - _ftLink).toFixed(0)}ms | Total: ${(_ftDone - _ft0).toFixed(0)}ms`,
      'color: #f0f; font-weight: bold', 'color: #ccc'
    );
    return true;
  }

  // ── Composite shader uniform locations ──
  let ucCurrentTex = null; // deferred
  let ucPrevTex = null; // deferred
  let ucPersistence = null; // deferred
  let ucFlowPersistence = null; // deferred
  let ucRegionMapTex = null; // deferred
  let ucFlowCurvatureTex = null; // deferred
  let ucEddyMinScale = null; // deferred
  let ucEddyMaxScale = null; // deferred
  let ucTrailSubtract = null; // deferred
  let ucFlowFieldTex = null; // deferred
  let ucSkyGustPersistence = null; // deferred
  let ucSkyGustFade = null; // deferred
  let ucNsWakeCursorUV = null; // deferred
  let ucNsWakeCursorInfluence = null; // deferred
  let ucNsWakeRadius = null; // deferred
  let ucVillageTrailPersistence = null; // deferred
  let ucVillageTrailFade = null; // deferred
  let ucVillageTrailCenter = null; // deferred
  let ucVillageTrailRadius = null; // deferred
  let ucVillageTrailAttraction = null; // deferred
  let ucVillageWindBlend = null; // deferred
  let ucVillageCursorMoving = null; // deferred
  let ucVillageTopY = null; // deferred
  let ucVillageBottomY = null; // deferred
  let ucVillageBaseTrailRatio = null; // deferred
  let ucCypressTrailPersistence = null; // deferred
  let ucCypressTrailFade = null; // deferred
  let ucVortexTrailPersistence = null; // deferred
  let ucStarCursorUV = null; // deferred
  let ucStarCursorInfluence = null; // deferred
  let ucStarPushRadius = null; // deferred
  let ucStarTrailPersist = null; // deferred
  let ucSwirlTrailPersistence = null; // deferred
  let ucSwirlTrailFade = null; // deferred
  let ucFlowSpeedFloor = null; // deferred
  let ucCVortexData = null; // deferred
  let ucCVortexParams = null; // deferred
  let ucCVortexCount = null; // deferred
  let ucCAspectRatio = null; // deferred
  let ucCTrailMultiplier = null; // deferred


  // ── Render attribute locations ──
  let aRenderHome = -1; // deferred — resolved in _finalizeRenderProg()
  let aRenderSpiral = -1; // deferred — resolved in _finalizeRenderProg()
  let aRenderColor = -1; // deferred — resolved in _finalizeRenderProg()
  let aRenderRegion = -1; // deferred — resolved in _finalizeRenderProg()
  let aRenderBoundaryDist = -1; // deferred — resolved in _finalizeRenderProg()
  let aRenderSimPos = -1; // deferred — resolved in _finalizeRenderProg()
  let aRenderCoherence = -1; // deferred — resolved in _finalizeRenderProg()
  let aRenderFlowAngle = -1; // deferred — resolved in _finalizeRenderProg()

  // ── Composite attribute location ──
  let acPos = -1; // deferred

  const _uniformElapsed = performance.now() - _uniformT0;
  _log(
    `%c[ShaderBreakdown]%c  Uniform/attrib resolution: ${_uniformElapsed.toFixed(0)}ms (261 locations)`,
    'color: #f0f; font-weight: bold', 'color: #ccc'
  );

  // ── Fullscreen quad for composite pass ──
  const quadVerts = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

  // Composite quad VAO — deferred until _finalizeOtherPrograms resolves acPos
  let vaoQuad = null;

  // ── Painting texture for color advection ──
  let paintingTex = null;

  function uploadPaintingTexture(imageData) {
    if (paintingTex) gl.deleteTexture(paintingTex);
    paintingTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, paintingTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8,
      imageData.width, imageData.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, imageData.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ── Tonal background texture (tiny downsampled source image) ──
  let tonalTex = null;

  function uploadTonalTexture(sourceImageData) {
    // Underpainting: downsampled painting behind dithered particles.
    // 512×512 preserves brushstroke-level color variation (~1MB GPU)
    // while staying far lighter than the full-res source.
    const SIZE = 512;
    const offscreen = document.createElement('canvas');
    offscreen.width = SIZE;
    offscreen.height = SIZE;
    const ctx = offscreen.getContext('2d');
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = sourceImageData.width;
    tmpCanvas.height = sourceImageData.height;
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.putImageData(sourceImageData, 0, 0);
    ctx.drawImage(tmpCanvas, 0, 0, SIZE, SIZE);
    const downsampled = ctx.getImageData(0, 0, SIZE, SIZE);

    if (tonalTex) gl.deleteTexture(tonalTex);
    tonalTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tonalTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIZE, SIZE, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, downsampled.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ── G12: Boundary distance texture (R16F) for displaced-position collision ──
  // R16F halves bandwidth vs R32F. Values are normalized [0,1] — R16F has
  // 11-bit mantissa (~0.1% precision), sufficient for threshold checks (< 0.001)
  // and smoothstep edge falloffs. Uses NEAREST filtering (no extension needed).
  let boundaryTex = null;

  function uploadBoundaryTexture(distField, width, height) {
    if (boundaryTex) gl.deleteTexture(boundaryTex);
    // Normalize to [0,1] — 0 = locked, 1 = far from boundary
    const maxDist = Math.max(width, height);
    const normalized = new Float32Array(distField.length);
    for (let i = 0; i < distField.length; i++) {
      normalized[i] = Math.min(distField[i] / maxDist, 1.0);
    }
    boundaryTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, boundaryTex);
    // R16F: driver converts Float32 source to half-float storage
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0,
      gl.RED, gl.FLOAT, normalized);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ── G4: Packed distance texture (RGBA16F) ──
  // R=flowEdge, G=cypressEdge, B=villageEdge, A=unused (0)
  // Replaces 3 separate R32F textures with 1 RGBA16F — saves 2 texture fetches
  // per particle and halves bandwidth per fetch (16-bit vs 32-bit).
  let distPackTex = null;

  function uploadDistancePackTexture(flowEdge, cypressEdge, villageEdge, width, height) {
    if (distPackTex) gl.deleteTexture(distPackTex);
    // Interleave into RGBA
    const n = width * height;
    const packed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      packed[i * 4]     = flowEdge ? flowEdge[i] : 0;
      packed[i * 4 + 1] = cypressEdge ? cypressEdge[i] : 0;
      packed[i * 4 + 2] = villageEdge ? villageEdge[i] : 0;
      packed[i * 4 + 3] = 0;  // unused alpha
    }
    distPackTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, distPackTex);
    gl.getExtension('OES_texture_float_linear');
    // RGBA16F: driver converts Float32 source → half-float storage
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0,
      gl.RGBA, gl.FLOAT, packed);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _log(
      `%c[DistPack]%c  RGBA16F texture uploaded: ${width}×${height} (flowEdge + cypressEdge + villageEdge)`,
      'color: #8af; font-weight: bold', 'color: #999'
    );
  }

  // ── Star edge distance texture ──
  let absorptionThreshold = 0.0;  // if you're in the gravity, you're part of the star

  // ── Flow curvature + eddy energy texture (RG16F) ──
  let flowCurvatureTex = null;

  // G13: RG16F instead of RG32F — halves bandwidth. Both curvature and
  // eddy energy are [0,1], fed into mix()/pow(). R16F precision sufficient.
  // WebGL 2 guarantees LINEAR filtering on half-float (no extension needed).
  function uploadFlowCurvatureTexture(curvatureField, eddyField, width, height) {
    if (flowCurvatureTex) gl.deleteTexture(flowCurvatureTex);
    flowCurvatureTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, flowCurvatureTex);
    // Interleave curvature (R) + eddy energy (G) into RG16F
    const n = width * height;
    const packed = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      packed[i * 2]     = curvatureField[i];
      packed[i * 2 + 1] = eddyField ? eddyField[i] : 0.5; // 0.5 = neutral (eddyScale = 1.0)
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, width, height, 0,
      gl.RG, gl.FLOAT, packed);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _log(
      `%c[FlowCurv]%c  RG16F texture uploaded: ${width}×${height} (curvature + eddy energy)`,
      'color: #f80; font-weight: bold', 'color: #999'
    );
  }

  // ── GPU Gaussian blur (init-time utility) ──
  // Lazy-compiled shader + VAO for separable blur passes.
  let gpuBlurProg = null;
  let gpuBlurLocs = null;
  let gpuBlurVAO = null;

  function ensureGpuBlurProgram() {
    if (gpuBlurProg) return true;
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
      console.warn('[gpuBlur] EXT_color_buffer_float not available — falling back to CPU blur');
      return false;
    }
    gpuBlurProg = createProgram(gl, GPU_BLUR_VERT, GPU_BLUR_FRAG);
    if (!gpuBlurProg) {
      console.warn('[gpuBlur] Failed to compile blur shader — falling back to CPU blur');
      return false;
    }
    gpuBlurLocs = {
      u_src:    gl.getUniformLocation(gpuBlurProg, 'u_src'),
      u_dir:    gl.getUniformLocation(gpuBlurProg, 'u_dir'),
      u_sigma:  gl.getUniformLocation(gpuBlurProg, 'u_sigma'),
      u_radius: gl.getUniformLocation(gpuBlurProg, 'u_radius'),
    };
    gpuBlurVAO = gl.createVertexArray(); // empty — uses gl_VertexID
    return true;
  }

  /**
   * GPU-accelerated separable Gaussian blur.
   * Takes a Float32Array of raw values and returns the blurred Float32Array.
   * Returns null if GPU path is unavailable (caller should fall back to CPU).
   */
  function gpuBlur(rawData, width, height, sigma) {
    if (!ensureGpuBlurProgram()) return null;

    const t0 = performance.now();
    const radius = Math.ceil(3.0 * sigma);
    const n = width * height;

    // ── Save GL state ──
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const prevViewport = gl.getParameter(gl.VIEWPORT);
    const prevActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
    const prevBlend = gl.isEnabled(gl.BLEND);

    // ── Create source texture from rawData ──
    const srcTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0,
      gl.RED, gl.FLOAT, rawData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ── Create two ping-pong R32F FBOs ──
    function makeBlurFBO() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0,
        gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, tex, 0);
      return { fbo, tex };
    }
    const fboA = makeBlurFBO();
    const fboB = makeBlurFBO();

    // ── Draw blur passes ──
    gl.useProgram(gpuBlurProg);
    gl.bindVertexArray(gpuBlurVAO);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.uniform1i(gpuBlurLocs.u_src, 0);
    gl.uniform1f(gpuBlurLocs.u_sigma, sigma);
    gl.uniform1i(gpuBlurLocs.u_radius, radius);

    // Horizontal pass: srcTex → fboA
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fbo);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform2f(gpuBlurLocs.u_dir, 1.0, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Vertical pass: fboA.tex → fboB
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fbo);
    gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
    gl.uniform2f(gpuBlurLocs.u_dir, 0.0, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ── Read back result ──
    const result = new Float32Array(n);
    gl.readPixels(0, 0, width, height, gl.RED, gl.FLOAT, result);

    // ── Restore GL state ──
    gl.bindVertexArray(prevVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.useProgram(prevProg);
    gl.activeTexture(prevActiveTexture);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    if (prevBlend) gl.enable(gl.BLEND);

    // ── Cleanup temp resources ──
    gl.deleteTexture(srcTex);
    gl.deleteTexture(fboA.tex);
    gl.deleteFramebuffer(fboA.fbo);
    gl.deleteTexture(fboB.tex);
    gl.deleteFramebuffer(fboB.fbo);

    const elapsed = performance.now() - t0;
    _log(
      `%c[gpuBlur]%c  σ=${sigma} (radius=${radius}), ${width}×${height}, ${elapsed.toFixed(1)}ms`,
      'color: #0cf; font-weight: bold', 'color: #999'
    );
    return result;
  }

  // ── Region map texture (R8) for territory boundary enforcement in sim shader ──
  let regionMapTex = null;

  function uploadRegionMapTexture(regionMap, width, height) {
    if (regionMapTex) gl.deleteTexture(regionMapTex);
    regionMapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, regionMapTex);
    // R8: single-channel 8-bit texture storing region IDs (0-5).
    // Shader reads texture(...).r as normalized [0,1], multiplies by 255 to recover integer ID.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0,
      gl.RED, gl.UNSIGNED_BYTE, regionMap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _log(
      `%c[RegionMap]%c  Texture uploaded: ${width}×${height}`,
      'color: #8f0; font-weight: bold', 'color: #999'
    );
  }

  // ── Click remap texture (R8) for debug visualization of enclosed region 3 → 4 ──
  let clickRemapTex = null;

  function uploadClickRemapTexture(clickMap, width, height) {
    if (clickRemapTex) gl.deleteTexture(clickRemapTex);
    clickRemapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, clickRemapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0,
      gl.RED, gl.UNSIGNED_BYTE, clickMap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _log(
      `%c[ClickRemap]%c  Texture uploaded: ${width}×${height}`,
      'color: #f5a; font-weight: bold', 'color: #999'
    );
  }

  /**
   * Upload precomputed flow field as a GPU texture for sim shader sampling.
   * R = coherence, G = cos(angle)*0.5+0.5, B = sin(angle)*0.5+0.5
   * The sim shader can sample this at any advected position to get flow direction.
   */
  function uploadFlowFieldTexture(flowCoherence, flowAngle, width, height) {
    if (flowFieldTex) gl.deleteTexture(flowFieldTex);
    const n = width * height;
    const pixels = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      pixels[i * 3]     = Math.round(flowCoherence[i] * 255);
      pixels[i * 3 + 1] = Math.round((Math.cos(flowAngle[i]) * 0.5 + 0.5) * 255);
      pixels[i * 3 + 2] = Math.round((Math.sin(flowAngle[i]) * 0.5 + 0.5) * 255);
    }
    flowFieldTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, flowFieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, width, height, 0,
      gl.RGB, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _log(
      '%c[FlowTex]%c  Uploaded %dx%d flow field texture',
      'color: #58f; font-weight: bold', 'color: #999', width, height
    );
  }

  function uploadCypressFlowTexture(flowCoherence, flowAngle, width, height) {
    if (cypressFlowTex) gl.deleteTexture(cypressFlowTex);
    const n = width * height;
    const pixels = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      pixels[i * 3]     = Math.round(flowCoherence[i] * 255);
      pixels[i * 3 + 1] = Math.round((Math.cos(flowAngle[i]) * 0.5 + 0.5) * 255);
      pixels[i * 3 + 2] = Math.round((Math.sin(flowAngle[i]) * 0.5 + 0.5) * 255);
    }
    cypressFlowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, cypressFlowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, width, height, 0,
      gl.RGB, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    _log(
      '%c[CypressFlow]%c  Uploaded %dx%d cypress flow field texture',
      'color: #4a5; font-weight: bold', 'color: #999', width, height
    );
  }

  // ── FBO ping-pong for trail persistence ──
  // Two FBOs: "current" receives fresh particle render,
  // "trail" accumulates faded afterimages across frames.
  // Trail FBOs are full-res (G9 half-res attempted April 9 but reverted —
  // 1px particles are sub-pixel at half-res, causing 75% brightness loss
  // when the composite downsamples texA via LINEAR filtering).
  let fboWidth = 0, fboHeight = 0;
  let fboA = null, texA = null;  // current frame particles (all)
  let fboB = null, texB = null;  // accumulated trail buffer
  let fboC = null, texC = null;  // composite output (becomes next trail)
  let fboD = null, texD = null;  // trail-only particles (star trails mode)

  function createFboTexture(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    const forceFail = new URLSearchParams(location.search).has('fboError');
    if (status !== gl.FRAMEBUFFER_COMPLETE || forceFail) {
      console.error(`[FBO] Framebuffer incomplete: 0x${status.toString(16)} (${w}x${h})${forceFail ? ' (forced)' : ''}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, complete: status === gl.FRAMEBUFFER_COMPLETE && !forceFail };
  }

  let _fboHealthy = true;

  function ensureFbos(w, h) {
    if (fboWidth === w && fboHeight === h) return;
    const oldFboB = fboB, oldTexB = texB;
    const oldW = fboWidth, oldH = fboHeight;
    // Create new FBOs at target size
    const a = createFboTexture(w, h);
    const b = createFboTexture(w, h);
    const c = createFboTexture(w, h);
    const d = createFboTexture(w, h);
    _fboHealthy = a.complete && b.complete && c.complete && d.complete;
    // Preserve trail buffer: blit old FBO-B → new FBO-B (scaled, LINEAR)
    // before deleting old FBOs. Prevents trail pop on canvas resize.
    if (oldFboB && oldW && oldH) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, oldFboB);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, b.fbo);
      gl.blitFramebuffer(0, 0, oldW, oldH, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    } else {
      // No old trail — clear to canvas color
      gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
      gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    // Destroy old FBOs
    if (fboA) { gl.deleteFramebuffer(fboA); gl.deleteTexture(texA); }
    if (oldFboB) { gl.deleteFramebuffer(oldFboB); gl.deleteTexture(oldTexB); }
    if (fboC) { gl.deleteFramebuffer(fboC); gl.deleteTexture(texC); }
    if (fboD) { gl.deleteFramebuffer(fboD); gl.deleteTexture(texD); }
    fboA = a.fbo; texA = a.tex;
    fboB = b.fbo; texB = b.tex;
    fboC = c.fbo; texC = c.tex;
    fboD = d.fbo; texD = d.tex;
    fboWidth = w; fboHeight = h;
    _log(`%c[Trail]%c  FBOs ${oldW ? 'resized' : 'created'}: ${w}×${h}${oldW ? ` (from ${oldW}×${oldH})` : ''}`, 'color: #0ff; font-weight: bold', 'color: #999');
  }


  // ── GPU buffers (all static) ──
  // G20 (interleaved VBO) was attempted and reverted — caused FPS regression
  // on Intel Iris Plus 645. Separate sequential buffers are faster on Intel's
  // vertex fetch hardware (streaming prefetch per binding point).
  let homePosBuffer    = null;
  let spiralPosBuffer  = null;
  let colorBuffer      = null;
  let regionIdBuffer   = null;
  let boundaryDistBuffer = null;
  let coherenceBuffer    = null;
  let flowAngleBuffer    = null;
  let flowFieldTex       = null;  // GPU texture: R=coherence, G=cos(θ)*0.5+0.5, B=sin(θ)*0.5+0.5
  let cypressFlowTex     = null;  // GPU texture: cypress-specific flow field (TEXTURE7)
  let vaoRender        = null;   // single VAO for all static buffers

  // ── State ──
  let pointCount    = 0;
  // Fraction of particles to actually draw per frame [0.1, 1.0]. Set via
  // setParticleFraction() — the renderer keeps the full buffer on the GPU and
  // simply passes a smaller count to gl.drawArrays. Combined with the
  // within-region shuffle in loadPoints, fractional draws give uniform spatial
  // thinning instead of "first regions only" bias.
  let _particleDrawFraction = 1.0;
  let pointSize     = 1.0;
  let resScale      = 1.0;   // canvas pixels / source pixels (DPR-aware scaling)
  let hasRegionData = false;
  let homePosData   = null;   // CPU copy of a_homePos
  let regionIdData  = null;   // CPU copy of a_regionId
  let coherenceData = null;   // CPU copy of coherence (for debug)
  let regionOffsets = null;   // G2a: per-region start index (Uint32Array[6])
  let regionCounts  = null;   // G2a: per-region particle count (Uint32Array[6])
  let animFrameId   = null;
  let lastFrameTime = 0;
  let simTime       = 0;         // accumulated simulation time (seconds)
  let fps           = 0;
  let frameCount    = 0;
  let fpsAccum      = 0;
  let frameTimeAccum = 0;  // rAF frame delta accumulator (ms)
  let renderTimeAccum = 0; // CPU render time accumulator (ms) — actual work per frame
  let gpuTimeAccum  = 0;   // GPU draw time accumulator (ms)
  let gpuQueryCount = 0;   // how many GPU queries completed this sample window
  let droppedFrames = 0;   // frames where delta > 20ms (missed vsync)
  let onFpsUpdate   = null;
  let onStatsUpdate = null; // callback for extended stats
  let beforeRender  = null;

  // ── Flashlight state ──
  const FLASH_TRAIL_SIZE = 24;
  const flashTrailData = new Float32Array(FLASH_TRAIL_SIZE * 4);  // vec4 per slot
  let flashRadius = 0;       // in canvas pixels (computed from CSS 64px)
  let flashDecay  = 0.4;     // seconds of persistence

  // ── Flashlight drift state ──
  let driftAmount         = 0;     // home-position-space units (set from UI via pixel conversion)
  let driftSpeed          = 0.6;   // noise frequency multiplier
  let driftMouseSpeed     = 0;     // 0–1 normalized, updated per frame from UI
  let driftMouseInfluence = 0.5;   // mouse speed amplification factor
  let driftCenterX        = 0;     // current cursor X in canvas pixels
  let driftCenterY        = 0;     // current cursor Y in canvas pixels
  let driftActive         = 0;     // 1.0 when cursor on canvas, 0.0 when off
  let driftMaxCap         = 0;     // home-position-space units (set from UI via pixel conversion)

  // Two hover layers for crossfade
  let hoverRegion0 = -1, hoverIntensity0 = 0, hoverCenterX0 = 0, hoverCenterY0 = 0;
  let hoverRegion1 = -1, hoverIntensity1 = 0, hoverCenterX1 = 0, hoverCenterY1 = 0;
  let hoverFreezeTime0 = -1, hoverFreezeTime1 = -1;  // -1 = live, >=0 = frozen simTime

  // ── Sim pass state (transform feedback) ──
  let simBufA     = null;   // ping-pong buffer A (vec2 per particle)
  let simBufB     = null;   // ping-pong buffer B (vec2 per particle)
  let vaoSimA     = null;   // reads from simBufA, writes to simBufB
  let vaoSimB     = null;   // reads from simBufB, writes to simBufA
  let simSrc      = 0;      // 0 = A has current data, 1 = B has current data
  let simSpringK  = 4.0;    // spring constant for return-to-home (tunable via _pulseSpringK)

  // ── GPU timer query (EXT_disjoint_timer_query_webgl2) ──
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let pendingQuery = null;  // one in-flight query at a time

  // Per-region easing
  const regionTarget  = new Float32Array(NUM_REGIONS);
  const regionCurrent = new Float32Array(NUM_REGIONS);
  const EASE_SPEED = 0.08;

  // Per-region color activation uniforms (regions 1-5 → indices 0-4)
  const regionActiveArr  = new Float32Array(5);   // smoothed intensity
  const regionClickUV    = new Float32Array(10);   // vec2 × 5 (x,y pairs)
  const regionRadiusArr  = new Float32Array(5);    // radial expansion

  // Per-star glow backing arrays (12 stars)
  const starCenterUV     = new Float32Array(24);    // vec2 × 12 (canvas UV positions)
  const starCurrentRadii = new Float32Array(12);    // per-star modulated radius
  const starInnerRadii   = new Float32Array(12);    // per-star boundary radius (corona starts here)
  const starGlowIntensity = new Float32Array(12);  // per-star glow intensity
  let starGlowActive = 0;  // 1.0 when any star is glowing
  let starDebugDots      = 0;
  let starScintillation  = 0;   // chorus-driven twinkle (0-1)
  let starHaloSoftness   = 0;   // reverb-driven edge softness (0-1)

  // Multi-vortex state
  const MAX_VORTICES = 12;
  let vortices = [];        // { id, centerTarget:[x,y], centerCurrent:[x,y], sign:-1|+1, strength:0-2 }
  const vortexById = new Map(); // O(1) lookup by id — kept in sync at push/splice/clear
  // Pre-allocated reuse object for getVortexPosition() — avoids ~25 {x,y} allocs per frame
  const _posOut = { x: 0, y: 0 };
  // Pre-allocated DTO array for getVortices() — avoids 13+ object allocs per frame (fix #2)
  const _vortexDTOs = Array.from({ length: MAX_VORTICES }, () => ({
    id: 0, x: 0, y: 0, sign: 1, strength: 0, gravity: 0, speed: 0,
    armTightness: 0, armCurl: 0, curlAmount: 0, trail: 0,
  }));
  let nextVortexId = 0;
  const vortexDataFlat = new Float32Array(MAX_VORTICES * 4);    // GPU upload: xy=center, z=sign, w=strength
  const vortexParamsFlat = new Float32Array(MAX_VORTICES * 4);  // GPU upload: x=radius, y=speed, z=birthTime, w=armTightness
  const vortexArtFlat = new Float32Array(MAX_VORTICES * 4);     // GPU upload: x=armCurl, y=fadeDuration, z=curlAmount, w=reserved
  const vortexCursorSpeedMult = new Float32Array(MAX_VORTICES); // per-vortex cursor angular velocity boost (eased)
  const vortexCursorPhaseOffset = new Float32Array(MAX_VORTICES); // accumulated rotation offset (radians)

  const CENTER_EASE  = 0.10;
  const GRAVITY_EASE = 0.008;
  const GRAVITY_CREEP = 0.0005; // 0.05% per second — subtle proportional growth
  const GRAVITY_CAP   = 0.005;  // hard cap (matches setVortexGravity clamp)
  const FADE_MIN      = 0.75;   // seconds — floor for tiniest vortices
  const FADE_MAX      = 6.0;    // seconds — ceiling for largest vortex

  let debugMode     = 0;     // 0 = normal, 4 = flow field, 5 = region map, 6 = flow speed, 7 = scintillation
  let flowSpeed       = 0.05;  // flow field advection speed (home-space units/sec)
  let flowActive      = false; // true when UP key held — gates flow advection
  let flowSpeedEased  = 0.0;   // smoothly eased toward target (0 or flowSpeed)
  const FLOW_EASE_IN  = 0.04;  // ease-in rate  (lower = slower ramp-up, Apple-smooth)
  const FLOW_EASE_OUT = 0.12;  // ease-out rate — matches regionActive smoothRate so flow dies in sync with color
  let flowMixEased    = 0.0;   // activation gate (0-1), eased independently of speed
  const FLOW_MIX_EASE_IN  = 0.12; // fast ramp-in for responsive click feel
  const FLOW_MIX_EASE_OUT = 0.12;  // matches regionActive smoothRate — flow gate dies in sync with color/dance

  let flowDriftFrac   = 0.90;  // fraction of cycle spent drifting (vs dead)
  let flowCyclePeriod = 1.0;   // total cycle length in seconds
  let flowThreshold   = 0.25;  // minimum coherence/strength to participate in flow
  let flowMaxDrift    = 0.020; // max UV displacement from home (~20px at 1000px canvas)
  let flowCursorUV    = [0.5, 0.5]; // cursor position in UV space
  let flowCursorDir   = [1.0, 0.0]; // smoothed cursor direction (normalized)
  let flowCursorInfluence = 0.0;    // eased influence (decays when mouse stops)
  let flowCursorRadius = 0.08;      // influence radius in UV space

  // Star cursor bump state
  let starCursorUV = [0.5, 0.5];
  let starCursorInfluence = 0;
  let starBumpStrength = 0.40;
  let starPushRadius = 0.60;
  let starTrailPersist = 0.90;  // cursor trail FBO persistence
  let flowEdgeDepth   = 45.0;  // pixels inward from region-4 edge to reach full drift
  let flowSpeedFloor  = 0.10;  // minimum coherence-driven speed (0=full range, 1=no variation)
  let gustAmplitude   = 0.75;  // gust intensity ±75% (0 = off, 1.0 = ±100%)
  const gustPeriod    = 10.0;  // gust cycle time in seconds
  let skyGustAmplitude = 1.0;
  let skyMaxDrift = 0.016;
  let skyGustTrailPersist = 0.92;
  let skySwayAmount = 0.35;
  let skyStarShimmer = 0.05;
  // Night Sky cursor wake state
  const NS_WAKE_TRAIL_SIZE = 20;
  const nsWakeTrailData = new Float32Array(NS_WAKE_TRAIL_SIZE * 4);
  let nsWakeCursorUV = [0.5, 0.5];
  let nsWakeCursorInfluence = 0;
  let nsWakeRadius = 0.06;   // ~5x cursor size in UV (set by ui.js each frame)
  let nsWakeDecay = 3.0;     // trail decay time in seconds
  let nsWakeGustBoost = 0.5; // gust displacement boost fraction (0-1)
  let nsWakePushStrength = 0.006; // radial push displacement in UV
  let nsWakePushInfluence = 0;    // speed-damped push influence for FBO drain
  let flowTwinkle = 0.0;
  let cypressSwayAmp  = 1.5;
  let cypressMaxDrift = 0.008;
  let cypressSwayMix  = 0.0;   // eased activation gate (0→1), independent of regionActive
  let cypressTopY     = 0.25;  // UV Y of treetop (tunable)
  let cypressBaseY    = 1.0;   // UV Y of tree base (tunable)
  let cypressBaseRatio = 0.15; // fraction of sway at base (0=still)
  let cypressCrossSway = 0.6; // cross-sway fraction (0=horizontal only, 1=full vertical)
  let cypressBreathPeriod = 8.0;  // breathing cycle length in seconds
  let cypressSwayAngle = 0.5;    // per-particle angle spread (0=horizontal, 1=±90°)
  let cypressTrailPersist = 0.85; // trail persistence per frame (0=no trail, 0.95=max)
  let swirlTrailPersist = 0;      // swirl/flow trail persistence (0=off, 0.95=max)
  let cypressEdgeDepth = 8.0;   // edge constraint zone width in pixels
  let villageWindAmp   = 0.001;
  let villageWindFreq  = 60.0;
  let villageWindSpeed = 0.6;
  let villageWindAngle = 0.0;    // wind direction in radians (0 = rightward)
  let villageSwayAngle = 0.5;    // per-particle angle scatter (0=uniform, 1=±180°)
  let villageEdgeDepth = 20.0;   // edge fade zone width in pixels
  let villageLumParallax = 1.0;  // luminance parallax strength (0=off, 1=full)
  let villageTwinkle = 0.0;       // warm twinkle intensity (0=off, 1=full)
  let villageTwinkleWarmth = 0.05; // color warmth threshold (r-b difference)
  let villageBreathPhase = 0.0;   // accumulated breathing phase (radians)
  let villageBreathDepth = 0.5;  // breathing depth (0=off, 1=full)
  let villageNoiseAmp   = 0.5;   // wind noise intensity multiplier
  let villageNoiseDrift = 0.001; // wind noise max displacement in UV
  let villageCrossSway  = 0.1;   // cross-wind sway fraction
  let villageTrailPersist = 0.95; // trail persistence per frame (0=none, 0.95=max)
  let villageAttraction = 0;      // attraction strength (0-1)
  let villageAttractionAmp = 0.005; // max stretch distance in UV
  let villageWindCenterX = 0.5;   // cursor UV X
  let villageWindCenterY = 0.5;   // cursor UV Y
  let villageWindRadius = 0.15;   // influence radius in UV space (idle — also used for wind blend)
  let villageWindRadiusActive = 0.15; // blended radius (tight when moving, wide when idle)
  let villageCursorMoving = 0;       // smoothed 0-1: cursor idle vs moving
  let villageAttractionAmpActive = 0.005; // blended strength (boosted when moving)
  let villageWindBlendVal = 0;     // JS-computed wind blend for render shader
  let villageExitPointX = 0.6;  // cursor UV when it last left village
  let villageExitPointY = 0.7;
  let villageWindRippleRadius = 0.15; // expanding participation radius
  let swarmDriftFracSmoothed = 0.50; // JS-smoothed drift fraction
  let villageSwarmTime = 0;       // accumulated swarm time (frozen when attraction=0)
  let swarmCyclePeriodMin = 8.0;
  let swarmCyclePeriodMax = 13.0;
  let swarmDriftFrac = 0.50;
  let swarmEarlyDeathPct = 0.30;
  let swarmDeathFadeWidth = 0.50;
  let swarmMaxDriftMul = 7.0;
  let swarmFadeIn = 0.25;
  let swarmFadeOutStart = 0.80;
  let swarmFixedPeriod = 0;  // 0 = variable (default), >0 = all particles same period
  let swarmPhaseSpread = 1.0;  // 0 = synced wave, 1 = fully random (only used with fixed period / LFO sync)
  let swarmLfoSync = 0;  // 0 = off, 1 = lifecycle synced to audio LFO
  let villageClickOriginX = 0.6;  // UV where click started
  let villageClickOriginY = 0.7;
  let villageTopY = 0.55;         // UV Y of village top (manual — horizon line)
  let villageBottomY = 0.95;      // UV Y of village bottom (manual — near canvas bottom)
  let villageBaseTrailRatio = 0.842; // trail persistence at bottom → 0.80 final (0.95 × 0.842)
  let cypressRimWidth = 20.0;   // rim glow zone width in pixels (wider than edge constraint)
  let cypressFlowCyclePeriod = 1.0;  // lifecycle period in seconds
  let cypressFlowDriftFrac = 0.90;   // visible fraction of lifecycle
  let cypressFlowMaxDrift = 0.015;   // max UV displacement along flow direction
  let cypressFlowGustAmp = 0.50;     // gust intensity (0-1)
  let cypressCanopyGlow = 0.25;     // canopy luminance breathing intensity (0=off, 1=full)
  let cypressLeafFlash = 0.2;       // leaf flash intensity (0=off, 1=full)
  let cypressRimGlow = 0.3;         // rim glow intensity (0=off, 1=full)
  let cypressWindBias = 0;          // horizontal wind direction bias [-1, 1] from mouse drag velocity
  const CYPRESS_SWAY_EASE_IN  = 0.08;  // moderate ramp-in (~0.8s to 90%)
  const CYPRESS_SWAY_EASE_OUT = 0.03;  // slow ramp-out (~2s to 10%) — no snap-back
  let eddyContrast    = 0.25;  // Kolmogorov eddy contrast (0 = disabled, 1 = max)
  let eddyMin = 1.0 - eddyContrast * 0.8;   // derived: updated at top of passRender
  let eddyMax = 1.0 + eddyContrast * 1.2;   // derived: updated at top of passRender
  let canvasDeformAmp = 0.020; // living canvas UV displacement (0 = off)
  let swell         = 0.25;  // point size boost near vortex center
  let wobbleAmt     = 0.25;  // time-varying wobble intensity (0 = static, 1 = full breathing)
  let curlAmount    = 0.0005; // curl noise turbulence strength
  let trembleAmt    = 0.0020; // boundary tremble strength (0 = off)
  let trembleFreq   = 5.0;    // boundary tremble frequency (time speed)
  let armTightness  = 1.0;   // 0 = no compression, 1 = razor-thin arms
  let armCurl       = 3.0;   // number of full turns (revolutions) edge→center
  let lumPreserve   = 0.5;   // 0 = hyper-saturated, 1 = painting's true luminance
  let baseAlpha     = 1.0;   // global particle opacity (0 = invisible, 1 = full)
  let introModeActive = true;   // true = only flashlight reveals particles, false = normal
  let introModeFading = false;  // true = vignette fading out after reveal
  let introModeValue = 1.0;    // 1.0 = full intro, eases to 0.0
  let introFadeStart = 0;      // performance.now() when fade began
  const INTRO_FADE_DURATION = 700; // ms — ease-out for gentle landing
  let introGlow = 0.0;          // fixed center glow intensity (0-1)
  let introGlowRadius = 300;    // center glow radius in canvas pixels
  let introDanceScale = 0.00025; // intro global dance (0.50 × 0.0005)
  let introDanceEased = 0.00025; // eased value sent to GPU (fades out after intro)
  let revealActive    = false;  // true = expanding circle reveal in progress
  let revealRadius    = 0;      // current reveal circle radius in canvas pixels
  let revealMaxRadius = 0;      // distance from click to farthest canvas corner
  let revealCenterX   = 0;      // click origin X in canvas pixels (gl_FragCoord space)
  let revealCenterY   = 0;      // click origin Y in canvas pixels (gl_FragCoord space)
  let revealSpeed     = 0;          // pixels per second (set at reveal start)
  let revealBrightness = 0.4;       // eases 0.4 → 1.0 during reveal
  let revealStartGlowRadius = 0;    // glow radius at start of reveal
  let revealElapsed = 0;            // seconds since reveal started
  let revealBrightDuration = 2.5;   // brightness takes longer than radius to ease
  let revealCallback  = null;   // called when reveal completes
  let colorAdvect   = 0.5;   // color advection rate (0 = static, 0.5 = variety, 1 = full follow)
  let trailScale    = 0.5;   // trail length multiplier (0 = no trails)
  let vortexTrailGlobal = 0.0; // global vortex trail intensity (0 = no trails, 1 = max)
  let trailLinesAlpha = 1.00;  // trail multiplier (scales vortex ring persistence)
  let starTrailsActive = false; // T key toggle: long-exposure star trail mode
  let regionBorderThickness = 0.04; // bleed zone for region boundaries (canvas-normalized)
  let canvasColor = [0.043, 0.043, 0.051]; // matches page bg #0b0b0d
  let bgTonalStrength = 0.0; // tonal background brightness (0–1.0), eased in during reveal
  let bgTonalTarget   = 0.10; // ease-in ceiling (raised by mood switch for bright paintings)
  let additiveBlend = true;   // additive blending for particle draw pass
  let _isRadiantActive = false; // mood flag — enables per-region Radiant multipliers at uniform upload
  let vignetteStrength = 0.1; // vignette darkening at corners (0 = off, 0.1 = 90% brightness)
  let borderWidth = 4.0;     // painting border width in pixels (0 = off)
  let borderRadius = 8.0;   // corner radius in pixels (0 = sharp)
  let borderColor = [0.24, 0.22, 0.20]; // warm dark border color
  let paintingMargin = 22.5;             // 10 + spread(0.5) * 25 = 22.5
  let shadowEnabled = true;
  let shadowOpacity = 0;
  let shadowOffset  = [0.0, -3.0];
  let shadowColor   = [0.0, 0.0, 0.0];
  let shadowSpread  = 0.5;

  gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // ────────────────────────────────────────────────────────────────────────
  // loadPoints
  // ────────────────────────────────────────────────────────────────────────
  function loadPoints(pointData, { resetIntro = true } = {}) {
    // Set attribute locations directly from explicit layout(location=N) if full
    // shader not yet finalized. Can't resolve from miniRenderProg because it
    // optimizes away unused attributes (simPos, coherence, flowAngle)
    // causing getAttribLocation to return -1 and VAO to skip binding them.
    if (!_renderFinalized) {
      // Hardcode attribute locations from explicit layout(location=N).
      // Can't query miniRenderProg — it optimizes away unused attributes.
      aRenderHome = 0;
      aRenderSpiral = 1;
      aRenderColor = 2;
      aRenderRegion = 3;
      aRenderBoundaryDist = 4;
      aRenderSimPos = 5;
      aRenderCoherence = 7;
      aRenderFlowAngle = 8;
      _activeRenderProg = miniRenderProg;
    }
    const _lpt0 = performance.now();
    pointCount = pointData.count;
    // Reset particle draw fraction whenever new points are loaded. Callers
    // that want fractional drawing (prebake initial load, G22 downgrade) call
    // setParticleFraction AFTER loadPoints. Resize and mood-swap re-extracts
    // produce buffers that are already correctly sized for the new canvas, so
    // they should draw at full fraction.
    _particleDrawFraction = 1.0;
    hasRegionData = pointData.regions != null;
    const hasBoundaryData = pointData.boundaryDists != null;
    const hasFlowData = pointData.coherences != null;

    // Separate per-attribute arrays from extract — no de-stride needed.
    // When regions are absent (stride-5 degraded path), allocate a zeroed array.
    const homePos = pointData.homePos;
    const colors  = pointData.colors;
    const regions = pointData.regions || new Float32Array(pointCount);
    const boundaryDists = pointData.boundaryDists || null;
    const coherences = pointData.coherences || null;
    const flowAngles = pointData.flowAngles || null;

    // ── G2a: Sort particles by region for SIMD branch coherence ──
    // Counting sort (O(n), 6 buckets). All arrays reordered in parallel so
    // per-particle data stays paired. Sorted order means particles in the
    // same region are contiguous → GPU SIMD lanes take the same branches.
    // G21 (Morton sort within regions) was attempted and reverted — caused
    // FPS regression on Intel Iris Plus 645 (disrupted vertex fetch streaming).
    {
      const NUM_REGIONS = 6;  // regions 0-5
      // Count particles per region
      const counts = new Uint32Array(NUM_REGIONS);
      for (let i = 0; i < pointCount; i++) {
        const r = Math.min(Math.round(regions[i]), NUM_REGIONS - 1);
        counts[r]++;
      }
      // Compute prefix sums (start offsets)
      const offsets = new Uint32Array(NUM_REGIONS);
      for (let r = 1; r < NUM_REGIONS; r++) {
        offsets[r] = offsets[r - 1] + counts[r - 1];
      }
      // Store region start/count
      regionOffsets = new Uint32Array(NUM_REGIONS);
      regionCounts = new Uint32Array(NUM_REGIONS);
      for (let r = 0; r < NUM_REGIONS; r++) {
        regionOffsets[r] = offsets[r];
        regionCounts[r] = counts[r];
      }
      // Build permutation index
      const writeIdx = new Uint32Array(NUM_REGIONS);
      writeIdx.set(offsets);
      const perm = new Uint32Array(pointCount);
      for (let i = 0; i < pointCount; i++) {
        const r = Math.min(Math.round(regions[i]), NUM_REGIONS - 1);
        perm[writeIdx[r]++] = i;
      }
      // Apply permutation to all arrays
      const sortedHomePos = new Float32Array(pointCount * 2);
      const sortedColors  = new Float32Array(pointCount * 3);
      const sortedRegions = new Float32Array(pointCount);
      const sortedBoundary = boundaryDists ? new Float32Array(pointCount) : null;
      const sortedCoherence = coherences ? new Float32Array(pointCount) : null;
      const sortedFlowAngle = flowAngles ? new Float32Array(pointCount) : null;
      for (let dst = 0; dst < pointCount; dst++) {
        const src = perm[dst];
        sortedHomePos[dst * 2]     = homePos[src * 2];
        sortedHomePos[dst * 2 + 1] = homePos[src * 2 + 1];
        sortedColors[dst * 3]      = colors[src * 3];
        sortedColors[dst * 3 + 1]  = colors[src * 3 + 1];
        sortedColors[dst * 3 + 2]  = colors[src * 3 + 2];
        sortedRegions[dst]         = regions[src];
        if (sortedBoundary)  sortedBoundary[dst]  = boundaryDists[src];
        if (sortedCoherence) sortedCoherence[dst] = coherences[src];
        if (sortedFlowAngle) sortedFlowAngle[dst] = flowAngles[src];
      }
      // Replace originals with sorted versions
      homePos.set(sortedHomePos);
      colors.set(sortedColors);
      regions.set(sortedRegions);
      if (boundaryDists) boundaryDists.set(sortedBoundary);
      if (coherences)    coherences.set(sortedCoherence);
      if (flowAngles)    flowAngles.set(sortedFlowAngle);

      // ── Within-region shuffle for adaptive particle fraction ──
      // The G2a sort grouped particles by region for SIMD coherence, but
      // particles within each region are still in raster-scan order. Drawing
      // the first N particles via setParticleFraction would give "first rows
      // of each region" — biased, not uniform. Fisher-Yates within each
      // region's range (deterministic seed → same shuffle every load → stable
      // visual output). Region order preserved → SIMD coherence intact.
      let _shuffleSeed = 0xa28cf2b1 | 0;
      const _shuffleRand = () => {
        _shuffleSeed = (_shuffleSeed + 0x6d2b79f5) | 0;
        let t = Math.imul(_shuffleSeed ^ (_shuffleSeed >>> 15), 1 | _shuffleSeed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (let r = 0; r < NUM_REGIONS; r++) {
        const rStart = regionOffsets[r];
        const rCount = regionCounts[r];
        for (let i = rCount - 1; i > 0; i--) {
          const j = (_shuffleRand() * (i + 1)) | 0;
          if (j === i) continue;
          const a = rStart + i;
          const b = rStart + j;
          let tmp;
          tmp = homePos[a*2];     homePos[a*2]     = homePos[b*2];     homePos[b*2]     = tmp;
          tmp = homePos[a*2+1];   homePos[a*2+1]   = homePos[b*2+1];   homePos[b*2+1]   = tmp;
          tmp = colors[a*3];      colors[a*3]      = colors[b*3];      colors[b*3]      = tmp;
          tmp = colors[a*3+1];    colors[a*3+1]    = colors[b*3+1];    colors[b*3+1]    = tmp;
          tmp = colors[a*3+2];    colors[a*3+2]    = colors[b*3+2];    colors[b*3+2]    = tmp;
          tmp = regions[a];       regions[a]       = regions[b];       regions[b]       = tmp;
          if (boundaryDists) { tmp = boundaryDists[a]; boundaryDists[a] = boundaryDists[b]; boundaryDists[b] = tmp; }
          if (coherences)    { tmp = coherences[a];    coherences[a]    = coherences[b];    coherences[b]    = tmp; }
          if (flowAngles)    { tmp = flowAngles[a];    flowAngles[a]    = flowAngles[b];    flowAngles[b]    = tmp; }
        }
      }
    }

    const _lpt1 = performance.now(); // after deStride + sort

    // Keep CPU copies for star glow, region queries, and diagnostics
    homePosData  = homePos;
    regionIdData = regions;
    coherenceData = coherences;  // retained for speed scintillation debug

    // Compute phyllotaxis spiral target positions + normalized distances
    const spiralStart = performance.now();
    const aspectRatio = canvas.width / canvas.height || 1;
    const spiral = computeSpiralPositions(homePos, pointCount, 0.5, 0.5, aspectRatio);
    const spiralElapsed = performance.now() - spiralStart;

    const _lpt2 = performance.now(); // after spiral

    // Delete old GPU resources
    if (homePosBuffer)       gl.deleteBuffer(homePosBuffer);
    if (spiralPosBuffer)     gl.deleteBuffer(spiralPosBuffer);
    if (colorBuffer)         gl.deleteBuffer(colorBuffer);
    if (regionIdBuffer)      gl.deleteBuffer(regionIdBuffer);
    if (boundaryDistBuffer)  gl.deleteBuffer(boundaryDistBuffer);
    if (coherenceBuffer)     gl.deleteBuffer(coherenceBuffer);
    if (flowAngleBuffer)     gl.deleteBuffer(flowAngleBuffer);
    coherenceBuffer = null;
    flowAngleBuffer = null;
    if (vaoRender)           gl.deleteVertexArray(vaoRender);

    // ── Upload static buffers (separate VBOs) ──
    homePosBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, homePosBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, homePos, gl.STATIC_DRAW);

    spiralPosBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, spiralPosBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, spiral.positions, gl.STATIC_DRAW);

    colorBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    regionIdBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, regionIdBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, regions, gl.STATIC_DRAW);

    if (hasBoundaryData) {
      boundaryDistBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, boundaryDistBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, boundaryDists, gl.STATIC_DRAW);
    } else {
      boundaryDistBuffer = null;
    }

    if (hasFlowData) {
      coherenceBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, coherenceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, coherences, gl.STATIC_DRAW);

      flowAngleBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, flowAngleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, flowAngles, gl.STATIC_DRAW);
    }

    // ── Sim pass buffers (transform feedback ping-pong) ──
    // ── Sim pass buffers (transform feedback ping-pong) ──
    // Both buffers start at home position. Intro scatter is handled
    // purely in the render shader via u_introScatter uniform.
    if (simBufA) gl.deleteBuffer(simBufA);
    if (simBufB) gl.deleteBuffer(simBufB);
    if (vaoSimA) gl.deleteVertexArray(vaoSimA);
    if (vaoSimB) gl.deleteVertexArray(vaoSimB);

    simBufA = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, simBufA);
    gl.bufferData(gl.ARRAY_BUFFER, homePos, gl.DYNAMIC_COPY);

    simBufB = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, simBufB);
    gl.bufferData(gl.ARRAY_BUFFER, homePos, gl.DYNAMIC_COPY);

    // Intro mode: full alpha + full color, but only flashlight reveals particles
    // Skip on re-dither resize to avoid re-triggering intro animation.
    if (resetIntro) {
      introModeActive = true;
      baseAlpha = 1.0;
    }

    simSrc = 0;  // A has current data initially
    // ── Sim VAO A: reads from simBufA (current=A), writes to simBufB ──
    vaoSimA = gl.createVertexArray();
    gl.bindVertexArray(vaoSimA);
    if (asCurrentPos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, simBufA);
      gl.enableVertexAttribArray(asCurrentPos);
      gl.vertexAttribPointer(asCurrentPos, 2, gl.FLOAT, false, 0, 0);
    }
    if (asHomePos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, homePosBuffer);
      gl.enableVertexAttribArray(asHomePos);
      gl.vertexAttribPointer(asHomePos, 2, gl.FLOAT, false, 0, 0);
    }
    if (asSpiralPos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, spiralPosBuffer);
      gl.enableVertexAttribArray(asSpiralPos);
      gl.vertexAttribPointer(asSpiralPos, 2, gl.FLOAT, false, 0, 0);
    }
    if (asRegionId >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, regionIdBuffer);
      gl.enableVertexAttribArray(asRegionId);
      gl.vertexAttribPointer(asRegionId, 1, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);

    // ── Sim VAO B: reads from simBufB (current=B), writes to simBufA ──
    vaoSimB = gl.createVertexArray();
    gl.bindVertexArray(vaoSimB);
    if (asCurrentPos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, simBufB);
      gl.enableVertexAttribArray(asCurrentPos);
      gl.vertexAttribPointer(asCurrentPos, 2, gl.FLOAT, false, 0, 0);
    }
    if (asHomePos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, homePosBuffer);
      gl.enableVertexAttribArray(asHomePos);
      gl.vertexAttribPointer(asHomePos, 2, gl.FLOAT, false, 0, 0);
    }
    if (asSpiralPos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, spiralPosBuffer);
      gl.enableVertexAttribArray(asSpiralPos);
      gl.vertexAttribPointer(asSpiralPos, 2, gl.FLOAT, false, 0, 0);
    }
    if (asRegionId >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, regionIdBuffer);
      gl.enableVertexAttribArray(asRegionId);
      gl.vertexAttribPointer(asRegionId, 1, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);

    // ── Render VAO — separate buffer per attribute ──
    vaoRender = gl.createVertexArray();
    gl.bindVertexArray(vaoRender);

    gl.bindBuffer(gl.ARRAY_BUFFER, homePosBuffer);
    gl.enableVertexAttribArray(aRenderHome);
    gl.vertexAttribPointer(aRenderHome, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, spiralPosBuffer);
    gl.enableVertexAttribArray(aRenderSpiral);
    gl.vertexAttribPointer(aRenderSpiral, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(aRenderColor);
    gl.vertexAttribPointer(aRenderColor, 3, gl.FLOAT, false, 0, 0);

    if (hasRegionData && aRenderRegion >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, regionIdBuffer);
      gl.enableVertexAttribArray(aRenderRegion);
      gl.vertexAttribPointer(aRenderRegion, 1, gl.FLOAT, false, 0, 0);
    } else if (aRenderRegion >= 0) {
      gl.disableVertexAttribArray(aRenderRegion);
      gl.vertexAttrib1f(aRenderRegion, 0.0);
    }

    if (hasBoundaryData && aRenderBoundaryDist >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, boundaryDistBuffer);
      gl.enableVertexAttribArray(aRenderBoundaryDist);
      gl.vertexAttribPointer(aRenderBoundaryDist, 1, gl.FLOAT, false, 0, 0);
    } else if (aRenderBoundaryDist >= 0) {
      gl.disableVertexAttribArray(aRenderBoundaryDist);
      gl.vertexAttrib1f(aRenderBoundaryDist, 1.0);
    }

    if (hasFlowData && coherenceBuffer && aRenderCoherence >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, coherenceBuffer);
      gl.enableVertexAttribArray(aRenderCoherence);
      gl.vertexAttribPointer(aRenderCoherence, 1, gl.FLOAT, false, 0, 0);
    } else if (aRenderCoherence >= 0) {
      gl.disableVertexAttribArray(aRenderCoherence);
      gl.vertexAttrib1f(aRenderCoherence, 0.0);
    }

    if (hasFlowData && flowAngleBuffer && aRenderFlowAngle >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, flowAngleBuffer);
      gl.enableVertexAttribArray(aRenderFlowAngle);
      gl.vertexAttribPointer(aRenderFlowAngle, 1, gl.FLOAT, false, 0, 0);
    } else if (aRenderFlowAngle >= 0) {
      gl.disableVertexAttribArray(aRenderFlowAngle);
      gl.vertexAttrib1f(aRenderFlowAngle, 0.0);
    }

    // Sim-advected position — separate buffer (rebound each frame)
    if (aRenderSimPos >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, simBufA);
      gl.enableVertexAttribArray(aRenderSimPos);
      gl.vertexAttribPointer(aRenderSimPos, 2, gl.FLOAT, false, 0, 0);
    }

    gl.bindVertexArray(null);

    // Reset simTime only on fresh load (intro animation start). Skipping this
    // on re-dither paths (mood swap, resize) keeps simTime continuous. Without
    // this guard, every M-swap jumped simTime back to 0 while each vortex's
    // birthTime (set at activation from the previous simTime) stayed at its
    // old value, making shader `vortexAge = u_time - birthTime_i` go briefly
    // negative. That forced `armYouth` to max, ran `timeRotation` backward,
    // and showed the star vortex as a compressed/warped static corona until
    // simTime caught up to birthTime — visible as "wobble that settles."
    if (resetIntro) simTime = 0;

    // ── G14: Shader warmup draw ──
    // Metal's deferred compilation costs ~100-300ms on Apple devices when
    // a shader program is first used in a real draw call. Fire a 1-point
    // throwaway draw during loading (before the intro is visible) so the
    // stutter happens behind the loading screen, not on the first interaction.
    // Skip if full shader not finalized (Firefox deferred path — warmup
    // happens at finalization time in showGLCanvas instead).
    if (_renderFinalized) {
      const t0 = performance.now();
      gl.useProgram(renderProg);
      gl.bindVertexArray(vaoRender);
      gl.viewport(0, 0, 1, 1);
      gl.colorMask(false, false, false, false);  // don't write pixels
      gl.drawArrays(gl.POINTS, 0, 1);
      gl.colorMask(true, true, true, true);
      gl.bindVertexArray(null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const warmupMs = performance.now() - t0;
      if (warmupMs > 50) {
        _log(
          `%c[Warmup]%c  Render shader warmup: ${warmupMs.toFixed(0)}ms (Metal deferred compilation)`,
          'color: #f80; font-weight: bold', 'color: #999'
        );
      }
    }

    const _lpt3 = performance.now(); // after GPU upload + VAO + warmup
    _log(
      `%c[loadPoints]%c  Sort+Shuffle: ${(_lpt1 - _lpt0).toFixed(0)}ms | Spiral: ${(_lpt2 - _lpt1).toFixed(0)}ms | GPU upload+VAO+warmup: ${(_lpt3 - _lpt2).toFixed(0)}ms | Total: ${(_lpt3 - _lpt0).toFixed(0)}ms`,
      'color: #0f0; font-weight: bold', 'color: #999'
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────

  function easeState(dt, dtSec) {
    // ── Ease each vortex center + per-vortex gravity ──
    const ct = 1 - Math.pow(1 - CENTER_EASE, dt);
    for (const v of vortices) {
      const dx = v.centerTarget[0] - v.centerCurrent[0];
      const dy = v.centerTarget[1] - v.centerCurrent[1];
      if (Math.abs(dx) > 0.0001 || Math.abs(dy) > 0.0001) {
        v.centerCurrent[0] += dx * ct;
        v.centerCurrent[1] += dy * ct;
      } else {
        v.centerCurrent[0] = v.centerTarget[0];
        v.centerCurrent[1] = v.centerTarget[1];
      }
      // Ease per-vortex gravity (speed scaled to vortex size)
      const gt = 1 - Math.pow(1 - v.gravityEase, dt);
      const gd = v.gravity - v.gravityCurrent;
      if (v.isRemoving) {
        const removalAge = simTime - v.removalTime;
        const releaseFrac = Math.min(removalAge / v.releaseDuration, 1.0);
        // Ease-out quadratic — fast initial response, gentle tail
        const t = 1 - (1 - releaseFrac) * (1 - releaseFrac);

        // Strength fades to zero
        v.strength = v.strengthAtRemoval * (1 - t);

        // Speed winds down — spiral slows like a music box
        v.speed = v.speedAtRemoval * (1 - t);

        // Arms soften gradually
        v.armTightness += (0.0 - v.armTightness) * gt;
        v.armCurl += (0.0 - v.armCurl) * gt;

        // Gravity follows the same t curve — radius converges to a point
        // at exactly the same moment strength reaches zero
        v.gravityCurrent = v.gravityAtRemoval * (1 - t);

        // Prune once the release curve completes
        if (releaseFrac >= 1.0) {
          v.removalScale = 0;
          v.gravityCurrent = 0;
        }
      } else {
        // Normal fade in
        if (Math.abs(gd) > v.gravity * 0.001) {
          v.gravityCurrent += gd * gt;
        } else {
          v.gravityCurrent = v.gravity;
        }
        // Slow gravity creep — proportional so larger vortices grow faster
        if (v.gravity > 0 && v.gravity < GRAVITY_CAP) {
          v.gravity = Math.min(v.gravity + v.gravity * GRAVITY_CREEP * dtSec, GRAVITY_CAP);
        }
        // Ease arm tightness and curl from dramatic start toward target
        v.armTightness += (v.armTightnessTarget - v.armTightness) * gt;
        v.armCurl += (v.armCurlTarget - v.armCurl) * gt;
      }
    }
    // Prune fully faded-out vortices
    for (let i = vortices.length - 1; i >= 0; i--) {
      if (vortices[i].isRemoving && vortices[i].removalScale <= 0) {
        vortexById.delete(vortices[i].id);
        vortices.splice(i, 1);
      }
    }

    // Region easing
    for (let i = 0; i < NUM_REGIONS; i++) {
      const diff = regionTarget[i] - regionCurrent[i];
      if (Math.abs(diff) > 0.001) {
        regionCurrent[i] += diff * (1 - Math.pow(1 - EASE_SPEED, dt));
      } else {
        regionCurrent[i] = regionTarget[i];
      }
    }

    // Flow mix easing — activation gate (0→1), decoupled from speed changes.
    // Prevents snap-back when audio-driven flowSpeed jumps mid-easing.
    const flowMixTarget = flowActive ? 1.0 : 0.0;
    const mixDiff = flowMixTarget - flowMixEased;
    if (Math.abs(mixDiff) > 0.0001) {
      const mixRate = mixDiff > 0 ? FLOW_MIX_EASE_IN : FLOW_MIX_EASE_OUT;
      flowMixEased += mixDiff * (1 - Math.pow(1 - mixRate, dt));
    } else {
      flowMixEased = flowMixTarget;
    }

    // Cypress sway easing — own gate, decoupled from regionActive ramp speed.
    // Tracks regionActive[0] but eases independently (slow fade-out prevents snap-back).
    const cypressSwayTarget = regionActiveArr[0] > 0.1 ? 1.0 : 0.0;
    const cypressDiff = cypressSwayTarget - cypressSwayMix;
    if (Math.abs(cypressDiff) > 0.0001) {
      const cypressRate = cypressDiff > 0 ? CYPRESS_SWAY_EASE_IN : CYPRESS_SWAY_EASE_OUT;
      cypressSwayMix += cypressDiff * (1 - Math.pow(1 - cypressRate, dt));
    } else {
      cypressSwayMix = cypressSwayTarget;
    }

    // Flow speed easing — smooth ramp in/out
    const flowTarget = flowActive ? flowSpeed : 0.0;
    const flowDiff = flowTarget - flowSpeedEased;
    if (Math.abs(flowDiff) > 0.0001) {
      const rate = flowDiff > 0 ? FLOW_EASE_IN : FLOW_EASE_OUT;
      flowSpeedEased += flowDiff * (1 - Math.pow(1 - rate, dt));
    } else {
      flowSpeedEased = flowTarget;
    }

    // ── Vignette open reveal: expand glow radius + ease brightness ──
    if (revealActive) {
      revealElapsed += dtSec;
      // Recalculate max radius in case of window resize
      const diag = Math.sqrt(canvas.width ** 2 + canvas.height ** 2);
      revealMaxRadius = diag * 0.6 + 100;
      const progress = revealRadius / revealMaxRadius;
      const easedSpeed = revealSpeed * (1.0 - progress * 0.7); // ease-out
      revealRadius += easedSpeed * dtSec;
      // Expand the existing intro glow radius to match reveal progress
      introGlowRadius = revealStartGlowRadius + (revealMaxRadius - revealStartGlowRadius) * progress;
      // Brightness eases slower than radius — time-based, not progress-based
      const bt = Math.min(revealElapsed / revealBrightDuration, 1.0);
      const bp = bt * bt * (3.0 - 2.0 * bt); // smoothstep
      revealBrightness = 0.4 + bp * 0.6;
      // Tonal background stays OFF during reveal — it draws fullscreen and would
      // make the canvas rectangle visible against the CSS background
      bgTonalStrength = 0;
      if (revealRadius >= revealMaxRadius && bt >= 1.0) {
        revealBrightness = 1.0;
        revealActive = false;
        introModeFading = true; // start fading intro mode instead of snapping
        introFadeStart = performance.now();
        if (revealCallback) {
          revealCallback();
          revealCallback = null;
        }
      }
    }

    // ── Intro mode fade-out: vignette dissolves with ease-out (gentle landing) ──
    if (introModeFading) {
      const ft = Math.min((performance.now() - introFadeStart) / INTRO_FADE_DURATION, 1.0);
      // Ease-out: fast start, decelerating finish — (1 - t)² inverted
      introModeValue = (1.0 - ft) * (1.0 - ft);
      if (ft >= 1.0) {
        introModeValue = 0;
        introModeFading = false;
        introModeActive = false;
        introModeValue = 0;
      }
    }

    // ── Intro dance: active during intro, fast fade when vignette starts dissolving ──
    if (introModeActive && !introModeFading) {
      introDanceEased = introDanceScale;
    } else if (introDanceEased > 0.000001) {
      introDanceEased *= Math.exp(-12.0 * dtSec); // ~250ms to near-zero
    } else {
      introDanceEased = 0;
    }

    // ── Underpainting ease toward target: bidirectional, only after intro ends ──
    if (!introModeActive && bgTonalStrength !== bgTonalTarget) {
      const rate = 0.25; // ~0.8s ease at default 0→0.20 step
      if (bgTonalStrength < bgTonalTarget) {
        bgTonalStrength = Math.min(bgTonalStrength + dtSec * rate, bgTonalTarget);
      } else {
        bgTonalStrength = Math.max(bgTonalStrength - dtSec * rate, bgTonalTarget);
      }
    }

  }

  // ────────────────────────────────────────────────────────────────────────
  // runSimStep — transform feedback pulse drift integration
  //
  // Reads current positions from one ping-pong buffer, writes updated
  // positions to the other. RASTERIZER_DISCARD means no fragment shader
  // runs — this is a pure compute step.
  // ────────────────────────────────────────────────────────────────────────

  function runSimStep(dtSec) {
    if (!simBufA || !simBufB || pointCount === 0 || !simProg) return;

    // ── G7: Skip vestigial sim pass ──
    // The sim shader has no displacement forces (Biot-Savart moved to render,
    // flow advection visual-only). It only does spring-back toward home with
    // no opposing force, making a_simPos converge to a_homePos (vec2(0.0)
    // displacement). Skipping saves 1.26M vertex invocations + 1.26M boundary
    // texture fetches + TF session per frame. Sim buffers stay at homePos
    // (their init value). Render shader: pos += a_simPos - a_homePos = 0.
    // Console override: window._forceSimPass = true to re-enable for debugging.
    if (!(typeof window !== 'undefined' && window._forceSimPass)) return;

    // Allow console override: window._pulseSpringK = 6.0
    const springK = (typeof window !== 'undefined' && window._pulseSpringK != null)
      ? window._pulseSpringK : simSpringK;

    gl.useProgram(simProg);

    // Set sim uniforms
    gl.uniform1f(usDt, dtSec);
    gl.uniform1f(usTime, simTime);
    gl.uniform1f(usDriftSpeed, driftSpeed);
    gl.uniform2f(usCanvasSize, canvas.width, canvas.height);
    gl.uniform1f(usFlashRadius, flashRadius);
    gl.uniform1f(usSpringK, springK);
    gl.uniform1f(usDriftMaxCap, driftMaxCap);

    // Flow field texture + speed (smoothly eased)
    gl.uniform1f(usFlowSpeed, flowSpeedEased);
    gl.uniform1f(usFlowDriftFrac, flowDriftFrac);
    gl.uniform1f(usFlowCyclePeriod, flowCyclePeriod);
    gl.uniform1f(usFlowThreshold, flowThreshold);
    gl.uniform1f(usFlowMaxDrift, flowMaxDrift);
    if (flowFieldTex && flowSpeedEased > 0.0001) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, flowFieldTex);
      gl.uniform1i(usFlowFieldTex, 0);
    }

    // Region map texture for territory boundary enforcement (flow advection)
    if (regionMapTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, regionMapTex);
      gl.uniform1i(usRegionMapTex, 1);
    }

    // Boundary distance field for locked-region enforcement (all displacement)
    if (boundaryTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, boundaryTex);
      gl.uniform1i(usBoundaryTex, 2);
    }

    // Bind the correct sim VAO (reads from current source buffer)
    gl.bindVertexArray(simSrc === 0 ? vaoSimA : vaoSimB);

    // Bind output buffer for transform feedback capture
    const outputBuf = simSrc === 0 ? simBufB : simBufA;
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tfObj);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, outputBuf);

    // Run the sim pass (no fragments — pure vertex compute)
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, pointCount);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    // Unbind TF buffer from slot 0 BEFORE unbinding the TF object.
    // bindBufferBase sets both the indexed and generic binding points;
    // leaving it bound blocks the buffer from being used as ARRAY_BUFFER
    // in subsequent draws (trail lines, render pass) on some implementations.
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);

    // Flip: the output buffer becomes the new source for next frame + render
    simSrc = 1 - simSrc;
  }

  // ────────────────────────────────────────────────────────────────────────
  // drawParticles — stateless render with multi-vortex rotation
  // ────────────────────────────────────────────────────────────────────────

  function drawShadow() {
    if (!_otherProgramsFinalized) return;
    if (!shadowEnabled || shadowOpacity <= 0) return;
    gl.useProgram(shadowProg);
    gl.uniform2f(uShadowResolution, Math.round(canvas.width), Math.round(canvas.height));
    gl.uniform1f(uShadowBorderRadius, borderRadius);
    gl.uniform1f(uShadowMargin, paintingMargin);
    gl.uniform3f(uShadowCanvasColor, canvasColor[0], canvasColor[1], canvasColor[2]);
    gl.uniform3f(uShadowColor, shadowColor[0], shadowColor[1], shadowColor[2]);
    gl.uniform1f(uShadowOpacity, shadowOpacity);
    gl.uniform2f(uShadowOffset, shadowOffset[0], shadowOffset[1]);
    gl.bindVertexArray(vaoShadow);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function drawTonalBackground() {
    if (!_otherProgramsFinalized) return;
    if (!tonalTex || bgTonalStrength <= 0) return;
    gl.useProgram(tonalProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tonalTex);
    gl.uniform1i(uTonalMap, 0);
    gl.uniform1f(uTonalStrength, bgTonalStrength);
    gl.uniform1f(uTonalVignetteStr, vignetteStrength);
    gl.uniform1f(uTonalBorderWidth, borderWidth);
    gl.uniform1f(uTonalBorderRadius, borderRadius);
    gl.uniform3f(uTonalBorderColor, borderColor[0], borderColor[1], borderColor[2]);
    gl.uniform2f(uTonalResolution, Math.round(canvas.width), Math.round(canvas.height));
    gl.uniform1f(uTonalMargin, paintingMargin);
    gl.uniform3f(uTonalCanvasColor, canvasColor[0], canvasColor[1], canvasColor[2]);
    gl.bindVertexArray(vaoTonal);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function drawParticles(starTrailMode) {
    // Before full shader is finalized, render with minimal shader (intro only)
    // Before full shader finalization: skip particle rendering entirely.
    // The intro overlay covers the canvas (z-index 10) — nothing visible.
    // Drawing with mini shader would flash the full painting before intro mode
    // takes over with the dark vignette, causing a jarring visual glitch.
    if (!_renderFinalized) return;
    // Use debug program when debug mode active (lazy-compiled on first V key)
    const targetProg = (debugMode > 0 && _debugRenderProg) ? _debugRenderProg : renderProg;
    // Re-resolve uniform locations when switching between render/debug programs
    if (targetProg !== _activeRenderProg) _resolveRenderUniforms(targetProg);
    gl.useProgram(targetProg);
    gl.uniform1f(uVignetteStr, vignetteStrength);
    gl.uniform2f(uResolution, Math.round(canvas.width), Math.round(canvas.height));
    gl.uniform1f(uBorderWidth, borderWidth);
    gl.uniform1f(uBorderRadius, borderRadius);
    gl.uniform3f(uBorderColor, borderColor[0], borderColor[1], borderColor[2]);
    gl.uniform1f(uIntroMode, introModeValue);
    gl.uniform1f(uIntroGlow, introGlow);
    gl.uniform1f(uIntroGlowRadius, introGlowRadius);
    gl.uniform1f(uRevealBrightness, revealBrightness);
    gl.uniform1f(uMargin, paintingMargin);

    const ar = canvas.width / canvas.height || 1;
    const halfDiag = Math.sqrt(0.25 * ar * ar + 0.25);

    // Pack vortex data for GPU
    for (let i = 0; i < vortices.length; i++) {
      vortexDataFlat[i * 4]     = vortices[i].centerCurrent[0];
      vortexDataFlat[i * 4 + 1] = vortices[i].centerCurrent[1];
      vortexDataFlat[i * 4 + 2] = vortices[i].sign;
      vortexDataFlat[i * 4 + 3] = vortices[i].strength;

      // Per-vortex params: pre-compute radius from eased gravity
      const gravNorm = Math.min(vortices[i].gravityCurrent / 0.005, 1.0);
      vortexParamsFlat[i * 4]     = halfDiag * Math.sqrt(gravNorm) * vortices[i].removalScale;  // radius
      vortexParamsFlat[i * 4 + 1] = vortices[i].speed;               // speed
      vortexParamsFlat[i * 4 + 2] = vortices[i].birthTime;           // for color fade-in
      vortexParamsFlat[i * 4 + 3] = vortices[i].armTightness;        // per-vortex arm tightness

      // Per-vortex art params
      // Per-vortex art: x=armCurl, y=fadeDuration, z=curlAmount, w=reserved
      vortexArtFlat[i * 4]     = vortices[i].armCurl;          // spiral revolutions
      vortexArtFlat[i * 4 + 1] = vortices[i].fadeDuration;     // per-vortex fade-in duration
      vortexArtFlat[i * 4 + 2] = vortices[i].curlAmount;       // turbulence strength
      vortexArtFlat[i * 4 + 3] = vortexCursorPhaseOffset[i];    // cursor-driven rotation offset
    }

    gl.uniform1f(uPointSize, pointSize);
    gl.uniform1f(uAspectRatio, ar);
    gl.uniform1f(uTime, simTime);
    gl.uniform1f(urBreatheWave, 0.7 + 0.3 * Math.sin(simTime * 0.2513));
    gl.uniform1i(uDebugMode, debugMode);
    gl.uniform1f(uSwell, swell);
    gl.uniform1f(uLumPreserve, lumPreserve);
    gl.uniform1f(uBaseAlpha, baseAlpha);

    // Flow lifecycle alpha (smoothly eased)
    gl.uniform1f(urFlowDriftFrac, flowDriftFrac);
    gl.uniform1f(urFlowCyclePeriod, flowCyclePeriod);
    gl.uniform1f(urFlowThreshold, flowThreshold);
    gl.uniform1f(urFlowMaxDrift, (window._dvs_noDisplace || window._dvs_noFlowDrift) ? 0 : flowMaxDrift * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform2f(urFlowCursorUV, flowCursorUV[0], flowCursorUV[1]);
    gl.uniform2f(urFlowCursorDir, flowCursorDir[0], flowCursorDir[1]);
    gl.uniform1f(urFlowCursorInfluence, flowCursorInfluence);
    gl.uniform1f(urFlowCursorRadius, flowCursorRadius);
    // Star cursor bump
    gl.uniform2f(urStarCursorUV, starCursorUV[0], starCursorUV[1]);
    gl.uniform1f(urStarCursorInfluence, starCursorInfluence);
    gl.uniform1f(urStarBumpStrength, starBumpStrength);
    gl.uniform1f(urStarPushRadius, starPushRadius);
    // flowMix: activation gate (0-1), eased independently of speed to prevent snap-back
    gl.uniform1f(urFlowMix, window._dvs_noFlow ? 0 : flowMixEased);

    gl.uniform1f(uWobbleAmt, wobbleAmt);
    gl.uniform1f(uTrembleAmt, trembleAmt);
    gl.uniform1f(uTrembleFreq, trembleFreq);
    gl.uniform4fv(uVortexData, vortexDataFlat);
    gl.uniform4fv(uVortexParams, vortexParamsFlat);
    gl.uniform4fv(uVortexArt, vortexArtFlat);
    gl.uniform1i(uVortexCount, vortices.length);
    gl.uniform1f(uColorAdvect, colorAdvect);

    // Painting texture for color advection
    if (paintingTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, paintingTex);
      gl.uniform1i(uPaintingTex, 0);
    }

    // Boundary distance texture for displaced-position collision
    if (boundaryTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, boundaryTex);
      gl.uniform1i(uBoundaryTex, 1);
    }

    // Flow field texture for streak tangent direction at current position
    if (flowFieldTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, flowFieldTex);
      gl.uniform1i(uFlowFieldTexR, 2);
    }

    // G4: Packed distance texture (R=flowEdge, G=cypressEdge, B=villageEdge)
    if (distPackTex) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, distPackTex);
      gl.uniform1i(urDistPackTex, 3);
    }
    if (flowCurvatureTex) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, flowCurvatureTex);
      gl.uniform1i(urFlowCurvatureTex, 4);
    }
    if (regionMapTex) {
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, regionMapTex);
      gl.uniform1i(urRegionMapTex, 5);
    }
    if (clickRemapTex && debugMode === 12) {
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D, clickRemapTex);
      gl.uniform1i(urClickRemapTex, 9);
    }
    // Noise texture (TEXTURE6) — pre-computed simplex noise for displacement effects
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(uNoiseTex, 6);
    // cypressEdgeTex packed into distPackTex.g (G4)
    if (cypressFlowTex) {
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, cypressFlowTex);
    }
    // Scale pixel-based edge depths to current canvas size (tuned for 2048px reference)
    const _edgeScale = Math.max(canvas.width, canvas.height) / 2048;
    gl.uniform1f(urAbsorptionThreshold, absorptionThreshold);
    gl.uniform1f(urFlowEdgeDepth, flowEdgeDepth * _edgeScale);
    gl.uniform1f(urFlowSpeedFloor, flowSpeedFloor * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform1f(urGustPeriod, gustPeriod);
    gl.uniform1f(urGustAmplitude, gustAmplitude * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform1f(urCanvasDeformAmp, canvasDeformAmp);
    gl.uniform1f(urEddyMinScale, eddyMin);
    gl.uniform1f(urEddyMaxScale, eddyMax);
    gl.uniform1f(urSkyGustAmplitude, window._dvs_noSkyBlock ? 0 : skyGustAmplitude * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform1f(urSkyMaxDrift, (window._dvs_noDisplace || window._dvs_noSkyDrift) ? 0 : skyMaxDrift * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform1f(urSkySwayAmount, skySwayAmount * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform1f(urSkyStarShimmer, window._dvs_noDisplace ? 0 : skyStarShimmer);
    gl.uniform4fv(urNsWakeTrail, nsWakeTrailData);
    gl.uniform2f(urNsWakeCursorUV, nsWakeCursorUV[0], nsWakeCursorUV[1]);
    gl.uniform1f(urNsWakeCursorInfluence, nsWakeCursorInfluence);
    gl.uniform1f(urNsWakeRadius, nsWakeRadius);
    gl.uniform1f(urNsWakeDecay, nsWakeDecay);
    gl.uniform1f(urNsWakeGustBoost, nsWakeGustBoost);
    gl.uniform1f(urNsWakePushStrength, nsWakePushStrength);
    gl.uniform1f(urFlowTwinkle, flowTwinkle);
    gl.uniform1f(urCypressSwayAmp, cypressSwayAmp * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform1f(urCypressMaxDrift, window._dvs_noDisplace ? 0 : cypressMaxDrift);
    gl.uniform1f(urCypressSwayMix, cypressSwayMix);
    gl.uniform1f(urCypressTopY, cypressTopY);
    gl.uniform1f(urCypressBaseY, cypressBaseY);
    gl.uniform1f(urCypressBaseRatio, cypressBaseRatio);
    gl.uniform1f(urCypressCrossSway, cypressCrossSway * (_isRadiantActive ? 1.2 : 1.0));
    gl.uniform1f(urCypressBreathPeriod, cypressBreathPeriod);
    gl.uniform1f(urCypressSwayAngle, cypressSwayAngle);
    gl.uniform1f(urCypressEdgeDepth, cypressEdgeDepth * _edgeScale);
    gl.uniform1f(urVillageWindAmp, villageWindAmp);
    gl.uniform1f(urVillageWindAngle, villageWindAngle);
    gl.uniform1f(urVillageSwayAngle, villageSwayAngle);
    gl.uniform1f(urVillageEdgeDepth, villageEdgeDepth * _edgeScale);
    gl.uniform1f(urVillageLumParallax, villageLumParallax);
    gl.uniform1f(urVillageTwinkle, villageTwinkle);
    gl.uniform1f(urVillageTwinkleWarmth, villageTwinkleWarmth);
    gl.uniform1f(urVillageBreathPhase, villageBreathPhase);
    gl.uniform1f(urVillageBreathDepth, villageBreathDepth);
    gl.uniform1f(urVillageNoiseAmp, villageNoiseAmp * (_isRadiantActive ? 2.0 : 1.0));
    gl.uniform1f(urVillageNoiseDrift, villageNoiseDrift);
    gl.uniform1f(urVillageCrossSway, villageCrossSway);
    gl.uniform2f(urVillageWindCenter, villageWindCenterX, villageWindCenterY);
    gl.uniform1f(urVillageWindRadius, villageWindRadius);
    gl.uniform1f(urVillageAttraction, villageAttraction);
    gl.uniform1f(urVillageWindRadiusActive, villageWindRadiusActive);
    gl.uniform1f(urVillageAttractionAmpActive, villageAttractionAmpActive * (_isRadiantActive ? 3.0 : 1.0));
    gl.uniform1f(urVillageSwarmTime, villageSwarmTime);
    gl.uniform1f(urSwarmCyclePeriodMin, swarmCyclePeriodMin);
    gl.uniform1f(urSwarmCyclePeriodMax, swarmCyclePeriodMax);
    gl.uniform1f(urSwarmEarlyDeathPct, swarmEarlyDeathPct);
    gl.uniform1f(urSwarmDeathFadeWidth, swarmDeathFadeWidth);
    gl.uniform1f(urSwarmMaxDriftMul, swarmMaxDriftMul);
    gl.uniform1f(urSwarmFadeIn, swarmFadeIn);
    gl.uniform1f(urSwarmFadeOutStart, swarmFadeOutStart);
    gl.uniform1f(urSwarmFixedPeriod, swarmFixedPeriod);
    gl.uniform1f(urSwarmPhaseSpread, swarmPhaseSpread);
    gl.uniform1f(urSwarmLfoSync, swarmLfoSync);
    gl.uniform1f(urVillageWindBlend, villageWindBlendVal);
    gl.uniform2f(urVillageExitPoint, villageExitPointX, villageExitPointY);
    gl.uniform1f(urVillageWindRippleRadius, villageWindRippleRadius);
    gl.uniform1f(urSwarmDriftFracSmoothed, swarmDriftFracSmoothed);
    gl.uniform2f(urVillageClickOrigin, villageClickOriginX, villageClickOriginY);
    // villageEdgeTex packed into distPackTex.b (G4)
    gl.uniform1f(urCypressCanopyGlow, window._dvs_noCypressGlow ? 0 : cypressCanopyGlow);
    gl.uniform1f(urCypressLeafFlash, window._dvs_noCypressFlash ? 0 : cypressLeafFlash);
    gl.uniform1f(urCypressRimWidth, cypressRimWidth);
    gl.uniform1f(urCypressRimGlow, window._dvs_noCypressRim ? 0 : cypressRimGlow);
    if (cypressFlowTex) gl.uniform1i(urCypressFlowTex, 7);
    gl.uniform1f(urCypressFlowCyclePeriod, cypressFlowCyclePeriod);
    gl.uniform1f(urCypressFlowDriftFrac, cypressFlowDriftFrac);
    gl.uniform1f(urCypressFlowMaxDrift, cypressFlowMaxDrift);
    gl.uniform1f(urCypressFlowGustAmp, cypressFlowGustAmp);
    gl.uniform1f(urCypressWindBias, cypressWindBias);
    gl.uniform1f(urIntroDanceScale, introDanceEased);

    for (let i = 0; i < NUM_REGIONS; i++) {
      gl.uniform1f(uRegionMix[i], regionCurrent[i]);
    }
    for (let i = 0; i < 5; i++) {
      gl.uniform1f(uRegionActive[i], regionActiveArr[i]);
      gl.uniform2f(uRegionClickOrigin[i], regionClickUV[i * 2], regionClickUV[i * 2 + 1]);
      gl.uniform1f(uRegionRadius[i], regionRadiusArr[i]);
    }
    gl.uniform1f(urVillageFadeOut, window._dvs_noVillageStagger ? 0 : villageFadeOut);
    gl.uniform1f(urSkyFadeOut, skyFadeOut);
    gl.uniform1f(urHorizonFadeOut, horizonFadeOut);
    // Star glow uniforms (12 stars)
    for (let i = 0; i < 12; i++) {
      gl.uniform2f(uStarCenter[i], starCenterUV[i * 2], starCenterUV[i * 2 + 1]);
      gl.uniform1f(uStarCurrentRadius[i], starCurrentRadii[i]);
      gl.uniform1f(uStarInnerRadius[i], starInnerRadii[i]);
    }
    gl.uniform1f(uStarGlowActive, starGlowActive);
    for (let i = 0; i < 12; i++) gl.uniform1f(uStarGlowIntensity[i], starGlowIntensity[i]);
    gl.uniform1f(uStarScintillation, starScintillation);
    gl.uniform1f(uStarHaloSoftness, starHaloSoftness);
    // Flashlight trail
    gl.uniform4fv(uFlashTrail, flashTrailData);
    gl.uniform1f(uFlashRadius, flashRadius);
    gl.uniform1f(uFlashDecay, flashDecay);

    // Flashlight drift
    gl.uniform2f(uCanvasSize, canvas.width, canvas.height);
    gl.uniform1f(uDriftAmount, driftAmount);
    gl.uniform1f(uDriftSpeed, driftSpeed);
    gl.uniform1f(uDriftMouseSpeed, driftMouseSpeed);
    gl.uniform1f(uDriftMouseInfluence, driftMouseInfluence);
    gl.uniform2f(uDriftCenter, driftCenterX, driftCenterY);
    gl.uniform1f(uDriftActive, driftActive);
    gl.uniform1f(uDriftMaxCap, driftMaxCap);

    // Hover orbit
    gl.uniform1f(uHoverRegion0, hoverRegion0);
    gl.uniform1f(uHoverIntensity0, hoverIntensity0);
    gl.uniform2f(uHoverCenter0, hoverCenterX0, hoverCenterY0);
    gl.uniform1f(uHoverFreezeTime0, hoverFreezeTime0);
    gl.uniform1f(uHoverRegion1, hoverRegion1);
    gl.uniform1f(uHoverIntensity1, hoverIntensity1);
    gl.uniform2f(uHoverCenter1, hoverCenterX1, hoverCenterY1);
    gl.uniform1f(uHoverFreezeTime1, hoverFreezeTime1);

    gl.bindVertexArray(vaoRender);

    // Rebind a_simPos to the CURRENT sim buffer (updated by runSimStep this frame).
    // simSrc points to whichever buffer has the latest integrated positions.
    // Rebind a_simPos to the CURRENT sim buffer (updated by runSimStep this frame).
    // simSrc points to whichever buffer has the latest integrated positions.
    if (aRenderSimPos >= 0 && (simBufA || simBufB)) {
      const currentSimBuf = simSrc === 0 ? simBufA : simBufB;
      gl.bindBuffer(gl.ARRAY_BUFFER, currentSimBuf);
      gl.vertexAttribPointer(aRenderSimPos, 2, gl.FLOAT, false, 0, 0);
    }

    if (pointCount > 0) {
      if (additiveBlend) gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      // Adaptive particle count via setParticleFraction (Phase 1 iPad fix).
      // window._gpuDiag_particleFrac is a debug override that wins if set.
      const debugFrac = (typeof window !== 'undefined' && window._gpuDiag_particleFrac != null)
        ? Math.max(0, Math.min(1, window._gpuDiag_particleFrac))
        : null;
      const effectiveFrac = debugFrac != null ? debugFrac : _particleDrawFraction;
      if (effectiveFrac >= 1.0 || !regionOffsets || !regionCounts) {
        // Fast path: full draw, single call. Zero behavior change for desktop.
        gl.drawArrays(gl.POINTS, 0, pointCount);
      } else {
        // Per-region fractional draw. The G2a sort grouped particles by
        // region, so the buffer is laid out [r0 | r1 | r2 | r3 | r4 | r5].
        // A single drawArrays(0, N) where N < pointCount would draw only
        // the early regions and miss later ones — stars (region 5) would
        // disappear entirely, leaving black holes in the painting.
        // Iterate per region instead, drawing a fraction of each range.
        // The within-region shuffle in loadPoints makes "first N per region"
        // spatially uniform within that region.
        for (let r = 0; r < NUM_REGIONS; r++) {
          const regionN = Math.round(regionCounts[r] * effectiveFrac);
          if (regionN > 0) {
            gl.drawArrays(gl.POINTS, regionOffsets[r], regionN);
          }
        }
      }
      if (additiveBlend) gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.bindVertexArray(null);
  }


  function passRender(dt) {
    const w = canvas.width, h = canvas.height;
    const iw = w, ih = h;  // kept as aliases since render paths reference both
    // Eddy contrast → min/max scale (computed once per frame, used by render + composite)
    eddyMin = 1.0 - eddyContrast * 0.8;
    eddyMax = 1.0 + eddyContrast * 1.2;

    // ── Collect previous GPU query result (non-blocking) ──
    if (timerExt && pendingQuery) {
      const available = gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
      if (available && !disjoint) {
        const nsElapsed = gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT);
        gpuTimeAccum += nsElapsed / 1e6;
        gpuQueryCount++;
      }
      if (available || disjoint) {
        gl.deleteQuery(pendingQuery);
        pendingQuery = null;
      }
    }

    // ── Start GPU timer query for this frame (both render paths) ──
    // Wraps the entire render body — shadow + tonal + particles + composite
    // + blits — so the gpu: readout in ?perfOverlay
    // reflects total GPU frame cost regardless of which render path runs.
    // Previously the query only wrapped `drawParticles(0)` in the direct
    // path, so the number was silently zero during trail mode (the heavy
    // state). Spec note: EXT_disjoint_timer_query_webgl2 allows one
    // TIME_ELAPSED query at a time; the pending-query check below enforces
    // that, same pattern as the prior code.
    let _queryStartedThisFrame = false;
    if (timerExt && !pendingQuery) {
      pendingQuery = gl.createQuery();
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, pendingQuery);
      _queryStartedThisFrame = true;
    }

    // ── Trail OFF: render directly to screen (zero overhead) ──
    // Debug flags: window._dvs_noTrail = true  → force direct (no FBO trails)
    //              window._dvs_alwaysTrail = true → keep FBO path always on
    //              window._dvs_forceDirect = true → force direct rendering
    const skyGustTrailActive = !window._dvs_noTrail && !window._dvs_forceDirect && (window._dvs_alwaysTrail || (skyMaxDrift > 0.0001 && skyGustTrailPersist > 0.01 && regionActiveArr[2] > 0.0001));
    const cypressTrailActive = !window._dvs_noTrail && !window._dvs_forceDirect && (cypressTrailPersist > 0.01 && cypressSwayMix > 0.0001);
    const swirlTrailActive = !window._dvs_noTrail && !window._dvs_forceDirect && (swirlTrailPersist > 0.01 && flowMixEased > 0.0001);
    const vortexTrailActive = !window._dvs_noTrail && !window._dvs_forceDirect && vortexTrailGlobal > 0.001 && vortices.some(v => v.active);
    const villageTrailNow = !window._dvs_noTrail && !window._dvs_forceDirect && (villageTrailPersist > 0.01 && regionActiveArr[1] > 0.0001);
    // ── G8: Skip FBO composite when no trail system needs persistence ──
    // Per-system checks cover all trail sources. The old trailScale gate was
    // vestigial — trailScale=0.5 (never changed) blocked the direct path even
    // when all persistence was zero. Removing it lets idle frames skip the
    // fullscreen composite quad entirely.
    // Force direct render when support shaders not yet finalized (intro idle pending)
    // Console: window._gpuDiag_directOnly = true → skip composite (direct render only)
    // URL param: ?directOnly=1 (for devices without console access, e.g. iPad)
    // (Path A TBDR diagnostic — reveals composite cost on TBDR architectures)
    const _directOnly = typeof window !== 'undefined' && (window._gpuDiag_directOnly || window._gpuDiag_directOnlyUrl);
    const anyTrailActive = !_directOnly && _otherProgramsFinalized && (starTrailsActive || skyGustTrailActive || cypressTrailActive || swirlTrailActive || vortexTrailActive || villageTrailNow);
    if (!anyTrailActive && !window._dvs_alwaysTrail) {
      // Direct render: zero FBO overhead, no trail persistence pipeline.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, iw, ih);
      gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawShadow(); drawTonalBackground();
      drawParticles(0);

      // End GPU timer query (direct path exit)
      if (_queryStartedThisFrame) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
      }
      return;
    }

    // ── Trail ON: FBO pipeline ──────────────────────────────────────
    // Normal mode:
    //   1. Render ALL particles to FBO-A
    //   2. Composite: max(FBO-A, FBO-B * persistence) → FBO-C
    //   3. Blit FBO-C to screen, swap B↔C
    //
    // Star trails mode:
    //   1a. Render ALL particles to FBO-A (display — full brightness, u_starTrails=1)
    //   1b. Render ONLY 10% trail particles to FBO-D (trail source, u_starTrails=2)
    //   2.  Composite: max(FBO-A, trail from FBO-D accumulated in FBO-B) → FBO-C
    //   3.  Blit FBO-C to screen, swap B↔C

    ensureFbos(iw, ih);

    if (starTrailsActive) {
      // ── Star trails: two-pass rendering ──

      // Pass 1a: ALL particles at full brightness → FBO-A (display)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
      gl.viewport(0, 0, iw, ih);
      gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawShadow(); drawTonalBackground();
      drawParticles(1);  // mode 1: render all, no dimming

      // Pass 1b: ONLY trail particles → FBO-D (trail source)
      // Fragment shader discards non-trail particles when u_starTrails==2
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboD);
      gl.viewport(0, 0, iw, ih);
      gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawParticles(2);  // mode 2: discard 90%, keep trail particles only

      // Step 2: Composite — trail accumulated from FBO-D, display from FBO-A
      // Trail buffer FBO-B decays and accumulates from FBO-D (sparse trail particles).
      // First: build trail → FBO-C = max(FBO-D, FBO-B * persistence)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboC);
      gl.viewport(0, 0, iw, ih);
      gl.disable(gl.BLEND);

      gl.useProgram(compositeProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texD);  // trail source (sparse)
      gl.uniform1i(ucCurrentTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);  // accumulated trail
      gl.uniform1i(ucPrevTex, 1);
      if (regionMapTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, regionMapTex);
        gl.uniform1i(ucRegionMapTex, 2);
      }
      if (flowCurvatureTex) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, flowCurvatureTex);
        gl.uniform1i(ucFlowCurvatureTex, 3);
      }
      if (flowFieldTex) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, flowFieldTex);
        gl.uniform1i(ucFlowFieldTex, 4);
      }
      gl.uniform1f(ucEddyMinScale, eddyMin);
      gl.uniform1f(ucEddyMaxScale, eddyMax);
      gl.uniform1f(ucFlowSpeedFloor, flowSpeedFloor * (_isRadiantActive ? 1.2 : 1.0));
      // Drop persistence fast when no active vortices — prevents trail burn-in after removal
      let hasActiveVortex = false;
      for (let i = 0; i < vortices.length; i++) { if (!vortices[i].isRemoving) { hasActiveVortex = true; break; } }
      const starTrailPersist = hasActiveVortex ? 0.99 : 0.5;
      gl.uniform1f(ucPersistence, 0);                              // no trail for default regions
      gl.uniform1f(ucVortexTrailPersistence, starTrailPersist);    // stars get trail
      gl.uniform1f(ucFlowPersistence, 0);                          // flow regions unaffected
      gl.uniform1f(ucSkyGustPersistence, 0);                       // sky gust unaffected
      gl.uniform1f(ucSkyGustFade, 1.0);  // no fade in star trail mode
      gl.uniform1f(ucSwirlTrailPersistence, 0);                    // swirl unaffected
      gl.uniform1f(ucSwirlTrailFade, 0);
      gl.uniform1f(ucCypressTrailPersistence, 0);                  // cypress unaffected
      gl.uniform1f(ucCypressTrailFade, 1.0);
      // Vortex data for composite: extends star trail persistence to absorbed
      // region-4 pixels inside gravity wells (same data as normal composite pass)
      gl.uniform4fv(ucCVortexData, vortexDataFlat);
      gl.uniform4fv(ucCVortexParams, vortexParamsFlat);
      gl.uniform1i(ucCVortexCount, vortices.length);
      gl.uniform1f(ucCAspectRatio, canvas.width / canvas.height || 1);
      gl.uniform1f(ucCTrailMultiplier, trailLinesAlpha);
      // Village trail uniforms (zeroed — not active in star trail mode)
      gl.uniform1f(ucVillageTrailPersistence, 0);
      gl.uniform1f(ucVillageTrailFade, 0);
      gl.uniform2f(ucVillageTrailCenter, 0.5, 0.5);
      gl.uniform1f(ucVillageTrailRadius, 0.15);
      gl.uniform1f(ucVillageTrailAttraction, 0);
      gl.uniform1f(ucVillageWindBlend, 0);
      gl.uniform1f(ucVillageCursorMoving, 0);
      gl.uniform1f(ucVillageTopY, 0);
      gl.uniform1f(ucVillageBottomY, 1);
      gl.uniform1f(ucVillageBaseTrailRatio, 1);
      // Star cursor trail boost
      gl.uniform2f(ucStarCursorUV, starCursorUV[0], starCursorUV[1]);
      gl.uniform1f(ucStarCursorInfluence, starCursorInfluence);
      {
        let maxVR = 0;
        for (let i = 0; i < vortices.length; i++) {
          maxVR = Math.max(maxVR, vortexParamsFlat[i * 4]);
        }
        gl.uniform1f(ucStarPushRadius, starPushRadius * maxVR);
        gl.uniform1f(ucStarTrailPersist, starTrailPersist);
      }
      // Night Sky cursor wake: drain persistence in push zone
      gl.uniform2f(ucNsWakeCursorUV, nsWakeCursorUV[0], nsWakeCursorUV[1]);
      gl.uniform1f(ucNsWakeCursorInfluence, nsWakePushInfluence);
      gl.uniform1f(ucNsWakeRadius, nsWakeRadius);
      // Subtractive drain: dims values by a flat amount per frame so gray
      // reaches true zero quickly instead of lingering as smudge
      gl.uniform1f(ucTrailSubtract, 0.008);

      gl.bindVertexArray(vaoQuad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);

      // Now FBO-C has the accumulated trail. Overlay display (FBO-A) on top.
      // Blit FBO-A onto FBO-C using max blending: result = max(display, trail)
      // WebGL2 doesn't have MAX blend for blit, so use the composite shader
      // with FBO-A as current and FBO-C as prev (persistence=1.0 to not decay).
      // Swap first so FBO-C (trail) becomes FBO-B for re-use as prev input.
      let tmpFbo = fboB, tmpTex = texB;
      fboB = fboC; texB = texC;
      fboC = tmpFbo; texC = tmpTex;

      // Final composite: max(FBO-A, trail) → FBO-C
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboC);
      gl.viewport(0, 0, iw, ih);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);  // full display
      gl.uniform1i(ucCurrentTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);  // accumulated trail
      gl.uniform1i(ucPrevTex, 1);
      gl.uniform1f(ucPersistence, 1.0);         // don't decay trail in this pass
      gl.uniform1f(ucVortexTrailPersistence, 1.0); // don't decay vortex trail in overlay
      gl.uniform1f(ucFlowPersistence, 1.0);    // no special flow treatment in overlay pass
      gl.uniform1f(ucSkyGustPersistence, 1.0);  // don't decay in display overlay
      gl.uniform1f(ucSkyGustFade, 1.0);        // no fade in display overlay
      gl.uniform1f(ucSwirlTrailPersistence, 1.0); // don't decay swirl trail in overlay
      gl.uniform1f(ucSwirlTrailFade, 1.0);
      gl.uniform1f(ucCypressTrailPersistence, 1.0);
      gl.uniform1f(ucCypressTrailFade, 1.0);
      // Village uniforms (pass-through — no decay in overlay)
      gl.uniform1f(ucVillageTrailPersistence, 1.0);
      gl.uniform1f(ucVillageTrailFade, 1.0);
      gl.uniform2f(ucVillageTrailCenter, 0.5, 0.5);
      gl.uniform1f(ucVillageTrailRadius, 0.15);
      gl.uniform1f(ucVillageTrailAttraction, 0);
      gl.uniform1f(ucVillageWindBlend, 0);
      gl.uniform1f(ucVillageCursorMoving, 0);
      gl.uniform1f(ucVillageTopY, 0);
      gl.uniform1f(ucVillageBottomY, 1);
      gl.uniform1f(ucVillageBaseTrailRatio, 1);
      // Star cursor (pass-through — no cursor trail in overlay)
      gl.uniform2f(ucStarCursorUV, 0.5, 0.5);
      gl.uniform1f(ucStarCursorInfluence, 0);
      gl.uniform1f(ucStarPushRadius, 0);
      gl.uniform1f(ucStarTrailPersist, 0);
      // Night Sky wake (pass-through — no drain in overlay)
      gl.uniform2f(ucNsWakeCursorUV, 0.5, 0.5);
      gl.uniform1f(ucNsWakeCursorInfluence, 0);
      gl.uniform1f(ucNsWakeRadius, 0);
      gl.uniform1f(ucTrailSubtract, 0.0);      // no drain for display overlay

      gl.bindVertexArray(vaoQuad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);

      // Step 3: Blit to screen
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboC);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, iw, ih, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      gl.enable(gl.BLEND);

      // G18: Invalidate consumed FBOs — hint for tile-based GPUs
      const _att = [gl.COLOR_ATTACHMENT0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA); gl.invalidateFramebuffer(gl.FRAMEBUFFER, _att);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboD); gl.invalidateFramebuffer(gl.FRAMEBUFFER, _att);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // FBO-B already holds the trail buffer for next frame (swapped above)

    } else {
      // ── Normal trail mode ──

      // Step 1: Render particles to FBO-A
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
      gl.viewport(0, 0, iw, ih);
      gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawShadow(); drawTonalBackground();
      drawParticles(0);

      // Step 2: Composite current frame with trail buffer
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboC);
      gl.viewport(0, 0, iw, ih);
      gl.disable(gl.BLEND);

      gl.useProgram(compositeProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(ucCurrentTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform1i(ucPrevTex, 1);

      // Bind region map for per-pixel persistence selection
      if (regionMapTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, regionMapTex);
        gl.uniform1i(ucRegionMapTex, 2);
      }
      // Bind curvature texture for speed-gated trail persistence
      if (flowCurvatureTex) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, flowCurvatureTex);
        gl.uniform1i(ucFlowCurvatureTex, 3);
      }
      if (flowFieldTex) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, flowFieldTex);
        gl.uniform1i(ucFlowFieldTex, 4);
      }
      gl.uniform1f(ucEddyMinScale, eddyMin);
      gl.uniform1f(ucEddyMaxScale, eddyMax);
      gl.uniform1f(ucFlowSpeedFloor, flowSpeedFloor * (_isRadiantActive ? 1.2 : 1.0));

      // Vortex trail persistence: only non-zero when stars are actually active.
      // Dormant pre-placed vortices (gravity=0) must not trigger trail accumulation
      // at region 5 pixels — otherwise brightness builds up before the user clicks.
      const hasActiveVortex = vortices.some(v => v.active);
      let vortexPersistence = 0;
      if (hasActiveVortex) {
        let effectiveTrail = vortexTrailGlobal;
        let avgSpeed = 0.1;
        let speedSum = 0;
        for (const v of vortices) { speedSum += v.speed; }
        avgSpeed = speedSum / vortices.length;
        // Map trail [0,1] to persistence [0, 0.95] with exponential curve
        // trail=0 → 0 (no trails), trail=0.5 → 0.88, trail=1.0 → 0.95
        // Capped at 0.95 to prevent blowout (trails fade in ~1.3s at 60fps)
        const basePersistence = Math.min(0.95, 1.0 - Math.exp(-effectiveTrail * 5.0));
        // Speed gently reduces persistence (fast rotation = shorter trails)
        // but floor at 0.7 so trails always remain visible when trail > 0
        const speedFactor = Math.max(0.7, 1.0 - (avgSpeed - 0.1) * 0.15);
        vortexPersistence = basePersistence * speedFactor;

        // Emergence ramp: delay trail persistence until the youngest vortex
        // has finished its fade-in. Prevents FBO accumulation during the
        // expansion phase when particles are at intermediate positions.
        let minRamp = 1.0;
        for (const v of vortices) {
          if (!v.active) continue;
          const age = simTime - v.birthTime;
          const ramp = Math.min(1.0, age / Math.max(v.fadeDuration, 0.1));
          minRamp = Math.min(minRamp, ramp);
        }
        vortexPersistence *= minRamp;

        // Removal ramp: fade trail persistence as vortices shrink during
        // deactivation. Mirrors the emergence ramp — trails fade out naturally
        // instead of an instant FBO clear that also kills other region trails.
        let anyRemoving = false;
        let maxReleaseFrac = 0;
        for (const v of vortices) {
          if (!v.isRemoving) continue;
          anyRemoving = true;
          const releaseFrac = Math.min(1.0, (simTime - v.removalTime) / v.releaseDuration);
          maxReleaseFrac = Math.max(maxReleaseFrac, releaseFrac);
        }
        if (anyRemoving) {
          vortexPersistence *= (1.0 - maxReleaseFrac);
        }
      }

      // Base persistence = 0: no trail for regions 0 (sky bg), 2 (hills), or any unhandled region
      gl.uniform1f(ucPersistence, 0);
      // Vortex trail only applies to star region (5) via shader branch
      gl.uniform1f(ucVortexTrailPersistence, vortexPersistence);

      // Flow persistence: only applied in regions 3,4 by the shader.
      // Decoupled from vortex persistence — derives from global trailScale only.
      const flowTrailValue = 1.0 - Math.exp(-trailScale * 3.5 * 1.5);
      const flowBlend = Math.min(1.0, flowMixEased);
      const flowPersistence = flowTrailValue * flowBlend;
      gl.uniform1f(ucFlowPersistence, flowPersistence);
      // Sky gust and cypress: fallback to 0 when their own systems are inactive
      gl.uniform1f(ucSkyGustPersistence, skyGustTrailActive ? skyGustTrailPersist : 0);
      gl.uniform1f(ucSkyGustFade, regionActiveArr[2]);
      gl.uniform4fv(ucCVortexData, vortexDataFlat);
      gl.uniform4fv(ucCVortexParams, vortexParamsFlat);
      gl.uniform1i(ucCVortexCount, vortices.length);
      gl.uniform1f(ucCAspectRatio, canvas.width / canvas.height || 1);
      gl.uniform1f(ucCTrailMultiplier, trailLinesAlpha);
      gl.uniform1f(ucSwirlTrailPersistence, swirlTrailActive ? swirlTrailPersist : 0);
      gl.uniform1f(ucSwirlTrailFade, flowMixEased);
      gl.uniform1f(ucCypressTrailPersistence, cypressTrailActive ? cypressTrailPersist : 0);
      gl.uniform1f(ucCypressTrailFade, cypressSwayMix);
      const villageTrailActive = !window._dvs_noTrail && !window._dvs_forceDirect
                              && !window._dvs_noVillageTrail
                              && (villageTrailPersist > 0.01 && regionActiveArr[1] > 0.0001);
      gl.uniform1f(ucVillageTrailPersistence, villageTrailActive ? villageTrailPersist : 0);
      // During fade-out, follow color intensity only (so the trail drains in
      // sync with the displacement fading down). Otherwise use max with
      // villageAttraction to keep trails alive during cursor interaction
      // even if color briefly dips. Without this gate the trail held at 1.0
      // throughout fade-out (because villageAttraction stays at 1.0 in hover
      // mode), then drained suddenly at the end — producing a bright pop.
      gl.uniform1f(ucVillageTrailFade,
        villageFadeOut ? regionActiveArr[1]
                       : Math.max(regionActiveArr[1], villageAttraction));
      gl.uniform2f(ucVillageTrailCenter, villageWindCenterX, villageWindCenterY);
      gl.uniform1f(ucVillageTrailRadius, villageWindRadius);
      gl.uniform1f(ucVillageTrailAttraction, villageAttraction);
      // Wind blend: JS-computed from region map (shared with render shader)
      gl.uniform1f(ucVillageWindBlend, villageWindBlendVal);
      gl.uniform1f(ucVillageCursorMoving, villageCursorMoving);
      gl.uniform1f(ucVillageTopY, villageTopY);
      gl.uniform1f(ucVillageBottomY, villageBottomY);
      gl.uniform1f(ucVillageBaseTrailRatio, villageBaseTrailRatio);

      // Star cursor trail boost
      gl.uniform2f(ucStarCursorUV, starCursorUV[0], starCursorUV[1]);
      gl.uniform1f(ucStarCursorInfluence, starCursorInfluence);
      {
        let maxVR = 0;
        for (let i = 0; i < vortices.length; i++) {
          maxVR = Math.max(maxVR, vortexParamsFlat[i * 4]);
        }
        gl.uniform1f(ucStarPushRadius, starPushRadius * maxVR);
        gl.uniform1f(ucStarTrailPersist, starTrailPersist);
      }
      // Night Sky cursor wake drain
      gl.uniform2f(ucNsWakeCursorUV, nsWakeCursorUV[0], nsWakeCursorUV[1]);
      gl.uniform1f(ucNsWakeCursorInfluence, nsWakePushInfluence);
      gl.uniform1f(ucNsWakeRadius, nsWakeRadius);

      gl.uniform1f(ucTrailSubtract, 0.0);  // no drain in normal trail mode

      gl.bindVertexArray(vaoQuad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);

      // Step 3: Blit composite to screen
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fboC);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, iw, ih, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      gl.enable(gl.BLEND);

      // G18: Invalidate consumed FBOs — hint for tile-based GPUs
      const _att = [gl.COLOR_ATTACHMENT0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboA); gl.invalidateFramebuffer(gl.FRAMEBUFFER, _att);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // Step 5: Swap trail buffers
      const tmpFbo = fboB, tmpTex = texB;
      fboB = fboC; texB = texC;
      fboC = tmpFbo; texC = tmpTex;
    }

    // End GPU timer query (trail path exit — covers both starTrails and
    // normal-trail sub-paths since both fall through to this point).
    // Ended here, BEFORE the dispTrace readPixels block below, so that
    // any CPU-side GPU sync from readPixels doesn't land inside the query.
    if (_queryStartedThisFrame) {
      gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    }

    // ── Displacement trace (temporary diagnostic) ──
    // Enable: window._dvs_dispTrace = true   then play Horizon → click Stop.
    // Logs per-frame: regionActive, skyRegionGate, skyMaxDrift, skyGustAmplitude,
    //                 avg brightness of 20×20 sky pixel region, Δ from baseline.
    if (window._dvs_dispTrace) {
      const ra = regionActiveArr[2];
      if (!window._dvs_dt) {
        window._dvs_dt = { active: false, frame: 0, prevRA: -1, baseline: -1, prevB: -1 };
      }
      const dt_s = window._dvs_dt;

      // Compute skyRegionGate matching shader: smoothstep(0.25, 0.55, ra)
      const ss = ra <= 0.25 ? 0 : ra >= 0.55 ? 1 : (() => { const t = (ra - 0.25) / 0.30; return t * t * (3 - 2 * t); })();

      // Auto-capture baseline while looping (ra stable and > 0.3)
      if (!dt_s.active && ra > 0.3 && dt_s.prevRA > 0 && Math.abs(ra - dt_s.prevRA) < 0.005) {
        // Capture baseline brightness from sky region
        const sx = Math.floor(w * 0.50) - 10;
        const sy = Math.floor(h * 0.70) - 10;
        const px = new Uint8Array(4 * 20 * 20);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(sx, sy, 20, 20, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let i = 0; i < 400; i++) sum += px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
        dt_s.baseline = sum / 1200;
      }

      // Auto-start: only trigger during actual STOP fade (rA dropping below 0.48).
      // Ignores building→looping ramp-down (which drops from ~0.96 to ~0.50).
      if (!dt_s.active && dt_s.prevRA > 0.1 && dt_s.prevRA < 0.52 && ra < dt_s.prevRA - 0.005) {
        dt_s.active = true;
        dt_s.frame = 0;
        dt_s.prevB = -1;
        _log('%c[DispTrace]%c ── started (baseline brightness: ' +
          (dt_s.baseline >= 0 ? dt_s.baseline.toFixed(1) : 'none') + ') ──',
          'color:#0af;font-weight:bold', 'color:#999');
      }
      dt_s.prevRA = ra;

      if (dt_s.active) {
        // Read 20×20 sky region
        const sx = Math.floor(w * 0.50) - 10;
        const sy = Math.floor(h * 0.70) - 10;
        const px = new Uint8Array(4 * 20 * 20);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(sx, sy, 20, 20, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let i = 0; i < 400; i++) sum += px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
        const avgB = sum / 1200;

        const deltaB = dt_s.prevB >= 0 ? avgB - dt_s.prevB : 0;
        const fromBase = dt_s.baseline >= 0 ? avgB - dt_s.baseline : 0;
        const flag = Math.abs(deltaB) > 2.0 ? ' ◀◀' : '';

        _log(
          `%c[DispTrace]%c f=${String(dt_s.frame).padStart(3)} ` +
          `rA=${ra.toFixed(4)} gate=${ss.toFixed(4)} ` +
          `drift=${skyMaxDrift.toFixed(5)} amp=${skyGustAmplitude.toFixed(3)} ` +
          `B=${avgB.toFixed(1)} ΔB=${(deltaB >= 0 ? '+' : '') + deltaB.toFixed(1)} ` +
          `fromBase=${(fromBase >= 0 ? '+' : '') + fromBase.toFixed(1)}` + flag,
          'color:#0af', 'color:#999'
        );

        dt_s.prevB = avgB;
        dt_s.frame++;

        if (dt_s.frame > 300 || (ra <= 0 && dt_s.frame > 60)) {
          dt_s.active = false;
          _log('%c[DispTrace]%c ── complete ──', 'color:#0af;font-weight:bold', 'color:#999');
        }
      }
    }

    // ── Village trace (fade-out pop diagnostic) ──
    // Enable: window._dvs_villageTrace = true   then click village → hover → click to stop.
    // Logs per-frame during fade-out: regionActive, attraction, windBlend, cursorMoving,
    //   fadeOut flag, computed trailFade, trailPersist, + avg brightness of a village
    //   pixel window, Δ from prev frame, Δ from baseline.
    // Auto-flags brightness jumps ≥ 2.0 units.
    // Elimination toggles to isolate cause:
    //   window._dvs_noVillageTrail     → force trail persistence 0 (skip FBO accumulation)
    //   window._dvs_noVillageStagger   → force u_villageFadeOut = 0 (skip per-particle pow)
    //   window._dvs_noTrail            → global: disable ALL FBO trails
    if (window._dvs_villageTrace) {
      const vRA = regionActiveArr[1];
      if (!window._dvs_vt) {
        window._dvs_vt = { active: false, frame: 0, prevRA: -1, baseline: -1, prevMean: -1, prevMax: -1, peakMean: -1, peakMax: -1, peakFrame: -1 };
      }
      const vt = window._dvs_vt;

      // Sample window: village is at painting-bottom. GL framebuffer y=0 is BOTTOM
      // of canvas (= painting bottom = village area). Use a wider 80×80 window
      // centered around painting UV (~0.45, ~0.85) which maps to GL (w*0.45, h*0.15).
      const sw = 80, sh = 80;
      const sx = Math.max(0, Math.floor(w * 0.45) - sw / 2);
      const sy = Math.max(0, Math.floor(h * 0.15) - sh / 2);

      const sampleVillage = () => {
        const px = new Uint8Array(4 * sw * sh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(sx, sy, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0, mx = 0;
        const count = sw * sh;
        for (let i = 0; i < count; i++) {
          const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
          const lum = r + g + b;
          sum += lum;
          if (lum > mx) mx = lum;
        }
        return { mean: sum / (count * 3), max: mx / 3 };
      };

      // Capture baseline while village is stably looping
      if (!vt.active && vRA > 0.3 && vt.prevRA > 0 && Math.abs(vRA - vt.prevRA) < 0.005) {
        const s = sampleVillage();
        vt.baseline = s.mean;
        vt.baselineMax = s.max;
      }

      // Auto-start: village regionActive dropping
      if (!vt.active && vt.prevRA > 0.1 && vt.prevRA < 0.99 && vRA < vt.prevRA - 0.005) {
        vt.active = true;
        vt.frame = 0;
        vt.prevMean = -1; vt.prevMax = -1;
        vt.peakMean = -1; vt.peakMax = -1; vt.peakFrame = -1;
        _log('%c[VillageTrace]%c ── started (baseline mean=' +
          (vt.baseline >= 0 ? vt.baseline.toFixed(1) : 'none') +
          ' max=' + (vt.baselineMax >= 0 ? vt.baselineMax.toFixed(1) : 'none') +
          ', fadeOut=' + villageFadeOut + ', sampleXY=' + sx + ',' + sy + ' ' + sw + 'x' + sh + ') ──',
          'color:#f8a;font-weight:bold', 'color:#999');
      }
      vt.prevRA = vRA;

      if (vt.active) {
        const s = sampleVillage();
        const dMean = vt.prevMean >= 0 ? s.mean - vt.prevMean : 0;
        const dMax  = vt.prevMax  >= 0 ? s.max  - vt.prevMax  : 0;
        const fromBase = vt.baseline >= 0 ? s.mean - vt.baseline : 0;
        const fromBaseMax = vt.baselineMax >= 0 ? s.max - vt.baselineMax : 0;
        const flag = (Math.abs(dMean) > 2.0 || Math.abs(dMax) > 8.0) ? ' ◀◀' : '';

        if (s.mean > vt.peakMean) { vt.peakMean = s.mean; vt.peakFrame = vt.frame; }
        if (s.max  > vt.peakMax)  { vt.peakMax  = s.max; }

        const tF = villageFadeOut ? regionActiveArr[1]
                                  : Math.max(regionActiveArr[1], villageAttraction);

        _log(
          `%c[VillageTrace]%c f=${String(vt.frame).padStart(3)} ` +
          `rA=${vRA.toFixed(4)} atr=${villageAttraction.toFixed(3)} ` +
          `fO=${villageFadeOut} tF=${tF.toFixed(3)} ` +
          `mean=${s.mean.toFixed(1)} Δm=${(dMean >= 0 ? '+' : '') + dMean.toFixed(1)} ` +
          `max=${s.max.toFixed(0)} Δmx=${(dMax >= 0 ? '+' : '') + dMax.toFixed(0)} ` +
          `fromBase=${(fromBase >= 0 ? '+' : '') + fromBase.toFixed(1)}/${(fromBaseMax >= 0 ? '+' : '') + fromBaseMax.toFixed(0)}` + flag,
          'color:#f8a', 'color:#999'
        );

        vt.prevMean = s.mean;
        vt.prevMax = s.max;
        vt.frame++;

        if (vt.frame > 360 || (vRA <= 0.001 && vt.frame > 120)) {
          vt.active = false;
          _log(
            `%c[VillageTrace]%c ── complete (peak mean=${vt.peakMean.toFixed(1)} max=${vt.peakMax.toFixed(0)} @ f${vt.peakFrame}, ` +
            `baseline mean=${vt.baseline >= 0 ? vt.baseline.toFixed(1) : 'none'} max=${vt.baselineMax >= 0 ? vt.baselineMax.toFixed(0) : 'none'}, ` +
            `Δpeak=${vt.baseline >= 0 ? (vt.peakMean - vt.baseline >= 0 ? '+' : '') + (vt.peakMean - vt.baseline).toFixed(1) : 'n/a'}/${vt.baselineMax >= 0 ? (vt.peakMax - vt.baselineMax >= 0 ? '+' : '') + (vt.peakMax - vt.baselineMax).toFixed(0) : 'n/a'}) ──`,
            'color:#f8a;font-weight:bold', 'color:#999'
          );
        }
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Render loop
  // ────────────────────────────────────────────────────────────────────────

  function render(time) {
    // Clamp dt to 1.5 frames — prevents visible particle jumps from ANY stall
    // (audio init, GC, tab switch). The animation won't "catch up" after stalls,
    // which is fine for generative art — smooth motion matters more than time accuracy.
    const dt = Math.min(
      lastFrameTime > 0 ? (time - lastFrameTime) / 16.667 : 1,
      1.5
    );

    if (beforeRender) beforeRender(dt);

    // Accumulate simulation time (seconds) for stateless vertex shader
    const dtSec = Math.min(dt * (1.0 / 60.0), 1.0 / 30.0);
    simTime += dtSec;

    // Ease vortex centers, gravity, and region values
    easeState(dt, dtSec);

    // Run sim step (transform feedback) — integrates Biot-Savart + spring-back
    runSimStep(dtSec);

    const renderStart = performance.now();
    passRender(dt);
    const renderElapsed = performance.now() - renderStart;

    frameCount++;
    const frameDelta = lastFrameTime > 0 ? time - lastFrameTime : 16.667;
    if (lastFrameTime > 0) {
      fpsAccum += 1000 / frameDelta;
      frameTimeAccum += frameDelta;
      renderTimeAccum += renderElapsed;
      if (frameDelta > 20) droppedFrames++;  // missed vsync threshold
    }
    lastFrameTime = time;

    if (frameCount % 30 === 0) {
      fps = Math.round(fpsAccum / 30);
      const avgFrameTime = frameTimeAccum / 30;
      const avgRenderTime = renderTimeAccum / 30;
      const avgGpuTime = gpuQueryCount > 0 ? gpuTimeAccum / gpuQueryCount : -1;
      const drops = droppedFrames;
      fpsAccum = 0;
      frameTimeAccum = 0;
      renderTimeAccum = 0;
      gpuTimeAccum = 0;
      gpuQueryCount = 0;
      droppedFrames = 0;
      if (onFpsUpdate) onFpsUpdate(fps);
      if (onStatsUpdate) onStatsUpdate({
        fps,
        frameTime: avgFrameTime,
        renderTime: avgRenderTime,
        gpuTime: avgGpuTime,
        pointCount,
        verticesPerSec: pointCount * fps,
        droppedFrames: drops,
      });
    }
  }

  function loop(time) {
    render(time);
    // _logSpeedScintDebug();  // disabled — easing/scintillation debug resolved
    animFrameId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (animFrameId !== null) return;
    lastFrameTime = 0;
    frameCount = 0;
    fpsAccum = 0;
    animFrameId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (animFrameId !== null) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  // ── Speed scintillation debug sampler ──
  // Logs lifecycle state for 10 red + 10 non-red flow particles every 500ms.
  // Replicates shader logic on CPU to show driftT, sizeEnvelope, activation, etc.
  let _debugSamples = null;  // cached particle indices: {red: [...], nonRed: [...]}
  let _lastDebugLog = 0;
  const SPEED_DEBUG = true;  // set false to disable

  function _buildDebugSamples() {
    if (!homePosData || !regionIdData || !coherenceData) return null;
    const red = [], nonRed = [];
    // Shader hashes replicated in JS
    function fract(x) { return x - Math.floor(x); }
    function dot2(ax, ay, bx, by) { return ax * bx + ay * by; }
    function shaderHash(hx, hy, sx, sy, m) {
      return fract(Math.sin(dot2(hx, hy, sx, sy)) * m);
    }
    for (let i = 0; i < pointCount && (red.length < 10 || nonRed.length < 10); i++) {
      const rid = Math.round(regionIdData[i]);
      if (rid !== 3 && rid !== 4) continue;  // flow regions only
      const coh = coherenceData[i];
      if (coh < flowThreshold) continue;  // must pass threshold
      const hx = homePosData[i * 2], hy = homePosData[i * 2 + 1];
      // Speed hash (same as shader: effectively we can't compute exact effectiveSpeed
      // without curvature/boundary textures, but we CAN check the selection hash)
      const scintHash = shaderHash(hx, hy, 41.31, 67.97, 29174.5);
      const isRedCandidate = scintHash < 0.50;
      if (isRedCandidate && red.length < 10) {
        red.push({ idx: i, hx, hy, coh, scintHash });
      } else if (!isRedCandidate && nonRed.length < 10) {
        nonRed.push({ idx: i, hx, hy, coh, scintHash });
      }
    }
    return { red, nonRed };
  }

  function _logSpeedScintDebug() {
    if (!SPEED_DEBUG || !homePosData) return;
    if (!_debugSamples) _debugSamples = _buildDebugSamples();
    if (!_debugSamples) return;

    const now = performance.now();
    if (now - _lastDebugLog < 500) return;
    _lastDebugLog = now;

    function fract(x) { return x - Math.floor(x); }
    function dot2(ax, ay, bx, by) { return ax * bx + ay * by; }
    function smoothstep(edge0, edge1, x) {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    }

    // flowMix matches GPU uniform: independent activation gate
    const flowMix = flowMixEased;

    // Replicate shader lifecycle for each sampled particle
    function getLifecycleState(hx, hy) {
      // Phase hash uses a_spiralPos in shader — we approximate with homePos
      const phase = fract(Math.sin(dot2(hx, hy, 12.9898, 78.233)) * 43758.5453);
      const t = fract((simTime + phase * flowCyclePeriod) / flowCyclePeriod);
      const driftFrac = flowDriftFrac;
      const inDrift = t < driftFrac;
      const driftT = inDrift ? t / driftFrac : -1;

      if (!inDrift) {
        return { t, driftT: -1, phase: 'DEAD', progress: 0, lifecycleAlpha: 0,
                 sizeEnvelope: 0, activation: 0, fadeIn: 0, fadeOut: 0 };
      }

      const fadeIn  = smoothstep(0.0, 0.08, driftT);
      const fadeOut = 1.0 - smoothstep(0.80, 1.0, driftT);
      const lifecycleAlpha = fadeIn * fadeOut;
      const progress = smoothstep(0, 1, smoothstep(0, 1, driftT));
      // Scintillation envelope (our custom one)
      const sizeEnvelope = smoothstep(0.0, 0.20, driftT) * (1.0 - smoothstep(0.45, 0.75, driftT));

      // We can't compute exact effectiveSpeed without GPU textures,
      // but we know it's > 0.5 for red candidates. Use 0.8 as estimate.
      const estSpeed = 0.8;
      // scintGate = sizeEnvelope * flowMix³  (matches GPU shader cubic gate)
      const flowMixCub = flowMix * flowMix * flowMix;
      const scintGate = sizeEnvelope * flowMixCub;
      const activation = smoothstep(0.5, 1.0, estSpeed) * scintGate;

      return { t: +t.toFixed(4), driftT: +driftT.toFixed(4), phase: 'DRIFT',
               progress: +progress.toFixed(3), lifecycleAlpha: +lifecycleAlpha.toFixed(3),
               sizeEnvelope: +sizeEnvelope.toFixed(3), activation: +activation.toFixed(3),
               fadeIn: +fadeIn.toFixed(3), fadeOut: +fadeOut.toFixed(3) };
    }

    // Compact per-particle lines — show 3 red + 3 non-red, values change each log
    function fmt(label, p, isRed) {
      const s = getLifecycleState(p.hx, p.hy);
      // Non-red particles never enter the scintillation block on GPU — activation is always 0
      const activ = isRed ? s.activation : 0;
      return `  ${label} (${p.hx.toFixed(2)},${p.hy.toFixed(2)}) ` +
        `phase=${s.phase.padEnd(5)} driftT=${String(s.driftT).padStart(6)} ` +
        `progress=${String(s.progress).padStart(5)} ` +
        `lcAlpha=${String(s.lifecycleAlpha).padStart(5)} ` +
        `sizeEnv=${String(isRed ? s.sizeEnvelope : 0).padStart(5)} ` +
        `activ=${String(activ).padStart(5)} ` +
        `fadeIn=${String(s.fadeIn).padStart(5)} fadeOut=${String(s.fadeOut).padStart(5)}`;
    }

    const lines = [
      `[SpeedScint] t=${simTime.toFixed(2)}s  flowMix=${flowMix.toFixed(3)}  cyclePeriod=${flowCyclePeriod}s  driftFrac=${flowDriftFrac}`
    ];
    for (let i = 0; i < Math.min(3, _debugSamples.red.length); i++) {
      lines.push(fmt(`RED#${i}`, _debugSamples.red[i], true));
    }
    for (let i = 0; i < Math.min(3, _debugSamples.nonRed.length); i++) {
      lines.push(fmt(`flow#${i}`, _debugSamples.nonRed[i], false));
    }
    _log(lines.join('\n'));
  }

  function resize(width, height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }

  function destroy() {
    stopLoop();
    if (paintingTex)         gl.deleteTexture(paintingTex);
    if (tonalTex)            gl.deleteTexture(tonalTex);
    if (boundaryTex)         gl.deleteTexture(boundaryTex);
    if (regionMapTex)        gl.deleteTexture(regionMapTex);
    if (clickRemapTex)       gl.deleteTexture(clickRemapTex);
    if (distPackTex)         gl.deleteTexture(distPackTex);
    if (homePosBuffer)       gl.deleteBuffer(homePosBuffer);
    if (spiralPosBuffer)     gl.deleteBuffer(spiralPosBuffer);
    if (colorBuffer)         gl.deleteBuffer(colorBuffer);
    if (regionIdBuffer)      gl.deleteBuffer(regionIdBuffer);
    if (boundaryDistBuffer)  gl.deleteBuffer(boundaryDistBuffer);
    if (simBufA)             gl.deleteBuffer(simBufA);
    if (simBufB)             gl.deleteBuffer(simBufB);
    if (vaoSimA)             gl.deleteVertexArray(vaoSimA);
    if (vaoSimB)             gl.deleteVertexArray(vaoSimB);
    if (tfObj)               gl.deleteTransformFeedback(tfObj);
    if (vaoRender)           gl.deleteVertexArray(vaoRender);
    if (fboA) { gl.deleteFramebuffer(fboA); gl.deleteTexture(texA); }
    if (fboB) { gl.deleteFramebuffer(fboB); gl.deleteTexture(texB); }
    if (fboC) { gl.deleteFramebuffer(fboC); gl.deleteTexture(texC); }
    if (fboD) { gl.deleteFramebuffer(fboD); gl.deleteTexture(texD); }
    if (vaoQuad) gl.deleteVertexArray(vaoQuad);
    if (quadBuf) gl.deleteBuffer(quadBuf);
    gl.deleteProgram(renderProg);
    if (_debugRenderProg) gl.deleteProgram(_debugRenderProg);
    gl.deleteProgram(compositeProg);
    if (simProg) gl.deleteProgram(simProg);
    if (shadowProg) gl.deleteProgram(shadowProg);
    if (vaoShadow) gl.deleteVertexArray(vaoShadow);
    if (gpuBlurProg) gl.deleteProgram(gpuBlurProg);
    if (gpuBlurVAO)  gl.deleteVertexArray(gpuBlurVAO);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Test draw — flush deferred shader compilation and check for GPU errors
  // ────────────────────────────────────────────────────────────────────────
  function testDraw() {
    // Context may have been lost during shader compilation
    if (gl.isContextLost()) return false;

    // Clear any stale errors
    while (gl.getError() !== gl.NO_ERROR) {}

    // Bind ALL active render shader attributes to a real buffer.
    // Metal requires every active vertex attribute to have a buffer binding
    // in the MTLVertexDescriptor — disabled attributes using generic constant
    // values rely on ANGLE's under-tested default-attributes emulation path,
    // which fails on Intel/AMD Macs (GL_INVALID_OPERATION false positive).
    // A shared zero buffer for all attributes avoids this entirely.
    const testBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, testBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(16), gl.STATIC_DRAW);

    const testVao = gl.createVertexArray();
    gl.bindVertexArray(testVao);

    // Use whichever render program is ready — mini for fast testDraw at init,
    // full after finalization. Both share the same attribute interface.
    const testProg = _renderFinalized ? renderProg : miniRenderProg;
    const attrNames = ['a_homePos', 'a_spiralPos', 'a_color', 'a_regionId',
      'a_boundaryDist', 'a_simPos', 'a_coherence', 'a_flowAngle'];
    const attrSizes = [2, 2, 3, 1, 1, 2, 1, 1];
    for (let i = 0; i < attrNames.length; i++) {
      const loc = gl.getAttribLocation(testProg, attrNames[i]);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, attrSizes[i], gl.FLOAT, false, 0, 0);
      }
    }

    gl.viewport(0, 0, 1, 1);
    gl.useProgram(testProg);
    gl.drawArrays(gl.POINTS, 0, 1);
    gl.flush();
    gl.finish();  // block until GPU completes — surfaces Metal errors

    const err = gl.getError();

    // Cleanup
    gl.bindVertexArray(null);
    gl.deleteVertexArray(testVao);
    gl.deleteBuffer(testBuf);
    if (canvas.width && canvas.height) gl.viewport(0, 0, canvas.width, canvas.height);

    // Context may have been lost during the draw/finish
    if (gl.isContextLost()) return false;

    return err === gl.NO_ERROR;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────

  return {
    testDraw,
    finalizeRenderProg: _finalizeRenderProg,
    finalizeOtherPrograms: _finalizeOtherPrograms,
    get renderFinalized() { return _renderFinalized; },
    get otherProgramsFinalized() { return _otherProgramsFinalized; },
    get fboHealthy() { return _fboHealthy; },
    loadPoints,
    uploadPaintingTexture,
    uploadTonalTexture,
    uploadBoundaryTexture,
    uploadRegionMapTexture,
    uploadClickRemapTexture,
    uploadDistancePackTexture,
    uploadCypressFlowTexture,
    uploadFlowCurvatureTexture,
    uploadFlowFieldTexture,
    gpuBlur,
    startLoop,
    stopLoop,
    resize,
    destroy,

    setResolutionScale(s) { resScale = s; },
    setOnFpsUpdate(fn) { onFpsUpdate = fn; },
    setOnStatsUpdate(fn) { onStatsUpdate = fn; },
    setBeforeRender(fn) { beforeRender = fn; },
    // Adaptive particle fraction (Phase 1 iPad fix). frac in [0.1, 1.0].
    // Combined with the within-region shuffle in loadPoints, smaller fractions
    // give uniform spatial thinning. Effective particle count at next frame =
    // round(pointCount * frac). Zero CPU cost — single number, no buffer change.
    setParticleFraction(frac) {
      _particleDrawFraction = Math.max(0.1, Math.min(1.0, frac));
    },
    getParticleFraction() { return _particleDrawFraction; },
    getPointCount() { return pointCount; },

    // Flashlight
    setFlashTrail(data) { flashTrailData.set(data); },
    setFlashRadius(r) { flashRadius = r; },
    setFlashDecay(d) { flashDecay = d; },
    getPaintingMargin() { return paintingMargin; },
    getBorderRadius() { return borderRadius; },

    // Flashlight drift
    setDriftAmount(v)         { driftAmount = v; },
    setDriftSpeed(v)          { driftSpeed = v; },
    setDriftMouseSpeed(v)     { driftMouseSpeed = v; },
    setDriftMouseInfluence(v) { driftMouseInfluence = v; },
    setDriftCenter(x, y)      { driftCenterX = x; driftCenterY = y; },
    setDriftActive(v)         { driftActive = v; },
    setDriftMaxCap(v)         { driftMaxCap = v; },

    setHoverHighlight2(r0, i0, cx0, cy0, ft0, r1, i1, cx1, cy1, ft1) {
      hoverRegion0 = r0; hoverIntensity0 = i0; hoverCenterX0 = cx0; hoverCenterY0 = cy0;
      hoverFreezeTime0 = ft0 ?? -1;
      hoverRegion1 = r1; hoverIntensity1 = i1; hoverCenterX1 = cx1; hoverCenterY1 = cy1;
      hoverFreezeTime1 = ft1 ?? -1;
    },
    /** Get current simTime (for freezing hover orbit direction). */
    getSimTime() { return simTime; },
    setSimSpringK(v) { simSpringK = Math.max(0.1, v); },
    getSimSpringK() { return simSpringK; },
    /** Reset sim buffers to home position (clear all accumulated drift) */
    resetSimBuffers() {
      if (simBufA && homePosBuffer) {
        gl.bindBuffer(gl.COPY_READ_BUFFER, homePosBuffer);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, simBufA);
        gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, pointCount * 2 * 4);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, simBufB);
        gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, pointCount * 2 * 4);
        simSrc = 0;
      }
    },

    setSwell(v) { swell = v; },
    setVortexDragging(id, dragging) {
      const v = vortexById.get(id);
      if (v) v.isDragging = !!dragging;
    },
    setLuminancePreserve(v) { lumPreserve = v; },
    setBaseAlpha(v) { baseAlpha = v; },
    getBaseAlpha() { return baseAlpha; },
    /** End intro mode with immediate cut (no animation). */
    endIntroMode() {
      introModeActive = false;
      revealActive = false;
      introGlow = 0.0;
    },
    /** Set intro center glow intensity (0-1). */
    setIntroDanceScale(v) { introDanceScale = v; if (introModeActive) introDanceEased = v; },
    getIntroDanceScale() { return introDanceScale; },
    getIntroDanceEased() { return introDanceEased; },
    setIntroGlow(v) { introGlow = v; },
    getIntroGlow() { return introGlow; },
    /** Set intro center glow radius in canvas pixels. */
    setIntroGlowRadius(v) { introGlowRadius = v; },
    /**
     * Start reveal animation: expanding circle from click point.
     * @param {number} cx - click X in canvas pixels (gl_FragCoord space)
     * @param {number} cy - click Y in canvas pixels (gl_FragCoord space)
     * @param {number} duration - reveal duration in seconds (default 1.5)
     * @param {function} onComplete - called when reveal finishes
     */
    startReveal(cx, cy, duration = 1.5, onComplete) {
      revealCenterX = cx;
      revealCenterY = cy;
      // Vignette open: start from current glow radius, expand to full canvas
      revealStartGlowRadius = introGlowRadius;
      revealRadius = 0;
      revealBrightness = 0.4;
      // Max radius = canvas diagonal + overshoot for full coverage
      const diag = Math.sqrt(canvas.width ** 2 + canvas.height ** 2);
      revealMaxRadius = diag * 0.6 + 100; // glow needs to cover to corners
      // Speed for vignette expansion
      revealSpeed = revealMaxRadius / (duration * 0.65);
      revealBrightDuration = duration * 1.2; // brightness lags behind radius
      revealElapsed = 0;
      revealActive = true;
      revealCallback = onComplete || null;
    },
    /** Check if intro mode is active. */
    isIntroMode() { return introModeActive || introModeFading; },

    setGlobalVortexTrail(v) { vortexTrailGlobal = Math.max(0, Math.min(1, v)); },
    getGlobalVortexTrail() { return vortexTrailGlobal; },
    setTrailLinesAlpha(v) { trailLinesAlpha = Math.max(0, Math.min(1, v)); },
    getTrailLinesAlpha() { return trailLinesAlpha; },
    /** Clear both trail FBOs. Call when stars deactivate to remove burn-in
     *  from vortex-displaced particles in region 3/4 pixel positions.
     *  Clears both B and C to handle the ping-pong — stale data in either
     *  would resurface on the next swap. */
    clearTrailBuffer() {
      gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
      if (fboB) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (fboC) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboC);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    setStarTrails(enabled) {
      starTrailsActive = !!enabled;
      // Clear trail buffer so old burn-in doesn't linger across toggles
      if (fboB) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
        gl.clearColor(canvasColor[0], canvasColor[1], canvasColor[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    },
    getStarTrails() { return starTrailsActive; },
    setDebugMode(v) {
      debugMode = v;
      // Compile debug shader on first use (V key press with mode > 0)
      if (v > 0) _ensureDebugRenderProg();
    },
    getDebugMode() { return debugMode; },
    setFlowSpeed(v) { flowSpeed = Math.max(0, v); },
    getFlowSpeed() { return flowSpeed; },
    setFlowActive(v) {
      flowActive = !!v;
    },
    getFlowActive() { return flowActive; },
    setFlowDriftFrac(v) { flowDriftFrac = Math.max(0.3, Math.min(1.0, v)); },
    getFlowDriftFrac() { return flowDriftFrac; },
    setFlowCyclePeriod(v) { flowCyclePeriod = Math.max(1.0, Math.min(15.0, v)); },
    getFlowCyclePeriod() { return flowCyclePeriod; },
    setFlowThreshold(v) { flowThreshold = Math.max(0.01, Math.min(0.50, v)); },
    getFlowThreshold() { return flowThreshold; },
    setFlowMaxDrift(v) { flowMaxDrift = Math.max(0.001, Math.min(0.100, v)); },
    getFlowMaxDrift() { return flowMaxDrift; },
    setFlowCursorUV(x, y) { flowCursorUV[0] = x; flowCursorUV[1] = y; },
    setFlowCursorDir(x, y) { flowCursorDir[0] = x; flowCursorDir[1] = y; },
    setFlowCursorInfluence(v) { flowCursorInfluence = Math.max(0, Math.min(1, v)); },
    setFlowCursorRadius(v) { flowCursorRadius = Math.max(0.01, Math.min(0.5, v)); },
    setVortexCursorAngVel(idx, v) { if (idx >= 0 && idx < MAX_VORTICES) vortexCursorSpeedMult[idx] = v; },
    getVortexCursorAngVel(idx) { return idx >= 0 && idx < MAX_VORTICES ? vortexCursorSpeedMult[idx] : 0; },
    /** Call each frame to integrate cursor angular velocity into phase offset */
    integrateVortexCursorPhase(dtSec) {
      for (let i = 0; i < vortices.length; i++) {
        vortexCursorPhaseOffset[i] += vortexCursorSpeedMult[i] * dtSec;
        if (vortexCursorPhaseOffset[i] > 6.2832) vortexCursorPhaseOffset[i] -= 6.2832;
      }
    },
    setStarCursorUV(x, y) { starCursorUV[0] = x; starCursorUV[1] = y; },
    setStarCursorInfluence(v) { starCursorInfluence = Math.max(0, Math.min(1, v)); },
    setStarBumpStrength(v) { starBumpStrength = v; },
    setStarPushRadius(v) { starPushRadius = v; },
    setStarTrailPersist(v) { starTrailPersist = v; },
    setFlowEdgeDepth(v) { flowEdgeDepth = Math.max(1.0, Math.min(100.0, v)); },
    getFlowEdgeDepth() { return flowEdgeDepth; },
    setAbsorptionThreshold(v) { absorptionThreshold = Math.max(0.0, Math.min(1.0, v)); },
    getAbsorptionThreshold() { return absorptionThreshold; },
    setFlowSpeedFloor(v) { flowSpeedFloor = Math.max(0.0, Math.min(1.0, v)); },
    getFlowSpeedFloor() { return flowSpeedFloor; },
    setGustAmplitude(v) { gustAmplitude = Math.max(0.0, Math.min(1.0, v)); },
    getGustAmplitude() { return gustAmplitude; },
    setSkyGustAmplitude(v) { skyGustAmplitude = Math.max(0, Math.min(2.0, v)); },
    getSkyGustAmplitude() { return skyGustAmplitude; },
    setSkyMaxDrift(v) { skyMaxDrift = Math.max(0, Math.min(0.03, v)); },
    getSkyMaxDrift() { return skyMaxDrift; },
    setSkyGustTrailPersist(v) { skyGustTrailPersist = Math.max(0, Math.min(0.995, v)); },
    getSkyGustTrailPersist() { return skyGustTrailPersist; },
    setSkySwayAmount(v) { skySwayAmount = Math.max(0, Math.min(1.0, v)); },
    getSkySwayAmount() { return skySwayAmount; },
    setSkyStarShimmer(v) { skyStarShimmer = Math.max(0, Math.min(1.0, v)); },
    getSkyStarShimmer() { return skyStarShimmer; },
    // Night Sky cursor wake
    setNsWakeTrail(data) { nsWakeTrailData.set(data); },
    setNsWakeCursorUV(u, v) { nsWakeCursorUV[0] = u; nsWakeCursorUV[1] = v; },
    setNsWakeCursorInfluence(v) { nsWakeCursorInfluence = v; },
    setNsWakeRadius(v) { nsWakeRadius = v; },
    setNsWakeDecay(v) { nsWakeDecay = v; },
    setNsWakeGustBoost(v) { nsWakeGustBoost = v; },
    setNsWakePushStrength(v) { nsWakePushStrength = v; },
    setNsWakePushInfluence(v) { nsWakePushInfluence = v; },  // speed-damped influence for FBO drain
    setFlowTwinkle(v) { flowTwinkle = Math.max(0, Math.min(1.0, v)); },
    getFlowTwinkle() { return flowTwinkle; },
    setCypressSwayAmp(v) { cypressSwayAmp = Math.max(0, Math.min(3.0, v)); },
    getCypressSwayAmp() { return cypressSwayAmp; },
    setVillageWindAmp(v) { villageWindAmp = Math.max(0, Math.min(0.05, v)); },
    getVillageWindAmp() { return villageWindAmp; },
    setVillageWindFreq(v) { villageWindFreq = Math.max(1, Math.min(60, v)); },
    getVillageWindFreq() { return villageWindFreq; },
    setVillageWindSpeed(v) { villageWindSpeed = Math.max(0, Math.min(10, v)); },
    getVillageWindSpeed() { return villageWindSpeed; },
    setVillageWindAngle(v) { villageWindAngle = v; },
    getVillageWindAngle() { return villageWindAngle; },
    setVillageSwayAngle(v) { villageSwayAngle = Math.max(0, Math.min(1, v)); },
    getVillageSwayAngle() { return villageSwayAngle; },
    setVillageEdgeDepth(v) { villageEdgeDepth = Math.max(0, Math.min(80, v)); },
    getVillageEdgeDepth() { return villageEdgeDepth; },
    setVillageLumParallax(v) { villageLumParallax = Math.max(0, Math.min(1, v)); },
    getVillageLumParallax() { return villageLumParallax; },
    setVillageTwinkle(v) { villageTwinkle = Math.max(0, Math.min(1, v)); },
    getVillageTwinkle() { return villageTwinkle; },
    setVillageTwinkleWarmth(v) { villageTwinkleWarmth = Math.max(-0.5, Math.min(0.5, v)); },
    getVillageTwinkleWarmth() { return villageTwinkleWarmth; },
    setVillageBreathPhase(v) { villageBreathPhase = v; },
    getVillageBreathPhase() { return villageBreathPhase; },
    setVillageBreathDepth(v) { villageBreathDepth = Math.max(0, Math.min(1, v)); },
    getVillageBreathDepth() { return villageBreathDepth; },
    setVillageNoiseAmp(v) { villageNoiseAmp = Math.max(0, Math.min(3, v)); },
    getVillageNoiseAmp() { return villageNoiseAmp; },
    setVillageNoiseDrift(v) { villageNoiseDrift = Math.max(0, Math.min(0.02, v)); },
    getVillageNoiseDrift() { return villageNoiseDrift; },
    setVillageCrossSway(v) { villageCrossSway = Math.max(0, Math.min(1, v)); },
    getVillageCrossSway() { return villageCrossSway; },
    setVillageTrailPersist(v) { villageTrailPersist = Math.max(0, Math.min(0.95, v)); },
    getVillageTrailPersist() { return villageTrailPersist; },
    setVillageWindCenter(x, y) { villageWindCenterX = x; villageWindCenterY = y; },
    setVillageWindRadius(v) { villageWindRadius = Math.max(0.02, Math.min(0.30, v)); },
    getVillageWindRadius() { return villageWindRadius; },
    setVillageAttraction(v) { villageAttraction = Math.max(0, Math.min(1, v)); },
    getVillageAttraction() { return villageAttraction; },
    setVillageWindRadiusActive(v) { villageWindRadiusActive = v; },
    setVillageCursorMoving(v) { villageCursorMoving = v; },
    setVillageAttractionAmpActive(v) { villageAttractionAmpActive = v; },
    setVillageWindBlend(v) { villageWindBlendVal = v; },
    setVillageExitPoint(x, y) { villageExitPointX = x; villageExitPointY = y; },
    setVillageWindRippleRadius(v) { villageWindRippleRadius = v; },
    setSwarmDriftFracSmoothed(v) { swarmDriftFracSmoothed = v; },
    setVillageAttractionAmp(v) { villageAttractionAmp = Math.max(0, Math.min(0.05, v)); },
    getVillageAttractionAmp() { return villageAttractionAmp; },
    setVillageSwarmTime(v) { villageSwarmTime = v; },
    setSwarmCyclePeriodMin(v) { swarmCyclePeriodMin = v; },
    setSwarmCyclePeriodMax(v) { swarmCyclePeriodMax = v; },
    setSwarmDriftFrac(v) { swarmDriftFrac = v; },
    getSwarmDriftFrac() { return swarmDriftFrac; },
    setSwarmEarlyDeathPct(v) { swarmEarlyDeathPct = v; },
    setSwarmDeathFadeWidth(v) { swarmDeathFadeWidth = v; },
    setSwarmMaxDriftMul(v) { swarmMaxDriftMul = v; },
    setSwarmFadeIn(v) { swarmFadeIn = v; },
    setSwarmFadeOutStart(v) { swarmFadeOutStart = v; },
    setSwarmFixedPeriod(v) { swarmFixedPeriod = Math.max(0, v); },
    setSwarmPhaseSpread(v) { swarmPhaseSpread = Math.max(0, Math.min(1, v)); },
    setSwarmLfoSync(v) { swarmLfoSync = v ? 1 : 0; },
    setVillageClickOrigin(x, y) { villageClickOriginX = x; villageClickOriginY = y; },
    setVillageTopY(v) { villageTopY = v; },
    setVillageBottomY(v) { villageBottomY = v; },
    // uploadVillageEdgeTexture replaced by uploadDistancePackTexture (G4)
    setCypressMaxDrift(v) { cypressMaxDrift = Math.max(0, Math.min(0.024, v)); },
    getCypressMaxDrift() { return cypressMaxDrift; },
    setCypressTopY(v) { cypressTopY = Math.max(0, Math.min(0.5, v)); },
    getCypressTopY() { return cypressTopY; },
    setCypressBaseY(v) { cypressBaseY = Math.max(0.5, Math.min(1.0, v)); },
    getCypressBaseY() { return cypressBaseY; },
    setCypressBaseRatio(v) { cypressBaseRatio = Math.max(0, Math.min(0.5, v)); },
    getCypressBaseRatio() { return cypressBaseRatio; },
    setCypressCrossSway(v) { cypressCrossSway = Math.max(0, Math.min(1.0, v)); },
    getCypressCrossSway() { return cypressCrossSway; },
    setCypressBreathPeriod(v) { cypressBreathPeriod = Math.max(5, Math.min(40, v)); },
    getCypressBreathPeriod() { return cypressBreathPeriod; },
    setCypressSwayAngle(v) { cypressSwayAngle = Math.max(0, Math.min(1, v)); },
    getCypressSwayAngle() { return cypressSwayAngle; },
    setCypressEdgeDepth(v) { cypressEdgeDepth = Math.max(5, Math.min(80, v)); },
    getCypressEdgeDepth() { return cypressEdgeDepth; },
    setCypressRimWidth(v) { cypressRimWidth = Math.max(5, Math.min(80, v)); },
    getCypressRimWidth() { return cypressRimWidth; },
    setCypressFlowCyclePeriod(v) { cypressFlowCyclePeriod = Math.max(1, Math.min(15, v)); },
    getCypressFlowCyclePeriod() { return cypressFlowCyclePeriod; },
    setCypressFlowDriftFrac(v) { cypressFlowDriftFrac = Math.max(0.1, Math.min(0.9, v)); },
    getCypressFlowDriftFrac() { return cypressFlowDriftFrac; },
    setCypressFlowMaxDrift(v) { cypressFlowMaxDrift = Math.max(0.001, Math.min(0.050, v)); },
    getCypressFlowMaxDrift() { return cypressFlowMaxDrift; },
    setCypressFlowGustAmp(v) { cypressFlowGustAmp = Math.max(0, Math.min(1, v)); },
    getCypressFlowGustAmp() { return cypressFlowGustAmp; },
    setCypressCanopyGlow(v) { cypressCanopyGlow = Math.max(0, Math.min(1.0, v)); },
    getCypressCanopyGlow() { return cypressCanopyGlow; },
    setCypressLeafFlash(v) { cypressLeafFlash = Math.max(0, Math.min(1.0, v)); },
    getCypressLeafFlash() { return cypressLeafFlash; },
    setCypressRimGlow(v) { cypressRimGlow = Math.max(0, Math.min(1.0, v)); },
    getCypressRimGlow() { return cypressRimGlow; },
    setCypressTrailPersist(v) { cypressTrailPersist = Math.max(0, Math.min(0.95, v)); },
    getCypressTrailPersist() { return cypressTrailPersist; },
    setSwirlTrailPersist(v) { swirlTrailPersist = Math.max(0, Math.min(0.95, v)); },
    getSwirlTrailPersist() { return swirlTrailPersist; },
    setCypressWindBias(v) { cypressWindBias = Math.max(-1, Math.min(1, v)); },
    getCypressWindBias() { return cypressWindBias; },
    setEddyContrast(v) { eddyContrast = Math.max(0.0, Math.min(1.0, v)); },
    getEddyContrast() { return eddyContrast; },
    addVortex(x, y, sign = 1.0, strength = 1.0, gravity = 0.0004, { dormant = false } = {}) {
      if (vortices.length >= MAX_VORTICES) return -1;
      // Reset sim clock when placing the first vortex so rotation
      // starts from zero instead of jumping to a huge accumulated angle.
      // Skip for dormant (pre-placed) vortices so the reset is preserved
      // for the first real activation (H-key choreography, Y-key, click).
      if (vortices.length === 0 && !dormant) simTime = 0;
      const id = nextVortexId++;
      // Fade duration scales with gravity (sqrt mapping to spread small values):
      // sqrt(0.00001/0.005)≈0.04 → ~1.0s, sqrt(0.0002/0.005)≈0.20 → ~1.8s, sqrt(1.0)=1.0 → 6.0s
      const fd = FADE_MIN + (FADE_MAX - FADE_MIN) * Math.sqrt(Math.min(gravity / GRAVITY_CAP, 1.0));
      vortices.push({
        id, centerTarget: [x, y], centerCurrent: [x, y],
        sign, strength, isDragging: false,
        gravity,                 // per-vortex gravity (0–0.005)
        gravityCurrent: 0,  // start at 0 so vortex grows in smoothly via easeState()
        fadeDuration: fd,        // per-vortex fade-in time (seconds)
        gravityEase: GRAVITY_EASE * (FADE_MAX / fd),  // faster ease for smaller vortices
        speed: 0.15,             // per-vortex rotation speed (0–2.5)
        birthTime: simTime,      // when this vortex was created (for color fade-in)
        // Per-vortex art params — eased from dramatic entry values toward target
        armTightness: 1.0,            // current (eased) — starts at max for dramatic spiral
        armTightnessTarget: armTightness,  // target value to settle into
        armCurl: 3.0,                 // current (eased) — starts at max curl
        armCurlTarget: armCurl,       // target value to settle into
        curlAmount,
        trail: trailScale,
        isRemoving: false,
        removalScale: 1.0,  // radius multiplier during removal (1.0→0.0)
        releaseDuration: 3.0,    // tunable release time (seconds)
        strengthAtRemoval: 0,    // snapshot of strength when release begins
        speedAtRemoval: 0,       // snapshot of speed when release begins
        gravityAtRemoval: 0,     // snapshot of gravityCurrent when release begins
        presetParams: null,  // STAR_PRESET art targets for dormant→active activation
        active: false,       // dormant until Stars click activates
        activationTime: 0,   // performance.now() when activated (for ramp-up)
      });
      vortexById.set(id, vortices[vortices.length - 1]);
      return id;
    },
    removeVortex(id) {
      const v = vortexById.get(id);
      if (!v || v.isRemoving) return false;
      v.isRemoving = true;
      v.removalTime = simTime;
      v.strengthAtRemoval = v.strength;
      v.speedAtRemoval = v.speed;
      v.gravityAtRemoval = v.gravityCurrent;
      return true;
    },
    moveVortex(id, x, y) {
      const v = vortexById.get(id);
      if (v) { v.centerTarget[0] = x; v.centerTarget[1] = y; }
    },
    findNearestVortex(x, y) {
      if (vortices.length === 0) return null;
      const ar = canvas.width / canvas.height || 1;
      let bestId = -1, bestDist = Infinity;
      for (const v of vortices) {
        if (v.isRemoving) continue;  // skip dying vortices
        const dx = (x - v.centerCurrent[0]) * ar;
        const dy = y - v.centerCurrent[1];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDist) { bestDist = d; bestId = v.id; }
      }
      return bestId === -1 ? null : { id: bestId, dist: bestDist };
    },
    clearVortices() {
      for (const v of vortices) {
        if (!v.isRemoving) {
          v.isRemoving = true;
          v.removalTime = simTime;
          v.strengthAtRemoval = v.strength;
          v.speedAtRemoval = v.speed;
          v.gravityAtRemoval = v.gravityCurrent;
        }
      }
    },
    /** Instant wipe — used when placing fresh preset (Y key) */
    forceRemoveAll() { vortices.length = 0; vortexById.clear(); },
    getVortexCount() { return vortices.length; },
    setVortexStrength(id, strength) {
      const v = vortexById.get(id);
      if (v) v.strength = Math.max(0, Math.min(2, strength));
    },
    getVortexStrength(id) {
      const v = vortexById.get(id);
      return v ? v.strength : 1.0;
    },
    setVortexGravity(id, g) {
      const v = vortexById.get(id);
      if (v) v.gravity = Math.max(0, Math.min(0.005, g));
    },
    getVortexGravity(id) {
      const v = vortexById.get(id);
      return v ? v.gravity : 0.0004;
    },
    getVortexGravityCurrent(id) {
      const v = vortexById.get(id);
      return v ? v.gravityCurrent : 0;
    },
    setVortexSpeed(id, s) {
      const v = vortexById.get(id);
      if (v) v.speed = Math.max(0, Math.min(2.5, s * (_isRadiantActive ? 1.2 : 1.0)));
    },
    getVortexSpeed(id) {
      const v = vortexById.get(id);
      return v ? v.speed : 0.15;
    },
    setVortexArmTightness(id, v) {
      const vo = vortexById.get(id);
      if (vo) {
        const clamped = Math.max(0, Math.min(1, v));
        vo.armTightnessTarget = clamped;
        // Snap current below target to prevent slow lingering from dramatic entry values
        if (vo.armTightness > clamped) vo.armTightness = clamped;
      }
    },
    getVortexArmTightness(id) { const vo = vortexById.get(id); return vo ? vo.armTightnessTarget : armTightness; },
    setVortexArmCurl(id, v) {
      const vo = vortexById.get(id);
      if (vo) {
        const clamped = Math.max(0, Math.min(3, v));
        vo.armCurlTarget = clamped;
        // Snap current below target to prevent slow lingering from dramatic entry values
        if (vo.armCurl > clamped) vo.armCurl = clamped;
      }
    },
    getVortexArmCurl(id) { const vo = vortexById.get(id); return vo ? vo.armCurlTarget : armCurl; },
    setVortexTurbulence(id, v) { const vo = vortexById.get(id); if (vo) vo.curlAmount = Math.max(0, Math.min(0.0025, v)); },
    getVortexTurbulence(id) { const vo = vortexById.get(id); return vo ? vo.curlAmount : curlAmount; },
    /**
     * Override a vortex's fade-in duration (seconds).
     * Also recalculates gravityEase to match the new duration.
     */
    setVortexFadeDuration(id, duration) {
      const vo = vortexById.get(id);
      if (vo) {
        vo.fadeDuration = Math.max(0.1, duration); // floor at 100ms
        vo.gravityEase = GRAVITY_EASE * (FADE_MAX / vo.fadeDuration);
      }
    },
    /** Reset birth time to current simTime — rotation starts from zero */
    resetVortexBirthTime(id) {
      const vo = vortexById.get(id);
      if (vo) vo.birthTime = simTime;
    },
    getVortexFadeDuration(id) { const vo = vortexById.get(id); return vo ? vo.fadeDuration : 1.0; },
    setVortexPresetParams(id, params) {
      const v = vortexById.get(id);
      if (v) v.presetParams = params;
    },
    getVortexPresetParams(id) {
      const v = vortexById.get(id);
      return v ? v.presetParams : null;
    },
    getVortices() {
      // Pre-allocated DTOs updated in-place — eliminates 12 object allocs per frame (fix #2)
      // Still allocates one small array via slice() for safe iteration by callers.
      const n = vortices.length;
      for (let i = 0; i < n; i++) {
        const v = vortices[i], d = _vortexDTOs[i];
        d.id = v.id; d.x = v.centerCurrent[0]; d.y = v.centerCurrent[1];
        d.sign = v.sign; d.strength = v.strength;
        d.gravity = v.gravity; d.speed = v.speed;
        d.armTightness = v.armTightnessTarget; d.armCurl = v.armCurlTarget;
        d.curlAmount = v.curlAmount; d.trail = v.trail;
      }
      return _vortexDTOs.slice(0, n);
    },
    getVortexPosition(id) {
      const v = vortexById.get(id);
      if (!v) return null;
      _posOut.x = v.centerCurrent[0];
      _posOut.y = v.centerCurrent[1];
      return _posOut;
    },
    /** Get the array index of a vortex by ID (O(1) Map + indexOf). Returns -1 if not found. */
    getVortexIndexById(id) {
      const v = vortexById.get(id);
      return v ? vortices.indexOf(v) : -1;
    },
    setVortexActive(id, val) {
      const v = vortexById.get(id);
      if (v) { v.active = val; v.activationTime = val ? performance.now() : 0; }
    },
    isVortexActive(id) {
      const v = vortexById.get(id);
      return v ? v.active : false;
    },
    isVortexRemoving(id) {
      const v = vortexById.get(id);
      return v ? !!v.isRemoving : false;
    },
    getVortexActivationTime(id) {
      const v = vortexById.get(id);
      return v ? v.activationTime : 0;
    },

    setColorMix(v) {
      for (let i = 0; i < NUM_REGIONS; i++) {
        regionTarget[i] = v;
        regionCurrent[i] = v;
      }
    },

    /** Set per-region color activation uniforms (regionId 1-5 → shader index 0-4). */
    setRegionActivation(regionId, intensity, clickX, clickY, radiusNorm) {
      const idx = regionId - 1;
      if (idx < 0 || idx >= 5) return;
      regionActiveArr[idx] = intensity;
      regionClickUV[idx * 2]     = clickX;
      regionClickUV[idx * 2 + 1] = clickY;
      regionRadiusArr[idx] = radiusNorm;
    },

    /** Gate per-particle fade-out stagger for the Village region (region 2). */
    setVillageFadeOut(v) { villageFadeOut = v ? 1 : 0; },
    setSkyFadeOut(v) { skyFadeOut = v ? 1 : 0; },
    setHorizonFadeOut(v) { horizonFadeOut = v ? 1 : 0; },

    /** Set 12 star glow centers in canvas UV space (Float32Array(24), vec2 × 12). */
    setStarGlowCenters(arr) {
      for (let i = 0; i < 24; i++) starCenterUV[i] = arr[i];
    },
    /** Set 12 per-star inner radii — corona starts outside this radius. */
    setStarInnerRadii(arr) {
      for (let i = 0; i < 12; i++) starInnerRadii[i] = arr[i];
    },
    /** Get 12 per-star inner radii (base home-space UV). */
    getStarInnerRadii() { return starInnerRadii; },
    /** Set 12 per-star modulated glow radii (Float32Array(12)). */
    setStarGlowRadii(arr) {
      for (let i = 0; i < 12; i++) starCurrentRadii[i] = arr[i];
    },
    /** Set overall star glow intensity (0–1). */
    // Set all 12 stars to the same intensity (broadcast)
    setStarGlowIntensity(v) {
      starGlowActive = v > 0.001 ? 1.0 : 0.0;
      for (let i = 0; i < 12; i++) starGlowIntensity[i] = v;
    },
    // Set per-star intensities from a Float32Array(12)
    setStarGlowIntensities(arr) {
      let any = false;
      for (let i = 0; i < 12; i++) {
        starGlowIntensity[i] = arr[i];
        if (arr[i] > 0.001) any = true;
      }
      starGlowActive = any ? 1.0 : 0.0;
    },
    /** Enable/disable star debug dots (1.0 = red dots at star centers). */
    setStarDebugDots(v) { starDebugDots = v; },
    setStarScintillation(v) { starScintillation = Math.max(0, Math.min(1.0, v)); },
    setStarHaloSoftness(v) { starHaloSoftness = Math.max(0, Math.min(1.0, v)); },
    setCanvasDeformAmp(v) { canvasDeformAmp = Math.max(0, Math.min(0.03, v)); },
    getCanvasDeformAmp() { return canvasDeformAmp; },
    /** Get home position of a particle by vertex index. */
    getParticleHomePos(vtxId) {
      if (!homePosData || vtxId < 0) return null;
      return [homePosData[vtxId * 2], homePosData[vtxId * 2 + 1]];
    },
    /**
     * Compute per-star inner radii (mean boundary distance from centroid).
     * Extracted from the removed computeStarBoundaries — only the inner radius
     * computation is needed for star glow corona sizing.
     */
    computeStarInnerRadii(starCentersFlat) {
      if (!homePosData || !regionIdData) return;
      const t0 = performance.now();

      // Coarse grid so dithering gaps don't create false boundaries
      const cellSz = 2;
      const gridW = Math.ceil(canvas.width / cellSz);
      const gridH = Math.ceil(canvas.height / cellSz);

      // Pass 1: fill coarse grid with region IDs (-1 = empty)
      const grid = new Int8Array(gridW * gridH).fill(-1);
      for (let i = 0; i < pointCount; i++) {
        const gx = Math.min(Math.floor(homePosData[i * 2] * canvas.width / cellSz), gridW - 1);
        const gy = Math.min(Math.floor(homePosData[i * 2 + 1] * canvas.height / cellSz), gridH - 1);
        grid[gy * gridW + gx] = Math.round(regionIdData[i]);
      }

      // Pass 2: for each region-5 particle, search nearby coarse cells
      // Flag as boundary only if a neighbor holds a DIFFERENT region (ignore empty)
      const R = 1; // search radius in coarse cells (~3px)
      const flags = new Float32Array(pointCount);
      let count = 0;
      for (let i = 0; i < pointCount; i++) {
        if (Math.round(regionIdData[i]) !== 5) continue;
        const gx = Math.min(Math.floor(homePosData[i * 2] * canvas.width / cellSz), gridW - 1);
        const gy = Math.min(Math.floor(homePosData[i * 2 + 1] * canvas.height / cellSz), gridH - 1);
        let isBoundary = false;
        for (let dy = -R; dy <= R && !isBoundary; dy++) {
          for (let dx = -R; dx <= R && !isBoundary; dx++) {
            if (dx === 0 && dy === 0) continue;
            const cx = gx + dx, cy = gy + dy;
            if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue;
            const val = grid[cy * gridW + cx];
            if (val >= 0 && val !== 5) isBoundary = true;
          }
        }
        if (isBoundary) { flags[i] = 1.0; count++; }
      }

      // Assign boundary particles to stars via multi-source BFS flood-fill.
      let perStar = null;
      if (starCentersFlat && starCentersFlat.length >= 24) {
        // Build star-ownership grid via multi-source BFS on region-5 cells
        const starOwner = new Int8Array(gridW * gridH).fill(-1);
        const queue = [];
        // Seed BFS from each star centroid's grid cell.
        // If the centroid cell isn't region 5 (coarse grid overlap with cypress/village),
        // search nearby cells in expanding rings to find the nearest region-5 cell.
        for (let s = 0; s < 12; s++) {
          const gx = Math.min(Math.floor(starCentersFlat[s * 2] * canvas.width / cellSz), gridW - 1);
          const gy = Math.min(Math.floor(starCentersFlat[s * 2 + 1] * canvas.height / cellSz), gridH - 1);
          let seedIdx = -1;
          if (grid[gy * gridW + gx] === 5 && starOwner[gy * gridW + gx] < 0) {
            seedIdx = gy * gridW + gx;
          } else {
            // Spiral search: find nearest unclaimed region-5 cell within 20-cell radius
            const maxR = 20;
            let bestD = Infinity;
            for (let sr = 1; sr <= maxR && seedIdx < 0; sr++) {
              for (let sdy = -sr; sdy <= sr; sdy++) {
                for (let sdx = -sr; sdx <= sr; sdx++) {
                  if (Math.abs(sdx) !== sr && Math.abs(sdy) !== sr) continue; // ring only
                  const nx = gx + sdx, ny = gy + sdy;
                  if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
                  const ni = ny * gridW + nx;
                  if (grid[ni] === 5 && starOwner[ni] < 0) {
                    const d = sdx * sdx + sdy * sdy;
                    if (d < bestD) { bestD = d; seedIdx = ni; }
                  }
                }
              }
              if (seedIdx >= 0) break; // found one on this ring
            }
          }
          if (seedIdx >= 0) {
            starOwner[seedIdx] = s;
            queue.push(seedIdx);
          }
        }
        // BFS: expand each star through connected region-5 cells
        let head = 0;
        while (head < queue.length) {
          const ci = queue[head++];
          const cx = ci % gridW, cy = (ci - cx) / gridW;
          const owner = starOwner[ci];
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
              const ni = ny * gridW + nx;
              if (grid[ni] === 5 && starOwner[ni] < 0) {
                starOwner[ni] = owner;
                queue.push(ni);
              }
            }
          }
        }
        // Bin boundary particles by their grid cell's star owner
        perStar = Array.from({length: 12}, () => []);
        for (let i = 0; i < pointCount; i++) {
          if (flags[i] < 0.5) continue;
          const gx = Math.min(Math.floor(homePosData[i * 2] * canvas.width / cellSz), gridW - 1);
          const gy = Math.min(Math.floor(homePosData[i * 2 + 1] * canvas.height / cellSz), gridH - 1);
          const owner = starOwner[gy * gridW + gx];
          if (owner >= 0 && owner < 12) perStar[owner].push(i);
        }
        // Compute per-star inner radius (mean boundary distance from centroid).
        // Uses aspect correction to match fragment shader's distance computation.
        const aspect = canvas.width / canvas.height;
        const computedInnerRadii = new Float32Array(12);
        for (let s = 0; s < 12; s++) {
          const pool = perStar[s];
          if (!pool || pool.length === 0) { computedInnerRadii[s] = 0.01; continue; }
          const cx = starCentersFlat[s * 2];
          const cy = starCentersFlat[s * 2 + 1];
          let sumDist = 0;
          for (let j = 0; j < pool.length; j++) {
            const idx = pool[j];
            const dx = (homePosData[idx * 2] - cx) * aspect;
            const dy = homePosData[idx * 2 + 1] - cy;
            sumDist += Math.sqrt(dx * dx + dy * dy);
          }
          computedInnerRadii[s] = sumDist / pool.length;
        }
        // Write directly to the module-level array
        for (let s = 0; s < 12; s++) starInnerRadii[s] = computedInnerRadii[s];
      }
      _log(`%c[StarRadii]%c  Computed inner radii for 12 stars (${(performance.now() - t0).toFixed(1)}ms)`,
        'color: #c9f; font-weight: bold', 'color: #999');
    },
    setBgTonalStrength(v) { bgTonalStrength = Math.max(0, Math.min(1.0, v)); },
    setBgTonalTarget(v) { bgTonalTarget = Math.max(0, Math.min(1.0, v)); },
    getBgTonalTarget() { return bgTonalTarget; },
    setAdditiveBlend(v) { additiveBlend = !!v; },
    getAdditiveBlend() { return additiveBlend; },
    setRadiantActive(v) { _isRadiantActive = !!v; },
    getBgTonalStrength() { return bgTonalStrength; },
    setShadowOpacity(v) { shadowOpacity = Math.max(0, Math.min(1.0, v)); },
    getShadowOpacity() { return shadowOpacity; },
    setShadowSpread(v) { shadowSpread = Math.max(0.1, Math.min(5.0, v)); paintingMargin = 10 + shadowSpread * 25; },
    getShadowSpread() { return shadowSpread; },
    setShadowOffset(x, y) { shadowOffset[0] = x; shadowOffset[1] = y; },
    getShadowOffset() { return [...shadowOffset]; },

    /**
     * Diagnostic: compute vortex proximity at a given UV position.
     * Usage from console:
     *   _renderer.probeVortex(0.5, 0.3)  // UV coordinates
     *   _renderer.probeVortex()           // last clicked position (if stored)
     *
     * Also can pass canvas pixel coordinates:
     *   _renderer.probePixel(400, 300)    // canvas pixel coords
     */
    probeVortex(uvX, uvY) {
      const ar = canvas.width / canvas.height || 1;
      const halfDiag = Math.sqrt(0.25 * ar * ar + 0.25);
      const results = [];
      let maxProx = 0, maxIdx = -1;

      for (let i = 0; i < vortices.length; i++) {
        const v = vortices[i];
        if (v.isRemoving) continue;

        const gravNorm = Math.min(v.gravityCurrent / GRAVITY_CAP, 1.0);
        const vortexRadius = halfDiag * Math.sqrt(gravNorm) * v.removalScale;
        const sigma = vortexRadius * 0.15;
        const sigmaSq = sigma * sigma + 0.0001;

        const dx = (uvX - v.centerCurrent[0]) * ar;
        const dy = uvY - v.centerCurrent[1];
        const homeDist = Math.sqrt(dx * dx + dy * dy);

        const softEdge = 0.20;
        const outerLimit = vortexRadius * (1.0 + softEdge);
        let proximity = 0;
        if (vortexRadius > 0.001) {
          if (homeDist <= vortexRadius) {
            proximity = 1.0 - homeDist / outerLimit;
          } else if (homeDist < outerLimit) {
            const t = (homeDist - vortexRadius) / (outerLimit - vortexRadius);
            const sm = t * t * (3 - 2 * t); // smoothstep
            proximity = (softEdge / (1.0 + softEdge)) * (1.0 - sm);
          }
        }

        // Suppress proximity (wider zone for gust suppression)
        const suppressEdge = 0.60;
        const suppressLimit = vortexRadius * (1.0 + suppressEdge);
        let suppressProx = 0;
        if (vortexRadius > 0.001) {
          if (homeDist <= vortexRadius) {
            suppressProx = 1.0 - homeDist / suppressLimit;
          } else if (homeDist < suppressLimit) {
            const st = (homeDist - vortexRadius) / (suppressLimit - vortexRadius);
            const sm = st * st * (3 - 2 * st);
            suppressProx = (suppressEdge / (1.0 + suppressEdge)) * (1.0 - sm);
          }
        }

        const rSq = dx * dx + dy * dy;
        const biotSavartWeight = (proximity > 0) ? v.strength / (rSq + sigmaSq) : 0;

        if (proximity > maxProx) { maxProx = proximity; maxIdx = i; }

        results.push({
          vortexId: v.id,
          active: v.active,
          dist: homeDist.toFixed(4),
          radius: vortexRadius.toFixed(4),
          outerLimit: outerLimit.toFixed(4),
          suppressLimit: suppressLimit.toFixed(4),
          proximity: proximity.toFixed(4),
          suppressProx: suppressProx.toFixed(4),
          biotSavartW: biotSavartWeight.toFixed(4),
          absorbed: proximity > absorptionThreshold,
          gustSuppress: (1.0 - suppressProx).toFixed(4),
          gravCurrent: v.gravityCurrent.toFixed(6),
        });
      }

      // Region at this UV (segmentationData lives in ui.js, exposed on window)
      let regionAtUV = 'unknown';
      const seg = window._segData;
      if (seg && seg.regionMap) {
        const px = Math.round(uvX * (seg.width - 1));
        const py = Math.round(uvY * (seg.height - 1));
        const idx = py * seg.width + px;
        regionAtUV = seg.regionMap[idx];
      }

      console.table(results);
      _log(`Position: (${uvX.toFixed(3)}, ${uvY.toFixed(3)})`);
      _log(`Region at home: ${regionAtUV}`);
      _log(`Max proximity: ${maxProx.toFixed(4)} (vortex idx ${maxIdx})`);
      _log(`Absorption threshold: ${absorptionThreshold}`);
      _log(`Would be absorbed: ${maxProx > absorptionThreshold && (regionAtUV === 0 || regionAtUV === 3 || regionAtUV === 4)}`);
      return { proximity: maxProx, region: regionAtUV, absorbed: maxProx > absorptionThreshold };
    },

    probePixel(canvasX, canvasY) {
      const uvX = canvasX / canvas.width;
      const uvY = canvasY / canvas.height;
      return this.probeVortex(uvX, uvY);
    },

    /**
     * Debug mode 6 diagnostic: compute vortex speed values for vortex[idx]
     * at 5 sample distances (center, 25%, 50%, 75%, edge).
     * Mirrors the shader math exactly.
     * Usage: _renderer.probeVortexSpeed(1)
     */
    probeVortexSpeed(idx = 1) {
      if (idx >= vortices.length) { _log('No vortex at index', idx); return; }
      const v = vortices[idx];
      const ar = canvas.width / canvas.height || 1;
      const halfDiag = Math.sqrt(0.25 * ar * ar + 0.25);
      const gravNorm = Math.min(v.gravityCurrent / GRAVITY_CAP, 1.0);
      const vortexRadius = halfDiag * Math.sqrt(gravNorm) * (v.removalScale || 1);
      const sigma = vortexRadius * 0.15;
      const sigmaSq = sigma * sigma;
      const speed = v.speed || 0;
      const speedNorm = speed / 2.5;

      _log('=== Vortex Speed Debug (index', idx, ') ===');
      _log('center:', v.centerCurrent);
      _log('gravityCurrent:', v.gravityCurrent, '→ gravNorm:', gravNorm.toFixed(6));
      _log('vortexRadius (aspect-corrected):', vortexRadius.toFixed(6));
      _log('sigma:', sigma.toFixed(6), ' sigmaSq:', sigmaSq.toFixed(8));
      _log('speed:', speed, ' speedNorm:', speedNorm.toFixed(4));
      _log('');

      const samples = [
        { label: 'center',  pct: 0.00 },
        { label: '25%',     pct: 0.25 },
        { label: '50%',     pct: 0.50 },
        { label: '75%',     pct: 0.75 },
        { label: 'edge',    pct: 1.00 },
        { label: '110%',    pct: 1.10 },
      ];

      const rows = samples.map(s => {
        const homeDist = vortexRadius * s.pct;
        // Proximity: same as shader (soft-edge with 20% outer zone)
        const outerLimit = vortexRadius * 1.2;
        let prox = 0;
        if (vortexRadius > 0.001) {
          if (homeDist <= vortexRadius) {
            prox = 1.0 - homeDist / outerLimit;
          } else if (homeDist < outerLimit) {
            const t = (homeDist - vortexRadius) / (outerLimit - vortexRadius);
            const sm = t * t * (3 - 2 * t);
            prox = (0.2 / 1.2) * (1.0 - sm);
          }
        }
        const coherenceSpeed = Math.max(prox * speedNorm, 0.002);
        const clamped = Math.min(Math.max(coherenceSpeed, 0), 1);
        let color;
        if (clamped < 0.25) color = 'blue→cyan';
        else if (clamped < 0.50) color = 'cyan→green';
        else if (clamped < 0.75) color = 'green→yellow';
        else color = 'yellow→red';

        return {
          position: s.label,
          homeDist: homeDist.toFixed(6),
          proximity: prox.toFixed(4),
          speedNorm: speedNorm.toFixed(4),
          coherenceSpeed: coherenceSpeed.toFixed(4),
          heatColor: color,
        };
      });

      console.table(rows);
      return rows;
    },

    /**
     * Debug mode 6 diagnostic: compare flow vs vortex speed profiles side by side.
     * Shows what effectiveSpeed (v_coherenceSpeed × v_driftScale) looks like
     * at various distances from the boundary for BOTH systems.
     * Usage: _renderer.probeSpeedComparison(1)
     */
    probeSpeedComparison(vortexIdx = 1) {
      // ── Flow edge profile ──
      // effectiveSpeed = gustedSpeed × driftScale
      // driftScale = mix(0.2, 1.0, smoothstep(0, edgeDepth, edgeDist))
      const edgeDepth = flowEdgeDepth;  // u_flowEdgeDepth (default 25px)
      const speedFloor = flowSpeedFloor; // u_flowSpeedFloor
      // Typical gustedSpeed: curvatureSpeed × gustFactor ≈ 0.5–0.8 mid-range
      const typicalGustedSpeed = 0.65;

      const distances = [0, 2, 5, 10, 15, 20, 25, 30, 40];

      _log('=== Flow Edge Speed Profile ===');
      _log('edgeDepth:', edgeDepth, 'px | speedFloor:', speedFloor);
      _log('typicalGustedSpeed (assumed):', typicalGustedSpeed);

      const flowRows = distances.map(px => {
        const t = Math.min(px / edgeDepth, 1);
        const edgeFactor = t * t * (3 - 2 * t); // smoothstep
        const driftScale = 0.2 + 0.8 * edgeFactor; // mix(0.2, 1.0, edgeFactor)
        const effectiveSpeed = typicalGustedSpeed * driftScale;
        const clamped = Math.min(Math.max(effectiveSpeed, 0), 1);
        let color;
        if (clamped < 0.25) color = 'blue→cyan';
        else if (clamped < 0.50) color = 'cyan→green';
        else if (clamped < 0.75) color = 'green→yellow';
        else color = 'yellow→red';
        return {
          edgeDist_px: px,
          edgeFactor: edgeFactor.toFixed(4),
          driftScale: driftScale.toFixed(4),
          coherenceSpeed: typicalGustedSpeed.toFixed(4),
          effectiveSpeed: effectiveSpeed.toFixed(4),
          heatColor: color,
        };
      });
      console.table(flowRows);

      // ── Vortex edge profile ──
      if (vortexIdx < vortices.length) {
        const v = vortices[vortexIdx];
        const ar = canvas.width / canvas.height || 1;
        const halfDiag = Math.sqrt(0.25 * ar * ar + 0.25);
        const gravNorm = Math.min(v.gravityCurrent / GRAVITY_CAP, 1.0);
        const vortexRadius = halfDiag * Math.sqrt(gravNorm) * (v.removalScale || 1);
        const outerLimit = vortexRadius * 1.2;
        const speed = v.speed || 0;
        const speedNorm = speed / 2.5;
        const canvasMax = Math.max(canvas.width, canvas.height);

        _log('');
        _log('=== Vortex Edge Speed Profile (index', vortexIdx, ') ===');
        _log('vortexRadius:', vortexRadius.toFixed(6), '| outerLimit:', outerLimit.toFixed(6));
        _log('speed:', speed, '| speedNorm:', speedNorm.toFixed(4));
        _log('canvasMax:', canvasMax, 'px');

        // Sample from outside the vortex edge inward
        // Use same pixel distances as flow for direct comparison
        const vortexRows = distances.map(px => {
          // px = distance from outerLimit, going INWARD
          const distUV = px / canvasMax;
          const homeDist = outerLimit - distUV; // distance from vortex center
          let prox = 0;
          if (vortexRadius > 0.001 && homeDist >= 0) {
            if (homeDist <= vortexRadius) {
              prox = 1.0 - homeDist / outerLimit;
            } else if (homeDist < outerLimit) {
              const t = (homeDist - vortexRadius) / (outerLimit - vortexRadius);
              const sm = t * t * (3 - 2 * t);
              prox = (0.2 / 1.2) * (1.0 - sm);
            }
          }
          const coherenceSpeed = Math.max(prox * speedNorm, 0.13);
          const effectiveSpeed = coherenceSpeed * 1.0; // driftScale = 1.0 for vortex
          const clamped = Math.min(Math.max(effectiveSpeed, 0), 1);
          let color;
          if (clamped < 0.25) color = 'blue→cyan';
          else if (clamped < 0.50) color = 'cyan→green';
          else if (clamped < 0.75) color = 'green→yellow';
          else color = 'yellow→red';
          return {
            fromEdge_px: px,
            homeDist: homeDist.toFixed(6),
            proximity: prox.toFixed(4),
            coherenceSpeed: coherenceSpeed.toFixed(4),
            effectiveSpeed: effectiveSpeed.toFixed(4),
            heatColor: color,
          };
        });
        console.table(vortexRows);
      }
    },

    get fps() { return fps; },
    get pointCount() { return pointCount; },
    get isRunning() { return animFrameId !== null; },

  };
}
