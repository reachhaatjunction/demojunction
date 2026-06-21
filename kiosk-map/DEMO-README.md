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
- The media lightbox (image / video / audio / PDF / Street View / embeds
  from YouTube, Vimeo, Spotify, SoundCloud, etc.).
- The idle-timer "heartbeat" that auto-resets to the overview after a
  period of inactivity (set to 25s in this build — short on purpose so
  the reset behavior is easy to see in a quick demo; the full app
  defaults to 90s).
- Offline support via the service worker — once loaded, the demo keeps
  working with no network connection at all.

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
   referenced image/audio/video/PDF file in alongside it.
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

## Files of note

- `index.html` / `app.js` / `kiosk.css` — the trimmed-down app shell.
- `mediamap-kiosk-data/` — the swappable demo data + `settings.json`.
- `sw.js` — offline caching; see step 4 above if you replace the data.
- `manifest.json` — PWA install metadata, labeled "(Demo)" so it's
  distinguishable from the full app if both are ever installed
  side-by-side on the same device.
