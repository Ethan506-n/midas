/**
 * WebDriver Bypass Module
 * Removes WebDriver detection and injects anti-detection JS
 */

/**
 * JavaScript injection to bypass WebDriver detection
 * Executed before any page scripts run
 */
const WEBDRIVER_BYPASS_SCRIPT = `
(function() {
  // Remove navigator.webdriver property
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });
  
  // Remove chrome automation extensions
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin' },
      { name: 'Chrome PDF Viewer' },
      { name: 'Native Client Executable' }
    ],
  });
  
  // Hide Puppeteer/Playwright detection via --headless flag
  if (navigator.userAgentData) {
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: [
          { brand: ' Not A;Brand', version: '99' },
          { brand: 'Google Chrome', version: '91' },
          { brand: 'Chromium', version: '91' }
        ],
        platform: 'Windows',
        platformVersion: '10.0',
        architecture: 'x86',
        mobile: false,
        model: '',
      }),
    });
  }
  
  // Prevent detection of Chrome's remote debugging protocol
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];
    if (typeof url === 'string' && url.includes('127.0.0.1:9222')) {
      return Promise.reject(new Error('Not allowed'));
    }
    return originalFetch.apply(this, args);
  };
  
  // Block detection via WebSocket to debugging port
  const originalWebSocket = WebSocket;
  window.WebSocket = function(url) {
    if (url && url.includes('127.0.0.1:9222')) {
      throw new Error('Not allowed');
    }
    return new originalWebSocket(url);
  };
  
  // Hide chrome.runtime detection
  if (window.chrome) {
    window.chrome.runtime = undefined;
  }
  
  // Remove __SELENIUM_IDERUNNER__ global
  if (window.__SELENIUM_IDERUNNER__) {
    delete window.__SELENIUM_IDERUNNER__;
  }
  
  // Override console.log to hide Playwright/Puppeteer detection
  const originalWarn = console.warn;
  console.warn = function(...args) {
    if (args.toString().includes('Playwright') || args.toString().includes('Puppeteer')) {
      return;
    }
    return originalWarn.apply(console, args);
  };
  
  // Hide cdp (Chrome DevTools Protocol) detection
  Object.defineProperty(window, '__CDP_ENABLED__', {
    get: () => false,
    configurable: true,
  });
})();
`;

/**
 * Advanced anti-detection script
 * Spoof more properties to appear as real browser
 */
const ADVANCED_ANTI_DETECTION_SCRIPT = `
(function() {
  // Randomize performance timing to avoid timing-based detection
  const originalNow = performance.now;
  let offset = Math.random() * 1000;
  performance.now = function() {
    return originalNow.call(this) + offset;
  };
  
  // Hide Canvas fingerprinting detection
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(contextType) {
    if (contextType === '2d') {
      const ctx = originalGetContext.call(this, contextType);
      // Override toDataURL to return slightly different data each time
      const originalToDataURL = ctx.canvas.toDataURL;
      ctx.canvas.toDataURL = function(type, quality) {
        const data = originalToDataURL.call(this, type, quality);
        // Add slight noise to prevent exact fingerprint match
        return data.replace(/(.{100})/g, '$1' + Math.random().toString(36).substring(2, 4));
      };
    }
    return originalGetContext.call(this, contextType);
  };
  
  // Override WebGL fingerprinting
  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(pname) {
    if (pname === 37445) { // UNMASKED_VENDOR_WEBGL
      return 'Google Inc.';
    }
    if (pname === 37446) { // UNMASKED_RENDERER_WEBGL
      return 'ANGLE (Intel HD Graphics 630)';
    }
    return originalGetParameter.call(this, pname);
  };
  
  // Hide timezone detection
  const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() {
    return -300; // EST
  };
  
  // Hide screen resolution detection variations
  Object.defineProperty(screen, 'width', {
    get: () => 1920,
  });
  Object.defineProperty(screen, 'height', {
    get: () => 1080,
  });
  
  // Hide language detection
  Object.defineProperty(navigator, 'language', {
    get: () => 'en-US',
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
  
  // Block common bot detection scripts
  const scriptBlocker = {
    blocked: [
      'botdetect',
      'antibot',
      'fingerprint',
      'tracker',
      'detection',
      'beacon',
      'analytics'
    ]
  };
  
  // Override Image for tracking pixel detection
  const OriginalImage = window.Image;
  window.Image = function() {
    return new OriginalImage();
  };
  
  // Prevent script loading for detection services
  const originalCreateElement = document.createElement;
  document.createElement = function(tagName) {
    const element = originalCreateElement.call(document, tagName);
    
    if (tagName === 'script') {
      Object.defineProperty(element, 'src', {
        set(value) {
          if (scriptBlocker.blocked.some(b => value.includes(b))) {
            console.log('[Anti-detection] Blocked script:', value);
            return;
          }
          Object.defineProperty(element, '_src', { value, writable: true });
        },
        get() {
          return this._src || '';
        }
      });
    }
    
    return element;
  };
})();
`;

/**
 * Get WebDriver bypass payload for HTML injection
 */
function getWebDriverBypassPayload() {
  return `<script>${WEBDRIVER_BYPASS_SCRIPT}</script>`;
}

/**
 * Get advanced anti-detection payload
 */
function getAdvancedAntiDetectionPayload() {
  return `<script>${ADVANCED_ANTI_DETECTION_SCRIPT}</script>`;
}

/**
 * Inject both payloads into HTML
 */
function injectAntiDetectionScripts(html) {
  if (!html || typeof html !== 'string') return html;
  
  const injectionPoint = html.indexOf('</head>');
  if (injectionPoint === -1) {
    return html; // No head tag, return original
  }
  
  const payload = getWebDriverBypassPayload() + '\n' + getAdvancedAntiDetectionPayload();
  const injected = html.slice(0, injectionPoint) + payload + html.slice(injectionPoint);
  
  return injected;
}

/**
 * Check if page has anti-bot detection script
 */
function hasAntiBotDetectionScript(html) {
  if (!html || typeof html !== 'string') return false;
  
  const detectionPatterns = [
    /botdetect/i,
    /antibot/i,
    /__bfCheck__/i,
    /navigator\.webdriver/i,
    /cdp|chrome\.debugger|remote.*protocol/i,
    /fingerprint.*js/i,
    /frictionless/i,
  ];
  
  return detectionPatterns.some(pattern => pattern.test(html));
}

/**
 * Get browser stealth options for Puppeteer
 */
function getStealthOptions() {
  return {
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-resources',
      '--disable-sync',
      '--disable-extensions',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-popup-blocking',
      '--disable-extensions-except',
      '--disable-component-extensions-with-background-pages',
    ],
    headless: true,
    ignoreHTTPSErrors: true,
  };
}

/**
 * Get launch options for Playwright
 */
function getPlaywrightStealthOptions() {
  return {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
  };
}

module.exports = {
  WEBDRIVER_BYPASS_SCRIPT,
  ADVANCED_ANTI_DETECTION_SCRIPT,
  getWebDriverBypassPayload,
  getAdvancedAntiDetectionPayload,
  injectAntiDetectionScripts,
  hasAntiBotDetectionScript,
  getStealthOptions,
  getPlaywrightStealthOptions,
};
