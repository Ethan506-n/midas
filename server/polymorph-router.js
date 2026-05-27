/**
 * Polymorphic Router Module
 * Generates rotating, unpredictable endpoint paths to eliminate static signatures.
 * Paths are derived from a server-side rotating seed + session nonce.
 */

import crypto from 'crypto';

const SEED_ROTATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
let currentSeed = crypto.randomBytes(16).toString('hex');
let previousSeed = currentSeed; // kept valid for one grace epoch after rotation
let seedCreated = Date.now();

function rotateSeed() {
  const now = Date.now();
  if (now - seedCreated > SEED_ROTATION_INTERVAL) {
    previousSeed = currentSeed; // old paths stay valid for one more epoch
    currentSeed = crypto.randomBytes(16).toString('hex');
    seedCreated = now;
  }
}

function derivePath(seed, name, length = 8) {
  const hash = crypto.createHmac('sha256', seed).update(name).digest('hex');
  return hash.slice(0, length);
}

function buildPaths(seed) {
  return {
    browse:      derivePath(seed, 'browse', 10),
    session:     derivePath(seed, 'session', 10),
    stream:      derivePath(seed, 'stream', 10),
    fetch:       derivePath(seed, 'fetch', 10),
    chunk:       derivePath(seed, 'chunk', 10),
    proxy:       derivePath(seed, 'proxy', 10),
    passthrough: derivePath(seed, 'passthrough', 10),
    wsBridge:    derivePath(seed, 'wsbridge', 10),
    noise:       derivePath(seed, 'noise', 10),
  };
}

export function getEndpointPaths() {
  rotateSeed();
  return {
    ...buildPaths(currentSeed),
    seed: currentSeed,
    created: seedCreated,
  };
}

export function matchPolymorphicPath(pathname, paths) {
  // Strip /_midas/ prefix if present, then compare
  const clean = pathname.replace(/^\/_midas\//, '').replace(/^\//, '');
  for (const [name, p] of Object.entries(paths)) {
    if (name === 'seed' || name === 'created') continue;
    if (clean === p || clean.startsWith(p + '/')) return name;
  }
  // Grace period: also accept the previous epoch's paths so pages loaded just
  // before a rotation can still navigate without a white-screen 404.
  if (previousSeed !== currentSeed) {
    const prev = buildPaths(previousSeed);
    for (const [name, p] of Object.entries(prev)) {
      if (clean === p || clean.startsWith(p + '/')) return name;
    }
  }
  return null;
}

export function buildUrl(base, pathKey, paths, query = {}) {
  const p = paths[pathKey];
  if (!p) throw new Error(`Unknown path key: ${pathKey}`);
  const url = new URL(p, base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  return url.pathname + url.search;
}


