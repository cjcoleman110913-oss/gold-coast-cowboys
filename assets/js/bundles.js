(function () {
  var buttons = document.querySelectorAll('.gt-buy');
  var dlg = document.getElementById('bundle-dialog'), form = document.getElementById('bundle-form');
  if (!buttons.length || !dlg) return;
  var $ = function (id) { return document.getElementById(id); };
  var money = function (c) { return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 }); };
  var info = {}, current = null;
  var fmtDate = function (iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

  function load() {
    return fetch('/api/checkout').then(function (r) { return r.json(); }).then(function (d) {
      d.bundles.forEach(function (b) { info[b.slug] = b; });
      return d;
    });
  }
  load().then(function (d) {
    buttons.forEach(function (btn) {
      var b = info[btn.dataset.bundle];
      if (b && b.saleEnded) { btn.disabled = true; btn.textContent = 'Sale ended'; }
      else if (b && b.soldOut) { btn.disabled = true; btn.textContent = 'Sold out'; }
      else if (b && b.remaining != null && b.remaining <= 5) {
        var note = document.createElement('p'); note.className = 'gt-left';
        note.textContent = 'Only ' + b.remaining + ' left'; btn.after(note);
      }
    });
  }).catch(function () {});

  function syncPlan() {
    var monthly = form.elements.plan.value === 'monthly';
    $('plan-terms').hidden = !monthly; form.elements.acceptTerms.required = monthly;
  }
  form.addEventListener('change', syncPlan);

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      current = btn.dataset.bundle;
      load().catch(function () {}).then(open);
      function open() { form.reset(); syncPlan(); $('bundle-error').hidden = true;
      var b = info[current];
      $('bundle-title').textContent = b ? b.name : 'Season pass';
      $('bundle-sub').textContent = 'All 3 events: Boots on the Coast, St. Louis Stomp, Tails California';
      var pl = b && b.plan;
      $('plan-full-sub').textContent = b ? money(b.priceCents) + ' today. No extra fees.' : '';
      $('plan-monthly-opt').hidden = !pl;
      if (pl) {
        $('plan-monthly-sub').textContent = money(pl.downCents) + ' today, then ' + pl.months + ' monthly payments of ' + money(pl.monthlyCents) +
          '. Total ' + money(pl.totalCents) + ' (includes a 4% payment plan fee). Charged automatically each month.';
        $('plan-schedule').textContent = 'Payment schedule: ' + money(pl.downCents) + ' today, then ' + money(pl.monthlyCents) + ' on ' +
          pl.schedule.map(fmtDate).join(', ') + '. Total ' + money(pl.totalCents) + '. You can cancel future payments any time by emailing dance@goldcoastcowboys.com.';
      }
      $('bundle-submit').disabled = false; $('bundle-submit').textContent = 'Continue to payment';
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
    });
  });
  $('bundle-cancel').addEventListener('click', function () { dlg.close(); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('bundle-submit'); btn.disabled = true; btn.textContent = 'One moment…'; $('bundle-error').hidden = true;
    fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundle: current, plan: form.elements.plan.value, acceptTerms: form.elements.plan.value === 'monthly' && form.elements.acceptTerms.checked, name: form.elements.name.value, email: form.elements.email.value }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) { if (!x.ok) throw new Error(x.d.error || 'Something went wrong.'); location.href = x.d.url; })
      .catch(function (err) { $('bundle-error').textContent = err.message; $('bundle-error').hidden = false; btn.disabled = false; btn.textContent = 'Continue to payment'; });
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
})();
