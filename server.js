require('dotenv').config(); // local .env (Render uses dashboard env vars)
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer'); // 🆕 file upload (Hero image/Logo/APK) ke liye
const path = require('path'); // 🆕 404.html ka absolute path resolve karne ke liye
const fs = require('fs'); // 🆕 static/page file lookup ke liye
const crypto = require('crypto');
const supabasePortals = require('./supabase-portals'); // 🆕 supabase-js layer for all 6 portals // 🆕 PII encryption/hash (pehle yeh file mein neeche require hota tha)

// ══════════════════════════════════════════════════════════════════
// 🛡️ PROCESS-LEVEL SAFETY NET — sabse pehli cheez jo file mein chalti
//   hai, taaki NEECHE ki poori startup code (DB pool banana, routes
//   register karna, middleware, waghera) bhi is safety net ke andar
//   aa jaaye.
//   🔒 CRITICAL FIX: yeh handlers pehle file ke bilkul AAKHIR mein
//   (app.listen se theek pehle) the. Iska matlab: agar startup ke
//   dauraan — DB pool banate waqt, ya kisi route register karte
//   waqt, ya kisi bhi synchronous code mein — koi error throw hoti,
//   to Node.js process TURANT crash ho jaata, kyunki safety net
//   abhi register hi nahi hua tha jab tak file poori load na ho
//   jaaye. Yehi wajah thi ki DB unreachable hone par sirf DB calls
//   fail nahi hote the — POORA SERVER hi crash ho jaata tha, aur
//   browser mein "Failed to fetch" (server se koi response hi
//   nahi) dikhta tha, na ki ek normal "DB error" JSON response.
//   Ab yeh sabse pehle register hote hain — koi bhi startup ya
//   runtime error ab poore server ko kabhi crash nahi karegi,
//   sirf log hogi.
// ══════════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
    console.error('🚨 UNCAUGHT EXCEPTION (server crash prevented):', err && err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('🚨 UNHANDLED PROMISE REJECTION (server crash prevented):', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// 🆕 Render ek reverse proxy ke peeche chalta hai — isके bina Express hamesha
// req.protocol ko 'http' samajhta, jisse upload-file wala absolute URL galti se
// 'http://...' ban jaata (jo HTTPS Netlify site par mixed-content block ho jaata).
app.set('trust proxy', 1);

// Middleware
// 🆕 FIX: ab CORS sirf EXPLICITLY allowed origins ke liye khulta hai. Do
// origins allowed hain: (1) Netlify site — jahan index.html/Admin Panel
// hain, aur (2) Render ka apna backend domain — kyunki ab kuch login pages
// (jaise Material Portal) '/api/pages/<slug>' se Render se hi seedhe serve
// hote hain, aur woh page bhi isi backend ko API call karta hai. Render ka
// apna domain whitelist mein na hone ki wajah se pehle yeh exact CORS error
// aa raha tha.
// NOTE: agar future mein koi custom domain jodna ho, ya Netlify deploy-preview
// URLs (jaise https://deploy-preview-3--digitallibraryanmollive.netlify.app)
// bhi allow karne hon, to bas neeche is array mein add kar dein.
const ALLOWED_ORIGINS = [
    'https://digitallibraryanmollive.netlify.app',
    'https://library-backend-4efk.onrender.com'
]
    // 🆕 Render ka apna (custom) domain + koi extra origin — Environment se, code badle bina:
    //   EXTRA_CORS_ORIGINS="https://mydomain.com,https://www.mydomain.com"
    .concat(process.env.RENDER_EXTERNAL_URL ? [process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')] : [])
    .concat([process.env.FRONTEND_URL, process.env.NETLIFY_URL].filter(Boolean).map(function (x) { return x.trim().replace(/\/$/, ''); }))
    .concat(String(process.env.EXTRA_CORS_ORIGINS || '').split(',').map(function (x) { return x.trim().replace(/\/$/, ''); }).filter(Boolean));
// 🆕 Netlify deploy-preview / branch-deploy URLs (sirf isi site ke: <x>--digitallibraryanmollive.netlify.app)
const NETLIFY_ANY_RE = /^https:\/\/[a-z0-9-]+\.netlify\.app$/;
const NETLIFY_PREVIEW_RE = /^https:\/\/[a-z0-9-]+--digitallibraryanmollive\.netlify\.app$/;
// 🆕 Local development (sirf production ke bahar)
const LOCAL_DEV_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(cors({
    origin: function (origin, callback) {
        // Server-to-server / curl / Postman jaisi requests mein origin header
        // hota hi nahi — unhe allow karo (koi browser CORS risk nahi hai).
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin) || NETLIFY_PREVIEW_RE.test(origin)) return callback(null, true);
        // 🆕 Any Netlify site (https://<name>.netlify.app and deploy previews) is allowed by default so a renamed /
        //    new Netlify site never gets "blocked by CORS". Auth uses Bearer tokens (no cookies), so this does not
        //    expose logged-in sessions. Set CORS_STRICT=true in Render to allow ONLY FRONTEND_URL / EXTRA_CORS_ORIGINS.
        if (process.env.CORS_STRICT !== 'true' && NETLIFY_ANY_RE.test(origin)) return callback(null, true);
        if (process.env.NODE_ENV !== 'production' && LOCAL_DEV_RE.test(origin)) return callback(null, true);
        console.warn('❌ CORS blocked origin:', origin);
        const corsErr = new Error('CORS: access from this domain is not allowed — ' + origin);
        corsErr.status = 403; // 500 ki jagah saaf 403
        return callback(corsErr);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400 // cache preflight for a day
}));

app.use(express.json({
    limit: '100mb',
    // 🆕 RAZORPAYX WEBHOOK: signature verify karne ke liye raw (unparsed)
    // body bytes chahiye hote hain — JSON.parse ke baad wo bytes exact
    // waapas nahi milte (whitespace/key-order badal sakta hai), isliye
    // yahan verify callback se raw Buffer bhi req.rawBody mein save kar
    // lete hain. Baaki poore app par iska koi asar nahi — sirf ek extra
    // Buffer reference save hota hai.
    verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
// ══════════════════════════════════════════════════════════════════
// 📁 STATIC FILES — pehle yahan `express.static('.')` tha, jo poore project
//   folder ko public bana deta tha (server.js, package.json tak URL se
//   khul jaate the). Ab:
//     1) agar `public/` folder hai to wahi serve hota hai;
//     2) root folder se sirf SAFE files (html/css/js/images/fonts...) serve
//        hoti hain — server.js, package*.json, dotfiles, node_modules kabhi nahi.
//   Login/home pages ke clean URLs neeche "PAGE ROUTES" mein map hain.
// ══════════════════════════════════════════════════════════════════
const PUBLIC_DIR = (function () {
    const p = path.join(__dirname, 'public');
    try { return fs.statSync(p).isDirectory() ? p : null; } catch (e) { return null; }
})();
const STATIC_DIRS = PUBLIC_DIR ? [PUBLIC_DIR, __dirname] : [__dirname];
const ROOT_DENY_NAMES = new Set(['server.js', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'procfile', 'dockerfile', 'render.yaml', 'readme.md']);
const ROOT_ALLOW_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.txt', '.xml', '.webmanifest', '.pdf']);
const STATIC_OPTS = {
    dotfiles: 'ignore', index: false, redirect: false, extensions: ['html'], maxAge: '1h',
    setHeaders: function (res, filePath) { if (/\.html?$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache'); }
};
function isSafeRootStaticPath(rawPath) {
    let p;
    try { p = decodeURIComponent(rawPath); } catch (e) { return false; }
    if (p.indexOf('\0') !== -1) return false;
    const segs = p.split('/').filter(Boolean);
    if (!segs.length) return false;
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i].toLowerCase();
        if (s === '..' || s.charAt(0) === '.' || s === 'node_modules') return false;
    }
    const base = segs[segs.length - 1].toLowerCase();
    if (ROOT_DENY_NAMES.has(base)) return false;
    const ext = path.extname(base);
    return ext ? ROOT_ALLOW_EXT.has(ext) : true; // extensionless (/Admin_Login) → .html try hota hai
}
// Case-insensitive file lookup (Linux par Admin_Login.html vs admin_login.html ka jhanjhat nahi).
function findStaticFile(name) {
    for (let i = 0; i < STATIC_DIRS.length; i++) {
        const dir = STATIC_DIRS[i];
        try {
            const exact = path.join(dir, name);
            if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;
            const hit = fs.readdirSync(dir).find(function (f) { return f.toLowerCase() === name.toLowerCase(); });
            if (hit && fs.statSync(path.join(dir, hit)).isFile()) return path.join(dir, hit);
        } catch (e) { /* is dir mein nahi mila — agla try karo */ }
    }
    return null;
}
if (PUBLIC_DIR) app.use(express.static(PUBLIC_DIR, STATIC_OPTS));
const rootStatic = express.static(__dirname, STATIC_OPTS);
app.use(function (req, res, next) { return isSafeRootStaticPath(req.path) ? rootStatic(req, res, next) : next(); });

// 🆕 Supabase layer: login/logout logging, form+registration mirroring and /api/portal/* routes.
//    Mounted BEFORE the portal routes so it can observe them; the 404 handlers come last.
supabasePortals.mount(app, { getAuthUser: getAuthUser, requireRole: requireRole });


// ── Auth helper: '/auth/login' se mila JWT token decode karke
//   req.user = { role, username } set karta hai. Token na ho / invalid ho
//   to bhi request block nahi hoti (kai routes public/self-verifying hain
//   jaisa Student_Attendance.html ke comment mein likha hai) — bas
//   req.user null rehta hai. Wallet jaise identity-based routes username
//   ko hi agentId/staffId ki tarah use karte hain. ──
function getAuthUser(req) {
    try {
        const h = req.headers.authorization || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) return null;
        if (supabasePortals.isRevoked(token)) return null; // 🆕 logged-out token (Supabase revoked_tokens)
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════
// 🔒 SECURITY LAYER — RBAC middleware + password-hashing helpers
//   (Advanced Security & Data Protection ke liye)
// ══════════════════════════════════════════════════════════════════

// RBAC: sirf diye gaye role(s) waale VALID JWT token ke saath hi aage
// badhne diya jaata hai. Bina token / galat role → turant 401, aage
// koi bhi route handler chalta hi nahi.
function requireRole(...roles) {
    const allowed = roles.map(r => String(r).toLowerCase());
    return function (req, res, next) {
        const auth = getAuthUser(req);
        const role = auth && String(auth.role || '').toLowerCase();
        if (!auth || !allowed.includes(role)) {
            return res.status(401).json({ error: 'A valid login or permission is required for this action.' });
        }
        req.authUser = auth;
        next();
    };
}

// Bcrypt hash "$2a$10$..." jaisa dikhta hai — isse pehchan lete hain ki
// value already hashed hai ya abhi plain-text hai (legacy data ke liye).
function looksHashed(pw) {
    return typeof pw === 'string' && /^\$2[aby]\$\d{2}\$/.test(pw);
}

// Password field ko har jagah alag naam se store kiya gaya hai
// (password / pass) — dono cover karte hain.
const PASSWORD_FIELD_NAMES = ['password', 'pass'];

// Kisi bhi entity-array (admins/staff/agents/students) ko DB mein save
// karne se PEHLE, agar koi record ka password plain-text mein hai
// (naya record banaya gaya ho ya purana un-hashed data ho), use turant
// bcrypt se hash kar dete hain — taaki DB mein KABHI plain-text
// password store hi na ho.
function hashEntityPasswordsBeforeSave(value) {
    if (!Array.isArray(value)) return value;
    return value.map(rec => {
        if (!rec || typeof rec !== 'object') return rec;
        const copy = { ...rec };
        PASSWORD_FIELD_NAMES.forEach(f => {
            if (copy[f] && typeof copy[f] === 'string' && !looksHashed(copy[f])) {
                copy[f] = bcrypt.hashSync(copy[f], 10);
            }
        });
        return copy;
    });
}

// API Response Sanitization: frontend ko kabhi bhi password/hash wapas
// nahi bhejte — chahe hashed hi kyun na ho, ise Network tab mein
// dikhna hi nahi chahiye. Ek harmless boolean flag (hasPassword) chhod
// dete hain taaki frontend sirf "credentials bane hain ya nahi" jaan
// sake, bina asli value dekhe.
function stripSensitiveFields(value) {
    if (!Array.isArray(value)) return value;
    return value.map(rec => {
        if (!rec || typeof rec !== 'object') return rec;
        const copy = { ...rec };
        let had = false;
        PASSWORD_FIELD_NAMES.forEach(f => {
            if (copy[f]) had = true;
            delete copy[f];
        });
        delete copy.password_hash;
        copy.hasPassword = had;
        return copy;
    });
}

// ══════════════════════════════════════════════════════════════════
// 🪪 PII / KYC HELPERS — Aadhaar + PAN ke liye encryption, blind-index,
//   masking, validation, agent-scope, rate-limit aur audit-log.
//
//   DESIGN (kyun aisa):
//   • Poora Aadhaar / PAN DB mein KABHI plain-text mein save nahi hota.
//       - AES-256-GCM se encrypt  → aadhaar_enc / pan_enc (sirf reveal ke liye)
//       - HMAC-SHA256 "blind index" → aadhaar_hash / pan_hash (exact search ke liye,
//         hash se number wapas nahi nikal sakta)
//       - Sirf last-4 (aadhaar_last4) aur masked PAN plain rehte hain (display ke liye)
//   • Search/list responses mein hamesha MASKED value jaati hai
//     (XXXX XXXX 1234). Poora number sirf explicit /reveal route se, aur
//     wahan bhi har baar audit-log mein entry hoti hai.
//   • Encryption key: Render Environment mein PII_ENCRYPTION_KEY set karein
//     (koi bhi lambi random string). Na ho to JWT_SECRET se derive hota hai
//     (server phir bhi chalta hai, par warning aati hai — JWT_SECRET badalne
//     par purane encrypted numbers reveal nahi ho paayenge).
//   • AADHAAR_STRICT_CHECKSUM=true set karne par Aadhaar ka Verhoeff
//     checksum + pehla digit (2-9) bhi verify hota hai (default: sirf 12 digits).
// ══════════════════════════════════════════════════════════════════
const KYC_ENTITY_TYPES = ['student', 'staff', 'customer', 'agent', 'employee'];
const KYC_AGENT_WRITABLE_TYPES = ['student', 'staff', 'employee', 'customer'];
const KYC_TYPE_LABEL = { student: 'Student', staff: 'Staff', customer: 'Customer Registration', agent: 'Agent', employee: 'Staff / HRMS' };
const AADHAAR_STRICT = String(process.env.AADHAAR_STRICT_CHECKSUM || '').toLowerCase() === 'true';

// ── Postgres unquoted columns lowercase ho jaate hain (studentId → studentid).
//    Purane code mein kai jagah row.studentId / o.planId jaisi camelCase reads
//    PG mein `undefined` aati hain. Yeh helper row ki ek COPY mein camelCase
//    alias jod deta hai (original row/JSON response ko chhue bina).
const CAMEL_COLUMN_NAMES = ['orderId', 'studentId', 'planId', 'planName', 'agentId', 'ownerUserId', 'userId', 'empId', 'employeeId', 'salarySlipId', 'agentName', 'agentShareAmount', 'netAmount'];
const _camelByLower = {};
CAMEL_COLUMN_NAMES.forEach(function (n) { _camelByLower[n.toLowerCase()] = n; });
function camelizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = Object.assign({}, row);
    Object.keys(row).forEach(function (k) {
        const c = _camelByLower[k];
        if (c && out[c] === undefined) out[c] = row[k];
    });
    return out;
}

// ── Chhote utility helpers ──
function firstDefined() {
    for (let i = 0; i < arguments.length; i++) {
        if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
    }
    return undefined;
}
function cleanText(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 255);
}
function escapeLike(s) { return String(s).replace(/[\\%_]/g, '\\$&'); }
function dbq(sql, params) {
    return new Promise(function (resolve, reject) {
        db.query(sql, params || [], function (err, rows) { if (err) reject(err); else resolve(rows || []); });
    });
}
// Best-effort query: error par [] deta hai (history jaisi optional cheezon ke liye).
function safeQ(sql, params) {
    return dbq(sql, params).catch(function (e) { console.warn('⚠️ optional query fail:', e.message); return []; });
}
// Express 4 async handler ke rejected-promise ko pakadta hai — request kabhi hang nahi hoti.
function asyncRoute(fn) {
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(function (e) {
            console.error('❌ route error:', e && e.stack || e);
            if (!res.headersSent) res.status(500).json({ error: 'Server error: ' + (e && e.message ? e.message : 'unknown') });
        });
    };
}
// PII responses ko browser/proxy cache na kare.
function noStore(req, res, next) {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    next();
}

// ── Simple in-memory rate limiter (naya npm package nahi chahiye) ──
const _rateBuckets = new Map();
function hitRateLimit(key, max, windowMs) {
    const now = Date.now();
    const arr = (_rateBuckets.get(key) || []).filter(function (t) { return now - t < windowMs; });
    if (arr.length >= max) { _rateBuckets.set(key, arr); return true; }
    arr.push(now);
    _rateBuckets.set(key, arr);
    return false;
}
setInterval(function () {
    const now = Date.now();
    _rateBuckets.forEach(function (arr, k) {
        const f = arr.filter(function (t) { return now - t < 10 * 60 * 1000; });
        if (f.length) _rateBuckets.set(k, f); else _rateBuckets.delete(k);
    });
}, 5 * 60 * 1000).unref();

// ── Encryption (AES-256-GCM) + blind index (HMAC-SHA256) ──
let _piiKeys = null;
function piiKeys() {
    if (_piiKeys) return _piiKeys;
    const master = process.env.PII_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!master) return null;
    if (!process.env.PII_ENCRYPTION_KEY) {
        console.warn('⚠️ PII_ENCRYPTION_KEY is not set — the key is currently derived from JWT_SECRET. Please set a separate PII_ENCRYPTION_KEY in Render → Environment (if JWT_SECRET is changed, previously encrypted Aadhaar/PAN values cannot be revealed).');
    }
    _piiKeys = {
        enc: crypto.scryptSync(String(master), 'anmol-libmatrix-pii-enc-v1', 32),
        idx: crypto.scryptSync(String(master), 'anmol-libmatrix-pii-idx-v1', 32)
    };
    return _piiKeys;
}
function piiReady() { return !!piiKeys(); }
function piiEncrypt(plain) {
    const k = piiKeys();
    if (!k) throw new Error('PII key is not configured.');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k.enc, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function piiDecrypt(blob) {
    if (!blob || typeof blob !== 'string' || blob.indexOf('v1:') !== 0) return null;
    const k = piiKeys();
    if (!k) return null;
    try {
        const raw = Buffer.from(blob.slice(3), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', k.enc, raw.slice(0, 12));
        d.setAuthTag(raw.slice(12, 28));
        return Buffer.concat([d.update(raw.slice(28)), d.final()]).toString('utf8');
    } catch (e) { return null; }
}
function piiIndex(label, value) {
    const k = piiKeys();
    if (!k) throw new Error('PII key is not configured.');
    return crypto.createHmac('sha256', k.idx).update(label + ':' + value).digest('hex');
}

// ── Validation + masking ──
const _vd = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const _vp = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function verhoeffValid(num) {
    let c = 0;
    const a = String(num).split('').reverse();
    for (let i = 0; i < a.length; i++) c = _vd[c][_vp[i % 8][parseInt(a[i], 10)]];
    return c === 0;
}
function validateAadhaar12(v) {
    const d = String(v == null ? '' : v).replace(/[\s-]/g, '');
    if (!/^\d{12}$/.test(d)) return { ok: false, error: 'The Aadhaar number must be exactly 12 digits.' };
    if (AADHAAR_STRICT && (!/^[2-9]/.test(d) || !verhoeffValid(d))) return { ok: false, error: 'Invalid Aadhaar number (checksum mismatch).' };
    return { ok: true, value: d };
}
function maskAadhaarLast4(l4) { return /^\d{4}$/.test(String(l4 || '')) ? 'XXXX XXXX ' + l4 : 'Not available'; }
function maskPan(p) { p = String(p || ''); return p.length === 10 ? p.slice(0, 2) + '******' + p.slice(-2) : ''; }

// Body se Aadhaar/PAN/district/state nikal kar validate + encrypt karta hai.
// opts.requireAadhaar / opts.requirePan: customer registration mein mandatory.
// Return: { error, status? }  ya  { fields } (sirf wahi columns jo body mein aaye).
function parseKycInput(body, opts) {
    opts = opts || {};
    const b = body || {};
    const out = {};
    function needKey() { return piiReady() ? null : { error: 'PII_ENCRYPTION_KEY (or JWT_SECRET) is not set on the server — Aadhaar/PAN cannot be saved securely.', status: 503 }; }
    function applyFull(d12) {
        out.aadhaar_last4 = d12.slice(-4);
        out.aadhaar_hash = piiIndex('AADHAAR', d12);
        out.aadhaar_enc = piiEncrypt(d12);
    }

    const aRaw = firstDefined(b.aadhaar, b.aadhaarNumber, b.aadhar, b.aadharNumber);
    const rRaw = firstDefined(b.aadhaarRedacted, b.aadhaarLast4);
    if (aRaw !== undefined && String(aRaw).trim() !== '') {
        const v = validateAadhaar12(aRaw);
        if (!v.ok) return { error: v.error };
        const nk = needKey(); if (nk) return nk;
        applyFull(v.value);
    } else if (rRaw !== undefined && String(rRaw).trim() !== '') {
        const d = String(rRaw).replace(/\D/g, '');
        if (d.length === 12) {
            const v = validateAadhaar12(d);
            if (!v.ok) return { error: v.error };
            const nk = needKey(); if (nk) return nk;
            applyFull(v.value);
        } else if (d.length === 4) {
            out.aadhaar_last4 = d; // poora number pata nahi — sirf last-4
        } else {
            return { error: 'Please enter only the last 4 digits (or the full 12 digits) of the Aadhaar number.' };
        }
    } else if (opts.requireAadhaar) {
        return { error: 'The last 4 digits of the Aadhaar number are required.' };
    }

    const pRaw = firstDefined(b.pan, b.panNumber, b.panNo, b.panCard);
    if (pRaw !== undefined && String(pRaw).trim() !== '') {
        const pan = String(pRaw).trim().toUpperCase();
        if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { error: 'Invalid PAN format (for example, ABCDE1234F).' };
        const nk = needKey(); if (nk) return nk;
        out.pan_hash = piiIndex('PAN', pan);
        out.pan_enc = piiEncrypt(pan);
        out.pan_masked = maskPan(pan);
    } else if (opts.requirePan) {
        return { error: 'PAN card number is required.' };
    }

    if (b.district !== undefined) out.district = cleanText(b.district, 120);
    if (b.state !== undefined) out.state = cleanText(b.state, 120);
    const pinRaw = firstDefined(b.pinCode, b.pincode, b.pin);
    if (pinRaw !== undefined && String(pinRaw).trim() !== '') {
        const pin = String(pinRaw).replace(/\s/g, '');
        if (!/^\d{6}$/.test(pin)) return { error: 'The PIN code must be 6 digits.' };
        out.pin_code = pin;
    }
    return { fields: out };
}

// ── PII-wali field names (Aadhaar/PAN number + unki photo). Last-4/masked
//    versions (aadhaarLast4, aadhaarRedacted, aadhaarMasked, panMasked) jaan-boojh
//    kar is list mein NAHI hain — woh sensitive nahi hain. ──
const PII_FIELD_SET = new Set(['aadhar', 'aadhaar', 'aadharnumber', 'aadhaarnumber', 'aadharno', 'aadhaarno',
    'aadharfront', 'aadharback', 'aadhaarfront', 'aadhaarback', 'aadharimage', 'aadhaarimage', 'aadharphoto', 'aadhaarphoto',
    'identitynumber', 'identityno', 'idnumber',
    'pan', 'pannumber', 'panno', 'pancard', 'pancardnumber', 'panimage', 'panphoto']);
function isPiiKey(k) { return PII_FIELD_SET.has(String(k).toLowerCase().replace(/[^a-z]/g, '')); }
function stripPiiIfNeeded(rec) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
    const keys = Object.keys(rec);
    if (!keys.some(isPiiKey)) return rec;
    const out = {};
    keys.forEach(function (k) { if (!isPiiKey(k)) out[k] = rec[k]; });
    return out;
}

// ── Agent scope: token ka username → us agent ki (username, agentId) ──
//    Records isi scope ke against match hote hain; scope kabhi widen nahi hota.
const _scopeCache = new Map();
function resolveAgentScope(auth, cb) {
    const uname = String((auth && auth.username) || '').trim().toLowerCase();
    if (!uname) return cb(null, null);
    const hit = _scopeCache.get(uname);
    if (hit && Date.now() - hit.t < 30000) return cb(null, hit.scope);
    db.query('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['agents'], function (err, rows) {
        if (err) return cb(err);
        let list = [];
        try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
        const a = (Array.isArray(list) ? list : []).find(function (x) { return x && String(x.username || '').toLowerCase() === uname; });
        const scope = { username: uname, agentId: a && a.agentId ? String(a.agentId) : '', name: a ? (a.name || '') : '', company: a ? (a.company || '') : '' };
        _scopeCache.set(uname, { t: Date.now(), scope: scope });
        cb(null, scope);
    });
}
function resolveAgentScopeP(auth) {
    return new Promise(function (resolve, reject) { resolveAgentScope(auth, function (e, s) { if (e) reject(e); else resolve(s); }); });
}
const AGENT_LINK_FIELDS = ['agentId', 'ownerUser', 'agentUsername', 'registeredAgentId', 'scopeAgentId', 'agent_id', 'agent_username'];
function belongsToAgent(rec, scope) {
    if (!rec || typeof rec !== 'object' || !scope) return false;
    const a = String(scope.agentId || '').toLowerCase();
    for (let i = 0; i < AGENT_LINK_FIELDS.length; i++) {
        const v = rec[AGENT_LINK_FIELDS[i]];
        if (v == null || v === '') continue;
        const s = String(v).trim().toLowerCase();
        if (s && (s === scope.username || (a && s === a))) return true;
    }
    return false;
}
// Kaun apne record ke PII dekh sakta hai:
//   admin/staff → sab (pehle jaisa); agent → sirf apne scope ke records;
//   student/employee → sirf apna khud ka record; baaki/anonymous → koi nahi.
function canViewOwnPii(auth, scope, rec) {
    const role = String((auth && auth.role) || '').toLowerCase();
    if (role === 'admin' || role === 'staff') return true;
    if (!auth) return false;
    if (role === 'agent') return !!scope && belongsToAgent(rec, scope);
    const uname = String(auth.username || '').trim().toLowerCase();
    if (!uname) return false;
    if (role === 'student') return [rec.id, rec.studentId].some(function (v) { return v != null && String(v).trim().toLowerCase() === uname; });
    if (role === 'employee') return [rec.empId, rec.empid].some(function (v) { return v != null && String(v).trim().toLowerCase() === uname; });
    return false;
}
function sanitizeArrayForViewer(arr, auth, scope) {
    if (!Array.isArray(arr)) return arr;
    const role = String((auth && auth.role) || '').toLowerCase();
    if (role === 'admin' || role === 'staff') return arr;
    return arr.map(function (rec) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
        return canViewOwnPii(auth, scope, rec) ? rec : stripPiiIfNeeded(rec);
    });
}
// Response bhejne se pehle array ko viewer ke hisaab se saaf karta hai.
// Kuch bhi galat ho to FAIL-CLOSED: saari PII hata kar bhejta hai (leak nahi).
function sendPiiSafeArray(req, res, arr) {
    const auth = getAuthUser(req);
    const role = String((auth && auth.role) || '').toLowerCase();
    if (role === 'admin' || role === 'staff') return res.json(arr);
    function done(scope) {
        let out;
        try { out = sanitizeArrayForViewer(arr, auth, scope); }
        catch (e) { console.error('❌ PII sanitize error (fail-closed):', e.message); out = arr.map(stripPiiIfNeeded); }
        res.json(out);
    }
    if (role === 'agent') return resolveAgentScope(auth, function (e, scope) { done(e ? null : scope); });
    done(null);
}

// ── Write-side protection: read par kisi viewer ke liye PII hata di jaati hai,
//    aur frontend poori array wapas POST karta hai. Agar hum kuch na karein to
//    doosre records ki Aadhaar/PAN save ke waqt ud jaayegi. Isliye jo PII field
//    incoming record mein HAI HI NAHI (undefined), use purane record se wapas
//    jod dete hain. (Explicit '' / null bhejne par clear ho jaata hai.) ──
const PII_MERGE_TARGETS = {
    kv_admin_entities: ['students', 'staff', 'agents'],
    kv_blob: ['pending_staff', 'hrms_employees', 'hrms_registrations', 'hrms_pending_registrations']
};
function recIdentity(rec) {
    const f = ['id', 'studentId', 'empId', 'empid', 'username', 'agentId', 'regId'];
    for (let i = 0; i < f.length; i++) {
        const v = rec[f[i]];
        if (v != null && String(v).trim() !== '') return f[i] + ':' + String(v).trim().toLowerCase();
    }
    return null;
}
function mergePiiFromExisting(incoming, existing) {
    if (!Array.isArray(incoming) || !Array.isArray(existing)) return incoming;
    const byId = new Map();
    existing.forEach(function (r) {
        if (r && typeof r === 'object') { const k = recIdentity(r); if (k && !byId.has(k)) byId.set(k, r); }
    });
    return incoming.map(function (rec) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
        const k = recIdentity(rec);
        const old = k ? byId.get(k) : null;
        if (!old) return rec;
        let copy = null;
        Object.keys(old).forEach(function (f) {
            if (isPiiKey(f) && old[f] !== undefined && !Object.prototype.hasOwnProperty.call(rec, f)) {
                copy = copy || Object.assign({}, rec);
                copy[f] = old[f];
            }
        });
        return copy || rec;
    });
}

// ── Audit log: kisne, kab, kaunsi PII search/reveal ki (raw number kabhi nahi) ──
function auditPii(req, action, target, detail) {
    try {
        const auth = (req && req.authUser) || (req && getAuthUser(req));
        db.query(
            'INSERT INTO pii_audit_log (actor_role, actor_username, action, target, detail, ip) VALUES (?,?,?,?,?,?)',
            [auth ? String(auth.role || '') : 'anonymous', auth ? String(auth.username || '') : '', cleanText(action, 50), cleanText(target, 200), cleanText(detail, 500), req ? cleanText(req.ip || '', 64) : ''],
            function (e) { if (e) console.warn('⚠️ pii audit insert fail:', e.message); }
        );
    } catch (e) { /* audit kabhi request ko fail nahi karta */ }
}

// 🆕 PERMANENT FIX for "Block karne par bhi user login/kaam karta rehta hai":
//   Login-time JWT token 7 din tak valid rehta hai aur usme sirf userId/role
//   store hota hai — agar Admin kisi CURRENTLY LOGGED-IN user ko beech mein
//   block kar de, to purana token khud-ba-khud invalid nahi hota (JWT ka yehi
//   design hai)। Isliye material-user ke har sensitive action (bill save/edit/
//   delete, mobile number change) par yeh middleware turant DB se current
//   status dobara check karta hai — token valid hone ke bawajood block hote
//   hi agli hi request se turant 403 mil jaata hai, session khatam hone ka
//   intezaar nahi karna padta.
function requireActiveMaterialUser(req, res, next) {
    const auth = getAuthUser(req);
    // 🔒 Admin ko hamesha full access rehta hai (Admin Panel isi route se
    // kisi bhi user ka bill edit/delete karta hai) — ownership check us
    // case mein route-level par khud skip ho jaata hai (neeche dekhein).
    if (auth && String(auth.role || '').toLowerCase() === 'admin') {
        req.authUser = auth;
        return next();
    }
    // 🔒 SECURITY FIX: pehle yahan bina token/galat-role wali request bhi
    // next() bula kar aage jaane deta tha — matlab material bills
    // (create/edit/delete) aur mobile-number-change jaisi sensitive
    // actions BINA KISI LOGIN ke bhi kaam kar jaati thi. Ab yeh middleware
    // ek asli authentication gate hai: valid material_user token na ho to
    // seedha 401.
    if (!auth || auth.role !== 'material_user' || !auth.userId) {
        return res.status(401).json({ error: 'Login is required — your session may have expired. Please log in again.' });
    }
    db.query('SELECT status FROM material_users WHERE userid = ?', [auth.userId], (err, rows) => {
        if (err) return next(); // DB check fail ho jaaye to request block mat karo
        if (rows && rows[0] && rows[0].status === 'blocked') {
            return res.status(403).json({ error: 'This ID has been blocked by the administrator. You can no longer use this portal.' });
        }
        req.authUser = auth; // 🔒 aage routes isi verified identity ko use karte hain
        next();
    });
}

/* --------------------------------------------------------------------------
   Database Connection (Supabase / PostgreSQL Compatible)
-------------------------------------------------------------------------- */

// insertWithIdHeal — Postgres mein 'id SERIAL PRIMARY KEY' hamesha khud
// apna default value (sequence se) leta hai, isliye MySQL wali "Field 'id'
// doesn't have a default value" error yahan kabhi aa hi nahi sakti — is
// function ka self-heal/retry hissa is liye ab zaroori nahi raha. Function
// wahi rehta hai (sirf db.query ko forward karta hai) taaki neeche ke ~15
// call sites bina badle chalte rahein.
function insertWithIdHeal(sql, params, tableName, callback) {
    db.query(sql, params, callback);
}
const db = new Pool(
    process.env.DATABASE_URL
        ? {
            // Supabase Connection String (Project Settings → Database → Connection string
            // → "URI" ya "Connection pooling"). Format:
            // postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 30000,
            idleTimeoutMillis: 60000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10000,
            max: 10
        }
        : {
            // Discrete params (agar DATABASE_URL na ho to fallback) — Supabase
            // Project Settings → Database mein yeh sab alag-alag bhi milte hain.
            host: process.env.DB_HOST,
            port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 30000,
            idleTimeoutMillis: 60000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10000,
            max: 10
        }
);

// 🆕 Pool-level error handler — agar koi idle connection background mein
// khud hi drop ho jaaye, to Node.js process crash nahi hoga, sirf log hoga.
db.on('error', (err) => {
    console.error('❌ Postgres pool-level error (auto-recovered, removed from the connection pool):', err.code || err.message);
});

// ══════════════════════════════════════════════════════════════════
// 🔄 MYSQL2 → PG COMPATIBILITY SHIM
//   Poori file mein ~90+ jagah `db.query(sql, params, callback)` MySQL2
//   ke andaaz mein likha hua hai: '?' placeholders, backtick-quoted
//   column naam (jaise `key`), callback mein seedhe 'rows' array milna
//   (SELECT ke liye), aur 'result.insertId'/'result.affectedRows' milna
//   (INSERT/UPDATE/DELETE ke liye). node-postgres (pg) in sabka format
//   alag hai — '$1,$2' placeholders, double-quote identifiers, callback
//   mein '{rows, rowCount}' object.
//   Is shim ka maksad: NEECHE ki saari 90+ existing routes BINA CHHUE
//   kaam karte rahein — SQL text ko yahin (ek hi jagah) convert kar
//   diya jaata hai, aur pg ka result wapas mysql2-jaisi shape mein de
//   diya jaata hai.
// ══════════════════════════════════════════════════════════════════
const TRANSIENT_DB_ERROR_CODES = [
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE',
    '57P03', // cannot_connect_now
    '08006', // connection_failure
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08004'  // sqlserver_rejected_establishment_of_sqlconnection
];

// Tables jinke 'id' column par SERIAL (auto-increment) hai — INSERT ke baad
// '.insertId' chahiye to yahan RETURNING id khud-b-khud jud jaata hai.
const AUTO_ID_TABLES = new Set([
    'users', 'material_user_requests', 'material_users', 'material_bills',
    'attendance_records', 'fee_payments', 'site_files',
    'wallet_withdrawals', 'wallet_direct_payments'
]);

function convertSqlToPg(sql) {
    // MySQL backtick identifiers → Postgres double-quote identifiers
    let out = sql.replace(/`([^`]+)`/g, '"$1"');
    // '?' positional placeholders → '$1, $2, ...' (order-preserving)
    let i = 0;
    out = out.replace(/\?/g, () => '$' + (++i));
    // Agar INSERT INTO kisi AUTO_ID table mein hai aur RETURNING already
    // nahi hai, to '.insertId' compatibility ke liye khud jod dete hain.
    if (/^\s*INSERT\s+INTO/i.test(out) && !/RETURNING/i.test(out)) {
        const m = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(out);
        if (m && AUTO_ID_TABLES.has(m[1])) {
            out = out.replace(/;\s*$/, '') + ' RETURNING id';
        }
    }
    return out;
}

const _rawPgQuery = db.query.bind(db);
db.query = function (sql, params, callback) {
    // db.query(sql, cb) aur db.query(sql, params, cb) — dono call-styles support karo
    if (typeof params === 'function') { callback = params; params = undefined; }
    const pgSql = convertSqlToPg(sql);
    const pgParams = params !== undefined ? params : [];
    function attempt(retriesLeft) {
        _rawPgQuery(pgSql, pgParams, (err, result) => {
            if (err && TRANSIENT_DB_ERROR_CODES.includes(err.code) && retriesLeft > 0) {
                console.warn('⚠️ DB transient error (' + err.code + ') — retrying in 500ms (' + retriesLeft + ' attempt(s) remaining)...');
                setTimeout(() => attempt(retriesLeft - 1), 500);
                return;
            }
            if (err) { if (callback) callback(err); return; }
            // mysql2-compatible shape: rows array (SELECT ke liye) + usi
            // array par insertId/affectedRows properties (INSERT/UPDATE/
            // DELETE consumers ke liye) — JS arrays objects hi hain, isliye
            // dono ek saath chal sakte hain.
            const compat = result.rows || [];
            compat.insertId = (result.rows && result.rows[0] && result.rows[0].id) || undefined;
            compat.affectedRows = result.rowCount || 0;
            if (callback) callback(null, compat, result.fields);
        });
    }
    attempt(2); // pehli koshish + 2 retries = total 3 attempts
};

// `db.getConnection()` (startup table-setup ke liye) — pg Pool mein iska
// naam `.connect()` hai aur release ek alag callback-param hoti hai; yeh
// shim usi connection object par mysql2-jaisa `.release()` method jod
// deta hai taaki neeche ka startup code bina badle chal sake.
const _rawPgConnect = db.connect.bind(db);
db.getConnection = function (cb) {
    _rawPgConnect(function (err, client, releaseFn) {
        if (err) return cb(err);
        client.release = releaseFn;
        cb(null, client);
    });
};

const JWT_SECRET = process.env.JWT_SECRET;

// 🔒 SECURITY: pehle DB password aur JWT secret seedhe code mein likhe the
// (agar yeh code kabhi public GitHub repo mein hota, to password sabko dikh
// jaata). Ab sab kuch sirf Render ke Environment Variables se aata hai —
// koi bhi secret ab is file mein kahin nahi likha. Agar zaroori variable
// missing ho, to server turant clearly bata dega (chup-chaap galat/khaali
// credential se connect karne ki koshish nahi karega).
const REQUIRED_ENV = process.env.DATABASE_URL ? ['DATABASE_URL', 'JWT_SECRET'] : ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
    console.error('❌ The following required environment variables are not set in the Render Dashboard: ' + missingEnv.join(', '));
    console.error('   Go to Render → your service → Environment tab and add them, otherwise the database and login features will not work.');
}

// 🆕 DIAGNOSTIC LOG: exact config (password masked) jo istemal ho raha hai —
// taaki agar connection fail ho to Render Logs mein turant dikh jaaye ki
// KAUN SA host/port/database/user try ho raha hai. "Total outage" (yaani
// HAR route fail ho raha ho) zyada tar in wajahon se hoti hai, jinhe
// timeout/retry jaisi client-side tuning theek nahi kar sakti:
//   1. DATABASE_URL (ya DB_HOST/DB_PORT) galat hai Render Environment mein
//   2. Supabase project paused pada hai (free-tier projects kuch din ki
//      inactivity ke baad khud paused ho jaate hain — Supabase Dashboard
//      kholkar "Restore project" karna padta hai)
//   3. DB_USER/DB_PASSWORD galat hai
if (process.env.DATABASE_URL) {
    console.log('🔍 Attempting DB connection → using DATABASE_URL (connection string) — it is set ✓');
} else {
    console.log('🔍 Attempting DB connection → host=' + (process.env.DB_HOST || '❌ MISSING') +
        ' port=' + (process.env.DB_PORT || '5432 (default)') +
        ' database=' + (process.env.DB_NAME || '❌ MISSING') +
        ' user=' + (process.env.DB_USER ? process.env.DB_USER[0] + '***' : '❌ MISSING') +
        ' password=' + (process.env.DB_PASSWORD ? '***set*** (' + process.env.DB_PASSWORD.length + ' chars)' : '❌ MISSING'));
}

// 🆕 Startup par bhi retry-with-backoff — agar DB thodi der ke liye
// unreachable ho (jaise Render aur DB ek saath cold-start ho rahe hon),
// to sirf ek baar try karke haar maan lene ki bajaye 5 baar, badhte hue
// gap ke saath, try karta hai. Yeh sirf ek quick health-check hai —
// asli table-setup (neeche) apne aap chalta hai jaise pehle chalta tha.
function connectWithRetry(attemptsLeft, delayMs) {
    db.getConnection((err, connection) => {
        if (err) {
            console.error('❌ DB connection attempt fail: ' + err.code + ' — ' + err.message);
            if (attemptsLeft > 1) {
                console.warn('⏳ ' + (delayMs / 1000) + ' seconds before the next retry. (' + (attemptsLeft - 1) + ' attempt(s) remaining)');
                setTimeout(() => connectWithRetry(attemptsLeft - 1, Math.min(delayMs * 2, 30000)), delayMs);
            } else {
                console.error('❌❌❌ Unable to connect to the database. Please verify the following checklist:');
                console.error('   1. Are DATABASE_URL (or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME) correct in Render → Environment tab?');
                console.error('   2. Check that the project is not Paused in the Supabase Dashboard (free-tier projects pause automatically after a few days of inactivity).');
                console.error('   3. Was the connection string (URI) copied correctly from Supabase → Project Settings → Database?');
                console.error('   4. This is a PostgreSQL database — this configuration does not apply if MySQL/mysql2 is set up elsewhere.');
                console.error('   The server will keep running and will attempt new connections whenever a request is received.');
            }
            return;
        }
        console.log('✓ Quick health-check connection succeeded — database is reachable.');
        connection.release();
    });
}

// 🔑 MASTER ADMIN SEED — runs once at startup and ONLY when no admin exists.
//   Default credentials: Anmol / Anmol@2003 (override with MASTER_ADMIN_USERNAME / MASTER_ADMIN_PASSWORD).
//   Change the password from the Admin Panel after the first login.
function seedMasterAdmin(attempt) {
    attempt = attempt || 1;
    db.query('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['admins'], (err, rows) => {
        if (err) { if (attempt < 6) setTimeout(() => seedMasterAdmin(attempt + 1), 5000); return; }
        let list = [];
        try { list = JSON.parse(rows && rows[0] && rows[0].value) || []; } catch (e) { list = []; }
        if (list.length) return;
        const uname = process.env.MASTER_ADMIN_USERNAME || 'Anmol';
        const pwd = process.env.MASTER_ADMIN_PASSWORD || 'Anmol@2003';
        const admin = { id: 'ADM' + Date.now(), username: uname, name: 'Anmol Kumar', role: 'Super Admin', status: 'active', password: bcrypt.hashSync(pwd, 10), lastLogin: null };
        db.query('INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['admins', JSON.stringify([admin])],
            (e2) => console.log(e2 ? 'Master admin seed failed: ' + e2.message : 'Master admin account created: ' + uname));
    });
}
setTimeout(() => seedMasterAdmin(1), 8000);

// 🏷️ Multi-tenant branding: public library name/contact for payment links and receipts
app.get('/api/library-branding/:agentId', (req, res) => {
    findAgentByIdOrUsername(req.params.agentId, (err, agent) => {
        if (err) return res.status(500).json({ error: 'Unable to load library details.' });
        if (!agent) return res.status(404).json({ error: 'Library not found.' });
        res.json({
            agentId: agent.agentId || '', libraryName: agent.company || agent.name || 'Library',
            mobile: agent.mobile || '', address: agent.address || '', upi: agent.upi || agent.upiId || ''
        });
    });
});

connectWithRetry(5, 2000);

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Table setup failed: ' + err.message);
        return;
    }
    console.log('✓ Successfully connected to the database.');

    // 🆕 Postgres mein columns UNQUOTED likhne par khud-b-khud lowercase ho
    // jaate hain (jaise ownerUserId → owneruserid) — poori file mein saari
    // queries bhi inhe kahin quote nahi karti (sirf `key` backtick se aata
    // hai, jo shim ne upar "key" mein convert kiya hai), isliye yeh consistent
    // rehta hai aur sab kuch bina kisi extra rename ke match karta hai.
    const DDL_STATEMENTS = [
        ['users', `
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Material user pending-registration requests (Anmol_material_entry_secure.html
        // ke "रजिस्ट्रेशन अनुरोध भेजें" form se yahan aata hai, admin approve karta hai)
        ['material_user_requests', `
            CREATE TABLE IF NOT EXISTS material_user_requests (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                village VARCHAR(255),
                address VARCHAR(500),
                email VARCHAR(255),
                mobile VARCHAR(20) NOT NULL,
                photo TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Approved material users / agents (jinhe userId + password mil chuka hai
        // aur jo Anmol_material_entry_secure.html se login karke bill entry karte hain)
        ['material_users', `
            CREATE TABLE IF NOT EXISTS material_users (
                id SERIAL PRIMARY KEY,
                userId VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                village VARCHAR(255),
                address VARCHAR(500),
                email VARCHAR(255),
                mobile VARCHAR(20) UNIQUE NOT NULL,
                photo TEXT,
                password_hash VARCHAR(255),
                status VARCHAR(20) DEFAULT 'active',
                blockedReason VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Material bills/invoices (Anmol_material_entry_secure.html)
        ['material_bills', `
            CREATE TABLE IF NOT EXISTS material_bills (
                id SERIAL PRIMARY KEY,
                ownerUserId VARCHAR(50) NOT NULL,
                data TEXT,
                savedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Generic key-value stores — admin-entities (admins/staff/agents/students
        // arrays) aur blob (settings/notices/mem_plans/... ) aur site-data (site
        // content JSON). Frontend hamesha poori array/object ek saath bhejta-padta
        // hai, isliye ek generic table kaafi hai. "key" quoted hai kyunki shim
        // backtick-columns (`key`) ko double-quote mein convert karta hai.
        ['kv_admin_entities', `
            CREATE TABLE IF NOT EXISTS kv_admin_entities (
                "key" VARCHAR(100) PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        ['kv_blob', `
            CREATE TABLE IF NOT EXISTS kv_blob (
                "key" VARCHAR(100) PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        ['kv_site_data', `
            CREATE TABLE IF NOT EXISTS kv_site_data (
                "key" VARCHAR(100) PRIMARY KEY,
                value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Attendance (date+batch pe keyed merge — Student_Attendance.html)
        ['attendance_records', `
            CREATE TABLE IF NOT EXISTS attendance_records (
                id SERIAL PRIMARY KEY,
                date VARCHAR(20) NOT NULL,
                batch VARCHAR(20) NOT NULL,
                records TEXT,
                selfies TEXT,
                markedBy VARCHAR(255),
                savedAt VARCHAR(50),
                UNIQUE (date, batch)
            )
        `],
        // 🆕 Student fee payments
        ['fee_payments', `
            CREATE TABLE IF NOT EXISTS fee_payments (
                id SERIAL PRIMARY KEY,
                studentId VARCHAR(100) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                mode VARCHAR(50),
                note VARCHAR(500),
                status VARCHAR(20) DEFAULT 'paid',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Student → Agent direct-collect transactions (HRMS verify/reject flow)
        ['transactions', `
            CREATE TABLE IF NOT EXISTS transactions (
                id VARCHAR(50) PRIMARY KEY,
                agentId VARCHAR(100),
                studentId VARCHAR(100),
                amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                reason VARCHAR(500),
                data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 HRMS salary slips (admin-generated) + claims (staff self-submitted)
        ['hrms_salary_slips', `
            CREATE TABLE IF NOT EXISTS hrms_salary_slips (
                id VARCHAR(50) PRIMARY KEY,
                empId VARCHAR(100),
                data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        ['hrms_salary_claims', `
            CREATE TABLE IF NOT EXISTS hrms_salary_claims (
                id VARCHAR(50) PRIMARY KEY,
                empId VARCHAR(100),
                status VARCHAR(30) DEFAULT 'pending',
                agentId VARCHAR(100),
                netAmount DECIMAL(10,2),
                data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Agent wallets + withdrawals + direct payments
        ['agent_wallets', `
            CREATE TABLE IF NOT EXISTS agent_wallets (
                agentId VARCHAR(100) PRIMARY KEY,
                approved_balance DECIMAL(12,2) DEFAULT 0,
                pending_balance DECIMAL(12,2) DEFAULT 0,
                total_earned DECIMAL(12,2) DEFAULT 0
            )
        `],
        ['wallet_withdrawals', `
            CREATE TABLE IF NOT EXISTS wallet_withdrawals (
                id SERIAL PRIMARY KEY,
                agentId VARCHAR(100) NOT NULL,
                agentName VARCHAR(255),
                amount DECIMAL(10,2) NOT NULL,
                accName VARCHAR(255), bankName VARCHAR(255), accNo VARCHAR(50), ifsc VARCHAR(20),
                status VARCHAR(20) DEFAULT 'pending',
                reason VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        ['wallet_direct_payments', `
            CREATE TABLE IF NOT EXISTS wallet_direct_payments (
                id SERIAL PRIMARY KEY,
                agentId VARCHAR(100) NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                note VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // ══════════════════════════════════════════════════════════════
        // 🆕 PFMS (Accountant) PORTAL — Agent payout request → HRMS/Staff
        //   approval → PFMS "Pay Now" (wallet debit + ledger entry).
        //   PFMS login credentials Admin banata hai (bcrypt-hashed password,
        //   'admins' table jaisa hi pattern).
        // ══════════════════════════════════════════════════════════════
        ['pfms_users', `
            CREATE TABLE IF NOT EXISTS pfms_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(255),
                password_hash VARCHAR(255) NOT NULL,
                status VARCHAR(20) DEFAULT 'active',
                created_by_admin VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        ['payout_requests', `
            CREATE TABLE IF NOT EXISTS payout_requests (
                id VARCHAR(50) PRIMARY KEY,
                agentId VARCHAR(100) NOT NULL,
                agentName VARCHAR(255),
                amount DECIMAL(12,2) NOT NULL,
                reason VARCHAR(500),
                status VARCHAR(20) DEFAULT 'Pending',
                hr_approved_by VARCHAR(100),
                hr_approved_at TIMESTAMP,
                pfms_paid_by VARCHAR(100),
                pfms_paid_at TIMESTAMP,
                rejected_reason VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Student subscription Razorpay orders — jab order create hota hai
        // tabhi studentId/planId/days yahan save ho jaate hain, taaki verify
        // step client se dobara yeh values na maange (jo tamper ho sakti thin)
        // balki seedha yahi se padh kar student ko activate kare.
        ['student_subscription_orders', `
            CREATE TABLE IF NOT EXISTS student_subscription_orders (
                orderId VARCHAR(100) PRIMARY KEY,
                studentId VARCHAR(100) NOT NULL,
                planId VARCHAR(150),
                planName VARCHAR(150),
                days INT NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'created',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Agent subscription Razorpay orders — student_subscription_orders
        // jaisa hi, taaki verify step client se plan/amount/days dobara na
        // maange (jo tamper ho sakti thin) balki seedha yahi se padhe.
        ['agent_subscription_orders', `
            CREATE TABLE IF NOT EXISTS agent_subscription_orders (
                orderId VARCHAR(100) PRIMARY KEY,
                username VARCHAR(100) NOT NULL,
                planId VARCHAR(150),
                planName VARCHAR(150),
                days INT NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'created',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 Customer Registration Razorpay orders — jab order create hota
        // hai tabhi customer ka naam/mobile/plan/amount yahan save ho jaate
        // hain, taaki verify step client se dobara yeh values na maange
        // (jo tamper ho sakti thin) balki seedha yahi se padhe.
        ['customer_registration_orders', `
            CREATE TABLE IF NOT EXISTS customer_registration_orders (
                orderId VARCHAR(100) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                mobile VARCHAR(20) NOT NULL,
                email VARCHAR(255),
                address VARCHAR(500),
                note VARCHAR(500),
                agentId VARCHAR(100) NOT NULL,
                planId VARCHAR(150),
                planName VARCHAR(150),
                amount DECIMAL(10,2) NOT NULL,
                status VARCHAR(20) DEFAULT 'created',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],

        // ══════════════════════════════════════════════════════════════
        // 🆕 KYC VAULT — Aadhaar / PAN / district / state / pin (encrypted).
        //   Poora Aadhaar/PAN kabhi plain-text nahi: *_enc = AES-256-GCM,
        //   *_hash = HMAC blind-index (exact search), aadhaar_last4/pan_masked
        //   sirf display ke liye. Search + agent-scope isi table se hota hai.
        // ══════════════════════════════════════════════════════════════
        ['kyc_records', `
            CREATE TABLE IF NOT EXISTS kyc_records (
                id SERIAL PRIMARY KEY,
                entity_type VARCHAR(30) NOT NULL,
                entity_id VARCHAR(100) NOT NULL,
                full_name VARCHAR(255),
                mobile VARCHAR(20),
                email VARCHAR(255),
                address VARCHAR(500),
                district VARCHAR(120),
                state VARCHAR(120),
                pin_code VARCHAR(10),
                agent_id VARCHAR(100),
                agent_username VARCHAR(100),
                aadhaar_last4 VARCHAR(4),
                aadhaar_hash VARCHAR(64),
                aadhaar_enc TEXT,
                pan_hash VARCHAR(64),
                pan_enc TEXT,
                pan_masked VARCHAR(12),
                status VARCHAR(30) DEFAULT 'active',
                source VARCHAR(40),
                plan_id VARCHAR(150),
                plan_name VARCHAR(150),
                amount DECIMAL(10,2),
                payment_ref VARCHAR(100),
                created_by VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (entity_type, entity_id)
            )
        `],
        // 🆕 Kisne kab kaunsi PII search/reveal ki (raw number kabhi store nahi hota)
        ['pii_audit_log', `
            CREATE TABLE IF NOT EXISTS pii_audit_log (
                id SERIAL PRIMARY KEY,
                ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                actor_role VARCHAR(30),
                actor_username VARCHAR(100),
                action VARCHAR(50),
                target VARCHAR(200),
                detail VARCHAR(500),
                ip VARCHAR(64)
            )
        `],

        // 🆕 Uploaded files (Hero image / Logo / APK / login-page HTML) — DB mein
        // hi blob ki tarah store hote hain, kyunki Render ka disk restart/redeploy
        // pe reset ho jaata hai. 'slug': login-pages jaisi cheezon ko ek FIXED,
        // memorable URL deta hai (jaise /api/pages/agent-login) jo kabhi nahi
        // badalta — chahe file dobara upload/update kyun na ho jaaye. LONGBLOB →
        // BYTEA (Postgres ka binary-data type; node-postgres Buffer object ko
        // ismein seedha, bina kisi extra conversion ke, store kar deta hai).
        ['site_files', `
            CREATE TABLE IF NOT EXISTS site_files (
                id SERIAL PRIMARY KEY,
                slug VARCHAR(150) UNIQUE,
                folder VARCHAR(100),
                name VARCHAR(255),
                mime VARCHAR(150),
                size INT,
                data BYTEA,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `],
        // 🆕 GLOBAL NOTIFICATION SYSTEM — Admin→Agent, Admin→SabAgents,
        // Agent→Student, Agent→SabStudents, Agent→Employee, Agent→SabEmployees.
        // target_scope: 'agent' | 'all_agents' | 'student' | 'all_students' |
        //               'employee' | 'all_employees'
        // target_id: specific agentId/studentId/empId (all_* ke liye NULL)
        // scope_agent_id: 'all_students'/'all_employees' ke liye — kis agent
        //                 ke sabhi students/employees ko yeh jaayega
        // read_by: JSON array — jinhone padh liya unki id (agentId/studentId/
        //          empId/'admin') yahan add ho jaati hai
        ['notifications', `
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                from_role VARCHAR(30) NOT NULL,
                from_name VARCHAR(255),
                target_scope VARCHAR(30) NOT NULL,
                target_id VARCHAR(100),
                scope_agent_id VARCHAR(100),
                title VARCHAR(255) NOT NULL,
                message TEXT,
                urgency VARCHAR(20) DEFAULT 'info',
                read_by TEXT DEFAULT '[]',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `]
    ];

    // 🆕 Purani (pehle se maujood) tables mein missing columns jodne ke liye —
    // Postgres ka 'ADD COLUMN IF NOT EXISTS' MySQL ke "Duplicate column error
    // ko catch karo" pattern se kaafi seedha/saaf hai, koi error-message
    // pattern-matching ki zaroorat nahi.
    const COLUMN_FIXES = [
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS address VARCHAR(500)",
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS email VARCHAR(255)",
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'",
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS blockedReason VARCHAR(500)",
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS photo TEXT",
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)",
        // 🆕 INVOICE PAYMENT GATE: Admin is column se decide karta hai ki
        // kis specific material user ke liye "Generate Invoice se pehle
        // Razorpay payment mandatory" wala check SKIP ho — baaki sab par
        // yeh hamesha mandatory rehta hai.
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS invoicePaymentExempt BOOLEAN DEFAULT false",
        // 🆕 PER-USER CUSTOM PAYMENT AMOUNT: agar yeh NULL hai, to us user ke
        // liye "Generate Invoice" par Admin ke GLOBAL Fixed Amount
        // ('material_invoice_settings') ke hisaab se charge hota hai (pehle
        // jaisa behavior). Agar Admin ne yahan koi specific amount daal diya
        // hai (jaise ₹5, ₹10, ₹20, ₹100...), to Global Amount ko IGNORE karke
        // seedha yehi individual amount Razorpay order mein use hota hai.
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS invoiceAmount DECIMAL(10,2)",
        "ALTER TABLE material_bills ADD COLUMN IF NOT EXISTS ownerUserId VARCHAR(50) NOT NULL DEFAULT ''",
        "ALTER TABLE material_bills ADD COLUMN IF NOT EXISTS data TEXT",
        "ALTER TABLE material_bills ADD COLUMN IF NOT EXISTS savedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE site_files ADD COLUMN IF NOT EXISTS slug VARCHAR(150) UNIQUE",
        // 🆕 PFMS ↔ HRMS LINKING: payout_requests ab sirf Agent-payouts tak
        // seemit nahi — Employee ki Salary Slip bhi isi table se PFMS tak
        // jaati hai (type='employee_salary'), taaki PFMS ek hi jagah se
        // dono tarah ke payments process kar sake, bank details (jo
        // 'hrms_employees' se aate hain) ke saath.
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'agent_payout'",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS employeeId VARCHAR(50)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS salarySlipId VARCHAR(50)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS bankName VARCHAR(255)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS accountNo VARCHAR(50)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS ifsc VARCHAR(20)",
        // 🆕 RAZORPAYX LIVE PAYOUT INTEGRATION: automated bank-transfer +
        // employee/agent split ke liye.
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS agentShareAmount DECIMAL(12,2) DEFAULT 0",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS rzp_payout_id VARCHAR(100)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS rzp_payout_status VARCHAR(30)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS rzp_agent_payout_id VARCHAR(100)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS rzp_agent_payout_status VARCHAR(30)",
        "ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS payout_error VARCHAR(500)",
        // 🆕 CUSTOMER REGISTRATION KYC: district/state/pin + Aadhaar last-4 + PAN (encrypted)
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS district VARCHAR(120)",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS state VARCHAR(120)",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS pin_code VARCHAR(10)",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS aadhaar_last4 VARCHAR(4)",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS aadhaar_hash VARCHAR(64)",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS aadhaar_enc TEXT",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS pan_enc TEXT",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS pan_hash VARCHAR(64)",
        "ALTER TABLE customer_registration_orders ADD COLUMN IF NOT EXISTS pan_masked VARCHAR(12)",
        // 🆕 KYC vault + audit indexes (search fast rakhne ke liye)
        "CREATE INDEX IF NOT EXISTS idx_kyc_aadhaar_hash ON kyc_records (aadhaar_hash)",
        "CREATE INDEX IF NOT EXISTS idx_kyc_aadhaar_last4 ON kyc_records (aadhaar_last4)",
        "CREATE INDEX IF NOT EXISTS idx_kyc_agent_username ON kyc_records (agent_username)",
        "CREATE INDEX IF NOT EXISTS idx_kyc_agent_id ON kyc_records (agent_id)",
        "CREATE INDEX IF NOT EXISTS idx_pii_audit_ts ON pii_audit_log (ts)"
    ];

    // 🆕 'updated_at' column ko row update hote hi khud-ba-khud "abhi" set
    // karne ke liye (MySQL ka 'ON UPDATE CURRENT_TIMESTAMP' — Postgres mein
    // yeh ek trigger se hota hai, inline column-option se nahi).
    const TRIGGER_SETUP = `
        CREATE OR REPLACE FUNCTION set_updated_at_now()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = CURRENT_TIMESTAMP;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    `;
    const TRIGGER_TABLES = ['kv_admin_entities', 'kv_blob', 'kv_site_data', 'site_files'];

    function runSequential(items, runOne, done) {
        let i = 0;
        function next() {
            if (i >= items.length) return done();
            runOne(items[i], () => { i++; next(); });
        }
        next();
    }

    runSequential(DDL_STATEMENTS, ([tableName, sql], cb) => {
        connection.query(sql, (e) => {
            if (e) console.error('❌ ' + tableName + ' table error:', e.message);
            cb();
        });
    }, () => {
        runSequential(COLUMN_FIXES, (sql, cb) => {
            connection.query(sql, (e) => {
                if (e) console.error('❌ Column fix error (' + sql + '):', e.message);
                cb();
            });
        }, () => {
            connection.query(TRIGGER_SETUP, (trigErr) => {
                if (trigErr) { console.error('❌ updated_at trigger function error:', trigErr.message); }
                runSequential(TRIGGER_TABLES, (t, cb) => {
                    connection.query(
                        `DROP TRIGGER IF EXISTS trg_set_updated_at ON ${t}; ` +
                        `CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON ${t} ` +
                        `FOR EACH ROW EXECUTE FUNCTION set_updated_at_now();`,
                        (e) => {
                            if (e) console.error('❌ ' + t + ' updated_at trigger error:', e.message);
                            cb();
                        }
                    );
                }, () => {
                    connection.release();
                    console.log('✅ All tables are ready — no feature will return 404 now.');
                });
            });
        });
    });
});

// ── Helpers: MU0001-style userId aur ek random 6-char password ──
function genMaterialUserId(cb) {
    // 🔒 FIX: Postgres mein unquoted column names hamesha lowercase mein fold
    // ho jaate hain, isliye query text/result key hamesha "userid" hi hota
    // hai. Pehle yahan "r.userId" (camelCase) padha jaata tha jo hamesha
    // undefined milta tha — isliye "max" hamesha 0 rehta tha aur naya ID
    // hamesha "MU001" hi ban-ta tha (chahe kitne bhi users pehle se ho),
    // jisse har naye user par duplicate-key collision + retry-exhaustion
    // (approve/register fail) hota tha.
    db.query("SELECT userid FROM material_users WHERE userid LIKE 'MU%'", (err, rows) => {
        if (err) return cb(err);
        let max = 0;
        (rows || []).forEach(r => {
            const num = parseInt(String(r.userid).replace('MU', ''), 10) || 0;
            if (num > max) max = num;
        });
        cb(null, 'MU' + String(max + 1).padStart(3, '0'));
    });
}
// 🔒 FIX: "duplicate key value violates unique constraint material_users_
// userid_key" — genMaterialUserId() sirf CURRENT max ID dekh kar agla
// number sochta hai. Agar do approve-requests (jaise admin ka double-click,
// ya do alag admin sessions) LAGBHAG EK SAATH aayein, dono ek hi "next" ID
// compute kar sakte hain — pehla insert safal hota hai, doosra isi duplicate-
// key error se fail ho jaata hai. Ab yeh helper INSERT ko khud retry karta
// hai (naya ID lekar) jab bhi yeh EXACT collision ho — user ko kabhi error
// dikhta hi nahi, aur ID kabhi khaali/wrong nahi rehti.
function insertMaterialUserWithRetry(buildParams, callback, attemptsLeft) {
    if (attemptsLeft === undefined) attemptsLeft = 5;
    genMaterialUserId((idErr, userId) => {
        if (idErr) return callback(idErr);
        const { sql, params } = buildParams(userId);
        db.query(sql, params, (insErr, result) => {
            if (insErr && insErr.code === '23505' && /userid/i.test(insErr.message || '') && attemptsLeft > 1) {
                console.warn('⚠️ Material User ID collision (' + userId + ') — retrying with a new ID...');
                return insertMaterialUserWithRetry(buildParams, callback, attemptsLeft - 1);
            }
            if (insErr) return callback(insErr);
            callback(null, result, userId);
        });
    });
}
function genMuPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let pwd = '';
    for (let i = 0; i < 6; i++) pwd += chars.charAt(Math.floor(Math.random() * chars.length));
    return pwd;
}

// 🆕 PER-USER CUSTOM PAYMENT AMOUNT — helper: client se aaya hua kuch bhi
// (khaali string, undefined, negative, non-number, waghera) ko safely
// ya to ek positive 2-decimal number, ya NULL (= "koi override nahi, global
// default istemal hoga") mein convert karta hai. Isse kabhi bhi DB mein
// invalid ya negative amount save nahi ho sakta.
function sanitizeInvoiceAmount(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 100) / 100;
}

// ══════════════════════════════════════════════════════════════════
// 🆕 MATERIAL USER / AGENT REGISTRATION & LOGIN ROUTES
//   (Anmol_material_entry_secure.html + Admin_panel_Login.html isi
//   se judte hain — pehle ye routes missing the, isliye 404 aata tha)
// ══════════════════════════════════════════════════════════════════

// 1) Public self-registration request (material_entry portal ka form)
app.post('/api/material/register', (req, res) => {
    const { name, village, address, email, mobile, photo } = req.body || {};
    if (!name || !village || !address || !email || !mobile) {
        return res.status(400).json({ error: 'Please fill in all required fields.' });
    }
    const dupSql = `SELECT id FROM material_users WHERE mobile = ?
                     UNION SELECT id FROM material_user_requests WHERE mobile = ?`;
    db.query(dupSql, [mobile, mobile], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (rows && rows.length) {
            return res.status(409).json({ error: 'This mobile number is already registered or pending.' });
        }
        insertWithIdHeal(
            'INSERT INTO material_user_requests (name, village, address, email, mobile, photo) VALUES (?,?,?,?,?,?)',
            [name, village, address, email, mobile, photo || null],
            'material_user_requests',
            (insErr) => {
                if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                res.status(201).json({ success: true });
            }
        );
    });
});

// 2) Admin: pending requests list
app.get('/api/material/requests', (req, res) => {
    db.query('SELECT * FROM material_user_requests ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});

// 3) Admin: approve a request → generates userId + password, moves it into material_users
app.post('/api/material/requests/:id/approve', (req, res) => {
    const reqId = req.params.id;
    db.query('SELECT * FROM material_user_requests WHERE id = ?', [reqId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'Request not found.' });
        const r = rows[0];
        const plainPassword = genMuPassword();
        const passwordHash = bcrypt.hashSync(plainPassword, 10);
        insertMaterialUserWithRetry(
            (userId) => ({
                sql: `INSERT INTO material_users (userid, name, village, address, email, mobile, photo, password_hash, status)
                      VALUES (?,?,?,?,?,?,?,?, 'active')`,
                params: [userId, r.name, r.village, r.address, r.email, r.mobile, r.photo, passwordHash]
            }),
            (insErr, result, userId) => {
                if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                db.query('DELETE FROM material_user_requests WHERE id = ?', [reqId], () => {
                    res.json({ userId, password: plainPassword });
                });
            }
        );
    });
});

// 4) Admin: reject/delete a pending request
app.post('/api/material/requests/:id/reject', (req, res) => {
    db.query('DELETE FROM material_user_requests WHERE id = ?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json({ success: true });
    });
});

// 5) Admin: list all material users (Admin Panel table)
app.get('/api/material/users', (req, res) => {
    // 🔒 FIX: Postgres unquoted columns hamesha lowercase mein fold ho jaate
    // hain (invoicePaymentExempt → invoicepaymentexempt) — isliye camelCase
    // quoted ALIAS ("invoicePaymentExempt") zaroori hai, warna neeche/Admin
    // Panel ka JS (jo hamesha camelCase property padhta hai, jaise
    // u.invoicePaymentExempt / u.invoiceAmount) hamesha undefined hi paata.
    db.query('SELECT id, userid, name, village, address, email, mobile, photo, status, blockedReason, invoicePaymentExempt AS "invoicePaymentExempt", invoiceAmount AS "invoiceAmount", created_at FROM material_users ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const mapped = (rows || []).map(u => Object.assign({ _docId: String(u.id) }, u));
        res.json(mapped);
    });
});

// 6) Admin: directly create a material user (bina request ke, "New Material User Register" form)
app.post('/api/material/users', (req, res) => {
    const { name, village, mobile, photo, status, invoicePaymentExempt, invoiceAmount } = req.body || {};
    if (!name || !village || !mobile) {
        return res.status(400).json({ error: 'Name, village and mobile number are required.' });
    }
    db.query('SELECT id FROM material_users WHERE mobile = ?', [mobile], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (rows && rows.length) return res.status(409).json({ error: 'This mobile number is already registered.' });
        const passwordHash = bcrypt.hashSync(genMuPassword(), 10);
        insertMaterialUserWithRetry(
            (userId) => ({
                sql: `INSERT INTO material_users (userid, name, village, mobile, photo, password_hash, status, invoicePaymentExempt, invoiceAmount)
                      VALUES (?,?,?,?,?,?,?,?,?)`,
                params: [userId, name, village, mobile, photo || null, passwordHash, status || 'active', !!invoicePaymentExempt, sanitizeInvoiceAmount(invoiceAmount)]
            }),
            (insErr, result, userId) => {
                if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                res.status(201).json({ userId });
            }
        );
    });
});

// 7) Admin: edit / block / unblock a material user
app.put('/api/material/users/:id', (req, res) => {
    const fields = req.body || {};
    const allowed = ['name', 'village', 'address', 'email', 'mobile', 'photo', 'status', 'blockedReason', 'invoicePaymentExempt'];
    const sets = [];
    const values = [];
    allowed.forEach(f => {
        if (Object.prototype.hasOwnProperty.call(fields, f)) {
            sets.push(f + ' = ?');
            values.push(fields[f]);
        }
    });
    // 🆕 PER-USER CUSTOM PAYMENT AMOUNT: alag se handle karte hain kyunki
    // ismein sanitization chahiye (khaali/invalid value → NULL, taaki woh
    // user wapas Global Default Amount par chala jaaye — "clear" karna bhi
    // isi field se possible hai).
    if (Object.prototype.hasOwnProperty.call(fields, 'invoiceAmount')) {
        sets.push('invoiceAmount = ?');
        values.push(sanitizeInvoiceAmount(fields.invoiceAmount));
    }
    if (!sets.length) return res.status(400).json({ error: 'No update data was provided.' });
    values.push(req.params.id);
    db.query(`UPDATE material_users SET ${sets.join(', ')} WHERE id = ?`, values, (err) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json({ success: true });
    });
});

// 7b) Admin/Live-sync: single material user ki details (photo field ke saath —
//     Anmol_material_entry_secure.html ka live-profile-sync isi route ko har
//     12 second mein poll karta hai taaki photo/status turant update ho jaaye)
app.get('/api/material/users/:id', (req, res) => {
    db.query(
        'SELECT id, userid, name, village, address, email, mobile, photo, status, blockedReason, invoicePaymentExempt AS "invoicePaymentExempt", invoiceAmount AS "invoiceAmount", created_at FROM material_users WHERE id = ?',
        [req.params.id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            if (!rows || !rows.length) return res.status(404).json({ error: 'Material user not found.' });
            res.json(Object.assign({ _docId: String(rows[0].id) }, rows[0]));
        }
    );
});

// 7c) Admin: material user ko permanently delete karna (Admin Panel "Delete User" feature)
app.delete('/api/material/users/:id', (req, res) => {
    db.query('DELETE FROM material_users WHERE id = ?', [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!result || !result.affectedRows) return res.status(404).json({ error: 'Material user not found.' });
        res.json({ success: true });
    });
});

// 8) Material user login (userId + mobile-number-or-admin-issued-password)
app.post('/api/material/login', (req, res) => {
    try {
        const userId = req.body && req.body.userId;
        // 🆕 FIX: 'secondFactor' hamesha String() mein convert kiya jaata hai —
        // agar frontend isse number ki tarah bhejta (jaise sirf mobile digits),
        // to bcrypt.compareSync() ek TypeError throw karta tha jo kahin bhi
        // catch nahi hota tha — poora Node.js process crash ho jaata tha!
        // Isi wajah se browser mein "Failed to fetch" (blank status) aata tha
        // — request backend tak pahunchi, par server hi crash ho gaya.
        const secondFactor = req.body && req.body.secondFactor != null ? String(req.body.secondFactor) : '';
        if (!userId || !secondFactor) return res.status(400).json({ error: 'User ID and Mobile/Password are both required.' });
        db.query('SELECT * FROM material_users WHERE userid = ?', [String(userId)], (err, rows) => {
            try {
                if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                if (!rows || !rows.length) return res.status(404).json({ error: 'User ID is not registered in the system.' });
                const u = rows[0];
                if (u.status === 'blocked') {
                    return res.status(403).json({ error: 'This ID has been blocked by the administrator.' });
                }
                const mobileMatches = String(u.mobile || '').replace(/\D/g, '').slice(-10) === secondFactor.replace(/\D/g, '').slice(-10);
                const passwordMatches = (u.password_hash && typeof u.password_hash === 'string')
                    ? bcrypt.compareSync(secondFactor, u.password_hash)
                    : false;
                if (!mobileMatches && !passwordMatches) {
                    return res.status(401).json({ error: 'Invalid mobile number or password.' });
                }
                // 🔒 FIX: pehle "u.userId" (camelCase) padha jaata tha jo Postgres
                // row mein hamesha undefined hota hai (asli key "userid" hai) —
                // isliye JWT token mein userId hamesha undefined save ho raha tha.
                // Isi wajah se requireActiveMaterialUser() middleware ka block-check
                // hamesha skip ho jaata tha (blocked user bhi login ke baad kaam
                // karta rehta tha), aur "मोबाइल नंबर बदलें" route bhi हमेशा
                // "Yeh User ID nahi mila" error deta tha.
                const token = jwt.sign({ userId: u.userid, role: 'material_user' }, JWT_SECRET, { expiresIn: '7d' });
                const { password_hash, ...userSafe } = u;
                userSafe._docId = String(u.id);
                res.json({ user: userSafe, token });
            } catch (innerErr) {
                console.error('❌ /material/login inner error:', innerErr.message);
                res.status(500).json({ error: 'An error occurred during login: ' + innerErr.message });
            }
        });
    } catch (outerErr) {
        console.error('❌ /material/login outer error:', outerErr.message);
        res.status(500).json({ error: 'An error occurred during the login request: ' + outerErr.message });
    }
});

// 9) 🆕 Material user: login ke baad khud apna mobile number badalna
//   (Anmol_material_entry.html ke "मोबाइल नंबर बदलें" form se yahan aata
//   hai). Yeh route login-time wale JWT token se hi authenticate karta
//   hai — koi bhi doosre user ka mobile isse nahi badla ja sakta. Update
//   hote hi wahi row (material_users.mobile) badalti hai jise Admin Panel
//   bhi seedhe '/api/material/users' se padhta hai — isliye Admin ko bhi
//   turant naya number dikhne lagta hai. Frontend is response ke baad
//   khud user ko turant logout kar deta hai, taaki agli baar login sirf
//   naye mobile number se ho.
app.post('/api/material/change-mobile', requireActiveMaterialUser, (req, res) => {
    try {
        const auth = getAuthUser(req);
        if (!auth || auth.role !== 'material_user' || !auth.userId) {
            return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
        }
        const rawMobile = req.body && req.body.newMobile;
        const newMobile = rawMobile != null ? String(rawMobile).trim() : '';
        const digitsOnly = newMobile.replace(/\D/g, '');
        if (digitsOnly.length !== 10) {
            return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
        }
        db.query('SELECT id, mobile FROM material_users WHERE userid = ?', [auth.userId], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            if (!rows || !rows.length) return res.status(404).json({ error: 'User ID not found.' });
            const me = rows[0];
            // Duplicate check: koi aur material user isi mobile (last 10 digits
            // ke aadhar par, taaki formatting ka farq na pade) se registered na ho.
            db.query('SELECT id, mobile FROM material_users WHERE id != ?', [me.id], (dupErr, others) => {
                if (dupErr) return res.status(500).json({ error: 'DB error: ' + dupErr.message });
                const clash = (others || []).some(r => String(r.mobile || '').replace(/\D/g, '').slice(-10) === digitsOnly);
                if (clash) {
                    return res.status(409).json({ error: 'This mobile number is already registered with another ID.' });
                }
                db.query('UPDATE material_users SET mobile = ? WHERE id = ?', [digitsOnly, me.id], (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                    res.json({ success: true, mobile: digitsOnly });
                });
            });
        });
    } catch (e) {
        res.status(500).json({ error: 'A server error occurred: ' + e.message });
    }
});

// ══════════════════════════════════════════════════════════════════
// 🔐 AUTH BRIDGE — Admin/Agent/Student login khud client-side (Firebase
//   data ke against) hota hai; yeh route sirf ek session token deta hai
//   taaki wallet/salary jaisi identity-based routes kaam kar sakein.
// ══════════════════════════════════════════════════════════════════
// 🔒 SECURITY FIX: pehle yeh route BINA KISI PASSWORD CHECK ke, client jo
// bhi role/username bheje usी ke liye ek VALID JWT token bana kar de deta
// tha — matlab koi bhi {role:'admin'} bhej kar asli Admin token le sakta
// tha. Ab yeh route DB mein saved (bcrypt-hashed) password/mobile se
// asli verification karta hai, tabhi token issue hota hai.
const AUTH_ENTITY_FOR_ROLE = { admin: 'admins', staff: 'staff', agent: 'agents' };

// ══════════════════════════════════════════════════════════════════
// 🔑 FIRST-ADMIN BOOTSTRAP — jab 'admins' entity bilkul KHAALI ho (naya
//   deployment, ya galti se saara admin data delete ho jaaye), tab
//   /api/auth/login kabhi kisi ko login nahi karne dega (koi record hi
//   match nahi hoga) — poora system permanently lock ho jaata. Yeh
//   route SIRF tabhi kaam karta hai jab: (1) admins list khaali ho,
//   AUR (2) Render Environment mein ADMIN_BOOTSTRAP_SECRET set ho aur
//   request usी secret ke saath aaye. Agar env var set hi nahi hai, yeh
//   route hamesha 403 dega — matlab yeh feature by-default OFF hai,
//   sirf jaan-boojh kar enable karne par hi kaam karta hai.
// ══════════════════════════════════════════════════════════════════
app.post('/api/auth/bootstrap-admin', (req, res) => {
    if (!process.env.ADMIN_BOOTSTRAP_SECRET) {
        return res.status(403).json({ error: 'Bootstrap feature is not enabled. Please set ADMIN_BOOTSTRAP_SECRET in Render → Environment.' });
    }
    const { secret, username, password, name } = req.body || {};
    if (secret !== process.env.ADMIN_BOOTSTRAP_SECRET) {
        return res.status(403).json({ error: 'Invalid bootstrap secret.' });
    }
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    db.query('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['admins'], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        let list = [];
        try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
        if (list && list.length) {
            return res.status(409).json({ error: 'Admins already exist — bootstrap works only when the list is empty. Please log in normally or add a new admin from the Admin Panel.' });
        }
        const newAdmin = { username, name: name || username, password: bcrypt.hashSync(password, 10), lastLogin: null };
        db.query(
            'INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
            ['admins', JSON.stringify([newAdmin])],
            (insErr) => {
                if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                res.status(201).json({ success: true });
            }
        );
    });
});

app.post('/api/auth/login', (req, res) => {
    const { role, username, password, mobile } = req.body || {};
    const roleKey = String(role || '').toLowerCase();
    if (!roleKey || !username) return res.status(400).json({ error: 'Role and username are required.' });

    // ── Student role: password nahi hota, mobile-match hi verification hai
    //    (poore app mein students ke liye yehi pattern istemal hota hai) ──
    if (roleKey === 'student') {
        if (!mobile) return res.status(400).json({ error: 'Mobile number is required.' });
        db.query('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['students'], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            let list = [];
            try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
            const wantMobile = String(mobile).replace(/\D/g, '').slice(-10);
            const stud = (list || []).find(s => s && (String(s.id) === String(username) || String(s.studentId) === String(username)));
            const studMobile = stud && String(stud.mobile || stud.phone || '').replace(/\D/g, '').slice(-10);
            if (!stud || !studMobile || studMobile !== wantMobile) {
                return res.status(401).json({ error: 'Student ID and mobile number do not match.' });
            }
            const token = jwt.sign({ role: 'student', username: String(username) }, JWT_SECRET, { expiresIn: '7d' });
            logLoginEvent('student', username); // 🆕 real-time login count ke liye
            res.json({ token });
        });
        return;
    }

    // ── Employee (HRMS) role: password nahi hota, Employee ID + mobile
    //    match hi verification hai — 'hrms_employees' blob se check karte
    //    hain (Firebase ki jagah Postgres). ──
    if (roleKey === 'employee') {
        if (!mobile) return res.status(400).json({ error: 'Mobile number is required.' });
        db.query('SELECT value FROM kv_blob WHERE `key` = ?', ['hrms_employees'], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            let list = [];
            try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
            const wantMobile = String(mobile).replace(/\D/g, '').slice(-10);
            const emp = (list || []).find(e => e && String(e.empId || '').toUpperCase() === String(username).toUpperCase());
            const empMobile = emp && String(emp.phone || emp.mobile || '').replace(/\D/g, '').slice(-10);
            if (!emp || !empMobile || empMobile !== wantMobile) {
                return res.status(401).json({ error: 'Employee ID and mobile number do not match.' });
            }
            // 🔒 FIX (Issue #3 — verification check in login): sirf wahi
            // employee login kar sakta hai jiska Admin verification poora
            // ho chuka ho (status==='active'). Yeh record yahan 'hrms_employees'
            // mein sirf tabhi aata hai jab Admin verify kar chuka ho (dekhein
            // ADMIN_APPROVE_STAFF / /api/hr/registrations/:id/approve) — agar
            // kisi wajah se koi record 'pending'/kisi aur status mein ho, to
            // login yahan bhi explicitly block hota hai, saaf error ke saath.
            if (emp.status === 'inactive' || emp.status === 'blocked') {
                return res.status(403).json({ error: 'This Employee ID is blocked or inactive. Please contact the administrator.' });
            }
            if (emp.status && emp.status !== 'active') {
                return res.status(403).json({ error: 'Your admin verification is still pending. You can log in only after verification.' });
            }
            const token = jwt.sign({ role: 'employee', username: String(username).toUpperCase() }, JWT_SECRET, { expiresIn: '7d' });
            logLoginEvent('employee', username); // 🆕 real-time login count ke liye
            res.json({ token });
        });
        return;
    }

    // ── PFMS (Accountant): password-based, apni alag SQL table se (Admin
    //    dwara banaye gaye credentials) ──
    if (roleKey === 'pfms') {
        if (!password) return res.status(400).json({ error: 'Password is required.' });
        db.query('SELECT * FROM pfms_users WHERE username = ?', [username], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            const u = rows && rows[0];
            if (!u) return res.status(401).json({ error: 'User ID is not registered in the system.' });
            if (u.status === 'inactive') return res.status(403).json({ error: 'This account has been deactivated by the administrator.' });
            if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Invalid password. Please enter the correct password.' });
            const token = jwt.sign({ role: 'pfms', username: u.username }, JWT_SECRET, { expiresIn: '7d' });
            logLoginEvent('pfms', u.username); // 🆕 real-time login count ke liye
            res.json({ token });
        });
        return;
    }

    // ── Admin / Staff / Agent: password-based verification ──
    const entityKey = AUTH_ENTITY_FOR_ROLE[roleKey];
    if (!entityKey) return res.status(400).json({ error: 'Invalid role.' });
    if (!password) return res.status(400).json({ error: 'Password is required.' });
    db.query('SELECT value FROM kv_admin_entities WHERE `key` = ?', [entityKey], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        let list = [];
        try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
        const idx = (list || []).findIndex(u => u && u.username === username);
        const user = idx >= 0 ? list[idx] : null;
        if (!user || !user.password) return res.status(401).json({ error: 'User ID is not registered in the system.' });

        let ok = false;
        if (looksHashed(user.password)) {
            ok = bcrypt.compareSync(password, user.password);
        } else {
            // Legacy plain-text record (purana data) — verify karke turant
            // hash mein upgrade kar dete hain, taaki agli baar se DB mein
            // kabhi plain-text na rahe.
            ok = user.password === password;
            if (ok) {
                list[idx] = { ...user, password: bcrypt.hashSync(password, 10) };
                db.query(
                    'INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
                    [entityKey, JSON.stringify(list)],
                    () => {}
                );
            }
        }
        if (!ok) return res.status(401).json({ error: 'Invalid password. Please enter the correct password.' });
        const token = jwt.sign({ role: roleKey, username: String(username) }, JWT_SECRET, { expiresIn: '7d' });
        logLoginEvent(roleKey, username); // 🆕 real-time login count ke liye
        res.json({ token });
    });
});

// ══════════════════════════════════════════════════════════════════
// 🆕 LOGOUT (naya, purely additive route — upar/neeche ka koi bhi
//   purana route/logic isse touch nahi hua hai)
//   ──────────────────────────────────────────────────────────────
//   Yeh app JWT (stateless) auth use karta hai — server par koi
//   session-store nahi hai jise "destroy" kiya ja sake, isliye asli
//   session-clear hamesha FRONTEND hi karta hai (localStorage se
//   token hata kar) — jaisa Admin/Agent/HRMS/Student/etc. saare 6
//   login pages ke Logout button mein already kiya gaya hai.
//   Yeh route sirf ek consistent, safe server-side confirmation deta
//   hai jise wahi Logout buttons chahें to call kar sakte hain (ek
//   audit-log jaisa signal). Invalid/expired/missing token par bhi
//   yeh kabhi crash/error nahi karta — getAuthUser() khud hi
//   try/catch ke andar hai — bas success response bhej deta hai
//   taaki frontend hamesha safely token clear karke index.html par
//   redirect kar sake.
// ══════════════════════════════════════════════════════════════════
app.post('/api/auth/logout', (req, res) => {
    const auth = getAuthUser(req); // galat/expired token ho tab bhi null milega, error nahi
    res.json({ success: true, message: 'Logged out successfully.', role: auth ? auth.role : null });
});

// ══════════════════════════════════════════════════════════════════
// 🗄️ GENERIC KEY-VALUE STORES — admin-entities / blob / site-data
//   (Admin Panel ke FBSync.pull/push isi se judte hain)
// ══════════════════════════════════════════════════════════════════
const ENTITY_KEYS = ['admins', 'staff', 'agents', 'students', 'agent_logins'];
// 🔒 Secrets/config jo kabhi bhi bina Admin login ke GET bhi nahi hone
// chahiye (jaise Razorpay/SMS API keys) — baaki blob keys (settings,
// notices, waghera) public site ke liye read-open rehte hain jaisa
// pehle tha. 'staff_att'/'leave_requests' ab Employee/Agent/Admin teeno
// padh sakte hain (HRMS self-service portal ke liye zaroori), baaki sab
// sirf Admin.
// 🔓 'razorpay_config' mein sirf PUBLIC keyId + orderEndpoint hote hain
// (koi secret key nahi — Razorpay secret hamesha server-side hi rehta
// hai) — isliye yeh public-read hai (Agent/Student ko apna subscription/
// fee payment shuru karne ke liye chahiye).
const ADMIN_ONLY_READ_BLOB_KEYS = ['sms_api_config', 'hrms_registrations',
    'agent_payments', 'agent_pending_registrations',
    'customer_pending_registrations', 'hrms_pending_registrations'];
// 🔒 Kuch blob-keys par Employee ko sirf PADHNE ki, likhne ki nahi,
// permission honi chahiye (jaise salary slips — Admin/Agent generate
// karte hain, Employee sirf apni slip dekhta hai). Isliye READ aur
// WRITE ke liye alag role-lists rakhte hain. 'hrms_settings' company
// branding jaisi non-sensitive info hoti hai jo LOGIN SE PEHLE bhi
// chahiye (naye visitor ko bhi company naam/logo dikhta hai), isliye
// GET public-read hi rehta hai — sirf WRITE role-restricted hai.
const MULTI_ROLE_READ_BLOB_KEYS = { staff_att: ['admin', 'agent', 'employee'], leave_requests: ['admin', 'agent', 'employee'], hrms_salary_slips: ['admin', 'agent', 'employee'], hrms_attendance: ['admin', 'agent', 'employee'], hrms_leaves: ['admin', 'agent', 'employee'], hrms_salary_claims: ['admin', 'agent', 'employee'], att_records: ['admin', 'agent'], student_photos: ['admin', 'agent'], selfies: ['admin', 'agent'], attendance_locations: ['admin', 'agent'], comments: ['admin', 'agent'], att_monthly_summary: ['admin', 'agent'], fee_records: ['admin', 'agent'], pending_staff: ['admin', 'agent'], salary_claims: ['admin', 'agent'] };
// 🔒 att_records/selfies/attendance_locations/student_photos par STUDENT
// khud likhta hai (apni attendance mark karte waqt selfie/GPS) — isliye
// WRITE mein 'student' role bhi shaamil hai, lekin READ (poori list dekhna)
// sirf Admin/Agent ke paas hi hai.
const MULTI_ROLE_WRITE_BLOB_KEYS = { staff_att: ['admin', 'agent', 'employee'], leave_requests: ['admin', 'agent', 'employee'], hrms_salary_slips: ['admin', 'agent'], hrms_settings: ['admin', 'agent'], hrms_attendance: ['admin', 'agent', 'employee'], hrms_leaves: ['admin', 'agent', 'employee'], hrms_salary_claims: ['admin', 'agent', 'employee'], att_records: ['admin', 'agent', 'student'], student_photos: ['admin', 'agent', 'student'], selfies: ['admin', 'agent', 'student'], attendance_locations: ['admin', 'agent', 'student'], comments: ['admin', 'agent'], att_monthly_summary: ['admin', 'agent'], fee_records: ['admin', 'agent'], pending_staff: ['admin', 'agent'], salary_claims: ['admin', 'agent'] };
const BLOB_KEYS = ['settings', 'activity', 'notices', 'mem_plans', 'members',
    'hrms_registrations', 'staff_att', 'leave_requests', 'agent_plans', 'agent_payments',
    'razorpay_config', 'sms_api_config', 'agent_pending_registrations', 'customer_pending_registrations',
    'hrms_employees', 'hrms_pending_registrations', 'hrms_salary_slips', 'hrms_settings',
    'hrms_attendance', 'hrms_leaves', 'hrms_salary_claims',
    'att_records', 'student_photos', 'selfies', 'attendance_locations', 'comments', 'att_monthly_summary',
    'fee_records', 'pending_staff', 'salary_claims', 'material_invoice_settings',
    // 🆕 MATERIAL & CATEGORY MANAGER: Admin Panel se banaye gaye Work
    // Categories (jaise 'Material Supply', 'Plantation', ya koi bhi naya
    // custom naam) + har category ke andar ka Material Name/Unit/GST%
    // catalogue — isi generic blob store (GET/POST /api/blob/material_categories)
    // se save/load hota hai. Public-read isliye rakha hai (kyunki
    // Anmol_material_entry.html portal ke Section A dropdown aur Section C
    // material list ko yeh data chahiye — koi sensitive info nahi hai,
    // sirf ek catalogue hai). Likhna sirf Admin (JWT role='admin') hi kar
    // sakta hai — neeche ki POST route mein yeh automatically enforce ho
    // jaata hai kyunki 'material_categories' MULTI_ROLE_WRITE_BLOB_KEYS
    // mein nahi hai (default rule: sirf role==='admin' likh sakta hai).
    'material_categories'];

function kvGet(table, key, res, wrapValue, req) {
    db.query(`SELECT value FROM ${table} WHERE \`key\` = ?`, [key], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.json(wrapValue ? null : null);
        let parsed = null;
        try { parsed = JSON.parse(rows[0].value); } catch (e) { parsed = rows[0].value; }
        // 🔒 API Response Sanitization: entity-store (admins/staff/agents/
        // students) mein password kabhi Network tab tak nahi pahunchta.
        if (table === 'kv_admin_entities') parsed = stripSensitiveFields(parsed);
        // 🆕 🔒 PII PROTECTION: pehle yeh routes bina login ke bhi saari Aadhaar/PAN
        // (aur unki photo) wali fields de dete the. Ab har viewer ko sirf uska
        // haq milta hai: Admin/Staff → sab; Agent → sirf apne records; baaki →
        // koi nahi. (`req` na di ho — internal calls — to purana behaviour.)
        if (req && Array.isArray(parsed)) return sendPiiSafeArray(req, res, parsed);
        res.json(parsed);
    });
}
// 🆕 FIX (Admin login "Invalid User ID & Password"): GET /admin-entities strips password hashes, and the
// Admin Panel posts the WHOLE (stripped) list back on every save. Without this, that save erased every
// stored hash and nobody could log in again. Records that arrive WITHOUT a password keep the stored one
// (matched by id, then username); records that arrive WITH a new plain password are hashed as before.
function preservePasswordsFromExisting(incoming, existing) {
    if (!Array.isArray(incoming) || !Array.isArray(existing)) return incoming;
    return incoming.map(rec => {
        if (!rec || typeof rec !== 'object') return rec;
        const has = PASSWORD_FIELD_NAMES.some(f => rec[f]);
        if (has) return rec;
        const old = existing.find(o => o && ((rec.id != null && o.id === rec.id) || (rec.username && o.username === rec.username)));
        if (!old) return rec;
        const copy = { ...rec };
        PASSWORD_FIELD_NAMES.forEach(f => { if (old[f]) copy[f] = old[f]; });
        delete copy.hasPassword;
        return copy;
    });
}
function kvSetCore(table, key, value, res) {
    const finishRaw = (val) => {
        // 🔒 Password Hashing: entity-store mein jo bhi naya/edited record
        // aaye, save hone se pehle uska password bcrypt se hash ho jaata hai
        // — DB mein kabhi plain-text password store nahi hota.
        const toSave = table === 'kv_admin_entities' ? hashEntityPasswordsBeforeSave(val) : val;
        const json = JSON.stringify(toSave);
        db.query(
            `INSERT INTO ${table} ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value`,
            [key, json],
            (err) => {
                if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                if (table === 'kv_admin_entities' && key === 'agents') _scopeCache.clear(); // agent scope cache refresh
                res.json({ success: true });
            }
        );
    };
    const finish = (val) => {
        if (table !== 'kv_admin_entities' || !Array.isArray(val)) return finishRaw(val);
        db.query(`SELECT value FROM ${table} WHERE \`key\` = ?`, [key], (err, rows) => {
            let merged = val;
            if (!err && rows && rows.length) { try { merged = preservePasswordsFromExisting(val, JSON.parse(rows[0].value)); } catch (e) { merged = val; } }
            finishRaw(merged);
        });
    };
    // 🆕 🔒 Read par kisi viewer ki PII hata di jaati hai; frontend poori array
    // wapas POST karta hai. Uski wajah se doosron ki Aadhaar/PAN overwrite/delete
    // na ho, isliye purane record se woh fields wapas jod dete hain.
    const mergeKeys = PII_MERGE_TARGETS[table];
    if (mergeKeys && mergeKeys.indexOf(key) !== -1 && Array.isArray(value)) {
        return db.query(`SELECT value FROM ${table} WHERE \`key\` = ?`, [key], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            let merged = value;
            if (rows && rows.length) {
                try { merged = mergePiiFromExisting(value, JSON.parse(rows[0].value)); } catch (e) { merged = value; }
            }
            finish(merged);
        });
    }
    finish(value);
}


// 🆕 Identity-duplicate guard wrapper: Student/Staff/Agent/HRMS arrays save hone se pehle Identity Number check.
function kvSet(table, key, value, res, req) {
    if (!req || !IDENTITY_GUARDED[table + ':' + key] || !Array.isArray(value)) return kvSetCore(table, key, value, res);
    identityGuard(table, key, value, getAuthUser(req)).then(function (bad) {
        if (bad) return res.status(bad.status || 409).json({ success: false, code: bad.code, error: bad.error, owner: bad.owner });
        kvSetCore(table, key, value, res);
    }).catch(function (e) { console.error('identityGuard error:', e && e.message); kvSetCore(table, key, value, res); });
}

app.get('/api/admin-entities/:key', (req, res) => {
    if (!ENTITY_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown entity key' });
    kvGet('kv_admin_entities', req.params.key, res, null, req);
});
// 🔒 RBAC: Admin har entity likh sakta hai. Agent/Staff sirf 'students'
// entity manage kar sakte hain (apne students add/edit karne ke liye —
// yeh app ka existing legitimate flow hai). Bina login / kisi aur
// role/key combination par turant 401.
app.post('/api/admin-entities/:key', (req, res) => {
    if (!ENTITY_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown entity key' });
    const auth = getAuthUser(req);
    const role = auth && String(auth.role || '').toLowerCase();
    const allowed = role === 'admin' || ((role === 'agent' || role === 'staff') && (req.params.key === 'students' || req.params.key === 'agent_logins'));
    if (!allowed) return res.status(401).json({ error: 'A valid login or permission is required to modify this data.' });
    kvSet('kv_admin_entities', req.params.key, req.body, res, req);
});

// ══════════════════════════════════════════════════════════════════
// 🆕 REAL-TIME LIVE STATS — Admin Dashboard ke "Active Agents",
//   "Students" aur "Today's Logins" cards isi ek route se REAL,
//   DB-connected numbers leke aate hain (koi dummy/random data nahi).
//   Public-read hai (jaisa live_dashboard/index_gallery jaise baaki
//   homepage-sync keys pehle se hain) kyunki yeh sirf aggregate
//   counts hain, koi private/PII data return nahi hota.
// ══════════════════════════════════════════════════════════════════
app.get('/api/dashboard/live-stats', (req, res) => {
    db.query('SELECT `key`, value FROM kv_admin_entities WHERE `key` IN (?, ?, ?, ?)', ['agents', 'students', 'staff', 'admins'], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const byKey = {};
        (rows || []).forEach(r => { try { byKey[r.key] = JSON.parse(r.value) || []; } catch (e) { byKey[r.key] = []; } });
        const agents = Array.isArray(byKey.agents) ? byKey.agents : [];
        const students = Array.isArray(byKey.students) ? byKey.students : [];
        const staff = Array.isArray(byKey.staff) ? byKey.staff : [];
        const admins = Array.isArray(byKey.admins) ? byKey.admins : [];

        const totalAgents = agents.length;
        const activeAgents = agents.filter(a => a && a.status === 'active' && !a.blocked).length;
        const totalStudents = students.length;
        const activeStudents = students.filter(s => s && s.status === 'active').length;

        // 🆕 Homepage "KYC Verification & Performance Report" (marketing)
        //   section ke liye — pehle yeh 4 numbers (98.6%, 97.9%, 1.8s, 100%)
        //   HTML mein hardcoded the. Ab jo bhi genuinely real DB se compute
        //   ho sakta hai, wahi bhejte hain:
        const kycCompleteAgents = agents.filter(a => a && a.aadharFront && a.aadharBack && a.upiScreenshot && a.qrCode).length;
        const kycVerifiedPercent = totalAgents ? Math.round((kycCompleteAgents / totalAgents) * 1000) / 10 : 0;
        const totalPeople = totalAgents + totalStudents;
        const activePeople = activeAgents + activeStudents;
        const activeVerificationPercent = totalPeople ? Math.round((activePeople / totalPeople) * 1000) / 10 : 0;
        const totalSecureRecords = totalAgents + totalStudents + staff.length + admins.length;

        hrGetBlob('login_log', (lErr, loginLog) => {
            const list = lErr ? [] : (Array.isArray(loginLog) ? loginLog : []);
            const todayStr = new Date().toLocaleDateString('en-CA');
            const todayEntries = list.filter(e => e && e.ts && new Date(e.ts).toLocaleDateString('en-CA') === todayStr);
            const loginsByRole = {};
            todayEntries.forEach(e => { const r = e.role || 'unknown'; loginsByRole[r] = (loginsByRole[r] || 0) + 1; });
            res.json({
                totalAgents, activeAgents,
                totalStudents, activeStudents,
                todayLogins: todayEntries.length,
                loginsByRole,
                kycVerifiedPercent, activeVerificationPercent, totalSecureRecords,
                generatedAt: Date.now()
            });
        });
    });
});

app.get('/api/blob/:key', (req, res) => {
    if (!BLOB_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown blob key' });
    // 🔒 Secrets (Razorpay/SMS keys) aur internal HR/agent data sirf Admin
    // login ke saath hi padhe ja sakte hain — baaki (settings/notices etc.)
    // public site ke liye pehle jaisa hi khula rehta hai. Kuch keys
    // (staff_att/leave_requests) Employee/Agent/Admin — teeno — padh sakte
    // hain, kyunki HRMS self-service portal ko yeh chahiye.
    if (ADMIN_ONLY_READ_BLOB_KEYS.includes(req.params.key)) {
        const auth = getAuthUser(req);
        if (!auth || String(auth.role || '').toLowerCase() !== 'admin') {
            return res.status(401).json({ error: 'Admin login is required to view this data.' });
        }
    } else if (MULTI_ROLE_READ_BLOB_KEYS[req.params.key]) {
        const auth = getAuthUser(req);
        const allowedRoles = MULTI_ROLE_READ_BLOB_KEYS[req.params.key];
        if (!auth || !allowedRoles.includes(String(auth.role || '').toLowerCase())) {
            return res.status(401).json({ error: 'A valid login is required to view this data.' });
        }
    }
    kvGet('kv_blob', req.params.key, res, null, req);
});
// 🔒 RBAC: 'staff_att'/'leave_requests' Employee/Agent bhi likh sakte hain
// (apni attendance punch / leave apply karne ke liye) — baaki sab blob
// keys sirf Admin likh sakta hai.
app.post('/api/blob/:key', (req, res) => {
    if (!BLOB_KEYS.includes(req.params.key)) return res.status(404).json({ error: 'Unknown blob key' });
    const auth = getAuthUser(req);
    const role = auth && String(auth.role || '').toLowerCase();
    const multiRoleAllowed = MULTI_ROLE_WRITE_BLOB_KEYS[req.params.key] && MULTI_ROLE_WRITE_BLOB_KEYS[req.params.key].includes(role);
    if (role !== 'admin' && !multiRoleAllowed) {
        return res.status(401).json({ error: 'A valid login or permission is required to modify this data.' });
    }
    kvSet('kv_blob', req.params.key, req.body, res, req);
});
app.delete('/api/blob/:key', requireRole('admin'), (req, res) => {
    db.query('DELETE FROM kv_blob WHERE `key` = ?', [req.params.key], (err) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json({ success: true });
    });
});

// ══════════════════════════════════════════════════════════════════
// 🧑‍💼 HRMS EMPLOYEE REGISTRATION + APPROVAL (Postgres-backed, Firebase
//   ki jagah). Data 'kv_blob' mein 'hrms_pending_registrations' aur
//   'hrms_employees' keys ke andar rehta hai (dono BLOB_KEYS mein hain).
//   Naya employee: self-register (pending) → Admin ya us Agent (jiski
//   Library select ki thi) approve/reject/edit kar sakta hai.
// ══════════════════════════════════════════════════════════════════
function hrGetBlob(key, cb) {
    db.query('SELECT value FROM kv_blob WHERE `key` = ?', [key], (err, rows) => {
        if (err) return cb(err);
        let list = [];
        try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
        cb(null, Array.isArray(list) ? list : []);
    });
}
// 🔒 Kuch blobs ARRAY nahi, OBJECT hote hain (jaise selfies: {studentId: {...}},
// student_photos: {studentId: photo}) — hrGetBlob hamesha [] array force
// karta hai isliye unke liye yeh alag helper hai jo object hi rakhta hai.
function hrGetBlobObj(key, cb) {
    db.query('SELECT value FROM kv_blob WHERE `key` = ?', [key], (err, rows) => {
        if (err) return cb(err);
        let val = {};
        try { val = JSON.parse(rows[0] && rows[0].value) || {}; } catch (e) { val = {}; }
        cb(null, (val && typeof val === 'object' && !Array.isArray(val)) ? val : {});
    });
}
function hrSetBlob(key, list, cb) {
    db.query(
        'INSERT INTO kv_blob ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
        [key, JSON.stringify(list)],
        cb
    );
}

// ══════════════════════════════════════════════════════════════════
// 🆕 REAL-TIME LOGIN LOG (Admin Dashboard "Today's Logins" ke liye)
//   Har successful login (student/employee/pfms/admin/staff/agent) par
//   isi function se ek chhota record 'login_log' blob (kv_blob table)
//   mein add ho jaata hai — {role, username, ts}. Yeh koi naya table
//   nahi hai, wahi existing generic kv_blob store hai jo already
//   settings/notices jaise keys ke liye use ho raha hai. Purane
//   3000 se zyada records apne aap trim ho jaate hain taaki row
//   bahut badi na ho jaaye. Yeh function kabhi login ko fail/block
//   nahi karta — error aane par bhi chup-chaap ignore kar deta hai
//   (best-effort logging, login ka main flow kabhi iski wajah se
//   ruknа nahi chahiye).
// ══════════════════════════════════════════════════════════════════
function logLoginEvent(role, username) {
    try {
        hrGetBlob('login_log', (err, list) => {
            if (err) return; // best-effort — login ka flow ruke nahi
            list = Array.isArray(list) ? list : [];
            list.push({ role: String(role || ''), username: String(username || ''), ts: Date.now() });
            if (list.length > 3000) list = list.slice(list.length - 3000);
            hrSetBlob('login_log', list, () => {});
        });
    } catch (e) { /* best-effort */ }
}
// ══════════════════════════════════════════════════════════════════
// 🔒 SALARY PAYOUT — DUPLICATE PAYMENT & MONTH LOCK HELPERS
//   Poora salary payout cycle: Employee claim submit → Agent/Admin
//   approve (slip generate) → HR "request-payment" (PFMS ke liye
//   payout_requests row banti hai) → PFMS "Pay Now" (Razorpay se asli
//   bank transfer) → 'Paid' + slip.status='paid' (LOCKED).
//   In teeno guard-points (claim submit, approve, request-payment) par
//   check hota hai ki isi employee ke isi month/year ka payment pehle
//   se 'Paid'/process-mein to nahi hai — agar hai, to turant clear
//   error message ke saath reject ho jaata hai, taaki galti se dobara
//   payout na ho jaaye.
// ══════════════════════════════════════════════════════════════════
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// hrms_salary_slips ASLI SQL table hai (id, empId, data JSON, created_at).
// `data` JSON ke andar hi month/year/status/basic/net waghera sab hota hai
// (jo employee ne claim submit karte waqt bheja tha, wahi copy hoti hai).
function markSalarySlipPaid(slipId, verifiedBy, verifiedById, cb) {
    if (!slipId) return cb(null);
    db.query('SELECT * FROM hrms_salary_slips WHERE id=?', [slipId], (err, rows) => {
        if (err) return cb(err);
        const row = rows && rows[0];
        if (!row) return cb(new Error('Salary slip (' + slipId + ') not found.'));
        let data = {};
        try { data = JSON.parse(row.data) || {}; } catch (e) { data = {}; }
        data.status = 'paid';
        data.verifiedBy = verifiedBy;
        if (verifiedById) data.verifiedById = verifiedById;
        data.paidAt = new Date().toISOString();
        db.query('UPDATE hrms_salary_slips SET data=? WHERE id=?', [JSON.stringify(data), slipId], (uErr) => cb(uErr || null));
    });
}

// Employee ke liye kisi month/year ka payment pehle se 'Paid/Locked' ya
// process-mein hai kya, yeh check karta hai — dono jagah (hrms_salary_claims
// aur hrms_salary_slips) dekh kar. cb(err, clashInfo|null) — clashInfo mein
// { alreadyPaid: bool, label: 'January 2026' } hota hai jab clash mile.
function findSalaryMonthClash(empId, month, year, cb) {
    const label = (MONTH_NAMES[month] || 'Is month') + ' ' + year;
    db.query(
        "SELECT * FROM hrms_salary_claims WHERE empId=? AND status IN ('pending','pending_admin','approved')",
        [empId],
        (err, claimRows) => {
            if (err) return cb(err);
            const claimClash = (claimRows || []).find(r => {
                try { const d = JSON.parse(r.data); return Number(d.month) === Number(month) && Number(d.year) === Number(year); }
                catch (e) { return false; }
            });
            db.query('SELECT * FROM hrms_salary_slips WHERE empId=?', [empId], (err2, slipRows) => {
                if (err2) return cb(err2);
                const slipClash = (slipRows || []).find(r => {
                    try { const d = JSON.parse(r.data); return Number(d.month) === Number(month) && Number(d.year) === Number(year); }
                    catch (e) { return false; }
                });
                let slipData = null;
                if (slipClash) { try { slipData = JSON.parse(slipClash.data); } catch (e) { slipData = null; } }
                const alreadyPaid = !!(slipData && slipData.status === 'paid');
                if (claimClash || slipClash) {
                    return cb(null, { alreadyPaid, label, slipId: slipClash ? slipClash.id : null });
                }
                cb(null, null);
            });
        }
    );
}


// Registration/approval par Admin ya SAHI Agent (jis Library ke liye
// registration hui thi) hi permission rakhte hain — koi aur agent kisi
// doosri library ki registration approve nahi kar sakta.
function hrCanManage(auth, agentUsername) {
    if (!auth) return false;
    const role = String(auth.role || '').toLowerCase();
    if (role === 'admin') return true;
    if (role === 'agent' && auth.username && agentUsername && String(auth.username).toLowerCase() === String(agentUsername).toLowerCase()) return true;
    return false;
}

// 1) Registration submit — PUBLIC (login se pehle hota hai). Admin login
//    se call hone par agentUsername zaroori nahi (Admin Panel se global
//    staff add karna — kisi specific library se linked nahi).
// 🪪 Identity Number (Aadhaar / ID) mandatory + global duplicate block (public form, so IP rate-limited)
app.post('/api/hr/register', asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (hitRateLimit('hrreg:' + (req.ip || ''), 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const norm = normIdentity(firstDefined(body.aadhar, body.aadhaar, body.identityNumber, body.identity, ''));
    if (IDENTITY_REQUIRED || norm) {
        const f = checkIdentityFormat(norm);
        if (!f.ok) return res.status(400).json({ error: f.error });
        const hit = await findIdentityOwner(norm, [], '', await loadAgentsIndex());
        if (hit) return res.status(409).json({ success: false, code: 'IDENTITY_DUPLICATE', error: dupMessage(hit.label) });
        req.body = Object.assign({}, body, { aadhar: norm });
    }
    return hrRegisterCore(req, res);
}));
function hrRegisterCore(req, res) {
    const body = req.body || {};
    const auth = getAuthUser(req);
    const isAdminCall = auth && String(auth.role || '').toLowerCase() === 'admin';
    const name = (body.name || '').trim();
    const phone = (body.phone || '').trim();
    const agentUsername = body.agentUsername || '';
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Please enter the full 10-digit mobile number.' });
    if (!agentUsername && !isAdminCall) return res.status(400).json({ error: 'Selecting a library/agent is required.' });
    hrGetBlob('hrms_pending_registrations', (err, pending) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        hrGetBlob('hrms_employees', (err2, employees) => {
            if (err2) return res.status(500).json({ error: 'DB error: ' + err2.message });
            const dup = (n) => String(n || '').replace(/\D/g, '').slice(-10) === phone;
            if (employees.some(e => dup(e.phone)) || pending.some(p => dup(p.phone))) {
                return res.status(409).json({ error: 'This mobile number already exists with another registration.' });
            }
            const regId = 'PREG' + Date.now() + Math.random().toString(36).slice(2, 6);
            const rec = {
                id: regId, name, phone, email: body.email || '', address: body.address || '',
                photo: body.photo || '', designation: body.designation || '', department: body.department || '',
                agentUsername, status: 'pending', submittedOn: new Date().toISOString()
            };
            if (body.aadhar) rec.aadhar = String(body.aadhar);
            pending.push(rec);
            hrSetBlob('hrms_pending_registrations', pending, (sErr) => {
                if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
                res.status(201).json({ success: true, id: regId });
            });
        });
    });
}

// 2) Pending registrations list — Admin ya Agent (sirf apni library ki
//    registrations dikhti hain agent ko; Admin sab dekh sakta hai)
app.get('/api/hr/registrations', (req, res) => {
    const auth = getAuthUser(req);
    const role = auth && String(auth.role || '').toLowerCase();
    if (!auth || (role !== 'admin' && role !== 'agent')) {
        return res.status(401).json({ error: 'Login is required.' });
    }
    hrGetBlob('hrms_pending_registrations', (err, pending) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const list = role === 'admin' ? pending : pending.filter(p => String(p.agentUsername || '').toLowerCase() === String(auth.username).toLowerCase());
        res.json(list);
    });
});

// 3) Edit a pending registration (Admin/owning-Agent only)
app.put('/api/hr/registrations/:id', (req, res) => {
    const auth = getAuthUser(req);
    hrGetBlob('hrms_pending_registrations', (err, pending) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const idx = pending.findIndex(p => p.id === req.params.id);
        if (idx < 0) return res.status(404).json({ error: 'Registration not found.' });
        if (!hrCanManage(auth, pending[idx].agentUsername)) return res.status(401).json({ error: 'You do not have permission to edit this registration.' });
        pending[idx] = Object.assign({}, pending[idx], req.body || {}, { id: pending[idx].id, agentUsername: pending[idx].agentUsername });
        hrSetBlob('hrms_pending_registrations', pending, (sErr) => {
            if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
            res.json({ success: true });
        });
    });
});

// 4) Approve — Admin/owning-Agent only. Naya Employee ID banata hai
//    (EMP001, EMP002, ...), 'hrms_employees' mein daalta hai, pending se
//    hataata hai.
app.post('/api/hr/registrations/:id/approve', (req, res) => {
    const auth = getAuthUser(req);
    hrGetBlob('hrms_pending_registrations', (err, pending) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const idx = pending.findIndex(p => p.id === req.params.id);
        if (idx < 0) return res.status(404).json({ error: 'Registration not found.' });
        const reg = pending[idx];
        if (!hrCanManage(auth, reg.agentUsername)) return res.status(401).json({ error: 'You do not have permission to approve this registration.' });
        // 🆕 Admin approve karte waqt agent/library CONFIRM ya BADAL sakta hai
        // (jaise registration mein agent na chuna gaya ho, ya galat ho) —
        // sirf Admin ko yeh override allowed hai, Agent apna hi agentUsername
        // use karta hai.
        const isAdmin = String(auth.role || '').toLowerCase() === 'admin';
        const finalAgentUsername = (isAdmin && req.body && req.body.agentUsername) ? req.body.agentUsername : reg.agentUsername;
        hrGetBlob('hrms_employees', (err2, employees) => {
            if (err2) return res.status(500).json({ error: 'DB error: ' + err2.message });
            let max = 0;
            employees.forEach(e => { const n = parseInt(String(e.empId || '').replace('EMP', ''), 10) || 0; if (n > max) max = n; });
            const empId = 'EMP' + String(max + 1).padStart(3, '0');
            const newEmp = {
                empId, name: reg.name, phone: reg.phone, email: reg.email || '', address: reg.address || '',
                photo: reg.photo || '', designation: reg.designation || '', department: reg.department || '',
                aadhar: reg.aadhar || '',
                agentUsername: finalAgentUsername, ownerUser: finalAgentUsername, status: 'active', joinedOn: new Date().toISOString()
            };
            employees.push(newEmp);
            pending.splice(idx, 1);
            hrSetBlob('hrms_employees', employees, (sErr) => {
                if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
                hrSetBlob('hrms_pending_registrations', pending, (sErr2) => {
                    if (sErr2) return res.status(500).json({ error: 'DB error: ' + sErr2.message });
                    res.json({ success: true, empId });
                });
            });
        });
    });
});

// 5) Reject — Admin/owning-Agent only
app.post('/api/hr/registrations/:id/reject', (req, res) => {
    const auth = getAuthUser(req);
    hrGetBlob('hrms_pending_registrations', (err, pending) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const idx = pending.findIndex(p => p.id === req.params.id);
        if (idx < 0) return res.status(404).json({ error: 'Registration not found.' });
        if (!hrCanManage(auth, pending[idx].agentUsername)) return res.status(401).json({ error: 'You do not have permission to reject this registration.' });
        pending.splice(idx, 1);
        hrSetBlob('hrms_pending_registrations', pending, (sErr) => {
            if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
            res.json({ success: true });
        });
    });
});

// 6) Employee apni profile (photo/email/address/bank details) khud update
//    kar sakta hai — sirf apna record, JWT se verified empId se. Agent/Admin
//    bhi update kar sakte hain (jaise Basic Salary fix karna Agent Login ke
//    HR Panel se) — Agent sirf apne agentUsername wale employees ke liye.
app.put('/api/hr/employees/:empId', requireRole('employee', 'agent', 'admin'), (req, res) => {
    const auth = req.authUser;
    const role = String(auth.role || '').toLowerCase();
    if (role === 'employee' && String(auth.username).toUpperCase() !== String(req.params.empId).toUpperCase()) {
        return res.status(401).json({ error: 'You can update only your own profile.' });
    }
    hrGetBlob('hrms_employees', (err, employees) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const idx = employees.findIndex(e => String(e.empId || '').toUpperCase() === String(req.params.empId).toUpperCase());
        if (idx < 0) {
            // 🔒 UPSERT: Admin Panel ke 'staff' entity wale employees frontend par
            // 'hrms_employees' ke saath sirf MERGE hote hain (asal blob mein nahi
            // hote) — jab agent pehli baar unki Basic Salary set kare, to yahan
            // naya record ban jaata hai (jaisa Firebase .set() bhi karta tha).
            const ownerField = (req.body && (req.body.agentUsername || req.body.ownerUser)) || '';
            if (role === 'agent' && ownerField && String(ownerField).toLowerCase() !== String(auth.username).toLowerCase()) {
                return res.status(401).json({ error: 'You can update only the employees of your own library.' });
            }
            const newEmp = Object.assign({ empId: req.params.empId, status: 'active' }, req.body || {}, { empId: req.params.empId });
            employees.push(newEmp);
            return hrSetBlob('hrms_employees', employees, (sErr) => {
                if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
                res.json({ success: true, created: true });
            });
        }
        const existingOwner = employees[idx].agentUsername || employees[idx].ownerUser;
        if (role === 'agent' && existingOwner && String(existingOwner).toLowerCase() !== String(auth.username).toLowerCase()) {
            return res.status(401).json({ error: 'You can update only the employees of your own library.' });
        }
        employees[idx] = Object.assign({}, employees[idx], req.body || {}, { empId: employees[idx].empId });
        hrSetBlob('hrms_employees', employees, (sErr) => {
            if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
            res.json({ success: true });
        });
    });
});

// 7) HRMS ke transactions/dashboard REST reads — pehle Firebase real-time
//    listeners (watchPendingTransactions/watchAdminDashboard) use hote the,
//    jo asal mein STALE the (writes bahut pehle hi is naye /api/payments/
//    route par shift ho chuki thi, status bhi 'pending'/'verified' hai,
//    Firebase wale purane 'Pending_HRMS' status se kabhi match hi nahi
//    hota tha). Ab seedha isi Postgres 'transactions' table se REST GET.
app.get('/api/hr/pending-transactions', (req, res) => {
    const auth = getAuthUser(req);
    const role = auth && String(auth.role || '').toLowerCase();
    if (!auth || !['admin', 'agent', 'employee'].includes(role)) return res.status(401).json({ error: 'Login is required.' });
    db.query("SELECT * FROM transactions WHERE status='pending' ORDER BY created_at DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json((rows || []).map(r => {
            let extra = {};
            try { extra = JSON.parse(r.data); } catch (e) {}
            return Object.assign(extra, { id: r.id, agentId: r.agentId, studentId: r.studentId, amount: Number(r.amount), status: r.status, created_at: r.created_at });
        }));
    });
});
app.get('/api/hr/admin-dashboard', requireRole('admin'), (req, res) => {
    db.query("SELECT * FROM transactions WHERE status='verified' ORDER BY created_at DESC LIMIT 200", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const ledger = (rows || []).map(r => ({ txnId: r.id, agentId: r.agentId, amount: Number(r.amount), verifiedAt: r.created_at }));
        const totalCommission = ledger.reduce((s, x) => s + x.amount, 0);
        res.json({ totalCommission, ledger });
    });
});

// 🔒 SAFE "Factory Reset" — sirf ISI Agent ke apne data (students, attendance,
// fee records, members, pending_staff, salary_claims — jahan bhi 'ownerUser'/
// 'agentId'/'agentUsername' match kare) ko hataata hai. Firebase-era wala
// purana button POORE 'shdl' root ko delete kar deta tha — matlab EK agent
// dabaye to SAARE agents ka data (baaki libraries samet) mit jaata — ek
// khatarnak cross-tenant bug jo yahan fix kiya gaya hai. Yeh naya route
// sirf apna hi data delete karta hai.
app.post('/api/agent/factory-reset', requireRole('agent'), (req, res) => {
    const agentUser = String(req.authUser.username || '').toLowerCase();
    if (!agentUser) return res.status(400).json({ error: 'Agent identity not found.' });

    function filterOutOwn(list, cb) {
        const kept = (list || []).filter(r => r && String(r.ownerUser || r.agentId || r.agentUsername || '').toLowerCase() !== agentUser);
        cb(kept);
    }
    const tasks = ['students', 'att_records', 'fee_records', 'members', 'pending_staff', 'salary_claims', 'agent_logins'];
    let pending = tasks.length;
    let hadError = false;
    function done() { pending--; if (pending === 0) { if (hadError) return res.status(500).json({ error: 'Some data could not be reset. Please try again.' }); res.json({ success: true }); } }

    tasks.forEach(key => {
        const table = key === 'students' || key === 'agent_logins' ? 'kv_admin_entities' : 'kv_blob';
        db.query(`SELECT value FROM ${table} WHERE \`key\` = ?`, [key], (err, rows) => {
            if (err) { hadError = true; return done(); }
            let list = [];
            try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
            if (!Array.isArray(list)) return done(); // object-shaped blobs yahan skip (students/agent_logins/att_records/fee_records/members/pending_staff/salary_claims sab array hote hain)
            filterOutOwn(list, (kept) => {
                const toSave = table === 'kv_admin_entities' ? hashEntityPasswordsBeforeSave(kept) : kept;
                db.query(
                    `INSERT INTO ${table} ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value`,
                    [key, JSON.stringify(toSave)],
                    (sErr) => { if (sErr) hadError = true; done(); }
                );
            });
        });
    });
});

// ══════════════════════════════════════════════════════════════════
// 💳 PFMS (Accountant) PORTAL — Agent payout request → HRMS/Staff
//   approval → PFMS "Pay Now" (wallet debit + ledger entry).
// ══════════════════════════════════════════════════════════════════

// ── 1) ADMIN: PFMS login credentials CRUD (bcrypt-hashed, admin-only) ──
app.get('/api/admin/pfms-users', requireRole('admin'), (req, res) => {
    db.query('SELECT id, username, name, status, created_by_admin, created_at FROM pfms_users ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []); // 🔒 password_hash yahan kabhi select/return nahi hota
    });
});
app.post('/api/admin/pfms-users', requireRole('admin'), (req, res) => {
    const { username, name, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password kam se kam 6 characters ka ho.' });
    const hash = bcrypt.hashSync(password, 10);
    db.query(
        'INSERT INTO pfms_users (username, name, password_hash, created_by_admin) VALUES (?,?,?,?)',
        [username, name || username, hash, req.authUser.username],
        (err, result) => {
            if (err) {
                if (String(err.message || '').includes('duplicate') || String(err.code) === '23505') {
                    return res.status(409).json({ error: 'This username already exists.' });
                }
                return res.status(500).json({ error: 'DB error: ' + err.message });
            }
            res.status(201).json({ success: true, id: result.insertId });
        }
    );
});
app.put('/api/admin/pfms-users/:id', requireRole('admin'), (req, res) => {
    const { name, password, status } = req.body || {};
    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push('name=?'); params.push(name); }
    if (status !== undefined) { sets.push('status=?'); params.push(status); }
    if (password) {
        if (password.length < 6) return res.status(400).json({ error: 'Password kam se kam 6 characters ka ho.' });
        sets.push('password_hash=?'); params.push(bcrypt.hashSync(password, 10));
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields were provided to update.' });
    params.push(req.params.id);
    db.query(`UPDATE pfms_users SET ${sets.join(', ')} WHERE id=?`, params, (err) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json({ success: true });
    });
});
app.delete('/api/admin/pfms-users/:id', requireRole('admin'), (req, res) => {
    db.query('DELETE FROM pfms_users WHERE id=?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json({ success: true });
    });
});

// ── 2) AGENT: payout/expense request banaye ──
app.post('/api/agent/payout-request', requireRole('agent'), (req, res) => {
    const agentId = req.authUser.username;
    const amount = Number((req.body || {}).amount);
    const reason = (req.body || {}).reason || '';
    if (!(amount > 0)) return res.status(400).json({ error: 'Please enter a valid amount.' });
    db.query('SELECT value FROM kv_admin_entities WHERE `key`=?', ['agents'], (err, rows) => {
        let agentName = agentId;
        try {
            const agents = JSON.parse(rows && rows[0] && rows[0].value) || [];
            const a = agents.find(x => x && x.username === agentId);
            if (a) agentName = a.company || a.name || agentId;
        } catch (e) {}
        const id = 'PR' + Date.now() + Math.random().toString(36).slice(2, 6);
        db.query(
            'INSERT INTO payout_requests (id, agentId, agentName, amount, reason, status) VALUES (?,?,?,?,?,?)',
            [id, agentId, agentName, amount, reason, 'Pending'],
            (iErr) => {
                if (iErr) return res.status(500).json({ error: 'DB error: ' + iErr.message });
                res.status(201).json({ success: true, id });
            }
        );
    });
});

// 🆕 HRMS ↔ PFMS LINK: Salary slip ke liye payment request banao — bank
//   details ('hrms_employees' se) automatically attach ho jaate hain,
//   taaki PFMS bina kisi extra lookup ke seedha pay kar sake. Yeh route
//   HR Panel se (role: agent/employee/admin) call hoti hai jab "Verify &
//   Mark Paid" dabaya jaata hai.
app.post('/api/hr/salary-slips/:slipId/request-payment', requireRole('agent', 'employee', 'admin'), (req, res) => {
    const { empId, empName, netAmount, agentShareAmount } = req.body || {};
    const amount = Number(netAmount);
    const agentShare = Number(agentShareAmount) || 0;
    const slipId = req.params.slipId;
    if (!empId || !(amount > 0)) return res.status(400).json({ error: 'empId and a valid netAmount are required.' });

    // 🔒 DUPLICATE PAYMENT & MONTH LOCK (guard #3 — sabse critical point,
    // kyunki isi ke turant baad PFMS "Pay Now" se ASLI bank transfer hota
    // hai). Pehle check: isi salary-slip ke liye pehle se koi payout
    // request 'HR_Approved'/'Processing'/'Paid' mein to nahi hai.
    db.query("SELECT * FROM payout_requests WHERE salarySlipId=? AND status IN ('HR_Approved','Processing','Paid')", [slipId], (dupErr, dupRows) => {
        if (dupErr) return res.status(500).json({ error: 'DB error: ' + dupErr.message });
        if (dupRows && dupRows.length) {
            const existing = dupRows[0];
            return res.status(409).json({
                error: existing.status === 'Paid'
                    ? 'Payment for this salary slip is already paid and completed.'
                    : `A payout request for this salary slip is already in the “${existing.status}” state — please do not submit the payment request again.`
            });
        }
        // Dusra check: isi employee ke isi month/year ka koi doosra slip
        // pehle se 'Paid' na ho chuka ho (extra safety agar kisi tarah alag
        // slipId se dobara try kiya gaya ho).
        db.query('SELECT data FROM hrms_salary_slips WHERE id=?', [slipId], (sErr, sRows) => {
            let slipData = {};
            try { slipData = JSON.parse((sRows && sRows[0] && sRows[0].data) || '{}') || {}; } catch (e) {}
            findSalaryMonthClash(empId, slipData.month, slipData.year, (cErr, clash) => {
                if (cErr) return res.status(500).json({ error: 'DB error: ' + cErr.message });
                if (clash && clash.alreadyPaid) {
                    return res.status(409).json({ error: `Payment for ${clash.label} is already paid and completed.` });
                }
                _createSalaryPayoutRequest();
            });
        });
    });

    function _createSalaryPayoutRequest() {
        hrGetBlob('hrms_employees', (err, employees) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            const emp = employees.find(e => String(e.empId || '').toUpperCase() === String(empId).toUpperCase());
            if (!emp) return res.status(404).json({ error: 'Employee record not found.' });
            if (!emp.bank || !emp.acc || !emp.ifsc) {
                return res.status(400).json({ error: 'The employee has not yet saved the Bank Name, Account Number and IFSC in “My Profile” — please have these completed first.' });
            }
            const id = 'PR' + Date.now() + Math.random().toString(36).slice(2, 6);
            db.query(
                `INSERT INTO payout_requests
                 (id, agentId, agentName, amount, reason, status, type, employeeId, salarySlipId, bankName, accountNo, ifsc, agentShareAmount)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [id, emp.agentUsername || emp.ownerUser || '', empName || emp.name, amount,
                    'Salary payment', 'HR_Approved', 'employee_salary', empId, slipId,
                    emp.bank, emp.acc, emp.ifsc, agentShare],
                (iErr) => {
                    // 🔒 NOTE: HR khud verify karke bhej raha hai, isliye seedha
                    // 'HR_Approved' status se banti hai — alag se dobara approve
                    // karne ki zaroorat nahi (jaisa agent-payout flow mein hota
                    // hai). PFMS Portal isse turant "Pay Now" ke liye dekh
                    // paayega.
                    if (iErr) return res.status(500).json({ error: 'DB error: ' + iErr.message });
                    res.status(201).json({ success: true, id });
                }
            );
        });
    }
});


// Agent apni khud ki requests dekh sakta hai
app.get('/api/agent/payout-requests', requireRole('agent'), (req, res) => {
    db.query('SELECT * FROM payout_requests WHERE agentId=? ORDER BY created_at DESC', [req.authUser.username], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});

// ── 3) HRMS/Staff (role='employee'): pending requests verify + approve/reject ──
app.get('/api/hr/payout-requests', requireRole('employee', 'admin'), (req, res) => {
    db.query("SELECT * FROM payout_requests WHERE status='Pending' ORDER BY created_at ASC", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});
app.post('/api/hr/payout-requests/:id/approve', requireRole('employee', 'admin'), (req, res) => {
    db.query('SELECT * FROM payout_requests WHERE id=?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const reqRow = rows && rows[0];
        if (!reqRow) return res.status(404).json({ error: 'Request not found.' });
        if (reqRow.status !== 'Pending') return res.status(409).json({ error: 'This request is no longer Pending — it has already been processed by someone else.' });
        // 🔒 Agent ke current approved wallet balance se zyada payout approve
        // nahi ho sakta — taaki PFMS "Pay Now" karte waqt balance kabhi
        // negative na ho jaaye.
        db.query('SELECT approved_balance FROM agent_wallets WHERE agentId=?', [reqRow.agentId], (wErr, wRows) => {
            const bal = Number(wRows && wRows[0] && wRows[0].approved_balance) || 0;
            if (Number(reqRow.amount) > bal) {
                return res.status(400).json({ error: `The approved wallet balance of the agent (₹${bal}) is less than the request amount (₹${reqRow.amount}) — approval is not possible.` });
            }
            db.query(
                "UPDATE payout_requests SET status='HR_Approved', hr_approved_by=?, hr_approved_at=CURRENT_TIMESTAMP WHERE id=?",
                [req.authUser.username, req.params.id],
                (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                    res.json({ success: true });
                }
            );
        });
    });
});
app.post('/api/hr/payout-requests/:id/reject', requireRole('employee', 'admin'), (req, res) => {
    const reason = (req.body || {}).reason || '';
    db.query('SELECT status FROM payout_requests WHERE id=?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows[0]) return res.status(404).json({ error: 'Request not found.' });
        if (rows[0].status !== 'Pending') return res.status(409).json({ error: 'This request is no longer Pending.' });
        db.query("UPDATE payout_requests SET status='Rejected', rejected_reason=? WHERE id=?", [reason, req.params.id], (uErr) => {
            if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
            res.json({ success: true });
        });
    });
});

// ── 4) PFMS: HR-approved list + "Pay Now" (wallet debit + ledger + status) ──
app.get('/api/pfms/payout-requests', requireRole('pfms'), (req, res) => {
    db.query("SELECT * FROM payout_requests WHERE status='HR_Approved' ORDER BY hr_approved_at ASC", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});
// 🆕 Bank mein "Processing" (RazorpayX ne accept kar liya, par webhook se
// final confirm abhi nahi aaya) — PFMS ko yeh alag se dikhna chahiye taaki
// dubara "Pay Now" na dabaya jaaye.
app.get('/api/pfms/payout-requests/processing', requireRole('pfms', 'admin'), (req, res) => {
    db.query("SELECT * FROM payout_requests WHERE status='Processing' ORDER BY pfms_paid_at DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});
app.get('/api/pfms/payout-requests/paid', requireRole('pfms', 'admin'), (req, res) => {
    db.query("SELECT * FROM payout_requests WHERE status='Paid' ORDER BY pfms_paid_at DESC LIMIT 200", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});
// 🆕 MANUAL RECONCILIATION: agar webhook kisi wajah se miss/delay ho jaaye,
// PFMS user is button se seedha RazorpayX se live status khinch sakta hai.
app.get('/api/pfms/payout-requests/:id/check-status', requireRole('pfms', 'admin'), async (req, res) => {
    if (!razorpayXConfigured()) return res.status(501).json({ error: 'RazorpayX is not configured.' });
    db.query('SELECT * FROM payout_requests WHERE id=?', [req.params.id], async (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const pr = rows && rows[0];
        if (!pr || !pr.rzp_payout_id) return res.status(404).json({ error: 'No RazorpayX payout was found for this request.' });
        try {
            const live = await razorpayXRequest('GET', '/v1/payouts/' + pr.rzp_payout_id, null);
            let agentLive = null;
            if (pr.rzp_agent_payout_id) agentLive = await razorpayXRequest('GET', '/v1/payouts/' + pr.rzp_agent_payout_id, null);
            const mainDone = live.status === 'processed';
            const agentDone = agentLive ? agentLive.status === 'processed' : true;
            let newStatus = pr.status;
            if (live.status === 'failed' || live.status === 'reversed' || (agentLive && (agentLive.status === 'failed' || agentLive.status === 'reversed'))) {
                newStatus = 'HR_Approved'; // retry ke liye
            } else if (mainDone && agentDone) {
                newStatus = 'Paid';
            }
            db.query(
                'UPDATE payout_requests SET status=?, rzp_payout_status=?, rzp_agent_payout_status=? WHERE id=?',
                [newStatus, live.status, agentLive ? agentLive.status : pr.rzp_agent_payout_status, pr.id],
                () => res.json({ success: true, status: newStatus, rzpStatus: live.status })
            );
        } catch (e) {
            res.status(502).json({ error: 'Error while checking status with RazorpayX: ' + e.message });
        }
    });
});
app.post('/api/pfms/payout-requests/:id/pay', requireRole('pfms'), (req, res) => {
    db.query('SELECT * FROM payout_requests WHERE id=?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const reqRow = rows && rows[0];
        if (!reqRow) return res.status(404).json({ error: 'Request not found.' });
        if (reqRow.status !== 'HR_Approved') {
            return res.status(409).json({ error: 'This request is no longer HR_Approved — it may already be Paid or Processing.' });
        }

        // 🔒 IDEMPOTENCY (Step 1 — DB-level): status ko atomically
        // 'HR_Approved' → 'Processing' karo (WHERE status='HR_Approved'
        // guard ke saath) — race condition (double-click / do PFMS users
        // ek saath) mein bhi sirf EK hi request successfully row-affect
        // karegi, aur sirf wahi Razorpay ko call karegi.
        const nextStatus = razorpayXConfigured() ? 'Processing' : 'Paid';
        db.query(
            `UPDATE payout_requests SET status=?, pfms_paid_by=?, pfms_paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='HR_Approved'`,
            [nextStatus, req.authUser.username, req.params.id],
            (uErr, uResult) => {
                if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                if (!uResult || !uResult.affectedRows) {
                    return res.status(409).json({ error: 'This request was just paid by someone else — please refresh.' });
                }

                // ══ FALLBACK PATH: RazorpayX configure nahi hai ══
                // (RAZORPAYX_KEY_ID/SECRET/ACCOUNT_NUMBER Render Environment
                // mein set nahi kiye gaye) — purana instant "mark Paid"
                // behavior (koi real bank transfer nahi, sirf app ke andar
                // record). Isse app hamesha kaam karta rehta hai, chahe
                // live payouts abhi setup na hue hon.
                if (!razorpayXConfigured()) {
                    return _pfmsFinalizePaidLegacy(reqRow, req.authUser.username, res);
                }

                // ══ LIVE PATH: RazorpayX se asli bank transfer ══
                _pfmsInitiateRazorpayXPayout(reqRow, req.authUser.username, res);
            }
        );
    });
});

// Purana (RazorpayX na ho to) instant-paid path — wallet deduct + ledger /
// salary-slip update, jaisa pehle tha.
function _pfmsFinalizePaidLegacy(reqRow, pfmsUsername, res) {
    if (reqRow.type === 'employee_salary') {
        // 🔒 BUGFIX + PAID/LOCK MARKING: pehle yahan `hrGetBlob('hrms_salary_slips')`
        // use hota tha, jo `kv_blob` table ke ek ALAG blob-row ko update karta
        // hai — jabki asli slip jo employee ka dashboard dikhata hai
        // (GET /api/hrms-salary/slips) `hrms_salary_slips` SQL TABLE se aata
        // hai. Matlab pehle "Paid" mark karne ke baad bhi employee ko slip
        // hamesha "pending/unpaid" hi dikhta rehta tha — yeh fix ab seedha
        // sahi table ki row update karta hai, aur yahi is mahine ka
        // "Paid / Locked" hone ka official moment hai (isi ke against
        // duplicate-payout-lock check hota hai — neeche dekhein
        // `/api/hr/salary-slips/:slipId/request-payment`).
        markSalarySlipPaid(reqRow.salarySlipId, 'PFMS', pfmsUsername, (sErr) => {
            if (sErr) console.warn('PFMS pay: salary slip update error:', sErr.message);
            res.json({ success: true });
        });
        return;
    }
    // 🔒 AUTO-ZERO WALLET: seedha "balance - amount" karne se kabhi-kabhi
    // floating-point ki wajah se balance 0 ki jagah 0.000001 jaisa reh
    // jaata tha (UI par "0" na dikh kar ek chhota fraction dikh jaata tha).
    // Ab agar payout balance ko clear (ya usse zyada) kar raha ho, to
    // seedha EXACT 0 set karte hain — warna normal partial-deduct hota hai.
    db.query(
        `UPDATE agent_wallets SET approved_balance = CASE WHEN approved_balance - ? <= 0.005 THEN 0 ELSE approved_balance - ? END WHERE agentId=?`,
        [reqRow.amount, reqRow.amount, reqRow.agentId],
        (wErr) => {
        if (wErr) console.warn('PFMS pay: wallet deduct error:', wErr.message);
        const txnId = 'TXN' + Date.now() + Math.random().toString(36).slice(2, 6);
        db.query(
            'INSERT INTO transactions (id, agentId, amount, status, reason, data) VALUES (?,?,?,?,?,?)',
            [txnId, reqRow.agentId, -Math.abs(Number(reqRow.amount)), 'verified', 'PFMS Payout: ' + (reqRow.reason || reqRow.id),
                JSON.stringify({ type: 'pfms_payout_debit', payoutRequestId: reqRow.id, paidBy: pfmsUsername })],
            (tErr) => {
                if (tErr) console.warn('PFMS pay: ledger entry error:', tErr.message);
                res.json({ success: true });
            }
        );
    });
}

// 🆕 LIVE PATH: RazorpayX Contact → Fund Account → Payout banata hai.
// Employee ko net-pay bhejta hai, aur agar agentShareAmount > 0 ho to
// agent ko bhi ek alag payout se uska split bhejta hai. Yahan status
// sirf 'Processing' set hota hai — FINAL 'Paid'/'Failed' status
// webhook (/api/webhooks/razorpayx) se aata hai, jab bank transfer
// asal mein confirm/fail ho jaaye.
async function _pfmsInitiateRazorpayXPayout(reqRow, pfmsUsername, res) {
    try {
        if (reqRow.type === 'employee_salary') {
            const employees = await new Promise((resolve, reject) => hrGetBlob('hrms_employees', (e, l) => e ? reject(e) : resolve(l)));
            const idx = employees.findIndex(e => e && String(e.empId).toUpperCase() === String(reqRow.employeeId).toUpperCase());
            if (idx < 0) throw new Error('Employee record not found.');
            const emp = employees[idx];
            if (!emp.bank || !emp.acc || !emp.ifsc) throw new Error('The employee bank details are incomplete.');

            const fundAccountId = await ensureRazorpayFundAccount(emp.rzpFundAccountId, emp.name, 'employee', emp.bank, emp.acc, emp.ifsc);
            if (!emp.rzpFundAccountId) {
                employees[idx].rzpFundAccountId = fundAccountId;
                await new Promise((resolve) => hrSetBlob('hrms_employees', employees, () => resolve()));
            }
            const payout = await createRazorpayPayout(fundAccountId, reqRow.amount, reqRow.id, 'Salary - ' + reqRow.employeeId);

            let agentPayoutId = null;
            if (Number(reqRow.agentShareAmount) > 0 && reqRow.agentId) {
                agentPayoutId = await _payAgentShare(reqRow.agentId, reqRow.agentShareAmount, reqRow.id + '_AGT');
            }
            db.query(
                'UPDATE payout_requests SET rzp_payout_id=?, rzp_payout_status=?, rzp_agent_payout_id=? WHERE id=?',
                [payout.id, payout.status || 'queued', agentPayoutId, reqRow.id],
                () => res.json({ success: true, status: 'Processing', rzpPayoutId: payout.id })
            );
        } else {
            // agent_payout — poora amount seedha agent ke bank account mein
            const agentPayoutId = await _payAgentShare(reqRow.agentId, reqRow.amount, reqRow.id);
            // Internal ledger bhi turant update (bookkeeping) — asli status
            // baad mein webhook se 'Paid'/'Failed' confirm hoga.
            // 🔒 AUTO-ZERO WALLET (yahan bhi wahi exact-zero fix — dekhein
            // upar _pfmsFinalizePaidLegacy mein comment).
            db.query(
                `UPDATE agent_wallets SET approved_balance = CASE WHEN approved_balance - ? <= 0.005 THEN 0 ELSE approved_balance - ? END WHERE agentId=?`,
                [reqRow.amount, reqRow.amount, reqRow.agentId], () => {});
            const txnId = 'TXN' + Date.now() + Math.random().toString(36).slice(2, 6);
            db.query(
                'INSERT INTO transactions (id, agentId, amount, status, reason, data) VALUES (?,?,?,?,?,?)',
                [txnId, reqRow.agentId, -Math.abs(Number(reqRow.amount)), 'pending', 'PFMS Payout (Razorpay processing): ' + (reqRow.reason || reqRow.id),
                    JSON.stringify({ type: 'pfms_payout_debit', payoutRequestId: reqRow.id, paidBy: pfmsUsername })]
            );
            db.query(
                'UPDATE payout_requests SET rzp_payout_id=? WHERE id=?',
                [agentPayoutId, reqRow.id],
                () => res.json({ success: true, status: 'Processing', rzpPayoutId: agentPayoutId })
            );
        }
    } catch (e) {
        // 🔒 ROLLBACK: Razorpay call fail hui (galat bank details, kam
        // balance, API error) — status wapas 'HR_Approved' par le aate
        // hain taaki PFMS user dobara try kar sake, data/permission fix
        // karke.
        console.error('RazorpayX payout error:', e.message);
        db.query(
            "UPDATE payout_requests SET status='HR_Approved', payout_error=? WHERE id=?",
            [e.message, reqRow.id],
            () => res.status(502).json({ error: 'RazorpayX payout failed: ' + e.message + ' — the request has been reverted to HR_Approved. Please try again.' })
        );
    }
}
async function _payAgentShare(agentId, amountRupees, referenceId) {
    const rows = await new Promise((resolve, reject) => db.query('SELECT value FROM kv_admin_entities WHERE `key`=?', ['agents'], (e, r) => e ? reject(e) : resolve(r)));
    let agents = [];
    try { agents = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) {}
    const idx = agents.findIndex(a => a && a.username === agentId);
    if (idx < 0) throw new Error('Agent record not found.');
    const agent = agents[idx];
    if (!agent.bank || !agent.ifsc) throw new Error('The agent bank details (Account Number/IFSC) are incomplete.');
    const fundAccountId = await ensureRazorpayFundAccount(agent.rzpFundAccountId, agent.accountName || agent.company || agent.name, 'vendor', agent.bankName, agent.bank, agent.ifsc);
    if (!agent.rzpFundAccountId) {
        agents[idx].rzpFundAccountId = fundAccountId;
        await new Promise((resolve) => db.query(
            'INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
            ['agents', JSON.stringify(agents)], () => resolve()
        ));
    }
    const payout = await createRazorpayPayout(fundAccountId, amountRupees, referenceId, 'Agent payout - ' + agentId);
    return payout.id;
}

// 🆕 RAZORPAYX WEBHOOK — bank transfer ka ASLI, final status yahan se
//   aata hai (payout.processed / payout.failed / payout.reversed).
//   Signature verify karna ZAROORI hai — warna koi bhi bina auth ke
//   fake "payment successful" bhej kar payslip/wallet ko galat tarike
//   se "Paid" mark karva sakta tha.
app.post('/api/webhooks/razorpayx', (req, res) => {
    const secret = process.env.RAZORPAYX_WEBHOOK_SECRET;
    if (!secret) { console.warn('Webhook received but RAZORPAYX_WEBHOOK_SECRET not set — ignoring.'); return res.status(501).end(); }
    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.from(JSON.stringify(req.body))).digest('hex');
    if (!signature || signature !== expected) {
        console.warn('RazorpayX webhook: invalid signature — request ignored.');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body.event;
    const payoutEntity = req.body.payload && req.body.payload.payout && req.body.payload.payout.entity;
    if (!payoutEntity) return res.status(200).end(); // koi payout data nahi — kuch karne ki zaroorat nahi

    const rzpPayoutId = payoutEntity.id;
    const rzpStatus = payoutEntity.status; // 'processed' | 'failed' | 'reversed' | 'queued' etc.

    db.query('SELECT * FROM payout_requests WHERE rzp_payout_id=? OR rzp_agent_payout_id=?', [rzpPayoutId, rzpPayoutId], (err, rows) => {
        if (err || !rows || !rows[0]) return res.status(200).end(); // is app se related nahi — ignore
        const pr = rows[0];
        const isAgentLeg = pr.rzp_agent_payout_id === rzpPayoutId;

        db.query(
            isAgentLeg ? 'UPDATE payout_requests SET rzp_agent_payout_status=? WHERE id=?' : 'UPDATE payout_requests SET rzp_payout_status=? WHERE id=?',
            [rzpStatus, pr.id],
            () => {
                if (event === 'payout.processed') {
                    // Dono legs (agar agent-split bhi tha) processed hue tabhi
                    // final 'Paid' mark karo — warna abhi partial hai.
                    const mainDone = isAgentLeg ? pr.rzp_payout_status === 'processed' : true;
                    const agentDone = pr.rzp_agent_payout_id ? (isAgentLeg ? true : pr.rzp_agent_payout_status === 'processed') : true;
                    if (mainDone && agentDone) {
                        db.query("UPDATE payout_requests SET status='Paid' WHERE id=?", [pr.id], () => {
                            if (pr.type === 'employee_salary') {
                                // 🔒 Yahan bhi wahi real-table fix (upar
                                // _pfmsFinalizePaidLegacy ka comment dekhein).
                                markSalarySlipPaid(pr.salarySlipId, 'PFMS (RazorpayX)', null, () => {});
                            } else {
                                db.query("UPDATE transactions SET status='verified' WHERE data::text LIKE ?", ['%"payoutRequestId":"' + pr.id + '"%'], () => {});
                            }
                        });
                    }
                } else if (event === 'payout.failed' || event === 'payout.reversed') {
                    // 🔒 Bank transfer fail/reverse hua — request ko wapas
                    // HR_Approved kar dete hain (PFMS dobara try kar sake),
                    // aur agar agent_payout tha to wallet/ledger bhi wapas
                    // rollback karte hain (jo deduct kiya tha).
                    db.query("UPDATE payout_requests SET status='HR_Approved', payout_error=? WHERE id=?",
                        ['RazorpayX: ' + event + ' — ' + (payoutEntity.failure_reason || 'reason not given')], [pr.id], () => {});
                    if (pr.type !== 'employee_salary' && !isAgentLeg) {
                        db.query('UPDATE agent_wallets SET approved_balance = approved_balance + ? WHERE agentId=?', [pr.amount, pr.agentId], () => {});
                        db.query("UPDATE transactions SET status='rejected' WHERE data::text LIKE ?", ['%"payoutRequestId":"' + pr.id + '"%'], () => {});
                    }
                }
                res.status(200).end();
            }
        );
    });
});

// ── 5) AGENT: Live Ledger/Statement — collections + debits + running balance ──
app.get('/api/agent/ledger', requireRole('agent'), (req, res) => {
    const agentId = req.authUser.username;
    db.query('SELECT * FROM transactions WHERE agentId=? ORDER BY created_at DESC LIMIT 500', [agentId], (err, txnRows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        db.query('SELECT * FROM agent_wallets WHERE agentId=?', [agentId], (wErr, wRows) => {
            const wallet = (wRows && wRows[0]) || { approved_balance: 0, pending_balance: 0, total_earned: 0 };
            const history = (txnRows || []).map(t => ({
                id: t.id, amount: Number(t.amount), status: t.status, reason: t.reason,
                type: Number(t.amount) < 0 ? 'debit' : 'credit', date: t.created_at
            }));
            const totalCollections = history.filter(h => h.type === 'credit').reduce((s, h) => s + h.amount, 0);
            const totalDebits = history.filter(h => h.type === 'debit').reduce((s, h) => s + Math.abs(h.amount), 0);
            res.json({
                walletBalance: Number(wallet.approved_balance) || 0,
                pendingBalance: Number(wallet.pending_balance) || 0,
                totalEarned: Number(wallet.total_earned) || 0,
                totalCollections, totalDebits,
                history
            });
        });
    });
});

// ── 6) ADMIN: PFMS Master Ledger — sab kuch ek jagah ──
app.get('/api/admin/pfms-master-ledger', requireRole('admin'), (req, res) => {
    db.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 500', (e1, txns) => {
        if (e1) return res.status(500).json({ error: 'DB error: ' + e1.message });
        db.query('SELECT * FROM payout_requests ORDER BY created_at DESC LIMIT 500', (e2, payouts) => {
            if (e2) return res.status(500).json({ error: 'DB error: ' + e2.message });
            db.query('SELECT agentId, approved_balance, pending_balance, total_earned FROM agent_wallets', (e3, wallets) => {
                if (e3) return res.status(500).json({ error: 'DB error: ' + e3.message });
                res.json({
                    transactions: (txns || []).map(t => ({ id: t.id, agentId: t.agentId, studentId: t.studentId, amount: Number(t.amount), status: t.status, reason: t.reason, date: t.created_at })),
                    payoutRequests: payouts || [],
                    agentWallets: wallets || []
                });
            });
        });
    });
});

// 🔒 FULL SYSTEM RESET — password-verified (backend-side, bcrypt), aur
//   ab har naya data-model (Invoice Material Portal, PFMS payouts, agent
//   wallets) bhi shamil karta hai — jo purana client-side reset function
//   miss kar raha tha. Admin login + Library Settings + PFMS credentials
//   hamesha bache rehte hain.
app.post('/api/admin/full-system-reset', requireRole('admin'), (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password is required.' });
    db.query('SELECT value FROM kv_admin_entities WHERE `key`=?', ['admins'], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        let admins = [];
        try { admins = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) {}
        const me = admins.find(a => a && a.username === req.authUser.username);
        if (!me || !me.password) return res.status(401).json({ error: 'Admin record not found.' });
        const ok = looksHashed(me.password) ? bcrypt.compareSync(password, me.password) : me.password === password;
        if (!ok) return res.status(401).json({ error: 'Invalid password. Please enter the correct password.' });

        // ── Entity keys (kv_admin_entities) — 'admins' aur 'agent_logins'
        //    ('agent_logins' credentials hain, isliye bacha lete hain) ──
        const entityClears = ['staff', 'agents', 'students'];
        // ── Blob keys — har tarah ka operational data ──
        const blobClears = [
            'att_records', 'fee_records', 'salary_claims', 'hrms_registrations', 'staff_att',
            'leave_requests', 'members', 'notices', 'pending_staff',
            'hrms_employees', 'hrms_pending_registrations', 'hrms_salary_slips', 'hrms_settings',
            'hrms_attendance', 'hrms_leaves', 'hrms_salary_claims',
            'student_photos', 'selfies', 'attendance_locations', 'comments', 'att_monthly_summary',
            'customer_pending_registrations', 'agent_pending_registrations'
        ];
        // ── SQL tables — Invoice Material Portal, PFMS payouts, agent wallets ──
        const tableClears = ['material_users', 'material_bills', 'payout_requests', 'agent_wallets', 'transactions'];

        let pending = entityClears.length + blobClears.length + tableClears.length;
        let hadError = false;
        function done() {
            pending--;
            if (pending === 0) {
                if (hadError) return res.status(500).json({ error: 'Some data could not be reset. Please try again.' });
                res.json({ success: true });
            }
        }
        entityClears.forEach(key => {
            db.query(
                'INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
                [key, '[]'], (e) => { if (e) hadError = true; done(); }
            );
        });
        blobClears.forEach(key => {
            db.query(
                'INSERT INTO kv_blob ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
                [key, '[]'], (e) => { if (e) hadError = true; done(); }
            );
        });
        tableClears.forEach(table => {
            db.query(`DELETE FROM ${table}`, (e) => { if (e) hadError = true; done(); });
        });
    });
});

// 🆕 ADMIN: HR Report — sabhi HRMS employees (bank details samet) +
//   unki latest salary slip + payout status, ek hi consolidated report
//   mein. Employee jab bhi HRMS se koi claim/data submit kare, yeh
//   report automatically usi turant reflect karti hai (koi caching nahi
//   — har baar fresh DB read).
app.get('/api/admin/hr-report', requireRole('admin'), (req, res) => {
    hrGetBlob('hrms_employees', (e1, employees) => {
        if (e1) return res.status(500).json({ error: 'DB error: ' + e1.message });
        hrGetBlob('hrms_salary_slips', (e2, slips) => {
            if (e2) return res.status(500).json({ error: 'DB error: ' + e2.message });
            db.query("SELECT * FROM payout_requests WHERE type='employee_salary' ORDER BY created_at DESC", (e3, payouts) => {
                if (e3) return res.status(500).json({ error: 'DB error: ' + e3.message });
                const report = employees.map(emp => {
                    const empSlips = (slips || []).filter(s => s && s.empId === emp.empId).sort((a, b) => (b.year - a.year) || (b.month - a.month));
                    const latestSlip = empSlips[0] || null;
                    const latestPayout = (payouts || []).find(p => p.employeeId === emp.empId) || null;
                    return {
                        empId: emp.empId, name: emp.name, phone: emp.phone,
                        designation: emp.designation, department: emp.department,
                        agentUsername: emp.agentUsername || emp.ownerUser || '',
                        status: emp.status,
                        bankName: emp.bank || '', accountNo: emp.acc || '', ifsc: emp.ifsc || '',
                        bankDetailsComplete: !!(emp.bank && emp.acc && emp.ifsc),
                        latestNetPay: latestSlip ? Number(latestSlip.net) : null,
                        latestSlipMonth: latestSlip ? (latestSlip.month + '/' + latestSlip.year) : null,
                        latestSlipStatus: latestSlip ? latestSlip.status : null,
                        latestPayoutStatus: latestPayout ? latestPayout.status : null
                    };
                });
                res.json(report);
            });
        });
    });
});

// ══════════════════════════════════════════════════════════════════
// 📸 STUDENT SELF-SERVICE ATTENDANCE (mobile selfie+GPS punch)
//   Student apni attendance khud mark karta hai — 'att_records',
//   'selfies', 'attendance_locations', 'student_photos' blobs sensitive
//   (poore batch ka data) hain, isliye Student ko poori list GET karne
//   ki zaroorat/permission nahi — yeh dedicated endpoints sirf server-
//   side merge karte hain (student sirf apna record bhejta hai).
// ══════════════════════════════════════════════════════════════════
app.post('/api/attendance/mark', requireRole('student'), (req, res) => {
    const entry = req.body || {};
    if (!entry.date || !entry.batch) return res.status(400).json({ error: 'date and batch are required.' });
    hrGetBlob('att_records', (err, records) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        // Isi date+batch ka existing record ho to usi mein naye student ka
        // record MERGE karo (jaisa client pehle localStorage mein karta tha)
        // — poora din/batch overwrite nahi hota, sirf is student ki entry.
        let idx = records.findIndex(r => r && r.date === entry.date && String(r.batch) === String(entry.batch));
        if (idx < 0) {
            records.push({ date: entry.date, batch: entry.batch, records: entry.records || {}, selfies: entry.selfies || {}, markedBy: entry.markedBy || req.authUser.username, savedAt: new Date().toLocaleTimeString() });
        } else {
            records[idx].records = Object.assign({}, records[idx].records, entry.records || {});
            if (entry.selfies) records[idx].selfies = Object.assign({}, records[idx].selfies, entry.selfies);
            records[idx].savedAt = new Date().toLocaleTimeString();
        }
        hrSetBlob('att_records', records, (sErr) => {
            if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
            res.json({ success: true });
        });
    });
});
app.post('/api/attendance/selfie', requireRole('student'), (req, res) => {
    const { studentId, date, selfie, location, name, batch } = req.body || {};
    if (!studentId || !date) return res.status(400).json({ error: 'studentId and date are required.' });
    hrGetBlobObj('selfies', (err, store) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        store[studentId] = store[studentId] || {};
        store[studentId][date] = {
            selfie: selfie || '', name: name || '', batch: batch || '',
            time: new Date().toLocaleTimeString('en-IN'), studentId,
            lat: location ? location.lat : null, lng: location ? location.lng : null,
            accuracy: location ? location.accuracy : null, mapsLink: location ? location.mapsLink : null,
            locationAt: location ? location.capturedAt : null
        };
        hrSetBlob('selfies', store, (sErr) => {
            if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
            // attendance_locations — alag, seedha GPS-only lookup
            if (location) {
                hrGetBlobObj('attendance_locations', (err2, locStore) => {
                    locStore[studentId] = locStore[studentId] || {};
                    locStore[studentId][date] = { lat: location.lat, lng: location.lng, accuracy: location.accuracy, mapsLink: location.mapsLink, name: name || '', batch: batch || '', time: new Date().toLocaleTimeString('en-IN'), capturedAt: location.capturedAt };
                    hrSetBlob('attendance_locations', locStore, () => {});
                });
            }
            // student_photos — profile photo bhi latest selfie se update
            if (selfie) {
                hrGetBlobObj('student_photos', (err3, photoStore) => {
                    photoStore[studentId] = selfie;
                    hrSetBlob('student_photos', photoStore, () => {});
                });
            }
            res.json({ success: true });
        });
    });
});
app.put('/api/attendance/profile-photo/:studentId', requireRole('student'), (req, res) => {
    const { photo } = req.body || {};
    if (!photo) return res.status(400).json({ error: 'photo is required.' });
    hrGetBlobObj('student_photos', (err, store) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        store[req.params.studentId] = photo;
        hrSetBlob('student_photos', store, (sErr) => {
            if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
            res.json({ success: true });
        });
    });
});
// Student apni khud ki profile photo / latest selfie dekh sakta hai
// (poori list nahi, sirf apna record).
app.get('/api/attendance/profile-photo/:studentId', (req, res) => {
    const auth = getAuthUser(req);
    const role = auth && String(auth.role || '').toLowerCase();
    if (!auth || (role === 'student' && String(auth.username).toUpperCase() !== String(req.params.studentId).toUpperCase()) || (role !== 'student' && role !== 'admin' && role !== 'agent')) {
        return res.status(401).json({ error: 'Permission denied.' });
    }
    hrGetBlobObj('student_photos', (err, store) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json({ photo: store[req.params.studentId] || null });
    });
});

// site-data: POST body { value }, GET returns { value }
// 🔒 Sirf Admin session (JWT role='Admin') hi website content badal sake —
//   index.html ise sirf PADHTA hai (login ke bina), yeh comment mein bhi
//   likha tha to ab isko enforce bhi kar diya.
const PRIVATE_SITE_KEYS = ['access_gate'];
app.post('/api/site-data/:key', (req, res) => {
    if (PRIVATE_SITE_KEYS.includes(req.params.key)) return res.status(403).json({ error: 'Is key ko /api/admin/gate-config se badlein.' });
    const auth = getAuthUser(req);
    if (!auth || String(auth.role).toLowerCase() !== 'admin') return res.status(401).json({ error: 'Website content can be changed only with an Admin login.' });
    const value = (req.body || {}).value;
    const json = JSON.stringify(value);
    db.query(
        'INSERT INTO kv_site_data ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
        [req.params.key, json],
        (err) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            res.json({ success: true });
        }
    );
});
app.get('/api/site-data/:key', (req, res) => {
    if (PRIVATE_SITE_KEYS.includes(req.params.key)) return res.status(404).json(null);
    db.query('SELECT value FROM kv_site_data WHERE `key` = ?', [req.params.key], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.json(null);
        let parsed = null;
        try { parsed = JSON.parse(rows[0].value); } catch (e) { parsed = rows[0].value; }
        res.json({ value: parsed });
    });
});

// 🆕 COMBINED site-data — index.html ka LIVE SYNC (GET /api/site-data, bina
//   key ke) isi ek call se ticker/hero/stats/footer/nav/login/apps saara
//   data ek saath fetch karta hai, taaki 7 alag requests na karni padein.
//   Admin Panel jab bhi koi ek section save karta hai (POST /site-data/:key),
//   agli baar yeh route khud-ba-khud updated value bhej dega — koi extra
//   kaam nahi karna padta.
app.get('/api/site-data', (req, res) => {
    db.query('SELECT `key`, value FROM kv_site_data', (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const out = {};
        (rows || []).forEach(r => {
            if (PRIVATE_SITE_KEYS.includes(r.key)) return;
            try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = r.value; }
        });
        res.json(out);
    });
});

// ══════════════════════════════════════════════════════════════════
// 📤 FILE UPLOAD — Hero image / Logo / Login-page HTML / APK
//   (Admin_panel_Login.html ka gcsUploadFile() isi route ko call karta
//   hai; pehle yeh route missing tha isliye Express ka default 404 HTML
//   aata tha aur frontend "Unexpected token '<'..." error deta tha.)
//   Memory mein hi rakha jaata hai (Multer memoryStorage) aur seedhe MySQL
//   mein blob ki tarah save hota hai — Render ke ephemeral disk pe nahi,
//   isliye redeploy/restart hone par bhi file gayab nahi hoti.
// ══════════════════════════════════════════════════════════════════
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max

// Slug ko URL-safe banata hai: "Agent Login" → "agent-login"
function slugify(str) {
    return String(str || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 140);
}

app.post('/api/site-content/upload-file', upload.single('file'), (req, res) => {
    const auth = getAuthUser(req);
    if (!auth || String(auth.role).toLowerCase() !== 'admin') return res.status(401).json({ error: 'Files can be uploaded only with an Admin login.' });
    if (!req.file) return res.status(400).json({ error: 'No file was received (the form field name must be file).' });
    const folder = req.body.folder || 'misc';
    const slug = req.body.slug ? slugify(req.body.slug) : null;

    const respondWithFile = (id) => {
        // 🆕 Agar slug diya gaya hai (login-pages ke liye hamesha diya jaata hai), to
        // URL hamesha /api/pages/<slug> hoga — yeh URL kabhi nahi badalta, chahe file
        // dobara-dobara upload/update hoti rahe. Isi se "Dynamic Centralized Login
        // System" banta hai: Netlify par kabhi alag se file deploy nahi karni padti.
        const path = slug ? ('/api/pages/' + slug) : ('/api/site-content/file/' + id);
        const absoluteUrl = req.protocol + '://' + req.get('host') + path;
        res.status(201).json({ url: absoluteUrl, path: absoluteUrl, name: req.file.originalname, size: req.file.size, slug: slug || null });
    };

    if (slug) {
        // 🆕 UPSERT by slug: pehli baar INSERT, agli baar isi slug par UPDATE —
        // taaki "Agent Login" dobara upload karne par bhi URL wahi purana hi rahe.
        insertWithIdHeal(
            `INSERT INTO site_files (slug, folder, name, mime, size, data) VALUES (?,?,?,?,?,?)
             ON CONFLICT (slug) DO UPDATE SET folder=EXCLUDED.folder, name=EXCLUDED.name, mime=EXCLUDED.mime, size=EXCLUDED.size, data=EXCLUDED.data`,
            [slug, folder, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer],
            'site_files',
            (err, result) => {
                if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                respondWithFile(result.insertId);
            }
        );
    } else {
        insertWithIdHeal(
            'INSERT INTO site_files (folder, name, mime, size, data) VALUES (?,?,?,?,?)',
            [folder, req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer],
            'site_files',
            (err, result) => {
                if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                respondWithFile(result.insertId);
            }
        );
    }
});

// File serve by numeric ID (purane links ke backward-compatibility ke liye)
app.get('/api/site-content/file/:id', (req, res) => {
    db.query('SELECT name, mime, data FROM site_files WHERE id=?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).send('DB error');
        if (!rows || !rows.length) return res.status(404).send('File not found');
        const f = rows[0];
        // 🔒 FIX: pehle hamesha 'inline' set hota tha — HTML login-pages ke
        // liye theek hai, lekin APK/App Download Manager se upload ki gayi
        // files (jinka koi slug nahi hota, isi route se serve hoti hain) ke
        // liye 'inline' ka matlab browser unhe khud render/open karne ki
        // koshish karta, jo APK jaise binary files ke liye fail ho jaata —
        // asli "Download" kabhi trigger hi nahi hota tha. Ab sirf HTML/text
        // files inline rahengi, baaki sab (APK sahit) turant download hongi.
        const isHtml = /html|text\//i.test(f.mime || '');
        res.set('Content-Type', f.mime || 'application/octet-stream');
        res.set('Content-Disposition', (isHtml ? 'inline' : 'attachment') + '; filename="' + f.name + '"');
        res.send(f.data);
    });
});

// ══════════════════════════════════════════════════════════════════
// 🌐 CENTRALIZED DYNAMIC PAGE ROUTE — yeh hi woh "catch-all" route hai
//   jo aapne maanga tha. Admin/Agent/HRMS/Student/Invoice — koi bhi
//   login page ho, sabka HTML ab isi EK route se, database se seedha
//   nikal kar serve hota hai. Naya login role add karna ho to bas Admin
//   Panel se naya HTML upload karo (slug ke saath) — turant
//   /api/pages/<slug> par live ho jaata hai, Netlify par kuch bhi
//   deploy karne ki zaroorat NAHI.
// ══════════════════════════════════════════════════════════════════
app.get('/api/pages/:slug', (req, res) => {
    // 🔒 FIX: MySQL mein VARCHAR comparison zyada tar case-insensitive hoti
    // hai (default collation), lekin Postgres mein '=' hamesha case-sensitive
    // hai. slugify() upload ke waqt hamesha lowercase karta hai, lekin yahan
    // URL se aaya slug seedha (bina lowercase kiye) compare ho raha tha —
    // isliye MySQL→Postgres migration ke baad koi bhi thoda different-case
    // URL (jaise /Admin-Login) match nahi karta tha, chahe file upload ho
    // chuki ho. Ab LOWER() dono taraf lagाya hai, taaki casing kabhi matter
    // na kare.
    db.query('SELECT name, mime, data FROM site_files WHERE LOWER(slug)=LOWER(?)', [req.params.slug], (err, rows) => {
        if (err) return res.status(500).send('DB error: ' + err.message);
        if (!rows || !rows.length) return res.status(404).send('This page has not been uploaded yet: /' + req.params.slug);
        const f = rows[0];
        res.set('Content-Type', f.mime || 'text/html');
        res.set('Content-Disposition', 'inline; filename="' + f.name + '"');
        res.send(f.data);
    });
});

// Admin Panel ke "Login Dropdown Manager" mein sabhi upload-ho-chuke pages
// ki list dikhane ke liye (slug + naam + kab update hua)
app.get('/api/pages', (req, res) => {
    db.query("SELECT slug, name, mime, size, updated_at FROM site_files WHERE slug IS NOT NULL ORDER BY updated_at DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});

// Convenience direct aliases (frontend polls these paths directly)
app.get('/api/students', (req, res) => kvGet('kv_admin_entities', 'students', res, null, req));

// 🔒 FIX: pehle frontend khud hi agla SHL-XXX ID "guess" karta tha —
// sirf screen par abhi dikh rahe rows aur ek purani localStorage copy
// dekhkar. Agar table filtered ho, ya kisi doosre device/agent ne
// beech mein koi student add kiya ho jo abhi is browser mein sync
// nahi hua, to yeh guess galat ho jaata — duplicate ya gaya-guzra ID
// ban jaata. Ab yeh ID seedha live database (jo hamesha sabse sahi/
// up-to-date jagah hai) dekh kar diya jaata hai.
// 🆕 PENDING REGISTRATION SYNC — pehle "Agent Register" form seedha
// Firebase (shdl/agent_logins) mein likh kar turant agent ko active kar
// deta tha — Admin Panel ko iske baare mein pata hi nahi chalta tha,
// koi "Pending" list thi hi nahi jahan yeh dikhta. Ab yeh backend mein
// pending register hota hai; Admin Panel isse dekh kar Approve/Reject
// karta hai — approve hone tak agent login nahi kar sakta.
app.post('/api/agent-registrations', (req, res) => {
    const { name, username, password, mobile, company } = req.body || {};
    if (!name || !username || !password) return res.status(400).json({ error: 'Name, username and password are required.' });
    if (password.length < 4) return res.status(400).json({ error: 'The password must be at least 4 characters long.' });
    const uname = String(username).trim().toLowerCase();
    if (uname.indexOf(' ') !== -1) return res.status(400).json({ error: 'The username must not contain spaces.' });

    db.query("SELECT value FROM kv_admin_entities WHERE \"key\"='agents'", (aErr, aRows) => {
        if (aErr) return res.status(500).json({ error: 'DB error: ' + aErr.message });
        let agents = [];
        try { agents = aRows && aRows.length ? JSON.parse(aRows[0].value) : []; } catch (e) {}
        if (agents.some(a => a && a.username && a.username.toLowerCase() === uname)) {
            return res.status(409).json({ error: 'This username already belongs to an active agent.' });
        }
        db.query("SELECT value FROM kv_blob WHERE \"key\"='agent_pending_registrations'", (pErr, pRows) => {
            if (pErr) return res.status(500).json({ error: 'DB error: ' + pErr.message });
            let pending = [];
            try { pending = pRows && pRows.length ? JSON.parse(pRows[0].value) : []; } catch (e) {}
            if (pending.some(p => p && p.username && p.username.toLowerCase() === uname && p.status === 'pending')) {
                return res.status(409).json({ error: 'A registration with this username is already awaiting Admin approval.' });
            }
            const rec = {
                id: 'REG' + Date.now(), name, username: uname,
                // 🔒 Password Hashing: pending registration mein bhi
                // password kabhi plain-text save nahi hota — turant bcrypt
                // hash. Admin approve karega to yahi hash 'agents' list
                // mein copy ho jaata hai (dobara hash nahi hoga, looksHashed()
                // ise pehchan lega).
                password: bcrypt.hashSync(password, 10),
                mobile: mobile || '', company: company || '',
                status: 'pending', submittedOn: new Date().toISOString()
            };
            pending.push(rec);
            db.query(
                "INSERT INTO kv_blob (\"key\", value) VALUES ('agent_pending_registrations', ?) ON CONFLICT (\"key\") DO UPDATE SET value = EXCLUDED.value",
                [JSON.stringify(pending)],
                (insErr) => {
                    if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                    res.status(201).json({ success: true, id: rec.id });
                }
            );
        });
    });
});


// ══════════════════════════════════════════════════════════════════
// 📋 CUSTOMER REGISTRATION — payment-gated. Customer plan chunta hai,
//   Razorpay checkout khulta hai, aur SIRF payment successful hone ke
//   baad hi registration DB mein save hoke Admin ke pending-approval
//   queue mein jaata hai. Plan ki price hamesha server par (Admin ke
//   asli mem_plans se) check hoti hai — client jo bheje uska koi
//   matlab nahi, tamper-proof hai.
// ══════════════════════════════════════════════════════════════════
app.post('/api/customer-registrations/order', async (req, res) => {
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) {
        return res.status(501).json({ error: 'Payment keys are not set in the Render Environment (PAYMENT_API_KEY / PAYMENT_API_SECRET).' });
    }
    const { name, mobile, email, address, note, planId } = req.body || {};
    if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile number are required.' });
    if (!/^\d{10}$/.test(String(mobile))) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    if (!planId) return res.status(400).json({ error: 'Selecting a membership plan is required.' });

    // 🆕 KYC FIELDS (Aadhaar last-4 / PAN / district / state / pin) — pehle yeh
    // frontend se aate the par backend inhe chup-chaap gira deta tha. Ab VALIDATE
    // hote hain (Razorpay order banane se PEHLE, taaki galat data par paisa na
    // kate) aur PAN encrypted save hota hai — plain-text kahin nahi.
    const kycIn = parseKycInput(req.body || {}, { requireAadhaar: true, requirePan: true });
    if (kycIn.error) return res.status(kycIn.status || 400).json({ error: kycIn.error });
    const kyc = kycIn.fields;
    const cName = cleanText(name, 255), cEmail = cleanText(email, 255), cAddress = cleanText(address, 500), cNote = cleanText(note, 500);

    // 🆕 PUBLIC SELF-REGISTRATION: yeh route ab agent-login ke bina bhi
    // (naye customer ke liye) khula hai — Login screen ke "Customer
    // Registration" button se, jahan koi currentUser/agent session nahi
    // hota. Agent ID yahan ab bilkul OPTIONAL hai:
    //   1) req.body.agentId — agar koi logged-in agent apne referral se
    //      bhej raha ho
    //   2) agar koi valid agent session ho (Authorization header), uska
    //      username/agentId
    //   3) warna khaali chhod dete hain — naya customer seedha payment
    //      karke apna registration Admin ke pending-approval queue mein
    //      bhej sakta hai, bina kisi Agent ke.
    const auth = getAuthUser(req);
    const loginUsername = auth && auth.username;
    const bodyAgentId = req.body && req.body.agentId;
    db.query('SELECT value FROM kv_admin_entities WHERE `key`=?', ['agents'], (aErr, aRows) => {
        if (aErr) return res.status(500).json({ error: 'DB error: ' + aErr.message });
        let agents = [];
        try { agents = JSON.parse(aRows && aRows[0] && aRows[0].value) || []; } catch (e) {}
        const agentProfile = loginUsername ? agents.find(a => a && a.username === loginUsername) : null;
        const agentId = cleanText(bodyAgentId || (agentProfile && agentProfile.agentId) || loginUsername || '', 100);

        db.query("SELECT value FROM kv_blob WHERE \"key\"='mem_plans'", (pErr, pRows) => {
            if (pErr) return res.status(500).json({ error: 'DB error: ' + pErr.message });
            let plans = [];
            try { plans = pRows && pRows.length ? JSON.parse(pRows[0].value) : []; } catch (e) {}
            const plan = plans.find(p => p && p.id === planId);
            if (!plan) return res.status(404).json({ error: 'This membership plan is not configured by the Admin.' });
            razorpayRequest('/v1/orders', {
                amount: Math.round(Number(plan.price) * 100),
                currency: 'INR',
                receipt: 'custreg_' + mobile + '_' + Date.now()
            }).then((order) => {
                db.query(
                    `INSERT INTO customer_registration_orders
                        (orderId, name, mobile, email, address, note, agentId, planId, planName, amount,
                         district, state, pin_code, aadhaar_last4, aadhaar_hash, aadhaar_enc, pan_enc, pan_hash, pan_masked)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [order.id, cName, mobile, cEmail, cAddress, cNote, agentId, plan.id, plan.name || '', plan.price,
                        kyc.district || '', kyc.state || '', kyc.pin_code || '',
                        kyc.aadhaar_last4 || null, kyc.aadhaar_hash || null, kyc.aadhaar_enc || null,
                        kyc.pan_enc || null, kyc.pan_hash || null, kyc.pan_masked || null],
                    (err) => {
                        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                        res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, plan: plan });
                    }
                );
            }).catch((e) => res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message }));
        });
    });
});

app.post('/api/customer-registrations/verify', (req, res) => {
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
    }
    const expected = crypto.createHmac('sha256', secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');
    if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' });
    }
    db.query("SELECT * FROM customer_registration_orders WHERE orderId=? AND status='created'", [razorpay_order_id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'This order has already been processed or was not found.' });
        // 🔒 FIX: Postgres row keys lowercase hoti hain (agentid/planid/planname) —
        // pehle o.agentId / o.planId / o.planName hamesha undefined milte the, isliye
        // pending registration mein Agent ID aur Plan gayab ho jaate the.
        const o = camelizeRow(rows[0]);
        db.query("UPDATE customer_registration_orders SET status='paid' WHERE orderId=?", [razorpay_order_id], () => {
            db.query("SELECT value FROM kv_blob WHERE \"key\"='customer_pending_registrations'", async (cErr, cRows) => {
                if (cErr) return res.status(500).json({ error: 'DB error: ' + cErr.message });
                let pending = [];
                try { pending = cRows && cRows.length ? JSON.parse(cRows[0].value) : []; } catch (e) {}
                const regId = 'CREG' + Date.now();
                const last4 = o.aadhaar_last4 || '';
                const rec = {
                    id: regId, name: o.name, mobile: o.mobile, email: o.email || '',
                    address: o.address || '', note: o.note || '', agentId: o.agentId,
                    planId: o.planId, planName: o.planName, amount: o.amount,
                    // 🆕 KYC (sirf safe/masked fields — poora Aadhaar/PAN yahan kabhi nahi)
                    district: o.district || '', state: o.state || '', pinCode: o.pin_code || '',
                    aadhaarLast4: last4, aadhaarMasked: maskAadhaarLast4(last4), panMasked: o.pan_masked || '',
                    kycRef: regId,
                    paymentRef: razorpay_payment_id, status: 'pending',
                    submittedOn: new Date().toISOString()
                };
                // 🆕 Encrypted KYC vault mein entry (search + reveal isi se hote hain).
                // Best-effort: fail ho to bhi registration/payment record save hota hai.
                try {
                    const idx = await loadAgentsIndex();
                    const att = attribute(idx, [o.agentId]);
                    await kycSave({
                        entity_type: 'customer', entity_id: regId,
                        full_name: o.name, mobile: o.mobile, email: o.email || '', address: o.address || '',
                        district: o.district || '', state: o.state || '', pin_code: o.pin_code || '',
                        agent_id: o.agentId || '', agent_username: att.agentUsername || '',
                        aadhaar_last4: o.aadhaar_last4 || null, aadhaar_hash: o.aadhaar_hash || null, aadhaar_enc: o.aadhaar_enc || null,
                        pan_hash: o.pan_hash || null, pan_enc: o.pan_enc || null, pan_masked: o.pan_masked || null,
                        status: 'pending', source: 'customer_self_registration',
                        plan_id: o.planId || '', plan_name: o.planName || '', amount: Number(o.amount) || 0,
                        payment_ref: razorpay_payment_id, created_by: 'customer'
                    });
                } catch (kErr) {
                    console.error('❌ KYC vault save failed (the registration is still being saved):', kErr.message);
                }
                pending.push(rec);
                db.query(
                    "INSERT INTO kv_blob (\"key\", value) VALUES ('customer_pending_registrations', ?) ON CONFLICT (\"key\") DO UPDATE SET value = EXCLUDED.value",
                    [JSON.stringify(pending)],
                    (insErr) => {
                        if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                        res.status(201).json({ success: true, id: rec.id });
                    }
                );
            });
        });
    });
});



// ═══════════════════════════════════════════════════════════════════════
// 📋 APPLICATION TRACKING — Customer Registration status (public, rate-limited)
//   Applicant enters Application ID + Mobile Number. Once the Super Admin
//   approves, the generated User ID & Password are revealed on that screen
//   (limited window + limited views; the password is stored encrypted).
// ═══════════════════════════════════════════════════════════════════════
const TRACK_CRED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TRACK_CRED_MAX_VIEWS = 5;
async function readCustomerRegs() {
    const r = await dbq('SELECT value FROM kv_blob WHERE `key` = ?', ['customer_pending_registrations']);
    try { const l = JSON.parse(r[0] && r[0].value); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
async function writeCustomerRegs(list) {
    await dbq('INSERT INTO kv_blob ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['customer_pending_registrations', JSON.stringify(list)]);
}
const normMobile = (m) => String(m || '').replace(/\D/g, '').slice(-10);

async function trackStatusHandler(req, res) {
    try {
        if (hitRateLimit('track:' + (req.ip || ''), 30, 10 * 60 * 1000)) {
            return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        }
        const src = Object.assign({}, req.query || {}, req.body || {});
        const appId = cleanText(src.applicationId || src.id, 40).trim();
        const mobile = normMobile(src.mobile);
        if (!appId || mobile.length !== 10) {
            return res.status(400).json({ error: 'Please enter a valid Application ID and a 10-digit mobile number.' });
        }
        const list = await readCustomerRegs();
        const rec = list.find(r => r && String(r.id).toLowerCase() === appId.toLowerCase() && normMobile(r.mobile) === mobile);
        if (!rec) return res.status(404).json({ error: 'No application was found for the Application ID and mobile number provided.' });
        const out = {
            success: true, applicationId: rec.id, name: rec.name, planName: rec.planName || '',
            submittedOn: rec.submittedOn || '', status: rec.status || 'pending'
        };
        if (out.status === 'approved') {
            out.message = 'Your registration application has been approved.';
            out.approvedOn = rec.approvedOn || '';
            const c = rec.credentials;
            if (c && c.enc && Date.now() - (c.at || 0) <= TRACK_CRED_TTL_MS && (c.views || 0) < TRACK_CRED_MAX_VIEWS) {
                const pwd = piiDecrypt(c.enc);
                if (pwd !== null) {
                    out.credentials = { userId: c.userId, password: pwd };
                    c.views = (c.views || 0) + 1;
                    await writeCustomerRegs(list);
                }
            } else if (c) {
                out.credentialsExpired = true;
                out.message = 'Your registration application has been approved. Your credentials are no longer available online. Please contact your library.';
            }
        } else if (out.status === 'rejected') {
            out.message = 'Your registration application was not approved. Please contact your library for details.';
        } else {
            out.message = 'Your application is under review. Please check again later.';
        }
        res.json(out);
    } catch (e) {
        console.error('track-status error:', e.message);
        res.status(500).json({ error: 'Unable to retrieve the application status. Please try again.' });
    }
}
app.post('/api/track-status', trackStatusHandler);
app.get('/api/track-status', trackStatusHandler);

// Admin: list server-side customer applications (for the existing Pending Registrations screen)
app.get('/api/admin/customer-registrations', requireRole('admin'), async (req, res) => {
    try {
        const list = await readCustomerRegs();
        res.json(list.map(r => { const o = Object.assign({}, r); delete o.credentials; return o; }));
    } catch (e) { res.status(500).json({ error: 'Unable to load applications.' }); }
});

// Admin: record the approval / rejection decision (and the generated credentials)
app.post('/api/admin/customer-registrations/:id/decision', requireRole('admin'), async (req, res) => {
    try {
        const status = String((req.body || {}).status || '').toLowerCase();
        if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
        const list = await readCustomerRegs();
        const rec = list.find(r => r && r.id === req.params.id);
        if (!rec) return res.status(404).json({ error: 'Application not found.' });
        rec.status = status;
        if (status === 'approved') {
            rec.approvedOn = new Date().toISOString();
            const uid = cleanText((req.body || {}).userId, 60);
            const pwd = String((req.body || {}).password || '');
            if (uid && pwd) {
                if (!piiReady()) return res.status(500).json({ error: 'Credential encryption is not configured on the server.' });
                rec.credentials = { userId: uid, enc: piiEncrypt(pwd), at: Date.now(), views: 0 };
            }
        } else if (status === 'rejected') {
            rec.rejectedOn = new Date().toISOString();
            delete rec.credentials;
        }
        await writeCustomerRegs(list);
        res.json({ success: true, id: rec.id, status: rec.status });
    } catch (e) { res.status(500).json({ error: 'Unable to record the decision.' }); }
});

app.get('/api/students/next-id', (req, res) => {
    db.query("SELECT value FROM kv_admin_entities WHERE \"key\"='students'", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        let students = [];
        try { students = rows && rows.length ? JSON.parse(rows[0].value) : []; } catch (e) {}
        let maxNum = 0;
        (students || []).forEach(s => {
            const sid = (s && (s.studentId || s.id)) || '';
            const m = /SHL-(\d+)/i.exec(sid);
            if (m) { const n = parseInt(m[1], 10); if (n > maxNum) maxNum = n; }
        });
        res.json({ nextId: 'SHL-' + String(maxNum + 1).padStart(3, '0') });
    });
});
app.get('/api/settings', (req, res) => kvGet('kv_blob', 'settings', res));

// ══════════════════════════════════════════════════════════════════
// 📋 ATTENDANCE — date+batch pe keyed merge (do students ek saath
//   save karein to ek-doosre ka data overwrite na ho)
// ══════════════════════════════════════════════════════════════════
app.post('/api/attendance', (req, res) => {
    const { date, batch, records, selfies, markedBy, savedAt } = req.body || {};
    if (!date || !batch) return res.status(400).json({ error: 'date and batch are required.' });
    db.query('SELECT records, selfies FROM attendance_records WHERE date=? AND batch=?', [date, batch], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        let mergedRecords = records || {};
        let mergedSelfies = selfies || {};
        if (rows && rows.length) {
            try { mergedRecords = Object.assign(JSON.parse(rows[0].records || '{}'), records || {}); } catch (e) {}
            try { mergedSelfies = Object.assign(JSON.parse(rows[0].selfies || '{}'), selfies || {}); } catch (e) {}
        }
        insertWithIdHeal(
            `INSERT INTO attendance_records (date, batch, records, selfies, markedBy, savedAt)
             VALUES (?,?,?,?,?,?)
             ON CONFLICT (date, batch) DO UPDATE SET records=EXCLUDED.records, selfies=EXCLUDED.selfies, markedBy=EXCLUDED.markedBy, savedAt=EXCLUDED.savedAt`,
            [date, batch, JSON.stringify(mergedRecords), JSON.stringify(mergedSelfies), markedBy || '', savedAt || new Date().toISOString()],
            'attendance_records',
            (insErr) => {
                if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                res.json({ success: true });
            }
        );
    });
});

// ══════════════════════════════════════════════════════════════════
// 💳 PAYMENTS — student fee, Razorpay, agent-collect transactions
// ══════════════════════════════════════════════════════════════════
app.post('/api/payments/fee', (req, res) => {
    // 🔒 FIX: Student_Attendance.html ka SUBMIT_FEE_PAYMENT() 'method' aur
    // 'monthKey' bhejta tha (mode/note nahi) aur response mein poora
    // 'payment' object expect karta tha (receipt PDF banane ke liye —
    // date/time/studentName/method/monthKey). Backend sirf 'mode'/'note'
    // padhta tha aur sirf {id} return karta tha, isliye 'result.payment'
    // hamesha undefined aata tha aur fee receipt kabhi sahi se nahi banta
    // tha. Ab dono field-naam accept hote hain aur poora payment object
    // wapas jaata hai (DB schema badle bina).
    const { studentId, amount, mode, method, note, status, monthKey } = req.body || {};
    if (!studentId || !(amount > 0)) return res.status(400).json({ error: 'studentId and amount are required.' });
    const paymentMode = mode || method || 'cash';
    insertWithIdHeal(
        'INSERT INTO fee_payments (studentId, amount, mode, note, status) VALUES (?,?,?,?,?)',
        [studentId, amount, paymentMode, note || '', status || 'paid'],
        'fee_payments',
        (err, result) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            db.query("SELECT value FROM kv_admin_entities WHERE `key`='students'", (sErr, sRows) => {
                let studentInfo = {};
                try {
                    const students = sRows && sRows.length ? JSON.parse(sRows[0].value) : [];
                    const s = students.find(x => x && (x.id === studentId || x.studentId === studentId));
                    if (s) studentInfo = { studentName: s.name, studentClass: s.cls || s.addr || '', batch: s.batch || '' };
                } catch (e) {}
                const now = new Date();
                res.status(201).json({
                    id: result.insertId,
                    payment: Object.assign({
                        id: result.insertId,
                        studentId, amount, mode: paymentMode, method: paymentMode,
                        note: note || '', status: status || 'paid',
                        monthKey: monthKey || (now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')),
                        date: now.toLocaleDateString('en-IN'),
                        time: now.toLocaleTimeString('en-IN')
                    }, studentInfo)
                });
            });
        }
    );
});
app.get('/api/payments/fee', (req, res) => {
    const studentId = req.query.studentId;
    const sql = studentId ? 'SELECT * FROM fee_payments WHERE studentId=? ORDER BY created_at DESC' : 'SELECT * FROM fee_payments ORDER BY created_at DESC';
    db.query(sql, studentId ? [studentId] : [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});

// ══════════════════════════════════════════════════════════════════
// 💳 RAZORPAY — order create + payment verify
//   Keys kabhi bhi code mein nahi likhi jaatin — dono Render Dashboard ke
//   Environment Variables se aati hain:
//     PAYMENT_API_KEY    → Razorpay "Key ID"
//     PAYMENT_API_SECRET → Razorpay "Key Secret"
//   (Node ke built-in 'https'/'crypto' se hi kaam chal jaata hai, isliye
//   koi naya npm package install karne ki zaroorat nahi.)
// ══════════════════════════════════════════════════════════════════
const https = require('https');

function razorpayRequest(path, body) {
    return new Promise((resolve, reject) => {
        const key = process.env.PAYMENT_API_KEY;
        const secret = process.env.PAYMENT_API_SECRET;
        if (!key || !secret) return reject(new Error('PAYMENT_API_KEY / PAYMENT_API_SECRET are not set in the Render Environment.'));
        const payload = JSON.stringify(body);
        const options = {
            hostname: 'api.razorpay.com',
            path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': 'Basic ' + Buffer.from(key + ':' + secret).toString('base64')
            }
        };
        const reqStream = https.request(options, (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(parsed);
                    else reject(new Error(parsed.error ? parsed.error.description : 'Razorpay API error'));
                } catch (e) { reject(e); }
            });
        });
        reqStream.on('error', reject);
        reqStream.write(payload);
        reqStream.end();

    });
}

// ══════════════════════════════════════════════════════════════════
// 💸 RAZORPAYX PAYOUTS — Live automated bank-transfer integration
//   (Employee salary + Agent-share split, seedha bank account mein).
//   YEH RAZORPAY CHECKOUT/ORDERS SE ALAG HAI — RazorpayX ek current
//   account + payouts product hai, jiske liye Razorpay Dashboard se
//   ALAG API keys aur ek funded "source" account chahiye hota hai.
//   Render Environment mein set karein:
//     RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET, RAZORPAYX_ACCOUNT_NUMBER
//     RAZORPAYX_WEBHOOK_SECRET (webhook signature verify ke liye)
// ══════════════════════════════════════════════════════════════════
function razorpayXConfigured() {
    return !!(process.env.RAZORPAYX_KEY_ID && process.env.RAZORPAYX_KEY_SECRET && process.env.RAZORPAYX_ACCOUNT_NUMBER);
}
function razorpayXRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const key = process.env.RAZORPAYX_KEY_ID;
        const secret = process.env.RAZORPAYX_KEY_SECRET;
        if (!key || !secret) return reject(new Error('RAZORPAYX_KEY_ID / RAZORPAYX_KEY_SECRET are not set in the Render Environment.'));
        const payload = body ? JSON.stringify(body) : '';
        const options = {
            hostname: 'api.razorpay.com',
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(key + ':' + secret).toString('base64')
            }
        };
        if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
        const reqStream = https.request(options, (resp) => {
            let data = '';
            resp.on('data', (chunk) => { data += chunk; });
            resp.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(parsed);
                    else reject(new Error(parsed.error ? parsed.error.description : 'RazorpayX API error (status ' + resp.statusCode + ')'));
                } catch (e) { reject(e); }
            });
        });
        reqStream.on('error', reject);
        if (payload) reqStream.write(payload);
        reqStream.end();
    });
}

// Contact + Fund Account banao (ya jo pehle se ban chuke hain unhe reuse
// karo) — is record ko wapas 'hrms_employees'/'agents' mein save kar
// dete hain taaki dobara-dobara Razorpay par naya contact na banana pade.
async function ensureRazorpayFundAccount(existingFundAccountId, contactName, contactType, bankAccountName, accountNumber, ifsc) {
    if (existingFundAccountId) return existingFundAccountId; // already bana hua hai
    const contact = await razorpayXRequest('POST', '/v1/contacts', {
        name: contactName, type: contactType // 'employee' ya 'vendor' (agent ke liye)
    });
    const fundAccount = await razorpayXRequest('POST', '/v1/fund_accounts', {
        contact_id: contact.id,
        account_type: 'bank_account',
        bank_account: { name: bankAccountName || contactName, ifsc: ifsc, account_number: accountNumber }
    });
    return fundAccount.id;
}
// Ek payout banata hai — 'reference_id' se IDEMPOTENT hai: agar isi
// reference_id se pehle se ek payout ban chuka ho, Razorpay dobara
// naya payout NAHI banata (double-payment se bachne ke liye critical).
async function createRazorpayPayout(fundAccountId, amountRupees, referenceId, narration) {
    return razorpayXRequest('POST', '/v1/payouts', {
        account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER,
        fund_account_id: fundAccountId,
        amount: Math.round(Number(amountRupees) * 100), // paise mein
        currency: 'INR',
        mode: 'IMPS',
        purpose: 'payout',
        queue_if_low_balance: true,
        reference_id: referenceId,
        narration: narration || 'Payout'
    });
}

app.post('/api/payments/razorpay/order', async (req, res) => {
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) {
        return res.status(501).json({ error: 'Payment keys are not set in the Render Environment (PAYMENT_API_KEY / PAYMENT_API_SECRET).' });
    }
    const { amount, currency, receipt } = req.body || {};
    if (!(amount > 0)) return res.status(400).json({ error: 'Please provide a valid amount.' });
    try {
        const order = await razorpayRequest('/v1/orders', {
            amount: Math.round(amount * 100), // paise mein
            currency: currency || 'INR',
            receipt: receipt || ('rcpt_' + Date.now())
        });
        res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY });
    } catch (e) {
        res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message });
    }
});

app.post('/api/payments/razorpay/verify', (req, res) => {
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
    }
    const expected = crypto.createHmac('sha256', secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');
    if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' });
    }
    res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// 🧾 MATERIAL PORTAL — PAYMENT-GATED INVOICE GENERATION
//   "Generate Invoice" dabane se pehle Razorpay se payment mandatory hai
//   (jab tak Admin us specific material user ke liye ise exempt na kare).
//   Amount hamesha Admin ke 'material_invoice_settings' se aata hai —
//   client se kabhi trust nahi karte (security-critical: client agar
//   apna manchaha amount bhej de to fraud ho sakta tha).
// ══════════════════════════════════════════════════════════════════

// Material user apna config check karta hai — payment chahiye ya nahi,
// aur kitna. (Amount yahan sirf DISPLAY ke liye hai — asli charge order
// banate waqt server phir se DB se hi amount uthata hai.)
app.get('/api/material/invoice-payment/config', requireActiveMaterialUser, (req, res) => {
    if (!req.authUser || req.authUser.role !== 'material_user') {
        return res.status(401).json({ error: 'Material user login is required.' });
    }
    // 🔒 FIX + 🆕 PER-USER CUSTOM AMOUNT: quoted camelCase alias zaroori hai
    // (dekhein upar wali similar fix ki tippani) — warna invoicePaymentExempt
    // aur naya invoiceAmount dono hamesha undefined milte (Postgres unquoted
    // columns lowercase mein fold ho jaate hain).
    db.query('SELECT invoicePaymentExempt AS "invoicePaymentExempt", invoiceAmount AS "invoiceAmount" FROM material_users WHERE userid=?', [req.authUser.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const exempt = !!(rows && rows[0] && rows[0].invoicePaymentExempt);
        const userAmount = (rows && rows[0]) ? sanitizeInvoiceAmount(rows[0].invoiceAmount) : null;
        hrGetBlobObj('material_invoice_settings', (sErr, settings) => {
            const enabled = sErr ? true : (settings.enabled !== false); // default ON agar admin ne kabhi set na kiya ho
            const globalAmount = sErr ? 10 : (Number(settings.amount) || 10);
            // 🆕 PER-USER CUSTOM AMOUNT: is specific user ke liye Admin ne agar
            // koi individual amount set kiya hai, to Global Fixed Amount ki
            // jagah WAHI istemal hota hai — chahe ₹5 ho, ₹10, ₹20, ya ₹100.
            const amount = (userAmount !== null) ? userAmount : globalAmount;
            res.json({ paymentRequired: enabled && !exempt, amount, exempt, isCustomAmount: userAmount !== null });
        });
    });
});

// Order banao — amount hamesha server-side DB se (per-user custom amount ho
// to wahi, warna Admin ke Global Fixed Amount se) — client se bheja gaya
// koi bhi amount IGNORE hota hai.
app.post('/api/material/invoice-payment/order', requireActiveMaterialUser, async (req, res) => {
    if (!req.authUser || req.authUser.role !== 'material_user') {
        return res.status(401).json({ error: 'Material user login is required.' });
    }
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) {
        return res.status(501).json({ error: 'Payment keys are not set in the Render Environment.' });
    }
    db.query('SELECT invoicePaymentExempt AS "invoicePaymentExempt", invoiceAmount AS "invoiceAmount" FROM material_users WHERE userid=?', [req.authUser.userId], async (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const exempt = !!(rows && rows[0] && rows[0].invoicePaymentExempt);
        if (exempt) return res.status(400).json({ error: 'You are exempt from this check — there is no need to create a payment order.' });
        const userAmount = (rows && rows[0]) ? sanitizeInvoiceAmount(rows[0].invoiceAmount) : null;
        hrGetBlobObj('material_invoice_settings', async (sErr, settings) => {
            const enabled = sErr ? true : (settings.enabled !== false);
            const globalAmount = sErr ? 10 : (Number(settings.amount) || 10);
            if (!enabled) return res.status(400).json({ error: 'Invoice payment is currently disabled by the Admin.' });
            // 🆕 PER-USER CUSTOM AMOUNT: yahi single source-of-truth hai jo
            // Razorpay order mein jaata hai — isi user ke liye set kiya gaya
            // individual amount (agar hai) Global Amount se hamesha priority
            // leta hai. Client isse kabhi override nahi kar sakta.
            const amount = (userAmount !== null) ? userAmount : globalAmount;
            try {
                const order = await razorpayRequest('/v1/orders', {
                    amount: Math.round(amount * 100),
                    currency: 'INR',
                    receipt: 'inv_' + req.authUser.userId + '_' + Date.now()
                });
                res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY });
            } catch (e) {
                res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message });
            }
        });
    });
});

// Verify karo — signature sahi hone par ek short-lived "invoice unlock"
// token issue hota hai, jo frontend ko Generate Invoice chalane ke liye
// chahiye hota hai (single-purpose, 10 minute expiry, isi user se bound).
app.post('/api/material/invoice-payment/verify', requireActiveMaterialUser, (req, res) => {
    if (!req.authUser || req.authUser.role !== 'material_user') {
        return res.status(401).json({ error: 'Material user login is required.' });
    }
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
    }
    const expected = crypto.createHmac('sha256', secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');
    if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' });
    }
    const unlockToken = jwt.sign(
        { purpose: 'material_invoice_unlock', userId: req.authUser.userId, paymentId: razorpay_payment_id },
        JWT_SECRET, { expiresIn: '10m' }
    );
    res.json({ success: true, unlockToken });
});

// 🎓 STUDENT SUBSCRIPTION PAYMENT — Student_Attendance.html ka
//   "Ab Payment Karein" button ab seedha in dono routes se judta hai
//   (pehle yeh Admin Panel mein manually daale gaye ek alag Firebase
//   'razorpay_config.orderEndpoint' URL ko call karta tha, aur payment
//   verify + subscription-activate ek Firebase Cloud Function ke bharose
//   chhod diya gaya tha jiska is codebase mein kahin naamo-nishaan nahi
//   hai — isi wajah se payment ho jaane ke baad bhi student ka
//   subscription kabhi activate nahi hota tha aur paisa kahin record
//   bhi nahi hota tha).
//   Ab: order isi backend (PAYMENT_API_KEY/SECRET) se banta hai, plan/
//   days/amount yahin DB mein save hote hain (client dobara nahi bhej
//   sakta — tamper-proof), aur verify step signature check karne ke
//   baad seedha (1) student ka subscription_status/expiry activate
//   karta hai aur (2) fee_payments mein record daalta hai taaki Admin
//   ke Fee Payment History mein turant dikhe.
// ══════════════════════════════════════════════════════════════════
app.post('/api/payments/student-subscription/order', async (req, res) => {
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) {
        return res.status(501).json({ error: 'Payment keys are not set in the Render Environment (PAYMENT_API_KEY / PAYMENT_API_SECRET).' });
    }
    const { studentId, amount, planId, planName, days } = req.body || {};
    if (!studentId) return res.status(400).json({ error: 'studentId is required.' });
    if (!(amount > 0)) return res.status(400).json({ error: 'Please provide a valid amount.' });
    if (!(Number(days) > 0)) return res.status(400).json({ error: 'Plan days are required.' });
    try {
        const order = await razorpayRequest('/v1/orders', {
            amount: Math.round(amount * 100),
            currency: 'INR',
            receipt: 'sub_' + studentId + '_' + Date.now()
        });
        db.query(
            'INSERT INTO student_subscription_orders (orderId, studentId, planId, planName, days, amount) VALUES (?,?,?,?,?,?)',
            [order.id, studentId, planId || '', planName || '', days, amount],
            (err) => {
                if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY });
            }
        );
    } catch (e) {
        res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message });
    }
});

app.post('/api/payments/student-subscription/verify', (req, res) => {
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
    }
    const expected = crypto.createHmac('sha256', secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');
    if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' });
    }
    db.query("SELECT * FROM student_subscription_orders WHERE orderId=? AND status='created'", [razorpay_order_id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'This order has already been processed or was not found.' });
        // 🔒 FIX: PG row keys lowercase hoti hain — pehle o.studentId undefined tha, aur
        // `s.studentId === o.studentId` (undefined === undefined) PEHLE student ko match
        // kar deta tha (galat student ka subscription active) + fee_payments insert fail.
        const o = camelizeRow(rows[0]);
        db.query("UPDATE student_subscription_orders SET status='paid' WHERE orderId=?", [razorpay_order_id], () => {
            // ── Student ka subscription_status/expiry activate karo (kv_admin_entities.students) ──
            db.query("SELECT value FROM kv_admin_entities WHERE `key`='students'", (sErr, sRows) => {
                if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
                let students = [];
                try { students = sRows && sRows.length ? JSON.parse(sRows[0].value) : []; } catch (e) {}
                const idx = students.findIndex(s => s && (s.id === o.studentId || s.studentId === o.studentId));
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const curExp = (idx !== -1 && students[idx].subscription_expiry) ? new Date(students[idx].subscription_expiry) : null;
                const base = (curExp && curExp > today) ? curExp : today;
                const newExp = new Date(base); newExp.setDate(newExp.getDate() + Number(o.days));
                const newExpStr = newExp.toISOString().split('T')[0];
                if (idx !== -1) {
                    students[idx] = Object.assign({}, students[idx], { subscription_status: 'active', subscription_expiry: newExpStr });
                }
                const saveStudents = (cb) => {
                    if (idx === -1) return cb(); // student record admin-entities mein na mile to bhi payment record safe rahega
                    db.query("UPDATE kv_admin_entities SET value=? WHERE `key`='students'", [JSON.stringify(students)], (uErr) => cb(uErr));
                };
                saveStudents((studentsSaveErr) => {
                    if (studentsSaveErr) {
                        // 🔒 CRITICAL FIX: pehle yahan error discard ho jaati thi — student ka
                        // payment safal ho jaata, par subscription_status DB mein kabhi
                        // 'active' save hi nahi hota tha, phir bhi response {success:true}
                        // bhej deta tha. Ab is galti ko chhupaya nahi jaata — turant, saaf
                        // error return hoti hai taaki payment safal hone ke bawajood
                        // "subscription active nahi ho rahi" jaisi silent-fail kabhi na ho.
                        console.error('❌ CRITICAL: Payment completed (Ref: ' + razorpay_payment_id + ') but the student subscription_status could not be saved:', studentsSaveErr.message);
                        return res.status(500).json({ error: 'Payment was successful, but a database error occurred while activating the subscription: ' + studentsSaveErr.message + '. Please contact support; the payment record is safe (Ref: ' + razorpay_payment_id + ').' });
                    }
                    // ── fee_payments mein log karo — Admin Fee History mein turant dikhega ──
                    insertWithIdHeal(
                        'INSERT INTO fee_payments (studentId, amount, mode, note, status) VALUES (?,?,?,?,?)',
                        [o.studentId, o.amount, 'Razorpay', (o.planName || 'Subscription') + ' — Ref: ' + razorpay_payment_id, 'paid'],
                        'fee_payments',
                        (fErr) => {
                            if (fErr) return res.status(500).json({ error: 'DB error: ' + fErr.message });
                            res.json({ success: true, subscription_status: 'active', subscription_expiry: newExpStr });
                        }
                    );
                });
            });
        });
    });
});

// ══════════════════════════════════════════════════════════════════
// 🧑‍💼 AGENT SUBSCRIPTION PAYMENT — Agent App ke "Renew" button ko
//   ab bhi seedha isse jodna hai (dekhein PAY_AGENT_SUBSCRIPTION()).
//   Pehle yeh Razorpay checkout bina kisi order_id ke khulta tha, aur
//   payment 'successful' hote hi client seedha browser se Firebase
//   likh deta tha — koi server-side verification nahi thi. Iska matlab
//   koi bhi browser console se AGENT_APPLY_RENEWAL() ko fake refId ke
//   saath call karke, bina paisa diye, apni subscription "renew" dikha
//   sakta tha. Ab: order backend par plan ke SAHI price se banta hai
//   (client jo amount bheje uska koi matlab nahi — plan seedha DB se
//   padha jaata hai), payment signature server par verify hoti hai,
//   aur tabhi jaake agent ki subscription + uske sabhi students ka
//   subscription_status backend khud activate karta hai.
// ══════════════════════════════════════════════════════════════════
app.post('/api/payments/agent-subscription/order', async (req, res) => {
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) {
        return res.status(501).json({ error: 'Payment keys are not set in the Render Environment (PAYMENT_API_KEY / PAYMENT_API_SECRET).' });
    }
    const { username, planId } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username is required.' });
    if (!planId) return res.status(400).json({ error: 'planId is required.' });
    db.query("SELECT value FROM kv_blob WHERE `key`='agent_plans'", (pErr, pRows) => {
        if (pErr) return res.status(500).json({ error: 'DB error: ' + pErr.message });
        let plans = [];
        try { plans = pRows && pRows.length ? JSON.parse(pRows[0].value) : []; } catch (e) {}
        const plan = plans.find(p => p && p.id === planId);
        if (!plan) return res.status(404).json({ error: 'This plan is not configured by the Admin.' });
        razorpayRequest('/v1/orders', {
            amount: Math.round(Number(plan.price) * 100),
            currency: 'INR',
            receipt: 'agentsub_' + username + '_' + Date.now()
        }).then((order) => {
            db.query(
                'INSERT INTO agent_subscription_orders (orderId, username, planId, planName, days, amount) VALUES (?,?,?,?,?,?)',
                [order.id, username, plan.id, plan.name || '', plan.days, plan.price],
                (err) => {
                    if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, plan: plan });
                }
            );
        }).catch((e) => res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message }));
    });
});

app.post('/api/payments/agent-subscription/verify', (req, res) => {
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
    }
    const expected = crypto.createHmac('sha256', secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');
    if (expected !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' });
    }
    db.query("SELECT * FROM agent_subscription_orders WHERE orderId=? AND status='created'", [razorpay_order_id], (oErr, oRows) => {
        if (oErr) return res.status(500).json({ error: 'DB error: ' + oErr.message });
        if (!oRows || !oRows.length) return res.status(404).json({ error: 'This order has already been processed or was not found.' });
        const o = camelizeRow(oRows[0]); // 🔒 FIX: lowercase PG columns (planId/planName undefined the)
        db.query("UPDATE agent_subscription_orders SET status='paid' WHERE orderId=?", [razorpay_order_id], () => {
            db.query("SELECT value FROM kv_admin_entities WHERE `key`='agents'", (aErr, aRows) => {
                if (aErr) return res.status(500).json({ error: 'DB error: ' + aErr.message });
                let agents = [];
                try { agents = aRows && aRows.length ? JSON.parse(aRows[0].value) : []; } catch (e) {}
                const idx = agents.findIndex(a => a && a.username && a.username.toLowerCase() === (o.username || '').toLowerCase());
                if (idx === -1) return res.status(404).json({ error: 'Agent record not found.' });
                const agent = agents[idx];
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const curExp = agent.subExpiry ? new Date(agent.subExpiry) : null;
                const base = (curExp && curExp > today) ? curExp : today;
                const newExp = new Date(base); newExp.setDate(newExp.getDate() + Number(o.days));
                const newExpStr = newExp.toISOString().split('T')[0];
                const newStartStr = today.toISOString().split('T')[0];
                agents[idx] = Object.assign({}, agent, { planId: o.planId, subStart: newStartStr, subExpiry: newExpStr });
                db.query("UPDATE kv_admin_entities SET value=? WHERE `key`='agents'", [JSON.stringify(agents)], (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                    // ── Is agent ke sabhi students ka subscription bhi turant activate karo ──
                    db.query("SELECT value FROM kv_admin_entities WHERE `key`='students'", (sErr, sRows) => {
                        if (sErr) {
                            console.error('❌ Agent subscription renewed, but a database error occurred while reading the students list:', sErr.message);
                            return res.status(500).json({ error: 'The agent subscription was renewed, but a database error occurred while activating the students: ' + sErr.message + '. The agent subscription is safe. Please try again.' });
                        }
                        let students = [];
                        try { students = sRows && sRows.length ? JSON.parse(sRows[0].value) : []; } catch (e) {}
                        let activatedCount = 0;
                        students = students.map(s => {
                            if (s && s.agentId === agent.agentId) {
                                activatedCount++;
                                return Object.assign({}, s, { subscription_status: 'active', subscription_expiry: newExpStr });
                            }
                            return s;
                        });
                        const saveStudents = (cb) => {
                            if (!activatedCount) return cb();
                            db.query("UPDATE kv_admin_entities SET value=? WHERE `key`='students'", [JSON.stringify(students)], (uErr2) => cb(uErr2));
                        };
                        saveStudents((studentsSaveErr) => {
                            // 🔒 CRITICAL FIX: yeh error pehle discard ho jaati thi — agent ki
                            // apni subscription to save ho jaati thi, par uske students ka
                            // subscription silently activate nahi hota tha, phir bhi response
                            // 'studentsActivated' mein galat count bhej deta tha.
                            if (studentsSaveErr) {
                                console.error('❌ Agent subscription renewed, but a database error occurred while activating students:', studentsSaveErr.message);
                                return res.status(500).json({ error: 'The agent subscription was renewed, but a database error occurred while activating the students: ' + studentsSaveErr.message + '. The agent subscription is safe. Please try again.' });
                            }
                            // ── Payment history log karo (Admin Panel isi 'agent_payments' blob ko dekhta hai) ──
                            db.query("SELECT value FROM kv_blob WHERE `key`='agent_payments'", (payErr, payRows) => {
                                if (payErr) {
                                    console.error('❌ Agent subscription and students were activated, but the payment history could not be saved:', payErr.message);
                                    // Yeh sirf history/record-keeping hai — subscription khud pehle
                                    // hi safal ho chuki hai, isliye request fail nahi karte, par
                                    // clearly Render logs mein flag zaroor karte hain.
                                }
                                let payments = [];
                                try { payments = payRows && payRows.length ? JSON.parse(payRows[0].value) : []; } catch (e) {}
                                const paymentRecord = {
                                    id: 'pay' + Date.now(), agentId: agent.id, agentDbId: agent.agentId, agentName: agent.name,
                                    planId: o.planId, planName: o.planName, amount: o.amount, mode: 'Razorpay',
                                    note: 'Ref: ' + razorpay_payment_id,
                                    date: new Date().toLocaleString('hi-IN'), newExpiry: newExpStr
                                };
                                payments.push(paymentRecord);
                                db.query(
                                    "INSERT INTO kv_blob (\"key\", value) VALUES ('agent_payments', ?) ON CONFLICT (\"key\") DO UPDATE SET value = EXCLUDED.value",
                                    [JSON.stringify(payments)],
                                    (finalErr) => {
                                        if (finalErr) console.error('❌ agent_payments log could not be saved:', finalErr.message);
                                        res.json({
                                            success: true, planId: o.planId, planName: o.planName,
                                            subStart: newStartStr, subExpiry: newExpStr,
                                            studentsActivated: activatedCount, paymentRecord: paymentRecord, agent: agents[idx]
                                        });
                                    }
                                );
                            });
                        });
                    });
                });
            });
        });
    });
});

// ══════════════════════════════════════════════════════════════════
// 🔒 SUBSCRIPTION & ACCESS CONTROL SYSTEM
//   Ek hi jagah se poore system (Agent/HRMS/Student teeno portals) ke
//   liye subscription status calculate hota hai, taaki teeno jagah
//   EXACT same rules follow hon:
//     > 5 din baaki         → 'active'  (kuch nahi dikhta)
//     0 se 5 din baaki      → 'warning' (banner dikhta hai, kaam chalu rehta hai)
//     expiry ke baad, <=5 din → 'grace' (still kaam chalta hai, urgent warning)
//     expiry ke 5 din baad  → 'locked' (portal disable, dynamic message)
//   🛡️ FAIL-OPEN BY DESIGN: agar agent record hi na mile, ya usme
//   subExpiry set hi na ho (jaise purane/legacy agents jinke liye yeh
//   feature kabhi setup nahi hua), to kabhi lock NAHI karte — 'active'
//   maan lete hain. Isse koi bhi agent achanak, bina wajah, lock nahi ho
//   jaata jab yeh feature pehli baar deploy ho.
// ══════════════════════════════════════════════════════════════════
function computeAgentSubStatus(agent) {
    if (!agent || !agent.subExpiry) return { status: 'active', daysLeft: null };
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const exp = new Date(agent.subExpiry);
    if (isNaN(exp.getTime())) return { status: 'active', daysLeft: null };
    const daysLeft = Math.ceil((exp - today) / 86400000);
    if (daysLeft > 5) return { status: 'active', daysLeft };
    if (daysLeft >= 0) return { status: 'warning', daysLeft };
    if (daysLeft >= -5) return { status: 'grace', daysLeft };
    return { status: 'locked', daysLeft };
}

function findAgentByIdOrUsername(idOrUsername, cb) {
    db.query("SELECT value FROM kv_admin_entities WHERE \"key\"='agents'", (err, rows) => {
        if (err) return cb(err);
        let agents = [];
        try { agents = rows && rows[0] ? JSON.parse(rows[0].value) : []; } catch (e) {}
        const needle = String(idOrUsername || '').toLowerCase();
        const agent = agents.find(a => a && (
            (a.agentId && String(a.agentId).toLowerCase() === needle) ||
            (a.username && String(a.username).toLowerCase() === needle)
        ));
        cb(null, agent || null, agents);
    });
}

// GET /api/subscription-status/AGT001  ya  /api/subscription-status/agentusername
// Agent App, HRMS Portal, aur Student Portal — teeno isi ek route se apna
// (ya apne linked agent ka) status check karte hain, taaki rules kabhi
// alag-alag jagah mismatch na hon.
// ══════════════════════════════════════════════════════════════════
// 🔔 GLOBAL NOTIFICATION SYSTEM — Admin → Agent → HRMS/Student
//   Backend mein persist hoti hain, isliye refresh/naya login par bhi
//   dikhti hain (pehle jo bell icons the woh sirf usi browser tak
//   simit the — koi doosre device/session ko kabhi nahi dikhta tha).
// ══════════════════════════════════════════════════════════════════

// Bhejna — Admin (agentId ya 'all_agents') / Agent (studentId ya
// 'all_students' apne under ke, empId ya 'all_employees' apne under ke)
app.post('/api/notifications', (req, res) => {
    const { fromRole, fromName, targetScope, targetId, scopeAgentId, title, message, urgency } = req.body || {};
    const validScopes = ['agent', 'all_agents', 'student', 'all_students', 'employee', 'all_employees'];
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (!validScopes.includes(targetScope)) return res.status(400).json({ error: 'Invalid targetScope.' });
    db.query(
        'INSERT INTO notifications (from_role, from_name, target_scope, target_id, scope_agent_id, title, message, urgency) VALUES (?,?,?,?,?,?,?,?)',
        [fromRole || '', fromName || '', targetScope, targetId || null, scopeAgentId || null, title, message || '', urgency || 'info'],
        (err, result) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            res.status(201).json({ success: true, id: result.insertId });
        }
    );
});

// Padhna — viewer apni identity/scope batata hai, backend match karke
// relevant notifications deta hai (naye pehle).
//   Agent dekhega:    ?role=agent&id=AGT001
//   Student dekhega:  ?role=student&id=SHL-001&agentId=AGT001
//   Employee dekhega: ?role=employee&id=EMP001&agentId=AGT001
//   Admin dekhega:    ?role=admin  (koi bhejta nahi Admin ko, sirf apni bheji hui dekh sakta hai — abhi ke liye khaali)
app.get('/api/notifications', (req, res) => {
    const { role, id, agentId } = req.query || {};
    let where = '1=0';
    const params = [];
    if (role === 'agent' && id) {
        where = "(target_scope='agent' AND target_id=?) OR target_scope='all_agents'";
        params.push(id);
    } else if (role === 'student' && id) {
        where = "(target_scope='student' AND target_id=?) OR (target_scope='all_students' AND scope_agent_id=?)";
        params.push(id, agentId || '');
    } else if (role === 'employee' && id) {
        where = "(target_scope='employee' AND target_id=?) OR (target_scope='all_employees' AND scope_agent_id=?)";
        params.push(id, agentId || '');
    } else {
        return res.json([]);
    }
    db.query(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT 50`, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const myId = id || '';
        const result = (rows || []).map(r => {
            let readBy = [];
            try { readBy = JSON.parse(r.read_by || '[]'); } catch (e) {}
            return {
                id: r.id, fromRole: r.from_role, fromName: r.from_name,
                title: r.title, message: r.message, urgency: r.urgency,
                createdAt: r.created_at, isRead: readBy.includes(myId)
            };
        });
        res.json(result);
    });
});

// Padh liya mark karna — viewer apni id bhejta hai, backend read_by
// array mein add kar deta hai (agar pehle se nahi hai).
app.post('/api/notifications/:id/read', (req, res) => {
    const { viewerId } = req.body || {};
    if (!viewerId) return res.status(400).json({ error: 'viewerId is required.' });
    db.query('SELECT read_by FROM notifications WHERE id=?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'Notification not found.' });
        let readBy = [];
        try { readBy = JSON.parse(rows[0].read_by || '[]'); } catch (e) {}
        if (!readBy.includes(viewerId)) readBy.push(viewerId);
        db.query('UPDATE notifications SET read_by=? WHERE id=?', [JSON.stringify(readBy), req.params.id], (uErr) => {
            if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
            res.json({ success: true });
        });
    });
});


app.get('/api/subscription-status/:identifier', (req, res) => {
    findAgentByIdOrUsername(req.params.identifier, (err, agent) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!agent) return res.json({ status: 'active', daysLeft: null, company: '', mobile: '', name: '' }); // fail-open
        const info = computeAgentSubStatus(agent);
        res.json({
            status: info.status,
            daysLeft: info.daysLeft,
            company: agent.company || agent.name || '',
            mobile: agent.mobile || '',
            name: agent.name || ''
        });
    });
});

// 🆕 GRACE PERIOD (Admin Override) — Admin Panel ka "Extend Validity"
// button isi route ko call karta hai. Payment ke bina bhi subExpiry ko
// aage badha deta hai (5-10 din request par) — kisi bhi data ko chhuta
// nahi, sirf yeh ek date field update hoti hai.
app.post('/api/admin/extend-agent-validity', requireRole('admin'), (req, res) => {
    const { agentId, days } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'agentId is required to specify which agent validity should be extended.' });
    const extendDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 30); // 1-30 din ke beech, safety cap
    findAgentByIdOrUsername(agentId, (err, agent, agents) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!agent) return res.status(404).json({ error: 'Agent not found.' });
        const idx = agents.findIndex(a => a === agent);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const curExp = agent.subExpiry ? new Date(agent.subExpiry) : null;
        const base = (curExp && !isNaN(curExp.getTime()) && curExp > today) ? curExp : today;
        const newExp = new Date(base); newExp.setDate(newExp.getDate() + extendDays);
        const newExpStr = newExp.toISOString().split('T')[0];
        agents[idx] = Object.assign({}, agent, {
            subExpiry: newExpStr,
            lastExtendedBy: 'admin',
            lastExtendedOn: today.toISOString().split('T')[0],
            lastExtendedDays: extendDays
        });
        db.query("UPDATE kv_admin_entities SET value=? WHERE \"key\"='agents'", [JSON.stringify(agents)], (uErr) => {
            if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
            res.json({ success: true, subExpiry: newExpStr, extendedDays: extendDays });
        });
    });
});

// ══════════════════════════════════════════════════════════════════
// 📱 SMS — OTP/notification bhejne ke liye. Key kabhi code mein nahi —
//   Render Environment se aati hai: SMS_API_KEY (+ optional SMS_SENDER_ID).
//   Neeche wala provider URL ek generic placeholder hai (Fast2SMS jaisa
//   pattern) — apne asli SMS provider (Fast2SMS/MSG91/Twilio/etc) ke
//   hisaab se path/params thoda badalna pad sakta hai.
// ══════════════════════════════════════════════════════════════════
function sendSms(mobile, message) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.SMS_API_KEY;
        if (!apiKey) return reject(new Error('SMS_API_KEY is not set in the Render Environment.'));
        const params = new URLSearchParams({
            authorization: apiKey,
            route: 'q',
            message,
            numbers: mobile,
            sender_id: process.env.SMS_SENDER_ID || 'LIBRBK'
        });
        https.get('https://www.fast2sms.com/dev/bulkV2?' + params.toString(), (resp) => {
            let data = '';
            resp.on('data', (c) => { data += c; });
            resp.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

app.post('/api/sms/send', async (req, res) => {
    const { mobile, message } = req.body || {};
    if (!mobile || !message) return res.status(400).json({ error: 'mobile and message are required.' });
    if (!process.env.SMS_API_KEY) return res.status(501).json({ error: 'SMS_API_KEY is not set in the Render Environment.' });
    try {
        await sendSms(mobile, message);
        res.json({ success: true });
    } catch (e) {
        res.status(502).json({ error: 'Error while sending SMS: ' + e.message });
    }
});

// Agent student-collect transaction (create → pending; HRMS verify/reject)
app.post('/api/payments/student-transaction', (req, res) => {
    const { agentId, amount } = req.body || {};
    if (!agentId || !(amount > 0)) return res.status(400).json({ error: 'agentId and a positive amount are required' });
    const txnId = 'TXN' + Date.now();
    db.query(
        'INSERT INTO transactions (id, agentId, studentId, amount, status, data) VALUES (?,?,?,?,?,?)',
        [txnId, agentId, req.body.studentId || null, amount, 'pending', JSON.stringify(req.body)],
        (err) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            res.status(201).json({ txnId });
        }
    );
});
app.post('/api/payments/transactions/:id/verify', (req, res) => {
    const id = req.params.id;
    db.query("SELECT * FROM transactions WHERE id=? AND status='pending'", [id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'Pending transaction not found.' });
        const t = rows[0];
        db.query("UPDATE transactions SET status='verified' WHERE id=?", [id], () => {
            db.query(
                `INSERT INTO agent_wallets (agentId, approved_balance, total_earned) VALUES (?,?,?)
                 ON CONFLICT (agentId) DO UPDATE SET approved_balance = agent_wallets.approved_balance + EXCLUDED.approved_balance,
                                          total_earned = agent_wallets.total_earned + EXCLUDED.total_earned`,
                [t.agentId, t.amount, t.amount],
                (wErr) => {
                    if (wErr) return res.status(500).json({ error: 'DB error: ' + wErr.message });
                    res.json({ success: true, txnId: id });
                }
            );
        });
    });
});
app.post('/api/payments/transactions/:id/reject', (req, res) => {
    db.query("UPDATE transactions SET status='rejected', reason=? WHERE id=?", [(req.body || {}).reason || '', req.params.id], (err) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json({ success: true });
    });
});

// ══════════════════════════════════════════════════════════════════
// 🧾 HRMS SALARY — slips (admin-generated) + claims (staff self-submit,
//   agent/admin verify → wallet se deduct karke payslip)
// ══════════════════════════════════════════════════════════════════
app.get('/api/hrms-salary/slips', (req, res) => {
    db.query('SELECT * FROM hrms_salary_slips ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json((rows || []).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { return { id: r.id }; } }));
    });
});
// ══════════════════════════════════════════════════════════════════
// 💳 SUBSCRIPTION RENEWAL — Agent_login.html ka AGENT_APPLY_RENEWAL()
//   pehle 3 alag-alag Firebase calls karta tha (agent update, students
//   bulk-activate, payment history log). Ab yeh sab EK hi backend call
//   mein ho jaata hai — 'agents'/'students' (kv_admin_entities) aur
//   'agent_payments' (kv_blob) ko seedhe DB mein update karke.
// ══════════════════════════════════════════════════════════════════
app.post('/api/payment/update', (req, res) => {
    const { username, planId, planName, days, price, mode, refId } = req.body || {};
    if (!username || !(Number(days) > 0)) return res.status(400).json({ error: 'username and days are required.' });

    db.query("SELECT value FROM kv_admin_entities WHERE `key`='agents'", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        let agents = [];
        try { agents = rows && rows.length ? JSON.parse(rows[0].value) : []; } catch (e) {}
        const idx = agents.findIndex(a => a && a.username && String(a.username).toLowerCase() === String(username).toLowerCase());
        if (idx === -1) return res.status(404).json({ error: 'Agent record not found. Please contact the administrator.' });

        const a = agents[idx];
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const curExp = a.subExpiry ? new Date(a.subExpiry) : null;
        const base = (curExp && curExp > today) ? curExp : today;
        const newExp = new Date(base); newExp.setDate(newExp.getDate() + Number(days));
        const newExpStr = newExp.toISOString().split('T')[0];
        const newStartStr = today.toISOString().split('T')[0];
        agents[idx] = Object.assign({}, a, { planId, subStart: newStartStr, subExpiry: newExpStr });
        const agentsJson = JSON.stringify(agents);

        db.query("UPDATE kv_admin_entities SET value=? WHERE `key`='agents'", [agentsJson], (uErr) => {
            if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });

            // ── Is agent ke saare students ka subscription bhi turant activate karo ──
            db.query("SELECT value FROM kv_admin_entities WHERE `key`='students'", (sErr, sRows) => {
                if (sErr) {
                    console.error('❌ Agent subscription renewed, but a database error occurred while reading the students list:', sErr.message);
                    return res.status(500).json({ error: 'The agent subscription was renewed, but a database error occurred while activating the students: ' + sErr.message + '. The agent subscription is safe. Please try again.' });
                }
                let students = [];
                try { students = sRows && sRows.length ? JSON.parse(sRows[0].value) : []; } catch (e) {}
                let activatedCount = 0;
                if (a.agentId && Array.isArray(students)) {
                    students = students.map(s => {
                        if (s && s.agentId === a.agentId) {
                            activatedCount++;
                            return Object.assign({}, s, { subscription_status: 'active', subscription_expiry: newExpStr });
                        }
                        return s;
                    });
                }
                const saveStudents = (cb) => {
                    if (!activatedCount) return cb();
                    db.query("UPDATE kv_admin_entities SET value=? WHERE `key`='students'", [JSON.stringify(students)], (uErr2) => cb(uErr2));
                };

                // 🔒 CRITICAL FIX: yeh error pehle discard ho jaati thi — agent ki apni
                // subscription to save ho jaati thi, par uske students ka subscription
                // silently activate nahi hota tha, phir bhi response mein galat
                // 'studentsActivated' count bhej diya jaata tha.
                saveStudents((studentsSaveErr) => {
                    if (studentsSaveErr) {
                        console.error('❌ Agent subscription renewed, but a database error occurred while activating students:', studentsSaveErr.message);
                        return res.status(500).json({ error: 'The agent subscription was renewed, but a database error occurred while activating the students: ' + studentsSaveErr.message + '. The agent subscription is safe. Please try again.' });
                    }
                    // ── Payment history log karo ──
                    db.query("SELECT value FROM kv_blob WHERE `key`='agent_payments'", (pErr, pRows) => {
                        if (pErr) console.error('❌ Agent subscription and students were activated, but the payment history could not be saved:', pErr.message);
                        let payments = [];
                        try { payments = pRows && pRows.length ? JSON.parse(pRows[0].value) : []; } catch (e) {}
                        const paymentRecord = {
                            id: 'pay' + Date.now(), agentId: a.id, agentDbId: a.agentId, agentName: a.name,
                            planId, planName, amount: price, mode: mode || '', note: refId ? ('Ref: ' + refId) : '',
                            date: new Date().toLocaleString('hi-IN'), newExpiry: newExpStr
                        };
                        payments.push(paymentRecord);
                        const paymentsJson = JSON.stringify(payments);
                        db.query(
                            "INSERT INTO kv_blob (\"key\", value) VALUES ('agent_payments', ?) ON CONFLICT (\"key\") DO UPDATE SET value = EXCLUDED.value",
                            [paymentsJson],
                            (finalErr) => {
                                if (finalErr) console.error('❌ agent_payments log could not be saved:', finalErr.message);
                                res.json({ subStart: newStartStr, subExpiry: newExpStr, agent: agents[idx], paymentRecord, studentsActivated: activatedCount });
                            }
                        );
                    });
                });
            });
        });
    });
});

// ══════════════════════════════════════════════════════════════════
// 🧾 STAFF SALARY SYNC — HRMS ke liye 'staff' data. Yeh route wahi
//   'admin-entities/staff' hi hai (naya endpoint nahi banaya), taaki
//   Admin Panel se add/edit kiya gaya staff seedhe HRMS salary-calc mein
//   bhi reflect ho. Alag naam se alias diya gaya hai taaki frontend code
//   mein intent saaf rahe ('/salary/sync' padhne mein samajh aata hai).
// ══════════════════════════════════════════════════════════════════
app.get('/api/salary/sync', (req, res) => kvGet('kv_admin_entities', 'staff', res, null, req));

app.get('/api/hrms-salary/claims', (req, res) => {
    db.query('SELECT * FROM hrms_salary_claims ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json((rows || []).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id, status: r.status }); } catch (e) { return { id: r.id, status: r.status }; } }));
    });
});
app.post('/api/hrms-salary/claims', (req, res) => {
    const claim = req.body || {};
    const id = claim.id || ('CLM' + Date.now());
    const month = Number(claim.month), year = Number(claim.year);
    if (!claim.empId || !(month >= 0 && month <= 11) || !year) {
        return res.status(400).json({ error: 'empId, month and year are required.' });
    }
    // 🔒 DUPLICATE PAYMENT & MONTH LOCK (guard #1 — claim submit time)
    findSalaryMonthClash(claim.empId, month, year, (cErr, clash) => {
        if (cErr) return res.status(500).json({ error: 'DB error: ' + cErr.message });
        if (clash) {
            return res.status(409).json({
                error: clash.alreadyPaid
                    ? `Payment for ${clash.label} is already paid and completed.`
                    : `A salary claim for ${clash.label} is already in process — please do not submit it again.`
            });
        }
        db.query(
            'INSERT INTO hrms_salary_claims (id, empId, status, netAmount, data) VALUES (?,?,?,?,?)',
            [id, claim.empId || null, 'pending', claim.net || 0, JSON.stringify(claim)],
            (err) => {
                if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                res.status(201).json({ id });
            }
        );
    });
});
// Staff claim → Agent verifies (deduct agent wallet)
app.post('/api/wallet/salary-claims/:id/verify', requireRole('agent', 'admin'), (req, res) => {
    const auth = req.authUser;
    const agentId = auth.username;
    db.query("SELECT * FROM hrms_salary_claims WHERE id=? AND status='pending'", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'Pending claim not found.' });
        const c = rows[0];
        db.query('SELECT approved_balance FROM agent_wallets WHERE agentId=?', [agentId], (wErr, wRows) => {
            if (wErr) return res.status(500).json({ error: 'DB error: ' + wErr.message });
            const balance = wRows && wRows.length ? Number(wRows[0].approved_balance) : 0;
            if (balance < Number(c.netAmount)) return res.status(400).json({ error: 'Insufficient balance in your wallet.' });
            const transferDueBy = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
            db.query('UPDATE agent_wallets SET approved_balance = approved_balance - ? WHERE agentId=?', [c.netAmount, agentId], () => {
                db.query("UPDATE hrms_salary_claims SET status='pending_admin', agentId=? WHERE id=?", [agentId, c.id], (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                    res.json({ walletDeductedAmount: c.netAmount, transferDueBy });
                });
            });
        });
    });
});
// Admin final approve → generates payslip
app.post('/api/hrms-salary/claims/:id/approve', requireRole('admin'), (req, res) => {
    db.query("SELECT * FROM hrms_salary_claims WHERE id=? AND (status='pending' OR status='pending_admin')", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(400).json({ error: 'This claim is not pending (already processed).' });
        const c = rows[0];
        let claimData = {};
        try { claimData = JSON.parse(c.data) || {}; } catch (e) {}
        // 🔒 DUPLICATE PAYMENT & MONTH LOCK (guard #2 — approve time,
        // defense-in-depth agar race condition se do claims bana chuke ho)
        findSalaryMonthClash(c.empId, claimData.month, claimData.year, (cErr, clash) => {
            if (cErr) return res.status(500).json({ error: 'DB error: ' + cErr.message });
            if (clash && clash.alreadyPaid) {
                return res.status(409).json({ error: `Payment for ${clash.label} is already paid and completed.` });
            }
            db.query("UPDATE hrms_salary_claims SET status='approved' WHERE id=?", [c.id], () => {
                const slipId = 'SLP' + Date.now();
                db.query('INSERT INTO hrms_salary_slips (id, empId, data) VALUES (?,?,?)', [slipId, c.empId, c.data], (sErr) => {
                    if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
                    res.json({ netAmount: c.netAmount, slipId });
                });
            });
        });
    });
});
app.post('/api/hrms-salary/claims/:id/reject', requireRole('admin'), (req, res) => {
    db.query("UPDATE hrms_salary_claims SET status='rejected' WHERE id=? AND status IN ('pending','pending_admin')", [req.params.id], (err, result) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!result.affectedRows) return res.status(400).json({ error: 'This claim is not pending (already processed).' });
        res.json({ success: true });
    });
});

// ══════════════════════════════════════════════════════════════════
// 👛 AGENT WALLET — balance, withdrawals, direct-collect payments
//   NOTE: identity JWT token ke 'username' se aati hai (Agent login ke
//   /auth/login bridge se). Production mein isse asli agentId se map
//   karna behtar hoga agar dono alag ho sakte hain.
// ══════════════════════════════════════════════════════════════════
function requireAgentId(req, res) {
    const auth = getAuthUser(req);
    const agentId = auth ? auth.username : null;
    if (!agentId) { res.status(401).json({ error: 'Login session not found — please log in again.' }); return null; }
    return agentId;
}

app.get('/api/wallet/me', (req, res) => {
    const agentId = requireAgentId(req, res); if (!agentId) return;
    db.query('SELECT * FROM agent_wallets WHERE agentId=?', [agentId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows && rows.length ? rows[0] : { approved_balance: 0, pending_balance: 0, total_earned: 0 });
    });
});
app.get('/api/wallet/my-salary-payments', (req, res) => {
    const agentId = requireAgentId(req, res); if (!agentId) return;
    db.query("SELECT * FROM hrms_salary_claims WHERE agentId=? AND status IN ('pending_admin','approved') ORDER BY created_at DESC", [agentId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json((rows || []).map(r => { try { return Object.assign(JSON.parse(r.data), { amount: r.netAmount }); } catch (e) { return { amount: r.netAmount }; } }));
    });
});
app.get('/api/wallet/withdrawals/mine', (req, res) => {
    const agentId = requireAgentId(req, res); if (!agentId) return;
    db.query('SELECT * FROM wallet_withdrawals WHERE agentId=? ORDER BY created_at DESC', [agentId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});
app.get('/api/wallet/my-direct-payments', (req, res) => {
    const agentId = requireAgentId(req, res); if (!agentId) return;
    db.query('SELECT * FROM wallet_direct_payments WHERE agentId=? ORDER BY created_at DESC', [agentId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});
app.post('/api/wallet/withdraw', (req, res) => {
    const agentId = requireAgentId(req, res); if (!agentId) return;
    const { amount, accName, bankName, accNo, ifsc, agentName } = req.body || {};
    if (!(amount > 0)) return res.status(400).json({ error: 'Please enter a valid amount.' });
    db.query('SELECT approved_balance FROM agent_wallets WHERE agentId=?', [agentId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const balance = rows && rows.length ? Number(rows[0].approved_balance) : 0;
        if (balance < amount) return res.status(400).json({ error: 'The amount exceeds your withdrawable balance — please enter a lower amount.' });
        db.query('UPDATE agent_wallets SET approved_balance = approved_balance - ?, pending_balance = pending_balance + ? WHERE agentId=?', [amount, amount, agentId], (uErr) => {
            if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
            insertWithIdHeal(
                'INSERT INTO wallet_withdrawals (agentId, agentName, amount, accName, bankName, accNo, ifsc, status) VALUES (?,?,?,?,?,?,?,\'pending\')',
                [agentId, agentName || '', amount, accName, bankName, accNo, ifsc],
                'wallet_withdrawals',
                (insErr) => {
                    if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
                    res.status(201).json({ success: true });
                }
            );
        });
    });
});
// Admin: list all withdrawals + approve/reject
app.get('/api/wallet/withdrawals', requireRole('admin'), (req, res) => {
    db.query('SELECT * FROM wallet_withdrawals ORDER BY created_at DESC', (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json(rows || []);
    });
});
app.post('/api/wallet/withdrawal/:id/process', requireRole('admin'), (req, res) => {
    const { action, reason } = req.body || {};
    db.query("SELECT * FROM wallet_withdrawals WHERE id=? AND status='pending'", [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'Pending withdrawal not found.' });
        const w = rows[0];
        if (action === 'approve') {
            db.query("UPDATE wallet_withdrawals SET status='paid' WHERE id=?", [w.id], () => {
                db.query('UPDATE agent_wallets SET pending_balance = pending_balance - ? WHERE agentId=?', [w.amount, w.agentId], (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                    res.json({ success: true });
                });
            });
        } else {
            // reject → refund back to approved_balance
            db.query("UPDATE wallet_withdrawals SET status='rejected', reason=? WHERE id=?", [reason || '', w.id], () => {
                db.query('UPDATE agent_wallets SET pending_balance = pending_balance - ?, approved_balance = approved_balance + ? WHERE agentId=?', [w.amount, w.amount, w.agentId], (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                    res.json({ success: true });
                });
            });
        }
    });
});
// Admin: student→agent direct-collect payments summary (today/month)
app.get('/api/wallet/agent-direct-payments', requireRole('admin'), (req, res) => {
    db.query(
        `SELECT
            SUM(CASE WHEN created_at::date = CURRENT_DATE THEN amount ELSE 0 END) AS today_total,
            SUM(CASE WHEN created_at::date = CURRENT_DATE THEN 1 ELSE 0 END) AS today_count,
            SUM(CASE WHEN EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) THEN amount ELSE 0 END) AS month_total,
            SUM(CASE WHEN EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM CURRENT_DATE) THEN 1 ELSE 0 END) AS month_count
         FROM wallet_direct_payments`,
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            const r = (rows && rows[0]) || {};
            res.json({
                today: { total: Number(r.today_total) || 0, count: Number(r.today_count) || 0 },
                month: { total: Number(r.month_total) || 0, count: Number(r.month_count) || 0 }
            });
        }
    );
});

// ══════════════════════════════════════════════════════════════════
// 💳 ADMIN: AGENT WALLET TOP-UP — Admin Panel ke "Agent Wallet Top-up"
//   page se call hote hain. Manually kisi agent ke approved_balance
//   mein amount jodne ke liye (jaise cash/offline payment counter par
//   mila ho). Dono routes sirf Admin JWT se accessible hain.
// ══════════════════════════════════════════════════════════════════
app.get('/api/admin/agent-wallet/:agentId', requireRole('admin'), (req, res) => {
    db.query('SELECT * FROM agent_wallets WHERE agentId=?', [req.params.agentId], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        const w = (rows && rows[0]) || { approved_balance: 0, pending_balance: 0, total_earned: 0 };
        res.json({
            agentId: req.params.agentId,
            approvedBalance: Number(w.approved_balance) || 0,
            pendingBalance: Number(w.pending_balance) || 0,
            totalEarned: Number(w.total_earned) || 0
        });
    });
});

app.post('/api/admin/wallet/topup', requireRole('admin'), (req, res) => {
    const { agentId, amount, note } = req.body || {};
    const amt = Number(amount);
    if (!agentId || !amt || amt <= 0) {
        return res.status(400).json({ error: 'Agent ID and an amount greater than 0 are required.' });
    }
    db.query(
        `INSERT INTO agent_wallets (agentId, approved_balance, total_earned) VALUES (?, ?, 0)
         ON CONFLICT (agentId) DO UPDATE SET approved_balance = agent_wallets.approved_balance + EXCLUDED.approved_balance`,
        [agentId, amt],
        (err) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            db.query('SELECT approved_balance FROM agent_wallets WHERE agentId=?', [agentId], (err2, rows) => {
                if (err2) return res.status(500).json({ error: 'DB error: ' + err2.message });
                const newBalance = rows && rows[0] ? Number(rows[0].approved_balance) : amt;
                res.json({ success: true, agentId, toppedUp: amt, note: note || '', newBalance });
            });
        }
    );
});

// ══════════════════════════════════════════════════════════════════
// 🧾 MATERIAL BILLS/INVOICES (Anmol_material_entry_secure.html)
// ══════════════════════════════════════════════════════════════════
app.post('/api/material/bills', requireActiveMaterialUser, (req, res) => {
    const body = req.body || {};
    // 🔒 SECURITY FIX: pehle ownerUserId client ke request body se seedha
    // trust ho jaata tha — koi bhi logged-in material user, body mein
    // KISI AUR ka userId bhej kar unke naam par bill save kar sakta tha.
    // Ab yeh hamesha verified JWT identity (req.authUser.userId) se
    // aata hai, client jo bhi body mein bheje uska koi asar nahi. (Admin
    // ke liye — jiska apna koi material userId nahi hota — client-supplied
    // ownerUserId hi allow karte hain, kyunki Admin doosre users ki taraf
    // se save kar sakta hai.)
    const isAdmin = String(req.authUser.role || '').toLowerCase() === 'admin';
    const ownerUserId = isAdmin ? body.ownerUserId : req.authUser.userId;
    if (!ownerUserId) return res.status(400).json({ error: 'ownerUserId is required.' });
    body.ownerUserId = ownerUserId;
    // 🆕 FIX: pehle yahan har save par HAMESHA naya row INSERT hota tha —
    // chahe wahi Bill No dobara save kiya jaaye. Frontend isi behavior ki
    // ummeed karta hai ki ownerUserId + billNo match hone par UPDATE ho,
    // naya duplicate row na bane. Ab pehle check karte hain ki isi user ka
    // isi Bill No wala record pehle se hai kya — agar hai to UPDATE, nahi to
    // naya INSERT.
    const billNo = body.billNo || null;
    const findExisting = (cb) => {
        if (!billNo) return cb(null); // Bill No khaali hai — hamesha naya bill
        db.query(
            "SELECT id FROM material_bills WHERE owneruserid=? AND (data::json->>'billNo')=? LIMIT 1",
            [ownerUserId, billNo],
            (err, rows) => cb(err ? null : (rows && rows[0] ? rows[0].id : null))
        );
    };
    findExisting((existingId) => {
        if (existingId) {
            db.query('UPDATE material_bills SET data=? WHERE id=?', [JSON.stringify(body), existingId], (uErr) => {
                if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                res.status(200).json({ id: existingId, updated: true });
            });
        } else {
            db.query('INSERT INTO material_bills (owneruserid, data) VALUES (?,?)', [ownerUserId, JSON.stringify(body)], (err, result) => {
                if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                res.status(201).json({ id: result.insertId, updated: false });
            });
        }
    });
});
app.get('/api/material/bills', (req, res) => {
    const ownerUserId = req.query.ownerUserId;
    // 🆕 MULTI-USER INVOICE + ADMIN VIEW: jab ownerUserId diya gaya ho, wahi
    // (self-service) behavior pehle jaisa hai — material user apne khud ke
    // bills dekh sakta hai. Lekin jab ownerUserId NAHI diya jaata (matlab
    // "sabhi users ke sabhi invoices" wali request — Admin Panel ka naya
    // 'All Invoices' page), tab yeh sirf logged-in Admin session (JWT
    // role='admin') ko hi allow karta hai, taaki koi bhi random request
    // saare users ka invoice data na khींच sake.
    if (!ownerUserId) {
        const auth = getAuthUser(req);
        if (!auth || String(auth.role).toLowerCase() !== 'admin') {
            return res.status(401).json({ error: 'Invoices of all users can be viewed only with an Admin login.' });
        }
    }
    const sql = ownerUserId ? 'SELECT * FROM material_bills WHERE owneruserid=? ORDER BY savedAt DESC' : 'SELECT * FROM material_bills ORDER BY savedAt DESC';
    db.query(sql, ownerUserId ? [ownerUserId] : [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json((rows || []).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id, savedAt: r.savedAt }); } catch (e) { return { id: r.id, savedAt: r.savedAt }; } }));
    });
});
app.put('/api/material/bills/:id', requireActiveMaterialUser, (req, res) => {
    db.query('SELECT owneruserid, data FROM material_bills WHERE id=?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'Bill not found.' });
        // 🔒 SECURITY FIX: pehle client body ke ownerUserId par bharosa
        // hota tha (jo khud client hi bhejta hai — spoof karna trivial
        // tha), aur us par bhi "rows[0].ownerUserId" (camelCase) hamesha
        // undefined milne ki wajah se yeh check kabhi trigger hi nahi
        // hota tha. Ab verified JWT identity (req.authUser.userId) se
        // asli malik match hota hai.
        const requestOwnerId = req.authUser.userId; // undefined for admin — check skip ho jaata hai neeche
        const isAdmin = String(req.authUser.role || '').toLowerCase() === 'admin';
        if (!isAdmin && rows[0].owneruserid && requestOwnerId !== rows[0].owneruserid) {
            return res.status(403).json({ error: 'This bill does not belong to you — it cannot be edited.' });
        }
        let merged = {};
        try { merged = JSON.parse(rows[0].data); } catch (e) {}
        Object.assign(merged, req.body || {});
        db.query('UPDATE material_bills SET data=? WHERE id=?', [JSON.stringify(merged), req.params.id], (uErr) => {
            if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
            res.json({ success: true });
        });
    });
});
app.delete('/api/material/bills/:id', requireActiveMaterialUser, (req, res) => {
    // 🔒 SECURITY FIX: pehle yahan koi ownership check hi nahi tha — koi
    // bhi logged-in material user, kisi bhi ID ka bill (kisi doosre user
    // ka bhi) seedha delete kar sakta tha. Ab verified JWT identity se
    // check karte hain ki bill isi user ka hai (Admin ke liye check
    // skip ho jaata hai — Admin kisi ka bhi bill delete kar sakta hai).
    const isAdmin = String(req.authUser.role || '').toLowerCase() === 'admin';
    db.query('SELECT owneruserid FROM material_bills WHERE id=?', [req.params.id], (selErr, rows) => {
        if (selErr) return res.status(500).json({ error: 'DB error: ' + selErr.message });
        if (!rows || !rows.length) return res.status(404).json({ error: 'Bill not found.' });
        if (!isAdmin && rows[0].owneruserid && req.authUser.userId !== rows[0].owneruserid) {
            return res.status(403).json({ error: 'This bill does not belong to you — it cannot be deleted.' });
        }
        db.query('DELETE FROM material_bills WHERE id=?', [req.params.id], (err) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            res.json({ success: true });
        });
    });
});

// ══════════════════════════════════════════════════════════════════
// 🪪 KYC VAULT + AADHAAR SEARCH  (Role-Based Access Control server-side)
//
//   Pehle dono panels ka Aadhaar search poori tarah browser mein hota tha
//   (saara data download karke JS se filter) — isliye "agent sirf apna data
//   dekhe" sirf screen par tha, network par nahi. Ab search backend par hota
//   hai aur scope JWT token se decide hota hai (client ki baat par nahi):
//
//   SEARCH  (POST body mein — Aadhaar URL/Render logs mein nahi jaata)
//     POST /api/agent/aadhaar-search   {q}   role=agent → SIRF apne Agent ID ke records
//     POST /api/admin/aadhaar-search   {q, history?}  role=admin → GLOBAL + agent attribution + poori history
//     POST /api/aadhaar/search         {q}   admin ya agent — token ke role se scope khud lagta hai
//        q = poora 12-digit Aadhaar  YA  sirf last-4 (redacted) digits
//
//   KYC RECORDS (encrypted vault — Aadhaar/PAN/district/state/pin)
//     PUT    /api/kyc/:entityType/:entityId          admin | agent(apna scope)  — create/update
//     GET    /api/kyc/:entityType/:entityId          masked view
//     GET    /api/kyc/:entityType/:entityId/reveal   poora Aadhaar/PAN (audit-logged, rate-limited)
//     GET    /api/kyc?type=&status=&q=&limit=&offset=  list (agent → sirf apna scope)
//     DELETE /api/kyc/:entityType/:entityId          admin only
//     PATCH  /api/admin/kyc/:id                      admin — status / agent / entity re-link
//     GET    /api/admin/pii-audit?limit=             admin — kisne kab search/reveal kiya
//     entityType ∈ student | staff | employee | customer | agent
// ══════════════════════════════════════════════════════════════════
const KYC_UPSERT_COLS = ['entity_type', 'entity_id', 'full_name', 'mobile', 'email', 'address', 'district', 'state', 'pin_code',
    'agent_id', 'agent_username', 'aadhaar_last4', 'aadhaar_hash', 'aadhaar_enc', 'pan_hash', 'pan_enc', 'pan_masked',
    'status', 'source', 'plan_id', 'plan_name', 'amount', 'payment_ref', 'created_by'];

async function kycFind(type, id) {
    const rows = await dbq('SELECT * FROM kyc_records WHERE entity_type = ? AND entity_id = ?', [type, id]);
    return rows[0] || null;
}
// row = poori column-set (existing + patch merged). Insert ya update (ON CONFLICT) — id return.
async function kycSave(row) {
    const updateCols = KYC_UPSERT_COLS.filter(function (c) { return c !== 'entity_type' && c !== 'entity_id' && c !== 'created_by'; });
    const sql = 'INSERT INTO kyc_records (' + KYC_UPSERT_COLS.join(', ') + ') VALUES (' + KYC_UPSERT_COLS.map(function () { return '?'; }).join(', ') + ') ' +
        'ON CONFLICT (entity_type, entity_id) DO UPDATE SET ' + updateCols.map(function (c) { return c + ' = EXCLUDED.' + c; }).join(', ') +
        ', updated_at = CURRENT_TIMESTAMP RETURNING id';
    const rows = await dbq(sql, KYC_UPSERT_COLS.map(function (c) { return row[c] === undefined ? null : row[c]; }));
    return rows[0] && rows[0].id;
}
function kycScopeWhere(scope) {
    const parts = ['agent_username = ?'];
    const params = [scope.username];
    if (scope.agentId) { parts.push('LOWER(agent_id) = ?'); params.push(String(scope.agentId).toLowerCase()); }
    return { sql: '(' + parts.join(' OR ') + ')', params: params };
}
function rowInAgentScope(row, scope) {
    if (!row || !scope) return false;
    if (row.agent_username && String(row.agent_username).toLowerCase() === scope.username) return true;
    return !!(scope.agentId && row.agent_id && String(row.agent_id).toLowerCase() === String(scope.agentId).toLowerCase());
}

// ── Agent attribution ──
async function loadAgentsIndex() {
    const idx = new Map();
    let rows = [];
    try { rows = await dbq('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['agents']); } catch (e) { return idx; }
    let list = [];
    try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
    (Array.isArray(list) ? list : []).forEach(function (a) {
        if (!a) return;
        const info = { agentId: a.agentId ? String(a.agentId) : '', username: String(a.username || '').toLowerCase(), name: a.name || '', company: a.company || '' };
        if (info.agentId) idx.set(info.agentId.toLowerCase(), info);
        if (info.username) idx.set(info.username, info);
    });
    return idx;
}
function attribute(idx, candidates) {
    for (let i = 0; i < candidates.length; i++) {
        const s = String(candidates[i] || '').trim().toLowerCase();
        if (s && idx.has(s)) {
            const a = idx.get(s);
            return { agentId: a.agentId, agentUsername: a.username, agentName: a.name, agentCompany: a.company };
        }
    }
    const first = candidates.map(function (v) { return String(v || '').trim(); }).filter(Boolean)[0] || '';
    return { agentId: first, agentUsername: '', agentName: '', agentCompany: '' };
}
function describeRegisteredBy(src, att) {
    const who = att.agentId || att.agentUsername;
    if (src === 'customer_self_registration') return 'Customer Self-Registration' + (who ? ' • Agent ' + who : '');
    if (src === 'admin_panel') return 'Admin / Direct';
    return who ? 'Agent ' + who : 'Admin / Direct';
}
function kycRowToApi(r, idx) {
    const att = attribute(idx, [r.agent_id, r.agent_username]);
    return {
        id: 'kyc:' + r.id, kycId: r.id, source: 'kyc_records', origin: r.source || '',
        kind: r.entity_type, type: KYC_TYPE_LABEL[r.entity_type] || r.entity_type,
        entityId: r.entity_id, name: r.full_name || '', mobile: r.mobile || '', email: r.email || '', address: r.address || '',
        district: r.district || '', state: r.state || '', pinCode: r.pin_code || '',
        aadhaarLast4: r.aadhaar_last4 || '', aadhaarMasked: maskAadhaarLast4(r.aadhaar_last4), hasFullAadhaar: !!r.aadhaar_enc,
        panMasked: r.pan_masked || '', hasPan: !!r.pan_enc,
        status: r.status || '',
        agentId: att.agentId || r.agent_id || '', agentUsername: att.agentUsername || r.agent_username || '',
        agentName: att.agentName, agentCompany: att.agentCompany,
        registeredBy: describeRegisteredBy(r.source, att),
        planId: r.plan_id || '', planName: r.plan_name || '', amount: r.amount == null ? null : Number(r.amount), paymentRef: r.payment_ref || '',
        createdAt: r.created_at, updatedAt: r.updated_at
    };
}

// ── Purane (JSON blob) records ke liye — unme Aadhaar plain field mein ho sakta hai ──
const AADHAAR_KEYS = ['aadhar', 'aadhaar', 'aadharNumber', 'aadhaarNumber', 'aadharNo', 'aadhaarNo'];
const LEGACY_SOURCES = [
    { table: 'kv_admin_entities', key: 'students', kind: 'student', label: 'Student' },
    { table: 'kv_admin_entities', key: 'staff', kind: 'staff', label: 'Staff' },
    { table: 'kv_admin_entities', key: 'agents', kind: 'agent', label: 'Agent', adminOnly: true },
    { table: 'kv_blob', key: 'hrms_employees', kind: 'employee', label: 'Staff / HRMS' },
    { table: 'kv_blob', key: 'hrms_registrations', kind: 'employee', label: 'Staff / HRMS' },
    { table: 'kv_blob', key: 'hrms_pending_registrations', kind: 'employee', label: 'Staff / HRMS' },
    { table: 'kv_blob', key: 'pending_staff', kind: 'staff', label: 'Staff' },
    { table: 'kv_blob', key: 'customer_pending_registrations', kind: 'customer', label: 'Customer Registration' }
];
function extractAadhaarDigits(rec) {
    for (let i = 0; i < AADHAAR_KEYS.length; i++) {
        const v = rec[AADHAAR_KEYS[i]];
        if (v == null) continue;
        const d = String(v).replace(/\D/g, '');
        if (d) return d;
    }
    return '';
}
function extractLast4(rec) {
    const full = extractAadhaarDigits(rec);
    if (full.length >= 4) return full.slice(-4);
    const r = String(firstDefined(rec.aadhaarLast4, rec.aadhaarRedacted, '')).replace(/\D/g, '');
    return r.length === 4 ? r : '';
}
// Response mein original record ka SAFE copy: PII, password aur bade base64 (photo) nikaal kar.
function safeRecord(rec) {
    const out = {};
    Object.keys(rec).forEach(function (k) {
        if (isPiiKey(k) || /^(password|pass|password_hash)$/i.test(k)) return;
        const v = rec[k];
        if (typeof v === 'string' && (v.length > 2000 || v.indexOf('data:') === 0)) return;
        if (v && typeof v === 'object') { try { if (JSON.stringify(v).length > 2000) return; } catch (e) { return; } }
        out[k] = v;
    });
    return out;
}
function legacyRecToApi(rec, src, idx) {
    const entityId = String(firstDefined(rec.id, rec.studentId, rec.empId, rec.empid, rec.username, rec.orderId, '')).trim();
    const att = attribute(idx, [rec.agentId, rec.ownerUser, rec.agentUsername, rec.registeredAgentId, rec.scopeAgentId]);
    const last4 = extractLast4(rec);
    const pan = firstDefined(rec.pan, rec.panNumber, rec.panNo, rec.panCard);
    const registeredBy = src.kind === 'customer' ? describeRegisteredBy('customer_self_registration', att)
        : (att.agentId || att.agentUsername) ? 'Agent ' + (att.agentId || att.agentUsername)
        : (src.label.indexOf('HRMS') >= 0 ? 'HRMS Portal' : 'Admin / Direct');
    return {
        id: src.kind + ':' + entityId, kycId: null, source: src.table + '/' + src.key, origin: 'legacy_record',
        kind: src.kind, type: src.label, entityId: entityId,
        name: rec.name || rec.fullName || '', mobile: rec.mobile || rec.phone || '', email: rec.email || '',
        address: rec.address || rec.addr || '', district: rec.district || rec.dist || '', state: rec.state || '', pinCode: rec.pinCode || rec.pin || '',
        aadhaarLast4: last4, aadhaarMasked: maskAadhaarLast4(last4), hasFullAadhaar: extractAadhaarDigits(rec).length === 12,
        panMasked: pan ? maskPan(String(pan).toUpperCase()) : (rec.panMasked || ''), hasPan: !!pan,
        status: rec.status || '',
        agentId: att.agentId, agentUsername: att.agentUsername, agentName: att.agentName, agentCompany: att.agentCompany,
        registeredBy: registeredBy,
        planId: rec.planId || '', planName: rec.planName || '', amount: rec.amount == null ? null : Number(rec.amount), paymentRef: rec.paymentRef || '',
        createdAt: rec.created || rec.submittedOn || rec.joinedOn || rec.created_at || null, updatedAt: null,
        data: safeRecord(rec)
    };
}

// ── Admin ke liye poori history (fee, subscription, transactions, attendance, salary) ──
async function attendanceSummary(keys) {
    const rows = await safeQ('SELECT value FROM kv_blob WHERE `key` = ?', ['att_records']);
    let data = null;
    try { data = JSON.parse(rows[0] && rows[0].value); } catch (e) { data = null; }
    const t = { present: 0, absent: 0, late: 0, other: 0, total: 0, lastDate: null };
    function tallyMap(date, map) {
        if (!map || typeof map !== 'object') return;
        Object.keys(map).forEach(function (k) {
            if (!keys.has(String(k).trim().toLowerCase())) return;
            const raw = map[k];
            const st = String(raw && typeof raw === 'object' ? (raw.status || '') : raw).toLowerCase();
            t.total++;
            if (st.indexOf('present') === 0 || st === 'p') t.present++;
            else if (st.indexOf('absent') === 0 || st === 'a') t.absent++;
            else if (st.indexOf('late') === 0) t.late++;
            else t.other++;
            if (date && (!t.lastDate || String(date) > t.lastDate)) t.lastDate = String(date);
        });
    }
    if (Array.isArray(data)) data.forEach(function (r) { if (r) tallyMap(r.date, r.records); });
    else if (data && typeof data === 'object') Object.keys(data).forEach(function (d) { tallyMap(d, data[d]); });
    return t;
}
async function buildHistory(hit) {
    const h = { feePayments: [], subscriptionOrders: [], transactions: [], registrationOrders: [], salarySlips: [], attendance: null };
    const id = String(hit.entityId || '');
    const mob = String(hit.mobile || '').replace(/\D/g, '').slice(-10);
    const num = function (v) { return v === null || v === undefined || v === '' ? null : Number(v); };
    if (id && hit.kind === 'student') {
        (await safeQ('SELECT id, amount, mode, note, status, created_at FROM fee_payments WHERE studentid = ? ORDER BY created_at DESC LIMIT 50', [id]))
            .forEach(function (r) { h.feePayments.push({ id: r.id, amount: num(r.amount), mode: r.mode, note: r.note, status: r.status, date: r.created_at }); });
        (await safeQ('SELECT orderid, planname, days, amount, status, created_at FROM student_subscription_orders WHERE studentid = ? ORDER BY created_at DESC LIMIT 50', [id]))
            .forEach(function (r) { h.subscriptionOrders.push({ orderId: r.orderid, plan: r.planname, days: r.days, amount: num(r.amount), status: r.status, date: r.created_at }); });
        (await safeQ('SELECT id, agentid, amount, status, reason, created_at FROM transactions WHERE studentid = ? ORDER BY created_at DESC LIMIT 50', [id]))
            .forEach(function (r) { h.transactions.push({ id: r.id, agentId: r.agentid, amount: num(r.amount), status: r.status, reason: r.reason, date: r.created_at }); });
        const keys = new Set([id.toLowerCase()]);
        if (hit.name) keys.add(String(hit.name).trim().toLowerCase());
        try { h.attendance = await attendanceSummary(keys); } catch (e) { h.attendance = null; }
    }
    if (mob.length === 10) {
        (await safeQ('SELECT orderid, planname, amount, status, agentid, created_at FROM customer_registration_orders WHERE mobile = ? ORDER BY created_at DESC LIMIT 20', [mob]))
            .forEach(function (r) { h.registrationOrders.push({ orderId: r.orderid, plan: r.planname, amount: num(r.amount), status: r.status, agentId: r.agentid, date: r.created_at }); });
    }
    if (id && (hit.kind === 'staff' || hit.kind === 'employee')) {
        (await safeQ('SELECT id, data, created_at FROM hrms_salary_slips WHERE empid = ? ORDER BY created_at DESC LIMIT 24', [id]))
            .forEach(function (r) {
                let d = {}; try { d = JSON.parse(r.data) || {}; } catch (e) {}
                h.salarySlips.push({ id: r.id, month: d.month, year: d.year, net: num(d.net), status: d.status || '', date: r.created_at });
            });
    }
    return h;
}

// ── SEARCH (admin = global, agent = apna scope) ──
async function runAadhaarSearch(req, res) {
    const auth = req.authUser;
    const role = String(auth.role || '').toLowerCase();
    const isAdmin = role === 'admin';
    if (hitRateLimit('aadhaar-search:' + role + ':' + String(auth.username || '').toLowerCase(), 40, 60 * 1000)) {
        return res.status(429).json({ error: 'Too many searches — please try again after 1 minute.' });
    }
    const body = req.body || {};
    const digits = String(firstDefined(body.q, body.aadhaar, body.query, '')).replace(/\D/g, '');
    let mode;
    if (digits.length === 12) mode = 'full';
    else if (digits.length === 4) mode = 'last4';
    else return res.status(400).json({ error: 'Please enter the full 12-digit Aadhaar number or only the last 4 digits.' });
    if (mode === 'full') {
        const v = validateAadhaar12(digits);
        if (!v.ok) return res.status(400).json({ error: v.error });
    }

    // Scope token se decide hota hai — kabhi request body se nahi.
    let scope = null;
    if (!isAdmin) {
        scope = await resolveAgentScopeP(auth);
        if (!scope || !scope.username) return res.status(403).json({ error: 'Agent identity could not be verified — please log in again.' });
    }
    const idx = await loadAgentsIndex();
    const results = [];
    const seen = new Set();
    const LIMIT = 50;

    // 1) Encrypted KYC vault
    if (mode === 'last4' || piiReady()) {
        const where = [];
        const params = [];
        if (mode === 'full') { where.push('aadhaar_hash = ?'); params.push(piiIndex('AADHAAR', digits)); }
        else { where.push('aadhaar_last4 = ?'); params.push(digits); }
        if (!isAdmin) { const sc = kycScopeWhere(scope); where.push(sc.sql); params.push.apply(params, sc.params); }
        const rows = await dbq('SELECT * FROM kyc_records WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT ' + LIMIT, params);
        rows.forEach(function (r) {
            const o = kycRowToApi(r, idx);
            o.matchType = mode;
            results.push(o);
            seen.add(r.entity_type + ':' + String(r.entity_id).toLowerCase());
        });
    }

    // 2) Purane JSON records (students / staff / hrms / pending ...)
    const legacy = LEGACY_SOURCES.filter(function (s) { return isAdmin || !s.adminOnly; });
    const tables = ['kv_admin_entities', 'kv_blob'];
    for (let t = 0; t < tables.length; t++) {
        const srcs = legacy.filter(function (s) { return s.table === tables[t]; });
        if (!srcs.length) continue;
        const rows = await dbq('SELECT `key`, value FROM ' + tables[t] + ' WHERE `key` IN (' + srcs.map(function () { return '?'; }).join(',') + ')', srcs.map(function (s) { return s.key; }));
        rows.forEach(function (row) {
            const src = srcs.find(function (s) { return s.key === row.key; });
            if (!src) return;
            let arr = [];
            try { arr = JSON.parse(row.value) || []; } catch (e) { return; }
            if (!Array.isArray(arr)) return;
            arr.forEach(function (rec) {
                if (!rec || typeof rec !== 'object' || results.length >= LIMIT) return;
                const full = extractAadhaarDigits(rec);
                const hitMatch = mode === 'full' ? (full.length === 12 && full === digits) : extractLast4(rec) === digits;
                if (!hitMatch) return;
                if (!isAdmin && !belongsToAgent(rec, scope)) return; // 🔒 RBAC: doosre agent ka record kabhi nahi
                const o = legacyRecToApi(rec, src, idx);
                const dk = o.kind + ':' + o.entityId.toLowerCase();
                if (o.entityId && seen.has(dk)) return;
                seen.add(dk);
                o.matchType = mode;
                results.push(o);
            });
        });
    }

    // 3) Admin ko poori history
    if (isAdmin && body.history !== false && results.length && results.length <= 10) {
        for (let i = 0; i < results.length; i++) {
            try { results[i].history = await buildHistory(results[i]); } catch (e) { results[i].history = null; }
        }
    }

    auditPii(req, 'aadhaar_search', 'XXXX' + digits.slice(-4), 'mode=' + mode + ' results=' + results.length + ' scope=' + (isAdmin ? 'global' : scope.username));
    res.json({
        success: true, mode: mode,
        queryMasked: mode === 'full' ? 'XXXX XXXX ' + digits.slice(-4) : 'XXXX XXXX ' + digits,
        scope: isAdmin ? { role: 'admin', global: true } : { role: 'agent', agentId: scope.agentId, username: scope.username },
        count: results.length, results: results
    });
}
app.post('/api/aadhaar/search', noStore, requireRole('admin', 'agent'), asyncRoute(runAadhaarSearch));
app.post('/api/admin/aadhaar-search', noStore, requireRole('admin'), asyncRoute(runAadhaarSearch));
app.post('/api/agent/aadhaar-search', noStore, requireRole('agent'), asyncRoute(runAadhaarSearch));

// ── KYC vault: create / update ──
async function loadScopeFor(auth) {
    const isAdmin = String(auth.role || '').toLowerCase() === 'admin';
    if (isAdmin) return { isAdmin: true, scope: null };
    const scope = await resolveAgentScopeP(auth);
    return { isAdmin: false, scope: scope && scope.username ? scope : null };
}
function parseKycTarget(req, res) {
    const type = String(req.params.entityType || '').toLowerCase();
    const id = cleanText(req.params.entityId, 100);
    if (KYC_ENTITY_TYPES.indexOf(type) === -1) { res.status(400).json({ error: 'Invalid entityType. Allowed: ' + KYC_ENTITY_TYPES.join(', ') }); return null; }
    if (!id) { res.status(400).json({ error: 'entityId is required.' }); return null; }
    return { type: type, id: id };
}

app.put('/api/kyc/:entityType/:entityId', noStore, requireRole('admin', 'agent'), asyncRoute(async (req, res) => {
    const target = parseKycTarget(req, res); if (!target) return;
    const auth = req.authUser;
    const ctx = await loadScopeFor(auth);
    if (!ctx.isAdmin && !ctx.scope) return res.status(403).json({ error: 'Agent identity could not be verified — please log in again.' });
    if (!ctx.isAdmin && KYC_AGENT_WRITABLE_TYPES.indexOf(target.type) === -1) return res.status(403).json({ error: 'Only the Admin can modify this type of KYC.' });

    const body = req.body || {};
    const parsed = parseKycInput(body, {});
    if (parsed.error) return res.status(parsed.status || 400).json({ error: parsed.error });
    const patch = Object.assign({}, parsed.fields);

    const existing = await kycFind(target.type, target.id);
    if (existing && !ctx.isAdmin && !rowInAgentScope(existing, ctx.scope)) {
        return res.status(403).json({ error: 'This record does not belong to your Agent ID — access denied.' });
    }
    // Sirf last-4 aaya aur pehle se poora number encrypted hai → last-4 badalne na dein (inconsistency).
    if (existing && existing.aadhaar_enc && patch.aadhaar_last4 && !patch.aadhaar_enc) delete patch.aadhaar_last4;

    if (body.name !== undefined || body.fullName !== undefined) patch.full_name = cleanText(firstDefined(body.name, body.fullName), 255);
    if (body.mobile !== undefined) { const m = String(body.mobile || '').replace(/\D/g, ''); patch.mobile = m.length > 10 ? m.slice(-10) : m; }
    if (body.email !== undefined) patch.email = cleanText(body.email, 255);
    if (body.address !== undefined) patch.address = cleanText(body.address, 500);
    if (body.status !== undefined) patch.status = cleanText(body.status, 30);

    if (!ctx.isAdmin) {
        patch.agent_username = ctx.scope.username;                               // 🔒 agent hamesha apne hi naam par
        patch.agent_id = ctx.scope.agentId || (existing && existing.agent_id) || null;
    } else {
        if (body.agentId !== undefined) patch.agent_id = cleanText(body.agentId, 100);
        if (body.agentUsername !== undefined) patch.agent_username = cleanText(body.agentUsername, 100).toLowerCase();
    }

    if (!existing && !patch.full_name) return res.status(400).json({ error: 'Name is required to create a new KYC record.' });
    const merged = Object.assign({}, existing || {}, patch, { entity_type: target.type, entity_id: target.id });
    if (!existing) {
        merged.source = ctx.isAdmin ? 'admin_panel' : 'agent_portal';
        merged.created_by = String(auth.username || '');
        if (!merged.status) merged.status = 'active';
    }
    if (patch.aadhaar_hash && !(existing && existing.aadhaar_hash === patch.aadhaar_hash)) {
        let dig = ''; try { dig = piiDecrypt(patch.aadhaar_enc); } catch (e) { dig = ''; }
        if (/^\d{12}$/.test(dig)) {
            const hit = await findIdentityOwner(dig, [target.id], '', await loadAgentsIndex());
            if (hit) return res.status(409).json({ success: false, code: 'IDENTITY_DUPLICATE', error: dupMessage(hit.label) });
        }
    }
    const id = await kycSave(merged);
    auditPii(req, existing ? 'kyc_update' : 'kyc_create', target.type + ':' + target.id, 'fields=' + Object.keys(patch).filter(function (k) { return !/_(hash|enc)$/.test(k); }).join(','));
    const idx = await loadAgentsIndex();
    const saved = await kycFind(target.type, target.id);
    res.status(existing ? 200 : 201).json({ success: true, id: id, kyc: saved ? kycRowToApi(saved, idx) : null });
}));

app.get('/api/kyc/:entityType/:entityId', noStore, requireRole('admin', 'agent'), asyncRoute(async (req, res) => {
    const target = parseKycTarget(req, res); if (!target) return;
    const ctx = await loadScopeFor(req.authUser);
    if (!ctx.isAdmin && !ctx.scope) return res.status(403).json({ error: 'Agent identity could not be verified — please log in again.' });
    const row = await kycFind(target.type, target.id);
    if (!row) return res.status(404).json({ error: 'KYC record not found.' });
    if (!ctx.isAdmin && !rowInAgentScope(row, ctx.scope)) return res.status(403).json({ error: 'This record does not belong to your Agent ID — access denied.' });
    res.json({ success: true, kyc: kycRowToApi(row, await loadAgentsIndex()) });
}));

// Poora Aadhaar/PAN — sirf explicit reveal par, har baar audit-log mein.
app.get('/api/kyc/:entityType/:entityId/reveal', noStore, requireRole('admin', 'agent'), asyncRoute(async (req, res) => {
    const target = parseKycTarget(req, res); if (!target) return;
    const auth = req.authUser;
    if (hitRateLimit('kyc-reveal:' + String(auth.role).toLowerCase() + ':' + String(auth.username || '').toLowerCase(), 20, 60 * 1000)) {
        return res.status(429).json({ error: 'Too many reveal requests — please try again after 1 minute.' });
    }
    const ctx = await loadScopeFor(auth);
    if (!ctx.isAdmin && !ctx.scope) return res.status(403).json({ error: 'Agent identity could not be verified — please log in again.' });
    const row = await kycFind(target.type, target.id);
    if (!row) return res.status(404).json({ error: 'KYC record not found.' });
    if (!ctx.isAdmin && !rowInAgentScope(row, ctx.scope)) {
        auditPii(req, 'kyc_reveal_denied', target.type + ':' + target.id, 'out-of-scope');
        return res.status(403).json({ error: 'This record does not belong to your Agent ID — access denied.' });
    }
    const aadhaar = row.aadhaar_enc ? piiDecrypt(row.aadhaar_enc) : null;
    const pan = row.pan_enc ? piiDecrypt(row.pan_enc) : null;
    if ((row.aadhaar_enc && aadhaar === null) || (row.pan_enc && pan === null)) {
        return res.status(500).json({ error: 'Decryption failed — has PII_ENCRYPTION_KEY been changed?' });
    }
    auditPii(req, 'kyc_reveal', target.type + ':' + target.id, 'aadhaar=' + (aadhaar ? 'yes' : 'no') + ' pan=' + (pan ? 'yes' : 'no'));
    res.json({ success: true, entityType: target.type, entityId: target.id, aadhaar: aadhaar, aadhaarLast4: row.aadhaar_last4 || '', pan: pan });
}));

app.get('/api/kyc', noStore, requireRole('admin', 'agent'), asyncRoute(async (req, res) => {
    const ctx = await loadScopeFor(req.authUser);
    if (!ctx.isAdmin && !ctx.scope) return res.status(403).json({ error: 'Agent identity could not be verified — please log in again.' });
    const where = [];
    const params = [];
    if (!ctx.isAdmin) { const sc = kycScopeWhere(ctx.scope); where.push(sc.sql); params.push.apply(params, sc.params); }
    const type = String(req.query.type || '').toLowerCase();
    if (type) {
        if (KYC_ENTITY_TYPES.indexOf(type) === -1) return res.status(400).json({ error: 'Invalid type.' });
        where.push('entity_type = ?'); params.push(type);
    }
    if (req.query.status) { where.push('status = ?'); params.push(cleanText(req.query.status, 30)); }
    if (ctx.isAdmin && req.query.agentId) { where.push('LOWER(agent_id) = ?'); params.push(cleanText(req.query.agentId, 100).toLowerCase()); }
    if (req.query.q) {
        const q = '%' + escapeLike(cleanText(req.query.q, 60).toLowerCase()) + '%';
        where.push('(LOWER(full_name) LIKE ? OR mobile LIKE ?)'); params.push(q, q);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const rows = await dbq('SELECT * FROM kyc_records' + w + ' ORDER BY created_at DESC, id DESC LIMIT ' + limit + ' OFFSET ' + offset, params);
    const cnt = await dbq('SELECT COUNT(*) AS n FROM kyc_records' + w, params);
    const idx = await loadAgentsIndex();
    res.json({ success: true, total: Number(cnt[0] && cnt[0].n) || 0, limit: limit, offset: offset, results: rows.map(function (r) { return kycRowToApi(r, idx); }) });
}));

app.delete('/api/kyc/:entityType/:entityId', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const target = parseKycTarget(req, res); if (!target) return;
    const rows = await dbq('DELETE FROM kyc_records WHERE entity_type = ? AND entity_id = ? RETURNING id', [target.type, target.id]);
    if (!rows.length) return res.status(404).json({ error: 'KYC record not found.' });
    auditPii(req, 'kyc_delete', target.type + ':' + target.id, '');
    res.json({ success: true });
}));

// Admin: status badalna (approve/reject), agent badalna, ya customer registration ko student/staff id se link karna.
app.patch('/api/admin/kyc/:id', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'A valid KYC ID is required.' });
    const rows = await dbq('SELECT * FROM kyc_records WHERE id = ?', [id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'KYC record not found.' });
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.status !== undefined) { sets.push('status = ?'); params.push(cleanText(b.status, 30)); }
    if (b.agentId !== undefined) { sets.push('agent_id = ?'); params.push(cleanText(b.agentId, 100)); }
    if (b.agentUsername !== undefined) { sets.push('agent_username = ?'); params.push(cleanText(b.agentUsername, 100).toLowerCase()); }
    if (b.entityType !== undefined || b.entityId !== undefined) {
        const t = String(firstDefined(b.entityType, row.entity_type)).toLowerCase();
        const e = cleanText(firstDefined(b.entityId, row.entity_id), 100);
        if (KYC_ENTITY_TYPES.indexOf(t) === -1 || !e) return res.status(400).json({ error: 'Invalid entityType/entityId.' });
        const clash = await dbq('SELECT id FROM kyc_records WHERE entity_type = ? AND entity_id = ? AND id <> ?', [t, e, id]);
        if (clash.length) return res.status(409).json({ error: 'A KYC record already exists for this entity.' });
        sets.push('entity_type = ?', 'entity_id = ?'); params.push(t, e);
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields were provided to update.' });
    params.push(id);
    await dbq('UPDATE kyc_records SET ' + sets.join(', ') + ', updated_at = CURRENT_TIMESTAMP WHERE id = ?', params);
    // Customer registration ka status Admin ki pending queue (blob) mein bhi sync rakho.
    if (b.status !== undefined && row.entity_type === 'customer') {
        try {
            const bl = await dbq('SELECT value FROM kv_blob WHERE `key` = ?', ['customer_pending_registrations']);
            let list = []; try { list = JSON.parse(bl[0] && bl[0].value) || []; } catch (e) {}
            let changed = false;
            list.forEach(function (r) { if (r && r.id === row.entity_id) { r.status = cleanText(b.status, 30); changed = true; } });
            if (changed) await dbq('INSERT INTO kv_blob ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['customer_pending_registrations', JSON.stringify(list)]);
        } catch (e) { console.warn('⚠️ pending blob status sync fail:', e.message); }
    }
    auditPii(req, 'kyc_patch', row.entity_type + ':' + row.entity_id, Object.keys(b).join(','));
    const fresh = await dbq('SELECT * FROM kyc_records WHERE id = ?', [id]);
    res.json({ success: true, kyc: kycRowToApi(fresh[0], await loadAgentsIndex()) });
}));

app.get('/api/admin/pii-audit', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await dbq('SELECT id, ts, actor_role, actor_username, action, target, detail, ip FROM pii_audit_log ORDER BY id DESC LIMIT ' + limit);
    res.json({ success: true, count: rows.length, entries: rows });
}));



// ══════════════════════════════════════════════════════════════════
// 🔐 ACCESS GATE + 🪪 IDENTITY (duplicate check) + 🔎 GLOBAL SEARCH + 📰 LIVE CMS
//   1) /api/auth/me, /api/gate/config, /api/portal/route  → post-login popup + seamless portal handoff
//   2) identityGuard()  → har Student/Staff/Agent save par Identity Number duplicate block
//   3) /api/search/global → Admin = sab kuch, Agent = sirf apne Agent ID ke records
//   4) /api/admin/cms/*  → Live Index Manager (index.html ka content bina Netlify redeploy)
// ══════════════════════════════════════════════════════════════════

const IDENTITY_KEYS = ['identityNumber', 'identity', 'idNumber', 'identityNo', 'identity_number',
    'aadhar', 'aadhaar', 'aadharNumber', 'aadhaarNumber', 'aadharNo', 'aadhaarNo'];
const IDENTITY_REQUIRED = String(process.env.IDENTITY_REQUIRED || 'true').toLowerCase() !== 'false';
const IDENTITY_GUARDED = {
    'kv_admin_entities:students': 'student', 'kv_admin_entities:staff': 'staff', 'kv_admin_entities:agents': 'agent',
    'kv_blob:hrms_employees': 'employee', 'kv_blob:hrms_registrations': 'employee',
    'kv_blob:hrms_pending_registrations': 'employee', 'kv_blob:pending_staff': 'staff'
};
function normIdentity(v) { return String(v == null ? '' : v).replace(/[\s\-.\/]/g, '').toUpperCase(); }
function extractIdentity(rec) {
    if (!rec || typeof rec !== 'object') return '';
    for (let i = 0; i < IDENTITY_KEYS.length; i++) { const n = normIdentity(rec[IDENTITY_KEYS[i]]); if (n) return n; }
    return '';
}
function genericEntityId(rec) {
    return String(firstDefined(rec.id, rec.studentId, rec.empId, rec.empid, rec.agentId, rec.username, '')).trim().toLowerCase();
}
function entityKeys(rec) {
    const out = [];
    if (!rec || typeof rec !== 'object') return out;
    [rec.id, rec.studentId, rec.empId, rec.empid, rec.agentId, rec.username].forEach(function (v) {
        const k = String(v == null ? '' : v).trim().toLowerCase();
        if (k && out.indexOf(k) < 0) out.push(k);
    });
    return out;
}
function shareKey(a, b) { return a.some(function (k) { return b.indexOf(k) >= 0; }); }
function checkIdentityFormat(n) {
    if (!n) return { ok: false, error: 'Identity Number (Aadhaar / ID) is required.' };
    if (/^\d+$/.test(n)) {
        if (n.length !== 12) return { ok: false, error: 'The Aadhaar / Identity Number must be exactly 12 digits.' };
        const v = validateAadhaar12(n);
        return v.ok ? { ok: true } : { ok: false, error: v.error };
    }
    if (!/^[A-Z0-9]{6,20}$/.test(n)) return { ok: false, error: 'Identity Number has an invalid format (6-20 letters/digits).' };
    return { ok: true };
}
function maskIdentity(n) { n = String(n || ''); return n.length >= 4 ? 'XXXX XXXX ' + n.slice(-4) : ''; }
function ownerLabel(att, fallbackName) {
    if (att && att.agentName) return att.agentName + (att.agentId ? ' (' + att.agentId + ')' : '');
    if (att && (att.agentId || att.agentUsername)) return att.agentId || att.agentUsername;
    return fallbackName ? fallbackName : 'Admin / Direct';
}
function dupMessage(label) {
    return 'This Identity Number is already registered with Agent/Library: ' + label + '. Please get it deleted from there first.';
}
async function readKv(table, key) {
    const rows = await safeQ('SELECT value FROM ' + table + ' WHERE `key` = ?', [key]);
    try { const v = JSON.parse(rows[0] && rows[0].value); return v == null ? null : v; } catch (e) { return null; }
}

// Identity ka owner dhoondhta hai (live scan: students/staff/agents/hrms/pending + KYC vault).
// excludeSrc = jis array ko abhi overwrite kiya ja raha hai (woh incoming se replace hoga).
const PENDING_IDENTITY_SRCS = ['hrms_pending_registrations', 'hrms_registrations', 'pending_staff'];
function last10(v) { return String(v == null ? '' : v).replace(/\D/g, '').slice(-10); }
async function findIdentityOwner(norm, selfKeys, excludeSrc, idx, selfPhone) {
    selfKeys = (Array.isArray(selfKeys) ? selfKeys : [selfKeys]).map(function (k) { return String(k || '').trim().toLowerCase(); }).filter(Boolean);
    const tables = ['kv_admin_entities', 'kv_blob'];
    for (let t = 0; t < tables.length; t++) {
        const srcs = LEGACY_SOURCES.filter(function (s) { return s.table === tables[t] && (s.table + ':' + s.key) !== excludeSrc; });
        if (!srcs.length) continue;
        const rows = await safeQ('SELECT `key`, value FROM ' + tables[t] + ' WHERE `key` IN (' + srcs.map(function () { return '?'; }).join(',') + ')', srcs.map(function (s) { return s.key; }));
        for (let r = 0; r < rows.length; r++) {
            const src = srcs.find(function (s) { return s.key === rows[r].key; });
            let arr = []; try { arr = JSON.parse(rows[r].value) || []; } catch (e) { arr = []; }
            if (!Array.isArray(arr)) continue;
            for (let i = 0; i < arr.length; i++) {
                const rec = arr[i];
                if (!rec || typeof rec !== 'object') continue;
                if (extractIdentity(rec) !== norm) continue;
                if (selfKeys.length && shareKey(selfKeys, entityKeys(rec))) continue;
                if (String(rec.status || '').toLowerCase() === 'rejected') continue;
                // pending registration → approved employee/staff (naya ID, wahi insaan): same mobile = same person
                if (selfPhone && PENDING_IDENTITY_SRCS.indexOf(src.key) >= 0 && last10(rec.mobile || rec.phone) === selfPhone) continue;
                const att = attribute(idx, [rec.agentId, rec.ownerUser, rec.agentUsername, rec.registeredAgentId, rec.scopeAgentId]);
                const lbl = src.kind === 'agent' ? ((rec.name || rec.username || 'Agent') + (rec.agentId ? ' (' + rec.agentId + ')' : '')) : ownerLabel(att);
                return { kind: src.kind, entityId: genericEntityId(rec), name: rec.name || '', label: lbl };
            }
        }
    }
    if (/^\d{12}$/.test(norm) && piiReady()) {
        const rows = await safeQ('SELECT * FROM kyc_records WHERE aadhaar_hash = ? LIMIT 5', [piiIndex('AADHAAR', norm)]);
        for (let i = 0; i < rows.length; i++) {
            if (selfKeys.length && selfKeys.indexOf(String(rows[i].entity_id).toLowerCase()) >= 0) continue;
            const att = attribute(idx, [rows[i].agent_id, rows[i].agent_username]);
            return { kind: rows[i].entity_type, entityId: String(rows[i].entity_id), name: rows[i].full_name || '', label: ownerLabel(att) };
        }
    }
    return null;
}

// Whole-array save guard. Sirf NAYE ya identity-BADLE hue records check hote hain
// (purane duplicates ki wajah se normal saves block nahi hote).
async function identityGuard(table, key, incoming, auth) {
    const kind = IDENTITY_GUARDED[table + ':' + key];
    if (!kind || !Array.isArray(incoming)) return null;
    const role = String((auth && auth.role) || '').toLowerCase();
    // 'Identity zaroori' sirf portal forms (agent/staff) par server-side force hota hai; Admin ke bulk/demo/legacy saves block nahi hote (Admin forms UI mein mandatory hain).
    const writer = role === 'agent' || role === 'staff';
    const existing = (await readKv(table, key)) || [];
    const oldMap = new Map();
    (Array.isArray(existing) ? existing : []).forEach(function (r) { if (r && typeof r === 'object') oldMap.set(genericEntityId(r), extractIdentity(r)); });
    const idx = await loadAgentsIndex();
    const excludeSrc = table + ':' + key;
    const seenInArr = new Map();
    for (let i = 0; i < incoming.length; i++) {
        const rec = incoming[i];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        const id = genericEntityId(rec);
        const ident = extractIdentity(rec);
        if (ident) { if (seenInArr.has(ident) && seenInArr.get(ident) !== id) { seenInArr.set(ident + '#dup', id); } else seenInArr.set(ident, id); }
    }
    for (let i = 0; i < incoming.length; i++) {
        const rec = incoming[i];
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        const id = genericEntityId(rec);
        const ident = extractIdentity(rec);
        const isNew = !oldMap.has(id);
        const changed = !isNew && ident && oldMap.get(id) !== ident;
        if (!ident) {
            if (isNew && IDENTITY_REQUIRED && writer && kind !== 'employee') {
                return { status: 400, error: 'Identity Number (Aadhaar / ID) is required for ' + (rec.name || id || 'this record') + '.' };
            }
            continue;
        }
        if (!isNew && !changed) continue;
        const f = checkIdentityFormat(ident);
        if (!f.ok) return { status: 400, error: f.error };
        // same array ke andar duplicate
        for (let j = 0; j < incoming.length; j++) {
            if (j === i) continue;
            const o = incoming[j];
            if (!o || typeof o !== 'object' || extractIdentity(o) !== ident) continue;
            if (shareKey(entityKeys(rec), entityKeys(o))) continue;
            const att = attribute(idx, [o.agentId, o.ownerUser, o.agentUsername]);
            return { status: 409, code: 'IDENTITY_DUPLICATE', error: dupMessage(ownerLabel(att)), owner: { entityId: genericEntityId(o), name: o.name || '' } };
        }
        const hit = await findIdentityOwner(ident, entityKeys(rec), excludeSrc, idx, last10(rec.mobile || rec.phone));
        if (hit) return { status: 409, code: 'IDENTITY_DUPLICATE', error: dupMessage(hit.label), owner: { kind: hit.kind, entityId: hit.entityId, name: hit.name } };
    }
    return null;
}

// Form se pehle (live) check — Student/Staff/Agent/HRMS forms yahi call karte hain.
app.post('/api/identity/check', noStore, requireRole('admin', 'agent', 'staff', 'employee'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const norm = normIdentity(firstDefined(b.identity, b.identityNumber, b.aadhaar, b.aadhar, ''));
    const f = checkIdentityFormat(norm);
    if (!f.ok) return res.status(400).json({ ok: false, error: f.error });
    if (hitRateLimit('idcheck:' + String(req.authUser.username || '').toLowerCase(), 60, 60 * 1000)) return res.status(429).json({ error: 'Too many checks. Please wait a moment and try again.' });
    const idx = await loadAgentsIndex();
    const hit = await findIdentityOwner(norm, [b.entityId].concat(Array.isArray(b.entityIds) ? b.entityIds : []), '', idx);
    if (hit) return res.status(409).json({ ok: false, code: 'IDENTITY_DUPLICATE', error: dupMessage(hit.label), owner: { kind: hit.kind, name: hit.name } });
    res.json({ ok: true, masked: maskIdentity(norm) });
}));

// ── Auth me ──
async function adminProfile(auth) {
    const admins = (await readKv('kv_admin_entities', 'admins')) || [];
    const u = String(auth.username || '').toLowerCase();
    const a = Array.isArray(admins) ? admins.find(function (x) { return x && String(x.username || '').toLowerCase() === u; }) : null;
    return { username: auth.username, role: auth.role, name: (a && (a.name || a.fullName)) || auth.username, gender: a && a.gender || '' };
}
app.get('/api/auth/me', noStore, asyncRoute(async (req, res) => {
    const auth = getAuthUser(req);
    if (!auth) return res.status(401).json({ error: 'Session expired — please log in again.' });
    const p = String(auth.role).toLowerCase() === 'admin' ? await adminProfile(auth) : { username: auth.username, role: auth.role, name: auth.username };
    res.json({ success: true, user: p, gate: !!auth.gate, location: auth.location || '', portal: auth.portal || '', exp: auth.exp });
}));

// ── Access-gate config ──
const GATE_DEFAULT = {
    popup: {
        heading: 'SECURE ANMOL LibMatrix ACCESS',
        welcomeTemplate: 'Welcome {title} {name}',
        subtitle: 'Select your role and location to continue',
        roleLabel: 'Select Role', locationLabel: 'Select Location', continueLabel: 'Continue'
    },
    roles: [
        { id: 'super_admin', label: 'Super Admin', portal: 'admin', target: 'Super_Admin_Dashboard.html', enabled: true },
        { id: 'pfms', label: 'PFMS Portal', portal: 'pfms', target: 'PFMS_login.html', enabled: true },
        { id: 'agent', label: 'Agent Login', portal: 'agent', target: 'Agent_Login.html', enabled: true },
        { id: 'hrms', label: 'HRMS', portal: 'hrms', target: 'HRMS_login.html', enabled: true },
        { id: 'student', label: 'Student Attendance', portal: 'student', target: 'Student_Attendance.html', enabled: true },
        { id: 'invoice', label: 'Invoice Login', portal: 'invoice', target: 'INVOICE_LOGIN.html', enabled: true }
    ],
    locations: [
        { id: 'begusarai', label: 'Begusarai', enabled: true },
        { id: 'pansalla', label: 'Pansalla', enabled: true }
    ],
    users: []   // [{username, name, title:'Mr.'|'Mrs.', roles:[ids], locations:[ids], actAs:{roleId: username}}]
};
const GATE_PORTALS = ['admin', 'pfms', 'agent', 'hrms', 'student', 'invoice'];
const SAFE_TARGET = /^[A-Za-z0-9_\-]{1,60}\.html$/;
function sanitizeGate(v) {
    const g = (v && typeof v === 'object') ? v : {};
    const s = function (x, n) { return cleanText(x, n); };
    const out = { popup: {}, roles: [], locations: [], users: [] };
    const p = g.popup || {};
    Object.keys(GATE_DEFAULT.popup).forEach(function (k) { out.popup[k] = s(firstDefined(p[k], GATE_DEFAULT.popup[k]), 120) || GATE_DEFAULT.popup[k]; });
    const slug = function (x, fb) { return String(x || fb || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40); };
    (Array.isArray(g.roles) ? g.roles : []).slice(0, 30).forEach(function (r) {
        if (!r || !s(r.label, 60)) return;
        const portal = GATE_PORTALS.indexOf(r.portal) >= 0 ? r.portal : 'admin';
        let target = s(r.target, 80);
        if (!SAFE_TARGET.test(target)) target = (GATE_DEFAULT.roles.find(function (d) { return d.portal === portal; }) || {}).target || 'Super_Admin_Dashboard.html';
        out.roles.push({ id: slug(r.id, r.label), label: s(r.label, 60), portal: portal, target: target, enabled: r.enabled !== false });
    });
    (Array.isArray(g.locations) ? g.locations : []).slice(0, 100).forEach(function (l) {
        if (!l || !s(l.label, 60)) return;
        out.locations.push({ id: slug(l.id, l.label), label: s(l.label, 60), enabled: l.enabled !== false });
    });
    (Array.isArray(g.users) ? g.users : []).slice(0, 200).forEach(function (u) {
        if (!u || !s(u.username, 60)) return;
        const act = {};
        if (u.actAs && typeof u.actAs === 'object') Object.keys(u.actAs).slice(0, 20).forEach(function (k) { const a = s(u.actAs[k], 60); if (a) act[slug(k)] = a; });
        out.users.push({
            username: s(u.username, 60), name: s(u.name, 80), title: /^(mrs|ms|miss)/i.test(s(u.title, 10)) ? 'Mrs.' : 'Mr.',
            roles: (Array.isArray(u.roles) ? u.roles : []).map(function (x) { return slug(x); }).filter(Boolean).slice(0, 30),
            locations: (Array.isArray(u.locations) ? u.locations : []).map(function (x) { return slug(x); }).filter(Boolean).slice(0, 100),
            actAs: act
        });
    });
    if (!out.roles.length) out.roles = GATE_DEFAULT.roles.slice();
    if (!out.locations.length) out.locations = GATE_DEFAULT.locations.slice();
    return out;
}
async function loadGate() {
    const v = await readKv('kv_site_data', 'access_gate');
    return sanitizeGate(v || GATE_DEFAULT);
}
function gateViewFor(gate, auth, profile) {
    const uname = String(auth.username || '').toLowerCase();
    const me = gate.users.find(function (u) { return u.username.toLowerCase() === uname; });
    const roles = gate.roles.filter(function (r) { return r.enabled && (!me || !me.roles.length || me.roles.indexOf(r.id) >= 0); });
    const locations = gate.locations.filter(function (l) { return l.enabled && (!me || !me.locations.length || me.locations.indexOf(l.id) >= 0); });
    const name = (me && me.name) || profile.name || auth.username;
    const title = (me && me.title) || (/^(f|female|mrs|ms)/i.test(profile.gender || '') ? 'Mrs.' : 'Mr.');
    const welcome = String(gate.popup.welcomeTemplate || 'Welcome {title} {name}').replace(/\{title\}/gi, title).replace(/\{name\}/gi, name).replace(/\s+/g, ' ').trim();
    return { popup: Object.assign({}, gate.popup, { welcome: welcome }), roles: roles, locations: locations, user: { username: auth.username, name: name, title: title } };
}
app.get('/api/gate/config', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const gate = await loadGate();
    res.json({ success: true, gate: gateViewFor(gate, req.authUser, await adminProfile(req.authUser)) });
}));
app.get('/api/admin/gate-config', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    res.json({ success: true, gate: await loadGate() });
}));
app.put('/api/admin/gate-config', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const clean = sanitizeGate((req.body || {}).gate || req.body);
    await dbq('INSERT INTO kv_site_data ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['access_gate', JSON.stringify(clean)]);
    res.json({ success: true, gate: clean });
}));
// Dropdown ke liye — sirf naam/username/role (password/PII kabhi nahi)
app.get('/api/admin/gate-users', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const out = [];
    const add = function (arr, role) {
        (Array.isArray(arr) ? arr : []).forEach(function (x) {
            if (x && x.username) out.push({ username: String(x.username), name: x.name || x.fullName || '', role: role, agentId: x.agentId || '' });
        });
    };
    add(await readKv('kv_admin_entities', 'admins'), 'admin');
    add(await readKv('kv_admin_entities', 'agents'), 'agent');
    add(await readKv('kv_admin_entities', 'staff'), 'staff');
    res.json({ success: true, users: out });
}));

// Role + Location → routing token (dobara username/password nahi)
const PORTAL_JWT_ROLE = { admin: 'admin', pfms: 'pfms', agent: 'agent', hrms: 'admin', student: 'admin', invoice: 'admin' };
app.post('/api/portal/route', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const auth = req.authUser;
    if (hitRateLimit('route:' + String(auth.username || '').toLowerCase(), 30, 60 * 1000)) return res.status(429).json({ error: 'Bahut zyada attempts.' });
    const b = req.body || {};
    const gate = await loadGate();
    const view = gateViewFor(gate, auth, await adminProfile(auth));
    const role = view.roles.find(function (r) { return r.id === String(b.roleId || '').toLowerCase() || r.label === b.role; });
    const loc = view.locations.find(function (l) { return l.id === String(b.locationId || '').toLowerCase() || l.label === b.location; });
    if (!role) return res.status(400).json({ error: 'This role is not permitted for you.' });
    if (!loc) return res.status(400).json({ error: 'This location is not permitted for you.' });
    const me = gate.users.find(function (u) { return u.username.toLowerCase() === String(auth.username || '').toLowerCase(); });
    const actAs = (me && me.actAs && me.actAs[role.id]) || auth.username;
    let jwtRole = PORTAL_JWT_ROLE[role.portal] || 'admin';
    let autoLogin = role.portal === 'admin' || role.portal === 'pfms' || role.portal === 'agent';
    let tokenUser = String(actAs);
    if (role.portal === 'hrms' && me && me.actAs && me.actAs[role.id]) { jwtRole = 'employee'; tokenUser = String(me.actAs[role.id]).toUpperCase(); autoLogin = true; }
    const payload = { role: jwtRole, username: tokenUser, gate: true, portal: role.portal, roleId: role.id, location: loc.label, via: String(auth.username) };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
    try { auditPii(req, 'gate_route', role.label + '@' + loc.label, 'portal=' + role.portal + ' as=' + tokenUser); } catch (e) {}
    try { if (supabasePortals.logSession) supabasePortals.logSession({ event: 'role_selected', role: role.label, location: loc.label, username: String(auth.username), ip: req.ip }); } catch (e) {}
    res.json({
        success: true, token: token, target: role.target, portal: role.portal, role: jwtRole, autoLogin: autoLogin,
        roleLabel: role.label, location: loc.label, username: tokenUser, name: view.user.name, title: view.user.title,
        expiresInSec: 12 * 3600
    });
}));

// ── GLOBAL SEARCH (Admin = sab, Agent = sirf apna Agent ID) ──
const IDENTITY_SOURCES = LEGACY_SOURCES;
app.get('/api/search/global', noStore, requireRole('admin', 'agent', 'staff'), asyncRoute(async (req, res) => {
    const auth = req.authUser;
    const role = String(auth.role).toLowerCase();
    const isAdmin = role === 'admin';
    if (hitRateLimit('gsearch:' + role + ':' + String(auth.username || '').toLowerCase(), 60, 60 * 1000)) return res.status(429).json({ error: 'Too many searches — please try again after 1 minute.' });
    const q = cleanText(req.query.q, 80);
    if (q.length < 2) return res.status(400).json({ error: 'Please enter at least 2 characters.' });
    let scope = null;
    if (!isAdmin) {
        scope = await resolveAgentScopeP(auth);
        if (!scope || !scope.username) return res.status(403).json({ error: 'Agent identity could not be verified — please log in again.' });
    }
    const idx = await loadAgentsIndex();
    const ql = q.toLowerCase();
    const normQ = normIdentity(q);
    const digits = q.replace(/\D/g, '');
    const idMode = /^\d{12}$/.test(digits) ? 'full' : (/^\d{4}$/.test(q.trim()) ? 'last4' : (/^[A-Z0-9]{6,20}$/.test(normQ) && /\d/.test(normQ) && /[A-Z]/.test(normQ) ? 'alnum' : ''));
    const results = []; const seen = new Set(); const LIMIT = 60;
    const push = function (o) {
        const k = o.kind + ':' + String(o.entityId).toLowerCase();
        if (seen.has(k) || results.length >= LIMIT) return;
        seen.add(k); results.push(o);
    };
    // 1) KYC vault
    if (idMode === 'full' && piiReady()) {
        const rows = await safeQ('SELECT * FROM kyc_records WHERE aadhaar_hash = ? LIMIT 20', [piiIndex('AADHAAR', digits)]);
        rows.forEach(function (r) { if (isAdmin || rowInAgentScope(r, scope)) { const o = kycRowToApi(r, idx); o.matchType = 'identity'; push(o); } });
    } else if (idMode === 'last4') {
        const rows = await safeQ('SELECT * FROM kyc_records WHERE aadhaar_last4 = ? LIMIT 30', [q.trim()]);
        rows.forEach(function (r) { if (isAdmin || rowInAgentScope(r, scope)) { const o = kycRowToApi(r, idx); o.matchType = 'last4'; push(o); } });
    } else {
        const like = '%' + escapeLike(ql) + '%';
        const rows = await safeQ('SELECT * FROM kyc_records WHERE (LOWER(full_name) LIKE ? OR LOWER(entity_id) LIKE ? OR mobile LIKE ? OR LOWER(email) LIKE ?) ORDER BY id DESC LIMIT 60', [like, like, like, like]);
        rows.forEach(function (r) { if (isAdmin || rowInAgentScope(r, scope)) { const o = kycRowToApi(r, idx); o.matchType = 'text'; push(o); } });
    }
    // 2) JSON arrays
    const srcsAll = IDENTITY_SOURCES.filter(function (s) { return isAdmin || !s.adminOnly; });
    for (const table of ['kv_admin_entities', 'kv_blob']) {
        const srcs = srcsAll.filter(function (s) { return s.table === table; });
        if (!srcs.length) continue;
        const rows = await safeQ('SELECT `key`, value FROM ' + table + ' WHERE `key` IN (' + srcs.map(function () { return '?'; }).join(',') + ')', srcs.map(function (s) { return s.key; }));
        rows.forEach(function (row) {
            const src = srcs.find(function (s) { return s.key === row.key; });
            let arr = []; try { arr = JSON.parse(row.value) || []; } catch (e) { return; }
            if (!Array.isArray(arr)) return;
            arr.forEach(function (rec) {
                if (!rec || typeof rec !== 'object') return;
                if (!isAdmin && !belongsToAgent(rec, scope)) return;
                const ident = extractIdentity(rec);
                let match = '';
                if (idMode === 'full' || idMode === 'alnum') { if (ident && ident === (idMode === 'full' ? digits : normQ)) match = 'identity'; }
                else if (idMode === 'last4') { if (ident.slice(-4) === q.trim() || extractLast4(rec) === q.trim()) match = 'last4'; }
                if (!match) {
                    const hay = [rec.name, rec.fullName, rec.mobile, rec.phone, rec.email, rec.id, rec.studentId, rec.empId, rec.empid, rec.username, rec.agentId, rec.company]
                        .map(function (x) { return String(x == null ? '' : x).toLowerCase(); });
                    if (hay.some(function (h) { return h && h.indexOf(ql) >= 0; })) match = 'text';
                }
                if (!match) return;
                const o = legacyRecToApi(rec, src, idx);
                o.identityMasked = ident ? maskIdentity(ident) : (o.aadhaarMasked || '');
                o.hasIdentity = !!ident || !!o.hasFullAadhaar;
                o.connectedAgent = o.agentName ? (o.agentName + (o.agentId ? ' (' + o.agentId + ')' : '')) : (o.agentId || o.agentUsername || 'Admin / Direct');
                o.matchType = match;
                push(o);
            });
        });
    }
    results.forEach(function (o) { if (!o.connectedAgent) o.connectedAgent = o.agentName ? (o.agentName + (o.agentId ? ' (' + o.agentId + ')' : '')) : (o.agentId || o.agentUsername || 'Admin / Direct'); });
    if (idMode && isAdmin && results.length && results.length <= 10) {
        for (let i = 0; i < results.length; i++) { try { results[i].history = await buildHistory(results[i]); } catch (e) { results[i].history = null; } }
    }
    auditPii(req, 'global_search', idMode ? 'ID-' + (digits.slice(-4) || 'x') : cleanText(q, 30), 'results=' + results.length + ' scope=' + (isAdmin ? 'global' : scope.username));
    res.json({ success: true, query: idMode ? '(identity)' : q, mode: idMode || 'text', scope: isAdmin ? { global: true } : { agentId: scope.agentId, username: scope.username }, count: results.length, results: results });
}));

// ── LIVE CMS (Live Index Manager) ──
// index.html public GET /api/site-data se padhta hai; Admin yahan se save karta hai.
const CMS_KEYS = ['homepage', 'index_about', 'ticker', 'notices', 'latest_updates', 'index_theme', 'apps', 'login_options',
    'index_overrides', 'live_dashboard', 'index_gallery', 'footer', 'stats', 'nav_buttons', 'kyc_performance_mode'];
const THEME_VARS = ['--blue', '--blue2', '--navy', '--orange', '--bg', '--text'];
const CMS_COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d\s.,%]+\)$/;
function cmsSanitize(key, v) {
    if (key === 'index_theme') {
        const o = { vars: {}, font: '', mode: '' };
        const src = (v && v.vars) || {};
        Object.keys(src).forEach(function (k) { if (/^--[a-z0-9-]{1,30}$/.test(k) && CMS_COLOR.test(String(src[k]).trim())) o.vars[k] = String(src[k]).trim(); });
        o.font = /^[A-Za-z0-9 ,'"-]{0,80}$/.test((v && v.font) || '') ? ((v && v.font) || '') : '';
        o.mode = (v && v.mode) === 'dark' ? 'dark' : '';
        return o;
    }
    return v;
}
async function cmsSave(key, value) {
    await dbq('INSERT INTO kv_site_data ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
}
app.get('/api/admin/cms', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const rows = await safeQ('SELECT `key`, value FROM kv_site_data', []);
    const out = {};
    rows.forEach(function (r) { if (CMS_KEYS.indexOf(r.key) >= 0) { try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = r.value; } } });
    res.json({ success: true, keys: CMS_KEYS, data: out });
}));
app.put('/api/admin/cms/:key', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const key = req.params.key;
    if (CMS_KEYS.indexOf(key) === -1) return res.status(404).json({ error: 'Unknown CMS key.' });
    const v = (req.body || {}).value;
    const s = JSON.stringify(v === undefined ? null : v);
    if (s.length > 3000000) return res.status(413).json({ error: 'Content is too large.' });
    if (/["']\s*(javascript|vbscript):/i.test(s) || /"(href|url|link)"\s*:\s*"\s*(javascript|vbscript):/i.test(s)) return res.status(400).json({ error: 'Unsafe link (javascript:/data:) is not allowed.' });
    await cmsSave(key, cmsSanitize(key, v));
    res.json({ success: true });
}));


// ══════════════════════════════════════════════════════════════════
// 🌐 PAGE ROUTES — clean URLs → HTML files. File `public/` ya project root
//   (server.js ke bagal) mein ho sakti hai; naam ka case matter nahi karta.
//   Local file na mile to login pages ke liye Admin Panel se upload hua page
//   (/api/pages/<slug>, DB se) par redirect hota hai.
//     /  /index /home            → index.html
//     /admin /admin-login        → Admin_Login.html   (fallback: /api/pages/admin-login)
//     /agent /agent-login        → Agent_Login.html   (fallback: /api/pages/agent-login)
// ══════════════════════════════════════════════════════════════════
const PAGE_MAP = [
    { paths: ['/', '/index', '/home'], file: 'index.html', slug: null },
    { paths: ['/admin', '/admin-login', '/admin_login'], file: 'Admin_Login.html', slug: 'admin-login' },
    { paths: ['/agent', '/agent-login', '/agent_login'], file: 'Agent_Login.html', slug: 'agent-login' }
];
PAGE_MAP.forEach(function (pg) {
    pg.paths.forEach(function (p) {
        app.get(p, function (req, res, next) {
            const f = findStaticFile(pg.file);
            if (f) { res.set('Cache-Control', 'no-cache'); return res.sendFile(f); }
            if (p === '/') return res.send('Library App Backend is running successfully!'); // frontend Netlify par ho to pehle jaisa
            if (pg.slug) return res.redirect(302, '/api/pages/' + pg.slug);
            next();
        });
    });
});
app.get('/favicon.ico', function (req, res, next) {
    const f = findStaticFile('favicon.ico');
    if (f) return res.sendFile(f);
    res.status(204).end();
});
app.get(['/health', '/healthz'], function (req, res) { res.json({ status: 'ok', running: true }); });


// 🆕 HEALTH CHECK ROUTE — frontend ka status dot (Admin/Agent/HRMS/Student
// portal ke '☁️ Render' indicator) isi route ko har 10 second mein poll
// karta hai (API_BASE + '/health' → '/api/health'). Pehle ye route missing
// tha, isliye fetch 404 deta tha aur dot hamesha red rehta tha.
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        running: true,
        db: db ? 'configured' : 'not configured',
        supabase: supabasePortals.enabled ? 'configured' : 'not configured',
        timestamp: new Date().toISOString()
    });
});

// ══════════════════════════════════════════════════════════════════
// 🛡️ SAFETY NET — yeh sabse aakhri mein aata hai (upar ke SAARE routes
//   define ho jaane ke baad — isliye /api/health jaisi cheezein isse
//   pehle hi match ho jaati hain, yeh sirf bacha hua traffic pakadta hai).
//   Kaam: kabhi bhi frontend ko HTML na mile, hamesha JSON hi mile —
//   chahe route na mila ho, chahe upload fail hua ho, chahe koi aur
//   unexpected error aaya ho. Isi wajah se "Unexpected token '<',
//   <!DOCTYPE" jaisi errors dobara kabhi nahi aayengi.
// ══════════════════════════════════════════════════════════════════

// 0) Koi bhi NON-API route jo upar (ya express.static se) match nahi hua —
//    Yeti wala custom 404.html page dikhao. '/api/*' ko yahan jaan-boojh kar
//    skip kiya gaya hai (next() call karke) taaki wo neeche wale JSON 404
//    handler (point 1) tak pahunche — API clients ko hamesha JSON hi milna
//    chahiye, HTML kabhi nahi.
const INLINE_404 = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 — Page Not Found</title>' +
    '<style>body{font-family:Arial,sans-serif;background:#0d1e3d;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}a{color:#c9a227}</style></head>' +
    '<body><div><h1>404</h1><p>This page does not exist.</p><p><a href="/">← Return to Home</a></p></div></body></html>';
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    // 🔒 FIX: pehle yahan hamesha public/404.html bheja jaata tha — file na ho to sendFile error →
    // 500 + server ka andar ka path leak. Ab file mile to wahi, warna built-in 404 page.
    const f = findStaticFile('404.html');
    res.status(404);
    if (f) return res.sendFile(f, (e) => { if (e && !res.headersSent) res.type('html').send(INLINE_404); });
    res.type('html').send(INLINE_404);
});

// 1) Koi bhi /api/* route jo upar define nahi hua — HTML 404 ki jagah JSON 404
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'This API route does not exist: ' + req.method + ' ' + req.originalUrl });
});

// 2) Global error handler — Multer errors (file bahut badi/galat field name)
//    aur koi bhi anya crash yahan pakda jaata hai, JSON ki tarah bheja jaata hai
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err && err.message);
    if (res.headersSent) return next(err);
    if (err && err.name === 'MulterError') {
        let msg = 'File upload error: ' + err.message;
        if (err.code === 'LIMIT_FILE_SIZE') msg = 'The file is too large (maximum 100MB allowed).';
        return res.status(400).json({ error: msg });
    }
    // status preserve karo (galat JSON body → 400, CORS → 403), warna 500. Stack kabhi nahi bhejte.
    const st = err && (err.status || err.statusCode);
    res.status(st >= 400 && st < 600 ? st : 500).json({ error: (err && err.message) || 'An unknown server error occurred.' });
});

// ══════════════════════════════════════════════════════════════════
// 🛡️ Process-level crash-protection (uncaughtException/unhandledRejection)
// ab file ke bilkul shuru mein register hoti hai — dekhein sabse upar,
// requires ke turant baad. Yahan dobara likhne ki zaroorat nahi.

// ══════════════════════════════════════════════════════════════════
// 🔄 KEEP-ALIVE / SELF-PING — Render ka FREE plan 15 minute ki
//   inactivity ke baad server ko "sleep" mode mein daal deta hai,
//   jiski wajah se agli request 30-60 second late khulti hai
//   ("cold start"). Isse rokne ke liye server khud apne hi
//   '/api/health' route ko har 10 minute mein internally ping karta
//   rehta hai — isse Render ko lagta hai server par activity ho
//   rahi hai, aur woh kabhi sone nahi paata.
//   NOTE: Render 'RENDER_EXTERNAL_URL' env var apne aap set karta
//   hai (jaise https://library-backend-4efk.onrender.com) — usi ko
//   use karte hain taaki URL kahin bhi hardcode na karna pade. Agar
//   yeh env var kisi wajah se na mile, to neeche wala fallback URL
//   (ALLOWED_ORIGINS wala apna hi backend domain) use hota hai.
// ══════════════════════════════════════════════════════════════════
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || 'https://library-backend-4efk.onrender.com';
const SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minute (15 minute wali sleep-limit se kam)

function selfPing() {
    try {
        const url = SELF_PING_URL.replace(/\/$/, '') + '/api/health';
        const lib = url.startsWith('https') ? require('https') : require('http');
        const req = lib.get(url, { timeout: 15000 }, (res) => {
            // Response body ki zaroorat nahi — sirf request complete hone
            // dena hai taaki connection turant clean ho jaaye.
            res.resume();
            console.log(`✅ Self-ping ok (status ${res.statusCode}) — ${new Date().toISOString()}`);
        });
        req.on('timeout', () => { req.destroy(); console.warn('⚠️ Self-ping timeout.'); });
        req.on('error', (err) => { console.warn('⚠️ Self-ping failed:', err && err.message); });
    } catch (e) {
        console.warn('⚠️ Self-ping error:', e && e.message);
    }
}
// Server start hone ke thodi der baad pehla ping, fir har 10 minute mein.
setTimeout(selfPing, 30 * 1000);
setInterval(selfPing, SELF_PING_INTERVAL_MS);

// Start Server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`📁 Static: ${PUBLIC_DIR ? 'public/ + safe root files' : 'safe root files (public/ folder not found)'}`);
    // 🆕 Deploy ke waqt turant dikh jaaye ki "/" par kaunsi index.html serve hogi (ya nahi mili).
    const _idxFile = findStaticFile('index.html');
    console.log(_idxFile
        ? `📄 "/" par index.html will be served: ${_idxFile}`
        : '⚠️ index.html not found — only the text “Backend is running” will be shown at “/”. Place index.html alongside server.js (same folder) or in the public/ folder.');
});
// Render ke proxy ke keep-alive (60s) se bada rakhte hain — warna kabhi-kabhi random 502 aata hai.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;
// 🆕 Graceful shutdown: Render redeploy par SIGTERM aata hai — chalti requests poori hone do, DB pool band karo.
let _shuttingDown = false;
function gracefulShutdown(sig) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log('🛑 ' + sig + ' received. The server is shutting down...');
    setTimeout(() => process.exit(0), 10000).unref();
    server.close(() => { Promise.resolve(db.end()).catch(() => {}).then(() => process.exit(0)); });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
