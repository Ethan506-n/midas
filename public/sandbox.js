/**
 * Midas Navigation Hook - Safe hybrid approach
 * Uses injected data-base attribute to resolve relative URLs correctly.
 */
(function() {
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

  function toProxy(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.indexOf('data:') === 0 || url.indexOf('blob:') === 0 || url.indexOf('javascript:') === 0) return url;
    if (url.indexOf('/_midas/') !== -1) return url;
    if (url.charAt(0) === '#') return url;
    try {
      var abs = new URL(url, BASE_URL || location.href).href;
      return PROXY_BASE + '?url=' + encodeURIComponent(abs);
    } catch (e) { return url; }
  }

  // Patch an anchor element
  function patchAnchor(a) {
    if (a.__midas_patched) return;
    var href = a.getAttribute('href');
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    if (href.indexOf('/_midas/') !== -1) return;
    a.setAttribute('data-midas-orig', href);
    a.setAttribute('href', toProxy(href));
    a.__midas_patched = true;
  }

  // Patch a form element
  function patchForm(f) {
    if (f.__midas_patched) return;
    var action = f.getAttribute('action');
    if (action) {
      f.setAttribute('data-midas-orig-action', action);
      f.setAttribute('action', toProxy(action));
    }
    f.__midas_patched = true;
  }

  // Recursively patch anchors and forms inside a node
  function patchNode(node) {
    if (node.tagName === 'A') patchAnchor(node);
    if (node.tagName === 'FORM') patchForm(node);
    if (node.querySelectorAll) {
      var anchors = node.querySelectorAll('a:not([__midas_patched])');
      for (var i = 0; i < anchors.length; i++) patchAnchor(anchors[i]);
      var forms = node.querySelectorAll('form:not([__midas_patched])');
      for (var i = 0; i < forms.length; i++) patchForm(forms[i]);
    }
  }

  // Patch existing content immediately
  patchNode(document.documentElement || document.body);

  // Light observer for dynamically added content
  var observer = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].nodeType === 1) patchNode(nodes[j]);
      }
    }
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      patchNode(document.documentElement || document.body);
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // --- CLICK INTERCEPTION (fallback for unpatchable links) ---
  document.addEventListener('click', function(e) {
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

  // --- FORM SUBMIT INTERCEPTION ---
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (form.tagName !== 'FORM') return;
    var action = form.getAttribute('action');
    if (action) form.setAttribute('action', toProxy(action));
  }, true);

  // --- HISTORY INTERCEPTION ---
  var origPush = history.pushState.bind(history);
  var origReplace = history.replaceState.bind(history);
  history.pushState = function(state, title, url) {
    if (url) url = toProxy(url);
    return origPush(state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url) url = toProxy(url);
    return origReplace(state, title, url);
  };

  // --- WINDOW.OPEN INTERCEPTION ---
  var origOpen = window.open;
  window.open = function(url, target, features) {
    if (url) url = toProxy(url);
    return origOpen(url, target, features);
  };

  // --- ASSIGN / REPLACE INTERCEPTION ---
  try {
    var origAssign = location.assign.bind(location);
    location.assign = function(url) { return origAssign(toProxy(url)); };
  } catch (e) {}
  try {
    var origReplaceLoc = location.replace.bind(location);
    location.replace = function(url) { return origReplaceLoc(toProxy(url)); };
  } catch (e) {}

})();

