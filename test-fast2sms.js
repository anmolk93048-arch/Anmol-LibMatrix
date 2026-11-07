// Standalone Fast2SMS check — no database, no app needed.
//   FAST2SMS_API_KEY=xxxx node test-fast2sms.js 9876543210            (sends a real test OTP "4321")
//   optional: FAST2SMS_ROUTE=dlt FAST2SMS_SENDER_ID=ABCDEF FAST2SMS_TEMPLATE_ID=123456
// Prints the exact HTTP status and Fast2SMS reply so you can see where the problem is.
const https = require('https');
const key = process.env.FAST2SMS_API_KEY || process.env.SMS_API_KEY || '';
const mobile = String(process.argv[2] || '').replace(/\D/g, '').slice(-10);
if (!key) { console.error('✖ Set FAST2SMS_API_KEY first.'); process.exit(1); }
if (mobile.length !== 10) { console.error('✖ Usage: node test-fast2sms.js <10-digit mobile>'); process.exit(1); }
const route = (process.env.FAST2SMS_ROUTE || 'otp').toLowerCase();
const body = route === 'dlt'
  ? { route: 'dlt', sender_id: process.env.FAST2SMS_SENDER_ID, message: process.env.FAST2SMS_TEMPLATE_ID, variables_values: '4321', numbers: mobile, flash: 0 }
  : { route: 'otp', variables_values: '4321', numbers: mobile, flash: 0 };
const payload = JSON.stringify(body);
console.log('→ POST https://www.fast2sms.com/dev/bulkV2  route=' + route + '  mobile=' + mobile + '  key=…' + key.slice(-4));
const rq = https.request('https://www.fast2sms.com/dev/bulkV2', { method: 'POST', timeout: 15000, headers: { authorization: key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => {
  let d = ''; r.on('data', c => d += c); r.on('end', () => {
    console.log('← HTTP ' + r.statusCode + '\n' + d);
    try { const j = JSON.parse(d); console.log(j.return === true ? '\n✔ Fast2SMS accepted the OTP — check the phone.' : '\n✖ Rejected: ' + (Array.isArray(j.message) ? j.message.join(' ') : j.message)); } catch (e) { console.log('\n✖ Reply was not JSON.'); }
  });
});
rq.on('timeout', () => rq.destroy(new Error('timed out — this machine cannot reach www.fast2sms.com')));
rq.on('error', e => console.error('✖ Network error:', e.code || '', e.message));
rq.write(payload); rq.end();
