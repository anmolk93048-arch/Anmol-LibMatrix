/* Anmol LibMatrix — registration fee helper (Super Admin sets the fee; ₹0 = free).
   REGPAY.pay(kind, mobile, agent) → Promise<{orderId,paymentId,signature}|null>  (null = free) */
(function () {
  function base() { return (window.SHDL_API_BASE || (window.ANMOL_CONFIG && window.ANMOL_CONFIG.API_BASE) || '/api').replace(/\/$/, ''); }
  function post(path, body) {
    return fetch(base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Request failed'); return d; }); });
  }
  function loadCheckout() {
    return new Promise(function (ok, bad) {
      if (window.Razorpay) return ok();
      var s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = ok; s.onerror = function () { bad(new Error('Unable to load the payment page. Please check your internet connection.')); };
      document.head.appendChild(s);
    });
  }
  window.REGPAY = {
    pay: function (kind, mobile, agent, label) {
      return post('/registration/payment-order', { kind: kind, mobile: mobile, agent: agent || '' }).then(function (o) {
        if (o.free) return null;
        return loadCheckout().then(function () {
          return new Promise(function (resolve, reject) {
            var rz = new Razorpay({
              key: o.key, amount: o.amount, currency: o.currency || 'INR', order_id: o.orderId,
              name: 'Anmol LibMatrix', description: label || 'Registration fee', prefill: { contact: mobile },
              theme: { color: '#0d1e3d' },
              handler: function (r) { resolve({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }); },
              modal: { ondismiss: function () { reject(new Error('Payment was cancelled. Registration not submitted.')); } }
            });
            rz.open();
          });
        });
      });
    }
  };
})();
