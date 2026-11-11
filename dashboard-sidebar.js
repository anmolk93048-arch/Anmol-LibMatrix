/* Anmol LibMatrix — Super Admin sidebar behaviour: accordion groups, remembered collapse state,
   live overview (server stats + local cache), auto-open of the group that holds the active page. */
(function () {
  'use strict';
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  var LS_OPEN = 'lm_sb_groups', LS_COL = 'lm_sb_collapsed';

  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {}
    return null;
  }

  /* ── accordion groups ── */
  function saveGroups() {
    var open = [].map.call(sb.querySelectorAll('.lm-group.open[data-group]'), function (g) { return g.getAttribute('data-group'); });
    ls(LS_OPEN, JSON.stringify(open));
  }
  function setGroup(g, open) {
    g.classList.toggle('open', open);
    var h = g.querySelector('.lm-group-head'); if (h) h.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  try {
    var saved = JSON.parse(ls(LS_OPEN) || 'null');
    if (Array.isArray(saved)) [].forEach.call(sb.querySelectorAll('.lm-group[data-group]:not(.lm-group-flat)'), function (g) { setGroup(g, saved.indexOf(g.getAttribute('data-group')) >= 0); });
  } catch (e) {}
  sb.addEventListener('click', function (e) {
    var h = e.target.closest && e.target.closest('.lm-group-head');
    if (!h || sb.classList.contains('collapsed') && window.innerWidth > 768) return;
    var g = h.parentNode; setGroup(g, !g.classList.contains('open')); saveGroups();
  });
  // Keep the group that holds the current page open (also when GOTO is triggered by search, quick actions, etc.)
  function revealActive() {
    var a = sb.querySelector('.lm-item.active'); if (!a) return;
    var g = a.closest('.lm-group'); if (g && !g.classList.contains('open')) setGroup(g, true);
  }
  new MutationObserver(revealActive).observe(sb, { subtree: true, attributes: true, attributeFilter: ['class'] });
  revealActive();

  /* ── remembered collapse (desktop only) ── */
  if (window.innerWidth > 768 && ls(LS_COL) === '1') sb.classList.add('collapsed');
  var _toggle = window.TOGGLE_SIDEBAR;
  window.TOGGLE_SIDEBAR = function () {
    if (typeof _toggle === 'function') _toggle.apply(this, arguments);
    if (window.innerWidth > 768) ls(LS_COL, sb.classList.contains('collapsed') ? '1' : '0');
  };
  // The dim overlay lives outside #admin-app (its own stacking context), so it painted over the drawer — move it inside.
  var ov = document.getElementById('sidebar-overlay');
  if (ov && sb.parentNode && ov.parentNode !== sb.parentNode) sb.parentNode.insertBefore(ov, sb);   // same stacking context as the drawer
  // measure topbar so the mobile drawer starts right under it
  function measure() { var t = document.querySelector('#admin-app .topbar'); if (t) sb.style.setProperty('--lm-top', t.offsetHeight + 'px'); }
  measure(); window.addEventListener('resize', measure);

  /* ── live overview ── */
  var live = document.getElementById('lm-live');
  function $(id) { return document.getElementById(id); }
  function arr(v) { return Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.keys(v).map(function (k) { return v[k]; }) : []); }
  function local(key) { try { return arr(window.DB && DB.get(key)); } catch (e) { return []; } }
  function cu(id, val, o) { if (window.AnmolLive) AnmolLive.countUp($(id), val, o); else if ($(id)) $(id).textContent = val; }
  function bar(id, pct) { var b = $(id); if (b) b.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + '%'; }

  function render(s, online) {
    // Server numbers are authoritative; the dashboard's local cache fills in until the first response (and offline).
    var students = s && s.totalStudents != null ? s.totalStudents : local('students').length;
    var agents = s && s.totalAgents != null ? s.totalAgents : local('agents').length;
    var books = s && s.totalBooks ? s.totalBooks : (local('books').length || local('library_books').length);
    cu('lmv-students', students); cu('lmv-agents', agents); cu('lmv-books', books);
    cu('lmv-logins', s ? s.todayLogins : 0);
    var att = s ? Number(s.attendancePercent) || 0 : 0, kyc = s ? Number(s.kycVerifiedPercent) || 0 : 0;
    var hasAtt = s && s.todayAttendanceMarked > 0;
    $('lmv-att').textContent = hasAtt ? att.toFixed(1).replace(/\.0$/, '') + '%' : 'No data';
    bar('lmb-att', hasAtt ? att : 0);
    $('lmv-kyc').textContent = s ? kyc.toFixed(1).replace(/\.0$/, '') + '%' : '–';
    bar('lmb-kyc', kyc);
    live.classList.toggle('on', !!online); live.classList.toggle('off', !online);
    $('lm-live-dot').title = online ? 'Live — connected to the server' : 'Offline — showing last known values';
    $('lm-live-time').textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  function start() {
    render(null, false);
    if (window.AnmolLive) AnmolLive.subscribe(function (s, m) { render(s, m.online); });
  }
  // Only poll once the admin app is actually visible (not on the login screen).
  var app = document.getElementById('admin-app'), started = false;
  function maybeStart() { if (!started && app && getComputedStyle(app).display !== 'none') { started = true; start(); } }
  maybeStart();
  if (!started) { var iv = setInterval(function () { maybeStart(); if (started) clearInterval(iv); }, 800); }
})();
