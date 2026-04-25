/**
 * WebSocket-over-HTTP Bridge Client
 * Emulates WebSocket API while tunneling all traffic over standard HTTP.
 * Avoids WebSocket connection signatures that Lightspeed detects.
 */
import { getTransport } from './transport';
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
export function installWebSocketHook() {
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
export function uninstallWebSocketHook() {
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
