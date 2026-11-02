/* Anmol LibMatrix — inactivity auto-logout + session-state guard (injected into every portal page by the server).
   • No mouse / keyboard / touch / scroll activity for IDLE minutes (default 15, ANMOL_CONFIG.IDLE_MIN) → the session is revoked
     on the server, cleared in this browser, and the user is sent back to the home page.
   • The last-activity time is shared by all tabs (localStorage). A tab that was closed and re-opened after the limit
     — or after the server invalidated the session — never resumes: it signs out and asks for a fresh login.
   • A heartbeat (POST /auth/ping) keeps the server-side idle clock in step while the user is genuinely active.
   • Every API call carries X-Anmol-Idle:1; a 401 with code SESSION_IDLE / SESSION_REVOKED (idle, or password changed on
     another device) logs this tab out at once. Logging out in one tab logs out all tabs. */
(function () {
  if (window.__anmolIdleGuard) return; window.__anmolIdleGuard = true;
  var CFG = window.ANMOL_CONFIG || {};
  var IDLE = (Number(CFG.IDLE_MIN) || 15) * 60 * 1000, WARN = 60 * 1000, PING_EVERY = 60 * 1000, THROTTLE = 4000;
  var K_ACT = 'anmol_last_active', K_OUT = 'anmol_logout_signal';
  var TOKEN_KEYS = ['shdl_auth_token', 'pfms_auth_token', 'anmol_auth_token', 'anmolPortalUser', 'anmol_session', 'anmol_location', 'anmol_gate'];
  var lastWrite = 0, lastPing = 0, expiring = false, warnEl = null;

  function api() { return String(window.SHDL_API_BASE || CFG.API_BASE || '/api').replace(/\/$/, ''); }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; }
  function tokens() {
    var out = [];
    ['shdl_auth_token', 'pfms_auth_token', 'anmol_auth_token'].forEach(function (k) { var v = ls(k) || (function () { try { return sessionStorage.getItem(k); } catch (e) { return null; } })(); if (v) out.push(v); });
    return out;
  }
  function hasSession() { return tokens().length > 0; }
  function iatMs() {                                                        // a freshly issued token always starts a fresh idle window
    var m = 0; tokens().forEach(function (t) { try { var p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (p && p.iat) m = Math.max(m, p.iat * 1000); } catch (e) {} });
    return m;
  }
  function lastActive() { return Math.max(Number(ls(K_ACT)) || 0, iatMs()); }
  function touch(force) { var n = Date.now(); if (force || n - lastWrite > THROTTLE) { lastWrite = n; ls(K_ACT, String(n)); } hideWarn(); }

  function isApi(u) { try { var a = new URL(u, location.href).href; return a.indexOf(new URL(api() + '/', location.href).href) === 0; } catch (e) { return false; } }
  // tag API calls + react to server-side session invalidation
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var tagged = isApi(url);
    if (tagged) {
      init = Object.assign({}, init || {});
      var h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      h.set('X-Anmol-Idle', '1'); init.headers = h;
    }
    var p = _fetch.call(this, input, init);
    if (!tagged) return p;
    return p.then(function (r) {
      if (r.status === 401 && hasSession()) {
        r.clone().json().then(function (d) { if (d && /^SESSION_(IDLE|REVOKED)$/.test(d.code || '')) expire(d.error || 'Your session has ended. Please log in again.', true); }).catch(function () {});
      }
      return r;
    });
  };

  function clearLocal() {
    TOKEN_KEYS.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} try { sessionStorage.removeItem(k); } catch (e) {} });
    ls(K_ACT, null);
  }
  function banner(text) {
    var d = document.createElement('div');
    d.setAttribute('role', 'alertdialog');
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(8,20,45,.78);font-family:system-ui,Arial,sans-serif';
    d.innerHTML = '<div style="background:#fff;color:#14213d;max-width:360px;width:calc(100% - 32px);border-radius:14px;padding:22px 20px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45)"><div style="font-size:34px">🔒</div><div style="font-weight:800;font-size:16px;margin:6px 0">Session ended</div><div style="font-size:13px;color:#4a5568;line-height:1.5"></div></div>';
    d.querySelector('div > div:last-child').textContent = text;
    (document.body || document.documentElement).appendChild(d);
  }
  function expire(msg, fromServer) {
    if (expiring) return; expiring = true;
    try { ls(K_OUT, String(Date.now())); } catch (e) {}                       // tell the other tabs
    banner(msg || 'You were signed out because of inactivity. Please log in again.');
    setTimeout(function () {
      if (!fromServer) tokens().forEach(function (t) {                         // revoke on the server (best effort) before forgetting the tokens
        try { _fetch(api() + '/auth/logout', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: '{}' }).catch(function () {}); } catch (e) {}
      });
      try { if (window.AnmolPortal) window.AnmolPortal.clearSession(); } catch (e) {}
      clearLocal();
      location.replace(window.SHDL_HOME_URL || CFG.HOME || '/');
    }, 1600);
  }

  function showWarn(secs) {
    if (!warnEl) {
      warnEl = document.createElement('div');
      warnEl.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:2147483500;background:#7a1f1f;color:#fff;padding:10px 16px;border-radius:10px;font:600 13px system-ui,Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35)';
      (document.body || document.documentElement).appendChild(warnEl);
    }
    warnEl.textContent = 'Inactive — you will be signed out in ' + secs + 's. Move the mouse or press a key to stay signed in.';
  }
  function hideWarn() { if (warnEl && warnEl.parentNode) warnEl.parentNode.removeChild(warnEl); warnEl = null; }

  function ping() {
    var t = tokens()[0]; if (!t) return;
    var h = { 'Content-Type': 'application/json', 'X-Anmol-Idle': '1', 'Authorization': 'Bearer ' + t };
    _fetch(api() + '/auth/ping', { method: 'POST', headers: h, body: '{}', keepalive: true }).then(function (r) {
      if (r.status === 401) return r.json().catch(function () { return {}; }).then(function (d) { expire(d.error || 'Your session has ended. Please log in again.', true); });
    }).catch(function () {});
  }

  function tick() {
    if (expiring || !hasSession()) { hideWarn(); return; }
    var n = Date.now(), idleFor = n - (lastActive() || n);
    if (idleFor >= IDLE) return expire('You were signed out because of inactivity. Please log in again.');
    if (idleFor >= IDLE - WARN) showWarn(Math.max(1, Math.ceil((IDLE - idleFor) / 1000))); else hideWarn();
    if (idleFor < PING_EVERY * 2 && n - lastPing >= PING_EVERY) { lastPing = n; ping(); }
  }

  // ── start-up: a re-opened tab must not resume a stale session ──
  if (hasSession()) {
    var la = lastActive();
    if (la && Date.now() - la >= IDLE) { setTimeout(function () { expire('Your previous session expired. Please log in again.', false); }, 0); }
    else { touch(true); setTimeout(ping, 1500); }                            // 1st ping also validates the token server-side (password changed elsewhere?)
  }
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll', 'click'].forEach(function (ev) { window.addEventListener(ev, function () { if (!expiring && hasSession()) touch(); }, { passive: true, capture: true }); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  window.addEventListener('focus', tick);
  window.addEventListener('storage', function (e) { if (e.key === K_OUT && e.newValue && !expiring) expire('You were signed out in another tab.', true); });
  setInterval(tick, 5000);
  window.AnmolIdle = { touch: function () { touch(true); }, expire: expire };
})();
