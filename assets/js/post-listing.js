(function () {
  var $ = function (id) { return document.getElementById(id); };
  var form = $('post-form');
  function sync() {
    var k = form.elements.kind.value;
    $('f-roommate').hidden = k !== 'roommate';
    $('f-partner').hidden = k !== 'partner';
  }
  Array.prototype.forEach.call(form.elements.kind, function (r) { r.addEventListener('change', sync); });
  var pre = new URLSearchParams(location.search).get('event');
  if (pre && form.elements.event.querySelector('option[value="' + pre + '"]')) form.elements.event.value = pre;
  function showErr(m) { var e = $('p-error'); e.textContent = m; e.hidden = !m; }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault(); showErr('');
    var f = form.elements;
    var data = { action: 'create', kind: f.kind.value, event: f.event.value, name: f.name.value, email: f.email.value,
      nights: f.nights.value, genderPref: f.genderPref.value, competition: f.competition.value, level: f.level.value,
      roleNeeded: f.roleNeeded.value, notes: f.notes.value, instagram: f.instagram.value, website: f.website.value };
    if (!data.kind) return showErr('Choose roommate or partner.');
    if (!data.event) return showErr('Choose an event.');
    if (!data.name.trim()) return showErr('Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email.trim())) return showErr('Please enter a valid email address.');
    var btn = $('p-submit'); btn.disabled = true; btn.textContent = 'Posting…';
    fetch('/api/listings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.'); return j; }); })
      .then(function (j) { window.location.href = j.manageUrl + '&new=1'; })
      .catch(function (e) { showErr(e.message); btn.disabled = false; btn.textContent = 'Post my listing'; });
  });
})();
