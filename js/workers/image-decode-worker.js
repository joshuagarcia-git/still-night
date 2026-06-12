// Classic (non-module) worker: fetch + decode + pixel readback for the
// radiant mood image, fully off the main thread so arrival never hitches
// the live canvas. One-shot — the caller terminates it after the reply.
//
// Message in:  { path } — absolute URL (worker-relative paths would resolve
//                          against js/workers/, not the site root).
// Message out: { width, height, buffer } with the RGBA buffer transferred,
//              or { error } on any failure (caller decides retry policy —
//              it must NOT re-download on fetch failure, only on worker
//              bootstrap failure, to avoid double-spending bandwidth).
//
// Requires OffscreenCanvas 2D (Chrome 69+, Firefox 105+, Safari 16.4+).
// The caller feature-detects before spawning and falls back to a
// main-thread decode otherwise.
self.onmessage = async (e) => {
  // Capability probe BEFORE the fetch: if this environment can't decode,
  // reply { unsupported } so the caller falls back to a main-thread decode
  // knowing no bandwidth was spent. Replying a generic error here would
  // trap the caller in a worker-retry loop that can never succeed.
  try {
    if (typeof createImageBitmap !== 'function' ||
        !new OffscreenCanvas(1, 1).getContext('2d')) throw new Error('no 2d');
  } catch (_) {
    self.postMessage({ unsupported: true });
    return;
  }
  try {
    const res = await fetch(e.data.path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    self.postMessage(
      { width: imageData.width, height: imageData.height, buffer: imageData.data.buffer },
      [imageData.data.buffer]
    );
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
