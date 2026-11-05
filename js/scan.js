// Read a UPC-A / EAN-13 number from a photo, screenshot or PDF, in the browser.
// The decoder (ZXing) and the PDF reader (pdf.js) load from a CDN the first time they're needed.
// Only the NUMBER is taken from the file; the barcode itself is always redrawn as vector.
(function (root) {
  'use strict';
  const C = root.LabelCore;
  const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const MAX_PDF_PAGES = 5;

  const loading = new Map();
  function loadScript(url) {
    if (!loading.has(url)) {
      loading.set(url, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => {
          loading.delete(url);
          reject(new Error('Could not load the scanner. Check the internet connection.'));
        };
        document.head.appendChild(s);
      }));
    }
    return loading.get(url);
  }

  let reader = null;
  async function getReader() {
    if (!reader) {
      await loadScript(ZXING_URL);
      const Z = root.ZXing;
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.UPC_A]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);
      reader = new Z.MultiFormatReader();
      reader.setHints(hints);
    }
    return reader;
  }

  function canvasOf(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // Copy src (any drawable) onto a white canvas at the given scale and rotation (0/90/180/270).
  function transform(src, sw, sh, scale, rot) {
    const swap = rot === 90 || rot === 270;
    const c = canvasOf((swap ? sh : sw) * scale, (swap ? sw : sh) * scale);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2);
    g.rotate((rot * Math.PI) / 180);
    g.drawImage(src, -(sw * scale) / 2, -(sh * scale) / 2, sw * scale, sh * scale);
    return c;
  }

  // Try the image at a few sizes and rotations. Returns a valid parseCode result or null.
  async function decodeDrawable(src, sw, sh) {
    const rd = await getReader();
    const Z = root.ZXing;
    const long = Math.max(sw, sh);
    const base = long < 900 ? 1200 / long : long > 2400 ? 2400 / long : 1;
    for (const scale of [base, base * 0.5]) {
      for (const rot of [0, 90, 180, 270]) {
        const c = transform(src, sw, sh, scale, rot);
        try {
          const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)));
          const text = rd.decode(bmp).getText();
          const code = C.parseCode(text);
          if (code.ok) return code;
        } catch (e) { /* not found at this setting; try the next */ }
      }
    }
    return null;
  }

  async function decodeImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await decodeDrawable(img, img.naturalWidth, img.naturalHeight);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function decodePdf(file) {
    await loadScript(PDFJS_URL);
    const pdfjs = root.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let n = 1; n <= pages; n++) {
      const page = await pdf.getPage(n);
      // Digits printed as real text (vector PDFs) are the most reliable source.
      try {
        const tc = await page.getTextContent();
        const text = tc.items.map(i => i.str).join(' ');
        for (const m of text.matchAll(/\d[\d -]{9,16}\d/g)) {
          const code = C.parseCode(m[0].replace(/\D/g, ''));
          if (code.ok && code.digits.length >= 12) return code;
        }
      } catch (e) { /* fall through to pixels */ }
      const vp = page.getViewport({ scale: 3 });
      const c = canvasOf(vp.width, vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      const code = await decodeDrawable(c, c.width, c.height);
      if (code) return code;
    }
    return null;
  }

  // Best-effort product name from a file name; '' for camera/screenshot style names.
  function nameFromFile(fileName) {
    const s = String(fileName).replace(/\.[a-z0-9]+$/i, '')
      .replace(/^\s*(upc|ean|gtin)([\s_-]?(a|e|8|12|13|14))?[\s_-]*/i, '')
      .replace(/\d{11,13}/, '')
      .replace(/_+/g, ' ')
      .replace(/^[\s-]+|[\s-]+$/g, '').trim();
    if (!s || /^(img|dsc|image|photo|scan|screenshot|screen shot|pxl|barcode|document)\b/i.test(s) ||
        /^[\d\s\-().]+$/.test(s)) return '';
    return s;
  }

  // -> { code } or { error }
  async function scanFile(file) {
    try {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      const code = isPdf ? await decodePdf(file) : await decodeImage(file);
      if (code) return { code };
      return { error: 'No barcode found. Try a sharper, straighter picture, or type the number.' };
    } catch (e) {
      return { error: e && e.message ? e.message : 'Could not read this file.' };
    }
  }

  root.LabelScan = { scanFile, nameFromFile };
})(window);
