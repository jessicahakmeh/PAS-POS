// Route registry: add a feature = add a page module in js/pages/ + one line here.
// modes: 'tenant' (a user, or the platform admin inside a tenant) and/or 'admin' (platform console).
// nav: false keeps a page out of the sidebar/bottom-nav/More menu (it stays reachable by its own hash and by an
// in-page link) - used for pages that belong inside another page's section rather than getting their own tab.
import { can, mode } from './state.js';

export const routes = [
  { path: 'dashboard', title: 'Dashboard', icon: 'home', modes: ['tenant', 'admin'], load: () => import('./pages/dashboard.js') },
  { path: 'tenants', title: 'Tenants', icon: 'building', modes: ['admin'], load: () => import('./pages/tenants.js') },
  { path: 'sales', title: 'Sales', icon: 'cart', modes: ['tenant'], can: () => can('salesOrders', 'read') && can('inventory', 'read'), load: () => import('./pages/sales.js') },
  { path: 'inventory', title: 'Inventory', icon: 'box', modes: ['tenant'], can: () => can('inventory', 'read'), load: () => import('./pages/inventory.js') },
  { path: 'batches', title: 'Batches', icon: 'clock', modes: ['tenant'], nav: false, can: () => can('batches', 'read') && can('inventory', 'read'), load: () => import('./pages/batches.js') },
  { path: 'purchases', title: 'Purchases', icon: 'receipt', modes: ['tenant'], can: () => can('purchaseOrders', 'read') && can('suppliers', 'read') && can('inventory', 'read'), load: () => import('./pages/purchases.js') },
  { path: 'expenses', title: 'Expenses', icon: 'minus', modes: ['tenant'], can: () => can('expenses', 'read'), load: () => import('./pages/expenses.js') },
  { path: 'reports', title: 'Reports', icon: 'trend', modes: ['tenant'], can: () => can('reports', 'read') && can('salesOrders', 'read'), load: () => import('./pages/reports.js') },
  { path: 'ledgers', title: 'Ledgers', icon: 'book', modes: ['tenant'], can: () => can('ledgers', 'read') && can('inventory', 'read'), load: () => import('./pages/ledgers.js') },
  { path: 'customers', title: 'Customers', icon: 'users', modes: ['tenant'], can: () => can('customers', 'read'), load: () => import('./pages/customers.js') },
  { path: 'suppliers', title: 'Suppliers', icon: 'truck', modes: ['tenant'], can: () => can('suppliers', 'read'), load: () => import('./pages/suppliers.js') },
  { path: 'prices', title: 'Prices', icon: 'tag', modes: ['tenant'], can: () => can('supplierPrices', 'read') && can('inventory', 'read') && can('suppliers', 'read'), load: () => import('./pages/prices.js') },
  { path: 'users', title: 'Users', icon: 'user', modes: ['tenant'], nav: false, can: () => can('users', 'read'), load: () => import('./pages/users.js') },
  { path: 'roles', title: 'Roles', icon: 'shield', modes: ['tenant'], nav: false, can: () => can('roles', 'read'), load: () => import('./pages/roles.js') },
];

// All routable pages the current user/mode can reach (used by the router to match a hash, whether or not the page has its own nav entry).
export const visibleRoutes = () => routes.filter(r => r.modes.includes(mode()) && (!r.can || r.can()));
// The subset shown in the sidebar/bottom-nav/More menu.
export const navRoutes = () => visibleRoutes().filter(r => r.nav !== false);
