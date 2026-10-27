// Customers: search, add/edit/delete, branches (locations), tap-to-call, Excel export/import.
import { h, icon, iconBtn, pageHead, searchBox, emptyState, fab, sheet, confirmDialog, toast, errText, day, money, norm, initials, exportImportButton, skeletons, badge, setChildren } from '../ui.js';
import { fs, core, dataDoc, dataColl } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { isInvoiced, salesNet, salesBalance, customerStatement } from '../../core.js';
import { branchEditor, branchLabel } from '../components/branchEditor.js';
import { openStatement } from '../components/statement.js';
import { openCustomerDetail } from '../components/customerDetail.js';

function customerForm(c) {
  const editing = !!c;
  const nameInput = h('input', { class: 'input', value: c?.name || '', placeholder: 'Customer name', required: true });
  const phoneInput = h('input', { class: 'input', type: 'tel', inputmode: 'tel', value: c?.phone || '', placeholder: 'Phone (optional)' });
  const editor = branchEditor(c?.branches || []);
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const go = h('button', { class: 'btn', type: 'button' }, editing ? 'Save changes' : 'Add customer');
  const s = sheet({
    title: editing ? `Edit ${c.name}` : 'New customer',
    content: h('div', { class: 'form' }, err,
      h('div', { class: 'field' }, h('label', {}, 'Customer name *'), nameInput),
      h('div', { class: 'field' }, h('label', {}, 'Phone'), phoneInput),
      editor.node),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    err.classList.add('hidden');
    if (!nameInput.value.trim()) { err.textContent = 'Customer name is required'; err.classList.remove('hidden'); return; }
    go.disabled = true;
    try {
      const data = { name: nameInput.value.trim(), phone: phoneInput.value.trim(), branches: editor.getBranches() };
      if (editing) { if (!can('customers', 'update')) throw new Error('No permission'); await fs.updateDoc(dataDoc(state.session, 'customers', c.id), data); toast('Customer updated', 'success'); }
      else { if (!can('customers', 'create')) throw new Error('No permission'); await fs.addDoc(dataColl(state.session, 'customers'), { ...data, createdBy: state.session.username, createdAt: new Date().toISOString() }); toast('Customer added', 'success'); }
      s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); }
    finally { go.disabled = false; }
  });
}

function openBranches(c) {
  const rows = (c.branches || []).map(b => h('div', { class: 'item' },
    h('div', { class: 'avatar' }, icon('building', 18)),
    h('div', { class: 'grow' }, h('div', { class: 'title' }, branchLabel(b)),
      [b.city, b.area].filter(Boolean).length ? h('div', { class: 'sub' }, [b.city, b.area].filter(Boolean).join(', ')) : null,
      b.addressNote ? h('div', { class: 'sub' }, b.addressNote) : null),
    b.mapLink ? h('a', { class: 'btn sm soft', href: b.mapLink, target: '_blank', rel: 'noopener' }, icon('external', 14), 'Map') : null));
  sheet({ title: `Branches • ${c.name}`, content: rows.length ? h('div', { class: 'list' }, rows) : emptyState('building', 'No branches', 'Edit this customer to add locations.') });
}

function printStatement(c) {
  openStatement({ title: c.name, subtitle: 'Customer statement', owedLabel: 'Owes you', creditLabel: 'You owe them', entries: customerStatement(store.salesOrders, c.id) });
}

async function deleteCustomer(c) {
  if (!await confirmDialog({ title: `Delete ${c.name}?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
  try { if (!can('customers', 'delete')) throw new Error('No permission'); await fs.deleteDoc(dataDoc(state.session, 'customers', c.id)); toast('Customer deleted'); } catch (e) { toast(errText(e), 'error'); }
}

const num = (v) => Number(v) || 0;
// Purchase history from sales orders (fulfilled, not returned): number of orders, total spent, and what is still unpaid.
function stats(c) {
  const orders = store.salesOrders.filter(o => o.customerId === c.id && isInvoiced(o) && salesNet(o) > 0);
  const all = store.salesOrders.filter(o => o.customerId === c.id && isInvoiced(o));
  return { n: orders.length, spent: orders.reduce((t, o) => t + salesNet(o), 0), unpaid: all.reduce((t, o) => t + Math.max(0, salesBalance(o)), 0), credit: all.reduce((t, o) => t + Math.max(0, -salesBalance(o)), 0) };
}
const history = (c) => {
  if (!can('salesOrders', 'read')) return null;
  const s = stats(c);
  return h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' }, badge(s.n ? `${s.n} order${s.n > 1 ? 's' : ''} • ${money(s.spent)}` : 'No orders yet', s.n ? 'brand' : ''), s.unpaid ? badge(`${money(s.unpaid)} owed`, 'warn') : null, s.credit ? badge(`${money(s.credit)} refund due`, 'bad') : null);
};

const sheetsFor = () => ({ Customers: [['Name', 'Phone', 'Branches', 'Orders', 'Total spent', 'Unpaid', 'Created by', 'Created at'],
  ...store.customers.map(r => { const s = stats(r); return [r.name, r.phone || '', (r.branches || []).map(branchLabel).join('; '), s.n, s.spent, s.unpaid, r.createdBy || '', day(r.createdAt)]; })] });

// Import: one row = one customer, with at most one branch (City/Area/Map link/Address description columns).
// Rows whose name matches an existing customer (case-insensitive) are skipped.
async function importRows(rows) {
  if (!can('customers', 'create')) throw new Error('No permission');
  const pick = (row, ...keys) => { for (const k of Object.keys(row)) if (keys.some(x => norm(k.trim()) === norm(x))) return String(row[k] ?? '').trim(); return ''; };
  const existing = new Set(store.customers.map(c => norm(c.name)));
  let skipped = 0;
  const toAdd = [];
  for (const row of rows) {
    const name = pick(row, 'name', 'customer name', 'customer');
    if (!name) { skipped++; continue; }
    if (existing.has(norm(name))) { skipped++; continue; }
    existing.add(norm(name));
    const city = pick(row, 'city'), area = pick(row, 'area', 'area / neighbourhood'), mapLink = pick(row, 'map link', 'google maps link', 'maps link'), addressNote = pick(row, 'address description', 'address', 'addressnote');
    const branchName = pick(row, 'branch name', 'branch');
    const branches = (city || area || mapLink || addressNote || branchName) ? [{ id: 'b' + Math.random().toString(36).slice(2, 9), name: branchName, city, area, mapLink, addressNote }] : [];
    toAdd.push({ name, phone: pick(row, 'phone'), branches });
  }
  if (!toAdd.length) return { created: 0, skipped };
  await core.importDocs(state.session, 'customers', toAdd.map(c => ({ ...c, createdBy: state.session.username, createdAt: new Date().toISOString() })));
  return { created: toAdd.length, skipped };
}

export default {
  mount(view) {
    let q = '';
    const list = h('div', { class: 'list two' });
    const draw = () => {
      if (!store.loaded.customers) return list.replaceChildren(...skeletons(3).children);
      const rows = store.customers.filter(c => !q || norm(c.name).includes(q) || norm(c.phone).includes(q) || (c.branches || []).some(b => norm(branchLabel(b)).includes(q)));
      if (!rows.length) return list.replaceChildren(store.customers.length ? emptyState('search', 'No matching customers') : emptyState('users', 'No customers yet', can('customers', 'create') ? 'Add your first customer.' : 'Nothing to show yet.'));
      list.replaceChildren(...rows.map(c => h('div', { class: 'item' },
        h('div', { class: 'avatar' }, initials(c.name)),
        h('div', { class: 'grow' },
          h('button', { class: 'title ellipsis', type: 'button', style: 'border:0;background:none;padding:0;text-align:left;cursor:pointer;font:inherit;color:inherit;display:block', onclick: () => openCustomerDetail(c, { onEdit: customerForm, onDelete: deleteCustomer }) }, c.name),
          c.phone ? h('a', { class: 'sub', href: 'tel:' + c.phone.replace(/\s+/g, '') }, icon('phone', 13), ' ', c.phone) : h('div', { class: 'sub' }, 'No phone'),
          (c.branches || []).length ? h('button', { class: 'badge brand', type: 'button', style: 'border:0;cursor:pointer;margin-top:6px', onclick: () => openBranches(c) }, icon('building', 12), `${c.branches.length} branch${c.branches.length > 1 ? 'es' : ''}`) : null,
          history(c)),
        h('div', { class: 'tools' },
          can('salesOrders', 'read') ? iconBtn('receipt', 'Print statement of account', () => printStatement(c)) : null,
          can('customers', 'update') ? iconBtn('edit', 'Edit customer', () => customerForm(c)) : null,
          can('customers', 'delete') ? iconBtn('trash', 'Delete customer', () => deleteCustomer(c), 'danger') : null))));
    };
    view.append(pageHead('Customers', [exportImportButton({
      getSheets: sheetsFor, filenameBase: () => `${state.session.tenantId}-customers`, canImport: can('customers', 'create'),
      onImportRows: async (rows) => { const r = await importRows(rows); toast(`${r.created} customer${r.created === 1 ? '' : 's'} imported${r.skipped ? `, ${r.skipped} skipped` : ''}`, r.created ? 'success' : 'error'); },
    })]),
      h('div', { class: 'toolbar' }, searchBox('Search customers or branches', v => { q = norm(v.trim()); draw(); })),
      list, can('customers', 'create') ? fab('Add customer', () => customerForm(null)) : null);
    draw();
    return onData(draw);
  },
};
