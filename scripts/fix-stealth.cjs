const fs = require('fs');
const path = require('path');

const filePath = path.resolve('server', 'router.js');
let content = fs.readFileSync(filePath, 'utf-8');

const markerStart = 'function getStealthScript(baseProxyUrl) {';
const markerEnd = 'return script.join(\'\');';
const markerEndBrace = '}';

if (!content.includes(markerStart) || !content.includes(markerEnd)) {
  console.error('Markers not found in router.js');
  process.exit(1);
}

const oldStartIdx = content.indexOf(markerStart);
const oldEndIdx = content.indexOf(markerEnd, oldStartIdx);
if (oldEndIdx === -1) {
  console.error('Could not find the return statement of getStealthScript');
  process.exit(1);
}
// Find the closing brace of the function after the return statement
let braceAfter = content.indexOf('\n', oldEndIdx + markerEnd.length);
let braceLine = content.substring(braceAfter).trimStart();
if (!braceLine.startsWith('}')) {
  // Try to find the exact line with just }
  const nextNewline = content.indexOf('\n', oldEndIdx);
  if (content.substring(oldEndIdx, nextNewline).includes('}')) {
    // return and } are on the same line
  }
}

// Find the start of the next function or export to know where getStealthScript ends
const afterReturn = content.indexOf('\n', oldEndIdx + markerEnd.length);
const upto = content.indexOf('\n\nfunction ', afterReturn);
const functionEnd = content.indexOf('\n}', afterReturn) + 2;

// Simpler: just regex-replace the entire getStealthScript function
const newFunction = `function getStealthScript(baseProxyUrl) {
  const nonce = Math.random().toString(36).slice(2, 10);
  const code = [
    '(function(){',
    'var B="' + baseProxyUrl + '";',
    'function px(u){',
    'try{',
    'if(!u||typeof u!=="string")return u;',
    'if(u.indexOf("/_midas/")>=0)return u;',
    'if(/^#|^(javascript|data|blob|mailto|tel|about|#)/i.test(u))return u;',
    'var a=document.createElement("a");a.href=u;',
    'return B+"?url="+encodeURIComponent(a.href);',
    '}catch(e){return u;}',
    '}',
    'function patch(el){',
    'try{',
    'if(!el||el.nodeType!==1)return;',
    'var t=el.tagName;if(!t)return;',
    'var tag=t.toLowerCase();',
    'if(tag==="a"){var h=el.getAttribute("href");if(h&&h[0]!=="#")el.setAttribute("href",px(h));}',
    'else if(tag==="form"){var a=el.getAttribute("action");if(a)el.setAttribute("action",px(a));}',
    'else if(tag==="img"||tag==="source"||tag==="track"){var s=el.getAttribute("src");if(s)el.setAttribute("src",px(s));var ss=el.getAttribute("srcset");if(ss)el.setAttribute("srcset",ss.split(",").map(function(p){var x=p.trim().split(/\\\\s+/);x[0]=px(x[0]);return x.join(" ");}).join(", "));}',
    'else if(tag==="link"){var h=el.getAttribute("href");if(h)el.setAttribute("href",px(h));}',
    'else if(tag==="script"){var s=el.getAttribute("src");if(s)el.setAttribute("src",px(s));el.removeAttribute("integrity");el.removeAttribute("crossorigin");}',
    'else if(tag==="iframe"||tag==="embed"||tag==="object"){var s=el.getAttribute("src")||el.getAttribute("data");if(s){var r=px(s);if(el.hasAttribute("src"))el.setAttribute("src",r);if(el.hasAttribute("data"))el.setAttribute("data",r);}}',
    'else if(tag==="meta"){var c=el.getAttribute("content");if(c&&/url\\\\s*=/i.test(c)){var m=c.match(/(.*url\\\\s*=\\\\s*)(.+?)(\\\\s*;.*|$)/i);if(m)el.setAttribute("content",m[1]+px(m[2])+m[3]);}}',
    'else if(tag==="video"||tag==="audio"){var s=el.getAttribute("src");if(s)el.setAttribute("src",px(s));var ps=el.querySelectorAll("source");for(var i=0;i<ps.length;i++)patch(ps[i]);}',
    '}catch(e){}',
    '}',
    'function patchAll(root){try{if(!root)return;var els=root.querySelectorAll?root.querySelectorAll("a,form,img,source,track,link,script,iframe,embed,object,meta,video,audio"):[];for(var i=0;i<els.length;i++)patch(els[i]);}catch(e){}}',
    'var obs=new MutationObserver(function(ms){try{for(var i=0;i<ms.length;i++){var ml=ms[i].addedNodes;for(var j=0;j<ml.length;j++){var n=ml[j];if(n.nodeType===1){patch(n);patchAll(n);}}}}catch(e){}});',
    'if(document.documentElement){obs.observe(document.documentElement,{childList:true,subtree:true});patchAll(document.body||document.documentElement);}else{document.addEventListener("DOMContentLoaded",function(){obs.observe(document.documentElement,{childList:true,subtree:true});patchAll(document.body);});}',
    'document.addEventListener("click",function(e){try{var t=e.target;while(t&&t.tagName!=="A")t=t.parentNode;if(!t)return;var h=t.getAttribute("href");if(!h||h[0]==="#"||/^(javascript|data|mailto|tel):/i.test(h))return;var p=px(h);if(p!==h)t.setAttribute("href",p);if(t.getAttribute("target")==="_blank")return;e.preventDefault();window.location.href=p;}catch(err){}},true);',
    'document.addEventListener("submit",function(e){try{var f=e.target;if(f.tagName!=="FORM")return;var a=f.getAttribute("action");if(!a)a=window.location.href;var p=px(a);if(p!==a)f.setAttribute("action",p);f.setAttribute("target","_self");}catch(err){}},true);',
    'try{var _wopen=window.open;window.open=function(u,t,f){try{if(u&&typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return _wopen.call(this,u,t,f);};}catch(e){}',
    'try{var _fetch=window.fetch;window.fetch=function(input,init){try{if(typeof input==="string")input=px(input);else if(input&&typeof input==="object"){try{var urlStr=String(input.url||input);if(urlStr&&urlStr.indexOf("/_midas/")<0){input=new Request(px(urlStr),init||undefined);}}catch(e2){}}}catch(e){}return _fetch.call(this,input,init);};}catch(e){}',
    'try{var _XHR=window.XMLHttpRequest;var X=function(){var x=new _XHR();try{var _o=x.open;x.open=function(m,u,as,us,pa){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return _o.call(x,m,u,as,us,pa);};}catch(e){}return x;};X.prototype=_XHR.prototype;window.XMLHttpRequest=X;}catch(e){}',
    'try{',
    'var _WS=window.WebSocket;',
    'var W=function(u,p){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u.replace(/^wss?/i,"https"));}catch(e){}return new _WS(u,p);};',
    'W.prototype=_WS.prototype;',
    'try{Object.setPrototypeOf(W,_WS);}catch(e){}',
    'window.WebSocket=W;',
    '}catch(e){}',
    'try{',
    'var _ES=window.EventSource;',
    'if(_ES){',
    'var E=function(u,o){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return new _ES(u,o);};',
    'E.prototype=_ES.prototype;',
    'try{Object.setPrototypeOf(E,_ES);}catch(e){}',
    'window.EventSource=E;',
    '}',
    '}catch(e){}',
    'try{var _sb=navigator.sendBeacon;if(_sb){navigator.sendBeacon=function(u,d){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return _sb.call(navigator,u,d);};}}catch(e){}',
    'try{var _wsend=window.Worker;if(_wsend){window.Worker=function(u,o){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return new _wsend(u,o);};}}catch(e){}',
    '})();'
  ].join('');
  return '<script data-midas="' + nonce + '">\\n' + code + '\\n</script>';
}`;

// Use regex to replace entire getStealthScript function
const regex = /function getStealthScript\(baseProxyUrl\) \{[\s\S]*?return script\.join\(''\);\s*\}/;
if (!regex.test(content)) {
  console.error('Could not find getStealthScript with regex');
  process.exit(1);
}

content = content.replace(regex, newFunction);
fs.writeFileSync(filePath, content);
console.log('getStealthScript replaced successfully.');

// Verify
const verify = fs.readFileSync(filePath, 'utf-8');
const syntaxCheck = require('child_process').execSync('node -c ' + filePath, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
console.log('Syntax OK');
