/**
 * Storage Isolation Layer
 * Virtualizes localStorage, sessionStorage, and indexedDB
 * to provide per-origin isolation within the proxy context.
 */
const ORIGIN_KEY_PREFIX = '__midas_storage_';
class IsolatedStorage {
    prefix;
    backend;
    constructor(origin, backend) {
        this.prefix = ORIGIN_KEY_PREFIX + btoa(origin).replace(/[^a-zA-Z0-9]/g, '') + '_';
        this.backend = backend;
    }
    get length() {
        let count = 0;
        for (let i = 0; i < this.backend.length; i++) {
            const k = this.backend.key(i);
            if (k && k.startsWith(this.prefix))
                count++;
        }
        return count;
    }
    key(index) {
        let count = 0;
        for (let i = 0; i < this.backend.length; i++) {
            const k = this.backend.key(i);
            if (k && k.startsWith(this.prefix)) {
                if (count === index)
                    return k.slice(this.prefix.length);
                count++;
            }
        }
        return null;
    }
    getItem(key) {
        return this.backend.getItem(this.prefix + key);
    }
    setItem(key, value) {
        this.backend.setItem(this.prefix + key, value);
    }
    removeItem(key) {
        this.backend.removeItem(this.prefix + key);
    }
    clear() {
        const toRemove = [];
        for (let i = 0; i < this.backend.length; i++) {
            const k = this.backend.key(i);
            if (k && k.startsWith(this.prefix))
                toRemove.push(k);
        }
        for (const k of toRemove)
            this.backend.removeItem(k);
    }
}
let realLocalStorage = null;
let realSessionStorage = null;
let currentOrigin = '';
let isolatedLocal = null;
let isolatedSession = null;
export function installStorageHooks(targetOrigin) {
    currentOrigin = targetOrigin;
    try {
        realLocalStorage = window.localStorage;
        isolatedLocal = new IsolatedStorage(targetOrigin, realLocalStorage);
        Object.defineProperty(window, 'localStorage', {
            get() { return isolatedLocal; },
            configurable: true,
        });
    }
    catch (e) {
        // Storage access denied (private mode, etc.)
    }
    try {
        realSessionStorage = window.sessionStorage;
        isolatedSession = new IsolatedStorage(targetOrigin, realSessionStorage);
        Object.defineProperty(window, 'sessionStorage', {
            get() { return isolatedSession; },
            configurable: true,
        });
    }
    catch (e) {
        // Storage access denied
    }
}
export function updateStorageOrigin(newOrigin) {
    currentOrigin = newOrigin;
    if (realLocalStorage)
        isolatedLocal = new IsolatedStorage(newOrigin, realLocalStorage);
    if (realSessionStorage)
        isolatedSession = new IsolatedStorage(newOrigin, realSessionStorage);
}
export function uninstallStorageHooks() {
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
let realIndexedDB = null;
export function installIndexedDBHook(targetOrigin) {
    const prefix = ORIGIN_KEY_PREFIX + btoa(targetOrigin).replace(/[^a-zA-Z0-9]/g, '') + '_';
    try {
        realIndexedDB = window.indexedDB;
        const wrapped = {
            open(name, version) {
                return realIndexedDB.open(prefix + name, version);
            },
            deleteDatabase(name) {
                return realIndexedDB.deleteDatabase(prefix + name);
            },
            cmp(a, b) {
                return realIndexedDB.cmp(a, b);
            },
            databases() {
                return realIndexedDB.databases().then(list => list.filter(d => d.name && d.name.startsWith(prefix)).map(d => ({
                    ...d,
                    name: d.name.slice(prefix.length),
                })));
            },
        };
        Object.defineProperty(window, 'indexedDB', {
            get() { return wrapped; },
            configurable: true,
        });
    }
    catch (e) {
        // IDB not available
    }
}
export function uninstallIndexedDBHook() {
    if (realIndexedDB) {
        Object.defineProperty(window, 'indexedDB', {
            get() { return realIndexedDB; },
            configurable: true,
        });
    }
}
