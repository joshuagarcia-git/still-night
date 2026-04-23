/**
 * Canvas I/O utilities — image loading, drawing, and download.
 */

/**
 * Load an image from a URL/path, draw it to canvas, return ImageData.
 * Canvas is resized to match image dimensions.
 */
export function loadImageFromPath(canvas, path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${path}`));
    img.src = path;
  });
}

/**
 * Load an image from a File object, draw it to canvas, return ImageData.
 */
export function loadImageFromFile(canvas, file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image file'));
    };
    img.src = url;
  });
}

/**
 * Draw an ImageData object onto the canvas.
 */
export function drawImageData(canvas, imageData) {
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Trigger download of the current canvas content as PNG.
 */
export function downloadCanvasAsPNG(canvas, filename = 'dithered.png') {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
