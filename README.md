# Midas Proxy Engine

> **Advanced proxy engine designed to bypass modern content-filtering detection systems including Lightspeed Live Intelligence.**

## Architecture Overview

Midas is a next-generation web proxy engine built from the ground up to defeat deep packet inspection, JavaScript execution pattern analysis, WebSocket tunnel detection, and proxy framework fingerprinting. Unlike Ultraviolet, Scramjet, or bare-mux which have catalogued runtime signatures, Midas uses **minimal native hooks**, **polymorphic code generation**, and **dynamic transport rotation** to remain invisible.

---

## Core Anti-Detection Features

### 1. Polymorphic Endpoint Paths
- All proxy endpoints (`browse`, `fetch`, `proxy`, `noise`, etc.) use cryptographically derived, rotating path names
- Paths change every 5 minutes based on a server-side HMAC seed
- No static `/_midas/fetch` or `/_midas/bare` signatures exist

### 2. No WebSocket/Wisp Tunnel Signatures
- Uses HTTP/2 Server Push, SSE, and chunked `fetch` streaming instead
- Binary wire protocol instead of JSON/base64 encoding
- Random padding injected into every response

### 3. Minimal Native API Hooking
- Hooks `fetch`, `XMLHttpRequest`, `WebSocket`, `history`, and `storage` via actual ES6 `Proxy` objects tied to real native functions
- No wholesale replacement of globals (which creates detectable fingerprint changes)
- Preserves native `toString()` behavior on all hooked functions

### 4. Anti-Instrumentation & Fingerprint Evasion
- Detects DevTools opening via window dimension analysis
- Detects instrumentation hooks by comparing `Function.prototype.toString` against known natives
- Randomizes execution timing with micro-delays to desynchronize pattern analysis
- Canvas/WebGL fingerprint randomization per session
- Navigator properties (`plugins`, `mimeTypes`, `vendor`) randomized

### 5. Stealth Service Worker
- Registers as a standard PWA cache worker (Workbox-style)
- Only intercepts requests with stealth headers or dynamic URL patterns
- Includes background sync and push notification handlers for cover traffic
- Mimics legitimate service worker lifecycle events

### 6. CAPTCHA Compatibility
- Dedicated passthrough endpoint preserves exact `origin`, `referrer`, and cookie contexts
- Special handling for reCAPTCHA, hCaptcha, and Cloudflare Turnstile domains
- Serves CAPTCHA scripts with unmodified headers to prevent origin validation failures

### 7. Full WebSocket Bridge
- `WebSocket` constructor transparently tunnels through standard HTTP(S) connections
- Binary message support with base64 encoding/decoding
- Events: `open`, `message`, `close`, `error` fully emulated

### 8. DOM & Storage Virtualization
- Lazy DOM patching via `MutationObserver` (no full HTML rewriting)
- `window.location` shadowed with getters/setters preserving native behavior
- `localStorage` / `sessionStorage` virtualized per-origin
- `IndexedDB` wrapped with per-origin namespace isolation

---

## File Structure

```
midas/
├── server/
│   ├── index.js              # HTTP/2 entry + TLS
│   ├── router.js             # Main request router with all endpoints
│   ├── polymorph-router.js   # Dynamic path generation + matching
│   ├── ws-bridge.js          # WebSocket-to-HTTP bridge
│   └── passthrough.js        # CAPTCHA/header pass-through
├── src/
│   ├── core/
│   │   ├── encoder.ts        # Binary protocol encoder/decoder
│   │   ├── crypto.ts         # Encryption (WASM-ready + JS fallback)
│   │   ├── transport.ts      # Transport layer (SSE/chunked/fetch)
│   │   ├── websocket.ts      # WebSocket hook + bridge client
│   │   └── noise.ts          # Random noise generation
│   ├── cloak/
│   │   ├── detect.ts         # Anti-instrumentation detection
│   │   ├── polymorph.ts      # Randomization utilities
│   │   └── fingerprint.ts    # Browser fingerprint evasion
│   ├── sw/
│   │   └── stealth-sw.ts     # Stealth service worker
│   ├── dom/
│   │   ├── window.ts         # window.location shadowing
│   │   ├── patch.ts          # Lazy DOM patching
│   │   └── storage.ts        # localStorage/sessionStorage/IndexedDB hooks
│   ├── captcha/
│   │   └── compat.ts         # CAPTCHA passthrough handling
│   └── sandbox/
│       └── iframe.ts         # iframe sandboxing + navigation
├── scripts/
│   └── build.js              # Build pipeline + module bundling
├── public/
│   ├── index.html            # Entry HTML page
│   ├── loader.js             # Bootstrap loader
│   ├── midas.client.js       # Built client bundle
│   ├── sw.js                 # Built service worker
│   └── manifest.json         # PWA manifest
├── package.json
├── tsconfig.json
└── README.md
```

---

## Quick Start

### Prerequisites
- Node.js 18+ (or Bun 1.0+)
- npm

### Installation

```bash
git clone <repo-url>
cd midas
npm install
```

### Build

```bash
npm run build
```

This compiles TypeScript, strips module syntax, bundles all client modules into a single `midas.client.js`, and builds the service worker.

### Run

```bash
npm start
# or for development:
npm run dev
```

The server starts on port 8443 by default (or the port specified by `PORT` env var).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8443` | Server port |
| `USE_HTTP2` | `true` | Enable HTTP/2 (falls back to HTTP/1.1 if no TLS certs) |

---

## Usage

### Browser Entry Point

Navigate to `https://localhost:8443/` (or `http://localhost:8443/` if HTTP/2 is disabled).

The loader script will:
1. Register the stealth service worker
2. Initialize the transport layer with polymorphic paths
3. Set up all DOM/storage hooks
4. Begin proxying

### Programmatic Navigation

```javascript
// Navigate to a URL through the proxy
window.dispatchEvent(new CustomEvent('midas-navigate', {
  detail: { url: 'https://example.com', replace: false }
}));

// Or use the fetch API directly
const resp = await midasFetch('https://api.example.com/data');
const data = await resp.json();
```

### WebSocket Usage

```javascript
// Midas transparently intercepts WebSocket creation
const ws = new WebSocket('wss://echo.websocket.org/');
ws.onopen = () => console.log('connected');
ws.onmessage = (e) => console.log('msg:', e.data);
ws.send('hello');
```

The WebSocket connection is transparently tunneled through HTTP(S) via the WebSocket bridge endpoint.

---

## Detection Evasion Details

### Against JavaScript Execution Pattern Analysis
- Critical encryption/decryption uses WebAssembly modules (when available)
- Execution timing is randomized with micro-delays
- Dead code is randomly inserted during build
- Variable names are randomized on every build
- Control flow is flattened where possible

### Against Tunnel Detection
- No WebSocket framing patterns
- Uses standard HTTP/1.1 and HTTP/2 features (SSE, chunked transfer)
- Random noise endpoints generate decoy traffic
- Binary protocol instead of JSON/base64

### Against Proxy Framework Signatures
- No global `__uv` or `__scramjet` variables
- No detectable `bare-mux` initialization patterns
- Service worker mimics legitimate PWA behavior
- All hooks preserve native `toString()` signatures

---

## CAPTCHA Support

Midas includes special handling for origin-sensitive CAPTCHA providers:

- **Google reCAPTCHA** (`www.google.com`, `www.gstatic.com`)
- **hCaptcha** (`js.hcaptcha.com`, `api.hcaptcha.com`)
- **Cloudflare Turnstile** (`challenges.cloudflare.com`)

These are detected automatically and served via the passthrough endpoint with preserved headers.

---

## Performance

- **Binary protocol** minimizes encoding overhead
- **Chunked streaming** allows large responses without buffering
- **Lazy DOM patching** avoids full HTML rewrite cost
- **HTTP/2 multiplexing** reduces connection overhead
- **Cache-friendly static assets** with standard cache headers

---

## Security Notes

- TLS certificates: In production, use real certificates. The server falls back to HTTP/1.1 without certs.
- `rejectUnauthorized: false` is used for upstream connections to handle self-signed certificates.
- Session cookies are `HttpOnly; SameSite=Lax`.
- No persistent logging of user traffic.

---

## Development

### Adding New Transport Strategies

Edit `src/core/transport.ts` and extend `BaseTransport`:

```typescript
class MyTransport extends BaseTransport {
  async fetch(req: MidasRequest): Promise<MidasResponse> {
    // Your implementation
  }
  supportsStreaming(): boolean { return true; }
}
```

### Adding New Cloaking Techniques

Edit `src/cloak/` modules. The build script automatically bundles all files listed in `scripts/build.js`.

### Rebuilding

```bash
npm run build
```

---

## License

MIT

---

## Disclaimer

This tool is provided for educational and research purposes. Users are responsible for complying with all applicable laws and network policies. The authors do not condone illegal activity.

