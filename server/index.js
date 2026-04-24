import http2 from 'http2';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { router } from './router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../public');

const PORT = process.env.PORT || 8443;
const USE_HTTP2 = process.env.USE_HTTP2 !== 'false';

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

  if (url.pathname === '/sw.js' || url.pathname === '/loader.js' || url.pathname === '/midas.client.js' || url.pathname === '/manifest.json') {
    serveStatic(req, res, url.pathname);
    return;
  }

  if (url.pathname === '/') {
    serveStatic(req, res, 'index.html');
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
    console.log(`Midas server listening on HTTP/1.1 port ${PORT}`);
  }
} else {
  server = http.createServer(handler);
  console.log(`Midas server listening on HTTP/1.1 port ${PORT}`);
}

server.listen(PORT);
