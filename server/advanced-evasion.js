/**
 * Advanced IP and proxy spoofing to evade detection
 */

import { createProxyChain } from './ip-provider.js';

// Common proxy headers that real proxies use
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-real-ip',
  'cf-connecting-ip',
  'client-ip',
  'x-client-ip',
  'x-forwarded-by',
  'x-forwarded-server',
  'x-forwarded-for-original',
];

/**
 * Generate realistic proxy/forwarding headers
 * Uses unique, unblocked IP ranges from ip-provider
 */
export function generateProxyHeaders() {
  // Use unique IP chain from ip-provider
  const proxyChain = createProxyChain(3);
  
  // Get the primary IP and proxy IPs
  const clientIp = proxyChain.primary;
  const proxyIps = proxyChain.ips;

  return {
    'x-forwarded-for': proxyChain.chain,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'proxy.relay.com',
    'x-real-ip': clientIp,
    'cf-connecting-ip': clientIp,
    'client-ip': clientIp,
    'x-originating-ip': `[${proxyIps[proxyIps.length - 1]}]`,
    'x-forwarded-by': `proxy-gateway-${Math.floor(Math.random() * 10)}`,
    'x-forwarded-server': `proxy-server-${Math.floor(Math.random() * 10)}`,
    'via': `1.1 proxy-relay:8080 (HTTP/1.1 GWA), 1.1 edge-cache:${3128 + Math.floor(Math.random() * 100)}`,
  };
}

/**
 * Detect Cloudflare challenge pages
 */
export function isCloudflareChallenge(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  return (
    lower.includes('challenge') ||
    lower.includes('checking your browser') ||
    lower.includes('cloudflare') ||
    lower.includes('ray id') ||
    lower.includes('cf_clearance') ||
    lower.includes('chk_jschl')
  );
}

/**
 * Detect bot detection pages
 */
export function isBotDetectionPage(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  const lowerTrimmed = lower.replace(/\s+/g, ' ').trim();
  
  // Reddit bot detection
  if (lowerTrimmed.includes('reddit') && (
    lower.includes('something went wrong') ||
    lower.includes('too many requests') ||
    lower.includes('you are doing that too much')
  )) return true;
  
  // StackOverflow bot detection  
  if (lowerTrimmed.includes('stackoverflow') && (
    lower.includes('access denied') ||
    lower.includes('robot') ||
    lower.includes('automated')
  )) return true;
  
  // Wikipedia bot detection
  if (lowerTrimmed.includes('wikipedia') && (
    lower.includes('suspicious activity') ||
    lower.includes('database locked') ||
    lower.includes('try again in a few hours')
  )) return true;
  
  // eBay bot detection
  if (lowerTrimmed.includes('ebay') && (
    lower.includes('temporary unavailable') ||
    lower.includes('suspicious activity') ||
    lower.includes('robot')
  )) return true;
  
  // Generic bot detection patterns
  return (
    (lower.includes('bot') && lower.includes('detect')) ||
    lower.includes('automated traffic') ||
    (lower.includes('javascript required') && lower.includes('access')) ||
    lower.includes('unusual traffic') ||
    lower.includes('please enable javascript')
  );
}

/**
 * Check if response is likely a bot block
 */
export function isLikelyBotBlock(statusCode, html, headers) {
  // 403 Forbidden with no content is a bot block
  if (statusCode === 403) {
    if (!html || html.length < 500) return true;
    if (isBotDetectionPage(html)) return true;
  }
  
  // Check for robot/bot headers
  const cacheControl = (headers['cache-control'] || '').toLowerCase();
  if (cacheControl.includes('no-cache') && statusCode === 403) {
    return true;
  }
  
  return false;
}

/**
 * Get headers for bypassing Cloudflare with enhanced fingerprinting
 */
export function getCloudflareBypassHeaders() {
  return {
    // Standard browser headers
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9,fr;q=0.8,de;q=0.7',
    'cache-control': 'max-age=0',
    'sec-ch-ua': '"Not A(Brand";v="99", "Chromium";v="96"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    // TLS indicators
    'tls-version': '1.3',
    // Fingerprinting evasion
    'sec-ch-ua-full-version-list': 'Not A(Brand";v="99.0.0.0", "Chromium";v="120.0.0.0"',
    'sec-ch-ua-platform-version': '"15.0"',
    'sec-ch-viewport-width': '1920',
    'sec-ch-viewport-height': '1080',
  };
}

/**
 * Generate enhanced headers with site-specific variations
 */
export function getEnhancedHeadersForSite(hostname, depth = 0) {
  const profile = getRandomBrowserProfile();
  const headers = {
    'user-agent': profile.ua,
    ...getCloudflareBypassHeaders(),
  };

  // Only add aggressive proxy headers on retries (depth > 0)
  if (depth > 0) {
    const proxyHeaders = generateProxyHeaders();
    if (depth === 1) {
      headers['x-forwarded-for'] = proxyHeaders['x-forwarded-for'];
      headers['x-real-ip'] = proxyHeaders['x-real-ip'];
      headers['via'] = proxyHeaders['via'];
    } else if (depth === 2) {
      headers['x-forwarded-for'] = proxyHeaders['x-forwarded-for'];
      headers['x-forwarded-proto'] = proxyHeaders['x-forwarded-proto'];
      headers['x-real-ip'] = proxyHeaders['x-real-ip'];
      headers['cf-connecting-ip'] = proxyHeaders['cf-connecting-ip'];
      headers['via'] = proxyHeaders['via'];
    } else {
      Object.assign(headers, proxyHeaders);
    }
    
    headers['cache-control'] = depth > 2 ? 'no-cache' : 'max-age=0';
    if (depth > 2) {
      headers['pragma'] = 'no-cache';
      headers['expires'] = '0';
    }
  } else {
    headers['cache-control'] = 'max-age=0';
  }

  return headers;
}

/**
 * Simulate real browser behavior delays
 */
export async function addBrowserDelay() {
  // Random delay between 100-500ms to simulate human behavior
  const delay = 100 + Math.random() * 400;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Rotate through different browser profiles with more variations
 */
const BROWSER_PROFILES = [
  {
    name: 'Chrome Windows 10',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Windows',
    chromeVersion: '120',
  },
  {
    name: 'Firefox Ubuntu',
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    platform: 'Linux',
  },
  {
    name: 'Safari macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    platform: 'macOS',
  },
  {
    name: 'Chrome macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'macOS',
    chromeVersion: '120',
  },
  {
    name: 'Edge Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    platform: 'Windows',
  },
  {
    name: 'Chrome Windows 11',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    platform: 'Windows',
    chromeVersion: '119',
  },
  {
    name: 'Firefox Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    platform: 'Windows',
  },
];

export function getRandomBrowserProfile() {
  return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

/**
 * Get anti-detection headers for specific depth/attempt
 */
export function getEnhancedAntiDetectionHeaders(depth = 0, hostname = '') {
  if (hostname) {
    return getEnhancedHeadersForSite(hostname, depth);
  }

  const profile = getRandomBrowserProfile();
  
  const headers = {
    'user-agent': profile.ua,
    ...getCloudflareBypassHeaders(),
  };

  // Only add aggressive proxy headers on retries (depth > 0)
  if (depth > 0) {
    const proxyHeaders = generateProxyHeaders();
    if (depth === 1) {
      headers['x-forwarded-for'] = proxyHeaders['x-forwarded-for'];
      headers['x-real-ip'] = proxyHeaders['x-real-ip'];
      headers['via'] = proxyHeaders['via'];
    } else if (depth === 2) {
      headers['x-forwarded-for'] = proxyHeaders['x-forwarded-for'];
      headers['x-forwarded-proto'] = proxyHeaders['x-forwarded-proto'];
      headers['x-real-ip'] = proxyHeaders['x-real-ip'];
      headers['cf-connecting-ip'] = proxyHeaders['cf-connecting-ip'];
      headers['via'] = proxyHeaders['via'];
    } else {
      Object.assign(headers, proxyHeaders);
    }
    
    headers['cache-control'] = depth > 2 ? 'no-cache' : 'max-age=0';
    if (depth > 2) {
      headers['pragma'] = 'no-cache';
      headers['expires'] = '0';
    }
  } else {
    headers['cache-control'] = 'max-age=0';
  }

  return headers;
}

/**
 * Adaptive delay based on site and retry depth
 */
export async function addAdaptiveDelay(hostname, retryDepth) {
  // Default adaptive delay
  let delayMs = 100 + Math.random() * 400;
  
  // Site-specific delays can be configured here if needed
  const delayMap = {
    'reddit.com': [50, 100, 200, 300, 500],
    'stackoverflow.com': [50, 150, 250, 350, 450],
    'wikipedia.org': [100, 200, 300, 400],
    'twitter.com': [75, 150, 250, 350],
    'x.com': [75, 150, 250, 350],
    'ebay.com': [200, 500, 1000],
  };
  
  // Check if we have a config for this site
  for (const [domain, delays] of Object.entries(delayMap)) {
    if (hostname.includes(domain)) {
      if (retryDepth < delays.length) {
        const baseDelay = delays[retryDepth];
        const variance = baseDelay * 0.2; // ±20% variance
        delayMs = baseDelay + (Math.random() - 0.5) * 2 * variance;
      } else {
        delayMs = delays[delays.length - 1];
      }
      break;
    }
  }
  
  return new Promise(resolve => setTimeout(resolve, delayMs));
}
