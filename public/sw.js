/* KAST Earn Tracker — service worker
 * Strategy:
 *  - Navigation / HTML: network-first, fall back to cache when offline.
 *    This is what makes new deploys visible immediately instead of
 *    serving a stale shell that was cached on first visit.
 *  - Hashed static assets (/_next/static/*, icons, manifest): cache-first.
 *    These filenames are content-hashed by Next.js, so cached entries can
 *    never become stale — only orphaned (which the version bump cleans up).
 *  - /api/*: network-first with cache fallback so the dashboard stays
 *    viewable offline (showing the last seen snapshot) but always tries
 *    fresh data first.
 *
 * Bump CACHE on every deploy that changes cacheable behavior; the activate
 * handler deletes any cache whose name does not match.
 */
const CACHE = 'kast-earn-v2';

const HASHED_ASSET_PREFIXES = ['/_next/static/', '/icon-'];
const HASHED_ASSET_PATHS = new Set(['/manifest.webmanifest']);

function isHashedAsset(url) {
  if (HASHED_ASSET_PATHS.has(url.pathname)) return true;
  return HASHED_ASSET_PREFIXES.some((p) => url.pathname.startsWith(p));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add('/'))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches
        .open(CACHE)
        .then((c) => c.put(req, copy))
        .catch(() => undefined);
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const root = await caches.match('/');
      if (root) return root;
    }
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches
        .open(CACHE)
        .then((c) => c.put(req, copy))
        .catch(() => undefined);
    }
    return res;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(networkFirst(req));
});
