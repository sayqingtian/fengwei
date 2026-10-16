const CACHE = 'fengwei-shell-v28';
const VERSION = '3.1.5';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './navigation.js', './store.js', './sync.js', './outbox.js', './my.js', './recovery.js', './photo.js', './photo-wire.js', './photos-page.js', './backup.js', './full-backup.js', './drafts.js', './updates.js', './version.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './update.js', './checkins.js', './runtime.js'];
function limit(promise, milliseconds, expired = () => {}) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('Application storage or network timed out')); expired(); }, milliseconds); })]).finally(() => clearTimeout(timer));
}
async function cached(key) {
  // A stalled Cache API in a resumed mobile process must not block navigation
  // or module loading. Keep its contents and try the network after this budget.
  try { return await limit(caches.open(CACHE).then(cache => cache.match(key)), 1500); }
  catch { return null; }
}
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const legacy = (await caches.keys()).some(key => /^fengwei-shell-v(?:[1-9]|1[0-2])$/.test(key) || key.startsWith('shiwei-shell-'));
    // Fetch a complete new shell without reusing a stale HTTP or CDN asset.
    const assets = await Promise.all(ASSETS.map(async asset => {
      const url = new URL(asset, self.location); url.searchParams.set('__fw_shell', CACHE);
      const controller = new AbortController();
      // Consume each body immediately: older workers can proxy these downloads
      // through a limited stream pool, which stalls if all bodies wait for headers.
      const complete = await limit((async () => {
        const response = await fetch(url, { cache: 'reload', signal: controller.signal });
        if (!response.ok) throw new Error('Incomplete application update');
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      })(), 25000, () => controller.abort());
      return [new URL(asset, self.location).href, complete];
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(assets.map(([url, response]) => cache.put(url, response)));
    // Bridge installations that predate the update button. Their open document
    // stays untouched; the next launch will receive the new update controls.
    if (legacy) await self.skipWaiting();
    // Existing clients activate explicitly so an update cannot discard a draft.
  })());
});
self.addEventListener('message', event => {
  if (['SKIP_WAITING', 'ACTIVATE_UPDATE'].includes(event.data?.type)) event.waitUntil(self.skipWaiting());
  if (event.data?.type === 'VERSION') event.ports[0]?.postMessage({ version: VERSION });
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
    event.respondWith(cached(new URL('./index.html', self.location).href).then(saved => saved || fetch(event.request).catch(() => Response.error())));
  } else {
    event.respondWith(cached(event.request).then(saved => saved || fetch(event.request)));
  }
});
