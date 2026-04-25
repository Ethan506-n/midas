import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

const SRC = path.resolve('src');
const DIST = path.resolve('dist');
const PUBLIC = path.resolve('public');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

function randomId(len = 8) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

function stripModuleSyntax(code) {
  // Remove import statements
  code = code.replace(/^\s*import\s+.*?from\s+['"].*?['"];?\s*$/gm, '');
  code = code.replace(/^\s*import\s+['"].*?['"];?\s*$/gm, '');
  // Remove export keyword from declarations
  code = code.replace(/\bexport\s+(default\s+)?/g, '');
  return code;
}

function compileTypeScript() {
  try {
    execSync('npx tsc --outDir dist --declaration false --sourceMap false --module ES2022 --moduleResolution node --target ES2022 --lib ES2022,DOM,WebWorker --allowSyntheticDefaultImports --esModuleInterop --skipLibCheck', { stdio: 'inherit' });
  } catch (e) {
    console.warn('TypeScript compilation had warnings, continuing with partial output');
  }
}

function buildClient() {
  const modules = [
    'core/encoder.js',
    'core/crypto.js',
    'core/transport.js',
    'core/websocket.js',
    'core/noise.js',
    'cloak/detect.js',
    'cloak/polymorph.js',
    'cloak/fingerprint.js',
    'dom/window.js',
    'dom/patch.js',
    'dom/storage.js',
    'captcha/compat.js',
    'sandbox/iframe.js',
  ];

  let combined = '';
  for (const mod of modules) {
    const fp = path.join(DIST, mod);
    if (!fs.existsSync(fp)) {
      console.warn(`Module not found: ${fp}`);
      continue;
    }
    let src = fs.readFileSync(fp, 'utf-8');
    src = stripModuleSyntax(src);
    combined += `\n/* module: ${mod} */\n` + src + '\n';
  }

  // Append init bootstrap
  combined += `
/* bootstrap */
window.__midasInit = async function(cfg) {
  initDetection();
  initSession();
  initAntiFingerprint();
  initNoise();
  installWebSocketHook();

  const sidRes = await fetch(cfg.baseUrl + '/_midas/session', { method: 'POST' });
  const sidData = await sidRes.json();

  // Use polymorphic paths from server if available
  const paths = sidData.paths || {};

  await initTransport({ baseUrl: cfg.baseUrl, sessionId: sidData.sid });
  installLocationHook(cfg.baseUrl, window.location.href);
  installHistoryHook();
  installStorageHooks(window.location.href);
  installIndexedDBHook(window.location.href);
  startDomPatching(cfg.baseUrl);
  installCaptchaHooks(cfg.baseUrl);

  // Handle ?go= parameter on initial load
  const params = new URLSearchParams(window.location.search);
  const goUrl = params.get('go');
  if (goUrl) {
    try {
      const resp = await midasFetch(goUrl);
      const html = await resp.text();
      if (typeof injectHtml === 'function') {
        injectHtml(html, goUrl);
      }
    } catch (err) {
      console.error('Initial load failed:', err);
    }
  }
};
`;

  const nonce = randomId(16);
  combined = `(function(){\nconst __MIDAS_NONCE__='${nonce}';\n` + combined + `\n})();`;

  const outFile = path.join(PUBLIC, 'midas.client.js');
  fs.writeFileSync(outFile, combined);
  console.log(`Built client bundle: ${outFile} (nonce: ${nonce})`);
  return nonce;
}

function buildSW() {
  const fp = path.join(DIST, 'sw/stealth-sw.js');
  if (!fs.existsSync(fp)) return;
  let src = fs.readFileSync(fp, 'utf-8');
  const out = path.join(PUBLIC, 'sw.js');
  fs.writeFileSync(out, src);
  console.log(`Built SW: ${out}`);
}

function buildLoader(nonce) {
  const loaderPath = path.join(PUBLIC, 'loader.js');
  if (!fs.existsSync(loaderPath)) return;
  let src = fs.readFileSync(loaderPath, 'utf-8');
  src = src.replace(/__NONCE__/g, nonce);
  fs.writeFileSync(loaderPath, src);
}

compileTypeScript();
const nonce = buildClient();
buildSW();
buildLoader(nonce);
console.log('Build complete.');


