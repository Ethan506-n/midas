// Midas Service Worker - completely inert
// No fetch interception to avoid caching issues
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function() {});
// Intentionally no 'fetch' handler

