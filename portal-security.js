/* Anmol LibMatrix portal security UX controls.
 * Client-side deterrents are not an authorization boundary: use server-side auth,
 * short-lived tokens, CSP and rate limiting to protect real data.
 */
(function () {
  'use strict';
  var IDLE_MS = 15 * 60 * 1000; // change to 10 * 60 * 1000 for 10 minutes
  var WARN_MS = 60 * 1000;
  var lastActivity = Date.now(), timer = null, warningTimer = null, overlay = null, loggedOut = false;
  var activityEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'click'];
  var KEY = 'anmol_security_idle_v1';

  function addStyles() {
    if (document.getElementById('anmol-security-style')) return;
    var s = document.createElement('style'); s.id = 'anmol-security-style';
    s.textContent = '#anmol-security-toast{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:min(420px,calc(100vw - 32px));padding:12px 16px;border-radius:10px;background:#172033;color:#fff;font:600 14px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px #0004}#anmol-idle-warning{position:fixed;inset:0;z-index:2147483646;background:#07111dcc;display:flex;align-items:center;justify-content:center;padding:20px;font:15px/1.5 system-ui,sans-serif}#anmol-idle-warning .card{max-width:420px;width:100%;background:#fff;color:#172033;border-radius:16px;padding:24px;box-shadow:0 20px 60px #0005}#anmol-idle-warning button{border:0;border-radius:8px;padding:10px 16px;background:#1769c2;color:white;font-weight:700;cursor:pointer}html{transition:background-color .18s,color .18s}';
    document.head.appendChild(s);
  }
  function message(text) {
    addStyles(); var el = document.getElementById('anmol-security-toast');
    if (!el) { el = document.createElement('div'); el.id = 'anmol-security-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = text; clearTimeout(el._hide); el._hide = setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
  }
  function isTypingTarget(t) { return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))); }

  // A lightweight deterrent only; browser developer tools/source cannot be reliably disabled.
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); message('Security notice: context menu is disabled on this portal.'); });
  document.addEventListener('keydown', function (e) {
    var k = String(e.key || '').toLowerCase();
    var blocked = k === 'f12' || (e.ctrlKey && e.shiftKey && ['i', 'j', 'c'].indexOf(k) !== -1) || (e.ctrlKey && !e.shiftKey && k === 'u');
    if (blocked) { e.preventDefault(); e.stopPropagation(); message('Developer shortcuts are disabled for this portal.'); }
  }, true);

  // Clipboard deterrent on form fields. Users can still use OS/browser tools; do not rely on this for data security.
  document.addEventListener('copy', function (e) { if (isTypingTarget(e.target)) { e.preventDefault(); message('Copy is disabled in form fields.'); } }, true);
  document.addEventListener('cut', function (e) { if (isTypingTarget(e.target)) { e.preventDefault(); message('Cut is disabled in form fields.'); } }, true);
  document.addEventListener('paste', function (e) { if (isTypingTarget(e.target)) { e.preventDefault(); message('Paste is disabled in form fields.'); } }, true);

  function getToken() {
    try { return localStorage.getItem('shdl_auth_token') || localStorage.getItem('pfms_auth_token') || localStorage.getItem('anmol_auth_token') || sessionStorage.getItem('shdl_auth_token') || sessionStorage.getItem('pfms_auth_token') || sessionStorage.getItem('anmol_auth_token'); } catch (_) { return null; }
  }
  function hasActiveSession() {
    if (getToken()) return true;
    try { return !!(sessionStorage.getItem('anmol_session') || sessionStorage.getItem('anmol_gate')); } catch (_) { return false; }
  }
  function removeWarning() { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); overlay = null; }
  function doLogout() {
    if (loggedOut) return; loggedOut = true; clearTimeout(timer); clearTimeout(warningTimer); removeWarning();
    try {
      if (window.AnmolPortal && typeof window.AnmolPortal.logout === 'function') { window.AnmolPortal.logout(); return; }
      var keys = ['shdl_auth_token','pfms_auth_token','anmol_auth_token','anmolPortalUser','anmol_session','anmol_location','anmol_gate'];
      keys.forEach(function (k) { localStorage.removeItem(k); sessionStorage.removeItem(k); });
    } catch (_) {}
    window.location.replace((window.SHDL_HOME_URL || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.HOME) || '/') + '?reason=idle-timeout');
  }
  function showWarning() {
    if (loggedOut || !hasActiveSession()) return;
    addStyles(); removeWarning(); overlay = document.createElement('div'); overlay.id = 'anmol-idle-warning';
    var card = document.createElement('div'); card.className = 'card';
    var title = document.createElement('h2'); title.textContent = 'Session expiring soon';
    var p = document.createElement('p'); p.textContent = 'You have been inactive. For your security, you will be logged out in 60 seconds.';
    var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Stay signed in';
    btn.addEventListener('click', function () { lastActivity = Date.now(); removeWarning(); schedule(); });
    card.appendChild(title); card.appendChild(p); card.appendChild(btn); overlay.appendChild(card); document.body.appendChild(overlay);
  }
  function schedule() {
    clearTimeout(timer); clearTimeout(warningTimer);
    if (!hasActiveSession() || loggedOut) return;
    var elapsed = Date.now() - lastActivity;
    if (elapsed >= IDLE_MS) { doLogout(); return; }
    warningTimer = setTimeout(showWarning, Math.max(0, IDLE_MS - WARN_MS - elapsed));
    timer = setTimeout(doLogout, Math.max(0, IDLE_MS - elapsed));
  }
  function activity() {
    if (loggedOut || !hasActiveSession()) return;
    lastActivity = Date.now(); removeWarning(); schedule();
  }
  activityEvents.forEach(function (name) { document.addEventListener(name, activity, { passive: true, capture: true }); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && hasActiveSession()) { if (Date.now() - lastActivity >= IDLE_MS) doLogout(); else schedule(); } });
  window.addEventListener('storage', function (e) { if (e.key && /auth_token|anmol_session|anmol_gate/.test(e.key) && !hasActiveSession()) { clearTimeout(timer); clearTimeout(warningTimer); removeWarning(); } });
  window.addEventListener('pageshow', function () { if (hasActiveSession()) schedule(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { if (hasActiveSession()) schedule(); }); else if (hasActiveSession()) schedule();
})();
