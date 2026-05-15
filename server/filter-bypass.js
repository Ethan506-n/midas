/**
 * Bypass techniques for network-level content filters
 */

// Known filter domains that indicate content blocking
const FILTER_DOMAINS = [
  'filter.',
  'block',
  'parental',
  'content-filter',
  'captive-portal',
  'netsweeper',
  'iboss',
  'forcepoint',
  'websense',
  'paloaltonetworks',
  'sonicwall',
  'meraki',
];

/**
 * Detect if a URL is a content filter block page
 */
export function isFilterDomain(hostname) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase();
  return FILTER_DOMAINS.some(filter => lower.includes(filter)) ||
    /\d+\.\d+\.\d+\.\d+/.test(hostname) || // Private IP ranges
    hostname.includes('local') ||
    hostname.includes('localhost');
}

/**
 * Bypass headers to try to evade common content filters
 */
export function getBypassHeaders() {
  return {
    // Claim to be a bot/crawler (some filters allow bots)
    'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    
    // Add headers that suggest legitimate traffic
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    
    // Some filters check referrer origin
    'referer': 'https://google.com',
    
    // Bypass DNS filter detection
    'dnt': '1',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'sec-fetch-user': '?1',
  };
}

/**
 * Alternative bypass strategies to try in order
 */
export const BYPASS_STRATEGIES = [
  {
    name: 'Alternative DNS',
    setup: async () => {
      // Try alternate DNS servers
      return { dnsServers: ['1.1.1.1', '1.0.0.1'] };
    }
  },
  {
    name: 'HTTP/2 Connection',
    setup: async () => {
      // Use HTTP/2 which may bypass some filters
      return { http2: true };
    }
  },
  {
    name: 'Randomized Headers',
    setup: async () => {
      // Randomize header order and values
      return { headers: getBypassHeaders() };
    }
  },
  {
    name: 'Direct IP with HTTPS',
    setup: async () => {
      // Use direct IP connection with proper SNI
      return { bypassDns: true, useSni: true };
    }
  },
];

/**
 * Extract original URL from filter redirect
 */
export function extractOriginalUrl(filterUrl) {
  try {
    const url = new URL(filterUrl);
    
    // Common parameter names for the blocked URL
    const paramNames = ['filtered', 'url', 'original', 'dest', 'destination', 'goto'];
    for (const param of paramNames) {
      const value = url.searchParams.get(param);
      if (value) return value;
    }
    
    // If no parameter found, return null
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if response is a filter block page
 */
export function isFilterBlockPage(html) {
  if (!html || typeof html !== 'string') return false;
  
  const lowerHtml = html.toLowerCase();
  return (
    lowerHtml.includes('content filter') ||
    lowerHtml.includes('access denied') ||
    lowerHtml.includes('blocked') && lowerHtml.includes('domain') ||
    lowerHtml.includes('filtered') ||
    lowerHtml.includes('parental control') ||
    lowerHtml.includes('your request was blocked') ||
    lowerHtml.includes('this page has been blocked')
  );
}
