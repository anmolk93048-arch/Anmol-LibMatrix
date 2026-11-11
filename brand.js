/* Anmol LibMatrix — single source of truth for branding.
   Load this BEFORE portal-shell.js on every page (index, Admin, Agent, HRMS, Invoice, Student, PFMS).

   To change the logo for every portal at once, replace the files in /assets/brand/
   (or edit BRAND.logo / BRAND.mark below). Nothing else needs touching.

   Markup contract (any page can opt in):
     <img data-brand-logo>              full logo lock-up
     <img data-brand-mark>              icon-only mark (small spaces, collapsed sidebar)
     <span data-brand-name></span>      "Anmol LibMatrix"
     <span data-brand-tagline></span>   "Smart Digital Library"
     <div data-brand-social></div>      renders Facebook / YouTube / X icon links
   The legacy shell header (.gov-brand img) and the shared footer are picked up automatically. */
(function () {
  'use strict';
  var defaults = {
    name: 'Anmol LibMatrix',
    tagline: 'Smart Digital Library',
    taglineHi: 'अनमोल लाइब्रेरी मैट्रिक्स',
    logo: '/assets/brand/anmol-libmatrix-logo.png',
    mark: '/assets/brand/anmol-libmatrix-mark.png',
    // Official pages. Admin can override these live from
    // Super Admin → Website Manager → Footer (stored in site-data key "footer.social").
    social: {
      facebook: 'https://www.facebook.com/',
      youtube: 'https://www.youtube.com/',
      twitter: 'https://x.com/'
    }
  };
  var BRAND = window.ANMOL_BRAND = Object.assign({}, defaults, window.ANMOL_BRAND || {});
  BRAND.social = Object.assign({}, defaults.social, (window.ANMOL_BRAND && window.ANMOL_BRAND.social) || {});

  // Inline fallback so the brand never renders as a broken image if the file is unreachable.
  var FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b2a5b"/>' +
    '<path d="M32 12 10 22l22 10 22-10z" fill="#f28c28"/><path d="M18 30v10c0 4 6 8 14 8s14-4 14-8V30l-14 6z" fill="#fff"/></svg>');

  var ICONS = {
    facebook: '<path d="M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H7.8v3h2.6V21z"/>',
    youtube: '<path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2C2 8.8 2 12 2 12s0 3.2.4 4.8a2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8c.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3z"/>',
    twitter: '<path d="M17.8 3.5h3l-6.5 7.5 7.7 10h-6l-4.7-6.1-5.4 6.1h-3l7-8L2.3 3.5h6.2l4.2 5.6zm-1 16h1.7L7.6 5.2H5.8z"/>'
  };
  var LABELS = { facebook: 'Facebook', youtube: 'YouTube', twitter: 'X (Twitter)' };

  function setImg(img, src) {
    if (!img || img.getAttribute('data-brand-applied') === src) return;
    img.setAttribute('data-brand-applied', src);
    img.onerror = function () { img.onerror = null; img.src = FALLBACK; };
    img.src = src;
    if (!img.getAttribute('alt')) img.alt = BRAND.name + ' logo';
  }

  function socialHtml() {
    return ['facebook', 'youtube', 'twitter'].map(function (k) {
      var u = BRAND.social[k];
      if (!u) return '';
      return '<a class="lm-social lm-social-' + k + '" href="' + u + '" target="_blank" rel="noopener noreferrer" aria-label="' + LABELS[k] + '" title="' + LABELS[k] + '">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' + ICONS[k] + '</svg></a>';
    }).join('');
  }

  function apply(root) {
    root = root || document;
    var i, n;
    n = root.querySelectorAll('img[data-brand-logo], .gov-brand img');
    for (i = 0; i < n.length; i++) setImg(n[i], BRAND.logo);
    n = root.querySelectorAll('img[data-brand-mark]');
    for (i = 0; i < n.length; i++) setImg(n[i], BRAND.mark);
    n = root.querySelectorAll('[data-brand-name]');
    for (i = 0; i < n.length; i++) if (n[i].textContent !== BRAND.name) n[i].textContent = BRAND.name;
    n = root.querySelectorAll('[data-brand-tagline]');
    for (i = 0; i < n.length; i++) if (n[i].textContent !== BRAND.tagline) n[i].textContent = BRAND.tagline;
    n = root.querySelectorAll('[data-brand-social]');
    var sh = socialHtml();
    for (i = 0; i < n.length; i++) if (n[i].getAttribute('data-brand-rendered') !== sh) { n[i].innerHTML = sh; n[i].setAttribute('data-brand-rendered', sh); }
    var fav = document.querySelector('link[rel~="icon"]');
    if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav); }
    if (fav.getAttribute('href') !== BRAND.mark) fav.setAttribute('href', BRAND.mark);
  }

  // Let the admin change social links without a redeploy (public, read-only endpoint already used by index.html).
  function loadSocialFromServer() {
    var base = window.SHDL_API_BASE || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.API_BASE) || '/api';
    fetch(base + '/site-data/footer', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var s = d && d.value && d.value.social;
        if (!s) return;
        ['facebook', 'youtube', 'twitter'].forEach(function (k) { if (typeof s[k] === 'string' && /^https?:\/\//i.test(s[k])) BRAND.social[k] = s[k]; });
        apply();
      }).catch(function () {});
  }

  BRAND.apply = apply;
  BRAND.socialHtml = socialHtml;

  function boot() {
    apply();
    loadSocialFromServer();
    // The shared shell (gov-shell.js / portal-shell.js) injects its header/footer later — re-apply when it does.
    if (window.MutationObserver) {
      var t;
      new MutationObserver(function () { clearTimeout(t); t = setTimeout(apply, 60); })
        .observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
