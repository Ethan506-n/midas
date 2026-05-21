/**
 * Site-specific configurations for optimal proxy evasion
 * Each site may have different bot detection strategies
 */

export const SITE_CONFIGS = {
  'reddit.com': {
    name: 'Reddit',
    retryLimit: 5,
    strategy: 'aggressive',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'dnt': '1',
      'sec-gpc': '1',
    },
    delays: [50, 100, 200, 300, 500],
  },
  'stackoverflow.com': {
    name: 'Stack Overflow',
    retryLimit: 5,
    strategy: 'moderate',
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
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
};

export function getSiteConfig(hostname) {
  // Try exact match first
  if (SITE_CONFIGS[hostname]) {
    return SITE_CONFIGS[hostname];
  }
  
  // Try domain match (e.g., www.reddit.com -> reddit.com)
  const parts = hostname.split('.');
  if (parts.length > 2) {
    const domain = parts.slice(-2).join('.');
    if (SITE_CONFIGS[domain]) {
      return SITE_CONFIGS[domain];
    }
  }
  
  return null;
}

export function getRetryDelay(hostname, retryDepth) {
  const config = getSiteConfig(hostname);
  if (!config || !config.delays) {
    return 100 + Math.random() * 400; // Default random delay
  }
  
  if (retryDepth < config.delays.length) {
    // Add randomness to avoid detection of automated patterns
    const baseDelay = config.delays[retryDepth];
    const variance = baseDelay * 0.2; // ±20% variance
    return baseDelay + (Math.random() - 0.5) * 2 * variance;
  }
  
  return config.delays[config.delays.length - 1];
}

export function getSiteSpecificHeaders(hostname) {
  const config = getSiteConfig(hostname);
  return config?.headers || {};
}

export function getRetryStrategy(hostname) {
  const config = getSiteConfig(hostname);
  return config?.strategy || 'standard';
}

export function getMaxRetries(hostname) {
  const config = getSiteConfig(hostname);
  return config?.retryLimit || 3;
}
