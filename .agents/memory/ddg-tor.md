---
name: DDG via Tor
description: Why DDG requires Tor routing and how it's implemented in the proxy
---

DDG's "bots use DuckDuckGo too" challenge fires at the IP layer — Replit's datacenter IP (Azure/Microsoft) is flagged before any JS fingerprinting runs. Client-side toString() spoofing, canvas noise, and navigator spoofing are all irrelevant.

**Solution**: Route all `*.duckduckgo.com` requests through Tor SOCKS5.

**Implementation**:
- `server/tor-proxy.js` — spawns `tor` (Nix package), waits for "Bootstrapped 100%", exports `getTorAgent()` returning a `SocksProxyAgent('socks5h://127.0.0.1:9050')`
- `server/index.js` — calls `startTor()` after `server.listen()` (non-blocking background start)
- `server/router.js` — in `browseHandlerImplAsync`, detects `isDDGHost`, uses `torAgent || pooledAgent`; skips DNS pre-resolution for Tor (socks5h resolves DNS remotely)

**Why socks5h not socks5**: The `h` suffix makes Tor resolve DNS internally — never leaks the hostname to local DNS resolvers.

**Flags that matter**: `--ClientOnly 1` is essential (no --ExitPolicy flag — that's relay-only and errors on client mode). `--Log 'notice stderr'` sends bootstrap progress to stderr which the Node.js child_process pipe captures.

**Bootstrap time**: ~15 seconds on Replit (tested). 90-second timeout before giving up and falling back to direct.

**Fallback**: If Tor isn't ready yet when a DDG request arrives, `getTorAgent()` returns null and the request goes direct (may trigger challenge until Tor is ready).
