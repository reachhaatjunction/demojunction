# Vendored third-party assets

Material Icons is bundled locally instead of loaded from a CDN, on
purpose: this PWA's whole reason to exist is running on a kiosk that
may have **no internet connection at all**, including on the very
first time it's ever set up. A CDN-loaded font only works offline
*after* a service worker has successfully cached it once — which means
the very first boot, on a kiosk that has never had connectivity, would
show every icon as literal fallback text ("menu_book", "translate",
"folder_open"...) instead of an actual glyph, since many of those
icons carry meaning rather than being purely decorative. Vendoring
removes that dependency entirely.

Fraunces (the serif heading font) is deliberately left CDN-loaded — it
already has a solid generic-serif fallback and is purely decorative,
so it's a much smaller cosmetic hit if it's unavailable than the icon
font would be.

## What's here

- `material-icons/` — the classic "Filled" Material Icons web font
  (CSS trimmed down to just that one style, plus its `.woff2`).
  Sourced from the `material-icons` npm package (a self-hosted
  distribution of Google's Material Icons, Apache 2.0 licensed):
  https://www.npmjs.com/package/material-icons

## Updating

```bash
npm install material-icons@<version>
cp node_modules/material-icons/iconfont/material-icons.woff2 vendor/material-icons/material-icons.woff2
# material-icons.css is hand-trimmed from the npm package's
# iconfont/material-icons.css — keep only the first @font-face +
# .material-icons block (the "Filled" style); the package also bundles
# Outlined/Round/Sharp/Two-tone variants this app doesn't use.
```

After updating, bump `CACHE_NAME` in `sw.js` so kiosks already running
the service worker actually pick up the new file instead of serving
the old cached version indefinitely.
