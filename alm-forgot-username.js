/* Anmol LibMatrix - Forgot Username (Mobile -> OTP -> Success). No framework, no change to your login page.
 *   <button onclick="ALMForgotUsername.open({ path: '/agent/forgot-username' })">Forgot Username?</button>
 * path: '/agent/forgot-username'  (Agent)   '/material/forgot-user-id'  (Invoice)   '/auth/forgot-username'  (Super Admin / HRMS)
 * The Username is delivered ONLY to the registered WhatsApp number; it is never shown here and passwords are never involved. */
(function () {
  'use strict';
  var CSS = '.alf{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,20,40,.62);opacity:0;transition:opacity .2s}.alf.on{opacity:1}' +
    '.alf-c{width:100%;max-width:420px;background:#fff;color:#1d2733;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.35);font:15px/1.5 "Noto Sans","Segoe UI",system-ui,sans-serif;overflow:hidden;transform:translateY(10px);transition:transform .25s}.alf.on .alf-c{transform:none}.alf-c *{box-sizing:border-box}' +
    '.alf-h{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:#12315c;color:#fff;border-bottom:4px solid #d98a2b}.alf-h h2{margin:0;font-size:17px}.alf-x{background:none;border:0;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:0 4px}' +
    '.alf-b{padding:20px}.alf-p{display:none;animation:alf-in .3s}.alf-p.on{display:block}@keyframes alf-in{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}' +
    '.alf p{margin:0 0 12px;font-size:14px;color:#4b5a6b}.alf label{display:block;font-weight:600;font-size:13px;margin-bottom:4px}' +
    '.alf-in{width:100%;height:44px;padding:0 12px;border:1px solid #8796a8;border-radius:4px;font:inherit;font-size:16px;letter-spacing:.5px}.alf :focus-visible{outline:3px solid #f2b666;outline-offset:1px}' +
    '.alf-d{display:flex;gap:6px;justify-content:center;margin:6px 0 12px}.alf-d input{flex:1;min-width:0;max-width:44px;height:50px;padding:0;text-align:center;font:inherit;font-size:20px;font-weight:700;border:1px solid #8796a8;border-radius:5px;background:#f4f7fa}.alf-d input.f{border-color:#12315c;background:#fff}.alf-d.bad{animation:alf-s .3s}@keyframes alf-s{25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}' +
    '.alf-bar{height:3px;background:#e1e7ee;border-radius:2px;overflow:hidden}.alf-bar i{display:block;height:100%;background:#d98a2b;transform-origin:left;transition:transform 1s linear}.alf-r{display:flex;justify-content:space-between;align-items:center;margin:6px 0 4px;font-size:13px;color:#4b5a6b}' +
    '.alf-l{background:none;border:0;padding:6px 0;font:inherit;font-size:13px;color:#12315c;text-decoration:underline;cursor:pointer}.alf-l:disabled{color:#5b6a7a;text-decoration:none;cursor:default}' +
    '.alf-btn{width:100%;height:44px;margin-top:10px;border:0;border-radius:4px;background:#12315c;color:#fff;font:600 15px/1 inherit;font-family:inherit;cursor:pointer}.alf-btn:disabled{opacity:.6;cursor:wait}' +
    '.alf-e{display:none;margin:0 0 10px;padding:9px 12px;border:1px solid #e3a9a5;background:#fdf1f0;color:#a8201a;border-radius:4px;font-size:13px}.alf-e.on{display:block}' +
    '.alf-ok{text-align:center}.alf-ok svg{width:56px;height:56px;margin:4px auto 10px;display:block}.alf-ok h3{margin:0 0 6px;font-size:17px;color:#14532d}@media(prefers-reduced-motion:reduce){.alf,.alf-c,.alf-p,.alf-bar i{transition:none;animation:none}}';
  var cur = null;

  function open(opt) {
    close(true); opt = opt || {};
    var api = (opt.api || window.API_BASE || '/api').replace(/\/$/, ''), base = api + (opt.path || '/auth/forgot-username'), prevFocus = document.activeElement;
    if (!document.getElementById('alf-css')) { var s = document.createElement('style'); s.id = 'alf-css'; s.textContent = CSS; document.head.appendChild(s); }
    var h = document.createElement('div'); h.className = 'alf'; h.setAttribute('role', 'dialog'); h.setAttribute('aria-modal', 'true'); h.setAttribute('aria-labelledby', 'alf-t');
    h.innerHTML = '<div class="alf-c"><div class="alf-h"><h2 id="alf-t">Recover Username</h2><button type="button" class="alf-x" aria-label="Close">&times;</button></div><div class="alf-b">' +
      '<div class="alf-p on" data-s="1"><p>Enter your registered mobile number. We will send a one-time password on WhatsApp.</p><div class="alf-e" role="alert"></div><label for="alf-m">Registered mobile number</label>' +
      '<input class="alf-in" id="alf-m" type="tel" inputmode="numeric" maxlength="10" autocomplete="tel-national" placeholder="10-digit mobile number"><button type="button" class="alf-btn" data-a="go">Proceed</button></div>' +
      '<div class="alf-p" data-s="2"><p class="alf-om"></p><div class="alf-e" role="alert"></div><div class="alf-d" aria-label="One-time password"></div><div class="alf-bar" aria-hidden="true"><i></i></div>' +
      '<div class="alf-r"><span class="alf-c2"></span><button type="button" class="alf-l" data-a="rs" disabled>Resend OTP</button></div><button type="button" class="alf-btn" data-a="vf">Verify OTP</button>' +
      '<button type="button" class="alf-l" data-a="bk">Change mobile number</button></div>' +
      '<div class="alf-p alf-ok" data-s="3"><svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="26" fill="#e6f4ea" stroke="#14532d" stroke-width="2"/><path d="M16 29l8 8 16-17" fill="none" stroke="#14532d" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<h3>Username sent</h3><p class="alf-sm" role="status"></p><p>For your security, your password is never sent. Use &ldquo;Forgot Password&rdquo; if you also need to reset it.</p><button type="button" class="alf-btn" data-a="x">Back to sign in</button></div></div></div>';
    document.body.appendChild(h); requestAnimationFrame(function () { h.classList.add('on'); });
    var q = function (x) { return h.querySelector(x); }, ch = null, cells = [], total = 60, timer = null, busyOn = false;
    cur = { h: h, prev: prevFocus, stop: function () { clearTimeout(timer); } };

    function show(n) { [].forEach.call(h.querySelectorAll('.alf-p'), function (p) { p.classList.toggle('on', p.getAttribute('data-s') === String(n)); }); var f = h.querySelector('.alf-p.on input, .alf-p.on button[data-a]'); if (f) setTimeout(function () { f.focus(); }, 60); }
    function err(step, m) { var e = h.querySelector('[data-s="' + step + '"] .alf-e'); if (e) { e.textContent = m || ''; e.classList.toggle('on', !!m); } }
    function post(path, data) {
      return fetch(base + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || j.success === false) { var e = new Error(j.error || j.message || 'Request failed. Please try again.'); e.code = j.code; e.data = j; throw e; } return j; }); });
    }
    function busy(btn, on, txt) { busyOn = on; btn.disabled = on; if (on) { btn.dataset.t = btn.textContent; btn.textContent = txt; } else if (btn.dataset.t) btn.textContent = btn.dataset.t; }
    function tick(s) {
      clearTimeout(timer); var bar = q('.alf-bar i'), rs = q('[data-a=rs]'), clock = q('.alf-c2'), left = s; total = Math.max(s, 1);
      bar.style.transition = 'none'; bar.style.transform = 'scaleX(1)'; void bar.offsetWidth; bar.style.transition = '';
      (function t() { bar.style.transform = 'scaleX(' + (Math.max(left - 1, 0) / total) + ')'; rs.disabled = left > 0; clock.textContent = left > 0 ? 'Resend OTP in ' + left + ' seconds' : 'You can request a new OTP'; if (left-- > 0) timer = setTimeout(t, 1000); })();
    }
    function buildBoxes(n) {
      var row = q('.alf-d'); row.innerHTML = ''; cells = [];
      for (var i = 0; i < n; i++) (function (i) {
        var c = document.createElement('input'); c.type = 'text'; c.inputMode = 'numeric'; c.maxLength = 1; c.autocomplete = i ? 'off' : 'one-time-code'; c.setAttribute('aria-label', 'OTP digit ' + (i + 1) + ' of ' + n);
        c.oninput = function () { c.value = c.value.replace(/\D/g, '').slice(-1); c.classList.toggle('f', !!c.value); if (c.value && cells[i + 1]) cells[i + 1].focus(); };
        c.onkeydown = function (e) { if (e.key === 'Backspace' && !c.value && cells[i - 1]) cells[i - 1].focus(); if (e.key === 'Enter') verify(); };
        c.onpaste = function (e) { var d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, n); if (!d) return; e.preventDefault(); cells.forEach(function (x, k) { x.value = d[k] || ''; x.classList.toggle('f', !!x.value); }); cells[Math.min(d.length, n - 1)].focus(); };
        row.appendChild(c); cells.push(c);
      })(i);
    }
    function go() {
      var m = q('#alf-m').value.replace(/\D/g, ''), b = q('[data-a=go]'); err(1, '');
      if (m.length !== 10) return err(1, 'Enter a valid 10-digit mobile number.');
      busy(b, true, 'Sending OTP…');
      post('', { mobile: m }).then(function (r) {
        busy(b, false); ch = r; buildBoxes(r.otpLength || 8);
        q('.alf-om').textContent = 'Enter the ' + (r.otpLength || 8) + '-digit OTP sent on WhatsApp to the number ending ' + String(r.maskedMobile || '').slice(-4) + '.';
        show(2); tick(r.resendInSec || 60);
      }).catch(function (e) { busy(b, false); err(1, e.message); });
    }
    function verify() {
      if (busyOn) return; var otp = cells.map(function (c) { return c.value; }).join(''), b = q('[data-a=vf]'); err(2, '');
      if (otp.length !== cells.length) return err(2, 'Enter all ' + cells.length + ' digits of your OTP.');
      busy(b, true, 'Verifying…');
      post('/verify', { challengeId: ch.challengeId, otp: otp }).then(function (r) {
        busy(b, false); clearTimeout(timer); q('.alf-sm').textContent = r.message || 'Your Username has been sent to your registered WhatsApp number.'; q('#alf-t').textContent = 'Username Recovery'; show(3);
      }).catch(function (e) {
        busy(b, false); err(2, e.message); var row = q('.alf-d'); row.classList.remove('bad'); void row.offsetWidth; row.classList.add('bad');
        if (/LOCKED/.test(e.code || '')) { setTimeout(function () { show(1); }, 1800); } else { cells.forEach(function (c) { c.value = ''; c.classList.remove('f'); }); if (cells[0]) cells[0].focus(); }
      });
    }
    h.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (e.target === h || e.target.classList.contains('alf-x') || a === 'x') return close();
      if (a === 'go') go(); else if (a === 'vf') verify(); else if (a === 'bk') { clearTimeout(timer); err(2, ''); show(1); }
      else if (a === 'rs') { err(2, ''); post('/resend', { challengeId: ch.challengeId }).then(function (r) { tick(r.resendInSec || 60); }).catch(function (x) { err(2, x.message); if (x.data && x.data.resendInSec) tick(x.data.resendInSec); }); }
    });
    q('#alf-m').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    q('#alf-m').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 10); });
    document.addEventListener('keydown', cur.esc = function (e) { if (e.key === 'Escape') close(); });
    setTimeout(function () { q('#alf-m').focus(); }, 80);
  }
  function close(now) {
    if (!cur) return; var c = cur; cur = null; c.stop(); document.removeEventListener('keydown', c.esc);
    var done = function () { c.h.parentNode && c.h.parentNode.removeChild(c.h); if (c.prev && c.prev.focus) c.prev.focus(); };
    if (now) return done(); c.h.classList.remove('on'); setTimeout(done, 220);
  }
  window.ALMForgotUsername = { open: open, close: close };
})();
