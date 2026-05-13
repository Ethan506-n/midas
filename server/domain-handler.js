/**
 * Domain-Specific Handlers
 * Provides optimized handling for popular websites
 */

// Domain configurations
const DOMAIN_CONFIG = {
  // Social Media
  'facebook.com': { handleJsonApi: true, preserveAuth: true, handleWebsockets: true },
  'twitter.com': { handleJsonApi: true, preserveAuth: true, handleWebsockets: true },
  'x.com': { handleJsonApi: true, preserveAuth: true, handleWebsockets: true },
  'instagram.com': { handleJsonApi: true, preserveAuth: true },
  'tiktok.com': { handleJsonApi: true, preserveAuth: true },
  'reddit.com': { handleJsonApi: true, preserveAuth: true },
  'linkedin.com': { handleJsonApi: true, preserveAuth: true },
  
  // Streaming & Media
  'youtube.com': { handleJsonApi: true, handleStreaming: true, largeBufferSize: true },
  'netflix.com': { handleJsonApi: true, handleStreaming: true, preserveAuth: true },
  'twitch.tv': { handleJsonApi: true, handleStreaming: true, handleWebsockets: true },
  'vimeo.com': { handleJsonApi: true, handleStreaming: true },
  'dailymotion.com': { handleJsonApi: true, handleStreaming: true },
  
  // Cloud Services
  'github.com': { handleJsonApi: true, preserveAuth: true, handleWebsockets: true },
  'gitlab.com': { handleJsonApi: true, preserveAuth: true, handleWebsockets: true },
  'google.com': { handleJsonApi: true, rateLimit: 10 },
  'drive.google.com': { handleJsonApi: true, preserveAuth: true },
  'dropbox.com': { handleJsonApi: true, preserveAuth: true },
  'onedrive.live.com': { handleJsonApi: true, preserveAuth: true },
  
  // Messaging & Communication
  'discord.com': { handleJsonApi: true, handleWebsockets: true, preserveAuth: true },
  'telegram.org': { handleJsonApi: true },
  'slack.com': { handleJsonApi: true, handleWebsockets: true, preserveAuth: true },
  'whatsapp.com': { handleJsonApi: true, handleWebsockets: true },
  
  // Search & News
  'bing.com': { handleJsonApi: true },
  'duckduckgo.com': { handleJsonApi: true },
  'news.ycombinator.com': { handleJsonApi: true },
  'bbc.com': { handleJsonApi: true, handleStreaming: true },
  'cnn.com': { handleJsonApi: true, handleStreaming: true },
  
  // E-Commerce
  'amazon.com': { handleJsonApi: true, preserveAuth: true },
  'ebay.com': { handleJsonApi: true, preserveAuth: true },
  'shopify.com': { handleJsonApi: true },
  'etsy.com': { handleJsonApi: true, preserveAuth: true },
  
  // Development/Tech
  'stackoverflow.com': { handleJsonApi: true },
  'npmjs.com': { handleJsonApi: true },
  'pypi.org': { handleJsonApi: true },
  'crates.io': { handleJsonApi: true },
};

// Get config for domain
export function getDomainConfig(hostname) {
  // Strip www prefix
  const domain = hostname.replace(/^www\./, '');
  return DOMAIN_CONFIG[domain] || {};
}

// Check if should preserve authentication
export function shouldPreserveAuth(hostname) {
  return getDomainConfig(hostname).preserveAuth || false;
}

// Check if handles JSON API
export function handlesJsonApi(hostname) {
  return getDomainConfig(hostname).handleJsonApi || false;
}

// Check if handles streaming
export function handlesStreaming(hostname) {
  return getDomainConfig(hostname).handleStreaming || false;
}

// Check if handles WebSockets
export function handlesWebsockets(hostname) {
  return getDomainConfig(hostname).handleWebsockets || false;
}

// Get rate limit for domain (requests per second, 0 = unlimited)
export function getRateLimit(hostname) {
  const config = getDomainConfig(hostname);
  return config.rateLimit || 20; // default 20 req/s
}

// Check if needs large buffer size
export function needsLargeBuffer(hostname) {
  return getDomainConfig(hostname).largeBufferSize || false;
}

// Get list of domains that need special handling
export function getSpecialDomains() {
  return Object.keys(DOMAIN_CONFIG);
}
