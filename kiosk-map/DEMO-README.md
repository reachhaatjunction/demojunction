# MediaMap Kiosk — Demo Build

This is a stripped-down build of the MediaMap Kiosk PWA for demoing and
evaluation. It boots straight into the map — no setup screen, no source
picker — using the sample data already bundled in `mediamap-kiosk-data/`.

## What's different from the full kiosk app

**Removed:**
- The setup screen and "URL / USB" mode tabs.
- Remote URL mode (the fullscreen iframe that points at a live WordPress
  MediaMap Kiosk site).
- USB folder picking (File System Access API) and the IndexedDB handle
  persistence that supported reconnecting to it across reloads.
- The domain allowlist + setup PIN security layer — there's no live
  source to protect in a demo, and no allowlist/PIN endpoints are wired
  into this build.
- The "⚙ source" button used to reconfigure a running kiosk.

**Kept, unchanged:**
- Leaflet map rendering, point clustering, styled GeoJSON shapes.
- The media lightbox (image / video / audio / Street View / embeds
  from YouTube, Vimeo, Spotify, SoundCloud, etc.).
- The idle-timer "heartbeat" that auto-resets to the overview after a
  period of inactivity (set to 25s in this build — short on purpose so
  the reset behavior is easy to see in a quick demo; the full app
  defaults to 90s).
- Offline support via the service worker — once loaded, the demo keeps
  working with no network connection at all, including PDFs (see below).

**Changed — PDF rendering:**
The original app embedded PDF points via `<iframe src="file.pdf">`,
which depends on the browser's own PDF plugin — most mobile browsers
(Chrome on Android especially, and inconsistently on iOS Safari) don't
reliably render that inline; they show a blank box or force a download.
This build instead renders PDFs onto a `<canvas>` using Mozilla's
PDF.js, vendored locally (~2.9MB — see `vendor/README.md` for what's
included and what was deliberately trimmed out), with page-by-page
navigation in the lightbox. Tap the sample "Visitor Guide (PDF)" point
near Kaziranga to see it. Works fully offline once cached, on desktop,
Android, and iOS alike.

**Tuned for demo purposes:**
- `idle_time_seconds` lowered from 90 → 25 in `settings.json`.
- `lock_bounds_to_data` left at its original default (`false`) — see
  the bug note below before turning this on.

## Replacing the demo data

No code changes needed. Everything lives in `mediamap-kiosk-data/`:

1. Add or replace a `.json`/`.geojson` file in that folder. Accepted
   shapes:
   - A plain array of points: `[{lat, lng, place_name, media_type, media_url, description}, ...]`
   - `{ "data": [...] }` wrapping the same array
   - GeoJSON (`FeatureCollection` / `Feature` / bare geometry) — `Point`/
     `MultiPoint` geometries become pins, `LineString`/`Polygon`/etc.
     become styled shapes
2. List it in `settings.json` under `"layers"`, with `"name"`,
   `"enabled": true`, and optionally `"shapeStyle"` (for shapes) or
   `"cluster": false` (to stop a layer's pins from clustering).
3. If a point's `media_url` is a plain filename (not `http…` or
   `data:`), it's resolved relative to `mediamap-kiosk-data/` — drop the
   referenced image/audio/video/PDF file in alongside it. For
   `"media_type": "pdf"`, that's all that's needed — no other config;
   see the bundled `kaziranga-visitor-guide.pdf` point for an example.
4. **If the service worker has already cached the old data**, add your
   new filenames to the `APP_SHELL` list in `sw.js` and bump
   `CACHE_NAME`, otherwise visitors who already loaded the demo once
   may keep seeing the old cached copy until the cache naturally
   expires/updates. (Or just have people do a hard refresh.)
5. Reload the page — that's it.

## ⚠️ A bug found while testing, worth knowing about

Turning on `"lock_bounds_to_data": true` with layers spread across a
wide area (e.g. data spanning >100km, like the bundled Kaziranga +
IIT Guwahati + Assam points) can produce a visibly wrong initial view —
the map settles zoomed into only part of the data, with the rest
completely missing from the locked viewable area.

Root cause: in `fitMapToActiveLayers()` (app.js), `map.setMaxBounds()`
and `map.setMinZoom()` are called immediately after `map.fitBounds()`,
in the same synchronous tick. When the initial zoom change is large
enough for Leaflet to animate it, that immediate follow-up call appears
to interrupt/conflict with the in-flight zoom animation, and the map
settles on the wrong final view rather than the one `fitBounds()` was
asked for. I reproduced this consistently in headless Chrome — it
isn't a one-off animation race, it's a deterministic wrong end-state
for this combination of inputs.

This logic is unchanged from your original `app.js` (ported verbatim) —
it's a pre-existing edge case, not something introduced by this demo
build. I left `lock_bounds_to_data` at its safe default (`false`) here
rather than patch the shared bounds-fitting code without being asked.
If you want it fixed for the production app too, the likely fix is
passing `{ animate: false }` to that `fitBounds()` call (or deferring
the `setMaxBounds`/`setMinZoom` calls to the map's `moveend` event) —
worth a dedicated look since it touches logic shared with the live
kiosk.

## ⚠️ A second bug found while testing — pdfjs-dist build matters a lot

While building the PDF viewer, the **main** (non-legacy) build of
`pdfjs-dist` 5.7.284/6.0.227 silently failed to render any text at
all — every PDF came out as a blank white page, with the only clue
being a console error (`getOrInsertComputed is not a function`) buried
inside `WorkerTransport.getOptionalContentConfig`.

Root cause: that build calls `Map.prototype.getOrInsertComputed()` —
a brand-new JavaScript Map method that's still a TC39 proposal, not a
finished/broadly-shipped standard — with no fallback if it's missing.
It threw on a fairly recent desktop Chromium (141) in testing, so this
isn't just an old-browser/old-device problem; it can break on
present-day browsers too, silently, with the page just looking empty.

The fix was switching to the **legacy** build
(`pdfjs-dist/legacy/build/...`), which includes a polyfill for this
and renders correctly everywhere tested. If you ever bump the vendored
PDF.js version, re-confirm you're still pulling from `legacy/build/`,
not `build/` — see `vendor/README.md`'s update instructions, which
call this out explicitly now.

Separately: PDF.js v5+ also requires `standardFontDataUrl` to be
passed explicitly to `getDocument()`, or text using any non-embedded
standard font silently fails to draw the same way. Both of these fail
*silently* — no error dialog, no console warning a developer would
necessarily notice, just a blank page — which is exactly the kind of
bug that's easy to ship and only discover when a real visitor taps a
real PDF on a real kiosk. Worth being aware of if you ever touch this
code path.

## Files of note

- `index.html` / `app.js` / `kiosk.css` — the trimmed-down app shell.
- `mediamap-kiosk-data/` — the swappable demo data + `settings.json`,
  including the sample `kaziranga-visitor-guide.pdf`.
- `vendor/pdfjs/` — the in-app PDF renderer; see `vendor/README.md`
  before ever updating its version.
- `sw.js` — offline caching; see step 4 above if you replace the data.
- `manifest.json` — PWA install metadata, labeled "(Demo)" so it's
  distinguishable from the full app if both are ever installed
  side-by-side on the same device.
