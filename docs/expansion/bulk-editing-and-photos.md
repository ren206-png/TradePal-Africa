# Bulk product editing, CSV import and product photos

Status: **implemented, locally tested (in-process database and a real local Postgres), and driven end to end in a browser against synthetic data. Not tried on a real low-end phone or a real network.** Default OFF.

Switches: platform `CATALOG_WEB_ENABLED=true`; per business the flag `catalogV2` (already the catalog flag). It reuses the phone page `/m/` and its one-time WhatsApp code (`/connect`); there is still no merchant web login.

## Bulk editing
The seller opens `/m/`, connects with the code, and sees **Products**: a card per product with price, "On the shop", the low-stock warning, status and product name. Change what you like, press **Review**, read exactly what will change, then **Save**.

Rules (all tested):
- **Nothing is saved until reviewed**, and a batch is **all-or-nothing**: if any row has a problem, nothing is written and the screen says which row and why.
- **Edits are checked against what you opened.** Each row carries a short fingerprint (`rev`). If someone else changed that product meanwhile (another phone, a WhatsApp command), your edit is refused as "changed after you opened it" instead of overwriting theirs.
- **Saving is safe to repeat.** Each batch has an id; a retry after a dropped connection, or two taps at once, applies it **once** (proved under parallel connections on a real Postgres).
- **Old prices are retired, never overwritten**, so price history stays. Only the retail price of one base unit is edited here.
- **Not editable here:** unit, cost, stock quantities, pack sizes, price breaks. Cost and stock go through goods receipts and counts, which keep the books right. A unit cannot be changed because stock counts depend on it.
- Permissions follow the matrix: price and product changes need `prices:manage`, listing on the shop needs `store:manage`, status needs `inventory:adjust`, photos need `store:manage`. Today a phone session maps to the owner (full) or a sales clerk (read only).
- A product needs a price before it can be on the shop, and cannot lose its price while listed.
- One audit entry per saved batch (who, how many, which SKUs).
- Up to 200 rows per batch; the screen shows 100 cards at a time with a search box.

## CSV
**Download CSV** gives every product. Edit in a spreadsheet, choose the file under "Or change many products with a CSV file", **Review**, **Save**. Empty cell = leave alone; the word `CLEAR` removes a value; a new SKU with a product name and unit creates a product. The export neutralises spreadsheet formulas (a leading `= + - @` gets an apostrophe) and the import removes that apostrophe again, so a note like `=SUM(...)` can never run in a spreadsheet.

## Photos
- Stored **in our own database** and served from our own address (`/shop-image/<id>`). A seller-typed image link is never loaded (it would tell a third party who is shopping, and the page security headers block it anyway).
- JPEG, PNG or WebP only; the server checks the first bytes and reads the size from the header (it never decodes a picture); SVG, GIF, animated images and HTML dressed as a picture are refused. 400 KB and 2000 px maximum, 6 per product, the same picture once per product.
- The phone shrinks a photo to about 1000 px before sending (a 2400x1800 test image became 1000x750, 128 KB), so an upload is small on a slow link.
- A photo is public **only while its product is on sale in an open shop** and the business is not suspended or hidden; otherwise the same 404 as a made-up id. Unlisting takes it down at once (browsers may keep a copy for up to an hour).
- Removing a photo deletes its bytes (the row stays for the record). The database refuses to edit or delete a photo's content.
- The seller sees their own photos (even unlisted products) through the signed-in phone page.

## Size and cost
Photos live in Postgres (`bytea`). At 6 photos x about 150 KB x 1,000 products that is about 900 MB: fine for a pilot, the point at which to move to object storage (S3-compatible) and keep only the key in the database. The switch is contained in `src/domain/productImages.ts` and the public route.

## What is not built
Barcode scanning, bulk stock receiving by CSV, per-variant photos, image cropping on the server, a desktop web login.
