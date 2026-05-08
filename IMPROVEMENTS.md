# Midas Proxy - Enhancement Guide

This guide documents the major improvements made to the Midas proxy engine to handle more websites and provide better overall functionality.

## New Features & Improvements

### 1. Enhanced Content Handler (`server/content-handler.js`)

Provides advanced HTML/CSS/JavaScript rewriting for better website compatibility.

#### Features:
- **Streaming Support**: Properly handles video/audio streaming tags (`<video>`, `<audio>`, `<source>`)
- **JSON Response Rewriting**: Recursively rewrites URLs in JSON API responses
- **JavaScript URL Rewriting**: Rewrites URLs in fetch(), XMLHttpRequest.open(), WebSocket(), and dynamic imports
- **API Endpoint Rewriting**: Handles GraphQL endpoints and API configuration variables
- **Header Sanitization**: Removes problematic headers (CSP, X-Frame-Options, etc.)
- **CORS Stripping**: Removes CORS headers that conflict with proxying

#### Usage in router.js:
```javascript
import { rewriteStreamingHtml, rewriteJsonResponse, rewriteJavaScriptUrls } from './content-handler.js';

// Apply to HTML responses
html = rewriteStreamingHtml(html, baseUrl);

// Apply to JSON API responses
jsonContent = rewriteJsonResponse(jsonContent, baseUrl);

// Apply to JavaScript files
jsContent = rewriteJavaScriptUrls(jsContent, baseUrl);
```

### 2. Domain-Specific Handlers (`server/domain-handlers.js`)

Provides optimized handling for specific website categories.

#### Supported Categories:
- **Social Media**: Facebook, Twitter/X, Instagram, TikTok, Reddit, LinkedIn
- **Streaming & Media**: YouTube, Netflix, Hulu, Twitch, Vimeo
- **E-Commerce**: Amazon, eBay, Shopify, Etsy
- **Search & News**: Google, Bing, DuckDuckGo, BBC, CNN
- **Cloud Services**: GitHub, GitLab, Google Drive, Dropbox, OneDrive
- **Messaging**: Discord, Telegram, WhatsApp, Slack

#### Features per Domain:
- Authentication preservation
- JSON API handling
- Streaming support
- WebSocket support
- Form handling
- Bandwidth prioritization

#### Usage:
```javascript
import { getDomainHandler, shouldPreserveAuthentication, isHighBandwidthDomain } from './domain-handlers.js';

const handler = getDomainHandler(hostname);
if (shouldPreserveAuthentication(hostname)) {
  // Preserve auth cookies and headers
}
```

### 3. Response Caching (`server/response-cache.js`)

Implements intelligent response caching for improved performance.

#### Features:
- **Smart Caching**: Caches GET requests with 500MB total limit
- **Static Asset Caching**: Automatically caches .js, .css, .png, .jpg, etc.
- **JSON API Caching**: Caches JSON responses with proper TTL
- **Cache Statistics**: Track cache usage and efficiency
- **Automatic Cleanup**: Removes expired entries based on Cache-Control headers

#### Configuration:
```javascript
import { ResponseCache, shouldCacheResponse, extractCacheTTL } from './response-cache.js';

// Check if response should be cached
if (shouldCacheResponse(statusCode, headers, url)) {
  const ttl = extractCacheTTL(headers);
  ResponseCache.set('GET', url, response, ttl);
}

// Retrieve from cache
const cached = ResponseCache.get('GET', url);
```

### 4. Connection Pool & Management (`server/connection-pool.js`)

Provides advanced connection pooling, rate limiting, and circuit breaker patterns.

#### Features:

**Connection Pool**:
- Maintains HTTP/HTTPS keep-alive connections
- Configurable socket limits (default: 100 max, 50 free)
- Automatic timeout handling
- Per-domain connection tracking

**Rate Limiter**:
- Token bucket algorithm
- Per-domain rate limiting (default: 50 req/s)
- Burst capacity support
- Prevents overwhelming target servers

**Circuit Breaker**:
- Automatic failure detection
- Graceful degradation
- Self-healing after timeout
- Tracks failure states

#### Usage:
```javascript
import { globalPool, getRateLimiterForDomain, CircuitBreaker } from './connection-pool.js';

// Get pooled agent
const agent = globalPool.getAgent(url);

// Rate limit per domain
const limiter = getRateLimiterForDomain('example.com');
const delay = limiter.acquire(1);
if (delay > 0) {
  await new Promise(r => setTimeout(r, delay));
}
```

### 5. Enhanced Anti-Detection (`server/anti-detection.js`)

Sophisticated detection evasion and anti-bot bypass techniques.

#### Features:
- **Random User Agents**: Rotating user agent strings for multiple browsers
- **Header Randomization**: Randomized request headers
- **WebRTC Leak Prevention**: Blocks WebRTC IP leaks
- **Canvas Fingerprint Randomization**: Randomizes canvas data
- **WebGL Fingerprint Randomization**: Randomizes WebGL renderer
- **Navigator Properties**: Randomizes hardware concurrency, plugins
- **DevTools Detection Avoidance**: Optional DevTools blocker
- **Timing Randomization**: Adds micro-delays to desynchronize pattern analysis
- **Chrome Property Hiding**: Removes detectable chrome properties

#### Client-Side Injection:
The proxy automatically injects anti-detection scripts into HTML:
```javascript
import AntiDetection from './anti-detection.js';

// Inject into HTML
const script = AntiDetection.injectAntiDetectionScript();
html = html.replace('</head>', `<script>${script}</script></head>`);
```

### 6. Enhanced CAPTCHA Support (`server/captcha-handler.js`)

Extended CAPTCHA provider support for better compatibility.

#### Supported Providers:
- Google reCAPTCHA (v2, v3, Enterprise)
- hCaptcha
- Cloudflare Turnstile
- AWS WAF
- Imperva/Incapsula
- Arkose (Captcha)
- Friendly Captcha
- Generic challenge patterns

#### Detection Improvements:
- Expanded HTML indicator detection
- Pattern-based URL matching
- Domain-based detection
- Generic challenge pattern recognition

### 7. Error Handling & Recovery (`server/error-handler.js`)

Robust error handling with automatic recovery.

#### Features:
- **Automatic Retries**: Exponential backoff with jitter
- **Retryable Status Codes**: 408, 429, 500, 502, 503, 504
- **User-Friendly Error Pages**: Beautiful error UI
- **Connection Error Recovery**: Specific handling for connection failures
- **Timeout Recovery**: Request timeout handling
- **Error Logging**: Tracks error patterns

#### Usage:
```javascript
import { ErrorHandler, RequestRetry } from './error-handler.js';

// Automatic retry with exponential backoff
const retry = new RequestRetry({ maxAttempts: 3 });
try {
  const response = await retry.execute(() => makeRequest(url));
} catch (error) {
  ErrorHandler.handleProxyError(error, res);
}
```

## Configuration Best Practices

### For High-Traffic Scenarios
```javascript
// Increase connection limits
const pool = new ConnectionPool({
  maxSockets: 500,
  maxFreeSockets: 100,
  timeout: 60000,
});

// Increase cache size
// Note: Modify CACHE_SIZE_LIMIT in response-cache.js
```

### For Stealth Browsing
```javascript
// Enable anti-detection features
const headers = AntiDetection.generateRandomHeaders();
// Inject DevTools detection
const script = AntiDetection.injectDevToolsDetection();
```

### For Streaming Services
```javascript
// Use streaming handler
if (shouldHandleStreaming(hostname)) {
  // Apply streaming-specific rewriting
  html = rewriteStreamingHtml(html, baseUrl);
}
```

## Integration Examples

### Adding Custom Domain Handler
```javascript
// In domain-handlers.js
DOMAIN_HANDLERS['mysite.com'] = {
  preserveAuth: true,
  handleJsonApi: true,
  handleStreaming: false,
  handleWebsockets: false,
  handleForms: true,
};
```

### Custom Caching Policy
```javascript
// Override default cache duration
const ttl = isHighBandwidthDomain(hostname) 
  ? 7200000  // 2 hours for video sites
  : 3600000; // 1 hour default

ResponseCache.set('GET', url, response, ttl);
```

### Custom Rate Limiting per Domain
```javascript
// Tighter rate limiting for sensitive APIs
const limiter = getRateLimiterForDomain(hostname);
if (isHighBandwidthDomain(hostname)) {
  // More lenient for streaming
  limiter.requestsPerSecond = 100;
} else {
  // Stricter for regular sites
  limiter.requestsPerSecond = 20;
}
```

## Performance Metrics

### Cache Efficiency
Monitor cache performance:
```javascript
const stats = ResponseCache.getStats();
console.log(`Cache: ${stats.entries} entries, ${stats.sizeMb}/${stats.limitMb} MB`);
```

### Connection Pool Stats
Monitor connection usage:
```javascript
const poolStats = globalPool.getStats();
console.log(`Connections: ${poolStats.httpSockets} HTTP, ${poolStats.httpsSockets} HTTPS`);
```

## Troubleshooting

### Sites Not Loading Correctly
1. Check if domain-specific handler needs to be added
2. Verify CSS/JS rewriting is working: check browser console for 404s
3. Enable request/response logging to diagnose issues

### High Memory Usage
1. Reduce CACHE_SIZE_LIMIT in response-cache.js
2. Reduce maxSockets in connection pool
3. Clear cache periodically: `ResponseCache.clear()`

### Slow Performance
1. Enable response caching for applicable sites
2. Increase maxSockets for high-traffic domains
3. Check rate limiter isn't throttling legitimate requests

### Detection/Bot Blocking
1. Enable anti-detection scripts
2. Randomize user agents more frequently
3. Add header randomization to requests
4. Check for WebRTC leaks

## Future Improvements

- [ ] WebRTC proxy support
- [ ] JavaScript execution sandbox
- [ ] Advanced image proxy with compression
- [ ] DNS-over-HTTPS support
- [ ] HTTP/3 QUIC support
- [ ] Machine learning-based anti-detection
- [ ] Database-backed session persistence
- [ ] Load balancing across multiple proxy instances
