'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// server.js — SAFE ENTRY POINT  (the real application now lives in app-main.js)
//
// Why: on Vercel a single error while loading ANY module / the database layer used to kill the whole function
//      ("FUNCTION_INVOCATION_FAILED", HTTP 500). Now the real app is loaded inside try/catch:
//        • success → `module.exports = app` (the full Express app, behaves exactly as before)
//        • failure → the full error + stack is printed to the logs, and a tiny fallback handler is exported instead:
//              /                  → index.html (the page still loads)
//              /api/boot-status   → JSON with the sanitized reason + which files / packages are missing
//              /api/health        → 503 JSON (same info)
//              everything else    → 503 JSON "temporarily unavailable"
//          The fallback uses only Node built-ins, so it works even if express itself is not installed.
// 🆕 ZERO-CONFIG: the live domain is detected per request (see "ZERO-CONFIG LIVE ORIGIN" below) — no BASE_URL env var needed.
// Render / local: `node server.js` still works (app-main.js starts the listener itself).
// ══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

if (require.main === module) process.env.AM_STANDALONE = '1';   // tell app-main.js it must open the port itself (Render / local)
const IS_VERCEL = !!(process.env.VERCEL || process.env.VERCEL_ENV);

// Last-resort process guards (app-main.js registers its own too; these cover the moment BEFORE it loads).
process.on('uncaughtException', (err) => { console.error('🚨 UNCAUGHT EXCEPTION (crash prevented):', err && err.stack || err); });
process.on('unhandledRejection', (reason) => { console.error('🚨 UNHANDLED REJECTION (crash prevented):', reason); });

// ──────────────────────────────────────────────────────────────────────────────
// ZERO-CONFIG LIVE ORIGIN — no BASE_URL / domain env var is ever needed.
// On EVERY request the current public origin (https://<current-host>) is detected from the request itself:
//   • req.liveOrigin                 → available in every Express route / middleware of app-main.js
//   • global.getLiveOrigin()         → same value anywhere (even deep inside helper modules, via AsyncLocalStorage)
//   • global.liveUrl('/path')        → full absolute URL on the current domain (SMS / WhatsApp / e-mail links, redirects)
//   • GET /api/live-origin           → { origin } for the frontend (works even in fallback mode)
// Masked / alphabetical paths (/admin-login …) are NOT touched: they stay exactly as app-main.js defines them,
// only the host part is taken from the live request.
// Safety: the host is format-validated (blocks Host-header injection like "evil.com/x" or "a b"). Optional hardening:
// set ALLOWED_HOSTS="mysite.com,*.vercel.app" and any other host is ignored (falls back to the plain Host header).
// ──────────────────────────────────────────────────────────────────────────────
const { AsyncLocalStorage } = require('async_hooks');
const liveCtx = new AsyncLocalStorage();
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;
const LOCAL_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;
const firstVal = (v) => String(Array.isArray(v) ? v[0] : (v || '')).split(',')[0].trim();

function hostAllowed(host) {
    const list = String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return true;
    const h = host.toLowerCase().replace(/:\d+$/, '');
    return list.some((p) => p === h || (p.startsWith('*.') && h.endsWith(p.slice(1))));
}

function detectOrigin(req) {
    try {
        const h = req.headers || {};
        let host = firstVal(h['x-forwarded-host']) || firstVal(h.host);
        if (!HOST_RE.test(host) || !hostAllowed(host)) host = firstVal(h.host);
        if (!HOST_RE.test(host)) return null;
        let proto = firstVal(h['x-forwarded-proto']).toLowerCase();
        if (proto !== 'http' && proto !== 'https') proto = (req.socket && req.socket.encrypted) ? 'https' : 'http';
        if (!LOCAL_RE.test(host) && (IS_VERCEL || proto === 'https')) proto = 'https';   // real domains are always https
        return proto + '://' + host;
    } catch (e) { return null; }
}

global.getLiveOrigin = () => { const s = liveCtx.getStore(); return (s && s.origin) || null; };
global.liveUrl = (p) => {
    const o = global.getLiveOrigin() || '';
    const s = String(p == null ? '/' : p);
    return o + (s.startsWith('/') ? s : '/' + s);
};

// Safety net while old code / old env vars still exist: if some redirect points at a STALE absolute domain taken from
// BASE_URL-style env vars, rewrite only its origin to the live one (path, query and masked URLs stay untouched).
const LEGACY_ENV = ['BASE_URL', 'PUBLIC_URL', 'SITE_URL', 'APP_URL', 'LIVE_HOME_URL', 'FRONTEND_URL', 'CLIENT_URL'];
function legacyHosts() {
    const out = new Set();
    for (const k of LEGACY_ENV) { try { if (process.env[k]) out.add(new URL(process.env[k]).host.toLowerCase()); } catch (e) { /* not a URL */ } }
    return out;
}
function patchLocationHeader(res, origin) {
    if (!origin || res.__liveLocPatched) return;
    res.__liveLocPatched = true;
    const orig = res.setHeader;
    res.setHeader = function (name, value) {
        try {
            if (typeof name === 'string' && name.toLowerCase() === 'location' && typeof value === 'string' && /^https?:\/\//i.test(value)) {
                const u = new URL(value);
                if (legacyHosts().has(u.host.toLowerCase()) && u.origin !== origin) value = origin + u.pathname + u.search + u.hash;
            }
        } catch (e) { /* leave header unchanged */ }
        return orig.call(this, name, value);
    };
}

// A browser page navigation (not an API / fetch call): these get a redirect to the home page instead of a raw JSON error.
function wantsHtml(req) {
    try {
        const u = String(req.url || '/').split('?')[0];
        return (req.method === 'GET' || req.method === 'HEAD') && /text\/html/i.test(String((req.headers || {}).accept || '')) && !/^\/(api|_am)\//.test(u);
    } catch (e) { return false; }
}
function softRedirectHome(res) { res.statusCode = 302; res.setHeader('Location', '/'); res.setHeader('Cache-Control', 'no-store'); res.end(); }

// Wraps any (req,res) handler: detects the origin, exposes it everywhere, answers /api/live-origin, and guarantees that
// a synchronous crash inside the handler returns a clean 503 instead of killing the serverless function.
function withLiveOrigin(inner) {
    if (inner && inner.__live) return inner;
    const handler = function liveHandler(req, res) {
        const origin = detectOrigin(req);
        req.liveOrigin = origin;
        try {
            const u = String(req.url || '/').split('?')[0];
            if (u === '/api/live-origin' && (req.method === 'GET' || req.method === 'HEAD')) {
                res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
                return res.end(req.method === 'HEAD' ? '' : JSON.stringify({ origin }));
            }
            patchLocationHeader(res, origin);
            return liveCtx.run({ origin }, () => inner(req, res));
        } catch (e) {
            console.error('🚨 REQUEST HANDLER CRASH (contained):', e && e.stack || e);
            try {
                if (res.headersSent) res.end();
                else if (wantsHtml(req) && String(req.url || '/').split('?')[0] !== '/') softRedirectHome(res);   // browser navigation → home page, never a raw JSON error
                else { res.statusCode = 503; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: 'The service is temporarily unavailable. Please try again shortly.' })); }
            } catch (e2) { /* nothing more to do */ }
        }
    };
    handler.__live = true;
    return handler;
}

// Render / local: app-main.js opens the port itself (app.listen → http.createServer(app)), bypassing module.exports.
// Wrap the listener it registers so the live-origin logic applies there too.
if (require.main === module) {
    const http = require('http');
    const realCreate = http.createServer;
    http.createServer = function (...args) {
        const i = typeof args[0] === 'function' ? 0 : (typeof args[1] === 'function' ? 1 : -1);
        if (i >= 0) args[i] = withLiveOrigin(args[i]);
        return realCreate.apply(this, args);
    };
}

// Deployment self-check: which project files / npm packages are missing from this deployment?
const NEED_FILES = ['app-main.js', 'supabase-portals.js', 'security.js', 'route-mask.js', 'dv-invoice-module.js', 'account-security.js', 'recycle.js', 'index.html', 'package.json'];
const NEED_PKGS = ['express', 'pg', 'cors', 'body-parser', 'jsonwebtoken', 'bcryptjs', 'multer'];
function preflight() {
    const missingFiles = NEED_FILES.filter((f) => { try { return !fs.existsSync(path.join(__dirname, f)); } catch (e) { return true; } });
    const missingPackages = NEED_PKGS.filter((m) => { try { require.resolve(m, { paths: [__dirname] }); return false; } catch (e) { return true; } });
    return { missingFiles, missingPackages };
}
const redact = (t) => String(t == null ? '' : t)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi, '[hidden-url]')   // connection strings with credentials
    .split('\n')[0]                                                         // first line only (no require-stack / file paths)
    .slice(0, 300);

let app = null, bootError = null, bootInfo = null, lastBootTry = 0;
function tryBoot() {
    lastBootTry = Date.now();
    try {
        const a = require('./app-main.js');   // a failed require is NOT cached by Node, so calling this again really retries
        if (typeof a !== 'function') throw new Error('app-main.js did not export the Express app (module.exports = app is missing).');
        app = a; bootError = null; bootInfo = null;
        return true;
    } catch (e) {
        bootError = e;
        try { bootInfo = preflight(); } catch (e2) { bootInfo = {}; }
        console.error('🚨 BOOT FAILED — the app could not be loaded. Serving the safe fallback instead of crashing.');
        console.error('   reason :', e && e.stack || e);
        console.error('   preflight:', JSON.stringify(bootInfo));
        if (e && e.code === 'MODULE_NOT_FOUND') console.error('   → a file or npm package is missing from this deployment. Check package.json dependencies and vercel.json includeFiles.');
        return false;
    }
}
tryBoot();

// ── Fallback that still opens the REAL login forms ───────────────────────────────────────────────────────────────────
// While app-main.js is not running (boot failed / retrying), /go/<portal> and /app/<token> serve the portal's static HTML file straight
// from disk (Admin_Login.html, Agent_Login.html, HRMS_login.html …) instead of bouncing the user to the home page. Tokens are stateless
// (decrypted with JWT_SECRET, no database), so a slow or unreachable database cannot affect them.
const FB_BACKEND_FILES = new Set(['app-main.js', 'server.js', 'security.js', 'route-mask.js', 'supabase-portals.js', 'dv-invoice-module.js', 'account-security.js', 'recycle.js', 'package.json', 'package-lock.json', 'vercel.json']);
const FB_ASSET_RE = /\.(css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|txt|xml|webmanifest|json|pdf)$/i;
function fbDirs() { return [__dirname, path.join(__dirname, 'public'), path.join(__dirname, 'frontend'), path.join(__dirname, 'dist'), path.join(__dirname, 'static')]; }
function fbFind(name) {
    for (const d of fbDirs()) {
        try {
            const exact = path.join(d, name);
            if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;
            const hit = fs.readdirSync(d).find((f) => f.toLowerCase() === String(name).toLowerCase());
            if (hit && fs.statSync(path.join(d, hit)).isFile()) return path.join(d, hit);
        } catch (e) { /* next dir */ }
    }
    return null;
}
function fbPortalFile(key) {
    try { const RM = require('./route-mask.js'); const pg = RM.PORTALS[key]; return pg ? fbFind(pg.file) : null; } catch (e) { return null; }
}
function fbKeyFromToken(token) {
    try {
        const secret = process.env.JWT_SECRET; if (!secret) return null;
        const RM = require('./route-mask.js');
        return RM.create({ getSecret: () => secret }).parse(token); // { key, sid } or null
    } catch (e) { return null; }
}
const FB_BANNER = '<script>(function(){function b(){var d=document.createElement("div");d.textContent="The server is restarting — sign-in may take a moment. Please retry in a few seconds.";d.style.cssText="position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#fff3cd;color:#664d03;font:13px Arial;padding:6px 10px;text-align:center";document.body.appendChild(d);setTimeout(function(){d.remove()},15000)}if(document.body)b();else document.addEventListener("DOMContentLoaded",b)})();</script>';
function fbSendPortal(req, res, file) {
    let buf = fs.readFileSync(file);
    if (req.method !== 'HEAD') { const html = buf.toString('utf8'); buf = Buffer.from(/<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, FB_BANNER + '</body>') : html + FB_BANNER, 'utf8'); }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive'); res.setHeader('X-AM-Fallback', '1');
    res.end(req.method === 'HEAD' ? '' : buf);
}
// returns true when the request was answered
function fbServe(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let m = /^\/go\/([A-Za-z0-9_-]+)\/?$/.exec(url);
    if (m) {
        let key = null; try { key = require('./route-mask.js').resolveKey(m[1]); } catch (e) { /* ignore */ }
        const f = key && fbPortalFile(key);
        if (!f) return false;
        // 🕶️ keep the address bar masked: mint a fresh encrypted /app/<66-hex> link (needs only JWT_SECRET, no database) and redirect to it
        const secret = process.env.JWT_SECRET;
        if (secret && secret.length >= 32) {
            try { const u = require('./route-mask.js').create({ getSecret: () => secret }).urlFor(key); if (u) { res.statusCode = 302; res.setHeader('Location', u); res.setHeader('Cache-Control', 'no-store'); res.end(); return true; } } catch (e) { /* serve in place below */ }
        }
        fbSendPortal(req, res, f);   // JWT_SECRET missing → no token can be minted; the form still opens (at /go/<portal>)
        return true;
    }
    m = /^\/app\/([^/]+)(?:\/(.+))?$/.exec(url);
    if (!m) return false;
    if (/^[0-9a-f]{66}$/.test(m[1]) && !m[2]) {
        const t = fbKeyFromToken(m[1]); const f = t && fbPortalFile(t.key);
        if (f) { fbSendPortal(req, res, f); return true; }
        return false;
    }
    const name = /^[0-9a-f]{66}$/.test(m[1]) ? m[2] : (m[2] ? m[1] + '/' + m[2] : m[1]);   // /app/<token>/x.js and /app/x.js → asset x.js from the site root
    if (!name || name.indexOf('..') >= 0 || !FB_ASSET_RE.test(name) || FB_BACKEND_FILES.has(name.toLowerCase())) return false;
    const f = fbFind(name);
    if (!f) return false;
    res.statusCode = 200; res.setHeader('Content-Type', ({ '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain', '.pdf': 'application/pdf' }[path.extname(f).toLowerCase()] || 'application/octet-stream'));
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? '' : fs.readFileSync(f));
    return true;
}

function fallbackHandler(req, res) {
    try {
        // self-heal: the real app may only have failed on a transient problem (cold start, database not ready yet) → retry at most every 15 s
        if (app || (Date.now() - lastBootTry > 15000 && tryBoot())) return app(req, res);   // already recovered → always hand over to the real app
        const url = String(req.url || '/').split('?')[0];
        if (fbServe(req, res, url)) return;   // login form / its assets straight from disk
        const status = {
            ok: false, boot: 'failed',
            reason: redact(bootError && (bootError.message || bootError)),
            where: (function () { try { const m = /\n\s+at (?:.*?\()?([^()\n]+?):(\d+):\d+\)?/.exec(String(bootError && bootError.stack || '')); return m ? path.basename(m[1]) + ':' + m[2] : null; } catch (e) { return null; } })(),
            code: bootError && bootError.code || null,
            missingFiles: (bootInfo && bootInfo.missingFiles) || [],
            missingPackages: (bootInfo && bootInfo.missingPackages) || [],
            hint: 'Open the Vercel dashboard → Deployments → Functions/Logs for the full error, fix it, then redeploy.'
        };
        const send = (code, type, body) => { res.statusCode = code; res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store'); res.end(body); };
        if (url === '/api/boot-status' || url === '/api/health') return send(url === '/api/health' ? 503 : 200, 'application/json; charset=utf-8', JSON.stringify(status));
        if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/' || url === '/index.html')) {
            const f = path.join(__dirname, 'index.html');
            if (fs.existsSync(f)) return send(200, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : fs.readFileSync(f));
            return send(503, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Temporarily unavailable</title><body style="font-family:Arial;padding:40px"><h2>Service temporarily unavailable</h2><p>Please try again in a few minutes.</p></body>');
        }
        if (wantsHtml(req)) return softRedirectHome(res);   // /go/…, /app/… and any other page → the home page (which is served above), not a JSON error
        return send(503, 'application/json; charset=utf-8', JSON.stringify({ error: 'The service is temporarily unavailable. Please try again shortly.', code: 'BOOT_FAILED', reason: status.reason, where: status.where }));   // reason/where = sanitized boot error (same as /api/boot-status)
    } catch (e) {
        try { res.statusCode = 503; res.end('Service temporarily unavailable'); } catch (e2) { /* nothing more to do */ }
    }
}

if (app) {
    module.exports = withLiveOrigin(app);   // ▲ Vercel entry point — the real Express app, wrapped with live-origin detection + crash containment
    // keep Express's own properties reachable for anything that does `require('./server').use / .listen / .get`
    for (const k of ['use', 'get', 'post', 'listen', 'set', 'locals', 'handle']) { try { if (app[k] !== undefined) module.exports[k] = typeof app[k] === 'function' ? app[k].bind(app) : app[k]; } catch (e) { /* ignore */ } }
} else {
    module.exports = withLiveOrigin(fallbackHandler);   // ▲ boot failed — still a valid (req, res) handler, so the function does not crash
    if (require.main === module && !IS_VERCEL) {   // Render / local: keep the port open so the platform does not restart-loop
        require('http').createServer(module.exports).listen(process.env.PORT || 3000, () => console.log('⚠️ Fallback server listening — see the boot error above.'));
    }
}
