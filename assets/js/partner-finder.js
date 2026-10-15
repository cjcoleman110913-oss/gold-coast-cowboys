/* ============================================
   Roommates & Strictly Partners — listings feed
   ============================================
   Connected to the live Google Form's response Sheet ("Form
   responses 1" tab inside "GCC Roommates & Partners Listings"),
   published to the web as CSV. New form submissions show up here
   automatically — no code changes needed.

   Column names below must exactly match the Form's own question
   text, since Google Forms uses the question text as the column
   header:
     Timestamp | Name | Event | I'm looking for: |
     Nights you have the hotel room for: | Preferred roommate gender |
     Competition / Style | Level | Lead or Follow needed |
     Anything everyone else should know? | Instagram link or handle
   ("I'm looking for:" must be exactly "Roommate" or "Partner";
   Event must exactly match "Boots on the Coast", "St. Louis Stomp",
   or "Tails California" so the per-event filters work.)

   IF A FORM QUESTION EVER GETS RENAMED:
   The column header here changes too (Forms uses the question text
   as the header) — update the matching idx[...] lookup below to
   the new exact wording, or the field will silently stop populating.

   IF YOU EVER MOVE TO A NEW SHEET OR TAB:
   File > Share > Publish to web > select the sheet tab >
   Comma-separated values (.csv) > Publish, then paste that URL
   below as CSV_URL.
*/

const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vS6iluOkePNuvOAz2eP84flF-qN81YYBtFu_n0PPL6-FkhZ3vVyP9allopMlODZ8fVCQV5trQTJ67Ee/pub?gid=559659249&single=true&output=csv"; // <-- paste your published Google Sheet CSV link here

document.addEventListener('DOMContentLoaded', function () {
  var grid = document.getElementById('listings-grid');
  var emptyState = document.getElementById('listings-empty');
  var allListings = [];
  var activeType = 'all';
  var activeEvent = 'all';

  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
          if (field !== '' || row.length) { row.push(field); rows.push(row); }
          field = ''; row = [];
          if (c === '\r' && text[i + 1] === '\n') i++;
        } else {
          field += c;
        }
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function rowsToListings(rows) {
    if (!rows.length) return [];
    var header = rows[0].map(function (h) { return h.trim(); });
    var idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    return rows.slice(1).filter(function (r) { return r.length > 1; }).map(function (r) {
      return {
        type: (r[idx["I'm looking for:"]] || '').trim().toLowerCase(),
        name: r[idx['Name']] || '',
        event: r[idx['Event']] || '',
        nights: r[idx['Nights you have the hotel room for:']] || '',
        genderPref: r[idx['Preferred roommate gender']] || '',
        competition: r[idx['Competition / Style']] || '',
        level: r[idx['Level']] || '',
        leadFollow: r[idx['Lead or Follow needed']] || '',
        message: r[idx['Anything everyone else should know?']] || '',
        instagram: r[idx['Instagram link or handle']] || ''
      };
    }).reverse(); // newest first
  }

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
        ig.href = l.instagram.indexOf('http') === 0 ? l.instagram : ('https://instagram.com/' + l.instagram.replace('@', ''));
        ig.target = '_blank';
        ig.rel = 'noopener';
        ig.textContent = 'Message on Instagram';
        card.appendChild(ig);
      }

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

  if (!CSV_URL) {
    emptyState.hidden = false;
    applyEventFromUrl();
    return;
  }

  fetch(CSV_URL)
    .then(function (res) { return res.text(); })
    .then(function (text) {
      allListings = rowsToListings(parseCSV(text));
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
});
