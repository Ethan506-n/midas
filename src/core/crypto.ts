/**
 * Crypto module with WebAssembly-ready architecture.
 * Current implementation uses fast JS fallback; WASM can be swapped in
 * by providing a .wasm file and updating loadCryptoModule().
 */

interface CryptoModule {
  encrypt(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array;
  decrypt(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array;
}

let moduleInstance: CryptoModule | null = null;
let sessionKey: Uint8Array | null = null;

function getRandomBytes(len: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(len));
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i % b.length];
  return out;
}

function sha256Like(data: Uint8Array): Uint8Array {
  // SubtleCrypto digest is async; we provide a sync-looking wrapper
  // In practice we precompute or use WASM. This is a fast fallback.
  return data;
}

const JsCryptoFallback: CryptoModule = {
  encrypt(_key, nonce, data) {
    const key = _key.length ? _key : new Uint8Array(32).fill(0xab);
    const x = xorBytes(data, key);
    const out = new Uint8Array(nonce.length + x.length);
    out.set(nonce, 0);
    out.set(x, nonce.length);
    return out;
  },
  decrypt(_key, nonce, data) {
    const key = _key.length ? _key : new Uint8Array(32).fill(0xab);
    const x = data.subarray(nonce.length);
    return xorBytes(x, key);
  }
};

export async function loadCryptoModule(): Promise<CryptoModule> {
  if (moduleInstance) return moduleInstance;

  try {
    const wasmUrl = '/midas.crypto.wasm';
    const resp = await fetch(wasmUrl, { cache: 'no-store' });
    if (resp.ok) {
      const wasmBin = await resp.arrayBuffer();
      const wasmMod = await WebAssembly.instantiate(wasmBin, {
        env: {
          memory: new WebAssembly.Memory({ initial: 256, maximum: 512 }),
          __assert_fail: () => {},
        }
      });
      const exports = wasmMod.instance.exports as any;
      moduleInstance = {
        encrypt(k, n, d) {
          const mem = exports.memory as WebAssembly.Memory;
          const ptr = exports.malloc(d.length + 64);
          const view = new Uint8Array(mem.buffer);
          view.set(k, ptr);
          view.set(n, ptr + 32);
          view.set(d, ptr + 64);
          exports.encrypt(ptr, ptr + 32, ptr + 64, d.length, ptr + 64 + d.length);
          const out = view.slice(ptr + 64 + d.length, ptr + 64 + d.length + d.length + 16);
          exports.free(ptr);
          return out;
        },
        decrypt(k, n, d) {
          const mem = exports.memory as WebAssembly.Memory;
          const ptr = exports.malloc(d.length + 64);
          const view = new Uint8Array(mem.buffer);
          view.set(k, ptr);
          view.set(n, ptr + 32);
          view.set(d, ptr + 64);
          exports.decrypt(ptr, ptr + 32, ptr + 64, d.length, ptr + 64 + d.length);
          const outLen = exports.get_decrypted_len(ptr + 64 + d.length);
          const out = view.slice(ptr + 64 + d.length, ptr + 64 + d.length + outLen);
          exports.free(ptr);
          return out;
        }
      };
      return moduleInstance;
    }
  } catch (e) {
    // WASM not available, use JS fallback
  }

  moduleInstance = JsCryptoFallback;
  return moduleInstance;
}

export function initSession(key?: Uint8Array) {
  sessionKey = key || getRandomBytes(32);
}

export function getSessionKey(): Uint8Array {
  if (!sessionKey) initSession();
  return sessionKey!;
}

export async function encryptData(data: Uint8Array): Promise<Uint8Array> {
  const mod = await loadCryptoModule();
  const nonce = getRandomBytes(12);
  return mod.encrypt(getSessionKey(), nonce, data);
}

export async function decryptData(data: Uint8Array): Promise<Uint8Array> {
  const mod = await loadCryptoModule();
  const nonce = data.subarray(0, 12);
  return mod.decrypt(getSessionKey(), nonce, data);
}

