# Midas Proxy Engine — replit.md

## Overview

Midas is an advanced web proxy engine built to bypass modern content-filtering and deep packet inspection systems (such as Lightspeed Live Intelligence). It routes web traffic through a Node.js server, rewriting HTML/CSS/JS on the fly and serving a client-side engine that hooks browser APIs to make proxied pages behave as if they were loaded natively.

Key capabilities:
- Polymorphic endpoint paths that rotate every 5 minutes via HMAC-derived names
- Server-side HTML/CSS/JS rewriting with client-side MutationObserver patching
- WebSocket tunneling over standard HTTP (avoids WS signature detection)
- Stealth Service Worker disguised as a PWA cache worker
- CAPTCHA passthrough for reCAPTCHA, hCaptcha, and Cloudflare Turnstile
- Anti-fingerprinting for canvas, WebGL, audio, navigator, and screen APIs
- Traffic noise injection (decoy requests, random padding) to defeat pattern analysis

---

## User Preferences

Preferred communication style: Simple, everyday language.

---

## System Architecture

### Server (Node.js, ESM)

**Entry point**: `server/index.js`
- Starts an HTTP server (HTTP/2 optional via `USE_HTTP2=true`)
- Serves the built-in browser UI (address bar + iframe) directly from an inline HTML string
- Delegates all requests to the router

**Router**: `server/router.js`
- Central request handler; routes traffic based on URL path prefixes
- Maintains a `COOKIE_JAR` (in-memory `Map`) for session cookie persistence across proxy hops
- Performs server-side HTML rewriting: rewrites `href`, `src`, `action`, `formaction`, `srcset`, etc. to go through the proxy
- Handles compressed responses (gzip/br/deflate) via Node's `zlib`
- Sets permissive CORS headers on all proxy responses
- Refreshes polymorphic endpoint paths every 60 seconds

**Polymorphic router**: `server/polymorph-router.js`
- Generates 8–10 character hex endpoint names via HMAC-SHA256 over a rotating random seed
- Seed rotates every 5 minutes; old paths become invalid automatically
- Eliminates static URL signatures like `/_uv/`, `/_bare/`, etc.

**WebSocket bridge**: `server/ws-bridge.js`
- Bridges WebSocket connections through HTTP using the `ws` npm package
- Sessions stored in `BRIDGE_SESSIONS` (in-memory `Map`) with 5-minute idle timeout
- Clients open/close/send/poll over regular HTTP endpoints; the server holds the real WS connection

**CAPTCHA handler**: `server/captcha-handler.js` + `server/passthrough.js`
- Detects CAPTCHA URLs by domain and path pattern matching
- Routes them through a minimal passthrough that preserves `origin`, `referer`, cookies, and UA headers
- Prevents CAPTCHA scripts from detecting they are being proxied

### Client Engine (TypeScript → bundled JS)

Source lives in `src/`, compiled and bundled by `scripts/build.js` into `public/midas.client.js`.

**Core modules** (`src/core/`):
- `encoder.ts` — Custom binary wire protocol (avoids base64/JSON signatures)
- `crypto.ts` — XOR-based encryption with WASM-swap-ready architecture; JS fallback active
- `transport.ts` — Multi-strategy transport (SSE → chunked fetch → plain fetch); uses dynamic polymorphic paths
- `websocket.ts` — `MidasWebSocket` class emulating the native `WebSocket` API over HTTP polling
- `noise.ts` — Periodic decoy requests to random-looking endpoints to break traffic pattern analysis

**DOM patching** (`src/dom/`):
- `patch.ts` — `MutationObserver`-based lazy link rewriting; patches `<a>`, `<form>`, `<img>`, `<script>` as they appear
- `window.ts` — Shadows `window.location` with a `Proxy` object returning the proxied page's URL values
- `storage.ts` — Virtualizes `localStorage`/`sessionStorage` with per-origin key prefixing

**Cloaking** (`src/cloak/`):
- `detect.ts` — DevTools detection (window dimension heuristic) + instrumentation hook detection
- `fingerprint.ts` — Adds pixel noise to canvas `getImageData`, patches WebGL, audio, navigator, and screen
- `polymorph.ts` — Random identifier and string generators for runtime code variation

**CAPTCHA compat** (`src/captcha/compat.ts`):
- Intercepts `document.createElement('script')` to redirect CAPTCHA `src` values through the passthrough endpoint

**Service Worker** (`src/sw/stealth-sw.ts` → `public/sw.js`):
- Registers as a PWA-style cache worker (Workbox-like appearance)
- Only intercepts requests on `/_midas/` routes or those carrying `x-midas-sid` headers
- Pre-caches legitimate-looking assets as cover

**Sandbox** (`src/sandbox/iframe.ts`):
- Creates a sandboxed `<iframe>` via `Blob` URL for full page isolation
- Two-way `postMessage` bridge between parent and iframe for navigation/title events

### Build Pipeline

`scripts/build.js` (plain Node.js):
- Concatenates TypeScript source files (after stripping `import`/`export` syntax) into a single IIFE bundle
- Outputs `public/midas.client.js` and `public/sw.js`
- TypeScript is used for type-checking only (`noEmit: true`); bundling is custom, not tsc

### Data Storage

- **No database** — all state is in-memory (`Map` objects for cookie jar, WebSocket bridge sessions, transport registry)
- Sessions are ephemeral; cookies survive only for the lifetime of the server process
- Storage isolation for proxied origins is implemented client-side via prefixed localStorage keys

### UI

- Single-page browser UI served inline from `server/index.js`
- Address bar, back/forward/reload buttons, search engine selector
- Main content rendered in a full-viewport `<iframe>` pointed at the proxy
- `public/demo.html` and `public/index.html` are alternative static UI variants

---

## External Dependencies

| Dependency | Purpose |
|---|---|
| `ws` (npm, ^8.16.0) | Real WebSocket client used server-side in `ws-bridge.js` to hold connections to target sites |
| `typescript` (dev, ^5.3.3) | Type checking only; not used for bundling |
| Node.js built-ins: `http`, `https`, `http2`, `zlib`, `crypto`, `fs`, `path` | Server infrastructure, compression, HMAC seed generation, file serving |
| Web APIs: `fetch`, `ServiceWorker`, `MutationObserver`, `Proxy`, `SubtleCrypto`, `WebGL`, `AudioContext` | Client-side hooking and anti-fingerprinting |

No external CDN dependencies, no database drivers, no authentication framework, no environment secrets required for basic operation. Port defaults to `5000`, configurable via `PORT` environment variable.