(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('redeem-form');
  var comp = $('comp-wrap');
  function sync() {
    var t = form.elements.ticketType.value;
    comp.hidden = t !== 'competition_pass';
    form.elements.competition.required = t === 'competition_pass';
  }
  Array.prototype.forEach.call(form.elements.ticketType, function (r) { r.addEventListener('change', sync); });
  function showErr(m) { var e = $('r-error'); e.textContent = m; e.hidden = !m; }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    showErr('');
    var f = form.elements;
    var data = {
      name: f.name.value, email: f.email.value, wonAt: f.wonAt.value, event: f.event.value,
      ticketType: f.ticketType.value, competition: f.competition.value, website: f.website.value
    };
    if (!data.name.trim()) return showErr('Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim())) return showErr('Please enter a valid email address.');
    if (!data.wonAt.trim()) return showErr('Tell us where you won the pass.');
    if (!data.event) return showErr('Please choose which event you’re redeeming for.');
    if (!data.ticketType) return showErr('Please choose what kind of ticket it is.');
    if (data.ticketType === 'competition_pass' && !data.competition.trim()) return showErr('Please list which competition you’re redeeming it for.');
    var btn = $('r-submit'); btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.'); }); })
      .then(function () { form.hidden = true; $('r-done').hidden = false; window.scrollTo({ top: 0, behavior: 'smooth' }); })
      .catch(function (e) { showErr(e.message); btn.disabled = false; btn.textContent = 'Submit redemption'; });
  });
})();
