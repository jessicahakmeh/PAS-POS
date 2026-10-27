// Live tenant data: one Firestore listener per readable collection, mirrored into `store`.
// Pages read `store` and call onData(cb) to redraw when anything changes (redraws are batched per frame).
import { fs, dataColl, dataDoc } from './firebase.js';
import { state, can } from './state.js';
import { DEFAULT_EXCHANGE_RATE, DEFAULT_EXPENSE_CATEGORIES } from '../core.js';

export const store = { inventory: [], customers: [], suppliers: [], supplierPrices: [], batches: [], wasteLog: [], salesOrders: [], purchaseOrders: [], expenses: [], roles: [], users: [],
  settings: { exchangeRate: DEFAULT_EXCHANGE_RATE, expenseCategories: DEFAULT_EXPENSE_CATEGORIES }, loaded: {} };
const listeners = new Set();
let unsubs = [];
let scheduled = false;

export const onData = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); });
}

export function stopData() {
  unsubs.forEach(u => u()); unsubs = [];
  Object.keys(store).forEach(k => { if (k === 'loaded') store.loaded = {}; else if (k === 'settings') store.settings = { exchangeRate: DEFAULT_EXCHANGE_RATE, expenseCategories: DEFAULT_EXPENSE_CATEGORIES }; else store[k] = []; });
  notify();
}

export function startData() {
  stopData();
  const s = state.session;
  if (!s) return;
  const plan = [
    ['inventory', 'name', can('inventory', 'read')],
    ['customers', 'name', can('customers', 'read')],
    ['suppliers', 'name', can('suppliers', 'read')],
    ['supplierPrices', null, can('supplierPrices', 'read')],
    ['batches', null, can('batches', 'read')],
    ['wasteLog', null, can('waste', 'read')],
    ['salesOrders', null, can('salesOrders', 'read')],
    ['purchaseOrders', null, can('purchaseOrders', 'read')],
    ['expenses', null, can('expenses', 'read')],
    ['roles', 'name', can('users', 'read') || can('users', 'create') || can('users', 'update') || can('roles', 'read')],
    ['users', 'username', can('users', 'read')],
  ];
  for (const [name, orderField, allowed] of plan) {
    if (!allowed) continue;
    const ref = dataColl(s, name);
    const q = orderField ? fs.query(ref, fs.orderBy(orderField)) : ref;
    unsubs.push(fs.onSnapshot(q, snap => {
      store[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      store.loaded[name] = true;
      notify();
    }, err => console.error('Snapshot error', name, err)));
  }
  // Exchange rate: a single doc, not a collection, and readable by every role (payments in any role need it to convert LBP).
  unsubs.push(fs.onSnapshot(dataDoc(s, 'meta', 'settings'), snap => {
    store.settings = { exchangeRate: DEFAULT_EXCHANGE_RATE, expenseCategories: DEFAULT_EXPENSE_CATEGORIES, ...(snap.exists() ? snap.data() : {}) };
    store.loaded.settings = true;
    notify();
  }, err => console.error('Snapshot error settings', err)));
}
