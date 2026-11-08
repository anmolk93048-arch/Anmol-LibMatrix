/* ============================================================================
   dv-invoice-module.js  —  "Option B" (DV Enterprises custom GST invoice)
   ----------------------------------------------------------------------------
   Self-contained backend module. It does NOT touch any Option A (wallet /
   Razorpay) route. server.js only needs the 3 tiny hooks described in
   INSTALL.md (require + install, schema spread, login dispatcher).

   Exposes:
     SCHEMA_SQL            idempotent DDL (spread into COLUMN_FIXES in server.js)
     install(app, ctx)     registers  GET /dv-invoice  and  /api/dv/*  and
                           /api/admin/dv-settings
     calc / amountInWords  pure helpers (also unit-tested)
   ============================================================================ */
'use strict';

/* ─────────────────────────── 1. DATABASE SCHEMA ─────────────────────────── */
const SCHEMA_SQL = [
    // (1) Super-Admin mapping: which invoice system a user gets. 'A' = legacy wallet system (default), 'B' = DV Enterprises
    "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS invoice_version VARCHAR(1) NOT NULL DEFAULT 'A'",
    // (2) Company / bank / tax presets owned by the Super Admin (single JSON row)
    `CREATE TABLE IF NOT EXISTS dv_settings (
        skey VARCHAR(40) PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // (3) Saved Option-B invoices. One row per Bill No. per user; company details are SNAPSHOTTED on save so an old bill never changes
    `CREATE TABLE IF NOT EXISTS dv_invoices (
        id SERIAL PRIMARY KEY,
        owner_user_id VARCHAR(50) NOT NULL,
        bill_no VARCHAR(40) NOT NULL,
        invoice_date DATE NOT NULL,
        customer_name VARCHAR(255),
        block_name VARCHAR(120),
        district_name VARCHAR(120),
        transport_mode VARCHAR(120),
        vehicle_no VARCHAR(60),
        items TEXT NOT NULL,
        taxable_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        cgst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        sgst_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        round_off NUMERIC(8,2) NOT NULL DEFAULT 0,
        grand_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        amount_words TEXT,
        company_snapshot TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // A Bill No. can exist only once per user (case-insensitive) — this is what protects old bills from being overwritten
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_dv_inv_owner_bill ON dv_invoices (owner_user_id, LOWER(bill_no))",
    "CREATE INDEX IF NOT EXISTS idx_dv_inv_owner_date ON dv_invoices (owner_user_id, invoice_date DESC, id DESC)"
];

/* ─────────────────────── 2. SUPER-ADMIN PRESET DEFAULTS ─────────────────── */
const DEFAULT_SETTINGS = {
    companyName: 'DV ENTERPRISES',
    address: 'Garhpura, Begusarai',
    gstin: '100PLPK1248J1ZP',
    mobile: '9939296463, 8340597183',
    bankName: 'UCO Bank',
    branch: 'Manjhaul',
    ifsc: 'UCBA0001199',
    accountNo: '11990210001653',
    cgstPct: 2.5,
    sgstPct: 2.5,
    roundOff: true,
    defaultCustomer: '',
    defaultBlock: '',
    defaultDistrict: ''
};

function sanitizeSettings(b, base) {
    b = b || {};
    const cur = Object.assign({}, DEFAULT_SETTINGS, base || {});
    const txt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const out = {
        companyName: txt(b.companyName != null ? b.companyName : cur.companyName, 120),
        address: txt(b.address != null ? b.address : cur.address, 250),
        gstin: txt(b.gstin != null ? b.gstin : cur.gstin, 20).toUpperCase(),
        mobile: txt(b.mobile != null ? b.mobile : cur.mobile, 80),
        bankName: txt(b.bankName != null ? b.bankName : cur.bankName, 80),
        branch: txt(b.branch != null ? b.branch : cur.branch, 80),
        ifsc: txt(b.ifsc != null ? b.ifsc : cur.ifsc, 15).toUpperCase(),
        accountNo: txt(b.accountNo != null ? b.accountNo : cur.accountNo, 25),
        cgstPct: b.cgstPct != null && b.cgstPct !== '' ? Number(b.cgstPct) : Number(cur.cgstPct),
        sgstPct: b.sgstPct != null && b.sgstPct !== '' ? Number(b.sgstPct) : Number(cur.sgstPct),
        roundOff: b.roundOff != null ? (b.roundOff === true || b.roundOff === 'true' || b.roundOff === 1 || b.roundOff === '1') : !!cur.roundOff,
        defaultCustomer: txt(b.defaultCustomer != null ? b.defaultCustomer : cur.defaultCustomer, 255),
        defaultBlock: txt(b.defaultBlock != null ? b.defaultBlock : cur.defaultBlock, 120),
        defaultDistrict: txt(b.defaultDistrict != null ? b.defaultDistrict : cur.defaultDistrict, 120)
    };
    if (!out.companyName) return { error: 'Company name is required.' };
    if (!out.address) return { error: 'Address is required.' };
    if (out.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(out.ifsc)) return { error: 'IFSC must look like UCBA0001199 (4 letters, a zero, 6 letters/digits).' };
    if (out.accountNo && !/^[0-9]{6,25}$/.test(out.accountNo)) return { error: 'Account number must be 6–25 digits.' };
    for (const k of ['cgstPct', 'sgstPct']) {
        if (!isFinite(out[k]) || out[k] < 0 || out[k] > 50) return { error: (k === 'cgstPct' ? 'CGST' : 'SGST') + ' % must be between 0 and 50.' };
        out[k] = Math.round(out[k] * 100) / 100;
    }
    return { value: out };
}

/* ───────────────────────── 3. CALCULATION ENGINE ────────────────────────── */
// All money maths is done in integer paise, so 2880 × 2.5 % is exactly 72.00 and there is no floating-point drift.
const toPaise = (rupees) => Math.round(rupees * 100);
const fromPaise = (p) => p / 100;

function calc(items, cgstPct, sgstPct, roundOff) {
    let taxP = 0, cgP = 0, sgP = 0;
    const rows = items.map((it) => {
        const t = toPaise(it.qty * it.rate);                 // taxable amount
        const c = Math.round(t * cgstPct / 100);             // CGST amount
        const s = Math.round(t * sgstPct / 100);             // SGST amount
        taxP += t; cgP += c; sgP += s;
        return Object.assign({}, it, {
            taxable: fromPaise(t), cgstPct: cgstPct, cgstAmt: fromPaise(c),
            sgstPct: sgstPct, sgstAmt: fromPaise(s), total: fromPaise(t + c + s)
        });
    });
    const totalP = taxP + cgP + sgP;
    const grandP = roundOff ? Math.round(totalP / 100) * 100 : totalP;
    return {
        rows: rows,
        taxableTotal: fromPaise(taxP), cgstTotal: fromPaise(cgP), sgstTotal: fromPaise(sgP),
        totalBeforeRound: fromPaise(totalP), roundOff: fromPaise(grandP - totalP), grandTotal: fromPaise(grandP)
    };
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }
function below1000(n) { return (n >= 100 ? ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? below100(n % 100) : ''); }
// Indian numbering (thousand, lakh, crore) — lower-case, matches "six thousand five hundred ninety four" in the sample bill
function amountInWords(amount) {
    const paiseTotal = Math.round(Math.abs(amount) * 100);
    let rupees = Math.floor(paiseTotal / 100);
    const paise = paiseTotal % 100;
    if (rupees === 0 && paise === 0) return 'zero';
    const parts = [];
    const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
    const lakh = Math.floor(rupees / 100000); rupees %= 100000;
    const thousand = Math.floor(rupees / 1000); rupees %= 1000;
    if (crore) parts.push(below1000(crore) + ' crore');
    if (lakh) parts.push(below100(lakh) + ' lakh');
    if (thousand) parts.push(below100(thousand) + ' thousand');
    if (rupees) parts.push(below1000(rupees));
    let words = parts.join(' ');
    if (paise) words += (words ? ' and ' : '') + below100(paise) + ' paise';
    return words;
}

/* ───────────────────── 4. INPUT VALIDATION (server is the authority) ────── */
function cleanText(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 255);
}

function parseInvoiceBody(b, settings) {
    b = b || {};
    const billNo = cleanText(b.billNo, 40);
    if (!billNo) return { error: 'Bill number is required.' };
    const date = String(b.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
        return { error: 'Please enter a valid invoice date.' };
    }
    if (!Array.isArray(b.items) || !b.items.length) return { error: 'Add at least one material row.' };
    if (b.items.length > 60) return { error: 'An invoice can have at most 60 rows.' };
    const items = [];
    for (let i = 0; i < b.items.length; i++) {
        const r = b.items[i] || {};
        const name = cleanText(r.name, 200);
        const qty = Number(r.qty), rate = Number(r.rate);
        const blank = !name && (r.qty === '' || r.qty == null) && (r.rate === '' || r.rate == null);
        if (blank) continue;                                  // fully empty row → ignored
        if (!name) return { error: 'Row ' + (i + 1) + ': material name is required.' };
        if (!isFinite(qty) || qty <= 0 || qty > 1e7) return { error: 'Row ' + (i + 1) + ': quantity must be greater than 0.' };
        if (!isFinite(rate) || rate < 0 || rate > 1e8) return { error: 'Row ' + (i + 1) + ': rate must be 0 or more.' };
        items.push({ name: name, qty: Math.round(qty * 1000) / 1000, unit: cleanText(r.unit, 20), rate: Math.round(rate * 100) / 100 });
    }
    if (!items.length) return { error: 'Add at least one material row.' };
    const c = calc(items, settings.cgstPct, settings.sgstPct, settings.roundOff);
    if (c.grandTotal > 99999999999) return { error: 'Invoice total is too large.' };
    return {
        value: {
            billNo: billNo, date: date,
            customer: cleanText(b.customer, 255), block: cleanText(b.block, 120), district: cleanText(b.district, 120),
            transport: cleanText(b.transport, 120), vehicle: cleanText(b.vehicle, 60),
            calc: c, words: amountInWords(c.grandTotal)
        }
    };
}

function rowOut(r, full) {
    const o = {
        id: r.id, billNo: r.bill_no, date: r.invoiceDate, customer: r.customer_name || '',
        grandTotal: Number(r.grand_total), createdAt: r.created_at, updatedAt: r.updated_at
    };
    if (full) {
        let items = [], company = null;
        try { items = JSON.parse(r.items); } catch (e) { items = []; }
        try { company = r.company_snapshot ? JSON.parse(r.company_snapshot) : null; } catch (e) { company = null; }
        Object.assign(o, {
            block: r.block_name || '', district: r.district_name || '', transport: r.transport_mode || '', vehicle: r.vehicle_no || '',
            items: items, taxableTotal: Number(r.taxable_total), cgstTotal: Number(r.cgst_total), sgstTotal: Number(r.sgst_total),
            roundOff: Number(r.round_off), words: r.amount_words || '', company: company
        });
    }
    return o;
}

const SEL_LIST = `id, bill_no, to_char(invoice_date,'YYYY-MM-DD') AS "invoiceDate", customer_name, grand_total, created_at, updated_at`;
const SEL_FULL = SEL_LIST + `, block_name, district_name, transport_mode, vehicle_no, items, taxable_total, cgst_total, sgst_total, round_off, amount_words, company_snapshot`;

/* ───────────────────────────── 5. ROUTES ────────────────────────────────── */
function install(app, ctx) {
    // ctx = { dbq, requireRole, getAuthUser, asyncRoute, noStore, escapeLike, findStaticFile, auditPii }
    const { dbq, requireRole, getAuthUser, asyncRoute, noStore, escapeLike, findStaticFile } = ctx;
    const audit = ctx.auditPii || function () {};

    async function loadSettings() {
        const rows = await dbq("SELECT data FROM dv_settings WHERE skey = 'invoice'", []);
        let saved = {};
        if (rows.length) { try { saved = JSON.parse(rows[0].data) || {}; } catch (e) { saved = {}; } }
        const s = sanitizeSettings(saved, DEFAULT_SETTINGS);
        return s.value || Object.assign({}, DEFAULT_SETTINGS);
    }

    // ── The page itself. A static shell (no secrets) — every byte of data comes from the JWT-protected /api/dv routes.
    app.get('/dv-invoice', function (req, res) {
        const f = findStaticFile('dv-invoice.html');
        if (!f) return res.status(404).type('text').send('DV invoice page not found. Place dv-invoice.html next to server.js.');
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');          // the login hand-off token lives in the URL fragment; never leak it
        res.sendFile(f);
    });

    // ── Gate for every Option-B user route: valid material-user JWT + active + mapped to Option B (checked live in the DB,
    //    so the Super Admin switching/blocking a user takes effect on the very next request).
    const dvUser = asyncRoute(async function (req, res, next) {
        const auth = getAuthUser(req);
        if (!auth || auth.role !== 'material_user' || !auth.userId) {
            return res.status(401).json({ error: 'Login is required — your session may have expired. Please log in again.' });
        }
        const rows = await dbq('SELECT userid, name, village, mobile, status, invoice_version FROM material_users WHERE userid = ?', [String(auth.userId)]);
        if (!rows.length) return res.status(401).json({ error: 'This account no longer exists. Please contact the administrator.', accountDeleted: true });
        const u = rows[0];
        if (u.status === 'blocked') return res.status(403).json({ error: 'This ID has been blocked by the administrator.' });
        if (String(u.invoice_version || 'A') !== 'B') {
            return res.status(403).json({ error: 'This account is not enabled for the DV Enterprises invoice format.', code: 'NOT_OPTION_B' });
        }
        req.dvUser = { userId: u.userid, name: u.name, village: u.village, mobile: u.mobile };
        next();
    });

    // ── Who am I + the Super-Admin presets (read-only for the user)
    app.get('/api/dv/me', noStore, dvUser, asyncRoute(async (req, res) => {
        res.json({ user: req.dvUser, settings: await loadSettings() });
    }));

    // ── List / instant search by Bill No.  GET /api/dv/invoices?q=50
    app.get('/api/dv/invoices', noStore, dvUser, asyncRoute(async (req, res) => {
        const q = cleanText(req.query.q, 40);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const rows = q
            ? await dbq("SELECT " + SEL_LIST + " FROM dv_invoices WHERE owner_user_id = ? AND bill_no ILIKE ? ESCAPE '\\' ORDER BY (LOWER(bill_no) = LOWER(?)) DESC, invoice_date DESC, id DESC LIMIT " + limit,
                [req.dvUser.userId, '%' + escapeLike(q) + '%', q])
            : await dbq("SELECT " + SEL_LIST + " FROM dv_invoices WHERE owner_user_id = ? ORDER BY invoice_date DESC, id DESC LIMIT " + limit, [req.dvUser.userId]);
        res.json(rows.map(r => rowOut(r, false)));
    }));

    app.get('/api/dv/invoices/:id', noStore, dvUser, asyncRoute(async (req, res) => {
        const rows = await dbq("SELECT " + SEL_FULL + " FROM dv_invoices WHERE id = ? AND owner_user_id = ?", [parseInt(req.params.id, 10) || 0, req.dvUser.userId]);
        if (!rows.length) return res.status(404).json({ error: 'Invoice not found.' });
        res.json(rowOut(rows[0], true));
    }));

    const isDup = (e) => e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message || ''));
    const insertSql = `INSERT INTO dv_invoices (owner_user_id, bill_no, invoice_date, customer_name, block_name, district_name, transport_mode, vehicle_no,
                       items, taxable_total, cgst_total, sgst_total, round_off, grand_total, amount_words, company_snapshot)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`;
    const insertParams = (owner, v, settings) => [owner, v.billNo, v.date, v.customer, v.block, v.district, v.transport, v.vehicle,
        JSON.stringify(v.calc.rows), v.calc.taxableTotal, v.calc.cgstTotal, v.calc.sgstTotal, v.calc.roundOff, v.calc.grandTotal, v.words, JSON.stringify(settings)];

    // ── SAVE (new). Never overwrites: a Bill No. that already exists is refused with 409.
    app.post('/api/dv/invoices', dvUser, asyncRoute(async (req, res) => {
        const settings = await loadSettings();
        const p = parseInvoiceBody(req.body, settings);
        if (p.error) return res.status(400).json({ error: p.error });
        try {
            const r = await dbq(insertSql, insertParams(req.dvUser.userId, p.value, settings));
            return res.status(201).json({ success: true, mode: 'created', id: r[0].id, billNo: p.value.billNo });
        } catch (e) {
            if (isDup(e)) return res.status(409).json({ error: 'Bill No. ' + p.value.billNo + ' is already saved. Open it from the list to edit it, or use a different Bill No.', code: 'DUPLICATE_BILL' });
            throw e;
        }
    }));

    // ── EDIT with the versioning rule:
    //    • same Bill No.      → that record is updated in place
    //    • DIFFERENT Bill No. → a NEW record is inserted; the original (e.g. 500) is left exactly as it was
    app.put('/api/dv/invoices/:id', dvUser, asyncRoute(async (req, res) => {
        const id = parseInt(req.params.id, 10) || 0;
        const cur = await dbq('SELECT id, bill_no FROM dv_invoices WHERE id = ? AND owner_user_id = ?', [id, req.dvUser.userId]);
        if (!cur.length) return res.status(404).json({ error: 'The invoice you are editing no longer exists. Save it as a new bill instead.', code: 'GONE' });
        const settings = await loadSettings();
        const p = parseInvoiceBody(req.body, settings);
        if (p.error) return res.status(400).json({ error: p.error });
        const sameNo = String(cur[0].bill_no).toLowerCase() === p.value.billNo.toLowerCase();
        try {
            if (!sameNo) {
                const r = await dbq(insertSql, insertParams(req.dvUser.userId, p.value, settings));
                audit(req, 'dv_invoice_fork', req.dvUser.userId, 'from=' + cur[0].bill_no + ' to=' + p.value.billNo);
                return res.status(201).json({ success: true, mode: 'created', id: r[0].id, billNo: p.value.billNo, previousBillNo: cur[0].bill_no });
            }
            const v = p.value;
            await dbq(`UPDATE dv_invoices SET bill_no=?, invoice_date=?, customer_name=?, block_name=?, district_name=?, transport_mode=?, vehicle_no=?,
                       items=?, taxable_total=?, cgst_total=?, sgst_total=?, round_off=?, grand_total=?, amount_words=?, company_snapshot=?, updated_at=CURRENT_TIMESTAMP
                       WHERE id=? AND owner_user_id=?`,
                [v.billNo, v.date, v.customer, v.block, v.district, v.transport, v.vehicle, JSON.stringify(v.calc.rows), v.calc.taxableTotal, v.calc.cgstTotal,
                 v.calc.sgstTotal, v.calc.roundOff, v.calc.grandTotal, v.words, JSON.stringify(settings), id, req.dvUser.userId]);
            return res.json({ success: true, mode: 'updated', id: id, billNo: v.billNo });
        } catch (e) {
            if (isDup(e)) return res.status(409).json({ error: 'Bill No. ' + p.value.billNo + ' is already saved. Choose a different Bill No. — the original bill ' + cur[0].bill_no + ' is untouched.', code: 'DUPLICATE_BILL' });
            throw e;
        }
    }));

    app.delete('/api/dv/invoices/:id', dvUser, asyncRoute(async (req, res) => {
        const r = await dbq('DELETE FROM dv_invoices WHERE id = ? AND owner_user_id = ? RETURNING bill_no', [parseInt(req.params.id, 10) || 0, req.dvUser.userId]);
        if (!r.length) return res.status(404).json({ error: 'Invoice not found.' });
        audit(req, 'dv_invoice_delete', req.dvUser.userId, 'bill=' + r[0].bill_no);
        res.json({ success: true, billNo: r[0].bill_no });
    }));

    // ── Super Admin: company / GST / bank presets
    app.get('/api/admin/dv-settings', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        res.json(await loadSettings());
    }));
    app.put('/api/admin/dv-settings', requireRole('admin'), asyncRoute(async (req, res) => {
        const s = sanitizeSettings(req.body, await loadSettings());
        if (s.error) return res.status(400).json({ error: s.error });
        await dbq(`INSERT INTO dv_settings (skey, data, updated_at) VALUES ('invoice', ?, CURRENT_TIMESTAMP)
                   ON CONFLICT (skey) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`, [JSON.stringify(s.value)]);
        audit(req, 'dv_settings_set', 'dv_settings', 'company=' + s.value.companyName);
        res.json(s.value);
    }));
}

function normVersion(v) { return String(v == null ? '' : v).trim().toUpperCase() === 'B' ? 'B' : 'A'; }

module.exports = { normVersion, SCHEMA_SQL, DEFAULT_SETTINGS, install, calc, amountInWords, sanitizeSettings, parseInvoiceBody };
