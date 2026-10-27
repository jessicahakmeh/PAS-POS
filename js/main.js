// Entry point: restores the session, renders login or the shell, and reacts to auth changes.
import { core } from './firebase.js';
import { state, mode, loadStored, onAuthChange, clearAuth, replaceStoredSession } from './state.js';
import { startData, stopData } from './data.js';
import { renderShell } from './shell.js';
import { renderRoute } from './router.js';
import { renderLogin } from './pages/login.js';

const app = document.getElementById('app');
let shellKey = null; // identifies the current shell so it is only rebuilt when the auth context changes

function render() {
  const m = mode();
  if (!m) { shellKey = null; stopData(); renderLogin(app); return; }
  const key = m + ':' + (state.session?.tenantId || '') + ':' + (state.session?.username || state.admin?.username);
  if (key !== shellKey) {
    shellKey = key;
    renderShell(app, { onLogout: clearAuth });
    if (state.session) startData(); else stopData();
    if (!location.hash || location.hash === '#') location.hash = '#/dashboard';
  }
  renderRoute();
}

// Login, logout, entering/leaving a tenant: always start from the dashboard.
onAuthChange(() => { shellKey = null; location.hash = '#/dashboard'; render(); });

(async function boot() {
  loadStored();
  // A reloaded tenant session is re-validated (user still enabled, tenant active, fresh permissions).
  if (state.session && !state.session.isPlatformAdmin) {
    try { replaceStoredSession(await core.refreshSession(state.session)); }
    catch (e) { console.error('Session refresh failed', e); }
  }
  render();
})();
