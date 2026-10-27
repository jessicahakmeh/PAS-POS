// Suppliers: search, add/edit/delete, and per-supplier item prices (sheet).
import { h, icon, iconBtn, pageHead, searchBox, emptyState, fab, openForm, confirmDialog, toast, errText, day, money, norm, exportImportButton, skeletons } from '../ui.js';
import { fs, core, dataDoc, dataColl } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { payableBalance, supplierStatement } from '../../core.js';
import { openSupplierPrices } from '../components/pricesSheet.js';
import { openStatement } from '../components/statement.js';

function supplierForm(sup) {
  const editing = !!sup;
  openForm({
    title: editing ? `Edit ${sup.name}` : 'New supplier', submitLabel: editing ? 'Save changes' : 'Add supplier',
    fields: [
      { name: 'name', label: 'Supplier name', value: sup?.name, required: true },
      { name: 'contact', label: 'Contact (phone or email)', value: sup?.contact, placeholder: 'Optional' },
    ],
    onSubmit: async (v) => {
      const data = { name: v.name.trim(), contact: v.contact.trim() };
      if (editing) { if (!can('suppliers', 'update')) throw new Error('No permission'); await fs.updateDoc(dataDoc(state.session, 'suppliers', sup.id), data); toast('Supplier updated', 'success'); }
      else { if (!can('suppliers', 'create')) throw new Error('No permission'); await fs.addDoc(dataColl(state.session, 'suppliers'), { ...data, createdBy: state.session.username, createdAt: new Date().toISOString() }); toast('Supplier added', 'success'); }
    },
  });
}

function printStatement(sup) {
  openStatement({ title: sup.name, subtitle: 'Supplier statement', owedLabel: 'You owe', creditLabel: 'Supplier owes you', entries: supplierStatement(store.purchaseOrders, sup.id) });
}

async function deleteSupplier(sup) {
  if (!await confirmDialog({ title: `Delete ${sup.name}?`, message: 'Its item prices will be removed too. This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
  try {
    if (!can('suppliers', 'delete')) throw new Error('No permission');
    await fs.deleteDoc(dataDoc(state.session, 'suppliers', sup.id));
    await core.removePrices(state.session, store.supplierPrices.filter(p => p.supplierId === sup.id).map(p => p.id));
    toast('Supplier deleted');
  } catch (e) { toast(errText(e), 'error'); }
}

// Purchase history: orders placed with this supplier and how many are still open.
function orderBadges(s) {
  const pos = store.purchaseOrders.filter(o => o.supplierId === s.id && o.status !== 'cancelled' && o.status !== 'draft');
  const open = pos.filter(o => ['ordered', 'partial'].includes(o.status)).length;
  const owe = pos.reduce((t, o) => t + payableBalance(o), 0);
  return [h('span', { class: 'badge' }, `${pos.length} order${pos.length === 1 ? '' : 's'}`), open ? h('span', { class: 'badge warn' }, `${open} awaiting delivery`) : null,
    owe > 0.004 ? h('span', { class: 'badge bad' }, `You owe ${money(owe)}`) : owe < -0.004 ? h('span', { class: 'badge ok' }, `Credit ${money(-owe)}`) : null];
}

const contactLink = (c) => /@/.test(c) ? h('a', { class: 'sub', href: 'mailto:' + c }, icon('mail', 13), ' ', c)
  : /^[+\d][\d\s()-]{5,}$/.test(c) ? h('a', { class: 'sub', href: 'tel:' + c.replace(/[\s()-]/g, '') }, icon('phone', 13), ' ', c) : h('div', { class: 'sub' }, c);

// Import: one row = one supplier. Rows whose name matches an existing supplier (case-insensitive) are skipped.
async function importRows(rows) {
  if (!can('suppliers', 'create')) throw new Error('No permission');
  const pick = (row, ...keys) => { for (const k of Object.keys(row)) if (keys.some(x => norm(k.trim()) === norm(x))) return String(row[k] ?? '').trim(); return ''; };
  const existing = new Set(store.suppliers.map(s => norm(s.name)));
  const toAdd = []; let skipped = 0;
  for (const row of rows) {
    const name = pick(row, 'name', 'supplier name', 'supplier');
    if (!name || existing.has(norm(name))) { skipped++; continue; }
    existing.add(norm(name));
    toAdd.push({ name, contact: pick(row, 'contact', 'phone', 'email') });
  }
  if (!toAdd.length) return { created: 0, skipped };
  await core.importDocs(state.session, 'suppliers', toAdd.map(d => ({ ...d, createdBy: state.session.username, createdAt: new Date().toISOString() })));
  return { created: toAdd.length, skipped };
}

const sheetsFor = () => ({ Suppliers: [['Name', 'Contact', 'Items priced', 'Created by', 'Created at'],
  ...store.suppliers.map(r => [r.name, r.contact || '', store.supplierPrices.filter(p => p.supplierId === r.id).length, r.createdBy || '', day(r.createdAt)])] });

export default {
  mount(view) {
    let q = '';
    const canPrices = can('supplierPrices', 'read') && can('inventory', 'read');
    const list = h('div', { class: 'list two' });
    const draw = () => {
      if (!store.loaded.suppliers) return list.replaceChildren(...skeletons(3).children);
      const rows = store.suppliers.filter(s => !q || norm(s.name).includes(q) || norm(s.contact).includes(q));
      if (!rows.length) return list.replaceChildren(store.suppliers.length ? emptyState('search', 'No matching suppliers') : emptyState('truck', 'No suppliers yet', can('suppliers', 'create') ? 'Add a supplier, then set the prices for the items they provide.' : 'Nothing to show yet.'));
      list.replaceChildren(...rows.map(s => {
        const priced = store.supplierPrices.filter(p => p.supplierId === s.id && store.inventory.some(i => i.id === p.itemId)).length;
        return h('div', { class: 'item' },
          h('div', { class: 'avatar gold' }, icon('truck', 20)),
          h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, s.name), s.contact ? contactLink(s.contact) : h('div', { class: 'sub' }, 'No contact'),
            h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' },
              canPrices ? h('span', { class: 'badge brand' }, icon('tag', 12), `${priced} item${priced === 1 ? '' : 's'} priced`) : null,
              can('purchaseOrders', 'read') ? orderBadges(s) : null)),
          h('div', { class: 'tools' },
            canPrices ? iconBtn('tag', 'Manage prices', () => openSupplierPrices(s)) : null,
            can('purchaseOrders', 'read') ? iconBtn('receipt', 'Print statement of account', () => printStatement(s)) : null,
            can('suppliers', 'update') ? iconBtn('edit', 'Edit supplier', () => supplierForm(s)) : null,
            can('suppliers', 'delete') ? iconBtn('trash', 'Delete supplier', () => deleteSupplier(s), 'danger') : null));
      }));
    };
    view.append(pageHead('Suppliers', [exportImportButton({
      getSheets: sheetsFor, filenameBase: () => `${state.session.tenantId}-suppliers`, canImport: can('suppliers', 'create'),
      onImportRows: async (rows) => { const r = await importRows(rows); toast(`${r.created} supplier${r.created === 1 ? '' : 's'} imported${r.skipped ? `, ${r.skipped} skipped` : ''}`, r.created ? 'success' : 'error'); },
    })]),
      h('div', { class: 'toolbar' }, searchBox('Search suppliers', v => { q = norm(v.trim()); draw(); })),
      list, can('suppliers', 'create') ? fab('Add supplier', () => supplierForm(null)) : null);
    draw();
    return onData(draw);
  },
};
