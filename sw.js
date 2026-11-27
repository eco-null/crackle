// Crackle service worker: makes the site installable and lets it open without a connection.
// Own files go network-first (a fresh deploy shows at once; the cache is only a fallback), so the
// installed app never runs stale code. Versioned libraries, fonts and the texture scans never change,
// so they come from the cache first. Music, lyrics and search always go to the network.

const CACHE = 'crackle-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/deck3d.js', 'js/materials.js', 'js/config.js', 'js/lyrics.js',
  'js/sources/spotify.js', 'js/sources/youtube.js', 'js/sources/local.js',
  'assets/mark.svg', 'assets/icon-192.png', 'assets/icon-512.png',
];
const IMMUTABLE = /^https:\/\/(cdn\.jsdelivr\.net|dl\.polyhaven\.org|fonts\.(googleapis|gstatic)\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // network first, revalidating past the HTTP cache; the cached copy only when offline
    e.respondWith(fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
    return;
  }

  if (IMMUTABLE.test(req.url)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
  // everything else (Spotify, YouTube, LRCLIB, search) goes straight to the network
});
