/* Anmol LibMatrix — official portal shell + shared helpers (announcement ticker, OTP countdown, silent authentication). */
(function () {
  var CFG = window.ANMOL_CONFIG || {};
  var API = window.SHDL_API_BASE || CFG.API_BASE || '';
  var PAGE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  var SHOW = {
    'admin_login.html': function () { return vis('#admin-login'); },
    'agent_login.html': function () { return vis('#login-screen'); },
    'hrms_login.html': function () { return vis('#login-screen'); },
    'pfms_login.html': function () { return vis('#login-screen'); },
    'student_attendance.html': function () { var s = document.getElementById('s-login'); return !!(s && s.classList.contains('active')); },
    'super_admin_dashboard.html': function () { return vis('#sa-boot') || vis('#login-screen'); },
    'invoice_login.html': function () { return vis('#loginGate'); }
  };
  var ZOOM_SEL = { 'super_admin_dashboard.html': '#sa-boot', 'admin_login.html': '#admin-login > *', 'agent_login.html': '#login-screen > *', 'hrms_login.html': '#login-screen > *', 'pfms_login.html': '#login-screen > *', 'student_attendance.html': '#s-login', 'invoice_login.html': '#loginGate' };
  function vis(sel) { var e = document.querySelector(sel); return !!(e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null || (e && getComputedStyle(e).position === 'fixed' && getComputedStyle(e).display !== 'none')); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ───────── OTP countdown helper ───────── */
  window.AnmolOtp = {
    /* start({button, note, seconds, resendLabel, onExpire}) — disables the button while counting down. */
    start: function (o) {
      var secs = o.seconds || 60, btn = o.button, note = o.note, label = o.resendLabel || 'Resend OTP';
      if (btn && btn.__otpTimer) clearInterval(btn.__otpTimer);
      var left = secs;
      function paint() {
        if (btn) { btn.disabled = true; btn.textContent = 'Resend OTP in ' + left + 's'; }
        if (note) { note.className = (note.className || '').replace(/\bexp\b/, '').trim(); note.textContent = 'OTP is valid for ' + left + 's'; }
      }
      paint();
      var t = setInterval(function () {
        left--;
        if (left <= 0) {
          clearInterval(t); if (btn) { btn.__otpTimer = null; btn.disabled = false; btn.textContent = label; }
          if (note) { note.className += ' exp'; note.textContent = 'OTP has expired. Please request a new OTP.'; }
          if (o.onExpire) o.onExpire();
        } else paint();
      }, 1000);
      if (btn) btn.__otpTimer = t;
      return { stop: function () { clearInterval(t); } };
    }
  };

  /* ───────── Silent authentication button helper ───────── */
  window.AnmolAuthUI = {
    busy: function (btn, on, text) {
      if (!btn) return;
      if (on) { if (btn.__orig === undefined) btn.__orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="gov-spin"></span>' + (text || 'Authenticating...'); }
      else { btn.disabled = false; if (btn.__orig !== undefined) { btn.innerHTML = btn.__orig; btn.__orig = undefined; } }
    },
    success: function (btn) { if (btn) { btn.disabled = true; btn.innerHTML = 'Login Successful! Redirecting...'; } }
  };


  /* ───────── Shared credential recovery (OTP over SMS) ───────── */
  window.AnmolRecovery = {
    open: function (opt) {
      opt = opt || {};
      var scope = opt.scope === 'material' ? '/material' : (opt.scope === 'agent' ? '/agent' : '/auth');
      var mode = opt.mode === 'userid' ? 'userid' : 'password';
      var old = document.getElementById('gov-rec'); if (old) old.remove();
      var el = document.createElement('div'); el.id = 'gov-rec'; el.className = 'gov-rec-back';
      el.innerHTML = '<div class="gov-rec" role="dialog" aria-modal="true" aria-label="Account recovery">' +
        '<button type="button" class="x" aria-label="Close">&times;</button>' +
        '<h3>' + (mode === 'userid' ? 'Recover User ID' : 'Password Recovery') + '</h3>' +
        '<div id="gr-s1">' +
          (mode === 'userid' ? '' : '<label>User ID</label><input id="gr-user" type="text" autocomplete="username" placeholder="Enter your User ID" value="' + esc(opt.userId || '') + '">') +
          '<label>Registered mobile number or email</label><input id="gr-contact" type="text" autocomplete="tel" placeholder="Registered mobile number or email">' +
          '<button type="button" class="go" id="gr-send">' + (mode === 'userid' ? 'Send User ID' : 'Send OTP') + '</button>' +
        '</div>' +
        '<div id="gr-s2" style="display:none">' +
          '<label>4-digit OTP</label><input id="gr-otp" type="text" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="Enter the OTP">' +
          '<div class="gov-otp-note" id="gr-note"></div>' +
          '<label>New password</label><input id="gr-p1" type="password" autocomplete="new-password" placeholder="New password">' +
          '<label>Confirm new password</label><input id="gr-p2" type="password" autocomplete="new-password" placeholder="Confirm new password">' +
          '<button type="button" class="go" id="gr-reset">Reset Password</button>' +
          '<button type="button" class="ln" id="gr-resend">Resend OTP</button>' +
        '</div>' +
        '<div class="msg" id="gr-msg" role="alert"></div></div>';
      document.body.appendChild(el);
      var $ = function (id) { return document.getElementById(id); };
      var msg = function (t, ok) { var m = $('gr-msg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); };
      var close = function () { el.remove(); };
      el.querySelector('.x').onclick = close; el.addEventListener('mousedown', function (e) { if (e.target === el) close(); });
      var post = function (path, body) {
        return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Unable to complete the request. Please try again.'); return d; }); });
      };
      var send = function (isResend) {
        var user = $('gr-user') ? $('gr-user').value.trim() : '', contact = $('gr-contact').value.trim();
        if (mode !== 'userid' && !user) { msg('Please enter your valid User ID.'); return; }
        if (!contact) { msg('Please provide your registered email or phone number to recover access.'); return; }
        var btn = isResend ? $('gr-resend') : $('gr-send'); window.AnmolAuthUI.busy(btn, true, 'Sending...'); msg('');
        post(mode === 'userid' ? scope + (scope === '/material' ? '/forgot-user-id' : '/forgot-username') : scope + '/forgot-password', { user: user, userId: user, contact: contact })
          .then(function (d) {
            window.AnmolAuthUI.busy(btn, false);
            if (mode === 'userid') { msg(d.message || 'If the details match a registered account, the User ID has been sent to the registered mobile number.', true); return; }
            $('gr-s1').style.display = 'none'; $('gr-s2').style.display = 'block'; $('gr-otp').value = ''; $('gr-otp').focus();
            msg(d.message || 'A 4-digit OTP has been sent to your registered mobile number.', true);
            window.AnmolOtp.start({ button: $('gr-resend'), note: $('gr-note'), seconds: d.resendInSec || 60, onExpire: function () { msg('OTP has expired. Please request a new OTP.'); } });
          }).catch(function (e) {
            window.AnmolAuthUI.busy(btn, false);
            if (e.message && /wait before requesting/i.test(e.message)) { $('gr-s1').style.display = 'none'; $('gr-s2').style.display = 'block'; }
            msg(e.message || 'Unable to send the OTP right now. Please try again.');
          });
      };
      $('gr-send').onclick = function () { send(false); };
      $('gr-resend').onclick = function () { send(true); };
      $('gr-reset').onclick = function () {
        var user = $('gr-user') ? $('gr-user').value.trim() : '', contact = $('gr-contact').value.trim(), otp = $('gr-otp').value.trim(), p1 = $('gr-p1').value, p2 = $('gr-p2').value;
        if (!/^\d{4}$/.test(otp)) { msg('Invalid or expired OTP. Please try again.'); return; }
        if (!p1 || !p2 || p1 !== p2) { msg('Passwords do not match or fields are empty.'); return; }
        var btn = $('gr-reset'); window.AnmolAuthUI.busy(btn, true, 'Updating...'); msg('');
        post(scope + '/reset-password', { user: user, userId: user, contact: contact, code: otp, newPassword: p1 })
          .then(function (d) { window.AnmolAuthUI.busy(btn, false); msg(d.message || 'Password reset successful. Please sign in with your new password.', true); $('gr-reset').style.display = 'none'; $('gr-resend').style.display = 'none'; setTimeout(close, 2200); })
          .catch(function (e) { window.AnmolAuthUI.busy(btn, false); msg(e.message || 'Invalid or expired OTP. Please try again.'); });
      };
      setTimeout(function () { var f = $('gr-user') || $('gr-contact'); if (f) f.focus(); }, 30);
    }
  };

  function build() {
    if (!SHOW[PAGE] || document.getElementById('gov-top')) return;
    var top = document.createElement('div');
    top.id = 'gov-top'; top.className = 'gov-shell gov-fixed-top';
    top.innerHTML =
      '<div class="gov-a11y" role="navigation" aria-label="Accessibility tools">' +
        '<button type="button" id="gov-sr">Screen Reader Access</button><span class="sep">|</span>' +
        '<a href="#gov-main" id="gov-skip">Skip to Main Content</a><span class="sep">|</span>' +
        '<button type="button" id="gov-contrast" aria-pressed="false">Contrast Mode</button><span class="sep">|</span>' +
        '<span class="fs" aria-label="Font size"><button type="button" id="gov-fs-" aria-label="Decrease font size">A-</button> <button type="button" id="gov-fs0" aria-label="Reset font size">A</button> <button type="button" id="gov-fs+" aria-label="Increase font size">A+</button></span>' +
        '<span class="sep">|</span><button type="button" id="gov-lang" aria-label="Language">English / हिंदी</button>' +
      '</div>' +
      '<div class="gov-header">' +
        '<div class="gov-brand"><img src="anmol_libmatrix_logo.png" alt="Anmol LibMatrix logo"><div><div class="t1">Anmol LibMatrix Private Limited</div><div class="t2">Smart Digital Library Portal</div></div></div>' +
        '<div class="gov-title"><div class="h" id="gov-h">Anmol LibMatrix – Smart Library Management Ecosystem</div><div class="s" id="gov-s">अनमोल लाइब्रेरी मैट्रिक्स - डिजिटल प्रबंधन पोर्टल</div><div class="code">ANMOL-LIB-SYS</div></div>' +
      '</div>' +
      '<div class="gov-ticker" id="gov-ticker" style="display:none"><div class="lbl">Announcements</div><div class="vp"><div class="trk" id="gov-trk"></div></div></div>';
    var foot = document.createElement('div');
    foot.id = 'gov-foot'; foot.className = 'gov-shell gov-footer';
    foot.innerHTML = 'Website content is owned &amp; managed by <b>Anmol LibMatrix Pvt. Ltd.</b> Designed, developed &amp; hosted by <b>Anmol LibMatrix Team</b>. &copy; <span id="gov-yr"></span>';
    document.body.insertBefore(top, document.body.firstChild);
    document.body.appendChild(foot);
    document.getElementById('gov-yr').textContent = new Date().getFullYear();
    var first = document.querySelector(ZOOM_SEL[PAGE] || 'body');
    if (first && !document.getElementById('gov-main')) { var tgt = document.querySelector((ZOOM_SEL[PAGE] || '').split(' ')[0]) || first; tgt.setAttribute('id', tgt.id || 'gov-main'); document.getElementById('gov-skip').setAttribute('href', '#' + tgt.id); tgt.setAttribute('tabindex', '-1'); }
    wire();
    layout();
    loadTicker();
    setInterval(loadTicker, 60000);
  }

  var fs = 100, contrast = false, hindi = false;
  function applyFs() {
    document.documentElement.style.fontSize = fs + '%';
    var sel = ZOOM_SEL[PAGE];
    if (sel) Array.prototype.forEach.call(document.querySelectorAll(sel), function (e) { e.style.zoom = (fs / 100); });
    store('gov_fs', String(fs));
  }
  function applyLang() {
    var h = document.getElementById('gov-h'), s = document.getElementById('gov-s');
    if (hindi) { h.textContent = 'अनमोल लाइब्रेरी मैट्रिक्स - डिजिटल प्रबंधन पोर्टल'; s.textContent = 'Anmol LibMatrix – Smart Library Management Ecosystem'; document.documentElement.lang = 'hi'; }
    else { h.textContent = 'Anmol LibMatrix – Smart Library Management Ecosystem'; s.textContent = 'अनमोल लाइब्रेरी मैट्रिक्स - डिजिटल प्रबंधन पोर्टल'; document.documentElement.lang = 'en'; }
  }
  function wire() {
    var $ = function (id) { return document.getElementById(id); };
    fs = parseInt(store('gov_fs'), 10) || 100; contrast = store('gov_contrast') === '1';
    if (contrast) document.documentElement.classList.add('gov-contrast');
    $('gov-contrast').setAttribute('aria-pressed', contrast ? 'true' : 'false');
    $('gov-fs+').onclick = function () { fs = Math.min(fs + 10, 130); applyFs(); layout(); };
    $('gov-fs-').onclick = function () { fs = Math.max(fs - 10, 80); applyFs(); layout(); };
    $('gov-fs0').onclick = function () { fs = 100; applyFs(); layout(); };
    $('gov-contrast').onclick = function () { contrast = !contrast; document.documentElement.classList.toggle('gov-contrast', contrast); this.setAttribute('aria-pressed', contrast); store('gov_contrast', contrast ? '1' : '0'); };
    $('gov-lang').onclick = function () { hindi = !hindi; applyLang(); };
    $('gov-sr').onclick = function () {
      try {
        if (!('speechSynthesis' in window)) { alert('Screen reader support is not available in this browser.'); return; }
        window.speechSynthesis.cancel();
        var txt = $('gov-h').textContent + '. ' + (document.querySelector('h1,h2,.login-title,.lc-title') || {}).textContent;
        var u = new SpeechSynthesisUtterance(String(txt).replace(/\s+/g, ' ')); window.speechSynthesis.speak(u);
      } catch (e) {}
    };
    $('gov-skip').addEventListener('click', function () { var t = document.getElementById((this.getAttribute('href') || '').slice(1)); if (t) setTimeout(function () { try { t.focus(); } catch (e) {} }, 0); });
    if (fs !== 100) applyFs();
  }
  function layout() {
    var t = document.getElementById('gov-top'), f = document.getElementById('gov-foot'); if (!t || !f) return;
    var on = SHOW[PAGE] && SHOW[PAGE]();
    document.body.classList.toggle('gov-on', !!on);
    if (on) {
      document.documentElement.style.setProperty('--gov-top', t.offsetHeight + 'px');
      document.documentElement.style.setProperty('--gov-bot', f.offsetHeight + 'px');
    }
  }

  /* ───────── announcement ticker (shared with the Super Admin "Header & Announcement Settings") ───────── */
  var lastSig = '';
  function loadTicker() {
    if (!API) return;
    fetch(API + '/admin/announcements', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      var items = (d.items || []).filter(function (i) { return i && i.active !== false && i.text; });
      var sig = JSON.stringify([items, d.speed]);
      if (sig === lastSig) return; lastSig = sig;
      window.__announcements = d;
      var box = document.getElementById('gov-ticker'), trk = document.getElementById('gov-trk');
      if (!box) return;
      if (!items.length) { box.style.display = 'none'; layout(); return; }
      trk.innerHTML = items.map(function (i) { return i.url ? '<a href="' + esc(i.url) + '" target="_blank" rel="noopener">' + esc(i.text) + '</a>' : '<span>' + esc(i.text) + '</span>'; }).join('');
      trk.style.setProperty('--gov-dur', Math.max(15, Math.round((trk.textContent.length * 0.22) * (40 / (d.speed || 40)) + 12)) + 's');
      box.style.display = 'flex'; layout();
    }).catch(function () {});
  }
  window.AnmolAnnouncements = { reload: function () { lastSig = ''; loadTicker(); } };

  function init() {
    build();
    if (!SHOW[PAGE]) return;
    new MutationObserver(layout).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
    window.addEventListener('resize', layout);
    setInterval(layout, 800);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
