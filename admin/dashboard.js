import { api, el, money, setCsrf } from './common.js';

const $ = (id) => document.getElementById(id);
let events = {};
let competitions = [];
let me = null;

function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.hidden = false; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000);
}
const fail = (e) => { if (e.status === 401) location.href = 'login.html'; else toast(e.message, true); };

// local datetime <-> ISO
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const roleLabel = { lead: 'Lead', follow: 'Follow', any: 'Open' };

async function init() {
  try { me = await api('me'); } catch { location.href = 'login.html'; return; }
  setCsrf(me.csrf); events = me.events;
  $('who').textContent = me.admin.name;
  $('logout').onclick = async () => { await api('logout', { method: 'POST', body: {} }); location.href = 'login.html'; };
  $('f-event').replaceChildren(el('option', { value: '' }, 'No specific event'), ...Object.entries(events).map(([k, v]) => el('option', { value: k }, v)));
  document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  await loadCompetitions();
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
  if (name === 'buyers') loadBuyers();
  if (name === 'team') loadTeam();
}

// ---------- competitions ----------
async function loadCompetitions() {
  try { competitions = (await api('competitions')).competitions; } catch (e) { return fail(e); }
  const list = $('comp-list');
  if (!competitions.length) { list.replaceChildren(el('p', { class: 'empty' }, 'No competitions yet. Click “New competition” to add the first one.')); return; }
  const groups = {};
  for (const c of competitions) (groups[c.eventSlug || ''] ||= []).push(c);
  list.replaceChildren(...Object.entries(groups).map(([slug, items]) =>
    el('div', { class: 'group' }, el('h2', {}, slug ? (events[slug] || slug) : 'Not tied to an event'), ...items.map(compCard))));
}

function compCard(c) {
  const rows = c.passes.map((p) => el('tr', {},
    el('td', {}, roleLabel[p.role]),
    el('td', {}, p.earlyActive ? `${money(p.currentPriceCents)} (early, until ${fmt(p.earlyUntil)})` : money(p.currentPriceCents),
      p.earlyPriceCents != null && !p.earlyActive ? el('small', {}, ' · early-bird ended') : null),
    el('td', {}, `${p.paid} sold` + (p.sold > p.paid ? ` + ${p.sold - p.paid} in checkout` : '')),
    el('td', {}, p.cap == null ? 'No limit' : `${p.cap} total · ${p.remaining} left`)));
  return el('article', { class: 'comp' + (c.active ? '' : ' hidden-comp') },
    el('div', { class: 'comp-top' },
      el('div', {}, el('h3', {}, c.title, c.active ? null : el('span', { class: 'badge' }, 'Hidden')),
        el('p', { class: 'meta' }, `${c.style} · ${c.level}`)),
      el('div', { class: 'comp-actions' },
        el('button', { class: 'btn', onclick: () => openForm(c) }, 'Edit'),
        el('button', { class: 'btn', onclick: () => viewBuyers(c) }, 'Buyers'),
        el('button', { class: 'btn danger', onclick: () => del(c) }, 'Delete'))),
    c.description ? el('p', { class: 'desc' }, c.description) : null,
    el('table', { class: 'mini' }, el('thead', {}, el('tr', {}, ...['Pass', 'Price', 'Sales', 'Limit'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
}

async function del(c) {
  if (!confirm(`Delete “${c.title}”? This can't be undone.`)) return;
  try { await api('competition-delete', { method: 'POST', body: { id: c.id } }); toast('Deleted.'); loadCompetitions(); }
  catch (e) { fail(e); }
}

function roleRow(role, p = {}) {
  const row = el('div', { class: 'role-row', 'data-role': role },
    el('strong', {}, roleLabel[role] + ' pass'),
    el('label', {}, 'Price ($)', el('input', { name: 'price', type: 'number', min: '0.5', step: '0.01', required: true, value: p.priceCents != null ? p.priceCents / 100 : '' })),
    el('label', {}, 'Limit', el('input', { name: 'cap', type: 'number', min: '0', step: '1', placeholder: 'No limit', value: p.cap ?? '' })),
    el('label', {}, 'Early-bird ($)', el('input', { name: 'earlyPrice', type: 'number', min: '0.5', step: '0.01', placeholder: 'None', value: p.earlyPriceCents != null ? p.earlyPriceCents / 100 : '' })),
    el('label', {}, 'Early-bird ends', el('input', { name: 'earlyUntil', type: 'datetime-local', value: toLocalInput(p.earlyUntil) })));
  return row;
}
function renderRoleRows(mode, existing = []) {
  const roles = mode === 'any' ? ['any'] : ['lead', 'follow'];
  $('role-rows').replaceChildren(...roles.map((r) => roleRow(r, existing.find((p) => p.role === r))));
}

const form = $('comp-form');
let editingId = null;
function openForm(c) {
  editingId = c?.id || null;
  $('form-title').textContent = c ? 'Edit competition' : 'New competition';
  form.reset(); $('form-err').hidden = true;
  $('f-event').value = c ? (c.eventSlug || '') : '';
  for (const k of ['title', 'style', 'level', 'description']) form.elements[k].value = c?.[k] || '';
  form.elements.active.checked = c ? c.active : true;
  const mode = c && c.passes.some((p) => p.role === 'any') ? 'any' : 'roles';
  form.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === mode; });
  renderRoleRows(mode, c?.passes || []);
  form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('new-comp').onclick = () => openForm(null);
$('cancel-comp').onclick = () => { form.hidden = true; };
form.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => renderRoleRows(r.value)));
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('form-err'); err.hidden = true;
  const passes = [...document.querySelectorAll('.role-row')].map((row) => {
    const g = (n) => row.querySelector(`[name=${n}]`).value;
    return { role: row.dataset.role, price: g('price'), cap: g('cap'), earlyPrice: g('earlyPrice'),
      earlyUntil: g('earlyUntil') ? new Date(g('earlyUntil')).toISOString() : '' };
  });
  const f = form.elements;
  try {
    await api('competition-save', { method: 'POST', body: {
      id: editingId, eventSlug: f.eventSlug.value, title: f.title.value, style: f.style.value, level: f.level.value,
      description: f.description.value, active: f.active.checked, passes } });
    form.hidden = true; toast('Saved.'); await loadCompetitions();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; if (ex.status === 401) fail(ex); }
});

// ---------- buyers ----------
function viewBuyers(c) {
  showTab('buyers'); $('b-event').value = c.eventSlug || 'none'; fillComps(); $('b-comp').value = String(c.id); loadBuyers();
}
function fillComps() {
  const ev = $('b-event').value;
  $('b-comp').replaceChildren(el('option', { value: '' }, 'All competitions'),
    ...competitions.filter((c) => !ev || (ev === 'none' ? !c.eventSlug : c.eventSlug === ev)).map((c) => el('option', { value: c.id }, `${c.title} (${c.level})`)));
}
$('b-event').replaceChildren(el('option', { value: '' }, 'All events'));
$('b-event').addEventListener('change', () => { fillComps(); loadBuyers(); });
$('b-comp').addEventListener('change', loadBuyers);
$('b-status').addEventListener('change', loadBuyers);
function buyerQuery() {
  const q = {};
  if ($('b-event').value) q.event = $('b-event').value;
  if ($('b-comp').value) q.competition = $('b-comp').value;
  if ($('b-status').value) q.status = $('b-status').value;
  return q;
}
async function loadBuyers() {
  if ($('b-event').options.length === 1) {
    $('b-event').append(...Object.entries(events).map(([k, v]) => el('option', { value: k }, v)), el('option', { value: 'none' }, 'No specific event'));
    fillComps();
  }
  try {
    const q = buyerQuery();
    const { orders } = await api('orders', { query: q });
    $('csv-link').href = '/api/admin/orders-csv?' + new URLSearchParams(q);
    const paid = orders.filter((o) => o.status === 'paid');
    $('b-summary').textContent = `${orders.length} order${orders.length === 1 ? '' : 's'} shown · ${paid.length} paid · ${money(paid.reduce((s, o) => s + o.amount_cents, 0))} collected`;
    $('b-table').tBodies[0].replaceChildren(...orders.map((o) => el('tr', {},
      el('td', {}, fmt(o.paid_at || o.created_at)), el('td', {}, o.buyer_name), el('td', {}, el('a', { href: 'mailto:' + o.email }, o.email)),
      el('td', {}, `${o.title} (${o.level})`), el('td', {}, roleLabel[o.role]), el('td', {}, money(o.amount_cents)),
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
