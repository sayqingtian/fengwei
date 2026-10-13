const CACHE = 'fengwei-shell-v20';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './store.js', './sync.js', './my.js', './recovery.js', './photo.js', './photo-wire.js', './photos-page.js', './backup.js', './full-backup.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith('shiwei-shell-') || key.startsWith('fengwei-shell-')) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const relative = url.pathname.slice(new URL('./', self.location).pathname.length);
  if (relative.startsWith('api/')) return;
  if (relative.startsWith('codecs/')) {
    event.respondWith(caches.open(CACHE).then(async cache => { const saved = await cache.match(event.request); if (saved) return saved; const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response; })); return;
  }
  if (event.request.mode !== 'navigate' && !ASSETS.some(asset => asset.slice(2) === relative)) return;
  if (event.request.mode === 'navigate') {
    // Open the cached interface immediately; private API responses are never cached.
    // The installed shell remains available even when the
    // device has a network connection that cannot reach the hosting domain.
    event.respondWith(caches.match(new URL('./index.html', self.location).href).then(cached => cached || fetch(event.request).catch(() => Response.error())));
  } else {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
