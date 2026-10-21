(function () {
  var EVENTS = { 'boots-on-the-coast': 'Boots on the Coast', 'st-louis-stomp': 'St. Louis Stomp', 'tails-california': 'Tails California' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var $ = function (id) { return document.getElementById(id); };
  var slug = new URLSearchParams(location.search).get('event');
  if (!EVENTS[slug]) slug = null; // null = show everything

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function money(c) { return '$' + (c % 100 ? (c / 100).toFixed(2) : String(c / 100)); }
  function when(iso) { return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
  function parts(d) { var p = d.split('-'); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; }
  function range(a, b) {
    if (!a) return '';
    var s = parts(a);
    if (!b || b === a) return MONTHS[s.m] + ' ' + s.d + ', ' + s.y;
    var e = parts(b);
    if (s.y === e.y && s.m === e.m) return MONTHS[s.m] + ' ' + s.d + '–' + e.d + ', ' + s.y;
    if (s.y === e.y) return MONTHS[s.m] + ' ' + s.d + ' – ' + MONTHS[e.m] + ' ' + e.d + ', ' + s.y;
    return MONTHS[s.m] + ' ' + s.d + ', ' + s.y + ' – ' + MONTHS[e.m] + ' ' + e.d + ', ' + e.y;
  }

  var tabs = $('p-events');
  var allTab = el('a', 'filter-btn' + (!slug ? ' active' : ''), 'All Events');
  allTab.href = 'passes.html';
  tabs.appendChild(allTab);
  Object.keys(EVENTS).forEach(function (s) {
    var b = el('a', 'filter-btn' + (s === slug ? ' active' : ''), EVENTS[s]);
    b.href = 'passes.html?event=' + s;
    tabs.appendChild(b);
  });
  $('p-eyebrow').textContent = slug ? EVENTS[slug] : 'Gold Coast Cowboys';
  $('p-title').textContent = 'Competitions';
  $('p-lede').textContent = 'Pick a competition and lock in your spot. Event weekend tickets are sold separately.';
  document.title = (slug ? EVENTS[slug] + ' ' : '') + 'Competitions — Gold Coast Cowboys';

  function passRow(c, p) {
    var row = el('div', 'pass-row');
    var left = el('div', 'pass-role');
    left.appendChild(el('strong', null, p.name));
    if (!p.soldOut && p.remaining != null && p.remaining <= 5) left.appendChild(el('small', 'low', 'Only ' + p.remaining + ' left'));
    var price = el('div', 'pass-price');
    price.appendChild(el('span', 'now', money(p.currentPriceCents)));
    if (p.earlyActive) {
      price.appendChild(el('s', null, money(p.priceCents)));
      price.appendChild(el('small', 'early', 'Early-bird until ' + when(p.earlyUntil)));
    }
    var btn = el('button', 'btn solid', p.soldOut ? 'Sold out' : 'Buy pass');
    btn.type = 'button';
    if (p.soldOut) btn.disabled = true; else btn.addEventListener('click', function () { openBuy(c, p); });
    row.appendChild(left); row.appendChild(price); row.appendChild(btn);
    return row;
  }

  function render(list) {
    var box = $('p-list'); box.textContent = '';
    list.forEach(function (c) {
      var card = el('article', 'pass-card');
      var h = el('div', 'pass-card-head');
      h.appendChild(el('h3', null, c.title));
      var meta = [range(c.date, c.endDate), c.location].filter(Boolean).join(' · ');
      if (meta) h.appendChild(el('p', 'pass-meta', meta));
      var kind = [c.style, c.level].filter(Boolean).join(' · ');
      if (kind) h.appendChild(el('p', 'pass-meta pass-kind', kind));
      card.appendChild(h);
      if (c.description) card.appendChild(el('p', 'pass-desc', c.description));
      c.passes.forEach(function (p) { card.appendChild(passRow(c, p)); });
      box.appendChild(card);
    });
  }

  fetch('/api/passes' + (slug ? '?event=' + slug : '')).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) {
    if (!d.competitions.length) { $('p-status').textContent = 'Competitions ' + (slug ? 'for ' + EVENTS[slug] + ' ' : '') + 'aren’t open yet. Check back soon, or join the newsletter to be first to know.'; return; }
    $('p-status').hidden = true; render(d.competitions);
  }).catch(function () { $('p-status').textContent = 'We couldn’t load competitions right now. Please refresh and try again.'; });

  var dlg = $('buy-dialog'), form = $('buy-form'), current = null;
  function openBuy(c, p) {
    current = p; $('buy-error').hidden = true; form.reset();
    $('buy-title').textContent = c.title + ' · ' + p.name;
    $('buy-sub').textContent = [range(c.date, c.endDate), c.location].filter(Boolean).concat([money(p.currentPriceCents)]).join(' · ');
    $('buy-submit').disabled = false; $('buy-submit').textContent = 'Continue to payment';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }
  $('buy-cancel').addEventListener('click', function () { dlg.close(); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('buy-submit'); btn.disabled = true; btn.textContent = 'One moment…'; $('buy-error').hidden = true;
    fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passTypeId: current.id, name: form.elements.name.value, email: form.elements.email.value }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        if (!x.ok) throw new Error(x.d.error || 'Something went wrong.');
        location.href = x.d.url;
      }).catch(function (err) {
        $('buy-error').textContent = err.message; $('buy-error').hidden = false;
        btn.disabled = false; btn.textContent = 'Continue to payment';
      });
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
})();
