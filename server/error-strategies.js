/**
 * Enhanced error detection and recovery strategies
 */

export function analyzeErrorResponse(statusCode, html, hostname) {
  const lower = html?.toLowerCase() || '';
  
  // Detect specific error types
  const errors = {
    cloudflareChallenge: lower.includes('challenge') || lower.includes('checking your browser') || lower.includes('cf_clearance'),
    botDetection: (lower.includes('bot') && lower.includes('detect')) || lower.includes('unusual traffic') || lower.includes('automated'),
    blocked: lower.includes('blocked') || lower.includes('forbidden') || lower.includes('access denied'),
    rateLimited: statusCode === 429 || lower.includes('rate limit') || lower.includes('too many requests'),
    redirect: statusCode >= 300 && statusCode < 400,
  };
  
  return {
    statusCode,
    errors,
    shouldRetry: statusCode === 403 || statusCode === 429 || errors.cloudflareChallenge || errors.botDetection,
    retryStrategy: getRetryStrategy(statusCode, errors, hostname),
  };
}

function getRetryStrategy(statusCode, errors, hostname) {
  // Different strategies for different error types
  if (errors.rateLimited) {
    return 'exponential-backoff'; // 50ms, 100ms, 200ms, 400ms
  }
  if (errors.cloudflareChallenge) {
    return 'cloudflare-bypass'; // Use CF headers
  }
  if (errors.botDetection) {
    return 'fingerprint-change'; // Rotate browser profile
  }
  if (errors.blocked) {
    return 'proxy-headers'; // Add aggressive proxy headers
  }
  
  return 'standard'; // Normal backoff
}

export function shouldRetryRequest(statusCode, html) {
  if (statusCode === 403 || statusCode === 429) return true;
  if (statusCode === 500 || statusCode === 502 || statusCode === 503) return true;
  
  const lower = html?.toLowerCase() || '';
  if (lower.includes('challenge') || lower.includes('bot') || lower.includes('unusual traffic')) {
    return true;
  }
  
  return false;
}

export function getRetryDelayMs(statusCode, retryCount, hostname) {
  // Different delay strategies based on error type
  if (statusCode === 429) {
    // Rate limit: exponential backoff
    return Math.min(1000 * Math.pow(2, retryCount), 30000);
  }
  
  // Adaptive delays for specific sites
  const siteDelays = {
    'reddit.com': [100, 200, 400, 800, 1600],
    'stackoverflow.com': [150, 300, 600, 1200, 2400],
    'wikipedia.org': [100, 300, 600, 1200],
    'ebay.com': [500, 1000, 2000, 4000],
  };
  
  for (const [domain, delays] of Object.entries(siteDelays)) {
    if (hostname.includes(domain)) {
      if (retryCount < delays.length) {
        return delays[retryCount] + Math.random() * 100;
      }
      return delays[delays.length - 1];
    }
  }
  
  // Default: 100ms + exponential backoff
  return 100 * Math.pow(1.5, retryCount) + Math.random() * 50;
}

export function getResponseHeaders(retryCount, retryStrategy) {
  const headers = {};
  
  if (retryStrategy === 'proxy-headers') {
    // Add aggressive proxy headers for blocked responses
    headers['x-forwarded-for'] = generateRandomIps();
    headers['x-real-ip'] = generateRandomIp();
    headers['via'] = `1.1 proxy-relay:8080 (HTTP/1.1 GWA)`;
    headers['cf-connecting-ip'] = generateRandomIp();
  }
  
  if (retryStrategy === 'fingerprint-change') {
    // Headers will be handled by browser profile rotation
  }
  
  return headers;
}

function generateRandomIp() {
  const octet = () => Math.floor(Math.random() * 256);
  return `${octet()}.${octet()}.${octet()}.${octet()}`;
}

function generateRandomIps() {
  const ips = [];
  for (let i = 0; i < 2; i++) {
    ips.push(generateRandomIp());
  }
  return ips.join(', ');
}

export const RETRY_CONFIG = {
  maxRetries: {
    'reddit.com': 5,
    'stackoverflow.com': 5,
    'wikipedia.org': 4,
    'twitter.com': 3,
    'ebay.com': 3,
    'default': 3,
  },
  strategies: {
    'cloudflare-bypass': { delays: [100, 200, 300], maxRetries: 3 },
    'proxy-headers': { delays: [150, 300, 600], maxRetries: 4 },
    'exponential-backoff': { delays: [100, 200, 500, 1000], maxRetries: 4 },
    'fingerprint-change': { delays: [200, 400, 800], maxRetries: 3 },
    'standard': { delays: [100, 200, 400], maxRetries: 3 },
  },
};
