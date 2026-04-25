/**
 * Iframe Sandbox Engine
 * Provides complete page isolation via sandboxed iframes.
 * Enables two-way proxy communication between parent and sandbox.
 */
let activeSandbox = null;
let messageHandler = null;
export function createSandbox(cfg) {
    destroySandbox();
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;border:none;z-index:999999;';
    iframe.sandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads';
    iframe.referrerPolicy = 'no-referrer';
    // Build a bootstrap HTML that loads our proxy inside the iframe
    const bootstrapHtml = buildBootstrapHtml(cfg);
    const blob = new Blob([bootstrapHtml], { type: 'text/html' });
    iframe.src = URL.createObjectURL(blob);
    document.body.appendChild(iframe);
    activeSandbox = iframe;
    // Listen for messages from the sandbox
    messageHandler = (e) => {
        if (e.source !== iframe.contentWindow)
            return;
        handleSandboxMessage(e.data, cfg);
    };
    window.addEventListener('message', messageHandler);
    return iframe;
}
export function destroySandbox() {
    if (messageHandler) {
        window.removeEventListener('message', messageHandler);
        messageHandler = null;
    }
    if (activeSandbox) {
        activeSandbox.remove();
        activeSandbox = null;
    }
}
function buildBootstrapHtml(cfg) {
    const proxyBase = cfg.proxyBase;
    const targetUrl = cfg.targetUrl;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${escapeHtml(targetUrl)}">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; overflow:auto; }
</style>
<script>
(function(){
  const PROXY_BASE = '${proxyBase}';
  const TARGET_URL = '${targetUrl}';

  // Notify parent we're ready
  parent.postMessage({ type: 'sandbox-ready', url: TARGET_URL }, '*');

  // Proxy all fetches through parent
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(PROXY_BASE) || url.startsWith('blob:') || url.startsWith('data:')) {
      return origFetch(input, init);
    }
    return origFetch(PROXY_BASE + '/_midas/proxy?url=' + encodeURIComponent(url), init);
  };

  // Proxy XMLHttpRequest
  const OrigXHR = window.XMLHttpRequest;
  function ProxyXHR() {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function(method, url, async, user, password) {
      if (typeof url === 'string' && !url.startsWith(PROXY_BASE) && !url.startsWith('data:')) {
        url = PROXY_BASE + '/_midas/proxy?url=' + encodeURIComponent(url);
      }
      return origOpen(method, url, async, user, password);
    };
    return xhr;
  }
  ProxyXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = ProxyXHR;

  // Notify parent on navigation attempts
  window.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (a && a.href && !a.href.startsWith('#') && !a.href.startsWith('javascript:')) {
      e.preventDefault();
      parent.postMessage({ type: 'sandbox-navigate', url: a.href }, '*');
    }
  });

  // Notify parent on form submissions
  window.addEventListener('submit', function(e) {
    const form = e.target.closest('form');
    if (form) {
      e.preventDefault();
      parent.postMessage({ type: 'sandbox-form', action: form.action, method: form.method }, '*');
    }
  });

  // Load target content
  fetch(PROXY_BASE + '/_midas/browse?url=' + encodeURIComponent(TARGET_URL))
    .then(r => r.text())
    .then(html => { document.open(); document.write(html); document.close(); })
    .catch(e => { document.body.innerHTML = '<h1>Failed to load</h1>'; });
})();
</script>
</head>
<body></body>
</html>`;
}
function handleSandboxMessage(data, cfg) {
    if (!data || typeof data !== 'object')
        return;
    switch (data.type) {
        case 'sandbox-ready':
            if (cfg.onNavigate)
                cfg.onNavigate(data.url);
            break;
        case 'sandbox-navigate':
            if (cfg.onNavigate)
                cfg.onNavigate(data.url);
            break;
        case 'sandbox-form':
            // Form submission handling could be added here
            break;
    }
}
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, '&#39;');
}
export function isSandboxActive() {
    return !!activeSandbox;
}
export function getSandboxFrame() {
    return activeSandbox;
}
