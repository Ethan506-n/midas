/**
 * Response Caching Layer — LRU eviction
 * Caches static assets and short-lived API responses to cut round-trips.
 */

class LRUResponseCache {
  constructor(maxBytes = 120 * 1024 * 1024) { // 120 MB
    this.maxBytes    = maxBytes;
    this.usedBytes   = 0;
    // Map preserves insertion order; we move hits to the end → tail = MRU
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  _key(method, url) { return `${method}:${url}`; }

  // Determine TTL from response headers and content-type.
  parseCacheTTL(cacheControl, contentType) {
    const cc = (cacheControl || '').toLowerCase();
    if (cc.includes('no-store') || cc.includes('no-cache') || cc.includes('private')) return 0;

    const maxAge = cc.match(/(?:s-maxage|max-age)=(\d+)/);
    if (maxAge) {
      // Cap CDN TTLs at 1 hour in the proxy cache
      return Math.min(parseInt(maxAge[1]) * 1000, 60 * 60 * 1000);
    }

    const ct = (contentType || '').toLowerCase();
    if (ct.includes('text/html'))           return  5 * 60 * 1000; // 5 min
    if (ct.includes('application/json'))    return  2 * 60 * 1000; // 2 min
    if (ct.includes('text/css'))            return 60 * 60 * 1000; // 1 h
    if (ct.includes('javascript'))          return 60 * 60 * 1000; // 1 h
    if (ct.includes('image/'))              return 60 * 60 * 1000; // 1 h
    if (ct.includes('font/'))               return  4 * 60 * 60 * 1000; // 4 h
    if (ct.includes('application/wasm'))    return 60 * 60 * 1000; // 1 h
    return 0;
  }

  shouldCache(statusCode, headers, _url, method = 'GET') {
    if (method !== 'GET') return false;
    if (statusCode < 200 || statusCode >= 400) return false;
    const cc = (headers['cache-control'] || '').toLowerCase();
    if (cc.includes('no-store') || cc.includes('no-cache') || cc.includes('private')) return false;
    // Don't cache set-cookie responses (session-specific)
    if (headers['set-cookie']) return false;
    return true;
  }

  set(method, url, data, ttl) {
    if (ttl <= 0) return;
    if (data.length > 20 * 1024 * 1024) return; // skip single files > 20 MB

    const key  = this._key(method, url);
    const size = data.length;

    // Remove existing entry if being replaced
    if (this.cache.has(key)) {
      this.usedBytes -= this.cache.get(key).size;
      this.cache.delete(key);
    }

    // LRU eviction: delete the least-recently-used (Map head) until we have room
    while (this.usedBytes + size > this.maxBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value;
      this.usedBytes -= this.cache.get(oldest).size;
      this.cache.delete(oldest);
      this.stats.evictions++;
    }

    if (this.usedBytes + size <= this.maxBytes) {
      this.cache.set(key, { data, size, expires: Date.now() + ttl });
      this.usedBytes += size;
    }
  }

  get(method, url) {
    const key   = this._key(method, url);
    const entry = this.cache.get(key);

    if (!entry) { this.stats.misses++; return null; }

    if (Date.now() > entry.expires) {
      this.usedBytes -= entry.size;
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // LRU: promote to tail on hit
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    return entry.data;
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate:  total > 0 ? (this.stats.hits / total * 100).toFixed(1) + '%' : '0%',
      usedMB:   (this.usedBytes / 1024 / 1024).toFixed(1),
      maxMB:    (this.maxBytes  / 1024 / 1024).toFixed(0),
      entries:  this.cache.size,
    };
  }

  clear() {
    this.cache.clear();
    this.usedBytes = 0;
  }
}

export const globalCache = new LRUResponseCache();

export const shouldCache   = (s, h, u, m)  => globalCache.shouldCache(s, h, u, m);
export const getCacheTTL   = (cc, ct)       => globalCache.parseCacheTTL(cc, ct);
export const getCached     = (m, u)         => globalCache.get(m, u);
export const setCached     = (m, u, d, ttl) => globalCache.set(m, u, d, ttl);
export const getCacheStats = ()             => globalCache.getStats();
export const clearCache    = ()             => globalCache.clear();
