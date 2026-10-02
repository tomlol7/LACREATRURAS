/* ==========================================================================
   URFONT // app.js
   Zero-backend font directory. Vanilla JS, no build step.
   Data source: ./fonts.json  ->  [{ id, name, author, category, url, css_weight }]
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- config ---------- */
  const DATA_URL = 'fonts.json';
  const DEFAULT_PREVIEW = 'The quick brown fox jumps over the lazy dog 0123456789';
  const FALLBACK_STACK = 'monospace';
  const CRT_KEY = 'urfont:crt';
  const LINE_HEIGHT = 1.2;

  /* ---------- DOM refs ---------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $('grid'),
    empty: $('empty'),
    search: $('search'),
    preview: $('preview-text'),
    size: $('preview-size'),
    sizeOut: $('preview-size-out'),
    filters: $('filters'),
    status: $('status'),
    crtToggle: $('crt-toggle'),
    modal: $('banner-modal'),
    bannerClose: $('banner-close'),
    bannerCancel: $('banner-cancel'),
    bannerFont: $('banner-font'),
    bannerText: $('banner-text'),
    bannerSize: $('banner-size'),
    bannerSizeOut: $('banner-size-out'),
    bannerDim: $('banner-dim'),
    bannerGlow: $('banner-glow'),
    bannerCanvas: $('banner-canvas'),
    bannerNote: $('banner-note'),
    bannerDownload: $('banner-download'),
  };

  /* ---------- state ---------- */
  const state = {
    fonts: [],
    byId: new Map(),
    cards: new Map(), // id -> { font, el, preview, haystack }
    query: '',
    category: 'all',
  };

  /* ---------- tiny helpers ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids) if (kid) el.append(kid);
    return el;
  }

  // Anything from fonts.json ends up in CSS or the DOM, so sanitize it.
  const safeId = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const cssStr = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const normWeight = (w) => {
    const s = String(w ?? '400').trim();
    return /^(normal|bold|\d{1,4}(\s+\d{1,4})?)$/i.test(s) ? s.toLowerCase() : '400';
  };
  const firstWeight = (w) => {
    const first = String(w).split(/\s+/)[0];
    return first === 'normal' ? '400' : first === 'bold' ? '700' : first;
  };
  // "/fonts/x.woff2" -> "fonts/x.woff2" so it resolves next to index.html
  // (works at a domain root, in a subfolder, and on GitHub Pages project sites).
  const resolveUrl = (u) => (/^(https?:)?\/\//i.test(u) ? u : u.replace(/^\/+/, ''));
  const fileName = (u) => u.split(/[?#]/)[0].split('/').pop() || u;
  const currentText = () => els.preview.value.trim() ? els.preview.value : DEFAULT_PREVIEW;

  /* ---------- data ---------- */
  async function loadFonts() {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${DATA_URL}`);
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error(`${DATA_URL} must be a JSON array`);

    const fonts = [];
    const seen = new Set();
    raw.forEach((item, i) => {
      const id = safeId(item && item.id);
      if (!id || !item.name || !item.url) {
        console.warn(`[urfont] skipped entry #${i}: needs id, name and url`, item);
        return;
      }
      if (seen.has(id)) {
        console.warn(`[urfont] skipped entry #${i}: duplicate id "${id}"`);
        return;
      }
      seen.add(id);
      fonts.push({
        id,
        name: String(item.name),
        author: String(item.author || 'unknown'),
        category: String(item.category || 'uncategorized').toLowerCase(),
        url: String(item.url),
        weight: normWeight(item.css_weight),
        family: `urfont-${id}`,          // internal family name, can never collide
        resolved: resolveUrl(String(item.url)),
      });
    });
    return fonts;
  }

  /* ---------- @font-face injection ---------- */
  function injectFontFaces(fonts) {
    const css = fonts.map((f) =>
      `@font-face{font-family:"${cssStr(f.family)}";` +
      `src:url("${cssStr(f.resolved)}") format("woff2");` +
      `font-weight:${f.weight};font-style:normal;font-display:swap;}`
    ).join('\n');
    const style = document.createElement('style');
    style.id = 'urfont-faces';
    style.textContent = css;
    document.head.append(style);
  }

  // The snippet a dev pastes into their own project (uses the real font name + the url from fonts.json).
  function buildSnippet(f) {
    return [
      '@font-face {',
      `  font-family: "${cssStr(f.name)}";`,
      `  src: url("${cssStr(f.url)}") format("woff2");`,
      `  font-weight: ${f.weight};`,
      '  font-style: normal;',
      '  font-display: swap;',
      '}',
      '',
      '/* usage */',
      '.your-selector {',
      `  font-family: "${cssStr(f.name)}", ${FALLBACK_STACK};`,
      '}',
    ].join('\n');
  }

  /* ---------- cards ---------- */
  function setBadge(badge, stateName, font) {
    badge.dataset.state = stateName;
    badge.textContent = stateName === 'ok' ? 'READY' : stateName === 'missing' ? 'NO FILE' : 'LOADING';
    if (stateName === 'missing') badge.title = `Could not load ${font.url}. Drop the .woff2 there.`;
  }

  function checkFontLoaded(font, badge) {
    const probe = `${firstWeight(font.weight)} 16px "${font.family}"`;
    document.fonts.load(probe, 'A')
      .then((faces) => setBadge(badge, faces.length ? 'ok' : 'missing', font))
      .catch(() => setBadge(badge, 'missing', font));
  }

  function createCard(f) {
    const badge = h('span', { class: 'badge', 'data-state': 'loading', text: 'LOADING' });
    const preview = h('p', { class: 'preview', text: currentText() });
    preview.style.fontFamily = `"${f.family}", ${FALLBACK_STACK}`;
    preview.style.fontWeight = firstWeight(f.weight);

    const row = (k, v) => h('div', {}, h('dt', { text: k }), h('dd', { text: v }));

    const el = h('article', { class: 'card', 'data-id': f.id },
      h('header', { class: 'card-bar' },
        h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        h('span', { class: 'card-file', title: f.url, text: fileName(f.url) }),
        badge),
      h('div', { class: 'card-body' },
        h('h2', { class: 'card-name', text: f.name }),
        preview,
        h('dl', { class: 'meta' }, row('AUTHOR', f.author), row('CATEGORY', f.category), row('WEIGHT', f.weight))),
      h('footer', { class: 'card-actions' },
        h('button', { type: 'button', class: 'btn', 'data-action': 'copy', text: '$ copy css' }),
        h('button', { type: 'button', class: 'btn', 'data-action': 'banner', text: 'png banner' })));

    checkFontLoaded(f, badge);

    state.cards.set(f.id, {
      font: f,
      el,
      preview,
      haystack: [f.name, f.author, f.category, f.id].join(' ').toLowerCase(),
    });
    return el;
  }

  function renderCards(fonts) {
    const frag = document.createDocumentFragment();
    for (const f of fonts) frag.append(createCard(f));
    els.grid.replaceChildren(frag);
  }

  function renderFilters(fonts) {
    const cats = ['all', ...[...new Set(fonts.map((f) => f.category))].sort()];
    els.filters.replaceChildren(...cats.map((c) =>
      h('button', {
        type: 'button',
        class: 'chip',
        'data-cat': c,
        'aria-pressed': String(c === state.category),
        text: c.toUpperCase(),
      })));
  }

  /* ---------- search + filter (toggles `hidden`, never re-renders) ---------- */
  function showMessage(text, kind) {
    els.empty.textContent = text;
    els.empty.dataset.kind = kind || '';
    els.empty.hidden = false;
  }

  function applyFilters() {
    const terms = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const { font, el, haystack } of state.cards.values()) {
      const match =
        (state.category === 'all' || font.category === state.category) &&
        terms.every((t) => haystack.includes(t));
      el.hidden = !match;
      if (match) shown++;
    }
    els.status.textContent = `> ${shown}/${state.fonts.length} fonts`;
    if (state.fonts.length && shown === 0) {
      showMessage(`> no matches${state.query.trim() ? ` for "${state.query.trim()}"` : ''}. try a shorter query or switch category.`);
    } else if (state.fonts.length) {
      els.empty.hidden = true;
    }
  }

  /* ---------- live preview ---------- */
  let previewQueued = false;
  function updatePreviews() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      const text = currentText();
      for (const c of state.cards.values()) c.preview.textContent = text;
    });
  }

  /* ---------- clipboard ---------- */
  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) { /* fall through to legacy path */ }
    }
    const ta = h('textarea', { readonly: '', 'aria-hidden': 'true' });
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* ignore */ }
    ta.remove();
    return ok;
  }

  function flash(btn, label, ms = 1400) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = label;
    btn.dataset.flash = 'on';
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.flash;
    }, ms);
  }

  /* ---------- CRT toggle ---------- */
  function setCrt(on, persist = true) {
    document.body.classList.toggle('crt', on);
    els.crtToggle.setAttribute('aria-pressed', String(on));
    els.crtToggle.replaceChildren(h('kbd', { text: 'T' }), ` CRT scanlines: ${on ? 'ON' : 'OFF'}`);
    if (persist) {
      try { localStorage.setItem(CRT_KEY, on ? '1' : '0'); } catch (_) { /* storage blocked */ }
    }
  }
  function initCrt() {
    let on = true;
    try { on = localStorage.getItem(CRT_KEY) !== '0'; } catch (_) { /* default on */ }
    setCrt(on, false);
  }
  const toggleCrt = () => setCrt(!document.body.classList.contains('crt'));

  /* ---------- PNG banner generator ---------- */
  let drawToken = 0;
  let drawQueued = false;

  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; drawBanner(); });
  }

  function setNote(text, kind) {
    els.bannerNote.textContent = text;
    els.bannerNote.dataset.state = kind || '';
  }

  function populateBannerFonts(fonts) {
    els.bannerFont.replaceChildren(...fonts.map((f) => h('option', { value: f.id, text: f.name })));
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    for (const para of text.split(/\r?\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(''); continue; }
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width <= maxW) { line = test; continue; }
        if (line) { out.push(line); line = ''; }
        if (ctx.measureText(word).width <= maxW) { line = word; continue; }
        // single word wider than the canvas: hard-break by character
        let chunk = '';
        for (const ch of word) {
          if (chunk && ctx.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      }
      out.push(line);
    }
    return out;
  }

  // Resolves true when a frame was painted, false if a newer draw superseded this one.
  async function drawBanner() {
    const token = ++drawToken;
    const f = state.byId.get(els.bannerFont.value);
    if (!f) return false;

    const text = els.bannerText.value.trim() || f.name;
    const [W, H] = els.bannerDim.value.split('x').map(Number);
    const weight = firstWeight(f.weight);

    // Canvas can only use a webfont once it has actually loaded.
    let faceOk = true;
    try {
      faceOk = (await document.fonts.load(`${weight} 64px "${f.family}"`, text)).length > 0;
    } catch (_) {
      faceOk = false;
    }
    if (token !== drawToken) return false;

    const canvas = els.bannerCanvas;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext('2d');
    const neon = getComputedStyle(document.documentElement).getPropertyValue('--neon').trim() || '#00ff41';

    // 1. black background
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // 2. fit text: wrap, then shrink until it fits the canvas
    const pad = Math.round(Math.min(W, H) * 0.08);
    const maxW = W - pad * 2;
    const maxH = H - pad * 2;
    let px = Math.round(Number(els.bannerSize.value) * (W / 1200));
    const minPx = 12;
    let lines;
    for (;;) {
      ctx.font = `${weight} ${px}px "${f.family}", ${FALLBACK_STACK}`;
      lines = wrapText(ctx, text, maxW);
      if (lines.length * px * LINE_HEIGHT <= maxH || px <= minPx) break;
      px = Math.max(minPx, Math.floor(px * 0.92));
    }

    // 3. neon green text
    const lh = px * LINE_HEIGHT;
    const top = (H - lines.length * lh) / 2 + lh / 2;
    ctx.fillStyle = neon;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (els.bannerGlow.checked) {
      ctx.shadowColor = neon;
      ctx.shadowBlur = Math.max(6, px * 0.18);
    }
    lines.forEach((line, i) => ctx.fillText(line, W / 2, top + i * lh));
    ctx.restore();

    setNote(
      faceOk
        ? `> ${f.name} @ ${px}px // ${W}x${H}`
        : `> font file not found (${f.url}). Drawing with monospace fallback.`,
      faceOk ? '' : 'warn'
    );
    return true;
  }

  async function downloadBanner() {
    let painted = false;
    for (let i = 0; i < 3 && !painted; i++) painted = await drawBanner();
    const f = state.byId.get(els.bannerFont.value);
    if (!painted || !f) return;

    els.bannerCanvas.toBlob((blob) => {
      if (!blob) { setNote('> export failed. Try a smaller canvas.', 'warn'); return; }
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `urfont-${f.id}-banner.png` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  function openBanner(id) {
    const f = state.byId.get(id);
    if (!f) return;
    els.bannerFont.value = id;
    els.bannerText.value = els.preview.value.trim() || f.name;
    if (typeof els.modal.showModal === 'function') els.modal.showModal();
    else els.modal.setAttribute('open', '');
    scheduleDraw();
  }

  const closeBanner = () => (els.modal.close ? els.modal.close() : els.modal.removeAttribute('open'));

  /* ---------- event wiring ---------- */
  function bindUi() {
    // global preview: every card updates as you type
    els.preview.addEventListener('input', updatePreviews);

    els.size.addEventListener('input', () => {
      const px = `${els.size.value}px`;
      els.grid.style.setProperty('--preview-size', px);
      els.sizeOut.textContent = px;
    });

    // search + category filters
    els.search.addEventListener('input', () => { state.query = els.search.value; applyFilters(); });
    els.filters.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.category = chip.dataset.cat;
      els.filters.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      applyFilters();
    });

    // card buttons (delegated)
    els.grid.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const entry = state.cards.get(btn.closest('.card').dataset.id);
      if (!entry) return;
      if (btn.dataset.action === 'copy') {
        const ok = await copyText(buildSnippet(entry.font));
        flash(btn, ok ? 'copied!' : 'copy failed');
      } else if (btn.dataset.action === 'banner') {
        openBanner(entry.font.id);
      }
    });

    // banner modal
    for (const el of [els.bannerFont, els.bannerText, els.bannerSize, els.bannerDim, els.bannerGlow]) {
      el.addEventListener('input', scheduleDraw);
    }
    els.bannerSize.addEventListener('input', () => { els.bannerSizeOut.textContent = els.bannerSize.value; });
    els.bannerDownload.addEventListener('click', downloadBanner);
    els.bannerClose.addEventListener('click', closeBanner);
    els.bannerCancel.addEventListener('click', closeBanner);
    els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeBanner(); }); // backdrop click

    // retro hotkeys: T = CRT, / = search
    els.crtToggle.addEventListener('click', toggleCrt);
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || els.modal.open) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 't' || e.key === 'T') { e.preventDefault(); toggleCrt(); }
      else if (e.key === '/') { e.preventDefault(); els.search.focus(); els.search.select(); }
    });
  }

  /* ---------- boot ---------- */
  async function init() {
    initCrt();
    bindUi();
    try {
      const fonts = await loadFonts();
      state.fonts = fonts;
      fonts.forEach((f) => state.byId.set(f.id, f));

      if (!fonts.length) {
        els.grid.replaceChildren();
        els.status.textContent = '> 0/0 fonts';
        showMessage(`> ${DATA_URL} has no valid entries. Add { id, name, author, category, url, css_weight } objects.`);
        return;
      }

      injectFontFaces(fonts);
      renderFilters(fonts);
      renderCards(fonts);
      populateBannerFonts(fonts);
      applyFilters();
    } catch (err) {
      console.error('[urfont]', err);
      els.grid.replaceChildren();
      els.status.textContent = '> load failed';
      const onFile = location.protocol === 'file:';
      showMessage(
        `ERR: could not load ${DATA_URL}\n${err.message}\n\n` +
        (onFile
          ? 'Browsers block fetch() on file:// pages. Serve this folder over HTTP instead:\n  python3 -m http.server 8000\nthen open http://localhost:8000'
          : 'Check that fonts.json sits next to index.html and contains valid JSON.'),
        'error'
      );
    } finally {
      els.grid.setAttribute('aria-busy', 'false');
    }
  }

  init();
})();
