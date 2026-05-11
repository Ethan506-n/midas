/**
 * Rate Limiter & Connection Pool Manager
 * Prevents proxy from getting rate-limited/blocked by origin servers
 * Implements token bucket rate limiting + connection pooling
 */

import http from 'http';
import https from 'https';

// Per-domain rate limiters (token bucket)
const domainLimiters = new Map();

// Per-domain connection pools
const domainPools = new Map();

// Global tracking
const stats = {
  requestsProcessed: 0,
  requestsRateLimited: 0,
  connectionErrors: 0,
};

/**
 * Token Bucket Rate Limiter
 * - Allows bursts but enforces average rate
 * - Default: 20 requests/second per domain
 */
class TokenBucket {
  constructor(rps = 20, burstSize = 50) {
    this.rps = rps; // requests per second
    this.burstSize = burstSize;
    this.tokens = burstSize;
    this.lastRefill = Date.now();
  }

  // Add tokens based on time elapsed
  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burstSize, this.tokens + elapsed * this.rps);
    this.lastRefill = now;
  }

  // Acquire token, return wait time in ms
  acquire(count = 1) {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return 0;
    }
    const needed = count - this.tokens;
    const waitTime = (needed / this.rps) * 1000;
    this.tokens = 0;
    return Math.ceil(waitTime);
  }
}

/**
 * Connection Pool Manager
 * - Keeps HTTP/HTTPS connections alive
 * - Limits concurrent connections per domain
 */
class ConnectionPool {
  constructor(maxPerDomain = 8) {
    this.maxPerDomain = maxPerDomain;
    this.agents = {
      http: new http.Agent({
        keepAlive: true,
        maxSockets: maxPerDomain,
        maxFreeSockets: 4,
        timeout: 60000,
      }),
      https: new https.Agent({
        keepAlive: true,
        maxSockets: maxPerDomain,
        maxFreeSockets: 4,
        timeout: 60000,
        rejectUnauthorized: false,
      }),
    };
  }

  getAgent(isHttps) {
    return isHttps ? this.agents.https : this.agents.http;
  }
}

// Get or create rate limiter for domain
export function getRateLimiter(domain) {
  if (!domainLimiters.has(domain)) {
    domainLimiters.set(domain, new TokenBucket());
  }
  return domainLimiters.get(domain);
}

// Get or create connection pool for domain
export function getConnectionPool(domain) {
  if (!domainPools.has(domain)) {
    domainPools.set(domain, new ConnectionPool());
  }
  return domainPools.get(domain);
}

// Check if should rate limit
export async function checkRateLimit(domain) {
  const limiter = getRateLimiter(domain);
  const waitTime = limiter.acquire(1);
  
  if (waitTime > 0) {
    stats.requestsRateLimited++;
    // Wait before allowing request
    await new Promise(r => setTimeout(r, waitTime));
  }
  
  stats.requestsProcessed++;
  return waitTime;
}

// Get agent for domain
export function getAgent(domain, isHttps) {
  const pool = getConnectionPool(domain);
  return pool.getAgent(isHttps);
}

// Track connection error (increases rate limit)
export function trackConnectionError(domain) {
  stats.connectionErrors++;
  const limiter = getRateLimiter(domain);
  
  // Reduce rate on errors (half previous rate)
  limiter.rps = Math.max(1, limiter.rps / 2);
  limiter.burstSize = Math.max(5, limiter.burstSize / 2);
  
  // Exponential backoff
  limiter.lastRefill = Date.now() + 1000;
}

// Get stats
export function getStats() {
  const limiters = {};
  for (const [domain, limiter] of domainLimiters) {
    limiters[domain] = {
      rps: limiter.rps,
      currentTokens: Math.round(limiter.tokens * 100) / 100,
      burstSize: limiter.burstSize,
    };
  }
  
  return {
    ...stats,
    domainLimiters: limiters,
  };
}

// Reset stats
export function resetStats() {
  stats.requestsProcessed = 0;
  stats.requestsRateLimited = 0;
  stats.connectionErrors = 0;
}
