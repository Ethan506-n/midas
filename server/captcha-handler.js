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
  { domain: 'google.com', paths: ['/recaptcha/'] },
  
  // hCaptcha
  { domain: 'js.hcaptcha.com', paths: ['/1/', '/hcaptcha.js'] },
  { domain: 'api.hcaptcha.com', paths: ['/checkcaptcha/', '/getcaptcha/'] },
  { domain: 'newassets.hcaptcha.com', paths: ['/captcha/'] },
  { domain: 'hcaptcha.com', paths: [] },
  
  // Cloudflare Turnstile & IUAM
  { domain: 'challenges.cloudflare.com', paths: ['/turnstile/', '/cdn-cgi/challenge-platform/'] },
  { domain: 'cdnjs.cloudflare.com', paths: ['/ajax/libs/turnstile/'] },
  { domain: 'cloudflare.com', paths: ['/cdn-cgi/', '/challenge-platform/'] },
  
  // AWS WAF
  { domain: 'waf.amazonaws.com', paths: [] },
  { domain: 'wafv2.amazonaws.com', paths: [] },
  
  // Imperva/Incapsula
  { domain: 'cdn.incapsula.com', paths: ['/'] },
  { domain: 'imperva.com', paths: ['/'] },
  
  // Others
  { domain: 'arkose.com', paths: ['/v2/', '/api/'] },
  { domain: 'arkoselabs.com', paths: ['/'] },
  { domain: 'friendly-captcha.com', paths: ['/'] },
  { domain: 'altcaptcha.com', paths: ['/'] },
  
  // Cloudflare challenge assets
  { domain: null, paths: [], patterns: [
    /\/cdn-cgi\/challenge-platform/i,
    /\/turnstile\//i,
    /waf\.amazonaws\.com/i,
    /imperva\.com/i,
    /arcose|arkose/i,
    /friendly-captcha/i,
  ]},
  
  // Generic challenge patterns
  { domain: null, paths: [], patterns: [
    /recaptcha/i,
    /hcaptcha/i,
    /turnstile/i,
    /grecaptcha/i,
    /cf-challenge/i,
    /challenge-platform/i,
    /captcha/i,
    /challenge/i,
    /verify/i,
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
  const lower = html.toLowerCase();
  
  // Check for explicit CAPTCHA indicators (high confidence)
  const captchaPatterns = [
    // Google reCAPTCHA
    /g-recaptcha[>\s]/i,
    /data-sitekey[=\s]/i,
    /recaptcha\/api\.js/i,
    /grecaptcha\s*\./i,
    
    // hCaptcha
    /h-captcha[>\s]/i,
    /hcaptcha\.com/i,
    
    // Cloudflare Turnstile (specifically the challenge UI, not cdn-cgi scripts)
    /cf-turnstile[>\s]/i,
    /window\.turnstile/i,
    /turnstile\.render/i,
    
    // AWS WAF
    /aws-waf-/i,
    /waf\.amazonaws\.com/i,
    
    // Imperva
    /imperva/i,
    /incapsula\.com/i,
    
    // Arkose
    /arkose\.com/i,
    /getArkose/i,
    
    // Friendly Captcha
    /friendly-captcha/i,
    /friendlycaptcha\.com/i,
    
    // AltCaptcha
    /altcaptcha/i,
    
    // Generic CAPTCHA patterns (more specific than before)
    /class\s*=\s*["'].*captcha[^"']*["']/i,
    /id\s*=\s*["'].*captcha[^"']*["']/i,
    /<div\s+[^>]*data-captcha/i,
  ];
  
  return captchaPatterns.some(pattern => pattern.test(html));
}

// New function: Allow CAPTCHAs to render inline in the proxy
export function shouldAllowInlineCaptcha(html) {
  // Return true to allow CAPTCHA pages to render inline
  // This allows users to solve CAPTCHAs without leaving the proxy
  return isCaptchaHtml(html);
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

