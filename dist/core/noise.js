/**
 * Traffic Noise Injection Module
 * Adds decoy requests and payload padding to break traffic pattern analysis.
 */
let config = {
    enabled: true,
    decoyProbability: 0.1,
    minDecoyInterval: 5000,
    maxDecoyInterval: 30000,
    paddingEnabled: false,
};
let noiseTimer = null;
let isRunning = false;
const DECOY_ENDPOINTS = [
    '/favicon.ico',
    '/robots.txt',
    '/sitemap.xml',
    '/.well-known/security.txt',
    '/assets/logo.png',
    '/assets/icon.svg',
];
const DECOY_ORIGINS = [
    'https://www.google.com',
    'https://cdnjs.cloudflare.com',
    'https://fonts.googleapis.com',
    'https://ajax.googleapis.com',
    'https://unpkg.com',
];
export function initNoise(cfg = {}) {
    config = { ...config, ...cfg };
    if (config.enabled)
        startNoise();
}
export function stopNoise() {
    isRunning = false;
    if (noiseTimer) {
        clearTimeout(noiseTimer);
        noiseTimer = null;
    }
}
function startNoise() {
    if (isRunning)
        return;
    isRunning = true;
    scheduleNextDecoy();
}
function scheduleNextDecoy() {
    if (!isRunning)
        return;
    const delay = config.minDecoyInterval + Math.random() * (config.maxDecoyInterval - config.minDecoyInterval);
    noiseTimer = setTimeout(() => {
        if (Math.random() < config.decoyProbability) {
            sendDecoyRequest();
        }
        scheduleNextDecoy();
    }, delay);
}
function sendDecoyRequest() {
    try {
        const endpoint = DECOY_ENDPOINTS[Math.floor(Math.random() * DECOY_ENDPOINTS.length)];
        const origin = DECOY_ORIGINS[Math.floor(Math.random() * DECOY_ORIGINS.length)];
        const url = origin + endpoint + '?_=' + Math.random().toString(36).slice(2);
        // Use fetch with no-cors to avoid CORS issues and make it look like a normal resource load
        fetch(url, { mode: 'no-cors', cache: 'no-store' }).catch(() => {
            // Expected to fail or be opaque, that's fine
        });
    }
    catch (e) {
        // Silent failure
    }
}
export function padPayload(data) {
    if (!config.paddingEnabled)
        return data;
    const paddingSize = Math.floor(Math.random() * 256);
    const padded = new Uint8Array(data.byteLength + paddingSize + 4);
    const view = new DataView(padded.buffer);
    view.setUint32(0, data.byteLength, true);
    padded.set(new Uint8Array(data), 4);
    // Fill padding with random bytes
    for (let i = data.byteLength + 4; i < padded.length; i++) {
        padded[i] = Math.floor(Math.random() * 256);
    }
    return padded.buffer;
}
export function unpadPayload(data) {
    if (!config.paddingEnabled)
        return data;
    const view = new DataView(data);
    const originalSize = view.getUint32(0, true);
    return data.slice(4, 4 + originalSize);
}
export function generateRandomTrafficBurst(count = 3) {
    for (let i = 0; i < count; i++) {
        setTimeout(() => sendDecoyRequest(), Math.random() * 2000);
    }
}
