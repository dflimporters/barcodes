// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

const layout = C.LAYOUTS.avery5160;
const measure = (text, pt) => (text.length * pt * 0.556) / 72; // rough Helvetica digit width

test('11 digits computes the check digit', () => {
  const r = C.parseCode('76546439583');
  assert.equal(r.ok, true);
  assert.equal(r.digits, '765464395832');
  assert.equal(r.computed, true);
});

test('12 digits with a bad check digit is rejected', () => {
  const r = C.parseCode('765464395833');
  assert.equal(r.ok, false);
  assert.match(r.error, /should be 2/);
});

test('spaces and dashes are stripped', () => {
  assert.equal(C.parseCode('7 65464-39583 2').digits, '765464395832');
});

test('13-digit EAN validates; leading 0 renders as UPC-A', () => {
  assert.deepEqual(
    [C.parseCode('6937463000411').ok, C.parseCode('6937463000411').type],
    [true, 'ean13']
  );
  const u = C.parseCode('0099451154806');
  assert.equal(u.type, 'upca');
  assert.equal(u.digits, '099451154806');
});

test('wrong lengths and non-digits are rejected', () => {
  assert.equal(C.parseCode('1234').ok, false);
  assert.equal(C.parseCode('12345678901a').ok, false);
});

// Independent decode of the 95-module pattern back to digits.
function decode(modules) {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const flip = s => s.replace(/./g, b => (b === '0' ? '1' : '0'));
  const R = L.map(flip);
  const G = R.map(s => [...s].reverse().join(''));
  const parityTable = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  assert.equal(modules.length, 95);
  assert.equal(modules.slice(0, 3), '101');
  assert.equal(modules.slice(45, 50), '01010');
  assert.equal(modules.slice(92), '101');
  let left = '', parity = '';
  for (let i = 0; i < 6; i++) {
    const chunk = modules.slice(3 + i * 7, 10 + i * 7);
    if (L.includes(chunk)) { left += L.indexOf(chunk); parity += 'L'; }
    else { left += G.indexOf(chunk); parity += 'G'; }
  }
  let right = '';
  for (let i = 0; i < 6; i++) right += R.indexOf(modules.slice(50 + i * 7, 57 + i * 7));
  return parityTable.indexOf(parity) + left + right;
}

test('UPC-A encodes and decodes back to the same digits', () => {
  for (const upc of ['765464395832', '099451154806', '036000291452', '843490029218']) {
    const enc = C.encode(C.parseCode(upc));
    assert.equal(decode(enc.modules), '0' + upc);
  }
});

test('EAN-13 matches the published reference pattern', () => {
  // GS1 / Wikipedia worked example for 5901234123457
  assert.equal(C.encode(C.parseCode('5901234123457')).modules,
    '10100010110100111011001100100110111101001110101010110011011011001000010101110010011101000100101');
});

test('EAN-13 encodes and decodes back to the same digits (every leading digit)', () => {
  const bodies = ['693746300041', '590123412345', '400638133393', '012345678901', '123456789012',
                  '234567890123', '345678901234', '789012345678', '890123456789', '978030640615'];
  for (const ean of bodies.map(b => b + C.checkDigit(b))) {
    assert.equal(decode(C.encode(C.parseCode(ean)).modules), ean);
  }
});

test('UPC-A human-readable digits follow standard layout', () => {
  const t = C.encode(C.parseCode('765464395832')).text.map(g => g.text).join(' ');
  assert.equal(t, '7 65464 39583 2');
});

test('start 14 with qty 40 fills 14-30 then 23 on page 2', () => {
  const pages = C.paginate(layout, [{ qty: 40 }], 14);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].length, 17);
  assert.equal(pages[0][0].slot, 13);
  assert.equal(pages[0][16].slot, 29);
  assert.equal(pages[1].length, 23);
  assert.equal(pages[1][0].slot, 0);
});

test('fill sheet counts start position and earlier rows', () => {
  assert.equal(C.remainingOnSheet(layout, 1, 0), 30);
  assert.equal(C.remainingOnSheet(layout, 14, 0), 17);
  assert.equal(C.remainingOnSheet(layout, 14, 17), 30);
  assert.equal(C.remainingOnSheet(layout, 1, 35), 25);
});

test('label origins match the 5160 spec', () => {
  assert.deepEqual(C.labelOrigin(layout, 0), { x: 0.1875, y: 0.5 });
  assert.deepEqual(C.labelOrigin(layout, 2), { x: 5.6875, y: 0.5 });
  assert.deepEqual(C.labelOrigin(layout, 29), { x: 5.6875, y: 9.5 });
  const last = C.labelOrigin(layout, 29);
  assert.equal(last.x + layout.label.w, 8.3125);
  assert.equal(last.y + layout.label.h, 10.5);
});

test('label content stays inside the padded area at 100% magnification', () => {
  const prims = C.labelPrimitives(layout, { name: 'Soft Plus Tissue', code: C.parseCode('765464395832') }, measure);
  const rects = prims.filter(p => p.t === 'rect');
  const minX = Math.min(...rects.map(r => r.x));
  const maxX = Math.max(...rects.map(r => r.x + r.w));
  assert.ok(Math.abs(maxX - minX - 95 * 0.013) < 1e-9, 'symbol width is 95X at X=0.013');
  assert.ok(minX - 9 * 0.013 >= layout.padding - 1e-9, 'left quiet zone inside padding');
  assert.ok(maxX + 9 * 0.013 <= layout.label.w - layout.padding + 1e-9, 'right quiet zone inside padding');
  assert.ok(Math.min(...rects.map(r => r.h)) >= 0.45, 'bars at least 0.45in');
  assert.ok(Math.max(...rects.map(r => r.y + r.h)) <= layout.label.h - layout.padding, 'bars inside padding');
});

test('library file names yield product name and UPC', () => {
  const cases = {
    'UPC-12-765464395832 - Soft Plus Tissue (Temporary).pdf': ['Soft Plus Tissue (Temporary)', '765464395832'],
    'folder/UPC-12-765464395832 - Soft Plus Tissue.pdf': ['Soft Plus Tissue', '765464395832'],
    '099451154806 - #2  Kraft Box.jpg': ['#2 Kraft Box', '099451154806'],
    'upc-a_720665774718 - 16oz Champagne 20pk.jpg': ['16oz Champagne 20pk', '720665774718'],
    'EAN-13-6937463000411 - White & Bright 4kg.pdf': ['White & Bright 4kg', '6937463000411'],
    'White & Bright 4kg Barcode 6937463000411.jpg': ['White & Bright 4kg', '6937463000411'],
    'Corned Beef Barcode 12oz.jpg': ['Corned Beef 12oz', '']
  };
  for (const [file, [name, upc]] of Object.entries(cases)) {
    assert.deepEqual(C.parseFilename(file), { name, upc }, file);
  }
});

test('label-names.csv overrides file names by UPC, even after Excel drops a leading zero', () => {
  const files = [
    'UPC-12-765464395832 - Soft Plus Tissue (Temporary).pdf',
    '099451154806 - #2 Kraft Box Brown Takeout Container Large Size 200pcs.jpg',
    '843490029218 - Covebay 10in Plate.png',
    'Corned Beef Barcode 12oz.jpg',
    'copy/843490029218 - Covebay 10in Plate.png'
  ];
  const csv = 'upc,name,file\r\n' +
    '="765464395832",Soft Plus Tissue,x.pdf\r\n' +
    '99451154806,#2 Kraft Box,y.jpg\r\n' +          // Excel ate the leading 0
    '843490029218,,z.png\r\n' +                     // blank name keeps the file name
    '6937463000411,White & Bright 4kg,\r\n' +       // product with no file
    '12345678901,Ambiguous,\r\n';                   // 11 digits in a sheet: flagged
  const lib = C.buildLibrary(files, [{ path: 'label-names.csv', text: csv }]);
  const byUpc = Object.fromEntries(lib.filter(e => !e.error).map(e => [e.code.digits, e.name]));
  assert.deepEqual(byUpc, {
    '765464395832': 'Soft Plus Tissue',
    '099451154806': '#2 Kraft Box',
    '843490029218': 'Covebay 10in Plate',
    '6937463000411': 'White & Bright 4kg'
  });
  const errors = lib.filter(e => e.error).map(e => e.error);
  assert.equal(errors.length, 3);
  assert.ok(errors.some(e => /No UPC in file name/.test(e)));
  assert.ok(errors.some(e => /Duplicate UPC/.test(e)));
  assert.ok(errors.some(e => /Only 11 digits/.test(e)));
});

test('long names shrink then truncate', () => {
  const short = C.fitText('Soft Plus Tissue', 2.465, measure);
  assert.equal(short.pt, 9);
  const long = C.fitText('Extra Long Product Name That Will Never Fit On A Single Avery Label', 2.465, measure);
  assert.equal(long.pt, 6);
  assert.ok(long.text.endsWith('...'));
  assert.ok(measure(long.text, 6) <= 2.465);
});
