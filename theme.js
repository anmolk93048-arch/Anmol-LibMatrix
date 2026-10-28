/* Anmol LibMatrix — portal-wide Theme & Dark Mode engine.
   Loaded in <head> of every page (before paint → no flash).
   • Dark mode  : per-browser choice (localStorage 'anmol_theme'); admin default comes from the server.
   • Colour/preset (incl. Tiranga): chosen by the Super Admin, saved to the database (site-data 'portal_theme')
     and applied on every page for every visitor; also cached in localStorage so it paints instantly.
   Classes set: html[data-theme="dark"], html.dark-mode, body.dark, body.dark-mode, html.theme-custom, html.theme-tiranga.  */
(function () {
  'use strict';
  var KEY = 'anmol_theme', PKEY = 'anmol_theme_portal';
  var root = document.documentElement;
  var PRESETS = {
    blue:    { name: 'Blue',    accent: '#2376cf', nav: '#0b2a5b' },
    green:   { name: 'Green',   accent: '#15946b', nav: '#06382a' },
    purple:  { name: 'Purple',  accent: '#7757d7', nav: '#2a1763' },
    red:     { name: 'Red',     accent: '#dc4356', nav: '#5e0f1c' },
    orange:  { name: 'Orange',  accent: '#d18a14', nav: '#4a2f05' },
    teal:    { name: 'Teal',    accent: '#0891a8', nav: '#063c49' },
    tiranga: { name: 'Tiranga', accent: '#ff9933', nav: '#0b2a5b', green: '#138808' }
  };
  var VARS = ['--gd', '--gd2', '--nv', '--nv2', '--sidebar-bg', '--gr', '--gov-navy', '--gov-navy2', '--gov-orange', '--login-accent', '--brand-accent', '--accent-color', '--primary-color'];

  function rd(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch (e) { return {}; } }
  function wr(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function legacyDark() { try { return localStorage.getItem('dm') === '1' || localStorage.getItem('hrms_dark') === '1'; } catch (e) { return false; } }
  function validColor(c) { return /^#[0-9a-f]{6}$/i.test(String(c || '')); }

  function hex2rgb(h) { h = h.replace('#', ''); return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
  function rgb2hex(r) { return '#' + r.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function mix(a, b, t) { var x = hex2rgb(a), y = hex2rgb(b); return rgb2hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]); }

  function state() {
    var l = rd(KEY), p = rd(PKEY);
    var mode = l.mode || p.mode || (legacyDark() ? 'dark' : 'light');
    var preset = p.preset, color = p.color;
    if (l.preset !== undefined || l.color) { preset = l.preset; color = l.color; } // an admin's just-picked theme shows instantly, before it is saved
    return { mode: mode === 'dark' ? 'dark' : 'light', preset: PRESETS[preset] ? preset : '', color: validColor(color) ? color : '' };
  }

  function apply() {
    var s = state(), dark = s.mode === 'dark';
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.classList.toggle('dark-mode', dark);
    var b = document.body;
    if (b) { b.classList.toggle('dark', dark); b.classList.toggle('dark-mode', dark); }
    var pr = s.preset ? PRESETS[s.preset] : (s.color ? { accent: s.color, nav: mix(s.color, '#000000', .62) } : null);
    root.classList.toggle('theme-custom', !!pr);
    root.classList.toggle('theme-tiranga', s.preset === 'tiranga');
    var st = root.style;
    VARS.forEach(function (v) { st.removeProperty(v); });
    if (pr) {
      var nav = dark ? mix(pr.nav, '#050a14', .55) : pr.nav;
      var map = { '--gd': pr.accent, '--gd2': mix(pr.accent, '#ffffff', .28), '--nv': nav, '--nv2': mix(nav, '#ffffff', .12), '--sidebar-bg': mix(nav, '#000000', .12),
        '--gov-navy': nav, '--gov-navy2': mix(nav, '#000000', .25), '--gov-orange': pr.accent, '--login-accent': pr.accent, '--brand-accent': pr.accent, '--accent-color': pr.accent, '--primary-color': pr.accent };
      if (pr.green) map['--gr'] = pr.green;
      Object.keys(map).forEach(function (k) { st.setProperty(k, map[k]); });
    }
    try { var m = document.querySelector('meta[name="theme-color"]'); if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); } m.content = dark ? '#0b1220' : (pr ? pr.nav : '#0b2a5b'); } catch (e) {}
    var al = document.getElementById('admin-login'); if (al) { al.setAttribute('data-login-mode', dark ? 'dark' : 'light'); var lc = document.getElementById('login-theme-dark'); if (lc) lc.checked = dark; }
    syncUI(s);
    try { window.dispatchEvent(new CustomEvent('anmol:theme-changed', { detail: s })); } catch (e) {}
    return s;
  }

  function syncUI(s) {
    var q = function (sel) { return document.querySelectorAll(sel); };
    q('[data-theme-toggle]').forEach(function (el) {
      var dark = s.mode === 'dark';
      el.setAttribute('aria-pressed', dark ? 'true' : 'false');
      el.title = dark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
      var lbl = dark ? (el.getAttribute('data-label-light') || '☀️ Light') : (el.getAttribute('data-label-dark') || '🌙 Dark');
      if (el.getAttribute('data-icon-only') === '1') lbl = dark ? '☀️' : '🌙';
      el.textContent = lbl;
    });
    var chk = document.getElementById('dashboard-theme-dark'); if (chk) chk.checked = s.mode === 'dark';
    var cur = s.color || (s.preset && PRESETS[s.preset] ? PRESETS[s.preset].accent : '');
    var pick = document.getElementById('dashboard-theme-custom'); if (pick && cur) pick.value = cur;
    q('.dashboard-theme-swatch').forEach(function (b) {
      var on = (b.getAttribute('data-preset') && b.getAttribute('data-preset') === s.preset) || (!b.getAttribute('data-preset') && !s.preset && cur && b.getAttribute('data-color') === cur);
      b.classList.toggle('selected', !!on);
    });
  }

  /* ── persistence ── */
  function token() { try { return AUTH_TOKEN || ''; } catch (e) { try { return localStorage.getItem('shdl_auth_token') || ''; } catch (e2) { return ''; } } }
  function base() { return String(window.SHDL_API_BASE || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.API_BASE) || '/api').replace(/\/$/, ''); }
  function saveServer(cfg, quiet) {
    var t = token(); if (!t) return Promise.resolve(false);
    return fetch(base() + '/site-data/portal_theme', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ value: cfg }) })
      .then(function (r) { if (!r.ok) throw new Error('save failed'); wr(PKEY, cfg); var l = rd(KEY); delete l.preset; delete l.color; wr(KEY, l); apply(); return true; })
      .catch(function () { if (!quiet) { try { SHOW_TOAST('Theme applied in this browser, but could not be saved to the server (admin login required).'); } catch (e) {} } return false; });
  }
  var _t;
  function queueSave() { clearTimeout(_t); _t = setTimeout(function () { var s = state(); saveServer({ preset: s.preset, color: s.color, mode: rd(PKEY).mode || '' }, true); }, 600); }
  function loadServer() {
    try {
      fetch(base() + '/site-data/portal_theme').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        var v = d && d.value; if (!v || typeof v !== 'object') return;
        var cfg = { preset: PRESETS[v.preset] ? v.preset : '', color: validColor(v.color) ? v.color : '', mode: v.mode === 'dark' ? 'dark' : '' };
        wr(PKEY, cfg); apply();
      }).catch(function () {});
    } catch (e) {}
  }

  /* ── public API ── */
  var T = window.AnmolTheme = {
    PRESETS: PRESETS, state: state, apply: apply,
    setMode: function (m) { var l = rd(KEY); l.mode = m === 'dark' ? 'dark' : 'light'; wr(KEY, l); try { localStorage.setItem('dm', l.mode === 'dark' ? '1' : '0'); localStorage.setItem('hrms_dark', l.mode === 'dark' ? '1' : '0'); } catch (e) {} apply(); },
    toggleDark: function () { T.setMode(state().mode === 'dark' ? 'light' : 'dark'); },
    setPreset: function (name) { var l = rd(KEY); l.preset = PRESETS[name] ? name : ''; l.color = ''; wr(KEY, l); apply(); queueSave(); },
    setColor: function (c) { if (!validColor(c)) return; var l = rd(KEY); l.preset = ''; l.color = c; wr(KEY, l); apply(); queueSave(); },
    reset: function () { wr(KEY, { mode: state().mode, preset: '', color: '' }); return saveServer({ preset: '', color: '', mode: '' }, true).then(function () { wr(PKEY, {}); apply(); }); },
    save: function () { var s = state(); return saveServer({ preset: s.preset, color: s.color, mode: s.mode === 'dark' ? 'dark' : '' }); }
  };
  /* Super Admin → Theme & Appearance page handlers (names are referenced by the page markup) */
  window.APPLY_DASHBOARD_THEME = function () { var c = document.getElementById('dashboard-theme-dark'); if (c) T.setMode(c.checked ? 'dark' : 'light'); else apply(); };
  window.SET_DASHBOARD_THEME = function (c) { T.setColor(c); };
  window.SET_DASHBOARD_PRESET = function (n) { T.setPreset(n); };
  window.SAVE_DASHBOARD_THEME = function () { T.save().then(function (ok) { try { SHOW_TOAST(ok ? 'Theme saved — it now applies across the whole portal.' : 'Saved in this browser only (admin login required for portal-wide save).'); } catch (e) {} }); };
  window.RESET_DASHBOARD_THEME = function () { T.reset().then(function () { try { SHOW_TOAST('Theme reset to default.'); } catch (e) {} }); };
  window.TOGGLE_DM = window.TOGGLE_DARK = window.TOGGLE_THEME = function () { T.toggleDark(); };

  apply(); // as early as possible (head)
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-theme-toggle]');
    if (t) { e.preventDefault(); e.stopPropagation(); T.toggleDark(); }
  }, true);
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    if (root.hasAttribute('data-anmol-nofloat')) return;
    setTimeout(function () { // floating toggle only on pages that have no toggle of their own
      if (document.querySelector('[data-theme-toggle]')) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'anmol-theme-fab'; b.setAttribute('data-theme-toggle', ''); b.setAttribute('data-icon-only', '1');
      document.body.appendChild(b); syncUI(state());
    }, 1200);
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === PKEY) apply(); });
  window.addEventListener('load', function () { apply(); });
  loadServer();
})();
