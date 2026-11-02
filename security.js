'use strict';
/* Anmol LibMatrix — security hardening layer (drop next to server.js).
 *
 *  1. HTTP-only session cookie  (JWT never needs to be readable by JavaScript / DevTools → XSS can't steal it)
 *  2. CSRF defence for cookie-authenticated writes (Origin / Fetch-Metadata check against the CORS allow-list)
 *  3. express-rate-limit on every login endpoint: 5 consecutive failures per IP+account → 429 for 15 minutes
 *  4. Baseline security headers + HTTPS enforcement + timing-safe compare helper
 *
 *  Requires:  npm i express-rate-limit@^7
 *
 *  Env (all optional):
 *    COOKIE_SAMESITE   none | lax | strict   (default: none in production, lax locally)
 *                      Use "strict" once the frontend calls the API on the SAME origin (Netlify /api/* proxy).
 *    COOKIE_ONLY       true → login responses no longer include the token in the JSON body (set after the
 *                      frontend has been moved to cookies; default false = transitional).
 *    LOGIN_MAX_FAILS   default 5          LOGIN_WINDOW_MIN  default 15
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const SECURE = IS_PROD || process.env.COOKIE_SECURE === 'true';
const COOKIE_NAME = SECURE ? '__Host-anmol_session' : 'anmol_session';   // __Host- prefix: Secure, Path=/, no Domain
let SAMESITE = String(process.env.COOKIE_SAMESITE || (SECURE ? 'none' : 'lax')).toLowerCase();
if (['none', 'lax', 'strict'].indexOf(SAMESITE) < 0) SAMESITE = 'lax';
if (SAMESITE === 'none' && !SECURE) SAMESITE = 'lax';                       // browsers reject SameSite=None without Secure
const COOKIE_ONLY = String(process.env.COOKIE_ONLY || '').toLowerCase() === 'true';
const MAX_FAILS = parseInt(process.env.LOGIN_MAX_FAILS || '5', 10) || 5;
const WINDOW_MS = (parseInt(process.env.LOGIN_WINDOW_MIN || '15', 10) || 15) * 60 * 1000;
const UNSAFE = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };

function readCookie(req, name) {
    const h = req.headers.cookie;
    if (!h) return null;
    const parts = h.split(';');
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i].trim(), eq = p.indexOf('=');
        if (eq > 0 && p.slice(0, eq) === name) { try { return decodeURIComponent(p.slice(eq + 1)); } catch (e) { return null; } }
    }
    return null;
}
function cookieString(value, maxAgeSec) {
    return COOKIE_NAME + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly' + (SECURE ? '; Secure' : '') +
        '; SameSite=' + SAMESITE.charAt(0).toUpperCase() + SAMESITE.slice(1) + '; Max-Age=' + Math.max(0, Math.floor(maxAgeSec));
}
function setSessionCookie(res, token, maxAgeMs) { res.append('Set-Cookie', cookieString(token, maxAgeMs / 1000)); }
function clearSessionCookie(res) { res.append('Set-Cookie', cookieString('', 0)); }

/** Constant-time string comparison (never use === on secrets / signatures). */
function safeEqual(a, b) {
    const x = Buffer.from(String(a == null ? '' : a)), y = Buffer.from(String(b == null ? '' : b));
    if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
    return crypto.timingSafeEqual(x, y);
}

/**
 * install(app, opts)
 *   opts.jwt            jsonwebtoken module
 *   opts.getSecret()    returns JWT secret
 *   opts.isOriginAllowed(origin) → boolean   (same allow-list the CORS layer uses)
 * Call it right after express.json(), BEFORE any route / supabasePortals.mount().
 */
function install(app, opts) {
    const jwt = opts.jwt;

    // ── baseline headers + HTTPS ──
    app.disable('x-powered-by');
    app.use(function (req, res, next) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
        if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        if (req.path.indexOf('/api/') === 0) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); }
        if (IS_PROD && !req.secure && req.path !== '/api/health') {      // trust proxy is enabled in server.js
            if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, 'https://' + req.headers.host + req.originalUrl);
            return res.status(403).json({ error: 'HTTPS is required.' });
        }
        next();
    });

    // ── cookie → Authorization bridge (+ CSRF check) ──
    // Existing code (getAuthUser, requireRole, supabase-portals logout/revoke) reads the Authorization header, so
    // a valid cookie simply becomes that header. An explicit Authorization header (legacy clients) still wins.
    app.use(function (req, res, next) {
        const hasHeader = /^Bearer\s+\S+/i.test(req.headers.authorization || '');
        const c = readCookie(req, COOKIE_NAME);
        if (hasHeader || !c) return next();
        if (UNSAFE[req.method]) {
            const sameOrigin = (req.protocol + '://' + req.get('host'));
            let origin = req.headers.origin;
            if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch (e) {} }
            const sfs = String(req.headers['sec-fetch-site'] || '');
            const ok = origin ? (origin === sameOrigin || opts.isOriginAllowed(origin)) : (sfs === 'same-origin' || sfs === 'none');
            if (!ok) return res.status(403).json({ error: 'Cross-site request blocked.' });
        }
        req.headers.authorization = 'Bearer ' + c;
        req.cookieAuth = true;
        next();
    });

    // ── set the cookie whenever a route issues one of OUR JWTs as { token } ──
    app.use(function (req, res, next) {
        if (req.method !== 'POST') return next();
        const orig = res.json.bind(res);
        res.json = function (body) {
            try {
                if (body && typeof body.token === 'string' && res.statusCode < 400) {
                    const dec = jwt.verify(body.token, opts.getSecret());
                    const maxAge = dec && dec.exp ? dec.exp * 1000 - Date.now() : 12 * 3600 * 1000;
                    if (maxAge > 0) setSessionCookie(res, body.token, maxAge);
                    if (COOKIE_ONLY) { body = Object.assign({}, body); delete body.token; body.sessionCookie = true; }
                }
            } catch (e) { /* not our token → leave untouched */ }
            return orig(body);
        };
        next();
    });
    app.post('/api/auth/logout', function (req, res, next) { clearSessionCookie(res); next(); });

    // ── login brute-force protection ──
    const failKey = function (req) {
        const b = req.body || {};
        const u = String(b.username || b.userId || b.email || '').trim().toLowerCase().slice(0, 80);
        return (req.ip || 'ip') + '|' + (req.path || '') + '|' + u;
    };
    const tooMany = function (req, res) {
        const sec = Math.ceil(WINDOW_MS / 1000);
        res.setHeader('Retry-After', String(sec));
        res.status(429).json({ error: 'Too many failed attempts. Please try again after ' + Math.ceil(WINDOW_MS / 60000) + ' minutes.' });
    };
    // 5 failed attempts per IP+account (successful logins are not counted, so they never lock anyone out)
    const perAccount = rateLimit({ windowMs: WINDOW_MS, limit: MAX_FAILS, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, keyGenerator: failKey, handler: tooMany });
    // password-spraying guard: many different accounts from one IP
    const perIp = rateLimit({ windowMs: WINDOW_MS, limit: MAX_FAILS * 8, skipSuccessfulRequests: true, standardHeaders: false, legacyHeaders: false, keyGenerator: function (req) { return 'ip|' + (req.ip || ''); }, handler: tooMany });
    ['/api/auth/login', '/api/material/login', '/api/auth/bootstrap-admin', '/api/security/verify-admin'].forEach(function (p) { app.post(p, perIp, perAccount); });
}

module.exports = { install, safeEqual, setSessionCookie, clearSessionCookie, COOKIE_NAME, SAMESITE, SECURE, IS_PROD };
