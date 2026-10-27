// Auth state. `session` = tenant session (user or platform admin inside a tenant), `admin` = platform admin login.
// Persisted in sessionStorage so a refresh keeps you signed in for the tab's lifetime (cleared on logout / tab close).
const KEY = 'pas.session.v1';
export const state = { session: null, admin: null };
const listeners = new Set();

export const onAuthChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach(fn => fn());

function persist() {
  try {
    if (!state.session && !state.admin) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify({ session: state.session, admin: state.admin }));
  } catch { /* storage unavailable (private mode) - session just won't survive a refresh */ }
}

export function loadStored() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (s) { state.session = s.session || null; state.admin = s.admin || null; }
  } catch { /* ignore */ }
}

export const mode = () => state.session ? 'tenant' : state.admin ? 'admin' : null;
export const isAdminViewingTenant = () => !!(state.session && state.admin);
export const can = (resource, action) => !!state.session && state.session.permissions?.[resource]?.[action] === true;

// Used on page reload: swap in a re-validated session (or drop it) without emitting an auth change.
export function replaceStoredSession(session) {
  state.session = session;
  if (!session) state.admin = null;
  persist();
}
export function setSession(session) { state.session = session; persist(); emit(); }
export function setAdmin(admin) { state.admin = admin; state.session = null; persist(); emit(); }
export function leaveTenant() { state.session = null; persist(); emit(); }
export function clearAuth() { state.session = null; state.admin = null; persist(); emit(); }
