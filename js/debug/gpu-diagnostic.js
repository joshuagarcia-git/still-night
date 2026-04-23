/**
 * GPU Diagnostic — stage-by-stage WebGL 2 capability test.
 * Triggered by ?diagnose URL parameter. Tests each initialization stage
 * independently to identify exactly where Intel/weak GPUs fail.
 */

import { SHADER_SOURCES } from '../gl-renderer.js';
import { ditherErrorDiffusion } from '../dither/dither-engine.js';
import { loadImageFromPath } from '../dither/canvas-renderer.js';
import { extractPointsWeighted } from '../dither/points.js';
import { computeImportanceMap } from '../dither/importance.js';

// ── Display panel ──────────────────────────────────────────────────────────

function createDiagPanel(canvas) {
  const container = canvas.closest('.canvas-container') || canvas.parentElement;
  if (container) container.style.flex = '1';

  const panel = document.createElement('div');
  panel.style.cssText =
    'position:absolute;inset:0;z-index:9999;' +
    'background:#0a0a0a;color:#e0e0e0;' +
    'font-family:"SF Mono","Consolas","Monaco",monospace;' +
    'font-size:13px;line-height:1.6;' +
    'overflow-y:auto;-webkit-overflow-scrolling:touch;padding:20px;';

  const title = document.createElement('h2');
  title.textContent = 'GPU Diagnostic';
  title.style.cssText = 'color:#fff;margin:0 0 16px;font-size:18px;font-weight:500;';
  panel.appendChild(title);

  const list = document.createElement('div');
  panel.appendChild(list);
  container.appendChild(panel);

  const colors = { PASS: '#4ade80', FAIL: '#ef4444', WARN: '#facc15', INFO: '#60a5fa' };

  return {
    addResult(label, status, detail) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:6px;padding:6px 10px;border-radius:4px;background:#1a1a1a;';
      const dot = status !== 'INFO' ? `<span style="color:${colors[status]}">●</span> ` : '';
      row.innerHTML =
        `<div style="color:${colors[status] || '#999'};font-weight:500">${dot}${label}</div>` +
        `<div style="color:#888;font-size:11px;white-space:pre-wrap;margin-top:2px">${detail}</div>`;
      list.appendChild(row);
      panel.scrollTop = panel.scrollHeight;
    },
    addSpacer() {
      const hr = document.createElement('hr');
      hr.style.cssText = 'border:none;border-top:1px solid #333;margin:12px 0;';
      list.appendChild(hr);
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const delay = (ms = 50) => new Promise(r => setTimeout(r, ms));

function glErrorName(gl, err) {
  const names = {
    [gl.INVALID_ENUM]: 'INVALID_ENUM',
    [gl.INVALID_VALUE]: 'INVALID_VALUE',
    [gl.INVALID_OPERATION]: 'INVALID_OPERATION',
    [gl.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION',
    [gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
    [gl.CONTEXT_LOST_WEBGL]: 'CONTEXT_LOST_WEBGL',
  };
  return names[err] || `0x${err.toString(16)}`;
}

function drainErrors(gl) {
  while (gl.getError() !== gl.NO_ERROR) {}
}

function checkError(gl) {
  const err = gl.getError();
  return err === gl.NO_ERROR ? null : glErrorName(gl, err);
}

function fboStatusName(gl, status) {
  const names = {
    [gl.FRAMEBUFFER_COMPLETE]: 'COMPLETE',
    [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: 'INCOMPLETE_ATTACHMENT',
    [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: 'INCOMPLETE_MISSING_ATTACHMENT',
    [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]: 'INCOMPLETE_DIMENSIONS',
    [gl.FRAMEBUFFER_UNSUPPORTED]: 'UNSUPPORTED',
    [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE]: 'INCOMPLETE_MULTISAMPLE',
  };
  return names[status] || `0x${status.toString(16)}`;
}

// ── Main diagnostic ────────────────────────────────────────────────────────

export async function runGpuDiagnostic(canvas) {
  const panel = createDiagPanel(canvas);

  // Ensure canvas has dimensions before creating context
  if (!canvas.width || !canvas.height) {
    canvas.width = 800;
    canvas.height = 600;
  }

  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) {
    panel.addResult('WebGL 2', 'FAIL', 'getContext("webgl2") returned null');
    return;
  }
  panel.addResult('WebGL 2', 'PASS', 'Context created');

  // Context lost tracking
  let contextLost = false;
  let contextLostStage = '';
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
  });

  // Stage runner — wraps each stage with error/context checks
  async function run(label, fn, delayMs = 50) {
    if (contextLost) {
      panel.addResult(label, 'FAIL', `Skipped — context lost during: ${contextLostStage}`);
      return false;
    }
    contextLostStage = label;
    drainErrors(gl);
    const t0 = performance.now();
    try {
      const detail = await fn();
      gl.flush();
      gl.finish();
      await delay(delayMs);

      if (gl.isContextLost() || contextLost) {
        contextLost = true;
        const ms = (performance.now() - t0).toFixed(0);
        panel.addResult(label, 'FAIL', `Context lost (${ms}ms)`);
        return false;
      }
      const errStr = checkError(gl);
      const ms = (performance.now() - t0).toFixed(0);
      if (errStr) {
        panel.addResult(label, 'FAIL', `GL error: ${errStr} (${ms}ms)`);
        return false;
      }
      const warn = typeof detail === 'string' && detail.startsWith('WARN:');
      panel.addResult(label, warn ? 'WARN' : 'PASS', `${(detail || 'OK')} (${ms}ms)`);
      return true;
    } catch (e) {
      const ms = (performance.now() - t0).toFixed(0);
      panel.addResult(label, 'FAIL', `${e.message} (${ms}ms)`);
      return false;
    }
  }

  // ── Stage A: GPU Info ──────────────────────────────────────────────────

  panel.addSpacer();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const info = [
    `Renderer: ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`,
    `Vendor: ${dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)}`,
    `Version: ${gl.getParameter(gl.VERSION)}`,
    `GLSL: ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`,
    `Max Vert Uniforms: ${gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS)} vec4`,
    `Max Frag Uniforms: ${gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)} vec4`,
    `Max Varyings: ${gl.getParameter(gl.MAX_VARYING_VECTORS)} vec4`,
    `Max Vert Textures: ${gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)}`,
    `Max Texture Size: ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`,
    `Max Vertex Attribs: ${gl.getParameter(gl.MAX_VERTEX_ATTRIBS)}`,
    `Max TF Varyings: ${gl.getParameter(gl.MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS)}`,
  ];
  panel.addResult('A. GPU Info', 'INFO', info.join('\n'));
  await delay(100);

  // ── Stage B: Shader Compilation ────────────────────────────────────────

  panel.addSpacer();
  const S = SHADER_SOURCES;
  const programs = {};

  const shaderTests = [
    ['B1. Render',           S.RENDER_VERT,       S.RENDER_FRAG,       null],
    ['B2. Composite',        S.COMPOSITE_VERT,    S.COMPOSITE_FRAG,    null],
    ['B3. Tonal',            S.TONAL_VERT,        S.TONAL_FRAG,        null],
    ['B4. Shadow',           S.SHADOW_VERT,       S.SHADOW_FRAG,       null],
    ['B5. Sim (TF)',         S.SIM_VERT,           S.SIM_FRAG,          ['v_newPos']],
  ];

  for (const [label, vertSrc, fragSrc, tfVaryings] of shaderTests) {
    const ok = await run(label, () => {
      // Compile vertex shader
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, vertSrc);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(vs) || '(no log)';
        gl.deleteShader(vs);
        throw new Error(`Vert compile: ${log.substring(0, 200)}`);
      }

      // Compile fragment shader
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, fragSrc);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(fs) || '(no log)';
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        throw new Error(`Frag compile: ${log.substring(0, 200)}`);
      }

      // Link program
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      if (tfVaryings) {
        gl.transformFeedbackVaryings(prog, tfVaryings, gl.SEPARATE_ATTRIBS);
      }
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) || '(no log)';
        gl.deleteProgram(prog);
        throw new Error(`Link: ${log.substring(0, 200)}`);
      }

      // Count active uniforms for info
      const numUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      programs[label] = prog;

      // Check for warnings in logs
      const vertLog = gl.getShaderInfoLog(vs) || '';
      const fragLog = gl.getShaderInfoLog(fs) || '';
      const warnText = [vertLog, fragLog].filter(l => l.trim()).join('; ');

      const lines = vertSrc.split('\n').length + fragSrc.split('\n').length;
      let result = `${numUniforms} active uniforms, ${lines} GLSL lines`;
      if (warnText) result = `WARN: ${result}\nWarnings: ${warnText.substring(0, 150)}`;
      return result;
    }, label.includes('Render') || label.includes('Sim') ? 200 : 50);

    if (!ok && contextLost) break;
  }

  // ── Stage C: Resource Creation ─────────────────────────────────────────

  panel.addSpacer();

  await run('C1. Texture 256x256', () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return '256 KB';
  });

  await run('C2. Texture 2048x1622', () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2048, 1622, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const mb = (2048 * 1622 * 4 / 1024 / 1024).toFixed(1);
    return `${mb} MB`;
  });

  await run('C3. Single FBO 2048x1622', () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2048, 1622, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer: ${fboStatusName(gl, status)}`);
    }
    return 'Complete';
  });

  await run('C4. 4 FBOs 2048x1622 (trail system)', () => {
    let totalMB = 0;
    for (let f = 0; f < 4; f++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2048, 1622, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`FBO ${f}: ${fboStatusName(gl, status)}`);
      }
      totalMB += 2048 * 1622 * 4 / 1024 / 1024;
    }
    return `4 complete, ${totalMB.toFixed(0)} MB total`;
  });

  const vertexCounts = [1000, 100000, 3300000];
  for (const count of vertexCounts) {
    const label = `C5. VBO ${(count / 1000).toFixed(0)}K vertices`;
    await run(label, () => {
      const data = new Float32Array(count * 2);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const mb = (data.byteLength / 1024 / 1024).toFixed(1);
      return `${mb} MB`;
    });
  }

  await run('C6. Transform feedback buffers', () => {
    const size = 3300000 * 2 * 4; // vec2 per particle
    const bufA = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufA);
    gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_COPY);
    const bufB = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
    gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_COPY);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const tf = gl.createTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, bufB);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    const mb = (size * 2 / 1024 / 1024).toFixed(0);
    return `2 ping-pong buffers, ${mb} MB total`;
  });

  // ── Stage E: CPU Pipeline (dithering, point extraction) ─────────────────

  panel.addSpacer();

  let cpuPointCount = 0;

  await run('E1. Load painting image', async () => {
    const tempCanvas = document.createElement('canvas');
    const imgData = await loadImageFromPath(tempCanvas, 'assets/starry_night.webp');
    window._diagImageData = imgData;
    return `${imgData.width}x${imgData.height} (${(imgData.data.byteLength / 1024 / 1024).toFixed(1)} MB)`;
  });

  if (window._diagImageData) {
    const imgData = window._diagImageData;
    const w = imgData.width;
    const h = imgData.height;

    await run('E2. Floyd-Steinberg dithering', () => {
      const matrix = [[0, 0, 7/16], [1, -1, 3/16], [1, 0, 5/16], [1, 1, 1/16]];
      const palette = [[0,0,0],[255,255,255]];
      window._diagDithered = ditherErrorDiffusion(imgData.data, w, h, matrix, palette, true);
      const blackPixels = window._diagDithered.reduce((n, v) => n + (v === 0 ? 1 : 0), 0) / 4;
      return `${w}x${h} = ${(w * h / 1000000).toFixed(1)}M pixels, ~${(blackPixels / 1000).toFixed(0)}K black`;
    });

    await run('E3. Importance map', () => {
      window._diagImportance = computeImportanceMap(imgData.data, w, h);
      return `${w}x${h}`;
    });

    if (window._diagDithered && window._diagImportance) {
      await run('E4. Point cloud extraction', () => {
        // Minimal seg args — no segmentation data, just extract points
        const result = extractPointsWeighted(
          window._diagDithered, imgData.data, w, h,
          [[0,0,0],[255,255,255]], window._diagImportance, 1.0
        );
        cpuPointCount = result.count;
        const bytes = result.homePos.byteLength + result.colors.byteLength;
        const mb = (bytes / 1024 / 1024).toFixed(1);
        return `${result.count.toLocaleString()} particles, ${mb} MB`;
      });
    }

    // Cleanup
    delete window._diagImageData;
    delete window._diagDithered;
    delete window._diagImportance;
  }

  // ── Stage D: Draw Tests ────────────────────────────────────────────────

  panel.addSpacer();

  // Create a minimal VAO with dummy vertex data for draw tests
  function makeTestVAO(count) {
    const data = new Float32Array(count * 2);
    for (let i = 0; i < data.length; i++) data[i] = Math.random();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, buf };
  }

  // D1-D5: Draw particles with render shader (if it compiled)
  const renderProg = programs['B1. Render'];
  if (renderProg) {
    const drawCounts = [1, 1000, 100000, 1000000, 3300000];
    for (const count of drawCounts) {
      const label = `D1. Draw ${count >= 1000000 ? (count / 1000000).toFixed(1) + 'M' : count >= 1000 ? (count / 1000) + 'K' : count} pts (render)`;
      await run(label, () => {
        const { vao } = makeTestVAO(count);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(renderProg);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.bindVertexArray(null);
        return `${count} vertices`;
      }, 100);
      if (contextLost) break;
    }
  } else {
    panel.addResult('D1-D5. Render draws', 'FAIL', 'Skipped — render shader did not compile');
  }

  // D6: Sim shader transform feedback
  const simProg = programs['B5. Sim (TF)'];
  if (simProg && !contextLost) {
    await run('D6. Sim TF 1K particles', () => {
      const count = 1000;
      const inputData = new Float32Array(count * 2);
      for (let i = 0; i < inputData.length; i++) inputData[i] = Math.random() * 0.5 + 0.25;

      const inputBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, inputBuf);
      gl.bufferData(gl.ARRAY_BUFFER, inputData, gl.STATIC_DRAW);

      const outputBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, outputBuf);
      gl.bufferData(gl.ARRAY_BUFFER, count * 2 * 4, gl.DYNAMIC_COPY);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, inputBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      const tf = gl.createTransformFeedback();

      gl.useProgram(simProg);
      gl.bindVertexArray(vao);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, outputBuf);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindVertexArray(null);

      return `${count} particles through TF`;
    }, 100);
  } else if (!contextLost) {
    panel.addResult('D6. Sim TF', 'FAIL', 'Skipped — sim shader did not compile');
  }

  // D7: Composite fullscreen quad
  const compositeProg = programs['B2. Composite'];
  if (compositeProg && !contextLost) {
    await run('D7. Composite quad', () => {
      const vao = gl.createVertexArray();
      gl.useProgram(compositeProg);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      return 'Fullscreen quad';
    });
  } else if (!contextLost) {
    panel.addResult('D7. Composite', 'FAIL', 'Skipped — composite shader did not compile');
  }

  // ── Summary ────────────────────────────────────────────────────────────

  panel.addSpacer();
  if (contextLost) {
    panel.addResult('RESULT', 'FAIL', `Context lost during: ${contextLostStage}`);
  } else {
    panel.addResult('RESULT', 'PASS', 'All stages completed without context loss');
  }
}
