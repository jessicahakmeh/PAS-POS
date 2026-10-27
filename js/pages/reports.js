// Reports: drill-down statistics on top of the same live data other pages use - revenue/sales, customer
// distribution by city or area, a top-customers leaderboard and a most-returns warning list. Read-only, all client-side.
// Every list here is capped at the top 10, and every customer name is clickable through to their full detail.
import { h, icon, pageHead, chipGroup, statCard, barCard, money, exportXlsx, setChildren, emptyState, sheet } from '../ui.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { isInvoiced, salesNet, salesSummary, incomeStatement, localDay, addDays } from '../../core.js';
import { openCustomerDetail } from '../components/customerDetail.js';

const num = (v) => Number(v) || 0;
const TOP_N = 10; // leaderboards and distribution charts never show more than this - a business owner needs the highlights, not a spreadsheet

// One row per customer that has at least one fulfilled order: revenue (net of returns), margin, order count and
// how much they've returned. Walk-in sales are grouped together under a single "Walk-in customers" row (no
// underlying customer record, so it can't be clicked through to a detail sheet).
function perCustomerStats() {
  const map = new Map();
  for (const o of store.salesOrders) {
    if (!isInvoiced(o)) continue;
    const id = o.customerId || null;
    const key = id || '__walkin';
    const cur = map.get(key) || { id, name: o.customerName || 'Walk-in customer', revenue: 0, margin: 0, orders: 0, returned: 0 };
    cur.revenue += salesNet(o); cur.margin += (num(o.total) - num(o.returnedValue)) - (num(o.cost) - num(o.returnedCost)); cur.orders += 1; cur.returned += num(o.returnedValue);
    map.set(key, cur);
  }
  return [...map.values()];
}

// Groups customers by their first branch's city or area (customers with no branches fall into "Unspecified").
function customersByField(field) {
  const groups = new Map();
  for (const c of store.customers) {
    const raw = (c.branches || [])[0]?.[field]?.trim();
    const key = raw || 'Unspecified';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()].map(([label, customers]) => ({ label, customers, value: customers.length, text: `${customers.length} customer${customers.length === 1 ? '' : 's'}` }))
    .sort((a, b) => b.value - a.value);
}

// A clickable customer name -> opens the shared detail sheet (read-only here: no edit/delete, those belong to the Customers page).
function openCustomer(entry) {
  const c = entry.id && store.customers.find(x => x.id === entry.id);
  if (!c) return; // walk-in sales have no customer record to show
  openCustomerDetail(c);
}

// The list of customers behind one city/area bar.
function openGroupList(label, field, customers) {
  const rows = customers.map(c => h('button', { class: 'item tap', type: 'button', style: 'width:100%;text-align:left', onclick: () => { openCustomerDetail(c); } },
    h('div', { class: 'avatar' }, icon('users', 18)),
    h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, c.name), c.phone ? h('div', { class: 'sub' }, c.phone) : null),
    icon('chevron', 18)));
  sheet({ title: label, content: rows.length ? h('div', { class: 'list' }, rows) : emptyState('users', 'No customers') });
}

export default {
  mount(view) {
    let tab = 'overview', groupBy = 'city';
    const stats = h('div', { class: 'stats' }), tabs = h('div'), body = h('div');

    const draw = () => {
      setChildren(tabs, chipGroup([{ value: 'overview', label: 'Overview' }, { value: 'revenue', label: 'Revenue' }, { value: 'customers', label: 'Customers' }], tab, v => { tab = v; draw(); }));
      const cust = perCustomerStats();

      if (tab === 'overview') {
        const sm = salesSummary(store.salesOrders, '0000-00-00');
        const pnl = can('expenses', 'read') ? incomeStatement(store.salesOrders, store.expenses, null, null) : null;
        const stockValue = store.inventory.reduce((t, i) => t + num(i.qty) * num(i.price), 0);
        setChildren(stats,
          statCard({ icon: 'dollar', label: 'Revenue, all time', value: money(sm.revenue), tone: 'green' }),
          statCard({ icon: 'trend', label: 'Margin, all time', value: money(sm.margin), tone: 'green' }),
          statCard({ icon: 'cart', label: 'Orders', value: sm.orders }),
          statCard({ icon: 'dollar', label: 'Avg order value', value: money(sm.orders ? sm.revenue / sm.orders : 0) }),
          statCard({ icon: 'users', label: 'Customers', value: store.customers.length }),
          statCard({ icon: 'truck', label: 'Suppliers', value: store.suppliers.length }),
          statCard({ icon: 'box', label: 'Stock value', value: money(stockValue), tone: 'gold' }),
          pnl ? statCard({ icon: 'minus', label: 'Net profit, all time', value: money(pnl.netProfit), tone: pnl.netProfit >= 0 ? 'green' : 'red' }) : null);
        return setChildren(body, h('div', { class: 'grid-2' },
          barCard('Top sellers, all time', sm.top.slice(0, TOP_N).map(t => ({ label: t.name, value: t.value, text: money(t.value) })), 'gold'),
          barCard(`Top ${TOP_N} customers, all time`, [...cust].sort((a, b) => b.revenue - a.revenue).slice(0, TOP_N)
            .map(c => ({ label: c.name, value: c.revenue, text: money(c.revenue), onclick: c.id ? () => openCustomer(c) : null })))));
      }

      if (tab === 'revenue') {
        setChildren(stats);
        // Revenue by month, last 6 months.
        const uniqMonths = [...new Set(Array.from({ length: 6 }, (_, i) => addDays(localDay(), -30 * (5 - i)).slice(0, 7)))];
        const byMonth = uniqMonths.map(m => {
          const rev = store.salesOrders.filter(o => isInvoiced(o) && (o.fulfilledAt || '').slice(0, 7) === m).reduce((t, o) => t + salesNet(o), 0);
          return { label: m, value: rev, text: money(rev) };
        });
        const sheets = () => ({ Revenue: [['Month', 'Revenue'], ...byMonth.map(r => [r.label, r.value])] });
        return setChildren(body,
          h('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:8px' },
            h('button', { class: 'btn soft sm', type: 'button', onclick: () => exportXlsx(`${state.session.tenantId}-revenue-report-${localDay()}.xlsx`, sheets()) }, icon('download', 16), 'Export')),
          barCard('Revenue by month (last 6 months)', byMonth, 'green'),
          barCard(`Top ${TOP_N} sellers, all time`, salesSummary(store.salesOrders, '0000-00-00').top.slice(0, TOP_N).map(t => ({ label: t.name, value: t.value, text: money(t.value) })), 'gold'));
      }

      // Customers: distribution by city or area (switchable), a leaderboard, and a most-returns warning list.
      const groups = customersByField(groupBy);
      const leaders = [...cust].sort((a, b) => b.revenue - a.revenue).filter(c => c.revenue > 0).slice(0, TOP_N);
      const warned = [...cust].sort((a, b) => b.returned - a.returned).filter(c => c.returned > 0.004).slice(0, TOP_N);
      setChildren(stats,
        statCard({ icon: 'building', label: `${groupBy === 'city' ? 'Cities' : 'Areas'} covered`, value: groups.length }),
        statCard({ icon: 'users', label: 'Customers with sales', value: cust.filter(c => c.id).length }),
        statCard({ icon: 'alert', label: 'Customers with returns', value: warned.length, tone: warned.length ? 'gold' : 'green' }));
      setChildren(body,
        h('div', { class: 'row', style: 'justify-content:space-between;align-items:center;margin-bottom:-4px' },
          h('h3', { style: 'margin:0' }, 'Customers by location'),
          chipGroup([{ value: 'city', label: 'City' }, { value: 'area', label: 'Area' }], groupBy, v => { groupBy = v; draw(); })),
        barCard(`By ${groupBy}`, groups.slice(0, TOP_N).map(g => ({ ...g, onclick: () => openGroupList(g.label, groupBy, g.customers) })), 'brand'),
        h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, `Top ${TOP_N} customers (leaderboard)`),
          leaders.length ? leaders.map((c, i) => h(c.id ? 'button' : 'div', {
            class: 'bar-row' + (c.id ? ' tap' : ''), type: c.id ? 'button' : null, onclick: c.id ? () => openCustomer(c) : null,
            style: `grid-template-columns:auto 1fr auto;${c.id ? 'width:100%;text-align:left;background:none;border:0;cursor:pointer;font:inherit;color:inherit' : ''}` },
            h('b', { class: 'muted' }, `#${i + 1}`), h('span', { class: 'ellipsis' }, c.name), h('span', { class: 'bar-val' }, money(c.revenue), ' ', h('span', { class: 'muted small' }, `(${c.orders} order${c.orders === 1 ? '' : 's'})`))))
            : emptyState('users', 'No sales yet')),
        h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Most returns (watch list)'),
          warned.length ? warned.map(c => h(c.id ? 'button' : 'div', {
            class: 'bar-row' + (c.id ? ' tap' : ''), type: c.id ? 'button' : null, onclick: c.id ? () => openCustomer(c) : null,
            style: `grid-template-columns:1fr auto;${c.id ? 'width:100%;text-align:left;background:none;border:0;cursor:pointer;font:inherit;color:inherit' : ''}` },
            h('span', { class: 'ellipsis' }, c.name), h('span', { class: 'bar-val', style: 'color:var(--danger)' }, money(c.returned))))
            : h('p', { class: 'muted small' }, 'No customer has significant returns.')));
    };

    view.append(pageHead('Reports'), stats, tabs, body);
    draw();
    return onData(draw);
  },
};
