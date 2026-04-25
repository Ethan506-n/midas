# Midas Implementation TODO

## Phase 1: Project Scaffolding
- [x] Create TODO.md
- [x] Create package.json with dependencies
- [x] Create TypeScript configuration
- [x] Create build pipeline script
- [x] Create directory structure

## Phase 2: Server-Side Infrastructure
- [x] Implement HTTP/2 server entry point
- [x] Implement request router with transport negotiation
- [x] Implement CAPTCHA passthrough handler
- [x] Implement dynamic client bundle serving with polymorphism
- [x] Implement polymorphic endpoint rotation (anti-detection)
- [x] Implement cookie jar for session persistence
- [x] Implement transparent redirect following

## Phase 3: Core Client Engine
- [x] Implement binary encoder/decoder
- [x] Implement transport layer (SSE + chunked fetch)
- [x] Implement crypto module (WASM-ready JS fallback + bindings)
- [x] Implement polymorphic code generator

## Phase 4: Stealth & Cloaking
- [x] Implement stealth service worker (cache-worker cover)
- [x] Implement minimal DOM hooks via Proxy
- [x] Implement window.location shadowing
- [x] Implement anti-instrumentation detection
- [x] Implement server-side HTML/CSS/JS rewriting
- [x] Implement client-side stealth script for dynamic content

## Phase 5: CAPTCHA Compatibility
- [x] Implement origin-preserving subresource proxying
- [x] Implement header forwarding for CAPTCHA domains
- [x] Detect and passthrough reCAPTCHA
- [x] Detect and passthrough hCaptcha
- [x] Detect and passthrough Cloudflare Turnstile

## Phase 6: Integration & Polish
- [x] Wire client loader bootstrap
- [x] Integrate all modules
- [x] Add randomized execution patterns
- [x] Fix all syntax errors
- [x] Test proxy functionality

## Key Improvements Made

### 1. Dual-Layer Link Rewriting
- **Server-side**: Regex rewrites href/src/action/formaction/poster/data/srcset attributes in HTML/CSS
- **Client-side**: Injected stealth script uses MutationObserver to catch dynamically created links (SPA frameworks, JS-generated content)
- **Click interception**: Prevents navigation to real sites, forces proxy routing

### 2. CAPTCHA Support
- Dedicated `captcha-handler.js` module
- Detects reCAPTCHA, hCaptcha, Cloudflare Turnstile by domain and URL patterns
- Passthrough mode preserves exact headers (origin, referrer, user-agent, cookies)
- CAPTCHA JS/resources are not rewritten to avoid breaking challenge scripts

### 3. Anti-Detection Features
- Polymorphic endpoint paths rotate every 5 minutes
- Noise endpoint returns random binary data to confuse traffic analysis
- No static `/proxy` or `/browse` signatures
- Cookie jar maintains session state per user

### 4. Website Compatibility
- Transparent redirect following (up to 8 hops)
- Cookie persistence across requests
- Referrer header preservation
- Content-Encoding decompression (gzip, deflate, brotli)
- Base tag removal to prevent URL resolution conflicts
- window.open() interception

### 5. Stealth Script Features
- Catches all dynamically inserted DOM elements
- Handles meta refresh redirects
- Intercepts video/audio source elements
- Works with SPAs (React, Vue, Angular) that modify DOM after load
- Minimal footprint - single inline script, no external resources

## To Run
```bash
node server/index.js
```
Then open http://localhost:5000 in your browser.

