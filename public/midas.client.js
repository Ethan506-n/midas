(function(){
const __MIDAS_NONCE__='876904a8a0b49c56';

/* module: core/encoder.js */
/**
 * Binary encoder/decoder to avoid base64/JSON fingerprints.
 * Uses a lightweight custom binary protocol.
 */
const HEADER_SIZE = 4;
function encodeRequest(data) {
    const urlBytes = new TextEncoder().encode(data.url);
    const methodBytes = new TextEncoder().encode(data.method);
    const headersStr = JSON.stringify(data.headers);
    const headersBytes = new TextEncoder().encode(headersStr);
    const bodyBytes = data.body ? new TextEncoder().encode(data.body) : new Uint8Array(0);
    const total = HEADER_SIZE + urlBytes.length + methodBytes.length + headersBytes.length + bodyBytes.length + 16;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let off = 0;
    view.setUint32(off, urlBytes.length, true);
    off += 4;
    bytes.set(urlBytes, off);
    off += urlBytes.length;
    view.setUint32(off, methodBytes.length, true);
    off += 4;
    bytes.set(methodBytes, off);
    off += methodBytes.length;
    view.setUint32(off, headersBytes.length, true);
    off += 4;
    bytes.set(headersBytes, off);
    off += headersBytes.length;
    view.setUint32(off, bodyBytes.length, true);
    off += 4;
    bytes.set(bodyBytes, off);
    off += bodyBytes.length;
    return buf.slice(0, off);
}
function decodeResponse(buf) {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let off = 0;
    const status = view.getUint16(off, true);
    off += 2;
    const hLen = view.getUint32(off, true);
    off += 4;
    const hStr = new TextDecoder().decode(bytes.subarray(off, off + hLen));
    off += hLen;
    const headers = JSON.parse(hStr);
    const bLen = view.getUint32(off, true);
    off += 4;
    const body = bytes.subarray(off, off + bLen);
    return { status, headers, body };
}
function encodeChunk(data, seq, final) {
    const buf = new ArrayBuffer(5 + data.length);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    view.setUint32(0, seq, true);
    bytes[4] = final ? 1 : 0;
    bytes.set(data, 5);
    return buf;
}
function decodeChunk(buf) {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const seq = view.getUint32(0, true);
    const final = bytes[4] === 1;
    return { seq, final, data: bytes.subarray(5) };
}


/* module: core/crypto.js */
/**
 * Crypto module with WebAssembly-ready architecture.
 * Current implementation uses fast JS fallback; WASM can be swapped in
 * by providing a .wasm file and updating loadCryptoModule().
 */
let moduleInstance = null;
let sessionKey = null;
function getRandomBytes(len) {
    return crypto.getRandomValues(new Uint8Array(len));
}
function xorBytes(a, b) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++)
        out[i] = a[i] ^ b[i % b.length];
    return out;
}
function sha256Like(data) {
    // SubtleCrypto digest is async; we provide a sync-looking wrapper
    // In practice we precompute or use WASM. This is a fast fallback.
    return data;
}
const JsCryptoFallback = {
    encrypt(_key, nonce, data) {
        const key = _key.length ? _key : new Uint8Array(32).fill(0xab);
        const x = xorBytes(data, key);
        const out = new Uint8Array(nonce.length + x.length);
        out.set(nonce, 0);
        out.set(x, nonce.length);
        return out;
    },
    decrypt(_key, nonce, data) {
        const key = _key.length ? _key : new Uint8Array(32).fill(0xab);
        const x = data.subarray(nonce.length);
        return xorBytes(x, key);
    }
};
async function loadCryptoModule() {
    if (moduleInstance)
        return moduleInstance;
    try {
        const wasmUrl = '/midas.crypto.wasm';
        const resp = await fetch(wasmUrl, { cache: 'no-store' });
        if (resp.ok) {
            const wasmBin = await resp.arrayBuffer();
            const wasmMod = await WebAssembly.instantiate(wasmBin, {
                env: {
                    memory: new WebAssembly.Memory({ initial: 256, maximum: 512 }),
                    __assert_fail: () => { },
                }
            });
            const exports = wasmMod.instance.exports;
            moduleInstance = {
                encrypt(k, n, d) {
                    const mem = exports.memory;
                    const ptr = exports.malloc(d.length + 64);
                    const view = new Uint8Array(mem.buffer);
                    view.set(k, ptr);
                    view.set(n, ptr + 32);
                    view.set(d, ptr + 64);
                    exports.encrypt(ptr, ptr + 32, ptr + 64, d.length, ptr + 64 + d.length);
                    const out = view.slice(ptr + 64 + d.length, ptr + 64 + d.length + d.length + 16);
                    exports.free(ptr);
                    return out;
                },
                decrypt(k, n, d) {
                    const mem = exports.memory;
                    const ptr = exports.malloc(d.length + 64);
                    const view = new Uint8Array(mem.buffer);
                    view.set(k, ptr);
                    view.set(n, ptr + 32);
                    view.set(d, ptr + 64);
                    exports.decrypt(ptr, ptr + 32, ptr + 64, d.length, ptr + 64 + d.length);
                    const outLen = exports.get_decrypted_len(ptr + 64 + d.length);
                    const out = view.slice(ptr + 64 + d.length, ptr + 64 + d.length + outLen);
                    exports.free(ptr);
                    return out;
                }
            };
            return moduleInstance;
        }
    }
    catch (e) {
        // WASM not available, use JS fallback
    }
    moduleInstance = JsCryptoFallback;
    return moduleInstance;
}
function initSession(key) {
    sessionKey = key || getRandomBytes(32);
}
function getSessionKey() {
    if (!sessionKey)
        initSession();
    return sessionKey;
}
async function encryptData(data) {
    const mod = await loadCryptoModule();
    const nonce = getRandomBytes(12);
    return mod.encrypt(getSessionKey(), nonce, data);
}
async function decryptData(data) {
    const mod = await loadCryptoModule();
    const nonce = data.subarray(0, 12);
    return mod.decrypt(getSessionKey(), nonce, data);
}


/* module: core/transport.js */
/**
 * Transport layer with multiple strategies.
 * Prioritizes SSE and chunked fetch to avoid WebSocket tunnel signatures.
 */
let currentTransport = null;
class BaseTransport {
    baseUrl;
    sessionId;
    constructor(cfg) {
        this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
        this.sessionId = cfg.sessionId;
    }
    endpoint(path) {
        return `${this.baseUrl}${path}`;
    }
}
class ChunkedTransport extends BaseTransport {
    async fetch(req) {
        const payload = JSON.stringify({
            url: req.url,
            method: req.method || 'GET',
            headers: req.headers || {},
            body: req.body && typeof req.body === 'string' ? req.body : undefined,
            sid: this.sessionId,
        });
        const resp = await fetch(this.endpoint('/_midas/chunk'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-midas-sid': this.sessionId,
            },
            body: payload,
            credentials: 'same-origin',
        });
        const reader = resp.body?.getReader();
        const chunks = [];
        if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                chunks.push(value);
            }
        }
        const totalLen = chunks.reduce((a, b) => a + b.length, 0);
        const combined = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
            combined.set(c, off);
            off += c.length;
        }
        return {
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            body: combined.buffer,
        };
    }
    supportsStreaming() { return true; }
}
class SseTransport extends BaseTransport {
    async fetch(req) {
        const payload = JSON.stringify({
            url: req.url,
            method: req.method || 'GET',
            headers: req.headers || {},
            body: req.body && typeof req.body === 'string' ? req.body : undefined,
            sid: this.sessionId,
        });
        const resp = await fetch(this.endpoint('/_midas/fetch'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-midas-sid': this.sessionId,
            },
            body: payload,
            credentials: 'same-origin',
        });
        const parsed = await resp.json();
        return {
            status: parsed.status,
            headers: parsed.headers,
            body: typeof parsed.body === 'string'
                ? new TextEncoder().encode(parsed.body).buffer
                : new ArrayBuffer(0),
        };
    }
    supportsStreaming() { return false; }
}
class SimpleFetchTransport extends BaseTransport {
    async fetch(req) {
        const payload = JSON.stringify({
            url: req.url,
            method: req.method || 'GET',
            headers: req.headers || {},
            body: req.body && typeof req.body === 'string' ? req.body : undefined,
            sid: this.sessionId,
            passthrough: false,
        });
        const resp = await fetch(this.endpoint('/_midas/fetch'), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-midas-sid': this.sessionId,
            },
            body: payload,
            credentials: 'same-origin',
        });
        const parsed = await resp.json();
        return {
            status: parsed.status,
            headers: parsed.headers,
            body: typeof parsed.body === 'string'
                ? new TextEncoder().encode(parsed.body).buffer
                : new ArrayBuffer(0),
        };
    }
    supportsStreaming() { return false; }
}
async function initTransport(cfg) {
    let type = cfg.preferred || 'chunked';
    try {
        const test = await fetch(`${cfg.baseUrl}/_midas/session?t=${type}`, { method: 'HEAD' });
        if (!test.ok)
            type = 'fetch';
    }
    catch (e) {
        type = 'fetch';
    }
    if (type === 'sse')
        currentTransport = new SseTransport(cfg);
    else if (type === 'chunked')
        currentTransport = new ChunkedTransport(cfg);
    else
        currentTransport = new SimpleFetchTransport(cfg);
    return currentTransport;
}
function getTransport() {
    if (!currentTransport)
        throw new Error('Transport not initialized');
    return currentTransport;
}
async function midasFetch(url, init) {
    const t = getTransport();
    const body = init?.body;
    const bodyStr = body instanceof ArrayBuffer
        ? new TextDecoder().decode(body)
        : typeof body === 'string'
            ? body
            : undefined;
    const resp = await t.fetch({
        url,
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: bodyStr,
    });
    return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
    });
}


/* module: cloak/detect.js */
/**
 * Anti-instrumentation and execution-pattern evasion.
 * Detects if the environment is being analyzed and adjusts behavior.
 */
let devtoolsOpen = false;
let instrumentationDetected = false;
function checkDevTools() {
    const threshold = 160;
    const check = () => {
        const widthThreshold = window.outerWidth - window.innerWidth > threshold;
        const heightThreshold = window.outerHeight - window.innerHeight > threshold;
        devtoolsOpen = widthThreshold || heightThreshold;
    };
    window.addEventListener('resize', check);
    setInterval(check, 2000);
}
function checkInstrumentation() {
    // Detect if common instrumentation hooks are present
    const nativeToString = Function.prototype.toString;
    const checks = [
        () => nativeToString.call(window.fetch) !== 'function fetch() { [native code] }',
        () => nativeToString.call(window.XMLHttpRequest.prototype.open) !== 'function open() { [native code] }',
        () => nativeToString.call(window.WebSocket) !== 'function WebSocket() { [native code] }',
    ];
    for (const c of checks) {
        try {
            if (c()) {
                instrumentationDetected = true;
                break;
            }
        }
        catch (e) { }
    }
    // Detect if Proxy objects are being observed via unusual means
    try {
        const obj = {};
        const p = new Proxy(obj, {
            get(t, k) {
                if (k === '__proto__' || k === 'constructor')
                    instrumentationDetected = true;
                return t[k];
            }
        });
        void p.__proto__;
    }
    catch (e) { }
}
function isEnvironmentSafe() {
    return !devtoolsOpen && !instrumentationDetected;
}
function getEnvironmentStatus() {
    return { devtools: devtoolsOpen, instrumentation: instrumentationDetected };
}
function initDetection() {
    checkDevTools();
    checkInstrumentation();
}
function randomDelay() {
    // Random tiny delays to desynchronize execution patterns
    const ms = Math.floor(Math.random() * 4);
    return new Promise(r => setTimeout(r, ms));
}
function scrambleExecution(fn) {
    // Execute function with minor timing jitter
    const start = performance.now();
    const result = fn();
    const elapsed = performance.now() - start;
    if (elapsed < 2) {
        // Too fast = suspicious, burn a few cycles
        for (let i = 0; i < 1000 + Math.floor(Math.random() * 5000); i++) {
            Math.sqrt(i);
        }
    }
    return result;
}


/* module: cloak/polymorph.js */
/**
 * Polymorphic code helpers.
 * Generates randomized strings, reorders operations, and flattens control flow
 * so static signatures cannot be built.
 */
const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const NUMS = '0123456789';
function randomId(len = 8) {
    let s = CHARS[Math.floor(Math.random() * 52)];
    for (let i = 1; i < len; i++) {
        const pool = i === 0 ? CHARS : CHARS + NUMS;
        s += pool[Math.floor(Math.random() * pool.length)];
    }
    return s;
}
function randomString(min = 6, max = 14) {
    const len = min + Math.floor(Math.random() * (max - min));
    let s = CHARS[Math.floor(Math.random() * 52)];
    for (let i = 1; i < len; i++) {
        s += CHARS[Math.floor(Math.random() * 52)];
    }
    return s;
}
function randomBytes(len) {
    return crypto.getRandomValues(new Uint8Array(len));
}
function flatten(arr) {
    return arr.reduce((a, b) => a.concat(b), []);
}
function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function obfuscateUrl(url) {
    // Rotate common proxy markers in URLs
    return url
        .replace(/proxy/gi, randomString(4, 6))
        .replace(/uv/gi, randomString(2, 3))
        .replace(/bare/gi, randomString(3, 5));
}
function generateNonce() {
    return btoa(String.fromCharCode(...Array.from(randomBytes(12))));
}
function createHiddenProperty(obj, key, value) {
    Object.defineProperty(obj, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
    });
}


/* module: dom/window.js */
/**
 * Minimal window.location and history shadowing.
 * Uses native Proxy and defineProperty instead of wholesale replacement.
 */

let locationProxy = null;
let originalLocation = null;
let currentTargetUrl = '';
function installLocationHook(proxyBase, targetUrl) {
    if (originalLocation)
        return;
    originalLocation = window.location;
    currentTargetUrl = targetUrl;
    rebuildProxy();
    // Listen for location updates from the DOM patcher
    window.addEventListener('midas-location-update', (e) => {
        currentTargetUrl = e.detail.url;
        rebuildProxy();
    });
}
function rebuildProxy() {
    const parsed = new URL(currentTargetUrl);
    const fakeOrigin = parsed.origin;
    const fakeHost = parsed.host;
    const fakeHostname = parsed.hostname;
    const fakeHref = currentTargetUrl;
    const fakeProtocol = parsed.protocol;
    const fakePort = parsed.port;
    const fakePathname = parsed.pathname;
    const fakeSearch = parsed.search;
    const fakeHash = parsed.hash;
    const locProxy = new Proxy(originalLocation, {
        get(target, prop) {
            switch (prop) {
                case 'href': return fakeHref;
                case 'origin': return fakeOrigin;
                case 'host': return fakeHost;
                case 'hostname': return fakeHostname;
                case 'protocol': return fakeProtocol;
                case 'port': return fakePort;
                case 'pathname': return fakePathname;
                case 'search': return fakeSearch;
                case 'hash': return fakeHash;
                case 'toString': return () => fakeHref;
                case 'assign': return (url) => { navigate(url); };
                case 'replace': return (url) => { navigate(url, true); };
                case 'reload': return () => target.reload();
                default: return target[prop];
            }
        },
        set(target, prop, value) {
            if (prop === 'href') {
                navigate(value);
                return true;
            }
            target[prop] = value;
            return true;
        }
    });
    try {
        Object.defineProperty(window, 'location', {
            get() { return locProxy; },
            set(v) { navigate(v); },
            configurable: true,
        });
    }
    catch (e) {
        // Fallback for strict environments
    }
    createHiddenProperty(window, '__midas_loc_real', originalLocation);
}
function installHistoryHook() {
    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);
    history.pushState = function (data, unused, url) {
        if (url) {
            const resolved = new URL(url, window.location.href).href;
            origPushState(data, unused, resolved);
        }
        else {
            origPushState(data, unused);
        }
    };
    history.replaceState = function (data, unused, url) {
        if (url) {
            const resolved = new URL(url, window.location.href).href;
            origReplaceState(data, unused, resolved);
        }
        else {
            origReplaceState(data, unused);
        }
    };
    createHiddenProperty(history, '__midas_push_orig', origPushState);
    createHiddenProperty(history, '__midas_replace_orig', origReplaceState);
}
function navigate(url, replace = false) {
    const fullUrl = new URL(url, window.location.href).href;
    // Dispatch to transport layer
    const event = new CustomEvent('midas-navigate', { detail: { url: fullUrl, replace } });
    window.dispatchEvent(event);
}
function uninstallHooks() {
    if (originalLocation) {
        try {
            Object.defineProperty(window, 'location', {
                get() { return originalLocation; },
                configurable: true,
            });
        }
        catch (e) { }
        originalLocation = null;
    }
}


/* module: dom/patch.js */
/**
 * Lazy DOM patching via MutationObserver.
 * Avoids rewriting entire HTML; patches elements as they appear.
 */
let observer = null;
let baseProxyUrl = '';
function startDomPatching(proxyBase) {
    baseProxyUrl = proxyBase.replace(/\/$/, '');
    observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
            for (const node of Array.from(mut.addedNodes)) {
                if (node instanceof HTMLElement) {
                    patchElement(node);
                    patchChildren(node);
                }
            }
        }
    });
    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
    });
    // Patch existing elements
    patchChildren(document.documentElement || document.body);
}
function patchChildren(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
        if (node instanceof HTMLElement)
            patchElement(node);
    }
}
function patchElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') {
        interceptLink(el);
    }
    if (tag === 'form') {
        interceptForm(el);
    }
    if (tag === 'img' || tag === 'source' || tag === 'track') {
        const src = el.getAttribute('src');
        if (src) {
            el.setAttribute('src', proxySubresource(src));
        }
        if (tag === 'img') {
            const srcset = el.getAttribute('srcset');
            if (srcset) {
                el.setAttribute('srcset', srcset.split(',').map(s => {
                    const parts = s.trim().split(/\s+/);
                    const url = parts[0];
                    const desc = parts.slice(1).join(' ');
                    return `${proxySubresource(url)}${desc ? ' ' + desc : ''}`;
                }).join(', '));
            }
        }
    }
    if (tag === 'link' && el.getAttribute('rel') === 'stylesheet') {
        const href = el.getAttribute('href');
        if (href)
            el.setAttribute('href', proxySubresource(href));
    }
    if (tag === 'script') {
        const src = el.getAttribute('src');
        if (src) {
            el.setAttribute('src', proxySubresource(src));
        }
    }
    if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
        const src = el.getAttribute('src') || el.getAttribute('data');
        if (src) {
            const resolved = proxySubresource(src);
            if (el.hasAttribute('src'))
                el.setAttribute('src', resolved);
            if (el.hasAttribute('data'))
                el.setAttribute('data', resolved);
        }
    }
    if (tag === 'video' || tag === 'audio') {
        const src = el.getAttribute('src');
        if (src)
            el.setAttribute('src', proxySubresource(src));
        const sources = el.querySelectorAll('source');
        for (const s of Array.from(sources)) {
            const sSrc = s.getAttribute('src');
            if (sSrc)
                s.setAttribute('src', proxySubresource(sSrc));
        }
    }
}
function interceptLink(el) {
    el.addEventListener('click', async (e) => {
        const href = el.getAttribute('href');
        if (!href)
            return;
        if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:'))
            return;
        e.preventDefault();
        e.stopPropagation();
        const absUrl = new URL(href, window.location.href).href;
        // Dispatch navigation event for the app to handle
        const event = new CustomEvent('midas-navigate', { detail: { url: absUrl, replace: false } });
        window.dispatchEvent(event);
        // Also try to fetch and inject if no handler catches it
        try {
            const resp = await midasFetch(absUrl);
            const html = await resp.text();
            injectHtml(html, absUrl);
        }
        catch (err) {
            console.error('Navigation failed:', err);
        }
    });
}
function interceptForm(el) {
    el.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = el.getAttribute('action') || window.location.href;
        const method = (el.getAttribute('method') || 'GET').toUpperCase();
        const absUrl = new URL(action, window.location.href).href;
        const formData = new FormData(el);
        const body = method === 'GET'
            ? undefined
            : new URLSearchParams(formData).toString();
        try {
            const resp = await midasFetch(absUrl, {
                method,
                body,
                headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
            });
            const html = await resp.text();
            injectHtml(html, absUrl);
        }
        catch (err) {
            console.error('Form submission failed:', err);
        }
    });
}
function injectHtml(html, url) {
    // Parse and inject HTML content
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    // Update document title
    if (doc.title)
        document.title = doc.title;
    // Replace body content
    document.body.innerHTML = doc.body.innerHTML;
    // Inject head elements (styles, meta, base)
    const existingHeadElements = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style, meta, base'));
    for (const el of existingHeadElements) {
        if (!el.getAttribute('data-midas-preserve'))
            el.remove();
    }
    for (const el of Array.from(doc.head.children)) {
        if (el.tagName.toLowerCase() === 'script')
            continue; // Don't inject scripts from head for safety
        const imported = document.importNode(el, true);
        imported.setAttribute('data-midas-injected', '1');
        document.head.appendChild(imported);
    }
    // Patch all new elements
    patchChildren(document.body);
    // Execute inline scripts safely
    const scripts = document.body.querySelectorAll('script');
    for (const script of Array.from(scripts)) {
        if (script.src)
            continue;
        const newScript = document.createElement('script');
        newScript.textContent = script.textContent;
        script.replaceWith(newScript);
    }
    // Update history
    history.pushState({ midas: true, url }, '', '/?go=' + encodeURIComponent(url));
    // Update location proxy
    const locEvent = new CustomEvent('midas-location-update', { detail: { url } });
    window.dispatchEvent(locEvent);
}
function proxySubresource(url) {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#'))
        return url;
    const abs = new URL(url, window.location.href).href;
    return `${baseProxyUrl}/_midas/proxy?url=${encodeURIComponent(abs)}`;
}
function stopDomPatching() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
}
function injectStyles(cssText) {
    const style = document.createElement('style');
    style.textContent = cssText;
    document.head.appendChild(style);
    return style;
}


/* module: captcha/compat.js */
/**
 * CAPTCHA compatibility layer.
 * Ensures origin-sensitive scripts execute in their expected environment.
 */
const CAPTCHA_ORIGINS = [
    'https://www.google.com',
    'https://www.recaptcha.net',
    'https://www.gstatic.com',
    'https://js.hcaptcha.com',
    'https://api.hcaptcha.com',
    'https://newassets.hcaptcha.com',
    'https://challenges.cloudflare.com',
];
function isCaptchaUrl(url) {
    try {
        const u = new URL(url);
        return CAPTCHA_ORIGINS.some(o => u.origin === o);
    }
    catch (e) {
        return false;
    }
}
function rewriteCaptchaScript(src, proxyBase) {
    if (!isCaptchaUrl(src))
        return src;
    return `${proxyBase}/_midas/passthrough?url=${encodeURIComponent(src)}`;
}
function installCaptchaHooks(proxyBase) {
    // Intercept script injection for known CAPTCHA providers
    const origCreateElement = document.createElement.bind(document);
    document.createElement = function (tagName, options) {
        const el = origCreateElement(tagName, options);
        if (tagName.toLowerCase() === 'script') {
            const origSetAttribute = el.setAttribute.bind(el);
            el.setAttribute = function (name, value) {
                if (name === 'src' && isCaptchaUrl(value)) {
                    value = `${proxyBase}/_midas/passthrough?url=${encodeURIComponent(value)}`;
                }
                return origSetAttribute(name, value);
            };
            let srcValue = '';
            Object.defineProperty(el, 'src', {
                get() { return srcValue; },
                set(v) {
                    srcValue = isCaptchaUrl(v)
                        ? `${proxyBase}/_midas/passthrough?url=${encodeURIComponent(v)}`
                        : v;
                    origSetAttribute('src', srcValue);
                },
                configurable: true,
            });
        }
        return el;
    };
    // Ensure fetch/xhr to captcha origins use passthrough
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input.toString();
        if (isCaptchaUrl(url)) {
            const headers = new Headers(init?.headers);
            headers.set('x-midas-passthrough', '1');
            return origFetch(`${proxyBase}/_midas/passthrough?url=${encodeURIComponent(url)}`, {
                ...init,
                headers,
                credentials: 'include',
            });
        }
        return origFetch(input, init);
    };
}


/* bootstrap */
window.__midasInit = async function(cfg) {
  initDetection();
  initSession();

  const sidRes = await fetch(cfg.baseUrl + '/_midas/session', { method: 'POST' });
  const sidData = await sidRes.json();

  await initTransport({ baseUrl: cfg.baseUrl, sessionId: sidData.sid });
  installLocationHook(cfg.baseUrl, window.location.href);
  installHistoryHook();
  startDomPatching(cfg.baseUrl);
  installCaptchaHooks(cfg.baseUrl);

  // Handle ?go= parameter on initial load
  const params = new URLSearchParams(window.location.search);
  const goUrl = params.get('go');
  if (goUrl) {
    try {
      const resp = await midasFetch(goUrl);
      const html = await resp.text();
      // Use the global injectHtml from patch module
      if (typeof injectHtml === 'function') {
        injectHtml(html, goUrl);
      }
    } catch (err) {
      console.error('Initial load failed:', err);
    }
  }
};

})();