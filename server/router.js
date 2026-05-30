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
import { resolveWithFallback, isCloudflareIp } from './dns-resolver.js';
import { isFilterDomain, getBypassHeaders, isFilterBlockPage } from './filter-bypass.js';
import { getEnhancedAntiDetectionHeaders, isCloudflareChallenge, isCloudflareError1000, getCloudflareBypassHeaders, addBrowserDelay, addAdaptiveDelay, isBotDetectionPage, isLikelyBotBlock, stripProxyHeaders } from './advanced-evasion.js';
import { detectChallengeType, hasCFClearance, extractCFRayId, attemptIUAMSolve } from './cloudflare-challenge.js';
import { getSiteConfig, getMaxRetries, getSiteSpecificHeaders } from './site-configs.js';
import { shouldRetryRequest, getRetryDelayMs, analyzeErrorResponse } from './error-strategies.js';
import { renderPageWithJS, handleJSChallenge, isAvailable as isBrowserAvailable, closeBrowser } from './browser-automation.js';
import { solveCaptcha } from './captcha-solver.js';
import { injectAntiDetectionScripts } from './webdriver-bypass.js';

// Default agents (fallback)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 60000, freeSocketTimeout: 60000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 60000, freeSocketTimeout: 60000 });
const ACTIVE_TRANSPORTS = new Map();
const COOKIE_JAR = new Map();
// Maps session ID → { origin, ts } so the referer-based fallback can forward
// socket.io / WebSocket / SPA asset requests to the right target even when the
// browser strips the Referer path (e.g. Referrer-Policy: strict-origin).
const SESSION_TARGETS = new Map();
// Purge stale entries every 10 minutes (sessions older than 2 hours).
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of SESSION_TARGETS) { if (v.ts < cutoff) SESSION_TARGETS.delete(k); }
}, 10 * 60 * 1000);

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

// URLs that must NOT be rewritten as string literals in JS because:
//  - The SDK uses the raw URL as a base for WebSocket/gRPC endpoints, so
//    replacing it with a /_midas/... path breaks its URL construction.
//  - The runtime hooks in sandbox.js (fetch, WebSocket interceptors) already
//    route these domains through the proxy at call time.
function isSDKUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /(?:^|\.)(firebaseio\.com|firebaseapp\.com|firebase\.google\.com|firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firebase\.googleapis\.com|cloudfunctions\.net|run\.app)$/.test(host);
  } catch { return false; }
}

// XML/RDF namespace URIs (e.g. http://www.w3.org/1999/xhtml, http://www.w3.org/2000/svg)
// are identifier strings used by libraries like DOMPurify for element validation.
// They are NOT browsable URLs and must NEVER be proxy-rewritten — doing so corrupts
// the library's allow-list and causes it to sanitize all content to an empty string.
function isXmlNamespaceUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /^(www\.)?w3\.org$/.test(h) ||
           /^(www\.)?purl\.org$/.test(h) ||
           /^(www\.)?schema\.org$/.test(h) ||
           /^(www\.)?xmlns\.com$/.test(h) ||
           /^ns\.(adobe|microsoft)\.com$/.test(h) ||
           /^vocab\.org$/.test(h) ||
           /^ogp\.me$/.test(h) ||
           /^open\.vocab\.org$/.test(h);
  } catch { return false; }
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

  // Rewrite inline event handler attributes (onclick, onchange, onsubmit, etc.)
  // MUST run BEFORE the href/src pass below, because the href/src regex would
  // otherwise match `href = '/path'` *inside* onclick values and inject bare
  // double-quotes that break the attribute's HTML structure.
  html = html.replace(/\b(on[a-z]+)\s*=\s*"([^"]*)"/gi, (m, attr, code) => {
    if (!code.trim()) return m;
    const decoded = htmlDecode(code);
    const rewritten = rewriteJs(decoded, baseUrl);
    if (rewritten === decoded) return m;
    return attr + '="' + rewritten.replace(/"/g, '&quot;') + '"';
  });
  html = html.replace(/\b(on[a-z]+)\s*=\s*'([^']*)'/gi, (m, attr, code) => {
    if (!code.trim()) return m;
    const decoded = htmlDecode(code);
    const rewritten = rewriteJs(decoded, baseUrl);
    if (rewritten === decoded) return m;
    return attr + "='" + rewritten.replace(/'/g, '&#39;') + "'";
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
    
    // Inject as the FIRST thing inside <head> so our hooks run before any
    // other scripts (including socket.io, Firebase, etc.) can read and cache
    // real location.origin / location.hostname values.
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head(\b[^>]*)>/i, (m) => m + injectionScript);
    } else if (html.includes('</head>')) {
      html = html.replace('</head>', injectionScript + '</head>');
    } else if (html.includes('</body>')) {
      html = html.replace('</body>', injectionScript + '</body>');
    } else {
      html = injectionScript + html;
    }
  }

  return html;
}

function rewriteJs(js, baseUrl) {
  // Absolute URL strings in double quotes
  // Use (?<!\\) lookbehind to avoid matching JSON-escaped \"url\" sequences (prevents %5C corruption)
  // Use [^"\\\s] to also exclude backslash from URL content
  js = js.replace(/(?<!\\)"(https?:\/\/[^"\\\s]{3,})(?<!\\)"/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u) || isSDKUrl(u) || isXmlNamespaceUrl(u)) return m;
    return '"' + toProxyUrl(u) + '"';
  });
  // Absolute URL strings in single quotes
  js = js.replace(/(?<!\\)'(https?:\/\/[^'\\\s]{3,})(?<!\\)'/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u) || isSDKUrl(u) || isXmlNamespaceUrl(u)) return m;
    return "'" + toProxyUrl(u) + "'";
  });
  // Absolute URL template literals (simple, no expressions)
  js = js.replace(/`(https?:\/\/[^`$\\\s]{3,})`/g, (m, u) => {
    if (isAlreadyProxied(u) || isCaptchaUrl(u) || isSDKUrl(u) || isXmlNamespaceUrl(u)) return m;
    return '`' + toProxyUrl(u) + '`';
  });

  // Protocol-relative URLs
  // Broaden matching and support both "//host/..." and '//host/...'.
  js = js.replace(/(?<!\\)"(\/\/[^"\r\n]{2,})(?<!\\)"/g, (m, u) => {
    if (isAlreadyProxied(u)) return m;
    const abs = 'https:' + u;
    if (isCaptchaUrl(abs) || isSDKUrl(abs)) return m;
    return '"' + toProxyUrl(abs) + '"';
  });

  js = js.replace(/(?<!\\)'(\/\/[^'\r\n]{2,})(?<!\\)'/g, (m, u) => {
    if (isAlreadyProxied(u)) return m;
    const abs = 'https:' + u;
    if (isCaptchaUrl(abs) || isSDKUrl(abs)) return m;
    return "'" + toProxyUrl(abs) + "'";
  });


  // fetch("url") and fetch('url') — including relative paths
  js = js.replace(/\bfetch\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'fetch("' + toProxyUrl(abs) + '"';
    } else if (u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) {
      // Relative URL - resolve from baseUrl
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'fetch("' + toProxyUrl(abs) + '"';
    }
    return m;
  });

  // XMLHttpRequest.open("METHOD", "url") - handle relative URLs
  js = js.replace(/\.open\s*\(\s*("(?:[^"]*)"|'(?:[^']*)')\s*,\s*("([^"]+)"|'([^']+)')/g, (m, method, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u)) return m;
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) {
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return '.open(' + method + ', "' + toProxyUrl(abs) + '"';
    } else if (u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) {
      // Relative URL - resolve from baseUrl
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

  // location.href = "url" / document.location.href = "url" / window.location.href = "url" - BOTH absolute AND relative
  js = js.replace(/\blocation(?:\s*\.\s*href)?\s*=\s*("([^"]+)"|'([^']+)')/g, (m, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u)) return m;
    // Handle both absolute URLs and relative paths
    if (/^https?:\/\//i.test(u)) {
      return 'location.href="' + toProxyUrl(u) + '"';
    } else if (u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) {
      // Relative URL - resolve from baseUrl
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'location.href="' + toProxyUrl(abs) + '"';
    }
    return m;
  });

  // location.assign("url") / location.replace("url") - BOTH absolute AND relative
  js = js.replace(/\blocation\s*\.\s*(assign|replace)\s*\(\s*("([^"]+)"|'([^']+)')/g, (m, method, _q, dq, sq) => {
    const u = (dq ?? sq ?? '').trim();
    if (!u || isAlreadyProxied(u)) return m;
    // Handle both absolute URLs and relative paths
    if (/^https?:\/\//i.test(u)) {
      return 'location.' + method + '("' + toProxyUrl(u) + '"';
    } else if (u.startsWith('/') || u.startsWith('./') || u.startsWith('../')) {
      // Relative URL - resolve from baseUrl
      const abs = resolveUrl(baseUrl, u);
      if (!abs) return m;
      return 'location.' + method + '("' + toProxyUrl(abs) + '"';
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

  // Track the most-recently visited target origin for this session so the
  // referer-based fallback can forward socket.io/SPA requests without Referer.
  SESSION_TARGETS.set(sid, { origin: url.origin, ts: Date.now() });

  // Path-level browse log — helps diagnose SPA navigation (e.g. /app/chat vs /)
  if (depth === 0) console.log(`[BROWSE] ${url.hostname}${url.pathname}${url.search ? url.search.slice(0,40) : ''}`);

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

  // Use adaptive delay based on site and retry depth
  if (depth > 0) {
    await addAdaptiveDelay(url.hostname, depth - 1);
  }

  // Use enhanced anti-detection headers with site-specific configuration
  let detectionHeaders = getEnhancedAntiDetectionHeaders(depth, url.hostname);
  
  // Apply bypass headers if we're retrying due to filter
  if (depth > 0) {
    detectionHeaders = { ...detectionHeaders, ...getBypassHeaders() };
    const siteConfig = getSiteConfig(url.hostname);
    const strategy = siteConfig?.strategy || 'standard';
    console.log(`[BYPASS] Attempt ${depth} (${strategy}) with enhanced evasion headers for ${url.hostname}`);
  }
  const headers = detectionHeaders;
  
  // Override with host (required)
  headers['host'] = url.host;

  // Strip all proxy-identifying headers before sending upstream.
  // These headers (x-forwarded-for, via, cf-connecting-ip, etc.) announce that the
  // request is coming from a proxy/datacenter and are the primary signal Cloudflare's
  // bot management uses to score and block requests.  They must never reach the target.
  Object.assign(headers, stripProxyHeaders(headers));
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (lk.startsWith('x-forwarded') || lk === 'via' || lk === 'forwarded' ||
        lk === 'x-real-ip' || lk === 'cf-connecting-ip' || lk === 'client-ip' ||
        lk === 'x-originating-ip' || lk === 'x-client-ip' || lk === 'proxy-connection') {
      delete headers[k];
    }
  }

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

  // Build cookie header from the server-side jar (cookies received via Set-Cookie)
  const jarCookieHeader = buildCookieHeader(jar, url.hostname, url.pathname, isHttps);

  // Also forward browser cookies from the incoming request.
  // When a proxied page does `document.cookie = 'token=...'` the browser stores
  // the cookie under the proxy's origin and sends it back on every proxy request
  // via req.headers['cookie'].  We must forward these to the target site or
  // server-side auth checks (e.g. vortexos.net checking for 'token') will fail.
  const PROXY_ONLY_COOKIES = new Set(['midas_sid']);
  const browserCookieStr = req.headers['cookie'] || '';
  const browserForward = browserCookieStr
    .split(';')
    .map(s => s.trim())
    .filter(s => {
      const name = s.split('=')[0].trim();
      return name && !PROXY_ONLY_COOKIES.has(name);
    });

  // Build a merged cookie string: jar cookies override browser cookies on conflict
  const jarMap = new Map();
  jarCookieHeader.split(';').map(s => s.trim()).filter(Boolean).forEach(s => {
    const eq = s.indexOf('=');
    if (eq > 0) jarMap.set(s.slice(0, eq).trim(), s);
  });
  const browserMap = new Map();
  browserForward.forEach(s => {
    const eq = s.indexOf('=');
    if (eq > 0) browserMap.set(s.slice(0, eq).trim(), s);
  });
  // Start with browser cookies, then let jar cookies override
  const merged = new Map([...browserMap, ...jarMap]);
  const cookieHeader = [...merged.values()].join('; ');
  if (cookieHeader) headers['cookie'] = cookieHeader;

  const isCaptchaRequest = isCaptchaUrl(targetUrl);
  if (isCaptchaRequest) {
    Object.assign(headers, buildPassthroughHeaders(req.headers, targetUrl));
  }

  // Use pooled agent for connection reuse and rate limiting
  const pooledAgent = getAgent(url.hostname, isHttps);
  
  // Try to resolve with alternative DNS to bypass ISP blocks.
  // Exception: Cloudflare edge IPs must never be used as direct connection targets —
  // connecting to them by IP without SNI causes Error 1000 ("DNS points to prohibited IP")
  // because Cloudflare's shared edge requires the TLS SNI hostname to route the request.
  let resolvedIp = url.hostname;
  try {
    const candidate = await resolveWithFallback(url.hostname);
    if (candidate && candidate !== url.hostname) {
      if (isCloudflareIp(candidate)) {
        console.log(`[BYPASS] ${url.hostname} -> ${candidate} is a Cloudflare edge IP, using hostname directly to preserve SNI`);
        // Leave resolvedIp = url.hostname so the OS resolves it with full SNI
      } else {
        resolvedIp = candidate;
        console.log(`[BYPASS] Using IP ${resolvedIp} for ${url.hostname}`);
      }
    }
  } catch (err) {
    console.log(`[BYPASS] Failed to resolve ${url.hostname}, using hostname directly`);
    // Fall through to use hostname
  }

  // When connecting via a raw IP, TLS has no hostname for SNI unless we set servername.
  // Missing SNI breaks any CDN or virtual-host that routes by domain (Cloudflare, Fastly, etc.)
  const usingIp = resolvedIp !== url.hostname;

  const options = {
    hostname: resolvedIp,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    rejectUnauthorized: false,
    agent: pooledAgent,
    ...(isHttps && usingIp ? { servername: url.hostname } : {}),
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
    // Forward non-HttpOnly cookies to the browser (rewritten for the proxy
    // domain so JS can read them via document.cookie).  HttpOnly cookies stay
    // server-side only (already stored in jar above).
    {
      const rawSc = proxyRes.headers['set-cookie'];
      const scList = rawSc ? (Array.isArray(rawSc) ? rawSc : [rawSc]) : [];
      const visible = scList
        .map(sc => {
          const p = parseSetCookie(sc);
          if (!p || p.httpOnly) return null;
          // Strip domain/secure so the cookie lands on the proxy origin.
          return p.name + '=' + p.value + '; SameSite=Lax; Path=/';
        })
        .filter(Boolean);
      if (visible.length > 0) {
        outHeaders['set-cookie'] = visible;
      } else {
        delete outHeaders['set-cookie'];
      }
    }
    // Remove policies that interfere with cross-origin proxy delivery
    delete outHeaders['cross-origin-opener-policy'];
    delete outHeaders['cross-origin-embedder-policy'];
    delete outHeaders['cross-origin-resource-policy'];
    delete outHeaders['origin-agent-cluster'];
    delete outHeaders['permissions-policy'];
    // Strip Referrer-Policy so the browser keeps its default (full URL for
    // same-origin requests). This ensures our referer-based fallback handler
    // receives the full /_midas/BROWSE?url=... path in the Referer header,
    // which is needed to forward socket.io / SPA-asset requests correctly.
    delete outHeaders['referrer-policy'];
    
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
      
      stream.on('end', async () => {
        if (tooLarge || res.headersSent) return; // Already sent
        
        const buf = Buffer.concat(chunks);
        const text = decodeBody(buf, charset);
        const baseProxyUrl = '/_midas/' + currentPaths.browse;
        let out = text;

        // Debug logging for failing sites
        if (url.hostname.includes('reddit') || url.hostname.includes('stackoverflow')) {
          console.log(`[DEBUG] ${url.hostname}: statusCode=${proxyRes.statusCode}, textLen=${text.length}, isHtml=${ct.includes('text/html') || ct.includes('application/xhtml')}, ct="${ct}"`);
        }

        // Check for Cloudflare challenges with site-specific retry limits
        const maxRetries = getMaxRetries(url.hostname);

        // Error 1000 ("DNS points to prohibited IP") is a hard block from Cloudflare's
        // edge because the server IP is flagged as a datacenter.  It is NOT a JS challenge
        // and cannot be solved by adding headers — but retrying with the cleanest possible
        // browser headers (no proxy artifacts, fresh UA) gives the best chance of a
        // different edge node or path accepting the request.
        if (isHtml && isCloudflareError1000(text)) {
          if (depth < 2) {
            console.log(`[CF] Error 1000 on ${url.hostname} (attempt ${depth + 1}/2) — retrying with clean browser headers`);
            browseHandler(req, res, targetUrl, depth + 1);
          } else {
            console.log(`[CF] Error 1000 on ${url.hostname} — all retries exhausted, passing through error page`);
            outHeaders['content-type'] = 'text/html; charset=utf-8';
            delete outHeaders['content-length'];
            res.writeHead(proxyRes.statusCode, outHeaders);
            res.end(rewriteHtml(text, url.toString(), baseProxyUrl));
          }
          return;
        }

        if (isHtml && isCloudflareChallenge(text)) {
          const challengeType = detectChallengeType(text);
          const rayId = extractCFRayId(text) || 'unknown';
          console.log(`[CF] ${challengeType} challenge on ${url.hostname} (ray:${rayId})`);

          // --- Old IUAM math challenge: solve server-side ---
          if (challengeType === 'iuam' && depth === 0) {
            const solved = await attemptIUAMSolve(text, url.toString());
            if (solved.success) {
              storeCookies(jar, url.hostname, solved.setCookieHeaders);
              console.log(`[CF-IUAM] Solved, retrying ${url.hostname} with cf_clearance`);
              browseHandler(req, res, targetUrl, depth + 1);
            } else {
              console.log(`[CF-IUAM] Server-side solve failed: ${solved.reason} — serving challenge to user`);
              outHeaders['content-type'] = 'text/html; charset=utf-8';
              delete outHeaders['content-length'];
              res.writeHead(proxyRes.statusCode || 403, outHeaders);
              res.end(rewriteHtml(text, url.toString(), baseProxyUrl));
            }
            return;
          }

          // --- Turnstile / Managed challenge: serve to user ---
          // The challenge widget runs in the user's browser.  All API calls to
          // challenges.cloudflare.com go through sandbox.js → our proxy, so the
          // resulting Set-Cookie: cf_clearance is captured by storeCookies() and
          // stored in the session jar.  The user's next navigation will succeed.
          outHeaders['content-type'] = 'text/html; charset=utf-8';
          delete outHeaders['content-length'];
          res.writeHead(proxyRes.statusCode || 403, outHeaders);
          res.end(rewriteHtml(text, url.toString(), baseProxyUrl));
          return;
        }

        // Check for bot detection pages - also check non-HTML responses for 403
        if ((isHtml || proxyRes.statusCode === 403) && isLikelyBotBlock(proxyRes.statusCode, text, proxyRes.headers) && depth < maxRetries) {
          // After 2 retries, try browser automation instead of more HTTP retries
          if (depth >= 2 && isBrowserAvailable()) {
            console.log(`[Browser] Switching to JavaScript rendering after ${depth} HTTP retries for ${url.hostname}...`);
            
            try {
              const result = await renderPageWithJS(targetUrl, { 
                waitUntil: 'networkidle2',
                timeout: 30000,
              });
              
              if (result && result.success && result.html) {
                console.log(`[Browser] JavaScript rendering successful for ${url.hostname}`);
                
                // Process the rendered HTML
                let renderedOut = result.html;
                
                // Inject anti-detection scripts
                renderedOut = injectAntiDetectionScripts(renderedOut);
                
                // Rewrite URLs
                renderedOut = rewriteHtml(renderedOut, url.toString(), baseProxyUrl);
                
                // Send response
                outHeaders['content-type'] = 'text/html; charset=utf-8';
                outHeaders['content-length'] = Buffer.byteLength(renderedOut, 'utf-8');
                res.writeHead(200, outHeaders);
                res.end(renderedOut);
                return;
              }
            } catch (err) {
              console.log('[Browser] JavaScript rendering failed:', err.message);
              // Fall through to continue retrying
            }
          }
          
          // Continue with HTTP retries if browser automation not attempted or failed
          console.log(`[BOT] Detected bot detection for ${url.hostname} (${proxyRes.statusCode}), retrying (${depth}/${maxRetries})...`);
          // Retry with more aggressive evasion
          browseHandler(req, res, targetUrl, depth + 1);
          return;
        }

        // Detect other bot detection patterns in HTML
        if (isHtml && isBotDetectionPage(text) && depth < maxRetries) {
          console.log(`[BOT] Detected bot detection page on ${url.hostname}, retrying...`);
          browseHandler(req, res, targetUrl, depth + 1);
          return;
        }

        // Try to solve CAPTCHA if detected and browser automation didn't work
        if (isHtml && depth < maxRetries) {
          try {
            const captchaResult = await solveCaptcha(text, targetUrl, '2CAPTCHA');
            if (captchaResult && captchaResult.html) {
              console.log('[CAPTCHA] Successfully solved CAPTCHA, injecting token...');
              out = captchaResult.html;
            }
          } catch (err) {
            console.log('[CAPTCHA] CAPTCHA solving failed:', err.message);
            // Fall through to normal response
          }
        }

        // Sniff HTML content more reliably.
        // Some sites start with comments/whitespace/extra tags before <!doctype>.
        let actuallyHtml = shouldRewriteHtml;
        if (!actuallyHtml && proxyRes.statusCode === 200 && buf.length > 0) {
          const t = text.trim();
          const head = t.substring(0, Math.min(t.length, 2048)).toLowerCase();
          // If it even looks like HTML, prefer rewriting so links/assets get proxied.
          actuallyHtml = (
            head.startsWith('<!doctype') ||
            head.startsWith('<html') ||
            head.startsWith('<head') ||
            head.startsWith('<body') ||
            head.startsWith('<?xml') ||
            head.includes('<html') ||
            head.includes('<head') ||
            head.includes('<body')
          );
        }


        if (actuallyHtml) {
          out = rewriteHtml(text, url.toString(), baseProxyUrl);
          outHeaders['content-type'] = 'text/html; charset=utf-8';

          // ── Cookie injection ──────────────────────────────────────────────
          // The proxy strips all Set-Cookie headers so the browser never stores
          // server-set cookies (e.g. `token`).  Proxied JS that reads
          // document.cookie (e.g. socket.js: document.cookie.split('token='))
          // gets undefined, causing auth failures on socket connect.
          //
          // Fix: collect every non-HttpOnly cookie in the server-side jar for
          // this host and inject a tiny <script> right after sandbox.js that
          // assigns each one via `document.cookie = ...`.  sandbox.js's virtual
          // cookie setter stores them in sessionStorage so they are visible to
          // subsequent document.cookie reads.
          try {
            const now = Date.now();
            const cookieLines = [];
            for (const [host, list] of jar) {
              if (!hostMatches(host, url.hostname)) continue;
              for (const c of list) {
                if (c.httpOnly) continue;
                if (c.expires && c.expires < now) continue;
                cookieLines.push(
                  `try{document.cookie=${JSON.stringify(c.name + '=' + c.value + '; SameSite=Lax; Path=/')};}catch(_e){}`
                );
              }
            }
            if (cookieLines.length > 0) {
              const cookieScript = '<script>' + cookieLines.join('') + '</script>';
              // Inject immediately after the sandbox.js tag so the virtual
              // cookie setter (installed by sandbox.js) is already active.
              const sbRe = /(<script[^>]+sandbox\.js[^>]*><\/script>)/i;
              if (sbRe.test(out)) {
                out = out.replace(sbRe, '$1' + cookieScript);
              } else {
                out = out.replace(/<\/head>/i, cookieScript + '</head>');
              }
            }
          } catch (_ce) { /* never break HTML rendering */ }
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

            // Keys whose string values are semantic identifiers (namespaces, schemas, types),
            // not navigable resource URLs — rewriting them would corrupt any library that
            // validates namespace URIs (XML validators, JSON-LD processors, OpenAPI parsers, etc.)
            const JSON_NAMESPACE_KEYS = new Set([
              '@context', '@type', '@vocab', '@base', '@id',
              'namespace', 'xmlns', '$schema', 'schema',
              'format', 'contentMediaType',
            ]);

            // Well-known namespace URI prefixes that are semantic identifiers, never resources
            const NAMESPACE_URI_PREFIXES = [
              'http://www.w3.org/',
              'https://www.w3.org/',
              'http://purl.org/',
              'https://purl.org/',
              'http://schema.org/',
              'https://schema.org/',
              'http://xmlns.com/',
              'http://ns.adobe.com/',
              'http://ogp.me/ns',
              'http://json-schema.org/',
              'https://json-schema.org/',
              'http://iiif.io/',
              'http://www.iana.org/',
              'https://www.iana.org/',
              'http://www.openarchives.org/',
              'http://dublincore.org/',
              'https://dublincore.org/',
            ];

            function isNamespaceUri(s) {
              return NAMESPACE_URI_PREFIXES.some(p => s.startsWith(p));
            }

            // parentKey: the object key whose value we are currently visiting,
            // used to skip rewriting values that carry semantic namespace meaning
            function rewriteJsonUrls(obj, parentKey) {
              if (!obj) return obj;
              if (typeof obj === 'string') {
                // Guard: never rewrite namespace/schema/semantic-identifier strings
                if (JSON_NAMESPACE_KEYS.has(parentKey) || isNamespaceUri(obj)) return obj;
                if (/^https?:\/\//i.test(obj) && !isAlreadyProxied(obj) && !isCaptchaUrl(obj)) {
                  const abs = resolveUrl(url.toString(), obj);
                  return abs ? toProxyUrl(abs) : obj;
                }
                return obj;
              }
              if (Array.isArray(obj)) return obj.map(item => rewriteJsonUrls(item, parentKey));
              if (typeof obj === 'object') {
                const result = {};
                for (const [k, v] of Object.entries(obj)) {
                  result[k] = rewriteJsonUrls(v, k);
                }
                return result;
              }
              return obj;
            }
            out = JSON.stringify(rewriteJsonUrls(jsonData, null));
          } catch {
            // Fallback to regex if JSON parsing fails — skip namespace URIs here too
            out = text.replace(/(?<!\\)"(https?:\/\/[^"\\]+)(?<!\\)"/g, (m, u) => {
              if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;
              // Skip well-known namespace URI prefixes
              if (/^https?:\/\/(www\.w3\.org|purl\.org|schema\.org|xmlns\.com|ns\.adobe\.com|ogp\.me\/ns|json-schema\.org|iiif\.io|www\.iana\.org|www\.openarchives\.org|dublincore\.org)/.test(u)) return m;
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
      // Diagnostic: log socket.io / firebase WS-poll responses so we can see
      // what event data is actually being delivered to the browser.
      const isRealtime = url.pathname.startsWith('/socket.io/') ||
        url.pathname.startsWith('/.ws') || url.pathname.startsWith('/ws');
      if (isRealtime && req.method === 'GET') {
        const teeChunks = [];
        stream.on('data', (c) => { teeChunks.push(c); res.write(c); });
        stream.on('end', () => {
          const body = Buffer.concat(teeChunks).toString('utf8');
          if (body && body.length > 2) {
            console.log(`[RT POLL] ${url.hostname} status=${proxyRes.statusCode} len=${body.length} data="${body.slice(0, 120).replace(/[\x00-\x1f]/g, '·')}"`);
          }
          res.end();
        });
        stream.on('error', () => { try { res.end(); } catch (_) {} });
      } else {
        stream.pipe(res);
      }
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

  // Socket.io long-polling holds connections open for up to the server's
  // pingInterval (default 25 s). Give it 65 s so we never kill a live poll.
  const isSocketIoPath = url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/ws') || url.pathname.startsWith('/.ws');
  proxyReq.setTimeout(isSocketIoPath ? 65000 : 30000, () => {
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

export { SESSION_TARGETS, COOKIE_JAR, parseCookieHeader, jarFor, buildCookieHeader };

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

  // ── cookie-sync: sandbox.js POSTs cookies that JS set on the proxied page
  //    so the server-side jar can forward them to the target host.
  if (pathname.endsWith('/cookie-sync')) {
    const sid = getOrCreateSid(req, res);
    const jar = jarFor(sid);
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { host, cookie } = JSON.parse(body);
        if (host && cookie) {
          // Parse the cookie string (name=value; attrs...) into a Set-Cookie-like entry
          storeCookies(jar, host, [cookie.replace(/;\s*SameSite=Strict\b/gi, '; SameSite=Lax')]);
        }
      } catch (e) { /* ignore malformed */ }
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-credentials': 'true',
      });
      res.end();
    });
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

  // ── Referer + session-based fallback proxy ──────────────────────────────
  // Handles requests that reach the proxy server on non-/_midas/ paths.
  // This covers:
  //   • socket.io/engine.io polling (/socket.io/?EIO=...)
  //   • SPA chunk loading (/_next/static/, /assets/, /_nuxt/, etc.)
  //   • Any relative-URL fetch that a proxied page makes to its own origin
  //
  // Resolution order:
  //   1. Referer header — parse /_midas/…?url=<target> from it (works when
  //      the iframe referrerpolicy is NOT no-referrer and the site doesn't
  //      send Referrer-Policy: no-referrer)
  //   2. SESSION_TARGETS — the last origin browsed by this session cookie;
  //      used as a reliable fallback when the Referer is stripped or absent.
  {
    const reqUrl = new URL(req.url, 'http://x');
    // Never intercept our own proxy paths or static assets.
    const isOwnPath = reqUrl.pathname.startsWith('/_midas/') ||
      reqUrl.pathname === '/sandbox.js' ||
      reqUrl.pathname === '/loader.js' ||
      reqUrl.pathname === '/sw.js' ||
      reqUrl.pathname === '/demo.html' ||
      reqUrl.pathname === '/manifest.json' ||
      /^\/(favicon|midas\.client\.js)/.test(reqUrl.pathname);

    if (!isOwnPath) {
      let targetOrigin = null;

      // 1. Try Referer header first.
      const referer = req.headers['referer'] || req.headers['referrer'] || '';
      if (referer) {
        const refMatch = referer.match(/\/_midas\/[^?#]+\?(?:[^&]*&)*url=([^&\s#]+)/);
        if (refMatch) {
          try { targetOrigin = new URL(decodeURIComponent(refMatch[1])).origin; } catch (_) {}
        }
        // Also accept bare-origin referer (e.g. Referrer-Policy: origin) if no
        // path match — in that case fall through to session lookup.
      }

      // 2. Fall back to session-based target origin.
      if (!targetOrigin) {
        const cookies = parseCookieHeader(req.headers.cookie);
        const sid = cookies.midas_sid;
        if (sid && SESSION_TARGETS.has(sid)) {
          targetOrigin = SESSION_TARGETS.get(sid).origin;
        }
      }

      if (targetOrigin) {
        try {
          const targetUrl = targetOrigin + req.url;
          setCors(res);
          browseHandler(req, res, targetUrl);
          return;
        } catch (_) { /* fall through */ }
      }
    }
  }

  res.writeHead(404); res.end();
}

