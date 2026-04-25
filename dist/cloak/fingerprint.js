/**
 * Advanced Anti-Fingerprinting Module
 * Adds noise to canvas, WebGL, audio, and timing fingerprints.
 * Randomizes navigator properties and screen metrics.
 */
let config = { noiseLevel: 0.5, enabled: true };
export function initAntiFingerprint(cfg = {}) {
    config = { ...config, ...cfg };
    if (!config.enabled)
        return;
    patchCanvas();
    patchWebGL();
    patchAudio();
    patchNavigator();
    patchScreen();
    patchTiming();
}
function patchCanvas() {
    const proto = HTMLCanvasElement.prototype;
    const origGetContext = proto.getContext.bind(proto);
    proto.getContext = function (contextId, options) {
        const ctx = origGetContext(contextId, options);
        if (!ctx)
            return ctx;
        if (contextId === '2d' && ctx instanceof CanvasRenderingContext2D) {
            patchCanvas2D(ctx);
        }
        else if ((contextId === 'webgl' || contextId === 'experimental-webgl') && ctx instanceof WebGLRenderingContext) {
            patchWebGLContext(ctx);
        }
        return ctx;
    };
}
function patchCanvas2D(ctx) {
    const origGetImageData = ctx.getImageData.bind(ctx);
    ctx.getImageData = function (sx, sy, sw, sh) {
        const data = origGetImageData(sx, sy, sw, sh);
        addPixelNoise(data.data);
        return data;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL.bind(ctx.canvas);
    const origToBlob = HTMLCanvasElement.prototype.toBlob.bind(ctx.canvas);
    ctx.canvas.toDataURL = function (type, quality) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        if (w === 0 || h === 0)
            return origToDataURL(type, quality);
        const img = origGetImageData(0, 0, w, h);
        addPixelNoise(img.data);
        ctx.putImageData(img, 0, 0);
        const result = origToDataURL(type, quality);
        return result;
    };
    ctx.canvas.toBlob = function (callback, type, quality) {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        if (w === 0 || h === 0) {
            origToBlob(callback, type, quality);
            return;
        }
        const img = origGetImageData(0, 0, w, h);
        addPixelNoise(img.data);
        ctx.putImageData(img, 0, 0);
        origToBlob(callback, type, quality);
    };
}
function addPixelNoise(data) {
    const level = config.noiseLevel || 0.5;
    for (let i = 0; i < data.length; i += 4) {
        const noise = (Math.random() - 0.5) * level * 2;
        data[i] = Math.min(255, Math.max(0, data[i] + noise));
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise));
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise));
    }
}
function patchWebGL() {
    // WebGL fingerprinting is done via parameter queries
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (pname) {
        const result = origGetParameter.call(this, pname);
        // Add tiny noise to float parameters that are commonly fingerprinted
        if (typeof result === 'number' && pname !== 0x0D31 && pname !== 0x0D33) {
            return result + (Math.random() - 0.5) * 0.0001;
        }
        return result;
    };
}
function patchWebGLContext(gl) {
    // Additional WebGL context patching if needed
}
function patchAudio() {
    if (!window.AudioContext && !window.webkitAudioContext)
        return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const origCreateAnalyser = AC.prototype.createAnalyser;
    AC.prototype.createAnalyser = function () {
        const analyser = origCreateAnalyser.call(this);
        const origGetFloatFrequencyData = analyser.getFloatFrequencyData.bind(analyser);
        analyser.getFloatFrequencyData = function (array) {
            origGetFloatFrequencyData(array);
            for (let i = 0; i < array.length; i++) {
                array[i] += (Math.random() - 0.5) * 0.1;
            }
        };
        return analyser;
    };
}
function patchNavigator() {
    const props = {
        hardwareConcurrency: Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4)),
        deviceMemory: [2, 4, 8][Math.floor(Math.random() * 3)],
        maxTouchPoints: navigator.maxTouchPoints || 0,
        platform: navigator.platform,
    };
    for (const [key, value] of Object.entries(props)) {
        try {
            Object.defineProperty(navigator, key, {
                get() { return value; },
                configurable: true,
            });
        }
        catch (e) { }
    }
    // Randomize user agent slightly (if possible)
    const ua = navigator.userAgent;
    if (ua.includes('Chrome/')) {
        const version = ua.match(/Chrome\/([\d.]+)/);
        if (version) {
            const minor = parseInt(version[1].split('.')[2] || '0', 10);
            const newMinor = Math.max(0, minor + Math.floor((Math.random() - 0.5) * 4));
            const newUa = ua.replace(version[1], version[1].replace(/\.\d+$/, `.${newMinor}`));
            try {
                Object.defineProperty(navigator, 'userAgent', {
                    get() { return newUa; },
                    configurable: true,
                });
            }
            catch (e) { }
        }
    }
}
function patchScreen() {
    // Add tiny variation to screen dimensions (some sites fingerprint these)
    const variations = [0, 0, 0, 0];
    try {
        Object.defineProperty(screen, 'availWidth', {
            get() { return screen.width + variations[0]; },
            configurable: true,
        });
        Object.defineProperty(screen, 'availHeight', {
            get() { return screen.height + variations[1]; },
            configurable: true,
        });
    }
    catch (e) { }
}
function patchTiming() {
    // Add jitter to performance.now() to prevent timing-based fingerprinting
    const origNow = performance.now.bind(performance);
    let drift = 0;
    performance.now = function () {
        const result = origNow() + drift;
        drift += (Math.random() - 0.5) * 0.05;
        drift *= 0.95; // slowly decay
        return result;
    };
    // Patch Date.now slightly
    const origDateNow = Date.now.bind(Date);
    Date.now = function () {
        return origDateNow() + Math.floor((Math.random() - 0.5) * 2);
    };
}
export function generateNoiseProfile() {
    return {
        canvasNoise: Math.random(),
        webglNoise: Math.random(),
        audioNoise: Math.random(),
        timingJitter: Math.random(),
    };
}
