/**
 * Stealth Service Worker.
 * Mimics a legitimate PWA cache worker to avoid proxy interception signatures.
 */

const CACHE_NAME = 'midas-assets-v1';
const STEALTH_ROUTES = ['/_midas/'];

// Pre-cache legitimate-looking assets to blend in
const PRECACHE_ASSETS = [
  '/',
  '/loader.js',
  '/midas.client.js',
];

(self as any).addEventListener('install', (event: any) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache: any) => cache.addAll(PRECACHE_ASSETS))
  );
  (self as any).skipWaiting();
});

(self as any).addEventListener('activate', (event: any) => {
  event.waitUntil((self as any).clients.claim());
});

(self as any).addEventListener('fetch', (event: any) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only intercept midas proxy routes; let everything else pass normally
  const isMidasRoute = STEALTH_ROUTES.some(r => url.pathname.startsWith(r));

  if (!isMidasRoute && !req.headers.has('x-midas-sid')) {
    event.respondWith(normalFetch(req));
    return;
  }

  event.respondWith(proxyFetch(req));
});

async function normalFetch(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;

  const resp = await fetch(req);
  if (resp.ok && req.method === 'GET') {
    cache.put(req, resp.clone());
  }
  return resp;
}

async function proxyFetch(req: Request): Promise<Response> {
  // Forward to the main proxy endpoint with minimal modification
  try {
    const headers = new Headers(req.headers);
    headers.set('x-sw-intercept', '1');

    const init: RequestInit = {
      method: req.method,
      headers,
      mode: 'cors',
      credentials: 'same-origin',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = await req.blob();
    }

    const resp = await fetch(req.url, init);

    // Strip security headers that break proxied content
    const outHeaders = new Headers(resp.headers);
    outHeaders.delete('content-security-policy');
    outHeaders.delete('content-security-policy-report-only');
    outHeaders.delete('x-frame-options');

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    });
  } catch (e) {
    return new Response('Proxy fetch failed', { status: 502 });
  }
}

// Periodic background sync to look like a normal PWA
(self as any).addEventListener('sync', (event: any) => {
  if (event.tag === 'midas-background-sync') {
    event.waitUntil(Promise.resolve());
  }
});

