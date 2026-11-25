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
        WHERE NOT EXISTS (SELECT 1 FROM dv_plans)`,
    // (6) Business categories + master item catalog (Super Admin) and each user's own rates (Session B)
    "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS dv_category_id INTEGER",
    `CREATE TABLE IF NOT EXISTS dv_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_dv_cat_name ON dv_categories (LOWER(name))",
    `CREATE TABLE IF NOT EXISTS dv_cat_items (
        id SERIAL PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES dv_categories(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        unit VARCHAR(20) NOT NULL DEFAULT 'Pcs',
        gst NUMERIC(5,2) NOT NULL DEFAULT 0
    )`,
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_dv_cat_item_name ON dv_cat_items (category_id, LOWER(name))",
    `CREATE TABLE IF NOT EXISTS dv_user_rates (
        user_id VARCHAR(50) NOT NULL,
        item_id INTEGER NOT NULL REFERENCES dv_cat_items(id) ON DELETE CASCADE,
        price NUMERIC(12,2) NOT NULL DEFAULT 0,
        gst NUMERIC(5,2) NOT NULL DEFAULT 0,
        unit VARCHAR(20),
        qty NUMERIC(12,3) NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, item_id)
    )`,
    // (7) How each bill was paid: 'cash' or 'online' (PhonePe / UPI)
    "ALTER TABLE dv_invoices ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(10) NOT NULL DEFAULT 'cash'",
    "CREATE INDEX IF NOT EXISTS idx_dv_inv_owner_pay ON dv_invoices (owner_user_id, invoice_date, payment_mode)",
    // (8) One-time starter catalog for the "Medical" category (guarded by a marker row, so items you delete later never come back; edit freely in Super Admin)
    `INSERT INTO dv_categories (name)
        SELECT 'Medical' WHERE NOT EXISTS (SELECT 1 FROM dv_settings WHERE skey = 'seed_medical_v1')
          AND NOT EXISTS (SELECT 1 FROM dv_categories WHERE LOWER(name) IN ('medical', 'medical store'))`,
    `INSERT INTO dv_cat_items (category_id, name, unit, gst)
        SELECT c.id, v.name, v.unit, v.gst
        FROM (SELECT id FROM dv_categories WHERE LOWER(name) IN ('medical', 'medical store') ORDER BY id LIMIT 1) c,
             (VALUES ('Paracetamol 500mg Tablet','Strip',5),('Paracetamol 650mg Tablet','Strip',5),('Ibuprofen 400mg Tablet','Strip',5),('Diclofenac 50mg Tablet','Strip',5),('Aceclofenac + Paracetamol Tablet','Strip',5),('Cetirizine 10mg Tablet','Strip',5),('Levocetirizine 5mg Tablet','Strip',5),('Montelukast + Levocetirizine Tablet','Strip',5),('Azithromycin 500mg Tablet','Strip',5),('Amoxicillin + Clavulanic Acid Tablet','Strip',5),('Cefixime 200mg Tablet','Strip',5),('Ciprofloxacin 500mg Tablet','Strip',5),('Metronidazole 400mg Tablet','Strip',5),('Ofloxacin + Ornidazole Tablet','Strip',5),('Pantoprazole 40mg Tablet','Strip',5),('Rabeprazole 20mg Tablet','Strip',5),('Domperidone 10mg Tablet','Strip',5),('Ondansetron 4mg Tablet','Strip',5),('Metformin 500mg Tablet','Strip',5),('Amlodipine 5mg Tablet','Strip',5),('Atenolol 50mg Tablet','Strip',5),('Telmisartan 40mg Tablet','Strip',5),('Atorvastatin 10mg Tablet','Strip',5),('Aspirin 75mg Tablet','Strip',5),('Loperamide 2mg Tablet','Strip',5),('Dicyclomine + Paracetamol Tablet','Strip',5),('Albendazole 400mg Tablet','Strip',5),('Folic Acid 5mg Tablet','Strip',5),('Calcium + Vitamin D3 Tablet','Strip',5),('Vitamin B-Complex Tablet','Strip',5),('Vitamin C 500mg Tablet','Strip',5),('Zinc 50mg Tablet','Strip',5),('Multivitamin Tablet','Strip',5),('Iron + Folic Acid Tablet','Strip',5),('Antacid Chewable Tablet','Strip',5),('Pantoprazole + Domperidone Capsule','Strip',5),('Omeprazole 20mg Capsule','Strip',5),('Amoxicillin 500mg Capsule','Strip',5),('Doxycycline 100mg Capsule','Strip',5),('Vitamin B12 Capsule','Strip',5),('Vitamin E 400mg Capsule','Strip',5),('Omega-3 Fish Oil Capsule','Strip',5),('Probiotic Capsule','Strip',5),('Itraconazole 100mg Capsule','Strip',5),('Fluconazole 150mg Tablet','Strip',5),('Paracetamol Syrup 60ml','Bottle',5),('Paracetamol Suspension 125mg/5ml','Bottle',5),('Cough Syrup (Dry) 100ml','Bottle',5),('Cough Syrup (Expectorant) 100ml','Bottle',5),('Cetirizine Syrup 60ml','Bottle',5),('Amoxicillin Dry Syrup','Bottle',5),('Azithromycin Dry Syrup','Bottle',5),('Antacid Liquid 170ml','Bottle',5),('Antacid Gel Suspension 200ml','Bottle',5),('Lactulose Solution 200ml','Bottle',5),('Digestive Enzyme Syrup 200ml','Bottle',5),('Multivitamin Syrup 200ml','Bottle',5),('Iron Syrup 200ml','Bottle',5),('Calcium Syrup 200ml','Bottle',5),('Ondansetron Syrup 30ml','Bottle',5),('Ambroxol Syrup 100ml','Bottle',5),('Zinc Syrup 100ml','Bottle',5),('Nasal Drops 10ml','Bottle',5),('Eye Drops 10ml','Bottle',5),('Ear Drops 10ml','Bottle',5),('Glycerin 100ml','Bottle',5),('Povidone Iodine Solution 100ml','Bottle',5),('Dettol Type Antiseptic Liquid 250ml','Bottle',5),('Surgical Spirit 100ml','Bottle',5),('Hydrogen Peroxide 100ml','Bottle',5),('ORS Powder Sachet (WHO) 21g','Sachet',5),('ORS Electrolyte Powder Sachet','Sachet',5),('Glucose Powder Sachet','Sachet',5),('Antacid Powder Sachet','Sachet',5),('Povidone Iodine Ointment 15g','Tube',5),('Antiseptic Cream 20g','Tube',5),('Antifungal Cream 15g','Tube',5),('Diclofenac Pain Relief Gel 30g','Tube',5),('Burn Cream 20g','Tube',5),('Antibiotic Ointment 10g','Tube',5),('Petroleum Jelly 25g','Tube',5),('Moisturising Cream 50g','Tube',5),('Adhesive Bandage (Band-Aid)','Pcs',5),('Crepe Bandage 6cm','Pcs',5),('Crepe Bandage 10cm','Pcs',5),('Roller Bandage 10cm','Pcs',5),('Elastic Knee Support','Pcs',5),('Surgical Tape 1 inch','Pcs',5),('Digital Thermometer','Pcs',5),('Mercury-free Thermometer','Pcs',5),('Syringe 2ml','Pcs',5),('Syringe 5ml','Pcs',5),('Syringe 10ml','Pcs',5),('Disposable Needle','Pcs',5),('IV Cannula 20G','Pcs',5),('Hot Water Bag','Pcs',5),('Nebulizer Mask','Pcs',5),('Blood Glucose Test Strip (50)','Pcs',5),('BP Monitor Digital','Pcs',5),('Pulse Oximeter','Pcs',5),('Cotton Roll 100g','Pcs',5),('Cotton Roll 500g','Pcs',5),('Gauze Swab Pack','Pcs',5),('Sterile Gauze Roll','Pcs',5),('Disposable Gloves (100 pcs)','Box',5),('Surgical Gloves (Sterile) Pair','Box',5),('Face Mask 3-Ply (50 pcs)','Box',5),('First Aid Kit','Box',5),('Pregnancy Test Kit','Box',5),('Cotton Buds Box','Box',5),('Hand Sanitizer 100ml','Pcs',18),('Hand Sanitizer 500ml','Pcs',18),('N95 Mask','Pcs',18),('Glucometer','Pcs',18)) AS v(name, unit, gst)
        WHERE NOT EXISTS (SELECT 1 FROM dv_settings WHERE skey = 'seed_medical_v1')
        ON CONFLICT DO NOTHING`,
    `INSERT INTO dv_settings (skey, data) VALUES ('seed_medical_v1', 'done') ON CONFLICT (skey) DO NOTHING`
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
        const hsnIn = String(r.hsn == null ? '' : r.hsn).replace(/[^0-9]/g, '').slice(0, 12);   // HSN/SAC: digits only
        if (hsnIn) item.hsn = hsnIn;
        // Per-item GST % typed by the user (split equally into CGST + SGST). Blank → the locked profile rate is used.
        if (r.gst !== '' && r.gst != null) {
            const g = Number(r.gst);
            if (!isFinite(g) || g < 0 || g > 100) return { error: 'Row ' + (i + 1) + ': GST % must be between 0 and 100.' };
            item.gst = Math.round(g * 100) / 100;
        }
        items.push(item);
    }
    if (!items.length) return { error: 'Add at least one material row.' };
    const pm = String(b.paymentMode == null ? '' : b.paymentMode).trim().toLowerCase();
    const paymentMode = (pm === 'online' || pm === 'phonepe' || pm === 'upi') ? 'online' : 'cash';
    // Company / bank / tax-rate fields ALWAYS come from the Super-Admin "Session B Presets". Anything a client sends in b.company is ignored.
    const company = settings;
    const c = calc(items, company.cgstPct, company.sgstPct, company.roundOff);
    if (c.grandTotal > 99999999999) return { error: 'Invoice total is too large.' };
    return {
        value: {
            billNo: billNo, date: date,
            customer: cleanText(b.customer, 255), block: cleanText(b.block, 120), district: cleanText(b.district, 120),
            transport: cleanText(b.transport, 120), vehicle: cleanText(b.vehicle, 60), paymentMode: paymentMode,
            company: company, calc: c, words: amountInWords(c.grandTotal)
        }
    };
}

function rowOut(r, full) {
    const o = {
        id: r.id, billNo: r.bill_no, date: r.invoiceDate, customer: r.customer_name || '',
        grandTotal: Number(r.grand_total), paymentMode: r.payment_mode === 'online' ? 'online' : 'cash', createdAt: r.created_at, updatedAt: r.updated_at
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

const SEL_LIST = `id, bill_no, to_char(invoice_date,'YYYY-MM-DD') AS "invoiceDate", customer_name, grand_total, payment_mode, created_at, updated_at`;
const SEL_FULL = SEL_LIST + `, block_name, district_name, transport_mode, vehicle_no, items, taxable_total, cgst_total, sgst_total, round_off, amount_words, company_snapshot`;

/* ───────────────────────────── 5. ROUTES ────────────────────────────────── */
let _settle = null;
function install(app, ctx) {
    // ctx = { dbq, requireRole, getAuthUser, asyncRoute, noStore, escapeLike, findStaticFile, auditPii }
    const { dbq, requireRole, getAuthUser, asyncRoute, noStore, escapeLike, findStaticFile } = ctx;
    const audit = ctx.auditPii || function () {};
    const crypto = require('crypto');

    // ── HSN / SAC sync from the Super-Admin Material Master (blob 'material_categories') ──
    // ONLY the HSN/SAC code is read from the Master. Prices, units, names, GST % and tax maths are never touched.
    const hsnKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
    async function loadMasterHsn() {
        const map = {}, list = [];
        try {
            const rows = await dbq('SELECT value FROM kv_blob WHERE "key" = ?', ['material_categories']);
            let cats = []; if (rows.length) { try { cats = JSON.parse(rows[0].value) || []; } catch (e) { cats = []; } }
            (Array.isArray(cats) ? cats : []).forEach((c) => (Array.isArray(c && c.items) ? c.items : []).forEach((m) => {
                const hsn = String(m && m.hsn != null ? m.hsn : '').replace(/[^0-9]/g, '').slice(0, 12);
                const name = String(m && m.name || '').trim(), code = String(m && m.code || '').trim();
                if (!name || !hsn) return;
                list.push({ name: name, code: code, hsn: hsn });
                [name, code ? code + '-' + name : '', code ? code + ' - ' + name : ''].forEach((k) => { k = hsnKey(k); if (k && !map[k]) map[k] = hsn; });
            }));
        } catch (e) { /* master unavailable → rows simply keep whatever HSN they already have */ }
        return { map: map, list: list };
    }
    // Fills item.hsn from the Master by material name. Rows with no match keep their own HSN (or none).
    async function applyMasterHsn(rows) {
        if (!Array.isArray(rows) || !rows.length) return;
        const m = await loadMasterHsn();
        rows.forEach((r) => { const h = m.map[hsnKey(r.name)]; if (h) r.hsn = h; });
    }

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

    // After the plan has expired, creating / editing / deleting bills is blocked (HTTP 402). Listing / opening bills (and so printing / PDF) are blocked too; the data itself stays in the database.
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
        const cu = (await dbq('SELECT c.id, c.name FROM material_users u JOIN dv_categories c ON c.id = u.dv_category_id WHERE u.userid = ?', [req.dvUser.userId]))[0];
        res.json({ user: req.dvUser, category: cu ? { id: cu.id, name: cu.name } : null, settings: await loadSettings(req.dvUser.userId), sub: subState(await loadSub(req.dvUser.userId)), plans: await plansForUser() });
    }));

    // ── Plan purchase through Razorpay (amount is fixed server-side from the plan; one-time-use order)
    app.post('/api/dv/plan/order', dvUser, asyncRoute(async (req, res) => {
        const plan = (await dbq('SELECT id, name, days, price FROM dv_plans WHERE id = ? AND active = TRUE', [parseInt(req.body && req.body.planId, 10) || 0]))[0];
        if (!plan) return res.status(404).json({ error: 'This plan is not available.' });
        const paise = Math.round(Number(plan.price) * 100);          // ONE integer amount (paise) is used for the order, the DB row and every later check
        const amt = paise / 100;
        const uid = req.dvUser.userId;
        if (amt <= 0) {                                      // a free plan activates at once
            const exp = await grantDays(uid, plan.id, plan.name, Number(plan.days));
            return res.json({ free: true, sub: subState({ plan_name: plan.name, expires: exp }) });
        }
        if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET || !ctx.razorpayRequest) {
            const miss = [!process.env.PAYMENT_API_KEY && 'PAYMENT_API_KEY (Razorpay Key ID)', !process.env.PAYMENT_API_SECRET && 'PAYMENT_API_SECRET (Razorpay Key Secret)'].filter(Boolean).join(' and ');
            console.error('❌ Session B plan payment: ' + (miss || 'Razorpay helper missing') + ' not set in the server environment.');
            return res.status(501).json({ error: 'Payment is temporarily unavailable — the administrator must add the Razorpay keys to the server settings (' + (miss || 'Razorpay helper') + '). Your data and plan are unchanged.' });
        }
        let order;
        try { order = await ctx.razorpayRequest('/v1/orders', { amount: paise, currency: 'INR', receipt: ('dvp_' + uid + '_' + Date.now()).slice(0, 40), notes: { userId: String(uid), planId: String(plan.id), plan: String(plan.name).slice(0, 40), days: String(plan.days) } }); }
        catch (e) { return res.status(502).json({ error: 'Could not create the payment order: ' + e.message }); }
        if (Number(order.amount) !== paise || (order.currency && order.currency !== 'INR')) {
            console.error('❌ Razorpay returned order ' + order.id + ' with ' + order.amount + ' ' + order.currency + ' but ' + paise + ' INR paise was requested.');
            return res.status(502).json({ error: 'The payment gateway returned an unexpected amount. Nothing was charged — please try again.' });
        }
        await dbq('INSERT INTO dv_plan_payments (order_id, user_id, plan_id, plan_name, days, amount) VALUES (?,?,?,?,?,?)', [order.id, uid, plan.id, plan.name, Number(plan.days), Number(order.amount) / 100]);
        res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, plan: { name: plan.name, days: Number(plan.days), price: amt } });
    }));
    app.post('/api/dv/plan/verify', dvUser, asyncRoute(async (req, res) => {
        const secret = process.env.PAYMENT_API_SECRET;
        if (!secret) return res.status(501).json({ error: 'Payment verification is unavailable — PAYMENT_API_SECRET is not set on the server.' });
        const b = req.body || {};
        const oid = String(b.razorpay_order_id || ''), pid = String(b.razorpay_payment_id || ''), sig = String(b.razorpay_signature || '');
        if (!oid || !pid || !sig) return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
        const expected = crypto.createHmac('sha256', secret).update(oid + '|' + pid).digest('hex');
        const x = Buffer.from(expected), y = Buffer.from(sig);
        if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return res.status(400).json({ error: 'Payment signature mismatch — the plan was not activated.' });
        const uid = req.dvUser.userId;
        const row = (await dbq('SELECT order_id, plan_id, plan_name, days, amount, status, payment_id FROM dv_plan_payments WHERE order_id = ? AND LOWER(user_id) = LOWER(?)', [oid, uid]))[0];
        if (!row) {
            const other = (await dbq('SELECT purpose FROM material_invoice_payments WHERE order_id = ?', [oid]).catch(() => []))[0];
            return res.status(400).json({ error: other ? 'This payment is for a Session A ' + (String(other.purpose) === 'topup' ? 'wallet recharge' : 'invoice fee') + ', not a Session B plan. The plan was not changed.' : 'This payment order was not found for your account.' });
        }
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

    // ── Settle a paid plan order (used by the webhook and by the status check, so a UPI / PhonePe payment is activated
    //    even when the browser never returns to the checkout callback). Idempotent: days are added once per order.
    async function settleOrder(oid, pid, paidRs) {
        const row = (await dbq('SELECT order_id, user_id, plan_id, plan_name, days, amount, status FROM dv_plan_payments WHERE order_id = ?', [String(oid)]))[0];
        if (!row) return false;
        if (row.status === 'paid') return true;
        if (paidRs != null && Math.round(Number(row.amount) * 100) !== Math.round(Number(paidRs) * 100)) { console.error('❌ plan order ' + oid + ': paid ₹' + paidRs + ' but ₹' + row.amount + ' expected — not activated'); return false; }
        const claimed = await dbq("UPDATE dv_plan_payments SET status='paid', payment_id=?, paid_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='created' RETURNING order_id", [pid || null, String(oid)]);
        if (claimed.length) { await grantDays(row.user_id, row.plan_id, row.plan_name, Number(row.days), 'razorpay', Number(row.amount)); try { audit({ headers: {}, ip: '' }, 'dv_plan_paid', row.user_id, 'plan=' + row.plan_name + ' amount=' + row.amount + ' via=webhook/status'); } catch (e) {} }
        return true;
    }
    _settle = settleOrder;
    // Ask Razorpay itself whether a plan order was paid and activate it (no signature needed). Returns true when active.
    async function checkPlanOrder(oid, amountRs) {
        if (!ctx.razorpayCall) return false;
        try {
            const list = await ctx.razorpayCall('GET', '/v1/orders/' + encodeURIComponent(oid) + '/payments');
            const p = ((list && list.items) || []).filter(x => x.status === 'captured' || x.status === 'authorized')[0];
            if (!p) return false;
            if (ctx.razorpayConfirmPayment) await ctx.razorpayConfirmPayment(oid, p.id, Number(amountRs));   // captures an authorized payment
            return await settleOrder(oid, p.id, Number(p.amount) / 100);
        } catch (e) { console.error('plan order check ' + oid + ':', e.message); return false; }
    }
    // Self-healing: loading the page / My Plan re-checks this user's recent unfinished plan orders.
    const _planRecent = {};
    async function reconcilePlans(uid) {
        const k = String(uid).toLowerCase(), now = Date.now();
        if (_planRecent[k] && now - _planRecent[k] < 15000) return;
        _planRecent[k] = now;
        const rows = await dbq("SELECT order_id, amount FROM dv_plan_payments WHERE LOWER(user_id) = LOWER(?) AND status = 'created' AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 5", [String(uid)]);
        for (const r of rows) await checkPlanOrder(r.order_id, r.amount);
    }
    // Browser asks "was this order paid?" (after a UPI app / PhonePe redirect, a closed window, or a slow callback) — the server asks Razorpay itself.
    app.get('/api/dv/plan/status', noStore, dvUser, asyncRoute(async (req, res) => {
        const oid = cleanText(req.query.orderId, 80), uid = req.dvUser.userId;
        const row = (await dbq('SELECT order_id, status, amount FROM dv_plan_payments WHERE order_id = ? AND LOWER(user_id) = LOWER(?)', [oid, uid]))[0];
        if (!row) return res.status(404).json({ error: 'Order not found.' });
        if (row.status !== 'paid') await checkPlanOrder(oid, row.amount);
        const now = (await dbq('SELECT status FROM dv_plan_payments WHERE order_id = ?', [oid]))[0];
        res.json({ paid: !!now && now.status === 'paid', sub: subState(await loadSub(uid)) });
    }));

    // ── List / instant search by Bill No.  GET /api/dv/invoices?q=50
    app.get('/api/dv/invoices', noStore, dvUser, dvActive, asyncRoute(async (req, res) => {
        // 🪶 Low-egress: the search runs inside Postgres (Bill No., Date or Client name) and only matches leave the database.
        //    ?full=1 returns the complete bills (items etc., max 20) so Edit / Print / PDF need no further call; default is the light list.
        const q = cleanText(req.query.q, 40).toLowerCase().replace(/[\/.]/g, '-');
        const full = req.query.full === '1' || req.query.full === 'true';
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || (full ? 20 : 50), 1), full ? 20 : 100);
        const where = ['owner_user_id = ?'], params = [req.dvUser.userId];
        q.split(' ').filter(Boolean).slice(0, 5).forEach(t => {
            where.push("lower(concat_ws(' | ', bill_no, customer_name, to_char(invoice_date,'YYYY-MM-DD'), to_char(invoice_date,'DD-MM-YYYY'), to_char(invoice_date,'FMDD-FMMM-YYYY'))) LIKE ? ESCAPE '\\'");
            params.push('%' + escapeLike(t) + '%');
        });
        // ?page=N&pageSize=5 → the database returns only that page (+ the total for the pager)
        if (req.query.page !== undefined && req.query.page !== '') {
            const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 5, 1), 20), page = Math.max(parseInt(req.query.page, 10) || 1, 1);
            const rows = await dbq("SELECT " + (full ? SEL_FULL : SEL_LIST) + " FROM dv_invoices WHERE " + where.join(' AND ') + " ORDER BY invoice_date DESC, id DESC LIMIT " + pageSize + " OFFSET " + ((page - 1) * pageSize), params);
            let total;
            if (rows.length < pageSize && page === 1) total = rows.length;
            else { const c = await dbq("SELECT COUNT(*) AS n FROM dv_invoices WHERE " + where.join(' AND '), params); total = Number(c[0] && c[0].n) || 0; }
            return res.json({ rows: rows.map(r => rowOut(r, full)), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
        }
        const rows = await dbq("SELECT " + (full ? SEL_FULL : SEL_LIST) + " FROM dv_invoices WHERE " + where.join(' AND ') + " ORDER BY invoice_date DESC, id DESC LIMIT " + limit, params);
        res.json(rows.map(r => rowOut(r, full)));
    }));
    // just the number of saved bills (for the "Saved Bills (n)" badge)
    app.get('/api/dv/invoices/count', noStore, dvUser, dvActive, asyncRoute(async (req, res) => {
        const rows = await dbq("SELECT COUNT(*) AS n FROM dv_invoices WHERE owner_user_id = ?", [req.dvUser.userId]);
        res.json({ count: Number(rows[0] && rows[0].n) || 0 });
    }));

    // Material names + HSN/SAC from the Super-Admin Master (read-only; used to auto-fill the HSN/SAC column)
    app.get('/api/dv/material-hsn', noStore, dvUser, asyncRoute(async (req, res) => {
        res.json((await loadMasterHsn()).list);
    }));

    app.get('/api/dv/invoices/:id', noStore, dvUser, dvActive, asyncRoute(async (req, res) => {
        const rows = await dbq("SELECT " + SEL_FULL + " FROM dv_invoices WHERE id = ? AND owner_user_id = ?", [parseInt(req.params.id, 10) || 0, req.dvUser.userId]);
        if (!rows.length) return res.status(404).json({ error: 'Invoice not found.' });
        res.json(rowOut(rows[0], true));
    }));

    const isDup = (e) => e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message || ''));
    const insertSql = `INSERT INTO dv_invoices (owner_user_id, bill_no, invoice_date, customer_name, block_name, district_name, transport_mode, vehicle_no,
                       items, taxable_total, cgst_total, sgst_total, round_off, grand_total, amount_words, company_snapshot, payment_mode)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`;
    const insertParams = (owner, v) => [owner, v.billNo, v.date, v.customer, v.block, v.district, v.transport, v.vehicle,
        JSON.stringify(v.calc.rows), v.calc.taxableTotal, v.calc.cgstTotal, v.calc.sgstTotal, v.calc.roundOff, v.calc.grandTotal, v.words, JSON.stringify(v.company), v.paymentMode];

    // ── SAVE (new). Never overwrites: a Bill No. that already exists is refused with 409.
    app.post('/api/dv/invoices', dvUser, dvActive, asyncRoute(async (req, res) => {
        const settings = await loadSettings(req.dvUser.userId);
        const p = parseInvoiceBody(req.body, settings);
        if (p.error) return res.status(400).json({ error: p.error });
        await applyMasterHsn(p.value.calc.rows);
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
        await applyMasterHsn(p.value.calc.rows);
        const sameNo = String(cur[0].bill_no).toLowerCase() === p.value.billNo.toLowerCase();
        try {
            if (!sameNo) {
                const r = await dbq(insertSql, insertParams(req.dvUser.userId, p.value));
                audit(req, 'dv_invoice_fork', req.dvUser.userId, 'from=' + cur[0].bill_no + ' to=' + p.value.billNo);
                return res.status(201).json({ success: true, mode: 'created', id: r[0].id, billNo: p.value.billNo, previousBillNo: cur[0].bill_no });
            }
            const v = p.value;
            await dbq(`UPDATE dv_invoices SET bill_no=?, invoice_date=?, customer_name=?, block_name=?, district_name=?, transport_mode=?, vehicle_no=?,
                       items=?, taxable_total=?, cgst_total=?, sgst_total=?, round_off=?, grand_total=?, amount_words=?, company_snapshot=?, payment_mode=?, updated_at=CURRENT_TIMESTAMP
                       WHERE id=? AND owner_user_id=?`,
                [v.billNo, v.date, v.customer, v.block, v.district, v.transport, v.vehicle, JSON.stringify(v.calc.rows), v.calc.taxableTotal, v.calc.cgstTotal,
                 v.calc.sgstTotal, v.calc.roundOff, v.calc.grandTotal, v.words, JSON.stringify(v.company), v.paymentMode, id, req.dvUser.userId]);
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
        const users = await dbq("SELECT userid, name, village, mobile, status, invoice_version, dv_category_id FROM material_users ORDER BY id DESC", []);
        const counts = await dbq("SELECT owner_user_id, COUNT(*) AS n FROM dv_invoices GROUP BY owner_user_id", []);
        const cnt = {}; counts.forEach(r => { cnt[String(r.owner_user_id).toLowerCase()] = Number(r.n); });
        const profs = {}; (await dbq('SELECT user_id, data FROM dv_profiles', [])).forEach(r => { let d = {}; try { d = JSON.parse(r.data) || {}; } catch (e) {} profs[String(r.user_id).toLowerCase()] = d.companyName || '(saved)'; });
        const subs = {}; (await dbq("SELECT user_id, plan_name, to_char(expires_at,'YYYY-MM-DD') AS expires FROM dv_subscriptions", [])).forEach(r => { subs[String(r.user_id).toLowerCase()] = subState(r); });
        res.json(users.map(u => {
            const k = String(u.userid).toLowerCase();
            return {
                userId: u.userid, name: u.name || '', village: u.village || '', mobile: u.mobile || '', status: u.status || 'active',
                session: normVersion(u.invoice_version), categoryId: u.dv_category_id || null, invoices: cnt[k] || 0,
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
        // optional: assign (or clear, with '') the Business Category together with the mapping — only meaningful for Session B
        const hasCat = Object.prototype.hasOwnProperty.call(b, 'categoryId');
        const catId = hasCat ? (parseInt(b.categoryId, 10) || null) : null;
        if (catId && !(await dbq('SELECT 1 FROM dv_categories WHERE id = ?', [catId])).length) return res.status(400).json({ error: 'That Business Category no longer exists.' });
        const updated = [], notFound = [];
        for (const id of ids) {
            const r = await dbq('UPDATE material_users SET invoice_version = ? WHERE LOWER(userid) = LOWER(?) RETURNING userid', [session, id]);
            if (r.length) {
                updated.push(r[0].userid);
                if (hasCat && session === 'B') await dbq('UPDATE material_users SET dv_category_id = ? WHERE LOWER(userid) = LOWER(?)', [catId, r[0].userid]);
                // Mapping to B gives the user THEIR OWN copy of the default template, so later changes to the template or to any other user never affect them
                if (session === 'B') {
                    await dbq('INSERT INTO dv_profiles (user_id, data) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING', [r[0].userid, JSON.stringify(await loadDefaults())]);
                }
            } else notFound.push(id);
        }
        audit(req, 'dv_mapping_set', 'dv_mapping', 'session=' + session + ' count=' + updated.length + (hasCat ? ' category=' + (catId || 'none') : ''));
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

    /* ═════════ CATEGORY CATALOG · RATES · BILL NUMBER · DAILY WALLET ═════════ */
    const money2 = (v) => Math.round(Number(v) * 100) / 100;

    // ── Super Admin: Business Categories
    app.get('/api/admin/dv-categories', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        const rows = await dbq(`SELECT c.id, c.name,
            (SELECT COUNT(*) FROM dv_cat_items i WHERE i.category_id = c.id) AS items,
            (SELECT COUNT(*) FROM material_users u WHERE u.dv_category_id = c.id) AS users
            FROM dv_categories c ORDER BY LOWER(c.name)`, []);
        res.json(rows.map(r => ({ id: r.id, name: r.name, items: Number(r.items), users: Number(r.users) })));
    }));
    app.put('/api/admin/dv-categories', requireRole('admin'), asyncRoute(async (req, res) => {
        const b = req.body || {}, name = cleanText(b.name, 80), id = parseInt(b.id, 10) || 0;
        if (!name) return res.status(400).json({ error: 'Category name is required.' });
        try {
            const r = id ? await dbq('UPDATE dv_categories SET name = ? WHERE id = ? RETURNING id, name', [name, id])
                         : await dbq('INSERT INTO dv_categories (name) VALUES (?) RETURNING id, name', [name]);
            if (!r.length) return res.status(404).json({ error: 'Category not found.' });
            audit(req, 'dv_category_set', 'dv_categories', 'name=' + name);
            res.json({ id: r[0].id, name: r[0].name });
        } catch (e) {
            if (isDup(e)) return res.status(409).json({ error: 'A category named "' + name + '" already exists.' });
            throw e;
        }
    }));
    app.delete('/api/admin/dv-categories/:id', requireRole('admin'), asyncRoute(async (req, res) => {
        const id = parseInt(req.params.id, 10) || 0;
        const n = Number(((await dbq('SELECT COUNT(*) AS n FROM material_users WHERE dv_category_id = ?', [id]))[0] || {}).n) || 0;
        if (n) return res.status(409).json({ error: n + ' user(s) are still assigned to this category. Move them to another category first.' });
        await dbq('DELETE FROM dv_categories WHERE id = ?', [id]);
        audit(req, 'dv_category_delete', 'dv_categories', 'id=' + id);
        res.json({ success: true });
    }));
    const itemOut = (i) => ({ id: i.id, name: i.name, unit: i.unit, gst: Number(i.gst) });
    app.get('/api/admin/dv-categories/:id/items', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
        const id = parseInt(req.params.id, 10) || 0;
        res.json((await dbq('SELECT id, name, unit, gst FROM dv_cat_items WHERE category_id = ? ORDER BY LOWER(name)', [id])).map(itemOut));
    }));
    // body: { items: [{ id?, name, unit, gst }] } — rows with an id are updated, rows without one are added, saved rows missing from the list are removed
    app.put('/api/admin/dv-categories/:id/items', requireRole('admin'), asyncRoute(async (req, res) => {
        const cid = parseInt(req.params.id, 10) || 0;
        if (!(await dbq('SELECT 1 FROM dv_categories WHERE id = ?', [cid])).length) return res.status(404).json({ error: 'Category not found.' });
        const list = Array.isArray(req.body && req.body.items) ? req.body.items : null;
        if (!list) return res.status(400).json({ error: 'Item list is required.' });
        if (list.length > 2000) return res.status(400).json({ error: 'A category can hold at most 2000 items.' });
        const clean = [], seen = {};
        for (let i = 0; i < list.length; i++) {
            const r = list[i] || {}, name = cleanText(r.name, 120);
            if (!name) continue;
            const gst = r.gst === '' || r.gst == null ? 0 : Number(r.gst);
            if (!isFinite(gst) || gst < 0 || gst > 100) return res.status(400).json({ error: 'Item "' + name + '": GST % must be between 0 and 100.' });
            if (seen[name.toLowerCase()]) return res.status(400).json({ error: 'Item "' + name + '" is listed twice.' });
            seen[name.toLowerCase()] = 1;
            clean.push({ id: parseInt(r.id, 10) || 0, name: name, unit: cleanText(r.unit, 20) || 'Pcs', gst: money2(gst) });
        }
        const have = (await dbq('SELECT id FROM dv_cat_items WHERE category_id = ?', [cid])).map(r => r.id);
        const keep = {}; clean.forEach(c => { if (c.id && have.indexOf(c.id) >= 0) keep[c.id] = 1; });
        try {
            for (const id of have) if (!keep[id]) await dbq('DELETE FROM dv_cat_items WHERE id = ? AND category_id = ?', [id, cid]);
            for (const c of clean) {
                if (c.id && keep[c.id]) await dbq('UPDATE dv_cat_items SET name = ?, unit = ?, gst = ? WHERE id = ? AND category_id = ?', [c.name, c.unit, c.gst, c.id, cid]);
                else await dbq('INSERT INTO dv_cat_items (category_id, name, unit, gst) VALUES (?,?,?,?)', [cid, c.name, c.unit, c.gst]);
            }
        } catch (e) {
            if (isDup(e)) return res.status(409).json({ error: 'Two items ended up with the same name. Please make every item name unique.' });
            throw e;
        }
        audit(req, 'dv_catalog_set', 'dv_categories', 'category=' + cid + ' items=' + clean.length);
        res.json((await dbq('SELECT id, name, unit, gst FROM dv_cat_items WHERE category_id = ? ORDER BY LOWER(name)', [cid])).map(itemOut));
    }));

    // ── Session B user: the master items of MY category merged with MY saved rates
    async function myCatalog(uid) {
        const u = (await dbq('SELECT dv_category_id FROM material_users WHERE userid = ?', [uid]))[0];
        if (!u || !u.dv_category_id) return { category: null, items: [] };
        const cat = (await dbq('SELECT id, name FROM dv_categories WHERE id = ?', [u.dv_category_id]))[0];
        if (!cat) return { category: null, items: [] };
        const rows = await dbq(`SELECT i.id, i.name, i.unit, i.gst, r.price, r.gst AS ugst, r.unit AS uunit, r.qty AS uqty
            FROM dv_cat_items i LEFT JOIN dv_user_rates r ON r.item_id = i.id AND LOWER(r.user_id) = LOWER(?)
            WHERE i.category_id = ? ORDER BY LOWER(i.name)`, [uid, cat.id]);
        return { category: { id: cat.id, name: cat.name }, items: rows.map(r => ({
            id: r.id, name: r.name, masterUnit: r.unit, masterGst: Number(r.gst),
            saved: r.price != null, price: r.price != null ? Number(r.price) : null,
            gst: r.ugst != null ? Number(r.ugst) : Number(r.gst), unit: r.uunit || r.unit, qty: r.uqty != null ? Number(r.uqty) : 1
        })) };
    }
    app.get('/api/dv/catalog', noStore, dvUser, dvActive, asyncRoute(async (req, res) => { res.json(await myCatalog(req.dvUser.userId)); }));
    // body: { rates: [{ itemId, price, gst, unit, qty }] } — a blank price removes the user's saved rate for that item
    app.put('/api/dv/catalog/rates', dvUser, dvActive, asyncRoute(async (req, res) => {
        const uid = req.dvUser.userId, list = Array.isArray(req.body && req.body.rates) ? req.body.rates : null;
        if (!list) return res.status(400).json({ error: 'Nothing to save.' });
        if (list.length > 2000) return res.status(400).json({ error: 'Too many items in one save.' });
        const cat = await myCatalog(uid);
        if (!cat.category) return res.status(403).json({ error: 'No Business Category is assigned to your account yet. Please contact the administrator.' });
        const ok = {}; cat.items.forEach(i => { ok[i.id] = i; });
        const todo = [];
        for (const r0 of list) {
            const r = r0 || {}, id = parseInt(r.itemId, 10) || 0, m = ok[id];
            if (!m) return res.status(400).json({ error: 'An item in your list does not belong to your category. Please reload the page.' });
            if (r.price === '' || r.price == null) { todo.push({ id: id, del: true }); continue; }
            const price = Number(r.price), gst = r.gst === '' || r.gst == null ? m.masterGst : Number(r.gst), qty = r.qty === '' || r.qty == null ? 1 : Number(r.qty);
            if (!isFinite(price) || price < 0 || price > 1e8) return res.status(400).json({ error: '"' + m.name + '": selling price must be 0 or more.' });
            if (!isFinite(gst) || gst < 0 || gst > 100) return res.status(400).json({ error: '"' + m.name + '": GST % must be between 0 and 100.' });
            if (!isFinite(qty) || qty <= 0 || qty > 1e7) return res.status(400).json({ error: '"' + m.name + '": default pieces must be greater than 0.' });
            todo.push({ id: id, price: money2(price), gst: money2(gst), qty: Math.round(qty * 1000) / 1000, unit: cleanText(r.unit, 20) || m.masterUnit });
        }
        for (const t of todo) {
            if (t.del) await dbq('DELETE FROM dv_user_rates WHERE LOWER(user_id) = LOWER(?) AND item_id = ?', [uid, t.id]);
            else await dbq(`INSERT INTO dv_user_rates (user_id, item_id, price, gst, unit, qty, updated_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, item_id) DO UPDATE SET price = EXCLUDED.price, gst = EXCLUDED.gst, unit = EXCLUDED.unit, qty = EXCLUDED.qty, updated_at = CURRENT_TIMESTAMP`,
                [uid, t.id, t.price, t.gst, t.unit, t.qty]);
        }
        res.json(await myCatalog(uid));
    }));

    // ── Next sequential Bill No. (keeps a text prefix and zero-padding:  1, 2, 3 …  or  INV-009 → INV-010)
    app.get('/api/dv/next-bill-no', noStore, dvUser, dvActive, asyncRoute(async (req, res) => {
        const uid = req.dvUser.userId;
        const rows = await dbq('SELECT bill_no FROM dv_invoices WHERE owner_user_id = ? ORDER BY id DESC LIMIT 300', [uid]);
        let prefix = '', width = 0, max = 0;
        const used = {}; rows.forEach(r => { used[String(r.bill_no).toLowerCase()] = 1; });
        for (let i = 0; i < rows.length; i++) {
            const m = /^(.*?)(\d{1,12})$/.exec(String(rows[i].bill_no));
            if (!m) continue;
            if (i === 0 || (!prefix && !width)) { prefix = m[1]; width = m[2].length > 1 && m[2][0] === '0' ? m[2].length : 0; }
            if (m[1] === prefix) max = Math.max(max, parseInt(m[2], 10));
        }
        let n = max + 1, no;
        do { no = prefix + (width ? String(n).padStart(width, '0') : String(n)); n++; } while (used[no.toLowerCase()]);
        res.json({ billNo: no });
    }));

    // ── Daily Wallet & stock-sales summary for a date range (default: today, IST). Everything is summed in integer paise.
    app.get('/api/dv/wallet', noStore, dvUser, dvActive, asyncRoute(async (req, res) => {
        const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
        let from = String(req.query.from || '').slice(0, 10), to = String(req.query.to || '').slice(0, 10);
        if (!okDate(from) && !okDate(to)) from = to = istToday();
        else if (!okDate(from)) from = to; else if (!okDate(to)) to = from;
        if (from > to) { const t = from; from = to; to = t; }
        if (dayNum(to) - dayNum(from) > 366) return res.status(400).json({ error: 'Please choose a period of at most one year.' });
        const rows = await dbq(`SELECT id, bill_no, to_char(invoice_date,'YYYY-MM-DD') AS d, to_char(created_at AT TIME ZONE 'Asia/Kolkata','HH24:MI') AS t,
                customer_name, payment_mode, grand_total, items
            FROM dv_invoices WHERE owner_user_id = ? AND invoice_date BETWEEN ? AND ? ORDER BY invoice_date DESC, id DESC LIMIT 5001`, [req.dvUser.userId, from, to]);
        const truncated = rows.length > 5000; if (truncated) rows.length = 5000;
        let totP = 0, onP = 0, caP = 0, qty = 0;
        const agg = {}, tx = [];
        rows.forEach(r => {
            const gp = toPaise(Number(r.grand_total)), online = r.payment_mode === 'online';
            totP += gp; if (online) onP += gp; else caP += gp;
            let its = []; try { its = JSON.parse(r.items) || []; } catch (e) { its = []; }
            its.forEach(it => {
                const key = String(it.name || '').toLowerCase() + '|' + String(it.unit || '').toLowerCase();
                const a = agg[key] || (agg[key] = { name: it.name || '', unit: it.unit || '', qty: 0, amountP: 0 });
                a.qty += Number(it.qty) || 0; a.amountP += toPaise(Number(it.total) || 0); qty += Number(it.qty) || 0;
            });
            tx.push({ id: r.id, billNo: r.bill_no, date: r.d, time: r.t, customer: r.customer_name || '', mode: online ? 'online' : 'cash', total: Number(r.grand_total), lines: its.length });
        });
        res.json({
            from: from, to: to, truncated: truncated,
            totals: { sales: fromPaise(totP), online: fromPaise(onP), cash: fromPaise(caP), bills: rows.length, qty: Math.round(qty * 1000) / 1000, itemKinds: Object.keys(agg).length },
            items: Object.keys(agg).map(k => ({ name: agg[k].name, unit: agg[k].unit, qty: Math.round(agg[k].qty * 1000) / 1000, amount: fromPaise(agg[k].amountP) })).sort((a, b) => b.amount - a.amount),
            transactions: tx
        });
    }));
}

function normVersion(v) { return String(v == null ? '' : v).trim().toUpperCase() === 'B' ? 'B' : 'A'; }

module.exports = { settlePlanOrder: function (o, p, r) { return _settle ? _settle(o, p, r) : Promise.resolve(false); }, subState, nextExpiry, normVersion, SCHEMA_SQL, DEFAULT_SETTINGS, install, calc, amountInWords, sanitizeSettings, parseInvoiceBody };
