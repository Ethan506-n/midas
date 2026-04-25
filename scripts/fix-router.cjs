const fs = require('fs');
const path = 'c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js';
let content = fs.readFileSync(path, 'utf-8');

const badUA = "headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (compatible; midas-proxy/0.1)';";
const goodUA = "headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';";

if (content.includes(badUA)) {
  content = content.split(badUA).join(goodUA);
  fs.writeFileSync(path, content);
  console.log('Fixed user-agent');
} else {
  console.log('UA already fixed or not found');
}

