/**
 * Residential IP Provider
 * Generates authentic-looking IPs from real US/EU residential ISP CIDR ranges.
 * Used to spoof CF-Connecting-IP / X-Forwarded-For so Cloudflare sees a home user.
 */

// Real residential ISP CIDR ranges (start, end octet3-ranges per /16 or wider block)
// Format: [firstOctet, secondOctetMin, secondOctetMax, provider, country]
const RESIDENTIAL_RANGES = [
  // Comcast / Xfinity (largest US residential ISP)
  [24,  0,  63,  'Comcast', 'US'],
  [73,  0, 127,  'Comcast', 'US'],
  [75, 128, 191, 'Comcast', 'US'],
  [98, 192, 255, 'Comcast', 'US'],

  // AT&T (residential broadband)
  [99,  0, 255, 'AT&T', 'US'],
  [107, 0, 255, 'AT&T', 'US'],

  // Verizon FiOS / DSL
  [71, 160, 175, 'Verizon', 'US'],
  [72,  64, 127, 'Verizon', 'US'],
  [108,  0,  63, 'Verizon', 'US'],

  // Charter / Spectrum
  [66, 175, 175, 'Spectrum', 'US'],
  [174, 192, 255, 'Spectrum', 'US'],
  [70,  64, 127, 'Spectrum', 'US'],

  // Cox Communications
  [68,   0,  63, 'Cox', 'US'],
  [174,  72,  79, 'Cox', 'US'],

  // Frontier Communications
  [66, 240, 255, 'Frontier', 'US'],
  [71,  80,  95, 'Frontier', 'US'],

  // CenturyLink / Lumen residential
  [66, 224, 239, 'CenturyLink', 'US'],
  [174,  16,  31, 'CenturyLink', 'US'],

  // T-Mobile Home Internet
  [172,  56,  63, 'T-Mobile', 'US'],

  // Google Fiber
  [174,   0,   7, 'GoogleFiber', 'US'],

  // BT Broadband (UK residential)
  [86,   0,  63, 'BT', 'GB'],
  [109, 144, 159, 'BT', 'GB'],

  // Sky Broadband (UK)
  [92,  24,  31, 'Sky', 'GB'],

  // Deutsche Telekom (Germany residential)
  [80, 128, 191, 'Telekom', 'DE'],
  [84, 128, 191, 'Telekom', 'DE'],

  // Free / Iliad (France)
  [82, 225, 239, 'Free', 'FR'],

  // Rostelecom residential (Russia)
  [95,  79,  79, 'Rostelecom', 'RU'],

  // Bell Canada residential
  [66,  95,  95, 'Bell', 'CA'],
  [24, 200, 207, 'Bell', 'CA'],

  // Telus (Canada)
  [70,  64,  79, 'Telus', 'CA'],

  // Optus (Australia)
  [49, 176, 191, 'Optus', 'AU'],

  // Telstra (Australia)
  [1, 128, 159, 'Telstra', 'AU'],
];

// Country codes → realistic timezone offsets (for use in headers if needed)
const COUNTRY_TZ = {
  US: 'America/Chicago',
  GB: 'Europe/London',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  RU: 'Europe/Moscow',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
};

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a single realistic residential IP from a real ISP range.
 * Returns { ip, provider, country }
 */
function generateResidentialIp() {
  const entry = RESIDENTIAL_RANGES[Math.floor(Math.random() * RESIDENTIAL_RANGES.length)];
  const [oct1, oct2min, oct2max, provider, country] = entry;
  const oct2 = rand(oct2min, oct2max);
  const oct3 = rand(0, 255);
  const oct4 = rand(2, 254); // avoid .0 and .255
  return { ip: `${oct1}.${oct2}.${oct3}.${oct4}`, provider, country };
}

/**
 * Generate a realistic X-Forwarded-For chain.
 * Looks like: <residential-client>, <CDN-edge-1>, <CDN-edge-2>
 * The residential IP is always first (the "real" client).
 */
function generateForwardedForChain(depth = 2) {
  const client = generateResidentialIp();
  const chain = [client.ip];
  // Add 1-2 intermediate CDN/ISP hops to look like normal proxied traffic
  for (let i = 0; i < depth - 1; i++) {
    const hop = generateResidentialIp();
    chain.push(hop.ip);
  }
  return { chain: chain.join(', '), primary: client.ip, info: client };
}

/**
 * Build the full set of Cloudflare-trusted residential IP headers.
 * Cloudflare reads CF-Connecting-IP and True-Client-IP from upstream trusted proxies
 * in its own network — injecting residential IPs here makes the site see a home user.
 */
function _generateResidentialIpHeaders() {
  const xffChain = generateForwardedForChain(2);
  const clientIp = xffChain.primary;
  return {
    'x-forwarded-for': xffChain.chain,
    'x-real-ip': clientIp,
    'cf-connecting-ip': clientIp,
    'true-client-ip': clientIp,
    'x-forwarded-proto': 'https',
  };
}

// Per-session IP cache — each session reuses the same residential IP for consistency.
// Bot scoring systems flag sessions that change IPs mid-session; stable IPs look human.
const SESSION_IP_CACHE = new Map();
const SESSION_IP_TTL = 30 * 60 * 1000; // 30 minutes

// Purge expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of SESSION_IP_CACHE) {
    if (entry.expires < now) SESSION_IP_CACHE.delete(sid);
  }
}, 10 * 60 * 1000);

/**
 * Return residential IP headers for this session.
 * If sid is provided the same IP is reused for the lifetime of the session.
 */
function buildResidentialIpHeaders(sid = null) {
  if (!sid) return _generateResidentialIpHeaders();
  const cached = SESSION_IP_CACHE.get(sid);
  if (cached && cached.expires > Date.now()) return cached.headers;
  const headers = _generateResidentialIpHeaders();
  SESSION_IP_CACHE.set(sid, { headers, expires: Date.now() + SESSION_IP_TTL });
  return headers;
}

// Legacy compat — used by advanced-evasion.js
function createProxyChain(depth = 3) {
  const result = generateForwardedForChain(depth);
  return {
    ips: result.chain.split(', '),
    chain: result.chain,
    primary: result.primary,
    proxies: result.chain.split(', ').slice(1),
  };
}

export {
  generateResidentialIp,
  generateForwardedForChain,
  buildResidentialIpHeaders,
  createProxyChain,
  RESIDENTIAL_RANGES,
};
