// Statistics dashboard. Tenant view: stock, low stock (per-item alert level), suppliers, savings. Admin view: tenants overview.
import { h, icon, setChildren, statCard, barCard, money, emptyState, errText, skeletons } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { buildPriceReport, isLowStock, lowStockOf, salesSummary, wasteSummary, payableBalance, batchStatus, localDay, addDays, WASTE_REASONS } from '../../core.js';
import { daysLabel } from '../stock.js';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const greeting = () => { const hr = new Date().getHours(); return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };

function tenantDashboard(view) {
  const s = state.session;
  const box = h('div');
  view.append(h('div', { class: 'hero' }, h('h2', {}, `${greeting()}, ${s.username}`), h('p', {}, `${s.tenantId} • ${s.roleName}`)), box);

  const draw = () => {
    const cards = [], blocks = [];
    if (can('inventory', 'read')) {
      const items = store.inventory;
      const low = items.filter(isLowStock).sort((a, b) => num(a.qty) - num(b.qty));
      const value = items.reduce((t, i) => t + num(i.qty) * num(i.price), 0);
      cards.push(
        statCard({ icon: 'box', label: 'Items', value: items.length, href: '#/inventory' }),
        statCard({ icon: 'layers', label: 'Units in stock', value: items.reduce((t, i) => t + num(i.qty), 0), href: '#/inventory' }),
        statCard({ icon: 'dollar', label: 'Stock value', value: money(value), tone: 'gold', href: '#/inventory' }),
        statCard({ icon: 'alert', label: 'Low stock', value: low.length, tone: low.length ? 'red' : 'green', href: '#/inventory' }));
      if (low.length) blocks.push(h('div', { class: 'card' }, h('h3', {}, 'Low stock - reorder soon'),
        low.slice(0, 6).map(i => h('div', { class: 'bar-row', style: 'grid-template-columns:1fr auto' },
          h('span', { class: 'ellipsis' }, i.name), h('span', { class: 'bar-val' }, num(i.qty) <= 0 ? 'Out of stock' : `${num(i.qty)} left`, h('span', { class: 'muted small' }, ` / alert ≤ ${lowStockOf(i)}`)))),
        low.length > 6 ? h('a', { href: '#/inventory', class: 'small' }, `View all ${low.length}`) : null));
      blocks.push(barCard('Highest stock value', items.map(i => ({ label: i.name, value: num(i.qty) * num(i.price), text: money(num(i.qty) * num(i.price)) }))
        .filter(r => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 5)));
    }
    // Sales, expiry and waste (each block appears only if the role can read that resource)
    const ops = [];
    const today = localDay(), since = addDays(today, -30);
    if (can('salesOrders', 'read')) {
      const sm = salesSummary(store.salesOrders, since);
      ops.push(statCard({ icon: 'dollar', label: 'Revenue, 30 days', value: money(sm.revenue), tone: 'green', href: '#/sales' }),
        statCard({ icon: 'trend', label: 'Margin, 30 days', value: money(sm.margin), tone: 'green', href: '#/sales' }),
        statCard({ icon: 'cart', label: 'Open sales orders', value: sm.open, tone: sm.open ? 'gold' : '', href: '#/sales' }),
        statCard({ icon: 'alert', label: 'To collect', value: money(sm.unpaid), tone: sm.unpaid ? 'gold' : 'green', href: can('ledgers', 'read') ? '#/ledgers' : '#/sales' }),
        ...(sm.refundsDue > 0.004 ? [statCard({ icon: 'back', label: 'Refunds due', value: money(sm.refundsDue), tone: 'red', href: '#/sales' })] : []));
      blocks.push(barCard('Top sellers, 30 days', sm.top.slice(0, 5).map(t => ({ label: t.name, value: t.value, text: money(t.value) })), 'gold'));
    }
    if (can('batches', 'read')) {
      const active = store.batches.filter(b => num(b.qtyRemaining) > 0 && b.expiryDate).map(b => { const item = store.inventory.find(i => i.id === b.itemId); return { ...b, ...batchStatus(b, item) }; });
      const expired = active.filter(b => b.state === 'expired'), soon = active.filter(b => b.state === 'expiring').sort((a, b) => a.daysLeft - b.daysLeft);
      ops.push(statCard({ icon: 'alert', label: 'Expired batches', value: expired.length, tone: expired.length ? 'red' : 'green', href: '#/batches' }),
        statCard({ icon: 'clock', label: 'Expiring soon', value: soon.length, tone: soon.length ? 'gold' : 'green', href: '#/batches' }));
      if (expired.length || soon.length) blocks.unshift(h('div', { class: 'card' }, h('h3', {}, 'Expiry watch'),
        [...expired, ...soon].slice(0, 6).map(b => h('div', { class: 'bar-row', style: 'grid-template-columns:1fr auto' },
          h('span', { class: 'ellipsis' }, `${b.itemName}${b.lotNo ? ` • ${b.lotNo}` : ''}`),
          h('span', { class: 'bar-val', style: b.state === 'expired' ? 'color:var(--danger)' : 'color:var(--warn)' }, `${num(b.qtyRemaining)} • ${daysLabel(b.daysLeft)}`))),
        h('a', { href: '#/batches', class: 'small' }, 'Manage batches')));
    }
    if (can('waste', 'read')) {
      const w = wasteSummary(store.wasteLog, since);
      ops.push(statCard({ icon: 'trash', label: 'Waste, 30 days', value: money(w.value), tone: w.value ? 'red' : 'green', href: '#/batches' }));
      blocks.push(barCard('Waste by reason, 30 days', Object.entries(w.byReason).map(([r, v]) => ({ label: WASTE_REASONS[r] || r, value: v, text: money(v) })).sort((a, b) => b.value - a.value), 'warn'));
    }
    if (can('expenses', 'read')) {
      const exp = store.expenses.filter(e => (e.date || (e.at || '').slice(0, 10)) >= since);
      const total = round2(exp.reduce((t, e) => t + num(e.amount), 0));
      ops.push(statCard({ icon: 'minus', label: 'Expenses, 30 days', value: money(total), tone: total ? 'red' : 'green', href: '#/expenses' }));
      const byCat = {}; for (const e of exp) byCat[e.category] = round2((byCat[e.category] || 0) + num(e.amount));
      if (Object.keys(byCat).length) blocks.push(barCard('Expenses by category, 30 days', Object.entries(byCat).map(([c, v]) => ({ label: c, value: v, text: money(v) })).sort((a, b) => b.value - a.value).slice(0, 5), 'warn'));
    }
    if (can('purchaseOrders', 'read')) {
      const openPo = store.purchaseOrders.filter(o => ['ordered', 'partial'].includes(o.status));
      const owe = store.purchaseOrders.reduce((t, o) => t + Math.max(0, payableBalance(o)), 0);
      ops.push(statCard({ icon: 'receipt', label: 'Awaiting delivery', value: openPo.length, tone: openPo.length ? 'gold' : '', href: '#/purchases' }),
        statCard({ icon: 'alert', label: 'You owe suppliers', value: money(owe), tone: owe ? 'red' : 'green', href: can('ledgers', 'read') ? '#/ledgers' : '#/purchases' }));
    }
    const second = [];
    if (can('customers', 'read')) second.push(statCard({ icon: 'users', label: 'Customers', value: store.customers.length, href: '#/customers' }));
    if (can('suppliers', 'read')) second.push(statCard({ icon: 'truck', label: 'Suppliers', value: store.suppliers.length, href: '#/suppliers' }));
    if (can('users', 'read')) second.push(statCard({ icon: 'user', label: 'Users', value: store.users.length, href: '#/users' }));
    if (can('supplierPrices', 'read') && can('inventory', 'read') && can('suppliers', 'read')) {
      const { rows, unpriced } = buildPriceReport(store.inventory, store.suppliers, store.supplierPrices);
      second.push(statCard({ icon: 'tag', label: 'Items with supplier prices', value: `${rows.length} / ${store.inventory.length}`, tone: 'green', href: '#/prices' }));
      if (unpriced.length) second.push(statCard({ icon: 'alert', label: 'Items without a price', value: unpriced.length, tone: 'red', href: '#/prices' }));
      blocks.push(barCard('Best savings by choosing the cheapest supplier', rows.filter(r => r.saving > 0).sort((a, b) => b.saving - a.saving).slice(0, 5)
        .map(r => ({ label: r.itemName, value: r.saving, text: `${money(r.saving)} • ${r.cheapest[0].supplierName}` })), 'gold'));
      const wins = new Map();
      rows.forEach(r => r.cheapest.forEach(o => wins.set(o.supplierName, (wins.get(o.supplierName) || 0) + 1)));
      blocks.push(barCard('Cheapest supplier - items won', [...wins].map(([n, c]) => ({ label: n, value: c, text: `${c} item${c > 1 ? 's' : ''}` })).sort((a, b) => b.value - a.value).slice(0, 5)));
    }
    if (!cards.length && !second.length && !ops.length) return box.replaceChildren(emptyState('shield', 'No access yet', 'Your role has no permissions yet. Ask a tenant admin.'));
    setChildren(box, cards.length ? h('div', { class: 'stats' }, cards) : null, ops.length ? h('div', { class: 'stats' }, ops) : null, second.length ? h('div', { class: 'stats' }, second) : null, h('div', { class: 'grid-2' }, blocks.filter(Boolean)));
  };
  draw();
  return onData(draw);
}

function adminDashboard(view) {
  const box = h('div', {}, skeletons(3));
  view.append(h('div', { class: 'hero' }, h('h2', {}, `${greeting()}, ${state.admin.username}`), h('p', {}, 'Platform administrator')), box);
  let alive = true;
  core.listTenants(state.admin.adminKey).then(tenants => {
    if (!alive) return;
    const suspended = tenants.filter(t => t.status === 'suspended').length;
    box.replaceChildren(
      h('div', { class: 'stats' },
        statCard({ icon: 'building', label: 'Tenants', value: tenants.length, href: '#/tenants' }),
        statCard({ icon: 'check', label: 'Active', value: tenants.filter(t => t.status === 'active').length, tone: 'green', href: '#/tenants' }),
        statCard({ icon: 'pause', label: 'Suspended', value: suspended, tone: suspended ? 'red' : '', href: '#/tenants' }),
        statCard({ icon: 'users', label: 'Total users', value: tenants.reduce((t, x) => t + x.users, 0), tone: 'gold', href: '#/tenants' })),
      barCard('Users per tenant', tenants.map(t => ({ label: t.name, value: t.users, text: String(t.users) })).sort((a, b) => b.value - a.value).slice(0, 8)) || emptyState('building', 'No tenants yet', 'Open the Tenants page to create one.'));
  }).catch(e => alive && box.replaceChildren(emptyState('alert', 'Could not load tenants', errText(e))));
  return () => { alive = false; };
}

export default { mount: (view) => state.session ? tenantDashboard(view) : adminDashboard(view) };
