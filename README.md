# DFL Barcode Label Generator

Browser tool that prints UPC-A / EAN-13 product barcode stickers on **Avery 5160** sheets
(30 labels, Letter). It builds an exact-dimension, all-vector PDF, so labels land where
they should, unlike the old Word template.

Live at **https://dflimporters.github.io/barcodes/**. Staff sign in with their DFL Microsoft account.

## Using it

1. Pick products from the library (search by name or UPC), or type a name and UPC into the queue.
   11 digits: the check digit is added for you. 12 or 13 digits: the check digit is verified.
2. Set the quantity for each row. **Fill sheet** sets it to the labels left on the current sheet.
3. Reusing a partly used sheet? Click the first free label under **Start position**.
4. Choose your printer under **Printer calibration** (see below).
5. **Open PDF** and print it. **Print at Actual size / 100%, Fit to page OFF, Paper size Letter.**

## Calibrating a new printer

Each printer feeds paper slightly differently. Do this once per printer, and again if labels start drifting.

1. Under **Printer calibration**, click **New** and name the printer (e.g. "Front office HP").
   Settings are saved in that browser, per printer.
2. Click **Print calibration sheet** and print it on **plain paper** at Actual size / 100%.
3. Put the printout on top of a blank 5160 sheet and hold both up to a window or light.
   Check all four corners, especially the **top and bottom rows**.
4. Every box should sit on a label. The crosshair ticks are 1/32" apart, so count ticks to
   measure how far off the labels are.
   - **All rows off by the same amount**: set **X offset** (+ moves right) or **Y offset** (+ moves down)
     in inches, e.g. 2 ticks low = Y offset `-0.06`.
   - **Top row lines up but the bottom row is off** (or the reverse): the printer is scaling.
     First check that Fit to page is really off. If it is, adjust **Y scale**: the grid is 10" tall,
     so bottom row 1/16" short means `100 + 0.0625/10*100` = `100.6`%. X scale works the same over 8.125".
   - The outer box should measure 8.125" x 10.000" with a ruler. If it doesn't, it's a scaling problem.
5. Print the calibration sheet again and repeat until every corner is within about 1/32".
6. Print one real label sheet and scan a few labels to confirm.

## Product library

Barcode source files live in the private Supabase Storage bucket **`product-barcodes`**
(project `hzagwndglwhcepsirafi`). Staff can read it; only Joel, Scott and Travis can upload or delete.
Upload through the Supabase dashboard. The page loads the list once per session.

**Barcode files** supply the UPC, which must be at the front of the file name:
`UPC-12-765464395832 - Soft Plus Tissue.pdf`, `765464395832 - Soft Plus Tissue.jpg` and
`EAN-13-6937463000411 - ….pdf` all work. Any file type is fine; only the name is read, and the
barcode is always redrawn as vector.

**Label names.** The rest of the file name is used as the printed name unless
`label-names.csv` (columns `upc,name`) gives a better one. To shorten names:

1. Click **Download names list** in the Product library. It exports every product as `label-names.csv`.
2. Open it in Excel and shorten the `name` column. Leave a name blank to keep the file name.
3. Save as CSV and upload it to the bucket, replacing the old one. Reload the page.

Rows in the CSV can also add products that have no file. UPCs are matched even if Excel
dropped a leading zero, but a new 11-digit UPC in the CSV is flagged rather than guessed.
Missing UPCs, bad check digits and duplicates show under **Show problems**; nothing is silently dropped.
Names can always be edited in the queue for a one-off print.

## Development

Plain static site: no build step. Libraries load from jsDelivr at pinned versions
(`@supabase/supabase-js@2.117.2`, `jspdf@4.2.1`).

| File | What it does |
|---|---|
| `js/core.js` | Sheet layouts (add other Avery formats to `LAYOUTS`), UPC/EAN encoding, label geometry, pagination. No dependencies. |
| `js/pdf.js` | Draws labels and the calibration sheet with jsPDF (vector rects + built-in Helvetica). |
| `js/app.js` | Sign-in, queue, start position, printer profiles, preview, library. |

Run the unit tests:

```bash
node --test tests/core.test.js
```

To run it locally, serve the folder (e.g. `npx http-server -p 8137`). Microsoft sign-in only redirects
back to URLs on Supabase's allow-list, so local testing of the signed-in flow needs
`http://localhost:8137/` added there too.
