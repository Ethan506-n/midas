/**
 * Anti-Detection & Header Randomization
 * Rotates user agents and headers to bypass detection.
 * Keep Chrome version in sync with CURRENT_CHROME_VERSION below when updating.
 */

// Chrome 136 shipped April 2026 — current stable as of May 2026.
// Firefox 138 shipped April 2026.
// All sec-ch-ua values MUST match the Chrome version here.
export const CURRENT_CHROME_VERSION = '136';
export const CURRENT_CHROME_FULL   = '136.0.7103.114';
export const CURRENT_FIREFOX_VERSION = '138';

export const USER_AGENTS = [
  // Chrome 136 on Windows 11
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CURRENT_CHROME_VERSION}.0.0.0 Safari/537.36`,
  // Chrome 136 on macOS Sequoia
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CURRENT_CHROME_VERSION}.0.0.0 Safari/537.36`,
  // Chrome 136 on Linux
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CURRENT_CHROME_VERSION}.0.0.0 Safari/537.36`,
  // Edge 136 on Windows
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CURRENT_CHROME_VERSION}.0.0.0 Safari/537.36 Edg/${CURRENT_CHROME_VERSION}.0.0.0`,
  // Firefox 138 on Windows
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${CURRENT_FIREFOX_VERSION}.0) Gecko/20100101 Firefox/${CURRENT_FIREFOX_VERSION}.0`,
  // Firefox 138 on macOS
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${CURRENT_FIREFOX_VERSION}.0) Gecko/20100101 Firefox/${CURRENT_FIREFOX_VERSION}.0`,
];

const ACCEPT_LANGUAGE = [
  'en-US,en;q=0.9',
  'en-US,en;q=0.9,fr;q=0.8',
  'en-US,en;q=0.9,de;q=0.7',
  'en-GB,en;q=0.9',
];

// Build a sec-ch-ua string that is consistent with the Chrome version.
// Must be called whenever the UA is Chrome/Edge; not for Firefox.
function buildSecChUa(version = CURRENT_CHROME_VERSION, isEdge = false) {
  const brand = isEdge ? 'Microsoft Edge' : 'Google Chrome';
  return `"${brand}";v="${version}", "Chromium";v="${version}", "Not/A)Brand";v="99"`;
}

// Generate fully consistent browser headers for a GET document request.
export function generateRandomHeaders() {
  const uaIndex = Math.floor(Math.random() * USER_AGENTS.length);
  const ua = USER_AGENTS[uaIndex];
  const isFirefox = ua.includes('Firefox');
  const isEdge    = ua.includes('Edg/');
  const isChrome  = !isFirefox;

  const headers = {
    'user-agent': ua,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': ACCEPT_LANGUAGE[Math.floor(Math.random() * ACCEPT_LANGUAGE.length)],
    'accept-encoding': 'gzip, deflate, br, zstd',
    'cache-control': 'max-age=0',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'priority': 'u=0, i',
  };

  if (isChrome) {
    headers['sec-ch-ua']                  = buildSecChUa(CURRENT_CHROME_VERSION, isEdge);
    headers['sec-ch-ua-mobile']           = '?0';
    headers['sec-ch-ua-platform']         = ua.includes('Macintosh') ? '"macOS"' : ua.includes('Linux') ? '"Linux"' : '"Windows"';
    headers['sec-ch-ua-platform-version'] = ua.includes('Macintosh') ? '"15.0"' : '"15.0.0"';
    headers['sec-ch-ua-full-version-list'] =
      `"${isEdge ? 'Microsoft Edge' : 'Google Chrome'}";v="${CURRENT_CHROME_FULL}", ` +
      `"Chromium";v="${CURRENT_CHROME_FULL}", "Not/A)Brand";v="99.0.0.0"`;
  }

  return headers;
}

// Randomize header order (makes TLS/HTTP fingerprinting harder)
export function randomizeHeaderOrder(headers) {
  const entries = Object.entries(headers);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return Object.fromEntries(entries);
}

export function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Inject anti-detection script into HTML pages.
// Patches the most common headless/bot fingerprinting checks in a way
// that survives minified detection libraries.
export function injectAntiDetectionScript() {
  return `(function(){
  // Suppress webdriver flag
  try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});}catch(e){}

  // Realistic plugin list (matches a typical Chrome install)
  try{
    var _plugins=[
      {name:'PDF Viewer',filename:'internal-pdf-viewer',description:'Portable Document Format'},
      {name:'Chrome PDF Viewer',filename:'internal-pdf-viewer',description:'Portable Document Format'},
      {name:'Chromium PDF Viewer',filename:'internal-pdf-viewer',description:'Portable Document Format'},
      {name:'Microsoft Edge PDF Viewer',filename:'internal-pdf-viewer',description:'Portable Document Format'},
      {name:'WebKit built-in PDF',filename:'internal-pdf-viewer',description:'Portable Document Format'},
    ];
    Object.defineProperty(navigator,'plugins',{get:function(){
      var arr=[];
      arr.length=_plugins.length;
      _plugins.forEach(function(p,i){
        var o=Object.create(Plugin.prototype||{});
        try{Object.defineProperty(o,'name',{value:p.name});
        Object.defineProperty(o,'filename',{value:p.filename});
        Object.defineProperty(o,'description',{value:p.description});}catch(e){}
        arr[i]=o;
      });
      arr.refresh=function(){};
      arr.item=function(i){return arr[i];};
      arr.namedItem=function(n){return _plugins.find(function(p){return p.name===n;})||null;};
      return arr;
    },configurable:true});
  }catch(e){}

  // Languages consistent with accept-language header
  try{Object.defineProperty(navigator,'languages',{get:()=>['en-US','en'],configurable:true});}catch(e){}

  // window.chrome present and consistent
  if(!window.chrome){
    try{window.chrome={
      runtime:{},
      loadTimes:function(){return{};},
      csi:function(){return{};},
      app:{isInstalled:false,InstallState:{},RunningState:{}},
    };}catch(e){}
  }

  // Permissions API — a real browser reports 'granted' for notifications prompt
  if(navigator.permissions&&navigator.permissions.query){
    var _origQuery=navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query=function(desc){
      return _origQuery(desc).catch(function(){
        return{state:'prompt',onchange:null};
      });
    };
  }

  // Canvas fingerprint noise — adds imperceptible per-session pixel jitter so
  // the canvas hash differs from a headless/proxy signature. DDG and other
  // fingerprinters hash canvas output to identify automated sessions.
  try{
    var _noise=(Math.random()*0.04)-0.02;
    var _origToDataURL=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=function(){
      var ctx=this.getContext&&this.getContext('2d');
      if(ctx&&this.width>0&&this.height>0){
        try{
          var id=ctx.getImageData(0,0,this.width,this.height);
          for(var i=0;i<id.data.length;i+=4){
            id.data[i]  =Math.min(255,Math.max(0,id.data[i]  +Math.round(_noise*32)));
            id.data[i+1]=Math.min(255,Math.max(0,id.data[i+1]+Math.round(_noise*28)));
            id.data[i+2]=Math.min(255,Math.max(0,id.data[i+2]+Math.round(_noise*24)));
          }
          ctx.putImageData(id,0,0);
        }catch(e2){}
      }
      return _origToDataURL.apply(this,arguments);
    };
  }catch(e){}

  // Hardware/screen fingerprint — match typical laptop values
  try{Object.defineProperty(navigator,'hardwareConcurrency',{get:function(){return 8;},configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,'deviceMemory',{get:function(){return 8;},configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return 0;},configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,'cookieEnabled',{get:function(){return true;},configurable:true});}catch(e){}
})();`;
}

// Clean response headers that could expose the proxy
export function cleanResponseHeaders(headers) {
  const cleaned = { ...headers };
  delete cleaned['server'];
  delete cleaned['x-powered-by'];
  delete cleaned['x-aspnet-version'];
  delete cleaned['x-runtime-version'];
  delete cleaned['via'];
  return cleaned;
}
