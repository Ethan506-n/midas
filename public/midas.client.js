(function(){
const __MIDAS_NONCE__='325123eed5675f50';

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
 * Transport layer with multiple strategies and polymorphic path support.
 * Prioritizes SSE and chunked fetch to avoid WebSocket tunnel signatures.
 */
// Dynamic paths from server session response
let dynamicPaths = {};
function setDynamicPaths(paths) {
    dynamicPaths = paths;
}
function endpoint(pathKey) {
    const p = dynamicPaths[pathKey];
    if (p)
        return '/_midas/' + p;
    return '/_midas/' + pathKey;
}
let currentTransport = null;
class BaseTransport {
    baseUrl;
    sessionId;
    constructor(cfg) {
        this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
        this.sessionId = cfg.sessionId;
    }
    buildUrl(pathKey) {
        return `${this.baseUrl}${endpoint(pathKey)}`;
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
        const resp = await fetch(this.buildUrl('chunk'), {
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
        const resp = await fetch(this.buildUrl('fetch'), {
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
        const resp = await fetch(this.buildUrl('fetch'), {
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
        const test = await fetch(`${cfg.baseUrl}${endpoint('session')}?t=${type}`, { method: 'HEAD' });
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


/* module: core/websocket.js */
/**
 * WebSocket-over-HTTP Bridge Client
 * Emulates WebSocket API while tunneling all traffic over standard HTTP.
 * Avoids WebSocket connection signatures that Lightspeed detects.
 */

const REAL_WEBSOCKET = window.WebSocket;
class MidasWebSocket extends EventTarget {
    url;
    protocol;
    extensions;
    bufferedAmount = 0;
    binaryType = 'blob';
    _readyState = 0;
    _bridgeUrl;
    _pollInterval = 100;
    _pollTimer = null;
    _sendQueue = [];
    _lastReceiveId = 0;
    _sendId = 0;
    _listeners = new Map();
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
        super();
        this.url = url.toString();
        this.protocol = Array.isArray(protocols) ? protocols[0] : (protocols || '');
        this.extensions = '';
        this._bridgeUrl = this._buildBridgeUrl();
        // Defer connection to avoid synchronous execution patterns
        setTimeout(() => this._connect(), 0);
    }
    get readyState() { return this._readyState; }
    get onopen() { return this._getHandler('open'); }
    set onopen(v) { this._setHandler('open', v); }
    get onmessage() { return this._getHandler('message'); }
    set onmessage(v) { this._setHandler('message', v); }
    get onclose() { return this._getHandler('close'); }
    set onclose(v) { this._setHandler('close', v); }
    get onerror() { return this._getHandler('error'); }
    set onerror(v) { this._setHandler('error', v); }
    send(data) {
        if (this._readyState !== 1) {
            throw new Error('WebSocket is not open');
        }
        let payload;
        if (typeof data === 'string') {
            payload = data;
        }
        else if (data instanceof ArrayBuffer) {
            payload = btoa(String.fromCharCode(...new Uint8Array(data)));
        }
        else if (ArrayBuffer.isView(data)) {
            payload = btoa(String.fromCharCode(...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
        }
        else if (data instanceof Blob) {
            const reader = new FileReader();
            reader.onload = () => this.send(reader.result);
            reader.readAsArrayBuffer(data);
            return;
        }
        else {
            payload = String(data);
        }
        this._sendQueue.push(payload);
        this._flushSend();
    }
    close(code, reason) {
        this._readyState = 2;
        this._stopPolling();
        this._signalClose(code || 1000, reason || '');
    }
    _buildBridgeUrl() {
        // Use the transport layer's base URL
        try {
            const t = getTransport();
            return t.baseUrl || window.location.origin;
        }
        catch {
            return window.location.origin;
        }
    }
    async _connect() {
        try {
            const resp = await fetch(`${this._bridgeUrl}/_midas/wsbridge/open`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: this.url, protocol: this.protocol }),
            });
            if (!resp.ok)
                throw new Error('Bridge open failed');
            const data = await resp.json();
            this._bridgeSession = data.sid;
            this._readyState = 1;
            this._dispatch('open', new Event('open'));
            this._startPolling();
        }
        catch (e) {
            this._readyState = 3;
            this._dispatch('error', new Event('error'));
            this._dispatch('close', new CloseEvent('close', { wasClean: false, code: 1006 }));
        }
    }
    async _flushSend() {
        const sid = this._bridgeSession;
        if (!sid || !this._sendQueue.length)
            return;
        const batch = this._sendQueue.splice(0, this._sendQueue.length);
        try {
            await fetch(`${this._bridgeUrl}/_midas/wsbridge/send`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sid, messages: batch }),
            });
        }
        catch (e) {
            // Queue for retry
            this._sendQueue.unshift(...batch);
        }
    }
    _startPolling() {
        const sid = this._bridgeSession;
        if (!sid)
            return;
        this._pollTimer = setInterval(async () => {
            try {
                const resp = await fetch(`${this._bridgeUrl}/_midas/wsbridge/poll?sid=${sid}&last=${this._lastReceiveId}`, {
                    method: 'GET',
                });
                if (!resp.ok)
                    return;
                const data = await resp.json();
                if (data.messages) {
                    for (const msg of data.messages) {
                        this._lastReceiveId = msg.id;
                        const event = new MessageEvent('message', {
                            data: msg.text || msg.binary,
                            origin: this.url,
                        });
                        this._dispatch('message', event);
                    }
                }
                if (data.closed) {
                    this._stopPolling();
                    this._signalClose(data.closeCode || 1000, data.closeReason || '');
                }
            }
            catch (e) {
                // Silent failure, continue polling
            }
        }, this._pollInterval + Math.floor(Math.random() * 50));
    }
    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }
    _signalClose(code, reason) {
        this._readyState = 3;
        this._dispatch('close', new CloseEvent('close', { wasClean: code === 1000, code, reason }));
    }
    _dispatch(type, event) {
        this.dispatchEvent(event);
        const handler = this._getHandler(type);
        if (handler) {
            if (typeof handler === 'function')
                handler.call(this, event);
            else
                handler.handleEvent(event);
        }
    }
    _getHandler(type) {
        const key = `__ws_on_${type}`;
        return this[key] || null;
    }
    _setHandler(type, v) {
        const key = `__ws_on_${type}`;
        this[key] = v;
    }
}
function installWebSocketHook() {
    // Replace global WebSocket with our bridge
    const descriptor = Object.getOwnPropertyDescriptor(window, 'WebSocket');
    if (descriptor && descriptor.configurable) {
        Object.defineProperty(window, 'WebSocket', {
            value: MidasWebSocket,
            configurable: true,
            writable: true,
        });
    }
    else {
        window.WebSocket = MidasWebSocket;
    }
    // Preserve the original for internal use if needed
    createHiddenProperty(window, '__midas_ws_real', REAL_WEBSOCKET);
}
function uninstallWebSocketHook() {
    const real = window.__midas_ws_real;
    if (real) {
        window.WebSocket = real;
    }
}
function createHiddenProperty(obj, key, value) {
    Object.defineProperty(obj, key, {
        value, writable: true, configurable: true, enumerable: false,
    });
}


/* module: core/noise.js */
/**
 * Traffic Noise Injection Module
 * Adds decoy requests and payload padding to break traffic pattern analysis.
 */
let config = {
    enabled: true,
    decoyProbability: 0.1,
    minDecoyInterval: 5000,
    maxDecoyInterval: 30000,
    paddingEnabled: false,
};
let noiseTimer = null;
let isRunning = false;
const DECOY_ENDPOINTS = [
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
    '/.well-known/security.txt',
    '/assets/logo.png',
    '/assets/icon.svg',
];
const DECOY_ORIGINS = [
    'https://www.google.com',
    'https://cdnjs.cloudflare.com',
    'https://fonts.googleapis.com',
    'https://ajax.googleapis.com',
    'https://unpkg.com',
];
function initNoise(cfg = {}) {
    config = { ...config, ...cfg };
    if (config.enabled)
        startNoise();
}
function stopNoise() {
    isRunning = false;
    if (noiseTimer) {
        clearTimeout(noiseTimer);
        noiseTimer = null;
    }
}
function startNoise() {
    if (isRunning)
        return;
    isRunning = true;
    scheduleNextDecoy();
}
function scheduleNextDecoy() {
    if (!isRunning)
        return;
    const delay = config.minDecoyInterval + Math.random() * (config.maxDecoyInterval - config.minDecoyInterval);
    noiseTimer = setTimeout(() => {
        if (Math.random() < config.decoyProbability) {
            sendDecoyRequest();
        }
        scheduleNextDecoy();
    }, delay);
}
function sendDecoyRequest() {
    try {
        const endpoint = DECOY_ENDPOINTS[Math.floor(Math.random() * DECOY_ENDPOINTS.length)];
        const origin = DECOY_ORIGINS[Math.floor(Math.random() * DECOY_ORIGINS.length)];
        const url = origin + endpoint + '?_=' + Math.random().toString(36).slice(2);
        // Use fetch with no-cors to avoid CORS issues and make it look like a normal resource load
        fetch(url, { mode: 'no-cors', cache: 'no-store' }).catch(() => {
            // Expected to fail or be opaque, that's fine
        });
    }
    catch (e) {
        // Silent failure
    }
}
function padPayload(data) {
    if (!config.paddingEnabled)
        return data;
    const paddingSize = Math.floor(Math.random() * 256);
    const padded = new Uint8Array(data.byteLength + paddingSize + 4);
    const view = new DataView(padded.buffer);
    view.setUint32(0, data.byteLength, true);
    padded.set(new Uint8Array(data), 4);
    // Fill padding with random bytes
    for (let i = data.byteLength + 4; i < padded.length; i++) {
        padded[i] = Math.floor(Math.random() * 256);
    }
    return padded.buffer;
}
function unpadPayload(data) {
    if (!config.paddingEnabled)
        return data;
    const view = new DataView(data);
    const originalSize = view.getUint32(0, true);
    return data.slice(4, 4 + originalSize);
}
function generateRandomTrafficBurst(count = 3) {
    for (let i = 0; i < count; i++) {
        setTimeout(() => sendDecoyRequest(), Math.random() * 2000);
    }
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


/* module: cloak/fingerprint.js */
/**
 * Advanced Anti-Fingerprinting Module
 * Adds noise to canvas, WebGL, audio, and timing fingerprints.
 * Randomizes navigator properties and screen metrics.
 */
let config = { noiseLevel: 0.5, enabled: true };
function initAntiFingerprint(cfg = {}) {
    config = { ...config, ...cfg };
    if (!config.enabled)
        return;
    patchCanvas();
    patchWebGL();
    patchAudio();
    patchNavigator();
    patchScreen();
    patchTiming();
}
function patchCanvas() {
    const proto = HTMLCanvasElement.prototype;
    const origGetContext = proto.getContext.bind(proto);
    proto.getContext = function (contextId, options) {
        const ctx = origGetContext(contextId, options);
        if (!ctx)
            return ctx;
        if (contextId === '2d' && ctx instanceof CanvasRenderingContext2D) {
            patchCanvas2D(ctx);
        }
        else if ((contextId === 'webgl' || contextId === 'experimental-webgl') && ctx instanceof WebGLRenderingContext) {
            patchWebGLContext(ctx);
        }
        return ctx;
    };
}
function patchCanvas2D(ctx) {
    const origGetImageData = ctx.getImageData.bind(ctx);
    ctx.getImageData = function (sx, sy, sw, sh) {
        const data = origGetImageData(sx, sy, sw, sh);
        addPixelNoise(data.data);
        return data;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL.bind(ctx.canvas);
    const origToBlob = HTMLCanvasElement.prototype.toBlob.bind(ctx.canvas);
    ctx.canvas.toDataURL = function (type, quality) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        if (w === 0 || h === 0)
            return origToDataURL(type, quality);
        const img = origGetImageData(0, 0, w, h);
        addPixelNoise(img.data);
        ctx.putImageData(img, 0, 0);
        const result = origToDataURL(type, quality);
        return result;
    };
    ctx.canvas.toBlob = function (callback, type, quality) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        if (w === 0 || h === 0) {
            origToBlob(callback, type, quality);
            return;
        }
        const img = origGetImageData(0, 0, w, h);
        addPixelNoise(img.data);
        ctx.putImageData(img, 0, 0);
        origToBlob(callback, type, quality);
    };
}
function addPixelNoise(data) {
    const level = config.noiseLevel || 0.5;
    for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * level * 2;
        data[i] = Math.min(255, Math.max(0, data[i] + noise));
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
    }
}
function patchWebGL() {
    // WebGL fingerprinting is done via parameter queries
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (pname) {
        const result = origGetParameter.call(this, pname);
        // Add tiny noise to float parameters that are commonly fingerprinted
        if (typeof result === 'number' && pname !== 0x0D31 && pname !== 0x0D33) {
            return result + (Math.random() - 0.5) * 0.0001;
        }
        return result;
    };
}
function patchWebGLContext(gl) {
    // Additional WebGL context patching if needed
}
function patchAudio() {
    if (!window.AudioContext && !window.webkitAudioContext)
        return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const origCreateAnalyser = AC.prototype.createAnalyser;
    AC.prototype.createAnalyser = function () {
        const analyser = origCreateAnalyser.call(this);
        const origGetFloatFrequencyData = analyser.getFloatFrequencyData.bind(analyser);
        analyser.getFloatFrequencyData = function (array) {
            origGetFloatFrequencyData(array);
            for (let i = 0; i < array.length; i++) {
                array[i] += (Math.random() - 0.5) * 0.1;
            }
        };
        return analyser;
    };
}
function patchNavigator() {
    const props = {
        hardwareConcurrency: Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)),
        deviceMemory: [2, 4, 8][Math.floor(Math.random() * 3)],
        maxTouchPoints: navigator.maxTouchPoints || 0,
        platform: navigator.platform,
    };
    for (const [key, value] of Object.entries(props)) {
        try {
            Object.defineProperty(navigator, key, {
                get() { return value; },
                configurable: true,
            });
        }
        catch (e) { }
    }
    // Randomize user agent slightly (if possible)
    const ua = navigator.userAgent;
    if (ua.includes('Chrome/')) {
        const version = ua.match(/Chrome\/([\d.]+)/);
        if (version) {
            const minor = parseInt(version[1].split('.')[2] || '0', 10);
            const newMinor = Math.max(0, minor + Math.floor((Math.random() - 0.5) * 4));
            const newUa = ua.replace(version[1], version[1].replace(/\.\d+$/, `.${newMinor}`));
            try {
                Object.defineProperty(navigator, 'userAgent', {
                    get() { return newUa; },
                    configurable: true,
                });
            }
            catch (e) { }
        }
    }
}
function patchScreen() {
    // Add tiny variation to screen dimensions (some sites fingerprint these)
    const variations = [0, 0, 0, 0];
    try {
        Object.defineProperty(screen, 'availWidth', {
            get() { return screen.width + variations[0]; },
            configurable: true,
        });
        Object.defineProperty(screen, 'availHeight', {
            get() { return screen.height + variations[1]; },
            configurable: true,
        });
    }
    catch (e) { }
}
function patchTiming() {
    // Add jitter to performance.now() to prevent timing-based fingerprinting
    const origNow = performance.now.bind(performance);
    let drift = 0;
    performance.now = function () {
        const result = origNow() + drift;
        drift += (Math.random() - 0.5) * 0.05;
        drift *= 0.95; // slowly decay
        return result;
    };
    // Patch Date.now slightly
    const origDateNow = Date.now.bind(Date);
    Date.now = function () {
        return origDateNow() + Math.floor((Math.random() - 0.5) * 2);
    };
}
function generateNoiseProfile() {
    return {
        canvasNoise: Math.random(),
        webglNoise: Math.random(),
        audioNoise: Math.random(),
        timingJitter: Math.random(),
    };
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
let dynamicPaths = {};
function setProxyPaths(paths) {
    dynamicPaths = paths;
}
function getProxyPath(key) {
    const p = dynamicPaths[key];
    if (p)
        return '/_midas/' + p;
    return '/_midas/' + key;
}
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
        const event = new CustomEvent('midas-navigate', { detail: { url: absUrl, replace: false } });
        window.dispatchEvent(event);
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    if (doc.title)
        document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML;
    const existingHeadElements = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style, meta, base'));
    for (const el of existingHeadElements) {
        if (!el.getAttribute('data-midas-preserve'))
            el.remove();
    }
    for (const el of Array.from(doc.head.children)) {
        if (el.tagName.toLowerCase() === 'script')
            continue;
        const imported = document.importNode(el, true);
        imported.setAttribute('data-midas-injected', '1');
        document.head.appendChild(imported);
    }
    patchChildren(document.body);
    const scripts = document.body.querySelectorAll('script');
    for (const script of Array.from(scripts)) {
        if (script.src)
            continue;
        const newScript = document.createElement('script');
        newScript.textContent = script.textContent;
        script.replaceWith(newScript);
    }
    history.pushState({ midas: true, url }, '', '/?go=' + encodeURIComponent(url));
    const locEvent = new CustomEvent('midas-location-update', { detail: { url } });
    window.dispatchEvent(locEvent);
}
function proxySubresource(url) {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#'))
        return url;
    const abs = new URL(url, window.location.href).href;
    return `${baseProxyUrl}${getProxyPath('proxy')}?url=${encodeURIComponent(abs)}`;
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


/* module: dom/storage.js */
/**
 * Storage Isolation Layer
 * Virtualizes localStorage, sessionStorage, and indexedDB
 * to provide per-origin isolation within the proxy context.
 */
const ORIGIN_KEY_PREFIX = '__midas_storage_';
class IsolatedStorage {
    prefix;
    backend;
    constructor(origin, backend) {
        this.prefix = ORIGIN_KEY_PREFIX + btoa(origin).replace(/[^a-zA-Z0-9]/g, '') + '_';
        this.backend = backend;
    }
    get length() {
        let count = 0;
        for (let i = 0; i < this.backend.length; i++) {
            const k = this.backend.key(i);
            if (k && k.startsWith(this.prefix))
                count++;
        }
        return count;
    }
    key(index) {
        let count = 0;
        for (let i = 0; i < this.backend.length; i++) {
            const k = this.backend.key(i);
            if (k && k.startsWith(this.prefix)) {
                if (count === index)
                    return k.slice(this.prefix.length);
                count++;
            }
        }
        return null;
    }
    getItem(key) {
        return this.backend.getItem(this.prefix + key);
    }
    setItem(key, value) {
        this.backend.setItem(this.prefix + key, value);
    }
    removeItem(key) {
        this.backend.removeItem(this.prefix + key);
    }
    clear() {
        const toRemove = [];
        for (let i = 0; i < this.backend.length; i++) {
            const k = this.backend.key(i);
            if (k && k.startsWith(this.prefix))
                toRemove.push(k);
        }
        for (const k of toRemove)
            this.backend.removeItem(k);
    }
}
let realLocalStorage = null;
let realSessionStorage = null;
let currentOrigin = '';
let isolatedLocal = null;
let isolatedSession = null;
function installStorageHooks(targetOrigin) {
    currentOrigin = targetOrigin;
    try {
        realLocalStorage = window.localStorage;
        isolatedLocal = new IsolatedStorage(targetOrigin, realLocalStorage);
        Object.defineProperty(window, 'localStorage', {
            get() { return isolatedLocal; },
            configurable: true,
        });
    }
    catch (e) {
        // Storage access denied (private mode, etc.)
    }
    try {
        realSessionStorage = window.sessionStorage;
        isolatedSession = new IsolatedStorage(targetOrigin, realSessionStorage);
        Object.defineProperty(window, 'sessionStorage', {
            get() { return isolatedSession; },
            configurable: true,
        });
    }
    catch (e) {
        // Storage access denied
    }
}
function updateStorageOrigin(newOrigin) {
    currentOrigin = newOrigin;
    if (realLocalStorage)
        isolatedLocal = new IsolatedStorage(newOrigin, realLocalStorage);
    if (realSessionStorage)
        isolatedSession = new IsolatedStorage(newOrigin, realSessionStorage);
}
function uninstallStorageHooks() {
    if (realLocalStorage) {
        Object.defineProperty(window, 'localStorage', {
            get() { return realLocalStorage; },
            configurable: true,
        });
    }
    if (realSessionStorage) {
        Object.defineProperty(window, 'sessionStorage', {
            get() { return realSessionStorage; },
            configurable: true,
        });
    }
}
/**
 * IndexedDB Isolation
 * Wraps IDBFactory to prefix database names per origin.
 */
let realIndexedDB = null;
function installIndexedDBHook(targetOrigin) {
    const prefix = ORIGIN_KEY_PREFIX + btoa(targetOrigin).replace(/[^a-zA-Z0-9]/g, '') + '_';
    try {
        realIndexedDB = window.indexedDB;
        const wrapped = {
            open(name, version) {
                return realIndexedDB.open(prefix + name, version);
            },
            deleteDatabase(name) {
                return realIndexedDB.deleteDatabase(prefix + name);
            },
            cmp(a, b) {
                return realIndexedDB.cmp(a, b);
            },
            databases() {
                return realIndexedDB.databases().then(list => list.filter(d => d.name && d.name.startsWith(prefix)).map(d => ({
                    ...d,
                    name: d.name.slice(prefix.length),
                })));
            },
        };
        Object.defineProperty(window, 'indexedDB', {
            get() { return wrapped; },
            configurable: true,
        });
    }
    catch (e) {
        // IDB not available
    }
}
function uninstallIndexedDBHook() {
    if (realIndexedDB) {
        Object.defineProperty(window, 'indexedDB', {
            get() { return realIndexedDB; },
            configurable: true,
        });
    }
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


/* module: sandbox/iframe.js */
/**
 * Iframe Sandbox Engine
 * Provides complete page isolation via sandboxed iframes.
 * Enables two-way proxy communication between parent and sandbox.
 */
let activeSandbox = null;
let messageHandler = null;
function createSandbox(cfg) {
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
function destroySandbox() {
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
function isSandboxActive() {
    return !!activeSandbox;
}
function getSandboxFrame() {
    return activeSandbox;
}


/* bootstrap */
window.__midasInit = async function(cfg) {
  initDetection();
  initSession();
  initAntiFingerprint();
  initNoise();
  installWebSocketHook();

  const sidRes = await fetch(cfg.baseUrl + '/_midas/session', { method: 'POST' });
  const sidData = await sidRes.json();

  // Use polymorphic paths from server if available
  const paths = sidData.paths || {};

  await initTransport({ baseUrl: cfg.baseUrl, sessionId: sidData.sid });
  installLocationHook(cfg.baseUrl, window.location.href);
  installHistoryHook();
  installStorageHooks(window.location.href);
  installIndexedDBHook(window.location.href);
  startDomPatching(cfg.baseUrl);
  installCaptchaHooks(cfg.baseUrl);

  // Handle ?go= parameter on initial load
  const params = new URLSearchParams(window.location.search);
  const goUrl = params.get('go');
  if (goUrl) {
    try {
      const resp = await midasFetch(goUrl);
      const html = await resp.text();
      if (typeof injectHtml === 'function') {
        injectHtml(html, goUrl);
      }
    } catch (err) {
      console.error('Initial load failed:', err);
    }
  }
};

})();