const fs = require('fs');
const path = 'c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js';
let content = fs.readFileSync(path, 'utf-8');

const bad = `  return css;
}

}

function getStealthScript(baseProxyUrl) {`;
const good = `  return css;
}

function getStealthScript(baseProxyUrl) {`;

if (content.includes(bad)) {
  content = content.replace(bad, good);
  fs.writeFileSync(path, content);
  console.log('Fixed extra brace');
} else {
  console.log('Pattern not found');
}
