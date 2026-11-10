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
// Render / local: `node server.js` still works (app-main.js starts the listener itself).
// ══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

if (require.main === module) process.env.AM_STANDALONE = '1';   // tell app-main.js it must open the port itself (Render / local)
const IS_VERCEL = !!(process.env.VERCEL || process.env.VERCEL_ENV);

// Last-resort process guards (app-main.js registers its own too; these cover the moment BEFORE it loads).
process.on('uncaughtException', (err) => { console.error('🚨 UNCAUGHT EXCEPTION (crash prevented):', err && err.stack || err); });
process.on('unhandledRejection', (reason) => { console.error('🚨 UNHANDLED REJECTION (crash prevented):', reason); });

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

let app = null, bootError = null, bootInfo = null;
try {
    app = require('./app-main.js');
    if (typeof app !== 'function') throw new Error('app-main.js did not export the Express app (module.exports = app is missing).');
} catch (e) {
    bootError = e;
    try { bootInfo = preflight(); } catch (e2) { bootInfo = {}; }
    console.error('🚨 BOOT FAILED — the app could not be loaded. Serving the safe fallback instead of crashing.');
    console.error('   reason :', e && e.stack || e);
    console.error('   preflight:', JSON.stringify(bootInfo));
    if (e && e.code === 'MODULE_NOT_FOUND') console.error('   → a file or npm package is missing from this deployment. Check package.json dependencies and vercel.json includeFiles.');
}

function fallbackHandler(req, res) {
    try {
        const url = String(req.url || '/').split('?')[0];
        const status = {
            ok: false, boot: 'failed',
            reason: redact(bootError && (bootError.message || bootError)),
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
        return send(503, 'application/json; charset=utf-8', JSON.stringify({ error: 'The service is temporarily unavailable. Please try again shortly.' }));
    } catch (e) {
        try { res.statusCode = 503; res.end('Service temporarily unavailable'); } catch (e2) { /* nothing more to do */ }
    }
}

if (app) {
    module.exports = app;   // ▲ Vercel entry point — the real, full Express app
} else {
    module.exports = fallbackHandler;   // ▲ boot failed — still a valid (req, res) handler, so the function does not crash
    if (require.main === module && !IS_VERCEL) {   // Render / local: keep the port open so the platform does not restart-loop
        require('http').createServer(fallbackHandler).listen(process.env.PORT || 3000, () => console.log('⚠️ Fallback server listening — see the boot error above.'));
    }
}
