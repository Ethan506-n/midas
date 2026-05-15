/**
 * Advanced IP and proxy spoofing to evade detection
 */

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
 * Makes request appear to come through multiple proxies
 */
export function generateProxyHeaders() {
  // Generate random IPs that appear to be proxy chain
  const generateRandomIp = () => {
    const octet = () => Math.floor(Math.random() * 256);
    return `${octet()}.${octet()}.${octet()}.${octet()}`;
  };

  // Common ISP/proxy provider IP ranges (for realism)
  const commonRanges = [
    '203.',  // APNIC
    '210.',  // APNIC
    '211.',  // APNIC
    '202.',  // Asian networks
    '61.',   // Australian networks
    '101.',  // Japanese networks
  ];

  const proxyIp = (commonRanges[Math.floor(Math.random() * commonRanges.length)] +
    `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`);

  const clientIp = generateRandomIp();
  const originatingIp = generateRandomIp();

  return {
    'x-forwarded-for': `${clientIp}, ${proxyIp}`,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'proxy.relay.com',
    'x-real-ip': proxyIp,
    'cf-connecting-ip': clientIp,
    'client-ip': proxyIp,
    'x-originating-ip': `[${originatingIp}]`,
    'x-forwarded-by': 'proxy-gateway-1',
    'x-forwarded-server': 'proxy-server-2',
    'via': '1.1 proxy-relay:8080 (HTTP/1.1 GWA), 1.1 edge-cache:3128',
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
  return (
    lower.includes('bot') && lower.includes('detect') ||
    lower.includes('automated') ||
    lower.includes('javascript required') && lower.includes('access') ||
    lower.includes('unusual traffic') ||
    lower.includes('please enable javascript')
  );
}

/**
 * Get headers for bypassing Cloudflare
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
    // Additional signals
    'dnt': '1',
    'sec-gpc': '1',
  };
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
 * Rotate through different browser profiles
 */
const BROWSER_PROFILES = [
  {
    name: 'Chrome Windows 10',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Windows',
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
  },
  {
    name: 'Edge Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    platform: 'Windows',
  },
];

export function getRandomBrowserProfile() {
  return BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)];
}

/**
 * Get anti-detection headers for specific depth/attempt
 */
export function getEnhancedAntiDetectionHeaders(depth = 0) {
  const profile = getRandomBrowserProfile();
  
  const headers = {
    'user-agent': profile.ua,
    ...getCloudflareBypassHeaders(),
    ...generateProxyHeaders(),
  };

  // Vary headers based on retry depth to avoid patterns
  if (depth > 0) {
    headers['cache-control'] = depth > 1 ? 'no-cache' : 'max-age=0';
    if (depth > 1) {
      headers['pragma'] = 'no-cache';
      headers['expires'] = '0';
    }
  }

  return headers;
}
