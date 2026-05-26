import http2 from 'http2';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { router } from './router.js';
import { wsUpgradeHandler } from './ws-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '../public');

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const USE_HTTP2 = process.env.USE_HTTP2 === 'true';

const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>midas-proxy</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0d0f12;color:#e8e8e8}
  .bar{display:flex;gap:6px;padding:8px;background:#16191f;border-bottom:1px solid #2a2f38;align-items:center;height:50px}
  .bar button{padding:0 12px;height:34px;min-width:34px;border:1px solid #2a2f38;background:#1d212a;color:#cdd2da;border-radius:6px;cursor:pointer;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
  .bar button:hover:not(:disabled){background:#262b36;border-color:#3a4150}
  .bar button:active:not(:disabled){background:#1a1f28}
  .bar button:disabled{opacity:.35;cursor:not-allowed}
  .bar #go{background:#2dd47a;border-color:#2dd47a;color:#0a1f12;font-weight:600;padding:0 16px}
  .bar #go:hover{background:#3ce58a;border-color:#3ce58a}
  #u{flex:1;height:34px;padding:0 12px;border:1px solid #2a2f38;background:#0a0c10;color:#f0f0f0;border-radius:6px;font:inherit;outline:none;min-width:0}
  #u:focus{border-color:#3a8dff;box-shadow:0 0 0 2px #3a8dff33}
  #status{font-size:12px;color:#7a8290;padding:0 6px;white-space:nowrap}
  #frame{width:100%;height:calc(100% - 50px);border:0;background:#fff;display:block}
  .loading #status::before{content:'';display:inline-block;width:10px;height:10px;border:2px solid #3a8dff;border-top-color:transparent;border-radius:50%;margin-right:6px;vertical-align:-2px;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .engine{position:relative}
  .engine select{height:34px;background:#1d212a;color:#cdd2da;border:1px solid #2a2f38;border-radius:6px;padding:0 8px;font:inherit;cursor:pointer}
</style></head><body>
<div class="bar">
  <button id="back" title="Back (Alt+Left)" aria-label="Back">&lsaquo;</button>
  <button id="fwd" title="Forward (Alt+Right)" aria-label="Forward">&rsaquo;</button>
  <button id="reload" title="Reload (F5)" aria-label="Reload">&#x21bb;</button>
  <button id="home" title="Home" aria-label="Home">&#x2302;</button>
  <input id="u" type="text" placeholder="Search the web or enter an address" autofocus spellcheck="false" autocomplete="off">
  <span class="engine">
    <select id="engine" title="Search engine">
      <option value="ddg">DuckDuckGo</option>
      <option value="bing">Bing</option>
      <option value="brave">Brave</option>
      <option value="wiki">Wikipedia</option>
    </select>
  </span>
  <button id="go">Go</button>
  <span id="status"></span>
</div>
  <iframe id="frame" name="midas-frame" src="about:blank" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation allow-downloads allow-modals allow-orientation-lock allow-pointer-lock allow-presentation"></iframe>
<script>
(()=>{
  const ENGINES = {
    ddg:   q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
    bing:  q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
    brave: q => 'https://search.brave.com/search?q=' + encodeURIComponent(q),
    wiki:  q => 'https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(q)
  };

  const $ = id => document.getElementById(id);
  const frame = $('frame');
  const ui = $('u');
  const status = $('status');
  const engine = $('engine');

  const stack = [];
  let cursor = -1;
  let suppressPush = false;

  let paths = null;
  let pathsFetched = 0;
  const PATHS_TTL = 4 * 60 * 1000;

  async function getPaths(force){
    const now = Date.now();
    if (!force && paths && (now - pathsFetched) < PATHS_TTL) return paths;
    try {
      const r = await fetch('/_midas/session?t=chunked', { cache: 'no-store', credentials: 'include' });
      if (r.ok) {
        const data = await r.json();
        if (data && data.paths) { paths = data.paths; pathsFetched = now; }
      }
    } catch {}
    return paths;
  }

  function browsePath(){
    return paths && paths.browse ? '/_midas/' + paths.browse : '/_midas/browse';
  }

  function isProxyPath(pathname){
    return pathname.startsWith('/_midas/') && pathname !== '/_midas/session';
  }

  try { engine.value = localStorage.getItem('midas.engine') || 'ddg'; } catch {}
  engine.addEventListener('change', () => { try { localStorage.setItem('midas.engine', engine.value); } catch {} });

  function looksLikeUrl(v){
    if (/^https?:\/\//i.test(v)) return true;
    if (/\s/.test(v)) return false;
    if (/^localhost(:|\/|$)/i.test(v)) return true;
    if (/^[\w-]+(\.[\w-]+)+([:\/?#]|$)/.test(v)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}([:\/?#]|$)/.test(v)) return true;
    return false;
  }

  function smartUrl(input){
    const v = input.trim();
    if (!v) return null;
    try {
      const p = new URL(v, location.origin);
      if (p.origin === location.origin && isProxyPath(p.pathname)) return location.origin + p.pathname + p.search;
    } catch {}
    if (looksLikeUrl(v)) return /^https?:\/\//i.test(v) ? v : 'https://' + v;
    return ENGINES[engine.value](v);
  }

  function toProxy(target){
    try {
      const p = new URL(target, location.origin);
      if (p.origin === location.origin && isProxyPath(p.pathname)) return p.pathname + p.search;
    } catch {}
    return browsePath() + '?url=' + encodeURIComponent(target);
  }

  function targetOf(proxyUrl){
    try {
      const p = new URL(proxyUrl, location.origin);
      if (isProxyPath(p.pathname)) {
        const real = p.searchParams.get('url');
        if (!real) return '';
        const ru = new URL(real);
        for (const [k,v] of p.searchParams) if (k !== 'url') ru.searchParams.append(k, v);
        return ru.toString();
      }
      return proxyUrl;
    } catch { return proxyUrl; }
  }

  function setLoading(b){
    document.body.classList.toggle('loading', b);
    if (b) status.textContent = 'Loading...';
    else status.textContent = '';
  }

  function updateButtons(){
    $('back').disabled = cursor <= 0;
    $('fwd').disabled  = cursor >= stack.length - 1;
  }

  async function navigate(target, push){
    await getPaths(false);
    const proxied = toProxy(target);
    if (push) {
      stack.splice(cursor + 1);
      stack.push(proxied);
      cursor = stack.length - 1;
    }
    suppressPush = !push;
    setLoading(true);
    frame.src = proxied;
    updateButtons();
  }

  async function go(){
    const t = smartUrl(ui.value);
    if (!t) return;
    await navigate(t, true);
  }

  $('go').onclick = go;
  ui.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  ui.addEventListener('focus', () => ui.select());

  $('back').onclick   = () => { if (cursor > 0) { cursor--; navigate(stack[cursor], false); } };
  $('fwd').onclick    = () => { if (cursor < stack.length - 1) { cursor++; navigate(stack[cursor], false); } };
  $('reload').onclick = () => { if (cursor >= 0) { suppressPush = true; setLoading(true); frame.src = stack[cursor]; } };
  $('home').onclick   = () => { stack.length = 0; cursor = -1; frame.src = 'about:blank'; ui.value = ''; ui.focus(); status.textContent = ''; updateButtons(); };

  document.addEventListener('keydown', e => {
    if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); $('back').click(); }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); $('fwd').click(); }
    if (e.key === 'F5' || ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'r')) { e.preventDefault(); $('reload').click(); }
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); ui.focus(); }
  });

  frame.addEventListener('load', () => {
    setLoading(false);
    let src = frame.src || '';
    try {
      const inner = frame.contentWindow.location.href;
      if (inner && inner !== 'about:blank') src = inner;
    } catch {}

    const here = src.startsWith(location.origin) ? src.slice(location.origin.length) : src;
    const realTarget = targetOf(src);
    if (realTarget) {
      ui.value = realTarget;
      document.title = 'midas — ' + (frame.contentDocument ? (frame.contentDocument.title || realTarget) : realTarget);
    }

    if (here && here.startsWith('/_midas/browse?') && !suppressPush) {
      if (stack[cursor] !== here) {
        stack.splice(cursor + 1);
        stack.push(here);
        cursor = stack.length - 1;
      }
    }
    suppressPush = false;
    updateButtons();
  });

  getPaths(true);
  setInterval(() => getPaths(true), PATHS_TTL);

  const initial = new URLSearchParams(location.search);
  const initQ = initial.get('q');
  const initU = initial.get('url');
  if (initU) { ui.value = initU; navigate(initU, true); }
  else if (initQ) { ui.value = initQ; navigate(ENGINES[engine.value](initQ), true); }

  updateButtons();
})();
</script>
</body></html>`;

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

  const staticFiles = ['/sw.js', '/loader.js', '/midas.client.js', '/manifest.json', '/demo.html', '/index.html'];
  const isStaticCandidate = staticFiles.includes(url.pathname) || url.pathname.match(/\.(js|html|css|json|wasm|png|jpg|svg|ico)$/);
  if (isStaticCandidate) {
    // Only serve as static if the file actually exists in public/
    // Otherwise fall through to router (referer-based fallback handles SPA dynamic imports)
    const safePath = path.normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(PUBLIC, safePath);
    if (filePath.startsWith(PUBLIC) && fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      serveStatic(req, res, url.pathname);
      return;
    }
  }

  if (url.pathname === '/') {
    const demoPath = path.join(PUBLIC, 'demo.html');
    if (fs.existsSync(demoPath)) {
      serveStatic(req, res, '/demo.html');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(INDEX_HTML);
    }
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

// Proxy native WebSocket upgrades (e.g. socket.io, Firebase RTDB, etc.)
// MidasWebSocket in sandbox.js rewrites wss://target.com/... to
// wss://proxy.dev/_midas/BROWSE?url=https://target.com/...  so the upgrade
// request arrives here.  We relay it transparently to the real target.
server.on('upgrade', (req, socket, head) => {
  try {
    const reqUrl = new URL(req.url, 'http://x');
    if (reqUrl.pathname.startsWith('/_midas/') && reqUrl.searchParams.has('url')) {
      wsUpgradeHandler(req, socket, head);
    } else {
      socket.destroy();
    }
  } catch (e) {
    try { socket.destroy(); } catch (_) {}
  }
});

server.listen(PORT, HOST);
