/**
 * Site-specific configurations for optimal proxy evasion.
 * Each entry tunes headers, retry strategy and delays for that domain.
 */

export const SITE_CONFIGS = {
  // ── Search Engines ──────────────────────────────────────────────────────
  'duckduckgo.com': {
    name: 'DuckDuckGo',
    retryLimit: 3,
    strategy: 'clean',
    // DDG scores bots by header consistency, TLS fingerprint and cookie presence.
    // Key requirements: correct sec-ch-ua, sec-gpc, no referer on direct nav.
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-gpc': '1',
      'dnt': '1',
    },
    // Never inject a google.com referer — DDG is itself a search engine
    noBypassHeaders: true,
    delays: [200, 500, 1000],
  },
  'google.com': {
    name: 'Google',
    retryLimit: 2,
    strategy: 'clean',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    noBypassHeaders: true,
    delays: [300, 800],
  },
  'bing.com': {
    name: 'Bing',
    retryLimit: 3,
    strategy: 'clean',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    noBypassHeaders: true,
    delays: [200, 500],
  },
  'yahoo.com': {
    name: 'Yahoo',
    retryLimit: 3,
    strategy: 'clean',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    noBypassHeaders: true,
    delays: [200, 500],
  },

  // ── Social / Community ───────────────────────────────────────────────────
  'reddit.com': {
    name: 'Reddit',
    retryLimit: 5,
    strategy: 'aggressive',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-gpc': '1',
      'dnt': '1',
    },
    delays: [50, 100, 200, 300, 500],
  },
  'discord.com': {
    name: 'Discord',
    retryLimit: 3,
    strategy: 'moderate',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    delays: [100, 300, 600],
  },
  'twitter.com': {
    name: 'Twitter/X',
    retryLimit: 4,
    strategy: 'adaptive',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    delays: [75, 150, 250, 350],
  },
  'x.com': {
    name: 'X (Twitter)',
    retryLimit: 4,
    strategy: 'adaptive',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    delays: [75, 150, 250, 350],
  },

  // ── Video / Media ────────────────────────────────────────────────────────
  'youtube.com': {
    name: 'YouTube',
    retryLimit: 3,
    strategy: 'clean',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    noBypassHeaders: true,
    delays: [100, 300, 600],
  },
  'twitch.tv': {
    name: 'Twitch',
    retryLimit: 3,
    strategy: 'moderate',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    delays: [100, 300, 600],
  },

  // ── Dev / Tech ───────────────────────────────────────────────────────────
  'github.com': {
    name: 'GitHub',
    retryLimit: 3,
    strategy: 'clean',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    noBypassHeaders: true,
    delays: [100, 300, 600],
  },
  'stackoverflow.com': {
    name: 'Stack Overflow',
    retryLimit: 5,
    strategy: 'moderate',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'cache-control': 'no-cache',
    },
    delays: [50, 150, 250, 350, 450],
  },
  'wikipedia.org': {
    name: 'Wikipedia',
    retryLimit: 4,
    strategy: 'gentle',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    delays: [100, 200, 300, 400],
  },

  // ── Shopping / Commerce ──────────────────────────────────────────────────
  'ebay.com': {
    name: 'eBay',
    retryLimit: 3,
    strategy: 'ratelimit',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    delays: [200, 500, 1000],
  },
  'amazon.com': {
    name: 'Amazon',
    retryLimit: 3,
    strategy: 'moderate',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    delays: [200, 500, 1000],
  },
};

export function getSiteConfig(hostname) {
  if (!hostname) return null;
  if (SITE_CONFIGS[hostname]) return SITE_CONFIGS[hostname];
  // Try base domain (www.reddit.com → reddit.com)
  const parts = hostname.split('.');
  if (parts.length > 2) {
    const base = parts.slice(-2).join('.');
    if (SITE_CONFIGS[base]) return SITE_CONFIGS[base];
  }
  return null;
}

export function getRetryDelay(hostname, retryDepth) {
  const config = getSiteConfig(hostname);
  if (!config?.delays) return 100 + Math.random() * 300;
  const base = retryDepth < config.delays.length
    ? config.delays[retryDepth]
    : config.delays[config.delays.length - 1];
  return base + (Math.random() - 0.5) * base * 0.2;
}

export function getSiteSpecificHeaders(hostname) {
  return getSiteConfig(hostname)?.headers || {};
}

export function getRetryStrategy(hostname) {
  return getSiteConfig(hostname)?.strategy || 'standard';
}

export function getMaxRetries(hostname) {
  return getSiteConfig(hostname)?.retryLimit ?? 3;
}

/**
 * True for sites where injecting a fake `referer: https://google.com` or
 * other content-filter bypass headers would look suspicious.
 */
export function noBypassHeaders(hostname) {
  return getSiteConfig(hostname)?.noBypassHeaders === true;
}
