/**
 * Polymorphic code helpers.
 * Generates randomized strings, reorders operations, and flattens control flow
 * so static signatures cannot be built.
 */

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const NUMS = '0123456789';

export function randomId(len = 8): string {
  let s = CHARS[Math.floor(Math.random() * 52)];
  for (let i = 1; i < len; i++) {
    const pool = i === 0 ? CHARS : CHARS + NUMS;
    s += pool[Math.floor(Math.random() * pool.length)];
  }
  return s;
}

export function randomString(min = 6, max = 14): string {
  const len = min + Math.floor(Math.random() * (max - min));
  let s = CHARS[Math.floor(Math.random() * 52)];
  for (let i = 1; i < len; i++) {
    s += CHARS[Math.floor(Math.random() * 52)];
  }
  return s;
}

export function randomBytes(len: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(len));
}

export function flatten<T>(arr: T[][]): T[] {
  return arr.reduce((a, b) => a.concat(b), []);
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function obfuscateUrl(url: string): string {
  // Rotate common proxy markers in URLs
  return url
    .replace(/proxy/gi, randomString(4, 6))
    .replace(/uv/gi, randomString(2, 3))
    .replace(/bare/gi, randomString(3, 5));
}

export function generateNonce(): string {
  return btoa(String.fromCharCode(...Array.from(randomBytes(12))));
}

export function createHiddenProperty(obj: any, key: string, value: any) {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

