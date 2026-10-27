// Sheet where a supplier's item prices are managed: only items the supplier can provide get a price.
import { h, icon, iconBtn, setChildren, sheet, toast, errText, day, money, emptyState } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';

export function openSupplierPrices(supplier) {
  const canAdd = can('supplierPrices', 'create'), canEdit = can('supplierPrices', 'update'), canDel = can('supplierPrices', 'delete');
  const body = h('div');
  const s = sheet({ title: `Prices • ${supplier.name}`, content: body, onClose: () => off() });
  const run = async (fn) => { try { await fn(); } catch (e) { toast(errText(e), 'error'); } };

  const draw = () => {
    const mine = store.supplierPrices.filter(p => p.supplierId === supplier.id)
      .map(p => ({ ...p, item: store.inventory.find(i => i.id === p.itemId) })).filter(p => p.item)
      .sort((a, b) => String(a.item.name).localeCompare(String(b.item.name)));
    const rows = mine.map(p => {
      const input = h('input', { class: 'input', type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: Number(p.price).toFixed(2), disabled: !canEdit, 'aria-label': `Price for ${p.item.name}` });
      return h('div', { class: 'price-row' },
        h('div', {}, h('div', { class: 'title' }, p.item.name), h('div', { class: 'sub muted small' }, 'updated ', day(p.updatedAt))), input,
        h('div', { class: 'tools row' },
          canEdit ? h('button', { class: 'btn sm soft', type: 'button', onclick: () => run(async () => { if (!can('supplierPrices', 'update')) throw new Error('No permission'); await core.setPrice(state.session, { supplierId: supplier.id, itemId: p.itemId, price: input.value }); toast('Price saved', 'success'); }) }, icon('check', 16), 'Save') : null,
          canDel ? iconBtn('trash', 'Remove price', () => run(async () => { if (!can('supplierPrices', 'delete')) throw new Error('No permission'); await core.removePrices(state.session, [p.id]); toast('Price removed'); }), 'danger') : null));
    });
    const free = store.inventory.filter(i => !mine.some(p => p.itemId === i.id));
    let add = null;
    if (canAdd && free.length) {
      const sel = h('select', { class: 'input', 'aria-label': 'Item to add' }, h('option', { value: '' }, 'Add an item…'), free.map(i => h('option', { value: i.id }, i.name)));
      const price = h('input', { class: 'input', type: 'number', step: '0.01', min: '0', inputmode: 'decimal', placeholder: 'Price', 'aria-label': 'Price' });
      add = h('div', { class: 'price-add' }, sel, price, h('button', { class: 'btn', type: 'button', onclick: () => {
        if (!sel.value) return toast('Choose an item first', 'error');
        run(async () => { if (!can('supplierPrices', 'create')) throw new Error('No permission'); await core.setPrice(state.session, { supplierId: supplier.id, itemId: sel.value, price: price.value }); toast('Price added', 'success'); });
      } }, icon('plus', 16), 'Add'));
    }
    setChildren(body,
      rows.length ? rows : emptyState('tag', 'No prices yet', 'Only add the items this supplier can actually provide.'),
      add,
      !store.inventory.length ? h('p', { class: 'muted small' }, 'Add inventory items first.') : null);
  };
  const off = onData(draw);
  draw();
  return s;
}

export const priceSummary = (o) => `${money(o.price)} • ${day(o.updatedAt)}`;
