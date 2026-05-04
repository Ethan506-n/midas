# Midas Proxy Engine

## Overview
An advanced web proxy engine that routes external websites through the server, rewriting HTML/CSS/JS/JSON on the fly to keep all resource URLs within the proxy. Uses polymorphic rotating endpoint paths to avoid static-signature detection.

## Tech Stack
- **Runtime**: Node.js 18+ (ESM modules)
- **Backend**: Pure Node.js `http`, `https`, `zlib` — no framework
- **WebSocket**: `ws` library for real bidirectional WS tunneling
- **Frontend**: Vanilla JS served as static files from `public/`
- **Build**: Custom TypeScript build pipeline (`scripts/build.js` → `public/`)

## Architecture

### Server (`server/`)
| File | Purpose |
|------|---------|
| `index.js` | HTTP/1.1 server entry point, port 5000 |
| `router.js` | Core proxy logic — HTML/CSS/JS rewriting, cookie jar, browseHandler |
| `polymorph-router.js` | Rotating endpoint paths (HMAC-derived, change every 5 min) |
| `ws-bridge.js` | WebSocket ↔ HTTP polling bridge |
| `captcha-handler.js` | CAPTCHA passthrough detection |
| `passthrough.js` | Header passthrough helpers |

### Public (`public/`)
| File | Purpose |
|------|---------|
| `demo.html` | Main browser UI (toolbar, iframe, search engine selector) |
| `sandbox.js` | Client-side hook — intercepts fetch, XHR, WS, navigation, DOM |
| `loader.js` | SW bootstrap and client bundle loader |
| `sw.js` | Service worker (cache + proxy route interception) |
| `midas.client.js` | Compiled TS client bundle (anti-detection, transport) |
| `manifest.json` | PWA manifest |

### TypeScript Source (`src/`)
Client-side TypeScript compiled via `scripts/build.js` into `public/midas.client.js`:
- `core/` — transport (SSE/chunked), binary encoding, WebSocket hooks, noise
- `cloak/` — anti-instrumentation, fingerprint evasion
- `dom/` — window.location, localStorage, DOM virtualization
- `sw/` — stealth service worker source
- `captcha/` — CAPTCHA compatibility hooks
- `sandbox/` — iframe interception

## Key Features

### HTML Rewriting (`router.js → rewriteHtml`)
- Removes `<base>` tags
- **Strips `integrity` (SRI) attributes** — prevents broken resources after rewriting
- **Strips `nonce` attributes** — avoids CSP nonce mismatches
- **Strips `crossorigin` attributes** — avoids CORS issues with rewritten origins
- Rewrites all `href`, `src`, `action`, `formaction`, `poster`, `srcset` attributes
- Rewrites inline `<style>` blocks and `style=""` attributes
- Rewrites `<script type="module">` import/export statements
- **Rewrites `<script type="importmap">`** — maps CDN imports through proxy
- Rewrites meta refresh redirects
- Rewrites `og:url`, `og:image`, `twitter:image` meta tags
- Injects `sandbox.js` before `</head>` with correct `data-base` attribute

### JS Rewriting (`router.js → rewriteJs`)
- Absolute URL strings (`"https://..."`, `'https://...'`, template literals)
- Protocol-relative URLs (`//cdn.example.com/...`)
- `fetch("url")` calls
- `XMLHttpRequest.open("METHOD", "url")`
- `navigator.sendBeacon("url")`
- `new URL("url")`
- `location.href = "url"`, `location.assign("url")`, `location.replace("url")`
- `new WebSocket("wss://...")` → converted to HTTP and proxied
- `new EventSource("url")`
- `import("url")` dynamic imports
- ES module `import ... from "url"` and `export ... from "url"`

### CSS Rewriting (`router.js → rewriteCss`)
- `url(...)` references
- `@import url(...)` and `@import "..."`

### Content-Type Sniffing
When servers return `application/octet-stream` or wrong types:
- `.js`, `.mjs`, `.ts`, `.tsx`, `.jsx` → rewritten as JavaScript
- `.css` → rewritten as CSS
- `.html`, `.htm` → rewritten as HTML

### Client-Side Hooks (`public/sandbox.js`)
Injected into every proxied HTML page:
- `fetch()` — intercepts and proxies external fetch calls
- `XMLHttpRequest.open()` — intercepts XHR
- `navigator.sendBeacon()` — intercepts beacon calls
- `new WebSocket()` — routes through proxy
- `new EventSource()` — intercepts SSE
- `document.createElement()` — patches script/link/img/iframe src on creation
- `history.pushState/replaceState` — keeps navigation proxied
- `window.open()` — proxied
- `location.assign/replace` — proxied
- Click/submit event fallback interceptors
- MutationObserver for dynamically added DOM nodes

### Cookie Management
Server-side cookie jar (`Map<sid → Map<host → Cookie[]>>`) stores cookies per session per host, correctly handles `domain`, `path`, `expires`, `max-age`, `secure` attributes.

### Session & Polymorphic Routing
- Each page load gets a `midas_sid` cookie
- Endpoint paths rotate every 5 minutes using HMAC-SHA256 derived paths
- Client fetches `/` session endpoint to get current path map

## Configuration
| Env Var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `5000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `USE_HTTP2` | `false` | Enable HTTP/2 (requires TLS certs in `server/`) |

## Build
```bash
npm run build   # Compile TypeScript + bundle client
npm start       # Start server
npm run dev     # Build then start
```

## Workflow
- **Start application**: `node server/index.js` on port 5000
- Port 5000 maps to external port 80

## Preferences
- Keep all server code as ESM (`"type": "module"` in package.json)
- No framework dependencies — pure Node.js stdlib + `ws`
- Rewrite content on the server side; use `sandbox.js` for dynamic client-side patching
- Never add `integrity` or `nonce` attributes to injected scripts
