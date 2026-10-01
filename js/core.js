// Label layout, UPC-A / EAN-13 encoding and label geometry.
// No DOM or library dependencies, so it runs in the browser and in Node tests
// (tests/core.test.js). All dimensions are inches; font sizes are points.
(function (root) {
  'use strict';

  // ---- Sheet formats ------------------------------------------------------
  // Add other Avery formats here; nothing else hard-codes 5160 geometry.
  const LAYOUTS = {
    avery5160: {
      name: 'Avery 5160',
      page: { w: 8.5, h: 11 },
      cols: 3,
      rows: 10,
      label: { w: 2.625, h: 1.0 },
      margin: { top: 0.5, left: 0.1875 },
      pitch: { x: 2.75, y: 1.0 },
      padding: 0.08 // inner safe area so small feed variance doesn't clip content
    }
  };

  function perPage(layout) {
    return layout.cols * layout.rows;
  }

  // slot is zero-based, left-to-right then top-to-bottom
  function labelOrigin(layout, slot) {
    const c = slot % layout.cols;
    const r = Math.floor(slot / layout.cols);
    return { x: layout.margin.left + c * layout.pitch.x, y: layout.margin.top + r * layout.pitch.y };
  }

  // ---- UPC / EAN ----------------------------------------------------------
  // Mod-10 check digit over the digits that precede it (weights 3,1,3,... from the right).
  function checkDigit(body) {
    let sum = 0;
    for (let i = 0; i < body.length; i++) {
      const d = body.charCodeAt(body.length - 1 - i) - 48;
      sum += i % 2 === 0 ? d * 3 : d;
    }
    return (10 - (sum % 10)) % 10;
  }

  // Accepts 11 digits (check digit computed), 12 (UPC-A, validated) or 13
  // (EAN-13, validated; a leading 0 is the same symbol as UPC-A so it renders as UPC-A).
  // Spaces and dashes are ignored.
  function parseCode(input) {
    const raw = String(input == null ? '' : input).replace(/[\s-]/g, '');
    if (!raw) return { ok: false, error: 'Enter a UPC' };
    if (!/^\d+$/.test(raw)) return { ok: false, error: 'Digits only' };
    if (raw.length === 11) {
      return { ok: true, type: 'upca', digits: raw + checkDigit(raw), computed: true };
    }
    if (raw.length === 12 || raw.length === 13) {
      const given = +raw.slice(-1);
      const want = checkDigit(raw.slice(0, -1));
      if (given !== want) {
        return { ok: false, error: `Bad check digit: ends in ${given}, should be ${want}` };
      }
      if (raw.length === 13 && raw[0] === '0') {
        return { ok: true, type: 'upca', digits: raw.slice(1), computed: false };
      }
      return { ok: true, type: raw.length === 12 ? 'upca' : 'ean13', digits: raw, computed: false };
    }
    return { ok: false, error: `Need 11, 12 or 13 digits (got ${raw.length})` };
  }

  const L_CODES = ['0001101', '0011001', '0010011', '0111101', '0100011',
                   '0110001', '0101111', '0111011', '0110111', '0001011'];
  const R_CODES = L_CODES.map(p => p.replace(/./g, b => (b === '0' ? '1' : '0')));
  const G_CODES = R_CODES.map(p => p.split('').reverse().join(''));
  const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
                      'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

  // Returns the 95-module pattern, which modules extend below the bars
  // (guards, plus UPC-A's first and last digit), and the human-readable groups.
  // Module positions in `text` are relative to the first bar.
  function encode(code) {
    const upc = code.type === 'upca';
    const ean = upc ? '0' + code.digits : code.digits;
    const parity = EAN_PARITY[+ean[0]];
    let modules = '101';
    let guard = '111';
    for (let i = 1; i <= 6; i++) {
      modules += (parity[i - 1] === 'L' ? L_CODES : G_CODES)[+ean[i]];
      guard += (upc && i === 1 ? '1' : '0').repeat(7);
    }
    modules += '01010';
    guard += '11111';
    for (let i = 7; i <= 12; i++) {
      modules += R_CODES[+ean[i]];
      guard += (upc && i === 12 ? '1' : '0').repeat(7);
    }
    modules += '101';
    guard += '111';

    const d = code.digits;
    const text = upc
      ? [{ text: d[0], side: 'left' },
         { text: d.slice(1, 6), from: 10, to: 45 },
         { text: d.slice(6, 11), from: 50, to: 85 },
         { text: d[11], side: 'right' }]
      : [{ text: d[0], side: 'left' },
         { text: d.slice(1, 7), from: 3, to: 45 },
         { text: d.slice(7, 13), from: 50, to: 92 }];
    return { modules, guard, text };
  }

  // Merge adjacent dark modules into bars: [{ start, end, guard }] in module units.
  function barRuns(enc) {
    const runs = [];
    for (let i = 0; i < enc.modules.length; i++) {
      if (enc.modules[i] !== '1') continue;
      const guard = enc.guard[i] === '1';
      const last = runs[runs.length - 1];
      if (last && last.end === i && last.guard === guard) last.end++;
      else runs.push({ start: i, end: i + 1, guard });
    }
    return runs;
  }

  // ---- Label geometry -----------------------------------------------------
  const PT = 1 / 72;
  const SPEC = {
    namePtMax: 9,
    namePtMin: 6,
    digitPt: 8,
    outerDigitPt: 6,
    xNominal: 0.013,   // 100% UPC magnification
    xMin: 0.0104,      // 80%
    quiet: 9,          // quiet zone each side, in modules
    minBarHeight: 0.45,
    insetY: 1.5 / 25.4 // extra 1.5 mm off the top and bottom of the content (from the first test print)
  };

  // Shrink to fit between max and min size, then truncate with "...".
  // (Three periods rather than U+2026 so the PDF's built-in Helvetica can encode it.)
  function fitText(text, maxWidth, measure) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return { text: '', pt: SPEC.namePtMax };
    for (let pt = SPEC.namePtMax; pt >= SPEC.namePtMin; pt -= 0.5) {
      if (measure(text, pt) <= maxWidth) return { text, pt };
    }
    const pt = SPEC.namePtMin;
    let cut = text;
    while (cut.length > 1 && measure(cut.trimEnd() + '...', pt) > maxWidth) cut = cut.slice(0, -1);
    return { text: cut.trimEnd() + '...', pt };
  }

  // Drawing primitives for one label, relative to the label's top-left corner.
  //   { t:'rect', x, y, w, h }                       filled
  //   { t:'text', x, y, pt, text, align }            y is the baseline
  // measure(text, pt) -> width in inches for Helvetica.
  function labelPrimitives(layout, item, measure) {
    const lw = layout.label.w;
    const lh = layout.label.h;
    const pad = layout.padding;
    const innerW = lw - 2 * pad;
    const top = pad + SPEC.insetY;
    const bottom = lh - pad - SPEC.insetY;
    const out = [];

    const name = fitText(item.name, innerW, measure);
    if (name.text) out.push({ t: 'text', x: lw / 2, y: top + 0.095, pt: name.pt, text: name.text, align: 'center' });

    const enc = encode(item.code);
    const X = Math.min(SPEC.xNominal, innerW / (95 + 2 * SPEC.quiet));
    if (X < SPEC.xMin) throw new Error('Barcode does not fit at 80% magnification');
    const x0 = lw / 2 - (95 * X) / 2;

    const barsTop = top + 0.145;
    const digitBase = bottom - 0.005;
    const digitTop = digitBase - SPEC.digitPt * PT * 0.72; // Helvetica cap height ~0.72em
    const barsBottom = digitTop - 0.015;
    const guardBottom = Math.min(barsBottom + 5 * X, digitBase - 0.02);
    if (barsBottom - barsTop < SPEC.minBarHeight) throw new Error('Bars too short');

    for (const run of barRuns(enc)) {
      out.push({
        t: 'rect',
        x: x0 + run.start * X,
        y: barsTop,
        w: (run.end - run.start) * X,
        h: (run.guard ? guardBottom : barsBottom) - barsTop
      });
    }
    for (const g of enc.text) {
      if (g.side === 'left') {
        out.push({ t: 'text', x: x0 - 1.5 * X, y: digitBase, pt: SPEC.outerDigitPt, text: g.text, align: 'right' });
      } else if (g.side === 'right') {
        out.push({ t: 'text', x: x0 + 96.5 * X, y: digitBase, pt: SPEC.outerDigitPt, text: g.text, align: 'left' });
      } else {
        out.push({ t: 'text', x: x0 + ((g.from + g.to) / 2) * X, y: digitBase, pt: SPEC.digitPt, text: g.text, align: 'center' });
      }
    }
    return out;
  }

  // Outline, crosshair and 1/32" ruler ticks for the plain-paper alignment check.
  //   { t:'stroke', x, y, w, h }   { t:'line', x1, y1, x2, y2 }
  function calibrationPrimitives(layout) {
    const w = layout.label.w;
    const h = layout.label.h;
    const cx = w / 2;
    const cy = h / 2;
    const arm = 0.3;
    const out = [
      { t: 'stroke', x: 0, y: 0, w, h },
      { t: 'line', x1: cx - arm, y1: cy, x2: cx + arm, y2: cy },
      { t: 'line', x1: cx, y1: cy - arm, x2: cx, y2: cy + arm }
    ];
    for (let i = -8; i <= 8; i++) {
      if (i === 0) continue;
      const d = i / 32;
      const len = i % 8 === 0 ? 0.08 : i % 4 === 0 ? 0.06 : i % 2 === 0 ? 0.04 : 0.025;
      out.push({ t: 'line', x1: cx + d, y1: cy - len / 2, x2: cx + d, y2: cy + len / 2 });
      out.push({ t: 'line', x1: cx - len / 2, y1: cy + d, x2: cx + len / 2, y2: cy + d });
    }
    return out;
  }

  // ---- Queue -> pages -----------------------------------------------------
  // items: [{ qty, ... }]; start is 1-based. Returns [[{ slot, item }]].
  function paginate(layout, items, start) {
    const per = perPage(layout);
    const pages = [];
    let page = null;
    let slot = start - 1;
    for (const item of items) {
      for (let n = 0; n < item.qty; n++) {
        if (!page || slot >= per) {
          if (page) slot = 0;
          page = [];
          pages.push(page);
        }
        page.push({ slot, item });
        slot++;
      }
    }
    return pages;
  }

  // Labels left on the current sheet once `usedBefore` labels have been placed after `start`.
  function remainingOnSheet(layout, start, usedBefore) {
    const per = perPage(layout);
    return per - ((start - 1 + usedBefore) % per);
  }

  // ---- Library file names -------------------------------------------------
  // "UPC-12-765464395832 - Soft Plus Tissue.pdf" -> { upc: '765464395832', name: 'Soft Plus Tissue' }
  // Also handles "upc-a_720665774718 - 16oz Champagne.jpg" and "099451154806 - #2 Kraft Box.jpg".
  function parseFilename(path) {
    const base = String(path).split('/').pop()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/^\s*(upc|ean|gtin)([\s_-]?(a|e|8|12|13|14))?[\s_-]*/i, '');
    const m = base.match(/(?:^|\D)(\d{11,13})(?!\d)/);
    const upc = m ? m[1] : '';
    const name = (m ? base.replace(m[1], ' ') : base)
      .replace(/_/g, ' ')
      .replace(/\b(barcode|label)\b/gi, ' ')
      .replace(/(^|\s)-+(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { name, upc };
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim()));
  }

  function libraryEntry(name, upc, source, forcedError) {
    const code = parseCode(upc);
    return { name, upc, source, code, error: forcedError || (code.ok ? '' : code.error) };
  }

  // CSV with a header containing a UPC column (upc/barcode/ean/gtin) and a name column
  // (name/product/description/item). Without a header, columns are name, upc.
  function csvEntries(text, path) {
    const rows = parseCsv(text.replace(/^﻿/, ''));
    if (!rows.length) return [];
    const head = rows[0].map(h => h.trim().toLowerCase());
    let ni = head.findIndex(h => /^(product|name|description|item)/.test(h));
    let ui = head.findIndex(h => /(upc|barcode|ean|gtin)/.test(h));
    let data = rows.slice(1);
    let firstRow = 2;
    if (ui < 0) { ni = 0; ui = 1; data = rows; firstRow = 1; }
    if (ni < 0) ni = ui === 0 ? 1 : 0;
    return data.map((r, i) => {
      const upc = (r[ui] || '').replace(/[="]/g, '').trim(); // ="0123..." keeps Excel from eating zeros
      // Excel drops leading zeros, so 11 digits in a spreadsheet is ambiguous: flag it, don't guess.
      const short = /^\d{11}$/.test(upc.replace(/[\s-]/g, ''));
      return libraryEntry((r[ni] || '').trim(), upc, `${path} row ${i + firstRow}`,
        short ? 'Only 11 digits. Excel may have dropped a leading 0; enter all 12' : '');
    });
  }

  const zeroKey = digits => digits.replace(/^0+/, '');

  // filePaths: names of barcode files in the bucket. csvFiles: [{ path, text }].
  // Files supply the UPC and a fallback name. CSV rows override the printed name by UPC
  // (matching even if a leading zero was lost) and can add products that have no file.
  // Problems (no UPC, bad check digit, duplicates) stay in the list with `error` set.
  function buildLibrary(filePaths, csvFiles) {
    const byKey = new Map();
    const out = [];
    for (const path of filePaths) {
      const { name, upc } = parseFilename(path);
      const e = libraryEntry(name, upc, path, upc ? '' : 'No UPC in file name');
      if (!e.error) {
        const first = byKey.get(zeroKey(e.code.digits));
        if (first) e.error = `Duplicate UPC (also in ${first.source})`;
        else byKey.set(zeroKey(e.code.digits), e);
      }
      out.push(e);
    }
    for (const { path, text } of csvFiles) {
      for (const row of csvEntries(text, path)) {
        const raw = row.upc.replace(/[\s-]/g, '');
        const match = /^\d+$/.test(raw) ? byKey.get(zeroKey(raw)) : null;
        if (match) {
          if (row.name) { match.name = row.name; match.nameFrom = row.source; }
        } else {
          if (!row.error) byKey.set(zeroKey(row.code.digits), row);
          out.push(row);
        }
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  const api = {
    LAYOUTS, SPEC, perPage, labelOrigin, checkDigit, parseCode, encode, barRuns,
    fitText, labelPrimitives, calibrationPrimitives, paginate, remainingOnSheet,
    parseFilename, parseCsv, buildLibrary
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabelCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
