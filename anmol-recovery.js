/* Anmol LibMatrix \u2014 shared "Forgot Password / Forgot User ID" modal + inline OTP helper (injected by route-mask.js).
 *
 *  AnmolRecovery.open({ scope:'material'|'entity'|'any', mode:'password'|'userid', userId:'' })
 *     Modal fields: State, Mobile No., Email ID, Security Captcha, Proceed / Reset button (+ User ID for password mode).
 *     After "Send OTP" the 4-digit OTP boxes and the new-password fields appear INSIDE the same modal (inline).
 *     Endpoints (same as the server): /<base>/forgot-password \u00b7 /<base>/reset-password \u00b7 /<base>/forgot-username
 *        scope material \u2192 /material \u00b7 entity \u2192 /agent \u00b7 any \u2192 /auth
 *
 *  AnmolOtp.start({button, note, seconds, onExpire})          resend countdown (used by the old Agent modal too)
 *  AnmolOtp.inline(afterEl, {length, onSend(), onVerify(code), title})
 *     \u2192 renders "Send OTP" + OTP boxes in a box directly under `afterEl` (e.g. inside a login card) instead of a headline banner.
 *
 *  Not used on Student Attendance and PFMS portals (they simply do not load this file's openers).
 */
(function () {
  if (window.AnmolRecovery) return;
  var STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];
  var BASES = { material: '/material', entity: '/agent', any: '/auth' };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  /* \u2500\u2500\u2500\u2500\u2500 OTP helpers \u2500\u2500\u2500\u2500\u2500 */
  var AnmolOtp = window.AnmolOtp || {};
  if (!AnmolOtp.start) AnmolOtp.start = function (o) {
    var left = Math.max(1, +o.seconds || 60), b = o.button, n = o.note, t;
    function tick() {
      if (b) { b.disabled = left > 0; }
      if (n) n.textContent = left > 0 ? 'You can request a new OTP in ' + left + 's' : 'Did not get the OTP? You can resend it now.';
      if (left-- <= 0) { clearInterval(t); if (o.onExpire) o.onExpire(); }
    }
    tick(); t = setInterval(tick, 1000);
  };
  // OTP digit boxes: returns { el, value(), clear(), focus() }
  function otpBoxes(len, onDone) {
    var wrap = document.createElement('div'); wrap.className = 'arx-otp';
    var inputs = [];
    for (var i = 0; i < len; i++) {
      var inp = document.createElement('input');
      inp.type = 'text'; inp.inputMode = 'numeric'; inp.maxLength = 1; inp.autocomplete = i ? 'off' : 'one-time-code'; inp.setAttribute('aria-label', 'OTP digit ' + (i + 1));
      wrap.appendChild(inp); inputs.push(inp);
    }
    var val = function () { return inputs.map(function (x) { return x.value; }).join(''); };
    inputs.forEach(function (inp, i) {
      inp.addEventListener('input', function () {
        inp.value = inp.value.replace(/\D/g, '').slice(-1);
        if (inp.value && i < len - 1) inputs[i + 1].focus();
        if (val().length === len && onDone) onDone(val());
      });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Backspace' && !inp.value && i) inputs[i - 1].focus(); });
      inp.addEventListener('paste', function (e) {
        var d = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, len);
        if (!d) return; e.preventDefault();
        d.split('').forEach(function (c, k) { inputs[k].value = c; });
        inputs[Math.min(d.length, len - 1)].focus();
        if (d.length === len && onDone) onDone(d);
      });
    });
    return { el: wrap, value: val, clear: function () { inputs.forEach(function (x) { x.value = ''; }); }, focus: function () { inputs[0].focus(); } };
  }
  // Inline OTP box under an element (e.g. inside the login card) \u2014 never a headline banner.
  AnmolOtp.inline = AnmolOtp.inline || function (after, o) {
    o = o || {};
    var box = document.createElement('div'); box.className = 'arx-inline';
    box.innerHTML = '<div class="arx-inline-t">' + esc(o.title || 'One-time password') + '</div><div class="arx-msg" hidden></div>' +
      '<div class="arx-row"><button type="button" class="arx-btn arx-sec" data-r="send">Generate OTP</button><span class="arx-note"></span></div>' +
      '<div data-r="enter" hidden><div class="arx-lbl">Enter the OTP</div><div data-r="boxes"></div>' +
      '<button type="button" class="arx-btn arx-pri" data-r="verify" style="margin-top:10px;width:100%">Verify OTP</button></div>';
    var q = function (r) { return box.querySelector('[data-r="' + r + '"]'); };
    var msg = box.querySelector('.arx-msg'), note = box.querySelector('.arx-note');
    var boxes = otpBoxes(o.length || 4); q('boxes').appendChild(boxes.el);
    var say = function (t, k) { msg.hidden = !t; msg.className = 'arx-msg ' + (k || 'info'); msg.textContent = t || ''; };
    q('send').onclick = function () {
      var b = q('send'); b.disabled = true; say('Sending OTP\u2026', 'info');
      Promise.resolve(o.onSend && o.onSend()).then(function (r) {
        say((r && r.message) || 'OTP sent.', 'ok'); q('enter').hidden = false; boxes.clear(); boxes.focus();
        AnmolOtp.start({ button: b, note: note, seconds: (r && r.resendInSec) || 60 }); b.textContent = 'Resend OTP';
      }).catch(function (e) { b.disabled = false; say(e && e.message || 'Could not send the OTP.', 'err'); });
    };
    q('verify').onclick = function () {
      var c = boxes.value(); if (c.length < (o.length || 4)) return say('Enter the full OTP.', 'err');
      q('verify').disabled = true;
      Promise.resolve(o.onVerify && o.onVerify(c)).then(function (r) { say((r && r.message) || 'Verified.', 'ok'); })
        .catch(function (e) { say(e && e.message || 'Invalid or expired OTP.', 'err'); boxes.clear(); boxes.focus(); })
        .then(function () { q('verify').disabled = false; });
    };
    after.parentNode.insertBefore(box, after.nextSibling);
    return { el: box, say: say };
  };
  window.AnmolOtp = AnmolOtp;

  /* \u2500\u2500\u2500\u2500\u2500 styles \u2500\u2500\u2500\u2500\u2500 */
  var css = '.arx-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(10,25,50,.55);backdrop-filter:blur(5px);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.arx-ov[hidden]{display:none}.arx-card{width:min(100%,430px);max-height:92vh;overflow:auto;background:#fff;color:#1e293b;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.35)}' +
    '.arx-head{display:flex;align-items:center;gap:12px;padding:18px 20px;background:linear-gradient(135deg,#0f2d5c,#1d4ed8);color:#fff;border-radius:16px 16px 0 0}' +
    '.arx-head h3{margin:0;font-size:17px;font-weight:800}.arx-head p{margin:3px 0 0;font-size:11.5px;opacity:.85;line-height:1.4}.arx-ic{font-size:24px}.arx-x{margin-left:auto;border:0;background:rgba(255,255,255,.15);color:#fff;width:30px;height:30px;border-radius:8px;font-size:20px;cursor:pointer}' +
    '.arx-body{padding:18px 20px 20px;display:flex;flex-direction:column;gap:12px}.arx-lbl{font-size:12px;font-weight:700;color:#334155;margin-bottom:5px}.arx-lbl i{color:#dc2626;font-style:normal}' +
    '.arx-in{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:9px;padding:10px 12px;font-size:14px;background:#fff;color:#0f172a;outline:none}.arx-in:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}' +
    '.arx-cap{display:flex;gap:8px;align-items:center}.arx-cap canvas{border:1px solid #cbd5e1;border-radius:8px;background:#f1f5f9;flex:1;height:44px;min-width:0}.arx-ref{border:1px solid #cbd5e1;background:#fff;border-radius:8px;width:40px;height:44px;font-size:18px;cursor:pointer}' +
    '.arx-btn{border-radius:9px;padding:11px 14px;font-size:13px;font-weight:800;cursor:pointer;border:1px solid transparent}.arx-btn:disabled{opacity:.6;cursor:not-allowed}.arx-pri{background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff}.arx-sec{background:#fff;color:#1d4ed8;border-color:#93c5fd}' +
    '.arx-act{display:flex;gap:10px}.arx-act .arx-btn{flex:1}.arx-msg{border-radius:9px;padding:9px 12px;font-size:12.5px;line-height:1.45}.arx-msg[hidden]{display:none}.arx-msg.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}.arx-msg.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}.arx-msg.info{background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe}' +
    '.arx-otp{display:flex;gap:10px;justify-content:center}.arx-otp input{width:46px;height:50px;text-align:center;font-size:22px;font-weight:800;border:1.5px solid #cbd5e1;border-radius:10px;outline:none}.arx-otp input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15)}' +
    '.arx-stage{border-top:1px dashed #cbd5e1;padding-top:12px;display:flex;flex-direction:column;gap:10px}.arx-stage[hidden]{display:none}.arx-note{font-size:11.5px;color:#475569}' +
    '.arx-inline{margin-top:12px;padding:12px;border:1px solid #bfdbfe;background:#f8fbff;border-radius:12px;display:flex;flex-direction:column;gap:9px;color:#1e293b}.arx-inline-t{font-size:12px;font-weight:800;color:#0f2d5c}.arx-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}';
  function addCss() { if ($('arx-css')) return; var s = document.createElement('style'); s.id = 'arx-css'; s.textContent = css; document.head.appendChild(s); }

  /* \u2500\u2500\u2500\u2500\u2500 captcha \u2500\u2500\u2500\u2500\u2500 */
  var cap = '';
  function drawCaptcha() {
    var cv = $('arx-cv'); if (!cv) return;
    var w = cv.width = 220, h = cv.height = 44, c = cv.getContext('2d'), A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var buf = new Uint32Array(5); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(buf) : buf.forEach(function (_, i) { buf[i] = Math.random() * 4e9; });
    cap = Array.prototype.map.call(buf, function (n) { return A[n % A.length]; }).join('');
    c.clearRect(0, 0, w, h); c.fillStyle = '#eef2f8'; c.fillRect(0, 0, w, h);
    for (var i = 0; i < 6; i++) { c.strokeStyle = 'rgba(30,64,175,' + (0.15 + Math.random() * 0.25) + ')'; c.beginPath(); c.moveTo(Math.random() * w, Math.random() * h); c.lineTo(Math.random() * w, Math.random() * h); c.stroke(); }
    c.font = 'bold 24px monospace'; c.textBaseline = 'middle';
    cap.split('').forEach(function (ch, k) { c.save(); c.translate(18 + k * 38, h / 2 + (Math.random() * 8 - 4)); c.rotate((Math.random() - .5) * .5); c.fillStyle = '#12305e'; c.fillText(ch, 0, 0); c.restore(); });
    var i2 = $('arx-cap'); if (i2) i2.value = '';
  }

  /* \u2500\u2500\u2500\u2500\u2500 API \u2500\u2500\u2500\u2500\u2500 */
  function post(path, body) {
    if (window.API && typeof window.API.post === 'function') return window.API.post(path, body);
    var base = String(window.SHDL_API_BASE || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.API_BASE) || '/api').replace(/\/$/, '');
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || d.message || ('Request failed (' + r.status + ')')); return d; }); });
  }

  /* \u2500\u2500\u2500\u2500\u2500 modal \u2500\u2500\u2500\u2500\u2500 */
  var S = { scope: 'any', mode: 'password', sent: false, busy: false };
  function build() {
    if ($('arx-ov')) return;
    addCss();
    var ov = document.createElement('div'); ov.id = 'arx-ov'; ov.className = 'arx-ov'; ov.hidden = true; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.innerHTML = '<div class="arx-card"><div class="arx-head"><div class="arx-ic" id="arx-ic">\ud83d\udd10</div><div><h3 id="arx-t"></h3><p id="arx-d"></p></div><button type="button" class="arx-x" id="arx-close" aria-label="Close">\u00d7</button></div>' +
      '<form class="arx-body" id="arx-form" autocomplete="off" novalidate><div class="arx-msg" id="arx-msg" hidden></div>' +
      '<div id="arx-uwrap"><div class="arx-lbl">User ID <i>*</i></div><input class="arx-in" id="arx-uid" maxlength="80" placeholder="Your User ID"></div>' +
      '<div><div class="arx-lbl">State <i>*</i></div><select class="arx-in" id="arx-state"><option value="">Select State</option>' + STATES.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select></div>' +
      '<div><div class="arx-lbl">Mobile No. <i>*</i></div><input class="arx-in" id="arx-mob" type="tel" inputmode="numeric" maxlength="10" placeholder="10-digit registered mobile"></div>' +
      '<div><div class="arx-lbl">Email ID</div><input class="arx-in" id="arx-mail" type="email" maxlength="160" placeholder="you@example.com"></div>' +
      '<div><div class="arx-lbl">Security Captcha <i>*</i></div><div class="arx-cap"><canvas id="arx-cv" width="220" height="44"></canvas><button type="button" class="arx-ref" id="arx-rf" title="New captcha" aria-label="New captcha">\u21bb</button></div>' +
      '<input class="arx-in" id="arx-cap" maxlength="5" placeholder="Type the characters shown" style="margin-top:8px;text-transform:uppercase"></div>' +
      '<div class="arx-stage" id="arx-stage" hidden><div><div class="arx-lbl">Enter the 4-digit OTP</div><div id="arx-boxes"></div><div class="arx-note" id="arx-note" style="text-align:center;margin-top:8px"></div></div>' +
      '<div id="arx-pw"><div class="arx-lbl">New password <i>*</i></div><input class="arx-in" id="arx-p1" type="password" autocomplete="new-password" placeholder="At least 8 characters" maxlength="128">' +
      '<div class="arx-lbl" style="margin-top:8px">Confirm new password <i>*</i></div><input class="arx-in" id="arx-p2" type="password" autocomplete="new-password" placeholder="Repeat the new password" maxlength="128"></div></div>' +
      '<div class="arx-act"><button type="button" class="arx-btn arx-sec" id="arx-cancel">Cancel</button><button type="submit" class="arx-btn arx-pri" id="arx-go">Proceed</button></div></form></div>';
    document.body.appendChild(ov);
    var boxes = otpBoxes(4); $('arx-boxes').appendChild(boxes.el); S.boxes = boxes;
    $('arx-close').onclick = $('arx-cancel').onclick = close;
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !ov.hidden) close(); });
    $('arx-rf').onclick = drawCaptcha;
    $('arx-mob').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 10); });
    $('arx-form').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  }
  function say(t, k) { var m = $('arx-msg'); m.hidden = !t; m.className = 'arx-msg ' + (k || 'info'); m.textContent = t || ''; }
  function close() { var o = $('arx-ov'); if (o) o.hidden = true; document.body.style.overflow = ''; }
  function open(o) {
    o = o || {}; build();
    S.scope = BASES[o.scope] ? o.scope : 'any'; S.mode = o.mode === 'userid' ? 'userid' : 'password'; S.sent = false; S.busy = false;
    var pw = S.mode === 'password';
    $('arx-t').textContent = pw ? 'Forgot Password' : 'Forgot User ID';
    $('arx-d').textContent = pw ? 'Verify your registered details to get an OTP and set a new password.' : 'Verify your registered details \u2014 your User ID will be sent to your mobile.';
    $('arx-ic').textContent = pw ? '\ud83d\udd10' : '\ud83e\udeaa';
    $('arx-uwrap').hidden = !pw; $('arx-uid').value = o.userId || '';
    ['arx-mob', 'arx-mail'].forEach(function (id) { $(id).value = ''; }); $('arx-state').value = '';
    $('arx-stage').hidden = true; $('arx-p1').value = $('arx-p2').value = ''; S.boxes.clear();
    ['arx-uid', 'arx-state', 'arx-mob', 'arx-mail', 'arx-cap'].forEach(function (id) { $(id).disabled = false; });
    $('arx-go').textContent = pw ? 'Proceed' : 'Send User ID'; $('arx-go').disabled = false; say('');
    drawCaptcha(); $('arx-ov').hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(function () { $(pw && !o.userId ? 'arx-uid' : 'arx-state').focus(); }, 40);
  }
  function details() { return { user: $('arx-uid').value.trim(), state: $('arx-state').value, mobile: $('arx-mob').value.trim(), email: $('arx-mail').value.trim() }; }
  function submit() {
    if (S.busy) return;
    var d = details(), base = BASES[S.scope], btn = $('arx-go');
    var fail = function (t, id) { say(t, 'err'); if (id) $(id).focus(); };
    if (!S.sent) {
      if (S.mode === 'password' && !d.user) return fail('Please enter your User ID.', 'arx-uid');
      if (!d.state) return fail('Please select your State.', 'arx-state');
      if (!/^[6-9]\d{9}$/.test(d.mobile)) return fail('Enter the 10-digit registered mobile number.', 'arx-mob');
      if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return fail('Enter a valid email address.', 'arx-mail');
      if ($('arx-cap').value.trim().toUpperCase() !== cap) { drawCaptcha(); return fail('Captcha does not match. Please try the new one.', 'arx-cap'); }
      S.busy = true; btn.disabled = true; btn.textContent = 'Please wait\u2026'; say('');
      var body = { user: d.user, contact: d.mobile, mobile: d.mobile, email: d.email, state: d.state };
      post(S.mode === 'password' ? base + '/forgot-password' : base + '/forgot-username', body).then(function (r) {
        if (S.mode === 'userid') { say((r && r.message) || 'If the details match a registered account, the User ID has been sent to the registered mobile number.', 'ok'); btn.textContent = 'Done'; btn.disabled = true; return; }
        S.sent = true; $('arx-stage').hidden = false;
        ['arx-uid', 'arx-state', 'arx-mob', 'arx-mail', 'arx-cap'].forEach(function (id) { $(id).disabled = true; });
        say((r && r.message) || 'OTP sent to your registered mobile number.', 'ok');
        btn.textContent = 'Reset Password'; btn.disabled = false; S.boxes.clear(); S.boxes.focus();
        resendLink((r && r.resendInSec) || 60);
      }).catch(function (e) { drawCaptcha(); btn.disabled = false; btn.textContent = S.mode === 'password' ? 'Proceed' : 'Send User ID'; say(e && e.message || 'Request failed. Please try again.', 'err'); })
        .then(function () { S.busy = false; });
      return;
    }
    var code = S.boxes.value(), p1 = $('arx-p1').value, p2 = $('arx-p2').value;
    if (!/^\d{4}$/.test(code)) return fail('Enter the 4-digit OTP.');
    if (p1.length < 8) return fail('Use a password with at least 8 characters.', 'arx-p1');
    if (p1 !== p2) return fail('Passwords do not match.', 'arx-p2');
    S.busy = true; btn.disabled = true; btn.textContent = 'Resetting\u2026';
    post(base + '/reset-password', { user: d.user, contact: d.mobile, mobile: d.mobile, email: d.email, state: d.state, code: code, newPassword: p1 }).then(function (r) {
      say((r && r.message) || 'Password reset successful. Please sign in with your new password.', 'ok'); btn.textContent = 'Done';
      setTimeout(close, 1800);
    }).catch(function (e) { btn.disabled = false; btn.textContent = 'Reset Password'; S.boxes.clear(); S.boxes.focus(); say(e && e.message || 'Reset failed. Please try again.', 'err'); })
      .then(function () { S.busy = false; });
  }
  function resendLink(sec) {
    var note = $('arx-note'); if (!note) return;
    var left = sec, t = setInterval(function () {
      if (!S.sent || $('arx-ov').hidden) return clearInterval(t);
      if (left > 0) { note.textContent = 'Resend OTP in ' + left-- + 's'; return; }
      clearInterval(t); note.innerHTML = 'Did not get it? <a href="#" id="arx-resend" style="color:#1d4ed8;font-weight:700">Resend OTP</a>';
      $('arx-resend').onclick = function (e) {
        e.preventDefault(); var d = details(); note.textContent = 'Sending\u2026';
        post(BASES[S.scope] + '/forgot-password', { user: d.user, contact: d.mobile, mobile: d.mobile, email: d.email, state: d.state })
          .then(function (r) { say((r && r.message) || 'A new OTP has been sent.', 'ok'); resendLink((r && r.resendInSec) || 60); })
          .catch(function (er) { say(er && er.message || 'Could not resend.', 'err'); resendLink(15); });
      };
    }, 1000);
    note.textContent = 'Resend OTP in ' + left-- + 's';
  }

  window.AnmolRecovery = { open: open, close: close };
  // Any element with data-anmol-recovery="password|userid" (optional data-scope) opens the modal.
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-anmol-recovery]'); if (!el) return;
    e.preventDefault(); var u = $(el.getAttribute('data-user-field') || '');
    open({ mode: el.getAttribute('data-anmol-recovery'), scope: el.getAttribute('data-scope') || 'any', userId: u ? u.value : '' });
  });
})();
