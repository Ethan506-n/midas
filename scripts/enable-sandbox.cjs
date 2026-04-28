const fs = require('fs');
const f = fs.readFileSync('c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js', 'utf8');

const oldFunc = `function getStealthScript(baseProxyUrl) {
  return '';
}`;

const newFunc = `function getStealthScript(baseProxyUrl) {
  return '<script src="/sandbox.js"></script>';
}`;

const updated = f.replace(oldFunc, newFunc);
fs.writeFileSync('c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js', updated);
console.log('Enabled minimal sandbox injection');

