const fs = require('fs');
const path = require('path');

const filePath = path.resolve('server', 'router.js');
const lines = fs.readFileSync(filePath, 'utf-8').split('\n');

let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'function getStealthScript(baseProxyUrl) {') {
    startIdx = i;
    break;
  }
}
if (startIdx === -1) {
  console.error('Start not found');
  process.exit(1);
}

let endIdx = -1;
let braceCount = 0;
for (let i = startIdx; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') braceCount++;
    else if (ch === '}') braceCount--;
  }
  if (braceCount === 0) {
    endIdx = i;
    break;
  }
}
if (endIdx === -1) {
  console.error('End not found');
  process.exit(1);
}

const newFunc = `function getStealthScript(baseProxyUrl) {
  const nonce = Math.random().toString(36).slice(2, 10);
  const code = [
    '(function(){',
    'var B="' + baseProxyUrl + '";',
    'var BASE_HOST="";try{var bu=new URL(B);BASE_HOST=bu.protocol+"//"+bu.host;}catch(e){}',
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
    'else if(tag==="button"){var f=el.getAttribute("formaction");if(f)el.setAttribute("formaction",px(f));}',
    '}catch(e){}',
    '}',
    'function patchAll(root){try{if(!root)return;var els=root.querySelectorAll?root.querySelectorAll("a,form,img,source,track,link,script,iframe,embed,object,meta,video,audio,button"):[];for(var i=0;i<els.length;i++)patch(els[i]);}catch(e){}}',
    'var obs=new MutationObserver(function(ms){try{for(var i=0;i<ms.length;i++){var ml=ms[i].addedNodes;for(var j=0;j<ml.length;j++){var n=ml[j];if(n.nodeType===1){patch(n);patchAll(n);}}}}catch(e){}});',
    'if(document.documentElement){obs.observe(document.documentElement,{childList:true,subtree:true});patchAll(document.body||document.documentElement);}else{document.addEventListener("DOMContentLoaded",function(){obs.observe(document.documentElement,{childList:true,subtree:true});patchAll(document.body);});}',
    'document.addEventListener("click",function(e){try{var t=e.target;while(t&&t!==document.body){var tn=t.tagName;if(tn==="A"){var h=t.getAttribute("href");if(!h||h[0]==="#"||/^(javascript|data|mailto|tel):/i.test(h))return;var p=px(h);if(p!==h)t.setAttribute("href",p);if(t.getAttribute("target")==="_blank")return;e.preventDefault();window.location.href=p;return;}if(tn==="BUTTON"||tn==="INPUT"){var ty=(t.getAttribute("type")||"").toLowerCase();if(ty==="submit"||ty==="button"){var f=t.getAttribute("formaction");if(f){var p2=px(f);t.setAttribute("formaction",p2);}return;}}t=t.parentNode;}}catch(err){}},true);',
    'document.addEventListener("submit",function(e){try{var f=e.target;if(f.tagName!=="FORM")return;var a=f.getAttribute("action");if(!a)a=window.location.href;var p=px(a);if(p!==a)f.setAttribute("action",p);f.setAttribute("target","_self");}catch(err){}},true);',
    'try{var _ce=document.createElement;document.createElement=function(tag){var el=_ce.call(document,tag);try{patch(el);}catch(e){}return el;};}catch(e){}',
    'try{var _wopen=window.open;Object.defineProperty(window,"open",{get:function(){return function(u,t,f){try{if(u&&typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return _wopen.call(window,u,t,f);};},set:function(v){_wopen=v;}});}catch(e){}',
    'try{var _loc=window.location;var _locProto=Object.getPrototypeOf(_loc)||Location.prototype;var _origAssign=_locProto.assign;var _origReplace=_locProto.replace;var _origHref=Object.getOwnPropertyDescriptor(_locProto,"href");Object.defineProperty(window,"location",{get:function(){return _loc;},set:function(v){try{if(typeof v==="string")v=px(v);}catch(e){}_loc.href=v;}});if(_origAssign)_locProto.assign=function(u){try{if(typeof u==="string")u=px(u);}catch(e){}return _origAssign.call(this,u);};if(_origReplace)_locProto.replace=function(u){try{if(typeof u==="string")u=px(u);}catch(e){}return _origReplace.call(this,u);};}catch(e){}',
    'try{var _fetch=window.fetch;Object.defineProperty(window,"fetch",{get:function(){return function(input,init){try{if(typeof input==="string")input=px(input);else if(input&&typeof input==="object"){try{var urlStr=String(input.url||input);if(urlStr&&urlStr.indexOf("/_midas/")<0){input=new Request(px(urlStr),init||undefined);}}catch(e2){}}}catch(e){}return _fetch.call(window,input,init);};},set:function(v){_fetch=v;}});}catch(e){}',
    'try{var _XHR=window.XMLHttpRequest;var X=function(){var x=new _XHR();try{var _o=x.open;x.open=function(m,u,as,us,pa){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return _o.call(x,m,u,as,us,pa);};}catch(e){}return x;};X.prototype=_XHR.prototype;try{Object.setPrototypeOf(X,_XHR);}catch(e){}Object.defineProperty(window,"XMLHttpRequest",{get:function(){return X;},set:function(v){_XHR=v;}});}catch(e){}',
    'try{var _WS=window.WebSocket;var W=function(u,p){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u.replace(/^wss?/i,"https"));}catch(e){}return new _WS(u,p);};W.prototype=_WS.prototype;try{Object.setPrototypeOf(W,_WS);}catch(e){}Object.defineProperty(window,"WebSocket",{get:function(){return W;},set:function(v){_WS=v;}});}catch(e){}',
    'try{var _ES=window.EventSource;if(_ES){var E=function(u,o){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return new _ES(u,o);};E.prototype=_ES.prototype;try{Object.setPrototypeOf(E,_ES);}catch(e){}Object.defineProperty(window,"EventSource",{get:function(){return E;},set:function(v){_ES=v;}});}}catch(e){}',
    'try{var _sb=navigator.sendBeacon;if(_sb){navigator.sendBeacon=function(u,d){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return _sb.call(navigator,u,d);};}}catch(e){}',
    'try{var _worker=window.Worker;if(_worker){window.Worker=function(u,o){try{if(typeof u==="string"&&!u.includes("/_midas/"))u=px(u);}catch(e){}return new _worker(u,o);};}}catch(e){}',
    'try{var _psh=history.pushState;var _rsh=history.replaceState;history.pushState=function(d,t,u){try{if(u&&typeof u==="string")u=px(u);}catch(e){}return _psh.call(history,d,t,u);};history.replaceState=function(d,t,u){try{if(u&&typeof u==="string")u=px(u);}catch(e){}return _rsh.call(history,d,t,u);};}catch(e){}',
    'try{var _ael=document.addEventListener;document.addEventListener=function(t,l,o){if(t==="click"&&typeof l==="function"){var wrapped=function(e){try{var target=e.target;while(target&&target!==document.body){if(target.tagName==="A"){var h=target.getAttribute("href");if(h&&h[0]!=="#"&&!/^(javascript|data|mailto|tel):/i.test(h)){var p=px(h);if(p!==h)target.setAttribute("href",p);}}target=target.parentNode;}catch(err){}return l.call(this,e);};return _ael.call(document,t,wrapped,o);}return _ael.call(document,t,l,o);};}catch(e){}',
    '})();'
  ].join('');
  return '<script data-midas="' + nonce + '">\\n' + code + '\\n</script>';
}`;

const result = [...lines.slice(0, startIdx), newFunc, ...lines.slice(endIdx + 1)];
fs.writeFileSync(filePath, result.join('\n'));
console.log('Replaced getStealthScript with navigation fixes (lines ' + startIdx + '-' + endIdx + ')');

require('child_process').execSync('node -c ' + filePath, { encoding: 'utf-8' });
console.log('Syntax OK');

