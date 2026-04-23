/**
 * Audio regression diagnostic — Phase 0.4 of audio-optimization-plan-2026-04-12.md
 *
 * Purpose: identify why idle render cost is 12.6× higher in the "autoplay-resume"
 * path (bad) vs the "user-gesture start" path (good). See
 * docs/audio-regression-trace-2026-04-12.md for the trace analysis.
 *
 * Enabled via ?audioDiag=1 URL param or window._audioDiag = true. When disabled,
 * every exported method is a no-op and the module contributes zero runtime cost.
 *
 * Protocol:
 *   1. Load page with ?audioDiag=1 in the Bad state (context auto-resumes,
 *      capacity monitor shows 20-35%).
 *   2. Wait ~10s after Play. In console: window.__audioDiag.report()
 *   3. Copy the full console output (timeline + worklet responses).
 *   4. Reload in the Good state (suspended → user-gesture start, 1-3%).
 *   5. Repeat step 2-3.
 *   6. Diff the two outputs.
 *
 * Hypothesis mapping:
 *   A (stuck fast-path): worklet fastPathHits/processCalls ratio is <1 in bad,
 *     ~1 in good. Look for activeVoices or nonZeroGains > 0 in bad.
 *   B (duplicate graph): worklet registration count differs between runs.
 *   C (context init race): ctxState at "preBuildAudioNodes:start" differs —
 *     'running' in bad, 'suspended' in good.
 */

const _enabled = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('audioDiag') === '1') return true;
    if (window._audioDiag === true) return true;
  } catch (e) {}
  return false;
})();

const _timeline = [];
const _workletRefs = []; // [{ label, node }]
const _workletResponses = []; // [{ t, label, data }]

// Step A defang (2026-04-12): do NOT touch `Tone.context` inside _readCtxState
// until primeContextAccess() has been called. `Tone.context` is a lazy getter
// that creates the underlying AudioContext on first access, and reading it too
// early (during the page-load main-thread storm) latches the audio stack into
// the ~12× DSP cost bad state. primeContextAccess() is called from the top of
// preBuildAudioNodes(), which is the moment the natural (non-diagnostic) code
// path would have touched Tone.context anyway. Before that moment, marks still
// record timing and still log to console, but with ctx=null — no observer effect.
let _primed = false;

function _now() { return performance.now(); }

/**
 * Attempt to read the underlying native AudioContext state through Tone.js.
 * Tone wraps its context; the native one carries state/sampleRate/outputLatency.
 *
 * IMPORTANT: returns null until primeContextAccess() is called. `Tone.context`
 * is a lazy getter — see _primed comment above for rationale.
 */
function _readCtxState() {
  if (!_primed) return null;
  try {
    if (typeof Tone === 'undefined' || !Tone.context) return null;
    const rc = Tone.context.rawContext || Tone.context;
    const native = rc._nativeAudioContext || rc._nativeContext || rc;
    if (!native || typeof native.state === 'undefined') return null;
    return {
      state: native.state,
      sampleRate: native.sampleRate,
      baseLatency: typeof native.baseLatency !== 'undefined' ? native.baseLatency : null,
      outputLatency: typeof native.outputLatency !== 'undefined' ? native.outputLatency : null,
      currentTime: native.currentTime,
    };
  } catch (e) {
    return null;
  }
}

export const audioDiag = {
  enabled: _enabled,

  /**
   * Add a timeline marker. Captures current AudioContext state (only after
   * primeContextAccess() has been called — see _primed comment for rationale).
   * Called at known init boundaries in ui.js and region-synths.js.
   */
  mark(label, extra = {}) {
    if (!_enabled) return;
    const ctx = _readCtxState();
    const entry = { t: _now(), label, ctx, extra, primed: _primed };
    _timeline.push(entry);
    const ctxSummary = ctx
      ? `state=${ctx.state} sr=${ctx.sampleRate} baseLat=${ctx.baseLatency !== null ? (ctx.baseLatency*1000).toFixed(1)+'ms' : '—'} outLat=${ctx.outputLatency !== null ? (ctx.outputLatency*1000).toFixed(1)+'ms' : '—'}`
      : (_primed ? 'ctx=— (Tone not ready)' : 'ctx=— (not primed)');
    console.log(
      `%c[AudioDiag]%c ${(entry.t).toFixed(0).padStart(6)}ms  ${label.padEnd(34)}  ${ctxSummary}`,
      'color: #fc0; font-weight: bold', 'color: #ccc',
      Object.keys(extra).length ? extra : ''
    );
  },

  /**
   * Prime context-state reads. Call this from the top of preBuildAudioNodes()
   * — the moment the natural (non-diagnostic) code path would have first
   * touched `Tone.context`. Before this call, _readCtxState() returns null
   * and mark() logs "ctx=— (not primed)". After this call, _readCtxState()
   * reads live state from the native AudioContext via Tone.js.
   *
   * This is the Step A defang from docs/audio-regression-trace-2026-04-12.md.
   * If Hypothesis E is right, gating context access on this call will drop
   * idle render capacity from 20–30% back to 1–5% even with ?audioDiag=1.
   */
  primeContextAccess() {
    if (!_enabled) return;
    if (_primed) return; // idempotent — only the first call matters
    _primed = true;
    console.log(
      `%c[AudioDiag]%c ${_now().toFixed(0).padStart(6)}ms  primeContextAccess()                ctx reads enabled`,
      'color: #fc0; font-weight: bold', 'color: #ccc'
    );
  },

  /**
   * Register a worklet node so it can be queried for counters later.
   * Hooks port.onmessage to capture diag_snapshot_response without breaking
   * the existing message handler.
   */
  registerWorklet(label, node) {
    if (!_enabled || !node || !node.port) return;
    _workletRefs.push({ label, node });
    console.log(
      `%c[AudioDiag]%c worklet registered: ${label} (total: ${_workletRefs.length})`,
      'color: #fc0; font-weight: bold', 'color: #ccc'
    );
    try {
      const existingHandler = node.port.onmessage;
      node.port.onmessage = (e) => {
        if (e.data && e.data.type === 'diag_snapshot_response') {
          const entry = { t: _now(), label, data: e.data };
          _workletResponses.push(entry);
          const c = e.data.counts || {};
          const s = e.data.state || {};
          const ratio = c.processCalls > 0
            ? (c.fastPathHits / c.processCalls * 100).toFixed(1) + '%'
            : 'n/a';
          console.log(
            `%c[AudioDiag]%c   ← ${label.padEnd(20)}  calls=${c.processCalls} fast=${c.fastPathHits} (${ratio})  active=${s.active} activeVoices=${s.activeVoices}/${s.voiceCount} nonZeroGains=${s.nonZeroGains}`,
            'color: #fc0; font-weight: bold', 'color: #9cf',
            s.extra || ''
          );
          return; // swallow — don't forward to existing handler
        }
        if (existingHandler) {
          try { existingHandler.call(node.port, e); } catch (err) {}
        }
      };
    } catch (e) {
      console.warn('[AudioDiag] Failed to hook worklet port:', label, e);
    }
  },

  /**
   * Broadcast diag_snapshot to every registered worklet. Responses arrive
   * asynchronously via the hooked port.onmessage (see registerWorklet).
   */
  snapshotWorklets() {
    if (!_enabled) return;
    console.log(
      `%c[AudioDiag]%c requesting snapshots from ${_workletRefs.length} worklet(s)`,
      'color: #fc0; font-weight: bold', 'color: #ccc'
    );
    for (const { label, node } of _workletRefs) {
      try {
        node.port.postMessage({ type: 'diag_snapshot' });
      } catch (e) {
        console.warn('[AudioDiag] snapshot post failed for', label, e);
      }
    }
  },

  /**
   * Print a complete report: timeline + current context state + worklet counts.
   * Worklet responses arrive ~1 audio frame later; run this AFTER audio has
   * been idle for at least 10 seconds so the counters reflect steady state.
   */
  report() {
    if (!_enabled) {
      console.log('[AudioDiag] disabled — append ?audioDiag=1 to the URL, or set window._audioDiag=true before loading.');
      return;
    }
    console.group('%c[AudioDiag] FULL REPORT', 'color: #fc0; font-weight: bold; font-size: 14px');

    // Prime status
    console.log(
      `%cPrime status:%c ${_primed ? 'primed (ctx reads active)' : 'NOT primed (ctx reads suppressed — defang active)'}`,
      'color: #fc0; font-weight: bold', 'color: #ccc'
    );

    // Current context snapshot — always reads live, even if unprimed (manual .report() is safe,
    // it's late in the lifecycle; we only suppress auto-reads during startup)
    const cur = _readCtxState();
    console.log('%cCurrent AudioContext state:', 'color: #fc0; font-weight: bold', cur || '(no context yet / not primed)');

    // Timeline — show pre-prime marks with a "[pre-prime]" tag so it's obvious
    // which marks happened BEFORE primeContextAccess() was called. In a defanged
    // run all pre-prime marks should show ctx=null (the whole point of Step A).
    console.log(`%cTimeline (${_timeline.length} marks):`, 'color: #fc0; font-weight: bold');
    for (const e of _timeline) {
      const state = e.ctx ? e.ctx.state : '—';
      const outLat = e.ctx && e.ctx.outputLatency !== null
        ? (e.ctx.outputLatency * 1000).toFixed(1) + 'ms'
        : '—';
      const primeTag = e.primed ? '          ' : '[pre-prime]';
      console.log(
        `  ${e.t.toFixed(0).padStart(7)}ms  ${primeTag}  ${e.label.padEnd(34)}  state=${state.padEnd(10)} outLat=${outLat.padEnd(8)}`,
        Object.keys(e.extra).length ? e.extra : ''
      );
    }

    // Registered worklets
    console.log(`%cRegistered worklets (${_workletRefs.length}):`, 'color: #fc0; font-weight: bold');
    const byLabel = {};
    for (const { label } of _workletRefs) byLabel[label] = (byLabel[label] || 0) + 1;
    for (const [label, count] of Object.entries(byLabel)) {
      console.log(`  ${label}: ${count}${count > 1 ? '  ⚠️ DUPLICATE' : ''}`);
    }

    // Previous worklet responses
    if (_workletResponses.length > 0) {
      console.log(`%cPrior worklet responses (${_workletResponses.length}):`, 'color: #fc0; font-weight: bold');
      for (const r of _workletResponses.slice(-20)) {
        const c = r.data.counts || {};
        const s = r.data.state || {};
        const ratio = c.processCalls > 0
          ? (c.fastPathHits / c.processCalls * 100).toFixed(1) + '%'
          : 'n/a';
        console.log(
          `  ${r.t.toFixed(0).padStart(7)}ms  ${r.label.padEnd(20)} calls=${c.processCalls} fast=${c.fastPathHits} (${ratio}) activeVoices=${s.activeVoices}/${s.voiceCount}`
        );
      }
    }

    // Request fresh snapshots (async — will log to console shortly)
    console.log('%cRequesting fresh worklet snapshots…', 'color: #fc0');
    this.snapshotWorklets();

    console.groupEnd();
  },

  /** Raw timeline data for programmatic inspection. */
  timeline() { return _timeline.slice(); },
  workletResponses() { return _workletResponses.slice(); },
  workletCount() { return _workletRefs.length; },
};

if (_enabled) {
  try {
    window.__audioDiag = audioDiag;
    console.log(
      '%c[AudioDiag]%c ENABLED — run window.__audioDiag.report() ~10s after Play',
      'color: #fc0; font-weight: bold; font-size: 12px', 'color: #ccc'
    );
  } catch (e) {}
}
