# Option B — DV Enterprises invoice: install guide

Option A (wallet / Razorpay) is untouched. Existing users automatically stay on Option A (`invoice_version` defaults to `'A'`).

## Files
| File | What to do |
|---|---|
| `dv-invoice-module.js` | **New.** Put next to `server.js`. All Option B backend code (schema, routes, calculations). |
| `dv-invoice.html` | **New.** Put in the same folder as `INVOICE_LOGIN.html` (the folder `findStaticFile` already searches). |
| `server.js` | Replace with the patched one (8 small edits, ~28 lines). |
| `INVOICE_LOGIN.html` | Replace with the patched one (one function + one line). |
| `Super_Admin_Dashboard.html` | Replace with the patched one. |

Your own copies may have changed since you sent them. In that case apply the `*.patch` files instead (`patch -p1 server.js < server.js.patch`) or copy the edits by hand.

## What changed in server.js
1. `ROOT_DENY_NAMES` gets `'dv-invoice-module.js'` so the module can never be downloaded as a static file.
2. Just before `app.use(routeMask.guard)`: `require('./dv-invoice-module').install(app, {...})`. It registers `GET /dv-invoice`, `/api/dv/*` and `/api/admin/dv-settings`.
3. `COLUMN_FIXES` starts with `...require('./dv-invoice-module').SCHEMA_SQL`, so the tables are created at startup with the rest of your schema.
4. `MU_PUBLIC_COLS` also returns `invoice_version AS "invoiceVersion"`.
5. Approve request, create user and edit user now accept `invoiceVersion` (`'A'` or `'B'`).
6. **Login dispatcher:** `/api/material/login` returns `invoiceVersion` and `redirectTo` (`'/dv-invoice'` for B, `null` for A).

## Database schema (created automatically; run manually in Supabase if you prefer)
```sql
ALTER TABLE material_users ADD COLUMN IF NOT EXISTS invoice_version VARCHAR(1) NOT NULL DEFAULT 'A';
CREATE TABLE IF NOT EXISTS dv_settings (skey VARCHAR(40) PRIMARY KEY, data TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS dv_invoices (
  id SERIAL PRIMARY KEY, owner_user_id VARCHAR(50) NOT NULL, bill_no VARCHAR(40) NOT NULL, invoice_date DATE NOT NULL,
  customer_name VARCHAR(255), block_name VARCHAR(120), district_name VARCHAR(120), transport_mode VARCHAR(120), vehicle_no VARCHAR(60),
  items TEXT NOT NULL, taxable_total NUMERIC(14,2) NOT NULL DEFAULT 0, cgst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst_total NUMERIC(14,2) NOT NULL DEFAULT 0, round_off NUMERIC(8,2) NOT NULL DEFAULT 0, grand_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_words TEXT, company_snapshot TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dv_inv_owner_bill ON dv_invoices (owner_user_id, LOWER(bill_no));
CREATE INDEX IF NOT EXISTS idx_dv_inv_owner_date ON dv_invoices (owner_user_id, invoice_date DESC, id DESC);
```

## Super Admin
* **Material Users → table:** a new *Invoice* column has an Option A / Option B selector. The change applies immediately, and the user's next login follows it.
* **Add / Edit user** and **Verify & Approve** forms have an *Invoice type* dropdown.
  The quick ✔ approve button on the pending list still defaults to Option A. Use Verify & Approve to pick B, or switch later in the table.
* **Settings → Payments → "Option B — DV Enterprises Invoice Presets":** company name, address, GSTIN, mobile, bank, branch, IFSC, A/C no., CGST %, SGST %, round-off, optional default customer / block / district.

## How Option B behaves
* **Same login for everyone.** `attemptLogin` → `enterPortal()` sends B users to `/dv-invoice`. The token travels in the URL fragment (never sent to a server), so this also works if the login page and API are on different domains. A users continue exactly as before.
* **User inputs:** Bill No., Date, material name, quantity, rate. Unit, customer, block, district, transport and vehicle are optional cells on the sheet. Company, GSTIN, bank, tax %, taxable / CGST / SGST / total, round-off and amount in words are automatic. The **server recalculates everything on save**.
* **Save:** a Bill No. that already exists is refused (409), never overwritten.
* **Edit & versioning:** open a saved bill, then
  * same Bill No. → that record is updated in place;
  * changed Bill No. (500 → 502) → a **new** record is inserted and 500 stays untouched. Forking onto a number that already exists is refused.
* **Search:** type in the box; results appear as you type (substring match on Bill No.; Enter opens an exact match).
* **Delete / Print / Reset:** Delete asks for confirmation. Print uses the A4 print layout (choose *Save as PDF* to download). Reset clears the sheet only.
* **Saved bills keep their company snapshot,** so changing the bank or GST presets later does not alter old bills.
* **Security:** every `/api/dv/*` route needs a valid material-user JWT, an active account, and `invoice_version = 'B'` (checked live in the DB). A user can only see, edit or delete their own bills. 15-minute inactivity logout, same as the legacy portal.

## Things to check
* The GSTIN is seeded exactly as printed on the sample (`100PLPK1248J1ZP`). It doesn't match the standard GSTIN pattern, so please verify it in Settings.
* Branch is seeded as **Manjhaul** (as on the sample PDF). You wrote "Manjhauli", so edit it in Settings if that is the right spelling.
* `/dv-invoice` is registered ahead of your route-mask guard, so it has a fixed URL (it holds no data; all data needs the JWT). To hide it like the other portals, add it to `route-mask.js` (that file wasn't shared with me).
