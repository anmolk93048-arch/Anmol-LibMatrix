/* Anmol LibMatrix — shared navigation, session, logout, role modal, branding.
   Loaded by index.html and all 6 portals (after config.js). */
(function () {
  var CFG = window.ANMOL_CONFIG || {};
  var API = window.SHDL_API_BASE || CFG.API_BASE || '';
  var HOME = window.SHDL_HOME_URL || '/';
  var LOGO = 'anmol_libmatrix_logo.png';
  var TOKEN_KEYS = ['shdl_auth_token', 'pfms_auth_token', 'anmol_auth_token', 'anmolPortalUser', 'anmol_session', 'anmol_location', 'anmol_gate'];

  var PORTALS = [
    { key: 'admin',   name: 'Admin Login',        icon: '🛡️', url: '/admin-login',       desc: 'Super Admin & management panel' },
    { key: 'agent',   name: 'Agent Login',        icon: '🤝', url: '/agent-login',       desc: 'Agents, students & collections' },
    { key: 'pfms',    name: 'PFMS Portal',        icon: '💳', url: '/pfms-login',        desc: 'Payout & fund management' },
    { key: 'hrms',    name: 'HRMS',               icon: '👥', url: '/hrms-login',        desc: 'Employees, salary & attendance' },
    { key: 'student', name: 'Student Attendance', icon: '🎓', url: '/student-login', desc: 'Mark attendance & fees' },
    { key: 'invoice', name: 'Invoice Generator',  icon: '🧾', url: '/invoice-login',     desc: 'Material bills & invoices' }
  ];

  function each(arr, fn) { for (var i = 0; i < arr.length; i++) fn(arr[i]); }
  function getToken() {
    var t = null;
    each(['shdl_auth_token', 'pfms_auth_token', 'anmol_auth_token'], function (k) {
      if (t) return;
      try { t = localStorage.getItem(k) || sessionStorage.getItem(k); } catch (e) {}
    });
    return t;
  }
  function clearSession() {            // session keys only — never wipes cached app data
    each(TOKEN_KEYS, function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
      try { sessionStorage.removeItem(k); } catch (e) {}
    });
  }
  function allTokens() {               // every distinct session token this browser holds (admin + gate-issued portal tokens)
    var seen = {}, out = [];
    each(['shdl_auth_token', 'pfms_auth_token', 'anmol_auth_token'], function (k) {
      each([function () { return localStorage.getItem(k); }, function () { return sessionStorage.getItem(k); }], function (rd) {
        try { var v = rd(); if (v && !seen[v]) { seen[v] = 1; out.push(v); } } catch (e) {}
      });
    });
    try { var g = JSON.parse(sessionStorage.getItem('anmol_gate') || 'null'); if (g && g.token && !seen[g.token]) out.push(g.token); } catch (e) {}
    return out;
  }
  function notifyLogout() {            // tells the backend to revoke every JWT held here (best effort)
    if (!API) return;
    each(allTokens(), function (t) {
      try { fetch(API + '/auth/logout', { method: 'POST', keepalive: true, headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {}); } catch (e) {}
    });
  }
  function logout() {                  // full logout: revoke + clear + back to index.html
    notifyLogout(); clearSession();
    window.location.href = HOME;
  }
  function openPortal(key) {
    var p = null; each(PORTALS, function (x) { if (x.key === key) p = x; });
    if (p) window.location.href = p.url;
  }


  // ── Secure access gate hand-off (Admin_Login → Super Admin / PFMS / Agent / HRMS) ──
  // The server issues a portal token after Role + Location are chosen; it travels in sessionStorage
  // (same tab, 5-minute window) so the target page signs in without asking for a password again.
  var GATE_KEY = 'anmol_gate';
  function goToTarget(resp) {
    try {
      sessionStorage.setItem(GATE_KEY, JSON.stringify({ token: resp.token, portal: resp.portal, role: resp.role, username: resp.username,
        name: resp.name, title: resp.title, location: resp.location, roleLabel: resp.roleLabel, autoLogin: resp.autoLogin !== false, ts: Date.now() }));
      sessionStorage.setItem('anmol_location', resp.location || '');
      if (resp.autoLogin !== false) {
        if (resp.portal === 'pfms') sessionStorage.setItem('pfms_auth_token', resp.token);
        else localStorage.setItem('shdl_auth_token', resp.token);
      }
    } catch (e) {}
    window.location.href = resp.target;
  }
  function consumeGate(portal) {
    var g = null;
    try { g = JSON.parse(sessionStorage.getItem(GATE_KEY) || 'null'); } catch (e) {}
    if (!g || g.portal !== portal || !g.token || (Date.now() - (g.ts || 0)) > 5 * 60 * 1000) return null;
    try { sessionStorage.removeItem(GATE_KEY); } catch (e) {}
    return g.autoLogin === false ? null : g;
  }

  function post(path, body, token) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return fetch(API + path, { method: 'POST', headers: h, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('Error ' + r.status)); return d; }); });
  }

  // Role & Location modal shown after Super Admin login.
  function showRoleModal(opts) {
    opts = opts || {};
    if (document.getElementById('anmol-rm')) return;
    var locations = opts.locations || ['Peinshallah'];
    var role = 'super_admin';
    var wrap = document.createElement('div');
    wrap.className = 'anmol-rm'; wrap.id = 'anmol-rm';
    wrap.innerHTML =
      '<div class="anmol-rm-card" role="dialog" aria-modal="true">' +
      '<div class="anmol-rm-head"><img src="' + LOGO + '" alt="" onerror="this.style.display=\'none\'"><div><h3>Select Role &amp; Location</h3><p>' + (opts.user ? 'Welcome, ' + String(opts.user).replace(/</g, '&lt;') : 'Continue to your workspace') + '</p></div></div>' +
      '<div class="anmol-rm-body"><label>Role</label><div class="anmol-rm-opts">' +
      '<div class="anmol-rm-opt sel" data-r="super_admin">🛡️ Super Admin</div><div class="anmol-rm-opt" data-r="pfms">💳 PFMS Portal</div></div>' +
      '<label>Location</label><select id="anmol-rm-loc"></select><div class="anmol-rm-err" id="anmol-rm-err"></div></div>' +
      '<div class="anmol-rm-foot"><button class="anmol-rm-out" id="anmol-rm-out">🚪 Logout</button><button class="anmol-rm-go" id="anmol-rm-go">Continue →</button></div></div>';
    document.body.appendChild(wrap);
    var sel = wrap.querySelector('#anmol-rm-loc');
    each(locations, function (l) { var o = document.createElement('option'); o.value = o.textContent = l; sel.appendChild(o); });
    each(wrap.querySelectorAll('.anmol-rm-opt'), function (el) {
      el.onclick = function () { each(wrap.querySelectorAll('.anmol-rm-opt'), function (x) { x.classList.remove('sel'); }); el.classList.add('sel'); role = el.getAttribute('data-r'); };
    });
    wrap.querySelector('#anmol-rm-out').onclick = function () { logout(); };
    wrap.querySelector('#anmol-rm-go').onclick = function () {
      var btn = this, err = wrap.querySelector('#anmol-rm-err'), loc = sel.value;
      btn.disabled = true; err.textContent = '';
      var finish = function () {
        try { sessionStorage.setItem('anmol_session', JSON.stringify({ role: role, location: loc, name: opts.user || '', at: Date.now() })); sessionStorage.setItem('anmol_location', loc); } catch (e) {}
        wrap.parentNode.removeChild(wrap);
        if (role === 'pfms') {
          // PFMS has its own credentials/JWT role ('pfms'); an admin token can't be reused there.
          window.location.href = '/pfms-login?from=admin&location=' + encodeURIComponent(loc);
        } else if (typeof opts.onSuperAdmin === 'function') { opts.onSuperAdmin(loc); }
      };
      var t = getToken();
      if (!t) return finish();       // token bridge still pending: continue locally, server logs on next call
      post('/portal/session', { role: role, location: loc }, t).then(finish).catch(function (e) {
        if (/401|login|permission/i.test(e.message)) return finish();
        btn.disabled = false; err.textContent = '❌ ' + e.message;
      });
    };
  }

  // Student attendance -> Supabase (today's rows only; selfies never leave the device)
  function syncAttendance(list) {
    try {
      if (!Array.isArray(list) || !API) return;
      var d = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10), rows = [];
      each(list, function (e) {
        if (!e || e.date !== d || !e.records) return;
        Object.keys(e.records).forEach(function (n) { rows.push({ student_name: n, date: e.date, batch: String(e.batch || ''), status: e.records[n], marked_by: e.markedBy || n, source: 'student_portal' }); });
      });
      if (rows.length) post('/portal/attendance', { records: rows }, getToken()).catch(function (x) { console.warn('Attendance sync:', x.message); });
    } catch (e) {}
  }

  // Render free tier sleeps after ~15 min idle; the first request can take 30-60 s. Retry network errors,
  // timeouts and 502/503/504 (never 4xx — those are real answers) and report progress to the UI.
  function fetchRetry(url, opts, cfg) {
    cfg = cfg || {}; var tries = cfg.tries || 4, timeout = cfg.timeout || 25000, n = 0;
    function once() {
      n++;
      var ac = new AbortController(), t = setTimeout(function () { ac.abort(); }, timeout);
      return fetch(url, Object.assign({}, opts, { signal: ac.signal })).then(function (r) {
        clearTimeout(t);
        if (r.status === 502 || r.status === 503 || r.status === 504) throw new Error('HTTP ' + r.status);
        return r;
      }).catch(function (e) {
        clearTimeout(t);
        if (n >= tries) throw e;
        if (cfg.onRetry) { try { cfg.onRetry(n + 1, tries, e); } catch (x) {} }
        return new Promise(function (res) { setTimeout(res, 1500 * n); }).then(once);
      });
    }
    return once();
  }
  function apiHost() { try { return new URL(API).host; } catch (e) { return API; } }
  function warmUp() { try { if (API) fetch(API + '/health', { cache: 'no-store' }).catch(function () {}); } catch (e) {} }

  function brand() {
    if (!document.querySelector('link[rel~="icon"]')) { var l = document.createElement('link'); l.rel = 'icon'; l.href = LOGO; document.head.appendChild(l); }
    if (!document.querySelector('.anmol-footer')) {
      var f = document.createElement('div'); f.className = 'anmol-footer';
      f.innerHTML = '<img src="' + LOGO + '" alt="" onerror="this.style.display=\'none\'"><span>© 2026 Anmol LibMatrix. All rights reserved.</span>';
      document.body.appendChild(f);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', brand); else brand();
  warmUp(); // wake the backend while the user types their credentials

  window.AnmolPortal = { goToTarget: goToTarget, consumeGate: consumeGate, allTokens: allTokens, PORTALS: PORTALS, HOME: HOME, getToken: getToken, clearSession: clearSession, notifyLogout: notifyLogout, logout: logout, openPortal: openPortal, showRoleModal: showRoleModal, syncAttendance: syncAttendance, fetchRetry: fetchRetry, apiHost: apiHost, warmUp: warmUp };
})();
