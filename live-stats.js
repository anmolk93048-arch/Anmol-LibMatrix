/* Anmol LibMatrix — live metrics poller shared by index.html and the Super Admin sidebar.
   Source: GET {API}/dashboard/live-stats (public, read-only, backed by the Supabase/Postgres tables).
   Usage:  AnmolLive.subscribe(function (stats, meta) { ... });  AnmolLive.countUp(el, 1234);
   - polls every 8 s while the tab is visible, pauses when hidden, retries with back-off on failure
   - never throws into the page; subscribers receive meta.online === false when the backend is unreachable */
(function () {
  'use strict';
  var subs = [], last = null, timer = null, fails = 0, inflight = false;
  var BASE_MS = 8000;

  function api() { return window.SHDL_API_BASE || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.API_BASE) || '/api'; }

  function emit(stats, online) {
    var meta = { online: online, at: Date.now() };
    subs.forEach(function (fn) { try { fn(stats, meta); } catch (e) { console.warn('AnmolLive subscriber:', e); } });
  }

  function tick() {
    if (inflight) return;
    inflight = true;
    var ac = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ac) ac.abort(); }, 20000);
    fetch(api() + '/dashboard/live-stats', { cache: 'no-store', signal: ac ? ac.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { fails = 0; last = d; emit(d, true); })
      .catch(function () { fails++; emit(last, false); })
      .then(function () { clearTimeout(to); inflight = false; schedule(); });
  }

  function schedule() {
    clearTimeout(timer);
    if (!subs.length || document.hidden) return;
    timer = setTimeout(tick, Math.min(BASE_MS * Math.pow(2, Math.min(fails, 3)), 64000));
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden && subs.length) { clearTimeout(timer); tick(); } else clearTimeout(timer); });

  function fmt(n) { return (Number(n) || 0).toLocaleString('en-IN'); }

  // Smooth number transition (respects reduced-motion).
  function countUp(el, to, opts) {
    if (!el) return;
    opts = opts || {};
    var prefix = opts.prefix || '', suffix = opts.suffix || '', dec = opts.decimals || 0;
    var from = Number(el.getAttribute('data-v')); if (isNaN(from)) from = 0;
    to = Number(to) || 0;
    el.setAttribute('data-v', to);
    function paint(v) { el.textContent = prefix + (dec ? v.toFixed(dec) : fmt(Math.round(v))) + suffix; }
    if (from === to || (window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches)) return paint(to);
    var t0 = performance.now(), dur = 700;
    (function step(t) {
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      paint(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }

  window.AnmolLive = {
    subscribe: function (fn) { subs.push(fn); if (last) fn(last, { online: true, at: Date.now(), cached: true }); if (subs.length === 1) tick(); else schedule(); return function () { subs = subs.filter(function (f) { return f !== fn; }); }; },
    refresh: function () { clearTimeout(timer); tick(); },
    countUp: countUp,
    fmt: fmt
  };
})();
