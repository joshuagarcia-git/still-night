/**
 * Audio Profiler — development diagnostic suite for audio performance and mix analysis.
 * Loaded conditionally when URL contains ?debug.
 *
 * Usage: import { setupAudioProfiler } from "./debug/audio-profiler.js"
 *        setupAudioProfiler({ regions, masterLimiter, ... })
 *        Then use _audioProfile.* in console.
 */

export function setupAudioProfiler(internals) {
  const {
    regions, masterLimiter, sharedReverb, sharedDeepReverb, sharedSpecialFreeverb,
    _nativeNode, getRegionAudioFeatures, NS_VOICE_COUNT, VOICES,
  } = internals;

  const disconnected = {};
  let _sweepRunning = false;
  let _monitorNode = null;
  let _monitorStarted = false;
  let _lastReading = null;

  function _getNativeCtx() {
    if (!Tone.context) return null;
    const raw = Tone.context.rawContext;
    return raw._nativeAudioContext || raw._nativeContext || raw;
  }

  function _log(msg) {
    console.log(`%c[AudioProfile]%c  ${msg}`, 'color: #f80; font-weight: bold', 'color: #eee');
  }
  function _warn(msg) {
    console.warn(`%c[AudioProfile]%c  ${msg}`, 'color: #f80; font-weight: bold', 'color: #fc0');
  }

  // ── Capacity monitor (AudioWorklet on audio thread) ──
  async function _ensureMonitor() {
    if (_monitorNode) return _monitorNode;
    const ctx = _getNativeCtx();
    if (!ctx || !ctx.audioWorklet) { _warn('No AudioWorklet support'); return null; }
    try {
      await ctx.audioWorklet.addModule('js/worklets/capacity-monitor.js');
    } catch (e) { _warn('capacity-monitor load failed: ' + e.message); return null; }
    _monitorNode = new AudioWorkletNode(ctx, 'capacity-monitor');
    _monitorNode.connect(ctx.destination);
    _monitorNode.port.onmessage = (e) => {
      _lastReading = e.data;
      if (_monitorStarted) {
        const d = e.data;
        const pct = (v) => (v * 100).toFixed(1);
        // batchCapacity: 0% = idle (lots of batching), 100% = saturated (no batching)
        const cap = d.batchCapacity;
        const clr = cap > 0.8 ? '#f44' : cap > 0.5 ? '#fa0' : '#4f4';
        const w = 30, f = Math.min(w, Math.round(cap * w));
        const bar = '[' + (cap > 0.8 ? '█' : cap > 0.5 ? '▓' : '░').repeat(f) + '·'.repeat(w - f) + ']';
        const glitch = d.droppedQuanta > 0 ? `  GLITCHES: ${d.droppedQuanta}` : '';
        console.log(
          `%c[Capacity]%c  load %c${pct(cap)}%%c  ` +
          `median ${pct(d.median)}  p75 ${pct(d.p75)}  p95 ${pct(d.p95)}  ` +
          `batch ${pct(d.batchRatio)}  ${bar}${glitch}`,
          'color:#f80;font-weight:bold', 'color:#eee',
          `color:${clr};font-weight:bold`, 'color:#999'
        );
      }
    };
    return _monitorNode;
  }

  async function monitor(on = true) {
    if (on) {
      await _ensureMonitor();
      if (!_monitorNode) return;
      _monitorStarted = true;
      _monitorNode.port.postMessage('start');
      _log('Monitor ON — 1-second averaged readings');
    } else {
      _monitorStarted = false;
      if (_monitorNode) _monitorNode.port.postMessage('stop');
      _log('Monitor OFF');
    }
  }

  function _waitReading() {
    return new Promise((resolve) => {
      if (!_monitorNode) return resolve(null);
      const orig = _monitorNode.port.onmessage;
      _monitorNode.port.onmessage = (e) => {
        _lastReading = e.data;
        if (_monitorStarted && orig) orig(e);
        _monitorNode.port.onmessage = orig;
        resolve(e.data);
      };
    });
  }

  async function _measure(seconds) {
    await _ensureMonitor();
    if (!_monitorNode) return null;
    _monitorNode.port.postMessage('start');
    const readings = [];
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const r = await _waitReading();
      if (r) readings.push(r);
    }
    if (!readings.length) return null;
    return {
      load: readings.reduce((s, r) => s + r.batchCapacity, 0) / readings.length,
      median: readings.reduce((s, r) => s + r.median, 0) / readings.length,
      p95: readings.reduce((s, r) => s + r.p95, 0) / readings.length,
      n: readings.length,
    };
  }

  // ── Test: measure baseline, isolate, measure delta, restore ──
  async function test(target) {
    _log(`=== Testing: ${target} ===`);
    _log('Baseline (4s)...');
    const before = await _measure(4);
    if (!before) return _warn('No readings');
    _log(`  Baseline: load=${(before.load * 100).toFixed(1)}%`);

    isolate(target);
    await _wait(2000);  // longer settle for batch ratio to stabilize
    _log('After disconnect (4s)...');
    const after = await _measure(4);

    restore();
    await _wait(2000);
    _log('After restore (4s)...');
    const restored = await _measure(4);

    if (after && restored) {
      const delta = before.load - after.load;
      console.log(
        `\n%c[Result]%c  ${target.toUpperCase()} cost: %c${delta > 0 ? '' : '+'}${(delta * 100).toFixed(1)}%%c  ` +
        `(baseline ${(before.load*100).toFixed(1)}% -> disconnected ${(after.load*100).toFixed(1)}% -> restored ${(restored.load*100).toFixed(1)}%)`,
        'color:#0f0;font-weight:bold', 'color:#eee',
        `color:${delta > 0.03 ? '#f44' : '#4f4'};font-weight:bold;font-size:14px`, 'color:#999'
      );
    }
    _log(`=== Done: ${target} ===\n`);
  }

  // ── Node counting ──
  function nodeCount() {
    const ctx = _getNativeCtx();
    if (!ctx) return _warn('No AudioContext');
    // Count all region chain nodes + special voice nodes
    const counts = { base: 0, special: {}, shared: 0, total: 0 };
    const names = { 1: 'Cypress', 2: 'Village', 3: 'Sky', 4: 'Horizon', 5: 'Stars' };

    for (const [id, r] of Object.entries(regions)) {
      // Base chain: filter, mainGain, deepSend, shortReverbSend, chorus, primarySynth, secondarySynth, secondaryGain
      counts.base += 8;  // approximate per-region base
      const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse :
                 id == 3 ? r.nightSky : id == 4 ? r.windHarp :
                 id == 5 ? r.celestialStrings : null;
      if (vs) {
        const vsName = names[id];
        // Count special voice nodes by checking which properties exist
        let n = 0;
        for (const key of Object.keys(vs)) {
          const v = vs[key];
          if (v && typeof v === 'object' && (v.dispose || v.disconnect || v.connect)) n++;
        }
        counts.special[vsName] = { nodes: n, active: !!vs.active, frozen: vs.freezeState || 'n/a' };
      }
    }
    // Shared
    if (masterLimiter) counts.shared++;
    if (sharedReverb) counts.shared++;
    if (sharedDeepReverb) counts.shared++;
    if (sharedSpecialFreeverb) counts.shared++;

    counts.total = counts.base * 5 + Object.values(counts.special).reduce((s, v) => s + v.nodes, 0) + counts.shared;

    console.table(counts.special);
    _log(`Base chains: ~${counts.base * 5} nodes | Shared: ${counts.shared} | Estimated total: ~${counts.total}`);
    return counts;
  }

  // ── Snapshot: report current state of all chains ──
  function snapshot() {
    _log('─── Audio Graph Snapshot ───');
    const names = { 1: 'Cypress/LW', 2: 'Village/VP', 3: 'Sky/NS', 4: 'Horizon/WH', 5: 'Stars/CS' };
    for (const [id, r] of Object.entries(regions)) {
      const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse :
                 id == 3 ? r.nightSky : id == 4 ? r.windHarp :
                 id == 5 ? r.celestialStrings : null;
      const limiterConnected = _isLimiterConnected(id, r, vs);
      const padState = _getPadState(id, r, vs);
      const state = r.state;
      const freeze = vs?.freezeState || 'n/a';
      console.log(
        `  R${id} ${names[id].padEnd(14)} | state: ${state.padEnd(8)} | ` +
        `limiter→filter: ${limiterConnected ? '✓ CONNECTED' : '✗ disconnected'} | ` +
        `pad: ${padState.padEnd(12)} | freeze: ${freeze}`
      );
    }
    _log(`Shared reverbs: short=${sharedReverb ? 'connected' : 'null'}, deep=${sharedDeepReverb ? 'connected' : 'null'}`);
    _log('Open Chrome DevTools → WebAudio panel to read render capacity %');
  }

  function _isLimiterConnected(id, r, vs) {
    // We can't directly query Web Audio connections, so track via our disconnected state
    if (disconnected[`limiter_${id}`]) return false;
    // At build time, WH/LW/NS/CS limiters are connected; VP is not
    if (!vs) return false;
    if (id == 2) return vs.active;  // VP only connects on activation
    return true;  // WH, LW, NS, CS connected at build
  }

  function _getPadState(id, r, vs) {
    if (!vs) return 'no voice';
    if (id == 4 && vs.harpPad) return vs._padPreTriggered ? 'pre-triggered' : 'idle';
    if (id == 1 && vs.trunkPad) return vs._padPreTriggered ? 'pre-triggered' : 'idle';
    if (id == 5 && vs.glassyPad) return vs._padPreTriggered ? 'pre-triggered' : 'idle';
    if (id == 2 && vs.pad) return vs._padPreTriggered ? 'pre-triggered' : 'idle';
    if (id == 3 && vs.pad) return vs._padPreTriggered ? 'pre-triggered' : 'idle';
    return 'unknown';
  }

  // ── Isolate: disconnect a specific chain and observe capacity delta ──
  function isolate(target) {
    const t = target.toLowerCase();

    if (t === 'ns' || t === 'nightsky' || t === 'sky') {
      return _disconnectLimiter(3, 'Night Sky');
    }
    if (t === 'wh' || t === 'windharp' || t === 'horizon') {
      return _disconnectLimiter(4, 'Wind Harp');
    }
    if (t === 'lw' || t === 'livingwood' || t === 'cypress') {
      return _disconnectLimiter(1, 'Living Wood');
    }
    if (t === 'cs' || t === 'celestialstrings' || t === 'stars') {
      return _disconnectLimiter(5, 'Celestial Strings');
    }
    if (t === 'vp' || t === 'villagepulse' || t === 'village') {
      return _disconnectLimiter(2, 'Village Pulse');
    }
    if (t === 'reverbs' || t === 'reverb') {
      return _disconnectReverbs();
    }
    if (t === 'pads' || t === 'pretrigger') {
      return _stopPads();
    }
    if (t === 'base') {
      return _disconnectBaseChains();
    }
    _warn(`Unknown target: "${target}". Use: ns, wh, lw, cs, vp, reverbs, pads, base`);
  }

  function _disconnectLimiter(id, name) {
    const r = regions[id];
    if (!r) return _warn(`Region ${id} not found`);
    const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse :
               id == 3 ? r.nightSky : id == 4 ? r.windHarp :
               id == 5 ? r.celestialStrings : null;
    if (!vs) return _warn(`${name}: no special voice`);

    const limiterKey = id == 4 ? 'harpLimiter' : 'limiter';
    const limiter = vs[limiterKey];
    if (!limiter) return _warn(`${name}: no limiter found`);

    try {
      _nativeNode(limiter).disconnect(_nativeNode(r.filter));
    } catch (e) {
      try { limiter.disconnect(r.filter); } catch (e2) {}
    }
    disconnected[`limiter_${id}`] = { limiter, filter: r.filter, name };
    _log(`✂ DISCONNECTED ${name} limiter → r${id}.filter — read DevTools capacity now`);
  }

  function _disconnectReverbs() {
    if (sharedReverb) {
      try { _nativeNode(sharedReverb).disconnect(_nativeNode(masterLimiter)); } catch (e) {
        try { sharedReverb.disconnect(masterLimiter); } catch (e2) {}
      }
      disconnected.sharedReverb = true;
      _log('✂ DISCONNECTED sharedReverb → masterLimiter');
    }
    if (sharedDeepReverb) {
      try { _nativeNode(sharedDeepReverb).disconnect(_nativeNode(masterLimiter)); } catch (e) {
        try { sharedDeepReverb.disconnect(masterLimiter); } catch (e2) {}
      }
      disconnected.sharedDeepReverb = true;
      _log('✂ DISCONNECTED sharedDeepReverb → masterLimiter');
    }
    _log('Read DevTools capacity now — this shows convolution reverb cost');
  }

  function _stopPads() {
    const stopped = [];
    for (const [id, r] of Object.entries(regions)) {
      const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse :
                 id == 3 ? r.nightSky : id == 4 ? r.windHarp :
                 id == 5 ? r.celestialStrings : null;
      if (!vs) continue;

      // Stop pad synths (triggerRelease all notes)
      const pads = [];
      if (vs.harpPad) pads.push({ synth: vs.harpPad, notes: VOICES[4]?.notes });
      if (vs.trunkPad) pads.push({ synth: vs.trunkPad, notes: VOICES[1]?.livingWood?.padNotes });
      if (vs.glassyPad) pads.push({ synth: vs.glassyPad, notes: VOICES[5]?.notes });
      if (vs.pad && id == 2) pads.push({ synth: vs.pad, notes: ['D3', 'F3'] });
      if (vs.lowPad) pads.push({ synth: vs.lowPad, notes: ['D2', 'F2'] });
      if (vs.pad && id == 3) pads.push({ synth: vs.pad, notes: ['A2', 'F3'] });
      if (vs.subSynth) pads.push({ synth: vs.subSynth, notes: [VOICES[1]?.livingWood?.subNote] });

      for (const p of pads) {
        try {
          if (p.notes) p.synth.triggerRelease(p.notes);
          stopped.push(`R${id}`);
        } catch (e) {}
      }
      if (vs._padPreTriggered) vs._padPreTriggered = false;
    }
    disconnected.pads = stopped;
    _log(`✂ RELEASED pads: [${stopped.join(', ')}] — read DevTools capacity now`);
    _warn('⚠ First click on these regions will have ~100-200ms latency (pad not pre-triggered)');
  }

  function _disconnectBaseChains() {
    const detached = [];
    for (const [id, r] of Object.entries(regions)) {
      if (!r.chorus) continue;
      // Disconnect dryGain from masterLimiter
      // We can't easily find dryGain, so disconnect chorus output instead
      try {
        // The chain is: chorus → dryGain → masterLimiter AND chorus → shortReverbSend
        // Disconnecting mainGain → panner severs the whole base chain
        _nativeNode(r.mainGain).disconnect();
        detached.push(id);
      } catch (e) {}
    }
    disconnected.base = detached;
    _log(`✂ DISCONNECTED ${detached.length} base region chains (mainGain outputs) — read DevTools`);
    _warn('⚠ No audio will play until restore()');
  }

  // ── Restore all connections ──
  function restore() {
    let restored = 0;

    // Restore limiters
    for (const key of Object.keys(disconnected)) {
      if (key.startsWith('limiter_')) {
        const { limiter, filter, name } = disconnected[key];
        try { _nativeNode(limiter).connect(_nativeNode(filter)); } catch (e) {
          try { limiter.connect(filter); } catch (e2) {}
        }
        _log(`↩ Reconnected ${name} limiter`);
        delete disconnected[key];
        restored++;
      }
    }

    // Restore shared reverbs
    if (disconnected.sharedReverb && sharedReverb) {
      try { _nativeNode(sharedReverb).connect(_nativeNode(masterLimiter)); } catch (e) {
        try { sharedReverb.connect(masterLimiter); } catch (e2) {}
      }
      delete disconnected.sharedReverb;
      _log('↩ Reconnected sharedReverb');
      restored++;
    }
    if (disconnected.sharedDeepReverb && sharedDeepReverb) {
      try { _nativeNode(sharedDeepReverb).connect(_nativeNode(masterLimiter)); } catch (e) {
        try { sharedDeepReverb.connect(masterLimiter); } catch (e2) {}
      }
      delete disconnected.sharedDeepReverb;
      _log('↩ Reconnected sharedDeepReverb');
      restored++;
    }

    // Restore base chains
    if (disconnected.base) {
      for (const id of disconnected.base) {
        const r = regions[id];
        if (!r) continue;
        try {
          // Reconnect mainGain → panner (the chain rebuilds from there)
          const panner = r.chorus;  // panner is between mainGain and chorus... actually mainGain → panner → chorus
          // Simplest: just reconnect. But we disconnected mainGain outputs.
          // The original connection was mainGain → panner.
          // We can't easily rebuild. Mark as needing page reload.
        } catch (e) {}
      }
      _warn('⚠ Base chains disconnected — reload page to fully restore');
      delete disconnected.base;
      restored++;
    }

    // Re-trigger pads (if they were stopped)
    if (disconnected.pads) {
      _warn('⚠ Pads were released — they will re-trigger on next region click');
      delete disconnected.pads;
      restored++;
    }

    if (restored === 0) _log('Nothing to restore');
    else _log(`Restored ${restored} connection(s)`);
  }

  async function sweep() {
    if (_sweepRunning) return _warn('Sweep already running');
    _sweepRunning = true;
    const targets = ['ns', 'wh', 'lw', 'cs', 'vp', 'reverbs', 'pads'];
    const results = {};
    _log('=== FULL SWEEP ===');
    // Warmup: ensure monitor worklet is loaded and producing readings
    _log('Warming up monitor (4s)...');
    await _measure(4);
    for (const t of targets) {
      const before = await _measure(3);
      isolate(t);
      await _wait(1500);
      const after = await _measure(3);
      restore();
      await _wait(1500);
      if (before && after) {
        results[t] = { before: before.load, after: after.load, delta: before.load - after.load };
        _log(`${t}: cost ${((before.load - after.load) * 100).toFixed(1)}%`);
      }
    }
    console.table(Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, {
        'Before %': (v.before * 100).toFixed(1),
        'Disconnected %': (v.after * 100).toFixed(1),
        'Cost %': (v.delta * 100).toFixed(1),
      }])
    ));
    _sweepRunning = false;
  }

  function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ══════════════════════════════════════════════════════════════════════════
  // PER-EFFECT ISOLATION PROFILER
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Surgically disconnects one effect at a time within a voice chain,
  // bridges the gap (upstream → downstream), measures capacity delta, restores.
  //
  // Usage:
  //   _audioProfile.testEffect('wh', 'phaser')   — single effect test
  //   _audioProfile.sweepEffects()                — test all effects (~4 min)
  //   _audioProfile.isolateEffect('wh', 'phaser') / restoreEffect() — manual

  let _effectDisconnected = null;  // current surgical disconnect state

  // Map of chain topologies per voice system.
  // Each entry: { upstream, node, downstream } — the effect sits inline between upstream and downstream.
  // For bypass: disconnect upstream→node and node→downstream, then connect upstream→downstream.
  function _getEffectMap(id) {
    const r = regions[id];
    if (!r) return null;
    const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse :
               id == 3 ? r.nightSky : id == 4 ? r.windHarp :
               id == 5 ? r.celestialStrings : null;
    if (!vs) return null;

    const useShared = vs.useSharedFx;
    const effects = {};

    if (id == 4) {
      // Wind Harp: harpMixBus → phaser → delay → [reverb|dryGain] → harpLimiter
      effects.phaser = { upstream: vs.harpMixBus, node: vs.phaser, downstream: vs.delay };
      if (useShared) {
        effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: vs.dryGain,
          also: [{ from: vs.delay, to: vs.reverbSend }] };  // delay also feeds reverbSend
      } else {
        effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: vs.reverb };
        effects.freeverb = { upstream: vs.delay, node: vs.reverb, downstream: vs.harpLimiter };
      }
    } else if (id == 1) {
      // Living Wood: cypressMixBus → phaser → delay → [darkReverb|dryGain] → limiter
      effects.phaser = { upstream: vs.cypressMixBus, node: vs.phaser, downstream: vs.delay };
      if (useShared) {
        effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: vs.dryGain,
          also: [{ from: vs.delay, to: vs.reverbSend }] };
      } else {
        effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: vs.darkReverb };
        effects.freeverb = { upstream: vs.delay, node: vs.darkReverb, downstream: vs.limiter };
      }
    } else if (id == 5) {
      // Celestial Strings: starsMixBus → phaser → delay → [coldReverb|dryGain] → limiter
      effects.phaser = { upstream: vs.starsMixBus, node: vs.phaser, downstream: vs.delay };
      if (useShared) {
        effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: vs.dryGain,
          also: [{ from: vs.delay, to: vs.reverbSend }] };
      } else {
        const reverbOrHPF = vs.coldReverb;
        effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: reverbOrHPF };
        // CS: delay → coldReverb → reverbHPF → limiter
        effects.freeverb = { upstream: vs.delay, node: vs.coldReverb, downstream: vs.reverbHPF || vs.limiter };
      }
    } else if (id == 3) {
      // Night Sky: mixBus → phaser → delay → [dryGain + reverbSend→taps→returnGain] → limiter
      effects.phaser = { upstream: vs.mixBus, node: vs.phaser, downstream: vs.delay };
      // Delay splits to two paths: dryGain and reverbSend. Bypassing delay = bridge phaser→dryGain + kill reverbSend
      effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: vs.dryGain,
        also: [{ from: vs.delay, to: vs.reverbSend }] };
      // Custom reverb: reverbSend → tap1 → lpf → tap2 → hpf → returnGain → limiter
      // Bypass = disconnect reverbSend→tap1 and returnGain→limiter, no bridge needed (dryGain path stays)
      effects.reverb = {
        upstream: vs.reverbSend, node: '_nsReverbChain', downstream: vs.limiter,
        customDisconnect: () => {
          _tryDisconnect(vs.reverbSend, vs.revTap1);
          _tryDisconnect(vs.returnGain, vs.limiter);
        },
        customReconnect: () => {
          _tryConnect(vs.reverbSend, vs.revTap1);
          _tryConnect(vs.returnGain, vs.limiter);
        }
      };
    } else if (id == 2) {
      // Village Pulse: proxFilter → [gain→phaser→delay + bleed] → reverb → limiter
      effects.phaser = { upstream: vs.gain, node: vs.phaser, downstream: vs.delay };
      effects.delay = { upstream: vs.phaser, node: vs.delay, downstream: vs.reverb };
      effects.freeverb = { upstream: vs.delay, node: vs.reverb, downstream: vs.limiter,
        also: [{ from: vs.bleed, to: vs.reverb }] };  // bleed also feeds reverb
    }

    return effects;
  }

  function _tryDisconnect(from, to) {
    if (!from || !to) return;
    try { _nativeNode(from).disconnect(_nativeNode(to)); } catch (e) {
      try { from.disconnect(to); } catch (e2) {}
    }
  }

  function _tryConnect(from, to) {
    if (!from || !to) return;
    try { _nativeNode(from).connect(_nativeNode(to)); } catch (e) {
      try { from.connect(to); } catch (e2) {}
    }
  }

  function isolateEffect(chain, effectName) {
    if (_effectDisconnected) {
      _warn('An effect is already isolated — call restoreEffect() first');
      return;
    }

    const idMap = { wh: 4, horizon: 4, lw: 1, cypress: 1, ns: 3, sky: 3, cs: 5, stars: 5, vp: 2, village: 2 };
    const id = idMap[chain.toLowerCase()];
    if (id === undefined) return _warn(`Unknown chain: "${chain}". Use: wh, lw, ns, cs, vp`);

    const effectMap = _getEffectMap(id);
    if (!effectMap) return _warn(`No effects found for region ${id}`);

    const fx = effectMap[effectName.toLowerCase()];
    if (!fx) return _warn(`Unknown effect: "${effectName}" in ${chain}. Available: ${Object.keys(effectMap).join(', ')}`);

    const names = { 1: 'Living Wood', 2: 'Village Pulse', 3: 'Night Sky', 4: 'Wind Harp', 5: 'Celestial Strings' };

    if (fx.customDisconnect) {
      // Custom disconnect (e.g., NS reverb chain)
      fx.customDisconnect();
      _effectDisconnected = { id, effectName, fx, custom: true };
      _log(`✂ BYPASSED ${names[id]} ${effectName} (custom path)`);
      return;
    }

    // Standard inline bypass: disconnect upstream→node and node→downstream, bridge upstream→downstream
    _tryDisconnect(fx.upstream, fx.node);
    _tryDisconnect(fx.node, fx.downstream);
    _tryConnect(fx.upstream, fx.downstream);

    // Also disconnect any secondary paths (e.g., delay→reverbSend, bleed→reverb)
    const alsoDisconnected = [];
    if (fx.also) {
      for (const a of fx.also) {
        _tryDisconnect(a.from, a.to);
        alsoDisconnected.push(a);
      }
    }

    _effectDisconnected = { id, effectName, fx, alsoDisconnected };
    _log(`✂ BYPASSED ${names[id]} ${effectName} — upstream bridged to downstream`);
  }

  function restoreEffect() {
    if (!_effectDisconnected) {
      _log('Nothing to restore');
      return;
    }

    const { id, effectName, fx, custom, alsoDisconnected } = _effectDisconnected;
    const names = { 1: 'Living Wood', 2: 'Village Pulse', 3: 'Night Sky', 4: 'Wind Harp', 5: 'Celestial Strings' };

    if (custom && fx.customReconnect) {
      fx.customReconnect();
      _effectDisconnected = null;
      _log(`↩ RESTORED ${names[id]} ${effectName}`);
      return;
    }

    // Remove the bypass bridge
    _tryDisconnect(fx.upstream, fx.downstream);
    // Reconnect through the effect
    _tryConnect(fx.upstream, fx.node);
    _tryConnect(fx.node, fx.downstream);
    // Restore secondary paths
    if (alsoDisconnected) {
      for (const a of alsoDisconnected) {
        _tryConnect(a.from, a.to);
      }
    }

    _effectDisconnected = null;
    _log(`↩ RESTORED ${names[id]} ${effectName}`);
  }

  async function testEffect(chain, effectName, _calledFromSweep) {
    const names = { wh: 'Wind Harp', lw: 'Living Wood', ns: 'Night Sky', cs: 'Celestial Strings', vp: 'Village Pulse' };
    const label = `${names[chain.toLowerCase()] || chain} ${effectName}`;

    // Only manage freeze suppression if called standalone (not from sweepEffects)
    if (!_calledFromSweep) _suppressFreeze(true);
    _log(`=== Testing: ${label} ===`);
    console.log(`%c[Sweep]%c ⏸ HANDS OFF — measuring baseline (4s)...`,
      'color:#0cf;font-weight:bold', 'color:#ff0');
    const before = await _measure(4);
    if (!before) { if (!_calledFromSweep) _suppressFreeze(false); return _warn('No readings'); }

    isolateEffect(chain, effectName);
    await _wait(1500);
    console.log(`%c[Sweep]%c ⏸ HANDS OFF — measuring without ${effectName} (4s)...`,
      'color:#0cf;font-weight:bold', 'color:#ff0');
    const after = await _measure(4);

    restoreEffect();
    await _wait(1500);

    if (before && after) {
      const delta = before.load - after.load;
      console.log(
        `%c[Result]%c  ${label}: %c${(delta * 100).toFixed(1)}%%c  ` +
        `(${(before.load*100).toFixed(1)}% → ${(after.load*100).toFixed(1)}%)`,
        'color:#0f0;font-weight:bold', 'color:#eee',
        `color:${delta > 0.02 ? '#f44' : delta > 0.01 ? '#fa0' : '#4f4'};font-weight:bold;font-size:14px`, 'color:#999'
      );
      console.log(`%c[Sweep]%c ✓ Safe to interact.`,
        'color:#0cf;font-weight:bold', 'color:#4f4');
      if (!_calledFromSweep) _suppressFreeze(false);
      return { chain, effect: effectName, before: before.load, after: after.load, delta };
    }
    if (!_calledFromSweep) _suppressFreeze(false);
    return null;
  }

  // Keep freeze from triggering during profiler measurements by resetting idle timers
  let _freezeSuppressInterval = null;
  function _suppressFreeze(on) {
    if (on && !_freezeSuppressInterval) {
      _freezeSuppressInterval = setInterval(() => {
        for (const [id, r] of Object.entries(regions)) {
          const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse :
                     id == 3 ? r.nightSky : id == 4 ? r.windHarp :
                     id == 5 ? r.celestialStrings : null;
          if (vs && vs.freezeIdleTime !== undefined) vs.freezeIdleTime = 0;
        }
      }, 2000);
      _log('Freeze suppressed during profiling');
    } else if (!on && _freezeSuppressInterval) {
      clearInterval(_freezeSuppressInterval);
      _freezeSuppressInterval = null;
      _log('Freeze suppression released');
    }
  }

  async function sweepEffects() {
    if (_sweepRunning) return _warn('Sweep already running');
    _sweepRunning = true;
    _suppressFreeze(true);

    // Determine which chains are active
    const chainDefs = [
      { key: 'wh', id: 4, name: 'Wind Harp' },
      { key: 'lw', id: 1, name: 'Living Wood' },
      { key: 'ns', id: 3, name: 'Night Sky' },
      { key: 'cs', id: 5, name: 'Celestial Strings' },
      { key: 'vp', id: 2, name: 'Village Pulse' },
    ];

    const activeChains = [];
    for (const c of chainDefs) {
      const r = regions[c.id];
      if (!r) continue;
      const vs = c.id == 1 ? r.livingWood : c.id == 2 ? r.villagePulse :
                 c.id == 3 ? r.nightSky : c.id == 4 ? r.windHarp :
                 c.id == 5 ? r.celestialStrings : null;
      if (vs && vs.active) {
        const effectMap = _getEffectMap(c.id);
        if (effectMap) activeChains.push({ ...c, effects: Object.keys(effectMap) });
      }
    }

    if (activeChains.length === 0) {
      _warn('No active voice systems found. Activate some regions first.');
      _sweepRunning = false;
      return;
    }

    const totalTests = activeChains.reduce((s, c) => s + c.effects.length, 0);
    const estTime = Math.ceil(totalTests * 10 / 60);
    _log(`=== EFFECT SWEEP: ${totalTests} effects across ${activeChains.length} active chains (~${estTime} min) ===`);
    _log(`Active: ${activeChains.map(c => c.name).join(', ')}`);

    // Warmup
    console.log(`%c[Sweep]%c Warming up monitor (4s)... you can move mouse.`,
      'color:#0cf;font-weight:bold', 'color:#4f4');
    await _measure(4);

    const results = [];
    let testNum = 0;

    for (const chain of activeChains) {
      for (const fx of chain.effects) {
        testNum++;
        _log(`── [${testNum}/${totalTests}] ${chain.name} → ${fx} ──`);
        const result = await testEffect(chain.key, fx, true);
        if (result) results.push(result);
        // Settle between tests
        console.log(`%c[Sweep]%c Settling (2s)... you can move mouse.`,
          'color:#0cf;font-weight:bold', 'color:#4f4');
        await _wait(2000);
      }
    }

    // Print summary table
    _log('=== EFFECT SWEEP RESULTS ===');
    console.table(Object.fromEntries(
      results.map(r => [`${r.chain.toUpperCase()} ${r.effect}`, {
        'Before %': (r.before * 100).toFixed(1),
        'Bypassed %': (r.after * 100).toFixed(1),
        'Cost %': (r.delta * 100).toFixed(1),
      }])
    ));

    // Sort by cost descending
    results.sort((a, b) => b.delta - a.delta);
    _log('─── Ranked by cost (highest first) ───');
    for (const r of results) {
      const pct = (r.delta * 100).toFixed(1);
      const clr = r.delta > 0.03 ? '#f44' : r.delta > 0.01 ? '#fa0' : '#4f4';
      console.log(
        `  %c${pct}%%c  ${r.chain.toUpperCase()} ${r.effect}`,
        `color:${clr};font-weight:bold;font-size:13px`, 'color:#eee'
      );
    }

    _suppressFreeze(false);
    _sweepRunning = false;
    _log('=== SWEEP COMPLETE ===');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MIX PROFILER — per-region level metering across states
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Usage:
  //   _audioProfile.mixCapture(regionId)       — start capturing a region
  //   _audioProfile.mixStop()                   — stop and print results
  //   _audioProfile.mixSummary()                — print all captured regions

  const _mixData = {};       // regionId → { active: {...}, loop5: {...}, loop10: {...}, frozen: {...} }
  let _mixCapture = null;    // current capture state

  const _regionNames = { 1: 'Cypress', 2: 'Village', 3: 'Night Sky', 4: 'Horizon', 5: 'Stars' };

  function _rmsToDb(rms) {
    return rms > 0.0001 ? 20 * Math.log10(rms) : -80;
  }

  function _centroidToHz(centroid, sampleRate) {
    return centroid * (sampleRate / 2);
  }

  // ── K-weighting curve for LUFS approximation ──
  // ITU-R BS.1770: high-shelf boost (~+4dB at 2kHz+) + highpass at 38Hz.
  // Pre-computed per FFT bin as dB offset, applied to frequency magnitude data.
  let _kWeightDb = null;
  let _kWeightLinear = null;

  function _ensureKWeight(sampleRate, binCount) {
    if (_kWeightLinear && _kWeightLinear.length === binCount) return;
    const nyquist = sampleRate / 2;
    const binHz = nyquist / binCount;
    _kWeightDb = new Float32Array(binCount);
    _kWeightLinear = new Float32Array(binCount);

    for (let i = 0; i < binCount; i++) {
      const f = (i + 0.5) * binHz;
      // Stage 1: High-shelf (pre-filter) — models head diffraction
      // Approximation: +4dB above 2kHz, flat below, smooth transition
      const shelfDb = 4.0 * (1 / (1 + Math.exp(-0.003 * (f - 1500))));  // sigmoid centered at 1.5kHz
      // Stage 2: High-pass at 38Hz — removes sub-bass energy that humans barely perceive
      const hpDb = f < 38 ? -80 : f < 80 ? -12 * (1 - (f - 38) / 42) : 0;
      _kWeightDb[i] = shelfDb + hpDb;
      _kWeightLinear[i] = Math.pow(10, _kWeightDb[i] / 20);
    }
  }

  // Compute K-weighted RMS from raw frequency data (Uint8Array, 0-255)
  function _computeKWeightedRms(freqData, sampleRate) {
    const binCount = freqData.length;
    _ensureKWeight(sampleRate, binCount);
    let weightedSum = 0;
    for (let i = 0; i < binCount; i++) {
      const mag = (freqData[i] / 255) * _kWeightLinear[i];
      weightedSum += mag * mag;
    }
    return Math.sqrt(weightedSum / binCount);
  }

  function _createBucket() {
    return {
      samples: 0,
      rmsSum: 0, rmsPeak: 0,
      kRmsSum: 0, kRmsPeak: 0,  // K-weighted (LUFS approximation)
      centroidSum: 0, centroidPeak: 0,
      spreadSum: 0,
      bassSum: 0, midsSum: 0, highsSum: 0,
    };
  }

  function _addSample(bucket, features, freqData, sampleRate) {
    bucket.samples++;
    bucket.rmsSum += features.rms;
    if (features.rms > bucket.rmsPeak) bucket.rmsPeak = features.rms;
    bucket.centroidSum += features.centroid;
    if (features.centroid > bucket.centroidPeak) bucket.centroidPeak = features.centroid;
    bucket.spreadSum += features.spread;
    bucket.bassSum += features.bass;
    bucket.midsSum += features.mids;
    bucket.highsSum += features.highs;
    // K-weighted LUFS approximation
    if (freqData) {
      const kRms = _computeKWeightedRms(freqData, sampleRate);
      bucket.kRmsSum += kRms;
      if (kRms > bucket.kRmsPeak) bucket.kRmsPeak = kRms;
    }
  }

  function _summarizeBucket(bucket, sampleRate) {
    if (bucket.samples === 0) return null;
    const n = bucket.samples;
    const avgRms = bucket.rmsSum / n;
    const avgKRms = bucket.kRmsSum / n;
    return {
      avgDb: _rmsToDb(avgRms).toFixed(1),
      peakDb: _rmsToDb(bucket.rmsPeak).toFixed(1),
      lufs: _rmsToDb(avgKRms).toFixed(1),
      lufsMax: _rmsToDb(bucket.kRmsPeak).toFixed(1),
      avgCentroidHz: Math.round(_centroidToHz(bucket.centroidSum / n, sampleRate)),
      peakCentroidHz: Math.round(_centroidToHz(bucket.centroidPeak, sampleRate)),
      avgSpread: (bucket.spreadSum / n).toFixed(3),
      avgBass: (bucket.bassSum / n).toFixed(3),
      avgMids: (bucket.midsSum / n).toFixed(3),
      avgHighs: (bucket.highsSum / n).toFixed(3),
      samples: n,
    };
  }

  function _printBucket(label, summary) {
    if (!summary) {
      console.log(`  ${label}: (no data)`);
      return;
    }
    console.log(
      `  %c${label}%c  avg %c${summary.avgDb} dB%c  peak %c${summary.peakDb} dB%c  ` +
      `LUFS %c${summary.lufs}%c (peak ${summary.lufsMax})  ` +
      `centroid ${summary.avgCentroidHz} Hz  spread ${summary.avgSpread}  ` +
      `bass ${summary.avgBass}  mids ${summary.avgMids}  highs ${summary.avgHighs}`,
      'color:#0cf;font-weight:bold', 'color:#eee',
      'color:#ff0;font-weight:bold', 'color:#eee',
      'color:#fa0;font-weight:bold', 'color:#eee',
      'color:#f0f;font-weight:bold', 'color:#999'
    );
  }

  function mixCapture(regionId) {
    const id = Number(regionId);
    const r = regions[id];
    if (!r) return _warn(`Region ${id} not found`);
    if (!r.analyzer) return _warn(`Region ${id} has no analyzer`);
    if (_mixCapture) return _warn('Already capturing — call mixStop() first');

    const name = _regionNames[id] || `Region ${id}`;
    const sampleRate = Tone.context?.sampleRate || 22050;

    const data = {
      id, name, sampleRate,
      active: _createBucket(),
      loop5: _createBucket(),
      loop10: _createBucket(),
      frozen: _createBucket(),
    };

    let loopStartTime = null;
    let prevState = r.state;
    let currentPhase = 'waiting';  // waiting → active → looping → capturing5 → capturing10 → frozen → done

    _log(`🎤 Capturing ${name} — activate the region now`);
    console.log(`%c[Mix]%c  Waiting for region ${id} to activate...`, 'color:#0cf;font-weight:bold', 'color:#eee');

    const interval = setInterval(() => {
      const state = r.state;
      const features = getRegionAudioFeatures(id);
      if (!features) return;
      const freqData = r.analyzer.getFrequencyData();  // raw FFT for K-weighting

      // Detect state transitions
      if (prevState !== state) {
        if (state === 'building' && currentPhase === 'waiting') {
          currentPhase = 'active';
          console.log(`%c[Mix]%c  ${name}: BUILDING — capturing active expression...`, 'color:#0cf;font-weight:bold', 'color:#4f4');
        }
        if (state === 'looping' && (currentPhase === 'active' || currentPhase === 'waiting')) {
          currentPhase = 'looping';
          loopStartTime = performance.now();
          console.log(`%c[Mix]%c  ${name}: LOOPING — will capture at 5s and 10s...`, 'color:#0cf;font-weight:bold', 'color:#4f4');
        }
        prevState = state;
      }

      // Check freeze
      const vs = id == 1 ? r.livingWood : id == 2 ? r.villagePulse :
                 id == 3 ? r.nightSky : id == 4 ? r.windHarp :
                 id == 5 ? r.celestialStrings : null;
      const isFrozen = vs && (vs.freezeState === 'frozen');

      // Sample based on current phase
      if (currentPhase === 'active' && (state === 'building' || state === 'reshaping')) {
        _addSample(data.active, features, freqData, sampleRate);
      }

      if (currentPhase === 'looping' && loopStartTime) {
        const elapsed = (performance.now() - loopStartTime) / 1000;

        // Always collect active data during early looping if user is still interacting
        if (state === 'looping' && elapsed < 3) {
          _addSample(data.active, features, freqData, sampleRate);
        }

        // 5s window: 4-6s
        if (elapsed >= 4 && elapsed < 6) {
          if (data.loop5.samples === 0) {
            console.log(`%c[Mix]%c  ${name}: Capturing 5s snapshot...`, 'color:#0cf;font-weight:bold', 'color:#ff0');
          }
          _addSample(data.loop5, features, freqData, sampleRate);
          currentPhase = 'capturing5';
        }
      }

      if (currentPhase === 'capturing5' && loopStartTime) {
        const elapsed = (performance.now() - loopStartTime) / 1000;
        if (elapsed < 6) {
          _addSample(data.loop5, features, freqData, sampleRate);
        } else {
          const s = _summarizeBucket(data.loop5, sampleRate);
          console.log(`%c[Mix]%c  ${name} @ 5s: avg ${s.avgDb} dB, peak ${s.peakDb} dB, LUFS ${s.lufs}, centroid ${s.avgCentroidHz} Hz`,
            'color:#0cf;font-weight:bold', 'color:#eee');
          currentPhase = 'waiting10';
        }
      }

      if (currentPhase === 'waiting10' && loopStartTime) {
        const elapsed = (performance.now() - loopStartTime) / 1000;
        if (elapsed >= 9 && elapsed < 11) {
          if (data.loop10.samples === 0) {
            console.log(`%c[Mix]%c  ${name}: Capturing 10s snapshot...`, 'color:#0cf;font-weight:bold', 'color:#ff0');
          }
          _addSample(data.loop10, features, freqData, sampleRate);
          currentPhase = 'capturing10';
        }
      }

      if (currentPhase === 'capturing10' && loopStartTime) {
        const elapsed = (performance.now() - loopStartTime) / 1000;
        if (elapsed < 11) {
          _addSample(data.loop10, features, freqData, sampleRate);
        } else {
          const s = _summarizeBucket(data.loop10, sampleRate);
          console.log(`%c[Mix]%c  ${name} @ 10s: avg ${s.avgDb} dB, peak ${s.peakDb} dB, LUFS ${s.lufs}, centroid ${s.avgCentroidHz} Hz`,
            'color:#0cf;font-weight:bold', 'color:#eee');
          currentPhase = 'waitingFreeze';
        }
      }

      if (currentPhase === 'waitingFreeze') {
        if (isFrozen) {
          console.log(`%c[Mix]%c  ${name}: FROZEN — capturing frozen snapshot...`, 'color:#0cf;font-weight:bold', 'color:#ff0');
          currentPhase = 'capturingFrozen';
        }
        // Still sample loop10 bucket as backup while waiting
      }

      if (currentPhase === 'capturingFrozen') {
        _addSample(data.frozen, features, freqData, sampleRate);
        if (data.frozen.samples >= 60) {  // ~1s at 60fps
          currentPhase = 'done';
          const s = _summarizeBucket(data.frozen, sampleRate);
          console.log(`%c[Mix]%c  ${name} frozen: avg ${s.avgDb} dB, peak ${s.peakDb} dB, LUFS ${s.lufs}, centroid ${s.avgCentroidHz} Hz`,
            'color:#0cf;font-weight:bold', 'color:#eee');
          console.log(`%c[Mix]%c  ✓ ${name} capture complete. Run mixStop() or activate next region.`,
            'color:#0cf;font-weight:bold', 'color:#4f4');
        }
      }

      // Auto-finish if region stops
      if (state === 'off' || state === 'stopping') {
        if (currentPhase !== 'waiting' && currentPhase !== 'done') {
          currentPhase = 'done';
          console.log(`%c[Mix]%c  ${name}: Region stopped — capture ended early.`,
            'color:#0cf;font-weight:bold', 'color:#fa0');
        }
      }
    }, 16);  // ~60fps sampling

    _mixCapture = { interval, data };
  }

  function mixStop() {
    if (!_mixCapture) return _log('No capture running');
    clearInterval(_mixCapture.interval);

    const d = _mixCapture.data;
    const sr = d.sampleRate;

    _mixData[d.id] = d;

    _log(`═══ ${d.name} Mix Profile ═══`);
    _printBucket('Active (expression)', _summarizeBucket(d.active, sr));
    _printBucket('Loop @ 5s          ', _summarizeBucket(d.loop5, sr));
    _printBucket('Loop @ 10s         ', _summarizeBucket(d.loop10, sr));
    _printBucket('Frozen             ', _summarizeBucket(d.frozen, sr));

    _mixCapture = null;
    _log(`Stored. Run mixCapture(N) for next region, or mixSummary() for comparison.`);
  }

  function mixSummary() {
    const ids = Object.keys(_mixData).sort();
    if (ids.length === 0) return _warn('No mix data captured yet');

    _log('═══════════════════════════════════════════════════════');
    _log('  MIX COMPARISON — All Captured Regions');
    _log('═══════════════════════════════════════════════════════');

    // Header
    console.log(
      '%c  Region          │ State    │ Avg dB │ Peak dB │  LUFS  │ Centroid │ Spread │ Bass  │ Mids  │ Highs',
      'color:#888'
    );
    console.log('%c  ────────────────┼──────────┼────────┼─────────┼────────┼──────────┼────────┼───────┼───────┼──────', 'color:#555');

    for (const id of ids) {
      const d = _mixData[id];
      const sr = d.sampleRate;
      const states = [
        { label: 'active', bucket: d.active },
        { label: 'loop@5s', bucket: d.loop5 },
        { label: 'loop@10s', bucket: d.loop10 },
        { label: 'frozen', bucket: d.frozen },
      ];
      for (const st of states) {
        const s = _summarizeBucket(st.bucket, sr);
        if (!s) continue;
        const name = st.label === 'active' ? d.name : '';
        const pad = (str, len) => String(str).padStart(len);
        console.log(
          `  ${(name || '').padEnd(15)} │ ${st.label.padEnd(8)} │ ${pad(s.avgDb, 6)} │ ${pad(s.peakDb, 7)} │ ${pad(s.lufs, 6)} │ ${pad(s.avgCentroidHz + 'Hz', 8)} │ ${pad(s.avgSpread, 6)} │ ${pad(s.avgBass, 5)} │ ${pad(s.avgMids, 5)} │ ${pad(s.avgHighs, 5)}`
        );
      }
      console.log('%c  ────────────────┼──────────┼────────┼─────────┼────────┼──────────┼────────┼───────┼───────┼──────', 'color:#555');
    }

    // Loudness ranking at loop@10s (settled state) — by LUFS (perceptual)
    const ranked = ids
      .map(id => {
        const s = _summarizeBucket(_mixData[id].loop10, _mixData[id].sampleRate);
        return s ? { name: _mixData[id].name, avgDb: parseFloat(s.avgDb), lufs: parseFloat(s.lufs), centroidHz: s.avgCentroidHz } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.lufs - a.lufs);

    if (ranked.length > 1) {
      _log('─── Perceived Loudness Ranking (loop @ 10s, LUFS) ───');
      for (let i = 0; i < ranked.length; i++) {
        const r = ranked[i];
        const delta = i > 0 ? (r.lufs - ranked[0].lufs).toFixed(1) : '  ref';
        console.log(
          `  %c${r.lufs.toFixed(1)} LUFS%c  (${r.avgDb.toFixed(1)} dB RMS)  ${r.name.padEnd(14)} centroid ${r.centroidHz} Hz  (${delta})`,
          'color:#f0f;font-weight:bold', 'color:#eee'
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NIGHT SKY LAYER SOLO/MUTE — isolate crackling source
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Usage:
  //   _audioProfile.nsMute('deep')     — mute deep noise band
  //   _audioProfile.nsMute('wind')     — mute stellar wind band
  //   _audioProfile.nsMute('air')      — mute high atmosphere band
  //   _audioProfile.nsMute('pad')      — mute FM pad
  //   _audioProfile.nsMute('voices')   — mute 6 melodic voices
  //   _audioProfile.nsUnmute('deep')   — restore
  //   _audioProfile.nsUnmuteAll()      — restore all

  const _nsMuted = {};

  function nsMute(layer) {
    const r = regions[3];
    if (!r || !r.nightSky) return _warn('Night Sky not built');
    const sky = r.nightSky;
    const l = layer.toLowerCase();
    const targets = {
      deep:   { node: sky.deepGain,  field: 'deep' },
      wind:   { node: sky.windGain,  field: 'wind' },
      air:    { node: sky.airGain,   field: 'air' },
      pad:    { node: sky.padGain,   field: 'pad' },
      voices: { node: sky.useWorklet ? null : null, field: 'voices', worklet: true },
    };
    const t = targets[l];
    if (!t) return _warn(`Unknown layer: "${layer}". Use: deep, wind, air, pad, voices`);

    if (l === 'voices') {
      // Mute voices via worklet or gain nodes
      if (sky.useWorklet && sky.workletNode) {
        _nsMuted.voices = true;
        const buf = sky._workletGainBuf;
        for (let i = 0; i < NS_VOICE_COUNT; i++) buf[i] = 0;
        sky.workletNode.port.postMessage({ type: 'gains', values: buf });
        sky._voicesMuted = true;
      } else {
        _nsMuted.voices = [];
        for (let i = 0; i < sky.voiceGains.length; i++) {
          _nsMuted.voices.push(sky.voiceGains[i].gain.value);
          sky.voiceGains[i].gain.value = 0;
        }
      }
    } else {
      _nsMuted[l] = t.node.gain.value;
      t.node.gain.cancelScheduledValues(Tone.now());
      t.node.gain.value = 0;
    }
    _log(`🔇 Night Sky ${l} MUTED`);
  }

  function nsUnmute(layer) {
    const r = regions[3];
    if (!r || !r.nightSky) return _warn('Night Sky not built');
    const sky = r.nightSky;
    const l = layer.toLowerCase();

    if (l === 'voices') {
      sky._voicesMuted = false;
      delete _nsMuted.voices;
      _log(`🔊 Night Sky voices UNMUTED (will restore on next frame)`);
    } else {
      const targets = { deep: sky.deepGain, wind: sky.windGain, air: sky.airGain, pad: sky.padGain };
      const node = targets[l];
      if (!node) return _warn(`Unknown layer: "${layer}"`);
      if (_nsMuted[l] !== undefined) {
        node.gain.value = _nsMuted[l];
        delete _nsMuted[l];
      }
      _log(`🔊 Night Sky ${l} UNMUTED`);
    }
  }

  function nsUnmuteAll() {
    for (const l of ['deep', 'wind', 'air', 'pad', 'voices']) nsUnmute(l);
    _log('🔊 All Night Sky layers UNMUTED');
  }

  function nsLimiter(threshold) {
    const r = regions[3];
    if (!r || !r.nightSky) return _warn('Night Sky not built');
    if (threshold === undefined) {
      _log(`NS limiter threshold: ${r.nightSky.limiter.threshold.value} dB`);
      return;
    }
    r.nightSky.limiter.threshold.value = threshold;
    _log(`NS limiter threshold set to ${threshold} dB`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MASTER BUS MEASUREMENT
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Usage:
  //   _audioProfile.mixMaster(seconds)  — capture master output for N seconds (default 10)

  async function mixMaster(seconds) {
    const dur = seconds || 10;
    const analyzer = window._connectMasterAnalyzer?.() || window._masterAnalyzer;
    if (!analyzer) return _warn('Master analyzer not available — reload page');
    const sampleRate = Tone.context?.sampleRate || 22050;

    _log(`🎤 Capturing master bus for ${dur}s — all active regions will be measured`);
    console.log(`%c[Mix]%c ⏸ HANDS OFF for ${dur}s...`, 'color:#0cf;font-weight:bold', 'color:#ff0');

    const bucket = _createBucket();
    const deadline = Date.now() + dur * 1000;

    await new Promise(resolve => {
      const interval = setInterval(() => {
        analyzer.analyze();
        const features = analyzer.getFeatures();
        const freqData = analyzer.getFrequencyData();
        _addSample(bucket, features, freqData, sampleRate);

        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve();
        }
      }, 16);
    });

    const s = _summarizeBucket(bucket, sampleRate);
    _log('═══ Master Bus Profile ═══');
    _printBucket('Master output     ', s);

    // Compare to reference levels
    console.log('');
    const lufs = parseFloat(s.lufs);
    console.log(`%c  Reference:%c  Spotify -14 LUFS  |  Podcast -18 LUFS  |  Ambient -24 LUFS`,
      'color:#888', 'color:#666');
    console.log(
      `%c  This mix: %c${s.lufs} LUFS%c  — ${lufs > -14 ? 'LOUDER than Spotify' : lufs > -18 ? 'between Spotify and podcast' : lufs > -24 ? 'podcast/ambient range' : 'quiet ambient'}`,
      'color:#888', 'color:#f0f;font-weight:bold', 'color:#999'
    );

    // Per-region comparison if we have individual data
    const ids = Object.keys(_mixData).sort();
    if (ids.length > 0) {
      console.log('');
      _log('─── Individual vs Master (loop@10s) ───');
      for (const id of ids) {
        const d = _mixData[id];
        const rs = _summarizeBucket(d.loop10, d.sampleRate);
        if (rs) {
          const rLufs = parseFloat(rs.lufs);
          console.log(
            `  ${d.name.padEnd(14)} ${rs.lufs} LUFS  (${(rLufs - lufs).toFixed(1)} dB below master)`,
          );
        }
      }
    }

    return s;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MIX SNAPSHOT — one command captures all active regions + master together
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Usage:
  //   _audioProfile.mixAll(seconds)  — capture all active regions + master (default 10s)

  async function mixAll(seconds) {
    const dur = seconds || 10;
    const sampleRate = Tone.context?.sampleRate || 22050;
    const masterAn = window._connectMasterAnalyzer?.() || window._masterAnalyzer;
    if (!masterAn) return _warn('Master analyzer not available — reload page');

    // Find active regions
    const active = [];
    for (const id of [1, 2, 3, 4, 5]) {
      const r = regions[id];
      if (r && r.analyzer && (r.state === 'looping' || r.state === 'building' || r.state === 'reshaping')) {
        active.push({ id, name: _regionNames[id], analyzer: r.analyzer });
      }
    }

    if (active.length === 0) return _warn('No active regions. Activate some regions first.');

    _suppressFreeze(true);
    _log(`🎤 Capturing ${active.length} regions + master for ${dur}s`);
    _log(`Active: ${active.map(a => a.name).join(', ')}`);
    console.log(`%c[Mix]%c ⏸ HANDS OFF for ${dur}s...`, 'color:#0cf;font-weight:bold', 'color:#ff0');

    // Create buckets for each region + master
    const buckets = {};
    for (const a of active) buckets[a.id] = _createBucket();
    const masterBucket = _createBucket();

    const deadline = Date.now() + dur * 1000;
    await new Promise(resolve => {
      const interval = setInterval(() => {
        // Sample each region
        for (const a of active) {
          a.analyzer.analyze();
          const features = a.analyzer.getFeatures();
          const freqData = a.analyzer.getFrequencyData();
          _addSample(buckets[a.id], features, freqData, sampleRate);
        }
        // Sample master
        masterAn.analyze();
        const mf = masterAn.getFeatures();
        const mfd = masterAn.getFrequencyData();
        _addSample(masterBucket, mf, mfd, sampleRate);

        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve();
        }
      }, 16);
    });

    _suppressFreeze(false);

    // Print results
    const masterS = _summarizeBucket(masterBucket, sampleRate);
    const masterLufs = parseFloat(masterS.lufs);

    _log('═══════════════════════════════════════════════════════');
    _log('  MIX SNAPSHOT — All Regions + Master');
    _log('═══════════════════════════════════════════════════════');

    // Header
    console.log(
      '%c  Source          │ Avg dB │ Peak dB │  LUFS  │ vs Master │ Centroid │ Spread │ Bass  │ Mids  │ Highs',
      'color:#888'
    );
    console.log('%c  ────────────────┼────────┼─────────┼────────┼───────────┼──────────┼────────┼───────┼───────┼──────', 'color:#555');

    // Regions sorted loudest to quietest by LUFS
    const regionResults = [];
    for (const a of active) {
      const s = _summarizeBucket(buckets[a.id], sampleRate);
      if (s) regionResults.push({ name: a.name, ...s });
    }
    regionResults.sort((a, b) => parseFloat(b.lufs) - parseFloat(a.lufs));

    for (const r of regionResults) {
      const rLufs = parseFloat(r.lufs);
      const delta = (rLufs - masterLufs).toFixed(1);
      const pad = (str, len) => String(str).padStart(len);
      console.log(
        `  ${r.name.padEnd(15)} │ ${pad(r.avgDb, 6)} │ ${pad(r.peakDb, 7)} │ ${pad(r.lufs, 6)} │ ${pad(delta + ' dB', 9)} │ ${pad(r.avgCentroidHz + 'Hz', 8)} │ ${pad(r.avgSpread, 6)} │ ${pad(r.avgBass, 5)} │ ${pad(r.avgMids, 5)} │ ${pad(r.avgHighs, 5)}`
      );
    }

    // Master row
    console.log('%c  ────────────────┼────────┼─────────┼────────┼───────────┼──────────┼────────┼───────┼───────┼──────', 'color:#555');
    const pad = (str, len) => String(str).padStart(len);
    console.log(
      `  %cMASTER%c          │ ${pad(masterS.avgDb, 6)} │ ${pad(masterS.peakDb, 7)} │ %c${pad(masterS.lufs, 6)}%c │     —     │ ${pad(masterS.avgCentroidHz + 'Hz', 8)} │ ${pad(masterS.avgSpread, 6)} │ ${pad(masterS.avgBass, 5)} │ ${pad(masterS.avgMids, 5)} │ ${pad(masterS.avgHighs, 5)}`,
      'color:#f0f;font-weight:bold', 'color:#eee',
      'color:#f0f;font-weight:bold', 'color:#eee'
    );

    // Reference
    console.log('');
    console.log(`%c  Reference:%c  Spotify -14 LUFS  |  Podcast -18 LUFS  |  Ambient -24 LUFS`,
      'color:#888', 'color:#666');
    console.log(
      `%c  This mix: %c${masterS.lufs} LUFS%c  — ${masterLufs > -14 ? 'LOUDER than Spotify' : masterLufs > -18 ? 'between Spotify and podcast' : masterLufs > -24 ? 'podcast/ambient range' : 'quiet ambient'}`,
      'color:#888', 'color:#f0f;font-weight:bold', 'color:#999'
    );

    // Flag imbalances
    if (regionResults.length > 1) {
      const loudest = parseFloat(regionResults[0].lufs);
      const quietest = parseFloat(regionResults[regionResults.length - 1].lufs);
      const spread = loudest - quietest;
      console.log('');
      _log(`Spread: ${spread.toFixed(1)} dB LUFS (loudest ${regionResults[0].name} to quietest ${regionResults[regionResults.length - 1].name})`);
      for (const r of regionResults) {
        const rLufs = parseFloat(r.lufs);
        if (rLufs - loudest < -3) {
          _warn(`${r.name} is ${(rLufs - loudest).toFixed(1)} dB below ${regionResults[0].name} — may be buried`);
        }
      }
    }
  }

  window._audioProfile = { monitor, snapshot, isolate, restore, test, sweep, nodeCount,
    isolateEffect, restoreEffect, testEffect, sweepEffects,
    mixCapture, mixStop, mixSummary, nsMute, nsUnmute, nsUnmuteAll, nsLimiter,
    mixMaster, mixAll };
  _log('Profiler ready: _audioProfile.mixAll() to snapshot all regions + master');
}
