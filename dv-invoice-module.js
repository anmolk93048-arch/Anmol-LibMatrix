/* ============================================================================
   dv-invoice-module.js  —  "Invoice Session B" (custom GST invoice, Session-A look & feel)
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
    // (1) Super-Admin mapping: which invoice session a user gets. 'A' = standard Invoice Session A (default), 'B' = Invoice Session B
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
    "CREATE INDEX IF NOT EXISTS idx_dv_inv_owner_date ON dv_invoices (owner_user_id, invoice_date DESC, id DESC)",
    // (4) One company profile PER Session-B user — editing one user's profile can never touch another user's
    `CREATE TABLE IF NOT EXISTS dv_profiles (
        user_id VARCHAR(50) PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // (5) Invoice Plans (set by the Super Admin), per-user subscription (valid THROUGH expires_at) and Razorpay plan payments
    `CREATE TABLE IF NOT EXISTS dv_plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        description TEXT,
        days INTEGER NOT NULL,
        price NUMERIC(10,2) NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS dv_subscriptions (
        user_id VARCHAR(50) PRIMARY KEY,
        plan_id INTEGER,
        plan_name VARCHAR(80),
        expires_at DATE NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS dv_plan_payments (
        order_id VARCHAR(80) PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        plan_id INTEGER,
        plan_name VARCHAR(80),
        days INTEGER NOT NULL,
        amount NUMERIC(10,2) NOT NULL,
        status VARCHAR(12) DEFAULT 'created',
        payment_id VARCHAR(80),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        paid_at TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS dv_plan_log (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        plan_name VARCHAR(80),
        action VARCHAR(20) NOT NULL,
        days INTEGER,
        amount NUMERIC(10,2),
        source VARCHAR(12) NOT NULL,
        expires_after DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // The standard ₹199 / 30-day VIP plan — created once, only while NO plan exists yet (the Super Admin can edit / replace it later)
    `INSERT INTO dv_plans (name, description, days, price, active)
        SELECT 'VIP Plan', '30 Days VIP — unlimited invoices, bills & PDFs for ₹199', 30, 199, TRUE
        WHERE NOT EXISTS (SELECT 1 FROM dv_plans)`
];

/* ───────── plan / expiry date helpers (all in IST, whole days; a plan is valid THROUGH its expiry date) ───────── */
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const dayNum = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);
const addDays = (d, n) => new Date((dayNum(d) + n) * 86400000).toISOString().slice(0, 10);
const NOTICE_DAYS = 5;
function subState(row) {
    if (!row || !row.expires) return { state: 'none', locked: false, daysLeft: null, expires: null, planName: '' };
    const left = dayNum(row.expires) - dayNum(istToday());
    return { state: left < 0 ? 'expired' : (left <= NOTICE_DAYS ? 'expiring' : 'active'), locked: left < 0, daysLeft: left, expires: row.expires, planName: row.plan_name || '' };
}
// new expiry after buying / being granted `days` days: renewing early adds to the remaining time, an expired plan restarts today
function nextExpiry(currentExpires, days) {
    const today = istToday();
    return (currentExpires && dayNum(currentExpires) >= dayNum(today)) ? addDays(currentExpires, days) : addDays(today, days - 1);
}

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
    userEditable: false,         // Session B presets are ALWAYS locked: users cannot change company / bank / tax-rate fields on their bill
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
        userEditable: false,                                   // locked for good — kept in the object only for older clients
        defaultCustomer: txt(b.defaultCustomer != null ? b.defaultCustomer : cur.defaultCustomer, 255),
        defaultBlock: txt(b.defaultBlock != null ? b.defaultBlock : cur.defaultBlock, 120),
        defaultDistrict: txt(b.defaultDistrict != null ? b.defaultDistrict : cur.defaultDistrict, 120)
    };
    if (!out.companyName) return { error: 'Company name is required.' };
    if (!out.address) return { error: 'Address is required.' };
    if (out.gstin && !/^[0-9A-Z]{10,15}$/.test(out.gstin)) return { error: 'GSTIN must be 10–15 letters/digits (e.g. 10ABCDE1234F1Z5).' };
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
        const t = toPaise(it.qty * it.rate);                 // taxable amount = qty × rate
        // a row may carry its own GST slab (it.gst = total %, split equally into CGST + SGST); otherwise the invoice rates apply
        const rc = it.gst != null ? it.gst / 2 : cgstPct, rs = it.gst != null ? it.gst / 2 : sgstPct;
        const c = Math.round(t * rc / 100);                  // CGST amount
        const s = Math.round(t * rs / 100);                  // SGST amount
        taxP += t; cgP += c; sgP += s;
        return Object.assign({}, it, {
            taxable: fromPaise(t), cgstPct: rc, cgstAmt: fromPaise(c),
            sgstPct: rs, sgstAmt: fromPaise(s), total: fromPaise(t + c + s)
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
        const item = { name: name, qty: Math.round(qty * 1000) / 1000, unit: cleanText(r.unit, 20), rate: Math.round(rate * 100) / 100 };
        // Per-item GST % typed by the user (split equally into CGST + SGST). Blank → the locked profile rate is used.
        if (r.gst !== '' && r.gst != null) {
            const g = Number(r.gst);
            if (!isFinite(g) || g < 0 || g > 100) return { error: 'Row ' + (i + 1) + ': GST % must be between 0 and 100.' };
            item.gst = Math.round(g * 100) / 100;
        }
        items.push(item);
    }
    if (!items.length) return { error: 'Add at least one material row.' };
    // Company / bank / tax-rate fields ALWAYS come from the Super-Admin "Session B Presets". Anything a client sends in b.company is ignored.
    const company = settings;
    const c = calc(items, company.cgstPct, company.sgstPct, company.roundOff);
    if (c.grandTotal > 99999999999) return { error: 'Invoice total is too large.' };
    return {
        value: {
            billNo: billNo, date: date,
            customer: cleanText(b.customer, 255), block: cleanText(b.block, 120), district: cleanText(b.district, 120),
            transport: cleanText(b.transport, 120), vehicle: cleanText(b.vehicle, 60),
            company: company, calc: c, words: amountInWords(c.grandTotal)
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
    const crypto = require('crypto');

    // The DEFAULT template (Super Admin → Session B → "Default template"). Copied into a user's own profile when the user is mapped to B.
    async function loadDefaults() {
        const rows = await dbq("SELECT data FROM dv_settings WHERE skey = 'invoice'", []);
        let saved = {};
        if (rows.length) { try { saved = JSON.parse(rows[0].data) || {}; } catch (e) { saved = {}; } }
        const s = sanitizeSettings(saved, DEFAULT_SETTINGS);
        return s.value || Object.assign({}, DEFAULT_SETTINGS);
    }
    // The company profile of ONE user: their own saved profile, else the default template.
    async function loadSettings(userId) {
        const base = await loadDefaults();
        if (!userId) return base;
        const rows = await dbq('SELECT data FROM dv_profiles WHERE LOWER(user_id) = LOWER(?)', [String(userId)]);
        if (!rows.length) return base;
        let saved = {}; try { saved = JSON.parse(rows[0].data) || {}; } catch (e) { saved = {}; }
        const s = sanitizeSettings(saved, base);
        return s.value || base;
    }
    async function loadSub(userId) {
        const r = await dbq("SELECT plan_id, plan_name, to_char(expires_at,'YYYY-MM-DD') AS expires FROM dv_subscriptions WHERE LOWER(user_id) = LOWER(?)", [String(userId)]);
        return r[0] || null;
    }
    async function planLog(userId, planName, action, days, amount, source, expires) {
        try { await dbq('INSERT INTO dv_plan_log (user_id, plan_name, action, days, amount, source, expires_after) VALUES (?,?,?,?,?,?,?)', [String(userId), planName || '', action, days || null, amount == null ? null : amount, source, expires || null]); } catch (e) { /* history is informational only */ }
    }
    async function grantDays(userId, planId, planName, days, source, amount) {
        const cur = await loadSub(userId);
        const exp = nextExpiry(cur && cur.expires, days);
        await dbq(`INSERT INTO dv_subscriptions (user_id, plan_id, plan_name, expires_at, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
                   ON CONFLICT (user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, plan_name = EXCLUDED.plan_name, expires_at = EXCLUDED.expires_at, updated_at = CURRENT_TIMESTAMP`,
            [String(userId), planId || null, planName || 'Custom', exp]);
        await planLog(userId, planName || 'Custom', cur && cur.expires ? 'extended' : 'started', days, amount, source || 'admin', exp);
        return exp;
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
        const rows = await dbq('SELECT userid, name, village, mobile, photo, status, invoice_version FROM material_users WHERE userid = ?', [String(auth.userId)]);
        if (!rows.length) return res.status(401).json({ error: 'This account no longer exists. Please contact the administrator.', accountDeleted: true });
        const u = rows[0];
        if (u.status === 'blocked') return res.status(403).json({ error: 'This ID has been blocked by the administrator.' });
        if (String(u.invoice_version || 'A') !== 'B') {
            return res.status(403).json({ error: 'This account is not mapped to Invoice Session B.', code: 'NOT_OPTION_B' });
        }
        req.dvUser = { userId: u.userid, name: u.name, village: u.village, mobile: u.mobile, photo: u.photo || '' };
        next();
    });

    // After the plan has expired, creating / editing / deleting bills is blocked (HTTP 402). Listing, opening, printing and PDF still work.
    const dvActive = asyncRoute(async function (req, res, next) {
        const st = subState(await loadSub(req.dvUser.userId));
        if (st.locked) {
            return res.status(402).json({ error: 'Please activate your plan to continue. Your Invoice Plan expired on ' + st.expires + '; all your saved bills and data are safe.', code: 'PLAN_EXPIRED', expires: st.expires });
        }
        next();
    });
    async function plansForUser() {
        const rows = await dbq('SELECT id, name, description, days, price FROM dv_plans WHERE active = TRUE ORDER BY price ASC, days ASC, id ASC', []);
        return rows.map(p => ({ id: p.id, name: p.name, description: p.description || '', days: Number(p.days), price: Number(p.price) }));
    }

    // ── Who am I + MY company profile (read-only for the user) + my plan status + plans I can buy
    app.get('/api/dv/me', noStore, dvUser, asyncRoute(async (req, res) => {
        res.json({ user: req.dvUser, settings: await loadSettings(req.dvUser.userId), sub: subState(await loadSub(req.dvUser.userId)), plans: await plansForUser() });
    }));

    // ── Plan purchase through Razorpay (amount is fixed server-side from the plan; one-time-use order)
    app.post('/api/dv/plan/order', dvUser, asyncRoute(async (req, res) => {
        const plan = (await dbq('SELECT id, name, days, price FROM dv_plans WHERE id = ? AND active = TRUE', [parseInt(req.body && req.body.planId, 10) || 0]))[0];
        if (!plan) return res.status(404).json({ error: 'This plan is not available.' });
        const amt = Math.round(Number(plan.price) * 100) / 100;
        const uid = req.dvUser.userId;
        if (amt <= 0) {                                      // a free plan activates at once
            const exp = await grantDays(uid, plan.id, plan.name, Number(plan.days));
            return res.json({ free: true, sub: subState({ plan_name: plan.name, expires: exp }) });
        }
        if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET || !ctx.razorpayRequest) {
            return res.status(501).json({ error: 'Online payment is not set up yet. Please contact the administrator.' });
        }
        let order;
        try { order = await ctx.razorpayRequest('/v1/orders', { amount: Math.round(amt * 100), currency: 'INR', receipt: ('dvp_' + uid + '_' + Date.now()).slice(0, 40) }); }
        catch (e) { return res.status(502).json({ error: 'Could not create the payment order: ' + e.message }); }
        await dbq('INSERT INTO dv_plan_payments (order_id, user_id, plan_id, plan_name, days, amount) VALUES (?,?,?,?,?,?)', [order.id, uid, plan.id, plan.name, Number(plan.days), amt]);
        res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, plan: { name: plan.name, days: Number(plan.days), price: amt } });
    }));
    app.post('/api/dv/plan/verify', dvUser, asyncRoute(async (req, res) => {
        const secret = process.env.PAYMENT_API_SECRET;
        if (!secret) return res.status(501).json({ error: 'Online payment is not set up yet.' });
        const b = req.body || {};
        const oid = String(b.razorpay_order_id || ''), pid = String(b.razorpay_payment_id || ''), sig = String(b.razorpay_signature || '');
        if (!oid || !pid || !sig) return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
        const expected = crypto.createHmac('sha256', secret).update(oid + '|' + pid).digest('hex');
        const x = Buffer.from(expected), y = Buffer.from(sig);
        if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return res.status(400).json({ error: 'Payment signature mismatch — the plan was not activated.' });
        const uid = req.dvUser.userId;
        const row = (await dbq('SELECT order_id, plan_id, plan_name, days, amount, status, payment_id FROM dv_plan_payments WHERE order_id = ? AND LOWER(user_id) = LOWER(?)', [oid, uid]))[0];
        if (!row) return res.status(400).json({ error: 'This payment order was not found for your account.' });
        if (row.status === 'paid') {                          // idempotent: a repeated verify never adds days twice
            if (row.payment_id !== pid) return res.status(400).json({ error: 'This order was already paid with a different payment.' });
            return res.json({ success: true, already: true, sub: subState(await loadSub(uid)) });
        }
        if (ctx.razorpayConfirmPayment) {
            try { await ctx.razorpayConfirmPayment(oid, pid, Number(row.amount)); }
            catch (e) { return res.status(402).json({ error: e.message }); }
        }
        const claimed = await dbq("UPDATE dv_plan_payments SET status='paid', payment_id=?, paid_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='created' RETURNING order_id", [pid, oid]);
        if (claimed.length) await grantDays(uid, row.plan_id, row.plan_name, Number(row.days), 'razorpay', Number(row.amount));
        audit(req, 'dv_plan_paid', uid, 'plan=' + row.plan_name + ' amount=' + row.amount);
        res.json({ success: true, sub: subState(await loadSub(uid)) });
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
    const insertParams = (owner, v) => [owner, v.billNo, v.date, v.customer, v.block, v.district, v.transport, v.vehicle,
        JSON.stringify(v.calc.rows), v.calc.taxableTotal, v.calc.cgstTotal, v.calc.sgstTotal, v.calc.roundOff, v.calc.grandTotal, v.words, JSON.stringify(v.company)];

    // ── SAVE (new). Never overwrites: a Bill No. that already exists is refused with 409.
    app.post('/api/dv/invoices', dvUser, dvActive, asyncRoute(async (req, res) => {
        const settings = await loadSettings(req.dvUser.userId);
        const p = parseInvoiceBody(req.body, settings);
        if (p.error) return res.status(400).json({ error: p.error });
        try {
            const r = await dbq(insertSql, insertParams(req.dvUser.userId, p.value));
            return res.status(201).json({ success: true, mode: 'created', id: r[0].id, billNo: p.value.billNo });
        } catch (e) {
            if (isDup(e)) return res.status(409).json({ error: 'Bill No. ' + p.value.billNo + ' is already saved. Open it from the list to edit it, or use a different Bill No.', code: 'DUPLICATE_BILL' });
            throw e;
        }
    }));

    // ── EDIT with the versioning rule:
    //    • same Bill No.      → that record is updated in place
    //    • DIFFERENT Bill No. → a NEW record is inserted; the original (e.g. 500) is left exactly as it was
    app.put('/api/dv/invoices/:id', dvUser, dvActive, asyncRoute(async (req, res) => {
        const id = parseInt(req.params.id, 10) || 0;
        const cur = await dbq('SELECT id, bill_no FROM dv_invoices WHERE id = ? AND owner_user_id = ?', [id, req.dvUser.userId]);
        if (!cur.length) return res.status(404).json({ error: 'The invoice you are editing no longer exists. Save it as a new bill instead.', code: 'GONE' });
        const settings = await loadSettings(req.dvUser.userId);
        const p = parseInvoiceBody(req.body, settings);
        if (p.error) return res.status(400).json({ error: p.error });
        const sameNo = String(cur[0].bill_no).toLowerCase() === p.value.billNo.toLowerCase();
        try {
            if (!sameNo) {
                const r = await dbq(insertSql, insertParams(req.dvUser.userId, p.value));
                audit(req, 'dv_invoice_fork', req.dvUser.userId, 'from=' + cur[0].bill_no + ' to=' + p.value.billNo);
                return res.status(201).json({ success: true, mode: 'created', id: r[0].id, billNo: p.value.billNo, previousBillNo: cur[0].bill_no });
            }
            const v = p.value;
            await dbq(`UPDATE dv_invoices SET bill_no=?, invoice_date=?, customer_name=?, block_name=?, district_name=?, transport_mode=?, vehicle_no=?,
                       items=?, taxable_total=?, cgst_total=?, sgst_total=?, round_off=?, grand_total=?, amount_words=?, company_snapshot=?, updated_at=CURRENT_TIMESTAMP
                       WHERE id=? AND owner_user_id=?`,
                [v.billNo, v.date, v.customer, v.block, v.district, v.transport, v.vehicle, JSON.stringify(v.calc.rows), v.calc.taxableTotal, v.calc.cgstTotal,
                 v.calc.sgstTotal, v.calc.roundOff, v.calc.grandTotal, v.words, JSON.stringify(v.company), id, req.dvUser.userId]);
            return res.json({ success: true, mode: 'updated', id: id, billNo: v.billNo });
        } catch (e) {
            if (isDup(e)) return res.status(409).json({ error: 'Bill No. ' + p.value.billNo + ' is already saved. Choose a different Bill No. — the original bill ' + cur[0].bill_no + ' is untouched.', code: 'DUPLICATE_BILL' });
            throw e;
        }
    }));

    app.delete('/api/dv/invoices/:id', dvUser, dvActive, asyncRoute(async (req, res) => {
        const r = await dbq('DELETE FROM dv_invoices WHERE id = ? AND owner_user_id = ? RETURNING bill_no', [parseInt(req.params.id, 10) || 0, req.dvUser.userId]);
        if (!r.length) return res.status(404).json({ error: 'Invoice not found.' });
        audit(req, 'dv_invoice_delete', req.dvUser.userId, 'bill=' + r[0].bill_no);
        res.json({ success: true, billNo: r[0].bill_no });
    }));

    // ── Super Admin: Session A / Session B mapping (list + bulk map by User ID)
    app.get('/api/admin/dv-mapping', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        const users = await dbq("SELECT userid, name, village, mobile, status, invoice_version FROM material_users ORDER BY id DESC", []);
        const counts = await dbq("SELECT owner_user_id, COUNT(*) AS n FROM dv_invoices GROUP BY owner_user_id", []);
        const cnt = {}; counts.forEach(r => { cnt[String(r.owner_user_id).toLowerCase()] = Number(r.n); });
        const profs = {}; (await dbq('SELECT user_id, data FROM dv_profiles', [])).forEach(r => { let d = {}; try { d = JSON.parse(r.data) || {}; } catch (e) {} profs[String(r.user_id).toLowerCase()] = d.companyName || '(saved)'; });
        const subs = {}; (await dbq("SELECT user_id, plan_name, to_char(expires_at,'YYYY-MM-DD') AS expires FROM dv_subscriptions", [])).forEach(r => { subs[String(r.user_id).toLowerCase()] = subState(r); });
        res.json(users.map(u => {
            const k = String(u.userid).toLowerCase();
            return {
                userId: u.userid, name: u.name || '', village: u.village || '', mobile: u.mobile || '', status: u.status || 'active',
                session: normVersion(u.invoice_version), invoices: cnt[k] || 0,
                profile: profs[k] || '', plan: subs[k] || subState(null)
            };
        }));
    }));
    // body: { userIds: ['MAT001', ...], session: 'A' | 'B' }  → { updated: [...], notFound: [...] }
    app.put('/api/admin/dv-mapping', requireRole('admin'), asyncRoute(async (req, res) => {
        const b = req.body || {};
        const session = normVersion(b.session);
        const raw = Array.isArray(b.userIds) ? b.userIds : String(b.userIds || '').split(/[\s,;]+/);
        const ids = Array.from(new Set(raw.map(x => cleanText(x, 50)).filter(Boolean)));
        if (!ids.length) return res.status(400).json({ error: 'Enter at least one User ID.' });
        if (ids.length > 500) return res.status(400).json({ error: 'You can map at most 500 User IDs at a time.' });
        const updated = [], notFound = [];
        for (const id of ids) {
            const r = await dbq('UPDATE material_users SET invoice_version = ? WHERE LOWER(userid) = LOWER(?) RETURNING userid', [session, id]);
            if (r.length) {
                updated.push(r[0].userid);
                // Mapping to B gives the user THEIR OWN copy of the default template, so later changes to the template or to any other user never affect them
                if (session === 'B') {
                    await dbq('INSERT INTO dv_profiles (user_id, data) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING', [r[0].userid, JSON.stringify(await loadDefaults())]);
                }
            } else notFound.push(id);
        }
        audit(req, 'dv_mapping_set', 'dv_mapping', 'session=' + session + ' count=' + updated.length);
        res.json({ success: true, session: session, updated: updated, notFound: notFound });
    }));

    // ── Super Admin: company / GST / bank presets
    app.get('/api/admin/dv-settings', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        res.json(await loadDefaults());
    }));
    app.put('/api/admin/dv-settings', requireRole('admin'), asyncRoute(async (req, res) => {
        const s = sanitizeSettings(req.body, await loadDefaults());
        if (s.error) return res.status(400).json({ error: s.error });
        await dbq(`INSERT INTO dv_settings (skey, data, updated_at) VALUES ('invoice', ?, CURRENT_TIMESTAMP)
                   ON CONFLICT (skey) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`, [JSON.stringify(s.value)]);
        audit(req, 'dv_settings_set', 'dv_settings', 'company=' + s.value.companyName);
        res.json(s.value);
    }));

    // ── Super Admin: the company profile of ONE user (GET to load, PUT to save, DELETE to fall back to the default template)
    async function userExists(id) {
        const r = await dbq('SELECT userid FROM material_users WHERE LOWER(userid) = LOWER(?)', [id]);
        return r.length ? r[0].userid : null;
    }
    app.get('/api/admin/dv-profile/:userId', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        const uid = await userExists(cleanText(req.params.userId, 50));
        if (!uid) return res.status(404).json({ error: 'User ID not found.' });
        const has = (await dbq('SELECT 1 FROM dv_profiles WHERE LOWER(user_id) = LOWER(?)', [uid])).length > 0;
        res.json({ userId: uid, hasProfile: has, settings: await loadSettings(uid) });
    }));
    app.put('/api/admin/dv-profile/:userId', requireRole('admin'), asyncRoute(async (req, res) => {
        const uid = await userExists(cleanText(req.params.userId, 50));
        if (!uid) return res.status(404).json({ error: 'User ID not found.' });
        const s = sanitizeSettings(req.body, await loadSettings(uid));
        if (s.error) return res.status(400).json({ error: s.error });
        await dbq(`INSERT INTO dv_profiles (user_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP`, [uid, JSON.stringify(s.value)]);
        audit(req, 'dv_profile_set', uid, 'company=' + s.value.companyName);
        res.json({ success: true, userId: uid, settings: s.value });
    }));
    app.delete('/api/admin/dv-profile/:userId', requireRole('admin'), asyncRoute(async (req, res) => {
        await dbq('DELETE FROM dv_profiles WHERE LOWER(user_id) = LOWER(?)', [cleanText(req.params.userId, 50)]);
        res.json({ success: true });
    }));

    // ── Super Admin: Invoice Plans
    const planOut = (p) => ({ id: p.id, name: p.name, description: p.description || '', days: Number(p.days), price: Number(p.price), active: !!p.active });
    app.get('/api/admin/dv-plans', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        res.json((await dbq('SELECT id, name, description, days, price, active FROM dv_plans ORDER BY active DESC, price ASC, id ASC', [])).map(planOut));
    }));
    app.put('/api/admin/dv-plans', requireRole('admin'), asyncRoute(async (req, res) => {
        const b = req.body || {};
        const name = cleanText(b.name, 80), desc = cleanText(b.description, 300);
        const days = parseInt(b.days, 10), price = Math.round(Number(b.price) * 100) / 100;
        if (!name) return res.status(400).json({ error: 'Plan name is required.' });
        if (!isFinite(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Plan days must be between 1 and 3650.' });
        if (!isFinite(price) || price < 0 || price > 1000000) return res.status(400).json({ error: 'Price must be between 0 and 10,00,000.' });
        const active = !(b.active === false || b.active === 'false' || b.active === 0 || b.active === '0');
        const id = parseInt(b.id, 10) || 0;
        let r;
        if (id) r = await dbq('UPDATE dv_plans SET name=?, description=?, days=?, price=?, active=? WHERE id=? RETURNING id, name, description, days, price, active', [name, desc, days, price, active, id]);
        else r = await dbq('INSERT INTO dv_plans (name, description, days, price, active) VALUES (?,?,?,?,?) RETURNING id, name, description, days, price, active', [name, desc, days, price, active]);
        if (!r.length) return res.status(404).json({ error: 'Plan not found.' });
        audit(req, 'dv_plan_set', 'dv_plans', 'plan=' + name + ' days=' + days + ' price=' + price);
        res.json(planOut(r[0]));
    }));
    app.delete('/api/admin/dv-plans/:id', requireRole('admin'), asyncRoute(async (req, res) => {
        await dbq('DELETE FROM dv_plans WHERE id = ?', [parseInt(req.params.id, 10) || 0]);
        res.json({ success: true });
    }));
    // Give / extend / set / clear the plan of one or more users.  body: { userIds, planId?, days?, mode: 'extend' | 'set' | 'clear' }
    // Plan history (status tracking) of one user: every purchase / admin grant, newest first
    async function historyOf(uid) {
        return (await dbq("SELECT plan_name, action, days, amount, source, to_char(expires_after,'YYYY-MM-DD') AS expires_after, to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS at FROM dv_plan_log WHERE LOWER(user_id) = LOWER(?) ORDER BY id DESC LIMIT 100", [String(uid)]))
            .map(r => ({ plan: r.plan_name, action: r.action, days: r.days, amount: r.amount == null ? null : Number(r.amount), source: r.source, expires: r.expires_after, at: r.at }));
    }
    app.get('/api/admin/dv-history/:userId', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        const uid = await userExists(cleanText(req.params.userId, 50));
        if (!uid) return res.status(404).json({ error: 'User not found.' });
        res.json({ userId: uid, sub: subState(await loadSub(uid)), history: await historyOf(uid) });
    }));
    app.get('/api/dv/plan/history', noStore, dvUser, asyncRoute(async (req, res) => {
        res.json({ sub: subState(await loadSub(req.dvUser.userId)), history: await historyOf(req.dvUser.userId) });
    }));
    app.post('/api/admin/dv-subscriptions', requireRole('admin'), asyncRoute(async (req, res) => {
        const b = req.body || {};
        const raw = Array.isArray(b.userIds) ? b.userIds : String(b.userIds || '').split(/[\s,;]+/);
        const ids = Array.from(new Set(raw.map(x => cleanText(x, 50)).filter(Boolean)));
        if (!ids.length) return res.status(400).json({ error: 'Enter at least one User ID.' });
        if (ids.length > 500) return res.status(400).json({ error: 'At most 500 User IDs at a time.' });
        const mode = ['extend', 'set', 'clear'].includes(b.mode) ? b.mode : 'extend';
        let plan = null, days = parseInt(b.days, 10);
        if (mode !== 'clear') {
            if (b.planId) {
                plan = (await dbq('SELECT id, name, days FROM dv_plans WHERE id = ?', [parseInt(b.planId, 10) || 0]))[0];
                if (!plan) return res.status(404).json({ error: 'Plan not found.' });
                if (!(days > 0)) days = Number(plan.days);
            }
            if (!isFinite(days) || days < 1 || days > 3650) return res.status(400).json({ error: 'Enter the number of days (1–3650) or pick a plan.' });
        }
        const done = [], notFound = [];
        for (const id of ids) {
            const uid = await userExists(id);
            if (!uid) { notFound.push(id); continue; }
            if (mode === 'clear') { await dbq('DELETE FROM dv_subscriptions WHERE LOWER(user_id) = LOWER(?)', [uid]); await planLog(uid, '', 'removed', null, null, 'admin', null); }
            else if (mode === 'set') {
                await dbq(`INSERT INTO dv_subscriptions (user_id, plan_id, plan_name, expires_at, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
                           ON CONFLICT (user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, plan_name = EXCLUDED.plan_name, expires_at = EXCLUDED.expires_at, updated_at = CURRENT_TIMESTAMP`,
                    [uid, plan ? plan.id : null, plan ? plan.name : 'Custom', addDays(istToday(), days - 1)]);
                await planLog(uid, plan ? plan.name : 'Custom', 'set', days, null, 'admin', addDays(istToday(), days - 1));
            } else await grantDays(uid, plan ? plan.id : null, plan ? plan.name : 'Custom', days);
            done.push(uid);
        }
        audit(req, 'dv_subscription_set', 'dv_subscriptions', 'mode=' + mode + ' count=' + done.length);
        res.json({ success: true, mode: mode, updated: done, notFound: notFound });
    }));
}

function normVersion(v) { return String(v == null ? '' : v).trim().toUpperCase() === 'B' ? 'B' : 'A'; }

module.exports = { subState, nextExpiry, normVersion, SCHEMA_SQL, DEFAULT_SETTINGS, install, calc, amountInWords, sanitizeSettings, parseInvoiceBody };
