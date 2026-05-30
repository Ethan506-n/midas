import dns from 'dns';
import https from 'https';
import { promisify } from 'util';

// Alternative DNS servers to bypass ISP-level DNS blocking
const ALTERNATIVE_DNS = [
  // Cloudflare (Fast, privacy-focused) - Use DoH for DNS-over-HTTPS
  { servers: ['1.1.1.1', '1.0.0.1'], name: 'Cloudflare', doh: 'https://1.1.1.1/dns-query' },
  // Google Public DNS
  { servers: ['8.8.8.8', '8.8.4.4'], name: 'Google', doh: 'https://8.8.8.8/dns-query' },
  // Quad9 (Security-focused)
  { servers: ['9.9.9.9', '149.112.112.112'], name: 'Quad9', doh: 'https://9.9.9.9/dns-query' },
];

const dnsLookup = promisify(dns.lookup);

// Cache resolved IPs to avoid repeated lookups
const IP_CACHE = new Map();
const CACHE_TTL = 3600000; // 1 hour

/**
 * Resolve using DNS-over-HTTPS to bypass ISP DNS filtering
 */
function resolveViaDOH(hostname, dohUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(dohUrl);
    const query = `?name=${encodeURIComponent(hostname)}&type=A`;
    
    https.get(`${dohUrl}${query}`, {
      headers: {
        'accept': 'application/dns-json',
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.Answer && result.Answer.length > 0) {
            // Find A record
            const aRecord = result.Answer.find(r => r.type === 1);
            if (aRecord) {
              resolve(aRecord.data);
              return;
            }
          }
          reject(new Error('No A records in DoH response'));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

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
    
    // Check if this looks like a filter redirect (private IP range)
    if (!isPrivateIp(ip)) {
      IP_CACHE.set(hostname, { ip, expires: Date.now() + CACHE_TTL });
      console.log(`[DNS] System resolver: ${hostname} -> ${ip}`);
      return ip;
    } else {
      console.log(`[DNS] System resolver returned private IP (${ip}), likely filtered, trying DoH...`);
    }
  } catch (err) {
    console.log(`[DNS] System resolver failed: ${err.code}`);
  }

  // Try DNS-over-HTTPS (bypasses ISP DNS filtering)
  for (const dnsConfig of ALTERNATIVE_DNS) {
    if (!dnsConfig.doh) continue;
    try {
      const ip = await resolveViaDOH(hostname, dnsConfig.doh);
      if (ip && !isPrivateIp(ip)) {
        IP_CACHE.set(hostname, { ip, expires: Date.now() + CACHE_TTL });
        console.log(`[DNS] ${dnsConfig.name} DoH: ${hostname} -> ${ip}`);
        return ip;
      }
    } catch (err) {
      console.log(`[DNS] ${dnsConfig.name} DoH failed: ${err.message}`);
    }
  }

  // Try standard DNS resolution as fallback
  for (const dnsConfig of ALTERNATIVE_DNS) {
    try {
      const ip = await resolveThroughDns(hostname, dnsConfig.servers);
      if (ip && !isPrivateIp(ip)) {
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
 * Check if IP is in private range (likely a filter redirect)
 */
function isPrivateIp(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  
  return (
    (parts[0] === 10) ||                           // 10.0.0.0/8
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||  // 172.16.0.0/12
    (parts[0] === 192 && parts[1] === 168) ||     // 192.168.0.0/16
    (parts[0] === 127) ||                          // 127.0.0.0/8 (localhost)
    (parts[0] === 169 && parts[1] === 254)        // 169.254.0.0/16 (link-local)
  );
}

/**
 * Cloudflare published IPv4 CIDR ranges (https://www.cloudflare.com/ips-v4/).
 * Connecting to these IPs directly without proper SNI causes Error 1000
 * ("DNS points to prohibited IP") because Cloudflare's shared edge does not
 * accept bare-IP connections — it needs the SNI hostname to route correctly.
 * We detect these and fall back to using the hostname directly so the OS
 * resolver + TLS SNI handle the connection normally.
 */
// Precomputed [network_int, mask_int] pairs for fast matching
const CF_CIDRS = [
  [ip4ToInt('103.21.244.0'),  cidrMask(22)],
  [ip4ToInt('103.22.200.0'),  cidrMask(22)],
  [ip4ToInt('103.31.4.0'),    cidrMask(22)],
  [ip4ToInt('104.16.0.0'),    cidrMask(13)],
  [ip4ToInt('104.24.0.0'),    cidrMask(14)],
  [ip4ToInt('108.162.192.0'), cidrMask(18)],
  [ip4ToInt('131.0.72.0'),    cidrMask(22)],
  [ip4ToInt('141.101.64.0'),  cidrMask(18)],
  [ip4ToInt('162.158.0.0'),   cidrMask(15)],
  [ip4ToInt('172.64.0.0'),    cidrMask(13)],
  [ip4ToInt('173.245.48.0'),  cidrMask(20)],
  [ip4ToInt('188.114.96.0'),  cidrMask(20)],
  [ip4ToInt('190.93.240.0'),  cidrMask(20)],
  [ip4ToInt('197.234.240.0'), cidrMask(22)],
  [ip4ToInt('198.41.128.0'),  cidrMask(17)],
];

function ip4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function cidrMask(bits) {
  return (bits === 0 ? 0 : (~0 << (32 - bits))) >>> 0;
}

/**
 * Returns true when the IP falls inside any of Cloudflare's published ranges.
 * Exported so router.js can skip the IP-bypass path for Cloudflare targets.
 */
export function isCloudflareIp(ip) {
  // Only handle IPv4 for now
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = ip4ToInt(ip);
  return CF_CIDRS.some(([net, mask]) => (n & mask) === net);
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
