/**
 * Midas Navigation & API Hook
 * Intercepts navigation, fetch, XHR, WebSocket, EventSource, and DOM mutations.
 */
(function () {
  'use strict';
  if (window.__midas_hook) return;
  window.__midas_hook = true;

  // ── Function.prototype.toString spoofing ──────────────────────────────────
  // Fingerprinting scripts (DDG, Reddit, bot detectors) call fetch.toString()
  // and XMLHttpRequest.prototype.open.toString() to detect proxy wrappers.
  // We intercept Function.prototype.toString and return '[native code]' for
  // any function we explicitly mark with _markNative() below.
  var _nativeFnSet;
  try { _nativeFnSet = new WeakSet(); } catch(e2) { _nativeFnSet = null; }
  var _origToStr = Function.prototype.toString;
  try {
    var _spoofedToStr = function toString() {
      if (_nativeFnSet && _nativeFnSet.has(this)) {
        return 'function ' + (this.name || '') + '() { [native code] }';
      }
      return _origToStr.call(this);
    };
    Object.defineProperty(Function.prototype, 'toString', {
      value: _spoofedToStr, writable: true, configurable: true,
    });
    if (_nativeFnSet) try { _nativeFnSet.add(_spoofedToStr); } catch(e2) {}
  } catch(e2) {}
  function _markNative(fn) {
    if (_nativeFnSet && fn && typeof fn === 'function') {
      try { _nativeFnSet.add(fn); } catch(e2) {}
    }
    return fn;
  }

  // Global error handler for SPA issues
  var errorCount = 0;
  var origError = console.error;
  console.error = function() {
    errorCount++;
    return origError.apply(console, arguments);
  };
  window.addEventListener('error', function() { errorCount++; });
  window.addEventListener('unhandledrejection', function() { errorCount++; });

  // Detect proxy base from current URL path
  var m = location.pathname.match(/^(\/_midas\/[^\/]+)/);
  var PROXY_BASE = m ? m[1] : '';

  // Refresh PROXY_BASE from the fixed session endpoint so navigation still
  // works after the polymorph seed rotates (every 5 min server-side).
  // /_midas/session is a stable path that always returns current paths.
  // shouldProxy() skips it (contains /_midas/) so it goes direct to proxy.
  (function _scheduleProxyBaseRefresh() {
    function _refreshProxyBase() {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/_midas/session?t=chunked', true);
        xhr.onload = function () {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data && data.paths && data.paths.browse) {
              PROXY_BASE = '/_midas/' + data.paths.browse;
            }
          } catch (e2) {}
        };
        xhr.send();
      } catch (e) {}
    }
    // First refresh after 200ms (page is fully initialised by then),
    // then every 4 minutes to stay ahead of the 5-minute rotation.
    setTimeout(_refreshProxyBase, 200);
    setInterval(_refreshProxyBase, 4 * 60 * 1000);
  })();

  // Read the target base URL from the script tag's data-base attribute
  var BASE_URL = '';
  try {
    var scripts = document.querySelectorAll('script[data-base]');
    for (var i = 0; i < scripts.length; i++) {
      BASE_URL = scripts[i].getAttribute('data-base') || '';
      if (BASE_URL) break;
    }
  } catch (e) {}

  // Cache the REAL proxy origin before any location virtualisation below.
  // toProxy/shouldProxy must always compare against the proxy server's actual
  // origin (not the virtualised target-site origin) or they'd stop proxying.
  var _REAL_ORIGIN = location.origin;

  // ── document.cookie interceptor ──────────────────────────────────────────
  // Proxied pages may run inside a sandboxed iframe where document.cookie
  // writes are silently blocked (sandbox inheritance / cross-site context).
  // We mirror every cookie set by proxied JS through sessionStorage so it
  // persists across page navigations and is always readable by the next page.
  // SameSite=Strict is downgraded to SameSite=Lax so the cookie survives
  // same-origin iframe navigations in cross-site top-level contexts.
  try {
    var _MIDAS_SS_KEY = '_midas_jar';
    var _cookieHost = '';
    try { if (BASE_URL) _cookieHost = new URL(BASE_URL).hostname; } catch(e2) {}

    var _cookieProto = Document.prototype;
    var _cookieDesc  = Object.getOwnPropertyDescriptor(_cookieProto, 'cookie');
    if (!_cookieDesc) {
      _cookieProto = HTMLDocument.prototype;
      _cookieDesc  = Object.getOwnPropertyDescriptor(_cookieProto, 'cookie');
    }

    if (_cookieDesc && _cookieDesc.get && _cookieDesc.set) {
      var _realCookieGet = _cookieDesc.get;
      var _realCookieSet = _cookieDesc.set;

      function _ssJarGet() {
        try { return JSON.parse(sessionStorage.getItem(_MIDAS_SS_KEY) || '{}'); } catch(e2) { return {}; }
      }
      function _ssJarSet(obj) {
        try { sessionStorage.setItem(_MIDAS_SS_KEY, JSON.stringify(obj)); } catch(e2) {}
      }

      // On every page load, replay cookies saved in previous pages of this
      // session so the real cookie store has them (with SameSite=Lax).
      (function _restoreJar() {
        var jar = _ssJarGet();
        for (var _cn in jar) {
          try {
            _realCookieSet.call(document,
              jar[_cn].replace(/;\s*SameSite=Strict\b/gi, '; SameSite=Lax'));
          } catch(e2) {}
        }
      })();

      Object.defineProperty(_cookieProto, 'cookie', {
        get: function () {
          var real = '';
          try { real = _realCookieGet.call(this); } catch(e2) {}
          // Merge sessionStorage-backed cookies to fill gaps where the browser
          // silently blocked the real cookie store.
          var jar  = _ssJarGet();
          var seen = {};
          real.split(';').forEach(function (c) {
            c = c.trim(); if (!c) return;
            var i = c.indexOf('=');
            if (i > 0) seen[c.slice(0, i).trim()] = true;
          });
          var extras = [];
          for (var jn in jar) {
            if (seen[jn]) continue;
            var pair = jar[jn].split(';')[0].trim();
            extras.push(pair);
          }
          return real + (real && extras.length ? '; ' : '') + extras.join('; ');
        },
        set: function (cookieStr) {
          cookieStr = String(cookieStr);
          // Downgrade SameSite=Strict → Lax for cross-site iframe compat.
          var modified = cookieStr.replace(/;\s*SameSite=Strict\b/gi, '; SameSite=Lax');
          try { _realCookieSet.call(this, modified); } catch(e2) {}
          // Mirror into sessionStorage.
          var nameVal = modified.split(';')[0].trim();
          var ei = nameVal.indexOf('=');
          if (ei > 0) {
            var cname = nameVal.slice(0, ei).trim();
            var cval  = nameVal.slice(ei + 1).trim();
            var jar   = _ssJarGet();
            if (cval) {
              jar[cname] = modified;
            } else {
              delete jar[cname];
            }
            _ssJarSet(jar);
            // Sync to server-side cookie jar so the proxy can forward the
            // cookie to the target site on subsequent requests.
            if (cval && _cookieHost && PROXY_BASE) {
              try {
                navigator.sendBeacon(
                  PROXY_BASE + '/cookie-sync',
                  JSON.stringify({ host: _cookieHost, cookie: cookieStr })
                );
              } catch(e2) {}
            }
          }
        },
        configurable: true,
      });
    }
  } catch(e) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  // Paths that the proxy server itself owns — never forward these to the target site.
  var _PROXY_OWN_RE = /^\/(sandbox\.js|loader\.js|sw\.js|demo\.html|manifest\.json|favicon[^/]*|_midas\b)/;

  // Returns true when a same-proxy-origin path should actually be forwarded to
  // the target site. This happens when a library (e.g. socket.io, engine.io)
  // captures window.location.origin before our virtualiser runs and then
  // constructs absolute XHR/fetch URLs against the proxy server's origin instead
  // of the target site's origin.
  function _isMisroutedTargetPath(pathname) {
    return BASE_URL && !_PROXY_OWN_RE.test(pathname);
  }

  function toProxy(url) {
    if (!url) return url;
    // Handle TrustedScriptURL and other non-string URL-like objects (Trusted Types API)
    if (typeof url !== 'string') {
      url = (url.toString ? url.toString() : String(url));
    }
    url = url.trim();
    if (!url) return url;
    if (url.indexOf('data:') === 0) return url;
    if (url.indexOf('blob:') === 0) return url;
    if (url.indexOf('javascript:') === 0) return url;
    if (url.indexOf('/_midas/') !== -1) return url;
    if (url.charAt(0) === '#') return url;
    if (url === 'about:blank') return url;
    try {
      var base = BASE_URL || location.href;
      var abs = new URL(url, base).href;
      var parsed = new URL(abs);
      // Don't proxy /_midas/ paths — those are already proxy paths.
      if (parsed.origin === _REAL_ORIGIN && parsed.pathname.indexOf('/_midas/') === 0) return url;
      // If the URL targets the proxy server's origin on a non-proxy path (e.g.
      // /socket.io/, /api/, /graphql — meaning a library cached the real origin
      // before our virtualiser ran), rewrite it to use the target site's origin.
      if (parsed.origin === _REAL_ORIGIN && _isMisroutedTargetPath(parsed.pathname)) {
        try {
          var targetOrigin = new URL(BASE_URL).origin;
          abs = targetOrigin + parsed.pathname + parsed.search + parsed.hash;
        } catch (e2) { return url; }
      } else if (parsed.origin === _REAL_ORIGIN) {
        // Proxy-server–owned path — let it pass through unchanged.
        return url;
      }
      // Challenge-service URLs must reach their real origin — not our proxy.
      // Return the absolute URL so the browser navigates / fetches directly.
      // Returning the original (possibly relative) url would make the browser
      // resolve it against our proxy origin, sending the request to our server.
      if (_isChallengeUrl(abs)) return abs;
      return PROXY_BASE + '?url=' + encodeURIComponent(abs);
    } catch (e) { return url; }
  }

  // Challenge-service domains that must load from their REAL origin so that
  // their postMessage origin checks pass.  These widgets (Turnstile, hCaptcha,
  // reCAPTCHA…) are designed for cross-origin embedding; proxying them through
  // /_midas/… replaces their origin with ours and breaks the parent's
  // `event.origin === 'https://challenges.cloudflare.com'` guard.
  var _CHALLENGE_DOMAINS = [
    'challenges.cloudflare.com',
    'js.hcaptcha.com',
    'api.hcaptcha.com',
    'newassets.hcaptcha.com',
    'hcaptcha.com',
    'www.google.com',
    'www.gstatic.com',
    'www.recaptcha.net',
    'recaptcha.net',
    'waf.amazonaws.com',
    'arkoselabs.com',
    'client-api.arkoselabs.com',
    'funcaptcha.com',
  ];

  function _isChallengeServiceHost(hostname) {
    hostname = hostname.toLowerCase();
    for (var _ci = 0; _ci < _CHALLENGE_DOMAINS.length; _ci++) {
      var d = _CHALLENGE_DOMAINS[_ci];
      if (hostname === d || hostname.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  function _isChallengeUrl(absUrl) {
    try {
      var p = new URL(absUrl);
      // Known challenge-service hostnames (Turnstile iframe, hCaptcha, reCAPTCHA…)
      // These must load from their real origin so postMessage origin checks pass.
      if (_isChallengeServiceHost(p.hostname)) return true;
      var path = p.pathname.toLowerCase();
      var search = p.search.toLowerCase();
      // CF challenge orchestration scripts — CF gates these on the caller's IP.
      // A datacenter IP gets another challenge instead of the script.  The browser
      // must fetch them directly with the user's real IP so CF serves the JS.
      if (path.indexOf('/cdn-cgi/challenge-platform/') !== -1) return true;
      // Old IUAM token exchange — IP-locked to the user's browser IP.
      if (path.indexOf('/cdn-cgi/l/chk_jschl') !== -1) return true;
      // Post-challenge redirect token — IP-locked to user browser's IP.
      // Our server can't submit it; must go direct from browser.
      if (search.indexOf('__cf_chl_rt_tk=') !== -1) return true;
    } catch (e) {}
    return false;
  }

  function shouldProxy(url) {
    if (!url) return false;
    // Handle TrustedScriptURL and other non-string URL-like objects
    if (typeof url !== 'string') {
      url = (url.toString ? url.toString() : String(url));
    }
    if (url.indexOf('/_midas/') !== -1) return false;
    if (url.indexOf('data:') === 0) return false;
    if (url.indexOf('blob:') === 0) return false;
    if (url.indexOf('javascript:') === 0) return false;
    if (url === 'about:blank' || url === '') return false;
    try {
      var base = BASE_URL || location.href;
      var abs = new URL(url, base).href;
      var parsed = new URL(abs);
      if (parsed.origin === _REAL_ORIGIN) {
        // Same-origin as proxy server. Only proxy it if it looks like a
        // misrouted target-site request (e.g. socket.io polling that cached
        // the real window.location.origin before our virtualiser ran).
        return _isMisroutedTargetPath(parsed.pathname);
      }
      // Let challenge-service URLs load / submit directly from the browser:
      //  • challenge-service domains (Turnstile, hCaptcha, reCAPTCHA…) so
      //    their iframe postMessage origin checks pass
      //  • /cdn-cgi/challenge-platform/ paths on any domain (CF orchestration
      //    scripts — proxying causes infinite challenge loops)
      //  • URLs with __cf_chl_rt_tk (IP-locked CF challenge tokens)
      if (_isChallengeUrl(abs)) return false;
      return true;
    } catch (e) { return false; }
  }

  // ── Prototype-level src/href interceptors ─────────────────────────────────
  // These intercept ALL src/href assignments at the prototype level, catching
  // webpack chunk loaders (u.src = chunkUrl), dynamic link insertions, etc.
  // This is more reliable than per-instance Object.defineProperty.

  try {
    var _scrSrcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (_scrSrcDesc && _scrSrcDesc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        get: _scrSrcDesc.get,
        set: function (v) {
          var url = (v && typeof v === 'object' && v.toString) ? v.toString() : String(v || '');
          // Always call toProxy — it now returns absolute target-domain URLs for
          // challenge-service paths (instead of proxying them), so relative
          // challenge URLs resolve to the target domain, not our proxy origin.
          if (url) url = toProxy(url);
          _scrSrcDesc.set.call(this, url);
        },
        configurable: true,
      });
    }
  } catch (e) {}

  try {
    var _lnkHrefDesc = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
    if (_lnkHrefDesc && _lnkHrefDesc.set) {
      Object.defineProperty(HTMLLinkElement.prototype, 'href', {
        get: _lnkHrefDesc.get,
        set: function (v) {
          var url = (v && typeof v === 'object' && v.toString) ? v.toString() : String(v || '');
          if (url) url = toProxy(url);
          _lnkHrefDesc.set.call(this, url);
        },
        configurable: true,
      });
    }
  } catch (e) {}

  try {
    var _imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (_imgSrcDesc && _imgSrcDesc.set) {
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: _imgSrcDesc.get,
        set: function (v) {
          var url = (v && typeof v === 'object' && v.toString) ? v.toString() : String(v || '');
          if (url) url = toProxy(url);
          _imgSrcDesc.set.call(this, url);
        },
        configurable: true,
      });
    }
  } catch (e) {}

  // ── DOM patching ──────────────────────────────────────────────────────────

  function patchAnchor(a) {
    if (a.__midas_patched) return;
    var href = a.getAttribute('href');
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    if (href.indexOf('/_midas/') !== -1) return;
    // Only rewrite absolute cross-origin URLs (http/https or protocol-relative).
    // Relative paths (e.g. "/app/chat", "./page") must NOT be rewritten here because
    // SPA frameworks (React Router, Vue Router, etc.) read the DOM .href property
    // from the <a> element to determine the navigation target. If we rewrite it to a
    // /_midas/ proxy URL, the SPA router pushes that proxy path as the route, which
    // matches nothing and causes a white screen. Relative paths are handled either by
    // the SPA's own router (via our history.pushState override) or by the click
    // handler fallback below.
    if (/^https?:\/\//i.test(href) || href.indexOf('//') === 0) {
      a.setAttribute('data-midas-orig', href);
      a.setAttribute('href', toProxy(href));
    }
    a.__midas_patched = true;
  }

  function patchForm(f) {
    if (f.__midas_patched) return;
    var action = f.getAttribute('action');
    if (action && action.indexOf('/_midas/') === -1) {
      f.setAttribute('data-midas-orig-action', action);
      f.setAttribute('action', toProxy(action));
    }
    f.__midas_patched = true;
  }

  function patchNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.tagName === 'A') patchAnchor(node);
    if (node.tagName === 'FORM') patchForm(node);
    // Patch SCRIPT src (MutationObserver backup for dynamically set src attributes)
    if (node.tagName === 'SCRIPT') {
      var scriptSrc = node.getAttribute('src');
      if (scriptSrc && scriptSrc.indexOf('/_midas/') === -1 && scriptSrc.indexOf('data:') !== 0 && scriptSrc.indexOf('blob:') !== 0) {
        var patchedSrc = toProxy(scriptSrc);
        if (patchedSrc !== scriptSrc) node.setAttribute('src', patchedSrc);
      }
    }
    // Patch LINK href (stylesheets, preloads, modulepreloads)
    if (node.tagName === 'LINK') {
      var linkHref = node.getAttribute('href');
      if (linkHref && linkHref.indexOf('/_midas/') === -1 && linkHref.indexOf('data:') !== 0) {
        var patchedHref = toProxy(linkHref);
        if (patchedHref !== linkHref) node.setAttribute('href', patchedHref);
      }
    }
    if (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'AUDIO' || node.tagName === 'SOURCE') {
      var src = node.getAttribute('src');
      if (src && src.indexOf('/_midas/') === -1 && src.indexOf('data:') !== 0 && src.indexOf('blob:') !== 0) {
        var absSrc = src;
        if (!/^https?:\/\//i.test(src) && src.indexOf('//') !== 0) {
          try { absSrc = new URL(src, BASE_URL || location.href).href; } catch (e2) { absSrc = ''; }
        }
        if (absSrc && shouldProxy(absSrc)) node.setAttribute('src', toProxy(absSrc));
      }
      var srcset = node.getAttribute('srcset');
      if (srcset) {
        var newSrcset = srcset.split(',').map(function(part) {
          var seg = part.trim().split(/\s+/);
          if (seg[0] && seg[0].indexOf('/_midas/') === -1 && seg[0].indexOf('data:') !== 0) {
            seg[0] = toProxy(seg[0]);
          }
          return seg.join(' ');
        }).join(', ');
        node.setAttribute('srcset', newSrcset);
      }
      // Handle lazy-load data-src / data-original / data-lazy-src attributes
      var lazyAttrs = ['data-src', 'data-href', 'data-lazy-src', 'data-original', 'data-url', 'data-bg', 'data-background', 'data-lazy'];
      for (var la = 0; la < lazyAttrs.length; la++) {
        var lazyVal = node.getAttribute(lazyAttrs[la]);
        if (lazyVal && lazyVal.indexOf('/_midas/') === -1 && lazyVal.indexOf('data:') !== 0 && lazyVal.indexOf('blob:') !== 0) {
          if (shouldProxy(lazyVal)) node.setAttribute(lazyAttrs[la], toProxy(lazyVal));
        }
      }
    }
    if (node.querySelectorAll) {
      var anchors = node.querySelectorAll('a[href]:not([data-midas-orig])');
      for (var i = 0; i < anchors.length; i++) patchAnchor(anchors[i]);
      var forms = node.querySelectorAll('form');
      for (var i = 0; i < forms.length; i++) patchForm(forms[i]);
    }
  }

  patchNode(document.documentElement || document.body);

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].nodeType === 1) patchNode(nodes[j]);
      }
      // Handle attribute mutations on existing nodes (e.g. JS sets img.src)
      if (mutations[i].type === 'attributes') {
        var el = mutations[i].target;
        var attrName = mutations[i].attributeName;
        if ((attrName === 'href' || attrName === 'src') && el.__midas_attr_patching !== true) {
          el.__midas_attr_patching = true;
          patchNode(el);
          el.__midas_attr_patching = false;
        }
      }
    }
  });

  var observerTarget = document.body || document.documentElement;
  if (observerTarget) {
    observer.observe(observerTarget, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src'] });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      patchNode(document.documentElement || document.body);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'src'] });
    });
  }

  // ── Click / submit fallback ───────────────────────────────────────────────

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.tagName !== 'A') el = el.parentElement;
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    // Already proxied — let the browser follow the href naturally.
    if (href.indexOf('/_midas/') !== -1) return;

    // Absolute cross-origin URL not yet patched (patchAnchor may have missed it).
    if (/^https?:\/\//i.test(href) || href.indexOf('//') === 0) {
      e.preventDefault();
      window.location.href = toProxy(href);
      return;
    }

    // Relative URL (e.g. "/app/chat", "./page").
    // These are same-site navigations. For SPAs (React Router, Vue Router, etc.)
    // we must NOT intercept here — their bubble-phase click handler calls
    // e.preventDefault() + history.push(), and our history.pushState override
    // handles the rest. Intercepting in capture phase (before the SPA handler)
    // would either corrupt the route or force a full page reload, causing a
    // white screen when the SPA's session/auth state is lost.
    //
    // For plain multi-page sites every anchor href was already rewritten to a
    // /_midas/ URL server-side (rewriteHtml), so they never reach this branch.
    // The only relative hrefs that arrive here are dynamically injected by a
    // SPA, so we let them propagate naturally. If the SPA's router handles the
    // click (preventDefault + pushState) our overrides keep everything proxied.
    // If no SPA router claims the click the browser will navigate to the
    // relative path on the proxy server; our location.href setter will catch
    // any programmatic location.href = '...' assignment and proxy it.
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var action = form.getAttribute('action');
    if (action && action.indexOf('/_midas/') === -1) {
      form.setAttribute('action', toProxy(action));
    }
  }, true);

  // ── History interception ──────────────────────────────────────────────────
  // SPA sites call history.pushState for client-side routing.
  //
  // Previous approach: keep bare path (e.g. "/app/chat") as the browser URL.
  // Problem: the proxy server has no handler for "/app/chat", so unintercepted
  // native import() calls, workers, and other resources resolve against the
  // proxy domain instead of through /_midas/ → React page bundle 404 → white
  // screen.
  //
  // Correct approach: always navigate to /_midas/BROWSE?url=<full-target-url>
  // for path/search changes. The location virtualiser already gives React Router
  // the right location.pathname after the reload. Hash-only changes stay
  // client-side (no reload needed).

  var origPush    = history.pushState.bind(history);
  var origReplace = history.replaceState.bind(history);

  // Scheduled full-proxy navigation URL (set by _handleSpaNav, consumed by the
  // pushState/replaceState wrappers after calling origPush/origReplace).
  var _pendingNavUrl = null;

  function _handleSpaNav(url) {
    if (!url) return url;
    try {
      var base = BASE_URL || '';
      try { if (!base && _origHrefGet) base = _origHrefGet.call(location); } catch(e3) {}
      if (!base) return toProxy(url);

      var baseOrigin = new URL(base).origin;
      var abs        = new URL(String(url), base).href;
      var absOrigin  = new URL(abs).origin;

      if (absOrigin === baseOrigin && abs.indexOf('/_midas/') === -1) {
        var baseParsed = new URL(base);
        var absParsed  = new URL(abs);
        var pathChanged = baseParsed.pathname !== absParsed.pathname ||
                          baseParsed.search   !== absParsed.search;

        BASE_URL = abs;

        if (pathChanged) {
          // Path/search changed → schedule a full proxy navigation so all
          // resource loads stay routed through /_midas/.
          _pendingNavUrl = PROXY_BASE + '?url=' + encodeURIComponent(abs);
        }
        // Return the original url for the pushState call (the navigation below
        // will supersede it, but we still want history to be consistent).
        return url;
      }
    } catch (e2) {}
    return toProxy(url);
  }

  history.pushState = _markNative(function pushState(state, title, url) {
    if (url !== undefined && url !== null) url = _handleSpaNav(url);
    var nav = _pendingNavUrl;
    _pendingNavUrl = null;
    try { origPush(state, title, url); } catch(e2) {}
    if (nav) {
      try {
        if (_origHrefSet) { _origHrefSet.call(location, nav); }
        else { location.assign(nav); }
      } catch(e2) {}
    }
  });
  history.replaceState = _markNative(function replaceState(state, title, url) {
    if (url !== undefined && url !== null) url = _handleSpaNav(url);
    var nav = _pendingNavUrl;
    _pendingNavUrl = null;
    try { origReplace(state, title, url); } catch(e2) {}
    if (nav) {
      try {
        if (_origHrefSet) { _origHrefSet.call(location, nav); }
        else { location.assign(nav); }
      } catch(e2) {}
    }
  });

  // Re-sync BASE_URL when the user navigates back/forward through SPA history.
  window.addEventListener('popstate', function () {
    try {
      var realHref = (_origHrefGet ? _origHrefGet.call(location) : null) || '';
      if (!realHref) return;
      var realUrl  = new URL(realHref);
      var realPath = realUrl.pathname + realUrl.search;
      if (realPath.indexOf('/_midas/') === 0) {
        var p = realUrl.searchParams.get('url');
        if (p) BASE_URL = p;
      } else if (BASE_URL) {
        var bOrigin = new URL(BASE_URL).origin;
        BASE_URL = new URL(realPath || '/', bOrigin).href;
      }
    } catch (e) {}
  });

  // ── window.open ───────────────────────────────────────────────────────────

  var _origOpen = window.open;
  window.open = function (url, target, features) {
    if (url) url = toProxy(url);
    return _origOpen.call(window, url, target, features);
  };

  // ── location.assign / replace ─────────────────────────────────────────────

  try {
    var origAssign = location.assign.bind(location);
    location.assign = function (url) { return origAssign(toProxy(url)); };
  } catch (e) {}
  try {
    var origReplaceLoc = location.replace.bind(location);
    location.replace = function (url) { return origReplaceLoc(toProxy(url)); };
  } catch (e) {}

  // ── location.href setter interception ─────────────────────────────────────
  // Intercepts `location.href = url` and `document.location.href = url`.
  // NOTE: setting location.href does NOT call location.assign() internally in
  // browser engines, so overriding assign() alone is not enough.
  try {
    var _locProto = Object.getPrototypeOf(location);
    var _hrefDesc = Object.getOwnPropertyDescriptor(_locProto, 'href');
    if (_hrefDesc && _hrefDesc.set) {
      var _origHrefSet = _hrefDesc.set;
      var _origHrefGet = _hrefDesc.get;
      Object.defineProperty(_locProto, 'href', {
        get: function () {
          // Return the target-site URL so SPAs see the right full URL.
          if (BASE_URL) return BASE_URL;
          return _origHrefGet.call(this);
        },
        set: function (url) {
          try { url = toProxy(String(url)); } catch (e2) {}
          _origHrefSet.call(this, url);
        },
        configurable: true,
      });
    }
  } catch (e) {}

  // ── window.location setter interception ───────────────────────────────────
  // Intercepts `window.location = url` (same effect as location.href = url).
  try {
    var _origLocationObj = window.location;
    var _safeAssign = (typeof origAssign === 'function') ? origAssign : location.assign.bind(location);
    Object.defineProperty(window, 'location', {
      get: function () { return _origLocationObj; },
      set: function (url) {
        try { url = toProxy(String(url)); } catch (e2) {}
        _safeAssign(url);
      },
      configurable: true,
    });
  } catch (e) {}

  // ── document.URL / document.documentURI virtualiser ─────────────────────
  // Some libraries (including socket.io 4.x) read document.URL or
  // document.documentURI instead of location.href to determine the base
  // origin. We override both to return BASE_URL (the target-site URL).
  try {
    var _docProto = Object.getPrototypeOf(document) || Document.prototype;
    ['URL', 'documentURI'].forEach(function (prop) {
      var _desc = Object.getOwnPropertyDescriptor(_docProto, prop) ||
                  Object.getOwnPropertyDescriptor(Document.prototype, prop);
      if (!_desc || !_desc.get) return;
      var _realGet = _desc.get;
      Object.defineProperty(_docProto, prop, {
        get: function () {
          if (BASE_URL) return BASE_URL;
          return _realGet.call(this);
        },
        configurable: true,
      });
    });
  } catch (e) {}

  // ── location property virtualiser ────────────────────────────────────────
  // When the proxy serves a page at /_midas/BROWSE?url=https://site.com/app/chat
  // the SPA reads location.pathname as '/_midas/BROWSE' and can't route.
  // We override pathname/search/hostname/host/origin/protocol/port on
  // Location.prototype to return target-site values derived from BASE_URL.
  // pathname and search setters are also intercepted so that:
  //   location.pathname = '/app/chat'  →  full proxy navigation
  //   location.search   = '?q=hello'  →  full proxy navigation
  // The href getter was already updated above; the setters still proxy correctly.
  try {
    var _lvProto = Object.getPrototypeOf(location);
    var _lvProps = ['pathname', 'search', 'hash', 'hostname', 'host', 'port', 'protocol', 'origin'];
    for (var _lvi = 0; _lvi < _lvProps.length; _lvi++) {
      (function (prop) {
        var desc = Object.getOwnPropertyDescriptor(_lvProto, prop);
        if (!desc || !desc.get) return;
        var _realGet = desc.get;
        var _realSet = desc.set || null;

        var _navSetter = (prop === 'pathname' || prop === 'search') ? function (val) {
          try {
            var base = new URL(BASE_URL || (_origHrefGet ? _origHrefGet.call(location) : ''));
            if (prop === 'pathname') { base.pathname = String(val); }
            else { base.search = String(val); }
            var _nav = PROXY_BASE + '?url=' + encodeURIComponent(base.href);
            if (_origHrefSet) { _origHrefSet.call(location, _nav); }
            else if (typeof origAssign === 'function') { origAssign(_nav); }
            else { location.assign(_nav); }
          } catch (e2) {
            if (_realSet) { try { _realSet.call(this, val); } catch (e3) {} }
          }
        } : _realSet;

        Object.defineProperty(_lvProto, prop, {
          get: function () {
            if (BASE_URL) {
              try {
                var t = new URL(BASE_URL);
                if (t[prop] !== undefined) return t[prop];
              } catch (e2) {}
            }
            return _realGet.call(this);
          },
          set: _navSetter || undefined,
          configurable: true,
        });
      })(_lvProps[_lvi]);
    }
  } catch (e) {}

  // ── fetch() interception ──────────────────────────────────────────────────
  // Mirrors what Scramjet/Ultraviolet do:
  //  • Rewrite the URL of any external request through the proxy
  //  • Rebuild Request objects so the proxied URL is used
  //  • Strip 'no-cors' mode → 'cors' (our proxy always returns CORS headers)
  //  • Strip credentials:'include' → 'omit' (server-side cookie jar handles auth)
  //  • Skip blob: and data: URLs — they are local and must not be proxied

  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url, isRequest = false;
      if (input instanceof Request) {
        url = input.url; isRequest = true;
      } else if (input instanceof URL) {
        url = input.href;
      } else if (typeof input === 'string') {
        url = input;
      }

      // Never proxy blob: or data: — they are local object URLs
      if (url && /^(blob:|data:)/i.test(url)) {
        return _origFetch.call(window, input, init);
      }

      if (url && shouldProxy(url)) {
        var proxied = toProxy(url);

        // Sanitise init options so they work from the proxy origin
        var safeInit = {};
        if (init) {
          for (var k in init) {
            if (Object.prototype.hasOwnProperty.call(init, k)) safeInit[k] = init[k];
          }
        }
        // 'no-cors' prevents reading the response — switch to 'cors' since
        // our proxy always responds with Access-Control-Allow-Origin: *
        if (safeInit.mode === 'no-cors') safeInit.mode = 'cors';
        // 'include' sends browser cookies to the proxy origin, which is wrong;
        // the server-side jar already attaches the right cookies upstream
        if (safeInit.credentials === 'include') safeInit.credentials = 'same-origin';

        if (isRequest) {
          // Rebuild the Request with the proxied URL, preserving method/body/headers
          try {
            var reqInit = {
              method: input.method,
              headers: input.headers,
              body: ['GET','HEAD'].indexOf(input.method) === -1 ? input.body : undefined,
              mode: safeInit.mode || (input.mode === 'no-cors' ? 'cors' : input.mode),
              credentials: safeInit.credentials || (input.credentials === 'include' ? 'same-origin' : input.credentials),
              cache: input.cache,
              redirect: input.redirect,
              referrer: input.referrer,
              integrity: input.integrity,
            };
            return _origFetch.call(window, new Request(proxied, reqInit), safeInit.signal !== undefined ? { signal: safeInit.signal } : undefined);
          } catch (re) {
            return _origFetch.call(window, proxied, safeInit);
          }
        }
        return _origFetch.call(window, proxied, safeInit);
      }
    } catch (e) {}
    return _origFetch.call(window, input, init);
  };
  _markNative(window.fetch);

  // ── XMLHttpRequest interception ───────────────────────────────────────────

  var _origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    try {
      if (url && shouldProxy(url)) {
        url = toProxy(url);
      }
    } catch (e) {}
    return _origXHROpen.apply(this, arguments.length > 2
      ? [method, url, async, user, password]
      : [method, url]);
  };
  _markNative(XMLHttpRequest.prototype.open);

  // ── navigator.sendBeacon interception ─────────────────────────────────────

  if (navigator.sendBeacon) {
    var _origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        if (url && shouldProxy(url)) url = toProxy(url);
      } catch (e) {}
      return _origBeacon(url, data);
    };
    _markNative(navigator.sendBeacon);
  }

  // ── WebSocket interception ────────────────────────────────────────────────

  var _OrigWebSocket = window.WebSocket;
  function MidasWebSocket(url, protocols) {
    try {
      if (typeof url === 'string' && /^wss?:\/\//i.test(url)) {
        // Convert ws(s):// → http(s):// to run through shouldProxy / toProxy
        var httpUrl = url.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
        if (shouldProxy(httpUrl)) {
          var proxied = toProxy(httpUrl);
          // proxied is a relative path like /_midas/BROWSE?url=...
          // Build an absolute wss:// URL pointing at the REAL proxy host so the
          // browser's WebSocket upgrade hits the proxy server (not vortexos.net).
          var wsScheme = /^wss:\/\//i.test(url) ? 'wss:' : 'ws:';
          var realHost = new URL(_REAL_ORIGIN).host;
          url = wsScheme + '//' + realHost + proxied;
        }
      }
    } catch (e) {}
    if (protocols !== undefined) {
      return new _OrigWebSocket(url, protocols);
    }
    return new _OrigWebSocket(url);
  }
  MidasWebSocket.prototype = _OrigWebSocket.prototype;
  MidasWebSocket.CONNECTING = _OrigWebSocket.CONNECTING;
  MidasWebSocket.OPEN = _OrigWebSocket.OPEN;
  MidasWebSocket.CLOSING = _OrigWebSocket.CLOSING;
  MidasWebSocket.CLOSED = _OrigWebSocket.CLOSED;
  // Mark so midas.client.js knows the native WS hook is already installed
  // and skips replacing it with the HTTP-bridge version.
  MidasWebSocket._midasNative = true;
  try {
    window.WebSocket = MidasWebSocket;
    _markNative(MidasWebSocket);
  } catch (e) {}

  // ── EventSource interception ──────────────────────────────────────────────

  if (window.EventSource) {
    var _OrigEventSource = window.EventSource;
    function MidasEventSource(url, init) {
      try {
        if (url && shouldProxy(url)) url = toProxy(url);
      } catch (e) {}
      return init !== undefined ? new _OrigEventSource(url, init) : new _OrigEventSource(url);
    }
    MidasEventSource.prototype = _OrigEventSource.prototype;
    try { window.EventSource = MidasEventSource; _markNative(MidasEventSource); } catch (e) {}
  }

  // ── document.createElement interception ──────────────────────────────────
  // Belt-and-suspenders: the prototype-level interceptors above are the primary
  // defense; this catches any remaining cases where src is set via setAttribute.

  var _origCreateElement = document.createElement.bind(document);
  document.createElement = _markNative(function createElement(tag) {
    var el = _origCreateElement(tag);
    var tagLower = (tag || '').toLowerCase();
    if (tagLower === 'script' || tagLower === 'link' || tagLower === 'img' || tagLower === 'iframe' || tagLower === 'video' || tagLower === 'audio') {
      var _origSetAttr = el.setAttribute.bind(el);
      el.setAttribute = function (name, val) {
        if ((name === 'src' || name === 'href') && val && shouldProxy(val)) {
          val = toProxy(val);
        }
        return _origSetAttr(name, val);
      };
    }
    return el;
  });

  // ── Service Worker blocking ───────────────────────────────────────────────
  // Prevent sites from registering a SW at the proxy origin — it would intercept
  // our own proxy requests and break navigation. We block register() entirely.
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', {
        get: function () {
          return {
            register: function () { return Promise.reject(new Error('SW blocked by proxy')); },
            getRegistrations: function () { return Promise.resolve([]); },
            ready: new Promise(function () {}),
            controller: null,
            addEventListener: function () {},
            removeEventListener: function () {},
          };
        },
        configurable: true,
      });
    }
  } catch (e) {
    try {
      navigator.serviceWorker.register = function () {
        return Promise.reject(new Error('SW blocked by proxy'));
      };
    } catch (e2) {}
  }

  // Deregister any already-registered service workers from previous sessions
  try {
    if (window.navigator && window.navigator.serviceWorker && window.navigator.serviceWorker.getRegistrations) {
      window.navigator.serviceWorker.getRegistrations().then(function (regs) {
        for (var i = 0; i < regs.length; i++) regs[i].unregister();
      }).catch(function () {});
    }
  } catch (e) {}

  // ── Worker / SharedWorker URL proxying ────────────────────────────────────

  try {
    var _OrigWorker = window.Worker;
    window.Worker = function (scriptURL, options) {
      try { if (scriptURL && shouldProxy(scriptURL)) scriptURL = toProxy(scriptURL); } catch (e) {}
      return options !== undefined ? new _OrigWorker(scriptURL, options) : new _OrigWorker(scriptURL);
    };
    window.Worker.prototype = _OrigWorker.prototype;
  } catch (e) {}

  try {
    if (window.SharedWorker) {
      var _OrigSharedWorker = window.SharedWorker;
      window.SharedWorker = function (scriptURL, options) {
        try { if (scriptURL && shouldProxy(scriptURL)) scriptURL = toProxy(scriptURL); } catch (e) {}
        return options !== undefined ? new _OrigSharedWorker(scriptURL, options) : new _OrigSharedWorker(scriptURL);
      };
      window.SharedWorker.prototype = _OrigSharedWorker.prototype;
    }
  } catch (e) {}

  // ── innerHTML / insertAdjacentHTML interception ───────────────────────────
  // When sites inject HTML dynamically the server-side rewriter can't touch it.
  // After the set, run patchNode on the changed subtree to fix URLs.

  try {
    var _innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (_innerHTMLDesc && _innerHTMLDesc.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        get: _innerHTMLDesc.get,
        set: function (v) {
          _innerHTMLDesc.set.call(this, v);
          try { patchNode(this); } catch (e) {}
        },
        configurable: true,
      });
    }
  } catch (e) {}

  try {
    var _origInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (position, html) {
      _origInsertAdjacentHTML.call(this, position, html);
      try { patchNode(this); } catch (e) {}
    };
  } catch (e) {}

  try {
    var _outerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    if (_outerHTMLDesc && _outerHTMLDesc.set) {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        get: _outerHTMLDesc.get,
        set: function (v) {
          _outerHTMLDesc.set.call(this, v);
          try { if (this.parentNode) patchNode(this.parentNode); } catch (e) {}
        },
        configurable: true,
      });
    }
  } catch (e) {}

  // ── document.write interception ───────────────────────────────────────────

  try {
    var _origDocWrite = document.write.bind(document);
    document.write = function (markup) {
      return _origDocWrite(markup);
    };
  } catch (e) {}

  // ── document.domain no-op ─────────────────────────────────────────────────
  // Some sites set document.domain for same-origin relaxation; ignore safely.
  try {
    Object.defineProperty(document, 'domain', {
      get: function () {
        try { return new URL(BASE_URL || location.href).hostname; } catch (e) { return location.hostname; }
      },
      set: function () {},
      configurable: true,
    });
  } catch (e) {}

  // ── import() dynamic interception ─────────────────────────────────────────
  // Note: true dynamic import() cannot be overridden at runtime without a SW.
  // The server-side JS rewriter handles static import("...") patterns.

})();
