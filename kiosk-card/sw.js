// LexiPic Kiosk PWA — Service Worker
// Caches all app shell files on install so the kiosk works fully
// offline — including from the very first launch, on a kiosk that has
// never had connectivity, since Material Icons is now vendored locally
// (see vendor/README.md) rather than depending on a CDN having been
// successfully cached at least once already. USB-loaded set data
// (images/audio embedded as base64 in the JSON) is handled by
// IndexedDB in app.js — the service worker only caches the app shell
// itself.
//
// Fraunces remains CDN-loaded and best-effort cached (see
// vendor/README.md for why) — its absence offline is a minor cosmetic
// fallback to a generic serif, not a broken or confusing UI.

const CACHE_NAME = 'lexipic-kiosk-v2'; // bumped: v1 cached the old Material Icons CDN URL, no longer in the app shell

const APP_SHELL_LOCAL = [
    './',
    './index.html',
    './kiosk.css',
    './app.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './vendor/material-icons/material-icons.css',
    './vendor/material-icons/material-icons.woff2',
];

const APP_SHELL_BEST_EFFORT = [
    'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,700;1,9..144,400&display=swap',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            // Local app-shell files (now including the vendored icon
            // font) must all succeed, or installation should fail rather
            // than activate a half-cached shell. Fraunces is loaded
            // best-effort on top — losing it offline is cosmetic only.
            return cache.addAll(APP_SHELL_LOCAL).then(() =>
                cache.addAll(APP_SHELL_BEST_EFFORT).catch(() => {})
            );
        })
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
    const isAppShell = url.origin === location.origin || url.hostname.includes('googleapis.com');

    // Anything that isn't our own app shell (including the iframe's remote
    // page in URL mode, and any of its sub-resources) passes straight
    // through to the network untouched — we never want to intercept or
    // rewrite a kiosk page being displayed in the iframe.
    if (!isAppShell) return;

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
