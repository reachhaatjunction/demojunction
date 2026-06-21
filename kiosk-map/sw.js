// MediaMap Kiosk PWA — DEMO BUILD — Service Worker
// Caches the entire app shell — including Leaflet and Material Icons,
// which are vendored locally rather than loaded from a CDN (see
// vendor/README.md) — plus the bundled mediamap-kiosk-data/ files, so
// the demo works fully offline from the very first launch, even one
// that happens with zero network connectivity. If you replace the
// demo data, add your new filenames to APP_SHELL below and bump
// CACHE_NAME so the service worker picks up the change instead of
// serving a stale cached copy.

const CACHE_NAME = 'mediamap-kiosk-demo-v1';

const APP_SHELL = [
    './',
    './index.html',
    './kiosk.css',
    './app.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './vendor/material-icons/material-icons.css',
    './vendor/material-icons/material-icons.woff2',
    './vendor/leaflet/leaflet.css',
    './vendor/leaflet/leaflet.js',
    './vendor/leaflet/images/marker-icon.png',
    './vendor/leaflet/images/marker-icon-2x.png',
    './vendor/leaflet/images/marker-shadow.png',
    './vendor/leaflet/images/layers.png',
    './vendor/leaflet/images/layers-2x.png',
    './vendor/leaflet.markercluster/MarkerCluster.css',
    './vendor/leaflet.markercluster/leaflet.markercluster.js',
    './mediamap-kiosk-data/settings.json',
    './mediamap-kiosk-data/iitg_campus.geojson',
    './mediamap-kiosk-data/kaziranga_area.geojson',
    './mediamap-kiosk-data/assam_points_demo.geojson',
];

self.addEventListener('install', event => {
    event.waitUntil(
        // Every entry here is now same-origin (no CDN), so a single
        // cache.addAll() either fully succeeds or fully fails — no more
        // "best effort" split between local files and external assets.
        // If this fails, the browser keeps any PREVIOUSLY installed
        // service worker active rather than activating a half-cached
        // one, which is exactly the safe behavior we want here.
        caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Anything that isn't our own same-origin app shell (e.g. the
    // basemap tiles fetched directly by Leaflet, or any remote
    // media_url referenced from the demo data) passes straight through
    // to the network untouched.
    if (url.origin !== location.origin) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
