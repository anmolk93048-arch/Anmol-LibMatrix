/* Anmol LibMatrix — device-binding client (injected by the server into every page, before the page's own scripts).
   • Keeps a random 256-bit device id in this browser (localStorage) and sends it as X-Device-Id on the login calls.
   • When the server answers 403 {code:'DEVICE_OTP_REQUIRED'} (new browser/laptop) it shows a small OTP box, then repeats the
     SAME login request with X-Device-Otp and hands the final response back to the page — the login pages need no changes.
   • Covers POST …/api/auth/login (Super Admin, Admin, Agent, HRMS, PFMS) and …/api/material/login (Invoice portal). */
(function () {
  if (window.__anmolDeviceOtp || !window.fetch) return;
  window.__anmolDeviceOtp = true;
  var origFetch = window.fetch.bind(window), KEY = 'anmol_device_id', mem = null;

  function deviceId() {
    try { var v = localStorage.getItem(KEY); if (v && /^[a-f0-9]{32,64}$/.test(v)) return v; } catch (e) {}
    if (mem) return mem;
    var a = new Uint8Array(32);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a); else for (var i = 0; i < 32; i++) a[i] = Math.floor(Math.random() * 256);
    var id = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    try { localStorage.setItem(KEY, id); } catch (e) { mem = id; }
    return id;
  }
  var LOGIN = /\/api\/(auth\/login|material\/login)\/?(\?|#|$)/i;
  function isLogin(u) { try { return LOGIN.test(new URL(u, location.href).pathname + '?'); } catch (e) { return false; } }

  function css(el, s) { el.style.cssText = s; return el; }
  function ask(info, first) {            // → Promise<{otp}|{resend:true}|null>
    return new Promise(function (resolve) {
      var ov = css(document.createElement('div'), 'position:fixed;inset:0;z-index:2147483000;background:rgba(11,37,69,.6);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
      var box = css(document.createElement('div'), 'background:#fff;color:#1f2a44;width:100%;max-width:380px;border-radius:14px;padding:22px 20px;box-shadow:0 20px 60px rgba(0,0,0,.35)');
      var h = css(document.createElement('div'), 'font-size:17px;font-weight:800;margin-bottom:6px'); h.textContent = '🔐 Verify this device';
      var p = css(document.createElement('div'), 'font-size:13px;line-height:1.5;color:#4a5876;margin-bottom:12px');
      p.textContent = 'You are signing in from a new browser or device. Enter the 6-digit OTP sent on WhatsApp to ' + (info.maskedMobile || 'your registered number') + '.';
      var inp = css(document.createElement('input'), 'width:100%;box-sizing:border-box;font-size:22px;letter-spacing:8px;text-align:center;padding:10px;border:1.5px solid #c9d3ea;border-radius:10px;outline:none');
      inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = 'one-time-code'; inp.maxLength = 6; inp.placeholder = '••••••';
      var err = css(document.createElement('div'), 'min-height:18px;font-size:12px;font-weight:700;color:#b42318;margin:6px 0'); err.textContent = first ? '' : (info.error || '');
      var row = css(document.createElement('div'), 'display:flex;gap:8px;margin-top:4px');
      var ok = css(document.createElement('button'), 'flex:1;padding:10px;border:0;border-radius:10px;background:#0b2a5b;color:#fff;font-weight:800;cursor:pointer'); ok.textContent = 'Verify & Sign in'; ok.type = 'button';
      var rs = css(document.createElement('button'), 'padding:10px 12px;border:1.5px solid #0b2a5b;border-radius:10px;background:#fff;color:#0b2a5b;font-weight:700;cursor:pointer'); rs.type = 'button';
      var cx = css(document.createElement('button'), 'width:100%;margin-top:8px;padding:8px;border:0;background:transparent;color:#667;cursor:pointer;font-size:12px'); cx.textContent = 'Cancel'; cx.type = 'button';
      row.appendChild(ok); row.appendChild(rs);
      [h, p, inp, err, row, cx].forEach(function (n) { box.appendChild(n); }); ov.appendChild(box); document.body.appendChild(ov);
      var left = Math.max(0, parseInt(info.resendInSec, 10) || 0), t;
      function tick() { rs.disabled = left > 0; rs.style.opacity = left > 0 ? '.5' : '1'; rs.textContent = left > 0 ? 'Resend in ' + left + 's' : 'Resend OTP'; if (left > 0) { left--; t = setTimeout(tick, 1000); } }
      tick(); setTimeout(function () { inp.focus(); }, 50);
      function done(v) { clearTimeout(t); ov.remove(); resolve(v); }
      ok.onclick = function () { var v = inp.value.replace(/\D/g, ''); if (v.length !== 6) { err.textContent = 'Enter the 6-digit OTP.'; return; } done({ otp: v }); };
      inp.onkeydown = function (e) { if (e.key === 'Enter') ok.onclick(); };
      rs.onclick = function () { if (left <= 0) done({ resend: true }); };
      cx.onclick = function () { done(null); };
    });
  }

  function send(url, base, extra) {
    var h = new Headers(base.headers || {});
    h.set('X-Device-Id', deviceId());
    if (extra) h.set('X-Device-Otp', extra);
    return origFetch(url, Object.assign({}, base, { headers: h }));
  }
  function peek(r) { return r.clone().json().catch(function () { return null; }); }

  window.fetch = function (input, init) {
    var isReq = typeof Request !== 'undefined' && input instanceof Request;
    var url = isReq ? input.url : String(input && input.href ? input.href : input);
    var method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
    if (method !== 'POST' || !isLogin(url)) return origFetch(input, init);
    var prep = isReq ? input.clone().text().then(function (body) {
      var hh = {}; input.headers.forEach(function (v, k) { hh[k] = v; });
      return Object.assign({ method: 'POST', headers: hh, body: body, credentials: input.credentials, mode: input.mode }, init || {});
    }) : Promise.resolve(init || {});
    return prep.then(function (base) {
      base = Object.assign({}, base, { method: 'POST' });
      return send(url, base).then(function loop(res) {
        if (res.status !== 403) return res;
        return peek(res).then(function (info) {
          if (!info || info.code !== 'DEVICE_OTP_REQUIRED') return res;
          function round(i, first) {
            return ask(i, first).then(function (a) {
              if (!a) return res;                                        // cancelled → page shows the server's message
              if (a.resend) return send(url, base).then(function (r2) { return peek(r2).then(function (j) { return j && j.code === 'DEVICE_OTP_REQUIRED' ? round(j, true) : r2; }); });
              return send(url, base, a.otp).then(function (r3) {
                if (r3.status === 401 || r3.status === 403) return peek(r3).then(function (j) {
                  if (j && j.code === 'DEVICE_OTP_INVALID') return round(Object.assign({}, i, { error: j.error, resendInSec: 0 }), false);
                  if (j && j.code === 'DEVICE_OTP_EXPIRED') return round(Object.assign({}, i, { error: j.error, resendInSec: 0 }), false);
                  return r3;
                });
                return r3;
              });
            });
          }
          return round(info, true);
        });
      });
    });
  };
})();
