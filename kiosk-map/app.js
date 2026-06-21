// =============================================================================
// MediaMap Kiosk PWA — DEMO BUILD — app.js
//
// This is a stripped-down build for demoing/evaluation. Compared to the
// full kiosk app, it has been reduced to ONE thing: a read-only Leaflet
// map renderer that loads settings.json + layer files from the bundled
// mediamap-kiosk-data/ folder via fetch(), the same import format the
// MediaMap Kiosk WordPress plugin's importer accepts.
//
// Removed entirely for this build (see DEMO-README.md for why):
//   - The setup screen and mode tabs — there is nothing to configure.
//   - Remote URL / iframe mode (no live WordPress site to point at).
//   - USB folder picking (File System Access API) + the IndexedDB
//     handle persistence that supported it — data now ships IN the
//     PWA's own folder and is read with a normal fetch().
//   - The domain allowlist + setup PIN security layer, which only
//     mattered for letting someone change the live source on a real
//     kiosk. A demo has nothing to protect, so this is just removed
//     rather than disabled — there are no live allowlist/PIN endpoints
//     wired into this build.
//
// Kept unchanged from the full app: map rendering, point clustering,
// styled GeoJSON shapes, the media lightbox (image/video/audio/PDF/
// street view), the idle-timer auto-reset "heartbeat", and offline
// caching via the service worker.
//
// To show your own data: replace/add files in mediamap-kiosk-data/ and
// list them in its settings.json. No code changes needed — see that
// file's comments, or DEMO-README.md, for the format.
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// 0. CONSTANTS + STATE
// ---------------------------------------------------------------------------
const DATA_DIR = './mediamap-kiosk-data/'; // bundled with the PWA, read via fetch()

let lastLoadErrors   = []; // layers listed in settings.json that failed to load this boot
let lastActivityTime = Date.now(); // drives the idle-timer heartbeat

function handleUserActivity() {
    lastActivityTime = Date.now();
    if (remainingSeconds < (KIOSK_IDLE_TIME / 1000)) {
        remainingSeconds = KIOSK_IDLE_TIME / 1000;
        updateCountdownUI();
    }
}

// ---------------------------------------------------------------------------
// 1. DATA LOADING (fetch-based — reads the bundled mediamap-kiosk-data/ folder)
// ---------------------------------------------------------------------------

async function readJsonFile(filename) {
    const res = await fetch(DATA_DIR + filename, { cache: 'no-store' });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

/**
 * Resolve a media_url value to a usable src. Remote URLs and data URIs
 * pass through untouched; a plain filename is treated as relative to
 * the data folder (mirrors the "local file" support the full app
 * offers in USB mode, just served over fetch() instead of the File
 * System Access API).
 */
async function resolveMediaUrl(value) {
    if (!value) return '';
    if (value.startsWith('data:') || value.startsWith('http') || value.startsWith('blob:')) return value;
    return DATA_DIR + value;
}

// --- DATA NORMALIZATION MODULE ---
// Ported from the MediaMap Kiosk plugin's MediaMap_Kiosk_Data_Normalizer
// (PHP) / DataNormalizationModule (JS) — same accepted shapes: a plain
// array of point objects, { data: [...] }, or GeoJSON (FeatureCollection/
// Feature/bare geometry). Point/MultiPoint geometries become flat marker
// points; LineString/Polygon/MultiLineString/MultiPolygon geometries are
// kept as raw GeoJSON Features for Leaflet to render directly.
const DataNormalizationModule = {
    process(rawInput) {
        let pointSources = [];
        let shapeFeatures = [];

        if (Array.isArray(rawInput)) {
            pointSources = rawInput;
        } else if (this.isGeoJSON(rawInput)) {
            const split = this.flattenGeoJSON(rawInput);
            pointSources = split.points;
            shapeFeatures = split.shapes;
        } else if (rawInput && rawInput.data && Array.isArray(rawInput.data)) {
            pointSources = rawInput.data;
        } else if (rawInput && Array.isArray(rawInput.features)) {
            const split = this.flattenGeoJSON({ type: 'FeatureCollection', features: rawInput.features });
            pointSources = split.points;
            shapeFeatures = split.shapes;
        }

        const points = pointSources.map(item => {
            const source = item.properties ? item.properties : item;

            let latVal = item.lat ?? source.lat;
            let lngVal = item.lng ?? source.lng;

            if ((latVal === undefined || lngVal === undefined) && item.geometry && item.geometry.type === 'Point') {
                const coords = item.geometry.coordinates;
                if (Array.isArray(coords) && coords.length >= 2) {
                    lngVal = coords[0];
                    latVal = coords[1];
                }
            }

            return {
                id: source.id || Math.random().toString(36).substr(2, 9),
                lat: parseFloat(latVal),
                lng: parseFloat(lngVal),
                place_name: source.place_name || source.name || 'Unknown Location',
                media_type: (source.media_type || this.detectMediaType(source.media_url)).toLowerCase(),
                media_url: source.media_url || '',
                description: source.description || source.desc || '',
            };
        }).filter(item => !isNaN(item.lat) && !isNaN(item.lng));

        return { points, shapeFeatures };
    },

    isGeoJSON(rawInput) {
        if (!rawInput || typeof rawInput !== 'object') return false;
        const shapeTypes = ['FeatureCollection', 'Feature', 'Point', 'MultiPoint',
            'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'];
        return shapeTypes.includes(rawInput.type);
    },

    flattenGeoJSON(rawInput) {
        let features;
        if (rawInput.type === 'FeatureCollection') {
            features = Array.isArray(rawInput.features) ? rawInput.features : [];
        } else if (rawInput.type === 'Feature') {
            features = [rawInput];
        } else {
            features = [{ type: 'Feature', geometry: rawInput, properties: {} }];
        }

        const points = [];
        const shapes = [];
        const SHAPE_GEOMETRY_TYPES = ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];

        const handleGeometry = (geom, props) => {
            if (!geom) return;

            if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
                points.push({ geometry: geom, properties: props });
            } else if (geom.type === 'MultiPoint' && Array.isArray(geom.coordinates)) {
                geom.coordinates.forEach(coords => {
                    points.push({ geometry: { type: 'Point', coordinates: coords }, properties: props });
                });
            } else if (SHAPE_GEOMETRY_TYPES.includes(geom.type)) {
                shapes.push({ type: 'Feature', geometry: geom, properties: props });
            } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
                geom.geometries.forEach(g => handleGeometry(g, props));
            }
        };

        features.forEach(feature => {
            handleGeometry(feature.geometry, feature.properties || {});
        });

        const resolvedPoints = points.map(item => ({
            ...item,
            lat: item.geometry.coordinates[1],
            lng: item.geometry.coordinates[0],
        }));

        return { points: resolvedPoints, shapes };
    },

    detectMediaType(url) {
        if (!url) return 'text';
        if (url.includes('youtube.com') || url.includes('youtu.be')) return 'video';
        if (url.match(/^https?:\/\/(www\.)?google\.com\/maps\/embed/)) return 'streetview';
        if (url.match(/\.(jpeg|jpg|gif|png|webp)$/i)) return 'image';
        if (url.match(/\.(mp3|wav|ogg)$/i)) return 'audio';
        if (url.match(/\.(mp4|webm)$/i)) return 'video';
        if (url.match(/\.pdf$/i)) return 'pdf';
        return 'text';
    },
};

/** Reads settings.json's top-level "kiosk" block. */
async function getKioskSettings() {
    const config = await readJsonFile('settings.json');
    return config.kiosk || { idle_time_seconds: 90, lock_bounds_to_data: false };
}

/**
 * Loads every enabled layer listed in settings.json, normalizes each
 * file's contents the same way the WordPress plugin's importer would,
 * and resolves any locally-referenced point media to fetchable URLs.
 * Shaped to match what GET /layers returns from the live plugin
 * (groupName/active/order/shapeStyle/data/shapes), so the rendering
 * code below (ported from the plugin's app.js) works unmodified.
 */
async function getAllLayers() {
    const config = await readJsonFile('settings.json');
    const entries = Array.isArray(config.layers) ? config.layers : [];
    const layers = [];
    const errors = [];

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.enabled) continue;
        const file = entry.file;
        if (!file) continue;

        try {
            const raw = await readJsonFile(file);
            const { points, shapeFeatures } = DataNormalizationModule.process(raw);

            const resolvedPoints = await Promise.all(points.map(async p => ({
                ...p,
                media_url: await resolveMediaUrl(p.media_url),
            })));

            layers.push({
                id: file,
                groupName: entry.name || file,
                active: true,
                order: i,
                shapeStyle: Object.assign({}, DEFAULT_SHAPE_STYLE, entry.shapeStyle || {}),
                cluster: entry.cluster !== false, // default on; "cluster": false opts a layer's pins out
                data: resolvedPoints,
                shapes: shapeFeatures,
            });
        } catch (err) {
            const reason = (err && err.status === 404)
                ? `File "${file}" not found in the data folder.`
                : `File "${file}" couldn't be loaded (${err.message || 'invalid JSON'}).`;
            errors.push({ file, name: entry.name || file, reason });
        }
    }

    lastLoadErrors = errors;
    return layers;
}

/**
 * Shows a small dismissible banner listing any layers from settings.json
 * that failed to load this boot (usually a filename mismatch or invalid
 * JSON). Without this, a missing layer is silent and very hard to
 * self-diagnose from the kiosk screen alone.
 */
function renderLoadErrorBanner() {
    const existing = document.getElementById('load-error-banner');
    if (existing) existing.remove();
    if (!lastLoadErrors || lastLoadErrors.length === 0) return;

    const banner = document.createElement('div');
    banner.id = 'load-error-banner';
    banner.innerHTML = `
        <span class="material-icons">error_outline</span>
        <div class="load-error-text">
            <strong>${lastLoadErrors.length} layer${lastLoadErrors.length === 1 ? '' : 's'} could not be loaded:</strong>
            ${lastLoadErrors.map(e => `<div>${escHtml(e.name)} — ${escHtml(e.reason)}</div>`).join('')}
        </div>
        <button type="button" aria-label="Dismiss">&times;</button>
    `;
    banner.querySelector('button').addEventListener('click', () => banner.remove());
    document.querySelector('main').prepend(banner);
}

/**
 * Shown only if settings.json itself can't be read at all (missing,
 * unreachable, invalid JSON) — there's no setup screen to fall back to
 * in this build, so this reuses the existing "empty state" UI with a
 * clearer message instead of leaving a blank map.
 */
function showFatalLoadError(err) {
    initMap(); // still show a basemap behind the message
    document.getElementById('map-empty-icon').textContent = 'cloud_off';
    document.getElementById('map-empty-title').textContent = "Couldn't load demo data";
    document.getElementById('map-empty-msg').textContent =
        `Check that mediamap-kiosk-data/settings.json exists and is valid JSON. (${err.message || 'Unknown error'})`;
    document.getElementById('map-empty').style.display = 'flex';
}

// ---------------------------------------------------------------------------
// 2. MEDIA EMBED RESOLUTION MODULE
// ---------------------------------------------------------------------------
// Pure string/regex logic, no DOM dependency — ported unchanged from the
// MediaMap Kiosk plugin's app.js.
const MediaEmbedModule = {
    resolve(type, url) {
        if (!url) return null;

        let host = '';
        try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }

        const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);
        if (yt) return { kind: 'iframe', src: `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0` };

        const vm = url.match(/vimeo\.com\/(\d+)/);
        if (vm) return { kind: 'iframe', src: `https://player.vimeo.com/video/${vm[1]}?autoplay=1` };

        const dm = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
        if (dm) return { kind: 'iframe', src: `https://www.dailymotion.com/embed/video/${dm[1]}?autoplay=1` };

        const parent = encodeURIComponent(window.location.hostname || 'localhost');
        const twClip = url.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/[^/]+\/clip\/)([A-Za-z0-9_-]+)/);
        if (twClip) return { kind: 'iframe', src: `https://clips.twitch.tv/embed?clip=${twClip[1]}&parent=${parent}` };
        const twVod = url.match(/twitch\.tv\/videos\/(\d+)/);
        if (twVod) return { kind: 'iframe', src: `https://player.twitch.tv/?video=${twVod[1]}&parent=${parent}&autoplay=true` };
        const twChannel = url.match(/twitch\.tv\/([A-Za-z0-9_]+)\/?(?:$|\?)/);
        if (twChannel && host === 'twitch.tv') return { kind: 'iframe', src: `https://player.twitch.tv/?channel=${twChannel[1]}&parent=${parent}&autoplay=true` };

        const tt = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
        if (tt) return { kind: 'iframe', src: `https://www.tiktok.com/player/v1/${tt[1]}` };

        const sm = url.match(/streamable\.com\/([A-Za-z0-9]+)/);
        if (sm && !/^(e|o|s)$/.test(sm[1])) return { kind: 'iframe', src: `https://streamable.com/e/${sm[1]}?autoplay=1` };

        const lm = url.match(/loom\.com\/share\/([A-Za-z0-9]+)/);
        if (lm) return { kind: 'iframe', src: `https://www.loom.com/embed/${lm[1]}` };

        const sp = url.match(/open\.spotify\.com\/(track|episode|playlist|album|show)\/([A-Za-z0-9]+)/);
        if (sp) return { kind: 'iframe', src: `https://open.spotify.com/embed/${sp[1]}/${sp[2]}` };

        if (host === 'soundcloud.com') {
            return { kind: 'iframe', src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&auto_play=true&color=1abc9c` };
        }

        if (type === 'streetview') {
            let parsed;
            try { parsed = new URL(url); } catch (e) { return null; }
            const isGoogleHost = parsed.hostname === 'google.com' || parsed.hostname === 'www.google.com';
            if (isGoogleHost && parsed.pathname.startsWith('/maps/embed')) {
                return { kind: 'iframe', src: url };
            }
            return null;
        }

        // Locally-bundled files resolved by resolveMediaUrl() are normal
        // same-origin URLs here (not blob:/data: URIs, since there's no
        // File System Access API in this build) — extension sniffing
        // below already covers them. data: URIs are still recognized in
        // case a JSON file inlines one directly.
        if (url.startsWith('blob:') || url.startsWith('data:')) {
            if (type === 'video') return { kind: 'file', src: url };
            if (type === 'audio') return { kind: 'file', src: url };
            if (type === 'pdf') return { kind: 'file', src: url };
        }

        const cleanPath = url.split('?')[0].split('#')[0];
        const ext = cleanPath.split('.').pop().toLowerCase();
        if (type === 'video' && ['mp4', 'webm', 'ogv', 'mov'].includes(ext)) return { kind: 'file', src: url };
        if (type === 'audio' && ['mp3', 'wav', 'flac', 'aac', 'oga', 'm4a', 'opus', 'wma'].includes(ext)) return { kind: 'file', src: url };
        if (type === 'pdf' && ext === 'pdf') return { kind: 'file', src: url };

        return null;
    },
};

// ---------------------------------------------------------------------------
// 3. PDF VIEWER MODULE (PDF.js — vendored locally, see vendor/README.md)
// ---------------------------------------------------------------------------
// Renders PDF points onto a <canvas> instead of embedding them via
// <iframe src="file.pdf">. The iframe approach depends entirely on the
// browser having its own inline PDF plugin — desktop browsers do, but
// most mobile browsers don't reliably: Chrome on Android commonly shows
// a download prompt instead of rendering inline, and iOS Safari is
// inconsistent about it too. PDF.js parses + rasterizes the PDF itself,
// so it looks identical on a kiosk, a phone, or a desktop, fully offline.
//
// pdfjs-dist no longer ships a plain-global/UMD script (every build is
// an ES module as of v4+), so the library is loaded via a dynamic
// import() the first time a PDF is actually opened — not on every
// kiosk boot — rather than a <script> tag like the other vendored libs.
//
// This uses the LEGACY build specifically (vendor/pdfjs/pdf.min.mjs is
// copied from pdfjs-dist's legacy/build/, not its main build/) — the
// main build calls a brand-new, not-yet-broadly-supported Map method
// with no fallback, which silently breaks rendering (blank page, no
// visible error) on browsers that don't have it yet — including, at
// the time this was written, a fairly recent desktop Chromium. See
// vendor/README.md for the full explanation.
const PdfViewerModule = (() => {
    let pdfjsLib = null;
    let pdfjsLoadPromise = null;
    let pdfDoc = null;
    let pageNum = 1;
    let currentRenderTask = null; // the in-flight PDF.js RenderTask, if any — cancelled rather than left to race a newer one
    let resizeHandler = null;
    let renderToken = 0; // bumped on every open()/destroy() to invalidate any in-flight load from a previous PDF

    // cancel()/destroy() are best-effort cleanup — if PDF.js's own internal
    // bookkeeping throws on a particular browser/timing combination, that's
    // not something the rest of the app should ever see as an error.
    function safeCancelTask() {
        if (currentRenderTask) {
            try { currentRenderTask.cancel(); } catch (err) { /* ignore */ }
            currentRenderTask = null;
        }
    }
    function safeDestroyDoc(doc) {
        if (!doc) return;
        try {
            const result = doc.destroy();
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (err) { /* ignore */ }
    }

    async function ensureLib() {
        if (pdfjsLib) return pdfjsLib;
        if (!pdfjsLoadPromise) {
            pdfjsLoadPromise = import('./vendor/pdfjs/pdf.min.mjs').then(mod => {
                mod.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
                pdfjsLib = mod;
                return mod;
            });
        }
        return pdfjsLoadPromise;
    }

    function destroy() {
        renderToken++; // any load still in flight from the old doc becomes a no-op
        if (resizeHandler) {
            window.removeEventListener('resize', resizeHandler);
            resizeHandler = null;
        }
        safeCancelTask();
        if (pdfDoc) {
            const doc = pdfDoc;
            pdfDoc = null;
            safeDestroyDoc(doc);
        }
        pageNum = 1;
    }

    /**
     * Renders `url` into `mediaBox`. Resolves true on success, 'stale' if
     * a newer open()/destroy() call superseded this one before it
     * finished (caller should do nothing), or false if the file
     * genuinely couldn't be loaded/parsed (caller shows the standard
     * "can't be displayed" status view).
     */
    async function open(mediaBox, url) {
        destroy(); // tear down whatever PDF (if any) was showing before this one
        const myToken = renderToken;

        mediaBox.innerHTML = `
            <div class="pdf-viewer">
                <div class="pdf-canvas-wrap">
                    <div class="pdf-loading"><span class="pdf-spinner"></span></div>
                    <canvas class="pdf-canvas"></canvas>
                </div>
                <div class="pdf-toolbar">
                    <button type="button" class="pdf-nav-btn" data-dir="-1" aria-label="Previous page" disabled>
                        <span class="material-icons">chevron_left</span>
                    </button>
                    <span class="pdf-page-indicator">– / –</span>
                    <button type="button" class="pdf-nav-btn" data-dir="1" aria-label="Next page" disabled>
                        <span class="material-icons">chevron_right</span>
                    </button>
                </div>
            </div>`;

        const canvas    = mediaBox.querySelector('.pdf-canvas');
        const loading   = mediaBox.querySelector('.pdf-loading');
        const indicator = mediaBox.querySelector('.pdf-page-indicator');
        const prevBtn   = mediaBox.querySelector('.pdf-nav-btn[data-dir="-1"]');
        const nextBtn   = mediaBox.querySelector('.pdf-nav-btn[data-dir="1"]');

        let lib, doc;
        try {
            lib = await ensureLib();
            if (myToken !== renderToken) return 'stale'; // a newer open()/destroy() happened while loading the library
            doc = await lib.getDocument({
                url,
                // As of PDF.js v5, these resource paths are no longer bundled
                // inline and MUST be supplied explicitly — without
                // standardFontDataUrl specifically, any text using a non-
                // embedded standard font (extremely common) silently fails
                // to draw: the page renders as a blank white rectangle with
                // no error visible to the kiosk visitor.
                //
                // cMapUrl is deliberately NOT set: it only covers legacy
                // CJK (Chinese/Japanese/Korean) CID-keyed font encodings,
                // which this archive's Indic/Latin-script content doesn't
                // use — Indic scripts render fine via standard embedded
                // Unicode fonts without it. Omitting it saved ~1.7MB of
                // vendored cmap files this app would never actually need;
                // see vendor/README.md if that ever changes.
                //
                // wasmUrl/iccUrl cover JBIG2 decoding (common in scanned
                // document compression — kept) and CMYK colour conversion
                // (kept, tiny). JPEG2000 decoding and embedded-PDF-
                // JavaScript execution were trimmed from vendor/pdfjs/wasm/
                // for the same reason as cmaps — see vendor/README.md.
                standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
                wasmUrl: './vendor/pdfjs/wasm/',
                iccUrl: './vendor/pdfjs/iccs/',
            }).promise;
        } catch (err) {
            if (myToken !== renderToken) return 'stale';
            console.warn('PDF load failed:', err);
            return false;
        }
        if (myToken !== renderToken) { safeDestroyDoc(doc); return 'stale'; }
        pdfDoc = doc; // only commit to shared state once we know this call is still the current one

        indicator.textContent = `1 / ${pdfDoc.numPages}`;
        prevBtn.addEventListener('click', () => renderPage(pageNum - 1));
        nextBtn.addEventListener('click', () => renderPage(pageNum + 1));
        resizeHandler = () => renderPage(pageNum); // re-fit on device rotation / window resize
        window.addEventListener('resize', resizeHandler);

        await renderPage(1);
        if (myToken !== renderToken) return 'stale';
        loading.remove();
        return true;

        async function renderPage(num) {
            if (!pdfDoc || myToken !== renderToken || num < 1 || num > pdfDoc.numPages) return;

            // Cancel whatever page render is still in flight before starting
            // a new one — PDF.js doesn't allow two concurrent render() calls
            // against the same canvas (a nav-button click and the resize
            // handler can otherwise both try to render at once).
            safeCancelTask();

            pageNum = num;
            indicator.textContent = `${pageNum} / ${pdfDoc.numPages}`;
            prevBtn.disabled = pageNum <= 1;
            nextBtn.disabled = pageNum >= pdfDoc.numPages;

            const page = await pdfDoc.getPage(pageNum);
            if (myToken !== renderToken) return;

            const wrap = canvas.parentElement;
            const unscaled = page.getViewport({ scale: 1 });
            const fitScale = Math.max(0.1, Math.min(
                wrap.clientWidth / unscaled.width,
                wrap.clientHeight / unscaled.height
            ));
            // Cap device-pixel-ratio scaling — kiosk hardware is often
            // lower-powered, and a 3x/4x canvas for a single PDF page is
            // wasted work the eye won't notice on a touchscreen anyway.
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            const viewport = page.getViewport({ scale: fitScale * pixelRatio });

            canvas.width  = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            canvas.style.width  = Math.round(viewport.width / pixelRatio) + 'px';
            canvas.style.height = Math.round(viewport.height / pixelRatio) + 'px';

            const ctx = canvas.getContext('2d');
            const task = page.render({ canvasContext: ctx, viewport });
            currentRenderTask = task;
            try {
                await task.promise;
            } catch (err) {
                if (err && err.name === 'RenderingCancelledException') return; // superseded by a newer page/resize — expected
                console.warn('PDF page render failed:', err);
            } finally {
                if (currentRenderTask === task) currentRenderTask = null;
            }
        }
    }

    return { open, destroy };
})();

// ---------------------------------------------------------------------------
// 4. MARKER ICON MODULE
// ---------------------------------------------------------------------------
const MarkerIconModule = {
    TYPES: {
        video: {
            color: '#e11d48',
            label: 'Video',
            glyph: '<path d="M1 3.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Zm9.5 2 4-2.2v9.4l-4-2.2v-5Z"/>',
        },
        audio: {
            color: '#7c3aed',
            label: 'Audio',
            glyph: '<path d="M8 1.5a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4A2.5 2.5 0 0 1 8 1.5Zm-4.25 6.75a.75.75 0 0 1 .75.75 3.5 3.5 0 0 0 7 0 .75.75 0 0 1 1.5 0 5 5 0 0 1-4.25 4.94v1.31h1.25a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5h1.25v-1.31A5 5 0 0 1 3 9a.75.75 0 0 1 .75-.75Z"/>',
        },
        image: {
            color: '#d97706',
            label: 'Image',
            glyph: '<path d="M2 2.5h12A1.5 1.5 0 0 1 15.5 4v8A1.5 1.5 0 0 1 14 13.5H2A1.5 1.5 0 0 1 .5 12V4A1.5 1.5 0 0 1 2 2.5Zm.5 9.5h11l-3.6-4.6a.5.5 0 0 0-.77-.03L6.8 10.2 5.06 8.32a.5.5 0 0 0-.74.02L2.5 11v1Zm3-6a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z"/>',
        },
        pdf: {
            color: '#dc2626',
            label: 'PDF',
            glyph: '<path d="M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm5.5.9V4.5a.5.5 0 0 0 .5.5h2.1l-2.6-2.6ZM5 8h6v1H5V8Zm0 2.5h6v1H5v-1ZM5 5.5h3v1H5v-1Z"/>',
        },
        text: {
            color: '#475569',
            label: 'Note',
            glyph: '<path d="M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Zm5.5.9V4.5a.5.5 0 0 0 .5.5h2.1l-2.6-2.6ZM5 8h6v1H5V8Zm0 2.5h6v1H5v-1ZM5 5.5h3v1H5v-1Z"/>',
        },
        streetview: {
            color: '#0891b2',
            label: 'Street View',
            glyph: '<path d="M8 9.8c3.6 0 6.5-1 6.5-2.3S11.6 5.2 8 5.2 1.5 6.2 1.5 7.5 4.4 9.8 8 9.8Zm0-3.4c.9 0 1.6.5 1.6 1.1S8.9 7.6 8 7.6s-1.6-.5-1.6-1.1.7-1.1 1.6-1.1Zm0-5.1a2.6 2.6 0 0 0-2.6 2.6c0 1.9 2.6 4.9 2.6 4.9s2.6-3 2.6-4.9A2.6 2.6 0 0 0 8 1.3Zm0 3.6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>',
        },
    },

    build(type) {
        const def = this.TYPES[type] || this.TYPES.text;
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 42" width="32" height="42">
                <path d="M16 0C7.163 0 0 7.163 0 16c0 10 10 20 16 26 6-6 16-16 16-26C32 7.163 24.837 0 16 0z"
                      fill="${def.color}" stroke="rgba(15,23,42,0.35)" stroke-width="1.5"/>
                <g transform="translate(8,7)" fill="#ffffff">${def.glyph}</g>
            </svg>`;

        return L.divIcon({
            html: svg,
            className: `mediamap-marker-icon mediamap-marker-${type}`,
            iconSize: [32, 42],
            iconAnchor: [16, 42],
            popupAnchor: [0, -42],
        });
    },

    labelFor(type) {
        return (this.TYPES[type] || this.TYPES.text).label;
    },
};

// Cluster bubbles, styled to match the indigo kiosk theme rather than
// leaflet.markercluster's default green/yellow/orange bullseye (we don't
// load MarkerCluster.Default.css for that reason — see vendor/README.md).
// Three size/shade tiers give a rough sense of cluster magnitude at a
// glance, the same way the default theme's color tiers do.
function buildClusterIcon(cluster) {
    const count = cluster.getChildCount();
    let tier = 'mediamap-cluster-small';
    let diameter = 38;
    if (count >= 50) {
        tier = 'mediamap-cluster-large';
        diameter = 54;
    } else if (count >= 10) {
        tier = 'mediamap-cluster-medium';
        diameter = 46;
    }

    return L.divIcon({
        html: `<div class="mediamap-cluster-inner">${count}</div>`,
        className: `mediamap-cluster-icon ${tier}`,
        iconSize: L.point(diameter, diameter),
    });
}

// ---------------------------------------------------------------------------
// 5. MAP STATE, IDLE TIMER, HEARTBEAT
// ---------------------------------------------------------------------------
let map, mapLayers = {};
let mapInitialized = false;

const DEFAULT_SHAPE_STYLE = {
    fillColor: '#4f46e5',
    fillOpacity: 0.35,
    lineColor: '#4f46e5',
    lineWeight: 3,
    label: '',
    labelColor: '#1e293b',
    labelSize: 14,
};

let KIOSK_IDLE_TIME = 90 * 1000;
let remainingSeconds = KIOSK_IDLE_TIME / 1000;
let idleInterval = null;

function setIdleTimeSeconds(seconds) {
    KIOSK_IDLE_TIME = Math.max(5, Math.round(seconds)) * 1000;
    remainingSeconds = KIOSK_IDLE_TIME / 1000;
    updateCountdownUI();
}

function updateCountdownUI() {
    const display = document.getElementById('lightbox-countdown');
    if (display) {
        display.querySelector('span:not(.material-icons)').textContent = `Auto-closes in ${remainingSeconds}s`;
    }
}

function startKioskHeartbeat() {
    stopKioskHeartbeat();
    idleInterval = setInterval(() => {
        const timeSinceLastActivity = Date.now() - lastActivityTime;
        const calculatedRemaining = Math.max(0, Math.ceil((KIOSK_IDLE_TIME - timeSinceLastActivity) / 1000));

        if (calculatedRemaining !== remainingSeconds) {
            remainingSeconds = calculatedRemaining;
            updateCountdownUI();
        }

        if (timeSinceLastActivity >= KIOSK_IDLE_TIME) {
            // Reset to a clean overview for the next visitor: close any
            // open lightbox and re-fit the map to the active layers.
            closeLightbox();
            fitMapToActiveLayers();
            lastActivityTime = Date.now();
        }
    }, 1000);
}

function stopKioskHeartbeat() {
    if (idleInterval) { clearInterval(idleInterval); idleInterval = null; }
}

// ---------------------------------------------------------------------------
// 6. MAP INITIALIZATION
// ---------------------------------------------------------------------------
const KIOSK_HOME_VIEW = { center: [26.1805, 91.7539], zoom: 8 };

function initMap() {
    if (mapInitialized) return;
    mapInitialized = true;

    map = L.map('map', { zoomControl: false, tap: false }).setView(KIOSK_HOME_VIEW.center, KIOSK_HOME_VIEW.zoom);
    L.control.zoom({ position: 'topright' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    }).addTo(map);

    initMapResizeHandling();
}

// Leaflet measures its container once on creation and then caches that
// size; it never re-measures on its own. A device rotation or the
// mobile browser chrome showing/hiding (resizing the dynamic viewport)
// leaves Leaflet's cached size stale, so tiles/markers only occupy the
// old box until something forces a recalculation. A ResizeObserver on
// the map container, plus listening for visualViewport resizes, covers
// both cases so the map always settles back to the right size on its own.
function initMapResizeHandling() {
    const mapEl = document.getElementById('map');

    if ('ResizeObserver' in window && mapEl) {
        const resizeObserver = new ResizeObserver(() => {
            if (map) map.invalidateSize();
        });
        resizeObserver.observe(mapEl);
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if (map) map.invalidateSize();
        });
    }
}

// ---------------------------------------------------------------------------
// 7. LAYER RENDERING (ported from the MediaMap Kiosk plugin's app.js;
//    point clustering added on top via the vendored leaflet.markercluster
//    plugin — see vendor/README.md)
// ---------------------------------------------------------------------------
function renderLayerOnMap(layer) {
    const groupName = layer.groupName;
    if (mapLayers[groupName]) {
        map.removeLayer(mapLayers[groupName]);
    }

    const layerGroup = L.featureGroup();
    const points = layer.data || [];

    // Clustering only makes sense for point pins — shapes (lines/polygons,
    // handled further below) are added straight to layerGroup and never
    // pass through this group. A layer can opt out via "cluster": false
    // in settings.json (e.g. a small, important set of pins you always
    // want individually visible rather than collapsing into a bubble).
    const pointsTarget = (layer.cluster !== false)
        ? L.markerClusterGroup({
            showCoverageOnHover: false, // kiosk is touch-driven; hover footprints don't apply
            zoomToBoundsOnClick: true,
            spiderfyOnMaxZoom: true,    // un-stacks pins still overlapping at max zoom
            chunkedLoading: true,       // keeps large point layers from blocking the UI thread
            maxClusterRadius: 60,
            iconCreateFunction: buildClusterIcon,
        })
        : L.featureGroup();

    points.forEach(item => {
        const marker = L.marker([item.lat, item.lng], {
            icon: MarkerIconModule.build(item.media_type),
        });

        const typeLabel = MarkerIconModule.labelFor(item.media_type);
        marker.bindTooltip(`${item.place_name} &middot; ${typeLabel}`, { direction: 'top', offset: [0, -38] });
        marker.on('click', () => {
            openLightbox(item);
        });
        pointsTarget.addLayer(marker);
    });

    if (points.length > 0) {
        layerGroup.addLayer(pointsTarget);
    }

    const shapes = layer.shapes || [];
    if (shapes.length > 0) {
        const style = layer.shapeStyle || DEFAULT_SHAPE_STYLE;
        const geoJsonLayer = L.geoJSON(shapes, {
            style: () => ({
                color: style.lineColor,
                weight: style.lineWeight,
                fillColor: style.fillColor,
                fillOpacity: style.fillOpacity,
            }),
        });
        layerGroup.addLayer(geoJsonLayer);

        if (style.label && style.label.trim()) {
            const labelPoint = findLargestShapeCenter(geoJsonLayer);
            if (labelPoint) {
                const labelIcon = L.divIcon({
                    html: `<span class="mediamap-shape-label" style="color:${escHtml(style.labelColor)};font-size:${parseFloat(style.labelSize) || 14}px;">${escHtml(style.label)}</span>`,
                    className: 'mediamap-shape-label-icon',
                    iconSize: null,
                });
                const labelMarker = L.marker(labelPoint, { icon: labelIcon, interactive: false });
                layerGroup.addLayer(labelMarker);
            }
        }
    }

    mapLayers[groupName] = layerGroup;
    map.addLayer(layerGroup);
}

function findLargestShapeCenter(geoJsonLayer) {
    let bestBounds = null;
    let bestArea = -1;

    geoJsonLayer.eachLayer(sublayer => {
        if (typeof sublayer.getBounds !== 'function') return;
        let b;
        try { b = sublayer.getBounds(); } catch (e) { return; }
        if (!b || !b.isValid()) return;

        const sw = b.getSouthWest();
        const ne = b.getNorthEast();
        const area = Math.abs(ne.lat - sw.lat) * Math.abs(ne.lng - sw.lng);

        if (area > bestArea) {
            bestArea = area;
            bestBounds = b;
        }
    });

    if (bestBounds) return bestBounds.getCenter();

    try {
        const combined = geoJsonLayer.getBounds();
        if (combined && combined.isValid()) return combined.getCenter();
    } catch (e) {
        // no measurable content at all
    }
    return null;
}

function redrawActiveLayersInOrder(layers) {
    Object.keys(mapLayers).forEach(key => map.removeLayer(mapLayers[key]));
    mapLayers = {};

    const mapEmpty = document.getElementById('map-empty');
    const activeLayers = (layers || []).filter(l => l.active);

    if (activeLayers.length === 0) {
        mapEmpty.style.display = 'flex';
    } else {
        mapEmpty.style.display = 'none';
    }

    activeLayers.forEach(layer => renderLayerOnMap(layer));

    fitMapToActiveLayers();
}

// ---------------------------------------------------------------------------
// 8. BOUNDS FIT / LOCK
// ---------------------------------------------------------------------------
let kioskLockBoundsToData = false;

function setLockBoundsToData(enabled) {
    kioskLockBoundsToData = !!enabled;
    fitMapToActiveLayers();
}

function fitMapToActiveLayers() {
    const groups = Object.values(mapLayers);
    if (groups.length === 0) {
        map.setMaxBounds(null);
        map.setMinZoom(0);
        map.setView(KIOSK_HOME_VIEW.center, KIOSK_HOME_VIEW.zoom);
        return;
    }

    let bounds = null;
    groups.forEach(group => {
        if (typeof group.getBounds !== 'function') return;
        let groupBounds;
        try { groupBounds = group.getBounds(); } catch (e) { return; }
        if (!groupBounds || !groupBounds.isValid()) return;
        bounds = bounds ? bounds.extend(groupBounds) : groupBounds;
    });

    if (bounds && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });

        if (kioskLockBoundsToData) {
            const padded = bounds.pad(0.5);
            map.setMaxBounds(padded);
            const computedMinZoom = map.getBoundsZoom(padded, true);
            map.setMinZoom(Number.isFinite(computedMinZoom) && computedMinZoom > 0 ? computedMinZoom : 1);
        } else {
            map.setMaxBounds(null);
            map.setMinZoom(0);
        }
    } else {
        map.setMaxBounds(null);
        map.setMinZoom(0);
        map.setView(KIOSK_HOME_VIEW.center, KIOSK_HOME_VIEW.zoom);
    }
}

// ---------------------------------------------------------------------------
// 9. LIGHTBOX
// ---------------------------------------------------------------------------
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderMediaStatus(mediaBox, iconName, message, linkUrl, isError) {
    const linkHtml = linkUrl
        ? `<a href="${escHtml(linkUrl)}" target="_blank" rel="noopener">Open original link &#8599;</a>`
        : '';
    mediaBox.innerHTML = `
        <div class="media-status${isError ? ' media-status-error' : ''}">
            <span class="material-icons">${iconName}</span>
            <p>${escHtml(message)}</p>
            ${linkHtml}
        </div>`;
}

function openLightbox(item) {
    const container = document.getElementById('lightbox');
    const mediaBox = document.getElementById('lightbox-media');
    const wrapper = document.getElementById('lightbox-content-wrapper');

    document.getElementById('lightbox-title').textContent = item.place_name;
    document.getElementById('lightbox-coords').textContent = `${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}`;
    document.getElementById('lightbox-desc').textContent = item.description || 'No description provided.';
    document.getElementById('lightbox-type').textContent = MarkerIconModule.labelFor(item.media_type);

    mediaBox.innerHTML = '';
    // Reset from any previous text-only or PDF point — re-added below when needed.
    wrapper.classList.remove('no-media');
    wrapper.classList.remove('pdf-media');
    PdfViewerModule.destroy(); // free any previous PDF doc — markers can be tapped one after another without closing the lightbox in between

    if (item.media_type === 'video') {
        const embed = MediaEmbedModule.resolve('video', item.media_url);
        if (!embed) {
            renderMediaStatus(mediaBox, 'play_circle', 'This video can\u2019t be played in the kiosk.', item.media_url, true);
        } else if (embed.kind === 'file') {
            mediaBox.innerHTML = `<video src="${escHtml(embed.src)}" controls autoplay playsinline></video>`;
        } else {
            mediaBox.innerHTML = `<iframe src="${escHtml(embed.src)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
        }
    } else if (item.media_type === 'audio') {
        const embed = MediaEmbedModule.resolve('audio', item.media_url);
        if (!embed) {
            renderMediaStatus(mediaBox, 'audiotrack', 'This audio can\u2019t be played in the kiosk.', item.media_url, true);
        } else if (embed.kind === 'file') {
            mediaBox.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;width:100%;padding:0 24px;">
                    <span class="material-icons" style="font-size:3.5rem;color:#a5b4fc;margin-bottom:1rem;">audiotrack</span>
                    <audio src="${escHtml(embed.src)}" controls autoplay></audio>
                </div>`;
        } else {
            mediaBox.innerHTML = `<iframe src="${escHtml(embed.src)}" frameborder="0" allow="autoplay"></iframe>`;
        }
    } else if (item.media_type === 'image') {
        mediaBox.innerHTML = `<img src="${escHtml(item.media_url)}" alt="${escHtml(item.place_name)}">`;
    } else if (item.media_type === 'pdf') {
        const embed = MediaEmbedModule.resolve('pdf', item.media_url);
        if (!embed) {
            renderMediaStatus(mediaBox, 'picture_as_pdf', 'This PDF can\u2019t be displayed in the kiosk.', item.media_url, true);
        } else {
            wrapper.classList.add('pdf-media'); // gives the PDF more vertical room than the 16:9 video/image box
            const pdfUrl = embed.src;
            PdfViewerModule.open(mediaBox, pdfUrl).then(result => {
                if (result === 'stale') return; // a newer item replaced this one before the load finished
                if (!result) {
                    wrapper.classList.remove('pdf-media');
                    renderMediaStatus(mediaBox, 'picture_as_pdf', 'This PDF can\u2019t be displayed in the kiosk.', pdfUrl, true);
                    return;
                }
                const openBtn = document.createElement('a');
                openBtn.className = 'media-open-new-tab';
                openBtn.href = pdfUrl;
                openBtn.target = '_blank';
                openBtn.rel = 'noopener';
                openBtn.title = 'Open full PDF in a new tab';
                openBtn.innerHTML = '<span class="material-icons">open_in_new</span>';
                mediaBox.appendChild(openBtn);
            });
        }
    } else if (item.media_type === 'streetview') {
        const embed = MediaEmbedModule.resolve('streetview', item.media_url);
        if (!embed) {
            renderMediaStatus(mediaBox, 'streetview', 'This Street View link isn\u2019t valid.', item.media_url, true);
        } else {
            mediaBox.innerHTML = `<iframe src="${escHtml(embed.src)}" frameborder="0" style="border:0" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
        }
    } else {
        // Text-only point — no media to show, so collapse the media box
        // entirely rather than rendering an empty placeholder area.
        wrapper.classList.add('no-media');
    }

    container.classList.remove('mm-hidden');
    setTimeout(() => {
        container.classList.remove('mm-opacity-0');
        wrapper.classList.remove('mm-scale-95');
    }, 10);

    handleUserActivity();
}

function closeLightbox() {
    const container = document.getElementById('lightbox');
    const wrapper = document.getElementById('lightbox-content-wrapper');
    if (container.classList.contains('mm-hidden')) return;
    container.classList.add('mm-opacity-0');
    wrapper.classList.add('mm-scale-95');
    setTimeout(() => {
        container.classList.add('mm-hidden');
        PdfViewerModule.destroy();
        wrapper.classList.remove('pdf-media');
        document.getElementById('lightbox-media').innerHTML = '';
    }, 300);
}

document.getElementById('close-lightbox').addEventListener('click', closeLightbox);
document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
});

// ---------------------------------------------------------------------------
// 10. ACTIVITY CAPTURE (drives the idle-timer heartbeat)
// ---------------------------------------------------------------------------
['click', 'keydown', 'mousedown', 'touchstart', 'touchmove'].forEach(ev =>
    window.addEventListener(ev, handleUserActivity, { passive: true, capture: true })
);

let mouseMoveTO;
window.addEventListener('mousemove', () => {
    if (!mouseMoveTO) mouseMoveTO = setTimeout(() => {
        handleUserActivity(); mouseMoveTO = null;
    }, 200);
}, { passive: true, capture: true });

// ---------------------------------------------------------------------------
// 11. SERVICE WORKER + BOOT
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err =>
        console.warn('SW registration failed:', err)
    );
}

async function bootDemoKiosk() {
    try {
        const settings = await getKioskSettings();
        setIdleTimeSeconds(settings.idle_time_seconds || 90);

        const layers = await getAllLayers();

        initMap();
        setLockBoundsToData(!!settings.lock_bounds_to_data);
        redrawActiveLayersInOrder(layers);
        renderLoadErrorBanner();
        startKioskHeartbeat();
    } catch (err) {
        console.error('Boot error:', err);
        showFatalLoadError(err);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    bootDemoKiosk();
});
