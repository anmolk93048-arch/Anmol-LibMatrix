try { require('dotenv').config(); } catch (e) { console.log('dotenv not installed, skipping...'); } // local .env only; Render uses dashboard env vars
// Friendly env-var aliases (Razorpay / App2SMS / Supabase naming) -> the names used below.
(function () {
    const E = process.env, alias = (to, ...from) => { if (!E[to]) for (const f of from) if (E[f]) { E[to] = E[f]; break; } };
    alias('PAYMENT_API_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_API_KEY');
    alias('PAYMENT_API_SECRET', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_API_SECRET');
    alias('DATABASE_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_URL', 'SUPABASE_DB_URL');
    alias('SUPABASE_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
    alias('SMS_API_KEY', 'APP2SMS_API_KEY');
    alias('PORTAL_URL', 'FRONTEND_URL');
    alias('BASE_URL', 'PORTAL_URL', 'PUBLIC_URL');   // 🔗 optional manual override for the site's public link (normally NOT needed — the live domain is auto-detected)
})();
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
const supabasePortals = require('./supabase-portals');
const security = require('./security');
// 🔑 One set of login messages for every portal (the UI colours the matching field red)
const AUTH_MSG = {
    NO_USER:    'User ID is not registered in the system.',
    BAD_PASS:   'Invalid Password. Please check your credentials and try again.',
    BAD_MOBILE: 'Invalid Mobile Number. Please check your credentials and try again.',
    NO_PASS:    'No password has been set for this account. Please contact the administrator.',
    NO_MOBILE:  'No mobile number is registered for this ID. Please contact the administrator.'
}; // 🔒 cookies, CSRF, login rate-limit, headers (see security.js) // 🆕 supabase-js layer for all 6 portals // 🆕 PII encryption/hash (pehle yeh file mein neeche require hota tha)

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
// ▲ Vercel serverless: no long-running listener / timers (see the bottom of this file). Set automatically by Vercel.
const IS_VERCEL = !!(process.env.VERCEL || process.env.VERCEL_ENV);

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
const ALLOWED_ORIGINS = []   // 🔗 no domain is hardcoded any more — everything comes from Environment (BASE_URL, FRONTEND_URL, NETLIFY_URL, EXTRA_CORS_ORIGINS, Vercel's own VERCEL_* vars)
    .concat([process.env.BASE_URL, process.env.PUBLIC_URL].filter(Boolean).map(function (x) { return String(x).trim().replace(/\/$/, ''); }))
    // 🆕 Render ka apna (custom) domain + koi extra origin — Environment se, code badle bina:
    //   EXTRA_CORS_ORIGINS="https://mydomain.com,https://www.mydomain.com"
    
    .concat([process.env.FRONTEND_URL, process.env.NETLIFY_URL].filter(Boolean).map(function (x) { return x.trim().replace(/\/$/, ''); }))
    // ▲ Vercel: this deployment's own domains (production alias, branch URL, per-deployment URL). Without these,
    //   every same-origin POST (login, logout, ...) is rejected by the CORS/CSRF origin check.
    .concat([process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
        .filter(Boolean).map(function (x) { return 'https://' + String(x).trim().replace(/^https?:\/\//, '').replace(/\/$/, ''); }))
    .concat(String(process.env.EXTRA_CORS_ORIGINS || '').split(',').map(function (x) { return x.trim().replace(/\/$/, ''); }).filter(Boolean));
// 🆕 Netlify deploy-preview / branch-deploy URLs (sirf isi site ke: <x>--digitallibraryanmollive.netlify.app)
const NETLIFY_ANY_RE = /^https:\/\/[a-z0-9-]+\.netlify\.app$/;
const NETLIFY_PREVIEW_RE = process.env.NETLIFY_SITE_NAME ? new RegExp('^https://[a-z0-9-]+--' + String(process.env.NETLIFY_SITE_NAME).replace(/[^a-z0-9-]/gi, '') + '\\.netlify\\.app$') : /$^/;   // optional: set NETLIFY_SITE_NAME to allow that site's deploy previews
// 🆕 Local development (sirf production ke bahar)
const LOCAL_DEV_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
// 🔒 CORS: STRICT by default. Only the allow-list above (+ FRONTEND_URL / NETLIFY_URL / EXTRA_CORS_ORIGINS and this
//    site's own deploy previews) may call the API from a browser. credentials:true lets the HTTP-only session cookie travel.
//    (Wildcard *.netlify.app was removed — anyone can publish a site on netlify.app.)
function isOriginAllowed(origin) {
    if (!origin) return false;
    if (ALLOWED_ORIGINS.includes(origin) || NETLIFY_PREVIEW_RE.test(origin)) return true;
    // 🔗 ZERO-CONFIG: a request whose Origin is the very domain it was sent to (same-origin) is always fine. server.js publishes the
    //    live origin of the request being handled via global.getLiveOrigin(); a cross-site attacker's Origin can never equal it.
    try { const live = typeof global.getLiveOrigin === 'function' ? global.getLiveOrigin() : null; if (live && origin === live) return true; } catch (e) { /* ignore */ }
    return process.env.NODE_ENV !== 'production' && LOCAL_DEV_RE.test(origin);
}
const CORS_OPTIONS = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);               // same-origin / server-to-server (webhooks, health checks): CORS does not apply
        if (isOriginAllowed(origin)) return callback(null, true);
        console.warn('CORS blocked origin:', origin, '→ add it to Render env EXTRA_CORS_ORIGINS (comma separated). The browser reports this as "Unable to reach the server".');
        const corsErr = new Error('CORS: access from this domain is not allowed.');
        corsErr.status = 403;
        return callback(corsErr);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Anmol-Idle'],
    maxAge: 86400
};
app.use(cors(CORS_OPTIONS));
app.use(function (req, res, next) { if (req.method === 'OPTIONS') return cors(CORS_OPTIONS)(req, res, next); next(); });   // preflight (works on Express 4 AND 5 — app.options('*') crashes Express 5)


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
// 🔒 HTTP-only session cookie bridge + CSRF check + login rate-limits + security headers
security.install(app, { jwt: jwt, getSecret: function () { return JWT_SECRET; }, isOriginAllowed: isOriginAllowed });
// 🕶️ ROUTE MASKING — portal pages live only at encrypted per-session links (/app/<token>); every predictable path
//    (/admin-login, /agent, /Admin_Login.html, /api/pages/admin-login …) answers 404. See route-mask.js.
const routeMask = require('./route-mask').create({
    getSecret: function () { return JWT_SECRET; },
    findStaticFile: function (n) { return findStaticFile(n); },
    isSafeRootStaticPath: function (p) { return isSafeRootStaticPath(p); },
    hitRateLimit: function (k, m, w) { return hitRateLimit(k, m, w); },
    notFound: function (req, res) { res.status(404).type('html').send(INLINE_404); },
    getDbPage: function (slug, cb) { db.query('SELECT data FROM site_files WHERE LOWER(slug)=LOWER(?)', [slug], function (err, rows) { cb(err, rows && rows[0] && rows[0].data); }); }
});
// 🧾 OPTION B — DV Enterprises custom invoice. Fully separate module: no Option A (wallet / Razorpay) route is touched.
const dvInvoice = require('./dv-invoice-module');
dvInvoice.install(app, { dbq: dbq, requireRole: requireRole, getAuthUser: getAuthUser, asyncRoute: asyncRoute, noStore: noStore,
                         escapeLike: escapeLike, findStaticFile: findStaticFile, auditPii: function () { return auditPii.apply(null, arguments); } });
// ▲ RENDER-URL REWRITE (safety net): any page/script served by THIS server that still contains the old Render origin
//   (theme.js, config.js, portal pages ...) gets it replaced by the current site's own origin → every API call becomes
//   same-origin (no CORS, no "Failed to fetch"). Fix the source files too; this keeps old copies working meanwhile.
const OLD_RENDER_ORIGIN_RE = /https?:\/\/[a-z0-9-]+\.onrender\.com/gi;   // any old Render host (no single domain hardcoded)
app.use(function (req, res, next) {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/img/')) return next();
    const origWrite = res.write, origEnd = res.end, chunks = [];
    let hit = null;
    const wanted = function () { return /text\/html|javascript|ecmascript/i.test(String(res.getHeader('Content-Type') || '')); };
    const toBuf = function (c, enc) { return Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === 'string' ? enc : 'utf8'); };
    res.write = function (c, enc, cb) {
        if (hit === null) hit = wanted();
        if (!hit) return origWrite.apply(res, arguments);
        if (c) chunks.push(toBuf(c, enc));
        const done = typeof enc === 'function' ? enc : cb; if (typeof done === 'function') done();
        return true;
    };
    res.end = function (c, enc, cb) {
        if (hit === null) hit = wanted();
        if (!hit) return origEnd.apply(res, arguments);
        if (c && typeof c !== 'function') chunks.push(toBuf(c, enc));
        const done = typeof c === 'function' ? c : (typeof enc === 'function' ? enc : cb);
        res.write = origWrite; res.end = origEnd;
        if (!chunks.length) return origEnd.call(res, done);
        const own = (IS_VERCEL ? 'https' : req.protocol) + '://' + (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
        const out = Buffer.concat(chunks).toString('utf8').replace(OLD_RENDER_ORIGIN_RE, own);
        res.removeHeader('Content-Length'); res.removeHeader('ETag');
        return origEnd.call(res, out, 'utf8', done);
    };
    next();
});
// ══════════════════════════════════════════════════════════════════
// ▲ VERCEL / ROUTE-MASK SESSION BRIDGE  (must stay BEFORE routeMask.guard so the guard cannot 404 it)
//   1) /logout (GET) — clears the session cookie and sends the browser to the main page "/".
//   2) /_am/bridge.js — tiny same-origin script that is injected into every masked page (/app/<token>):
//        • after ANY call to /api/auth/logout it clears the local session and sends EVERY open tab
//          (dashboard + portal tabs) back to the main page "/";
//        • a link to another portal whose label says "login" opens in a NEW tab (dashboard stays open).
//   3) Masked pages are never cached (no-store) → the Back button can not show a logged-out page again.
// ══════════════════════════════════════════════════════════════════
const AM_BRIDGE_JS = "(function(){'use strict';if(window.__amBridge)return;window.__amBridge=1;var HOME=(window.location.origin||'')+'/',done=false,bc=null;" +
    "try{bc=new BroadcastChannel('anmol-auth');}catch(e){}" +
    "function wipe(){var st=[window.localStorage,window.sessionStorage];for(var i=0;i<st.length;i++){try{var s=st[i],ks=[];for(var j=0;j<s.length;j++)ks.push(s.key(j));" +
    "ks.forEach(function(k){if(/token|jwt|bearer|auth|session/i.test(k))s.removeItem(k);});}catch(e){}}}" +
    "function home(){if(done)return;done=true;wipe();try{window.location.replace(HOME);}catch(e){window.location.href=HOME;}}" +
    "function logout(){wipe();try{if(bc)bc.postMessage('logout');}catch(e){}try{localStorage.setItem('__am_logout',String(Date.now()));}catch(e){}setTimeout(home,250);}" +
    "if(bc)bc.onmessage=function(e){if(e&&e.data==='logout')home();};" +
    "window.addEventListener('storage',function(e){if(e.key==='__am_logout')home();});" +
    "var LOGOUT=/\\/api\\/auth\\/logout(?:[?#]|$)/i;" +
    "if(window.fetch){var f=window.fetch;window.fetch=function(i){var u='';try{u=typeof i==='string'?i:(i&&i.url)||String(i);}catch(e){}" +
    "var p=f.apply(this,arguments);if(LOGOUT.test(u)){p.then(logout,logout);}return p;};}" +
    "if(window.XMLHttpRequest){var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{if(LOGOUT.test(String(u)))this.addEventListener('loadend',logout);}catch(e){}return o.apply(this,arguments);};}" +
    "document.addEventListener('click',function(ev){if(ev.defaultPrevented||ev.button>0)return;var a=ev.target&&ev.target.closest?ev.target.closest('a[href]'):null;if(!a)return;" +
    "var u;try{u=new URL(a.getAttribute('href'),window.location.href);}catch(e){return;}" +
    "if(u.origin!==window.location.origin||!/^\\/app\\//i.test(u.pathname)||u.pathname===window.location.pathname)return;" +
    "var label=(a.textContent||'')+' '+(a.getAttribute('title')||'')+' '+(a.getAttribute('aria-label')||'');" +
    "if(/login/i.test(label)){a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');}},true);})();";

// (moved up: STATIC_DIRS must exist before it is used below — it used to be declared ~230 lines later, which threw a ReferenceError at startup)
const PUBLIC_DIR = (function () {
    const p = path.join(__dirname, 'public');
    try { return fs.statSync(p).isDirectory() ? p : null; } catch (e) { return null; }
})();
const FRONTEND_DIR = (function () {
    const p = path.join(__dirname, '..', 'frontend');
    try { return fs.statSync(p).isDirectory() ? p : null; } catch (e) { return null; }
})();
// ▲ Vercel: __dirname is /var/task and only files listed in vercel.json "includeFiles" exist there. Look in the usual places
//   (project root, process.cwd(), public/, frontend/, dist/ ...) so index.html and the login pages are found wherever they were bundled.
const STATIC_DIRS = (function () {
    const cands = [PUBLIC_DIR, FRONTEND_DIR, __dirname, process.cwd()];
    ['public', 'frontend', 'dist', 'static', 'www', 'web', 'client'].forEach(function (d) {
        cands.push(path.join(__dirname, d), path.join(process.cwd(), d));
    });
    const seen = {}, out = [];
    cands.filter(Boolean).forEach(function (d) {
        try { if (!seen[d] && fs.statSync(d).isDirectory()) { seen[d] = 1; out.push(d); } } catch (e) { /* not there */ }
    });
    return out;
})();
// 🖼️ Photos + logo are served BEFORE the route-mask guard so the guard can never 404 them (public/img/* and /anmol_libmatrix_logo.png).
STATIC_DIRS.forEach(function (d) {
    const imgDir = path.join(d, 'img');
    try { if (fs.statSync(imgDir).isDirectory()) app.use('/img', express.static(imgDir, { dotfiles: 'ignore', index: false, redirect: false, maxAge: '7d' })); } catch (e) { /* no img folder here */ }
});
// 🏷️ OFFICIAL LOGO — can NEVER be broken: if the file is not in the deployment (Vercel only ships files listed in includeFiles / public/),
//    the same logo is served from memory. Covers the plain names AND the hashed names the pages used to reference.
const LOGO_PNG = Buffer.from('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', 'base64');
const LOGO_ALIASES = ['/anmol_libmatrix_logo.png', '/img/anmol_libmatrix_logo.png', '/logo.png', '/img/logo.png', '/favicon.ico',
    '/img/229545308f.png', '/img/2e7f7a75c4.png', '/img/a1559ab6fd.jpg'];   // hashed names = logo files referenced by Invoice login / index / Admin login
app.get(LOGO_ALIASES, function (req, res) {
    res.set({ 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    const f = findStaticFile('anmol_libmatrix_logo.png');
    if (f) return res.sendFile(f);
    res.type('png').send(LOGO_PNG);   // file missing from the deployment → serve the embedded copy
});

app.get('/_am/bridge.js', function (req, res) {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.send(AM_BRIDGE_JS);
});

// 🎚️ The OTP switches live ONLY inside the Super Admin dashboard (sidebar → "OTP Settings", per portal). The old script that injected a
//    single "OTP Verification" box into every page with an admin token is retired: this route stays as an empty no-op so pages cached
//    by a browser before the update do not 404.
app.get('/_am/otp-toggle.js', function (req, res) {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send('/* retired: OTP switches are managed in Super Admin → OTP Settings */');
});

// 📲 6-digit OTP prompt for the Agent / HRMS login pages (injected only there, see the masked-page middleware).
//    The page keeps calling its normal login API. When the server answers 401 OTP_REQUIRED (portal switch ON + unknown device) this script
//    asks for the OTP (WhatsApp, sent only now), then repeats the SAME login with the code. A remembered device never reaches this code:
//    the server recognises it by its HttpOnly cookie, so the user simply logs in with ID + password.
function __amOtpFlow() {
    'use strict';
    if (window.__amOtpFlow) return; window.__amOtpFlow = 1;
    var realFetch = window.fetch; if (!realFetch) return;
    var LOGIN_RE = /\/(material\/login|auth\/login)(?:[?#]|$)/i;
    function jsonResp(status, obj) { return new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } }); }
    function post(url, body) {
        return realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d || {} }; }); });
    }
    function dtKey(kind, b) { return 'am_dt:' + (kind === 'material' ? 'mat|' + String(b.userId || '').toLowerCase() : String(b.role || '') + '|' + String(b.username || '').toLowerCase()); }
    function modal(info) {
        return new Promise(function (resolve) {
            var ov = document.createElement('div');
            ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
            ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(10,20,40,.62);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,Segoe UI,Arial,sans-serif';
            ov.innerHTML = '<div style="background:#fff;color:#12233f;width:100%;max-width:360px;border-radius:16px;padding:22px 20px;box-shadow:0 20px 60px rgba(0,0,0,.35)">' +
                '<div style="font-size:18px;font-weight:800;margin-bottom:4px">Verify your login</div>' +
                '<div id="amo-msg" style="font-size:13px;line-height:1.45;color:#35547e;margin-bottom:12px"></div>' +
                '<input id="amo-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="Enter 6-digit OTP" style="width:100%;box-sizing:border-box;font-size:22px;letter-spacing:8px;text-align:center;padding:11px 8px;border:1.5px solid #b8c6dd;border-radius:10px;outline:none">' +
                '<label style="display:flex;align-items:center;gap:8px;margin:12px 0 4px;font-size:13px;cursor:pointer"><input id="amo-trust" type="checkbox" checked style="width:17px;height:17px"> Remember this device (no OTP next time)</label>' +
                '<div id="amo-err" style="min-height:18px;margin:6px 0;font-size:12.5px;color:#c0392b"></div>' +
                '<button id="amo-ok" type="button" style="width:100%;padding:12px;border:0;border-radius:10px;background:#1a3a6b;color:#fff;font-size:15px;font-weight:700;cursor:pointer">Verify &amp; Login</button>' +
                '<div style="display:flex;justify-content:space-between;margin-top:10px;font-size:13px"><button id="amo-resend" type="button" style="background:none;border:0;color:#1a3a6b;font-weight:600;cursor:pointer;padding:4px 0" disabled>Resend OTP</button><button id="amo-cancel" type="button" style="background:none;border:0;color:#64748b;cursor:pointer;padding:4px 0">Cancel</button></div></div>';
            document.body.appendChild(ov);
            var code = ov.querySelector('#amo-code'), err = ov.querySelector('#amo-err'), ok = ov.querySelector('#amo-ok'), rs = ov.querySelector('#amo-resend'), t = null, left = 0;
            ov.querySelector('#amo-msg').textContent = info.message || 'Enter the 6-digit OTP sent to your registered WhatsApp number.';
            function tick() { if (left > 0) { rs.disabled = true; rs.textContent = 'Resend OTP in ' + left + 's'; left--; } else { rs.disabled = false; rs.textContent = 'Resend OTP'; clearInterval(t); } }
            function startCount(sec) { clearInterval(t); left = sec || 60; tick(); t = setInterval(tick, 1000); }
            function close(v) { clearInterval(t); ov.remove(); resolve(v); }
            startCount(info.resendInSec);
            code.addEventListener('input', function () { code.value = code.value.replace(/\D/g, '').slice(0, 6); err.textContent = ''; });
            code.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok.click(); });
            ov.querySelector('#amo-cancel').addEventListener('click', function () { close(null); });
            rs.addEventListener('click', function () {
                rs.disabled = true; err.textContent = '';
                info.resend().then(function (r) { if (r.ok) startCount((r.data && r.data.resendInSec) || 60); else { err.textContent = r.data.error || 'Could not resend the OTP.'; startCount(r.data && r.data.resendInSec); } });
            });
            ok.addEventListener('click', function () {
                if (code.value.length !== 6) { err.textContent = 'Enter the 6-digit OTP.'; code.focus(); return; }
                ok.disabled = true; ok.textContent = 'Verifying…'; err.textContent = '';
                info.verify(code.value, ov.querySelector('#amo-trust').checked).then(function (res) {
                    ok.disabled = false; ok.textContent = 'Verify & Login';
                    if (res.retry) { err.textContent = res.error || 'Invalid or expired OTP.'; code.select(); } else close(res.response);
                });
            });
            setTimeout(function () { code.focus(); }, 50);
        });
    }
    function run(url, init, original) {
        var b; try { b = JSON.parse(init.body); } catch (e) { return Promise.resolve(original); }
        var kind = /\/material\/login/i.test(url) ? 'material' : 'auth';
        if (kind === 'auth' && ['agent', 'employee'].indexOf(String(b.role).toLowerCase()) < 0) return Promise.resolve(original);
        var base = url.replace(/\/(material|auth)\/login.*$/i, '');
        var sendUrl = kind === 'material' ? base + '/material/login-otp/send' : base + '/auth/portal-otp/send';
        var sendBody = kind === 'material' ? { userId: b.userId, secondFactor: b.secondFactor } : { role: b.role, username: b.username, password: b.password, mobile: b.mobile };
        function retry(extra) { return realFetch(url, Object.assign({}, init, { body: JSON.stringify(Object.assign({}, b, extra)) })); }
        return post(sendUrl, sendBody).then(function (s) {
            if (s.data && s.data.skipped) return retry({});                       // switch turned OFF meanwhile / device trusted
            if (!s.ok) return jsonResp(s.status, s.data);                          // wrong credentials, service down … → the page shows the server's message
            return modal({
                message: s.data.message, resendInSec: s.data.resendInSec,
                resend: function () { return post(sendUrl, sendBody); },
                verify: function (code, trust) {
                    if (kind === 'material') {
                        return post(base + '/material/login-otp/verify', { userId: b.userId, secondFactor: b.secondFactor, code: code, trustDevice: trust }).then(function (v) {
                            if (!v.ok) return { retry: true, error: v.data.error };
                            return retry({ otpToken: v.data.otpToken, trustDevice: trust }).then(function (r) { return { response: r }; });
                        });
                    }
                    return retry({ otp: code, trustDevice: trust }).then(function (r) {
                        if (r.status === 401) return r.clone().json().catch(function () { return {}; }).then(function (d) { return d && (d.code === 'INVALID_OTP' || d.code === 'OTP_REQUIRED') ? { retry: true, error: d.error } : { response: r }; });
                        return { response: r };
                    });
                }
            }).then(function (r) {
                if (!r) return jsonResp(401, { error: 'OTP verification was cancelled.', code: 'OTP_CANCELLED' });
                if (r.ok) { try { r.clone().json().then(function (d) { if (d && d.deviceToken) localStorage.setItem(dtKey(kind, b), d.deviceToken); }); } catch (e) {} }
                return r;
            });
        }).catch(function () { return original; });
    }
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        var isLogin = method === 'POST' && LOGIN_RE.test(url) && init && typeof init.body === 'string';
        if (isLogin) {                                                              // older browsers / cross-origin API: send a stored device token too
            try { var b0 = JSON.parse(init.body), kind0 = /\/material\/login/i.test(url) ? 'material' : 'auth', tk = localStorage.getItem(dtKey(kind0, b0)); if (tk && !b0.deviceToken) { b0.deviceToken = tk; init = Object.assign({}, init, { body: JSON.stringify(b0) }); } } catch (e) {}
        }
        var p = realFetch.call(this, input, init);
        if (!isLogin) return p;
        return p.then(function (res) {
            if (res.ok) {   // remember the device token a successful OTP login returned
                return res.clone().json().then(function (d) { try { var b1 = JSON.parse(init.body); if (d && d.deviceToken) localStorage.setItem(dtKey(/\/material\/login/i.test(url) ? 'material' : 'auth', b1), d.deviceToken); } catch (e) {} return res; }).catch(function () { return res; });
            }
            if (res.status !== 401) return res;
            return res.clone().json().catch(function () { return null; }).then(function (d) {
                if (!d || d.code !== 'OTP_REQUIRED') return res;
                return run(url, init, res);
            });
        });
    };
}
const AM_OTP_FLOW_JS = '(' + __amOtpFlow.toString() + ')();';
app.get('/_am/otp-flow.js', function (req, res) {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    res.send(AM_OTP_FLOW_JS);
});

// 🏠 LIVE HOME URL — the main page of the domain the user is on RIGHT NOW (auto-detected, nothing hardcoded).
//    Used after logout from the Admin / Agent / HRMS / Student / Material portals. Falls back to '/', which the browser
//    also resolves against the current domain, so a logout can never land on an old or wrong site.
function liveHomeUrl(req) {
    try {
        const h = String((req && typeof req.get === 'function' && (req.get('x-forwarded-host') || req.get('host'))) || '').split(',')[0].trim().toLowerCase();
        if (h && /^[a-z0-9.\-]+(:\d{1,5})?$/.test(h) && !_isLocalHost(h)) {
            const proto = IS_VERCEL ? 'https' : (String(req.protocol || 'https').toLowerCase() === 'http' ? 'http' : 'https');
            return proto + '://' + h + '/';
        }
    } catch (e) { /* fall through */ }
    const base = (typeof liveBaseUrl === 'function') ? liveBaseUrl(req) : '';
    return base ? base + '/' : '/';
}
function clearSessionCookies(req, res) {
    // security.clearSessionCookie's signature lives in security.js — try both common forms; a wrong form just throws and is ignored.
    try { security.clearSessionCookie(res); } catch (e) { try { security.clearSessionCookie(req, res); } catch (e2) { /* nothing to clear */ } }
}
app.get('/logout', function (req, res) {
    clearSessionCookies(req, res);
    res.set({ 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache' });
    res.redirect(303, liveHomeUrl(req));   // 🏠 straight to the home page of the current live domain
});

// Inject the bridge into masked HTML pages and make them uncacheable.
app.use(function (req, res, next) {
    if (req.method !== 'GET' || !/^\/app\//i.test(req.path)) return next();
    delete req.headers['if-none-match']; delete req.headers['if-modified-since'];   // never answer 304 for a masked page
    const origWrite = res.write, origEnd = res.end, chunks = [];
    let html = null;
    const isHtml = function () { return /text\/html/i.test(String(res.getHeader('Content-Type') || '')); };
    const toBuf = function (c, enc) { return Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === 'string' ? enc : 'utf8'); };
    res.write = function (c, enc, cb) {
        if (html === null) html = isHtml();
        if (!html) return origWrite.apply(res, arguments);
        if (c) chunks.push(toBuf(c, enc));
        const done = typeof enc === 'function' ? enc : cb; if (typeof done === 'function') done();
        return true;
    };
    res.end = function (c, enc, cb) {
        if (html === null) html = isHtml();
        if (!html) return origEnd.apply(res, arguments);
        if (c && typeof c !== 'function') chunks.push(toBuf(c, enc));
        const done = typeof c === 'function' ? c : (typeof enc === 'function' ? enc : cb);
        res.write = origWrite; res.end = origEnd;
        res.setHeader('Cache-Control', 'no-store, max-age=0'); res.setHeader('Pragma', 'no-cache');
        if (!chunks.length) return origEnd.call(res, done);
        let out = Buffer.concat(chunks).toString('utf8');
        let tag = '<script src="/_am/bridge.js" defer></script>';
        // 6-digit OTP prompt for the portals that have no OTP screen of their own (Agent / HRMS). Admin and Invoice have their own OTP screens.
        if (/__ANMOL_PAGE=("|')(agent_login|hrms_login)\.html\1/.test(out)) tag += '<script src="/_am/otp-flow.js" defer></script>';
        out = /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + '</body>') : out + tag;
        res.removeHeader('Content-Length'); res.removeHeader('ETag');
        return origEnd.call(res, out, 'utf8', done);
    };
    next();
});
app.use(routeMask.guard);
routeMask.mount(app);
// 🔐 Session security (global logout on password change, idle timeout, change-password) + ♻️ Recycle Bin
let _dbShimQuery = null;   // the Postgres shim, set once db.query has been wrapped below
const accountSecurity = require('./account-security').create({
    jwt: jwt, getSecret: function () { return JWT_SECRET; }, dbq: function (s, p) { return dbq(s, p); }, getAuthUser: function (r) { return getAuthUser(r); },
    asyncRoute: function (f) { return asyncRoute(f); }, hitRateLimit: function (k, m, w) { return hitRateLimit(k, m, w); },
    readEntity: function (k) { return readEntity(k); }, writeEntity: function (k, l) { return writeEntity(k, l); },
    looksHashed: function (v) { return looksHashed(v); }, safeEqual: security.safeEqual, clearCookie: security.clearSessionCookie,
    get AUTH_ENTITY_FOR_ROLE() { return AUTH_ENTITY_FOR_ROLE; }
});
const recycleBin = require('./recycle').create({
    rawQuery: function (s, p) { return new Promise(function (ok, bad) { (_dbShimQuery || db.query)(s, p || [], function (e, r) { e ? bad(e) : ok(r || []); }); }); },
    getAuthUser: function (r) { return getAuthUser(r); }, requireRole: function () { return requireRole.apply(null, arguments); },
    asyncRoute: function (f) { return asyncRoute(f); }, hitRateLimit: function (k, m, w) { return hitRateLimit(k, m, w); },
    verifyAdminPassword: function (a, pw) { return verifyAdminPasswordFor(a, pw); },
    bump: function (ids) { accountSecurity.bump(ids); }, clearScopeCache: function () { _scopeCache.clear(); }
});
accountSecurity.mount(app);
recycleBin.mount(app);
// ══════════════════════════════════════════════════════════════════
// 📁 STATIC FILES — pehle yahan `express.static('.')` tha, jo poore project
//   folder ko public bana deta tha (server.js, package.json tak URL se
//   khul jaate the). Ab:
//     1) agar `public/` folder hai to wahi serve hota hai;
//     2) root folder se sirf SAFE files (html/css/js/images/fonts...) serve
//        hoti hain — server.js, package*.json, dotfiles, node_modules kabhi nahi.
//   Login/home pages ke clean URLs neeche "PAGE ROUTES" mein map hain.
// ══════════════════════════════════════════════════════════════════
const ROOT_DENY_NAMES = new Set(['server.js', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'procfile', 'dockerfile', 'render.yaml', 'readme.md',
    'security.js', 'route-mask.js', 'supabase-portals.js', 'account-security.js', 'recycle.js', 'dv-invoice-module.js']); // 🔒 backend modules must never be downloadable
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
// ═══ CLEAN URLs (no .html) ═══ one table drives: clean routes, legacy *.html -> 301 redirects and /api/pages/<slug> fallbacks.
const CLEAN_PAGES = [
    { clean: '/', file: 'index.html', aliases: ['/index', '/home'], slug: null },
    { clean: '/admin-login', file: 'Admin_Login.html', slug: 'admin-login',
      aliases: ['/admin', '/admin_login', '/super-admin', '/super-admin-login', '/super_admin_login', '/superadmin', '/admin-panel-login', '/admin_panel_login', '/new-admin-login', '/new_admin_login'] },
    { clean: '/agent-login', file: 'Agent_Login.html', slug: 'agent-login', aliases: ['/agent', '/agent_login'] },
    { clean: '/hrms-login', file: 'HRMS_login.html', slug: 'hrms-login', aliases: ['/hrms', '/hrms_login'] },
    { clean: '/student-login', file: 'Student_Attendance.html', slug: 'student-login', aliases: ['/student', '/student_login', '/student-attendance', '/student_attendance'] },
    { clean: '/pfms-login', file: 'PFMS_login.html', slug: 'pfms-login', aliases: ['/pfms', '/pfms_login'] },
    { clean: '/invoice-login', file: 'INVOICE_LOGIN.html', slug: 'invoice-login', aliases: ['/invoice', '/invoice_login'] },
    { clean: '/admin-dashboard', file: 'Super_Admin_Dashboard.html', slug: 'admin-dashboard', aliases: ['/dashboard', '/super-admin-dashboard', '/super_admin_dashboard'] }
];
const LEGACY_FILE_TO_CLEAN = {};   // 'admin_login.html' -> '/admin-login' (lower-case, with and without .html)
const CLEAN_BY_SLUG = {};
CLEAN_PAGES.forEach(function (pg) {
    const base = pg.file.toLowerCase();
    LEGACY_FILE_TO_CLEAN[base] = pg.clean;
    LEGACY_FILE_TO_CLEAN[base.replace(/\.html$/, '')] = pg.clean;
    if (pg.slug) CLEAN_BY_SLUG[pg.slug] = pg;
    pg.aliases.forEach(function (a) { LEGACY_FILE_TO_CLEAN[a.slice(1) + '.html'] = pg.clean; });
});
LEGACY_FILE_TO_CLEAN['admin_panel_login.html'] = '/admin-login';
LEGACY_FILE_TO_CLEAN['index.html'] = '/';
// Slug aliases for /api/pages/<slug> (so old names keep working)
['admin', 'super-admin', 'super-admin-login', 'admin_login'].forEach(function (a) { CLEAN_BY_SLUG[a] = CLEAN_BY_SLUG['admin-login']; });
['agent', 'agent_login'].forEach(function (a) { CLEAN_BY_SLUG[a] = CLEAN_BY_SLUG['agent-login']; });
['student', 'student_attendance'].forEach(function (a) { CLEAN_BY_SLUG[a] = CLEAN_BY_SLUG['student-login']; });
['hrms', 'hrms_login'].forEach(function (a) { CLEAN_BY_SLUG[a] = CLEAN_BY_SLUG['hrms-login']; });
// Browser URL never shows ".html": /Agent_Login.html?x=1 -> 301 /agent-login?x=1
app.use(function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    const m = /^\/([A-Za-z0-9_\-]+)(\.html?)?$/.exec(req.path);
    if (!m) return next();
    const key = (m[1] + '.html').toLowerCase();
    const hit = LEGACY_FILE_TO_CLEAN[key];
    if (hit !== '/') return next();   // 🕶️ portal files are no longer redirected to a clean URL — they 404 (route-mask guard)
    const clean = hit;
    if (!m[2] && ('/' + m[1]) === clean) return next();           // already the clean URL
    if (!m[2] && key.replace(/\.html$/, '') === m[1].toLowerCase() && '/' + m[1].toLowerCase() === clean) return next();
    const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(301, clean + q);
});
if (PUBLIC_DIR) app.use(express.static(PUBLIC_DIR, STATIC_OPTS));
if (FRONTEND_DIR) { const feStatic = express.static(FRONTEND_DIR, STATIC_OPTS); app.use(function (req, res, next) { return isSafeRootStaticPath(req.path) && !/\.html?$/i.test(req.path) ? feStatic(req, res, next) : next(); }); }
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
const PREGATE_ALLOWED_PATHS = ['/api/gate/config', '/api/portal/route', '/api/auth/logout', '/api/auth/me', '/api/auth/ping'];
function getAuthUser(req) {
    try {
        const h = req.headers.authorization || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) return null;
        if (supabasePortals.isRevoked(token)) return null; // 🆕 logged-out token (Supabase revoked_tokens)
        const dec = jwt.verify(token, JWT_SECRET);
        if (accountSecurity.isStale(dec)) return null;   // 🔐 password changed after this token was issued
        // 🔒 A Super Admin password login only yields a short-lived PRE-GATE token. It is accepted solely by the
        //    role/location endpoints below, so the dashboard and every admin API stay locked until a role AND a
        //    location have been chosen (POST /api/portal/route issues the real session token).
        if (dec && dec.pregate && PREGATE_ALLOWED_PATHS.indexOf(String(req.originalUrl || req.url || '').split('?')[0].toLowerCase().replace(/\/+$/, '')) < 0) return null;
        return dec;
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
function maskAadhaarLast4(l4) { return /^\d{4}$/.test(String(l4 || '')) ? 'XXXX-XXXX-' + l4 : 'Not available'; }
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
        // 🆕 DELETE => credentials turant invalid: row hi nahi bacha to purana JWT (7 din) bhi kaam nahi karega.
        if (!rows || !rows.length) {
            return res.status(401).json({ error: 'This account no longer exists. Please contact the administrator.', accountDeleted: true });
        }
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
            max: IS_VERCEL ? 3 : 10   // serverless: many instances -> keep each pool small (use the Supabase pooler URL)
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
            max: IS_VERCEL ? 3 : 10   // serverless: many instances -> keep each pool small (use the Supabase pooler URL)
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

// ♻️ Recycle Bin: every statement that would erase data is snapshotted first (see recycle.js)
_dbShimQuery = db.query;
recycleBin.install(db, _dbShimQuery);
(function loadSessionMarks(n) { Promise.resolve(accountSecurity.load()).then(function (ok) { if (!ok && n < 20) setTimeout(function () { loadSessionMarks(n + 1); }, 5000); }); })(0);

const JWT_SECRET = (function () {
    // 🔒 A real, random secret is mandatory (Render → Environment → JWT_SECRET, 32+ chars, e.g. `openssl rand -hex 48`).
    const s = process.env.JWT_SECRET;
    if (s && s.length >= 32) return s;
    if (process.env.NODE_ENV !== 'production' && !process.env.RENDER && !process.env.VERCEL) {
        console.warn('⚠️ JWT_SECRET missing/short — using a temporary random secret (local development only).');
        return require('crypto').randomBytes(48).toString('hex');
    }
    console.error('❌ FATAL: JWT_SECRET is not set (or shorter than 32 characters). Set it in Render / Vercel → Environment and redeploy.');
    if (IS_VERCEL) throw new Error('JWT_SECRET is not set or is shorter than 32 characters (Vercel → Settings → Environment Variables, then Redeploy).');   // ▲ throw, never process.exit(), on Vercel → server.js keeps the page up and shows this reason at /api/boot-status
    process.exit(1);
})();

// 🔒 SECURITY: pehle DB password aur JWT secret seedhe code mein likhe the
// (agar yeh code kabhi public GitHub repo mein hota, to password sabko dikh
// jaata). Ab sab kuch sirf Render ke Environment Variables se aata hai —
// koi bhi secret ab is file mein kahin nahi likha. Agar zaroori variable
// missing ho, to server turant clearly bata dega (chup-chaap galat/khaali
// credential se connect karne ki koshish nahi karega).
const REQUIRED_ENV = process.env.DATABASE_URL ? ['DATABASE_URL'] : ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
// ECONNREFUSED guard: without DATABASE_URL / DB_HOST the pg driver silently tries localhost:5432 -> ECONNREFUSED.
if (missingEnv.length) console.error('❌ No database configured — pg would fall back to 127.0.0.1:5432 and fail with ECONNREFUSED. Set DATABASE_URL in Render → Environment.');
if (process.env.DATABASE_URL) {
    if (/\[YOUR-PASSWORD\]|<password>/i.test(process.env.DATABASE_URL)) console.error('❌ DATABASE_URL still contains the [YOUR-PASSWORD] placeholder — put the real database password.');
    if (/@db\.[a-z0-9]+\.supabase\.co/i.test(process.env.DATABASE_URL)) console.warn('⚠️ DATABASE_URL uses the direct Supabase host (IPv6-only). On Render use the Session POOLER string (aws-0-<region>.pooler.supabase.com:5432, user postgres.<ref>) to avoid ECONNREFUSED/ENETUNREACH.');
}
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
        // 🔒 No default credentials any more: seeding happens only when BOTH env vars are set and the password is strong.
        const uname = process.env.MASTER_ADMIN_USERNAME;
        const pwd = process.env.MASTER_ADMIN_PASSWORD;
        if (!uname || !pwd || pwd.length < 12) {
            console.warn('⚠️ No admin exists and MASTER_ADMIN_USERNAME / MASTER_ADMIN_PASSWORD (12+ chars) are not set — nothing seeded. Use POST /api/auth/bootstrap-admin (needs ADMIN_BOOTSTRAP_SECRET).');
            return;
        }
        const admin = { id: 'ADM' + Date.now(), username: uname, name: 'Anmol Kumar', role: 'Super Admin', status: 'active', password: bcrypt.hashSync(pwd, 10), lastLogin: null };
        db.query('INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['admins', JSON.stringify([admin])],
            (e2) => console.log(e2 ? 'Master admin seed failed: ' + e2.message : 'Master admin account created: ' + uname));
    });
}
setTimeout(() => seedMasterAdmin(1), 8000);

// 🔒 Super Admin / Admin passwords must never sit in the database as plain text. Any record that still has one (e.g. typed in by
// hand in Supabase) is converted to a bcrypt hash at boot; login keeps working with the same password.
function hashPlainAdminPasswords(attempt) {
    attempt = attempt || 1;
    db.query('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['admins'], (err, rows) => {
        if (err) { if (attempt < 6) setTimeout(() => hashPlainAdminPasswords(attempt + 1), 5000); return; }
        let list; try { list = JSON.parse(rows && rows[0] && rows[0].value); } catch (e) { return; }
        if (!Array.isArray(list)) return;
        let changed = 0;
        const out = list.map(rec => {
            if (!rec || typeof rec !== 'object') return rec;
            const c = { ...rec };
            PASSWORD_FIELD_NAMES.forEach(f => { if (typeof c[f] === 'string' && c[f] && !looksHashed(c[f])) { c[f] = bcrypt.hashSync(c[f], 10); changed++; } });
            return c;
        });
        if (!changed) return;
        db.query('INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['admins', JSON.stringify(out)],
            (e2) => console.log(e2 ? 'Admin password hashing failed: ' + e2.message : '🔒 ' + changed + ' plain-text admin password(s) converted to bcrypt.'));
    });
}
setTimeout(() => hashPlainAdminPasswords(1), 10000);

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

function runTableSetup(done) {
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Table setup failed: ' + err.message);
        if (done) done(err);
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
        ...require('./dv-invoice-module').SCHEMA_SQL,   // 🧾 Option B tables + material_users.invoice_version
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
        // 🆕 MATERIAL USER AADHAAR (mandatory at registration) — encrypted vault style:
        //   aadhaar_enc = AES-256-GCM, aadhaar_hash = HMAC blind-index (exact search / duplicate block),
        //   aadhaar_last4 = display only. Poora Aadhaar kabhi plain-text nahi.
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS aadhaar_last4 VARCHAR(4)",
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS aadhaar_hash VARCHAR(64)",
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS aadhaar_enc TEXT",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS aadhaar_last4 VARCHAR(4)",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS aadhaar_hash VARCHAR(64)",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS aadhaar_enc TEXT",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS approved_userid VARCHAR(50)",
        "CREATE INDEX IF NOT EXISTS idx_mur_status ON material_user_requests (status)",
        // 🆕 INVOICE PORTAL APPLICATION TRACKING (same model as the Agent / Customer flow):
        //   tracking_id  = public Application ID shown to the applicant (INV001, INV002 ...)
        //   orig_mobile  = mobile typed at registration (tracking keeps working even if Admin corrects the number)
        //   cred_enc / cred_at / cred_views = approved credentials, AES-256-GCM encrypted, shown on the
        //   tracking screen for a limited time / number of views only.
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS tracking_id VARCHAR(40)",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS orig_mobile VARCHAR(20)",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS cred_enc TEXT",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS cred_at BIGINT",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS cred_views INTEGER DEFAULT 0",
        "ALTER TABLE material_user_requests ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_mur_tracking_id ON material_user_requests (tracking_id)",
        "CREATE INDEX IF NOT EXISTS idx_mu_aadhaar_hash ON material_users (aadhaar_hash)",
        "CREATE INDEX IF NOT EXISTS idx_mu_aadhaar_last4 ON material_users (aadhaar_last4)",
        "CREATE INDEX IF NOT EXISTS idx_mur_aadhaar_hash ON material_user_requests (aadhaar_hash)",
        "CREATE INDEX IF NOT EXISTS idx_mur_aadhaar_last4 ON material_user_requests (aadhaar_last4)",
        // 🆕 Material invoice payments: one row per Razorpay order (amount is fixed server-side, one-time use)
        `CREATE TABLE IF NOT EXISTS material_invoice_payments (
            order_id VARCHAR(80) PRIMARY KEY,
            owner_user_id VARCHAR(50) NOT NULL,
            amount DECIMAL(10,2) NOT NULL,
            purpose VARCHAR(20),
            status VARCHAR(12) DEFAULT 'created',
            payment_id VARCHAR(80),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            paid_at TIMESTAMP,
            used_at TIMESTAMP
        )`,
        // 💰 Prepaid wallet / credit balance for the Invoice Portal
        "ALTER TABLE material_users ADD COLUMN IF NOT EXISTS walletBalance DECIMAL(12,2) DEFAULT 0",
        `CREATE TABLE IF NOT EXISTS material_wallet_txns (
            id SERIAL PRIMARY KEY,
            owner_user_id VARCHAR(50) NOT NULL,
            type VARCHAR(12) NOT NULL,
            amount DECIMAL(12,2) NOT NULL,
            balance_after DECIMAL(12,2),
            note VARCHAR(255),
            ref VARCHAR(80),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS material_wallet_requests (
            id SERIAL PRIMARY KEY,
            owner_user_id VARCHAR(50) NOT NULL,
            amount DECIMAL(12,2),
            note VARCHAR(255),
            status VARCHAR(12) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            resolved_at TIMESTAMP
        )`,
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
                    if (done) done();
                });
            });
        });
    });
});
}
runTableSetup(); // create/verify all tables at boot

// ═══════════════════════════════════════════════════════════════════════
// ♻️ VACANT-ID RECYCLING / SEQUENTIAL GAP-FILLING  (one reusable allocator for every ID series)
//   Old behaviour: next ID = highest existing number + 1  (deleted IDs were lost forever).
//   New behaviour: next ID = the LOWEST positive number not currently in use.
//     existing 1,2,3,5 → 4   |   existing 2,3 → 1   |   existing 1,2,3 (no gap) → 4
//   A short-lived in-memory "hold" stops two simultaneous requests from receiving the same
//   vacant number before the first record has been written (see ID_HOLD_MS).
// ═══════════════════════════════════════════════════════════════════════
const ID_HOLD_MS = 2 * 60 * 1000;
const _idHolds = Object.create(null);
function lowestVacantNumber(usedNumbers) {
    const used = new Set();
    (usedNumbers || []).forEach(function (n) { n = Number(n); if (Number.isInteger(n) && n > 0) used.add(n); });
    let n = 1;
    while (used.has(n)) n++;
    return n;
}
// scope: independent series name · prefix: e.g. 'EMP' / 'SHL-' · ids: every ID string currently in use for that series
// opts.pad (default 3) · opts.reserve=false for read-only previews (no hold is placed)
function allocateVacantId(scope, prefix, ids, opts) {
    opts = opts || {};
    const pad = opts.pad || 3;
    const re = new RegExp('^' + String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$', 'i');
    const holds = _idHolds[scope] || (_idHolds[scope] = new Map());
    const now = Date.now();
    holds.forEach(function (exp, n) { if (exp <= now) holds.delete(n); });
    const nums = [];
    (ids || []).forEach(function (id) { const m = re.exec(String(id == null ? '' : id).trim()); if (m) nums.push(parseInt(m[1], 10)); });
    holds.forEach(function (exp, n) { nums.push(n); });
    const n = lowestVacantNumber(nums);
    if (opts.reserve !== false) holds.set(n, now + ID_HOLD_MS);
    return prefix + String(n).padStart(pad, '0');
}
function releaseVacantId(scope, id, prefix) {
    const holds = _idHolds[scope]; if (!holds) return;
    const m = new RegExp('^' + String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)$', 'i').exec(String(id || ''));
    if (m) holds.delete(parseInt(m[1], 10));
}

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
        // ♻️ lowest vacant MU number (gap-filling) instead of max+1
        cb(null, allocateVacantId('MU', 'MU', (rows || []).map(r => r.userid)));
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
    for (let i = 0; i < 6; i++) pwd += chars.charAt(crypto.randomInt(chars.length));   // 🔒 CSPRNG — this password is sent over WhatsApp
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
    if (!isFinite(n) || n < 0 || n > 100000) return null;
    return Math.round(n * 100) / 100; // 0 = free (gateway bypassed), blank/invalid = use default
}

// ══════════════════════════════════════════════════════════════════
// 🆕 MATERIAL USER / AGENT REGISTRATION & LOGIN ROUTES
//   (Anmol_material_entry_secure.html + Admin_panel_Login.html isi
//   se judte hain — pehle ye routes missing the, isliye 404 aata tha)
// ══════════════════════════════════════════════════════════════════

// ── Material Aadhaar helper: mandatory, 12 digits, stored encrypted (never plain-text) ──
function parseMaterialAadhaar(body, required) {
    const raw = firstDefined(body.aadhaar, body.aadhaarNumber, body.aadhar, body.aadharNumber, body.aadhaarRedacted);
    if (raw === undefined || String(raw).trim() === '') {
        return required ? { error: 'Aadhaar number is required.' } : { none: true };
    }
    const v = validateAadhaar12(raw);
    if (!v.ok) return { error: v.error };
    if (!piiReady()) return { error: 'PII_ENCRYPTION_KEY (or JWT_SECRET) is not set on the server — Aadhaar cannot be saved securely.' };
    return { last4: v.value.slice(-4), hash: piiIndex('AADHAAR', v.value), enc: piiEncrypt(v.value) };
}
function normMobile10(m) { return String(m || '').replace(/\D/g, '').slice(-10); }
// Duplicate guard across users + pending requests (mobile and Aadhaar). excludeUserId = row id being edited.
async function materialDuplicate(mobile, aadhaarHash, excludeUserRowId, excludeRequestId) {
    const ex = excludeUserRowId ? Number(excludeUserRowId) : -1;
    const exReq = excludeRequestId ? Number(excludeRequestId) : -1;   // the pending request currently being edited by Admin
    if (mobile) {
        const a = await dbq('SELECT id FROM material_users WHERE mobile = ? AND id <> ?', [mobile, ex]);
        const b = await dbq("SELECT id FROM material_user_requests WHERE mobile = ? AND id <> ? AND COALESCE(status,'pending') = 'pending'", [mobile, exReq]);
        if (a.length || b.length) return 'This mobile number is already registered or pending.';
    }
    if (aadhaarHash) {
        const a = await dbq('SELECT id FROM material_users WHERE aadhaar_hash = ? AND id <> ?', [aadhaarHash, ex]);
        const b = await dbq("SELECT id FROM material_user_requests WHERE aadhaar_hash = ? AND id <> ? AND COALESCE(status,'pending') = 'pending'", [aadhaarHash, exReq]);
        if (a.length || b.length) return 'This Aadhaar number is already registered or pending.';
    }
    return null;
}
const MU_PUBLIC_COLS = 'id, userid, name, village, address, email, mobile, photo, status, blockedReason, aadhaar_last4, invoicePaymentExempt AS "invoicePaymentExempt", invoiceAmount AS "invoiceAmount", invoice_version AS "invoiceVersion", created_at';
function muRowOut(u) {
    const o = Object.assign({ _docId: String(u.id) }, u);
    o.aadhaarMasked = maskAadhaarLast4(u.aadhaar_last4);
    return o;
}

// 1) Public self-registration request (material_entry portal ka form) — saved as status 'pending'
//    Required: name, village, email, mobile, Aadhaar (12 digits). Photo accepted (portal form makes it mandatory).
app.post('/api/material/register', noStore, asyncRoute(async (req, res) => {
    if (hitRateLimit('mu-register:' + String(req.ip || ''), 10, 60 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many registration attempts — please try again later.' });
    }
    const b = req.body || {};
    const name = cleanText(b.name, 255), village = cleanText(b.village, 255), address = cleanText(b.address, 500);
    const email = cleanText(b.email, 255), mobile = normMobile10(b.mobile);
    if (!name || !village || !email || !mobile) {
        return res.status(400).json({ error: 'Please fill in all required fields (Name, Village, Email, Mobile and Aadhaar).' });
    }
    if (mobile.length !== 10) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const aad = parseMaterialAadhaar(b, true);
    if (aad.error) return res.status(400).json({ error: aad.error });
    const dup = await materialDuplicate(mobile, aad.hash, null);
    if (dup) return res.status(409).json({ error: dup });
    // 💳 Active registration fee (Super Admin, Supabase). ₹0 → gateway bypassed; > 0 → verified payment required.
    const regFee = await resolveFee('material', { mobile });
    if (regFee > 0) {
        const paid = await verifyRegPayment('material', regFee, b.payment || {});
        if (!paid) return res.status(402).json({ error: 'A registration fee of ₹' + regFee + ' is required. Please complete the payment to continue.', feeRequired: true, fee: regFee });
    }
    // 🆕 Unique Application / Tracking ID (INV001, INV002 ...) — applicant uses it with the mobile number on the
    //    "Track Application Status" tab. Retried on the (very unlikely) unique-index collision.
    let trackingId = null;
    for (let attempt = 0; attempt < 4 && !trackingId; attempt++) {
        let candidate;
        try { candidate = await nextInvTrackingId(); } catch (e) { candidate = genTrackingId('INV'); }
        try {
            await dbq(`INSERT INTO material_user_requests (name, village, address, email, mobile, orig_mobile, photo, status, aadhaar_last4, aadhaar_hash, aadhaar_enc, tracking_id)
                       VALUES (?,?,?,?,?,?,?, 'pending', ?,?,?,?)`,
                [name, village, address || null, email, mobile, mobile, b.photo || null, aad.last4, aad.hash, aad.enc, candidate]);
            trackingId = candidate;
        } catch (e) {
            if (!(e && e.code === '23505' && /tracking/i.test(e.message || ''))) throw e;
        }
    }
    if (!trackingId) return res.status(500).json({ error: 'Unable to generate a Tracking ID. Please try again.' });
    res.status(201).json({ success: true, status: 'pending', trackingId, applicationId: trackingId });
}));

// Sequential Invoice-Portal application ID: INV001, INV002 ... (own counter; also re-synced from the table)
let _invQueue = Promise.resolve();
function nextInvTrackingId() {
    const run = _invQueue.then(async function () {
        // ♻️ lowest vacant INV number (gap-filling); the unique index + the caller's retry loop remain the final guard
        const rows = await dbq("SELECT tracking_id FROM material_user_requests WHERE tracking_id LIKE 'INV%'", []);
        return allocateVacantId('INV', 'INV', rows.map(function (r) { return r.tracking_id; }));
    });
    _invQueue = run.catch(function () {});
    return run;
}

// 1b) Pre-check before any payment: validates Aadhaar / mobile / duplicates and tells the form the ACTIVE registration fee
//     (₹0 → the portal skips the payment gateway entirely). Nothing is written here.
app.post('/api/material/register-precheck', noStore, asyncRoute(async (req, res) => {
    if (hitRateLimit('mu-precheck:' + String(req.ip || ''), 40, 60 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many attempts — please try again later.' });
    }
    const b = req.body || {};
    const mobile = normMobile10(b.mobile);
    if (mobile.length !== 10) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    const aad = parseMaterialAadhaar(b, true);
    if (aad.error) return res.status(400).json({ error: aad.error });
    const dup = await materialDuplicate(mobile, aad.hash, null);
    if (dup) return res.status(409).json({ error: dup });
    const fee = await resolveFee('material', { mobile });
    res.json({ ok: true, fee: fee, free: fee <= 0 });
}));

// 2) Admin: registration requests by status — ?status=pending (default) | approved | rejected | all
//    (Aadhaar is masked — the full number never leaves the server here)
app.get('/api/material/requests', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const st = String(req.query.status || 'pending').toLowerCase();
    const where = (st === 'all') ? '' : ((['pending', 'approved', 'rejected'].indexOf(st) >= 0) ? "WHERE COALESCE(status,'pending') = '" + st + "'" : "WHERE COALESCE(status,'pending') = 'pending'");
    const rows = await dbq(`SELECT id, name, village, address, email, mobile, photo, COALESCE(status,'pending') AS status, aadhaar_last4, created_at, reviewed_at, approved_userid, tracking_id, orig_mobile, edited_at
                            FROM material_user_requests ${where} ORDER BY COALESCE(reviewed_at, created_at) DESC, created_at DESC LIMIT 1000`);
    res.json(rows.map(r => Object.assign({ _docId: String(r.id), aadhaarMasked: maskAadhaarLast4(r.aadhaar_last4) }, r)));
}));
app.get('/api/material/requests/counts', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const rows = await dbq("SELECT COALESCE(status,'pending') AS status, COUNT(*) AS n FROM material_user_requests GROUP BY COALESCE(status,'pending')");
    const c = { pending: 0, approved: 0, rejected: 0 };
    rows.forEach(r => { if (c[r.status] !== undefined) c[r.status] = Number(r.n) || 0; });
    c.all = c.pending + c.approved + c.rejected;
    res.json(c);
}));

// 3) Admin: approve → generates userId + password, moves it into material_users (Material User List)
app.post('/api/material/requests/:id/approve', requireRole('admin'), asyncRoute(async (req, res) => {
    const reqId = req.params.id;
    const rows = await dbq('SELECT * FROM material_user_requests WHERE id = ?', [reqId]);
    if (!rows.length) return res.status(404).json({ error: 'Request not found.' });
    const r = rows[0];
    if (String(r.status || 'pending') === 'approved') return res.status(409).json({ error: 'This request is already approved (User ID ' + (r.approved_userid || '—') + ').' });
    if (String(r.status || 'pending') === 'rejected') return res.status(409).json({ error: 'This request was rejected. Re-open it first to approve.' });
    const plainPassword = genMuPassword();
    const passwordHash = bcrypt.hashSync(plainPassword, 10);
    insertMaterialUserWithRetry(
        (userId) => ({
            sql: `INSERT INTO material_users (userid, name, village, address, email, mobile, photo, password_hash, status, invoicePaymentExempt, invoiceAmount, aadhaar_last4, aadhaar_hash, aadhaar_enc, invoice_version)
                  VALUES (?,?,?,?,?,?,?,?, 'active', ?,?, ?,?,?, ?)`,
            params: [userId, r.name, r.village, r.address, r.email, r.mobile, r.photo, passwordHash,
                !!(req.body && req.body.invoicePaymentExempt), sanitizeInvoiceAmount(req.body && req.body.invoiceAmount),
                r.aadhaar_last4 || null, r.aadhaar_hash || null, r.aadhaar_enc || null, dvInvoice.normVersion(req.body && req.body.invoiceVersion)]
        }),
        (insErr, result, userId) => {
            if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
            // keep the request as history; the encrypted Aadhaar now lives only on the user row.
            // 🆕 The freshly generated password is also kept AES-256-GCM encrypted (never plain-text) so the applicant can
            //    read it on the Track Application Status screen — limited to a time window / number of views.
            const credEnc = piiReady() ? piiEncrypt(plainPassword) : null;
            db.query("UPDATE material_user_requests SET status='approved', reviewed_at=CURRENT_TIMESTAMP, approved_userid=?, aadhaar_enc=NULL, aadhaar_hash=NULL, cred_enc=?, cred_at=?, cred_views=0 WHERE id = ?", [userId, credEnc, credEnc ? Date.now() : null, reqId], () => {
                auditPii(req, 'material_approve', userId, 'request=' + reqId);
                notifyAccount({ kind: 'credentials', portal: 'invoice', mobile: r.mobile, name: r.name, userId: userId, password: plainPassword, link: portalLink(req) }).then(function (ch) {   // automatic WhatsApp (Meta Cloud API) the moment Super Admin approves
                    res.json({ success: true, userId, password: plainPassword, mobile: r.mobile, name: r.name, village: r.village, photo: r.photo || '', notified: ch || null, notifyError: ch === 'whatsapp' ? undefined : (_lastNotifyError || undefined) });
                });
            });
        }
    );
}));

// 3b) 🆕 Admin: edit the submitted details of a PENDING request before approving it ("view → edit → verify → approve").
//     Aadhaar is optional here (blank keeps the one on file). Duplicate checks ignore the request being edited.
app.put('/api/material/requests/:id', requireRole('admin'), asyncRoute(async (req, res) => {
    const cur = (await dbq('SELECT * FROM material_user_requests WHERE id = ?', [req.params.id]))[0];
    if (!cur) return res.status(404).json({ error: 'Request not found.' });
    if (String(cur.status || 'pending') !== 'pending') return res.status(409).json({ error: 'Only a pending request can be edited.' });
    const b = req.body || {};
    const name = cleanText(b.name, 255), village = cleanText(b.village, 255), address = cleanText(b.address, 500);
    const email = cleanText(b.email, 255), mobile = normMobile10(b.mobile);
    if (!name || !village || !email || !mobile) return res.status(400).json({ error: 'Name, village, email and mobile number are required.' });
    if (mobile.length !== 10) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const aad = parseMaterialAadhaar(b, false);
    if (aad.error) return res.status(400).json({ error: aad.error });
    const dup = await materialDuplicate(mobile, aad.none ? null : aad.hash, null, req.params.id);
    if (dup) return res.status(409).json({ error: dup });
    const sets = ['name = ?', 'village = ?', 'address = ?', 'email = ?', 'mobile = ?', 'edited_at = CURRENT_TIMESTAMP'];
    const vals = [name, village, address || null, email, mobile];
    if (Object.prototype.hasOwnProperty.call(b, 'photo') && b.photo) { sets.push('photo = ?'); vals.push(b.photo); }
    if (!aad.none) { sets.push('aadhaar_last4 = ?', 'aadhaar_hash = ?', 'aadhaar_enc = ?'); vals.push(aad.last4, aad.hash, aad.enc); }
    vals.push(req.params.id);
    const r = await dbq(`UPDATE material_user_requests SET ${sets.join(', ')} WHERE id = ? AND COALESCE(status,'pending') = 'pending' RETURNING id`, vals);
    if (!r.length) return res.status(409).json({ error: 'Only a pending request can be edited.' });
    auditPii(req, 'material_request_edit', String(req.params.id), 'tracking=' + (cur.tracking_id || ''));
    res.json({ success: true });
}));

// 3c) 🆕 PUBLIC "Track Application Status" for the Invoice Portal (Tracking ID + registered mobile number).
//     Same model as /api/track-status for Agent / Customer registrations: rate-limited, both values must match, and the
//     approved User ID + Password are revealed for a limited time / number of views only.
const MAT_TRACK_CRED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAT_TRACK_CRED_MAX_VIEWS = 5;
async function materialTrackLookup(trackingId, mobile) {
    const row = (await dbq("SELECT * FROM material_user_requests WHERE LOWER(tracking_id) = ?", [String(trackingId).toLowerCase()]))[0];
    if (!row) return null;
    // mobile must match the number typed at registration OR the current (Admin-corrected) number
    if (normMobile10(row.mobile) !== mobile && normMobile10(row.orig_mobile) !== mobile) return null;
    const st = String(row.status || 'pending').toLowerCase();
    const out = {
        success: true, trackingId: row.tracking_id, applicationId: row.tracking_id, type: 'Invoice Portal Registration',
        name: row.name, village: row.village || '', mobile: normMobile10(row.mobile),
        submittedOn: row.created_at || '', status: st
    };
    if (st === 'approved') {
        out.approvedOn = row.reviewed_at || '';
        out.userId = row.approved_userid || '';
        out.message = 'Your registration has been approved. Log in to the Invoice Portal with the User ID and Password below.';
        const fresh = row.cred_enc && row.cred_at && (Date.now() - Number(row.cred_at)) <= MAT_TRACK_CRED_TTL_MS && Number(row.cred_views || 0) < MAT_TRACK_CRED_MAX_VIEWS;
        const pwd = fresh ? piiDecrypt(row.cred_enc) : null;
        if (pwd !== null && pwd !== undefined) {
            out.credentials = { userId: row.approved_userid, password: pwd };
            out.viewsLeft = Math.max(0, MAT_TRACK_CRED_MAX_VIEWS - (Number(row.cred_views || 0) + 1));
            await dbq('UPDATE material_user_requests SET cred_views = COALESCE(cred_views,0) + 1 WHERE id = ?', [row.id]);
        } else {
            // Password window over — the registered mobile number still works as the login password.
            out.credentialsExpired = true;
            out.message = 'Your registration has been approved. For security the password is no longer shown here — log in with your User ID ' + (row.approved_userid || '') + ' and your registered mobile number, or contact the Admin.';
        }
    } else if (st === 'rejected') {
        out.message = 'Your registration request was not approved. Please contact the Admin for details.';
    } else {
        out.message = 'Your application is under review by the Admin. Please check again later.';
    }
    return out;
}
async function materialTrackHandler(req, res) {
    try {
        if (hitRateLimit('mu-track:' + String(req.ip || ''), 30, 10 * 60 * 1000)) {
            return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        }
        const src = Object.assign({}, req.query || {}, req.body || {});
        const trackingId = cleanText(src.trackingId || src.applicationId || src.id, 40).trim();
        const mobile = normMobile10(src.mobile);
        if (!trackingId || mobile.length !== 10) return res.status(400).json({ error: 'Please enter a valid Application / Tracking ID and a 10-digit mobile number.' });
        const out = await materialTrackLookup(trackingId, mobile);
        if (!out) return res.status(404).json({ error: 'No application was found for the Tracking ID and mobile number provided.' });
        res.set('Cache-Control', 'no-store').json(out);
    } catch (e) {
        console.error('material track-status error:', e.message);
        res.status(500).json({ error: 'Unable to retrieve the application status. Please try again.' });
    }
}
app.post('/api/material/track-status', materialTrackHandler);
app.get('/api/material/track-status', materialTrackHandler);

// 4) Admin: reject (kept as history), re-open a rejected request, or permanently remove a record
app.post('/api/material/requests/:id/reject', requireRole('admin'), asyncRoute(async (req, res) => {
    const r = await dbq("UPDATE material_user_requests SET status='rejected', reviewed_at=CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(status,'pending') = 'pending' RETURNING id", [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Only a pending request can be rejected.' });
    res.json({ success: true });
}));
app.post('/api/material/requests/:id/reopen', requireRole('admin'), asyncRoute(async (req, res) => {
    const cur = await dbq('SELECT mobile, aadhaar_hash FROM material_user_requests WHERE id = ?', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Request not found.' });
    const dup = await materialDuplicate(cur[0].mobile, cur[0].aadhaar_hash, null);
    if (dup) return res.status(409).json({ error: dup });
    const r = await dbq("UPDATE material_user_requests SET status='pending', reviewed_at=NULL WHERE id = ? AND status = 'rejected' RETURNING id", [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Only a rejected request can be re-opened.' });
    res.json({ success: true });
}));
app.delete('/api/material/requests/:id', requireRole('admin'), asyncRoute(async (req, res) => {
    await dbq('DELETE FROM material_user_requests WHERE id = ?', [req.params.id]);
    res.json({ success: true });
}));

// 5) Admin: list all material users (Material User List table)
app.get('/api/material/users', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const rows = await dbq('SELECT ' + MU_PUBLIC_COLS + ' FROM material_users ORDER BY created_at DESC');
    res.json(rows.map(muRowOut));
}));

// 6) Admin: directly create a material user ("New Material User Register" form). Aadhaar mandatory.
app.post('/api/material/users', requireRole('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const name = cleanText(b.name, 255), village = cleanText(b.village, 255), mobile = normMobile10(b.mobile);
    if (!name || !village || !mobile) return res.status(400).json({ error: 'Name, village and mobile number are required.' });
    if (mobile.length !== 10) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    const aad = parseMaterialAadhaar(b, true);
    if (aad.error) return res.status(400).json({ error: aad.error });
    const dup = await materialDuplicate(mobile, aad.hash, null);
    if (dup) return res.status(409).json({ error: dup });
    const plainPassword = genMuPassword();
    const passwordHash = bcrypt.hashSync(plainPassword, 10);
    const status = b.status === 'blocked' ? 'blocked' : 'active';
    insertMaterialUserWithRetry(
        (userId) => ({
            sql: `INSERT INTO material_users (userid, name, village, address, email, mobile, photo, password_hash, status, invoicePaymentExempt, invoiceAmount, aadhaar_last4, aadhaar_hash, aadhaar_enc, invoice_version)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            params: [userId, name, village, cleanText(b.address, 500) || null, cleanText(b.email, 255) || null, mobile, b.photo || null, passwordHash, status,
                !!b.invoicePaymentExempt, sanitizeInvoiceAmount(b.invoiceAmount), aad.last4, aad.hash, aad.enc, dvInvoice.normVersion(b.invoiceVersion)]
        }),
        (insErr, result, userId) => {
            if (insErr) return res.status(500).json({ error: 'DB error: ' + insErr.message });
            notifyAccount({ kind: 'credentials', portal: 'invoice', mobile: mobile, name: name, userId: userId, password: plainPassword, link: portalLink(req) }).then(function (ch) {   // automatic WhatsApp the moment Super Admin creates the user
                res.status(201).json({ success: true, userId, password: plainPassword, notified: ch || null });
            });
        }
    );
}));

// 7) Admin: edit / block / unblock a material user (Aadhaar optional on edit — blank keeps the existing one)
app.put('/api/material/users/:id', requireRole('admin'), asyncRoute(async (req, res) => {
    const fields = req.body || {};
    const allowed = ['name', 'village', 'address', 'email', 'photo', 'status', 'blockedReason', 'invoicePaymentExempt'];
    const sets = [], values = [];
    allowed.forEach(f => {
        if (Object.prototype.hasOwnProperty.call(fields, f)) { sets.push(f + ' = ?'); values.push(fields[f]); }
    });
    if (Object.prototype.hasOwnProperty.call(fields, 'mobile')) {
        const m = normMobile10(fields.mobile);
        if (m.length !== 10) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
        const dup = await materialDuplicate(m, null, req.params.id);
        if (dup) return res.status(409).json({ error: dup });
        sets.push('mobile = ?'); values.push(m);
    }
    const aad = parseMaterialAadhaar(fields, false);
    if (aad.error) return res.status(400).json({ error: aad.error });
    if (!aad.none) {
        const dup = await materialDuplicate(null, aad.hash, req.params.id);
        if (dup) return res.status(409).json({ error: dup });
        sets.push('aadhaar_last4 = ?', 'aadhaar_hash = ?', 'aadhaar_enc = ?');
        values.push(aad.last4, aad.hash, aad.enc);
    }
    // per-user custom payment amount (invalid/empty → NULL = Global Default Amount)
    if (Object.prototype.hasOwnProperty.call(fields, 'invoiceAmount')) {
        sets.push('invoiceAmount = ?'); values.push(sanitizeInvoiceAmount(fields.invoiceAmount));
    }
    if (Object.prototype.hasOwnProperty.call(fields, 'invoiceVersion')) {   // 🧾 Option A / Option B mapping
        sets.push('invoice_version = ?'); values.push(dvInvoice.normVersion(fields.invoiceVersion));
    }
    if (!sets.length) return res.status(400).json({ error: 'No update data was provided.' });
    values.push(req.params.id);
    const r = await dbq(`UPDATE material_users SET ${sets.join(', ')} WHERE id = ? RETURNING id`, values);
    if (!r.length) return res.status(404).json({ error: 'Material user not found.' });
    res.json({ success: true });
}));

// 7b) Single material user (portal live-profile-sync polls this; 404 after delete → portal must log out)
app.get('/api/material/users/:id', (req, res) => {
    db.query(
        'SELECT ' + MU_PUBLIC_COLS + ' FROM material_users WHERE id = ?',
        [req.params.id],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            if (!rows || !rows.length) return res.status(404).json({ error: 'Material user not found.', accountDeleted: true });
            res.json(muRowOut(rows[0]));
        }
    );
});

// 7c) Admin: PERMANENT delete. Row (incl. password hash + Aadhaar) is removed from Supabase, so login fails
//     immediately (login looks the user up in DB) and any still-valid JWT is rejected by requireActiveMaterialUser.
app.delete('/api/material/users/:id', requireRole('admin'), asyncRoute(async (req, res) => {
    const r = await dbq('DELETE FROM material_users WHERE id = ? RETURNING userid', [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Material user not found.' });
    auditPii(req, 'material_delete', String(r[0].userid || ''), 'row=' + req.params.id);
    res.json({ success: true, userId: r[0].userid });
}));

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
                if (!rows || !rows.length) return res.status(404).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
                const u = rows[0];
                const mobileMatches = String(u.mobile || '').replace(/\D/g, '').slice(-10) === secondFactor.replace(/\D/g, '').slice(-10);
                const passwordMatches = (u.password_hash && typeof u.password_hash === 'string')
                    ? bcrypt.compareSync(secondFactor, u.password_hash)
                    : false;
                if (!mobileMatches && !passwordMatches) {
                    return res.status(401).json({ error: AUTH_MSG.BAD_PASS, code: 'INVALID_PASSWORD' });
                }
                if (u.status === 'blocked') {
                    return res.status(403).json({ error: 'This ID has been blocked by the administrator.', code: 'BLOCKED' });
                }
                // 🔒 FIX: pehle "u.userId" (camelCase) padha jaata tha jo Postgres
                // row mein hamesha undefined hota hai (asli key "userid" hai) —
                // isliye JWT token mein userId hamesha undefined save ho raha tha.
                // Isi wajah se requireActiveMaterialUser() middleware ka block-check
                // hamesha skip ho jaata tha (blocked user bhi login ke baad kaam
                // karta rehta tha), aur "मोबाइल नंबर बदलें" route bhi हमेशा
                // "Yeh User ID nahi mila" error deta tha.
                // 🔐 6-digit WhatsApp OTP on a NEW device (skipped for a trusted device or while the Super Admin switch is OFF)
                materialOtpGate(req, u.userid).then((gate) => {
                    if (!gate.ok) return res.status(gate.status).json(gate.body);
                    const token = jwt.sign({ userId: u.userid, role: 'material_user' }, JWT_SECRET, { expiresIn: '7d' });
                    // never send the password hash or the encrypted Aadhaar data to the browser
                    const { password_hash, aadhaar_enc, aadhaar_hash, ...userSafe } = u;
                    userSafe._docId = String(u.id);
                    userSafe.aadhaarMasked = maskAadhaarLast4(u.aadhaar_last4);
                    userSafe.invoiceVersion = dvInvoice.normVersion(u.invoice_version);
                    delete userSafe.invoice_version;
                    res.json({ user: userSafe, token, invoiceVersion: userSafe.invoiceVersion, redirectTo: userSafe.invoiceVersion === 'B' ? '/dv-invoice' : null, deviceToken: gate.deviceToken });
                }).catch((gateErr) => {
                    console.error('❌ /material/login OTP gate error:', gateErr.message);
                    if (!res.headersSent) res.status(500).json({ error: 'Unable to verify the login right now. Please try again.' });
                });
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
        // Mobile / Password: either field (or both) may be sent; at least one is required.
        const rawMobile = req.body && req.body.newMobile;
        const newMobile = rawMobile != null ? String(rawMobile).trim() : '';
        const digitsOnly = newMobile.replace(/\D/g, '');
        const wantMobile = newMobile !== '';
        const newPassword = req.body && req.body.newPassword != null ? String(req.body.newPassword) : '';
        const wantPassword = newPassword !== '';
        if (!wantMobile && !wantPassword) {
            return res.status(400).json({ error: 'Enter a new mobile number, a new password, or both.' });
        }
        if (wantMobile && digitsOnly.length !== 10) {
            return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
        }
        if (wantPassword && (newPassword.length < 6 || newPassword.length > 64)) {
            return res.status(400).json({ error: 'The password must be 6 to 64 characters long.' });
        }
        db.query('SELECT id, name, mobile FROM material_users WHERE userid = ?', [auth.userId], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            if (!rows || !rows.length) return res.status(404).json({ error: 'User ID not found.' });
            const me = rows[0];
            const apply = () => {
                const sets = [], params = [];
                if (wantMobile) { sets.push('mobile = ?'); params.push(digitsOnly); }
                if (wantPassword) { sets.push('password_hash = ?'); params.push(bcrypt.hashSync(newPassword, 10)); }
                params.push(me.id);
                db.query('UPDATE material_users SET ' + sets.join(', ') + ' WHERE id = ?', params, (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'DB error: ' + uErr.message });
                    if (wantPassword) {
                        // password changed → remembered devices must pass OTP again; confirmation never contains the password
                        try { Promise.resolve(revokeTrustedDevices(auth.userId)).catch(() => {}); } catch (e) { /* best effort */ }
                        try { Promise.resolve(notifyAccount({ kind: 'password_changed', mobile: wantMobile ? digitsOnly : me.mobile, name: me.name, userId: auth.userId })).catch(() => {}); } catch (e) { /* best effort */ }
                    }
                    res.json({ success: true, mobile: wantMobile ? digitsOnly : undefined, mobileChanged: wantMobile, passwordChanged: wantPassword });
                });
            };
            if (!wantMobile) return apply();
            // Duplicate check: no other material user may already hold this mobile (last 10 digits)
            db.query('SELECT id, mobile FROM material_users WHERE id != ?', [me.id], (dupErr, others) => {
                if (dupErr) return res.status(500).json({ error: 'DB error: ' + dupErr.message });
                const clash = (others || []).some(r => String(r.mobile || '').replace(/\D/g, '').slice(-10) === digitsOnly);
                if (clash) return res.status(409).json({ error: 'This mobile number is already registered with another ID.' });
                apply();
            });
        });
    } catch (e) {
        res.status(500).json({ error: 'A server error occurred: ' + e.message });
    }
});

// 9b) 🔒 Material user: re-confirm their OWN identity before a destructive action (Invoice Portal → "Reset Factory All").
//   Accepts the logged-in user's account password OR registered mobile number (same two factors as /material/login).
//   The identity comes only from the JWT — a user can never be verified as someone else. The password hash never leaves
//   the server, attempts are rate-limited per user, and the value entered is never logged or returned.
app.post('/api/material/verify-self', noStore, requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const auth = req.authUser || getAuthUser(req);
    if (!auth || auth.role !== 'material_user' || !auth.userId) {
        return res.status(401).json({ error: 'This check is only available to a logged-in Invoice Portal user. Please log in again.' });
    }
    const cred = req.body && req.body.credential != null ? String(req.body.credential).trim() : '';
    if (!cred) return res.status(400).json({ error: 'Enter your account password or registered mobile number.' });
    if (hitRateLimit('verify-self:' + String(auth.userId), 6, 5 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    const rows = await dbq('SELECT mobile, password_hash FROM material_users WHERE userid = ?', [String(auth.userId)]);
    if (!rows || !rows.length) return res.status(401).json({ error: 'This account no longer exists. Please contact the administrator.', accountDeleted: true });
    const u = rows[0];
    const regMobile = String(u.mobile || '').replace(/\D/g, '');
    const typedDigits = cred.replace(/\D/g, '');
    const mobileOk = regMobile.length >= 10 && typedDigits.length >= 10 && typedDigits.slice(-10) === regMobile.slice(-10);
    let passwordOk = false;
    if (u.password_hash && typeof u.password_hash === 'string' && looksHashed(u.password_hash)) {
        try { passwordOk = bcrypt.compareSync(cred, u.password_hash); } catch (e) { passwordOk = false; }
    }
    if (!mobileOk && !passwordOk) return res.status(403).json({ error: 'Incorrect password or mobile number. Nothing was changed.' });
    res.json({ success: true });
}));

// ══════════════════════════════════════════════════════════════════
// 🔐 AUTH BRIDGE — Admin/Agent/Student login khud client-side (legacy DB
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
    if (!security.safeEqual(secret, process.env.ADMIN_BOOTSTRAP_SECRET)) {
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

// Accepts whatever Supabase returns for kv_admin_entities.value: JSON text, a jsonb array, or a single object -> always an array.
function parseEntityList(raw) {
    let v = raw;
    for (let i = 0; i < 2 && typeof v === 'string'; i++) { try { v = JSON.parse(v); } catch (e) { return []; } }
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') return Array.isArray(v.items) ? v.items : [v];
    return [];
}
const _lcT = (x) => String(x == null ? '' : x).trim().toLowerCase();


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
            if (!stud) return res.status(401).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
            if (!studMobile) return res.status(401).json({ error: AUTH_MSG.NO_MOBILE, code: 'NO_MOBILE' });
            if (studMobile !== wantMobile) return res.status(401).json({ error: AUTH_MSG.BAD_MOBILE, code: 'INVALID_MOBILE' });
            const token = jwt.sign({ role: 'student', username: String(username) }, JWT_SECRET, { expiresIn: '7d' });
            logLoginEvent('student', username); // 🆕 real-time login count ke liye
            res.json({ token });
        });
        return;
    }

    // ── Employee (HRMS) role: password nahi hota, Employee ID + mobile
    //    match hi verification hai — 'hrms_employees' blob se check karte
    //    hain (legacy DB ki jagah Postgres). ──
    if (roleKey === 'employee') {
        if (!mobile) return res.status(400).json({ error: 'Mobile number is required.' });
        db.query('SELECT value FROM kv_blob WHERE `key` = ?', ['hrms_employees'], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
            let list = [];
            try { list = JSON.parse(rows[0] && rows[0].value) || []; } catch (e) { list = []; }
            const wantMobile = String(mobile).replace(/\D/g, '').slice(-10);
            const emp = (list || []).find(e => e && String(e.empId || '').toUpperCase() === String(username).toUpperCase());
            const empMobile = emp && String(emp.phone || emp.mobile || '').replace(/\D/g, '').slice(-10);
            if (!emp) return res.status(401).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
            if (!empMobile) return res.status(401).json({ error: AUTH_MSG.NO_MOBILE, code: 'NO_MOBILE' });
            if (empMobile !== wantMobile) return res.status(401).json({ error: AUTH_MSG.BAD_MOBILE, code: 'INVALID_MOBILE' });
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
            adminSecondFactor(req, String(username).toUpperCase(), 'hrms').then(r => {   // 🔐 HRMS OTP only while its switch is ON
                if (!r.ok) return res.status(r.status).json(r.body);
                const token = jwt.sign({ role: 'employee', username: String(username).toUpperCase() }, JWT_SECRET, { expiresIn: '7d' });
                logLoginEvent('employee', username); // 🆕 real-time login count ke liye
                res.json(r.deviceToken ? { token, deviceToken: r.deviceToken } : { token });
            }).catch(e => { console.error('hrms second factor error:', e.message); res.status(500).json({ error: 'Unable to verify the login right now. Please try again.' }); });
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
            if (!u) return res.status(401).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
            if (u.status === 'inactive') return res.status(403).json({ error: 'This account has been deactivated by the administrator.' });
            if (!bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: AUTH_MSG.BAD_PASS, code: 'INVALID_PASSWORD' });
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
        const list = parseEntityList(rows && rows[0] && rows[0].value);
        // Match User ID (username), e-mail, id or agentId — case-insensitive, trimmed.
        const wantU = _lcT(username);
        const idx = list.findIndex(u => u && [u.username, u.email, u.id, u.agentId, u.empId].some(f => f && _lcT(f) === wantU));
        const user = idx >= 0 ? list[idx] : null;
        if (!user) return res.status(401).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
        if (!user.password) return res.status(401).json({ error: AUTH_MSG.NO_PASS, code: 'NO_PASSWORD' });

        let ok = false;
        if (looksHashed(user.password)) {
            ok = bcrypt.compareSync(password, user.password);
        } else {
            // Legacy plain-text record (purana data) — verify karke turant
            // hash mein upgrade kar dete hain, taaki agli baar se DB mein
            // kabhi plain-text na rahe.
            ok = security.safeEqual(user.password, password);
            if (ok) {
                list[idx] = { ...user, password: bcrypt.hashSync(password, 10) };
                db.query(
                    'INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
                    [entityKey, JSON.stringify(list)],
                    () => {}
                );
            }
        }
        if (!ok) return res.status(401).json({ error: AUTH_MSG.BAD_PASS, code: 'INVALID_PASSWORD' });
        if (user && String(user.status || 'active').toLowerCase() !== 'active' && ['blocked', 'inactive', 'suspended', 'disabled'].includes(String(user.status).toLowerCase())) return res.status(403).json({ error: 'This account has been deactivated. Please contact the administrator.' });
        const _isAdminLogin = roleKey === 'admin';
        const _issue = (extra) => {
            const token = _isAdminLogin
                ? jwt.sign({ role: roleKey, username: String(user.username || username), pregate: true }, JWT_SECRET, { expiresIn: '15m' })
                : jwt.sign({ role: roleKey, username: String(user.username || username) }, JWT_SECRET, { expiresIn: '7d' });
            logLoginEvent(roleKey, user.username || username); // 🆕 real-time login count ke liye
            res.json(Object.assign({ token }, extra || {}));
        };
        const _otpPortal = _isAdminLogin ? 'admin' : (roleKey === 'agent' ? 'agent' : null);
        if (!_otpPortal) return _issue();
        // 🔐 Admin / Agent: 6-digit OTP only while that portal's switch is ON, skipped for a trusted device (see "SUPER ADMIN LOGIN" block)
        adminSecondFactor(req, String(user.username || username), _otpPortal).then(r => {
            if (!r.ok) return res.status(r.status).json(r.body);
            _issue(r.deviceToken ? { deviceToken: r.deviceToken } : null);
        }).catch(e => { console.error('admin second factor error:', e.message); res.status(500).json({ error: 'Unable to verify the login right now. Please try again.' }); });
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
// 🔒 Re-confirm the Super Admin password before destructive actions (Reset Factory All, Load Default Lists, ...).
//    Super Admin session → checked against that admin's own password. Any other logged-in user (Invoice Portal) →
//    checked against the Super Admin accounts. Rate-limited; the password is never logged or returned.
async function verifyAdminPasswordFor(auth, pw) {
    const lc = v => String(v == null ? '' : v).trim().toLowerCase();
    let admins = parseEntityList(await readKv('kv_admin_entities', 'admins'));
    if (String(auth.role || '').toLowerCase() === 'admin') {
        const me = lc(auth.via || auth.username);
        admins = admins.filter(a => a && [a.username, a.email, a.id].some(f => f && lc(f) === me));
    }
    return admins.some(a => a && a.password && (looksHashed(a.password) ? bcrypt.compareSync(pw, a.password) : security.safeEqual(a.password, pw)));
}
app.post('/api/security/verify-admin', noStore, asyncRoute(async (req, res) => {
    const auth = getAuthUser(req);
    if (!auth) return res.status(401).json({ error: 'Session expired — please log in again.' });
    const pw = String((req.body && req.body.password) || '');
    if (!pw) return res.status(400).json({ error: 'Enter the Super Admin password.' });
    if (hitRateLimit('verify-admin:' + String(auth.via || auth.username || auth.userId || req.ip), 8, 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    const lc = v => String(v == null ? '' : v).trim().toLowerCase();
    let admins = parseEntityList(await readKv('kv_admin_entities', 'admins'));
    if (String(auth.role || '').toLowerCase() === 'admin') {
        const me = lc(auth.via || auth.username);
        admins = admins.filter(a => a && [a.username, a.email, a.id].some(f => f && lc(f) === me));
    }
    const ok = admins.some(a => a && a.password && (looksHashed(a.password) ? bcrypt.compareSync(pw, a.password) : security.safeEqual(a.password, pw)));
    if (!ok) return res.status(401).json({ error: 'Incorrect Super Admin password.' });
    res.json({ success: true });
}));

app.post('/api/auth/logout', noStore, (req, res) => {
    const auth = getAuthUser(req); // galat/expired token ho tab bhi null milega, error nahi
    clearSessionCookies(req, res); // ▲ the HTTP-only session cookie is removed on the server, not only the localStorage token
    res.json({ success: true, message: 'Logged out successfully.', role: auth ? auth.role : null, redirect: liveHomeUrl(req) });
});

// ══════════════════════════════════════════════════════════════════
// 🗄️ GENERIC KEY-VALUE STORES — admin-entities / blob / site-data
//   (Admin Panel ke CloudSync.pull/push isi se judte hain)
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
        // New accounts are ACTIVE by default (never "Deactivated") — only an explicit Block/Deactivate by the admin changes it.
        if (table === 'kv_admin_entities' && Array.isArray(val) && ['admins', 'agents', 'staff', 'students'].indexOf(key) >= 0) {
            val = val.map(function (r) { return (r && typeof r === 'object' && !Array.isArray(r) && (r.status === undefined || r.status === null || r.status === '')) ? Object.assign({}, r, { status: 'active' }) : r; });
        }
        if (table !== 'kv_admin_entities' || !Array.isArray(val)) return finishRaw(val);
        db.query(`SELECT value FROM ${table} WHERE \`key\` = ?`, [key], (err, rows) => {
            let merged = val, prevList = [];
            if (!err && rows && rows.length) { try { prevList = JSON.parse(rows[0].value); merged = preservePasswordsFromExisting(val, prevList); } catch (e) { merged = val; } }
            if (WA_NOTIFY_ENTITIES.indexOf(key) >= 0) {
                // New account created / password set or reset by Super Admin, Admin or an Agent (admins / agents / staff / students):
                // WhatsApp the User ID, password and portal link (SMS fallback, best effort, bounded to 9 s).
                const t = new Promise(r => setTimeout(r, 9000));
                return Promise.race([autoNotifyEntityCredentials(key, merged, prevList, portalLink(req)), t]).catch(() => {}).then(() => finishRaw(merged));
            }
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
    res.set('Cache-Control', 'no-store, max-age=0'); // always serve the live value (e.g. Material Master units)
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
// 🧑‍💼 HRMS EMPLOYEE REGISTRATION + APPROVAL (Postgres-backed, legacy DB
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
const hrRegisterWithChecks = asyncRoute(async (req, res) => {
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
});
app.post('/api/hr/register', feeGate('hrms'), hrRegisterWithChecks);
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
            const trackingId = genTrackingId('HRM');
            const rec = {
                id: regId, trackingId, paymentRef: req.__paymentRef || '', fee: req.__fee || 0, name, phone, email: body.email || '', address: body.address || '',
                photo: body.photo || '', designation: body.designation || '', department: body.department || '',
                agentUsername, status: 'pending', submittedOn: new Date().toISOString()
            };
            if (body.aadhar) rec.aadhar = String(body.aadhar);
            pending.push(rec);
            hrSetBlob('hrms_pending_registrations', pending, (sErr) => {
                if (sErr) return res.status(500).json({ error: 'DB error: ' + sErr.message });
                addTracking({ trackingId, kind: 'hrms', regId, name, mobile: phone, paymentRef: req.__paymentRef || '', fee: req.__fee || 0 });
                res.status(201).json({ success: true, id: regId, trackingId });
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
            // ♻️ lowest vacant EMP number (gap-filling) instead of max+1
            const empId = allocateVacantId('EMP', 'EMP', (employees || []).map(e => e && e.empId));
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
                    notifyAccount({ kind: 'hr_approved', portal: 'hrms', mobile: reg.phone, name: reg.name, userId: empId });   // 💬 WhatsApp the employee (Admin or Agent approval)
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
            // naya record ban jaata hai (jaisa legacy DB .set() bhi karta tha).
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

// 7) HRMS ke transactions/dashboard REST reads — pehle legacy DB real-time
//    listeners (watchPendingTransactions/watchAdminDashboard) use hote the,
//    jo asal mein STALE the (writes bahut pehle hi is naye /api/payments/
//    route par shift ho chuki thi, status bhi 'pending'/'verified' hai,
//    legacy DB wale purane 'Pending_HRMS' status se kabhi match hi nahi
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
// 'agentId'/'agentUsername' match kare) ko hataata hai. legacy DB-era wala
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
            // 💬 PFMS users have no mobile column — if the admin form sends one, WhatsApp the login details
            if ((req.body || {}).mobile) notifyAccount({ kind: 'credentials', portal: 'pfms', mobile: req.body.mobile, name: name || username, userId: username, password: password, link: portalLink(req) });
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
        if (password && (req.body || {}).mobile) notifyAccount({ kind: 'credentials', portal: 'pfms', mobile: req.body.mobile, name: name || (req.body || {}).username, userId: (req.body || {}).username || String(req.params.id), password: password, link: portalLink(req) });
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
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
    if (!req.rawBody || !signature || !security.safeEqual(signature, expected)) {
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
        const ok = looksHashed(me.password) ? bcrypt.compareSync(password, me.password) : security.safeEqual(me.password, password);
        if (!ok) return res.status(401).json({ error: AUTH_MSG.BAD_PASS, code: 'INVALID_PASSWORD' });

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
        // Built-in page fallback: never 404 for the standard login pages (admin-login, agent-login, ...).
        const _builtin = CLEAN_BY_SLUG[String(req.params.slug || '').toLowerCase()];
        const _sendBuiltin = function () {
            const bf = _builtin && findStaticFile(_builtin.file);
            if (bf) { res.set('Cache-Control', 'no-cache'); return res.sendFile(bf); }
            if (_builtin) return res.redirect(302, _builtin.clean);
            return false;
        };
        if (err) { if (_builtin) return _sendBuiltin(); return res.status(500).send('DB error: ' + err.message); }
        if (!rows || !rows.length) {
            if (_builtin) return _sendBuiltin();
            return res.status(404).send('This page has not been uploaded yet: /' + req.params.slug);
        }
        const f = rows[0];
        res.set('Content-Type', f.mime || 'text/html');
        res.set('Content-Disposition', 'inline; filename="' + f.name + '"');
        res.send(f.data);
    });
});

// Admin Panel ke "Login Dropdown Manager" mein sabhi upload-ho-chuke pages
// ki list dikhane ke liye (slug + naam + kab update hua)
app.get('/api/pages', requireRole('admin'), (req, res) => {   // 🕶️ was public
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
// legacy DB (shdl/agent_logins) mein likh kar turant agent ko active kar
// deta tha — Admin Panel ko iske baare mein pata hi nahi chalta tha,
// koi "Pending" list thi hi nahi jahan yeh dikhta. Ab yeh backend mein
// pending register hota hai; Admin Panel isse dekh kar Approve/Reject
// karta hai — approve hone tak agent login nahi kar sakta.
function agentRegistrationCore(req, res) {
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
            nextAgtId().catch(function () { return genTrackingId('AGT'); }).then(function (trackingId) {
            const rec = {
                id: 'REG' + Date.now(), trackingId, paymentRef: req.__paymentRef || '', fee: req.__fee || 0, name, username: uname,
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
                    addTracking({ trackingId, kind: 'agent', regId: rec.id, name: rec.name, mobile: rec.mobile, username: rec.username, paymentRef: req.__paymentRef || '', fee: req.__fee || 0 });
                    res.status(201).json({ success: true, id: rec.id, trackingId });
                }
            );
            });
        });
    });
}
app.post('/api/agent-registrations', feeGate('agent'), agentRegistrationCore);


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
    if (!kyc.aadhaar_hash) return res.status(400).json({ error: 'Please enter the full 12-digit Aadhaar number.' });
    const _aadhaarDigits = String(firstDefined(req.body.aadhaar, req.body.aadhaarNumber, req.body.aadhar, req.body.aadharNumber, req.body.aadhaarRedacted, '')).replace(/\D/g, '');
    try {
        if (await aadhaarAlreadyExists(_aadhaarDigits)) return res.status(409).json({ error: AADHAAR_EXISTS_MSG, code: 'AADHAAR_DUPLICATE' });
    } catch (e) { return res.status(500).json({ error: 'Unable to verify the Aadhaar number right now. Please try again.' }); }
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
            if (plan.active === false) return res.status(400).json({ error: 'This membership plan is no longer active. Please choose another plan.' });
            resolveFee('customer', { mobile: mobile, agent: [agentId, loginUsername], planPrice: plan.price }).then((fee) => {
                if (fee <= 0) return { id: 'FREE_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex'), amount: 0, currency: 'INR', free: true };
                return razorpayRequest('/v1/orders', {
                    amount: Math.round(Number(fee) * 100),
                    currency: 'INR',
                    receipt: 'custreg_' + mobile + '_' + Date.now()
                }).then((o) => { o.fee = fee; return o; });
            }).then((order) => {
                db.query(
                    `INSERT INTO customer_registration_orders
                        (orderId, name, mobile, email, address, note, agentId, planId, planName, amount,
                         district, state, pin_code, aadhaar_last4, aadhaar_hash, aadhaar_enc, pan_enc, pan_hash, pan_masked)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [order.id, cName, mobile, cEmail, cAddress, cNote, agentId, plan.id, plan.name || '', order.free ? 0 : (order.fee != null ? order.fee : plan.price),
                        kyc.district || '', kyc.state || '', kyc.pin_code || '',
                        kyc.aadhaar_last4 || null, kyc.aadhaar_hash || null, kyc.aadhaar_enc || null,
                        kyc.pan_enc || null, kyc.pan_hash || null, kyc.pan_masked || null],
                    (err) => {
                        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
                        res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, plan: plan, free: !!order.free, fee: order.free ? 0 : (order.fee != null ? order.fee : plan.price) });
                    }
                );
            }).catch((e) => res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message }));
        });
    });
});

app.post('/api/customer-registrations/verify', async (req, res) => {
    const secret = process.env.PAYMENT_API_SECRET;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    // Free registration (₹0 set by the Super Admin): the order id is server-issued ("FREE_…") and its stored amount is 0.
    const isFree = /^FREE_/.test(String(razorpay_order_id || ''));
    if (!isFree) {
        if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
        }
        const expected = crypto.createHmac('sha256', secret)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');
        if (expected !== razorpay_signature) {
            { console.error('❌ Payment signature MISMATCH — order=' + razorpay_order_id + ' payment=' + razorpay_payment_id + ' (wrong PAYMENT_API_SECRET for this key, or the checkout payload was altered).'); return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' }); }
        }
    }
    if (!isFree) {
    try { await razorpayConfirmPayment(razorpay_order_id, razorpay_payment_id); } catch (e) { console.error('❌ verify rejected:', e.message); return res.status(402).json({ error: e.message }); }
    }
    db.query(isFree ? "SELECT * FROM customer_registration_orders WHERE orderId=? AND status='created' AND amount = 0" : "SELECT * FROM customer_registration_orders WHERE orderId=? AND status='created'", [razorpay_order_id], (err, rows) => {
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
                let trackingId;
                try { trackingId = await nextAgtId(); } catch (e) { trackingId = genTrackingId('AGT'); }
                const paidOn = new Date().toISOString();
                const last4 = o.aadhaar_last4 || '';
                const rec = {
                    id: regId, trackingId: trackingId, paidOn: paidOn, name: o.name, mobile: o.mobile, email: o.email || '',
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
                        res.status(201).json({
                            success: true, id: rec.id, trackingId: trackingId,
                            message: 'Your application has been submitted and sent to the Super Admin for approval.',
                            receipt: { receiptNo: 'RCP-' + trackingId, trackingId: trackingId, name: rec.name, mobile: rec.mobile, email: rec.email,
                                planName: rec.planName, amount: Number(rec.amount) || 0, paymentRef: isFree ? 'FREE (no fee)' : razorpay_payment_id,
                                orderId: razorpay_order_id, paymentMode: isFree ? 'No fee' : 'Online (Razorpay)', paymentStatus: isFree ? 'No payment required' : 'Paid',
                                paidOn: paidOn, status: 'pending' }
                        });
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
    return parseEntityList(r[0] && r[0].value);
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
        const aid = appId.toLowerCase();
        const list = await readCustomerRegs();
        const rec = list.find(r => r && (String(r.id).toLowerCase() === aid || String(r.trackingId || '').toLowerCase() === aid) && normMobile(r.mobile) === mobile);
        if (!rec) {
            if (/^INV\d/i.test(appId)) {
                const m = await materialTrackLookup(appId, mobile);
                if (m) return res.set('Cache-Control', 'no-store').json(m);
            }
            if (/^(TRK-|AGT\d)/i.test(appId)) {
                const t = await trackingLookup(appId, mobile);
                if (t) return res.json(t);
            }
            return res.status(404).json({ error: 'No application was found for the Tracking ID and mobile number provided.' });
        }
        const out = {
            success: true, applicationId: rec.id, trackingId: rec.trackingId || rec.id, name: rec.name, mobile: rec.mobile, type: 'Customer Registration', planName: rec.planName || '',
            amount: Number(rec.amount) || 0, paymentRef: rec.paymentRef || '', paidOn: rec.paidOn || rec.submittedOn || '',
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
        res.json(list.map(r => {
            const o = Object.assign({}, r); const c = o.credentials; delete o.credentials;
            if (c && c.userId) { o.assignedUserId = c.userId; const pw = c.enc && piiReady() ? piiDecrypt(c.enc) : null; if (pw) o.assignedPassword = pw; }
            return o;
        }));
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
        await safeQ("UPDATE kyc_records SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE entity_type = 'customer' AND LOWER(entity_id) = ?", [rec.status, String(rec.id).toLowerCase()]);
        res.json({ success: true, id: rec.id, status: rec.status });
    } catch (e) { res.status(500).json({ error: 'Unable to record the decision.' }); }
});


// Admin: agent / library SELF-registrations (pending → approve / reject). These were saved by /api/agent-registrations
// but never listed anywhere in the admin panel, so they could not be approved.
async function readAgentRegs() {
    const r = await dbq('SELECT value FROM kv_blob WHERE `key` = ?', ['agent_pending_registrations']);
    return parseEntityList(r[0] && r[0].value);
}
app.get('/api/admin/agent-registrations', noStore, requireRole('admin'), async (req, res) => {
    try {
        const list = await readAgentRegs();
        res.json(list.filter(r => r && r.id).map(r => Object.assign({}, r, {
            mobile: r.mobile || '', email: r.email || '', planName: 'Agent / Library Registration',
            amount: r.fee != null ? Number(r.fee) : 0, paymentRef: r.paymentRef || '', status: r.status || 'pending'
        })));
    } catch (e) { res.status(500).json({ error: 'Unable to load agent registrations.' }); }
});
app.post('/api/admin/agent-registrations/:id/decision', requireRole('admin'), async (req, res) => {
    try {
        const status = String((req.body || {}).status || '').toLowerCase();
        if (!['approved', 'rejected', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
        const list = await readAgentRegs();
        const rec = list.find(r => r && r.id === req.params.id);
        if (!rec) return res.status(404).json({ error: 'Registration not found.' });
        rec.status = status;
        if (status === 'approved') rec.approvedOn = new Date().toISOString();
        if (status === 'rejected') rec.rejectedOn = new Date().toISOString();
        await dbq('INSERT INTO kv_blob ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['agent_pending_registrations', JSON.stringify(list)]);
        res.json({ success: true, id: rec.id, status: rec.status });
    } catch (e) { res.status(500).json({ error: 'Unable to record the decision.' }); }
});

// ═══════════════════════════════════════════════════════════════════════
// 🔐 CREDENTIAL RECOVERY (6-digit OTP via WhatsApp) + AGENT CREDENTIAL SMS + ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════
const OTP_LENGTH = 6;                          // 🔢 EVERY OTP in this project (login, recovery, forgot-username) is exactly 6 digits
const OTP_TTL_MS = 10 * 60 * 1000;            // 📲 OTP validity — 10 minutes (must match the WhatsApp template's code_expiration_minutes)
const OTP_RESEND_MS = 60 * 1000;               // minimum gap between two OTP requests for the same account
const OTP_MAX_TRIES = 5;
// OTP store lives in the database so it works on serverless (no shared memory between instances).
let _otpTableReady = null;
function ensureOtpTable() {
    if (!_otpTableReady) _otpTableReady = dbq('CREATE TABLE IF NOT EXISTS otp_codes ("key" VARCHAR(190) PRIMARY KEY, data TEXT NOT NULL, exp BIGINT NOT NULL)', []).catch(e => { _otpTableReady = null; throw e; });
    return _otpTableReady;
}
const _otpStore = {
    async get(k) { await ensureOtpTable(); const r = await dbq('SELECT data FROM otp_codes WHERE "key" = ?', [k]); try { return r && r[0] ? JSON.parse(r[0].data) : undefined; } catch (e) { return undefined; } },
    async set(k, v) { await ensureOtpTable(); await dbq('INSERT INTO otp_codes ("key", data, exp) VALUES (?, ?, ?) ON CONFLICT ("key") DO UPDATE SET data = EXCLUDED.data, exp = EXCLUDED.exp', [k, JSON.stringify(v), v.exp + 300000]); await dbq('DELETE FROM otp_codes WHERE exp < ?', [Date.now()]).catch(() => {}); },
    async delete(k) { await ensureOtpTable(); await dbq('DELETE FROM otp_codes WHERE "key" = ?', [k]); }
};
const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
// 🔗 LIVE LINK — every WhatsApp / SMS / notification that carries a portal link points to the CURRENT live domain.
//    Nothing is hardcoded. Detection order:
//      1) the domain of the request being served right now (x-forwarded-host / Host — works automatically on Vercel)
//      2) the last live domain seen by this server instance
//      3) Vercel's own env: VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL
//      4) LAST resort only (no request, no history): BASE_URL / PORTAL_URL / FRONTEND_URL / PUBLIC_URL if set
//    Change the domain tomorrow → nothing to edit (just remove/update BASE_URL if you had set it).
//    Any old host (onrender.com / netlify.app / *.vercel.app) found inside a stored link or SMS template is rewritten to the live one.
const STALE_LINK_HOST_RE = /https?:\/\/[^\/\s"'<>]*\.(?:onrender\.com|netlify\.app|vercel\.app)(?=[\/:?#\s"'<>]|$)/gi;
let _lastLiveOrigin = '';
function _isLocalHost(h) { return /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(h); }
function requestOrigin(req) {   // origin of THIS request (never throws, '' if unknown or local)
    try {
        if (!req || typeof req.get !== 'function') return '';
        const h = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
        if (!h || _isLocalHost(h) || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(h)) return '';   // malformed / spoofed Host → ignore
        return 'https://' + h;
    } catch (e) { return ''; }
}
app.use(function (req, res, next) {
    try {
        const o = requestOrigin(req);
        if (o && !/\.onrender\.com$/i.test(o)) _lastLiveOrigin = o;
    } catch (e) { /* never block a request */ }
    next();
});
function liveBaseUrl(req) {
    const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
    const good = (u) => /^https?:\/\/[^\s]+$/i.test(u);
    const list = [requestOrigin(req), _lastLiveOrigin,   // 1) the live domain of THIS request (zero-config)  2) last live domain seen
        process.env.VERCEL_PROJECT_PRODUCTION_URL && 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL,
        process.env.VERCEL_URL && 'https://' + process.env.VERCEL_URL,
        process.env.BASE_URL, process.env.PORTAL_URL, process.env.FRONTEND_URL, process.env.PUBLIC_URL];   // env = last-resort fallback only (e.g. background jobs with no request)
    for (const c of list) { const u = clean(c); if (u && good(u)) return u; }
    return '';
}
function freshenLinks(text, req) {
    const base = liveBaseUrl(req);
    return base ? String(text == null ? '' : text).replace(STALE_LINK_HOST_RE, base) : String(text == null ? '' : text);
}
function portalLink(req) { return liveBaseUrl(req); }
async function readEntity(key) {
    const r = await dbq('SELECT value FROM kv_admin_entities WHERE `key` = ?', [key]);
    try { const l = JSON.parse(r[0] && r[0].value); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
async function writeEntity(key, list) {
    await dbq('INSERT INTO kv_admin_entities ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(list)]);
    if (key === 'agents') _scopeCache.clear();
}
// Finds a login account by User ID and/or contact (mobile or e-mail).
async function findRecoveryAccount(userId, contact, scope) {
    const uid = lc(userId), c = lc(contact), c10 = last10(contact);
    const match = (rec, ids) => {
        if (!rec) return false;
        if (uid && !ids.some(i => lc(rec[i]) === uid)) return false;
        if (!c) return !!uid;
        return lc(rec.email) === c || (c10.length === 10 && last10(rec.mobile || rec.phone) === c10);
    };
    if (scope !== 'material') {
        for (const [entity, ids] of [['agents', ['username', 'agentId', 'id']], ['admins', ['username']], ['staff', ['username', 'empId', 'empid']]]) {
            const list = await readEntity(entity);
            const idx = list.findIndex(r => match(r, ids));
            if (idx >= 0) return { kind: 'entity', entity, list, idx, rec: list[idx], userId: list[idx].username || list[idx].agentId || list[idx].id, mobile: last10(list[idx].mobile || list[idx].phone) };
        }
    }
    if (scope === 'material' || scope === 'any') {
        const rows = await dbq('SELECT * FROM material_users WHERE (? = \'\' OR LOWER(userid) = ?) AND (LOWER(COALESCE(email,\'\')) = ? OR RIGHT(REGEXP_REPLACE(COALESCE(mobile,\'\'), \'\\D\', \'\', \'g\'), 10) = ?)', [uid, uid, c, c10]);
        if (rows && rows[0]) { const r = rows[0]; return { kind: 'material', rec: r, userId: r.userid, mobile: last10(r.mobile) }; }
    }
    return null;
}
function recoveryScope(req) { return /\/material\//.test(req.path) ? 'material' : (/\/agent\//.test(req.path) ? 'entity' : 'any'); }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ══════════════════════════════════════════════════════════════════
// 💬 WHATSAPP — centralised in ./whatsapp-service.js (Meta templates, 100% from Environment — see .env.example)
//   Two core templates serve EVERY portal (Invoice, Agent, HRMS, Admin and any future one):
//     WA_TEMPLATE_OTP   authentication template → 6-digit OTP
//     WA_TEMPLATE_INFO  utility template        → User Name · User ID · Password · portal login link
//   A new portal needs no new code: pass portal:'<name>' to notifyAccount() and set PORTAL_URL_<NAME> in Environment.
// ══════════════════════════════════════════════════════════════════
// 📦 whatsapp-service is INLINED here (single-file deploy: nothing extra to upload to Vercel)
const wa = (function () {
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// whatsapp-service.js — the ONE place that talks to WhatsApp (Meta templates)
//
//   Every portal (Invoice, Agent, HRMS, Admin, and any future one) uses just two pre-approved templates:
//     1) OTP   template  (AUTHENTICATION)  WA_TEMPLATE_OTP    body {{1}} = 6-digit code (+ Copy-code button)
//     2) INFO  template  (UTILITY)         WA_TEMPLATE_INFO   body {{1}} name · {{2}} User ID · {{3}} password · {{4}} portal login link
//   Optional 3rd template for notices without a password (approved / password changed …): WA_TEMPLATE_NOTICE.
//
//   NOTHING is hardcoded: every key, id, template name, language, URL and version comes from process.env (.env locally,
//   dashboard Environment on Render/Vercel). See .env.example for the full list.
//
//   Adding a new portal needs NO new code: call  sendLoginInfo(mobile, { portal: 'newportal', ... })  and put
//   PORTAL_URL_NEWPORTAL=https://newportal.example.com in .env — the link in the message is resolved from that variable.
//
//   Transport (WA_PROVIDER):
//     meta      – Meta WhatsApp Cloud API directly   (WA_ACCESS_TOKEN + WA_PHONE_NUMBER_ID)
//     fast2sms  – Fast2SMS WhatsApp gateway (same Meta payload)  (FAST2SMS_API_KEY + FAST2SMS_WA_PHONE_NUMBER_ID)
//     (unset → "meta" when its credentials exist, otherwise "fast2sms" when its credentials exist)
//   OTPs / passwords are never logged.
// ═══════════════════════════════════════════════════════════════════════════
const https = require('https');
const http = require('http');

const env = (k, d) => { const v = process.env[k]; return v == null || String(v).trim() === '' ? (d == null ? '' : d) : String(v).trim(); };
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const last10 = (v) => digits(v).slice(-10);
const clean = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 500) || '-';

// ── configuration (re-read on every call so a changed Environment value needs no code change) ─────────────
function config() {
    const meta = { token: env('WA_ACCESS_TOKEN'), phoneId: env('WA_PHONE_NUMBER_ID'), version: env('WA_API_VERSION', 'v21.0'), base: env('WA_API_BASE', 'https://graph.facebook.com') };
    const f2s = { key: env('FAST2SMS_API_KEY'), phoneId: env('FAST2SMS_WA_PHONE_NUMBER_ID'), version: env('FAST2SMS_WA_VERSION', 'v26.0'), base: env('FAST2SMS_WA_URL', 'https://www.fast2sms.com/dev/whatsapp') };
    const metaOk = !!(meta.token && meta.phoneId), f2sOk = !!(f2s.key && f2s.phoneId);
    let provider = env('WA_PROVIDER').toLowerCase();
    if (provider !== 'meta' && provider !== 'fast2sms') provider = metaOk ? 'meta' : (f2sOk ? 'fast2sms' : 'meta');
    return {
        provider, meta, f2s,
        enabled: env('WA_ENABLED', env('WA_OTP_ENABLED', 'true')).toLowerCase() !== 'false',
        lang: env('WA_TEMPLATE_LANG', env('FAST2SMS_WA_LANG', 'en')),
        cc: digits(env('WA_DEFAULT_CC', env('FAST2SMS_WA_CC', '91'))) || '91',
        timeoutMs: parseInt(env('WA_TIMEOUT_MS', '12000'), 10) || 12000,
        langs: {   // each template can have its own approved language code (e.g. OTP "en", info "en_US")
            otp: env('WA_TEMPLATE_OTP_LANG'), info: env('WA_TEMPLATE_INFO_LANG'), notice: env('WA_TEMPLATE_NOTICE_LANG')
        },
        templates: {
            otp: env('WA_TEMPLATE_OTP', env('FAST2SMS_WA_TEMPLATE_NAME', env('WA_OTP_TEMPLATE'))),
            info: env('WA_TEMPLATE_INFO', env('CREDENTIALS_WA_TEMPLATE_NAME', env('WA_CRED_TEMPLATE'))),
            notice: env('WA_TEMPLATE_NOTICE', env('WA_NOTICE_TEMPLATE'))
        }
    };
}
function isConfigured() {
    const c = config();
    return c.enabled && (c.provider === 'fast2sms' ? !!(c.f2s.key && c.f2s.phoneId) : !!(c.meta.token && c.meta.phoneId));
}
function missingConfig() {
    const c = config(), miss = [];
    if (c.provider === 'fast2sms') { if (!c.f2s.key) miss.push('FAST2SMS_API_KEY'); if (!c.f2s.phoneId) miss.push('FAST2SMS_WA_PHONE_NUMBER_ID'); }
    else { if (!c.meta.token) miss.push('WA_ACCESS_TOKEN'); if (!c.meta.phoneId) miss.push('WA_PHONE_NUMBER_ID'); }
    return miss;
}
// Safe-to-show summary for diagnostics (no secrets).
function describe() {
    const c = config();
    return { provider: c.provider, configured: isConfigured(), missing: missingConfig(), language: c.lang, countryCode: c.cc,
        templates: { otp: c.templates.otp || null, info: c.templates.info || null, notice: c.templates.notice || null } };
}

// ── portal login links: PORTAL_URL_<NAME> per portal, any new portal just adds an env var ──────────────────
function portalKey(p) { return String(p || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
function portalLink(portal, fallback) {
    const k = portalKey(portal);
    const own = k ? env('PORTAL_URL_' + k) : '';
    return (own || fallback || env('PORTAL_URL', env('FRONTEND_URL', env('BASE_URL')))).replace(/\/+$/, '');
}

// ── transport ──────────────────────────────────────────────────────────────────────────────────────────
function postJson(urlStr, headers, body, timeoutMs) {
    return new Promise((resolve, reject) => {
        let u; try { u = new URL(urlStr); } catch (e) { return reject(waError('WhatsApp API URL is invalid.')); }
        const payload = JSON.stringify(body), lib = u.protocol === 'http:' ? http : https;
        const rq = lib.request(u, { method: 'POST', timeout: timeoutMs, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers) }, (resp) => {
            let data = '';
            resp.on('data', (d) => { data += d; });
            resp.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (e) { /* non-JSON */ } resolve({ status: resp.statusCode, json: j, text: data }); });
        });
        rq.on('timeout', () => rq.destroy(new Error('WhatsApp API request timed out after ' + timeoutMs + ' ms.')));
        rq.on('error', (e) => reject(waError('WhatsApp network error: ' + (e.code ? e.code + ' – ' : '') + e.message)));
        rq.write(payload); rq.end();
    });
}
function waError(msg, extra) { const e = new Error(msg); e.channel = 'whatsapp'; if (extra) Object.assign(e, extra); return e; }

// Generic template sender. bodyParams → {{1}}, {{2}} … ; buttonParam (optional) → the Copy-code / URL button.
async function sendTemplate(mobile, templateName, bodyParams, buttonParam, langOverride) {
    const c = config();
    if (!c.enabled) throw waError('WhatsApp sending is disabled (WA_ENABLED=false).');
    if (!isConfigured()) throw waError('WhatsApp is not configured (set ' + missingConfig().join(' / ') + ').');
    if (!templateName) throw waError('WhatsApp template name is not configured (WA_TEMPLATE_OTP / WA_TEMPLATE_INFO).');
    const num = last10(mobile);
    if (num.length !== 10) throw waError('A valid 10-digit mobile number is required.');
    const components = [{ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: String(p) })) }];
    if (buttonParam != null) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(buttonParam) }] });
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: c.cc + num, type: 'template',
        template: { name: templateName, language: { code: langOverride || c.lang }, components } };
    let url, headers;
    if (c.provider === 'fast2sms') {
        url = c.f2s.base.replace(/\/$/, '') + '/' + c.f2s.version + '/' + encodeURIComponent(c.f2s.phoneId) + '/messages';
        headers = { Authorization: c.f2s.key };
    } else {
        url = c.meta.base.replace(/\/$/, '') + '/' + c.meta.version + '/' + encodeURIComponent(c.meta.phoneId) + '/messages';
        headers = { Authorization: 'Bearer ' + c.meta.token };
    }
    console.log('[whatsapp] → ' + c.provider + ' template=' + templateName + ' mobile=XXXXXX' + num.slice(-4));   // never the OTP / password
    const r = await postJson(url, headers, body, c.timeoutMs);
    const j = r.json || {};
    const ok = r.status >= 200 && r.status < 300 && ((Array.isArray(j.messages) && j.messages.length > 0) || j.status === true || j.status === 'true' || j.return === true || j.return === 'true');
    if (ok) return (Array.isArray(j.messages) && j.messages[0] && j.messages[0].id) || true;
    const e = j.error || {};
    const m = e.error_user_msg || e.message || (Array.isArray(j.message) ? j.message.join(' ') : j.message) || String(r.text || '').slice(0, 200) || ('HTTP ' + r.status);
    const code = Number(e.code || j.status_code || r.status) || 0;
    const err = waError('WhatsApp API rejected the request (status ' + r.status + (code ? ', code ' + code : '') + '): ' + String(m).slice(0, 200), { gatewayCode: code });
    console.error('[whatsapp] FAILED:', err.message);
    throw err;
}

// ── the two core templates ───────────────────────────────────────────────────────────────────────────────
// 1) OTP — identical for every portal.
function sendOtp(mobile, otp) { const c = config(); return sendTemplate(mobile, c.templates.otp, [otp], otp, c.langs.otp); }
// 2) Login info — User ID + password + the portal's own login link, for registrations AND password resets in every portal.
function sendLoginInfo(mobile, o) {
    o = o || {};
    const c = config(), link = String(o.link || '').replace(/^-$/, '');
    const params = [clean(o.name || 'User'), clean(o.userId), clean(o.password), clean(portalLink(o.portal, link))];   // {{1}} name · {{2}} User ID · {{3}} password · {{4}} login link — Meta rejects empty values, clean() never returns ''
    return sendTemplate(mobile, c.templates.info, params, null, c.langs.info);
}
// Optional: password-less notices (approved / password changed / username recovered). Only used when WA_TEMPLATE_NOTICE is set.
function noticeEnabled() { return !!config().templates.notice; }
function sendNotice(mobile, o) {
    o = o || {};
    const c = config();
    return sendTemplate(mobile, c.templates.notice, [clean(o.name || 'User'), clean(o.text), clean(o.userId), clean(portalLink(o.portal, o.link))], null, c.langs.notice);
}

return { config, isConfigured, missingConfig, describe, portalLink, sendTemplate, sendOtp, sendLoginInfo, sendNotice, noticeEnabled, clean };

})();
function waConfigured() { return wa.isConfigured(); }

// ── 🔔 Account notifications: login credentials / approvals / password changes ─────────────────────────────
//   Templates (names come ONLY from Environment — see whatsapp-service.js / .env.example):
//     WA_TEMPLATE_INFO   {{1}} User Name · {{2}} User ID · {{3}} Password · {{4}} Portal Login Link   (registrations + password resets, all portals)
//     WA_TEMPLATE_NOTICE (optional) {{1}} name · {{2}} message · {{3}} User ID · {{4}} portal link     (password-less notices; without it → SMS)
//   Every send is best-effort: WhatsApp first → SMS fallback → never throws, never blocks or fails the registration itself.
const waTxt = (v) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 500) || '-';
const NOTICE_TEXT = {
    approved: 'your account has been approved. Please sign in with the password you chose at registration.',
    password_changed: 'your password was changed successfully. If this was not you, please contact the administrator immediately.',
    hr_approved: 'your HRMS profile has been approved.',
    username_recovered: 'as requested, your Anmol LibMatrix Username is shown below. Your password is never sent by message. Please do not share this message.'
};
let _lastNotifyError = '';
async function _notifyAccountOnce(ev) {
    try {
        const mobile = last10(ev.mobile);
        if (mobile.length !== 10) return null;
        const name = waTxt(ev.name || 'User'), uid = waTxt(ev.userId);
        let sms, send = null;
        const portal = ev.portal || '';
        const plink = waTxt(wa.portalLink(portal, freshenLinks(ev.link) || liveBaseUrl()) || '');   // PORTAL_URL_<PORTAL> wins, else the live domain
        if (ev.kind === 'credentials' || ev.kind === 'userid_recovered') {
            // INFO template (WA_TEMPLATE_INFO): {{1}} name · {{2}} User ID · {{3}} password · {{4}} portal login link — same for every portal.
            // User-ID recovery has no plain password (stored hashed only) → {{3}} carries a pointer to "Forgot Password" instead.
            const shownPwd = ev.kind === 'credentials' ? String(ev.password == null ? '' : ev.password) : (process.env.WA_RECOVERY_PASSWORD_TEXT || 'Use your existing password (Forgot Password to reset)');
            send = () => wa.sendLoginInfo(mobile, { name: name, userId: uid, password: shownPwd, portal: portal, link: plink === '-' ? '' : plink });
            const cfg = await loadSmsConfig();
            sms = ev.kind === 'credentials'
                ? freshenLinks(buildCredentialsMessage(name, uid, String(ev.password), plink, cfg.template && /\{pass\}/.test(cfg.template) ? freshenLinks(cfg.template) : ''))   // a saved SMS template may still hold the old link
                : 'Hello ' + name + ', your User ID is ' + uid + '. Use your existing password (or Forgot Password).' + (plink !== '-' ? ' Login: ' + plink : '');
        } else {
            const text = NOTICE_TEXT[ev.kind] || String(ev.text || '');
            if (wa.noticeEnabled()) send = () => wa.sendNotice(mobile, { name: name, text: waTxt(freshenLinks(text)), userId: uid, portal: portal, link: plink });   // optional WA_TEMPLATE_NOTICE
            sms = 'Hello ' + name + ', ' + text + ' User ID: ' + uid + (plink !== '-' ? ' Portal: ' + plink : '');
        }
        if (send && waConfigured()) {
            try { await send(); return 'whatsapp'; }
            catch (e) { _lastNotifyError = String(e && e.message || e).slice(0, 300); console.error('[notify] WhatsApp (' + ev.kind + ') to XXXXXX' + mobile.slice(-4) + ' FAILED: ' + _lastNotifyError); }
        } else if (send) { _lastNotifyError = 'WhatsApp is not configured (missing: ' + (wa.missingConfig().join(', ') || 'WA_ENABLED=false') + ')'; console.error('[notify] ' + _lastNotifyError); }
        if (await smsConfigured()) { await sendSms(mobile, sms); return 'sms'; }
        return null;
    } catch (e) { console.warn('notifyAccount (' + (ev && ev.kind) + ') failed:', e.message); return null; }
}
// Automatic dispatch + delivery tracking. Credential / approval messages go out the moment Super Admin approves or creates a record.
// The first attempt is awaited (so the API answer can report it); if it fails, two background retries follow (3 s, 12 s).
// Only the DELIVERY RESULT is stored (status, channel, time), never the password. Read it via GET /api/admin/credential-delivery/:userId.
const CRED_KINDS = ['credentials', 'approved', 'hr_approved'];
async function _setDelivery(uid, st) { try { await _otpStore.set('cn|' + lc(uid), Object.assign({ at: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }, st)); } catch (e) {} }
async function notifyAccount(ev) {
    const track = !!(ev && CRED_KINDS.indexOf(ev.kind) >= 0 && ev.userId);
    const ch = await _notifyAccountOnce(ev);
    if (!track) return ch;
    if (ch) { await _setDelivery(ev.userId, { status: ch === 'whatsapp' ? 'sent' : 'sms', channel: ch }); return ch; }
    await _setDelivery(ev.userId, { status: 'retrying', error: _lastNotifyError });
    (async () => {
        for (const wait of [3000, 12000]) {
            await new Promise((r) => setTimeout(r, wait));
            const c = await _notifyAccountOnce(ev);
            if (c) return _setDelivery(ev.userId, { status: c === 'whatsapp' ? 'sent' : 'sms', channel: c });
        }
        console.warn('[notify] ' + ev.kind + ' message for ' + ev.userId + ' could not be delivered after retries.');
        await _setDelivery(ev.userId, { status: 'failed', error: _lastNotifyError });
    })().catch(() => {});
    return null;
}
// Saved lists (admins / agents / staff / students): a record that arrives with a NEW plain-text password (created or reset by
// Super Admin / Admin / Agent) gets its credentials on WhatsApp; a freshly approved agent whose own password is already hashed gets
// an approval notice. HMAC marker `credWaSig` on the record prevents the same password from being sent twice.
const WA_NOTIFY_ENTITIES = ['admins', 'agents', 'staff', 'students'];
const ENTITY_PORTAL = { admins: 'admin', agents: 'agent', staff: 'hrms', students: 'student' };   // → PORTAL_URL_ADMIN / _AGENT / _HRMS / _STUDENT (any missing one falls back to the live domain)
const credSig = (uid, pwd) => crypto.createHmac('sha256', JWT_SECRET).update(String(uid) + '|' + String(pwd)).digest('hex').slice(0, 24);
async function autoNotifyEntityCredentials(key, incoming, existing, link) {
    if (!Array.isArray(incoming) || WA_NOTIFY_ENTITIES.indexOf(key) < 0) return;
    if (!waConfigured() && !(await otpServiceConfigured()) && !(await smsConfigured())) return;
    const same = (o, r) => o && ((r.id != null && o.id === r.id) || (r.username && o.username === r.username) || (r.agentId && o.agentId === r.agentId) || (r.studentId && o.studentId === r.studentId) || (r.empId && o.empId === r.empId));
    const jobs = [];
    for (const rec of incoming) {
        if (!rec || typeof rec !== 'object' || jobs.length >= 25) continue;
        const mobile = last10(rec.mobile || rec.phone || rec.contact || rec.whatsapp);
        const uid = rec.username || rec.agentId || rec.studentId || rec.empId || rec.id;
        if (mobile.length !== 10 || !uid) continue;
        const old = (existing || []).find(o => same(o, rec));
        const pf = PASSWORD_FIELD_NAMES.find(f => typeof rec[f] === 'string' && rec[f] && !looksHashed(rec[f]));
        if (pf) {
            const pwd = rec[pf], sig = credSig(uid, pwd);
            if (rec.credWaSig === sig) continue;
            if (old && rec.credSmsSentAt && !rec.credWaSig) { rec.credWaSig = sig; continue; }     // already SMSed by the older flow
            jobs.push(notifyAccount({ kind: 'credentials', portal: ENTITY_PORTAL[key] || key, mobile: mobile, name: rec.name || rec.fullName || rec.studentName, userId: uid, password: pwd, link: link })
                .then(ch => { if (ch) { rec.credWaSig = sig; rec.credSmsSentAt = new Date().toISOString(); } }));
        } else if (key === 'agents' && !old && !rec.credWaSig && !rec.credSmsSentAt && PASSWORD_FIELD_NAMES.some(f => rec[f])) {
            jobs.push(notifyAccount({ kind: 'approved', portal: ENTITY_PORTAL[key] || key, mobile: mobile, name: rec.name, userId: uid, link: link })
                .then(ch => { if (ch) { rec.credWaSig = 'notice'; rec.credSmsSentAt = new Date().toISOString(); } }));
        }
    }
    await Promise.all(jobs);
}
// ══════════════════════════════════════════════════════════════════
// 💬 OTP DELIVERY — every portal's 6-digit OTP goes through wa.sendOtp() (WA_TEMPLATE_OTP). The OTP itself is never logged.
// ══════════════════════════════════════════════════════════════════
const OTP_NOT_CONFIGURED_MSG = 'The WhatsApp OTP service is not configured. Please contact the administrator.';
// Any OTP-sending failure (wrong key, template not approved, wallet balance, timeout, network) becomes a friendly JSON answer —
// never a crash and never a bare 502. The real reason goes to the server log only (OTP_DEBUG=true adds it to the reply).
function otpSendFailed(res, e, where) {
    console.error('[' + (where || 'otp') + '] OTP could not be sent:', e && e.message);
    if (res.headersSent) return;
    const message = 'The WhatsApp OTP could not be sent. Please check the WhatsApp setup (credentials, approved template, account balance).';
    const out = { success: false, message: message, error: message, code: 'WHATSAPP_GATEWAY_FAILED' };
    if (e && e.gatewayCode) out.gatewayCode = e.gatewayCode;
    if (String(process.env.OTP_DEBUG || '').toLowerCase() === 'true') out.detail = String(e && e.message || e).slice(0, 300);
    res.status(424).json(out);   // 424 (not 5xx) so proxies/CDNs such as Render never replace the JSON with their own 502 page
}
async function otpServiceConfigured() { return wa.isConfigured(); }
// Every OTP (all portals: login + password recovery + forgot-username) goes through here → WhatsApp authentication template.
async function sendOtpMessage(mobile, otp) {
    await wa.sendOtp(mobile, otp);
    return 'whatsapp';
}

// 🆕 Recovery modal sends State + Mobile + Email together. When the stored record HAS an e-mail / state, they must match too
// (mobile alone is already matched by findRecoveryAccount). Records without those fields are not blocked.
function recoveryExtraOk(acc, b) {
    if (!acc || !acc.rec) return false;
    const r = acc.rec, mail = lc(b && b.email), st = lc(b && b.state);
    if (mail && r.email && lc(r.email) !== mail) return false;
    if (st && r.state && lc(r.state) !== st) return false;
    return true;
}
async function forgotPasswordCore(req, res) {
    try {
        if (hitRateLimit('otp:' + (req.ip || ''), 15, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        const b = req.body || {};
        const userId = String(b.user || b.userId || b.username || '').trim();
        const contact = String(b.contact || b.email || b.mobile || '').trim();
        if (!contact) return res.status(400).json({ error: 'Please provide your registered email or phone number to recover access.' });
        if (!userId) return res.status(400).json({ error: 'Please enter your valid User ID.' });
        const acc = await findRecoveryAccount(userId, contact, recoveryScope(req));
        if (!acc || !recoveryExtraOk(acc, b)) return res.status(404).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
        if (acc.mobile.length !== 10) return res.status(422).json({ error: 'No registered mobile number is available for this account. Please contact the administrator.' });
        if (!(await otpServiceConfigured())) return res.status(501).json({ error: 'The WhatsApp OTP service is not configured. Please contact the administrator.' });
        const key = lc(acc.userId) + '|' + acc.kind;
        const prev = await _otpStore.get(key);
        if (prev && Date.now() - prev.sentAt < OTP_RESEND_MS) {
            return res.status(429).json({ error: 'Please wait before requesting a new OTP.', resendInSec: Math.ceil((OTP_RESEND_MS - (Date.now() - prev.sentAt)) / 1000) });
        }
        const otpLen = OTP_LENGTH;   // always 6 digits (same for /api/send-otp and the legacy /forgot-password routes)
        const otp = String(crypto.randomInt(10 ** (otpLen - 1), 10 ** otpLen));
        let channel;
        try { channel = await sendOtpMessage(acc.mobile, otp); }
        catch (e) { return otpSendFailed(res, e, 'forgot-password'); }
        await _otpStore.set(key, { hash: sha(otp), sentAt: Date.now(), exp: Date.now() + OTP_TTL_MS, tries: 0 });
        const m = acc.mobile;
        res.json({ success: true, channel: channel, message: 'A ' + otpLen + '-digit OTP has been sent on ' + (channel === 'whatsapp' ? 'WhatsApp' : 'SMS') + ' to the registered mobile number ending ' + m.slice(-4) + '.', expiresInSec: Math.round(OTP_TTL_MS / 1000), resendInSec: Math.round(OTP_RESEND_MS / 1000) });
    } catch (e) {
        console.error('[forgot-password] FAILED:', e && (e.stack || e.message));
        if (res.headersSent) return;
        res.status(502).json(Object.assign({ error: 'Unable to send the OTP right now. Please try again.' }, String(process.env.OTP_DEBUG || '').toLowerCase() === 'true' ? { detail: String(e && e.message || e).slice(0, 300) } : {}));   // OTP_DEBUG=true shows the exact reason in the browser (turn off afterwards)
    }
}
// Never leave the browser hanging: whatever happens, answer within 25 s (the page waits 30 s before "Unable to reach the server").
function forgotPasswordHandler(req, res) {
    console.log('[forgot-password] ' + req.method + ' ' + req.originalUrl + ' origin=' + (req.headers.origin || '-') + ' ip=' + (req.ip || '-'));
    const t = setTimeout(() => { if (!res.headersSent) { console.error('[forgot-password] TIMEOUT after 25 s (database or SMS gateway not answering)'); res.status(504).json({ error: 'The server took too long to respond. Please try again.' }); } }, 25000);
    return forgotPasswordCore(req, res).catch(e => { console.error('[forgot-password] unexpected:', e && e.stack); if (!res.headersSent) res.status(500).json({ error: 'Unable to send the OTP right now. Please try again.' }); }).then(() => clearTimeout(t));
}
async function resetPasswordHandler(req, res) {
    try {
        if (hitRateLimit('otpv:' + (req.ip || ''), 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        const b = req.body || {};
        const userId = String(b.user || b.userId || b.username || '').trim();
        const contact = String(b.contact || '').trim();
        const code = String(b.code || b.otp || '').trim();
        const newPassword = String(b.newPassword || '');
        if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.' });
        if (newPassword.length < 6) return res.status(400).json({ error: 'Passwords do not match or fields are empty.' });
        const acc = await findRecoveryAccount(userId, contact, recoveryScope(req));
        if (!acc || !recoveryExtraOk(acc, b)) return res.status(404).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
        const key = lc(acc.userId) + '|' + acc.kind;
        const o = await _otpStore.get(key);
        if (!o || Date.now() > o.exp) { await _otpStore.delete(key); return res.status(400).json({ error: 'OTP has expired. Please request a new OTP.' }); }
        o.tries++;
        await _otpStore.set(key, o);
        if (o.tries > OTP_MAX_TRIES) { await _otpStore.delete(key); return res.status(400).json({ error: 'OTP has expired. Please request a new OTP.' }); }
        if (o.hash !== sha(code)) return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.' });
        await _otpStore.delete(key);
        await revokeTrustedDevices(acc.userId);   // 🔒 password changed → every remembered device must pass OTP again
        const hash = bcrypt.hashSync(newPassword, 10);
        if (acc.kind === 'entity') {
            acc.list[acc.idx] = Object.assign({}, acc.rec, { password: hash });
            await writeEntity(acc.entity, acc.list);
        } else {
            await dbq('UPDATE material_users SET password_hash = ? WHERE id = ?', [hash, acc.rec.id]);
        }
        notifyAccount({ kind: 'password_changed', mobile: acc.mobile, name: acc.rec && (acc.rec.name || acc.rec.fullName), userId: acc.userId });   // 💬 confirmation (never contains the password)
        res.json({ success: true, message: 'Password reset successful. Please sign in with your new password.' });
    } catch (e) {
        console.error('reset-password error:', e.message);
        res.status(500).json({ error: 'Unable to reset the password right now. Please try again.' });
    }
}
// === FORGOT USERNAME (OTP) START ===
// Step 1  POST <base>/forgot-username           {mobile}               -> OTP sent on WhatsApp to the REGISTERED number, returns {challengeId}
// Step 2  POST <base>/forgot-username/verify    {challengeId, otp}     -> correct OTP -> ONLY the Username is sent to that WhatsApp number
//         POST <base>/forgot-username/resend    {challengeId}
// The response never contains the Username or any password. Unknown numbers get an identical-looking step-1 answer (no account enumeration).
const FU_LEN = OTP_LENGTH;
const FU_ID_RE = /^[0-9a-f]{48}$/;
async function forgotUsernameHandler(req, res) {
    try {
        const b = req.body || {};
        if (hitRateLimit('fuid:' + (req.ip || ''), 10, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        const contact = String(b.mobile || b.contact || b.email || '').trim();
        if (!contact || contact.length > 120) return res.status(400).json({ error: 'Please enter your registered mobile number.' });
        if (hitRateLimit('fuc:' + lc(contact), 5, 30 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        if (!(await otpServiceConfigured())) return res.status(501).json({ error: 'The WhatsApp OTP service is not configured. Please contact the administrator.' });
        const acc = await findRecoveryAccount('', contact, recoveryScope(req));
        const real = !!(acc && recoveryExtraOk(acc, b) && acc.mobile.length === 10);
        const id = crypto.randomBytes(24).toString('hex');
        const m4 = (real ? acc.mobile : last10(contact)).slice(-4) || '0000';
        if (real) {
            const otp = String(crypto.randomInt(10 ** (FU_LEN - 1), 10 ** FU_LEN));
            try { await sendOtpMessage(acc.mobile, otp); } catch (e) { return otpSendFailed(res, e, 'forgot-username'); }
            await _otpStore.set('fu|' + id, { hash: sha(otp), userId: acc.userId, mobile: acc.mobile, name: acc.rec && (acc.rec.name || acc.rec.fullName) || '', sentAt: Date.now(), exp: Date.now() + OTP_TTL_MS, tries: 0 });
        }
        res.json({ success: true, challengeId: id, otpLength: FU_LEN, maskedMobile: 'XXXXXX' + m4, expiresInSec: Math.round(OTP_TTL_MS / 1000), resendInSec: Math.round(OTP_RESEND_MS / 1000),
            message: 'If this number is registered, an ' + FU_LEN + '-digit OTP has been sent on WhatsApp to the number ending ' + m4 + '.' });
    } catch (e) { console.error('[forgot-username] failed:', e && e.message); if (!res.headersSent) res.status(502).json({ error: 'Unable to process the request right now. Please try again.' }); }
}
async function forgotUsernameResendHandler(req, res) {
    try {
        const id = String((req.body || {}).challengeId || '');
        if (!FU_ID_RE.test(id) || hitRateLimit('fur:' + id, 5, 30 * 60 * 1000) || hitRateLimit('fur:' + (req.ip || ''), 15, 30 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please start again later.' });
        const ch = await _otpStore.get('fu|' + id);
        if (!ch) return res.json({ success: true, resendInSec: Math.round(OTP_RESEND_MS / 1000) });   // unknown / expired id looks the same
        if (Date.now() - ch.sentAt < OTP_RESEND_MS) return res.status(429).json({ error: 'Please wait before requesting a new OTP.', resendInSec: Math.ceil((OTP_RESEND_MS - (Date.now() - ch.sentAt)) / 1000) });
        const otp = String(crypto.randomInt(10 ** (FU_LEN - 1), 10 ** FU_LEN));
        try { await sendOtpMessage(ch.mobile, otp); } catch (e) { return otpSendFailed(res, e, 'forgot-username'); }
        Object.assign(ch, { hash: sha(otp), sentAt: Date.now(), exp: Date.now() + OTP_TTL_MS, tries: 0 });
        await _otpStore.set('fu|' + id, ch);
        res.json({ success: true, resendInSec: Math.round(OTP_RESEND_MS / 1000) });
    } catch (e) { console.error('[forgot-username/resend] failed:', e && e.message); if (!res.headersSent) res.status(502).json({ error: 'Unable to resend the OTP right now. Please try again.' }); }
}
async function forgotUsernameVerifyHandler(req, res) {
    try {
        const b = req.body || {}, id = String(b.challengeId || ''), otp = String(b.otp || '').replace(/\D/g, '');
        if (hitRateLimit('fuv:' + (req.ip || ''), 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        const bad = () => res.status(400).json({ error: 'Invalid or expired OTP. Please try again.', code: 'INVALID_OTP' });
        if (!FU_ID_RE.test(id) || otp.length !== FU_LEN) return bad();
        const ch = await _otpStore.get('fu|' + id);
        if (!ch || Date.now() > ch.exp) { await _otpStore.delete('fu|' + id); return bad(); }
        ch.tries++;
        if (ch.tries > OTP_MAX_TRIES) { await _otpStore.delete('fu|' + id); return res.status(400).json({ error: 'Too many incorrect attempts. Please start again.', code: 'OTP_LOCKED' }); }
        await _otpStore.set('fu|' + id, ch);
        if (!security.safeEqual(ch.hash, sha(otp))) return bad();
        // OTP proven: send ONLY the Username (utility template, WhatsApp first, SMS fallback). Passwords are never read or sent here.
        const via = await notifyAccount({ kind: 'username_recovered', mobile: ch.mobile, name: ch.name, userId: ch.userId });
        if (!via) return res.status(424).json({ error: 'Your OTP was verified, but the message could not be delivered right now. Please try again shortly.', code: 'DELIVERY_FAILED' });
        await _otpStore.delete('fu|' + id);
        res.json({ success: true, channel: via, maskedMobile: 'XXXXXX' + ch.mobile.slice(-4),
            message: 'Your Username has been sent to your registered ' + (via === 'whatsapp' ? 'WhatsApp number' : 'mobile number by SMS') + ' ending ' + ch.mobile.slice(-4) + '.' });
    } catch (e) { console.error('[forgot-username/verify] failed:', e && e.message); if (!res.headersSent) res.status(500).json({ error: 'Unable to verify the OTP right now. Please try again.' }); }
}
// === FORGOT USERNAME (OTP) END ===
// === MATERIAL (INVOICE) ACCOUNT RECOVERY START ===
// The Invoice login page's 3-step recovery modal calls these (all 6-digit WhatsApp OTP):
//   POST /api/material/recovery/send-otp          {purpose:'password-reset'|'userid-recovery', method:'mobile', contact, userId?}
//   POST /api/material/recovery/verify-otp        {purpose, method, contact, userId?, otp}
//        password-reset  → {resetToken}  (single use, 10 min)          userid-recovery → the User ID is sent on WhatsApp (anmol_libmatrix_login_info)
//   POST /api/material/recovery/reset-credentials {userId, mobile, newUserId, newPassword, resetToken}
// Aliases under /api/auth/recovery/* are registered too. Passwords are only ever stored hashed and are never sent back.
const MREC_PURPOSES = ['password-reset', 'userid-recovery'];
function _mrecKey(purpose, userId, mobile) { return 'mrec|' + purpose + '|' + (purpose === 'password-reset' ? lc(userId) : last10(mobile)); }
async function _mrecFind(purpose, userId, contact) {
    const c = String(contact || '').trim();
    if (purpose === 'password-reset') return findRecoveryAccount(userId, c, 'material');
    return findRecoveryAccount('', c, 'material');
}
const materialRecoverySendOtp = asyncRoute(async (req, res) => {
    const b = req.body || {};
    const purpose = String(b.purpose || '').trim(), userId = String(b.userId || b.user || '').trim(), contact = String(b.contact || b.mobile || '').trim();
    if (MREC_PURPOSES.indexOf(purpose) < 0) return res.status(400).json({ error: 'Invalid recovery request.' });
    if (!contact) return res.status(400).json({ error: 'Please enter your registered mobile number.' });
    if (purpose === 'password-reset' && !userId) return res.status(400).json({ error: 'Please enter your valid User ID.' });
    if (hitRateLimit('mrec:' + (req.ip || ''), 15, 10 * 60 * 1000) || hitRateLimit('mrecc:' + lc(contact), 6, 30 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    if (!(await otpServiceConfigured())) return res.status(501).json({ error: 'The WhatsApp OTP service is not configured. Please contact the administrator.' });
    const acc = await _mrecFind(purpose, userId, contact);
    const real = !!(acc && acc.kind === 'material' && acc.mobile.length === 10 && last10(contact) === acc.mobile);   // recovery is by registered MOBILE number
    const m4 = (real ? acc.mobile : last10(contact)).slice(-4) || '0000';
    const okBody = { success: true, channel: 'whatsapp', otpLength: OTP_LENGTH, expiresInSec: Math.round(OTP_TTL_MS / 1000), resendInSec: Math.round(OTP_RESEND_MS / 1000),
        message: 'A ' + OTP_LENGTH + '-digit OTP has been sent on WhatsApp to the registered mobile number ending ' + m4 + '.' };
    if (!real) {
        if (purpose === 'password-reset') return res.status(404).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
        return res.json(okBody);   // User-ID recovery: identical answer for unknown numbers (no account enumeration)
    }
    const key = _mrecKey(purpose, acc.userId, acc.mobile);
    const prev = await _otpStore.get(key);
    if (prev && Date.now() - prev.sentAt < OTP_RESEND_MS) return res.status(429).json({ error: 'Please wait before requesting a new OTP.', resendInSec: Math.ceil((OTP_RESEND_MS - (Date.now() - prev.sentAt)) / 1000) });
    const otp = String(crypto.randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH));
    try { await sendOtpMessage(acc.mobile, otp); } catch (e) { return otpSendFailed(res, e, 'material-recovery'); }
    await _otpStore.set(key, { hash: sha(otp), sentAt: Date.now(), exp: Date.now() + OTP_TTL_MS, tries: 0, userId: acc.userId, mobile: acc.mobile, name: acc.rec && acc.rec.name || '' });
    res.json(okBody);
});
const materialRecoveryVerifyOtp = asyncRoute(async (req, res) => {
    const b = req.body || {};
    const purpose = String(b.purpose || '').trim(), userId = String(b.userId || b.user || '').trim(), contact = String(b.contact || b.mobile || '').trim();
    const code = String(b.otp || b.code || '').replace(/\D/g, '');
    if (MREC_PURPOSES.indexOf(purpose) < 0 || code.length !== OTP_LENGTH) return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.', code: 'INVALID_OTP' });
    if (hitRateLimit('mrecv:' + (req.ip || ''), 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const bad = () => res.status(400).json({ error: 'Invalid or expired OTP. Please try again.', code: 'INVALID_OTP' });
    const acc = await _mrecFind(purpose, userId, contact);
    if (!acc || acc.kind !== 'material' || last10(contact) !== acc.mobile) return bad();
    const key = _mrecKey(purpose, acc.userId, acc.mobile);
    const o = await _otpStore.get(key);
    if (!o || Date.now() > o.exp) { await _otpStore.delete(key); return bad(); }
    o.tries++;
    if (o.tries > OTP_MAX_TRIES) { await _otpStore.delete(key); return bad(); }
    await _otpStore.set(key, o);
    if (!security.safeEqual(o.hash, sha(code))) return bad();
    await _otpStore.delete(key);   // one-time use
    if (purpose === 'password-reset') {
        const jti = crypto.randomBytes(16).toString('hex');
        await _otpStore.set('mrj|' + jti, { exp: Date.now() + 10 * 60 * 1000 });
        const resetToken = jwt.sign({ purpose: 'material-recovery', u: String(acc.userId), jti: jti }, JWT_SECRET, { expiresIn: '10m' });
        return res.json({ success: true, resetToken: resetToken, message: 'OTP verified. Set your new password.' });
    }
    // User-ID recovery: OTP proven → the User ID goes to the registered WhatsApp number through the INFO template. The password is hashed, so it is never sent.
    const via = await notifyAccount({ kind: 'userid_recovered', portal: 'invoice', mobile: acc.mobile, name: acc.rec && acc.rec.name, userId: acc.userId, link: portalLink(req) });
    if (!via) return res.status(424).json({ error: 'Your OTP was verified, but the message could not be delivered right now. Please try again shortly.', code: 'DELIVERY_FAILED' });
    res.json({ success: true, smsSent: via === 'sms', channel: via, message: 'Your User ID has been sent to your registered ' + (via === 'whatsapp' ? 'WhatsApp number' : 'mobile number by SMS') + ' ending ' + acc.mobile.slice(-4) + '.' });
});
const materialRecoveryReset = asyncRoute(async (req, res) => {
    const b = req.body || {};
    const userId = String(b.userId || '').trim(), newPassword = String(b.newPassword || ''), token = String(b.resetToken || '');
    if (hitRateLimit('mrecr:' + (req.ip || ''), 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must contain at least 8 characters.' });
    let d;
    try { d = jwt.verify(token, JWT_SECRET); } catch (e) { d = null; }
    const stored = d && d.purpose === 'material-recovery' && d.jti ? await _otpStore.get('mrj|' + d.jti) : null;
    if (!d || !stored || lc(d.u) !== lc(userId)) return res.status(401).json({ error: 'This reset session has expired. Please verify the OTP again.', code: 'INVALID_RESET_TOKEN' });
    await _otpStore.delete('mrj|' + d.jti);   // single use
    const rows = await dbq('SELECT id, userid, mobile FROM material_users WHERE userid = ?', [d.u]);
    if (!rows || !rows.length) return res.status(404).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
    await dbq('UPDATE material_users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), rows[0].id]);
    await revokeTrustedDevices(rows[0].userid);   // 🔒 password changed → every remembered device must pass the OTP again
    notifyAccount({ kind: 'password_changed', portal: 'invoice', mobile: rows[0].mobile, name: '', userId: rows[0].userid });   // confirmation, never contains the password
    const kept = String(b.newUserId || '').trim() && lc(b.newUserId) !== lc(rows[0].userid);
    res.json({ success: true, userId: rows[0].userid, message: 'Your password has been updated. Please sign in with User ID ' + rows[0].userid + ' and your new password.' + (kept ? ' (The User ID cannot be changed from this screen and stays the same.)' : '') });
});
['/api/material/recovery', '/api/auth/recovery'].forEach(base => {
    app.post(base + '/send-otp', noStore, materialRecoverySendOtp);
    app.post(base + '/verify-otp', noStore, materialRecoveryVerifyOtp);
    app.post(base + '/reset-credentials', noStore, materialRecoveryReset);
});
// === MATERIAL (INVOICE) ACCOUNT RECOVERY END ===
// Step 2 of the Super Admin "Reset Password" modal: checks the 6-digit OTP WITHOUT consuming it
// (reset-password re-checks and consumes it when the new password is saved).
async function verifyResetOtpHandler(req, res) {
    try {
        if (hitRateLimit('otpv:' + (req.ip || ''), 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
        const b = req.body || {};
        const userId = String(b.user || b.userId || b.username || '').trim();
        const contact = String(b.contact || '').trim();
        const code = String(b.code || b.otp || '').trim();
        if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.' });
        const acc = await findRecoveryAccount(userId, contact, recoveryScope(req));
        if (!acc || !recoveryExtraOk(acc, b)) return res.status(404).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
        const key = lc(acc.userId) + '|' + acc.kind;
        const o = await _otpStore.get(key);
        if (!o || Date.now() > o.exp) { await _otpStore.delete(key); return res.status(400).json({ error: 'OTP has expired. Please request a new OTP.' }); }
        o.tries++;
        await _otpStore.set(key, o);
        if (o.tries > OTP_MAX_TRIES) { await _otpStore.delete(key); return res.status(400).json({ error: 'OTP has expired. Please request a new OTP.' }); }
        if (o.hash !== sha(code)) return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.' });
        o.tries = 0; await _otpStore.set(key, o);   // a correct OTP does not use up an attempt (the final reset call checks it again)
        res.json({ success: true, message: 'OTP verified.' });
    } catch (e) {
        console.error('verify-reset-otp error:', e.message);
        res.status(500).json({ error: 'Unable to verify the OTP right now. Please try again.' });
    }
}

// ══════════════════════════════════════════════════════════════════
// 🔐 SUPER ADMIN LOGIN — 6-digit WhatsApp OTP + "Remember this device"
//   Step 1  POST /api/auth/admin-login-otp  {username, password, deviceToken?}
//             · wrong credentials → 401 (no OTP is sent)
//             · valid trusted-device token for this user → {skipped:true, trusted:true}  (no OTP)
//             · otherwise a 6-digit OTP is sent to the admin's registered mobile
//   Step 2  POST /api/auth/login  {role:'admin', username, password, otp, trustDevice}
//             · correct OTP → JWT (+ a random deviceToken when trustDevice is true; the browser keeps it)
//             · no OTP → accepted only with a valid deviceToken, else 401 OTP_REQUIRED
//   Trusted devices are stored hashed (sha256) in the otp_codes table, expire after TRUSTED_DEVICE_DAYS (default 90) and are
//   all revoked when the password is reset. Per-portal ON/OFF switches: see OTP_PORTAL_REGISTRY below (ADMIN_LOGIN_OTP=off = break-glass override).
// ══════════════════════════════════════════════════════════════════
const ADMIN_OTP_LEN = OTP_LENGTH;
const TRUSTED_DEVICE_MS = Math.max(1, parseInt(process.env.TRUSTED_DEVICE_DAYS || '365', 10) || 365) * 24 * 60 * 60 * 1000;
// 🎚️ PER-PORTAL OTP SWITCHES (Super Admin → sidebar → "OTP Settings")
//    ONE registry (OTP_PORTAL_REGISTRY) is the single source of truth for "which portals exist". The dashboard builds its switch list from
//    GET /api/admin/login-otp-setting, so a new portal appears there automatically after ONE call:
//        registerOtpPortal({ id: 'vendor', label: 'Vendor portal', icon: '🏭', description: '…', roles: ['vendor'] });
//    and its login route only has to call  adminSecondFactor(req, userId, 'vendor').
//    ON  → the portal enforces the 6-digit WhatsApp/SMS OTP (on a device that is not yet trusted).
//    OFF → Emergency Mode: that portal alone skips the OTP completely — ID + password only, no message is sent.
//    State is stored in the database (key cfg|login_otp → { portals:{ <id>: true|false }, by, at }) so it survives restarts and works on
//    serverless. Nothing is kept in the browser. A portal with no saved value uses its registered default; if the setting cannot be read the registered
//    defaults apply (a failed read never switches a protected portal OFF).
//    ADMIN_LOGIN_OTP=off in the environment is kept only as a break-glass override for the case where nobody can log in to flip a switch.
const OTP_PORTAL_REGISTRY = [];
function registerOtpPortal(def) {
    const id = lc(def && def.id).replace(/[^a-z0-9_-]/g, '');
    if (!id) throw new Error('registerOtpPortal: a portal id (letters, digits, - or _) is required');
    if (OTP_PORTAL_REGISTRY.some(p => p.id === id)) return id;   // registering twice is harmless
    OTP_PORTAL_REGISTRY.push({
        id: id,
        label: String((def && def.label) || id),
        icon: String((def && def.icon) || '🔐'),
        description: String((def && def.description) || ''),
        defaultOn: !(def && def.defaultOn === false),            // a new portal is protected (ON) unless it says otherwise
        roles: ((def && def.roles) || []).map(lc)                // login "role" values that belong to this portal (used by /auth/portal-otp/send)
    });
    return id;
}
// Order here = order of the switches in the dashboard.
registerOtpPortal({ id: 'invoice', label: 'Invoice portal', icon: '🧾', description: 'Invoice / material users — OTP on a new device only.', defaultOn: true });
registerOtpPortal({ id: 'agent', label: 'Agent portal', icon: '♟', description: 'Agent logins. (Staff users are not affected.)', defaultOn: false, roles: ['agent'] });
registerOtpPortal({ id: 'hrms', label: 'HRMS portal', icon: '👥', description: 'Employee (HRMS) logins.', defaultOn: false, roles: ['employee', 'hrms'] });
registerOtpPortal({ id: 'admin', label: 'Admin portal', icon: '🛡', description: 'Super Admin login.', defaultOn: true });
const otpPortalById = (id) => OTP_PORTAL_REGISTRY.find(p => p.id === lc(id)) || null;
const otpPortalByRole = (role) => OTP_PORTAL_REGISTRY.find(p => p.roles.indexOf(lc(role)) >= 0) || null;
const _otpForcedOff = () => String(process.env.ADMIN_LOGIN_OTP || 'on').toLowerCase() === 'off';
let _otpCfgCache = { v: null, t: 0 };
async function _otpCfgRecord(fresh) {
    if (!fresh && _otpCfgCache.v !== null && Date.now() - _otpCfgCache.t < 2000) return _otpCfgCache.v;   // short cache: an emergency OFF reaches every instance within ~2 s
    let r = null;
    try { r = (await _otpStore.get('cfg|login_otp')) || null; } catch (e) { r = null; }   // unreadable → registered defaults (never "everything OFF")
    _otpCfgCache = { v: r, t: Date.now() };
    return r;
}
function _otpPortalValue(cfg, portal) {
    if (cfg && cfg.portals && typeof cfg.portals[portal.id] === 'boolean') return cfg.portals[portal.id];
    return portal.defaultOn;
}
// Everything the dashboard needs, one entry per registered portal.
async function loginOtpPortalList(fresh) {
    const cfg = await _otpCfgRecord(fresh), forced = _otpForcedOff();
    return OTP_PORTAL_REGISTRY.map(p => {
        const enabled = _otpPortalValue(cfg, p);
        return { id: p.id, label: p.label, icon: p.icon, description: p.description, enabled: enabled, effective: enabled && !forced };
    });
}
async function loginOtpEnabled(portalId) {
    const portal = otpPortalById(portalId);
    if (!portal) { console.warn('[otp] unknown portal "' + portalId + '" — OTP stays ON. Register it with registerOtpPortal().'); return true; }
    if (_otpForcedOff()) return false;
    return _otpPortalValue(await _otpCfgRecord(), portal);
}
// patch = { <portalId>: true|false, … }  → returns the updated list. Unknown ids are rejected by the caller before this runs.
async function setLoginOtpPortals(patch, by) {
    const cfg = await _otpCfgRecord(true), portals = {};   // read fresh so two quick changes never overwrite each other
    OTP_PORTAL_REGISTRY.forEach(p => { portals[p.id] = typeof patch[p.id] === 'boolean' ? patch[p.id] : _otpPortalValue(cfg, p); });
    const rec = { portals: portals, by: String(by || ''), at: Date.now(), exp: Date.now() + 3650 * 24 * 60 * 60 * 1000 };
    await _otpStore.set('cfg|login_otp', rec);
    _otpCfgCache = { v: rec, t: Date.now() };
    return loginOtpPortalList(true);
}
// ── 📱 DEVICE TRUST ──────────────────────────────────────────────────────────────────────────────────────────────
//    After one successful OTP the device gets a random token. The server stores only its sha256 and ALSO hands it to the browser as a
//    long-lived HttpOnly cookie (am_dt_<hash of the user key>, TRUSTED_DEVICE_DAYS, default 365). The cookie survives logout,
//    localStorage.clear() / sessionStorage.clear() and the bridge's token wipe, which is what used to throw the token away and ask for
//    a fresh (paid) OTP on every login. The body field `deviceToken` is still accepted for older front-ends.
const _tdKey = (user, token) => 'td|' + lc(user) + '|' + sha(String(token));
const _tdCookie = (user) => 'am_dt_' + sha('dtc|' + lc(user)).slice(0, 16);
function _readCookie(req, name) {
    const h = String((req && req.headers && req.headers.cookie) || '');
    const parts = h.split(';');
    for (let i = 0; i < parts.length; i++) {
        const k = parts[i].indexOf('=');
        if (k > 0 && parts[i].slice(0, k).trim() === name) { try { return decodeURIComponent(parts[i].slice(k + 1).trim()); } catch (e) { return ''; } }
    }
    return '';
}
function _setDeviceCookie(req, user, token) {
    try {
        const res = req && req.res; if (!res || res.headersSent) return;
        const secure = IS_VERCEL || req.secure || /https/i.test(String((req.headers && req.headers['x-forwarded-proto']) || ''));
        res.append('Set-Cookie', _tdCookie(user) + '=' + token + '; Path=/; Max-Age=' + Math.floor(TRUSTED_DEVICE_MS / 1000) + '; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''));
    } catch (e) { /* cookie is a bonus — the body token still works */ }
}
async function isTrustedDevice(user, token) {
    token = String(token || '');
    if (!/^[0-9a-f]{64}$/.test(token)) return false;
    const r = await _otpStore.get(_tdKey(user, token));
    return !!(r && r.exp > Date.now());
}
// request-aware check: the cookie first, then the token the front-end may still send in the body
async function isTrustedDeviceReq(req, user, bodyToken) {
    const c = _readCookie(req, _tdCookie(user));
    if (c && await isTrustedDevice(user, c)) return true;
    return isTrustedDevice(user, bodyToken);
}
async function issueTrustedDevice(user, req) {
    const token = crypto.randomBytes(32).toString('hex');
    await _otpStore.set(_tdKey(user, token), { createdAt: Date.now(), exp: Date.now() + TRUSTED_DEVICE_MS, ua: String((req.headers && req.headers['user-agent']) || '').slice(0, 160) });
    _setDeviceCookie(req, user, token);
    return token;
}
async function revokeTrustedDevices(user) {
    const u = lc(user).replace(/[%_\\]/g, '');
    try { await ensureOtpTable(); for (const ns of [u, 'agent|' + u, 'hrms|' + u, 'mat|' + u]) await dbq('DELETE FROM otp_codes WHERE "key" LIKE ?', ['td|' + ns + '|%']); } catch (e) { console.warn('revokeTrustedDevices:', e.message); }
}
async function findAdminByCredentials(username, password, entity) {
    const list = parseEntityList(await readKv('kv_admin_entities', entity || 'admins'));
    const want = lc(username);
    const user = list.find(u => u && [u.username, u.email, u.id].some(f => f && lc(f) === want));
    if (!user) return { status: 401, error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' };
    if (!user.password) return { status: 401, error: AUTH_MSG.NO_PASS, code: 'NO_PASSWORD' };
    const ok = looksHashed(user.password) ? bcrypt.compareSync(password, user.password) : security.safeEqual(user.password, password);
    if (!ok) return { status: 401, error: AUTH_MSG.BAD_PASS, code: 'INVALID_PASSWORD' };
    if (['blocked', 'inactive', 'suspended', 'disabled'].includes(lc(user.status || 'active'))) return { status: 403, error: 'This account has been deactivated by the administrator.' };
    return { user: user, id: String(user.username || username) };
}
const adminLoginOtpHandler = asyncRoute(async (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim(), password = String(b.password || '');
    if (!username || !password) return res.status(400).json({ error: 'User ID and password are required.' });
    if (hitRateLimit('aotp:' + (req.ip || ''), 20, 10 * 60 * 1000) || hitRateLimit('aotpu:' + lc(username), 10, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const a = await findAdminByCredentials(username, password);
    if (a.error) return res.status(a.status).json({ error: a.error, code: a.code });
    if (!(await loginOtpEnabled('admin'))) return res.json({ success: true, skipped: true, otpDisabled: true });
    if (await isTrustedDeviceReq(req, a.id, b.deviceToken)) return res.json({ success: true, skipped: true, trusted: true });
    const mobile = last10(a.user.mobile || a.user.phone || a.user.contact || a.user.whatsapp);
    if (mobile.length !== 10) return res.status(422).json({ error: 'No registered mobile number is available for this account. Please contact the administrator.' });
    if (!(await otpServiceConfigured())) return res.status(501).json({ error: 'The WhatsApp OTP service is not configured. Please contact the administrator.' });
    const key = 'lotp|' + lc(a.id);
    const prev = await _otpStore.get(key);
    if (prev && Date.now() - prev.sentAt < OTP_RESEND_MS) {
        return res.status(429).json({ error: 'Please wait before requesting a new OTP.', resendInSec: Math.ceil((OTP_RESEND_MS - (Date.now() - prev.sentAt)) / 1000) });
    }
    const otp = String(crypto.randomInt(10 ** (ADMIN_OTP_LEN - 1), 10 ** ADMIN_OTP_LEN));
    let channel;
    try { channel = await sendOtpMessage(mobile, otp); }
    catch (e) { return otpSendFailed(res, e, 'admin-login-otp'); }
    await _otpStore.set(key, { hash: sha(otp), sentAt: Date.now(), exp: Date.now() + OTP_TTL_MS, tries: 0 });
    res.json({ success: true, channel: channel, message: 'A ' + ADMIN_OTP_LEN + '-digit OTP has been sent by ' + (channel === 'whatsapp' ? 'WhatsApp' : 'SMS') + ' to your registered mobile number ending ' + mobile.slice(-4) + '.', expiresInSec: Math.round(OTP_TTL_MS / 1000), resendInSec: Math.round(OTP_RESEND_MS / 1000) });
});
app.post('/api/auth/admin-login-otp', noStore, adminLoginOtpHandler);   // kept for backward compatibility

// ══════════════════════════════════════════════════════════════════
// 📲 POST /api/send-otp — single entry point for the Super Admin 6-digit OTP (WhatsApp template)
//   {purpose:'login',    username, password, deviceToken?}   → verifies the credentials FIRST; a wrong password never triggers an OTP
//   {purpose:'recovery', user, mobile|contact, email?}       → account must match the stored record (User ID + registered mobile)
//   The OTP is ALWAYS sent to the mobile number stored on the account — never to a number supplied by the browser — and only a
//   SHA-256 hash is stored (10-minute expiry, 60 s resend gap, 5 tries). Verification stays in /api/auth/login (login) and
//   /api/auth/verify-reset-otp + /api/auth/reset-password (recovery).
// ══════════════════════════════════════════════════════════════════
app.post('/api/send-otp', noStore, (req, res, next) => {
    if (hitRateLimit('sotp:' + (req.ip || ''), 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const purpose = lc((req.body || {}).purpose);
    if (purpose === 'login') return adminLoginOtpHandler(req, res, next);
    if (purpose === 'recovery' || purpose === 'forgot-password') { req.otpLen = ADMIN_OTP_LEN; return forgotPasswordHandler(req, res); }
    return res.status(400).json({ error: 'Invalid request. purpose must be "login" or "recovery".' });
});
// Public status: a login page may ask whether ITS portal needs an OTP step → GET /api/auth/otp-status?portal=invoice
app.get('/api/auth/otp-status', noStore, asyncRoute(async (req, res) => {
    const portal = otpPortalById(req.query && req.query.portal);
    if (!portal) return res.status(404).json({ error: 'Unknown portal.', portals: OTP_PORTAL_REGISTRY.map(p => p.id) });
    res.json({ enabled: await loginOtpEnabled(portal.id), portal: portal.id, length: OTP_LENGTH });
}));
const _otpSettingsPayload = async (fresh) => ({ portals: await loginOtpPortalList(fresh), forcedOff: _otpForcedOff(), length: OTP_LENGTH });
// Super Admin: GET → the full, registry-driven list.   POST { portal:'invoice', enabled:false }  or  { portals:{ invoice:false, agent:true } }
app.get('/api/admin/login-otp-setting', noStore, requireRole('admin'), asyncRoute(async (req, res) => { res.json(await _otpSettingsPayload(true)); }));
app.post('/api/admin/login-otp-setting', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {}, patch = {}, valid = OTP_PORTAL_REGISTRY.map(p => p.id);
    const put = (id, v) => { const p = otpPortalById(id); if (!p || typeof v !== 'boolean') return false; patch[p.id] = v; return true; };
    if (b.portals && typeof b.portals === 'object' && !Array.isArray(b.portals)) {
        for (const id of Object.keys(b.portals)) if (!put(id, b.portals[id])) return res.status(400).json({ error: 'Unknown portal "' + id + '" or a value that is not true/false. Valid portals: ' + valid.join(', ') + '.' });
    } else if (typeof b.portal === 'string') {
        if (!put(b.portal, b.enabled)) return res.status(400).json({ error: 'portal must be one of: ' + valid.join(', ') + ' and enabled must be true or false.' });
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change. Send { portal, enabled } or { portals:{…} }.' });
    const list = await setLoginOtpPortals(patch, req.authUser && (req.authUser.username || req.authUser.via));
    console.log('[otp-setting] ' + JSON.stringify(patch) + ' by ' + (req.authUser && req.authUser.username));
    res.json({ success: true, portals: list, forcedOff: _otpForcedOff(), length: OTP_LENGTH });
}));
// ══════════════════════════════════════════════════════════════════
// 🧾 INVOICE / MATERIAL PORTAL LOGIN — 6-digit WhatsApp OTP on a NEW device + "remember this device"
//   POST /api/material/login-otp/send    {userId, secondFactor, deviceToken?}
//        wrong User ID / password → normal 401/404 (no OTP is sent) · OTP switched OFF or device already trusted → {skipped:true}
//        otherwise a 6-digit OTP goes to the mobile number STORED on the account (never one supplied by the browser) via the WhatsApp OTP template
//   POST /api/material/login-otp/verify  {userId, secondFactor, code, trustDevice?}  → {otpToken}  (single-use, 10 min)
//   POST /api/material/login             {userId, secondFactor, otpToken? | deviceToken?}  → needs a valid otpToken or a trusted deviceToken
//        (returns a deviceToken when the user kept "remember this device" on).  /api/auth/login-otp/* are aliases of the same handlers.
// ══════════════════════════════════════════════════════════════════
async function findMaterialLoginUser(userId, secondFactor) {
    const rows = await dbq('SELECT * FROM material_users WHERE userid = ?', [String(userId)]);
    if (!rows || !rows.length) return { status: 404, error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' };
    const u = rows[0];
    const mobileMatches = last10(u.mobile) === last10(secondFactor);
    const passwordMatches = (u.password_hash && typeof u.password_hash === 'string') ? bcrypt.compareSync(secondFactor, u.password_hash) : false;
    if (!mobileMatches && !passwordMatches) return { status: 401, error: AUTH_MSG.BAD_PASS, code: 'INVALID_PASSWORD' };
    if (u.status === 'blocked') return { status: 403, error: 'This ID has been blocked by the administrator.', code: 'BLOCKED' };
    return { user: u };
}
const _matTd = (userid) => 'mat|' + lc(userid);   // trusted-device namespace for material users
const materialLoginOtpSend = asyncRoute(async (req, res) => {
    const b = req.body || {};
    const userId = String(b.userId || '').trim(), secondFactor = b.secondFactor != null ? String(b.secondFactor) : '';
    if (!userId || !secondFactor) return res.status(400).json({ error: 'User ID and Mobile/Password are both required.' });
    if (hitRateLimit('motp:' + (req.ip || ''), 25, 10 * 60 * 1000) || hitRateLimit('motpu:' + lc(userId), 10, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const m = await findMaterialLoginUser(userId, secondFactor);
    if (m.error) return res.status(m.status).json({ error: m.error, code: m.code });
    if (!(await loginOtpEnabled('invoice'))) return res.json({ success: true, skipped: true, otpDisabled: true });
    if (await isTrustedDeviceReq(req, _matTd(m.user.userid), b.deviceToken)) return res.json({ success: true, skipped: true, trusted: true });
    const mobile = last10(m.user.mobile);
    if (mobile.length !== 10) return res.status(422).json({ error: 'No registered mobile number is available for this account. Please contact the administrator.' });
    if (!(await otpServiceConfigured())) return res.status(501).json({ error: 'The WhatsApp OTP service is not configured. Please contact the administrator.' });
    const key = 'lotp|mat|' + lc(m.user.userid);
    const prev = await _otpStore.get(key);
    if (prev && Date.now() - prev.sentAt < OTP_RESEND_MS) {
        return res.status(429).json({ error: 'Please wait before requesting a new OTP.', resendInSec: Math.ceil((OTP_RESEND_MS - (Date.now() - prev.sentAt)) / 1000) });
    }
    const otp = String(crypto.randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH));
    let channel;
    try { channel = await sendOtpMessage(mobile, otp); }
    catch (e) { return otpSendFailed(res, e, 'material-login-otp'); }
    await _otpStore.set(key, { hash: sha(otp), sentAt: Date.now(), exp: Date.now() + OTP_TTL_MS, tries: 0 });
    res.json({ success: true, channel: channel, message: 'A ' + OTP_LENGTH + '-digit OTP has been sent on WhatsApp to your registered mobile number ending ' + mobile.slice(-4) + '.', expiresInSec: Math.round(OTP_TTL_MS / 1000), resendInSec: Math.round(OTP_RESEND_MS / 1000) });
});
const materialLoginOtpVerify = asyncRoute(async (req, res) => {
    const b = req.body || {};
    const userId = String(b.userId || '').trim(), secondFactor = b.secondFactor != null ? String(b.secondFactor) : '';
    const code = String(b.code || b.otp || '').replace(/\D/g, '');
    if (!userId || !secondFactor) return res.status(400).json({ error: 'User ID and Mobile/Password are both required.' });
    if (hitRateLimit('motpv:' + (req.ip || ''), 40, 10 * 60 * 1000) || hitRateLimit('motpvu:' + lc(userId), 15, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const m = await findMaterialLoginUser(userId, secondFactor);
    if (m.error) return res.status(m.status).json({ error: m.error, code: m.code });
    const bad = { error: 'Invalid or expired OTP. Please try again.', code: 'INVALID_OTP' };
    const key = 'lotp|mat|' + lc(m.user.userid);
    const o = await _otpStore.get(key);
    if (!o || Date.now() > o.exp) { await _otpStore.delete(key); return res.status(401).json(bad); }
    o.tries++;
    await _otpStore.set(key, o);
    if (o.tries > OTP_MAX_TRIES) { await _otpStore.delete(key); return res.status(401).json(bad); }
    if (code.length !== OTP_LENGTH || !security.safeEqual(o.hash, sha(code))) return res.status(401).json(bad);
    await _otpStore.delete(key);   // one-time use
    const jti = crypto.randomBytes(16).toString('hex');
    await _otpStore.set('mjti|' + jti, { exp: Date.now() + 10 * 60 * 1000 });
    const trust = !(b.trustDevice === false || b.trustDevice === 'false' || b.trustDevice === 0 || b.trustDevice === '0');
    const otpToken = jwt.sign({ purpose: 'material-login-otp', u: String(m.user.userid), jti: jti, trust: trust }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ success: true, otpToken: otpToken });
});
['/api/material/login-otp', '/api/auth/login-otp'].forEach(base => {
    app.post(base + '/send', noStore, materialLoginOtpSend);
    app.post(base + '/verify', noStore, materialLoginOtpVerify);
});
// Second factor for POST /api/material/login → {ok:true, deviceToken?} or {status, body}
async function materialOtpGate(req, userid) {
    if (!(await loginOtpEnabled('invoice'))) return { ok: true };
    const b = req.body || {};
    if (b.otpToken) {
        try {
            const d = jwt.verify(String(b.otpToken), JWT_SECRET);
            if (d && d.purpose === 'material-login-otp' && lc(d.u) === lc(userid) && d.jti && await _otpStore.get('mjti|' + d.jti)) {
                await _otpStore.delete('mjti|' + d.jti);   // single use
                return { ok: true, deviceToken: d.trust ? await issueTrustedDevice(_matTd(userid), req) : undefined };
            }
        } catch (e) { /* fall through */ }
        return { status: 401, body: { error: 'Invalid or expired verification code. Please try again.', code: 'INVALID_OTP' } };
    }
    if (await isTrustedDeviceReq(req, _matTd(userid), b.deviceToken)) return { ok: true };
    return { status: 401, body: { error: 'OTP verification is required on this device.', code: 'OTP_REQUIRED' } };
}
// Called by /api/auth/login (admin role): returns null when the login may continue, otherwise {status, body}.
async function adminSecondFactor(req, userId, portal) {
    portal = portal || 'admin';
    if (!(await loginOtpEnabled(portal))) return { ok: true };            // switch OFF for this portal → ID + password only, no WhatsApp message
    const ns = portal === 'admin' ? userId : portal + '|' + userId;       // trusted-device namespace (admin keeps its original one)
    const b = req.body || {};
    const otp = String(b.otp || '').replace(/\D/g, '');
    if (!otp) {
        if (await isTrustedDeviceReq(req, ns, b.deviceToken)) return { ok: true };
        return { status: 401, body: { error: 'OTP verification is required on this device.', code: 'OTP_REQUIRED' } };
    }
    if (hitRateLimit('aotpv:' + portal + ':' + lc(userId), 15, 10 * 60 * 1000)) return { status: 429, body: { error: 'Too many attempts. Please try again later.' } };
    const key = portal === 'admin' ? 'lotp|' + lc(userId) : 'lotp|' + portal + '|' + lc(userId);
    const o = await _otpStore.get(key);
    const bad = { status: 401, body: { error: 'Invalid or expired verification code. Please try again.', code: 'INVALID_OTP' } };
    if (!o || Date.now() > o.exp) { await _otpStore.delete(key); return bad; }
    o.tries++;
    await _otpStore.set(key, o);
    if (o.tries > OTP_MAX_TRIES) { await _otpStore.delete(key); return bad; }
    if (otp.length !== ADMIN_OTP_LEN || !security.safeEqual(o.hash, sha(otp))) return bad;
    await _otpStore.delete(key);   // one-time use
    // 📱 a device that passed the OTP is remembered by default (the 'Remember this device' box can opt out with trustDevice:false)
    const remember = !(b.trustDevice === false || b.trustDevice === 'false' || b.trustDevice === 0 || b.trustDevice === '0');
    return { ok: true, deviceToken: remember ? await issueTrustedDevice(ns, req) : undefined };
}
// 📲 Agent / HRMS login OTP — POST /api/auth/portal-otp/send {role:'agent'|'employee', username, password | mobile}
//    Wrong credentials → normal 401 (no OTP). Switch OFF for that portal, or a trusted device → {skipped:true} (nothing is sent).
app.post('/api/auth/portal-otp/send', noStore, asyncRoute(async (req, res) => {
    const b = req.body || {};
    const roleKey = lc(b.role);
    const portalDef = otpPortalByRole(roleKey), portal = portalDef ? portalDef.id : null;   // agent → agent, employee/hrms → hrms (registry)
    const username = String(b.username || '').trim();
    // this endpoint knows how to look up Agent and HRMS accounts only; another portal needs its own send route (see registerOtpPortal)
    if (!portal || (portal !== 'agent' && portal !== 'hrms') || !username) return res.status(400).json({ error: 'Role and User ID are required.' });
    if (hitRateLimit('potp:' + (req.ip || ''), 25, 10 * 60 * 1000) || hitRateLimit('potpu:' + portal + ':' + lc(username), 10, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    let id, mobile;
    if (portal === 'agent') {
        const password = String(b.password || '');
        if (!password) return res.status(400).json({ error: 'Password is required.' });
        const a = await findAdminByCredentials(username, password, 'agents');
        if (a.error) return res.status(a.status).json({ error: a.error, code: a.code });
        id = a.id; mobile = last10(a.user.mobile || a.user.phone || a.user.contact || a.user.whatsapp);
    } else {
        const list = await readKv('kv_blob', 'hrms_employees');
        const emp = (Array.isArray(list) ? list : []).find(e => e && String(e.empId || '').toUpperCase() === username.toUpperCase());
        if (!emp) return res.status(401).json({ error: AUTH_MSG.NO_USER, code: 'USER_NOT_FOUND' });
        const empMobile = last10(emp.phone || emp.mobile);
        if (!empMobile) return res.status(401).json({ error: AUTH_MSG.NO_MOBILE, code: 'NO_MOBILE' });
        if (empMobile !== last10(b.mobile)) return res.status(401).json({ error: AUTH_MSG.BAD_MOBILE, code: 'INVALID_MOBILE' });
        if (emp.status === 'inactive' || emp.status === 'blocked') return res.status(403).json({ error: 'This Employee ID is blocked or inactive. Please contact the administrator.' });
        if (emp.status && emp.status !== 'active') return res.status(403).json({ error: 'Your admin verification is still pending. You can log in only after verification.' });
        id = username.toUpperCase(); mobile = empMobile;
    }
    if (!(await loginOtpEnabled(portal))) return res.json({ success: true, skipped: true, otpDisabled: true });
    if (await isTrustedDeviceReq(req, portal + '|' + id, b.deviceToken)) return res.json({ success: true, skipped: true, trusted: true });
    if (mobile.length !== 10) return res.status(422).json({ error: 'No registered mobile number is available for this account. Please contact the administrator.' });
    if (!(await otpServiceConfigured())) return res.status(501).json({ error: 'The WhatsApp OTP service is not configured. Please contact the administrator.' });
    const key = 'lotp|' + portal + '|' + lc(id);
    const prev = await _otpStore.get(key);
    if (prev && Date.now() - prev.sentAt < OTP_RESEND_MS) return res.status(429).json({ error: 'Please wait before requesting a new OTP.', resendInSec: Math.ceil((OTP_RESEND_MS - (Date.now() - prev.sentAt)) / 1000) });
    const otp = String(crypto.randomInt(10 ** (ADMIN_OTP_LEN - 1), 10 ** ADMIN_OTP_LEN));
    let channel;
    try { channel = await sendOtpMessage(mobile, otp); }
    catch (e) { return otpSendFailed(res, e, portal + '-login-otp'); }
    await _otpStore.set(key, { hash: sha(otp), sentAt: Date.now(), exp: Date.now() + OTP_TTL_MS, tries: 0 });
    res.json({ success: true, channel: channel, message: 'A ' + ADMIN_OTP_LEN + '-digit OTP has been sent by ' + (channel === 'whatsapp' ? 'WhatsApp' : 'SMS') + ' to your registered mobile number ending ' + mobile.slice(-4) + '.', expiresInSec: Math.round(OTP_TTL_MS / 1000), resendInSec: Math.round(OTP_RESEND_MS / 1000) });
}));
// 🧪 POST /api/admin/whatsapp-test {mobile, template:'otp'|'info'} (admin only) — sends ONE real test message and returns the exact gateway error, if any.
app.post('/api/admin/whatsapp-test', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {}, mobile = last10(b.mobile);
    if (mobile.length !== 10) return res.status(400).json({ error: 'A valid 10-digit mobile number is required.' });
    const out = { config: wa.describe() };
    try {
        if (String(b.template || 'info') === 'otp') await wa.sendOtp(mobile, String(crypto.randomInt(10 ** (OTP_LENGTH - 1), 10 ** OTP_LENGTH)));
        else await wa.sendLoginInfo(mobile, { name: 'Test User', userId: 'TEST001', password: 'Test@1234', portal: b.portal || '', link: liveBaseUrl(req) });
        out.success = true;
    } catch (e) { out.success = false; out.error = String(e && e.message || e).slice(0, 400); }
    res.json(out);
}));
// 🩺 OTP health check — GET /api/auth/otp-diagnostics with header  x-diag-secret: <OTP_DIAG_SECRET>  (route is disabled unless that env var is set).
//    Shows whether the WhatsApp credentials / templates / database are configured; never returns any secret. Add  &send=9XXXXXXXXX  to send a real test OTP.
app.get('/api/auth/otp-diagnostics', noStore, asyncRoute(async (req, res) => {
    if (!process.env.OTP_DIAG_SECRET || !security.safeEqual(String(req.headers['x-diag-secret'] || ''), process.env.OTP_DIAG_SECRET)) return res.status(404).json({ error: 'Not found' });
    const out = Object.assign({ origin: req.headers.origin || null, originAllowed: req.headers.origin ? isOriginAllowed(req.headers.origin) : null, nodeEnv: process.env.NODE_ENV || null }, { whatsapp: wa.describe() });
    try { await ensureOtpTable(); out.otpTable = 'ok'; } catch (e) { out.otpTable = 'ERROR: ' + e.message; }
    if (req.query.send) { try { out.testSend = 'ok via ' + await sendOtpMessage(String(req.query.send), String(crypto.randomInt(10 ** (ADMIN_OTP_LEN - 1), 10 ** ADMIN_OTP_LEN))); } catch (e) { out.testSend = 'ERROR: ' + e.message; } }
    res.json(out);
}));
['/api/auth', '/api/agent', '/api/material'].forEach(base => {
    app.post(base + '/verify-reset-otp', verifyResetOtpHandler);
    app.post(base + '/forgot-password', forgotPasswordHandler);
    app.post(base + '/reset-password', resetPasswordHandler);
});
['/api/auth/forgot-username', '/api/material/forgot-user-id', '/api/material/forgot-username', '/api/agent/forgot-username'].forEach(p => {
    app.post(p, forgotUsernameHandler);
    app.post(p + '/resend', forgotUsernameResendHandler);
    app.post(p + '/verify', forgotUsernameVerifyHandler);
});

// Official SMS with User ID, Password and Portal link (used when an agent is created or approved)
function buildCredentialsMessage(name, userId, password, link, template) {
    const base = template || 'Hello {name}, your Anmol LibMatrix login is ready. User ID: {user} Password: {pass} Portal: {link}';
    return base.replace(/\{name\}/g, name || 'User').replace(/\{user\}/g, userId).replace(/\{pass\}/g, password).replace(/\{link\}/g, link || '');
}
// (autoSendAgentCredentials was replaced by autoNotifyEntityCredentials — WhatsApp first, SMS fallback)
// Manual "send credentials" route removed: messages are now dispatched automatically on approval / creation.
app.get('/api/admin/credential-delivery/:userId', requireRole('admin'), noStore, asyncRoute(async (req, res) => {
    const r = await _otpStore.get('cn|' + lc(req.params.userId));
    res.json({ status: r ? r.status : 'unknown', channel: (r && r.channel) || null, at: (r && r.at) || null });
}));

// Announcement / ticker settings (public read, Super Admin write)
async function readAnnouncements() {
    const r = await dbq('SELECT value FROM kv_site_data WHERE `key` = ?', ['announcements']);
    let v = {}; try { v = JSON.parse(r[0] && r[0].value) || {}; } catch (e) { v = {}; }
    return { items: Array.isArray(v.items) ? v.items : [], speed: Number(v.speed) || 40, updatedAt: v.updatedAt || null };
}
app.get('/api/admin/announcements', noStore, async (req, res) => {
    try { res.json(await readAnnouncements()); } catch (e) { res.json({ items: [], speed: 40 }); }
});
async function saveAnnouncements(req, res) {
    try {
        const b = req.body || {};
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map(i => ({
            text: cleanText(i && i.text, 300), url: /^(https?:\/\/|\/|[A-Za-z0-9_\-./]+\.html)/i.test(String(i && i.url || '').trim()) ? String(i.url).trim().slice(0, 500) : '',
            active: !(i && i.active === false)
        })).filter(i => i.text);
        const out = { items, speed: Math.min(Math.max(Number(b.speed) || 40, 10), 120), updatedAt: new Date().toISOString() };
        await dbq('INSERT INTO kv_site_data ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', ['announcements', JSON.stringify(out)]);
        res.json(Object.assign({ success: true }, out));
    } catch (e) { res.status(500).json({ error: 'Unable to save the announcements.' }); }
}
app.put('/api/admin/announcements', requireRole('admin'), saveAnnouncements);
app.post('/api/admin/announcements', requireRole('admin'), saveAnnouncements);

app.get('/api/students/next-id', (req, res) => {
    db.query("SELECT value FROM kv_admin_entities WHERE \"key\"='students'", (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        let students = [];
        try { students = rows && rows.length ? JSON.parse(rows[0].value) : []; } catch (e) {}
        // ♻️ lowest vacant SHL number (gap-filling). Read-only preview → no hold is placed.
        const used = (students || []).map(s => (s && (s.studentId || s.id)) || '');
        res.json({ nextId: allocateVacantId('SHL', 'SHL-', used, { reserve: false }) });
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

// ── Low-level Razorpay call (any method). Every failure is written to the Render log with the exact reason. ──
function razorpayCall(method, path, body) {
    return new Promise((resolve, reject) => {
        const key = process.env.PAYMENT_API_KEY;
        const secret = process.env.PAYMENT_API_SECRET;
        if (!key || !secret) return reject(new Error('PAYMENT_API_KEY / PAYMENT_API_SECRET are not set in the Render Environment.'));
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
                let parsed;
                try { parsed = data ? JSON.parse(data) : {}; }
                catch (e) {
                    console.error('❌ Razorpay ' + method + ' ' + path + ' — unreadable (non-JSON) response, HTTP ' + resp.statusCode + ':', String(data).slice(0, 300));
                    return reject(new Error('Razorpay returned an unreadable response (HTTP ' + resp.statusCode + ').'));
                }
                if (resp.statusCode >= 200 && resp.statusCode < 300) return resolve(parsed);
                const er = parsed.error || {};
                console.error('❌ Razorpay API error — ' + method + ' ' + path + ' | HTTP ' + resp.statusCode + ' | code=' + (er.code || '-') + ' | reason=' + (er.reason || '-') + ' | field=' + (er.field || '-') + ' | description=' + (er.description || '-'));
                const err = new Error(er.description || ('Razorpay API error (HTTP ' + resp.statusCode + ')'));
                err.razorpay = er; err.httpStatus = resp.statusCode;
                reject(err);
            });
        });
        reqStream.setTimeout(20000, () => reqStream.destroy(new Error('Razorpay request timed out (20s)')));
        reqStream.on('error', (e) => { console.error('❌ Razorpay ' + method + ' ' + path + ' — network error:', e.message); reject(e); });
        if (payload) reqStream.write(payload);
        reqStream.end();
    });
}

// Order creation. 🔒 FIX (auto-refund): every order is created with payment_capture:1 (AUTOMATIC capture).
// An order created without it leaves the live payment only "authorized"; Razorpay auto-refunds an authorized
// payment that is never captured — the customer is charged, then refunded, and the invoice never unlocks.
function razorpayRequest(path, body) {
    const isOrder = /^\/v1\/orders\/?$/.test(path);
    // Merchant/biller identity is recorded on every order (shows in the Razorpay dashboard, webhooks and logs).
    const withCapture = (isOrder && body && body.payment_capture === undefined)
        ? Object.assign({ payment_capture: 1 }, body, { notes: Object.assign({ merchant: 'Anmol LibMatrix' }, body.notes || {}) })
        : body;
    return razorpayCall('POST', path, withCapture).catch((e) => {
        // If this account rejects the payment_capture flag, retry once without it (capture is then enforced in
        // razorpayConfirmPayment() + the payment webhook below, so the payment is still never left uncaptured).
        if (withCapture !== body && e && e.razorpay && /payment_capture/i.test((e.razorpay.field || '') + ' ' + (e.razorpay.description || ''))) {
            console.warn('⚠️ Razorpay rejected payment_capture on order creation — retrying without it (capture will be forced after payment).');
            return razorpayCall('POST', path, body);
        }
        throw e;
    });
}

// 🔒 PAYMENT CONFIRMATION — called by every /verify route AFTER the HMAC signature check.
//   • fetches the payment from Razorpay and checks that it belongs to the SAME order id the checkout reported,
//     that the amount (paise) equals what the server fixed when the order was created, and the currency is INR;
//   • if the payment is only "authorized", CAPTURES it right now (prevents the auto-refund);
//   • returns only when the payment is "captured". Every rejection is logged with the exact reason.
//   If Razorpay itself cannot be reached the signature has already proved the payment — we log and continue.
async function razorpayConfirmPayment(orderId, paymentId, expectedRupees) {
    const tag = '[razorpay-verify order=' + orderId + ' payment=' + paymentId + ']';
    const fail = (msg) => { const e = new Error(msg); e.code = 'PAYMENT_VERIFY'; return e; };
    let p;
    try { p = await razorpayCall('GET', '/v1/payments/' + encodeURIComponent(paymentId)); }
    catch (e) {
        console.error('⚠️ ' + tag + ' could not fetch the payment from Razorpay (signature was valid, continuing):', e.message);
        return { verified: false, status: 'unknown' };
    }
    if (String(p.order_id || '') !== String(orderId)) {
        console.error('❌ ' + tag + ' ORDER ID MISMATCH — this payment belongs to order "' + p.order_id + '", checkout reported "' + orderId + '".');
        throw fail('Payment does not belong to this order.');
    }
    if (expectedRupees !== undefined && expectedRupees !== null) {
        const expectedPaise = Math.round(Number(expectedRupees) * 100);
        if (Number(p.amount) !== expectedPaise) {
            console.error('❌ ' + tag + ' AMOUNT MISMATCH — Razorpay paid ' + p.amount + ' paise, server expected ' + expectedPaise + ' paise.');
            throw fail('Paid amount does not match the amount fixed for this order.');
        }
    }
    if (p.currency && p.currency !== 'INR') {
        console.error('❌ ' + tag + ' CURRENCY MISMATCH — ' + p.currency + '.');
        throw fail('Payment currency is not INR.');
    }
    if (p.status === 'authorized') {
        try {
            p = await razorpayCall('POST', '/v1/payments/' + encodeURIComponent(paymentId) + '/capture', { amount: p.amount, currency: p.currency || 'INR' });
            console.log('✅ ' + tag + ' authorized payment captured (₹' + (p.amount / 100) + ').');
        } catch (e) {
            // Race: the webhook (or auto-capture) may have captured it a moment earlier — re-read before giving up.
            let again = null;
            try { again = await razorpayCall('GET', '/v1/payments/' + encodeURIComponent(paymentId)); } catch (e2) { /* logged above */ }
            if (again && again.status === 'captured') { p = again; console.log('✅ ' + tag + ' already captured by another path (race handled).'); }
            else { console.error('❌ ' + tag + ' CAPTURE FAILED — ' + e.message + ' (payment would be auto-refunded by Razorpay).'); throw fail('Payment could not be captured: ' + e.message); }
        }
    }
    if (p.status === 'captured') return { verified: true, status: 'captured', payment: p };
    console.error('❌ ' + tag + ' payment status is "' + p.status + '" (error_code=' + (p.error_code || '-') + ', reason=' + (p.error_description || p.error_reason || '-') + ') — not treated as paid.');
    throw fail('Payment is not complete (status: ' + p.status + ').');
}

// 🔔 RAZORPAY PAYMENT WEBHOOK  →  POST /api/webhooks/razorpay
//   Dashboard → Settings → Webhooks: URL https://<your-render-domain>/api/webhooks/razorpay
//   Events: payment.authorized, payment.captured, order.paid, payment.failed, refund.created, refund.processed
//   Secret → Render env RAZORPAY_WEBHOOK_SECRET.   (The RazorpayX payout webhook above is a different route.)
//   • payment.authorized → capture immediately (no auto-refund even if the browser never returned);
//   • payment.captured / order.paid → mark the material invoice payment "paid" (only if order id + amount match);
//     the browser's /verify call is idempotent, so webhook-first or browser-first both work (no race);
//   • payment.failed / refund.* → logged with the exact reason in the Render log.
app.post('/api/webhooks/razorpay', async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET;
    if (!secret) { console.error('❌ Razorpay payment webhook received but RAZORPAY_WEBHOOK_SECRET is not set in Render — cannot verify, ignored.'); return res.status(501).json({ error: 'Webhook secret not configured.' }); }
    const raw = req.rawBody;
    if (!raw) { console.error('❌ Razorpay payment webhook: raw body unavailable, cannot verify signature.'); return res.status(400).json({ error: 'Raw body missing.' }); }
    const sig = Buffer.from(String(req.headers['x-razorpay-signature'] || ''));
    const exp = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
    if (sig.length !== exp.length || !crypto.timingSafeEqual(sig, exp)) {
        console.error('❌ Razorpay payment webhook: INVALID SIGNATURE — request ignored (check RAZORPAY_WEBHOOK_SECRET matches the Dashboard secret).');
        return res.status(400).json({ error: 'Invalid signature' });
    }
    const body = req.body || {};
    const event = String(body.event || '');
    const pl = body.payload || {};
    const pay = pl.payment && pl.payment.entity;
    const ord = pl.order && pl.order.entity;
    const orderId = String((pay && pay.order_id) || (ord && ord.id) || (pl.refund && pl.refund.entity && pl.refund.entity.notes && pl.refund.entity.notes.order_id) || '');
    const paymentId = String((pay && pay.id) || (pl.refund && pl.refund.entity && pl.refund.entity.payment_id) || '');
    const tag = '[razorpay-webhook ' + event + ' order=' + orderId + ' payment=' + paymentId + ']';
    console.log('📩 ' + tag + (pay ? ' status=' + pay.status + ' amount=' + pay.amount : ''));
    try {
        if (event === 'payment.authorized' && pay) {
            await razorpayConfirmPayment(orderId, paymentId);   // captures the authorized payment (no auto-refund)
        } else if ((event === 'payment.captured' || event === 'order.paid') && orderId) {
            const paidRs = pay ? Number(pay.amount) / 100 : (ord ? Number(ord.amount_paid) / 100 : null);
            const rows = await dbq('SELECT status, amount FROM material_invoice_payments WHERE order_id=?', [orderId]);
            if (!rows.length) {
                console.log('ℹ️ ' + tag + ' not a material-invoice order — nothing to mark here.');
            } else if (paidRs !== null && Math.abs(Number(rows[0].amount) - paidRs) > 0.001) {
                console.error('❌ ' + tag + ' AMOUNT MISMATCH — Razorpay received ₹' + paidRs + ', order was created for ₹' + rows[0].amount + '. Invoice NOT marked Paid.');
            } else if (rows[0].status === 'created') {
                const up = await dbq("UPDATE material_invoice_payments SET status='paid', payment_id=?, paid_at=CURRENT_TIMESTAMP WHERE order_id=? AND status='created' RETURNING order_id", [paymentId || null, orderId]);
                console.log((up.length ? '✅ ' : 'ℹ️ ') + tag + (up.length ? ' invoice payment marked Paid.' : ' already updated by the browser verify call.'));
            } else {
                console.log('ℹ️ ' + tag + ' invoice payment already "' + rows[0].status + '" — nothing to do.');
            }
        } else if (event === 'payment.failed' && pay) {
            console.warn('⚠️ ' + tag + ' PAYMENT FAILED — code=' + (pay.error_code || '-') + ' source=' + (pay.error_source || '-') + ' step=' + (pay.error_step || '-') + ' reason=' + (pay.error_reason || '-') + ' description=' + (pay.error_description || '-'));
        } else if (/^refund\./.test(event)) {
            const rf = (pl.refund && pl.refund.entity) || {};
            console.warn('⚠️ ' + tag + ' REFUND — refund=' + rf.id + ' amount=' + rf.amount + ' status=' + rf.status + ' speed=' + (rf.speed_processed || rf.speed_requested || '-') + ' notes=' + JSON.stringify(rf.notes || {}) + ' (an AUTO-refund means the payment stayed "authorized" and was never captured).');
        }
        res.status(200).json({ ok: true });
    } catch (e) {
        console.error('❌ ' + tag + ' webhook processing FAILED:', (e && e.stack) || e);
        if (!res.headersSent) res.status(500).json({ error: 'Webhook processing failed — Razorpay will retry.' });
    }
});

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

app.post('/api/payments/razorpay/verify', async (req, res) => {
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
        { console.error('❌ Payment signature MISMATCH — order=' + razorpay_order_id + ' payment=' + razorpay_payment_id + ' (wrong PAYMENT_API_SECRET for this key, or the checkout payload was altered).'); return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' }); }
    }
    try { await razorpayConfirmPayment(razorpay_order_id, razorpay_payment_id); } catch (e) { console.error('❌ verify rejected:', e.message); return res.status(402).json({ error: e.message }); }
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

// ── Active invoice fee for one material user (Supabase: kv_blob 'material_invoice_settings' + per-user override) ──
//    Priority: Admin-exempt → ₹0 | per-user amount (0 = free) | global amount. Global switch "enabled=false" → ₹0.
async function materialInvoiceFeeFor(userId) {
    const rows = await dbq('SELECT invoicePaymentExempt AS "invoicePaymentExempt", invoiceAmount AS "invoiceAmount" FROM material_users WHERE userid = ?', [String(userId || '')]);
    const exempt = !!(rows[0] && rows[0].invoicePaymentExempt);
    const userAmount = rows[0] ? sanitizeInvoiceAmount(rows[0].invoiceAmount) : null;
    const st = await xBlobGet('material_invoice_settings', {});
    const enabled = !st || st.enabled !== false;
    const gRaw = st ? st.amount : undefined;
    const globalAmount = (gRaw === undefined || gRaw === null || gRaw === '' || !isFinite(Number(gRaw)) || Number(gRaw) < 0) ? 10 : Math.round(Number(gRaw) * 100) / 100;
    const amount = userAmount !== null ? userAmount : globalAmount;
    const fee = (!enabled || exempt) ? 0 : amount;
    return { fee, paymentRequired: fee > 0, amount, exempt, enabled, isCustomAmount: userAmount !== null };
}
// Who is the invoice owner? Material user → self. Admin (editing on behalf of a user) → ownerUserId from request.
function invoiceOwnerFromReq(req) {
    const isAdmin = String(req.authUser.role || '').toLowerCase() === 'admin';
    const owner = isAdmin ? cleanText((req.body && req.body.ownerUserId) || req.query.ownerUserId, 50) : req.authUser.userId;
    return { isAdmin, owner };
}

// Fee check — payment needed? and how much? (display only; the real charge is re-computed on order creation)
app.get('/api/material/invoice-payment/config', noStore, requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    if (!owner) return res.status(400).json({ error: 'ownerUserId is required.' });
    const cfg = await materialInvoiceFeeFor(owner);
    cfg.walletBalance = await walletBalanceOf(owner);
    res.json(cfg);
}));

// Order — fee is ALWAYS read from the database. ₹0 → no order, gateway bypassed (free:true).
app.post('/api/material/invoice-payment/order', requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    if (!owner) return res.status(400).json({ error: 'ownerUserId is required.' });
    const f = await materialInvoiceFeeFor(owner);
    if (!f.paymentRequired) return res.json({ free: true, fee: 0, amount: 0 });
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) {
        return res.status(501).json({ error: 'Payment keys are not set in the Render Environment.' });
    }
    const purpose = String((req.body && req.body.purpose) || 'generate') === 'update' ? 'update' : 'generate';
    let order;
    try {
        order = await razorpayRequest('/v1/orders', { amount: Math.round(f.fee * 100), currency: 'INR', receipt: ('inv_' + owner + '_' + Date.now()).slice(0, 40) });
    } catch (e) { return res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message }); }
    await dbq('INSERT INTO material_invoice_payments (order_id, owner_user_id, amount, purpose) VALUES (?,?,?,?)', [order.id, owner, f.fee, purpose]);
    res.json({ free: false, orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, fee: f.fee });
}));

// Verify — Razorpay signature + order must belong to this owner. Returns a 10-minute unlock token (single use).
app.post('/api/material/invoice-payment/verify', requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!owner || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
    }
    const expected = crypto.createHmac('sha256', secret).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        { console.error('❌ Payment signature MISMATCH — order=' + razorpay_order_id + ' payment=' + razorpay_payment_id + ' (wrong PAYMENT_API_SECRET for this key, or the checkout payload was altered).'); return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' }); }
    }
    // Order ID + amount must match what was fixed server-side when this order was created.
    const ordRow = (await dbq("SELECT amount, status FROM material_invoice_payments WHERE order_id=? AND owner_user_id=? AND COALESCE(purpose,'') <> 'topup'", [razorpay_order_id, owner]))[0];
    if (!ordRow) { console.error('❌ invoice verify: order ' + razorpay_order_id + ' not found for owner ' + owner + ' (order id sent at initialization does not match).'); return res.status(400).json({ error: 'This payment order was not found or was already processed.' }); }
    try { await razorpayConfirmPayment(razorpay_order_id, razorpay_payment_id, Number(ordRow.amount)); }   // captures if still "authorized"
    catch (e) { console.error('❌ invoice verify rejected — order=' + razorpay_order_id + ' owner=' + owner + ':', e.message); return res.status(402).json({ error: e.message }); }
    // Idempotent: works whether the browser or the webhook marks it Paid first (no race), single use is still enforced by 'used'.
    const r = await dbq("UPDATE material_invoice_payments SET status='paid', payment_id=?, paid_at=COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE order_id=? AND owner_user_id=? AND (status='created' OR (status='paid' AND payment_id=?)) RETURNING amount",
        [razorpay_payment_id, razorpay_order_id, owner, razorpay_payment_id]);
    if (!r.length) { console.error('❌ invoice verify: order ' + razorpay_order_id + ' already ' + ordRow.status + ' with a different payment id — refusing.'); return res.status(400).json({ error: 'This payment order was not found or was already processed.' }); }
    const unlockToken = jwt.sign({ purpose: 'material_invoice_unlock', userId: owner, orderId: razorpay_order_id }, JWT_SECRET, { expiresIn: '10m' });
    res.json({ success: true, unlockToken, amount: Number(r[0].amount) });
}));

// 🔒 SERVER-SIDE FEE GATE for every bill create / update.
//    fee = ₹0 → saved instantly (gateway bypassed).  fee > 0 → a verified, unused payment for >= that amount is mandatory.
//    Returns { ok:true, orderId? } or sends 402 and returns { ok:false }.
// ── 💰 Prepaid wallet helpers (balance lives in material_users.walletBalance; every change is logged in material_wallet_txns) ──
async function walletBalanceOf(userId) {
    const r = await dbq('SELECT COALESCE(walletBalance,0) AS "bal" FROM material_users WHERE userid = ?', [String(userId || '')]);
    return r[0] ? Math.round(Number(r[0].bal) * 100) / 100 : 0;
}
// Atomic debit: succeeds only if the balance covers the amount. Returns the new balance, or null if insufficient.
async function walletDebit(userId, amount, note, ref) {
    const r = await dbq('UPDATE material_users SET walletBalance = COALESCE(walletBalance,0) - ? WHERE userid = ? AND COALESCE(walletBalance,0) >= ? RETURNING walletBalance AS "bal"', [amount, String(userId), amount]);
    if (!r.length) return null;
    const bal = Math.round(Number(r[0].bal) * 100) / 100;
    await dbq('INSERT INTO material_wallet_txns (owner_user_id, type, amount, balance_after, note, ref) VALUES (?,?,?,?,?,?)', [String(userId), 'debit', amount, bal, note || null, ref || null]);
    return bal;
}
async function walletCredit(userId, amount, note, ref) {
    const r = await dbq('UPDATE material_users SET walletBalance = COALESCE(walletBalance,0) + ? WHERE userid = ? RETURNING walletBalance AS "bal"', [amount, String(userId)]);
    if (!r.length) return null;
    const bal = Math.round(Number(r[0].bal) * 100) / 100;
    await dbq('INSERT INTO material_wallet_txns (owner_user_id, type, amount, balance_after, note, ref) VALUES (?,?,?,?,?,?)', [String(userId), 'credit', amount, bal, note || null, ref || null]);
    return bal;
}

// 🔒 SERVER-SIDE FEE GATE for every bill create / update.
//    fee = ₹0 → saved instantly.  fee > 0 → paid from the user's prepaid wallet balance (deducted here, atomically);
//    a verified one-time Razorpay unlock token (older flow) is still honoured if the client sends one.
//    Not enough balance → 402 { insufficientBalance:true } so the portal can offer a top-up.
//    Returns { ok:true, ... } or sends 402 and returns { ok:false }.
async function enforceInvoiceFee(req, res, ownerUserId, billNo) {
    const f = await materialInvoiceFeeFor(ownerUserId);
    if (!f.paymentRequired) return { ok: true, fee: 0 };
    const tok = String((req.body && req.body.unlockToken) || req.get('x-invoice-unlock') || '');
    let dec = null;
    try { dec = tok ? jwt.verify(tok, JWT_SECRET) : null; } catch (e) { dec = null; }
    if (dec && dec.purpose === 'material_invoice_unlock' && String(dec.userId) === String(ownerUserId) && dec.orderId) {
        const used = await dbq("UPDATE material_invoice_payments SET status='used', used_at=CURRENT_TIMESTAMP WHERE order_id=? AND owner_user_id=? AND status='paid' AND amount >= ? AND COALESCE(purpose,'') <> 'topup' RETURNING order_id",
            [dec.orderId, ownerUserId, f.fee]);
        if (used.length) return { ok: true, fee: f.fee, orderId: dec.orderId };
    }
    const bal = await walletDebit(ownerUserId, f.fee, 'Bill generation fee' + (billNo ? ' — Bill No. ' + cleanText(String(billNo), 60) : ''), 'invoice');
    if (bal === null) {
        const have = await walletBalanceOf(ownerUserId);
        res.status(402).json({ error: 'Insufficient credit balance: the invoice fee is ₹' + f.fee + ' and your balance is ₹' + have + '. Please add credit to your wallet.', feeRequired: true, insufficientBalance: true, fee: f.fee, balance: have });
        return { ok: false };
    }
    return { ok: true, fee: f.fee, wallet: true, walletOwner: String(ownerUserId), balance: bal };
}
// If the DB write fails after the fee was taken, give it back so the user is not charged for an invoice that was not saved.
function refundInvoiceToken(gate) {
    if (!gate) return;
    if (gate.orderId) db.query("UPDATE material_invoice_payments SET status='paid', used_at=NULL WHERE order_id=? AND status='used'", [gate.orderId], () => {});
    if (gate.wallet && gate.walletOwner) walletCredit(gate.walletOwner, gate.fee, 'Refund: invoice was not saved', 'refund').catch(() => {});
}

// ── 💰 Wallet: portal user endpoints ──
app.get('/api/material/wallet', noStore, requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    if (!owner) return res.status(400).json({ error: 'ownerUserId is required.' });
    const f = await materialInvoiceFeeFor(owner);
    const txns = await dbq('SELECT type, amount, balance_after AS "balanceAfter", note, created_at AS "createdAt" FROM material_wallet_txns WHERE owner_user_id = ? ORDER BY id DESC LIMIT 10', [owner]);
    res.json({ balance: await walletBalanceOf(owner), fee: f.fee, paymentRequired: f.paymentRequired, txns });
}));
// Top-up via Razorpay — the user chooses the amount; the order is created and fixed server-side.
app.post('/api/material/wallet/topup/order', requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    if (!owner) return res.status(400).json({ error: 'ownerUserId is required.' });
    const amt = Math.round(Number(req.body && req.body.amount) * 100) / 100;
    if (!isFinite(amt) || amt < 1 || amt > 50000) return res.status(400).json({ error: 'Please enter an amount between ₹1 and ₹50,000.' });
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) return res.status(501).json({ error: 'Payment keys are not set in the Render Environment.' });
    let order;
    try { order = await razorpayRequest('/v1/orders', { amount: Math.round(amt * 100), currency: 'INR', receipt: ('wal_' + owner + '_' + Date.now()).slice(0, 40) }); }
    catch (e) { return res.status(502).json({ error: 'Error while creating the Razorpay order: ' + e.message }); }
    await dbq('INSERT INTO material_invoice_payments (order_id, owner_user_id, amount, purpose) VALUES (?,?,?,?)', [order.id, owner, amt, 'topup']);
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, topup: amt });
}));
app.post('/api/material/wallet/topup/verify', requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret) return res.status(501).json({ error: 'PAYMENT_API_SECRET is not set in the Render Environment.' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!owner || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Order ID, Payment ID and Signature are all required.' });
    const expected = crypto.createHmac('sha256', secret).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'Payment verification failed (signature mismatch). Nothing was added.' });
    const ord = (await dbq("SELECT amount, status FROM material_invoice_payments WHERE order_id=? AND owner_user_id=? AND purpose='topup'", [razorpay_order_id, owner]))[0];
    if (!ord) return res.status(400).json({ error: 'This top-up order was not found.' });
    if (ord.status === 'used') return res.json({ success: true, already: true, balance: await walletBalanceOf(owner) });
    try { await razorpayConfirmPayment(razorpay_order_id, razorpay_payment_id, Number(ord.amount)); }
    catch (e) { return res.status(402).json({ error: e.message }); }
    // single-use: only the request that flips the order to 'used' credits the wallet
    const claimed = await dbq("UPDATE material_invoice_payments SET status='used', payment_id=?, paid_at=COALESCE(paid_at, CURRENT_TIMESTAMP), used_at=CURRENT_TIMESTAMP WHERE order_id=? AND owner_user_id=? AND purpose='topup' AND status IN ('created','paid') RETURNING amount", [razorpay_payment_id, razorpay_order_id, owner]);
    if (!claimed.length) return res.json({ success: true, already: true, balance: await walletBalanceOf(owner) });
    const bal = await walletCredit(owner, Number(claimed[0].amount), 'Wallet top-up (Razorpay)', razorpay_payment_id);
    res.json({ success: true, balance: bal, added: Number(claimed[0].amount) });
}));
// Ask the Super Admin for a credit top-up
app.post('/api/material/wallet/request', requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    if (!owner) return res.status(400).json({ error: 'ownerUserId is required.' });
    const amt = Math.round(Number(req.body && req.body.amount) * 100) / 100;
    if (!isFinite(amt) || amt < 1 || amt > 50000) return res.status(400).json({ error: 'Please enter an amount between ₹1 and ₹50,000.' });
    const pend = await dbq("SELECT COUNT(*) AS n FROM material_wallet_requests WHERE owner_user_id=? AND status='pending'", [owner]);
    if (Number(pend[0] && pend[0].n) >= 3) return res.status(429).json({ error: 'You already have pending top-up requests. Please wait for the Super Admin to respond.' });
    await dbq('INSERT INTO material_wallet_requests (owner_user_id, amount, note) VALUES (?,?,?)', [owner, amt, cleanText((req.body && req.body.note) || '', 255) || null]);
    res.json({ success: true });
}));


// ── 📒 Wallet LEDGER (full history): transaction ID · credit / debit · exact amount · timestamp · running balance ──
//    Same data feeds the portal user's "Wallet Ledger" and the Super Admin "Invoice Wallet & Credit" history.
function walletTxnShape(r) {
    const type = String(r.type || '').toLowerCase() === 'credit' ? 'credit' : 'debit';
    const ref = String(r.ref || '');
    let category;
    if (ref === 'invoice') category = 'bill';
    else if (ref === 'refund') category = 'refund';
    else if (ref === 'admin') category = type === 'credit' ? 'admin_credit' : 'admin_debit';
    else category = type === 'credit' ? 'topup' : 'other_debit';
    return {
        id: r.id, txnId: 'WTX' + String(r.id).padStart(6, '0'),
        userId: r.userId, userName: r.userName || '',
        type, category, amount: Math.round(Number(r.amount) * 100) / 100,
        balanceAfter: r.balanceAfter === null || r.balanceAfter === undefined ? null : Math.round(Number(r.balanceAfter) * 100) / 100,
        note: r.note || '', ref, createdAt: r.createdAt
    };
}
async function walletLedgerQuery(userId, from, to, limit) {
    const where = [], params = [];
    if (userId) { where.push('t.owner_user_id = ?'); params.push(String(userId)); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(from || '')) { where.push('t.created_at >= ?'); params.push(from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) { const d = new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); where.push('t.created_at < ?'); params.push(d.toISOString().slice(0, 10)); }
    const lim = Math.min(Math.max(parseInt(limit, 10) || 2000, 1), 5000);
    const rows = await dbq('SELECT t.id, t.owner_user_id AS "userId", u.name AS "userName", t.type, t.amount, t.balance_after AS "balanceAfter", t.note, t.ref, t.created_at AS "createdAt" FROM material_wallet_txns t LEFT JOIN material_users u ON u.userid = t.owner_user_id' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY t.id DESC LIMIT ' + lim, params);
    const list = rows.map(walletTxnShape);
    const summary = { count: list.length, credits: 0, debits: 0 };
    list.forEach(function (r) { if (r.type === 'credit') summary.credits += r.amount; else summary.debits += r.amount; });
    summary.credits = Math.round(summary.credits * 100) / 100; summary.debits = Math.round(summary.debits * 100) / 100;
    return { rows: list, summary };
}
// Portal user: own ledger (Admin may pass ?ownerUserId=)
app.get('/api/material/wallet/ledger', noStore, requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const { owner } = invoiceOwnerFromReq(req);
    if (!owner) return res.status(400).json({ error: 'ownerUserId is required.' });
    const out = await walletLedgerQuery(owner, req.query.from, req.query.to, req.query.limit);
    const u = (await dbq('SELECT userid AS "userId", name, mobile FROM material_users WHERE userid = ?', [owner]))[0] || { userId: owner, name: '', mobile: '' };
    const f = await materialInvoiceFeeFor(owner);
    res.json({ user: u, balance: await walletBalanceOf(owner), fee: f.fee, rows: out.rows, summary: out.summary });
}));
// Super Admin: one user's ledger (?userId=) or every user's (no userId)
app.get('/api/admin/material/wallet-ledger', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const userId = cleanText(req.query.userId, 50);
    const out = await walletLedgerQuery(userId, req.query.from, req.query.to, req.query.limit);
    let user = null, balance = null;
    if (userId) { user = (await dbq('SELECT userid AS "userId", name, mobile FROM material_users WHERE userid = ?', [userId]))[0] || { userId, name: '', mobile: '' }; balance = await walletBalanceOf(userId); }
    res.json({ user, balance, rows: out.rows, summary: out.summary });
}));

// ── 💰 Wallet: Super Admin endpoints ──
app.get('/api/admin/material/wallet-overview', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const users = await dbq('SELECT userid AS "userId", name, mobile, COALESCE(walletBalance,0) AS "balance" FROM material_users ORDER BY name');
    const requests = await dbq("SELECT r.id, r.owner_user_id AS \"userId\", u.name, u.mobile, r.amount, r.note, r.created_at AS \"createdAt\" FROM material_wallet_requests r LEFT JOIN material_users u ON u.userid = r.owner_user_id WHERE r.status='pending' ORDER BY r.id DESC LIMIT 200");
    res.json({ users, requests });
}));
// amount > 0 adds credit, amount < 0 deducts (never below zero). Optional requestId marks a top-up request as done.
app.post('/api/admin/material/wallet/credit', requireRole('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const userId = cleanText(b.userId, 50);
    const amt = Math.round(Number(b.amount) * 100) / 100;
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    if (!isFinite(amt) || amt === 0 || Math.abs(amt) > 500000) return res.status(400).json({ error: 'Please enter a valid non-zero amount.' });
    const exists = await dbq('SELECT 1 AS x FROM material_users WHERE userid = ?', [userId]);
    if (!exists.length) return res.status(404).json({ error: 'No material user with ID ' + userId + '.' });
    const note = cleanText(b.note, 200) || (amt > 0 ? 'Credit added by Super Admin' : 'Deducted by Super Admin');
    const bal = amt > 0 ? await walletCredit(userId, amt, note, 'admin') : await walletDebit(userId, -amt, note, 'admin');
    if (bal === null) return res.status(400).json({ error: 'The balance is lower than the amount to deduct.' });
    if (b.requestId) await dbq("UPDATE material_wallet_requests SET status='done', resolved_at=CURRENT_TIMESTAMP WHERE id=? AND owner_user_id=? AND status='pending'", [b.requestId, userId]);
    auditPii(req, 'wallet_adjust', userId, 'amount=' + amt);
    res.json({ success: true, balance: bal });
}));
app.post('/api/admin/material/wallet/requests/:id/reject', requireRole('admin'), asyncRoute(async (req, res) => {
    await dbq("UPDATE material_wallet_requests SET status='rejected', resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'", [req.params.id]);
    res.json({ success: true });
}));

// Super Admin: set the invoice fee (stored in Supabase). Amount 0 = free → payment gateway is bypassed everywhere.
app.get('/api/admin/material-invoice-settings', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const st = await xBlobGet('material_invoice_settings', {});
    const n = (st && st.amount !== undefined && st.amount !== '' && isFinite(Number(st.amount)) && Number(st.amount) >= 0) ? Number(st.amount) : 10;
    res.json({ enabled: !st || st.enabled !== false, amount: n });
}));
app.put('/api/admin/material-invoice-settings', requireRole('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const n = Number(b.amount);
    if (b.amount === '' || b.amount === undefined || !isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'Please enter a valid fee amount (0 or more).' });
    const cfg = { enabled: b.enabled !== false, amount: Math.round(n * 100) / 100 };
    await xBlobSet('material_invoice_settings', cfg);
    auditPii(req, 'invoice_fee_set', 'material_invoice_settings', 'amount=' + cfg.amount + ' enabled=' + cfg.enabled);
    res.json(cfg);
}));

// 🎓 STUDENT SUBSCRIPTION PAYMENT — Student_Attendance.html ka
//   "Ab Payment Karein" button ab seedha in dono routes se judta hai
//   (pehle yeh Admin Panel mein manually daale gaye ek alag legacy DB
//   'razorpay_config.orderEndpoint' URL ko call karta tha, aur payment
//   verify + subscription-activate ek legacy DB Cloud Function ke bharose
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

app.post('/api/payments/student-subscription/verify', async (req, res) => {
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
        { console.error('❌ Payment signature MISMATCH — order=' + razorpay_order_id + ' payment=' + razorpay_payment_id + ' (wrong PAYMENT_API_SECRET for this key, or the checkout payload was altered).'); return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' }); }
    }
    try { await razorpayConfirmPayment(razorpay_order_id, razorpay_payment_id); } catch (e) { console.error('❌ verify rejected:', e.message); return res.status(402).json({ error: e.message }); }
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
//   payment 'successful' hote hi client seedha browser se legacy DB
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

app.post('/api/payments/agent-subscription/verify', async (req, res) => {
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
        { console.error('❌ Payment signature MISMATCH — order=' + razorpay_order_id + ' payment=' + razorpay_payment_id + ' (wrong PAYMENT_API_SECRET for this key, or the checkout payload was altered).'); return res.status(400).json({ error: 'Payment could not be verified — signature mismatch.' }); }
    }
    try { await razorpayConfirmPayment(razorpay_order_id, razorpay_payment_id); } catch (e) { console.error('❌ verify rejected:', e.message); return res.status(402).json({ error: e.message }); }
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
// SMS gateway (App2SMS-compatible). Settings come from the Super Admin "SMS API" configuration
// (kv_blob: sms_api_config {endpoint, key}) or from Render environment variables:
//   SMS_API_URL  – gateway URL. May contain {key}, {mobile} and {message} placeholders.
//                  Without placeholders the parameters apikey / numbers / message are appended.
//   SMS_API_KEY  – gateway key (APP2SMS_API_KEY is also accepted)
//   SMS_SENDER_ID – optional sender id (appended as sender_id)
async function loadSmsConfig() {
    let cfg = {};
    try {
        const r = await dbq('SELECT value FROM kv_blob WHERE `key` = ?', ['sms_api_config']);
        cfg = JSON.parse(r[0] && r[0].value) || {};
    } catch (e) { cfg = {}; }
    return {
        endpoint: cfg.endpoint || process.env.SMS_API_URL || '',
        key: cfg.key || process.env.FAST2SMS_API_KEY || process.env.SMS_API_KEY || process.env.APP2SMS_API_KEY || '',
        template: cfg.template || ''
    };
}
async function smsConfigured() { const c = await loadSmsConfig(); return !!(c.key || c.endpoint); }
function httpGetText(urlStr) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlStr); } catch (e) { return reject(new Error('The SMS gateway URL is invalid.')); }
        const lib = u.protocol === 'http:' ? require('http') : https;
        const rq = lib.get(u, { timeout: 12000 }, (resp) => {
            let data = '';
            resp.on('data', (c) => { data += c; });
            resp.on('end', () => (resp.statusCode >= 200 && resp.statusCode < 300) ? resolve(data) : reject(new Error('SMS gateway responded with status ' + resp.statusCode)));
        });
        rq.on('timeout', () => rq.destroy(new Error('SMS gateway timed out.')));
        rq.on('error', reject);
    });
}
async function sendSms(mobile, message) {
    const cfg = await loadSmsConfig();
    if (!cfg.key && !cfg.endpoint) throw new Error('The SMS gateway is not configured (SMS_API_URL / SMS_API_KEY).');
    const num = String(mobile || '').replace(/\D/g, '').slice(-10);
    if (num.length !== 10) throw new Error('A valid 10-digit mobile number is required.');
    let url;
    if (cfg.endpoint) {
        const enc = encodeURIComponent;
        if (/\{(key|mobile|message)\}/.test(cfg.endpoint)) {
            url = cfg.endpoint.replace(/\{key\}/g, enc(cfg.key)).replace(/\{mobile\}/g, enc(num)).replace(/\{message\}/g, enc(message));
        } else {
            const sep = cfg.endpoint.indexOf('?') === -1 ? '?' : '&';
            url = cfg.endpoint + sep + new URLSearchParams({ apikey: cfg.key, numbers: num, message, ...(process.env.SMS_SENDER_ID ? { sender_id: process.env.SMS_SENDER_ID } : {}) }).toString();
        }
    } else {
        url = 'https://www.fast2sms.com/dev/bulkV2?' + new URLSearchParams({ authorization: cfg.key, route: 'q', message, numbers: num, sender_id: process.env.SMS_SENDER_ID || 'LIBRBK' }).toString();
    }
    return httpGetText(url);
}

app.post('/api/sms/send', async (req, res) => {
    const { mobile, message } = req.body || {};
    if (!mobile || !message) return res.status(400).json({ error: 'mobile and message are required.' });
    if (!(await smsConfigured())) return res.status(501).json({ error: 'The SMS gateway is not configured (SMS_API_URL / SMS_API_KEY).' });
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
//   pehle 3 alag-alag legacy DB calls karta tha (agent update, students
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
app.post('/api/material/bills', requireActiveMaterialUser, asyncRoute(async (req, res) => {
    const body = Object.assign({}, req.body || {});
    delete body.unlockToken;
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
    // 🔒 FEE GATE: ₹0 → instant save; fee > 0 → verified one-time payment required (checked on the server)
    const gate = await enforceInvoiceFee(req, res, ownerUserId, body.billNo);
    if (!gate.ok) return;
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
            refundInvoiceToken(gate);
            return res.status(409).json({ error: 'Error: Bill Number already exists! Please use a unique Bill Number.' });
        } else {
            db.query('INSERT INTO material_bills (owneruserid, data) VALUES (?,?)', [ownerUserId, JSON.stringify(body)], (err, result) => {
                if (err) { refundInvoiceToken(gate); return res.status(500).json({ error: 'DB error: ' + err.message }); }
                res.status(201).json({ id: result.insertId, updated: false });
            });
        }
    });
}));
app.get('/api/material/bills', noStore, (req, res) => {
    // 🔒 Login mandatory. Material user → ONLY own invoices (ownerUserId in the URL is ignored).
    //    Admin → all invoices, or one user's invoices with ?ownerUserId=
    const auth = getAuthUser(req);
    if (!auth) return res.status(401).json({ error: 'Your session is not active. Please log in again.' });
    const isAdmin = String(auth.role || '').toLowerCase() === 'admin';
    let ownerUserId = req.query.ownerUserId;
    if (!isAdmin) {
        if (auth.role !== 'material_user' || !auth.userId) return res.status(401).json({ error: 'Your session is not active. Please log in again.' });
        ownerUserId = auth.userId;
    }
    const sql = ownerUserId ? 'SELECT * FROM material_bills WHERE owneruserid=? ORDER BY savedAt DESC' : 'SELECT * FROM material_bills ORDER BY savedAt DESC';
    db.query(sql, ownerUserId ? [ownerUserId] : [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error: ' + err.message });
        res.json((rows || []).map(r => {
            const saved = r.savedAt || r.savedat;
            try { return Object.assign(JSON.parse(r.data), { id: r.id, savedAt: saved, ownerUserId: r.owneruserid || r.ownerUserId || '' }); }
            catch (e) { return { id: r.id, savedAt: saved }; }
        }));
    });
});
// 👑 SUPER ADMIN — every invoice in the database (with the owner's name). Reads Supabase directly; whether a
//    material user is logged in, logged out or even deleted makes no difference to this list.
app.get('/api/admin/material/bills', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const rows = await dbq('SELECT b.*, u.name AS owner_name FROM material_bills b LEFT JOIN material_users u ON u.userid = b.owneruserid ORDER BY b.savedAt DESC');
    res.json(rows.map(r => {
        const saved = r.savedAt || r.savedat;
        const owner = r.owneruserid || r.ownerUserId || '';
        try { return Object.assign(JSON.parse(r.data), { id: r.id, savedAt: saved, ownerUserId: owner, ownerName: r.owner_name || '' }); }
        catch (e) { return { id: r.id, savedAt: saved, ownerUserId: owner, ownerName: r.owner_name || '' }; }
    }));
}));

app.put('/api/material/bills/:id', requireActiveMaterialUser, (req, res) => {
    db.query('SELECT owneruserid, data FROM material_bills WHERE id=?', [req.params.id], async (err, rows) => {
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
        const newBody = Object.assign({}, req.body || {});
        delete newBody.unlockToken;
        // Duplicate Bill No guard: another bill of the same owner must not already use this number
        const _newBillNo = String(newBody.billNo == null ? '' : newBody.billNo).trim();
        if (_newBillNo) {
            const _dup = await new Promise((resolve) => {
                db.query(
                    "SELECT id FROM material_bills WHERE owneruserid=? AND (data::json->>'billNo')=? AND id<>? LIMIT 1",
                    [rows[0].owneruserid, _newBillNo, req.params.id],
                    (dErr, dRows) => resolve(!dErr && dRows && dRows.length > 0)
                );
            });
            if (_dup) return res.status(409).json({ error: 'Error: Bill Number already exists! Please use a unique Bill Number.' });
        }
        // 🔒 EDIT => RE-PAYMENT: changes are NOT saved until the active fee is paid (₹0 → saved instantly)
        let gate;
        try { let _bn = newBody && newBody.billNo; if (!_bn) { try { _bn = JSON.parse(rows[0].data).billNo; } catch (e) {} } gate = await enforceInvoiceFee(req, res, rows[0].owneruserid || '', _bn); } catch (gErr) { return res.status(500).json({ error: 'Fee check failed: ' + gErr.message }); }
        if (!gate.ok) return;
        let merged = {};
        try { merged = JSON.parse(rows[0].data); } catch (e) {}
        Object.assign(merged, newBody);
        db.query('UPDATE material_bills SET data=? WHERE id=?', [JSON.stringify(merged), req.params.id], (uErr) => {
            if (uErr) { refundInvoiceToken(gate); return res.status(500).json({ error: 'DB error: ' + uErr.message }); }
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
    const h = { feePayments: [], subscriptionOrders: [], transactions: [], registrationOrders: [], salarySlips: [], materialBills: [], attendance: null };
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
    if (id && hit.kind === 'material_user') {
        h.materialBills = [];
        (await safeQ('SELECT id, data, savedat FROM material_bills WHERE owneruserid = ? ORDER BY savedat DESC LIMIT 100', [id]))
            .forEach(function (r) {
                let d = {}; try { d = JSON.parse(r.data) || {}; } catch (e) {}
                h.materialBills.push({ id: r.id, billNo: d.billNo || '', billDate: d.billDate || '', business: d.businessName || d.vendorName || '', workCode: d.workCode || '', date: r.savedat || r.savedAt });
            });
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

    // 1b) Material users + their pending registrations (Admin only) — instant, by Aadhaar hash / last-4
    if (isAdmin && (mode === 'last4' || piiReady())) {
        const col = mode === 'full' ? 'aadhaar_hash' : 'aadhaar_last4';
        const val = mode === 'full' ? piiIndex('AADHAAR', digits) : digits;
        const mus = await safeQ('SELECT id, userid, name, village, address, email, mobile, photo, status, aadhaar_last4, aadhaar_enc, created_at FROM material_users WHERE ' + col + ' = ? ORDER BY created_at DESC LIMIT ' + LIMIT, [val]);
        mus.forEach(function (r) {
            results.push({ id: 'mu:' + r.id, source: 'material_users', kind: 'material_user', type: 'Material User', entityId: String(r.userid), materialId: r.id,
                name: r.name || '', mobile: r.mobile || '', email: r.email || '', address: [r.village, r.address].filter(Boolean).join(', '), photo: r.photo || '',
                aadhaarLast4: r.aadhaar_last4 || '', aadhaarMasked: maskAadhaarLast4(r.aadhaar_last4), hasFullAadhaar: !!r.aadhaar_enc,
                status: r.status || 'active', registeredBy: 'Material Portal / Admin', agentId: '', agentUsername: '', agentName: '', agentCompany: '',
                createdAt: r.created_at, matchType: mode });
            seen.add('material_user:' + String(r.userid).toLowerCase());
        });
        const mrs = await safeQ("SELECT id, name, village, address, email, mobile, photo, status, aadhaar_last4, aadhaar_enc, created_at FROM material_user_requests WHERE " + col + " = ? AND COALESCE(status,'pending') = 'pending' ORDER BY created_at DESC LIMIT " + LIMIT, [val]);
        mrs.forEach(function (r) {
            results.push({ id: 'mur:' + r.id, source: 'material_user_requests', kind: 'material_request', type: 'Material User (Pending)', entityId: String(r.id), materialId: r.id,
                name: r.name || '', mobile: r.mobile || '', email: r.email || '', address: [r.village, r.address].filter(Boolean).join(', '), photo: r.photo || '',
                aadhaarLast4: r.aadhaar_last4 || '', aadhaarMasked: maskAadhaarLast4(r.aadhaar_last4), hasFullAadhaar: !!r.aadhaar_enc,
                status: r.status || 'pending', registeredBy: 'Material Portal (self-registration)', agentId: '', agentUsername: '', agentName: '', agentCompany: '',
                createdAt: r.created_at, matchType: mode });
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
        queryMasked: mode === 'full' ? 'XXXX-XXXX-' + digits.slice(-4) : 'XXXX-XXXX-' + digits,
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
function maskIdentity(n) { n = String(n || ''); return n.length >= 4 ? 'XXXX-XXXX-' + n.slice(-4) : ''; }
function ownerLabel(att, fallbackName) {
    if (att && att.agentCompany) return att.agentCompany + (att.agentName ? ' — Agent ' + att.agentName : '') + (att.agentId ? ' (' + att.agentId + ')' : '');
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
                const lbl = src.kind === 'agent' ? ((rec.company ? rec.company + ' — ' : '') + 'Agent ' + (rec.name || rec.username || '') + (rec.agentId ? ' (' + rec.agentId + ')' : '')) : ownerLabel(att);
                return { kind: src.kind, entityId: genericEntityId(rec), name: rec.name || '', company: (att && att.agentCompany) || (src.kind === 'agent' ? (rec.company || '') : ''), label: (src.kind !== 'agent' && rec.name ? 'existing record "' + rec.name + '" under ' : '') + lbl };
            }
        }
    }
    if (/^\d{12}$/.test(norm) && piiReady()) {
        const rows = await safeQ('SELECT * FROM kyc_records WHERE aadhaar_hash = ? LIMIT 5', [piiIndex('AADHAAR', norm)]);
        for (let i = 0; i < rows.length; i++) {
            if (selfKeys.length && selfKeys.indexOf(String(rows[i].entity_id).toLowerCase()) >= 0) continue;
            if (String(rows[i].status || '').toLowerCase() === 'rejected') continue;
            const att = attribute(idx, [rows[i].agent_id, rows[i].agent_username]);
            return { kind: rows[i].entity_type, entityId: String(rows[i].entity_id), name: rows[i].full_name || '', company: att.agentCompany || '', label: (rows[i].full_name ? 'existing record "' + rows[i].full_name + '" under ' : '') + ownerLabel(att) };
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
        { id: 'super_admin', label: 'Admin', portal: 'admin', target: '/admin-dashboard', enabled: true },
        { id: 'pfms', label: 'PFMS Portal', portal: 'pfms', target: '/pfms-login', enabled: true },
        { id: 'agent', label: 'Agent Login', portal: 'agent', target: '/agent-login', enabled: true },
        { id: 'hrms', label: 'HRMS', portal: 'hrms', target: '/hrms-login', enabled: true },
        { id: 'student', label: 'Student Attendance', portal: 'student', target: '/student-login', enabled: true },
        { id: 'invoice', label: 'Invoice Login', portal: 'invoice', target: '/invoice-login', enabled: true }
    ],
    locations: [
        { id: 'begusarai', label: 'Begusarai', enabled: true },
        { id: 'pansalla', label: 'Pansalla', enabled: true }
    ],
    users: []   // [{username, name, title:'Mr.'|'Mrs.', roles:[ids], locations:[ids], actAs:{roleId: username}}]
};
const GATE_PORTALS = ['admin', 'pfms', 'agent', 'hrms', 'student', 'invoice'];
const SAFE_TARGET = /^\/?[A-Za-z0-9_\-]{1,60}(\.html)?$/;
const cleanTarget = (t) => { const k = String(t || '').replace(/^\//, '').toLowerCase(); return LEGACY_FILE_TO_CLEAN[k.endsWith('.html') ? k : k + '.html'] || (String(t).charAt(0) === '/' ? t : '/' + t); };
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
        if (!SAFE_TARGET.test(target)) target = (GATE_DEFAULT.roles.find(function (d) { return d.portal === portal; }) || {}).target || '/admin-dashboard';
        target = cleanTarget(target);
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
    return { popup: Object.assign({}, gate.popup, { welcome: welcome }), roles: roles.map(function (r) { const c = Object.assign({}, r); delete c.target; return c; }), locations: locations, user: { username: auth.username, name: name, title: title } };
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
        success: true, token: token, target: routeMask.urlFor(routeMask.resolveKey(role.target) || (role.portal === 'admin' ? 'dashboard' : role.portal)) || '/', portal: role.portal, role: jwtRole, autoLogin: autoLogin,
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
CLEAN_PAGES.filter(function (pg) { return pg.clean === '/'; }).forEach(function (pg) {   // 🕶️ portals are served by route-mask.js only
    [pg.clean].concat(pg.aliases).forEach(function (p) {
        app.get(p, function (req, res, next) {
            if (p !== pg.clean) { const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : ''; return res.redirect(301, pg.clean + q); } // alias -> canonical clean URL
            const f = findStaticFile(pg.file);
            if (f) { return routeMask.sendHome(req, res, pg.file); }
            if (p === '/' && IS_VERCEL) {   // ▲ index.html is part of THIS project now — a missing file is a deployment error, not "backend only"
                console.error('❌ index.html was not found in the Vercel bundle. Check vercel.json includeFiles and that index.html is committed next to server.js. Searched:', STATIC_DIRS.join(', '));
                return res.status(500).type('html').send('<!doctype html><meta charset="utf-8"><title>Deployment error</title><body style="font-family:Arial;padding:40px"><h2>Main page is not available</h2><p>index.html is missing from this deployment. Please contact the administrator.</p></body>');
            }
            if (p === '/') return res.send('Library App Backend is running successfully!'); // frontend on Netlify: same as before
            if (pg.slug) return res.redirect(302, '/api/pages/' + pg.slug);                 // uploaded copy from the database
            next();
        });
    });
});
app.get('/favicon.ico', function (req, res, next) {
    const f = findStaticFile('favicon.ico');
    if (f) return res.sendFile(f);
    res.status(204).end();
});
app.get(['/health', '/healthz'], function (req, res) { res.json({ status: 'ok', running: true, indexBundled: !!findStaticFile('index.html') }); });


// 🆕 HEALTH CHECK ROUTE — frontend ka status dot (Admin/Agent/HRMS/Student
// portal ke '☁️ Render' indicator) isi route ko har 10 second mein poll
// karta hai (API_BASE + '/health' → '/api/health'). Pehle ye route missing
// tha, isliye fetch 404 deta tha aur dot hamesha red rehta tha.
// Deep diagnostics (no secrets): /api/health/deep tells exactly why login may fail.
app.get('/api/health/deep', requireRole('admin'), async (req, res) => { // 🔒 was public (leaked admin usernames)
    const out = { env: { DATABASE_URL: !!process.env.DATABASE_URL, JWT_SECRET: !!process.env.JWT_SECRET, node: process.version }, db: 'unknown', admins: null, hint: [] };
    try {
        await dbq('SELECT 1', []);
        out.db = 'connected';
        try {
            const r = await dbq('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['admins']);
            let list = []; try { list = JSON.parse(r[0] && r[0].value) || []; } catch (e) { out.hint.push('admins row is not valid JSON text'); }
            out.admins = list.map(a => ({ username: a && a.username, status: a && a.status, hasBcryptHash: !!(a && /^\$2[aby]\$\d\d\$.{53}$/.test(String(a.password || ''))) }));
            if (!r.length) out.hint.push('No "admins" row in kv_admin_entities — it will be auto-created on the next request/boot, or insert it manually.');
            else if (!list.length) out.hint.push('"admins" row exists but the array is empty.');
            list.forEach(a => { if (!/^\$2[aby]\$/.test(String(a.password || ''))) out.hint.push('Admin "' + a.username + '" password is not a bcrypt hash.'); if (String(a.status || 'active').toLowerCase() !== 'active') out.hint.push('Admin "' + a.username + '" status is not active.'); });
        } catch (e) { out.hint.push('Table kv_admin_entities missing/unreadable: ' + e.message); }
    } catch (e) {
        out.db = 'FAILED: ' + (e.code || '') + ' ' + e.message;
        out.hint.push('Use the Supabase SESSION POOLER connection string (host aws-0-<region>.pooler.supabase.com, port 5432, user postgres.<ref>) for DATABASE_URL on Render; the direct db.<ref>.supabase.co host is IPv6-only and can fail with ECONNREFUSED/ENETUNREACH. Check the password and that the project is not paused.');
    }
    res.set('Cache-Control', 'no-store').json(out);
});
// ═══════════════════════════════════════════════════════════════════════
// 🆕 TRACKING IDs · CUSTOM FEES · DYNAMIC BRANDING · MASTER USERS LIST
// ═══════════════════════════════════════════════════════════════════════
// Sequential application / tracking token: AGT001, AGT002 ... (shared by customer + agent registrations)
let _agtQueue = Promise.resolve();
function nextAgtId() {
    const run = _agtQueue.then(async function () {
        // ♻️ lowest vacant AGT number (gap-filling) across every list that carries an AGT tracking ID
        const used = [];
        const scan = function (list) { (Array.isArray(list) ? list : []).forEach(function (r) { if (r && r.trackingId) used.push(r.trackingId); }); };
        scan(await xBlobGet('tracking_records', []));
        scan(await xBlobGet('customer_pending_registrations', []));
        scan(await xBlobGet('agent_pending_registrations', []));
        return allocateVacantId('AGT', 'AGT', used);
    });
    _agtQueue = run.catch(function () {});
    return run;
}
const AADHAAR_EXISTS_MSG = 'This Aadhaar number already exists in the system. A duplicate registration is not allowed.';
// true if this 12-digit Aadhaar is already registered / pending anywhere (agents, students, staff, HRMS, customers, KYC vault, material users)
async function aadhaarAlreadyExists(digits12) {
    if (!/^\d{12}$/.test(digits12 || '') || !piiReady()) return false;
    const hash = piiIndex('AADHAAR', digits12);
    const idx = await loadAgentsIndex();
    if (await findIdentityOwner(digits12, [], '', idx, '')) return true;
    const q = async function (sql) { const r = await safeQ(sql, [hash]); return !!(r && r.length); };
    if (await q("SELECT 1 AS x FROM customer_registration_orders WHERE aadhaar_hash = ? AND status = 'paid' LIMIT 1")) return true;
    if (await q("SELECT 1 AS x FROM material_users WHERE aadhaar_hash = ? LIMIT 1")) return true;
    if (await q("SELECT 1 AS x FROM material_user_requests WHERE aadhaar_hash = ? AND COALESCE(status,'pending') = 'pending' LIMIT 1")) return true;
    return false;
}
function genTrackingId(prefix) {
    return 'TRK-' + prefix + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
}
async function xBlobGet(key, dflt) {
    try {
        const r = await dbq('SELECT value FROM kv_blob WHERE `key` = ?', [key]);
        const v = JSON.parse(r[0] && r[0].value);
        return v == null ? dflt : v;
    } catch (e) { return dflt; }
}
async function xBlobSet(key, val) {
    await dbq('INSERT INTO kv_blob ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(val)]);
}
let _trkQueue = Promise.resolve();
function addTracking(rec) {
    rec.createdAt = new Date().toISOString();
    _trkQueue = _trkQueue.then(async function () {
        const list = await xBlobGet('tracking_records', []);
        (Array.isArray(list) ? list : (list = [])).push(rec);
        await xBlobSet('tracking_records', list.slice(-5000));
    }).catch(function (e) { console.error('tracking save failed:', e.message); });
    return _trkQueue;
}

// ── Fee configuration (Super Admin controlled; ₹0 = free) ──
const FEE_KINDS = ['agent', 'hrms', 'customer', 'material'];
function feeNum(v) { const n = Math.round(Number(v) * 100) / 100; return (isFinite(n) && n >= 0 && n <= 1000000) ? n : null; }
async function getFeeConfig() {
    const c = await xBlobGet('fee_config', {});
    const cfg = { defaults: { agent: 0, hrms: 0, material: 0 }, overrides: [] };
    if (c && c.defaults) { ['agent', 'hrms', 'material'].forEach(function (k) { const n = feeNum(c.defaults[k]); if (n !== null) cfg.defaults[k] = n; }); }
    if (c && Array.isArray(c.overrides)) cfg.overrides = c.overrides.filter(function (o) { return o && o.key && feeNum(o.fee) !== null; });
    return cfg;
}
// Resolution order: per-mobile override → per-agent override → default (customer: the plan's own price).
async function resolveFee(kind, ctx) {
    const cfg = await getFeeConfig();
    ctx = ctx || {};
    const mob = last10(ctx.mobile);
    const agents = (Array.isArray(ctx.agent) ? ctx.agent : [ctx.agent]).map(function (a) { return String(a || '').trim().toLowerCase(); }).filter(Boolean);
    const match = function (o) { return o.kind === kind || o.kind === '*' || !o.kind; };
    if (mob.length === 10) { const o = cfg.overrides.find(function (x) { return match(x) && last10(x.key) === mob && /^\d{10}$/.test(last10(x.key)) && String(x.key).replace(/\D/g, '').length >= 10; }); if (o) return feeNum(o.fee); }
    if (agents.length) { const o = cfg.overrides.find(function (x) { return match(x) && agents.indexOf(String(x.key).trim().toLowerCase()) >= 0; }); if (o) return feeNum(o.fee); }
    if (kind === 'customer') return feeNum(ctx.planPrice) === null ? 0 : feeNum(ctx.planPrice);
    return cfg.defaults[kind] || 0;
}
async function verifyRegPayment(kind, fee, p) {
    const secret = process.env.PAYMENT_API_SECRET;
    if (!secret || !p || !p.orderId || !p.paymentId || !p.signature) return false;
    const expected = crypto.createHmac('sha256', secret).update(p.orderId + '|' + p.paymentId).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(p.signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { console.error('❌ registration payment signature MISMATCH — order=' + p.orderId + ' payment=' + p.paymentId); return false; }
    try { await razorpayConfirmPayment(p.orderId, p.paymentId, fee); } catch (e) { console.error('❌ registration payment rejected — order=' + p.orderId + ':', e.message); return false; }
    const orders = await xBlobGet('reg_orders', {});
    const o = orders && orders[p.orderId];
    if (!o || o.kind !== kind || Number(o.fee) !== Number(fee) || o.used) { console.error('❌ registration payment: order/amount check failed — order=' + p.orderId + ' found=' + !!o + ' kindOk=' + !!(o && o.kind === kind) + ' feeOk=' + !!(o && Number(o.fee) === Number(fee)) + ' alreadyUsed=' + !!(o && o.used)); return false; }
    o.used = true; o.paymentId = p.paymentId;
    await xBlobSet('reg_orders', orders);
    return true;
}
function feeGate(kind) {
    return function (req, res, next) {
        (async function () {
            const b = req.body || {};
            const fee = await resolveFee(kind, { mobile: b.mobile || b.phone, agent: [b.agentUsername, b.agent, b.agentId] });
            req.__fee = fee;
            if (fee <= 0) return next();
            const ok = await verifyRegPayment(kind, fee, b.payment || {});
            if (!ok) return res.status(402).json({ error: 'A registration fee of ₹' + fee + ' is required. Please complete the payment to continue.', feeRequired: true, fee: fee });
            req.__paymentRef = String(b.payment.paymentId).slice(0, 60);
            next();
        })().catch(function (e) { console.error('feeGate error:', e.message); res.status(500).json({ error: 'Unable to verify the registration fee. Please try again.' }); });
    };
}
app.get('/api/registration/fee', asyncRoute(async (req, res) => {
    const kind = String(req.query.kind || '');
    if (FEE_KINDS.indexOf(kind) < 0 || kind === 'customer') return res.status(400).json({ error: 'Invalid registration type.' });
    const fee = await resolveFee(kind, { mobile: req.query.mobile, agent: req.query.agent });
    res.json({ fee: fee, free: fee <= 0 });
}));
app.post('/api/registration/payment-order', asyncRoute(async (req, res) => {
    if (hitRateLimit('regpay:' + (req.ip || ''), 20, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (kind !== 'agent' && kind !== 'hrms' && kind !== 'material') return res.status(400).json({ error: 'Invalid registration type.' });
    const fee = await resolveFee(kind, { mobile: b.mobile, agent: [b.agentUsername, b.agent, b.agentId] });
    if (fee <= 0) return res.json({ free: true, fee: 0 });
    if (!process.env.PAYMENT_API_KEY || !process.env.PAYMENT_API_SECRET) return res.status(501).json({ error: 'Payment keys are not set in the Render Environment (PAYMENT_API_KEY / PAYMENT_API_SECRET).' });
    const order = await razorpayRequest('/v1/orders', { amount: Math.round(fee * 100), currency: 'INR', receipt: 'reg_' + kind + '_' + Date.now(), notes: { kind: kind } });
    const orders = await xBlobGet('reg_orders', {});
    const keys = Object.keys(orders);
    if (keys.length > 2000) keys.slice(0, keys.length - 1500).forEach(function (k) { delete orders[k]; });
    orders[order.id] = { kind: kind, fee: fee, used: false, at: Date.now() };
    await xBlobSet('reg_orders', orders);
    res.json({ free: false, orderId: order.id, amount: order.amount, currency: order.currency, key: process.env.PAYMENT_API_KEY, fee: fee });
}));
app.get('/api/admin/fee-config', requireRole('admin'), asyncRoute(async (req, res) => { res.json(await getFeeConfig()); }));
app.put('/api/admin/fee-config', requireRole('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const cfg = { defaults: { agent: 0, hrms: 0, material: 0 }, overrides: [] };
    for (const k of ['agent', 'hrms', 'material']) {
        const n = feeNum(b.defaults && b.defaults[k]);
        if (b.defaults && b.defaults[k] !== undefined && n === null) return res.status(400).json({ error: 'Please enter a valid fee amount (0 or more).' });
        cfg.defaults[k] = n === null ? 0 : n;
    }
    for (const o of (Array.isArray(b.overrides) ? b.overrides : [])) {
        const key = cleanText(o && o.key, 80).trim();
        const fee = feeNum(o && o.fee);
        if (!key) continue;
        if (fee === null) return res.status(400).json({ error: 'Invalid fee for "' + key + '".' });
        const kind = ['agent', 'hrms', 'customer', 'material', '*'].indexOf(o.kind) >= 0 ? o.kind : '*';
        cfg.overrides.push({ key: key, kind: kind, fee: fee, note: cleanText(o.note, 120) });
    }
    if (cfg.overrides.length > 500) return res.status(400).json({ error: 'Too many custom fee rows (max 500).' });
    await xBlobSet('fee_config', cfg);
    res.json(cfg);
}));

// ── Dynamic branding: the agent's company name + logo for login page / dashboard header ──
app.get('/api/branding/agent', asyncRoute(async (req, res) => {
    const u = String(req.query.u || '').trim().toLowerCase();
    res.set('Cache-Control', 'public, max-age=60');
    if (!u || u.length > 80) return res.json({ found: false });
    const rows = await dbq('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['agents']);
    const list = parseEntityList(rows[0] && rows[0].value);
    const a = list.find(function (x) { return x && (String(x.username || '').toLowerCase() === u || String(x.agentId || '').toLowerCase() === u); });
    if (!a) return res.json({ found: false });
    const logo = String(a.logo || '');
    const okLogo = /^(data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,|https?:\/\/|\/[^\/])/i.test(logo) && logo.length < 3 * 1024 * 1024;
    res.json({ found: true, company: a.company || '', name: a.name || '', logo: okLogo ? logo : '' });
}));

// ── Tracking lookup for Agent / HRMS registrations (used by track-status) ──
async function trackingLookup(trackingId, mobile) {
    const list = await xBlobGet('tracking_records', []);
    const t = (Array.isArray(list) ? list : []).find(function (r) { return r && String(r.trackingId).toLowerCase() === trackingId.toLowerCase() && last10(r.mobile) === mobile; });
    if (!t) return null;
    const out = { success: true, trackingId: t.trackingId, applicationId: t.trackingId, name: t.name, type: t.kind === 'agent' ? 'Agent Registration' : 'HRMS / Staff Registration', submittedOn: t.createdAt, status: 'pending', feePaid: t.fee || 0 };
    if (t.kind === 'agent') {
        const pend = parseEntityList(((await dbq('SELECT value FROM kv_blob WHERE `key` = ?', ['agent_pending_registrations']))[0] || {}).value);
        const p = pend.find(function (x) { return x && x.id === t.regId; });
        const ag = parseEntityList(((await dbq('SELECT value FROM kv_admin_entities WHERE `key` = ?', ['agents']))[0] || {}).value);
        const agent = ag.find(function (x) { return x && String(x.username || '').toLowerCase() === String(t.username || '').toLowerCase(); });
        if (agent) { out.status = 'approved'; out.credentials = { userId: agent.username, password: null }; out.message = 'Your Agent registration has been approved. Sign in with your User ID and the password you chose at registration.'; }
        else if (p && String(p.status || 'pending') === 'rejected') { out.status = 'rejected'; out.message = 'Your registration was not approved. Please contact the Admin.'; }
        else if (!p) { out.status = 'rejected'; out.message = 'This registration is no longer in the review queue. Please contact the Admin.'; }
        else out.message = 'Your registration is under review by the Admin.';
    } else {
        const pend = parseEntityList(((await dbq('SELECT value FROM kv_blob WHERE `key` = ?', ['hrms_pending_registrations']))[0] || {}).value);
        if (pend.some(function (x) { return x && x.id === t.regId; })) { out.message = 'Your registration is under review.'; }
        else {
            const emps = parseEntityList(((await dbq('SELECT value FROM kv_blob WHERE `key` = ?', ['hrms_employees']))[0] || {}).value);
            const e = emps.find(function (x) { return x && last10(x.phone) === mobile; });
            if (e) { out.status = 'approved'; out.credentials = { userId: e.empId, password: null }; out.message = 'Your registration has been approved. Your Employee ID is ' + e.empId + '. Sign in on the HRMS login page with this ID.'; }
            else { out.status = 'rejected'; out.message = 'Your registration was not approved. Please contact your library / Admin.'; }
        }
    }
    return out;
}

// ═══ MASTER USERS & REGISTRATIONS LIST (Super Admin — every Supabase record in one place) ═══
const MASTER_SOURCES = [
    { id: 'agents', table: 'kv_admin_entities', key: 'agents', kind: 'agent', label: 'Agent' },
    { id: 'students', table: 'kv_admin_entities', key: 'students', kind: 'student', label: 'Student' },
    { id: 'staff', table: 'kv_admin_entities', key: 'staff', kind: 'staff', label: 'Staff' },
    { id: 'hrms_employees', table: 'kv_blob', key: 'hrms_employees', kind: 'employee', label: 'HRMS Staff' },
    { id: 'hrms_pending_registrations', table: 'kv_blob', key: 'hrms_pending_registrations', kind: 'employee', label: 'HRMS Registration (pending)' },
    { id: 'agent_pending_registrations', table: 'kv_blob', key: 'agent_pending_registrations', kind: 'agent', label: 'Agent Registration (pending)' },
    { id: 'customer_pending_registrations', table: 'kv_blob', key: 'customer_pending_registrations', kind: 'customer', label: 'Customer Registration' }
];
function masterRecId(rec) { return String(firstDefined(rec.id, rec.studentId, rec.empId, rec.agentId, rec.username, '')).trim(); }
function masterStatus(rec) { return String(rec.status || 'active').toLowerCase(); }
app.get('/api/admin/master-list', noStore, requireRole('admin'), asyncRoute(async (req, res) => {
    const idx = await loadAgentsIndex();
    const kycRows = await safeQ('SELECT entity_type, entity_id, aadhaar_last4 FROM kyc_records LIMIT 50000', []);
    const kycMap = new Map();
    kycRows.forEach(function (r) { kycMap.set(r.entity_type + ':' + String(r.entity_id).toLowerCase(), r.aadhaar_last4 || ''); });
    const out = [];
    for (const s of MASTER_SOURCES) {
        const rows = await safeQ('SELECT value FROM ' + s.table + ' WHERE `key` = ?', [s.key]);
        const list = parseEntityList(rows[0] && rows[0].value);
        list.forEach(function (rec) {
            if (!rec || typeof rec !== 'object') return;
            const id = masterRecId(rec);
            const att = attribute(idx, [rec.agentUsername, rec.ownerUser, rec.agentId, s.kind === 'agent' ? rec.username : '']);
            let last4 = kycMap.get(s.kind + ':' + id.toLowerCase()) || '';
            if (!last4) { const d = extractAadhaarDigits(rec); if (d) last4 = d.slice(-4); }
            out.push({
                source: s.id, kind: s.kind, type: s.label, id: id, name: rec.name || '', mobile: rec.mobile || rec.phone || '', email: rec.email || '',
                address: rec.address || '', username: rec.username || '', status: masterStatus(rec),
                aadhaarMasked: last4 ? 'XXXX-XXXX-' + last4 : '', trackingId: rec.trackingId || '',
                agentUsername: att.agentUsername || String(rec.agentUsername || ''), agentName: att.agentName, company: s.kind === 'agent' ? (rec.company || '') : (att.agentCompany || ''),
                createdAt: rec.createdAt || rec.submittedOn || rec.joinedOn || rec.registeredOn || rec.date || ''
            });
        });
    }
    const mu = await safeQ('SELECT * FROM material_users ORDER BY 1 DESC LIMIT 5000', []);
    mu.forEach(function (r) {
        out.push({ source: 'material_users', kind: 'material_user', type: 'Material User', id: String(r.userid || r.userId || ''), name: r.name || '', mobile: r.mobile || '', email: r.email || '', address: r.address || r.village || '',
            username: String(r.userid || ''), status: String(r.status || 'active').toLowerCase(), aadhaarMasked: r.aadhaar_last4 ? 'XXXX-XXXX-' + r.aadhaar_last4 : '', trackingId: '', agentUsername: '', agentName: '', company: '', createdAt: r.created_at || r.createdat || '' });
    });
    const mr = await safeQ('SELECT * FROM material_user_requests ORDER BY 1 DESC LIMIT 5000', []);
    mr.forEach(function (r) {
        out.push({ source: 'material_user_requests', kind: 'material_request', type: 'Material User Request', id: String(r.id || ''), name: r.name || '', mobile: r.mobile || '', email: r.email || '', address: r.address || r.village || '',
            username: '', status: String(r.status || 'pending').toLowerCase(), aadhaarMasked: '', trackingId: '', agentUsername: '', agentName: '', company: '', createdAt: r.created_at || r.createdat || '' });
    });
    const counts = {};
    out.forEach(function (r) { counts[r.type] = (counts[r.type] || 0) + 1; });
    res.json({ total: out.length, counts: counts, items: out, agents: Array.from(new Set(Array.from(idx.values()))).map(function (a) { return { username: a.username, name: a.name, company: a.company, agentId: a.agentId }; }) });
}));
const MASTER_EDITABLE = ['name', 'mobile', 'phone', 'email', 'address', 'status', 'company', 'designation', 'department'];
app.put('/api/admin/master/:source/:id', requireRole('admin'), asyncRoute(async (req, res) => {
    const src = req.params.source, id = String(req.params.id || '').trim();
    const b = req.body || {};
    if (b.status !== undefined && ['active', 'inactive', 'blocked', 'pending', 'approved', 'rejected'].indexOf(String(b.status).toLowerCase()) < 0) return res.status(400).json({ error: 'Invalid status.' });
    if (src === 'material_users') {
        const sets = [], params = [];
        ['name', 'mobile', 'email', 'address', 'status'].forEach(function (f) { if (b[f] !== undefined) { sets.push(f + ' = ?'); params.push(cleanText(b[f], 500)); } });
        if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });
        params.push(id);
        const r = await dbq('UPDATE material_users SET ' + sets.join(', ') + ' WHERE userid = ? RETURNING userid', params);
        if (!r.length) return res.status(404).json({ error: 'Record not found.' });
        return res.json({ success: true });
    }
    const s = MASTER_SOURCES.find(function (x) { return x.id === src; });
    if (!s) return res.status(400).json({ error: 'Unknown record source.' });
    const rows = await dbq('SELECT value FROM ' + s.table + ' WHERE `key` = ?', [s.key]);
    const list = parseEntityList(rows[0] && rows[0].value);
    const rec = list.find(function (r) { return r && masterRecId(r).toLowerCase() === id.toLowerCase(); });
    if (!rec) return res.status(404).json({ error: 'Record not found.' });
    MASTER_EDITABLE.forEach(function (f) { if (b[f] !== undefined) rec[f] = cleanText(b[f], 500); });
    // Agent ↔ Staff / Student mapping
    if (b.agentUsername !== undefined) {
        const idx = await loadAgentsIndex();
        const uname = String(b.agentUsername || '').trim().toLowerCase();
        if (uname) {
            const a = idx.get(uname);
            if (!a) return res.status(400).json({ error: 'The selected Agent was not found.' });
            rec.agentUsername = a.username; rec.ownerUser = a.username; if (a.agentId) rec.agentId = a.agentId;
        } else { rec.agentUsername = ''; rec.ownerUser = ''; }
    }
    await dbq('INSERT INTO ' + s.table + ' ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', [s.key, JSON.stringify(list)]);
    if (s.key === 'agents') _scopeCache.clear();
    if (b.name !== undefined || b.mobile !== undefined || b.email !== undefined) {
        await safeQ('UPDATE kyc_records SET full_name = COALESCE(?, full_name), mobile = COALESCE(?, mobile), email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP WHERE entity_type = ? AND LOWER(entity_id) = ?',
            [b.name !== undefined ? cleanText(b.name, 255) : null, b.mobile !== undefined ? cleanText(b.mobile, 20) : null, b.email !== undefined ? cleanText(b.email, 255) : null, s.kind, id.toLowerCase()]);
    }
    res.json({ success: true });
}));
app.delete('/api/admin/master/:source/:id', requireRole('admin'), asyncRoute(async (req, res) => {
    const src = req.params.source, id = String(req.params.id || '').trim();
    if (src === 'material_users') {
        const r = await dbq('DELETE FROM material_users WHERE userid = ? RETURNING userid', [id]);
        return r.length ? res.json({ success: true }) : res.status(404).json({ error: 'Record not found.' });
    }
    if (src === 'material_user_requests') {
        const r = await dbq('DELETE FROM material_user_requests WHERE id = ? RETURNING id', [id]);
        return r.length ? res.json({ success: true }) : res.status(404).json({ error: 'Record not found.' });
    }
    const s = MASTER_SOURCES.find(function (x) { return x.id === src; });
    if (!s) return res.status(400).json({ error: 'Unknown record source.' });
    const rows = await dbq('SELECT value FROM ' + s.table + ' WHERE `key` = ?', [s.key]);
    const list = parseEntityList(rows[0] && rows[0].value);
    const next = list.filter(function (r) { return !(r && masterRecId(r).toLowerCase() === id.toLowerCase()); });
    if (next.length === list.length) return res.status(404).json({ error: 'Record not found.' });
    await dbq('INSERT INTO ' + s.table + ' ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value', [s.key, JSON.stringify(next)]);
    await safeQ('DELETE FROM kyc_records WHERE entity_type = ? AND LOWER(entity_id) = ?', [s.kind, id.toLowerCase()]);
    if (s.key === 'agents') _scopeCache.clear();
    res.json({ success: true });
}));

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
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || '';   // no hardcoded fallback; empty → ping is skipped
const SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minute (15 minute wali sleep-limit se kam)

function selfPing() {
    try {
        if (!SELF_PING_URL) return;   // nothing to ping (e.g. local / Vercel)
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
const RUN_STANDALONE = !IS_VERCEL && (require.main === module || process.env.AM_STANDALONE === '1');   // ▲ true only when started with `node server.js` (Render / local); false on Vercel
if (RUN_STANDALONE) {   // ▲ Vercel functions sleep by themselves — a self-ping timer is useless there
    setTimeout(selfPing, 30 * 1000);
    setInterval(selfPing, SELF_PING_INTERVAL_MS);
}

// Start Server
// ▲ On Vercel the platform calls the exported app per request; app.listen() is only for Render/local.
const server = !RUN_STANDALONE ? null : app.listen(PORT, () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`📁 Static: ${PUBLIC_DIR ? 'public/ + safe root files' : 'safe root files (public/ folder not found)'}`);
    // 🆕 Deploy ke waqt turant dikh jaaye ki "/" par kaunsi index.html serve hogi (ya nahi mili).
    const _idxFile = findStaticFile('index.html');
    console.log(_idxFile
        ? `📄 "/" par index.html will be served: ${_idxFile}`
        : '⚠️ index.html not found — only the text “Backend is running” will be shown at “/”. Place index.html alongside server.js (same folder) or in the public/ folder.');
});
// Render ke proxy ke keep-alive (60s) se bada rakhte hain — warna kabhi-kabhi random 502 aata hai.
if (server) {
    server.keepAliveTimeout = 65 * 1000;
    server.headersTimeout = 66 * 1000;
}
// 🆕 Graceful shutdown: Render redeploy par SIGTERM aata hai — chalti requests poori hone do, DB pool band karo.
let _shuttingDown = false;
function gracefulShutdown(sig) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log('🛑 ' + sig + ' received. The server is shutting down...');
    setTimeout(() => process.exit(0), 10000).unref();
    if (!server) return process.exit(0);
    server.close(() => { Promise.resolve(db.end()).catch(() => {}).then(() => process.exit(0)); });
}
if (RUN_STANDALONE) {
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
// ▲ Vercel entry point (@vercel/node uses the exported Express app as the request handler)
module.exports = app;
