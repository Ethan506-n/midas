/**
 * CAPTCHA Handler Module
 * Detects and passes through CAPTCHA challenges with minimal interference
 * to preserve the exact execution environment they expect.
 */

const CAPTCHA_PATTERNS = [
  // reCAPTCHA
  { domain: 'www.google.com', paths: ['/recaptcha/', '/recaptcha/api.js', '/recaptcha/enterprise.js'] },
  { domain: 'www.recaptcha.net', paths: ['/recaptcha/'] },
  { domain: 'www.gstatic.com', paths: ['/recaptcha/'] },
  // hCaptcha
  { domain: 'js.hcaptcha.com', paths: ['/1/', '/hcaptcha.js'] },
  { domain: 'api.hcaptcha.com', paths: ['/checkcaptcha/', '/getcaptcha/'] },
  { domain: 'newassets.hcaptcha.com', paths: ['/captcha/'] },
  // Cloudflare Turnstile
  { domain: 'challenges.cloudflare.com', paths: ['/turnstile/'] },
  { domain: 'cdnjs.cloudflare.com', paths: ['/ajax/libs/turnstile/'] },
  // Generic challenge patterns
  { domain: null, paths: [], patterns: [
    /recaptcha/i,
    /hcaptcha/i,
    /turnstile/i,
    /grecaptcha/i,
    /cf-challenge/i,
    /challenge-platform/i,
  ]},
];

export function isCaptchaUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    for (const rule of CAPTCHA_PATTERNS) {
      if (rule.domain) {
        if (hostname === rule.domain || hostname.endsWith('.' + rule.domain)) {
          if (rule.paths.length === 0) return true;
          for (const p of rule.paths) {
            if (pathname.includes(p.toLowerCase())) return true;
          }
        }
      }
      if (rule.patterns) {
        for (const pat of rule.patterns) {
          if (pat.test(url)) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function isCaptchaHtml(html) {
  const indicators = [
    'g-recaptcha',
    'data-sitekey',
    'h-captcha',
    'cf-turnstile',
    'challenge-platform',
    'recaptcha/api.js',
    'hcaptcha.com',
    'turnstile.js',
  ];
  const lower = html.toLowerCase();
  return indicators.some(i => lower.includes(i));
}

export function buildPassthroughHeaders(reqHeaders, targetUrl) {
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
    'x-requested-with',
  ];

  for (const h of keep) {
    if (reqHeaders[h]) headers[h] = reqHeaders[h];
  }

  try {
    const parsed = new URL(targetUrl);
    headers['host'] = parsed.host;
  } catch {}

  return headers;
}

