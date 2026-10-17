(function () {
  var $ = function (id) { return document.getElementById(id); };
  var sid = new URLSearchParams(location.search).get('session_id');
  function line(k, v) { var p = document.createElement('p'); var b = document.createElement('strong'); b.textContent = k + ': '; p.appendChild(b); p.appendChild(document.createTextNode(v)); return p; }
  if (!sid) { $('s-title').textContent = 'No order found'; $('s-lede').textContent = 'Head back to the passes page to pick a competition.'; return; }
  var tries = 0;
  function check() {
    fetch('/api/order-status?session_id=' + encodeURIComponent(sid)).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (o) {
      if (o.status === 'paid') {
        $('s-title').textContent = 'You’re in, ' + o.name.split(' ')[0] + '!';
        $('s-lede').textContent = 'Your payment went through. A receipt is on its way to ' + o.email + '.';
        var c = $('s-card'); c.textContent = '';
        c.appendChild(line('Event', o.title));
        if (o.date) c.appendChild(line('Date', o.date + (o.endDate && o.endDate !== o.date ? ' to ' + o.endDate : '')));
        if (o.location) c.appendChild(line('Location', o.location));
        c.appendChild(line('Pass', o.passName)); c.appendChild(line('Paid', '$' + (o.amountCents / 100).toFixed(2)));
        c.hidden = false;
      } else if (o.status === 'pending' && tries++ < 10) {
        $('s-title').textContent = 'Confirming your payment…'; setTimeout(check, 2000);
      } else if (o.status === 'pending') {
        $('s-title').textContent = 'Almost there'; $('s-lede').textContent = 'We haven’t received confirmation yet. If you were charged, you’ll get an email shortly, or contact goldcoastcowboys@gmail.com.';
      } else {
        $('s-title').textContent = 'This order isn’t active'; $('s-lede').textContent = 'Status: ' + o.status + '. Questions? Email goldcoastcowboys@gmail.com.';
      }
    }).catch(function () { $('s-title').textContent = 'We couldn’t find that order'; $('s-lede').textContent = 'Email goldcoastcowboys@gmail.com and we’ll sort it out.'; });
  }
  check();
})();
