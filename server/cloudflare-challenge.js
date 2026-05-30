/**
 * Cloudflare Challenge Solver
 *
 * Handles two classes of Cloudflare challenges:
 *
 * 1. IUAM (Interstitial Under Attack Mode) — the old JS math challenge.
 *    Parameters are embedded in the HTML, the expression can be evaluated in
 *    a Node.js VM, and the answer submitted to /cdn-cgi/l/chk_jschl.
 *    The response sets cf_clearance which we store in the session cookie jar.
 *
 * 2. Turnstile / Managed challenge — modern bot-detection widget that requires
 *    real browser JS execution.  We cannot solve these headlessly, so we serve
 *    the challenge HTML back to the user through the proxy.  The user's browser
 *    runs the widget; all API calls to challenges.cloudflare.com flow through
 *    sandbox.js → our proxy → CF, and the resulting Set-Cookie: cf_clearance
 *    is captured by storeCookies() in router.js and stored in the session jar.
 *    The next page load uses the stored clearance automatically.
 */

import vm from 'vm';
import https from 'https';
import http from 'http';

/**
 * Classify the challenge type so we can choose the right strategy.
 */
export function detectChallengeType(html) {
  if (!html) return 'unknown';
  const lower = html.toLowerCase();

  if (lower.includes('jschl_vc') || lower.includes('jschl-answer') ||
      lower.includes('chk_jschl')) {
    return 'iuam';
  }
  if (lower.includes('cf-turnstile') || lower.includes('window.turnstile') ||
      lower.includes('turnstile.render') || lower.includes('challenges.cloudflare.com/turnstile')) {
    return 'turnstile';
  }
  if (lower.includes('challenge-platform') || lower.includes('orchestrate') ||
      lower.includes('chl_page')) {
    return 'managed';
  }
  if (lower.includes('just a moment') || lower.includes('checking your browser')) {
    return 'managed';
  }
  return 'unknown';
}

/**
 * Check whether the session jar already holds a live cf_clearance for hostname.
 */
export function hasCFClearance(jar, hostname) {
  if (!jar) return false;
  const now = Date.now();
  for (const [host, cookies] of jar) {
    if (host !== hostname && !hostname.endsWith('.' + host)) continue;
    const found = cookies.find(
      c => c.name === 'cf_clearance' && (!c.expires || c.expires > now)
    );
    if (found) return true;
  }
  return false;
}

/**
 * Extract a Ray ID for logging.
 */
export function extractCFRayId(html) {
  const m = html.match(/Ray\s+ID[:\s•]+([a-f0-9]{16,})/i);
  return m ? m[1] : null;
}

/**
 * Attempt to solve the old-style IUAM JS math challenge server-side.
 *
 * Flow:
 *   1. Parse jschl_vc / pass / s from hidden form inputs
 *   2. Extract the obfuscated JS expression from the <script> block
 *   3. Run it in a sandboxed Node.js VM with a minimal browser stub
 *   4. Wait the ~4 s CF requires before accepting the answer
 *   5. GET /cdn-cgi/l/chk_jschl?... and collect the cf_clearance Set-Cookie
 *
 * Returns { success: true, setCookieHeaders: [...] }
 *      or { success: false, reason: '...' }
 */
export async function attemptIUAMSolve(html, targetUrl) {
  try {
    const url = new URL(targetUrl);
    const hostname = url.hostname;

    const jschlVc = extractInput(html, 'jschl_vc');
    const pass    = extractInput(html, 'pass');
    const s       = extractInput(html, 's');

    if (!jschlVc || !pass) {
      return { success: false, reason: 'missing jschl_vc or pass field' };
    }

    const challengeScript = extractChallengeScript(html);
    if (!challengeScript) {
      return { success: false, reason: 'could not isolate challenge script' };
    }

    let capturedAnswer = null;

    const stubElement = () => ({
      get value() { return capturedAnswer || ''; },
      set value(v) { capturedAnswer = String(v); },
      submit: () => {},
      style: {},
    });

    const stubDoc = {
      getElementById: (_id) => stubElement(),
      createElement:  (_tag) => ({ style: {} }),
      location:       { reload: () => {} },
    };

    const vmCtx = vm.createContext({
      document:  stubDoc,
      window:    { document: stubDoc, location: { hostname, host: url.host } },
      location:  { hostname, host: url.host },
      setTimeout: (fn, _ms) => { try { fn(); } catch (_) {} },
      clearTimeout:  () => {},
      setInterval:   () => 0,
      clearInterval: () => {},
      navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      Math,
      parseInt,
      parseFloat,
      String,
      Number,
      Array,
      Object,
    });

    try {
      vm.runInContext(challengeScript, vmCtx, { timeout: 5000 });
    } catch (vmErr) {
      if (!capturedAnswer) {
        return { success: false, reason: `VM error (no answer): ${vmErr.message}` };
      }
    }

    if (!capturedAnswer) {
      return { success: false, reason: 'script executed but produced no answer' };
    }

    // CF requires the client to wait before submitting
    await delay(4500);

    const params = new URLSearchParams({ jschl_vc: jschlVc, jschl_answer: capturedAnswer, pass });
    if (s) params.set('s', s);

    const submitUrl = `${url.protocol}//${url.host}/cdn-cgi/l/chk_jschl?${params}`;
    console.log(`[CF-IUAM] Submitting answer for ${hostname}: ${capturedAnswer}`);

    const result = await rawGet(submitUrl, {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'referer': targetUrl,
      'host': url.host,
    });

    const setCookies = [].concat(result.headers['set-cookie'] || []);
    const hasClearance = setCookies.some(c => c.toLowerCase().startsWith('cf_clearance'));

    if (hasClearance) {
      console.log(`[CF-IUAM] Solved! cf_clearance obtained for ${hostname}`);
      return { success: true, setCookieHeaders: setCookies };
    }

    return {
      success: false,
      reason: `submission returned status ${result.status} but no cf_clearance cookie`,
    };
  } catch (err) {
    return { success: false, reason: `unexpected error: ${err.message}` };
  }
}

function extractInput(html, name) {
  const m = html.match(new RegExp(`name=["']${name}["']\\s+value=["']([^"']+)["']`)) ||
            html.match(new RegExp(`name=["']${name}["'][^>]*value=["']([^"']+)["']`));
  return m ? m[1] : null;
}

function extractChallengeScript(html) {
  // Prefer the setTimeout block (classic IUAM pattern)
  const st = html.match(/setTimeout\s*\(\s*function\s*\(\s*\)\s*\{([\s\S]+?)\}\s*,\s*\d+\s*\)/);
  if (st) return st[1];

  // CDATA block
  const cd = html.match(/\/\/<!\[CDATA\[([\s\S]*?)\/\/\]\]>/);
  if (cd) return cd[1];

  // Last <script> that references jschl or challenge form
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  for (let i = scripts.length - 1; i >= 0; i--) {
    const body = scripts[i][1];
    if (/jschl|challenge-form|chk_jschl/i.test(body)) return body;
  }

  return null;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Minimal raw GET that follows one redirect and returns { status, headers }.
 * Used only for IUAM answer submission — keeps the module dependency-free.
 */
function rawGet(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('too many redirects'));
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...headers, host: parsed.host },
        rejectUnauthorized: false,
      },
      (res) => {
        // Drain body
        res.on('data', () => {});
        res.on('end', () => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const next = new URL(res.headers.location, url).toString();
            rawGet(next, headers, redirectCount + 1).then(resolve).catch(reject);
          } else {
            resolve({ status: res.statusCode, headers: res.headers });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}
