(function () {
  'use strict';
  const C = window.LabelCore;
  const P = window.LabelPdf;

  const SUPABASE_URL = 'https://hzagwndglwhcepsirafi.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_5rAinfDT1K9kwEQnqYwlOA_-C5tk_6h';
  const BUCKET = 'product-barcodes';
  const STAFF_DOMAIN = '@dflimporters.com';
  const STORE_KEY = 'dfl-barcodes.printers.v1';
  const MAX_LABELS = 3000;
  const DEFAULT_CAL = { dx: 0, dy: 0, sx: 100, sy: 100 };

  const layout = C.LAYOUTS.avery5160;
  const PER_PAGE = C.perPage(layout);
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const state = {
    queue: [],
    start: 1,
    previewPage: 0,
    printers: loadPrinters(),
    library: null // null = not loaded; [] = loaded, empty
  };
  let nextRowId = 1;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- Auth (same pattern as the portal's staff pages) --------------------
  async function doMicrosoftLogin() {
    $('loginError').textContent = '';
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'azure',
      options: { redirectTo: window.location.href.split('#')[0].split('?')[0], scopes: 'email' }
    });
    if (error) {
      console.error('Microsoft sign-in failed:', error);
      $('loginError').textContent = 'Could not start Microsoft sign-in. Please try again.';
    }
  }

  async function doLogout() {
    await sb.auth.signOut();
    location.reload();
  }

  let started = false;
  async function handleSession(session) {
    const email = (session && session.user && session.user.email || '').toLowerCase();
    if (!session) {
      $('loginWrap').hidden = false;
      $('app').hidden = true;
      return;
    }
    if (!email.endsWith(STAFF_DOMAIN)) {
      await sb.auth.signOut();
      $('loginError').textContent = "Your Microsoft account doesn't have access to this page.";
      $('loginWrap').hidden = false;
      $('app').hidden = true;
      return;
    }
    $('loginWrap').hidden = true;
    $('app').hidden = false;
    $('userBadge').textContent = email;
    if (!started) {
      started = true;
      loadLibrary();
    }
  }

  // ---- Printer profiles (localStorage, per browser) -----------------------
  function loadPrinters() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.profiles && s.profiles[s.active]) return s;
    } catch (e) { /* storage blocked or corrupt: fall back to defaults */ }
    return { active: 'Default', profiles: { Default: { ...DEFAULT_CAL } } };
  }

  function savePrinters() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.printers));
    } catch (e) {
      console.warn('Could not save printer profiles:', e);
    }
  }

  function cal() {
    return state.printers.profiles[state.printers.active];
  }

  function renderPrinters() {
    const sel = $('printerSel');
    sel.innerHTML = Object.keys(state.printers.profiles).sort()
      .map(n => `<option${n === state.printers.active ? ' selected' : ''}>${esc(n)}</option>`).join('');
    const c = cal();
    $('calDx').value = c.dx.toFixed(2);
    $('calDy').value = c.dy.toFixed(2);
    $('calSx').value = c.sx.toFixed(1);
    $('calSy').value = c.sy.toFixed(1);
    $('deletePrinter').disabled = Object.keys(state.printers.profiles).length < 2;
  }

  function readCalInputs() {
    const num = (id, def, lo, hi) => {
      const v = parseFloat($(id).value);
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
    };
    const c = cal();
    c.dx = num('calDx', 0, -0.5, 0.5);
    c.dy = num('calDy', 0, -0.5, 0.5);
    c.sx = num('calSx', 100, 95, 105);
    c.sy = num('calSy', 100, 95, 105);
    savePrinters();
    renderPreview();
  }

  function newPrinter() {
    const name = (prompt('Name this printer (e.g. "Front office HP"):') || '').trim();
    if (!name) return;
    if (!state.printers.profiles[name]) state.printers.profiles[name] = { ...DEFAULT_CAL };
    state.printers.active = name;
    savePrinters();
    renderPrinters();
    renderPreview();
  }

  function deletePrinter() {
    const name = state.printers.active;
    if (Object.keys(state.printers.profiles).length < 2) return;
    if (!confirm(`Delete printer profile "${name}"?`)) return;
    delete state.printers.profiles[name];
    state.printers.active = Object.keys(state.printers.profiles).sort()[0];
    savePrinters();
    renderPrinters();
    renderPreview();
  }

  // ---- Queue ---------------------------------------------------------------
  function qtyBefore(index) {
    let n = 0;
    for (let i = 0; i < index; i++) n += Math.max(0, state.queue[i].qty | 0);
    return n;
  }

  function addRow(name, upc) {
    const qty = C.remainingOnSheet(layout, state.start, qtyBefore(state.queue.length));
    state.queue.push({ id: nextRowId++, name: name || '', upc: upc || '', qty });
    renderQueue();
    const rows = $('queueBody').querySelectorAll('tr');
    const last = rows[rows.length - 1];
    if (last && !name) last.querySelector('input').focus();
  }

  function rowStatus(row) {
    const code = C.parseCode(row.upc);
    if (!code.ok) return { ok: false, html: esc(code.error) };
    const kind = code.type === 'upca' ? 'UPC-A' : 'EAN-13';
    const note = code.computed ? ` (check digit ${code.digits.slice(-1)} added)` : '';
    return { ok: true, html: `${kind} ${esc(code.digits)}${note}` };
  }

  function renderQueue() {
    const body = $('queueBody');
    if (!state.queue.length) {
      body.innerHTML = `<tr class="empty"><td colspan="5">Nothing queued. Pick a product above or add a row.</td></tr>`;
    } else {
      body.innerHTML = state.queue.map((r, i) => {
        const st = rowStatus(r);
        return `<tr data-i="${i}">
          <td><input class="in-name" type="text" value="${esc(r.name)}" placeholder="Product name" aria-label="Product name"></td>
          <td><input class="in-upc mono" type="text" inputmode="numeric" value="${esc(r.upc)}" placeholder="11 or 12 digits" aria-label="UPC">
              <div class="status ${st.ok ? 'ok' : 'bad'}">${st.html}</div></td>
          <td><input class="in-qty" type="number" min="1" max="${MAX_LABELS}" step="1" value="${r.qty}" aria-label="Quantity"></td>
          <td><button type="button" class="btn-link act-fill" title="Set qty to the labels left on this sheet">Fill sheet</button></td>
          <td><button type="button" class="btn-x act-remove" aria-label="Remove row">&times;</button></td>
        </tr>`;
      }).join('');
    }
    afterQueueChange();
  }

  function onQueueInput(e) {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const row = state.queue[+tr.dataset.i];
    if (e.target.classList.contains('in-name')) row.name = e.target.value;
    if (e.target.classList.contains('in-upc')) {
      row.upc = e.target.value;
      const st = rowStatus(row);
      const box = tr.querySelector('.status');
      box.className = 'status ' + (st.ok ? 'ok' : 'bad');
      box.innerHTML = st.html;
    }
    if (e.target.classList.contains('in-qty')) row.qty = Math.max(0, parseInt(e.target.value, 10) || 0);
    afterQueueChange();
  }

  function onQueueClick(e) {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const i = +tr.dataset.i;
    if (e.target.closest('.act-remove')) {
      state.queue.splice(i, 1);
      renderQueue();
    } else if (e.target.closest('.act-fill')) {
      state.queue[i].qty = C.remainingOnSheet(layout, state.start, qtyBefore(i));
      tr.querySelector('.in-qty').value = state.queue[i].qty;
      afterQueueChange();
    }
  }

  // Validated items ready for layout, or a list of problems.
  function buildJob() {
    const problems = [];
    const items = [];
    state.queue.forEach((r, i) => {
      const code = C.parseCode(r.upc);
      const label = r.name.trim() || `Row ${i + 1}`;
      if (!code.ok) problems.push(`${label}: ${code.error}`);
      else if (!(r.qty > 0)) problems.push(`${label}: quantity must be at least 1`);
      else items.push({ name: r.name.trim(), code, qty: r.qty });
    });
    const total = items.reduce((n, it) => n + it.qty, 0);
    if (!state.queue.length) problems.push('Add at least one product to the queue.');
    if (total > MAX_LABELS) problems.push(`That's ${total} labels; the limit is ${MAX_LABELS} per PDF.`);
    return { problems, items, total };
  }

  function afterQueueChange() {
    const job = buildJob();
    const pages = C.paginate(layout, job.items, state.start);
    const sheets = pages.length;
    $('queueSummary').textContent = job.total
      ? `${job.total} label${job.total === 1 ? '' : 's'} on ${sheets} sheet${sheets === 1 ? '' : 's'}` +
        (state.start > 1 ? `, starting at position ${state.start}` : '')
      : '';
    const blocked = job.problems.length > 0;
    $('openPdf').disabled = blocked;
    $('downloadPdf').disabled = blocked;
    $('outputErrors').innerHTML = state.queue.length && blocked
      ? job.problems.map(p => `<li>${esc(p)}</li>`).join('') : '';
    renderStartGrid();
    renderPreview();
  }

  // ---- Start position ------------------------------------------------------
  function renderStartGrid() {
    const job = buildJob();
    const firstPage = C.paginate(layout, job.items, state.start)[0] || [];
    const filled = new Set(firstPage.map(p => p.slot));
    let html = '';
    for (let s = 0; s < PER_PAGE; s++) {
      const pos = s + 1;
      const cls = pos < state.start ? 'used' : pos === state.start ? 'start' : filled.has(s) ? 'fill' : '';
      html += `<button type="button" class="${cls}" data-pos="${pos}" aria-label="Start at label ${pos}"` +
              `${pos === state.start ? ' aria-pressed="true"' : ''}>${pos}</button>`;
    }
    $('startGrid').innerHTML = html;
    $('startLabel').textContent = state.start === 1
      ? 'Full sheet: starting at label 1.'
      : `Labels 1–${state.start - 1} are skipped (already used).`;
  }

  function setStart(pos) {
    state.start = Math.min(PER_PAGE, Math.max(1, pos));
    state.previewPage = 0;
    afterQueueChange();
  }

  // ---- Preview ---------------------------------------------------------------
  function renderPreview() {
    const job = buildJob();
    const pages = C.paginate(layout, job.items, state.start);
    const count = Math.max(1, pages.length);
    state.previewPage = Math.min(state.previewPage, count - 1);
    const pageIdx = state.previewPage;
    const page = pages[pageIdx] || [];
    const c = cal();
    const { w: pw, h: ph } = layout.page;
    const { w: lw, h: lh } = layout.label;

    let sheet = '';
    for (let s = 0; s < PER_PAGE; s++) {
      const o = C.labelOrigin(layout, s);
      const used = pageIdx === 0 && s < state.start - 1;
      sheet += `<rect x="${o.x}" y="${o.y}" width="${lw}" height="${lh}" rx="0.06" class="${used ? 'pv-used' : 'pv-label'}"/>`;
    }

    const primCache = new Map();
    let content = '';
    for (const { slot, item } of page) {
      let prims = primCache.get(item);
      if (!prims) {
        try {
          prims = C.labelPrimitives(layout, item, P.measure);
        } catch (e) {
          prims = [];
        }
        primCache.set(item, prims);
      }
      const o = C.labelOrigin(layout, slot);
      content += `<g transform="translate(${o.x} ${o.y})">` + prims.map(svgPrim).join('') + '</g>';
    }

    $('preview').innerHTML =
      `<svg viewBox="0 0 ${pw} ${ph}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sheet preview, page ${pageIdx + 1}">` +
      `<rect width="${pw}" height="${ph}" class="pv-page"/>${sheet}` +
      `<g transform="translate(${c.dx} ${c.dy}) scale(${c.sx / 100} ${c.sy / 100})">${content}</g></svg>`;
    $('pageInfo').textContent = `Sheet ${pageIdx + 1} of ${count}`;
    $('prevPage').disabled = pageIdx === 0;
    $('nextPage').disabled = pageIdx >= count - 1;
  }

  function svgPrim(p) {
    if (p.t === 'rect') return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>`;
    const anchor = p.align === 'center' ? 'middle' : p.align === 'right' ? 'end' : 'start';
    return `<text x="${p.x}" y="${p.y}" font-size="${p.pt / 72}" text-anchor="${anchor}">${esc(p.text)}</text>`;
  }

  // ---- Output ----------------------------------------------------------------
  function yyyymmdd() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'labels';
  }

  function makeLabelsPdf() {
    const job = buildJob();
    if (job.problems.length) return null;
    const names = [...new Set(job.items.map(it => it.name || it.code.digits))];
    const product = names.length === 1 ? slug(names[0]) : 'mixed';
    const filename = `labels_${product}_${yyyymmdd()}.pdf`;
    const pages = C.paginate(layout, job.items, state.start);
    return { doc: P.labelsPdf(layout, pages, cal(), filename), filename };
  }

  function openPdf(doc) {
    const url = URL.createObjectURL(doc.output('blob'));
    const win = window.open(url, '_blank');
    if (!win) alert('Your browser blocked the new tab. Allow pop-ups for this site, or use Download.');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function onOpen() {
    const out = makeLabelsPdf();
    if (out) openPdf(out.doc);
  }

  function onDownload() {
    const out = makeLabelsPdf();
    if (out) out.doc.save(out.filename);
  }

  function onCalibration() {
    const doc = P.calibrationPdf(layout, cal(), state.printers.active);
    openPdf(doc);
  }

  // ---- Product library (Supabase Storage) ------------------------------------
  // Loaded once per session and kept in memory.
  async function listAll(prefix, depth) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await sb.storage.from(BUCKET)
        .list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw error;
      for (const o of data) {
        if (o.name === '.emptyFolderPlaceholder') continue;
        const path = prefix ? `${prefix}/${o.name}` : o.name;
        if (o.id === null) {
          if (depth < 3) out.push(...await listAll(path, depth + 1));
        } else {
          out.push(path);
        }
      }
      if (data.length < 1000) return out;
    }
  }

  async function loadLibrary() {
    $('libStatus').textContent = 'Loading product library…';
    try {
      const paths = await listAll('', 0);
      const files = [];
      const csvs = [];
      for (const path of paths) {
        if (/\.csv$/i.test(path)) {
          const { data, error } = await sb.storage.from(BUCKET).download(path);
          if (error) throw error;
          csvs.push({ path, text: await data.text() });
        } else {
          files.push(path);
        }
      }
      state.library = C.buildLibrary(files, csvs);
    } catch (e) {
      console.error('Library load failed:', e);
      state.library = [];
      $('libStatus').textContent = 'Could not load the product library. Manual entry still works.';
      return;
    }
    renderLibrary();
  }

  function renderLibrary() {
    const lib = state.library || [];
    const bad = lib.filter(e => e.error);
    const showBad = $('libShowBad').checked;
    $('libStatus').innerHTML = !lib.length
      ? 'The library is empty. Type products into the queue manually.'
      : `${lib.length} product${lib.length === 1 ? '' : 's'}` +
        (bad.length ? ` · <span class="bad">${bad.length} need${bad.length === 1 ? 's' : ''} attention</span>` : '');
    $('libBadToggle').hidden = !bad.length;
    $('libExport').hidden = !lib.some(e => !e.error);

    const terms = $('libSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
    let list = showBad ? bad : lib;
    if (terms.length) {
      list = list.filter(e => {
        const hay = `${e.name} ${e.upc} ${e.code.ok ? e.code.digits : ''}`.toLowerCase();
        return terms.every(t => hay.includes(t));
      });
    } else if (!showBad) {
      list = [];
    }
    $('libResults').innerHTML = list.slice(0, 50).map((e, i) => {
      const idx = lib.indexOf(e);
      return e.error
        ? `<li class="lib-bad"><div><b>${esc(e.name || '(no name)')}</b><span class="mono">${esc(e.upc || '—')}</span></div>` +
          `<div class="why">${esc(e.error)} · <span class="mono">${esc(e.source)}</span></div></li>`
        : `<li><button type="button" data-lib="${idx}"><b>${esc(e.name || '(no name)')}</b>` +
          `<span class="mono">${esc(e.code.digits)}</span><span class="add">Add</span></button></li>`;
    }).join('') + (list.length > 50 ? `<li class="more">${list.length - 50} more. Refine the search.</li>` : '');
  }

  // Editable names list: shorten names in Excel, save as CSV, upload as label-names.csv.
  // UPCs are written as ="..." so Excel keeps leading zeros.
  function downloadNamesList() {
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    const rows = (state.library || []).filter(e => !e.error)
      .map(e => [`="${e.code.digits}"`, q(e.name), q(e.source.split('/').pop())].join(','));
    const csv = '﻿upc,name,file\r\n' + rows.join('\r\n') + '\r\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'label-names.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function addFromLibrary(idx) {
    const e = state.library[idx];
    if (!e || e.error) return;
    addRow(e.name, e.code.digits);
    $('libSearch').value = '';
    renderLibrary();
  }

  // ---- Wire up -----------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    $('msLogin').addEventListener('click', doMicrosoftLogin);
    $('logout').addEventListener('click', doLogout);

    $('addRow').addEventListener('click', () => addRow());
    $('queueBody').addEventListener('input', onQueueInput);
    $('queueBody').addEventListener('click', onQueueClick);

    $('startGrid').addEventListener('click', e => {
      const b = e.target.closest('button[data-pos]');
      if (b) setStart(+b.dataset.pos);
    });

    $('printerSel').addEventListener('change', e => {
      state.printers.active = e.target.value;
      savePrinters();
      renderPrinters();
      renderPreview();
    });
    $('newPrinter').addEventListener('click', newPrinter);
    $('deletePrinter').addEventListener('click', deletePrinter);
    for (const id of ['calDx', 'calDy', 'calSx', 'calSy']) {
      $(id).addEventListener('input', readCalInputs);
      $(id).addEventListener('change', renderPrinters); // normalise display on blur
    }
    $('calSheet').addEventListener('click', onCalibration);

    $('prevPage').addEventListener('click', () => { state.previewPage--; renderPreview(); });
    $('nextPage').addEventListener('click', () => { state.previewPage++; renderPreview(); });
    $('openPdf').addEventListener('click', onOpen);
    $('downloadPdf').addEventListener('click', onDownload);

    $('libSearch').addEventListener('input', renderLibrary);
    $('libSearch').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = $('libResults').querySelector('button[data-lib]');
      if (first) addFromLibrary(+first.dataset.lib);
    });
    $('libShowBad').addEventListener('change', renderLibrary);
    $('libExport').addEventListener('click', downloadNamesList);
    $('libResults').addEventListener('click', e => {
      const b = e.target.closest('button[data-lib]');
      if (b) addFromLibrary(+b.dataset.lib);
    });

    renderPrinters();
    renderQueue();

    const { data: { session } } = await sb.auth.getSession();
    await handleSession(session);
    sb.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_IN') handleSession(s);
    });
  });
})();
