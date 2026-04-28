const fs = require('fs');
const f = fs.readFileSync('c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js', 'utf8');
const updated = f.replace(/return bootstrap;/g, "return '';");
fs.writeFileSync('c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js', updated);
console.log('Removed sandbox injection');

