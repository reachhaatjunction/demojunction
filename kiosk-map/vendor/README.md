# Vendored third-party assets

Everything in this folder is bundled locally instead of loaded from a
CDN, on purpose: this PWA's whole reason to exist is running on a kiosk
that may have **no internet connection at all**, including on the very
first time it's ever set up. A CDN-loaded library only works offline
*after* a service worker has successfully cached it once — which means
the very first boot, on a kiosk that has never had connectivity, would
fail before that cache ever gets populated. Vendoring removes that
dependency entirely: these files ship in the app package itself, so
USB mode works from boot #1, with zero network, every time.

(This bit Map mode specifically: before this fix, the entire "select
your USB folder" flow would complete successfully — picking the
folder, reading settings.json, reading every layer file — and then
fail at the very last step with `ReferenceError: L is not defined`,
because Leaflet had no local fallback. The folder-selection flow looks
identical online or offline; only the map library it needs at the end
ever depended on a connection that doesn't necessarily exist on a
freshly unboxed kiosk.)

## What's here

- `leaflet/` — Leaflet 1.9.4 (CSS, JS, marker icon images). Sourced
  from the `leaflet` npm package, which mirrors the same files the
  `unpkg.com/leaflet@1.9.4/dist/...` CDN URLs used to serve.
- `leaflet.markercluster/` — leaflet.markercluster 1.5.3 (JS plugin +
  its base structural CSS only). Sourced from the
  `leaflet.markercluster` npm package, MIT licensed. We deliberately
  do **not** vendor the package's `MarkerCluster.Default.css` — its
  green/yellow/orange bullseye theme is replaced with kiosk-branded
  indigo cluster bubbles styled in `kiosk.css` (`.mediamap-cluster-*`
  classes), built via `iconCreateFunction` in app.js
  (`buildClusterIcon`). Only `MarkerCluster.css` (transitions/spiderfy
  geometry, no colors) is needed alongside that.
- `material-icons/` — the classic "Filled" Material Icons web font
  (CSS trimmed down to just that one style, plus its `.woff2`).
  Sourced from the `material-icons` npm package (a self-hosted
  distribution of Google's Material Icons, Apache 2.0 licensed):
  https://www.npmjs.com/package/material-icons

## Updating

```bash
npm install leaflet@<version>
cp node_modules/leaflet/dist/leaflet.css vendor/leaflet/leaflet.css
cp node_modules/leaflet/dist/leaflet.js  vendor/leaflet/leaflet.js
cp node_modules/leaflet/dist/images/*.png vendor/leaflet/images/

npm install leaflet.markercluster@<version>
cp node_modules/leaflet.markercluster/dist/leaflet.markercluster.js vendor/leaflet.markercluster/leaflet.markercluster.js
cp node_modules/leaflet.markercluster/dist/MarkerCluster.css        vendor/leaflet.markercluster/MarkerCluster.css
# (MarkerCluster.Default.css is intentionally not copied — see above)

npm install material-icons@<version>
cp node_modules/material-icons/iconfont/material-icons.woff2 vendor/material-icons/material-icons.woff2
# material-icons.css is hand-trimmed from the npm package's
# iconfont/material-icons.css — keep only the first @font-face +
# .material-icons block (the "Filled" style); the package also bundles
# Outlined/Round/Sharp/Two-tone variants this app doesn't use.
```

After updating, bump `CACHE_NAME` in `sw.js` so kiosks already running
the service worker actually pick up the new files instead of serving
the old cached versions indefinitely.
