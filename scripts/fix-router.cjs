const fs = require('fs');

const content = `import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { URL } from 'url';
import { getEndpointPaths, matchPolymorphicPath } from './polymorph-router.js';
import { wsBridgeHandler } from './ws-bridge.js';
import { isCaptchaUrl, buildPassthroughHeaders } from './captcha-handler.js';

const ACTIVE_TRANSPORTS = new Map();
const COOKIE_JAR = new Map();

let currentPaths = getEndpointPaths();
function refreshPaths() { currentPaths = getEndpointPaths(); }
setInterval(refreshPaths, 60000);

function generateSessionId() {
  return Array.from({ length: 24 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
      Math.floor(Math.random() * 62)
    ]
  ).join('');
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS, PUT, DELETE, PATCH, HEAD');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-max-age', '86400');
}

function toProxyUrl(target) {
  return '/_midas/' + currentPaths.browse + '?url=' + encodeURIComponent(target);
}

function htmlDecode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

function resolveUrl(base, ref) {
  try { return new URL(htmlDecode(ref), base).toString(); } catch { return null; }
}

function isAlreadyProxied(v) {
  return typeof v === 'string' && (v.includes('/_midas/') || v.startsWith('/_midas/'));
}

function extractOriginalFromProxy(u) {
  try {
    const parsed = new URL(u, 'http://x');
    if (!parsed.pathname.includes('/_midas/')) return null;
    return parsed.searchParams.get('url');
  } catch { return null; }
}

function rewriteCss(css, baseUrl) {
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
}

function getStealthScript(baseProxyUrl) {
  const nonce = Math.random().toString(36).slice(2, 10);
  const script = [
    '<script data-midas="' + nonce + '">',
    '(function(){',
    'var base="' + baseProxyUrl + '";',
    'function px(u){',
    'if(!u||typeof u!=="string")return u;',
    'if(u.indexOf("/_midas/")>=0)return u;',
    'if(/^#|^(javascript|data|blob|mailto|tel|about|ws|wss):/i.test(u))return u;',
    'try{var a=document.createElement("a");a.href=u;return base+"?url="+encodeURIComponent(a.href);}catch(e){return u;}',
    '}',
    'function patch(el){',
    'if(!el||el.nodeType!==1)return;',
    'var t=el.tagName;if(!t)return;',
    'var tag=t.toLowerCase();',
    'if(tag==="a"){var h=el.getAttribute("href");if(h&&h[0]!=="#")el.setAttribute("href",px(h));}',
    'else if(tag==="form"){var a=el.getAttribute("action");if(a)el.setAttribute("action",px(a));}',
    'else if(tag==="img"||tag==="source"||tag==="track"){var s=el.getAttribute("src");if(s)el.setAttribute("src",px(s));var ss=el.getAttribute("srcset");if(ss)el.setAttribute("srcset",ss.split(",").map(function(p){var x=p.trim().split(/\\\\s+/);x[0]=px(x[0]);return x.join(" ");}).join(", "));}',
    'else if(tag==="link"){var h=el.getAttribute("href");if(h)el.setAttribute("href",px(h));}',
    'else if(tag==="script"){var s=el.getAttribute("src");if(s)el.setAttribute("src",px(s));el.removeAttribute("integrity");el.removeAttribute("crossorigin");}',
    'else if(tag==="iframe"||tag==="embed"||tag==="object"){var s=el.getAttribute("src")||el.getAttribute("data");if(s){var r=px(s);if(el.hasAttribute("src"))el.setAttribute("src",r);if(el.hasAttribute("data"))el.setAttribute("data",r);}}',
    'else if(tag==="meta"){var c=el.getAttribute("content");if(c&&/url\\\\s*=/i.test(c)){var m=c.match(/(.*url\\\\s*=\\\\s*)(.+?)(\\\\s*;.*|$)/i);if(m)el.setAttribute("content",m[1]+px(m[2])+m[3]);}}',
    'else if(tag==="video"||tag==="audio"){var s=el.getAttribute("src");if(s)el.setAttribute("src",px(s));var ps=el.querySelectorAll("source");for(var i=0;i<ps.length;i++)patch(ps[i]);}',
    '}',
    'function patchAll(root){if(!root)return;var els=root.querySelectorAll?root.querySelectorAll("a,form,img,source,track,link,script,iframe,embed,object,meta,video,audio"):[];for(var i=0;i<els.length;i++)patch(els[i]);}',
    'var obs=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var ml=ms[i].addedNodes;for(var j=0;j<ml.length;j++){var n=ml[j];if(n.nodeType===1){patch(n);patchAll(n);}}}});',
    'if(document.documentElement){obs.observe(document.documentElement,{childList:true,subtree:true});patchAll(document.body||document.documentElement);}else{document.addEventListener("DOMContentLoaded",function(){obs.observe(document.documentElement,{childList:true,subtree:true});patchAll(document.body);});}',
    'document.addEventListener("click",function(e){var t=e.target;while(t&&t.tagName!=="A")t=t.parentNode;if(!t)return;var h=t.getAttribute("href");if(!h||h[0]==="#"||/^(javascript|data|mailto|tel):/i.test(h))return;var p=px(h);if(p!==h)t.setAttribute("href",p);if(t.getAttribute("target")==="_blank")return;e.preventDefault();window.location.href=p;},true);',
    'document.addEventListener("submit",function(e){var f=e.target;if(f.tagName!=="FORM")return;var a=f.getAttribute("action");if(!a){a=window.location.href;}var p=px(a);if(p!==a)f.setAttribute("action",p);f.setAttribute("target","_self");},true);',
    'var origOpen=window.open;',
    'window.open=function(url,target,features){',
    'if(url&&typeof url==="string"&&!url.includes("/_midas/")){url=px(url);}',
    'return origOpen.call(this,url,target,features);',
    '};',
    'var origFetch=window.fetch;',
    'window.fetch=function(input,init){',
    'if(typeof input==="string"){input=px(input);}',
    'else if(input&&input.url){input.url=px(input.url);}',
    'return origFetch(input,init);',
    '};',
    'var origXHR=window.XMLHttpRequest;',
    'window.XMLHttpRequest=function(){var x=new origXHR();var origOpen=x.open;x.open=function(method,url,async,user,password){if(typeof url==="string"){url=px(url);}return origOpen.call(x,method,url,async,user,password);};return x;};',
    'var origWS=window.WebSocket;',
    'window.WebSocket=function(url,protocols){if(typeof url==="string"&&url.indexOf("/_midas/")<0){url=px(url.replace(/^wss?/,"https"));}return new origWS(url,protocols);};',
    'var origES=window.EventSource;',
    'if(origES){window.EventSource=function(url,options){if(typeof url==="string"){url=px(url);}return new origES(url,options);};}',
    'var origSendBeacon=navigator.sendBeacon;',
    'if(origSendBeacon){navigator.sendBeacon=function(url,data){if(typeof url==="string"){url=px(url);}return origSendBeacon.call(navigator,url,data);};}',
    '})();',
    '</script>'
  ];
  return script.join('');
}

function rewriteHtml(html, baseUrl, baseProxyUrl) {
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
}

function rewriteJs(js, baseUrl) {
  js = js.replace(/"(https?:\\/\\/[^"]+)"/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '"' + toProxyUrl(u) + '"';
  });
  js = js.replace(/'(https?:\\/\\/[^']+)'/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return "'" + toProxyUrl(u) + "'";
  });
  js = js.replace(/\\`(https?:\\/\\/[^\\`]+)\\`/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '\\`' + toProxyUrl(u) + '\\`';
  });
  js = js.replace(/\\bimport\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']\\s*\\)/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'import("' + toProxyUrl(u) + '")';
  });
  js = js.replace(/\\bfetch\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'fetch("' + toProxyUrl(u) + '"';
  });
  js = js.replace(/\\bnew\\s+URL\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'new URL("' + toProxyUrl(u) + '"';
  });
  js = js.replace(/\\.open\\s*\\(\\s*["'][^"']*["']\\s*,\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return m.replace(u, toProxyUrl(u));
  });
  js = js.replace(/\\bnew\\s+WebSocket\\s*\\(\\s*["'](wss?:\\/\\/[^"']+)["']/g, (m, u) => {
    if (isAlreadyProxied(u)) return m;
    return 'new WebSocket("' + toProxyUrl(u.replace(/^wss?/, 'https')) + '"';
  });
  js = js.replace(/\\bnew\\s+EventSource\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return 'new EventSource("' + toProxyUrl(u) + '"';
  });
  return js;
}

function parseCookieHeader(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function parseSetCookie(str) {
  const parts = str.split(';').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const nv = parts.shift();
  const eq = nv.indexOf('=');
  if (eq < 0) return null;
  const cookie = {
    name: nv.slice(0, eq).trim(),
    value: nv.slice(eq + 1).trim(),
    path: '/',
    domain: null,
    expires: null,
    secure: false,
    httpOnly: false,
  };
  for (const a of parts) {
    const ei = a.indexOf('=');
    const k = (ei < 0 ? a : a.slice(0, ei)).trim().toLowerCase();
    const v = ei < 0 ? '' : a.slice(ei + 1).trim();
    if (k === 'path') cookie.path = v || '/';
    else if (k === 'domain') cookie.domain = v.replace(/^\\./, '').toLowerCase();
    else if (k === 'expires') { const t = Date.parse(v); if (t) cookie.expires = t; }
    else if (k === 'max-age') { const n = parseInt(v, 10); if (!isNaN(n)) cookie.expires = Date.now() + n * 1000; }
    else if (k === 'secure') cookie.secure = true;
    else if (k === 'httponly') cookie.httpOnly = true;
  }
  return cookie;
}

function getOrCreateSid(req, res) {
  const cookies = parseCookieHeader(req.headers.cookie);
  let sid = cookies.midas_sid;
  if (!sid) {
    sid = generateSessionId();
    const prev = res.getHeader('set-cookie');
    const next = 'midas_sid=' + sid + '; Path=/; HttpOnly; SameSite=Lax';
    res.setHeader('set-cookie', prev ? [].concat(prev, next) : next);
  }
  return sid;
}

function jarFor(sid) {
  let j = COOKIE_JAR.get(sid);
  if (!j) { j = new Map(); COOKIE_JAR.set(sid, j); }
  return j;
}

function hostMatches(cookieHost, requestHost) {
  if (!cookieHost) return true;
  if (cookieHost === requestHost) return true;
  return requestHost.endsWith('.' + cookieHost);
}

function buildCookieHeader(jar, hostname, pathname, isHttps) {
  const out = [];
  const now = Date.now();
  for (const [host, list] of jar) {
    if (!hostMatches(host, hostname)) continue;
    for (const c of list) {
      if (c.expires && c.expires < now) continue;
      if (!pathname.startsWith(c.path)) continue;
      if (c.secure && !isHttps) continue;
      out.push(c.name + '=' + c.value);
    }
  }
  return out.join('; ');
}

function storeCookies(jar, hostname, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const sc of list) {
    const cookie = parseSetCookie(sc);
    if (!cookie) continue;
    const host = cookie.domain || hostname;
    let bucket = jar.get(host);
    if (!bucket) { bucket = []; jar.set(host, bucket); }
    const idx = bucket.findIndex(c => c.name === cookie.name && c.path === cookie.path);
    if (idx >= 0) bucket[idx] = cookie; else bucket.push(cookie);
  }
}

function decodeBody(buf, charset) {
  try { return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(buf); }
  catch { return buf.toString('utf8'); }
}

function proxyRequest(req, res, targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const isPassthrough = options.passthrough || isCaptchaUrl(targetUrl);

    const headers = options.headers || {};
    if (isPassthrough) {
      Object.assign(headers, buildPassthroughHeaders(req.headers, targetUrl));
    }

    delete headers['host'];
    headers['host'] = url.host;

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || req.method || 'GET',
      headers,
      rejectUnauthorized: false,
    };

    const proxyReq = lib.request(reqOptions, (proxyRes) => {
      const outHeaders = { ...proxyRes.headers };
      delete outHeaders['content-security-policy'];
      delete outHeaders['content-security-policy-report-only'];
      delete outHeaders['strict-transport-security'];
      delete outHeaders['x-frame-options'];
      delete outHeaders['set-cookie'];

      if (isPassthrough) {
        outHeaders['access-control-allow-origin'] = req.headers['origin'] || '*';
        outHeaders['access-control-allow-credentials'] = 'true';
      }

      res.writeHead(proxyRes.statusCode, outHeaders);
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

    if (options.body) {
      proxyReq.write(options.body);
      proxyReq.end();
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });
}

function browseHandler(req, res, targetUrl, depth = 0) {
  const sid = getOrCreateSid(req, res);
  const jar = jarFor(sid);

  let url;
  try { url = new URL(targetUrl); } catch {
    res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad url'); return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    res.writeHead(400, { 'content-type': 'text/plain' }); res.end('unsupported protocol'); return;
  }

  const reqUrl = new URL(req.url, 'http://x');
  for (const [k, v] of reqUrl.searchParams) {
    if (k === 'url') continue;
    url.searchParams.append(k, v);
  }

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const headers = {};
  headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  headers['accept'] = req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  headers['accept-language'] = req.headers['accept-language'] || 'en-US,en;q=0.9';
  headers['accept-encoding'] = 'gzip, deflate, br';
  headers['sec-ch-ua'] = req.headers['sec-ch-ua'] || '"Not.A/Brand";v="8", "Chromium";v="125", "Google Chrome";v="125"';
  headers['sec-ch-ua-mobile'] = req.headers['sec-ch-ua-mobile'] || '?0';
  headers['sec-ch-ua-platform'] = req.headers['sec-ch-ua-platform'] || '"Windows"';
  headers['sec-fetch-dest'] = req.headers['sec-fetch-dest'] || 'document';
  headers['sec-fetch-mode'] = req.headers['sec-fetch-mode'] || 'navigate';
  headers['sec-fetch-site'] = req.headers['sec-fetch-site'] || 'none';
  headers['sec-fetch-user'] = req.headers['sec-fetch-user'] || '?1';
  headers['upgrade-insecure-requests'] = '1';
  headers['cache-control'] = req.headers['cache-control'] || 'max-age=0';
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  const clientIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
  if (clientIp) {
    headers['x-forwarded-for'] = clientIp;
    headers['x-real-ip'] = clientIp.split(',')[0].trim();
  }

  const refOriginal = extractOriginalFromProxy(req.headers.referer || '');
  if (refOriginal) headers['referer'] = refOriginal;

  const cookieHeader = buildCookieHeader(jar, url.hostname, url.pathname, isHttps);
  if (cookieHeader) headers['cookie'] = cookieHeader;

  const isCaptchaRequest = isCaptchaUrl(targetUrl);
  if (isCaptchaRequest) {
    Object.assign(headers, buildPassthroughHeaders(req.headers, targetUrl));
  }

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    rejectUnauthorized: false,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    storeCookies(jar, url.hostname, proxyRes.headers['set-cookie']);

    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && depth < 8) {
      const next = resolveUrl(url.toString(), proxyRes.headers.location);
      proxyRes.resume();
      if (next) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          browseHandler(req, res, next, depth + 1);
          return;
        }
        res.writeHead(302, { location: toProxyUrl(next), 'cache-control': 'no-store' });
        res.end();
        return;
      }
    }

    const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
    const charsetMatch = ct.match(/charset=([^\\s;]+)/i);
    const charset = charsetMatch ? charsetMatch[1] : 'utf-8';

    const outHeaders = { ...proxyRes.headers };
    delete outHeaders['content-security-policy'];
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
    outHeaders['cache-control'] = 'no-store';

    const enc = (proxyRes.headers['content-encoding'] || '').toLowerCase();
    let stream = proxyRes;
    if (enc === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (enc === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

    const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
    const isCss = ct.includes('text/css');
    const isJs = ct.includes('javascript') || ct.includes('/ecmascript');
    const isJson = ct.includes('application/json');

    if (isCaptchaRequest && !isHtml) {
      res.writeHead(proxyRes.statusCode, outHeaders);
      stream.pipe(res);
      return;
    }

    if (isHtml || isCss || isJs || isJson) {
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('decode error'); } });
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = decodeBody(buf, charset);
        const baseProxyUrl = '/_midas/' + currentPaths.browse;
        let out = text;

        if (isHtml) {
          out = rewriteHtml(text, url.toString(), baseProxyUrl);
          outHeaders['content-type'] = 'text/html; charset=utf-8';
        } else if (isCss) {
          out = rewriteCss(text, url.toString());
          outHeaders['content-type'] = 'text/css; charset=utf-8';
        } else if (isJs) {
          out = rewriteJs(text, url.toString());
          outHeaders['content-type'] = ct || 'application/javascript; charset=utf-8';
        } else if (isJson) {
          out = text.replace(/"(https?:\\/\\/[^"]+)"/g, (m, u) => {
            if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
            return '"' + toProxyUrl(u) + '"';
          });
        }

        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(out);
      });
    } else {
      res.writeHead(proxyRes.statusCode, outHeaders);
      stream.pipe(res);
    }
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error');
    }
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

export function router(req, res, url) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const pathname = url.pathname;
  const pathType = matchPolymorphicPath(pathname, currentPaths);

  if (pathname === '/_midas/session') {
    const sid = generateSessionId();
    const transport = url.searchParams.get('t') || 'chunked';
    ACTIVE_TRANSPORTS.set(sid, { transport, created: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      sid,
      transport,
      nonce: Math.random().toString(36).slice(2),
      paths: currentPaths,
    }));
    return;
  }

  if (pathType === 'noise') {
    const size = 100 + Math.floor(Math.random() * 900);
    const noise = Buffer.alloc(size);
    for (let i = 0; i < size; i++) noise[i] = Math.floor(Math.random() * 256);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': size,
      'cache-control': 'no-store',
    });
    res.end(noise);
    return;
  }

  if (pathType === 'browse') {
    const target = url.searchParams.get('url');
    if (!target) { res.writeHead(400); res.end('missing url'); return; }
    browseHandler(req, res, target);
    return;
  }

  if (pathType === 'session') {
    const sid = generateSessionId();
    const transport = url.searchParams.get('t') || 'chunked';
    ACTIVE_TRANSPORTS.set(sid, { transport, created: Date.now() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      sid,
      transport,
      nonce: Math.random().toString(36).slice(2),
      paths: currentPaths,
    }));
    return;
  }

  if (pathType === 'stream') {
    const sid = url.searchParams.get('sid');
    if (!sid || !ACTIVE_TRANSPORTS.has(sid)) {
      res.writeHead(400); res.end(); return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(':ok\\n\\n');
    const interval = setInterval(() => {
      if (res.writableEnded) { clearInterval(interval); return; }
      res.write(':ping\\n\\n');
    }, 30000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  if (pathType === 'proxy') {
    const target = url.searchParams.get('url');
    if (!target) { res.writeHead(400); res.end(); return; }
    proxyRequest(req, res, target).catch(() => {
      if (!res.headersSent) { res.writeHead(502); res.end(); }
    });
    return;
  }

  if (pathType === 'fetch') {
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

  if (pathType === 'chunk') {
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
          port: targetUrl.port
