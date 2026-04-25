/**
 * Transport layer with multiple strategies and polymorphic path support.
 * Prioritizes SSE and chunked fetch to avoid WebSocket tunnel signatures.
 */
// Dynamic paths from server session response
let dynamicPaths = {};
export function setDynamicPaths(paths) {
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
export async function initTransport(cfg) {
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
export function getTransport() {
    if (!currentTransport)
        throw new Error('Transport not initialized');
    return currentTransport;
}
export async function midasFetch(url, init) {
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
