const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mid': 'audio/midi',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.dvs': 'application/octet-stream',
};

const ROOT = __dirname;
const PORT = parseInt(process.env.PORT, 10) || 8080;

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  // Pre-compressed Brotli asset: strip .br, look up the underlying MIME type,
  // and set Content-Encoding so the browser decompresses transparently. Matches
  // the netlify.toml rule for production.
  const isBrotli = filePath.endsWith('.br');
  const headerExt = isBrotli
    ? path.extname(filePath.slice(0, -3)).toLowerCase()
    : path.extname(filePath).toLowerCase();
  const mime = MIME[headerExt] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const headers = {
      'Content-Type': mime,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    };
    if (isBrotli) headers['Content-Encoding'] = 'br';
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`Serving on http://0.0.0.0:${PORT}`));
