/**
 * Midas Proxy Loader
 * Minimal bootstrap that initializes the full client engine.
 * This file is small and inlines critical startup logic to avoid detection.
 */

(function() {
  'use strict';

  const NONCE = '876904a8a0b49c56';
  const BASE = window.location.origin;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js?n=' + NONCE, {
        scope: '/',
        updateViaCache: 'none',
      }).catch(() => {
        // SW registration failed, continue without it
      });
    }
  }

  async function init() {
    // Register service worker first to look like a PWA
    registerSW();

    // Load main client bundle
    try {
      await loadScript('/midas.client.js?n=' + NONCE);
    } catch (e) {
      console.error('Midas client load failed', e);
      return;
    }

    // Initialize if global init function exists
    if (typeof window.__midasInit === 'function') {
      window.__midasInit({ baseUrl: BASE, nonce: NONCE });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

