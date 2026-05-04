/**
 * Midas Navigation & API Hook
 * Intercepts navigation, fetch, XHR, WebSocket, EventSource, and DOM mutations.
 */
(function () {
  'use strict';
  if (window.__midas_hook) return;
  window.__midas_hook = true;

  // Detect proxy base from current URL path
  var m = location.pathname.match(/^(\/_midas\/[^\/]+)/);
  var PROXY_BASE = m ? m[1] : '';

  // Read the target base URL from the script tag's data-base attribute
  var BASE_URL = '';
  try {
    var scripts = document.querySelectorAll('script[data-base]');
    for (var i = 0; i < scripts.length; i++) {
      BASE_URL = scripts[i].getAttribute('data-base') || '';
      if (BASE_URL) break;
    }
  } catch (e) {}

  // ── helpers ──────────────────────────────────────────────────────────────

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
      // Don't proxy same-origin /_midas/ paths
      var parsed = new URL(abs);
      if (parsed.origin === location.origin && parsed.pathname.indexOf('/_midas/') === 0) return url;
      // Don't proxy same-origin non-proxy paths (static assets served by the proxy server itself)
      if (parsed.origin === location.origin && parsed.pathname.indexOf('/_midas/') === -1) return url;
      return PROXY_BASE + '?url=' + encodeURIComponent(abs);
    } catch (e) { return url; }
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
    // Proxy absolute external URLs and relative URLs that resolve to external
    try {
      var base = BASE_URL || location.href;
      var abs = new URL(url, base).href;
      var parsed = new URL(abs);
      // If same-origin as the proxy server, let it pass through
      if (parsed.origin === location.origin) return false;
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
          if (url && shouldProxy(url)) url = toProxy(url);
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
          if (url && shouldProxy(url)) url = toProxy(url);
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
          if (url && shouldProxy(url)) url = toProxy(url);
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
    a.setAttribute('data-midas-orig', href);
    a.setAttribute('href', toProxy(href));
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
        if (shouldProxy(scriptSrc)) node.setAttribute('src', toProxy(scriptSrc));
      }
    }
    // Patch LINK href (stylesheets, preloads, modulepreloads)
    if (node.tagName === 'LINK') {
      var linkHref = node.getAttribute('href');
      if (linkHref && linkHref.indexOf('/_midas/') === -1 && linkHref.indexOf('data:') !== 0) {
        if (shouldProxy(linkHref)) node.setAttribute('href', toProxy(linkHref));
      }
    }
    if (node.tagName === 'IMG' || node.tagName === 'VIDEO' || node.tagName === 'AUDIO' || node.tagName === 'SOURCE') {
      var src = node.getAttribute('src');
      if (src && src.indexOf('/_midas/') === -1 && src.indexOf('data:') !== 0 && src.indexOf('blob:') !== 0) {
        node.setAttribute('src', toProxy(src));
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
    if (href.indexOf('/_midas/') !== -1) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.href = toProxy(href);
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

  var origPush = history.pushState.bind(history);
  var origReplace = history.replaceState.bind(history);
  history.pushState = function (state, title, url) {
    if (url) url = toProxy(url);
    return origPush(state, title, url);
  };
  history.replaceState = function (state, title, url) {
    if (url) url = toProxy(url);
    return origReplace(state, title, url);
  };

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

  // ── fetch() interception ──────────────────────────────────────────────────

  var _origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url;
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input === 'object' && input.url) {
        url = input.url;
      } else if (input instanceof URL) {
        url = input.href;
      }
      if (url && shouldProxy(url)) {
        var proxied = toProxy(url);
        if (typeof input === 'string') {
          input = proxied;
        } else if (input instanceof Request) {
          input = new Request(proxied, input);
        } else if (input && typeof input.url !== 'undefined') {
          input = proxied;
        }
      }
    } catch (e) {}
    return _origFetch.call(window, input, init);
  };

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

  // ── navigator.sendBeacon interception ─────────────────────────────────────

  if (navigator.sendBeacon) {
    var _origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        if (url && shouldProxy(url)) url = toProxy(url);
      } catch (e) {}
      return _origBeacon(url, data);
    };
  }

  // ── WebSocket interception ────────────────────────────────────────────────

  var _OrigWebSocket = window.WebSocket;
  function MidasWebSocket(url, protocols) {
    try {
      // Convert ws:// or wss:// to http:// or https:// for proxy
      var httpUrl = url.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
      if (shouldProxy(httpUrl)) {
        var proxied = toProxy(httpUrl);
        // Convert back to ws:// via the proxy path (handled by ws-bridge on server)
        url = proxied.replace(/^https?:/, location.protocol).replace(location.host, location.host);
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
  try {
    window.WebSocket = MidasWebSocket;
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
    try { window.EventSource = MidasEventSource; } catch (e) {}
  }

  // ── document.createElement interception ──────────────────────────────────
  // Belt-and-suspenders: the prototype-level interceptors above are the primary
  // defense; this catches any remaining cases where src is set via setAttribute.

  var _origCreateElement = document.createElement.bind(document);
  document.createElement = function (tag) {
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
  };

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
