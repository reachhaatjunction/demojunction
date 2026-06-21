'use strict';

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

async function readJsonFile(filename) {
    const res = await fetch(DATA_DIR + filename, { cache: 'no-store' });
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

async function resolveMediaUrl(value) {
    if (!value) return '';
    if (value.startsWith('data:') || value.startsWith('http') || value.startsWith('blob:')) return value;
    return DATA_DIR + value;
}

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

async function getKioskSettings() {
    const config = await readJsonFile('settings.json');
    return config.kiosk || { idle_time_seconds: 90, lock_bounds_to_data: false };
}

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
                cluster: entry.cluster !== false,
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

function showFatalLoadError(err) {
    initMap();
    document.getElementById('map-empty-icon').textContent = 'cloud_off';
    document.getElementById('map-empty-title').textContent = "Couldn't load demo data";
    document.getElementById('map-empty-msg').textContent =
        `Check that mediamap-kiosk-data/settings.json exists and is valid JSON. (${err.message || 'Unknown error'})`;
    document.getElementById('map-empty').style.display = 'flex';
}

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
            closeLightbox();
            fitMapToActiveLayers();
            lastActivityTime = Date.now();
        }
    }, 1000);
}

function stopKioskHeartbeat() {
    if (idleInterval) { clearInterval(idleInterval); idleInterval = null; }
}

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

function renderLayerOnMap(layer) {
    const groupName = layer.groupName;
    if (mapLayers[groupName]) {
        map.removeLayer(mapLayers[groupName]);
    }

    const layerGroup = L.featureGroup();
    const points = layer.data || [];

    const pointsTarget = (layer.cluster !== false)
        ? L.markerClusterGroup({
            showCoverageOnHover: false,
            zoomToBoundsOnClick: true,
            spiderfyOnMaxZoom: true,
            chunkedLoading: true,
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
    wrapper.classList.remove('no-media');

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
            mediaBox.innerHTML = `
                <iframe src="${escHtml(embed.src)}" frameborder="0" style="border:0;background:#fff;"></iframe>
                <a class="media-open-new-tab" href="${escHtml(embed.src)}" target="_blank" rel="noopener" title="Open full PDF in a new tab">
                    <span class="material-icons">open_in_new</span>
                </a>`;
        }
    } else if (item.media_type === 'streetview') {
        const embed = MediaEmbedModule.resolve('streetview', item.media_url);
        if (!embed) {
            renderMediaStatus(mediaBox, 'streetview', 'This Street View link isn\u2019t valid.', item.media_url, true);
        } else {
            mediaBox.innerHTML = `<iframe src="${escHtml(embed.src)}" frameborder="0" style="border:0" allowfullscreen loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
        }
    } else {
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
        document.getElementById('lightbox-media').innerHTML = '';
    }, 300);
}

document.getElementById('close-lightbox').addEventListener('click', closeLightbox);
document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
});

['click', 'keydown', 'mousedown', 'touchstart', 'touchmove'].forEach(ev =>
    window.addEventListener(ev, handleUserActivity, { passive: true, capture: true })
);

let mouseMoveTO;
window.addEventListener('mousemove', () => {
    if (!mouseMoveTO) mouseMoveTO = setTimeout(() => {
        handleUserActivity(); mouseMoveTO = null;
    }, 200);
}, { passive: true, capture: true });

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
