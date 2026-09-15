import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { createDownloadHandler } from '../integrations/kool/download-handler.mjs';

const root = fileURLToPath(new URL('../landing/', import.meta.url));
const port = Number(process.env.PORT || 4174);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');
// Local verification can never create a real campaign conversion, even if the
// developer's shell happens to carry production deployment variables.
const download = createDownloadHandler({
  env: { ...process.env, VERCEL_ENV: 'development' },
  diagnose: (code, details) => console.log(JSON.stringify({ code, ...details })),
});
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/download') { await download(request, response); return; }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
      || pathname.split('/').some(part => part.startsWith('.'))) {
      response.writeHead(404); response.end(); return;
    }
    const info = await stat(file);
    if (!info.isFile()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Warden landing test server: http://127.0.0.1:${port} (Kool test mode)`));
