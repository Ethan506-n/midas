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
 * Detect Cloudflare Error 1000 ("DNS points to prohibited IP") pages specifically.
 * This is NOT a solvable JS challenge — it means Cloudflare's edge is rejecting the
 * datacenter IP.  We need a different retry strategy (clean headers, no proxy artifacts)
 * rather than the normal challenge retry which adds proxy-announcing headers and
 * makes things worse.
 */
export function isCloudflareError1000(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  return (
    (lower.includes('error 1000') || lower.includes('error&nbsp;1000')) ||
    lower.includes('dns points to prohibited ip') ||
    (lower.includes('prohibited ip') && lower.includes('cloudflare')) ||
    (lower.includes('1000') && lower.includes('dns') && lower.includes('cloudflare'))
  );
}

/**
 * Detect Cloudflare INTERSTITIAL challenge pages (IUAM / JS challenge / Turnstile).
 * Deliberately excludes Error 1000 (handled separately) and regular pages that merely
 * EMBED a Turnstile widget (e.g. dash.cloudflare.com/login with status 200) — those
 * are real content pages and must be rendered normally, not treated as a challenge.
 *
 * @param {string} html - Response body
 * @param {number} [statusCode=200] - HTTP status code of the response
 */
export function isCloudflareChallenge(html, statusCode = 200) {
  if (!html || typeof html !== 'string') return false;
  if (isCloudflareError1000(html)) return false;

  const lower = html.toLowerCase();

  // Old IUAM math challenge — always an interstitial, always qualifies.
  if (lower.includes('chk_jschl') || lower.includes('jschl_vc')) return true;

  // CF's interstitial-specific JS variable — never present in regular pages.
  if (lower.includes('window._cf_chl_opt') || lower.includes('window.__cf$cv$params')) return true;

  // "Just a moment…" is CF's canonical interstitial title.
  if (lower.includes('just a moment') && lower.includes('cloudflare')) return true;

  // Modern managed / Turnstile interstitials come with a 403 or 503.
  // A 200 page that embeds Turnstile (e.g. a login form) is NOT an interstitial.
  if (statusCode === 403 || statusCode === 503) {
    if (lower.includes('cf-challenge') || lower.includes('orchestrate/managed')) return true;
    if (lower.includes('checking your browser')) return true;
    if (lower.includes('challenge-platform') && lower.includes('cloudflare')) return true;
  }

  return false;
}

/**
 * All header names that identify a request as coming from a proxy or
 * datacenter.  Cloudflare's bot management scores these heavily —
 * sending them actively worsens the block.  Strip them before every
 * outgoing upstream request.
 */
const PROXY_HEADER_NAMES = new Set([
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-by',
  'x-forwarded-server',
  'x-forwarded-for-original',
  'x-real-ip',
  'x-originating-ip',
  'x-client-ip',
  'client-ip',
  'cf-connecting-ip',
  'via',
  'forwarded',
  'x-cluster-client-ip',
  'proxy-connection',
  'x-proxy-id',
  'x-bluemix-client-ip',
]);

export function stripProxyHeaders(headers) {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    if (PROXY_HEADER_NAMES.has(k.toLowerCase())) delete out[k];
  }
  return out;
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
  // 403 Forbidden is almost always a bot block in proxy scenarios
  if (statusCode === 403) {
    // Small response or known bot detection page
    if (!html || html.length < 500 || isBotDetectionPage(html)) return true;
    // If response is HTML and not too large, treat as bot block
    // (legitimate 403s in proxy contexts are rare)
    if (html && html.toLowerCase().includes('<!doctype') && html.length < 10000) return true;
  }
  
  // Check for robot/bot headers
  const cacheControl = (headers['cache-control'] || '').toLowerCase();
  if (cacheControl.includes('no-cache') && statusCode === 403) {
    return true;
  }
  
  return false;
}

/**
 * Get headers for bypassing Cloudflare with enhanced fingerprinting.
 * Uses current Chrome 136 stable UA/sec-ch-ua so version strings are consistent.
 */
export function getCloudflareBypassHeaders() {
  const CV = '136';
  const CVF = '136.0.7103.114';
  return {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'max-age=0',
    'sec-ch-ua': `"Google Chrome";v="${CV}", "Chromium";v="${CV}", "Not/A)Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"15.0.0"',
    'sec-ch-ua-full-version-list': `"Google Chrome";v="${CVF}", "Chromium";v="${CVF}", "Not/A)Brand";v="99.0.0.0"`,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'priority': 'u=0, i',
  };
}

/**
 * Generate enhanced headers with site-specific variations.
 * Proxy-identifying headers (x-forwarded-for, via, cf-connecting-ip, etc.) are
 * intentionally never added here — Cloudflare's bot management scores them heavily
 * and adding them on retries made things worse, not better.
 */
export function getEnhancedHeadersForSite(hostname, depth = 0) {
  const profile = getRandomBrowserProfile();
  const headers = {
    'user-agent': profile.ua,
    ...getCloudflareBypassHeaders(),
    'cache-control': 'max-age=0',
  };
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
 * Browser profiles — all kept on current Chrome 136 / Firefox 138 stable
 * (May 2026 releases) so User-Agent and sec-ch-ua always match.
 */
const BROWSER_PROFILES = [
  {
    name: 'Chrome 136 Windows 11',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    platform: 'Windows',
    isChrome: true,
  },
  {
    name: 'Chrome 136 macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    platform: 'macOS',
    isChrome: true,
  },
  {
    name: 'Chrome 136 Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    platform: 'Linux',
    isChrome: true,
  },
  {
    name: 'Edge 136 Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
    platform: 'Windows',
    isChrome: true,
    isEdge: true,
  },
  {
    name: 'Firefox 138 Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
    platform: 'Windows',
    isChrome: false,
  },
  {
    name: 'Firefox 138 macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:138.0) Gecko/20100101 Firefox/138.0',
    platform: 'macOS',
    isChrome: false,
  },
  {
    name: 'Safari 18 macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    platform: 'macOS',
    isChrome: false,
  },
];

export function getRandomBrowserProfile() {
  return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

/**
 * Get anti-detection headers for a request.
 * Proxy-identifying headers (x-forwarded-for, via, etc.) are NEVER added here —
 * they are the primary signal bot-detection systems use to score proxy traffic.
 * The depth argument is kept for API compatibility but no longer changes the
 * header set in a proxy-announcing way.
 */
export function getEnhancedAntiDetectionHeaders(depth = 0, hostname = '') {
  return getEnhancedHeadersForSite(hostname, depth);
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
