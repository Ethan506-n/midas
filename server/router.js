import http from 'http';
import https from 'https';
import { URL } from 'url';

const ACTIVE_TRANSPORTS = new Map();

function generateSessionId() {
  return Array.from({ length: 24 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
      Math.floor(Math.random() * 62)
    ]
  ).join('');
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS, PUT, DELETE, PATCH');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-max-age', '86400');
}

async function proxyRequest(req, res, targetUrl, passthrough = false) {
  const url = new URL(targetUrl);
  const lib = url.protocol === 'https:' ? https : http;

  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['connection'];
  delete headers['upgrade'];
  delete headers['http2-settings'];

  if (passthrough) {
    headers['x-midas-passthrough'] = '1';
  }

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    rejectUnauthorized: false,
  };

  return new Promise((resolve, reject) => {
    const proxyReq = lib.request(options, (proxyRes) => {
      const status = proxyRes.statusCode;
      const outHeaders = { ...proxyRes.headers };

      delete outHeaders['content-security-policy'];
      delete outHeaders['content-security-policy-report-only'];
      delete outHeaders['strict-transport-security'];
      delete outHeaders['x-frame-options'];

      if (passthrough) {
        outHeaders['access-control-allow-origin'] = '*';
      }

      res.writeHead(status, outHeaders);
      proxyRes.pipe(res);
      proxyRes.on('end', resolve);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Proxy error');
      }
      reject(err);
    });

    req.pipe(proxyReq);
  });
}

function toProxyUrl(target) {
  return '/_midas/browse?url=' + encodeURIComponent(target);
}

function resolveUrl(base, ref) {
  try { return new URL(ref, base).toString(); } catch { return null; }
}

function rewriteHtml(html, baseUrl) {
  html = html.replace(/<base[^>]*>/gi, '');

  html = html.replace(
    /\b(href|src|action|formaction|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, attr, _all, dq, sq, uq) => {
      const v = (dq ?? sq ?? uq ?? '').trim();
      if (!v) return m;
      if (/^(#|javascript:|data:|mailto:|blob:|tel:|about:)/i.test(v)) return m;
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return m;
      return `${attr}="${toProxyUrl(abs)}"`;
    }
  );

  html = html.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = dq ?? sq ?? '';
    const parts = v.split(',').map(p => {
      const seg = p.trim().split(/\s+/);
      const u = seg[0];
      if (!u) return p;
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return p;
      seg[0] = toProxyUrl(abs);
      return seg.join(' ');
    });
    return `srcset="${parts.join(', ')}"`;
  });

  html = html.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:)/i.test(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return `url("${toProxyUrl(abs)}")`;
  });

  return html;
}

function rewriteCss(css, baseUrl) {
  css = css.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:)/i.test(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return `url("${toProxyUrl(abs)}")`;
  });
  css = css.replace(/@import\s+(?:url\()?\s*("([^"]*)"|'([^']*)')\s*\)?/gi, (m, _all, dq, sq) => {
    const v = dq ?? sq ?? '';
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return `@import url("${toProxyUrl(abs)}")`;
  });
  return css;
}

function browseHandler(req, res, targetUrl, depth = 0) {
  let url;
  try { url = new URL(targetUrl); } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad url'); return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unsupported protocol'); return;
  }

  const lib = url.protocol === 'https:' ? https : http;
  const headers = {
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
    'accept': req.headers['accept'] || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
  };

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
    rejectUnauthorized: false,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && depth < 5) {
      const next = resolveUrl(url.toString(), proxyRes.headers.location);
      proxyRes.resume();
      if (next) {
        res.writeHead(302, { location: toProxyUrl(next) });
        res.end();
        return;
      }
    }

    const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
    const outHeaders = { ...proxyRes.headers };
    delete outHeaders['content-security-policy'];
    delete outHeaders['content-security-policy-report-only'];
    delete outHeaders['strict-transport-security'];
    delete outHeaders['x-frame-options'];
    delete outHeaders['content-length'];
    delete outHeaders['content-encoding'];
    delete outHeaders['transfer-encoding'];
    outHeaders['cache-control'] = 'no-store';

    if (ct.includes('text/html')) {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const html = rewriteHtml(Buffer.concat(chunks).toString('utf8'), url.toString());
        outHeaders['content-type'] = 'text/html; charset=utf-8';
        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(html);
      });
    } else if (ct.includes('text/css')) {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const css = rewriteCss(Buffer.concat(chunks).toString('utf8'), url.toString());
        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(css);
      });
    } else {
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error');
    }
  });
  proxyReq.end();
}

export function router(req, res, url) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const pathname = url.pathname;

  if (pathname === '/_midas/browse') {
    const target = url.searchParams.get('url');
    if (!target) { res.writeHead(400); res.end('missing url'); return; }
    browseHandler(req, res, target);
    return;
  }

  if (pathname === '/_midas/session') {
    const sid = generateSessionId();
    const transport = url.searchParams.get('t') || 'chunked';
    ACTIVE_TRANSPORTS.set(sid, { transport, created: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid, transport, nonce: Math.random().toString(36).slice(2) }));
    return;
  }

  if (pathname === '/_midas/stream') {
    const sid = url.searchParams.get('sid');
    if (!sid || !ACTIVE_TRANSPORTS.has(sid)) {
      res.writeHead(400); res.end(); return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(`:ok\n\n`);
    const interval = setInterval(() => {
      if (res.writableEnded) { clearInterval(interval); return; }
      res.write(`:ping\n\n`);
    }, 30000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  // GET proxy for subresources (images, css, scripts, etc.)
  if (pathname === '/_midas/proxy') {
    const target = url.searchParams.get('url');
    if (!target) { res.writeHead(400); res.end(); return; }
    proxyRequest(req, res, target).catch(() => {
      if (!res.headersSent) { res.writeHead(502); res.end(); }
    });
    return;
  }

  if (pathname === '/_midas/fetch') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const target = data.url;
        if (!target) { res.writeHead(400); res.end(); return; }

        const targetUrl = new URL(target);
        const lib = targetUrl.protocol === 'https:' ? https : http;
        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: data.method || 'GET',
          headers: { ...(data.headers || {}) },
          rejectUnauthorized: false,
        };

        const proxyReq = lib.request(options, (proxyRes) => {
          let responseBody = '';
          proxyRes.setEncoding('utf8');
          proxyRes.on('data', chunk => responseBody += chunk);
          proxyRes.on('end', () => {
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-security-policy'];
            delete outHeaders['content-security-policy-report-only'];
            delete outHeaders['strict-transport-security'];
            delete outHeaders['x-frame-options'];

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              status: proxyRes.statusCode,
              headers: outHeaders,
              body: responseBody,
            }));
          });
        });

        proxyReq.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 502, headers: {}, body: '' }));
          }
        });

        if (data.body && (data.method === 'POST' || data.method === 'PUT' || data.method === 'PATCH')) {
          proxyReq.write(data.body);
        }
        proxyReq.end();
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (pathname === '/_midas/chunk') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const target = data.url;
        if (!target) { res.writeHead(400); res.end(); return; }

        const targetUrl = new URL(target);
        const lib = targetUrl.protocol === 'https:' ? https : http;
        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: data.method || 'GET',
          headers: { ...(data.headers || {}), 'accept': data.headers?.accept || '*/*' },
          rejectUnauthorized: false,
        };

        const proxyReq = lib.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, {
            'content-type': proxyRes.headers['content-type'] || 'application/octet-stream',
            'transfer-encoding': 'chunked',
          });
          proxyRes.pipe(res);
        });
        proxyReq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });

        if (data.body && (data.method === 'POST' || data.method === 'PUT' || data.method === 'PATCH')) {
          proxyReq.write(data.body);
        }
        proxyReq.end();
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  if (pathname === '/_midas/passthrough') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        await proxyRequest(req, res, data.url, true);
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  res.writeHead(404); res.end();
}

