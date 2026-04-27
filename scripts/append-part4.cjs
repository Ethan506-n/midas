const fs = require('fs');
const out = 'c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js';

let c = '';
function add(s) { c += s + '\n'; }

add(`function rewriteJs(js, baseUrl) {`);
add(`  js = js.replace(/"(https?:\\/\\/[^"]+)"/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return '"' + toProxyUrl(u) + '"';`);
add(`  });`);
add(`  js = js.replace(/'(https?:\\/\\/[^']+)'/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return "'" + toProxyUrl(u) + "'";`);
add(`  });`);
add(`  js = js.replace(/\\`(https?:\\/\\/[^\\`]+)\\`/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return '\\`' + toProxyUrl(u) + '\\`';`);
add(`  });`);
add(`  js = js.replace(/\\bimport\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']\\s*\\)/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return 'import("' + toProxyUrl(u) + '")';`);
add(`  });`);
add(`  js = js.replace(/\\bfetch\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return 'fetch("' + toProxyUrl(u) + '"';`);
add(`  });`);
add(`  js = js.replace(/\\bnew\\s+URL\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return 'new URL("' + toProxyUrl(u) + '"';`);
add(`  });`);
add(`  js = js.replace(/\\.open\\s*\\(\\s*["'][^"']*["']\\s*,\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return m.replace(u, toProxyUrl(u));`);
add(`  });`);
add(`  js = js.replace(/\\bnew\\s+WebSocket\\s*\\(\\s*["'](wss?:\\/\\/[^"']+)["']/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u)) return m;`);
add(`    return 'new WebSocket("' + toProxyUrl(u.replace(/^wss?/, 'https')) + '"';`);
add(`  });`);
add(`  js = js.replace(/\\bnew\\s+EventSource\\s*\\(\\s*["'](https?:\\/\\/[^"']+)["']/g, (m, u) => {`);
add(`    if (isAlreadyProxied(u) || isCaptchaUrl(u)) return m;`);
add(`    return 'new EventSource("' + toProxyUrl(u) + '"';`);
add(`  });`);
add(`  return js;`);
add(`}`);
add(``);

fs.appendFileSync(out, c);
console.log('Part 4 done');

