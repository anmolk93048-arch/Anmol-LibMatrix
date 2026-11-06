'use strict';
/* One-time: creates the WhatsApp AUTHENTICATION template (one-tap autofill, 10-minute expiry).
   Run once:  WA_ACCESS_TOKEN=... WABA_ID=... node setup-wa-template.js
   Then wait for Meta approval (status APPROVED in WhatsApp Manager) before OTPs can be sent. */
const https = require('https');
const { WA_ACCESS_TOKEN, WABA_ID } = process.env;
if (!WA_ACCESS_TOKEN || !WABA_ID) { console.error('Set WA_ACCESS_TOKEN and WABA_ID (WhatsApp Business Account ID).'); process.exit(1); }
const body = JSON.stringify({
  name: process.env.WA_OTP_TEMPLATE || 'libmatrix_login_otp',
  language: process.env.WA_TEMPLATE_LANG || 'en',
  category: 'AUTHENTICATION',
  components: [
    { type: 'BODY', add_security_recommendation: true },
    { type: 'FOOTER', code_expiration_minutes: 10 },
    { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'ONE_TAP', text: 'Copy code', autofill_text: 'Autofill',
        package_name: 'com.anmol.libmatrix', signature_hash: 'Abc123Xyz99' }] }
  ]
});
// Also creates the two UTILITY templates used for login credentials / account notices.
//   libmatrix_credentials  → {{1}} name, {{2}} User ID, {{3}} password, {{4}} portal link
//   libmatrix_account_notice → {{1}} name, {{2}} message, {{3}} User ID, {{4}} portal link
const UTIL = [
  { name: process.env.WA_CRED_TEMPLATE || 'libmatrix_credentials', language: process.env.WA_TEMPLATE_LANG || 'en', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hello {{1}}, your Anmol LibMatrix login details are ready. User ID: {{2}} Password: {{3}} Portal: {{4}} Please change your password after signing in.',
      example: { body_text: [['Rahul', 'AGT001', 'K7M2PQ', 'https://portal.example.com']] } }] },
  { name: process.env.WA_NOTICE_TEMPLATE || 'libmatrix_account_notice', language: process.env.WA_TEMPLATE_LANG || 'en', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hello {{1}}, {{2}} User ID: {{3}} Portal: {{4}}',
      example: { body_text: [['Rahul', 'your account has been approved.', 'AGT001', 'https://portal.example.com']] } }] }
];
function post(payload) {
  const b = JSON.stringify(payload);
  const r = https.request('https://graph.facebook.com/' + (process.env.WA_API_VERSION || 'v21.0') + '/' + WABA_ID + '/message_templates',
    { method: 'POST', headers: { Authorization: 'Bearer ' + WA_ACCESS_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
    (x) => { let d = ''; x.on('data', c => d += c); x.on('end', () => console.log(payload.name, x.statusCode, d)); });
  r.on('error', e => console.error(e.message)); r.write(b); r.end();
}
UTIL.forEach(post);
const rq = https.request('https://graph.facebook.com/' + (process.env.WA_API_VERSION || 'v21.0') + '/' + WABA_ID + '/message_templates',
  { method: 'POST', headers: { Authorization: 'Bearer ' + WA_ACCESS_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
  (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => console.log(r.statusCode, d)); });
rq.on('error', e => console.error(e.message)); rq.write(body); rq.end();
