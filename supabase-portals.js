'use strict';
/**
 * supabase-portals.js — Supabase (supabase-js) layer for all 6 portals:
 * Admin, Agent, PFMS, HRMS, Student Attendance, Invoice Generator.
 *
 * What it does (server-side only; the service key never reaches the browser):
 *  1. Logs every login attempt / logout            -> portal_login_attempts, portal_sessions
 *  2. Revokes JWTs on logout (real server-side logout) -> revoked_tokens
 *  3. Mirrors successful form submissions + registrations from the existing
 *     routes into Supabase (sanitised: passwords/OTP/PIN/card redacted,
 *     Aadhaar masked, base64 blobs dropped)           -> portal_submissions, portal_registrations
 *  4. New endpoints under /api/portal/*                -> attendance, forms, role/location session
 *
 * Env: SUPABASE_URL, SUPABASE_KEY (service_role key). If either is missing the module
 * disables itself and the rest of server.js keeps working exactly as before.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const enabled = !!(SUPABASE_URL && SUPABASE_KEY);

let sb = null;
if (enabled) {
    try {
        const { createClient } = require('@supabase/supabase-js');
        sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (e) { console.warn('Supabase client could not be created: ' + e.message); }
} else {
    console.warn('⚠️ SUPABASE_URL / SUPABASE_KEY not set — Supabase portal layer is DISABLED.');
}

const PORTALS = ['admin', 'agent', 'pfms', 'hrms', 'student', 'invoice'];
const LOCATIONS = String(process.env.PORTAL_LOCATIONS || 'Peinshallah').split(',').map(s => s.trim()).filter(Boolean);
const SESSION_ROLES = ['super_admin', 'pfms'];

// ── helpers ─────────────────────────────────────────────────────────
function logErr(where, error) { if (error) console.warn('⚠️ Supabase[' + where + ']:', error.message || error); }
async function insert(table, rows) {
    if (!enabled) return;
    try { const { error } = await sb.from(table).insert(rows); logErr(table, error); }
    catch (e) { logErr(table, e); }
}
const str = (v, max) => (v == null ? null : String(v).slice(0, max || 200));
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const ip = req => str(req.ip || (req.connection && req.connection.remoteAddress), 64);
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
function maskId(v) { const s = String(v == null ? '' : v); return /^\d{10}$/.test(s) ? 'XXXXXX' + s.slice(-4) : s.slice(0, 80); }

// Redact secrets, mask Aadhaar, drop binary blobs, cap size.
const SECRET_KEY = /pass(word)?|pwd|secret|token|otp|pin$|cvv|card|captcha|signature/i;
const AADHAAR_KEY = /aadh?a+r/i;
function sanitize(v, depth) {
    depth = depth || 0;
    if (v == null || depth > 6) return v == null ? null : '[deep]';
    if (typeof v === 'string') return /^data:/.test(v) || v.length > 2000 ? '[binary/long omitted]' : v;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 100).map(x => sanitize(x, depth + 1));
    const out = {};
    Object.keys(v).slice(0, 100).forEach(k => {
        if (SECRET_KEY.test(k)) out[k] = '[REDACTED]';
        else if (AADHAAR_KEY.test(k)) out[k] = 'XXXXXXXX' + String(v[k] == null ? '' : v[k]).replace(/\D/g, '').slice(-4);
        else out[k] = sanitize(v[k], depth + 1);
    });
    return out;
}
function boundedPayload(body) {
    const clean = sanitize(body || {});
    return JSON.stringify(clean).length > 100000 ? { _note: 'payload too large', keys: Object.keys(body || {}).slice(0, 100) } : clean;
}

// ── tiny in-memory rate limiter (no extra dependency) ──────────────
const hits = new Map();
function rateLimit(max, windowMs) {
    return (req, res, next) => {
        const k = ip(req) + '|' + req.path, now = Date.now();
        const e = hits.get(k);
        if (!e || now > e.reset) { hits.set(k, { n: 1, reset: now + windowMs }); return next(); }
        if (++e.n > max) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        next();
    };
}
setInterval(() => { const n = Date.now(); hits.forEach((e, k) => { if (n > e.reset) hits.delete(k); }); }, 5 * 60 * 1000).unref();

// ── token revocation (sync check used by getAuthUser) ──────────────
const revoked = new Map(); // sha256(token) -> expiry ms
function isRevoked(token) { return !!token && revoked.has(sha(token)); }
async function revokeToken(token) {
    const d = jwt.decode(token);
    if (!d) return;
    const exp = (d.exp ? d.exp * 1000 : Date.now() + 7 * 86400000);
    revoked.set(sha(token), exp);
    await insert('revoked_tokens', { token_hash: sha(token), role: str(d.role, 40), username: str(d.username || d.userId, 80), expires_at: new Date(exp).toISOString() });
}
async function loadRevoked() {
    if (!enabled) return;
    try {
        const { data, error } = await sb.from('revoked_tokens').select('token_hash,expires_at').gt('expires_at', new Date().toISOString()).limit(20000);
        logErr('revoked_tokens.load', error);
        (data || []).forEach(r => revoked.set(r.token_hash, new Date(r.expires_at).getTime()));
    } catch (e) { logErr('revoked_tokens.load', e); }
}
setInterval(() => { const n = Date.now(); revoked.forEach((exp, k) => { if (n > exp) revoked.delete(k); }); }, 3600 * 1000).unref();

// ── which existing routes get mirrored into Supabase ───────────────
const MIRRORS = [
    // registrations -> portal_registrations
    { m: 'POST', re: /^\/agent-registrations$/, portal: 'agent', kind: 'registration', reg: true },
    { m: 'POST', re: /^\/hr\/register$/, portal: 'hrms', kind: 'registration', reg: true },
    { m: 'POST', re: /^\/material\/register$/, portal: 'invoice', kind: 'registration', reg: true },
    { m: 'POST', re: /^\/customer-registrations\/order$/, portal: 'student', kind: 'registration', reg: true },
    // everything else -> portal_submissions
    { m: 'POST', re: /^\/material\/bills$/, portal: 'invoice', kind: 'invoice_create' },
    { m: 'PUT', re: /^\/material\/bills\/[^/]+$/, portal: 'invoice', kind: 'invoice_update' },
    { m: 'POST', re: /^\/material\/users$/, portal: 'invoice', kind: 'material_user_create' },
    { m: 'POST', re: /^\/material\/change-mobile$/, portal: 'invoice', kind: 'change_mobile' },
    { m: 'POST', re: /^\/attendance(\/mark|\/selfie)?$/, portal: 'student', kind: 'attendance_legacy' },
    { m: 'POST', re: /^\/payments\/fee$/, portal: 'student', kind: 'fee_payment' },
    { m: 'POST', re: /^\/payments\/student-transaction$/, portal: 'student', kind: 'student_transaction' },
    { m: 'POST', re: /^\/agent\/payout-request$/, portal: 'agent', kind: 'payout_request' },
    { m: 'POST', re: /^\/hr\/salary-slips\/[^/]+\/request-payment$/, portal: 'hrms', kind: 'salary_payment_request' },
    { m: 'POST', re: /^\/hrms-salary\/claims$/, portal: 'hrms', kind: 'salary_claim' },
    { m: 'PUT', re: /^\/hr\/employees\/[^/]+$/, portal: 'hrms', kind: 'employee_update' },
    { m: 'POST', re: /^\/hr\/registrations\/[^/]+\/(approve|reject)$/, portal: 'hrms', kind: 'registration_review' },
    { m: 'POST', re: /^\/pfms\/payout-requests\/[^/]+\/pay$/, portal: 'pfms', kind: 'payout_paid' },
    { m: 'POST', re: /^\/admin\/pfms-users$/, portal: 'admin', kind: 'pfms_user_create' },
    { m: 'PUT', re: /^\/admin\/pfms-users\/[^/]+$/, portal: 'admin', kind: 'pfms_user_update' },
    { m: 'DELETE', re: /^\/admin\/pfms-users\/[^/]+$/, portal: 'admin', kind: 'pfms_user_delete' },
    { m: 'POST', re: /^\/admin\/wallet\/topup$/, portal: 'admin', kind: 'wallet_topup' },
    { m: 'POST', re: /^\/admin\/extend-agent-validity$/, portal: 'admin', kind: 'extend_agent_validity' },
    { m: 'POST', re: /^\/admin-entities\/[^/]+$/, portal: 'admin', kind: 'entity_save', summaryOnly: true },
    { m: 'POST', re: /^\/notifications$/, portal: 'admin', kind: 'notification' },
    { m: 'POST', re: /^\/site-data\/[^/]+$/, portal: 'admin', kind: 'site_data_save', summaryOnly: true }
];

function pickName(b) { return str(b.name || b.fullName || b.full_name || b.employeeName || b.agentName || b.studentName, 150); }

function mirrorMiddleware(getAuthUser) {
    return (req, res, next) => {
        if (!enabled || req.method === 'GET' || req.method === 'OPTIONS') return next();
        const hit = MIRRORS.find(x => x.m === req.method && x.re.test(req.path));
        if (!hit) return next();
        res.on('finish', () => {
            if (res.statusCode >= 400) return;
            try {
                const b = req.body || {};
                const auth = getAuthUser(req);
                const actor = auth ? str(auth.username || auth.userId, 80) : null;
                const payload = hit.summaryOnly ? { keys: Object.keys(b).slice(0, 50), path: req.path } : boundedPayload(b);
                if (hit.reg) {
                    insert('portal_registrations', { portal: hit.portal, full_name: pickName(b), mobile: str(b.mobile || b.phone, 20), email: str(b.email, 150), status: 'pending', payload, ip: ip(req) });
                } else {
                    insert('portal_submissions', { portal: hit.portal, kind: hit.kind, route: req.method + ' /api' + req.path, actor, actor_role: auth ? str(auth.role, 40) : null, payload, ip: ip(req) });
                }
            } catch (e) { logErr('mirror', e); }
        });
        next();
    };
}

// ── public index-page content (edited from Admin -> read live by index.html) ──
const SITE_KEYS = ['nav_buttons', 'login_options', 'homepage', 'apps', 'ticker', 'stats', 'footer',
    'index_overrides', 'live_dashboard', 'index_gallery', 'latest_updates', 'notices', 'kyc_performance_mode', 'index_about', 'index_theme'];
const BAD_SCHEME = /^\s*(javascript|vbscript|data):/i;
const IMG_DATA = /^\s*data:image\/(png|jpe?g|webp|gif);base64,/i;
function siteValueOk(v, key, depth) {          // rejects javascript:/data: links saved into public content
    depth = depth || 0;
    if (depth > 6 || v == null) return true;
    if (typeof v === 'string') {
        if (!BAD_SCHEME.test(v)) return true;
        return /image|img|logo|photo/i.test(key || '') && IMG_DATA.test(v);
    }
    if (Array.isArray(v)) return v.every(x => siteValueOk(x, key, depth + 1));
    if (typeof v === 'object') return Object.keys(v).every(k => siteValueOk(v[k], k, depth + 1));
    return true;
}
let siteCache = { at: 0, data: null };

// ── mount ──────────────────────────────────────────────────────────
function mount(app, deps) {
    const { getAuthUser, requireRole } = deps;
    const express = require('express');

    // 1) login attempt log (server-side, can't be spoofed by the browser)
    app.post(['/api/auth/login', '/api/material/login'], (req, res, next) => {
        if (!enabled) return next();
        const orig = res.json.bind(res);
        res.json = function (body) {
            try {
                const b = req.body || {};
                const portalByRole = { admin: 'admin', agent: 'agent', employee: 'hrms', staff: 'hrms', hr: 'hrms', pfms: 'pfms', student: 'student' };
                const portal = req.path.indexOf('material') !== -1 ? 'invoice' : (portalByRole[String(b.role || '').toLowerCase()] || str(b.role, 30) || 'unknown');
                insert('portal_login_attempts', {
                    portal, role: str(b.role, 30), username: maskId(b.username || b.userId || b.mobile),
                    success: res.statusCode < 400, reason: res.statusCode < 400 ? null : str(body && body.error, 200),
                    ip: ip(req), user_agent: str(req.headers['user-agent'], 250)
                });
            } catch (e) { logErr('login-log', e); }
            return orig(body);
        };
        next();
    });

    // 2) logout = revoke token + log
    app.post('/api/auth/logout', (req, res, next) => {
        const token = bearer(req);
        if (token && enabled) {
            const a = getAuthUser(req);
            revokeToken(token);
            insert('portal_sessions', { event: 'logout', role: a ? str(a.role, 40) : null, username: a ? str(a.username || a.userId, 80) : null, ip: ip(req) });
        } else if (token) { const d = jwt.decode(token); if (d) revoked.set(sha(token), d.exp ? d.exp * 1000 : Date.now() + 86400000); }
        next(); // existing route replies { success:true }
    });

    // 2b) validate public index content before the existing admin-only save route runs,
    //     and drop the read cache after a successful save so index.html sees it immediately
    app.post('/api/site-data/:key', (req, res, next) => {
        if (SITE_KEYS.indexOf(req.params.key) === -1) return next();
        const a = getAuthUser(req);
        if (!a || String(a.role).toLowerCase() !== 'admin') return next(); // existing route answers 401
        const v = (req.body || {}).value;
        if (JSON.stringify(v === undefined ? null : v).length > 3000000) return res.status(413).json({ error: 'The content is too large.' });
        if (!siteValueOk(v, req.params.key)) return res.status(400).json({ error: 'Unsafe links (javascript: or data:) are not allowed.' });
        res.on('finish', () => { if (res.statusCode < 400) siteCache = { at: 0, data: null }; });
        next();
    });

    // 3) mirror existing form submissions / registrations
    app.use('/api', mirrorMiddleware(getAuthUser));

    // 4) new endpoints
    const r = express.Router();
    r.use(rateLimit(60, 60 * 1000));
    const off = (req, res, next) => enabled ? next() : res.status(503).json({ error: 'Supabase is not configured (SUPABASE_URL / SUPABASE_KEY).' });

    r.get('/health', async (req, res) => {
        if (!enabled) return res.json({ supabase: 'disabled' });
        const { error } = await sb.from('portal_sessions').select('id', { head: true, count: 'exact' }).limit(1);
        res.status(error ? 500 : 200).json({ supabase: error ? 'error: ' + error.message : 'connected', portals: PORTALS });
    });

    // PUBLIC: everything index.html needs in one call (served via supabase-js, 10s cache)
    r.get('/site', off, rateLimit(120, 60 * 1000), async (req, res) => {
        res.set('Cache-Control', 'public, max-age=10');
        if (siteCache.data && Date.now() - siteCache.at < 10000) return res.json(siteCache.data);
        const { data, error } = await sb.from('kv_site_data').select('key,value').in('key', SITE_KEYS);
        if (error) { logErr('site', error); return res.status(500).json({ error: 'Unable to load the site data.' }); }
        const out = {};
        (data || []).forEach(row => { let v = row.value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) {} } out[row.key] = v; });
        siteCache = { at: Date.now(), data: out };
        res.json(out);
    });

    // Admin: role & location chosen in the post-login modal
    r.post('/session', off, requireRole('admin'), async (req, res) => {
        const role = String((req.body || {}).role || ''), location = String((req.body || {}).location || '');
        if (!SESSION_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
        if (!LOCATIONS.includes(location)) return res.status(400).json({ error: 'Invalid location.' });
        const a = req.authUser || getAuthUser(req);
        await insert('portal_sessions', { event: 'role_selected', role, location, username: str(a && a.username, 80), ip: ip(req) });
        res.json({ ok: true, next: role === 'pfms' ? 'pfms' : 'admin', location });
    });

    // Generic form submission (any portal)
    r.post('/submit', off, rateLimit(20, 60 * 1000), async (req, res) => {
        const b = req.body || {};
        const portal = String(b.portal || ''), kind = String(b.kind || '');
        if (!PORTALS.includes(portal)) return res.status(400).json({ error: 'Invalid portal.' });
        if (!/^[a-z0-9_-]{2,40}$/.test(kind)) return res.status(400).json({ error: 'Invalid kind.' });
        const a = getAuthUser(req);
        const { data, error } = await sb.from('portal_submissions').insert({
            portal, kind, route: 'POST /api/portal/submit', actor: a ? str(a.username || a.userId, 80) : null,
            actor_role: a ? str(a.role, 40) : null, payload: boundedPayload(b.payload), ip: ip(req)
        }).select('id').single();
        if (error) return res.status(500).json({ error: 'Unable to save.' });
        res.json({ ok: true, id: data.id });
    });

    // Student attendance (public / self-verifying like the existing page; rate-limited)
    r.post('/attendance', off, rateLimit(30, 60 * 1000), async (req, res) => {
        const list = Array.isArray((req.body || {}).records) ? req.body.records.slice(0, 200) : [];
        if (!list.length) return res.status(400).json({ error: 'records[] required.' });
        const ok = ['Present', 'Absent', 'Late'];
        const rows = [];
        for (const x of list) {
            const name = str(x && x.student_name, 150);
            const date = /^\d{4}-\d{2}-\d{2}$/.test(String(x && x.date)) ? x.date : todayIST();
            if (!name || !ok.includes(x.status)) continue;
            rows.push({ student_id: str(x.student_id, 60), student_name: name, att_date: date, batch: str(x.batch, 40) || '', status: x.status, marked_by: str(x.marked_by, 150), source: str(x.source, 30) || 'student_portal', updated_at: new Date().toISOString() });
        }
        if (!rows.length) return res.status(400).json({ error: 'No valid records.' });
        const { error } = await sb.from('portal_attendance').upsert(rows, { onConflict: 'student_name,att_date,batch' });
        if (error) { logErr('attendance', error); return res.status(500).json({ error: 'Unable to save the attendance record.' }); }
        res.json({ ok: true, saved: rows.length });
    });

    r.get('/attendance', off, requireRole('admin', 'agent', 'employee'), async (req, res) => {
        let q = sb.from('portal_attendance').select('*').order('att_date', { ascending: false }).limit(Math.min(parseInt(req.query.limit, 10) || 500, 2000));
        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) q = q.gte('att_date', req.query.from);
        if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) q = q.lte('att_date', req.query.to);
        if (req.query.batch) q = q.eq('batch', String(req.query.batch).slice(0, 40));
        if (req.query.student) q = q.ilike('student_name', '%' + String(req.query.student).replace(/[%_,()]/g, '').slice(0, 60) + '%');
        const { data, error } = await q;
        if (error) return res.status(500).json({ error: 'Query failed.' });
        res.json({ records: data });
    });

    // Admin summary for all 6 portals
    r.get('/summary', off, requireRole('admin'), async (req, res) => {
        const count = async (t, f) => { let q = sb.from(t).select('id', { count: 'exact', head: true }); if (f) q = f(q); const { count: c } = await q; return c || 0; };
        const out = { registrations: {}, submissions: {}, logins: {} };
        for (const p of PORTALS) {
            out.registrations[p] = await count('portal_registrations', q => q.eq('portal', p));
            out.submissions[p] = await count('portal_submissions', q => q.eq('portal', p));
            out.logins[p] = await count('portal_login_attempts', q => q.eq('portal', p).eq('success', true));
        }
        out.attendance_rows = await count('portal_attendance');
        res.json(out);
    });

    app.use('/api/portal', r);
    loadRevoked();
    console.log('✅ Supabase portal layer ' + (enabled ? 'enabled' : 'disabled') + ' (/api/portal/*)');
}

function logSession(row) { return insert('portal_sessions', { event: str(row.event, 40), role: str(row.role, 40), location: str(row.location, 80), username: str(row.username, 80), ip: str(row.ip, 64) }); }
module.exports = { mount, isRevoked, enabled, PORTALS, logSession };
