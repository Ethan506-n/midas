/**
 * Rate Limiter & Connection Pool Manager
 * Prevents proxy from getting rate-limited/blocked by origin servers.
 * Token bucket per domain + per-domain HTTPS/HTTP connection pools.
 */

import http from 'http';
import https from 'https';

const domainLimiters = new Map();
const domainPools    = new Map();

const stats = {
  requestsProcessed:   0,
  requestsRateLimited: 0,
  connectionErrors:    0,
};

/**
 * Token Bucket Rate Limiter
 * Default: 30 req/s with a burst of 80 — tuned for a single-user proxy
 * where bursts (page with 40 sub-resources) are normal.
 */
class TokenBucket {
  constructor(rps = 30, burstSize = 80) {
    this.rps       = rps;
    this.burstSize = burstSize;
    this.tokens    = burstSize;
    this.lastRefill = Date.now();
  }

  refill() {
    const now     = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens   = Math.min(this.burstSize, this.tokens + elapsed * this.rps);
    this.lastRefill = now;
  }

  // Returns ms to wait (0 = proceed immediately)
  acquire() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const waitMs = ((1 - this.tokens) / this.rps) * 1000;
    this.tokens = 0;
    return Math.ceil(waitMs);
  }
}

/**
 * Per-domain HTTPS/HTTP agent pool.
 * Larger socket counts avoid head-of-line blocking on pages with many assets.
 */
class ConnectionPool {
  constructor() {
    this.http = new http.Agent({
      keepAlive:        true,
      maxSockets:       24,
      maxFreeSockets:   8,
      timeout:          30000,
      freeSocketTimeout: 15000,
      scheduling:       'lifo',   // Reuse hot sockets first
    });
    this.https = new https.Agent({
      keepAlive:        true,
      maxSockets:       24,
      maxFreeSockets:   8,
      timeout:          30000,
      freeSocketTimeout: 15000,
      scheduling:       'lifo',
      rejectUnauthorized: false,
    });
  }

  getAgent(isHttps) {
    return isHttps ? this.https : this.http;
  }
}

export function getRateLimiter(domain) {
  if (!domainLimiters.has(domain)) domainLimiters.set(domain, new TokenBucket());
  return domainLimiters.get(domain);
}

export function getConnectionPool(domain) {
  if (!domainPools.has(domain)) domainPools.set(domain, new ConnectionPool());
  return domainPools.get(domain);
}

export async function checkRateLimit(domain) {
  const limiter  = getRateLimiter(domain);
  const waitTime = limiter.acquire();
  if (waitTime > 0) {
    stats.requestsRateLimited++;
    await new Promise(r => setTimeout(r, waitTime));
  }
  stats.requestsProcessed++;
  return waitTime;
}

export function getAgent(domain, isHttps) {
  return getConnectionPool(domain).getAgent(isHttps);
}

// Back off on repeated errors (halve rate, pause briefly)
export function trackConnectionError(domain) {
  stats.connectionErrors++;
  const limiter = getRateLimiter(domain);
  limiter.rps       = Math.max(2, limiter.rps / 2);
  limiter.burstSize = Math.max(5, limiter.burstSize / 2);
  limiter.lastRefill = Date.now() + 1000;
}

export function getStats() {
  const limiters = {};
  for (const [domain, l] of domainLimiters) {
    limiters[domain] = { rps: l.rps, tokens: Math.round(l.tokens * 10) / 10, burst: l.burstSize };
  }
  return { ...stats, domains: limiters };
}

export function resetStats() {
  stats.requestsProcessed   = 0;
  stats.requestsRateLimited = 0;
  stats.connectionErrors    = 0;
}
