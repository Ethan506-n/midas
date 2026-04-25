import http2 from 'http2';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { router } from './router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../public');

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const USE_HTTP2 = process.env.USE_HTTP2 === 'true';

let server;

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC, safePath);

  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end(); return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }

  const ext = path.extname(filePath);
  const mime = {
    '.js': 'application/javascript',
    '.html': 'text/html',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  }[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'content-type': mime,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/_midas/')) {
    router(req, res, url);
    return;
  }

  // Serve any static file from public directory
  const staticFiles = ['/sw.js', '/loader.js', '/midas.client.js', '/manifest.json', '/demo.html', '/index.html'];
  const isStatic = staticFiles.includes(url.pathname) || url.pathname.match(/\.(js|html|css|json|wasm|png|jpg|svg|ico)$/);
  if (isStatic) {
    serveStatic(req, res, url.pathname);
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>midas-proxy</title>
<style>
  html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111;color:#eee}
  form{display:flex;gap:6px;padding:8px;background:#1b1b1b;border-bottom:1px solid #333}
  input[type=text]{flex:1;padding:8px 10px;border:1px solid #333;background:#0d0d0d;color:#eee;border-radius:4px;font:inherit}
  button{padding:8px 14px;border:0;background:#2d7;border-radius:4px;color:#000;font-weight:600;cursor:pointer}
  iframe{width:100%;height:calc(100% - 50px);border:0;background:#fff}
</style></head><body>
<form id="f" onsubmit="go(event)">
  <input id="u" type="text" placeholder="https://example.com" autofocus>
  <button type="submit">Go</button>
</form>
<iframe id="frame" src="about:blank"></iframe>
<script>
  function go(e){
    e.preventDefault();
    let v=document.getElementById('u').value.trim();
    if(!v) return;
    if(!/^https?:\\/\\//i.test(v)) v='https://'+v;
    document.getElementById('frame').src='/_midas/browse?url='+encodeURIComponent(v);
  }
</script>
</body></html>`);
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  router(req, res, url);
}

if (USE_HTTP2) {
  try {
    const keyPath = path.join(__dirname, 'key.pem');
    const certPath = path.join(__dirname, 'cert.pem');
    let key, cert;
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      key = fs.readFileSync(keyPath);
      cert = fs.readFileSync(certPath);
    } else {
      const { generateKeyPairSync } = await import('crypto');
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      // Note: self-signed cert generation simplified; in prod use real certs
      console.warn('No TLS certs found, falling back to HTTP/1.1');
      throw new Error('No certs');
    }
    server = http2.createSecureServer({ key, cert, allowHTTP1: true }, handler);
    console.log(`Midas server listening on HTTPS/2 port ${PORT}`);
  } catch (e) {
    server = http.createServer(handler);
    console.log(`Midas server listening on HTTP/1.1 ${HOST}:${PORT}`);
  }
} else {
  server = http.createServer(handler);
  console.log(`Midas server listening on HTTP/1.1 ${HOST}:${PORT}`);
}

server.listen(PORT, HOST);
