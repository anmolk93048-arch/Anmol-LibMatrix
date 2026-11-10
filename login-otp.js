/* Anmol LibMatrix — unified login OTP step (Agent_Login · HRMS_login · INVOICE_LOGIN).
 *
 *  Place next to config.js / anmol-recovery.js (site root) and inject it from route-mask.js.
 *
 *  var otp = AnmolLoginOtp.attach({
 *    anchor : element | selector,        // the OTP block is inserted directly AFTER this element (last field: captcha)
 *    length : 6,                         // number of digit boxes — must equal the length the server issues
 *    path   : '/auth',                   // API base → POST <path>/login-otp/send  and  <path>/login-otp/verify
 *    accent : '#c9a227',                 // optional focus / link colour
 *    payload: function () { return {…}; },   // SAME body the page already posts to its login route (server re-checks it)
 *    watch  : [inputEl, …],              // editing any of these after the OTP was sent resets the step
 *    onComplete: fn,                     // fired once when the last digit is typed/pasted (usually = the login handler)
 *    onError: fn(message),               // where a failed FIRST send is shown (page's own error box)
 *    onBusy : fn(true|false)             // optional: spinner on the page's Login button
 *  });
 *
 *  otp.gate(function (otpToken) { …existing login call… });
 *      1st call → sends the OTP, shows the top banner + the boxes + resend timer
 *      later    → verifies the typed code, then runs the callback with the server's otpToken
 *  otp.reset();   call when a login attempt fails / captcha is regenerated.
 *
 *  Nothing here is trusted: the server must verify the code and the otpToken.
 */
(function () {
  'use strict';
  if (window.AnmolLoginOtp) return;

  /* ───────── styles (scoped, theme-agnostic: colours derive from the surrounding text colour) ───────── */
  var CSS =
    '.lotp-banner{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);left:50%;z-index:2147483001;max-width:calc(100vw - 24px);box-sizing:border-box;padding:9px 16px;border-radius:999px;background:#0f5132;color:#fff;font:600 13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;box-shadow:0 6px 22px rgba(0,0,0,.28);opacity:0;transform:translate(-50%,-160%);transition:transform .28s ease,opacity .28s ease;pointer-events:none}' +
    '.lotp-banner.show{opacity:1;transform:translate(-50%,0)}.lotp-banner.err{background:#7f1d1d}' +
    '.lotp{margin-top:12px;color:inherit;font-family:inherit;text-align:left}.lotp[hidden]{display:none!important}' +
    '.lotp-title{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.8;margin-bottom:4px}' +
    '.lotp-sub{font-size:12px;line-height:1.4;opacity:.75;margin-bottom:8px}.lotp-sub:empty{display:none}' +
    '.lotp-boxes{display:grid;grid-template-columns:repeat(var(--n,6),minmax(0,1fr));gap:8px}' +
    '.lotp-boxes input{width:100%;min-width:0;height:46px;box-sizing:border-box;margin:0;padding:0;text-align:center;font-family:ui-monospace,Consolas,monospace;font-size:20px;font-weight:700;line-height:1;color:inherit;' +
      'background:color-mix(in srgb,currentColor 7%,transparent);border:1.5px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:9px;outline:none;caret-color:var(--lotp-accent,#1d4ed8);transition:border-color .15s,box-shadow .15s}' +
    '.lotp-boxes input:focus{border-color:var(--lotp-accent,#1d4ed8);box-shadow:0 0 0 3px color-mix(in srgb,var(--lotp-accent,#1d4ed8) 25%,transparent)}' +
    '.lotp.bad .lotp-boxes input{border-color:#dc2626;animation:lotp-shake .3s}' +
    '.lotp-msg{margin-top:8px;padding:7px 10px;border-radius:8px;border-left:3px solid var(--lotp-accent,#1d4ed8);background:color-mix(in srgb,currentColor 8%,transparent);font-size:12px;line-height:1.4}' +
    '.lotp-msg.err{border-left-color:#dc2626;background:rgba(220,38,38,.14)}.lotp-msg[hidden]{display:none}' +
    '.lotp-foot{display:flex;justify-content:flex-end;margin-top:8px}' +
    '.lotp-resend{background:none;border:0;padding:4px 0;font-family:inherit;font-size:12px;font-weight:600;color:var(--lotp-accent,#1d4ed8);text-decoration:underline;cursor:pointer}' +
    '.lotp-resend:disabled{color:inherit;opacity:.7;text-decoration:none;cursor:default}' +
    '@keyframes lotp-shake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}' +
    '@media (prefers-reduced-motion:reduce){.lotp-banner{transition:none}.lotp.bad .lotp-boxes input{animation:none}}';

  function ensureStyle() {
    if (document.getElementById('lotp-css')) return;
    var s = document.createElement('style'); s.id = 'lotp-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  /* ───────── top banner (shared; auto-hides) ───────── */
  var bannerEl, bannerT;
  function ensureBanner() {
    if (bannerEl) return;
    bannerEl = el('div', 'lotp-banner'); bannerEl.setAttribute('role', 'status'); bannerEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(bannerEl);
  }
  function banner(text, kind, ms) {
    ensureStyle(); ensureBanner();
    bannerEl.textContent = text;
    bannerEl.classList.toggle('err', kind === 'err');
    void bannerEl.offsetWidth;                      // restart the transition if it is already showing
    bannerEl.classList.add('show');
    clearTimeout(bannerT);
    bannerT = setTimeout(function () { bannerEl.classList.remove('show'); }, ms || 3000);
  }

  /* ───────── API (same base resolution as anmol-recovery.js; keeps resendInSec from 429s) ───────── */
  function apiBase() { return String(window.SHDL_API_BASE || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.API_BASE) || '/api').replace(/\/$/, ''); }
  function post(path, body) {
    return fetch(apiBase() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) { var e = new Error(d.error || d.message || ('Request failed (' + r.status + ')')); e.status = r.status; e.resendInSec = d.resendInSec; throw e; }
          return d;
        });
      });
  }

  /* ───────── component ───────── */
  function attach(opts) {
    var o = Object.assign({ length: 6, seconds: 60, path: '/auth', accent: '', title: 'Enter the OTP', payload: function () { return {}; } }, opts || {});
    var anchor = typeof o.anchor === 'string' ? document.querySelector(o.anchor) : o.anchor;
    if (!anchor || !anchor.parentNode) throw new Error('AnmolLoginOtp: anchor element not found');
    ensureStyle(); ensureBanner();

    var N = Math.max(4, Math.min(8, o.length | 0));
    var api = o.post || post;

    var root = el('div', 'lotp'); root.hidden = true;
    root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'One-time password');
    root.style.setProperty('--n', N);
    if (o.accent) root.style.setProperty('--lotp-accent', o.accent);
    var title = el('div', 'lotp-title'); title.textContent = o.title;
    var sub = el('div', 'lotp-sub');
    var boxes = el('div', 'lotp-boxes');
    var msg = el('div', 'lotp-msg'); msg.hidden = true; msg.setAttribute('role', 'alert');
    var foot = el('div', 'lotp-foot');
    var resend = el('button', 'lotp-resend'); resend.type = 'button'; resend.disabled = true;
    foot.appendChild(resend);
    [title, sub, boxes, msg, foot].forEach(function (n) { root.appendChild(n); });

    var inputs = [];
    for (var i = 0; i < N; i++) {
      var inp = el('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = i ? 'off' : 'one-time-code';
      inp.setAttribute('aria-label', 'OTP digit ' + (i + 1) + ' of ' + N); inp.setAttribute('autocapitalize', 'off'); inp.spellcheck = false;
      boxes.appendChild(inp); inputs.push(inp);
    }
    anchor.parentNode.insertBefore(root, anchor.nextSibling);

    var sent = false, token = null, busy = false, fired = false, endAt = 0, tid = 0;

    function value() { return inputs.map(function (x) { return x.value; }).join(''); }
    function clearBoxes() { inputs.forEach(function (x) { x.value = ''; }); fired = false; }
    function focusEmpty() { var t = inputs.filter(function (x) { return !x.value; })[0] || inputs[N - 1]; t.focus(); }
    function say(text, kind) { msg.hidden = !text; msg.className = 'lotp-msg' + (kind === 'err' ? ' err' : ''); msg.textContent = text || ''; }
    function setBusy(b) { busy = b; if (o.onBusy) o.onBusy(b); }
    function show() { root.hidden = false; if (root.scrollIntoView) root.scrollIntoView({ block: 'nearest' }); }

    // digits entered / pasted / SMS-autofilled (iOS & Android put the whole code into box 1)
    function fill(from, digits) {
      for (var k = 0; k < digits.length && from + k < N; k++) inputs[from + k].value = digits[k];
      inputs[Math.min(from + digits.length, N - 1)].focus();
      if (value().length < N) { fired = false; return; }
      if (!fired) { fired = true; if (o.onComplete) o.onComplete(); }
    }
    inputs.forEach(function (inp, i) {
      inp.addEventListener('input', function () {
        var d = inp.value.replace(/\D/g, ''); inp.value = '';
        if (d) fill(i, d); else fired = false;
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !inp.value && i) { inputs[i - 1].value = ''; inputs[i - 1].focus(); fired = false; e.preventDefault(); }
        else if (e.key === 'ArrowLeft' && i) { inputs[i - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowRight' && i < N - 1) { inputs[i + 1].focus(); e.preventDefault(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (o.onComplete) o.onComplete(); }
      });
      inp.addEventListener('focus', function () { inp.select(); });
      inp.addEventListener('paste', function (e) {
        var d = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
        if (!d) return; e.preventDefault(); fill(d.length >= N ? 0 : i, d.slice(0, N));
      });
    });

    // "Resend OTP in 42 seconds" — based on an end timestamp, so background-tab throttling cannot drift it
    function tick() {
      var left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      if (left > 0) { resend.disabled = true; resend.textContent = 'Resend OTP in ' + left + ' second' + (left === 1 ? '' : 's'); }
      else { clearInterval(tid); resend.disabled = false; resend.textContent = 'Resend OTP'; }
    }
    function startTimer(sec) { endAt = Date.now() + Math.max(1, sec | 0) * 1000; clearInterval(tid); tick(); tid = setInterval(tick, 250); }

    function send() {
      if (busy) return Promise.resolve();
      setBusy(true); resend.disabled = true; say(sent ? 'Sending a new OTP…' : '', 'info');
      return api(o.path + '/login-otp/send', o.payload()).then(function (r) {
        if (r && r.skipped) { sent = true; token = r.otpToken || true; return 'skipped'; }   // OTP switched off / trusted device → no OTP step
        var first = !sent; sent = true; token = null; clearBoxes(); say('');
        sub.textContent = (r && r.message) || '';
        show(); focusEmpty(); startTimer((r && r.resendInSec) || o.seconds);
        banner('OTP sent successfully');
        return first;
      }).catch(function (e) {
        var text = (e && e.message) || 'Could not send the OTP. Please try again.';
        if (sent) { say(text, 'err'); startTimer((e && e.resendInSec) || 15); }
        else if (o.onError) o.onError(text); else banner(text, 'err', 4500);
      }).then(function (v) { setBusy(false); return v; });
    }

    function verify() {
      var code = value();
      if (code.length < N) { say('Enter the complete ' + N + '-digit OTP.', 'err'); focusEmpty(); return Promise.reject(new Error('incomplete')); }
      setBusy(true); say('');
      var body = Object.assign({}, o.payload(), { code: code });
      return api(o.path + '/login-otp/verify', body).then(function (r) {
        token = (r && r.otpToken) || true; return token;
      }).catch(function (e) {
        clearBoxes(); root.classList.add('bad'); setTimeout(function () { root.classList.remove('bad'); }, 400);
        say((e && e.message) || 'Invalid or expired OTP.', 'err'); inputs[0].focus(); throw e;
      }).then(function (t) { setBusy(false); return t; }, function (e) { setBusy(false); throw e; });
    }

    function gate(next) {
      if (busy) return;
      if (token) return next(token === true ? undefined : token);
      if (!sent) return send().then(function (v) { if (v === 'skipped') next(token === true ? undefined : token); });
      return verify().then(function (t) { next(t === true ? undefined : t); }, function () { /* message already shown */ });
    }

    function reset() {
      clearInterval(tid); sent = false; token = null; busy = false; clearBoxes(); say(''); sub.textContent = '';
      resend.disabled = true; root.hidden = true;
    }

    resend.addEventListener('click', function () { if (!resend.disabled) send(); });
    (o.watch || []).forEach(function (w) { if (w) w.addEventListener('input', function () { if (sent) reset(); }); });

    return { gate: gate, send: send, verify: verify, reset: reset, isSent: function () { return sent; }, el: root };
  }

  window.AnmolLoginOtp = { attach: attach, banner: banner };
})();
