/* Anmol LibMatrix — client side of route masking (injected into every page by the server).
   window.AnmolNav.go('pfms')            open a portal by key: admin | dashboard | agent | hrms | student | pfms | invoice
   window.AnmolNav.go('pfms', '?from=x') …with a query string        AnmolNav.go('admin', '', true) → replace()
   window.AnmolNav.href(anything)        legacy name / path → the masked URL for THIS session (or nav:<key> until the map is loaded)
   Anchors and window.open() that point at a portal are masked automatically.
   The link map (window.__ANMOL_NAV) is injected by the server; it is fetched from /api/nav/map when missing or stale. */
(function () {
  var KEYS = { admin: 1, dashboard: 1, agent: 1, hrms: 1, student: 1, pfms: 1, invoice: 1 };
  // names that old CMS data / role targets may still contain (lookup keys only — none of them resolve as a URL any more)
  var ALIAS = { 'admin-login': 'admin', 'admin_login': 'admin', 'admin_panel_login': 'admin', 'new_admin_login': 'admin', 'super_admin_login': 'admin', 'super-admin': 'admin',
    'admin-dashboard': 'dashboard', 'super_admin_dashboard': 'dashboard', 'agent-login': 'agent', 'agent_login': 'agent', 'hrms-login': 'hrms', 'hrms_login': 'hrms',
    'student-login': 'student', 'student_attendance': 'student', 'student_attendance_portal': 'student', 'pfms-login': 'pfms', 'pfms_login': 'pfms',
    'invoice-login': 'invoice', 'invoice_login': 'invoice', 'anmol_material_entry': 'invoice', 'anmol_material_login': 'invoice' };
  var STALE_MS = 6 * 3600 * 1000;
  var pending = null;

  function apiBase() { return String(window.SHDL_API_BASE || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.API_BASE) || '/api').replace(/\/$/, ''); }
  function split(s) { s = String(s == null ? '' : s).trim(); var i = s.search(/[?#]/); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i)]; }
  function keyFor(s) {
    var b = split(s)[0].toLowerCase();
    if (/^https?:\/\//.test(b)) { try { var u = new URL(b); if (u.origin !== location.origin && u.origin !== apiOrigin()) return null; b = u.pathname; } catch (e) { return null; } }
    b = b.replace(/^nav:/, '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.html?$/, '');
    if (KEYS[b]) return b;
    return ALIAS[b] || null;
  }
  function apiOrigin() { try { return new URL(apiBase(), location.href).origin; } catch (e) { return ''; } }
  function mapOrigin() { return window.__ANMOL_NAV_ORIGIN || ''; }   // set when the map came from another origin
  function fresh() { return window.__ANMOL_NAV && (Date.now() - (window.__ANMOL_NAV_TS || 0)) < STALE_MS; }
  function load(cb) {
    if (fresh()) return cb();
    if (!pending) {
      pending = fetch(apiBase() + '/nav/map', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.map) { window.__ANMOL_NAV = d.map; window.__ANMOL_NAV_TS = Date.now(); var o = apiOrigin(); window.__ANMOL_NAV_ORIGIN = o && o !== location.origin ? o : ''; }
      }).catch(function () {}).then(function () { pending = null; });
    }
    pending.then(cb);
  }
  function masked(k, rest) { var m = window.__ANMOL_NAV; return m && m[k] ? mapOrigin() + m[k] + (rest || '') : null; }
  function href(s) {
    var k = keyFor(s); if (!k) return s;
    return masked(k, split(s)[1]) || ('nav:' + k + split(s)[1]);
  }
  function nav(u, replace) { if (replace) location.replace(u); else location.assign(u); }
  function go(s, rest, replace) {
    if (rest === true) { replace = true; rest = ''; }
    var k = keyFor(s);
    if (!k) { nav(String(s || '/'), replace); return; }                    // already a masked link / home / external
    var q = rest || split(s)[1];
    load(function () { nav(masked(k, q) || '/', replace); });
  }

  // anchors pointing at a portal → masked (works for static HTML, CMS-built menus and nav:<key> links)
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button > 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var raw = a.getAttribute('href'), k = keyFor(raw);
    if (!k) return;
    e.preventDefault();
    var blank = /^_blank$/i.test(a.getAttribute('target') || '') || e.ctrlKey || e.metaKey || e.shiftKey;
    var q = split(raw)[1];
    if (blank) {
      var w = window.open('', '_blank');                                    // opened synchronously so pop-up blockers allow it
      if (w) { try { w.opener = null; } catch (x) {} load(function () { w.location.href = masked(k, q) || '/'; }); }
      return;
    }
    go(k, q);
  }, true);

  // window.open('/some-portal-path') → masked
  var _open = window.open;
  window.open = function (u) {
    var k = typeof u === 'string' ? keyFor(u) : null;
    if (k && masked(k)) { arguments[0] = masked(k, split(u)[1]); }
    return _open.apply(window, arguments);
  };

  window.AnmolNav = { go: go, href: href, keyFor: keyFor, load: load, current: function () { return window.__ANMOL_PAGE || ''; } };
})();
