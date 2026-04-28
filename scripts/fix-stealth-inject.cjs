const fs = require('fs');
const f = fs.readFileSync('c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js', 'utf8');

// Find the getStealthScript function and replace its entire body
const start = f.indexOf('function getStealthScript(baseProxyUrl) {');
if (start === -1) {
  console.log('Function not found');
  process.exit(1);
}

// Find the matching closing brace
let braceCount = 0;
let end = start;
let foundOpen = false;
for (let i = start; i < f.length; i++) {
  if (f[i] === '{') { braceCount++; foundOpen = true; }
  else if (f[i] === '}') { braceCount--; }
  if (foundOpen && braceCount === 0) { end = i + 1; break; }
}

const before = f.slice(0, start);
const after = f.slice(end);
const newFunc = `function getStealthScript(baseProxyUrl) {
  return '<script src="/sandbox.js"></script>';
}`;

fs.writeFileSync('c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js', before + newFunc + after);
console.log('Fixed stealth injection to minimal script tag');

