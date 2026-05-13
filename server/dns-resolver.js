import dns from 'dns';
import { promisify } from 'util';

// Alternative DNS servers to bypass ISP-level DNS blocking
const ALTERNATIVE_DNS = [
  // Cloudflare (Fast, privacy-focused)
  { servers: ['1.1.1.1', '1.0.0.1'], name: 'Cloudflare' },
  // Google Public DNS
  { servers: ['8.8.8.8', '8.8.4.4'], name: 'Google' },
  // Quad9 (Security-focused)
  { servers: ['9.9.9.9', '149.112.112.112'], name: 'Quad9' },
  // OpenDNS
  { servers: ['208.67.222.222', '208.67.220.220'], name: 'OpenDNS' },
  // Verisign
  { servers: ['64.6.64.6', '64.6.65.6'], name: 'Verisign' },
];

const dnsLookup = promisify(dns.lookup);

// Cache resolved IPs to avoid repeated lookups
const IP_CACHE = new Map();
const CACHE_TTL = 3600000; // 1 hour

/**
 * Resolve domain using system DNS first, fallback to alternative DNS
 */
export async function resolveWithFallback(hostname) {
  // Check cache first
  const cached = IP_CACHE.get(hostname);
  if (cached && cached.expires > Date.now()) {
    return cached.ip;
  }

  // Try system DNS first (fast path)
  try {
    const address = await dnsLookup(hostname);
    const ip = address.address;
    IP_CACHE.set(hostname, { ip, expires: Date.now() + CACHE_TTL });
    console.log(`[DNS] System resolver: ${hostname} -> ${ip}`);
    return ip;
  } catch (err) {
    console.log(`[DNS] System resolver failed for ${hostname}: ${err.code}`);
  }

  // Try alternative DNS servers
  for (const dnsConfig of ALTERNATIVE_DNS) {
    try {
      const ip = await resolveThroughDns(hostname, dnsConfig.servers);
      if (ip) {
        IP_CACHE.set(hostname, { ip, expires: Date.now() + CACHE_TTL });
        console.log(`[DNS] ${dnsConfig.name}: ${hostname} -> ${ip}`);
        return ip;
      }
    } catch (err) {
      console.log(`[DNS] ${dnsConfig.name} failed: ${err.message}`);
    }
  }

  // If all DNS methods fail, throw error
  throw new Error(`DNS resolution failed for ${hostname}`);
}

/**
 * Resolve using specific DNS servers
 */
function resolveThroughDns(hostname, servers) {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver();
    resolver.setServers(servers);
    
    resolver.resolve4(hostname, (err, addresses) => {
      if (err) {
        return reject(err);
      }
      if (addresses && addresses.length > 0) {
        resolve(addresses[0]);
      } else {
        reject(new Error('No addresses returned'));
      }
    });
  });
}

/**
 * Clear IP cache (useful for testing)
 */
export function clearCache() {
  IP_CACHE.clear();
}

/**
 * Get current cache stats
 */
export function getCacheStats() {
  return {
    size: IP_CACHE.size,
    entries: Array.from(IP_CACHE.entries()).map(([host, data]) => ({
      host,
      ip: data.ip,
      expiresIn: Math.round((data.expires - Date.now()) / 1000)
    }))
  };
}
