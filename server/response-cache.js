/**
 * Response Caching Layer
 * Caches static assets and API responses to improve performance
 */

class ResponseCache {
  constructor() {
    this.cache = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
    };
    this.maxSize = 500 * 1024 * 1024; // 500MB
    this.currentSize = 0;
  }

  // Get cache key
  getKey(method, url) {
    return `${method}:${url}`;
  }

  // Parse Cache-Control header to get TTL
  parseCacheTTL(cacheControl, contentType) {
    if (!cacheControl) {
      // Default TTLs by content type
      if (contentType.includes('text/html')) return 5 * 60 * 1000; // 5 min
      if (contentType.includes('application/json')) return 5 * 60 * 1000; // 5 min
      if (contentType.includes('text/css')) return 24 * 60 * 60 * 1000; // 24h
      if (contentType.includes('javascript')) return 24 * 60 * 60 * 1000; // 24h
      if (contentType.includes('image/')) return 24 * 60 * 60 * 1000; // 24h
      if (contentType.includes('font/')) return 7 * 24 * 60 * 60 * 1000; // 7 days
      return 0; // Don't cache
    }

    // Parse max-age
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    if (maxAgeMatch) {
      return parseInt(maxAgeMatch[1]) * 1000;
    }

    // Parse s-maxage (CDN cache)
    const sMaxAgeMatch = cacheControl.match(/s-maxage=(\d+)/i);
    if (sMaxAgeMatch) {
      return Math.min(parseInt(sMaxAgeMatch[1]) * 1000, 24 * 60 * 60 * 1000);
    }

    return 0;
  }

  // Should cache response
  shouldCache(statusCode, headers, url, method = 'GET') {
    // Only cache GET requests
    if (method !== 'GET') return false;

    // Only cache successful responses
    if (statusCode < 200 || statusCode >= 400) return false;

    // Don't cache if explicitly disabled
    const cacheControl = (headers['cache-control'] || '').toLowerCase();
    if (cacheControl.includes('no-cache') || cacheControl.includes('no-store') || cacheControl.includes('private')) {
      return false;
    }

    return true;
  }

  // Store response in cache
  set(method, url, data, ttl) {
    if (ttl <= 0) return;
    if (data.length > 50 * 1024 * 1024) return; // Don't cache files > 50MB

    const key = this.getKey(method, url);
    const size = data.length;

    // Make room if needed
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      const [, entry] = this.cache.get(firstKey);
      this.currentSize -= entry.data.length;
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }

    // Only cache if it fits
    if (this.currentSize + size <= this.maxSize) {
      this.cache.set(key, [Date.now() + ttl, { data, size }]);
      this.currentSize += size;
    }
  }

  // Retrieve from cache
  get(method, url) {
    const key = this.getKey(method, url);
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    const [expiry, { data }] = entry;

    // Check if expired
    if (Date.now() > expiry) {
      this.currentSize -= data.length;
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return data;
  }

  // Get cache stats
  getStats() {
    return {
      ...this.stats,
      size: Math.round(this.currentSize / 1024 / 1024) + 'MB',
      entries: this.cache.size,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(1) + '%'
        : '0%',
    };
  }

  // Clear cache
  clear() {
    this.cache.clear();
    this.currentSize = 0;
  }
}

// Global cache instance
export const globalCache = new ResponseCache();

// Convenience functions
export function shouldCache(statusCode, headers, url, method) {
  return globalCache.shouldCache(statusCode, headers, url, method);
}

export function getCacheTTL(cacheControl, contentType) {
  return globalCache.parseCacheTTL(cacheControl, contentType);
}

export function getCached(method, url) {
  return globalCache.get(method, url);
}

export function setCached(method, url, data, ttl) {
  globalCache.set(method, url, data, ttl);
}

export function getCacheStats() {
  return globalCache.getStats();
}

export function clearCache() {
  globalCache.clear();
}
