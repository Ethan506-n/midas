/**
 * CAPTCHA compatibility layer.
 * Ensures origin-sensitive scripts execute in their expected environment.
 */
const CAPTCHA_ORIGINS = [
    'https://www.google.com',
    'https://www.recaptcha.net',
    'https://www.gstatic.com',
    'https://js.hcaptcha.com',
    'https://api.hcaptcha.com',
    'https://newassets.hcaptcha.com',
    'https://challenges.cloudflare.com',
];
export function isCaptchaUrl(url) {
    try {
        const u = new URL(url);
        return CAPTCHA_ORIGINS.some(o => u.origin === o);
    }
    catch (e) {
        return false;
    }
}
export function rewriteCaptchaScript(src, proxyBase) {
    if (!isCaptchaUrl(src))
        return src;
    return `${proxyBase}/_midas/passthrough?url=${encodeURIComponent(src)}`;
}
export function installCaptchaHooks(proxyBase) {
    // Intercept script injection for known CAPTCHA providers
    const origCreateElement = document.createElement.bind(document);
    document.createElement = function (tagName, options) {
        const el = origCreateElement(tagName, options);
        if (tagName.toLowerCase() === 'script') {
            const origSetAttribute = el.setAttribute.bind(el);
            el.setAttribute = function (name, value) {
                if (name === 'src' && isCaptchaUrl(value)) {
                    value = `${proxyBase}/_midas/passthrough?url=${encodeURIComponent(value)}`;
                }
                return origSetAttribute(name, value);
            };
            let srcValue = '';
            Object.defineProperty(el, 'src', {
                get() { return srcValue; },
                set(v) {
                    srcValue = isCaptchaUrl(v)
                        ? `${proxyBase}/_midas/passthrough?url=${encodeURIComponent(v)}`
                        : v;
                    origSetAttribute('src', srcValue);
                },
                configurable: true,
            });
        }
        return el;
    };
    // Ensure fetch/xhr to captcha origins use passthrough
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input.toString();
        if (isCaptchaUrl(url)) {
            const headers = new Headers(init?.headers);
            headers.set('x-midas-passthrough', '1');
            return origFetch(`${proxyBase}/_midas/passthrough?url=${encodeURIComponent(url)}`, {
                ...init,
                headers,
                credentials: 'include',
            });
        }
        return origFetch(input, init);
    };
}
