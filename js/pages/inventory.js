// Inventory: search, filters, quick quantity stepper, per-item low-stock alert level, Excel export.
import { h, icon, iconBtn, pageHead, searchBox, chipGroup, emptyState, fab, openForm, confirmDialog, toast, errText, money, day, norm, exportImportButton, skeletons } from '../ui.js';
import { fs, core, dataDoc, dataColl } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { isLowStock, lowStockOf, DEFAULT_LOW_STOCK, expiryAlertOf, DEFAULT_EXPIRY_ALERT_DAYS, stockPosition, localDay } from '../../core.js';
import { expiryOverview, batchesOf, daysLabel } from '../stock.js';
import { openWriteOff } from '../components/writeOff.js';

const num = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

function itemForm(item) {
  const editing = !!item;
  openForm({
    title: editing ? `Edit ${item.name}` : 'New item',
    submitLabel: editing ? 'Save changes' : 'Add item',
    fields: [
      { name: 'name', label: 'Item name', value: item?.name, required: true, placeholder: 'e.g. Bolt M8' },
      { name: 'qty', label: 'Quantity in stock', type: 'number', min: 0, step: 1, inputMode: 'numeric', value: item ? num(item.qty) : '', required: true },
      { name: 'price', label: 'Price', type: 'number', min: 0, step: '0.01', inputMode: 'decimal', value: item ? num(item.price) : '', required: true },
      { name: 'lowStock', label: 'Low-stock alert level', type: 'number', min: 0, step: 1, inputMode: 'numeric', value: item ? lowStockOf(item) : DEFAULT_LOW_STOCK,
        help: `Alert when quantity is at or below this number (default ${DEFAULT_LOW_STOCK}).` },
      { name: 'perishable', label: 'Perishable (has expiry dates)', type: 'switch', value: !!item?.perishable, help: 'Food and other items that expire. Receiving stock then requires an expiry date.' },
      { name: 'expiryAlertDays', label: 'Expiry alert (days before)', type: 'number', min: 0, step: 1, inputMode: 'numeric', value: item ? expiryAlertOf(item) : DEFAULT_EXPIRY_ALERT_DAYS,
        help: `Flag batches this many days before they expire (default ${DEFAULT_EXPIRY_ALERT_DAYS}).` },
    ],
    onSubmit: async (v) => {
      const data = { name: v.name.trim(), qty: num(v.qty), price: num(v.price), lowStock: v.lowStock === '' ? DEFAULT_LOW_STOCK : Math.max(0, num(v.lowStock, DEFAULT_LOW_STOCK)),
        perishable: !!v.perishable, expiryAlertDays: v.expiryAlertDays === '' ? DEFAULT_EXPIRY_ALERT_DAYS : Math.max(0, num(v.expiryAlertDays, DEFAULT_EXPIRY_ALERT_DAYS)) };
      if (data.qty < 0 || data.price < 0) throw new Error('Quantity and price cannot be negative');
      if (editing) {
        const batched = stockPosition(item, batchesOf(item.id), localDay()).batched;
        if (data.qty < batched) throw new Error(`Quantity can't be below ${batched}, the stock held in batches. Use Write off in Batches to remove stock.`);
      }
      if (editing) {
        if (!can('inventory', 'update')) throw new Error('No permission');
        const { qty: newQty, ...rest } = data;   // quantity changes go through the stock ledger
        await fs.updateDoc(dataDoc(state.session, 'inventory', item.id), rest);
        if (newQty !== num(item.qty)) await core.adjustStock(state.session, item.id, { newQty, note: 'Edited in inventory' });
        toast('Item updated', 'success');
      } else {
        if (!can('inventory', 'create')) throw new Error('No permission');
        await core.createItem(state.session, data);   // opening quantity is logged in the stock ledger
        toast('Item added', 'success');
      }
    },
  });
}

async function deleteItem(item) {
  const ok = await confirmDialog({ title: `Delete ${item.name}?`, message: 'Its supplier prices and batches will be removed too. This cannot be undone.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    if (!can('inventory', 'delete')) throw new Error('No permission');
    await fs.deleteDoc(dataDoc(state.session, 'inventory', item.id));
    await core.removePrices(state.session, store.supplierPrices.filter(p => p.itemId === item.id).map(p => p.id));
    await core.removeDocs(state.session, 'batches', store.batches.filter(b => b.itemId === item.id).map(b => b.id));
    toast('Item deleted');
  } catch (e) { toast(errText(e), 'error'); }
}

// Manual +/- only touches unbatched stock: it can't drop below what is held in batches (use Write off for that).
const adjust = (item, delta) => {
  const batched = stockPosition(item, batchesOf(item.id), localDay()).batched;
  const next = num(item.qty) + delta;
  if (next < batched) return toast(`${batched} units are held in batches. Use Write off in Batches to remove them.`, 'error');
  return core.adjustStock(state.session, item.id, { delta, note: 'Quick adjust (+/-)' }).catch(e => toast(errText(e), 'error'));
};

// Import: one row = one item. Rows whose name matches an existing item (case-insensitive) are skipped.
async function importRows(rows) {
  if (!can('inventory', 'create')) throw new Error('No permission');
  const pick = (row, ...keys) => { for (const k of Object.keys(row)) if (keys.some(x => norm(k.trim()) === norm(x))) return String(row[k] ?? '').trim(); return ''; };
  const existing = new Set(store.inventory.map(i => norm(i.name)));
  const toAdd = []; let skipped = 0;
  for (const row of rows) {
    const name = pick(row, 'name', 'item name', 'item');
    if (!name || existing.has(norm(name))) { skipped++; continue; }
    existing.add(norm(name));
    const truthy = (s) => /^(y|yes|true|1)$/i.test(s.trim());
    toAdd.push({
      name, qty: num(pick(row, 'quantity', 'qty') || 0), price: num(pick(row, 'price') || 0),
      lowStock: pick(row, 'low-stock alert at', 'low stock', 'lowstock') ? num(pick(row, 'low-stock alert at', 'low stock', 'lowstock')) : DEFAULT_LOW_STOCK,
      perishable: truthy(pick(row, 'perishable')),
      expiryAlertDays: pick(row, 'expiry alert (days)', 'expiry alert') ? num(pick(row, 'expiry alert (days)', 'expiry alert')) : DEFAULT_EXPIRY_ALERT_DAYS,
    });
  }
  if (!toAdd.length) return { created: 0, skipped };
  await core.importDocs(state.session, 'inventory', toAdd.map(d => ({ ...d, createdBy: state.session.username, createdAt: new Date().toISOString() })));
  return { created: toAdd.length, skipped };
}

export function sheetsFor() {
  return { Inventory: [['Name', 'Quantity', 'Price', 'Low-stock alert at', 'Low stock?', 'Perishable', 'Expiry alert (days)', 'Created by', 'Created at'],
    ...store.inventory.map(r => [r.name, num(r.qty), num(r.price), lowStockOf(r), isLowStock(r) ? 'Yes' : '', r.perishable ? 'Yes' : '', r.perishable ? expiryAlertOf(r) : '', r.createdBy || '', day(r.createdAt)])] };
}

export default {
  mount(view) {
    let q = '', filter = 'all';
    const list = h('div', { class: 'list two' });
    const draw = () => {
      if (!store.loaded.inventory) return list.replaceChildren(...skeletons(3).children);
      const rows = store.inventory.filter(i => (!q || norm(i.name).includes(q)) &&
        (filter === 'all' || (filter === 'low' && isLowStock(i) && num(i.qty) > 0) || (filter === 'out' && num(i.qty) <= 0)));
      if (!rows.length) return list.replaceChildren(store.inventory.length
        ? emptyState('search', 'No matching items', 'Try another search or filter.')
        : emptyState('box', 'No items yet', can('inventory', 'create') ? 'Add your first item to start tracking stock.' : 'Nothing to show yet.'));
      list.replaceChildren(...rows.map(item => {
        const qty = num(item.qty), low = isLowStock(item), out = qty <= 0;
        const batched = stockPosition(item, batchesOf(item.id), localDay()).batched, ex = item.perishable ? expiryOverview(item) : null;
        return h('div', { class: 'item', style: 'flex-wrap:wrap' },
          h('div', { class: 'avatar ' + (out ? 'red' : low ? 'gold' : '') }, icon('box', 20)),
          h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, item.name), h('div', { class: 'sub' }, money(item.price), ' each • value ', money(qty * num(item.price)))),
          h('div', { class: 'tools' },
            can('inventory', 'update') ? iconBtn('edit', 'Edit item', () => itemForm(item)) : null,
            can('waste', 'create') && qty - batched > 0 ? iconBtn('alert', 'Write off unbatched stock', () => openWriteOff({ item, max: qty - batched })) : null,
            can('inventory', 'delete') ? iconBtn('trash', 'Delete item', () => deleteItem(item), 'danger') : null),
          h('div', { style: 'flex-basis:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px dashed var(--line)' },
            h('div', { class: 'row' }, out ? h('span', { class: 'badge bad' }, icon('alert', 12), 'Out of stock') : low ? h('span', { class: 'badge warn' }, icon('alert', 12), 'Low stock') : h('span', { class: 'badge ok' }, 'In stock'),
              h('span', { class: 'muted small' }, `alert ≤ ${lowStockOf(item)}`),
              can('batches', 'read') && batchesOf(item.id).some(b => num(b.qtyRemaining) > 0)
                ? h('button', { class: 'badge brand', type: 'button', style: 'border:0;cursor:pointer', 'aria-label': `Show batches of ${item.name}`, onclick: () => { location.hash = '#/batches?q=' + encodeURIComponent(item.name); } },
                    icon('clock', 12), `${batchesOf(item.id).filter(b => num(b.qtyRemaining) > 0).length} batch${batchesOf(item.id).filter(b => num(b.qtyRemaining) > 0).length > 1 ? 'es' : ''}`) : null,
              ex && ex.state === 'expired' ? h('span', { class: 'badge bad' }, icon('clock', 12), `${ex.expired} expired batch${ex.expired > 1 ? 'es' : ''}`)
                : ex && ex.state === 'expiring' ? h('span', { class: 'badge warn' }, icon('clock', 12), 'Expiring soon')
                : ex && ex.soonest ? h('span', { class: 'muted small' }, `next expiry ${daysLabel(ex.soonest.daysLeft)}`) : null),
            can('inventory', 'update')
              ? h('div', { class: 'stepper' }, iconBtn('minus', batched >= qty && batched > 0 ? 'Stock is held in batches: use Write off in Batches' : 'Decrease quantity', () => adjust(item, -1)), h('span', { class: 'qty' }, qty), iconBtn('plus', 'Increase quantity', () => adjust(item, 1)))
              : h('b', {}, `${qty} in stock`)));
      }));
    };
    view.append(
      pageHead('Inventory', [
        can('batches', 'read') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { location.hash = '#/batches'; } }, icon('clock', 16), 'Batches') : null,
        exportImportButton({
          getSheets: sheetsFor, filenameBase: () => `${state.session.tenantId}-inventory`, canImport: can('inventory', 'create'),
          onImportRows: async (rows) => { const r = await importRows(rows); toast(`${r.created} item${r.created === 1 ? '' : 's'} imported${r.skipped ? `, ${r.skipped} skipped` : ''}`, r.created ? 'success' : 'error'); },
        })]),
      h('div', { class: 'toolbar' }, searchBox('Search items', v => { q = norm(v.trim()); draw(); }),
        chipGroup([{ value: 'all', label: 'All' }, { value: 'low', label: 'Low stock' }, { value: 'out', label: 'Out of stock' }], filter, v => { filter = v; draw(); })),
      list, can('inventory', 'create') ? fab('Add item', () => itemForm(null)) : null);
    draw();
    return onData(draw);
  },
};
