// PDF output with jsPDF. Everything is vector: bars are filled rectangles and
// text uses the PDF's built-in Helvetica.
(function (root) {
  'use strict';
  const C = root.LabelCore;

  function newDoc() {
    return new root.jspdf.jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait', compress: true });
  }

  // Helvetica width in inches, for fitting product names.
  let scratch = null;
  function measure(text, pt) {
    if (!scratch) scratch = newDoc();
    scratch.setFont('helvetica', 'normal');
    scratch.setFontSize(pt);
    return scratch.getTextWidth(text);
  }

  // Calibration maps nominal page inches to printed inches:
  //   printed = offset + nominal * scale, anchored at the page's top-left corner.
  function mapper(cal) {
    const sx = cal.sx / 100;
    const sy = cal.sy / 100;
    return { sx, sy, x: v => cal.dx + v * sx, y: v => cal.dy + v * sy };
  }

  function draw(doc, prims, ox, oy, m) {
    for (const p of prims) {
      if (p.t === 'rect') {
        doc.rect(m.x(ox + p.x), m.y(oy + p.y), p.w * m.sx, p.h * m.sy, 'F');
      } else if (p.t === 'stroke') {
        doc.rect(m.x(ox + p.x), m.y(oy + p.y), p.w * m.sx, p.h * m.sy, 'S');
      } else if (p.t === 'line') {
        doc.line(m.x(ox + p.x1), m.y(oy + p.y1), m.x(ox + p.x2), m.y(oy + p.y2));
      } else if (p.t === 'text') {
        doc.setFontSize(p.pt * m.sy);
        doc.text(p.text, m.x(ox + p.x), m.y(oy + p.y), { align: p.align, baseline: 'alphabetic' });
      }
    }
  }

  // pages: output of LabelCore.paginate, with item = { name, code }
  function labelsPdf(layout, pages, cal, title) {
    const doc = newDoc();
    const m = mapper(cal);
    doc.setProperties({ title, creator: 'DFL Barcode Label Generator' });
    doc.setFont('helvetica', 'normal');
    doc.setFillColor(0, 0, 0);
    doc.setTextColor(0, 0, 0);
    const cache = new Map(); // same product -> same primitives
    pages.forEach((page, i) => {
      if (i > 0) doc.addPage('letter', 'portrait');
      for (const { slot, item } of page) {
        let prims = cache.get(item);
        if (!prims) {
          prims = C.labelPrimitives(layout, item, measure);
          cache.set(item, prims);
        }
        const o = C.labelOrigin(layout, slot);
        draw(doc, prims, o.x, o.y, m);
      }
    });
    return doc;
  }

  function calibrationPdf(layout, cal, profileName) {
    const doc = newDoc();
    const m = mapper(cal);
    doc.setProperties({ title: `Calibration - ${profileName}`, creator: 'DFL Barcode Label Generator' });
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.006);
    const prims = C.calibrationPrimitives(layout);
    for (let slot = 0; slot < C.perPage(layout); slot++) {
      const o = C.labelOrigin(layout, slot);
      draw(doc, prims, o.x, o.y, m);
    }
    const gridW = (layout.cols - 1) * layout.pitch.x + layout.label.w;
    const gridH = (layout.rows - 1) * layout.pitch.y + layout.label.h;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(2);
    draw(doc, [
      { t: 'text', x: layout.page.w / 2, y: 0.3, pt: 9, align: 'center',
        text: `${layout.name} calibration  |  Profile: ${profileName}  |  X ${fmt(cal.dx)} in, Y ${fmt(cal.dy)} in, ` +
              `scale ${cal.sx.toFixed(1)}% x ${cal.sy.toFixed(1)}%` },
      { t: 'text', x: layout.page.w / 2, y: layout.page.h - 0.22, pt: 8, align: 'center',
        text: `Print on plain paper at Actual size / 100%. Outer box should measure ` +
              `${gridW.toFixed(3)} x ${gridH.toFixed(3)} in. Ticks are 1/32 in.` }
    ], 0, 0, m);
    return doc;
  }

  root.LabelPdf = { measure, labelsPdf, calibrationPdf };
})(window);
