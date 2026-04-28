const fs = require('fs');
const path = require('path');

const routerPath = path.resolve('server', 'router.js');
let content = fs.readFileSync(routerPath, 'utf-8');

// Replace the getStealthScript function with one that injects the sandbox
const oldFuncStart = 'function getStealthScript(baseProxyUrl) {';
const oldFuncEnd = 'return \'<script data-midas="\' + nonce + \'">\\n\' + code + \'\\n</script>\';\n}';

const newFunc = `function getStealthScript(baseProxyUrl) {
  const nonce = Math.random().toString(36).slice(2, 10);
  const paths = JSON.stringify(currentPaths);
  
  // Small inline bootstrap that loads the full sandbox
  const bootstrap = [
    '<script data-midas="' + nonce + '">',
    '(function(){',
    'window.__midas_paths=' + paths + ';',
    'window.__midas_base="' + baseProxyUrl + '";',
    '})();',
    '</script>',
    '<script src="/sandbox.js" data-midas="' + nonce + '"></script>',
  ].join('\\n');
  
  return bootstrap;
}`;

// Find and replace the function
const startIdx = content.indexOf(oldFuncStart);
if (startIdx === -1) {
  console.error('Could not find getStealthScript function');
  process.exit(1);
}

// Find the end of the function by tracking braces
let braceCount = 0;
let endIdx = -1;
for (let i = startIdx; i < content.length; i++) {
  if (content[i] === '{') braceCount++;
  else if (content[i] === '}') braceCount--;
  if (braceCount === 0 && i > startIdx) {
    endIdx = i;
    break;
  }
}

if (endIdx === -1) {
  console.error('Could not find end of getStealthScript function');
  process.exit(1);
}

const before = content.slice(0, startIdx);
const after = content.slice(endIdx + 1);
content = before + newFunc + after;

fs.writeFileSync(routerPath, content);
console.log('Updated getStealthScript to use sandbox.js');

// Verify syntax
require('child_process').execSync('node -c ' + routerPath, { encoding: 'utf-8' });
console.log('Syntax OK');

