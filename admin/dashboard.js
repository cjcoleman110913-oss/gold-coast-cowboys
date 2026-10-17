import { api, el, money, setCsrf } from './common.js';

const $ = (id) => document.getElementById(id);
let pages = {};
let events = [];
let me = null;

function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.hidden = false; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000);
}
const fail = (e) => { if (e.status === 401) location.href = 'login.html'; else toast(e.message, true); };

const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dparts = (d) => { const p = d.split('-'); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; };
function range(a, b) {
  if (!a) return '';
  const s = dparts(a);
  if (!b || b === a) return `${MONTHS[s.m]} ${s.d}, ${s.y}`;
  const e = dparts(b);
  if (s.y === e.y && s.m === e.m) return `${MONTHS[s.m]} ${s.d}–${e.d}, ${s.y}`;
  return `${MONTHS[s.m]} ${s.d}${s.y === e.y ? '' : ', ' + s.y} – ${MONTHS[e.m]} ${e.d}, ${e.y}`;
}

async function init() {
  try { me = await api('me'); } catch { location.href = 'login.html'; return; }
  setCsrf(me.csrf); pages = me.events;
  $('who').textContent = me.admin.name;
  $('logout').onclick = async () => { await api('logout', { method: 'POST', body: {} }); location.href = 'login.html'; };
  $('f-event').replaceChildren(el('option', { value: '' }, 'None'), ...Object.entries(pages).map(([k, v]) => el('option', { value: k }, v)));
  document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  await loadEvents();
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
  if (name === 'buyers') loadBuyers();
  if (name === 'team') loadTeam();
}

// ---------- events ----------
async function loadEvents() {
  try { events = (await api('competitions')).competitions; } catch (e) { return fail(e); }
  const list = $('comp-list');
  if (!events.length) { list.replaceChildren(el('p', { class: 'empty' }, 'No events yet. Click “New event” to add the first one.')); return; }
  list.replaceChildren(...events.map(eventCard));
}

function eventCard(c) {
  const rows = c.passes.map((p) => el('tr', {},
    el('td', {}, p.name),
    el('td', {}, money(p.currentPriceCents),
      p.earlyActive ? el('small', {}, ` early-bird until ${fmt(p.earlyUntil)}`) : null,
      p.earlyPriceCents != null && !p.earlyActive ? el('small', {}, ' · early-bird ended') : null),
    el('td', {}, `${p.paid} sold` + (p.sold > p.paid ? ` + ${p.sold - p.paid} in checkout` : '')),
    el('td', {}, p.cap == null ? 'No limit' : `${p.cap} total · ${p.remaining} left`)));
  const meta = [range(c.date, c.endDate), c.location, [c.style, c.level].filter(Boolean).join(' · '),
    c.eventSlug ? 'on the ' + pages[c.eventSlug] + ' page' : ''].filter(Boolean).join(' · ');
  return el('article', { class: 'comp' + (c.active && !c.past ? '' : ' hidden-comp') },
    el('div', { class: 'comp-top' },
      el('div', {}, el('h3', {}, c.title, !c.active ? el('span', { class: 'badge' }, 'Hidden') : null, c.past ? el('span', { class: 'badge' }, 'Past') : null),
        el('p', { class: 'meta' }, meta)),
      el('div', { class: 'comp-actions' },
        el('button', { class: 'btn', onclick: () => openForm(c) }, 'Edit'),
        el('button', { class: 'btn', onclick: () => viewBuyers(c) }, 'Buyers'),
        el('button', { class: 'btn danger', onclick: () => del(c) }, 'Delete'))),
    c.description ? el('p', { class: 'desc' }, c.description) : null,
    el('table', { class: 'mini' }, el('thead', {}, el('tr', {}, ...['Pass', 'Price', 'Sales', 'Limit'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
}

async function del(c) {
  if (!confirm(`Delete “${c.title}”? This can't be undone.`)) return;
  try { await api('competition-delete', { method: 'POST', body: { id: c.id } }); toast('Deleted.'); loadEvents(); }
  catch (e) { fail(e); }
}

// ---------- event form ----------
function passRow(p = {}) {
  const row = el('div', { class: 'role-row', 'data-id': p.id || '' },
    el('label', { class: 'wide' }, 'Pass name', el('input', { name: 'name', required: true, maxlength: '80', value: p.name || '', placeholder: 'e.g. General Admission' })),
    el('label', {}, 'Role', (() => {
      const s = el('select', { name: 'role' }, el('option', { value: '' }, 'None'), el('option', { value: 'lead' }, 'Lead'), el('option', { value: 'follow' }, 'Follow'));
      s.value = p.role || ''; return s;
    })()),
    el('label', {}, 'Price ($)', el('input', { name: 'price', type: 'number', min: '0.5', step: '0.01', required: true, value: p.priceCents != null ? p.priceCents / 100 : '' })),
    el('label', {}, 'Limit', el('input', { name: 'cap', type: 'number', min: '0', step: '1', placeholder: 'No limit', value: p.cap ?? '' })),
    el('label', {}, 'Early-bird ($)', el('input', { name: 'earlyPrice', type: 'number', min: '0.5', step: '0.01', placeholder: 'None', value: p.earlyPriceCents != null ? p.earlyPriceCents / 100 : '' })),
    el('label', {}, 'Early-bird ends', el('input', { name: 'earlyUntil', type: 'datetime-local', value: toLocalInput(p.earlyUntil) })),
    el('button', { type: 'button', class: 'link-btn danger remove-pass', onclick: (e) => { e.target.closest('.role-row').remove(); } }, 'Remove'));
  return row;
}

const form = $('comp-form');
let editingId = null;
function openForm(c) {
  editingId = c?.id || null;
  $('form-title').textContent = c ? 'Edit event' : 'New event';
  form.reset(); $('form-err').hidden = true;
  const f = form.elements;
  f.title.value = c?.title || ''; f.date.value = c?.date || ''; f.endDate.value = c?.endDate || '';
  f.location.value = c?.location || ''; f.description.value = c?.description || '';
  f.style.value = c?.style || ''; f.level.value = c?.level || ''; f.eventSlug.value = c?.eventSlug || '';
  f.active.checked = c ? c.active : true;
  form.querySelector('details.more').open = !!(c && (c.style || c.level || c.eventSlug));
  $('role-rows').replaceChildren(...(c?.passes?.length ? c.passes : [{}]).map(passRow));
  form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('new-comp').onclick = () => openForm(null);
$('cancel-comp').onclick = () => { form.hidden = true; };
$('add-pass').onclick = () => $('role-rows').append(passRow());
$('add-leadfollow').onclick = () => {
  const have = [...document.querySelectorAll('.role-row [name=role]')].map((s) => s.value);
  if (!have.includes('lead')) $('role-rows').append(passRow({ name: 'Lead', role: 'lead' }));
  if (!have.includes('follow')) $('role-rows').append(passRow({ name: 'Follow', role: 'follow' }));
};
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('form-err'); err.hidden = true;
  const passes = [...document.querySelectorAll('.role-row')].map((row) => {
    const g = (n) => row.querySelector(`[name=${n}]`).value;
    return { id: row.dataset.id || null, name: g('name'), role: g('role'), price: g('price'), cap: g('cap'), earlyPrice: g('earlyPrice'),
      earlyUntil: g('earlyUntil') ? new Date(g('earlyUntil')).toISOString() : '' };
  });
  const f = form.elements;
  try {
    await api('competition-save', { method: 'POST', body: {
      id: editingId, title: f.title.value, date: f.date.value, endDate: f.endDate.value, location: f.location.value,
      description: f.description.value, style: f.style.value, level: f.level.value, eventSlug: f.eventSlug.value,
      active: f.active.checked, passes } });
    form.hidden = true; toast('Saved.'); await loadEvents();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; if (ex.status === 401) fail(ex); }
});

// ---------- buyers ----------
function viewBuyers(c) { showTab('buyers'); fillEvents(); $('b-comp').value = String(c.id); loadBuyers(); }
function fillEvents() {
  const cur = $('b-comp').value;
  $('b-comp').replaceChildren(el('option', { value: '' }, 'All events'), ...events.map((c) => el('option', { value: c.id }, c.title)));
  $('b-comp').value = cur;
}
$('b-comp').addEventListener('change', loadBuyers);
$('b-status').addEventListener('change', loadBuyers);
function buyerQuery() {
  const q = {};
  if ($('b-comp').value) q.competition = $('b-comp').value;
  if ($('b-status').value) q.status = $('b-status').value;
  return q;
}
async function loadBuyers() {
  fillEvents();
  try {
    const q = buyerQuery();
    const { orders } = await api('orders', { query: q });
    $('csv-link').href = '/api/admin/orders-csv?' + new URLSearchParams(q);
    const paid = orders.filter((o) => o.status === 'paid');
    $('b-summary').textContent = `${orders.length} order${orders.length === 1 ? '' : 's'} shown · ${paid.length} paid · ${money(paid.reduce((s, o) => s + o.amount_cents, 0))} collected`;
    $('b-table').tBodies[0].replaceChildren(...orders.map((o) => el('tr', {},
      el('td', {}, fmt(o.paid_at || o.created_at)), el('td', {}, o.buyer_name), el('td', {}, el('a', { href: 'mailto:' + o.email }, o.email)),
      el('td', {}, o.title), el('td', {}, o.pass_name || ''), el('td', {}, money(o.amount_cents)),
      el('td', {}, el('span', { class: 'status ' + o.status }, o.status)))));
    if (!orders.length) $('b-table').tBodies[0].replaceChildren(el('tr', {}, el('td', { colspan: 7, class: 'empty' }, 'No buyers match yet.')));
  } catch (e) { fail(e); }
}

// ---------- team ----------
async function loadTeam() {
  try {
    const [{ admins }, { invites }] = await Promise.all([api('admins'), api('invites')]);
    $('admin-list').replaceChildren(...admins.map((a) => el('li', {}, el('span', {}, `${a.name} · ${a.email}`),
      a.id === me.admin.id ? el('small', {}, ' (you)') : el('button', { class: 'link-btn danger', onclick: async () => {
        if (!confirm(`Remove ${a.name} as an admin?`)) return;
        try { await api('admin-remove', { method: 'POST', body: { id: a.id } }); loadTeam(); } catch (e) { fail(e); }
      } }, 'Remove'))));
    $('invite-list').replaceChildren(...(invites.length ? invites.map((i) => el('li', {},
      el('span', {}, `${i.email || 'Anyone with the link'} · expires ${fmt(i.expires_at)}`),
      el('button', { class: 'link-btn danger', onclick: async () => { await api('invite-revoke', { method: 'POST', body: { id: i.id } }); loadTeam(); } }, 'Revoke')))
      : [el('li', { class: 'empty' }, 'None')]));
  } catch (e) { fail(e); }
}
$('invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { link } = await api('invite-create', { method: 'POST', body: { email: e.target.elements.email.value } });
    $('invite-link').value = link; $('invite-out').hidden = false; e.target.reset(); loadTeam();
  } catch (ex) { fail(ex); }
});
$('copy-invite').onclick = async () => { $('invite-link').select(); try { await navigator.clipboard.writeText($('invite-link').value); toast('Copied.'); } catch { document.execCommand('copy'); } };

init();
