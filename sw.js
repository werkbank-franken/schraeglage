// Offline-Cache: App läuft auch ohne Netz (z. B. auf Strecken ohne Empfang)
const CACHE = 'schraeglage-v4';
const FILES = ['./', 'index.html', 'app.js', 'lean.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Erst Netz (für Updates), bei Funkloch aus dem Cache.
// Nur eigene Dateien und die Kartenbibliothek cachen, keine Kartenkacheln.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin && u.hostname !== 'cdnjs.cloudflare.com') return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || Response.error()))
  );
});
