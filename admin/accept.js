import { api, authForm } from './common.js';
const token = new URLSearchParams(location.search).get('token') || '';
const msg = document.getElementById('invite-msg');
api('invite-info', { query: { token } }).then((info) => {
  msg.textContent = "You've been invited to manage Gold Coast Cowboys passes. Create your account below.";
  document.getElementById('fields').hidden = false;
  if (info.email) { const i = document.querySelector('input[name=email]'); i.value = info.email; i.readOnly = true; }
}).catch((e) => { msg.textContent = e.message; });
authForm((d) => api('accept', { method: 'POST', body: { ...d, token } }));
