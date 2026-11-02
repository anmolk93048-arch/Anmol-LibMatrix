'use strict';
/* Anmol LibMatrix — route masking.
 *
 *  Portal pages are no longer reachable at predictable paths. Each browser session gets its own set of
 *  encrypted, random-looking links:   /app/<66 hex chars>
 *
 *  Token = AES-256-GCM( portalIndex | sessionId | expiry ) with a random 96-bit IV, so the same portal gets a
 *  different URL every time it is issued, nothing about the portal can be read from the string, and forged or
 *  tampered tokens fail authentication. Tokens are stateless (survive Render restarts) and expire (NAV_TTL_HOURS,
 *  default 24). The key is derived from JWT_SECRET, so rotating that secret also invalidates every link.
 *
 *  • Old paths (/admin-login, /agent, /Admin_Login.html, /api/pages/admin-login …) answer 404.
 *  • Only the public home page ("/") is a fixed URL; it hands out the links for the session.
 *  • Relative asset requests made from a masked page (/app/config.js …) are served from the site root,
 *    so the pages keep working unchanged. Portal HTML is never served through that path.
 *
 *  Honest limits: this hides and de-fingerprints the pages (scanners, bookmarks, shoulder-surfing, "guess /admin").
 *  It is NOT authentication — anyone who loads the home page can obtain a link to a public login screen, exactly as
 *  before. Real protection is still login + rate limiting + JWT checks on every API.
 */
const crypto = require('crypto');
const fs = require('fs');

const PORTALS = {
    admin:     { file: 'Admin_Login.html',            slug: 'admin-login',     page: 'admin_login.html' },
    dashboard: { file: 'Super_Admin_Dashboard.html',  slug: 'admin-dashboard', page: 'super_admin_dashboard.html' },
    agent:     { file: 'Agent_Login.html',            slug: 'agent-login',     page: 'agent_login.html' },
    hrms:      { file: 'HRMS_login.html',             slug: 'hrms-login',      page: 'hrms_login.html' },
    student:   { file: 'Student_Attendance.html',     slug: 'student-login',   page: 'student_attendance.html' },
    pfms:      { file: 'PFMS_login.html',             slug: 'pfms-login',      page: 'pfms_login.html' },
    invoice:   { file: 'INVOICE_LOGIN.html',          slug: 'invoice-login',   page: 'invoice_login.html' }
};
const KEYS = Object.keys(PORTALS);

// every legacy / alias name that must stop resolving (and that old CMS data or role targets may still contain)
const ALIAS = {};
function alias(key, names) { names.forEach(function (n) { ALIAS[n] = key; }); }
alias('admin', ['admin-login', 'admin_login', 'admin', 'super-admin', 'super-admin-login', 'super_admin_login', 'superadmin', 'admin-panel-login', 'admin_panel_login', 'new-admin-login', 'new_admin_login']);
alias('dashboard', ['admin-dashboard', 'dashboard', 'super-admin-dashboard', 'super_admin_dashboard']);
alias('agent', ['agent-login', 'agent_login', 'agent']);
alias('hrms', ['hrms-login', 'hrms_login', 'hrms']);
alias('student', ['student-login', 'student_login', 'student', 'student-attendance', 'student_attendance', 'student_attendance_portal']);
alias('pfms', ['pfms-login', 'pfms_login', 'pfms']);
alias('invoice', ['invoice-login', 'invoice_login', 'invoice', 'anmol_material_entry', 'anmol_material_login']);
KEYS.forEach(function (k) { ALIAS[k] = k; ALIAS[PORTALS[k].file.toLowerCase().replace(/\.html$/, '')] = k; });

function resolveKey(s) {
    let t = String(s == null ? '' : s).trim().toLowerCase();
    t = t.replace(/^nav:/, '').split(/[?#]/)[0].replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.html?$/, '');
    return ALIAS[t] || null;
}

const TOKEN_RE = /^[0-9a-f]{66}$/;
const ASSET_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|txt|xml|webmanifest|json|pdf)$/i;

function create(ctx) {
    const ttlHours = Math.max(1, parseInt(process.env.NAV_TTL_HOURS || ctx.ttlHours || '24', 10) || 24);
    let _key = null;
    const key = function () { return _key || (_key = crypto.createHash('sha256').update('anmol-nav-v1|' + ctx.getSecret()).digest()); };
    const hourNow = function () { return Math.floor(Date.now() / 3600000); };

    function issue(portalKey, sid) {
        const idx = KEYS.indexOf(portalKey);
        if (idx < 0) return null;
        const payload = Buffer.alloc(13);
        payload[0] = idx;
        (sid || crypto.randomBytes(8)).copy(payload, 1);
        payload.writeUInt32BE(hourNow() + ttlHours, 9);
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key(), iv, { authTagLength: 8 });
        const ct = Buffer.concat([c.update(payload), c.final()]);
        return Buffer.concat([iv, ct, c.getAuthTag()]).toString('hex');       // 12 + 13 + 8 = 33 bytes → 66 hex chars
    }
    function parse(token) {
        if (!TOKEN_RE.test(String(token || ''))) return null;
        try {
            const raw = Buffer.from(token, 'hex');
            const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12), { authTagLength: 8 });
            d.setAuthTag(raw.subarray(25));
            const p = Buffer.concat([d.update(raw.subarray(12, 25)), d.final()]);
            if (p.readUInt32BE(9) < hourNow()) return null;                     // expired
            const k = KEYS[p[0]];
            return k ? { key: k, sid: Buffer.from(p.subarray(1, 9)) } : null;
        } catch (e) { return null; }
    }
    const urlFor = function (portalKey, sid) { const t = issue(portalKey, sid); return t ? '/app/' + t : null; };
    function mapFor(sid) { sid = sid || crypto.randomBytes(8); const m = {}; KEYS.forEach(function (k) { m[k] = urlFor(k, sid); }); return m; }

    // ── legacy-path guard ──
    const LEGACY = {};
    Object.keys(ALIAS).forEach(function (n) { LEGACY[n] = 1; });
    PORTALS && KEYS.forEach(function (k) { LEGACY[PORTALS[k].slug] = 1; });
    function legacyName(p) {
        let s; try { s = decodeURIComponent(p); } catch (e) { return false; }
        s = s.toLowerCase().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
        const seg = s.split('/');
        let name = null;
        if (seg.length === 1) name = seg[0];
        else if (seg.length === 3 && seg[0] === 'api' && seg[1] === 'pages') name = seg[2];
        else if (seg.length === 2 && seg[0] === 'app') name = null;               // handled by the /app router
        if (!name) return false;
        name = name.replace(/\.html?$/, '');
        return !!LEGACY[name];
    }
    function guard(req, res, next) {
        if ((req.method === 'GET' || req.method === 'HEAD') && legacyName(req.path)) return ctx.notFound(req, res);
        next();
    }

    // ── page loading (local file first, then an admin-uploaded copy in the database) ──
    const cache = new Map();   // file → { mtime, buf, headEnd }
    function headEndOf(buf) {
        const m = /<head[^>]*>/i.exec(buf.toString('latin1', 0, Math.min(buf.length, 4000)));
        return m ? m.index + m[0].length : 0;
    }
    function load(fileName, slug, cb) {
        const f = ctx.findStaticFile(fileName);
        if (f) {
            try {
                const st = fs.statSync(f), c = cache.get(f);
                if (c && c.mtime === st.mtimeMs) return cb(null, c);
                const buf = fs.readFileSync(f), ent = { mtime: st.mtimeMs, buf: buf, headEnd: headEndOf(buf) };
                cache.set(f, ent);
                return cb(null, ent);
            } catch (e) { return cb(e); }
        }
        if (!slug || !ctx.getDbPage) return cb(null, null);
        ctx.getDbPage(slug, function (err, buf) { if (err || !buf) return cb(err, null); buf = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)); cb(null, { buf: buf, headEnd: headEndOf(buf) }); });
    }
    function send(req, res, ent, pageName, sid) {
        const inj = Buffer.from('<script>window.__ANMOL_NAV=' + JSON.stringify(mapFor(sid)) + ';window.__ANMOL_NAV_TS=' + Date.now() + ';window.__ANMOL_PAGE=' + JSON.stringify(pageName) + ';</script><script src="/nav-mask.js"></script><script src="/idle-guard.js"></script>', 'utf8');
        res.status(200);
        res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'same-origin', 'Content-Length': String(ent.buf.length + inj.length) });
        if (req.method === 'HEAD') return res.end();
        res.write(ent.buf.subarray(0, ent.headEnd));
        res.write(inj);
        res.end(ent.buf.subarray(ent.headEnd));
    }

    function mount(app) {
        // public: fresh link set for this session (used by the home page / cross-origin front-ends)
        app.get('/api/nav/map', function (req, res) {
            if (ctx.hitRateLimit && ctx.hitRateLimit('nav-map:' + (req.ip || ''), 120, 60 * 1000)) return res.status(429).json({ error: 'Too many requests.' });
            res.set('Cache-Control', 'no-store').json({ map: mapFor(), ts: Date.now() });
        });
        // the masked pages + the assets they request relatively
        app.get('/app/*', function (req, res, next) {
            const rest = req.path.slice(5);
            const seg = rest.split('/');
            if (seg.length === 1 && TOKEN_RE.test(seg[0])) {
                const t = parse(seg[0]);
                if (!t) return ctx.notFound(req, res);
                const pg = PORTALS[t.key];
                return load(pg.file, pg.slug, function (err, ent) {
                    if (err || !ent) return ctx.notFound(req, res);
                    send(req, res, ent, pg.page, t.sid);
                });
            }
            if (TOKEN_RE.test(seg[0])) seg.shift();                                // /app/<token>/asset.js (trailing-slash form)
            const name = seg.join('/');
            if (!name) return ctx.notFound(req, res);
            if (/^index(\.html)?$/i.test(name)) return res.redirect(302, '/' + (req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : ''));
            if (!ASSET_EXT.test(name) || !ctx.isSafeRootStaticPath('/' + name) || legacyName('/' + name)) return ctx.notFound(req, res);
            const f = ctx.findStaticFile(name);
            if (!f) return ctx.notFound(req, res);
            res.set('Cache-Control', 'public, max-age=3600');
            res.sendFile(f);
        });
    }
    // home page ("/"): the only fixed URL. Gets a fresh set of masked links.
    function sendHome(req, res, file) {
        load(file, null, function (err, ent) {
            if (err || !ent) return res.status(500).send('Home page unavailable.');
            send(req, res, ent, 'index.html', null);
        });
    }
    return { guard: guard, mount: mount, sendHome: sendHome, urlFor: urlFor, mapFor: mapFor, issue: issue, parse: parse, resolveKey: resolveKey, KEYS: KEYS };
}

module.exports = { create: create, resolveKey: resolveKey, KEYS: KEYS, PORTALS: PORTALS };
