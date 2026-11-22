/* Service Worker: App-Shell offline verfügbar machen. Kartenkacheln kommen aus dem Netz. */
const CACHE = 'fm-mapper-v3';
const SHELL = ['./', 'index.html', 'app.js?v=2', 'style.css?v=2', 'manifest.webmanifest', 'logo-hell.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/meshcore/connection/connection.js', 'vendor/meshcore/connection/web_ble_connection.js',
  'vendor/meshcore/connection/web_serial_connection.js', 'vendor/meshcore/connection/serial_connection.js',
  'vendor/meshcore/constants.js', 'vendor/meshcore/packet.js', 'vendor/meshcore/advert.js',
  'vendor/meshcore/buffer_reader.js', 'vendor/meshcore/buffer_writer.js', 'vendor/meshcore/buffer_utils.js',
  'vendor/meshcore/events.js', 'vendor/meshcore/meshcore_path.js', 'vendor/meshcore/random_utils.js',
  'vendor/meshcore/cayenne_lpp.js', 'vendor/meshcore/hex_util.js', 'vendor/meshcore/transport_key_util.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  // Netz zuerst (Updates), bei Funkloch aus dem Cache
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: false }).then((m) => m || caches.match(e.request, { ignoreSearch: true }))));
});
