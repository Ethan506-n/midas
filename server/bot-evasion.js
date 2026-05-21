/**
 * Advanced bot detection evasion
 * Defeats simple bot detection through realistic behavior
 */

/**
 * Request context tracking for realistic behavior
 */
export class BotEvisionContext {
  constructor(hostname) {
    this.hostname = hostname;
    this.requestCount = 0;
    this.startTime = Date.now();
    this.lastRequestTime = Date.now();
    this.requestIntervals = [];
    this.userAgents = [];
  }

  recordRequest() {
    const now = Date.now();
    const interval = now - this.lastRequestTime;
    this.requestIntervals.push(interval);
    this.lastRequestTime = now;
    this.requestCount++;
  }

  getInterRequestDelay() {
    // Simulate human-like inter-request delays
    // Real users don't make requests every 10ms
    if (this.requestCount < 3) {
      // First few requests: 500-2000ms apart (initial page load)
      return 500 + Math.random() * 1500;
    } else if (this.requestCount < 10) {
      // Subsequent requests: 100-500ms apart (resource loading)
      return 100 + Math.random() * 400;
    } else {
      // Later requests: 50-300ms apart (sub-resources)
      return 50 + Math.random() * 250;
    }
  }

  isRequestPatternSuspicious() {
    // Check for bot-like patterns
    if (this.requestIntervals.length < 3) return false;

    // If all intervals are identical (within 5ms), it's suspicious
    const lastThree = this.requestIntervals.slice(-3);
    const avgInterval = lastThree.reduce((a, b) => a + b) / lastThree.length;
    const variance = lastThree.reduce((sum, interval) => {
      return sum + Math.abs(interval - avgInterval);
    }, 0) / lastThree.length;

    return variance < 5; // Very low variance = bot-like
  }
}

/**
 * Generate headers that avoid common bot detection patterns
 */
export function getAntiDetailectionHeaders(depth = 0, hostname = '') {
  return {
    // Accept headers that real browsers send
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': getRandomLanguage(),

    // Fetch metadata headers (modern browsers)
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',

    // Upgrade insecure requests
    'upgrade-insecure-requests': '1',

    // Client hints (optional but modern)
    'sec-ch-ua': getRandomSecChUA(),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': getRandomPlatform(),

    // Referer policy
    'referrer-policy': 'strict-origin-when-cross-origin',

    // Cache control with variation
    'cache-control': depth === 0 ? 'max-age=0' : 'no-cache',
    'pragma': 'no-cache',

    // Privacy headers
    'dnt': Math.random() > 0.5 ? '1' : undefined,
    'sec-gpc': Math.random() > 0.5 ? '1' : undefined,

    // Avoid common bot patterns
    'connection': 'keep-alive',
    'keep-alive': '300',
  };
}

/**
 * Random language variations
 */
function getRandomLanguage() {
  const languages = [
    'en-US,en;q=0.9',
    'en-US,en;q=0.9,es;q=0.8',
    'en-US,en;q=0.9,fr;q=0.8,de;q=0.7',
    'en-GB,en;q=0.9',
    'en-US,en;q=0.95',
  ];
  return languages[Math.floor(Math.random() * languages.length)];
}

/**
 * Random sec-ch-ua variations
 */
function getRandomSecChUA() {
  const versions = [
    '"Google Chrome";v="120", "Chromium";v="120", "Not:A-Brand";v="99"',
    '"Chromium";v="120", "Google Chrome";v="120", "Not?A_Brand";v="99"',
    '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  ];
  return versions[Math.floor(Math.random() * versions.length)];
}

/**
 * Random platform variations
 */
function getRandomPlatform() {
  const platforms = [
    '"Windows"',
    '"Linux"',
    '"macOS"',
    '"Android"',
  ];
  return platforms[Math.floor(Math.random() * platforms.length)];
}

/**
 * Detect and bypass common bot detection techniques
 */
export function shouldBypassBotDetection(html, hostname) {
  if (!html) return false;

  const lower = html.toLowerCase();

  // Check for common bot detection indicators
  const botDetectionSigns = [
    'javascript:void',
    'noscript',
    'javascript required',
    'please enable javascript',
    '__req__',
    'cloudflare',
    'challenge',
    'checking your browser',
    'bot check',
    'robot',
    'automated',
    'suspicious activity',
    'unusual traffic',
  ];

  for (const sign of botDetectionSigns) {
    if (lower.includes(sign)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate request timing variations to avoid detection
 */
export function getRealisticRequestDelay(hostname, requestCount) {
  // Different delay profiles for different site types
  if (hostname.includes('reddit') || hostname.includes('stackoverflow')) {
    // Sites with aggressive rate limiting
    if (requestCount < 5) return 100 + Math.random() * 200; // Early requests slower
    return 50 + Math.random() * 100; // Later requests faster
  }

  if (hostname.includes('wikipedia') || hostname.includes('github')) {
    // More lenient sites
    return 30 + Math.random() * 70;
  }

  // Default: random but realistic
  return 50 + Math.random() * 150;
}

/**
 * Headers that avoid triggering rate limit detection
 */
export function getRateLimitAvoidanceHeaders() {
  return {
    // Vary cache control to avoid pattern
    'cache-control': Math.random() > 0.3 ? 'max-age=0' : 'no-cache',
    
    // Random if-modified-since
    'if-modified-since': getRandomIfModifiedSince(),
    
    // Connection reuse
    'connection': Math.random() > 0.5 ? 'keep-alive' : 'close',
  };
}

function getRandomIfModifiedSince() {
  const days = Math.floor(Math.random() * 30);
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toUTCString();
}

/**
 * Detect if response contains JavaScript challenge
 */
export function isJavaScriptChallenge(html) {
  if (!html || typeof html !== 'string') return false;

  const lower = html.toLowerCase();
  return (
    lower.includes('eval(') && lower.includes('challenge') ||
    lower.includes('recaptcha') ||
    lower.includes('hcaptcha') ||
    lower.includes('__cf_chl_jschl_tk__') ||
    (lower.includes('document.write') && lower.includes('script'))
  );
}

/**
 * Detect if response is a simple bot block page
 */
export function isSimpleBotBlock(html) {
  if (!html || typeof html !== 'string') return false;

  const lower = html.toLowerCase();
  const blockKeywords = ['bot', 'robot', 'automated', 'automated access'];
  const contextKeywords = ['blocked', 'denied', 'forbidden', 'access denied'];

  // Check if multiple bot-detection keywords present
  let botKeywordCount = 0;
  for (const keyword of blockKeywords) {
    if (lower.includes(keyword)) botKeywordCount++;
  }

  let contextKeywordCount = 0;
  for (const keyword of contextKeywords) {
    if (lower.includes(keyword)) contextKeywordCount++;
  }

  // If has both bot keywords AND context keywords, likely a bot block
  return botKeywordCount >= 1 && contextKeywordCount >= 1;
}

/**
 * Get headers specific to avoiding rate limiting
 */
export function getAntiRateLimitHeaders(hostname, attemptNumber) {
  const headers = {};

  // Vary User-Agent more aggressively for rate-limited sites
  if (hostname.includes('reddit') || hostname.includes('stackoverflow')) {
    // Change more frequently for aggressive sites
    headers['user-agent'] = getVariedUserAgent(attemptNumber);
  }

  // X-Forwarded-For rotation
  if (attemptNumber > 0) {
    headers['x-forwarded-for'] = generateVariedForwardedFor(attemptNumber);
  }

  return headers;
}

function getVariedUserAgent(seed) {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ];
  return agents[seed % agents.length];
}

function generateVariedForwardedFor(seed) {
  const ranges = ['203', '210', '211', '202', '61', '101'];
  const range = ranges[seed % ranges.length];
  const octet2 = Math.floor(Math.random() * 256);
  const octet3 = Math.floor(Math.random() * 256);
  const octet4 = Math.floor(Math.random() * 256);
  return `${range}.${octet2}.${octet3}.${octet4}`;
}

/**
 * Check if response headers indicate bot detection
 */
export function hasAntiBotHeaders(responseHeaders) {
  if (!responseHeaders) return false;

  const suspiciousHeaders = [
    'x-robot-check',
    'x-crawler-protection',
    'x-bot-protection',
  ];

  const headerStr = JSON.stringify(responseHeaders).toLowerCase();
  for (const header of suspiciousHeaders) {
    if (headerStr.includes(header)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate request order that mimics real browser
 */
export function getRealisticRequestOrder(hostname) {
  // Real browsers load resources in this order:
  // 1. HTML document
  // 2. CSS stylesheets (render-blocking)
  // 3. JavaScript (async where possible)
  // 4. Images and fonts
  // 5. XHR/Fetch calls

  return {
    firstPriority: 'document', // HTML first
    secondPriority: 'stylesheet', // CSS second
    thirdPriority: 'script', // JS third
    fourthPriority: 'image', // Images/fonts last
    fifthPriority: 'xhr', // XHR/Fetch last
  };
}

/**
 * Detect if site uses browser fingerprinting
 */
export function usesBrowserFingerprinting(html) {
  if (!html) return false;

  const lower = html.toLowerCase();
  const fingerprinting = [
    'navigator.webdriver',
    'chrome.webstore',
    'phantom',
    'headless',
    'getusermedia',
    'webgl',
  ];

  for (const term of fingerprinting) {
    if (lower.includes(term)) {
      return true;
    }
  }

  return false;
}
