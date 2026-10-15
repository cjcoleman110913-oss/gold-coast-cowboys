import { api, authForm } from './common.js';
api('me').then(() => { location.href = 'index.html'; }).catch(() => {});
api('status').then((s) => { if (s.needsSetup) document.getElementById('setup-link').hidden = false; });
authForm((d) => api('login', { method: 'POST', body: d }));
