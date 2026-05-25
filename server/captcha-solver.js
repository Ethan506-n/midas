/**
 * CAPTCHA Solver Module
 * Integrates with multiple CAPTCHA solving services
 * Supports: reCAPTCHA (v2/v3), hCaptcha, etc.
 */

import http from 'http';
import https from 'https';

// CAPTCHA service configurations
const CAPTCHA_SERVICES = {
  '2CAPTCHA': {
    apiUrl: 'http://2captcha.com/api',
    submitEndpoint: '/upload',
    resultEndpoint: '/res.php',
    apiKey: process.env.CAPTCHA_2CAPTCHA_API_KEY || '', // Set via environment variable
  },
  'ANTICAPTCHA': {
    apiUrl: 'https://api.anti-captcha.com/createTask',
    resultUrl: 'https://api.anti-captcha.com/getTaskResult',
    apiKey: process.env.CAPTCHA_ANTICAPTCHA_API_KEY || '',
  },
  'DEATHBYCAPTCHA': {
    apiUrl: 'http://api.dbcapi.me/api/captcha',
    apiKey: process.env.CAPTCHA_DBC_API_KEY || '',
  },
};

/**
 * Detect CAPTCHA type from HTML
 */
function detectCaptchaType(html) {
  if (!html || typeof html !== 'string') return null;
  
  const lowerHtml = html.toLowerCase();
  
  if (lowerHtml.includes('g-recaptcha') || lowerHtml.includes('recaptcha')) {
    if (lowerHtml.includes('recaptcha/api.js')) {
      // Check for v2 vs v3
      if (lowerHtml.includes('data-callback') || lowerHtml.includes('data-size')) {
        return { type: 'reCAPTCHA', version: 2 };
      } else if (lowerHtml.includes('data-action')) {
        return { type: 'reCAPTCHA', version: 3 };
      }
      return { type: 'reCAPTCHA', version: 2 };
    }
  }
  
  if (lowerHtml.includes('hcaptcha') || lowerHtml.includes('h-captcha')) {
    return { type: 'hCaptcha' };
  }
  
  if (lowerHtml.includes('cloudflare') && lowerHtml.includes('turnstile')) {
    return { type: 'Cloudflare Turnstile' };
  }
  
  if (lowerHtml.includes('challenge') && lowerHtml.includes('captcha')) {
    return { type: 'Generic Captcha' };
  }
  
  return null;
}

/**
 * Extract reCAPTCHA sitekey from HTML
 */
function extractRecaptchaSiteKey(html) {
  if (!html || typeof html !== 'string') return null;
  
  // Try multiple patterns
  const patterns = [
    /data-sitekey="([^"]+)"/,
    /data-sitekey='([^']+)'/,
    /"sitekey"\s*:\s*"([^"]+)"/,
    /'sitekey'\s*:\s*'([^']+)'/,
    /g-recaptcha[^>]*data-sitekey="([^"]+)"/,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  return null;
}

/**
 * Extract hCaptcha sitekey from HTML
 */
function extractHcaptchaSiteKey(html) {
  if (!html || typeof html !== 'string') return null;
  
  const patterns = [
    /data-sitekey="([^"]+)"/,
    /data-sitekey='([^']+)'/,
    /"sitekey"\s*:\s*"([^"]+)"/,
    /h-captcha[^>]*data-sitekey="([^"]+)"/,
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  return null;
}

/**
 * Solve reCAPTCHA v2 using 2Captcha
 */
async function solveRecaptchaV2(sitekey, pageUrl, serviceKey = '2CAPTCHA') {
  return new Promise((resolve, reject) => {
    const service = CAPTCHA_SERVICES[serviceKey];
    if (!service.apiKey) {
      return reject(new Error(`${serviceKey} API key not configured`));
    }
    
    const postData = new URLSearchParams({
      key: service.apiKey,
      method: 'userrecaptcha',
      googlekey: sitekey,
      pageurl: pageUrl,
      json: 1,
    });
    
    const req = http.request(`${service.apiUrl}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData.toString()),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.status === 0) {
            // Solution in progress, poll for result
            pollCaptchaResult(response.captcha_id, serviceKey)
              .then(resolve)
              .catch(reject);
          } else if (response.status === 1) {
            resolve(response.request);
          } else {
            reject(new Error(`CAPTCHA Error: ${response.error_text}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData.toString());
    req.end();
  });
}

/**
 * Poll for CAPTCHA solution result
 */
async function pollCaptchaResult(captchaId, serviceKey = '2CAPTCHA', maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    const service = CAPTCHA_SERVICES[serviceKey];
    let attempts = 0;
    
    const poll = () => {
      attempts++;
      if (attempts > maxAttempts) {
        return reject(new Error('CAPTCHA solving timeout'));
      }
      
      const query = new URLSearchParams({
        key: service.apiKey,
        action: 'get',
        captcha_id: captchaId,
        json: 1,
      });
      
      http.get(`${service.apiUrl}/res.php?${query.toString()}`, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.status === 0) {
              // Still processing, wait and retry
              setTimeout(poll, 2000);
            } else if (response.status === 1) {
              resolve(response.request);
            } else {
              reject(new Error(`CAPTCHA Poll Error: ${response.error_text}`));
            }
          } catch (e) {
            setTimeout(poll, 2000);
          }
        });
      }).on('error', reject);
    };
    
    poll();
  });
}

/**
 * Solve hCaptcha using 2Captcha
 */
async function solveHcaptcha(sitekey, pageUrl, serviceKey = '2CAPTCHA') {
  return new Promise((resolve, reject) => {
    const service = CAPTCHA_SERVICES[serviceKey];
    if (!service.apiKey) {
      return reject(new Error(`${serviceKey} API key not configured`));
    }
    
    const postData = new URLSearchParams({
      key: service.apiKey,
      method: 'hcaptcha',
      sitekey: sitekey,
      pageurl: pageUrl,
      json: 1,
    });
    
    const req = http.request(`${service.apiUrl}/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData.toString()),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.status === 0 && response.captcha_id) {
            pollCaptchaResult(response.captcha_id, serviceKey)
              .then(resolve)
              .catch(reject);
          } else if (response.status === 1) {
            resolve(response.request);
          } else {
            reject(new Error(`CAPTCHA Error: ${response.error_text}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(postData.toString());
    req.end();
  });
}

/**
 * Inject solved CAPTCHA token into HTML response
 */
function injectCaptchaToken(html, captchaType, token) {
  if (!html || typeof html !== 'string') return html;
  
  switch (captchaType.type) {
    case 'reCAPTCHA':
      // Inject token into g-recaptcha-response
      const injectionScript = `
        <script>
        document.getElementById('g-recaptcha-response').innerHTML = '${token}';
        if (typeof ___grecaptcha_cfg !== 'undefined') {
          Object.entries(___grecaptcha_cfg.clients).forEach(([key, client]) => {
            if (client.callback) {
              client.callback('${token}');
            }
          });
        }
        if (typeof __recaptcha_api !== 'undefined') {
          __recaptcha_api.render('g-recaptcha', { callback: function() { return '${token}'; } });
        }
        </script>
      `;
      
      const headIndex = html.indexOf('</head>');
      if (headIndex !== -1) {
        return html.slice(0, headIndex) + injectionScript + html.slice(headIndex);
      }
      return html;
      
    case 'hCaptcha':
      // Inject into hCaptcha response
      const hcaptchaScript = `
        <script>
        if (typeof hcaptcha !== 'undefined') {
          hcaptcha.getResponse = function() { return '${token}'; };
        }
        document.dispatchEvent(new CustomEvent('hcaptcha.success', { detail: { response: '${token}' } }));
        </script>
      `;
      
      const hHeadIndex = html.indexOf('</head>');
      if (hHeadIndex !== -1) {
        return html.slice(0, hHeadIndex) + hcaptchaScript + html.slice(hHeadIndex);
      }
      return html;
      
    default:
      return html;
  }
}

/**
 * Main CAPTCHA solver function - autodetects and solves
 */
async function solveCaptcha(html, pageUrl, serviceKey = '2CAPTCHA') {
  try {
    const captchaType = detectCaptchaType(html);
    
    if (!captchaType) {
      return null; // No CAPTCHA detected
    }
    
    console.log(`[CAPTCHA] Detected ${captchaType.type}, attempting to solve...`);
    
    let token;
    
    switch (captchaType.type) {
      case 'reCAPTCHA':
        const sitekey = extractRecaptchaSiteKey(html);
        if (!sitekey) throw new Error('Could not extract reCAPTCHA sitekey');
        token = await solveRecaptchaV2(sitekey, pageUrl, serviceKey);
        console.log(`[CAPTCHA] Solved reCAPTCHA v${captchaType.version}`);
        break;
        
      case 'hCaptcha':
        const hcaptchaSitekey = extractHcaptchaSiteKey(html);
        if (!hcaptchaSitekey) throw new Error('Could not extract hCaptcha sitekey');
        token = await solveHcaptcha(hcaptchaSitekey, pageUrl, serviceKey);
        console.log('[CAPTCHA] Solved hCaptcha');
        break;
        
      default:
        console.log(`[CAPTCHA] No solver available for ${captchaType.type}`);
        return null;
    }
    
    return {
      type: captchaType,
      token: token,
      html: injectCaptchaToken(html, captchaType, token),
    };
  } catch (error) {
    console.error('[CAPTCHA] Solving failed:', error.message);
    return null;
  }
}

export {
  detectCaptchaType,
  extractRecaptchaSiteKey,
  extractHcaptchaSiteKey,
  solveRecaptchaV2,
  solveHcaptcha,
  pollCaptchaResult,
  injectCaptchaToken,
  solveCaptcha,
  CAPTCHA_SERVICES,
};
