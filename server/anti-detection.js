/**
 * Anti-Detection & Header Randomization
 * Rotates user agents and headers to bypass detection
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

const ACCEPT_LANGUAGE = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.8',
  'en;q=0.9',
];

const ACCEPT_ENCODING = [
  'gzip, deflate, br',
  'gzip, deflate',
  'br, gzip, deflate',
];

// Generate random headers that look natural
export function generateRandomHeaders() {
  const isChrome = Math.random() > 0.4;
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  
  const headers = {
    'user-agent': userAgent,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': ACCEPT_LANGUAGE[Math.floor(Math.random() * ACCEPT_LANGUAGE.length)],
    'accept-encoding': ACCEPT_ENCODING[Math.floor(Math.random() * ACCEPT_ENCODING.length)],
    'cache-control': 'max-age=0',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
  };

  // Add Chrome-specific headers
  if (isChrome) {
    headers['sec-ch-ua'] = '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    headers['sec-ch-ua-platform-version'] = '"15.0"';
  }

  return headers;
}

// Randomize header order (makes fingerprinting harder)
export function randomizeHeaderOrder(headers) {
  const entries = Object.entries(headers);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  
  const result = {};
  for (const [k, v] of entries) {
    result[k] = v;
  }
  return result;
}

// Get random user agent
export function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Inject anti-detection script into HTML
export function injectAntiDetectionScript() {
  return `
(function() {
  // Hide headless/automation flags
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });
  
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3],
  });
  
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
  
  // Randomize canvas fingerprint slightly
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const data = originalToDataURL.apply(this, args);
    // Don't modify empty canvas
    if (this.width === 0 || this.height === 0) return data;
    return data;
  };
  
  // Fake chrome property for some sites
  window.chrome = { runtime: {} };
})();
`;
}

// Clean response headers (remove detection vectors)
export function cleanResponseHeaders(headers) {
  const cleaned = { ...headers };
  
  // Remove headers that might leak proxy identity
  delete cleaned['server'];
  delete cleaned['x-powered-by'];
  delete cleaned['x-aspnet-version'];
  delete cleaned['x-runtime-version'];
  
  return cleaned;
}
