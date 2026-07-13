// The Ledger — service worker
//
// Deliberately minimal. This app's real data lives in Supabase, not in the
// cache, so the goal here is just: (1) let the app be "Added to Home Screen"
// properly, and (2) let the app shell load quickly / open at all when
// offline. It does NOT try to cache or serve Supabase or /api/lookup
// requests — those always need a live network round-trip, and pretending
// otherwise would just cause confusing stale-data bugs.

const CACHE_NAME = 'the-ledger-shell-v1';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isAppShellRequest(url) {
  // Only ever handle same-origin GET requests for the shell files above.
  // Everything else (Supabase, /api/lookup, Google Books, iTunes, etc.)
  // passes straight through to the network, untouched.
  return url.origin === self.location.origin &&
    (SHELL_FILES.includes(url.pathname) || url.pathname === '/');
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (!isAppShellRequest(url)) return; // let the browser handle it normally

  // Network-first: always try to get the latest version so a deploy
  // actually reaches people, falling back to the cached shell only if
  // there's no connection at all.
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
