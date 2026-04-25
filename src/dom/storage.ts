/**
 * Storage Isolation Layer
 * Virtualizes localStorage, sessionStorage, and indexedDB
 * to provide per-origin isolation within the proxy context.
 */

const ORIGIN_KEY_PREFIX = '__midas_storage_';

interface StorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

class IsolatedStorage implements StorageArea {
  private prefix: string;
  private backend: Storage;

  constructor(origin: string, backend: Storage) {
    this.prefix = ORIGIN_KEY_PREFIX + btoa(origin).replace(/[^a-zA-Z0-9]/g, '') + '_';
    this.backend = backend;
  }

  get length(): number {
    let count = 0;
    for (let i = 0; i < this.backend.length; i++) {
      const k = this.backend.key(i);
      if (k && k.startsWith(this.prefix)) count++;
    }
    return count;
  }

  key(index: number): string | null {
    let count = 0;
    for (let i = 0; i < this.backend.length; i++) {
      const k = this.backend.key(i);
      if (k && k.startsWith(this.prefix)) {
        if (count === index) return k.slice(this.prefix.length);
        count++;
      }
    }
    return null;
  }

  getItem(key: string): string | null {
    return this.backend.getItem(this.prefix + key);
  }

  setItem(key: string, value: string): void {
    this.backend.setItem(this.prefix + key, value);
  }

  removeItem(key: string): void {
    this.backend.removeItem(this.prefix + key);
  }

  clear(): void {
    const toRemove: string[] = [];
    for (let i = 0; i < this.backend.length; i++) {
      const k = this.backend.key(i);
      if (k && k.startsWith(this.prefix)) toRemove.push(k);
    }
    for (const k of toRemove) this.backend.removeItem(k);
  }
}

let realLocalStorage: Storage | null = null;
let realSessionStorage: Storage | null = null;
let currentOrigin: string = '';
let isolatedLocal: IsolatedStorage | null = null;
let isolatedSession: IsolatedStorage | null = null;

export function installStorageHooks(targetOrigin: string): void {
  currentOrigin = targetOrigin;

  try {
    realLocalStorage = window.localStorage;
    isolatedLocal = new IsolatedStorage(targetOrigin, realLocalStorage);

    Object.defineProperty(window, 'localStorage', {
      get() { return isolatedLocal; },
      configurable: true,
    });
  } catch (e) {
    // Storage access denied (private mode, etc.)
  }

  try {
    realSessionStorage = window.sessionStorage;
    isolatedSession = new IsolatedStorage(targetOrigin, realSessionStorage);

    Object.defineProperty(window, 'sessionStorage', {
      get() { return isolatedSession; },
      configurable: true,
    });
  } catch (e) {
    // Storage access denied
  }
}

export function updateStorageOrigin(newOrigin: string): void {
  currentOrigin = newOrigin;
  if (realLocalStorage) isolatedLocal = new IsolatedStorage(newOrigin, realLocalStorage);
  if (realSessionStorage) isolatedSession = new IsolatedStorage(newOrigin, realSessionStorage);
}

export function uninstallStorageHooks(): void {
  if (realLocalStorage) {
    Object.defineProperty(window, 'localStorage', {
      get() { return realLocalStorage; },
      configurable: true,
    });
  }
  if (realSessionStorage) {
    Object.defineProperty(window, 'sessionStorage', {
      get() { return realSessionStorage; },
      configurable: true,
    });
  }
}

/**
 * IndexedDB Isolation
 * Wraps IDBFactory to prefix database names per origin.
 */
let realIndexedDB: IDBFactory | null = null;

export function installIndexedDBHook(targetOrigin: string): void {
  const prefix = ORIGIN_KEY_PREFIX + btoa(targetOrigin).replace(/[^a-zA-Z0-9]/g, '') + '_';

  try {
    realIndexedDB = window.indexedDB;
    const wrapped: IDBFactory = {
      open(name: string, version?: number): IDBOpenDBRequest {
        return realIndexedDB!.open(prefix + name, version);
      },
      deleteDatabase(name: string): IDBOpenDBRequest {
        return realIndexedDB!.deleteDatabase(prefix + name);
      },
      cmp(a: any, b: any): number {
        return realIndexedDB!.cmp(a, b);
      },
      databases(): Promise<IDBDatabaseInfo[]> {
        return realIndexedDB!.databases().then(list =>
          list.filter(d => d.name && d.name.startsWith(prefix)).map(d => ({
            ...d,
            name: d.name!.slice(prefix.length),
          }))
        );
      },
    };

    Object.defineProperty(window, 'indexedDB', {
      get() { return wrapped; },
      configurable: true,
    });
  } catch (e) {
    // IDB not available
  }
}

export function uninstallIndexedDBHook(): void {
  if (realIndexedDB) {
    Object.defineProperty(window, 'indexedDB', {
      get() { return realIndexedDB; },
      configurable: true,
    });
  }
}


