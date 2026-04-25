/**
 * Lazy DOM patching via MutationObserver.
 * Avoids rewriting entire HTML; patches elements as they appear.
 */
let observer = null;
let baseProxyUrl = '';
let dynamicPaths = {};
export function setProxyPaths(paths) {
    dynamicPaths = paths;
}
function getProxyPath(key) {
    const p = dynamicPaths[key];
    if (p)
        return '/_midas/' + p;
    return '/_midas/' + key;
}
export function startDomPatching(proxyBase) {
    baseProxyUrl = proxyBase.replace(/\/$/, '');
    observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
            for (const node of Array.from(mut.addedNodes)) {
                if (node instanceof HTMLElement) {
                    patchElement(node);
                    patchChildren(node);
                }
            }
        }
    });
    observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
    });
    // Patch existing elements
    patchChildren(document.documentElement || document.body);
}
function patchChildren(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
        if (node instanceof HTMLElement)
            patchElement(node);
    }
}
function patchElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') {
        interceptLink(el);
    }
    if (tag === 'form') {
        interceptForm(el);
    }
    if (tag === 'img' || tag === 'source' || tag === 'track') {
        const src = el.getAttribute('src');
        if (src) {
            el.setAttribute('src', proxySubresource(src));
        }
        if (tag === 'img') {
            const srcset = el.getAttribute('srcset');
            if (srcset) {
                el.setAttribute('srcset', srcset.split(',').map(s => {
                    const parts = s.trim().split(/\s+/);
                    const url = parts[0];
                    const desc = parts.slice(1).join(' ');
                    return `${proxySubresource(url)}${desc ? ' ' + desc : ''}`;
                }).join(', '));
            }
        }
    }
    if (tag === 'link' && el.getAttribute('rel') === 'stylesheet') {
        const href = el.getAttribute('href');
        if (href)
            el.setAttribute('href', proxySubresource(href));
    }
    if (tag === 'script') {
        const src = el.getAttribute('src');
        if (src) {
            el.setAttribute('src', proxySubresource(src));
        }
    }
    if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
        const src = el.getAttribute('src') || el.getAttribute('data');
        if (src) {
            const resolved = proxySubresource(src);
            if (el.hasAttribute('src'))
                el.setAttribute('src', resolved);
            if (el.hasAttribute('data'))
                el.setAttribute('data', resolved);
        }
    }
    if (tag === 'video' || tag === 'audio') {
        const src = el.getAttribute('src');
        if (src)
            el.setAttribute('src', proxySubresource(src));
        const sources = el.querySelectorAll('source');
        for (const s of Array.from(sources)) {
            const sSrc = s.getAttribute('src');
            if (sSrc)
                s.setAttribute('src', proxySubresource(sSrc));
        }
    }
}
function interceptLink(el) {
    el.addEventListener('click', async (e) => {
        const href = el.getAttribute('href');
        if (!href)
            return;
        if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:'))
            return;
        e.preventDefault();
        e.stopPropagation();
        const absUrl = new URL(href, window.location.href).href;
        const event = new CustomEvent('midas-navigate', { detail: { url: absUrl, replace: false } });
        window.dispatchEvent(event);
        try {
            const resp = await midasFetch(absUrl);
            const html = await resp.text();
            injectHtml(html, absUrl);
        }
        catch (err) {
            console.error('Navigation failed:', err);
        }
    });
}
function interceptForm(el) {
    el.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const action = el.getAttribute('action') || window.location.href;
        const method = (el.getAttribute('method') || 'GET').toUpperCase();
        const absUrl = new URL(action, window.location.href).href;
        const formData = new FormData(el);
        const body = method === 'GET'
            ? undefined
            : new URLSearchParams(formData).toString();
        try {
            const resp = await midasFetch(absUrl, {
                method,
                body,
                headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
            });
            const html = await resp.text();
            injectHtml(html, absUrl);
        }
        catch (err) {
            console.error('Form submission failed:', err);
        }
    });
}
export function injectHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    if (doc.title)
        document.title = doc.title;
    document.body.innerHTML = doc.body.innerHTML;
    const existingHeadElements = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style, meta, base'));
    for (const el of existingHeadElements) {
        if (!el.getAttribute('data-midas-preserve'))
            el.remove();
    }
    for (const el of Array.from(doc.head.children)) {
        if (el.tagName.toLowerCase() === 'script')
            continue;
        const imported = document.importNode(el, true);
        imported.setAttribute('data-midas-injected', '1');
        document.head.appendChild(imported);
    }
    patchChildren(document.body);
    const scripts = document.body.querySelectorAll('script');
    for (const script of Array.from(scripts)) {
        if (script.src)
            continue;
        const newScript = document.createElement('script');
        newScript.textContent = script.textContent;
        script.replaceWith(newScript);
    }
    history.pushState({ midas: true, url }, '', '/?go=' + encodeURIComponent(url));
    const locEvent = new CustomEvent('midas-location-update', { detail: { url } });
    window.dispatchEvent(locEvent);
}
function proxySubresource(url) {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('#'))
        return url;
    const abs = new URL(url, window.location.href).href;
    return `${baseProxyUrl}${getProxyPath('proxy')}?url=${encodeURIComponent(abs)}`;
}
export function stopDomPatching() {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
}
export function injectStyles(cssText) {
    const style = document.createElement('style');
    style.textContent = cssText;
    document.head.appendChild(style);
    return style;
}
