// MediaMap Kiosk PWA — DEMO BUILD — Service Worker
// Caches the entire app shell — including Leaflet and Material Icons,
// which are vendored locally rather than loaded from a CDN (see
// vendor/README.md) — plus the bundled mediamap-kiosk-data/ files, so
// the demo works fully offline from the very first launch, even one
// that happens with zero network connectivity. If you replace the
// demo data, add your new filenames to APP_SHELL below and bump
// CACHE_NAME so the service worker picks up the change instead of
// serving a stale cached copy.

const CACHE_NAME = 'mediamap-kiosk-demo-v6'; // v6: install no longer fails the whole shell on one bad URL; logs the specific failing url

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
    './vendor/pdfjs/pdf.min.mjs',
    './vendor/pdfjs/pdf.worker.min.mjs',
    './vendor/pdfjs/standard_fonts/FoxitDingbats.pfb',
    './vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb',
    './vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
    './vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb',
    './vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb',
    './vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
    './vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb',
    './vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb',
    './vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb',
    './vendor/pdfjs/standard_fonts/FoxitSymbol.pfb',
    './vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
    './vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
    './vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
    './vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    './vendor/pdfjs/wasm/jbig2.wasm',
    './vendor/pdfjs/wasm/jbig2_nowasm_fallback.js',
    './vendor/pdfjs/wasm/qcms_bg.wasm',
    './vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc',
    // vendor/pdfjs/cmaps/, vendor/pdfjs/wasm/openjpeg*, and
    // vendor/pdfjs/wasm/quickjs-eval* are deliberately NOT vendored at
    // all (not just left uncached) — see vendor/README.md for why.
    './mediamap-kiosk-data/settings.json',
    './mediamap-kiosk-data/iitg_campus.geojson',
    './mediamap-kiosk-data/kaziranga_area.geojson',
    './mediamap-kiosk-data/assam_points_demo.geojson',
    './mediamap-kiosk-data/kaziranga-visitor-guide.pdf',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            // cache.addAll() is all-or-nothing and — critically — gives no
            // indication of WHICH url in APP_SHELL failed when it rejects,
            // just a generic "Request failed" TypeError. Caching each entry
            // individually means one bad/blocked URL doesn't sink caching
            // for everything else, and any failure is logged with the
            // specific url plus status, so the actual cause shows up in the
            // browser console instead of needing trial and error.
            Promise.all(
                APP_SHELL.map(url =>
                    fetch(url).then(response => {
                        if (!response.ok) {
                            console.warn('[SW] skip caching (HTTP ' + response.status + '):', url);
                            return;
                        }
                        return cache.put(url, response);
                    }).catch(err => {
                        console.warn('[SW] skip caching (fetch failed):', url, err);
                    })
                )
            )
        )
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