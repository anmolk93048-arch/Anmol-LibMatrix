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
async function sendTemplate(mobile, templateName, bodyParams, buttonParam) {
    const c = config();
    if (!c.enabled) throw waError('WhatsApp sending is disabled (WA_ENABLED=false).');
    if (!isConfigured()) throw waError('WhatsApp is not configured (set ' + missingConfig().join(' / ') + ').');
    if (!templateName) throw waError('WhatsApp template name is not configured (WA_TEMPLATE_OTP / WA_TEMPLATE_INFO).');
    const num = last10(mobile);
    if (num.length !== 10) throw waError('A valid 10-digit mobile number is required.');
    const components = [{ type: 'body', parameters: bodyParams.map((p) => ({ type: 'text', text: String(p) })) }];
    if (buttonParam != null) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(buttonParam) }] });
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: c.cc + num, type: 'template',
        template: { name: templateName, language: { code: c.lang }, components } };
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
function sendOtp(mobile, otp) { return sendTemplate(mobile, config().templates.otp, [otp], otp); }
// 2) Login info — User ID + password + the portal's own login link, for registrations AND password resets in every portal.
function sendLoginInfo(mobile, o) {
    o = o || {};
    return sendTemplate(mobile, config().templates.info, [clean(o.name || 'User'), clean(o.userId), clean(o.password), clean(portalLink(o.portal, o.link))]);
}
// Optional: password-less notices (approved / password changed / username recovered). Only used when WA_TEMPLATE_NOTICE is set.
function noticeEnabled() { return !!config().templates.notice; }
function sendNotice(mobile, o) {
    o = o || {};
    return sendTemplate(mobile, config().templates.notice, [clean(o.name || 'User'), clean(o.text), clean(o.userId), clean(portalLink(o.portal, o.link))]);
}

module.exports = { config, isConfigured, missingConfig, describe, portalLink, sendTemplate, sendOtp, sendLoginInfo, sendNotice, noticeEnabled, clean };
