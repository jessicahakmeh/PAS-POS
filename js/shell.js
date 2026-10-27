// App shell: top bar, sidebar (desktop), bottom tab bar (phone), account sheet.
import { h, icon, iconBtn, initials, sheet, openForm, toast } from './ui.js';
import { state, can, isAdminViewingTenant, leaveTenant } from './state.js';
import { navRoutes } from './routes.js';
import { core } from './firebase.js';

const MAX_TABS = 5; // bottom bar shows up to 5 tabs; the 5th becomes "More" when there are more pages

export function renderShell(app, { onLogout }) {
  const routes = navRoutes();
  const link = (r, cls = '') => h('a', { href: '#/' + r.path, class: cls, dataset: { path: r.path } }, icon(r.icon, 22), h('span', {}, r.title));
  const who = state.session ? state.session.username : state.admin.username;
  const roleLine = state.session ? `${state.session.roleName} • ${state.session.tenantId}` : 'Platform admin';

  const tabs = routes.length > MAX_TABS ? routes.slice(0, MAX_TABS - 1) : routes;
  const more = routes.length > MAX_TABS ? routes.slice(MAX_TABS - 1) : [];
  const moreBtn = more.length ? h('button', { type: 'button', dataset: { path: '__more' }, onclick: () => openMore(more) }, icon('dots', 22), h('span', {}, 'More')) : null;

  const account = () => openAccount({ who, roleLine, onLogout });
  const banner = isAdminViewingTenant()
    ? h('div', { class: 'banner' }, icon('shield', 18), h('span', {}, 'Viewing ', h('b', {}, state.session.tenantId), ' as platform admin'),
        h('button', { class: 'btn sm accent', type: 'button', onclick: () => { leaveTenant(); location.hash = '#/dashboard'; } }, icon('back', 16), 'Console'))
    : null;

  const view = h('main', { id: 'view', class: 'view' });
  app.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('img', { src: 'PAS.jpeg', alt: '' }), 'PAS'),
      h('nav', {}, routes.map(r => link(r))),
      h('div', { class: 'foot' }, h('button', { class: 'item tap', type: 'button', style: 'width:100%;text-align:left', onclick: account },
        h('div', { class: 'avatar' }, initials(who)), h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, who), h('div', { class: 'sub ellipsis' }, roleLine))))),
    h('div', { class: 'main-col' },
      h('header', { class: 'topbar' }, h('img', { class: 'logo mobile-only', src: 'PAS.jpeg', alt: 'PAS' }), h('h1', { id: 'pageTitle', class: 'grow' }, 'PAS'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Account', title: who, onclick: account }, icon('user', 20))),
      banner, view,
      h('nav', { class: 'bottom-nav' }, tabs.map(r => link(r)), moreBtn))));
  return view;
}

// Pages reachable only from inside another page's section (nav: false in routes.js) light up that page's tab instead of none at all.
const NAV_PARENT = { batches: 'inventory', roles: 'users' };
export function setActiveNav(path, title) {
  const navPath = NAV_PARENT[path] || path;
  document.querySelectorAll('[data-path]').forEach(el => el.classList.toggle('active', el.dataset.path === navPath || (el.dataset.path === '__more' && el.dataset.inMore === navPath)));
  const moreEl = document.querySelector('[data-path="__more"]');
  if (moreEl) moreEl.classList.toggle('active', !document.querySelector('.bottom-nav a.active'));
  const t = document.getElementById('pageTitle'); if (t) t.textContent = title;
  document.title = `${title} • PAS`;
}

function openMore(more) {
  const s = sheet({ title: 'More', content: h('div', { class: 'list' }, more.map(r =>
    h('a', { class: 'item tap', href: '#/' + r.path, onclick: () => s.close() }, h('div', { class: 'avatar' }, icon(r.icon, 20)), h('div', { class: 'title grow' }, r.title), icon('chevron', 18)))) });
}

function openAccount({ who, roleLine, onLogout }) {
  const s = sheet({
    title: 'Account',
    content: h('div', { class: 'stack' },
      h('div', { class: 'item' }, h('div', { class: 'avatar' }, initials(who)), h('div', {}, h('div', { class: 'title' }, who), h('div', { class: 'sub' }, roleLine))),
      can('users', 'read') ? h('a', { class: 'btn soft block', href: '#/users', onclick: () => s.close() }, icon('user', 18), 'Manage users') : null,
      !state.session?.isPlatformAdmin ? h('button', { class: 'btn soft block', type: 'button', onclick: () => { s.close(); changePassword(); } }, icon('key', 18), 'Change password') : null,
      h('button', { class: 'btn danger-soft block', type: 'button', onclick: () => { s.close(); onLogout(); } }, icon('logout', 18), 'Log out')),
  });
}

function changePassword() {
  openForm({
    title: 'Change password',
    fields: [
      { name: 'oldPw', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'newPw', label: 'New password', type: 'password', required: true, help: 'At least 6 characters', autocomplete: 'new-password' },
    ],
    submitLabel: 'Change password',
    onSubmit: async (v) => {
      if (state.session) await core.changeOwnPassword(state.session, v.oldPw, v.newPw);
      else await core.changeAdminPassword(state.admin.username, v.oldPw, v.newPw);
      toast('Password changed', 'success');
    },
  });
}
