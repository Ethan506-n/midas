import http from 'http';
import https from 'https';
import { URL } from 'url';

/**
 * CAPTCHA and origin-sensitive resource passthrough.
 * This endpoint forwards requests with minimal header manipulation
 * to preserve the exact execution environment CAPTCHA scripts expect.
 */

const CAPTCHA_DOMAINS = [
  'www.google.com',
  'www.recaptcha.net',
  'www.gstatic.com',
  'js.hcaptcha.com',
  'api.hcaptcha.com',
  'newassets.hcaptcha.com',
  'challenges.cloudflare.com',
  'cdnjs.cloudflare.com',
];

export function isCaptchaDomain(hostname) {
  return CAPTCHA_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
}

export async function passthroughHandler(req, res, targetUrl) {
  const url = new URL(targetUrl);

  const headers = {};
  const keep = [
    'user-agent',
    'accept',
    'accept-language',
    'accept-encoding',
    'referer',
    'cookie',
    'origin',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
  ];

  for (const h of keep) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  headers['host'] = url.host;

  const lib = url.protocol === 'https:' ? https : http;
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers,
    rejectUnauthorized: false,
  };

  return new Promise((resolve, reject) => {
    const proxyReq = lib.request(options, (proxyRes) => {
      const outHeaders = { ...proxyRes.headers };

      delete outHeaders['content-security-policy'];
      delete outHeaders['content-security-policy-report-only'];
      outHeaders['access-control-allow-origin'] = req.headers['origin'] || '*';
      outHeaders['access-control-allow-credentials'] = 'true';

      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
      proxyRes.on('end', resolve);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Passthrough error');
      }
      reject(err);
    });

    req.pipe(proxyReq);
  });
}

