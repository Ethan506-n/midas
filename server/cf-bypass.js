/**
 * CF Error 1000 bypass via non-Cloudflare relay services.
 *
 * Root cause: Replit runs on Cloudflare's infrastructure. When our proxy tries
 * to reach another CF-protected site, Cloudflare's edge detects the source IP
 * is within its own datacenter network and returns Error 1000 (routing loop
 * prevention). Header spoofing cannot fix this — CF checks the actual TCP
 * source IP, not X-Forwarded-For or CF-Connecting-IP headers.
 *
 * Solution: route the outgoing request through servers whose IPs are NOT in
 * Cloudflare's datacenter ranges. The following services qualify:
 *
 *   • Wayback Machine  (207.241.x.x — Internet Archive, Portland OR)
 *   • Google Cache     (142.250.x.x — Google Cloud, non-CF)
 *
 * NOTE: allorigins.win / corsproxy.io / codetabs.com are themselves behind
 * Cloudflare (172.67.x.x / 104.26.x.x) — requests from Replit to them also
 * get blocked. Do NOT use those services here.
 *
 * All relays are attempted in PARALLEL so the fastest successful one wins
 * immediately (typically < 2 seconds) rather than serially (up to 30 seconds).
 */

import https from 'https';
import http  from 'http';
import zlib  from 'zlib';
import net   from 'net';
import tls   from 'tls';

// ─── low-level fetch ──────────────────────────────────────────────────────────

function decompress(buf, encoding) {
  return new Promise((resolve, reject) => {
    const enc = (encoding || '').toLowerCase();
    if (enc.includes('gzip'))    zlib.gunzip(buf, (e, d) => e ? reject(e) : resolve(d));
    else if (enc.includes('br')) zlib.brotliDecompress(buf, (e, d) => e ? reject(e) : resolve(d));
    else if (enc.includes('deflate')) zlib.inflate(buf, (e, d) => e ? reject(e) : resolve(d));
    else resolve(buf);
  });
}

function fetchDirect(urlStr, opts = {}, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        ...(opts.headers || {}),
      },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks);
          const body = await decompress(raw, res.headers['content-encoding'] || '');
          resolve({ statusCode: res.statusCode, body: body.toString('utf8'), headers: res.headers });
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── Wayback Machine (Internet Archive — 207.241.x.x, NOT Cloudflare) ────────

async function tryWayback(targetUrl) {
  // Step 1: find the most recent snapshot via CDX API
  const cdxUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`;
  let snapshotUrl;
  try {
    const cdx = await fetchDirect(cdxUrl, {}, 6000);
    if (cdx.statusCode !== 200) return null;
    const data = JSON.parse(cdx.body);
    if (!data?.archived_snapshots?.closest?.available) return null;
    snapshotUrl = data.archived_snapshots.closest.url;
  } catch { return null; }

  // Step 2: fetch the raw page content using the `id_` modifier.
  // Without `id_` the Wayback Machine injects its own toolbar and JS.
  // The `id_` flag returns the original content byte-for-byte.
  //   e.g. https://web.archive.org/web/20260615120000/https://example.com
  //     →  https://web.archive.org/web/20260615120000id_/https://example.com
  const rawUrl = snapshotUrl.replace(
    /web\.archive\.org\/web\/(\d+)\//,
    'web.archive.org/web/$1id_/'
  );

  try {
    const result = await fetchDirect(rawUrl.replace('http://', 'https://'), {}, 12000);
    if (result.statusCode >= 200 && result.statusCode < 400 &&
        result.body && result.body.length > 300 &&
        !result.body.toLowerCase().includes('error 1000')) {
      console.log(`[CF-BYPASS] wayback served ${targetUrl} (snapshot: ${snapshotUrl.match(/\/(\d+)\//)?.[1]})`);
      return { body: result.body, source: 'wayback' };
    }
  } catch (e) {
    console.log(`[CF-BYPASS] wayback fetch failed: ${e.message}`);
  }
  return null;
}

// ─── Google Cache (Google 142.250.x.x — NOT Cloudflare) ──────────────────────
// NOTE: Google Cache often returns its own JavaScript challenge page instead of
// the cached content (especially for high-traffic sites). We detect this and
// reject it so the Wayback Machine result is used instead.

async function tryGoogleCache(targetUrl) {
  const gcUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(targetUrl)}&hl=en&gl=us`;
  try {
    const result = await fetchDirect(gcUrl, {}, 8000);
    if (result.statusCode === 200 && result.body.length > 300) {
      const body = result.body;
      // Reject Google's own bot-challenge/Turing-test page — these markers
      // indicate Google returned its own page, not the cached site content.
      const isGoogleChallenge =
        body.includes('challenge_version') ||
        body.includes('var challenge_version') ||
        body.includes('SG_SS=') ||
        body.includes('retry/enablejs') ||
        (body.includes('<title>Google Search</title>') && body.includes('challenge'));
      if (isGoogleChallenge) {
        console.log(`[CF-BYPASS] google-cache returned its own challenge page — skipping`);
        return null;
      }
      if (!body.toLowerCase().includes('error 1000')) {
        // Strip Google's cache banner, leaving only the original page HTML.
        // The original document starts with its own <!DOCTYPE or <html> tag
        // after Google's header/banner section.
        let clean = body;
        // Google inserts a 'X-Cache-Lookup' marker div; original content follows
        const gcBannerEnd = body.indexOf('</div><div id="googcache_main_frame"');
        if (gcBannerEnd > -1) clean = body.slice(gcBannerEnd + 36);
        // Fallback: find first occurrence of the page's own DOCTYPE/html
        else {
          const m = body.match(/<(!DOCTYPE|html)[\s>]/i);
          if (m) clean = body.slice(body.indexOf(m[0]));
        }
        if (clean.length > 300) {
          console.log(`[CF-BYPASS] google-cache served ${targetUrl}`);
          return { body: clean, source: 'google-cache' };
        }
      }
    }
  } catch (e) {
    console.log(`[CF-BYPASS] google-cache failed: ${e.message}`);
  }
  return null;
}

// ─── archive.today (non-CF, runs on own servers) ─────────────────────────────
// archive.ph / archive.today uses their own IP infrastructure, not Cloudflare.
// They return a snapshot of the page as-is.

async function tryArchiveToday(targetUrl) {
  // archive.today's newest endpoint redirects to the latest snapshot
  const atUrl = `https://archive.ph/newest/${encodeURIComponent(targetUrl)}`;
  try {
    // Follow up to 3 redirects manually
    let current = atUrl;
    for (let i = 0; i < 3; i++) {
      const result = await fetchDirect(current, {}, 8000);
      if (result.statusCode >= 300 && result.statusCode < 400 && result.headers.location) {
        current = result.headers.location.startsWith('http')
          ? result.headers.location
          : new URL(result.headers.location, current).href;
        continue;
      }
      if (result.statusCode === 200 && result.body.length > 300 &&
          !result.body.toLowerCase().includes('error 1000')) {
        console.log(`[CF-BYPASS] archive.today served ${targetUrl}`);
        return { body: result.body, source: 'archive.today' };
      }
      break;
    }
  } catch (e) {
    console.log(`[CF-BYPASS] archive.today failed: ${e.message}`);
  }
  return null;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Try to fetch targetUrl via non-CF relay services.
 * All relays race in parallel — the fastest successful response wins.
 * Returns { body: string, source: string } or null if all relays fail.
 */
export function tryViaRelay(targetUrl) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (!resolved && result) { resolved = true; resolve(result); }
    };

    const relays = [
      tryWayback(targetUrl),
      tryGoogleCache(targetUrl),
      tryArchiveToday(targetUrl),
    ];

    let remaining = relays.length;
    for (const p of relays) {
      p.then(r => {
        done(r);
        remaining--;
        if (remaining === 0 && !resolved) resolve(null);
      }).catch(() => {
        remaining--;
        if (remaining === 0 && !resolved) resolve(null);
      });
    }
  });
}

// ─── HTTP CONNECT tunnel (for POST/PUT/PATCH) ─────────────────────────────────
// For non-GET methods, free relay services can't help. We use HTTP CONNECT
// tunneling through public open proxies that run on non-CF IP ranges.

const PUBLIC_HTTP_PROXIES = [
  ['195.154.185.32', 3128],
  ['5.188.166.22',   3128],
  ['91.108.4.31',    3128],
  ['103.152.112.162', 80],
  ['185.199.229.156', 7492],
];

function requestViaConnectProxy(proxyHost, proxyPort, targetUrl, reqOptions, bodyData, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(e); }
    const targetHost = u.hostname;
    const targetPort = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
    const isHttps = u.protocol === 'https:';

    const sock = net.connect(proxyPort, proxyHost, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('proxy timeout')); });
    sock.on('error', reject);

    let headerBuf = '';
    let tunnelReady = false;
    sock.on('data', (chunk) => {
      if (tunnelReady) return;
      headerBuf += chunk.toString();
      if (!headerBuf.includes('\r\n\r\n')) return;
      if (!headerBuf.startsWith('HTTP/1.1 200') && !headerBuf.startsWith('HTTP/1.0 200')) {
        sock.destroy();
        return reject(new Error('CONNECT rejected: ' + headerBuf.slice(0, 80)));
      }
      tunnelReady = true;

      const makeRequest = (socket) => {
        const method = reqOptions.method || 'GET';
        const path = u.pathname + u.search;
        const hdrs = {
          'Host': u.host,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'Accept-Encoding': 'gzip, deflate',
          'Accept-Language': 'en-US,en;q=0.9',
          'Connection': 'close',
          ...(reqOptions.headers || {}),
        };
        let reqStr = `${method} ${path} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(hdrs)) reqStr += `${k}: ${v}\r\n`;
        reqStr += '\r\n';
        socket.write(reqStr);
        if (bodyData) socket.write(bodyData);

        const resChunks = [];
        socket.on('data', c => resChunks.push(c));
        socket.on('end', async () => {
          try {
            const raw = Buffer.concat(resChunks);
            const rawStr = raw.toString('binary');
            const headerEnd = rawStr.indexOf('\r\n\r\n');
            if (headerEnd < 0) return reject(new Error('bad response'));
            const statusLine = rawStr.slice(0, rawStr.indexOf('\r\n'));
            const statusCode = parseInt(statusLine.split(' ')[1], 10);
            const headerPart = rawStr.slice(0, headerEnd);
            const ce = (headerPart.match(/content-encoding:\s*(\S+)/i) || [])[1] || '';
            const bodyBuf = raw.slice(headerEnd + 4);
            const decompressed = await decompress(bodyBuf, ce);
            resolve({ statusCode, body: decompressed.toString('utf8') });
          } catch (e) { reject(e); }
        });
        socket.on('error', reject);
      };

      if (isHttps) {
        const tlsSock = tls.connect({ socket: sock, servername: targetHost, rejectUnauthorized: false }, () => makeRequest(tlsSock));
        tlsSock.on('error', reject);
      } else {
        makeRequest(sock);
      }
    });
  });
}

export async function tryViaProxyTunnel(targetUrl, reqOptions = {}, bodyData = null) {
  const pool = [...PUBLIC_HTTP_PROXIES].sort(() => Math.random() - 0.5).slice(0, 3);
  for (const [host, port] of pool) {
    try {
      const result = await requestViaConnectProxy(host, port, targetUrl, reqOptions, bodyData, 8000);
      if (result && result.statusCode < 500) {
        console.log(`[CF-BYPASS] proxy tunnel ${host}:${port} → ${targetUrl} (${result.statusCode})`);
        return result;
      }
    } catch (e) {
      console.log(`[CF-BYPASS] proxy ${host}:${port} failed: ${e.message}`);
    }
  }
  return null;
}
