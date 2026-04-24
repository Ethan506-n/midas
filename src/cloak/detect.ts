/**
 * Anti-instrumentation and execution-pattern evasion.
 * Detects if the environment is being analyzed and adjusts behavior.
 */

let devtoolsOpen = false;
let instrumentationDetected = false;

function checkDevTools() {
  const threshold = 160;
  const check = () => {
    const widthThreshold = window.outerWidth - window.innerWidth > threshold;
    const heightThreshold = window.outerHeight - window.innerHeight > threshold;
    devtoolsOpen = widthThreshold || heightThreshold;
  };
  window.addEventListener('resize', check);
  setInterval(check, 2000);
}

function checkInstrumentation() {
  // Detect if common instrumentation hooks are present
  const nativeToString = Function.prototype.toString;
  const checks = [
    () => nativeToString.call(window.fetch) !== 'function fetch() { [native code] }',
    () => nativeToString.call(window.XMLHttpRequest.prototype.open) !== 'function open() { [native code] }',
    () => nativeToString.call(window.WebSocket) !== 'function WebSocket() { [native code] }',
  ];

  for (const c of checks) {
    try { if (c()) { instrumentationDetected = true; break; } }
    catch (e) {}
  }

  // Detect if Proxy objects are being observed via unusual means
  try {
    const obj = {};
    const p = new Proxy(obj, {
      get(t, k) {
        if (k === '__proto__' || k === 'constructor') instrumentationDetected = true;
        return (t as any)[k];
      }
    });
    void (p as any).__proto__;
  } catch (e) {}
}

export function isEnvironmentSafe(): boolean {
  return !devtoolsOpen && !instrumentationDetected;
}

export function getEnvironmentStatus(): { devtools: boolean; instrumentation: boolean } {
  return { devtools: devtoolsOpen, instrumentation: instrumentationDetected };
}

export function initDetection() {
  checkDevTools();
  checkInstrumentation();
}

export function randomDelay(): Promise<void> {
  // Random tiny delays to desynchronize execution patterns
  const ms = Math.floor(Math.random() * 4);
  return new Promise(r => setTimeout(r, ms));
}

export function scrambleExecution<T>(fn: () => T): T {
  // Execute function with minor timing jitter
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  if (elapsed < 2) {
    // Too fast = suspicious, burn a few cycles
    for (let i = 0; i < 1000 + Math.floor(Math.random() * 5000); i++) {
      Math.sqrt(i);
    }
  }
  return result;
}

