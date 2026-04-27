const fs = require('fs');
const out = 'c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js';

const cssFunc = `
function rewriteCss(css, baseUrl) {
  css = css.replace(/url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || /^(data:|blob:|about:|#)/i.test(v) || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return 'url("' + toProxyUrl(abs) + '")';
  });
  css = css.replace(/@import\\s+url\\(\\s*("([^"]*)"|'([^']*)'|([^)]*))\\s*\\)/gi, (m, _all, dq, sq, uq) => {
    const v = (dq ?? sq ?? uq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import url("' + toProxyUrl(abs) + '")';
  });
  css = css.replace(/@import\\s+("([^"]*)"|'([^']*)')/gi, (m, _all, dq, sq) => {
    const v = (dq ?? sq ?? '').trim();
    if (!v || isAlreadyProxied(v)) return m;
    const abs = resolveUrl(baseUrl, v);
    if (!abs) return m;
    return '@import "' + toProxyUrl(abs) + '"';
  });
  return css;
}
`;

let content = fs.readFileSync(out, 'utf-8');
const insertAfter = 'function extractOriginalFromProxy(u) {';
const insertPoint = content.indexOf(insertAfter);
if (insertPoint === -1) {
  console.log('Could not find insert point');
  process.exit(1);
}

// Find end of extractOriginalFromProxy function
const funcEnd = content.indexOf('}', content.indexOf('}', insertPoint) + 1) + 1;
const before = content.slice(0, funcEnd);
const after = content.slice(funcEnd);

fs.writeFileSync(out, before + '\n' + cssFunc + after);
console.log('rewriteCss added');

