/**
 * Browser Automation Module
 * Integrates Puppeteer/Playwright for handling JavaScript rendering
 * Used when HTTP-only requests fail on JavaScript-heavy sites
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as webdriverBypass from './webdriver-bypass.js';
import * as ipProvider from './ip-provider.js';

let puppeteer;
try {
  puppeteer = puppeteerExtra;
  puppeteer.use(StealthPlugin());
} catch (e) {
  console.warn('[Browser Automation] Puppeteer not installed. JavaScript rendering will be disabled.');
  puppeteer = null;
}

// Browser pool to reuse browser instances
let browserInstance = null;
let pagePool = [];
const MAX_PAGES = 5;

/**
 * Initialize browser instance (lazy load)
 */
async function initBrowser() {
  if (browserInstance) {
    return browserInstance;
  }
  
  if (!puppeteer) {
    throw new Error('Puppeteer not installed. Run: npm install puppeteer-extra puppeteer-extra-plugin-stealth');
  }
  
  console.log('[Browser] Initializing Puppeteer with stealth options...');
  
  const stealthOptions = webdriverBypass.getStealthOptions();
  
  browserInstance = await puppeteer.launch({
    ...stealthOptions,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  
  console.log('[Browser] Puppeteer initialized successfully');
  return browserInstance;
}

/**
 * Get a page from the pool or create new one
 */
async function getPage(browser) {
  if (pagePool.length > 0) {
    return pagePool.pop();
  }
  
  const page = await browser.newPage();
  
  // Set realistic viewport
  await page.setViewport({ width: 1920, height: 1080 });
  
  // Set realistic user agent from rotation
  const browsers = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  ];
  
  const ua = browsers[Math.floor(Math.random() * browsers.length)];
  await page.setUserAgent(ua);
  
  // Set realistic headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  });
  
  // Random IP in X-Forwarded-For
  const ipChain = ipProvider.createProxyChain(3);
  await page.setExtraHTTPHeaders({
    'X-Forwarded-For': ipChain.chain,
    'X-Real-IP': ipChain.primary,
    'CF-Connecting-IP': ipChain.primary,
  });
  
  // Inject anti-detection scripts early
  await page.evaluateOnNewDocument(() => {
    eval(webdriverBypass.WEBDRIVER_BYPASS_SCRIPT);
    eval(webdriverBypass.ADVANCED_ANTI_DETECTION_SCRIPT);
  });
  
  // Enable request interception BEFORE setting up request handlers
  await page.setRequestInterception(true);
  
  // Block images and stylesheets to speed up loading
  await page.on('request', (request) => {
    const resourceType = request.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      request.abort();
    } else {
      request.continue();
    }
  });
  
  return page;
}

/**
 * Return page to pool or close if pool is full
 */
async function releasePage(page) {
  if (pagePool.length < MAX_PAGES) {
    await page.goto('about:blank'); // Clear page state
    pagePool.push(page);
  } else {
    await page.close();
  }
}

/**
 * Render page with JavaScript execution
 */
async function renderPageWithJS(url, options = {}) {
  try {
    const browser = await initBrowser();
    const page = await getPage(browser);
    
    const {
      waitUntil = 'networkidle2',
      timeout = 30000,
      waitForSelector = null,
      clickSelector = null,
      waitForNavigation = false,
    } = options;
    
    console.log(`[Browser] Rendering ${url} with JavaScript...`);
    
    try {
      // Navigate to page
      await page.goto(url, { 
        waitUntil: waitUntil,
        timeout: timeout,
      });
      
      // Wait for specific selector if provided
      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, { timeout: 5000 }).catch(() => {});
      }
      
      // Click specific element if needed (e.g., "Load More")
      if (clickSelector) {
        await page.click(clickSelector).catch(() => {});
        await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
      }
      
      // Extract content
      const content = await page.content();
      const cookies = await page.cookies();
      const headers = {
        'set-cookie': cookies.map(c => 
          `${c.name}=${c.value}; Path=${c.path}; Domain=${c.domain}` +
          (c.expires ? `; Expires=${new Date(c.expires * 1000).toUTCString()}` : '') +
          (c.httpOnly ? '; HttpOnly' : '') +
          (c.secure ? '; Secure' : '') +
          (c.sameSite ? `; SameSite=${c.sameSite}` : '')
        ),
      };
      
      console.log(`[Browser] Successfully rendered ${url}`);
      
      return {
        html: content,
        cookies: cookies,
        headers: headers,
        success: true,
      };
    } catch (error) {
      console.error(`[Browser] Failed to render ${url}:`, error.message);
      return {
        html: null,
        error: error.message,
        success: false,
      };
    } finally {
      await releasePage(page);
    }
  } catch (error) {
    console.error('[Browser] Rendering failed:', error.message);
    return {
      html: null,
      error: error.message,
      success: false,
    };
  }
}

/**
 * Handle JavaScript challenge (e.g., Cloudflare, reCAPTCHA)
 */
async function handleJSChallenge(url, options = {}) {
  try {
    const result = await renderPageWithJS(url, {
      waitUntil: 'networkidle2',
      timeout: 45000,
      ...options,
    });
    
    if (result.success && result.html) {
      console.log('[Browser] JavaScript challenge handled successfully');
      return result;
    } else {
      console.log('[Browser] Failed to handle JavaScript challenge');
      return result;
    }
  } catch (error) {
    console.error('[Browser] Challenge handling error:', error.message);
    return {
      html: null,
      error: error.message,
      success: false,
    };
  }
}

/**
 * Intercept and modify requests in browser
 */
async function renderWithInterception(url, requestModifier) {
  try {
    const browser = await initBrowser();
    const page = await getPage(browser);
    
    // Set up request interception
    await page.setRequestInterception(true);
    
    page.on('request', async (request) => {
      const modifiedRequest = requestModifier(request);
      if (modifiedRequest) {
        await request.continue(modifiedRequest);
      } else {
        await request.continue();
      }
    });
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const content = await page.content();
    
    await releasePage(page);
    
    return { html: content, success: true };
  } catch (error) {
    console.error('[Browser] Interception failed:', error.message);
    return { html: null, success: false, error: error.message };
  }
}

/**
 * Close browser and clear pool
 */
async function closeBrowser() {
  if (pagePool.length > 0) {
    for (const page of pagePool) {
      await page.close().catch(() => {});
    }
    pagePool = [];
  }
  
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
  
  console.log('[Browser] Browser instances closed');
}

/**
 * Check if Puppeteer is available
 */
function isAvailable() {
  return puppeteer !== null;
}

export {
  initBrowser,
  getPage,
  releasePage,
  renderPageWithJS,
  handleJSChallenge,
  renderWithInterception,
  closeBrowser,
  isAvailable,
};
