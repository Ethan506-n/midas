import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { URL } from 'url';
import { getEndpointPaths, matchPolymorphicPath } from './polymorph-router.js';
import { wsBridgeHandler } from './ws-bridge.js';
import { isCaptchaUrl, isCaptchaHtml, buildPassthroughHeaders, shouldAllowInlineCaptcha } from './captcha-handler.js';
import { checkRateLimit, getAgent } from './rate-limiter.js';
import { generateRandomHeaders, injectAntiDetectionScript, cleanResponseHeaders } from './anti-detection.js';
import { shouldCache, getCacheTTL, getCached, setCached, getCacheStats } from './response-cache.js';
import { getDomainConfig, shouldPreserveAuth, handlesJsonApi, getRateLimit } from './domain-handler.js';
import { globalRetry } from './error-recovery.js';
import { resolveWithFallback } from './dns-resolver.js';
import { isFilterDomain, getBypassHeaders, isFilterBlockPage } from './filter-bypass.js';
import { getEnhancedAntiDetectionHeaders, isCloudflareChallenge, getCloudflareBypassHeaders, addBrowserDelay } from './advanced-evasion.js';

// Default agents (fallback)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 60000, freeSocketTimeout: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 60000, freeSocketTimeout: 60000 });
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
  css = css.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)'"]\S*))\s*\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:|#)/i.test(v) || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'url("' + toProxyUrl(abs) + '")';
  });
  css = css.replace(/@import\s+url\(\s*("([^"]*)"|'([^']*)'|([^)'"]\S*))\s*\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import url("' + toProxyUrl(abs) + '")';
  });
  css = css.replace(/@import\s+("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import "' + toProxyUrl(abs) + '"';
  });
  return css;
}

function getStealthScript(baseUrl) {
  return '<script src="/sandbox.js" data-base="' + (baseUrl || '') + '"></script>';
}

// Rewrite ES module import/export statements inside inline <script type="module"> or .js modules
function rewriteModuleImports(code, baseUrl) {
  // import ... from "url"
  code = code.replace(/\bfrom\s+("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v) || isCaptchaUrl(v)) return m;
    // Only rewrite absolute URLs and protocol-relative
    if (/^https?:\/\//i.test(v) || v.startsWith('//')) {
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return m;
      return 'from "' + toProxyUrl(abs) + '"';
    }
    return m;
  });
  // import "url" (side-effect imports)
  code = code.replace(/\bimport\s+("([^"]+)"|'([^']+)')\s*;/g, (m, _q, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v) || isCaptchaUrl(v)) return m;
    if (/^https?:\/\//i.test(v) || v.startsWith('//')) {
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return m;
      return 'import "' + toProxyUrl(abs) + '";';
    }
    return m;
  });
  // export ... from "url"
  code = code.replace(/\bexport\s+.*?\bfrom\s+("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v) || isCaptchaUrl(v)) return m;
    if (/^https?:\/\//i.test(v) || v.startsWith('//')) {
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return m;
      return m.replace(_q || dq || sq, '"' + toProxyUrl(abs) + '"');
    }
    return m;
  });
  return code;
}

// Rewrite an import map JSON
function rewriteImportMap(json, baseUrl) {
  try {
    const map = JSON.parse(json);
    function rewriteObj(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && /^https?:\/\//i.test(v) && !isAlreadyProxied(v)) {
          const abs = resolveUrl(baseUrl, v);
          out[k] = abs ? toProxyUrl(abs) : v;
        } else if (typeof v === 'object') {
          out[k] = rewriteObj(v);
        } else {
          out[k] = v;
        }
      }
      return out;
    }
    if (map.imports) map.imports = rewriteObj(map.imports);
    if (map.scopes) {
      const newScopes = {};
      for (const [scope, mapping] of Object.entries(map.scopes)) {
        newScopes[scope] = rewriteObj(mapping);
      }
      map.scopes = newScopes;
    }
    return JSON.stringify(map);
  } catch {
    return json;
  }
}

function rewriteJsonLd(json, baseUrl) {
  try {
    const data = JSON.parse(json);
    function rewrite(obj) {
      if (!obj) return obj;
      if (typeof obj === 'string') {
        if (/^https?:\/\//i.test(obj) && !isAlreadyProxied(obj) && !isCaptchaUrl(obj)) {
          const abs = resolveUrl(baseUrl, obj);
          return abs ? toProxyUrl(abs) : obj;
        }
        return obj;
      }
      if (Array.isArray(obj)) return obj.map(rewrite);
      if (typeof obj === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = rewrite(v);
        return out;
      }
      return obj;
    }
    return JSON.stringify(rewrite(data));
  } catch { return json; }
}

function rewriteHtml(html, baseUrl, baseProxyUrl) {
  // Remove <base> tags (we handle base URL ourselves)
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Strip integrity attributes (SRI blocks rewritten content)
  html = html.replace(/\s+integrity\s*=\s*("([^"]*)"|'([^']*)')/gi, '');

  // Strip nonces (they are tied to CSP headers we remove anyway)
  html = html.replace(/\s+nonce\s*=\s*("([^"]*)"|'([^']*)')/gi, '');

  // Strip crossorigin on scripts/links (breaks with rewritten origins)
  html = html.replace(/\s+crossorigin\s*=\s*("([^"]*)"|'([^']*)')/gi, '');
  html = html.replace(/\s+crossorigin(?=[\s>\/])/gi, '');

  // Strip inline CSP meta tags (we strip headers but inline meta CSP also blocks scripts)
  html = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  html = html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy-report-only["']?[^>]*>/gi, '');

  // Remove preconnect/dns-prefetch links (they leak real domain names to the browser)
  html = html.replace(/<link\b[^>]*\brel\s*=\s*["'](?:preconnect|dns-prefetch)["'][^>]*>/gi, '');

  // Rewrite inline <style> blocks
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, body, close) => open + rewriteCss(body, baseUrl) + close);

  // Rewrite <script type="importmap"> content
  html = html.replace(/(<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, body, close) => open + rewriteImportMap(body, baseUrl) + close);

  // Rewrite inline <script type="module"> imports
  html = html.replace(/(<script\b[^>]*type\s*=\s*["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, body, close) => open + rewriteModuleImports(rewriteJs(body, baseUrl), baseUrl) + close);

  // Rewrite JSON-LD structured data (<script type="application/ld+json">)
  html = html.replace(/(<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, body, close) => open + rewriteJsonLd(body.trim(), baseUrl) + close);

  // Rewrite inline <script> (non-module) blocks
  html = html.replace(/(<script\b(?![^>]*type\s*=\s*["'](?:module|importmap|text\/template|text\/html|application\/(?:json|ld\+json))["'])[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_m, open, body, close) => open + rewriteJs(body, baseUrl) + close);

  // meta refresh redirect
  html = html.replace(/<meta\b([^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*)>/gi, (m, attrs) => {
    return m.replace(/\bcontent\s*=\s*["']([^"']+)["']/i, (cm, content) => {
      const mm = content.match(/^\s*([\d.]+)\s*;\s*url\s*=\s*(.+?)\s*$/i);
      if (!mm) return cm;
      const abs = resolveUrl(baseUrl, mm[2]);
      if (!abs) return cm;
      return 'content="' + mm[1] + '; url=' + toProxyUrl(abs) + '"';
    });
  });

  // Rewrite href/src/action/formaction/poster/data attributes
  html = html.replace(
    /\b(href|src|action|formaction|poster|data|ping)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, attr, _all, dq, sq, uq) => {
      const v = (dq ?? sq ?? uq ?? '').trim();
      if (!v) return m;
      if (/^(#|javascript:|data:|mailto:|blob:|tel:|about:|ws:|wss:|chrome:|chrome-extension:)/i.test(v)) return m;
      if (isAlreadyProxied(v)) return m;
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return m;
      return attr + '="' + toProxyUrl(abs) + '"';
    }
  );

  // Rewrite data-src / data-href / data-lazy-src / data-original (lazy-load attributes)
  html = html.replace(/\b(data-src|data-href|data-lazy-src|data-original|data-url|data-bg|data-background|data-lazy)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (m, attr, _all, dq, sq) => {
      const v = (dq ?? sq ?? '').trim();
      if (!v || /^(data:|blob:|#|javascript:)/i.test(v) || isAlreadyProxied(v)) return m;
      const abs = resolveUrl(baseUrl, v);
      if (!abs) return m;
      return attr + '="' + toProxyUrl(abs) + '"';
    });

  // Rewrite srcset attributes
  html = html.replace(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = dq ?? sq ?? '';
    const parts = v.split(',').map(p => {
      const seg = p.trim().split(/\s+/);
      const u = seg[0];
      if (!u || isAlreadyProxied(u) || /^data:/i.test(u)) return p;
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return p;
      seg[0] = toProxyUrl(abs);
      return seg.join(' ');
    });
    return 'srcset="' + parts.join(', ') + '"';
  });

  // Rewrite CSS url() in inline style attributes
  html = html.replace(/\bstyle\s*=\s*"([^"]*)"/gi, (m, css) => {
    const rewritten = rewriteCss(css, baseUrl);
    return 'style="' + rewritten + '"';
  });
  html = html.replace(/\bstyle\s*=\s*'([^']*)'/gi, (m, css) => {
    const rewritten = rewriteCss(css, baseUrl);
    return "style='" + rewritten + "'";
  });

  // Rewrite url() outside of attributes (inline CSS background images etc.)
  html = html.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)'"]\S*))\s*\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:)/i.test(v) || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'url("' + toProxyUrl(abs) + '")';
  });

  // Rewrite <link rel="preload|prefetch|modulepreload|stylesheet|canonical"> href
  html = html.replace(/(<link\b[^>]*\brel\s*=\s*["']([^"']*)["'][^>]*>)/gi, (m, tag, rel) => {
    const relLower = rel.toLowerCase();
    if (/preload|prefetch|modulepreload|stylesheet|manifest/.test(relLower)) {
      return tag; // already handled by the href= pass above
    }
    return m;
  });

  // Rewrite og:url, og:image, twitter:image meta tags
  html = html.replace(/(<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:url|og:image|og:image:url|twitter:image|twitter:url)["'][^>]*content\s*=\s*["'])([^"']*)(")/gi,
    (m, pre, url, post) => {
      if (!url || isAlreadyProxied(url)) return m;
      const abs = resolveUrl(baseUrl, url);
      if (!abs) return m;
      return pre + toProxyUrl(abs) + post;
    });
  html = html.replace(/(<meta\b[^>]*content\s*=\s*["'])([^"']*)("(?:[^>]*(?:property|name)\s*=\s*["'](?:og:url|og:image|twitter:image|twitter:url)["'][^>]*)>)/gi,
    (m, pre, url, post) => {
      if (!url || isAlreadyProxied(url)) return m;
      const abs = resolveUrl(baseUrl, url);
      if (!abs) return m;
      return pre + toProxyUrl(abs) + post;
    });

  const isChallengePage = isCaptchaHtml(html);
  if (!isChallengePage) {
    // Inject anti-detection script early (before sandbox)
    const antiDetectionScript = '<script>' + injectAntiDetectionScript() + '</script>';
    const stealthScript = getStealthScript(baseUrl);
    const injectionScript = antiDetectionScript + stealthScript;
    
    if (html.includes('</head>')) {
      html = html.replace('</head>', injectionScript + '</head>');
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', injectionScript + '</body>');
    } else {
      html += injectionScript;
    }
  }

  return html;
}

function rewriteJs(js, baseUrl) {
  // Absolute URL strings in double quotes
  // Use (?<!\\) lookbehind to avoid matching JSON-escaped \"url\" sequences (prevents %5C corruption)
  // Use [^"\\\s] to also exclude backslash from URL content
  js = js.replace(/(?<!\\)"(https?:\/\/[^"\\\s]{3,})(?<!\\)"/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '"' + toProxyUrl(u) + '"';
  });
  // Absolute URL strings in single quotes
  js = js.replace(/(?<!\\)'(https?:\/\/[^'\\\s]{3,})(?<!\\)'/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return "'" + toProxyUrl(u) + "'";
  });
  // Absolute URL template literals (simple, no expressions)
  js = js.replace(/`(https?:\/\/[^`$\\\s]{3,})`/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    return '`' + toProxyUrl(u) + '`';
  });

  // Protocol-relative URLs
  js = js.replace(/(?<!\\)"(\/\/[^"\/\\\s][^"\\\s]{2,})(?<!\\)"/g, (m, u) => {
    if (isAlreadyProxied(u)) return m;
    const abs = 'https:' + u;
    if (isCaptchaUrl(abs)) return m;
    return '"' + toProxyUrl(abs) + '"';
  });

  // fetch("url") and fetch('url') — including relative paths
  js = js.replace(/\bfetch\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'fetch("' + toProxyUrl(abs) + '"';
    }
    return m;
  });

  // XMLHttpRequest.open("METHOD", "url")
  js = js.replace(/\.open\s*\(\s*("(?:[^"]*)"|'(?:[^']*)')\s*,\s*("([^"]+)"|'([^']+)')/g, (m, method, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u)) return m;
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return '.open(' + method + ', "' + toProxyUrl(abs) + '"';
    }
    return m;
  });

  // navigator.sendBeacon("url")
  js = js.replace(/\bsendBeacon\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    if (/^https?:\/\//i.test(u)) {
      return 'sendBeacon("' + toProxyUrl(u) + '"';
    }
    return m;
  });

  // new URL("url") — absolute
  js = js.replace(/\bnew\s+URL\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'new URL("' + toProxyUrl(abs) + '"';
    }
    return m;
  });

  // location.href = "url" / document.location.href = "url" / window.location.href = "url"
  js = js.replace(/\blocation(?:\s*\.\s*href)?\s*=\s*("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u)) return m;
    if (/^https?:\/\//i.test(u)) {
      return 'location.href="' + toProxyUrl(u) + '"';
    }
    return m;
  });

  // location.assign("url") / location.replace("url")
  js = js.replace(/\blocation\s*\.\s*(assign|replace)\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, method, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u)) return m;
    if (/^https?:\/\//i.test(u)) {
      return 'location.' + method + '("' + toProxyUrl(u) + '"';
    }
    return m;
  });

  // new WebSocket("wss://...") / new WebSocket('ws://...')
  js = js.replace(/\bnew\s+WebSocket\s*\(\s*("(wss?:\/\/[^"]+)"|'(wss?:\/\/[^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u)) return m;
    const httpUrl = u.replace(/^wss?:\/\//i, (proto) => proto.startsWith('wss') ? 'https://' : 'http://');
    return 'new WebSocket("' + toProxyUrl(httpUrl) + '"';
  });

  // new EventSource("url")
  js = js.replace(/\bnew\s+EventSource\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    if (/^https?:\/\//i.test(u)) {
      return 'new EventSource("' + toProxyUrl(u) + '"';
    }
    return m;
  });

  // dynamic import("url") — absolute URLs only
  js = js.replace(/\bimport\s*\(\s*("([^"]+)"|'([^']+)')\s*\)/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'import("' + toProxyUrl(abs) + '")';
    }
    return m;
  });

  // importScripts("url") — used in web workers
  js = js.replace(/\bimportScripts\s*\(\s*((?:"[^"]+"|'[^']+')\s*(?:,\s*(?:"[^"]+"|'[^']+')\s*)*)\)/g, (m, args) => {
    const rewritten = args.replace(/"([^"]+)"|'([^']+)'/g, (_q, dq, sq) => {
      const u = (dq ?? sq ?? '').trim();
      if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return _q;
      if (/^https?:\/\//i.test(u) || u.startsWith('//') || u.startsWith('/')) {
        const abs = resolveUrl(baseUrl, u);
        if (!abs) return _q;
        return '"' + toProxyUrl(abs) + '"';
      }
      return _q;
    });
    return 'importScripts(' + rewritten + ')';
  });

  // new Worker("url") / new SharedWorker("url") — proxy the worker script
  js = js.replace(/\bnew\s+(Worker|SharedWorker)\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, cls, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    if (/^https?:\/\//i.test(u) || u.startsWith('//') || u.startsWith('/')) {
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'new ' + cls + '("' + toProxyUrl(abs) + '"';
    }
    return m;
  });

  // ES module static imports: import ... from "url"
  js = rewriteModuleImports(js, baseUrl);

  // Rewrite webpack public path (r.p / __webpack_require__.p / __webpack_public_path__)
  // Fixes Next.js / webpack5 dynamic chunk loading where chunks use relative paths like /_next/
  // We use a non-encoded proxy prefix so webpack can safely append chunk filenames via string concat.
  js = js.replace(/\b(\w+\.p)\s*=\s*"(\/[^"]{0,120}\/)"(?!\s*\+)/g, (m, ref, path) => {
    if (isAlreadyProxied(path)) return m;
    const abs = resolveUrl(baseUrl, path);
    if (!abs) return m;
    // Build prefix without encoding so "prefix" + "static/chunks/foo.js" resolves correctly
    return ref + '="/_midas/' + currentPaths.browse + '?url=' + abs + '"';
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
    else if (k === 'domain') cookie.domain = v.replace(/^\./, '').toLowerCase();
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

  // Check cache for GET requests BEFORE rate limiting
  if (req.method === 'GET') {
    const cached = getCached('GET', targetUrl);
    if (cached) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-cache': 'HIT',
        'cache-control': 'max-age=300',
      });
      res.end(cached);
      return;
    }
  }

  // Apply rate limiting synchronously (non-blocking)
  checkRateLimit(url.hostname).catch(e => console.error('Rate limit error:', e.message));

  browseHandlerImpl(req, res, url, jar, targetUrl, depth);
}

function browseHandlerImpl(req, res, url, jar, targetUrl, depth = 0) {

  const reqUrl = new URL(req.url, 'http://x');
  for (const [k, v] of reqUrl.searchParams) {
    if (k === 'url') continue;
    url.searchParams.append(k, v);
  }

  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  // Wrap in async to support DNS resolution
  (async () => {
    try {
      await browseHandlerImplAsync(req, res, url, jar, targetUrl, depth, lib, isHttps);
    } catch (err) {
      console.error(`[Browse] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('proxy error');
      }
    }
  })();
}

async function browseHandlerImplAsync(req, res, url, jar, targetUrl, depth, lib, isHttps) {

  // Add realistic browser delay for human-like behavior
  if (depth > 0) {
    await addBrowserDelay();
  }

  // Use enhanced anti-detection headers with IP scrambling and proxy headers
  let detectionHeaders = getEnhancedAntiDetectionHeaders(depth);
  
  // Apply bypass headers if we're retrying due to filter
  if (depth > 0) {
    detectionHeaders = { ...detectionHeaders, ...getBypassHeaders() };
    console.log(`[BYPASS] Attempt ${depth} with enhanced evasion headers`);
  }
  const headers = detectionHeaders;
  
  // Override with host (required)
  headers['host'] = url.host;

  // Determine sec-fetch-* based on accept header (heuristic)
  const isDocumentReq = (req.headers['accept'] || '').includes('text/html') || (req.headers['sec-fetch-dest'] === 'document');
  const isXhrOrFetch = req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers['sec-fetch-mode'] === 'cors' || req.headers['sec-fetch-mode'] === 'same-origin';
  
  // Update sec-fetch headers based on request type
  if (isDocumentReq) {
    headers['sec-fetch-dest'] = 'document';
    headers['sec-fetch-mode'] = 'navigate';
    headers['sec-fetch-user'] = '?1';
  } else if (isXhrOrFetch) {
    headers['sec-fetch-dest'] = 'empty';
    headers['sec-fetch-mode'] = 'cors';
  }

  headers['cache-control'] = isDocumentReq ? 'max-age=0' : 'no-cache';
  if (req.headers['pragma']) headers['pragma'] = req.headers['pragma'];

  // Forward content-type for POST/PUT/PATCH
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];

  // Forward authorization if present
  if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'];

  // Forward any x-* custom headers the JS may send
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-') && !['x-forwarded-for', 'x-real-ip', 'x-sw-intercept', 'x-midas-sid'].includes(k)) {
      headers[k] = v;
    }
  }

  // Set origin to the target origin for same-origin API requests
  const refOriginalUrl = extractOriginalFromProxy(req.headers.referer || '');
  if (refOriginalUrl) {
    headers['referer'] = refOriginalUrl;
    try {
      const refParsed = new URL(refOriginalUrl);
      // Only set origin for non-navigate requests (XHR/fetch)
      if (!isDocumentReq) {
        headers['origin'] = refParsed.origin;
        headers['sec-fetch-site'] = refParsed.hostname === url.hostname ? 'same-origin' : 'cross-site';
      }
    } catch {}
  } else if (req.headers['origin']) {
    // Client sent an origin — rewrite it to the target origin
    const origUrl = extractOriginalFromProxy(req.headers['origin']);
    if (origUrl) {
      try { headers['origin'] = new URL(origUrl).origin; } catch {}
    } else {
      headers['origin'] = url.origin;
    }
  }

  const cookieHeader = buildCookieHeader(jar, url.hostname, url.pathname, isHttps);
  if (cookieHeader) headers['cookie'] = cookieHeader;

  const isCaptchaRequest = isCaptchaUrl(targetUrl);
  if (isCaptchaRequest) {
    Object.assign(headers, buildPassthroughHeaders(req.headers, targetUrl));
  }

  // Use pooled agent for connection reuse and rate limiting
  const pooledAgent = getAgent(url.hostname, isHttps);
  
  // Try to resolve with alternative DNS to bypass ISP blocks
  let resolvedIp = url.hostname;
  try {
    resolvedIp = await resolveWithFallback(url.hostname);
    if (resolvedIp && resolvedIp !== url.hostname) {
      console.log(`[BYPASS] Using IP ${resolvedIp} for ${url.hostname}`);
    }
  } catch (err) {
    console.log(`[BYPASS] Failed to resolve ${url.hostname}, using hostname directly`);
    // Fall through to use hostname
  }
  
  const options = {
    hostname: resolvedIp,  // Use resolved IP to bypass DNS blocks
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    rejectUnauthorized: false,
    agent: pooledAgent,
  };

  // Debug logging for problematic sites
  const isProblematicSite = url.hostname.includes('facebook') || url.hostname.includes('twitter') || url.hostname.includes('netflix');
  if (isProblematicSite) {
    console.log(`[${url.hostname}] Requesting ${url.pathname}${url.search.slice(0, 50)}`);
  }

  const proxyReq = lib.request(options, (proxyRes) => {
    if (isProblematicSite) {
      console.log(`[${url.hostname}] Got response: ${proxyRes.statusCode}, headers: ${JSON.stringify(Object.keys(proxyRes.headers))}`);
    }
    storeCookies(jar, url.hostname, proxyRes.headers['set-cookie']);

    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && depth < 8) {
      const next = resolveUrl(url.toString(), proxyRes.headers.location);
      if (next) {
        const nextUrl = new URL(next);
        
        // Check if this is a filter domain blocking our request
        if (isFilterDomain(nextUrl.hostname)) {
          if (isProblematicSite) {
            console.log(`[FILTER] Detected filter redirect: ${nextUrl.hostname}`);
            console.log(`[FILTER] Retrying original URL with bypass headers...`);
          }
          
          // Don't follow the filter redirect
          proxyRes.on('data', () => {}); // Drain response
          proxyRes.on('end', () => {
            // Retry the original request with bypass headers
            const bypassReqUrl = new URL(req.url, 'http://x');
            const retryUrl = bypassReqUrl.searchParams.get('url');
            if (retryUrl && depth < 3) {
              // Recursively call with increased depth to use different bypass technique
              browseHandler(req, res, retryUrl, depth + 1);
            } else {
              // Give up, return error
              res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
              res.end(`<h1>Content Blocked</h1><p>This site is blocked by your network filter.</p><p>Filter: ${nextUrl.hostname}</p>`);
            }
          });
          return;
        }
        
        // Normal redirect handling
        if (isProblematicSite) {
          console.log(`[${url.hostname}] Redirect to: ${next}`);
        }
        proxyRes.on('data', () => {}); // Drain any buffered data
        proxyRes.on('end', () => {
          if (isProblematicSite) console.log(`[${url.hostname}] Following redirect`);
          if (req.method === 'GET' || req.method === 'HEAD') {
            browseHandler(req, res, next, depth + 1);
          } else {
            res.writeHead(302, { location: toProxyUrl(next), 'cache-control': 'no-store' });
            res.end();
          }
        });
        return;
      }
    }

    const ct = (proxyRes.headers['content-type'] || '').toLowerCase();
    const charsetMatch = ct.match(/charset=([^\s;]+)/i);
    const charset = charsetMatch ? charsetMatch[1] : 'utf-8';

    const enc = (proxyRes.headers['content-encoding'] || '').toLowerCase();
    let stream = proxyRes;
    const wasCompressed = !!enc;
    if (enc === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (enc === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

    const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
    const isCss = ct.includes('text/css');
    const isJs = ct.includes('javascript') || ct.includes('/ecmascript') || ct.includes('text/module');
    const isJson = ct.includes('application/json') || ct.includes('application/manifest+json') || ct.includes('application/ld+json');
    const isXml = ct.includes('application/xml') || ct.includes('text/xml') || ct.includes('application/rss') || ct.includes('application/atom');
    const isFormData = ct.includes('application/x-www-form-urlencoded');
    const isImage = ct.startsWith('image/');

    const outHeaders = { ...proxyRes.headers };
    // Remove security headers that would interfere with proxied content
    delete outHeaders['content-security-policy'];
    delete outHeaders['content-security-policy-report-only'];
    delete outHeaders['strict-transport-security'];
    delete outHeaders['x-frame-options'];
    delete outHeaders['set-cookie'];
    // Remove policies that interfere with cross-origin proxy delivery
    delete outHeaders['cross-origin-opener-policy'];
    delete outHeaders['cross-origin-embedder-policy'];
    delete outHeaders['cross-origin-resource-policy'];
    delete outHeaders['origin-agent-cluster'];
    delete outHeaders['permissions-policy'];
    
    // Add CORS headers to ALL responses (images, fonts, stylesheets need this)
    outHeaders['access-control-allow-origin'] = '*';
    outHeaders['access-control-allow-credentials'] = 'true';
    outHeaders['access-control-allow-methods'] = 'GET, HEAD, OPTIONS';
    outHeaders['access-control-allow-headers'] = '*';
    outHeaders['access-control-expose-headers'] = '*';
    
    // Keep content-length for streaming responses
    // Only delete if we're going to modify content
    if (isHtml || isCss || isJs || isJson || isXml) {
      delete outHeaders['content-length'];
      delete outHeaders['content-encoding'];
      delete outHeaders['transfer-encoding'];
      outHeaders['cache-control'] = 'no-store';
    }
    
    // If we decompressed the stream, always remove content-encoding
    // because the client will receive uncompressed data
    if (wasCompressed && enc) {
      delete outHeaders['content-encoding'];
      delete outHeaders['content-length'];
    }
    delete outHeaders['alt-svc'];

    // Sniff content type from URL extension when server sends generic types
    const urlExt = (url.pathname.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    const sniffedJs = !isHtml && !isCss && !isJs && (urlExt === 'js' || urlExt === 'mjs' || urlExt === 'ts' || urlExt === 'tsx' || urlExt === 'jsx');
    const sniffedCss = !isHtml && !isCss && !isJs && urlExt === 'css';
    const sniffedHtml = !isHtml && (urlExt === 'html' || urlExt === 'htm');

    const shouldRewriteJs = isJs || sniffedJs;
    const shouldRewriteCss = isCss || sniffedCss;
    const shouldRewriteHtml = isHtml || sniffedHtml;

    // Allow CAPTCHA pages to be rewritten and rendered inline (not passthrough)
    // This enables users to solve CAPTCHAs without leaving the proxy
    if (isCaptchaRequest && !shouldRewriteHtml) {
      res.writeHead(proxyRes.statusCode, outHeaders);
      stream.pipe(res);
      return;
    }

    // Only buffer content that needs rewriting (HTML, CSS, JS, JSON, XML)
    // Don't buffer based on status code alone - this breaks large file transfers
    const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB limit
    if (shouldRewriteHtml || shouldRewriteCss || shouldRewriteJs || isJson || isXml) {
      const chunks = [];
      let bufferSize = 0;
      let tooLarge = false;
      
      stream.on('data', c => {
        if (tooLarge) return; // Stop collecting if already too large
        bufferSize += c.length;
        if (bufferSize > MAX_BUFFER_SIZE) {
          tooLarge = true;
          stream.pause();
          // Send buffered content as-is without rewriting
          res.writeHead(proxyRes.statusCode, outHeaders);
          if (chunks.length > 0) res.write(Buffer.concat(chunks));
          stream.pipe(res); // Pipe remaining content
        } else {
          chunks.push(c);
        }
      });
      
      stream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('decode error'); } });
      
      stream.on('end', () => {
        if (tooLarge || res.headersSent) return; // Already sent
        
        const buf = Buffer.concat(chunks);
        const text = decodeBody(buf, charset);
        const baseProxyUrl = '/_midas/' + currentPaths.browse;
        let out = text;

        // Check for Cloudflare challenges
        if (isHtml && isCloudflareChallenge(text) && depth < 3) {
          if (isProblematicSite) {
            console.log(`[CF] Detected Cloudflare challenge, retrying with bypass headers...`);
          }
          // Retry with Cloudflare bypass headers
          browseHandler(req, res, targetUrl, depth + 1);
          return;
        }

        // Sniff HTML content by looking at first non-whitespace chars
        let actuallyHtml = shouldRewriteHtml;
        if (!actuallyHtml && proxyRes.statusCode === 200 && buf.length > 0) {
          const sniff = text.trim().substring(0, 20).toLowerCase();
          actuallyHtml = sniff.startsWith('<!doctype') || sniff.startsWith('<html') || sniff.startsWith('<head') || sniff.startsWith('<body') || sniff.startsWith('<?xml');
        }

        if (actuallyHtml) {
          out = rewriteHtml(text, url.toString(), baseProxyUrl);
          outHeaders['content-type'] = 'text/html; charset=utf-8';
        } else if (shouldRewriteCss) {
          out = rewriteCss(text, url.toString());
          outHeaders['content-type'] = 'text/css; charset=utf-8';
        } else if (shouldRewriteJs) {
          out = rewriteJs(text, url.toString());
          // Preserve original content-type so browsers parse as module if needed
          outHeaders['content-type'] = ct.includes('module') ? 'application/javascript; charset=utf-8' : (ct || 'application/javascript; charset=utf-8');
        } else if (isJson) {
          // Use recursive JSON rewriting for better handling of nested structures
          try {
            const jsonData = JSON.parse(text);
            function rewriteJsonUrls(obj) {
              if (!obj) return obj;
              if (typeof obj === 'string') {
                if (/^https?:\/\//i.test(obj) && !isAlreadyProxied(obj) && !isCaptchaUrl(obj)) {
                  const abs = resolveUrl(url.toString(), obj);
                  return abs ? toProxyUrl(abs) : obj;
                }
                return obj;
              }
              if (Array.isArray(obj)) return obj.map(rewriteJsonUrls);
              if (typeof obj === 'object') {
                const result = {};
                for (const [k, v] of Object.entries(obj)) {
                  result[k] = rewriteJsonUrls(v);
                }
                return result;
              }
              return obj;
            }
            out = JSON.stringify(rewriteJsonUrls(jsonData));
          } catch {
            // Fallback to regex if JSON parsing fails
            out = text.replace(/(?<!\\)"(https?:\/\/[^"\\]+)(?<!\\)"/g, (m, u) => {
              if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
              return '"' + toProxyUrl(u) + '"';
            });
          }
        } else if (isXml) {
          // Rewrite URLs inside XML (RSS feeds, sitemaps, etc.)
          out = text.replace(/(https?:\/\/[^\s<>"']{4,})/g, (m, u) => {
            if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
            return toProxyUrl(u);
          });
        }

        // Cache HTML responses
        if (actuallyHtml && req.method === 'GET' && proxyRes.statusCode === 200) {
          const ttl = getCacheTTL(proxyRes.headers['cache-control'], 'text/html');
          if (ttl > 0) {
            setCached('GET', targetUrl, out, ttl);
          }
        }

        res.writeHead(proxyRes.statusCode, outHeaders);
        res.end(out);
      });
    } else {
      res.writeHead(proxyRes.statusCode, outHeaders);
      stream.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    if (isProblematicSite) {
      console.error(`[${url.hostname}] Request error: ${err.code || err.message}`);
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('proxy error');
    }
  });

  proxyReq.setTimeout(30000, () => {
    if (isProblematicSite) console.error(`[${url.hostname}] Request socket timeout`);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'content-type': 'text/plain' });
      res.end('gateway timeout');
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

  if (pathname === '/_midas/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cache: getCacheStats(),
      timestamp: new Date().toISOString(),
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
    res.write(':ok\n\n');
    const interval = setInterval(() => {
      if (res.writableEnded) { clearInterval(interval); return; }
      res.write(':ping\n\n');
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
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: 'GET',
          headers: { ...data.headers, 'accept': data.headers?.accept || '*/*' },
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
        proxyReq.end();
      } catch (e) {
        res.writeHead(400); res.end();
      }
    });
    return;
  }

  // ── Referer-based fallback proxy ─────────────────────────────────────────
  // When a proxied SPA (Next.js /_next/, Vite /assets/, Nuxt /_nuxt/, CRA /static/, etc.)
  // dynamically loads resources using same-origin relative paths, those requests hit our
  // server instead of the target site. We recover by using the Referer header to determine
  // the target origin and transparently proxy the request there.
  {
    const referer = req.headers['referer'] || req.headers['referrer'] || '';
    if (referer) {
      const refMatch = referer.match(/\/_midas\/[^?#]+\?(?:[^&]*&)*url=([^&\s#]+)/);
      if (refMatch) {
        try {
          const targetOrigin = new URL(decodeURIComponent(refMatch[1])).origin;
          const reqUrl = new URL(req.url, 'http://x');
          // Only proxy non-midas, non-sandbox paths
          if (!reqUrl.pathname.startsWith('/_midas/') &&
              reqUrl.pathname !== '/sandbox.js' &&
              reqUrl.pathname !== '/demo.html') {
            const targetUrl = targetOrigin + req.url;
            setCors(res);
            browseHandler(req, res, targetUrl);
            return;
          }
        } catch (e) { /* fall through to 404 */ }
      }
    }
  }

  res.writeHead(404); res.end();
}

