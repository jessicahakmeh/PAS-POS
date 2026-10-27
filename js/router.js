// Hash router (#/inventory). Pages are lazy-loaded ES modules: { mount(view) -> optional cleanup }.
import { h, skeletons, appendKids } from './ui.js';
import { mode } from './state.js';
import { visibleRoutes } from './routes.js';
import { setActiveNav } from './shell.js';

let cleanup = null;
let token = 0;

export async function renderRoute() {
  const path = (location.hash.replace(/^#\/?/, '').split(/[?/]/)[0]) || 'dashboard';
  const route = visibleRoutes().find(r => r.path === path);
  if (!route) { if (mode()) location.replace('#/dashboard'); return; }
  const view = document.getElementById('view');
  if (!view) return;
  const my = ++token;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  view.replaceChildren(skeletons(4));
  setActiveNav(route.path, route.title);
  try {
    const mod = await route.load();
    if (my !== token) return; // navigated away while loading
    view.replaceChildren();
    view.append = (...kids) => appendKids(view, ...kids); // pages may pass null (e.g. a permission-gated button): skip instead of printing "null"
    view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
    cleanup = mod.default.mount(view) || null;
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    view.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Something went wrong'), h('p', {}, 'Could not load this page. Please refresh.')));
  }
}

window.addEventListener('hashchange', () => { if (mode()) renderRoute(); });
