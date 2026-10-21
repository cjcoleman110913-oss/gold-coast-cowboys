/* Roommates & Strictly Partners: live listings from /api/listings.
   People apply to a listing; the poster accepts or declines from a private link. */
document.addEventListener('DOMContentLoaded', function () {
  var grid = document.getElementById('listings-grid');
  var emptyState = document.getElementById('listings-empty');
  var allListings = [];
  var activeType = 'all';
  var activeEvent = 'all';

  function renderListings() {
    var filtered = allListings.filter(function (l) {
      var typeMatch = activeType === 'all' || l.type === activeType;
      var eventMatch = activeEvent === 'all' || l.event === activeEvent;
      return typeMatch && eventMatch;
    });

    grid.innerHTML = '';
    if (!filtered.length) {
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    filtered.forEach(function (l) {
      var card = document.createElement('div');
      card.className = 'listing-card';

      var tag = document.createElement('span');
      tag.className = 'listing-tag ' + (l.type === 'roommate' ? 'tag-roommate' : 'tag-partner');
      tag.textContent = l.type === 'roommate' ? 'Roommate' : 'Partner';
      card.appendChild(tag);

      var name = document.createElement('h3');
      name.textContent = l.name || 'Dancer';
      card.appendChild(name);

      var event = document.createElement('div');
      event.className = 'listing-event';
      event.textContent = l.event;
      card.appendChild(event);

      var details = document.createElement('div');
      details.className = 'listing-details';
      if (l.type === 'roommate') {
        if (l.nights) details.innerHTML += '<div><strong>Nights:</strong> ' + escapeHtml(l.nights) + '</div>';
        if (l.genderPref) details.innerHTML += '<div><strong>Roommate preference:</strong> ' + escapeHtml(l.genderPref) + '</div>';
      } else {
        if (l.competition) details.innerHTML += '<div><strong>Competition:</strong> ' + escapeHtml(l.competition) + '</div>';
        if (l.level) details.innerHTML += '<div><strong>Level:</strong> ' + escapeHtml(l.level) + '</div>';
        if (l.leadFollow) details.innerHTML += '<div><strong>Needs:</strong> ' + escapeHtml(l.leadFollow) + '</div>';
      }
      card.appendChild(details);

      if (l.message) {
        var msg = document.createElement('p');
        msg.className = 'listing-message';
        msg.textContent = l.message;
        card.appendChild(msg);
      }

      if (l.instagram) {
        var ig = document.createElement('a');
        ig.className = 'btn ghost-gold';
        ig.href = l.instagram.indexOf('http') === 0 ? l.instagram : ('https://instagram.com/' + encodeURIComponent(l.instagram.replace(/^@/, '')));
        ig.target = '_blank';
        ig.rel = 'noopener';
        ig.textContent = 'Instagram';
        card.appendChild(ig);
      }

      var ask = document.createElement('button');
      ask.type = 'button';
      ask.className = 'btn solid';
      ask.textContent = 'Request to connect';
      ask.addEventListener('click', function () { openApply(l); });
      card.appendChild(ask);

      grid.appendChild(card);
    });
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  document.querySelectorAll('#filter-type .filter-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#filter-type .filter-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeType = btn.dataset.filterType;
      renderListings();
    });
  });
  document.querySelectorAll('#filter-event .filter-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#filter-event .filter-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeEvent = btn.dataset.filterEvent;
      renderListings();
    });
  });

  fetch('/api/listings')
    .then(function (res) { if (!res.ok) throw 0; return res.json(); })
    .then(function (d) {
      allListings = d.listings;
      applyEventFromUrl();
      renderListings();
    })
    .catch(function () {
      emptyState.hidden = false;
    });

  function applyEventFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var eventParam = params.get('event');
    if (!eventParam) return;
    var btn = document.querySelector('#filter-event .filter-btn[data-filter-event="' + eventParam + '"]');
    if (btn) {
      document.querySelectorAll('#filter-event .filter-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activeEvent = eventParam;
    }
  }

  var dlg = document.getElementById('apply-dialog');
  var af = document.getElementById('apply-form');
  var current = null;
  function openApply(l) {
    current = l;
    af.reset();
    document.getElementById('apply-error').hidden = true;
    document.getElementById('apply-title').textContent = 'Request to connect with ' + (l.name || 'this dancer');
    document.getElementById('apply-submit').disabled = false;
    document.getElementById('apply-submit').textContent = 'Send request';
    dlg.showModal();
  }
  document.getElementById('apply-cancel').addEventListener('click', function () { dlg.close(); });
  af.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var err = document.getElementById('apply-error');
    var btn = document.getElementById('apply-submit');
    err.hidden = true; btn.disabled = true; btn.textContent = 'Sending…';
    fetch('/api/listings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'apply', listingId: current.id, name: af.elements.name.value, email: af.elements.email.value, message: af.elements.message.value }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); }); })
      .then(function () {
        document.getElementById('apply-title').textContent = 'Request sent!';
        document.getElementById('apply-sub').textContent = 'They’ll get an email. If they accept, we’ll send you their contact info.';
        af.querySelectorAll('label').forEach(function (n) { n.hidden = true; });
        btn.hidden = true;
        document.getElementById('apply-cancel').textContent = 'Close';
      })
      .catch(function (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Send request'; });
  });
  dlg.addEventListener('close', function () {
    af.querySelectorAll('label').forEach(function (n) { n.hidden = false; });
    document.getElementById('apply-submit').hidden = false;
    document.getElementById('apply-cancel').textContent = 'Cancel';
    document.getElementById('apply-sub').textContent = 'Your email is only shared if they accept.';
  });
});
