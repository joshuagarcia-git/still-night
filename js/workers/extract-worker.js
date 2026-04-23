/**
 * G22 extract worker — runs extractPointsWeighted off the main thread.
 *
 * Used by the intro-time benchmark in ui.js: if the bloom-phase frame time
 * exceeds the threshold, the main thread dispatches a re-extraction at a
 * lower density to this worker. The result is sent back via transfer (zero
 * copy) so loadPoints can swap the buffer without freezing the render loop.
 *
 * ES module worker — requires Safari 15+ / Firefox 114+ / Chrome 80+.
 */

import { extractPointsWeighted } from '../dither/points.js';

self.onmessage = (e) => {
  try {
    const t0 = performance.now();
    const result = extractPointsWeighted(...e.data);
    const elapsed = performance.now() - t0;
    // Transfer all per-attribute buffers back zero-copy.
    const transfers = [result.homePos.buffer, result.colors.buffer];
    if (result.regions)       transfers.push(result.regions.buffer);
    if (result.boundaryDists) transfers.push(result.boundaryDists.buffer);
    if (result.coherences)    transfers.push(result.coherences.buffer);
    if (result.flowAngles)    transfers.push(result.flowAngles.buffer);
    self.postMessage({ result, elapsed }, transfers);
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
