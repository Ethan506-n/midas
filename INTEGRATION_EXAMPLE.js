/**
 * Router Integration Example
 * Shows how to integrate all enhancement modules into the main router.js
 * 
 * To use these improvements, add the following imports and modifications to router.js
 */

// ============================================================================
// ADD THESE IMPORTS TO router.js
// ============================================================================

// import { rewriteStreamingHtml, rewriteJsonResponse, rewriteJavaScriptUrls, rewriteApiEndpoints, sanitizeResponseHeaders } from './content-handler.js';
// import { getDomainHandler, shouldPreserveAuthentication, shouldHandleJsonApi, isHighBandwidthDomain } from './domain-handlers.js';
// import { ResponseCache, shouldCacheResponse, extractCacheTTL } from './response-cache.js';
// import { globalPool, getRateLimiterForDomain } from './connection-pool.js';
// import AntiDetection from './anti-detection.js';
// import { ErrorHandler, RequestRetry } from './error-handler.js';

// ============================================================================
// REPLACE EXISTING AGENT INITIALIZATION
// ============================================================================

// REMOVE:
// const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000, freeSocketTimeout: 30000 });
// const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000, freeSocketTimeout: 30000 });

// REPLACE WITH:
// const agent = globalPool;

// ============================================================================
// ENHANCED REQUEST HANDLER EXAMPLE
// ============================================================================

function createEnhancedRequestHandler(router) {
  return async (req, res, url, targetUrl) => {
    try {
      const hostname = new URL(targetUrl).hostname;
      const requestUrl = req.originalUrl || url.href;

      // 1. CHECK CACHE FIRST
      const cacheKey = `${req.method}:${targetUrl}`;
      const cachedResponse = ResponseCache.get(req.method, targetUrl);
      if (cachedResponse) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(cachedResponse.data);
        return;
      }

      // 2. APPLY RATE LIMITING
      const limiter = getRateLimiterForDomain(hostname);
      const delay = limiter.acquire(1);
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }

      // 3. CHECK ANTI-BOT DETECTION
      if (AntiDetection.shouldBlockRequest(req.headers)) {
        return ErrorHandler.handleProxyError(
          { statusCode: 403, message: 'Suspicious request detected' },
          res
        );
      }

      // 4. PREPARE ENHANCED HEADERS
      const enhancedHeaders = {
        ...req.headers,
        ...AntiDetection.generateRandomHeaders(),
      };
      delete enhancedHeaders['host'];
      delete enhancedHeaders['connection'];
      delete enhancedHeaders['content-length'];

      // 5. CREATE RETRY LOGIC
      const retry = new RequestRetry({ maxAttempts: 3 });

      // 6. MAKE REQUEST WITH RETRY
      let response;
      try {
        response = await retry.execute(async () => {
          return new Promise((resolve, reject) => {
            const protocol = targetUrl.startsWith('https://') ? https : http;
            const agent = globalPool.getAgent(targetUrl);
            
            const options = {
              method: req.method,
              headers: enhancedHeaders,
              agent: agent,
              timeout: 30000,
            };

            const proxyReq = protocol.request(new URL(targetUrl), options, (proxyRes) => {
              resolve(proxyRes);
            });

            proxyReq.on('error', reject);
            proxyReq.on('timeout', () => {
              proxyReq.destroy();
              reject(new Error('Request timeout'));
            });

            if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
              req.pipe(proxyReq);
            } else {
              proxyReq.end();
            }
          });
        });
      } catch (error) {
        return ErrorHandler.handleProxyError(error, res);
      }

      // 7. PROCESS RESPONSE
      const statusCode = response.statusCode || 200;
      const contentType = response.headers['content-type'] || '';
      let responseBody = '';

      response.on('data', chunk => {
        responseBody += chunk.toString();
      });

      response.on('end', async () => {
        try {
          // 8. HANDLE REDIRECTS
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            const location = response.headers['location'];
            const redirectUrl = location.startsWith('http')
              ? location
              : new URL(location, targetUrl).href;
            res.writeHead(statusCode, {
              'location': toProxyUrl(redirectUrl),
            });
            res.end();
            return;
          }

          // 9. SANITIZE HEADERS
          const sanitizedHeaders = sanitizeResponseHeaders(response.headers);

          // 10. REWRITE CONTENT BASED ON TYPE
          if (contentType.includes('text/html')) {
            // Apply streaming support
            responseBody = rewriteStreamingHtml(responseBody, targetUrl);
            
            // Apply API endpoint rewriting
            responseBody = rewriteApiEndpoints(responseBody, targetUrl);
            
            // Inject anti-detection script
            if (shouldHandleJsonApi(hostname)) {
              const antiDetectScript = AntiDetection.injectAntiDetectionScript();
              responseBody = responseBody.replace(
                '</head>',
                `<script>${antiDetectScript}</script></head>`
              );
            }

            sanitizedHeaders['content-length'] = Buffer.byteLength(responseBody);
          } else if (contentType.includes('application/json')) {
            // Rewrite JSON APIs
            if (shouldHandleJsonApi(hostname)) {
              responseBody = rewriteJsonResponse(responseBody, targetUrl);
              sanitizedHeaders['content-length'] = Buffer.byteLength(responseBody);
            }
          } else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
            // Rewrite JavaScript
            responseBody = rewriteJavaScriptUrls(responseBody, targetUrl);
            sanitizedHeaders['content-length'] = Buffer.byteLength(responseBody);
          }

          // 11. CACHE IF APPLICABLE
          if (shouldCacheResponse(statusCode, response.headers, targetUrl)) {
            const ttl = extractCacheTTL(response.headers);
            ResponseCache.set(req.method, targetUrl, responseBody, ttl);
          }

          // 12. SEND RESPONSE
          res.writeHead(statusCode, sanitizedHeaders);
          res.end(responseBody);

        } catch (error) {
          ErrorHandler.handleProxyError(error, res);
        }
      });

      response.on('error', (error) => {
        ErrorHandler.handleConnectionError(res, error.message);
      });

    } catch (error) {
      ErrorHandler.handleProxyError(error, res);
    }
  };
}

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

function createHealthCheckEndpoint() {
  return (req, res) => {
    const stats = {
      cache: ResponseCache.getStats(),
      connections: globalPool.getStats(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
  };
}

// ============================================================================
// USAGE IN MAIN ROUTER
// ============================================================================

// In your main router.js request handler:
/*
if (matchPolymorphicPath(pathname, currentPaths.browse)) {
  const handler = createEnhancedRequestHandler(router);
  return handler(req, res, url, targetUrl);
}

if (pathname === '/_midas/health') {
  return createHealthCheckEndpoint()(req, res);
}
*/

export { createEnhancedRequestHandler, createHealthCheckEndpoint };
