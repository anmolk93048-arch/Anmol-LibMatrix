'use strict';
/* Anmol LibMatrix — account & session security.
 *
 *  1. GLOBAL LOGOUT ON PASSWORD CHANGE — every identity gets a "sessions valid after" timestamp. A JWT issued
 *     before it is rejected instantly (401 SESSION_REVOKED) on every API call from every browser/device.
 *     Persisted in kv_site_data so it survives restarts. Bumped by: POST /api/auth/change-password, OTP password
 *     reset, an admin editing someone's password, PFMS / Material password updates (hooks in recycle.js).
 *  2. SERVER-SIDE IDLE TIMEOUT — browser pages send `X-Anmol-Idle: 1` and a heartbeat (POST /api/auth/ping) while the
 *     user is really active. If a token's last heartbeat is older than IDLE_TIMEOUT_MIN (default 15) the next request is
 *     rejected with 401 SESSION_IDLE — so a tab that was closed and reopened later cannot resume the old session.
 *     (Mobile apps do not send the header and are not subject to the idle gate.)
 *  3. POST /api/auth/change-password — verifies the CURRENT password on the server (bcrypt) for the logged-in account.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function create(ctx) {
    const IDLE_MS = (Number(process.env.IDLE_TIMEOUT_MIN) || 15) * 60 * 1000;
    const lc = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
    const sha = function (t) { return crypto.createHash('sha256').update(t).digest('hex'); };
    const validAfter = new Map();      // identity → unix seconds
    const idle = new Map();            // sha256(token) → { last, exp }
    const KEY = 'sessions_valid_after';
    let saveTimer = null;

    function idsOf(dec) { return [dec && dec.username, dec && dec.via, dec && dec.userId].filter(Boolean).map(lc); }
    function isStale(dec) {
        if (!dec || !dec.iat) return false;
        const ids = idsOf(dec);
        for (let i = 0; i < ids.length; i++) { const va = validAfter.get(ids[i]); if (va && dec.iat < va) return true; }
        return false;
    }
    async function load() {
        try {
            const r = await ctx.dbq('SELECT value FROM kv_site_data WHERE `key` = ?', [KEY]);
            const o = JSON.parse((r[0] && r[0].value) || '{}') || {};
            Object.keys(o).forEach(function (k) { validAfter.set(k, Number(o[k]) || 0); });
            return true;
        } catch (e) { return false; /* table not ready yet — retried by caller */ }
    }
    function persist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async function () {
            const cutoff = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;      // tokens live ≤ 7 days: older marks are useless
            const o = {};
            validAfter.forEach(function (v, k) { if (v >= cutoff) o[k] = v; else validAfter.delete(k); });
            try { await ctx.dbq('INSERT INTO kv_site_data ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', [KEY, JSON.stringify(o)]); }
            catch (e) { console.error('sessions_valid_after save failed:', e.message); }
        }, 150);
    }
    /** Invalidate every token ever issued to any of these identities (username / email / id / agentId / empId / userid). */
    function bump(identities) {
        const now = Math.floor(Date.now() / 1000);
        (identities || []).map(lc).filter(Boolean).forEach(function (i) { validAfter.set(i, now); });
        persist();
    }

    function middleware(req, res, next) {
        const h = req.headers.authorization || '';
        if (!/^Bearer\s+\S+/i.test(h)) return next();
        const token = h.slice(7).trim();
        let dec;
        try { dec = ctx.jwt.verify(token, ctx.getSecret()); } catch (e) { return next(); }      // invalid → downstream decides
        if (isStale(dec)) return res.status(401).json({ error: 'Your password was changed. Please log in again.', code: 'SESSION_REVOKED' });
        if (req.headers['x-anmol-idle'] === '1') {
            const k = sha(token), now = Date.now(), ent = idle.get(k);
            if (ent && now - ent.last > IDLE_MS) { idle.delete(k); return res.status(401).json({ error: 'Your session expired due to inactivity. Please log in again.', code: 'SESSION_IDLE' }); }
            if (!ent || req.path === '/api/auth/ping') {
                if (idle.size > 50000) idle.delete(idle.keys().next().value);
                idle.set(k, { last: now, exp: (dec.exp || 0) * 1000 });
            }
        }
        next();
    }
    setInterval(function () { const n = Date.now(); idle.forEach(function (v, k) { if (v.exp && v.exp < n) idle.delete(k); }); }, 30 * 60 * 1000).unref();

    async function locate(auth) {
        const role = lc(auth.role), me = lc(auth.via || auth.username || auth.userId);
        if (role === 'pfms') {
            const r = await ctx.dbq('SELECT * FROM pfms_users WHERE username = ?', [auth.username]);
            return r[0] ? { kind: 'pfms', row: r[0], hash: r[0].password_hash, ids: [r[0].username] } : null;
        }
        if (role === 'material_user') {
            const r = await ctx.dbq('SELECT * FROM material_users WHERE userid = ?', [auth.userId]);
            return r[0] ? { kind: 'material', row: r[0], hash: r[0].password_hash, ids: [r[0].userid, r[0].id] } : null;
        }
        const entity = ctx.AUTH_ENTITY_FOR_ROLE[role];
        if (!entity) return null;
        const list = await ctx.readEntity(entity);
        const idx = list.findIndex(function (u) { return u && [u.username, u.email, u.id, u.agentId, u.empId].some(function (f) { return f && lc(f) === me; }); });
        if (idx < 0) return null;
        const rec = list[idx];
        return { kind: 'entity', entity: entity, list: list, idx: idx, rec: rec, hash: rec.password, ids: [rec.username, rec.email, rec.id, rec.agentId, rec.empId] };
    }

    function mount(app) {
        app.use(middleware);
        app.post('/api/auth/ping', function (req, res) {
            const a = ctx.getAuthUser(req);
            if (!a) return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'SESSION_INVALID' });
            res.set('Cache-Control', 'no-store').json({ ok: true, idleMs: IDLE_MS });
        });
        app.post('/api/auth/change-password', ctx.asyncRoute(async function (req, res) {
            const auth = ctx.getAuthUser(req);
            if (!auth) return res.status(401).json({ error: 'Session expired. Please log in again.' });
            const b = req.body || {};
            const cur = String(b.currentPassword == null ? '' : b.currentPassword), nw = String(b.newPassword == null ? '' : b.newPassword);
            if (!cur || !nw) return res.status(400).json({ error: 'Please fill in all fields.' });
            if (nw.length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
            if (nw === cur) return res.status(400).json({ error: 'The new password must be different from the current password.' });
            if (auth.gate && auth.via && lc(auth.via) !== lc(auth.username) && lc(auth.role) !== 'admin')
                return res.status(403).json({ error: 'Open this account from its own login page to change its password.' });
            if (ctx.hitRateLimit('chpw:' + lc(auth.via || auth.username || auth.userId), 8, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
            const acc = await locate(auth);
            if (!acc) return res.status(404).json({ error: 'Account not found for this session.' });
            const stored = String(acc.hash || '');
            const good = !stored ? false : (ctx.looksHashed(stored) ? bcrypt.compareSync(cur, stored) : ctx.safeEqual(stored, cur));
            if (!good) return res.status(401).json({ error: 'The current password is incorrect.' });
            const hash = bcrypt.hashSync(nw, 10);
            if (acc.kind === 'entity') { acc.list[acc.idx] = Object.assign({}, acc.rec, { password: hash }); await ctx.writeEntity(acc.entity, acc.list); }
            else if (acc.kind === 'pfms') await ctx.dbq('UPDATE pfms_users SET password_hash = ? WHERE id = ?', [hash, acc.row.id]);
            else await ctx.dbq('UPDATE material_users SET password_hash = ? WHERE id = ?', [hash, acc.row.id]);
            bump(acc.ids.concat([auth.username, auth.via, auth.userId]));
            ctx.clearCookie(res);
            res.json({ success: true, relogin: true, message: 'Password changed. All your sessions on every browser and device have been signed out — please log in again.' });
        }));
    }
    return { mount: mount, bump: bump, load: load, isStale: isStale, IDLE_MS: IDLE_MS };
}
module.exports = { create: create };
