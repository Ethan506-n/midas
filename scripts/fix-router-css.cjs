const fs = require('fs');
const path = 'c:/Users/BigEP/OneDrive/Documents/GitHub/midas/server/router.js';
let content = fs.readFileSync(path, 'utf-8');

// Fix the missing closing brace after extractOriginalFromProxy
const bad = `  } catch { return null; }

function rewriteCss(css, baseUrl) {`;
const good = `  } catch { return null; }
}

function rewriteCss(css, baseUrl) {`;

if (content.includes(bad)) {
  content = content.replace(bad, good);
  fs.writeFileSync(path, content);
  console.log('Fixed missing brace');
} else {
  console.log('Pattern not found, checking...');
  // Also remove the extra closing brace after rewriteCss
  const extraBrace = `  return css;
}

}`;
  const fixed = `  return css;
}`;
  if (content.includes(extraBrace)) {
    content = content.replace(extraBrace, fixed);
    fs.writeFileSync(path, content);
    console.log('Fixed extra brace');
  } else {
    console.log('Extra brace not found either');
  }
}
