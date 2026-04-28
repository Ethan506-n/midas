const fs = require('fs');
const path = require('path');

const filePath = path.resolve('server', 'router.js');
let content = fs.readFileSync(filePath, 'utf-8');

// 1. Add keep-alive agents after imports
const importBlockEnd = content.indexOf("const ACTIVE_TRANSPORTS");
const agentsCode = `
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000, freeSocketTimeout: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000, freeSocketTimeout: 30000 });
`;
content = content.slice(0, importBlockEnd) + agentsCode + content.slice(importBlockEnd);

// 2. Replace rewriteCss with enhanced version
const oldRewriteCss = `function rewriteCss(css, baseUrl) {
  css = css.replace(/url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:|#)/i.test(v) || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'url("' + toProxyUrl(abs) + '")';
  });
  css = css.replace(/@import\\s+url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\s*\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import url("' + toProxyUrl(abs) + '")';
  });
  css = css.replace(/@import\\s+("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import "' + toProxyUrl(abs) + '"';
  });
  return css;
}`;

const newRewriteCss = `function rewriteCss(css, baseUrl) {
  // url() in any context
  css = css.replace(/url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:|#)/i.test(v) || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'url("' + toProxyUrl(abs) + '")';
  });
  // @import url()
  css = css.replace(/@import\\s+url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\s*\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import url("' + toProxyUrl(abs) + '")';
  });
  // @import "..."
  css = css.replace(/@import\\s+("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import "' + toProxyUrl(abs) + '"';
  });
  // @font-face src: url()
  css = css.replace(/src\\s*:\\s*([^;}]*)url\\(/gi, (m) => m);
  // @namespace
  css = css.replace(/@namespace\\s+\\S*\\s+("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return m.replace(v, toProxyUrl(abs));
  });
  // filter: url(#id) - skip internal references
  css = css.replace(/filter\\s*:\\s*([^;}]*)url\\("([^"]+)"\\)/gi, (m, prefix, v) => {
    if (!v || v.startsWith('#') || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'filter:' + prefix + 'url("' + toProxyUrl(abs) + '")';
  });
  return css;
}`;

content = content.replace(oldRewriteCss, newRewriteCss);

// 3. Replace rewriteHtml with enhanced version
const oldRewriteHtml = `function rewriteHtml(html, baseUrl, baseProxyUrl) {
  html = html.replace(/<base\\b[^>]*>/gi, '');

  html = html.replace(/(<style\\b[^>]*>)([\\s\\S]*?)(<\\/style>)/gi,
    (_m, open, body, close) => open + rewriteCss(body, baseUrl) + close);

  html = html.replace(/<meta\\s+http-equiv=["']?refresh["']?\\s+content=["']([^"']+)["'][^>]*>/gi,
    (m, content) => {
      const mm = content.match(/^\\s*([\\d.]+)\\s*;\\s*url\\s*=\\s*(.+?)\\s*$/i);
      if (!mm) return m;
      const abs = resolveUrl(baseUrl, mm[2]);
      if (!abs) return m;
      return m.replace(mm[2], toProxyUrl(abs));
    });

  html = html.replace(
    /\\b(href|src|action|formaction|poster|data)\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))/gi,
    (m, attr, _all, dq, sq, uq) => {
      const v = (dq ?? sq ?? uq ?? '').trim();
      if (!v) return m;
      if (/^(#|javascript:|data:|mailto:|blob:|tel:|about:|ws:|wss:)/i.test(v)) return m;
      if (isAlreadyProxied(v)) return m;
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return m;
      return attr + '="' + toProxyUrl(abs) + '"';
    }
  );

  html = html.replace(/\\bsrcset\\s*=\\s*("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = dq ?? sq ?? '';
    const parts = v.split(',').map(p => {
      const seg = p.trim().split(/\\s+/);
      const u = seg[0];
      if (!u || isAlreadyProxied(u) || /^data:/i.test(u)) return p;
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return p;
      seg[0] = toProxyUrl(abs);
      return seg.join(' ');
    });
    return 'srcset="' + parts.join(', ') + '"';
  });

  html = html.replace(/url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:)/i.test(v) || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'url("' + toProxyUrl(abs) + '")';
  });

  const stealthScript = getStealthScript(baseProxyUrl);
  if (html.includes('</head>')) {
    html = html.replace('</head>', stealthScript + '</head>');
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', stealthScript + '</body>');
  } else {
    html += stealthScript;
  }

  return html;
}`;

const newRewriteHtml = `function rewriteHtml(html, baseUrl, baseProxyUrl) {
  html = html.replace(/<base\\b[^>]*>/gi, '');

  html = html.replace(/(<style\\b[^>]*>)([\\s\\S]*?)(<\\/style>)/gi,
    (_m, open, body, close) => open + rewriteCss(body, baseUrl) + close);

  html = html.replace(/<meta\\s+http-equiv=["']?refresh["']?\\s+content=["']([^"']+)["'][^>]*>/gi,
    (m, content) => {
      const mm = content.match(/^\\s*([\\d.]+)\\s*;\\s*url\\s*=\\s*(.+?)\\s*$/i);
      if (!mm) return m;
      const abs = resolveUrl(baseUrl, mm[2]);
      if (!abs) return m;
      return m.replace(mm[2], toProxyUrl(abs));
    });

  // Comprehensive attribute rewriting
  const urlAttrs = [
    'href', 'src', 'action', 'formaction', 'poster', 'data',
    'data-src', 'data-href', 'data-url', 'data-icon', 'data-image',
    'background', 'cite', 'longdesc', 'profile', 'codebase', 'archive',
    'dynsrc', 'lowsrc', 'srcset', 'imagesrcset', 'ping',
    'manifest', 'xmlns', 'xlink:href', 'content'
  ];
  const attrPattern = new RegExp('\\\\b(' + urlAttrs.join('|') + ')\\\\s*=\\\\s*("([^"]*)"|\'([^\']*)\'|([^\\\\s>]+))', 'gi');
  
  html = html.replace(attrPattern, (m, attr, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v) return m;
    if (/^(#|javascript:|data:|mailto:|blob:|tel:|about:|ws:|wss:)/i.test(v)) return m;
    if (isAlreadyProxied(v)) return m;
    // Skip non-URL content attributes unless they contain url=
    if (attr === 'content' && !/url\s*=/i.test(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return attr + '="' + toProxyUrl(abs) + '"';
  });

  // srcset rewriting
  html = html.replace(/\\bsrcset\\s*=\\s*("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = dq ?? sq ?? '';
    const parts = v.split(',').map(p => {
      const seg = p.trim().split(/\\s+/);
      const u = seg[0];
      if (!u || isAlreadyProxied(u) || /^data:/i.test(u)) return p;
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return p;
      seg[0] = toProxyUrl(abs);
      return seg.join(' ');
    });
    return 'srcset="' + parts.join(', ') + '"';
  });

  // Inline style url() rewriting
  html = html.replace(/style\\s*=\\s*("[^"]*url\\([^"]*"|'[^']*url\\([^']*\')/gi, (m) => {
    return m.replace(/url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\)/gi, (_m2, _all2, dq2, sq2, uq2) => {
      const v = (dq2 ?? sq2 ?? uq2 ?? '').trim();
      if (!v || /^(data:|blob:|about:)/i.test(v) || isAlreadyProxied(v)) return _m2;
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return _m2;
      return 'url("' + toProxyUrl(abs) + '")';
    });
  });

  // Inline url() in any attribute
  html = html.replace(/url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:)/i.test(v) || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'url("' + toProxyUrl(abs) + '")';
  });

  // Rewrite <link rel="preload" imagesrcset>
  html = html.replace(/<link\\b([^>]*)imagesrcset\\s*=\\s*("([^"]*)"|'([^']*)')/gi, (m, prefix, _all, dq, sq) => {
    const v = dq ?? sq ?? '';
    const parts = v.split(',').map(p => {
      const seg = p.trim().split(/\\s+/);
      const u = seg[0];
      if (!u || isAlreadyProxied(u)) return p;
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return p;
      seg[0] = toProxyUrl(abs);
      return seg.join(' ');
    });
    return '<link' + prefix + 'imagesrcset="' + parts.join(', ') + '"';
  });

  const stealthScript = getStealthScript(baseProxyUrl);
  if (html.includes('</head>')) {
    html = html.replace('</head>', stealthScript + '</head>');
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', stealthScript + '</body>');
  } else {
    html += stealthScript;
  }

  return html;
}`;

content = content.replace(oldRewriteHtml, newRewriteHtml);

// 4. Replace rewriteJs with enhanced version
const oldRewriteJs = `function rewriteJs(js, baseUrl) {
  js = js.replace(/"(https?:\\/\\/[^"]+)"/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '"' + toProxyUrl(u) + '"';
  });
  js = js.replace(/'(https?:\\/\\/[^']+)'/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return "'" + toProxyUrl(u) + "'";
  });
  js = js.replace(/\\\\x60(https?:\\/\\/[^\\\\x60]+)\\\\x60/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '\\\\x60' + toProxyUrl(u) + '\\\\x60';
  });
  js = js.replace(/\\bimport\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]\\s*\\)/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'import("' + toProxyUrl(u) + '")';
  });
  js = js.replace(/\\bfetch\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'fetch("' + toProxyUrl(u) + '"';
  });
  js = js.replace(/\\bnew\\s+URL\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'new URL("' + toProxyUrl(u) + '"';
  });
  js = js.replace(/\\.open\\s*\\(\\s*['"][^'"]*['"]\\s*,\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return m.replace(u, toProxyUrl(u));
  });
  js = js.replace(/\\bnew\\s+WebSocket\\s*\\(\\s*['"](wss?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u)) return m;
    return 'new WebSocket("' + toProxyUrl(u.replace(/^wss?/, 'https')) + '"';
  });
  js = js.replace(/\\bnew\\s+EventSource\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'new EventSource("' + toProxyUrl(u) + '"';
  });
  return js;
}`;

const newRewriteJs = `function rewriteJs(js, baseUrl) {
  // String literals with URLs
  js = js.replace(/"(https?:\\/\\/[^"]+)"/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '"' + toProxyUrl(u) + '"';
  });
  js = js.replace(/'(https?:\\/\\/[^']+)'/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return "'" + toProxyUrl(u) + "'";
  });
  js = js.replace(/\\\\x60(https?:\\/\\/[^\\\\x60]+)\\\\x60/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '\\\\x60' + toProxyUrl(u) + '\\\\x60';
  });
  // import()
  js = js.replace(/\\bimport\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]\\s*\\)/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'import("' + toProxyUrl(u) + '")';
  });
  // fetch("...")
  js = js.replace(/\\bfetch\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'fetch("' + toProxyUrl(u) + '"';
  });
  // new URL("...")
  js = js.replace(/\\bnew\\s+URL\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'new URL("' + toProxyUrl(u) + '"';
  });
  // XMLHttpRequest.open(method, "url")
  js = js.replace(/\\.open\\s*\\(\\s*['"][^'"]*['"]\\s*,\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return m.replace(u, toProxyUrl(u));
  });
  // new WebSocket("wss://...")
  js = js.replace(/\\bnew\\s+WebSocket\\s*\\(\\s*['"](wss?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u)) return m;
    return 'new WebSocket("' + toProxyUrl(u.replace(/^wss?/, 'https')) + '"';
  });
  // new EventSource("...")
  js = js.replace(/\\bnew\\s+EventSource\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'new EventSource("' + toProxyUrl(u) + '"';
  });
  // location.href = "..."
  js = js.replace(/(location\\.href|window\\.location|document\\.location)\\s*=\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, prefix, u) => {
    if (isAlreadyProxied(u)) return m;
    return prefix + '="' + toProxyUrl(u) + '"';
  });
  // history.pushState/replaceState(..., "url")
  js = js.replace(/(history\\.(?:pushState|replaceState)\\s*\\([^)]*),\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, prefix, u) => {
    if (isAlreadyProxied(u)) return m;
    return prefix + ',"' + toProxyUrl(u) + '"';
  });
  // navigator.sendBeacon("url")
  js = js.replace(/navigator\\.sendBeacon\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'navigator.sendBeacon("' + toProxyUrl(u) + '"';
  });
  // Worker("url")
  js = js.replace(/\\bnew\\s+Worker\\s*\\(\\s*['"](https?:\\/\\/[^'"]+)['"]/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'new Worker("' + toProxyUrl(u) + '"';
  });
  // CSS url() inside JS strings (common in styled-components, etc)
  js = js.replace(/url\\(\\s*['"](https?:\\/\\/[^'"]+)['"]\\s*\\)/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'url("' + toProxyUrl(u) + '")';
  });
  return js;
}`;

content = content.replace(oldRewriteJs, newRewriteJs);

// 5. Enhance proxyRequest with agents and timeout
const oldProxyRequest = `function proxyRequest(req, res, targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const isPassthrough = options.passthrough || isCaptchaUrl(targetUrl);`;

const newProxyRequest = `function proxyRequest(req, res, targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const isPassthrough = options.passthrough || isCaptchaUrl(targetUrl);`;

content = content.replace(oldProxyRequest, newProxyRequest);

// Add agent to reqOptions
const oldReqOptions = `    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || req.method || 'GET',
      headers,
      rejectUnauthorized: false,
    };`;

const newReqOptions = `    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || req.method || 'GET',
      headers,
      rejectUnauthorized: false,
      agent: isHttps ? httpsAgent : httpAgent,
      timeout: 30000,
    };`;

content = content.replace(oldReqOptions, newReqOptions);

// 6. Enhance browseHandler with agents and better headers
const oldBrowseOptions = `  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    rejectUnauthorized: false,
  };`;

const newBrowseOptions = `  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    rejectUnauthorized: false,
    agent: isHttps ? httpsAgent : httpAgent,
    timeout: 30000,
  };`;

content = content.replace(oldBrowseOptions, newBrowseOptions);

// 7. Add more header removals
const oldHeaderDeletes = `    delete outHeaders['content-security-policy'];
    delete outHeaders['content-security-policy-report-only'];
    delete outHeaders['strict-transport-security'];
    delete outHeaders['x-frame-options'];
    delete outHeaders['content-length'];
    delete outHeaders['content-encoding'];
    delete outHeaders['transfer-encoding'];
    delete outHeaders['set-cookie'];
    delete outHeaders['alt-svc'];
    delete outHeaders['cross-origin-opener-policy'];
    delete outHeaders['cross-origin-embedder-policy'];
    delete outHeaders['cross-origin-resource-policy'];
    delete outHeaders['origin-agent-cluster'];
    delete outHeaders['permissions-policy'];
    outHeaders['cache-control'] = 'no-store';`;

const newHeaderDeletes = `    delete outHeaders['content-security-policy'];
    delete outHeaders['content-security-policy-report-only'];
    delete outHeaders['strict-transport-security'];
    delete outHeaders['x-frame-options'];
    delete outHeaders['content-length'];
    delete outHeaders['content-encoding'];
    delete outHeaders['transfer-encoding'];
    delete outHeaders['set-cookie'];
    delete outHeaders['alt-svc'];
    delete outHeaders['cross-origin-opener-policy'];
    delete outHeaders['cross-origin-embedder-policy'];
    delete outHeaders['cross-origin-resource-policy'];
    delete outHeaders['origin-agent-cluster'];
    delete outHeaders['permissions-policy'];
    delete outHeaders['report-to'];
    delete outHeaders['nel'];
    delete outHeaders['expect-ct'];
    delete outHeaders['feature-policy'];
    delete outHeaders['large-allocation'];
    delete outHeaders['link']; // Preload hints with original URLs
    outHeaders['cache-control'] = 'no-store';
    outHeaders['referrer-policy'] = 'no-referrer';`;

content = content.replace(oldHeaderDeletes, newHeaderDeletes);

// 8. Add retry logic to browseHandler proxyReq
const oldProxyReqOnError = `  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error');
    }
  });`;

const newProxyReqOnError = `  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html><head><title>Error</title></head><body><h1>Proxy Error</h1><p>Unable to reach target site. ' + (err.message || 'Unknown error') + '</p><button onclick="history.back()">Go Back</button></body></html>');
    }
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html><head><title>Timeout</title></head><body><h1>Gateway Timeout</h1><p>The target site took too long to respond.</p><button onclick="location.reload()">Retry</button></body></html>');
    }
  });`;

content = content.replace(oldProxyReqOnError, newProxyReqOnError);

// 9. Enhance JSON rewriting
const oldJsonRewrite = `        } else if (isJson) {
          out = text.replace(/"(https?:\\/\\/[^"]+)"/g, (m, u) => {
            if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
            return '"' + toProxyUrl(u) + '"';
          });
        }`;

const newJsonRewrite = `        } else if (isJson) {
          out = text.replace(/"(https?:\\/\\/[^"]+)"/g, (m, u) => {
            if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
            return '"' + toProxyUrl(u) + '"';
          });
          // Also rewrite URLs in common JSON fields
          out = out.replace(/"(url|href|src|icon|image|logo|banner|thumbnail|poster|avatar)":\\s*"(https?:\\/\\/[^"]+)"/gi, (m, key, u) => {
            if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
            return '"' + key + '":"' + toProxyUrl(u) + '"';
          });
        }`;

content = content.replace(oldJsonRewrite, newJsonRewrite);

fs.writeFileSync(filePath, content);
console.log('Router enhanced successfully');

require('child_process').execSync('node -c ' + filePath, { encoding: 'utf-8' });
console.log('Syntax OK');

