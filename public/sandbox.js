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
    if (!url || typeof url !== 'string') return url;
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

  function isAbsolute(url) {
    return /^https?:\/\//i.test(url);
  }

  function shouldProxy(url) {
    if (!url || typeof url !== 'string') return false;
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
        // We'll use the HTTP polling bridge instead by connecting to the proxied HTTP URL
        // as a WebSocket through the server's ws-bridge
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

  var _origCreateElement = document.createElement.bind(document);
  document.createElement = function (tag) {
    var el = _origCreateElement(tag);
    var tagLower = (tag || '').toLowerCase();
    if (tagLower === 'script') {
      // Intercept src assignment via Object.defineProperty
      var _scriptSrc = '';
      try {
        Object.defineProperty(el, 'src', {
          get: function () { return _scriptSrc; },
          set: function (v) {
            _scriptSrc = v;
            if (v && shouldProxy(v)) {
              Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src') ||
              Object.getOwnPropertyDescriptor(Element.prototype, 'src');
              el.setAttribute('src', toProxy(v));
            } else {
              el.setAttribute('src', v);
            }
          },
          configurable: true,
        });
      } catch (e) {}
    }
    if (tagLower === 'link') {
      var _linkHref = '';
      try {
        Object.defineProperty(el, 'href', {
          get: function () { return _linkHref; },
          set: function (v) {
            _linkHref = v;
            if (v && shouldProxy(v)) {
              el.setAttribute('href', toProxy(v));
            } else {
              el.setAttribute('href', v);
            }
          },
          configurable: true,
        });
      } catch (e) {}
    }
    if (tagLower === 'img' || tagLower === 'iframe' || tagLower === 'video' || tagLower === 'audio') {
      var _mediaSrc = '';
      try {
        Object.defineProperty(el, 'src', {
          get: function () { return _mediaSrc; },
          set: function (v) {
            _mediaSrc = v;
            if (v && shouldProxy(v)) {
              el.setAttribute('src', toProxy(v));
            } else {
              el.setAttribute('src', v);
            }
          },
          configurable: true,
        });
      } catch (e) {}
    }
    return el;
  };

  // ── import() dynamic interception ─────────────────────────────────────────
  // Note: true dynamic import() cannot be overridden at runtime without a SW.
  // The server-side JS rewriter handles static import("...") patterns.

})();
