/**
 * FreezeTapProcessor — Pass-through AudioWorklet for freeze-to-buffer capture.
 *
 * Sits inline in the signal chain (e.g., after limiter, before region filter).
 * Passes input through to output unchanged — zero audible impact.
 * On 'startCapture' message, begins accumulating input samples into an internal buffer.
 * On 'stopCapture', transfers the accumulated buffer back to the main thread.
 *
 * Mono input/output (matches starsMixBus/cypressMixBus topology).
 */

class FreezeTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const config = options.processorOptions || {};
    this.sRate = config.sampleRate || sampleRate || 22050;

    // Capture state
    this.capturing = false;
    this.captureBuffer = null;   // Float32Array, allocated on startCapture
    this.captureOffset = 0;     // write position
    this.captureLength = 0;     // total samples to capture

    this.port.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'startCapture': {
          // msg.duration: seconds to capture (e.g., 25)
          const duration = msg.duration || 25;
          this.captureLength = Math.ceil(duration * this.sRate);
          this.captureBuffer = new Float32Array(this.captureLength);
          this.captureOffset = 0;
          this.capturing = true;
          break;
        }
        case 'stopCapture':
          this._finishCapture();
          break;
        case 'abortCapture':
          this.capturing = false;
          this.captureBuffer = null;
          this.captureOffset = 0;
          break;
      }
    };
  }

  _finishCapture() {
    if (!this.captureBuffer) return;
    this.capturing = false;

    // Trim to actual captured length (may be less if stopped early)
    const actual = Math.min(this.captureOffset, this.captureLength);
    const result = this.captureBuffer.slice(0, actual);

    // Transfer the buffer (zero-copy)
    this.port.postMessage(
      { type: 'captureComplete', buffer: result, sampleRate: this.sRate },
      [result.buffer]  // transferable
    );

    this.captureBuffer = null;
    this.captureOffset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Pass-through: copy input to output
    if (input && input.length > 0 && output && output.length > 0) {
      const inCh = input[0];
      const outCh = output[0];
      const len = inCh.length;

      // Copy input → output
      for (let i = 0; i < len; i++) {
        outCh[i] = inCh[i];
      }

      // Accumulate if capturing
      if (this.capturing && this.captureBuffer) {
        const remaining = this.captureLength - this.captureOffset;
        const toCopy = Math.min(len, remaining);
        for (let i = 0; i < toCopy; i++) {
          this.captureBuffer[this.captureOffset++] = inCh[i];
        }
        // Auto-finish when buffer is full
        if (this.captureOffset >= this.captureLength) {
          this._finishCapture();
        }
      }
    } else if (output && output.length > 0) {
      // No input — output silence
      for (let i = 0; i < output[0].length; i++) {
        output[0][i] = 0;
      }
    }

    return true;
  }
}

registerProcessor('freeze-tap-processor', FreezeTapProcessor);
