/*
 * BunkCraft service worker (hand-written, no Workbox).
 *
 * - Precache: every built file, listed at build time (scripts/vite-pwa.ts fills __PRECACHE__).
 *   The cache name carries a content hash (__VERSION__), so a new build installs side by side
 *   with the old one and waits until the player accepts the "new version" toast.
 * - index.html (navigations): network-first, so a deploy shows up immediately; the cached copy is
 *   the offline fallback. Worlds live in IndexedDB, so singleplayer works fully offline.
 * - Texture packs, fonts, icons and anything else same-origin: cache-first with a background
 *   refresh in a runtime cache.
 * - Never touched: /api, /ws, /health, other origins and non-GET requests (multiplayer stays live).
 */
const VERSION = '__VERSION__';
const PRECACHE = '__PRECACHE__';
const PRECACHE_NAME = `bunkcraft-precache-${VERSION}`;
const RUNTIME_NAME = 'bunkcraft-runtime';
const SCOPE = self.registration.scope;
const NAV_TIMEOUT_MS = 4000;

const abs = (path) => new URL(path, SCOPE).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Only precache in a real build; the dev placeholder is not a list.
    if (!Array.isArray(PRECACHE)) return;
    const cache = await caches.open(PRECACHE_NAME);
    // cache: 'reload' bypasses the HTTP cache so a half-stale precache can never happen.
    await cache.addAll(PRECACHE.map((p) => new Request(abs(p), { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('bunkcraft-precache-') && name !== PRECACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.source) event.source.postMessage({ type: 'VERSION', version: VERSION });
});

function ignored(url) {
  const path = url.pathname.slice(new URL(SCOPE).pathname.length - 1);
  return path.startsWith('/api/') || path === '/ws' || path.startsWith('/ws/') || path === '/health';
}

async function navigate(request) {
  const cache = await caches.open(PRECACHE_NAME);
  const fallback = () => cache.match(abs('./'), { ignoreSearch: true });
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NAV_TIMEOUT_MS));
    const res = await Promise.race([fetch(request), timeout]);
    // A host that answers 404/5xx for the page (or an offline captive portal) still gets the game.
    if (res.ok) return res;
    return (await fallback()) || res;
  } catch {
    return (await fallback()) || Response.error();
  }
}

async function cached(request) {
  const hit = await caches.match(request, { ignoreSearch: false });
  if (hit) {
    // Refresh runtime entries in the background (not the immutable precache).
    if (!request.url.includes('/assets/')) {
      fetch(request).then((res) => (res.ok ? caches.open(RUNTIME_NAME).then((c) => c.put(request, res)) : undefined)).catch(() => undefined);
    }
    return hit;
  }
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(RUNTIME_NAME).then((c) => c.put(request, copy)).catch(() => undefined);
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE) || ignored(url)) return;
  if (request.headers.has('range')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  event.respondWith(cached(request));
});
