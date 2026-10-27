(function () {
  var buttons = document.querySelectorAll('.gt-buy');
  var dlg = document.getElementById('bundle-dialog'), form = document.getElementById('bundle-form');
  if (!buttons.length || !dlg) return;
  var $ = function (id) { return document.getElementById(id); };
  var money = function (c) { return '$' + (c / 100).toLocaleString(undefined, { minimumFractionDigits: 0 }); };
  var info = {}, current = null;

  fetch('/api/checkout').then(function (r) { return r.json(); }).then(function (d) {
    d.bundles.forEach(function (b) { info[b.slug] = b; });
    buttons.forEach(function (btn) {
      var b = info[btn.dataset.bundle];
      if (b && b.soldOut) { btn.disabled = true; btn.textContent = 'Sold out'; }
      else if (b && b.remaining != null && b.remaining <= 5) {
        var note = document.createElement('p'); note.className = 'gt-left';
        note.textContent = 'Only ' + b.remaining + ' left'; btn.after(note);
      }
    });
  }).catch(function () {});

  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      current = btn.dataset.bundle; form.reset(); $('bundle-error').hidden = true;
      var b = info[current];
      $('bundle-title').textContent = b ? b.name : 'Season pass';
      $('bundle-sub').textContent = (b ? money(b.priceCents) + ' · ' : '') + 'All 3 events: Boots on the Coast, St. Louis Stomp, Tails California';
      $('bundle-submit').disabled = false; $('bundle-submit').textContent = 'Continue to payment';
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    });
  });
  $('bundle-cancel').addEventListener('click', function () { dlg.close(); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('bundle-submit'); btn.disabled = true; btn.textContent = 'One moment…'; $('bundle-error').hidden = true;
    fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundle: current, name: form.elements.name.value, email: form.elements.email.value }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) { if (!x.ok) throw new Error(x.d.error || 'Something went wrong.'); location.href = x.d.url; })
      .catch(function (err) { $('bundle-error').textContent = err.message; $('bundle-error').hidden = false; btn.disabled = false; btn.textContent = 'Continue to payment'; });
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
})();
