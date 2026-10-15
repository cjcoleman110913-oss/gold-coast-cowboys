import { api, authForm } from './common.js';
api('status').then((s) => {
  if (!s.needsSetup) location.href = 'login.html';
});
authForm((d) => api('setup', { method: 'POST', body: d }));
