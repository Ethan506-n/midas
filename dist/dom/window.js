/**
 * Minimal window.location and history shadowing.
 * Uses native Proxy and defineProperty instead of wholesale replacement.
 */
import { createHiddenProperty } from '../cloak/polymorph';
let locationProxy = null;
let originalLocation = null;
let currentTargetUrl = '';
export function installLocationHook(proxyBase, targetUrl) {
    if (originalLocation)
        return;
    originalLocation = window.location;
    currentTargetUrl = targetUrl;
    rebuildProxy();
    // Listen for location updates from the DOM patcher
    window.addEventListener('midas-location-update', (e) => {
        currentTargetUrl = e.detail.url;
        rebuildProxy();
    });
}
function rebuildProxy() {
    const parsed = new URL(currentTargetUrl);
    const fakeOrigin = parsed.origin;
    const fakeHost = parsed.host;
    const fakeHostname = parsed.hostname;
    const fakeHref = currentTargetUrl;
    const fakeProtocol = parsed.protocol;
    const fakePort = parsed.port;
    const fakePathname = parsed.pathname;
    const fakeSearch = parsed.search;
    const fakeHash = parsed.hash;
    const locProxy = new Proxy(originalLocation, {
        get(target, prop) {
            switch (prop) {
                case 'href': return fakeHref;
                case 'origin': return fakeOrigin;
                case 'host': return fakeHost;
                case 'hostname': return fakeHostname;
                case 'protocol': return fakeProtocol;
                case 'port': return fakePort;
                case 'pathname': return fakePathname;
                case 'search': return fakeSearch;
                case 'hash': return fakeHash;
                case 'toString': return () => fakeHref;
                case 'assign': return (url) => { navigate(url); };
                case 'replace': return (url) => { navigate(url, true); };
                case 'reload': return () => target.reload();
                default: return target[prop];
            }
        },
        set(target, prop, value) {
            if (prop === 'href') {
                navigate(value);
                return true;
            }
            target[prop] = value;
            return true;
        }
    });
    try {
        Object.defineProperty(window, 'location', {
            get() { return locProxy; },
            set(v) { navigate(v); },
            configurable: true,
        });
    }
    catch (e) {
        // Fallback for strict environments
    }
    createHiddenProperty(window, '__midas_loc_real', originalLocation);
}
export function installHistoryHook() {
    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);
    history.pushState = function (data, unused, url) {
        if (url) {
            const resolved = new URL(url, window.location.href).href;
            origPushState(data, unused, resolved);
        }
        else {
            origPushState(data, unused);
        }
    };
    history.replaceState = function (data, unused, url) {
        if (url) {
            const resolved = new URL(url, window.location.href).href;
            origReplaceState(data, unused, resolved);
        }
        else {
            origReplaceState(data, unused);
        }
    };
    createHiddenProperty(history, '__midas_push_orig', origPushState);
    createHiddenProperty(history, '__midas_replace_orig', origReplaceState);
}
function navigate(url, replace = false) {
    const fullUrl = new URL(url, window.location.href).href;
    // Dispatch to transport layer
    const event = new CustomEvent('midas-navigate', { detail: { url: fullUrl, replace } });
    window.dispatchEvent(event);
}
export function uninstallHooks() {
    if (originalLocation) {
        try {
            Object.defineProperty(window, 'location', {
                get() { return originalLocation; },
                configurable: true,
            });
        }
        catch (e) { }
        originalLocation = null;
    }
}
