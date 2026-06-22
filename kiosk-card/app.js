// ---------------------------------------------------------------------------
// LexiPic Kiosk — DEMO VERSION
// Loads word sets directly from ./lexipic-kiosk-data/ via fetch.
// No URL mode, no USB mode, no PIN, no setup screen.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 0. STATE
// ---------------------------------------------------------------------------

let kioskAutoplay   = false;
let KIOSK_IDLE_MS   = 90000;
let lastActivity    = Date.now();
let idleInterval    = null;
let currentEntries  = [];
let currentSetSlug  = null;
let currentCardIdx  = 0;
let cardRenderToken = 0;
let lastLoadErrors  = [];

// ---------------------------------------------------------------------------
// 1. DATA — fetch from local lexipic-kiosk-data/ directory
// ---------------------------------------------------------------------------

const DATA_DIR = './lexipic-kiosk-data/';

async function fetchJson(filename) {
    const res = await fetch(DATA_DIR + filename);
    if (!res.ok) throw new Error(`Could not load ${filename} (${res.status})`);
    return res.json();
}

const LANG_LABELS = {
    bpm: 'Bishnupriya Manipuri (ইমার ঠার)',
    as:  'Assamese (অসমীয়া)',
    bn:  'Bengali (বাংলা)',
};

async function getKioskSettings() {
    const config = await fetchJson('settings.json');
    return config.kiosk || { idle_time_seconds: 90, autoplay_audio: false };
}

async function getAllSets() {
    const config = await fetchJson('settings.json');
    const layers = Array.isArray(config.layers) ? config.layers : [];
    const sets   = [];
    const errors = [];

    for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        if (!layer.enabled) continue;
        const slug = layer.slug;
        if (!slug) continue;

        try {
            const set  = await fetchJson(slug + '.json');
            const meta = set.set || set;
            const lang = meta.language || 'bpm';
            sets.push({
                slug,
                name:          layer.name || meta.name || slug,
                group:         layer.group || '',
                language:      lang,
                languageLabel: meta.languageLabel || LANG_LABELS[lang] || lang.toUpperCase(),
                entryCount:    Array.isArray(set.entries) ? set.entries.length : 0,
                active:        true,
                order:         i,
            });
        } catch (err) {
            errors.push({ slug, name: layer.name || slug, reason: err.message });
        }
    }

    lastLoadErrors = errors;
    return sets;
}

async function getSetWithEntries(slug) {
    const raw  = await fetchJson(slug + '.json');
    const meta = raw.set || raw;
    const lang = meta.language || 'bpm';

    const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
    const entries = rawEntries.map((e, i) => ({
        id:          e.id ?? i,
        word_script: e.word_script || e.heritage || '',
        word_roman:  e.word_roman  || e.transliteration || '',
        description: e.description || '',
        image:       e.image || '',
        audio:       e.audio || '',
    }));

    const config = await fetchJson('settings.json');
    const layerOverride = (config.layers || []).find(l => l.slug === slug);

    return {
        slug,
        name:          (layerOverride && layerOverride.name) || meta.name || slug,
        language:      lang,
        languageLabel: meta.languageLabel || LANG_LABELS[lang] || lang.toUpperCase(),
        entries,
    };
}

// ---------------------------------------------------------------------------
// 2. IDLE TIMER
// ---------------------------------------------------------------------------

function setIdleTimeSeconds(s) { KIOSK_IDLE_MS = Math.max(5, Math.round(s)) * 1000; }
function setAutoplayAudio(b)   { kioskAutoplay = !!b; }
function handleUserActivity()  { lastActivity = Date.now(); }

function startKioskHeartbeat() {
    if (idleInterval) clearInterval(idleInterval);
    idleInterval = setInterval(() => {
        if (Date.now() - lastActivity >= KIOSK_IDLE_MS) {
            returnToSetsScreen();
            lastActivity = Date.now();
        }
    }, 1000);
}

// ---------------------------------------------------------------------------
// 3. SCREEN NAVIGATION
// ---------------------------------------------------------------------------

function showSetsScreen() {
    document.getElementById('screen-sets').classList.remove('lp-screen-hidden');
    document.getElementById('screen-archive').classList.remove('lp-screen-active');
    document.getElementById('back-to-sets-btn').style.display = 'none';
    currentSetSlug = null;
}

function showArchiveScreen() {
    document.getElementById('screen-sets').classList.add('lp-screen-hidden');
    document.getElementById('screen-archive').classList.add('lp-screen-active');
    document.getElementById('back-to-sets-btn').style.display = 'inline-flex';
}

function returnToSetsScreen() {
    if (currentSetSlug !== null) showSetsScreen();
}

document.getElementById('back-to-sets-btn').addEventListener('click', () => {
    handleUserActivity();
    showSetsScreen();
});

// ---------------------------------------------------------------------------
// 4. SETS GRID
// ---------------------------------------------------------------------------

function renderSetsGrid(sets) {
    const grid    = document.getElementById('sets-grid');
    const emptyEl = document.getElementById('sets-empty');
    const active  = sets.filter(s => s.active !== false);

    if (active.length === 0) {
        grid.innerHTML = '';
        emptyEl.style.display = 'flex';
        return;
    }
    emptyEl.style.display = 'none';

    const groupOrder = [];
    const seen = {};
    active.forEach(s => {
        const g = s.group || '';
        if (!seen[g]) { seen[g] = true; groupOrder.push(g); }
    });

    let html = '';
    groupOrder.forEach(group => {
        const groupSets = active.filter(s => (s.group || '') === group);
        if (group) html += `<div class="group-header">${escHtml(group)}</div>`;
        groupSets.forEach(set => {
            const count = typeof set.entryCount === 'number'
                ? set.entryCount
                : (Array.isArray(set.entries) ? set.entries.length : 0);
            html += `
            <div class="lp-set-tile" data-slug="${escHtml(set.slug)}" role="button" tabindex="0" aria-label="Open ${escHtml(set.name)}">
		      <div class="lp-set-tile-header">
                <div class="lp-set-tile-icon"><span class="material-icons">menu_book</span></div>
                <div class="lp-set-tile-info">
                    <div class="lp-set-tile-name">${escHtml(set.name)}</div>
                    <div class="lp-set-tile-meta"><span class="material-icons">translate</span>${escHtml(set.languageLabel || set.language || '')}</div>
                </div>
		      </div>
              <div class="lp-set-tile-count"><span class="material-icons">collections_bookmark</span>${count} word${count === 1 ? '' : 's'}</div>
            </div>`;
        });
    });

    grid.innerHTML = html;

    grid.querySelectorAll('.lp-set-tile').forEach(tile => {
        const open = () => { handleUserActivity(); openSetArchive(tile.dataset.slug); };
        tile.addEventListener('click', open);
        tile.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(); });
    });
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
            <strong>${lastLoadErrors.length} set${lastLoadErrors.length === 1 ? '' : 's'} could not be loaded:</strong>
            ${lastLoadErrors.map(e => `<div>${escHtml(e.name)} — ${escHtml(e.reason)}</div>`).join('')}
        </div>
        <button type="button" aria-label="Dismiss">&times;</button>
    `;
    banner.querySelector('button').addEventListener('click', () => banner.remove());
    document.getElementById('screen-sets').prepend(banner);
}

async function openSetArchive(slug) {
    document.getElementById('archive-set-title-text').textContent = 'Loading…';
    document.getElementById('archive-set-meta').textContent  = '';
    document.getElementById('lp-archive-slider').innerHTML   =
        '<div style="display:flex;align-items:center;justify-content:center;height:100%;"><div class="spinner"></div></div>';
    showArchiveScreen();

    try {
        const set = await getSetWithEntries(slug);
        if (!set) throw new Error('Set not found');

        currentSetSlug = slug;
        currentCardIdx = 0;

        document.getElementById('archive-set-title-text').textContent = set.name;
        document.getElementById('archive-set-meta').textContent  =
            `${set.languageLabel || set.language || ''} · ${set.entries.length} word${set.entries.length === 1 ? '' : 's'}`;

        renderCards(set.entries);
        if (kioskAutoplay && set.entries[0]) playAudio(set.entries[0].audio);
    } catch (err) {
        document.getElementById('archive-set-title-text').textContent = 'Could not load set';
        document.getElementById('archive-set-meta').textContent  = err.message;
        document.getElementById('lp-archive-slider').innerHTML   = '';
    }
}

// ---------------------------------------------------------------------------
// 5. CARD SLIDER
// ---------------------------------------------------------------------------

const FIRST_BATCH = 6;
const CHUNK_SIZE  = 10;

function buildCardHtml(e, i) {
    const label = e.word_script || e.word_roman || '';
    const sub   = (e.word_script && e.word_roman)
        ? `<span class="lp-roman-display">${escHtml(e.word_roman)}</span>` : '';
    const desc  = e.description
        ? `<p class="lp-card-desc">${escHtml(e.description)}</p>` : '';
    const img   = e.image
        ? `<img src="${escHtml(e.image)}" alt="${escHtml(label)}" loading="lazy">`
        : `<div class="lp-card-no-img"><span class="material-icons" style="font-size:48px;">image</span><span style="font-size:12px;">No image</span></div>`;

    return `
    <div class="lp-card-slot">
        <div class="lp-card" role="listitem" data-index="${i}">
            <div class="lp-card-media">${img}</div>
            <div class="lp-card-body">
                <div class="lp-card-title">
                    <span class="lp-script-display">${escHtml(label)}</span>
                    ${sub}
                </div>
                ${desc}
                ${e.audio ? `<div class="lp-card-actions">
                    <button class="lp-play-btn" data-audio="${escHtml(e.audio)}" aria-label="Play audio for ${escHtml(label)}">
                        <span class="material-icons" style="font-size:18px;">volume_up</span> Play
                    </button></div>` : ''}
            </div>
        </div>
    </div>`;
}

function wireCards(container) {
    container.querySelectorAll('.lp-play-btn:not([data-wired])').forEach(btn => {
        btn.dataset.wired = '1';
        btn.addEventListener('click', e => {
            e.stopPropagation();
            handleUserActivity();
            playAudio(btn.dataset.audio);
        });
    });
}

function renderCards(entries) {
    const slider   = document.getElementById('lp-archive-slider');
    const myToken  = ++cardRenderToken;
    currentEntries = entries || [];
    slider.innerHTML = '';

    if (!entries || entries.length === 0) {
        updateNavButtons();
        updateProgressUI(0, 0);
        return;
    }

    const appendRange = (start, end) => {
        slider.insertAdjacentHTML('beforeend',
            entries.slice(start, end).map((e, idx) => buildCardHtml(e, start + idx)).join('')
        );
        wireCards(slider);
    };

    appendRange(0, Math.min(FIRST_BATCH, entries.length));
    updateNavButtons();
    updateProgressUI(1, entries.length);

    if (entries.length > FIRST_BATCH) {
        let next = FIRST_BATCH;
        const chunk = () => {
            if (myToken !== cardRenderToken || next >= entries.length) return;
            appendRange(next, Math.min(next + CHUNK_SIZE, entries.length));
            next += CHUNK_SIZE;
            updateNavButtons();
            if (next < entries.length) scheduleIdle(chunk);
        };
        scheduleIdle(chunk);
    }
}

function scheduleIdle(fn) {
    typeof requestIdleCallback === 'function'
        ? requestIdleCallback(fn, { timeout: 500 })
        : setTimeout(fn, 32);
}

function playAudio(src) {
    if (!src) return;
    new Audio(src).play().catch(() => {});
}

function updateProgressUI(current, total) {
    const el = document.getElementById('archive-progress');
    if (el) el.textContent = total > 0 ? `${current} / ${total}` : '';
}

let scrollSettleTO = null;

function updateProgressFromScroll(total) {
    const slider = document.getElementById('lp-archive-slider');
    if (!slider || total === 0) return;
    const slot = slider.querySelector('.lp-card-slot');
    if (!slot || !slot.offsetWidth) return;
    const idx = Math.min(Math.max(Math.round(slider.scrollLeft / slot.offsetWidth), 0), total - 1);
    if (idx !== currentCardIdx) {
        currentCardIdx = idx;
        updateProgressUI(currentCardIdx + 1, total);
    }
    clearTimeout(scrollSettleTO);
    scrollSettleTO = setTimeout(() => {
        if (kioskAutoplay && currentEntries[currentCardIdx]) {
            playAudio(currentEntries[currentCardIdx].audio);
        }
    }, 150);
}

function cardWidth() {
    const slider = document.getElementById('lp-archive-slider');
    const slot   = slider && slider.querySelector('.lp-card-slot');
    return slot ? slot.offsetWidth : 0;
}

document.getElementById('lp-next-btn').addEventListener('click', () => {
    handleUserActivity();
    document.getElementById('lp-archive-slider').scrollBy({ left: cardWidth(), behavior: 'smooth' });
});
document.getElementById('lp-prev-btn').addEventListener('click', () => {
    handleUserActivity();
    document.getElementById('lp-archive-slider').scrollBy({ left: -cardWidth(), behavior: 'smooth' });
});
document.getElementById('lp-archive-slider').addEventListener('scroll', () => {
    updateNavButtons();
    updateProgressFromScroll(currentEntries.length);
});

function updateNavButtons() {
    const slider = document.getElementById('lp-archive-slider');
    if (!slider) return;
    const atStart = slider.scrollLeft <= 5;
    const atEnd   = slider.scrollLeft >= slider.scrollWidth - slider.clientWidth - 5;
    document.getElementById('lp-prev-btn').style.display = atStart ? 'none' : 'flex';
    document.getElementById('lp-next-btn').style.display = atEnd   ? 'none' : 'flex';
}

// ---------------------------------------------------------------------------
// 6. DOM HELPERS
// ---------------------------------------------------------------------------

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// 7. ACTIVITY CAPTURE
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
// 8. SERVICE WORKER + BOOT
// ---------------------------------------------------------------------------

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err =>
        console.warn('SW registration failed:', err)
    );
}

async function boot() {
    const settings = await getKioskSettings().catch(() => ({ idle_time_seconds: 90, autoplay_audio: false }));
    setIdleTimeSeconds(settings.idle_time_seconds || 90);
    setAutoplayAudio(settings.autoplay_audio || false);

    const sets = await getAllSets().catch(() => []);
    renderSetsGrid(sets);
    renderLoadErrorBanner();
    startKioskHeartbeat();
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// ---------------------------------------------------------------------------
// 9. RIGHT-CLICK & LONG-PRESS SUPPRESSION
// ---------------------------------------------------------------------------

document.addEventListener('contextmenu', e => {
    if (e.target.tagName !== 'IFRAME') e.preventDefault();
}, { capture: true });

(function () {
    let longPressTimer = null;
    function clearLongPress() {
        if (longPressTimer !== null) { clearTimeout(longPressTimer); longPressTimer = null; }
    }
    document.addEventListener('touchstart', e => {
        if (e.target.tagName === 'IFRAME') return;
        clearLongPress();
        longPressTimer = setTimeout(() => { e.preventDefault(); longPressTimer = null; }, 500);
    }, { passive: false, capture: true });
    document.addEventListener('touchend',    clearLongPress, { passive: true, capture: true });
    document.addEventListener('touchmove',   clearLongPress, { passive: true, capture: true });
    document.addEventListener('touchcancel', clearLongPress, { passive: true, capture: true });
})();
