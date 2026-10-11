const CACHE = 'shiwei-shell-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './store.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('shiwei-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const relative = url.pathname.slice(new URL('./', self.location).pathname.length);
  if (event.request.mode !== 'navigate' && !ASSETS.some(asset => asset.slice(2) === relative)) return;
  if (event.request.mode === 'navigate') {
    // Recipes are local. Open the installed shell immediately even when the
    // device has a network connection that cannot reach the hosting domain.
    event.respondWith(caches.match(new URL('./index.html', self.location).href).then(cached => cached || fetch(event.request).catch(() => Response.error())));
  } else {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
