(function () {
  var $ = function (id) { return document.getElementById(id); };
  var sp = new URLSearchParams(location.search);
  var id = sp.get('id'), token = sp.get('token');
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function banner(html, back) {
    var b = $('m-banner'); b.textContent = '';
    (Array.isArray(html) ? html : [html]).forEach(function (t) { b.appendChild(el('p', null, t)); });
    if (back) { var a = el('a', 'btn', 'Back to listings'); a.href = 'partner-finder.html'; b.appendChild(a); }
    b.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function msg(m) { var e = $('m-msg'); e.textContent = m || ''; e.hidden = !m; }
  function api(method, body) {
    var url = '/api/listing-manage' + (method === 'GET' ? '?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(token) : '');
    return fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(Object.assign({ id: id, token: token }, body)) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }); });
  }
  function line(k, v) { if (!v) return null; var d = el('div'); d.appendChild(el('strong', null, k + ': ')); d.appendChild(document.createTextNode(v)); return d; }

  function render(d) {
    var l = d.listing;
    $('m-title').textContent = 'Your ' + l.kind + ' listing';
    var open = l.status === 'open';
    $('m-lede').textContent = l.event + ' · ' + (open ? 'Live on the site until ' + new Date(l.expiresAt).toLocaleDateString([], { dateStyle: 'medium' }) : l.status === 'expired' ? 'Expired (listings come down after 60 days)' : 'This listing is no longer on the site');
    var card = $('m-card'); card.textContent = '';
    [line('Name', l.name), line(l.kind === 'roommate' ? 'Nights' : 'Competition', l.kind === 'roommate' ? l.nights : l.competition),
     line(l.kind === 'roommate' ? 'Roommate preference' : 'Level', l.kind === 'roommate' ? l.genderPref : l.level),
     line('Needs', l.roleNeeded), line('Notes', l.notes)].forEach(function (n) { if (n) card.appendChild(n); });
    $('m-keep-wrap').hidden = !open;
    $('m-close').hidden = !open;
    var box = $('m-reqs'); box.textContent = '';
    if (!d.requests.length) box.appendChild(el('p', 'hint', 'No requests yet. We’ll email you when someone reaches out.'));
    d.requests.forEach(function (r) {
      var c = el('div', 'req-card');
      c.appendChild(el('h3', null, r.name));
      if (r.message) c.appendChild(el('p', 'listing-message', '“' + r.message + '”'));
      if (r.status === 'pending' && open) {
        var row = el('div', 'req-actions');
        var yes = el('button', 'btn solid', 'Accept'); yes.type = 'button';
        var no = el('button', 'btn', 'Decline'); no.type = 'button';
        yes.onclick = function () { decide(r, 'accept'); }; no.onclick = function () { decide(r, 'decline'); };
        row.appendChild(yes); row.appendChild(no); c.appendChild(row);
      } else if (r.status === 'accepted') {
        var p = el('p', 'req-status'); p.appendChild(el('strong', null, 'Accepted. ')); p.appendChild(document.createTextNode('Reach them at '));
        var a = el('a', null, r.email); a.href = 'mailto:' + r.email; p.appendChild(a); c.appendChild(p);
      } else {
        c.appendChild(el('p', 'req-status', r.status === 'declined' ? 'Declined' : 'Pending'));
      }
      box.appendChild(c);
    });
    $('m-body').hidden = false;
  }
  function load() { return api('GET').then(render); }
  function decide(r, action) {
    msg('');
    if (action === 'decline' && !confirm('Decline ' + r.name + '?')) return;
    var keep = $('m-keep').checked;
    api('POST', { action: action, requestId: r.id, keepOpen: keep }).then(function (res) {
      return load().then(function () {
        if (action === 'accept') {
          banner(['You accepted ' + r.name + '!', 'We emailed you both each other’s contact info. You can reach them at ' + res.email + '.', keep ? 'Your listing is still up for more people.' : 'Your listing has been taken down.'], !keep);
        } else {
          banner('You declined ' + r.name + '. We let them know.');
        }
      });
    }).catch(function (e) { msg(e.message); });
  }
  $('m-close').onclick = function () {
    if (!confirm('Take your listing down? Anyone with a pending request won’t be able to get in touch through the site.')) return;
    api('POST', { action: 'close' }).then(load).then(function () { banner('Your listing has been taken down. Good luck at the event!', true); }).catch(function (e) { msg(e.message); });
  };
  if (!id || !token) { $('m-lede').textContent = 'This link isn’t valid. Use the private link from your email.'; return; }
  var isNew = sp.get('new') === '1';
  load().then(function () {
    if (isNew) {
      banner(['Your listing is live!', 'People can now send you a request, and we’ll email you when they do. Accept or decline requests right here. Bookmark this page, because it’s your private link and you’ll need it to take your listing down once you’ve found someone.']);
      history.replaceState(null, '', location.pathname + '?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(token));
    }
  }).catch(function (e) { $('m-lede').textContent = e.message; });
})();
