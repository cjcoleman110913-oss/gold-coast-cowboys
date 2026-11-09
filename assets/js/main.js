document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      links.classList.toggle('open');
      toggle.textContent = links.classList.contains('open') ? '✕' : '☰';
    });
    links.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        links.classList.remove('open');
        toggle.textContent = '☰';
      });
    });
  }
});

// Newsletter pop-up: shown once each time someone opens the site (per browser session), not again once they've subscribed.
(function () {
  var skip = /pass-success|terms|listing-manage/.test(location.pathname);
  try { if (skip || localStorage.getItem('gcc-subscribed') || sessionStorage.getItem('gcc-popup-seen')) return; } catch (e) { if (skip) return; }
  setTimeout(function () {
    if (!window.HTMLDialogElement) return;
    var d = document.createElement('dialog');
    d.className = 'buy-dialog news-pop';
    d.innerHTML = '<button type="button" class="news-x" aria-label="Close">\u2715</button>' +
      '<img src="assets/img/gcc-logo.png?v=2" alt="Gold Coast Cowboys" class="news-logo">' +
      '<span class="eyebrow">Stay Up to Date</span>' +
      '<h2>Your Backstage Pass to the Country Dance World</h2>' +
      '<p>Get GCC news, exclusive announcements and upcoming events straight to your inbox.</p>' +
      '<form class="news-form"><input type="email" placeholder="Enter your email" required autocomplete="email">' +
      '<button type="submit" class="btn solid">Subscribe</button></form>' +
      '<p class="news-msg" role="status"></p>';
    document.body.appendChild(d);
    var msg = d.querySelector('.news-msg'), form = d.querySelector('form');
    d.querySelector('.news-x').onclick = function () { d.close(); };
    d.addEventListener('close', function () { d.remove(); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button'); btn.disabled = true; msg.textContent = '';
      fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.querySelector('input').value, source: 'popup' }) })
        .then(function (r) { if (!r.ok) throw 0; form.style.display = 'none'; msg.textContent = 'Thanks for subscribing! \u{1F920}';
          try { localStorage.setItem('gcc-subscribed', '1'); } catch (x) {} setTimeout(function () { d.close(); }, 2200); })
        .catch(function () { btn.disabled = false; msg.textContent = 'That didn\u2019t go through. Check your email and try again.'; });
    });
    try { sessionStorage.setItem('gcc-popup-seen', '1'); } catch (e) {}
    d.showModal();
  }, 2500);
})();
