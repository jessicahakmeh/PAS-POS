// Customer detail sheet: contact info, branches, order stats and a print-statement action. Opened from the
// Customers list and from Reports (a leaderboard or a city/area drill-down) - wherever a customer's name is
// clicked, it lands here, so there is exactly one place that shows "everything about this customer".
import { h, icon, sheet, setChildren, money, emptyState } from '../ui.js';
import { can } from '../state.js';
import { store, onData } from '../data.js';
import { isInvoiced, salesNet, salesBalance, customerStatement } from '../../core.js';
import { branchLabel } from './branchEditor.js';
import { openStatement } from './statement.js';

const num = (v) => Number(v) || 0;
function stats(c) {
  const orders = store.salesOrders.filter(o => o.customerId === c.id && isInvoiced(o) && salesNet(o) > 0);
  const all = store.salesOrders.filter(o => o.customerId === c.id && isInvoiced(o));
  return { n: orders.length, spent: orders.reduce((t, o) => t + salesNet(o), 0), unpaid: all.reduce((t, o) => t + Math.max(0, salesBalance(o)), 0), credit: all.reduce((t, o) => t + Math.max(0, -salesBalance(o)), 0) };
}

// onEdit(customer)/onDelete(customer) are optional - pass them from a page that already has those actions (Customers)
// so this sheet can offer them too; omit them (e.g. from Reports) to show a read-only detail with just the statement.
export function openCustomerDetail(customer, { onEdit, onDelete } = {}) {
  const body = h('div'), actions = h('div', { style: 'display:flex;gap:10px;flex:1;flex-wrap:wrap' });
  const s = sheet({ title: customer.name, content: body, footer: [actions], onClose: () => off() });
  const draw = () => {
    const c = store.customers.find(x => x.id === customer.id) || customer;
    const st = stats(c);
    setChildren(body,
      h('dl', { class: 'kv' },
        h('dt', {}, 'Phone'), h('dd', {}, c.phone || '—'),
        h('dt', {}, 'Orders'), h('dd', {}, st.n),
        h('dt', {}, 'Total spent'), h('dd', {}, money(st.spent)),
        st.unpaid > 0.004 ? [h('dt', {}, 'Owed to you'), h('dd', { style: 'color:var(--warn)' }, money(st.unpaid))] : null,
        st.credit > 0.004 ? [h('dt', {}, 'Refund due'), h('dd', { style: 'color:var(--danger)' }, money(st.credit))] : null),
      h('div', { class: 'card', style: 'margin-top:10px' }, h('h3', {}, 'Branches'),
        (c.branches || []).length ? c.branches.map(b => h('div', { class: 'item' },
          h('div', { class: 'avatar' }, icon('building', 18)),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, branchLabel(b)),
            [b.city, b.area].filter(Boolean).length ? h('div', { class: 'sub' }, [b.city, b.area].filter(Boolean).join(', ')) : null,
            b.addressNote ? h('div', { class: 'sub' }, b.addressNote) : null),
          b.mapLink ? h('a', { class: 'btn sm soft', href: b.mapLink, target: '_blank', rel: 'noopener' }, icon('external', 14), 'Map') : null))
          : emptyState('building', 'No branches on file')));
    setChildren(actions,
      can('salesOrders', 'read') ? h('button', { class: 'btn soft', type: 'button', onclick: () => openStatement({
        title: c.name, subtitle: 'Customer statement', owedLabel: 'Owes you', creditLabel: 'You owe them', entries: customerStatement(store.salesOrders, c.id) }) }, icon('receipt', 16), 'Print statement') : null,
      onEdit && can('customers', 'update') ? h('button', { class: 'btn soft', type: 'button', onclick: () => { s.close(); onEdit(c); } }, icon('edit', 16), 'Edit') : null,
      onDelete && can('customers', 'delete') ? h('button', { class: 'btn danger-soft', type: 'button', onclick: () => onDelete(c) }, icon('trash', 16), 'Delete') : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Close'));
  };
  const off = onData(draw);
  draw();
  return s;
}
