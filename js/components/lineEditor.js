// Order line editor used by sales and purchase orders.
// getOptions() -> [{ id, name, price, hint, max }]  (items that can be added; `max` caps the quantity, `hint` is shown under the name)
import { h, icon, iconBtn, money, toast } from '../ui.js';

export function lineEditor({ getOptions, emptyText = 'No items available.', onChange = () => {}, initial = [] }) {
  // { itemId, itemName, qty, unitPrice, hint, max }; `initial` lines (when editing a draft) pick up hint/max from the current options
  let lines = initial.map(l => { const o = getOptions().find(x => x.id === l.itemId); return { itemId: l.itemId, itemName: l.itemName, qty: l.qty, unitPrice: l.unitPrice, hint: o?.hint, max: o?.max }; });
  const list = h('div', { class: 'lines' });
  const total = h('b', {}, money(0));
  const sel = h('select', { class: 'input', 'aria-label': 'Item to add' });
  const qty = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: '1', inputmode: 'numeric', 'aria-label': 'Quantity' });
  const add = h('button', { class: 'btn soft', type: 'button' }, icon('plus', 16), 'Add');
  const addRow = h('div', { class: 'line-add' }, sel, qty, add);
  const node = h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Items'), list, addRow, h('div', { class: 'row', style: 'justify-content:space-between;padding-top:6px' }, h('span', { class: 'muted' }, 'Total'), total));

  const sum = () => lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const update = () => { total.textContent = money(sum()); onChange(); };

  function drawLines() {
    list.replaceChildren(...lines.map((l, i) => {
      const q = h('input', { class: 'input', type: 'number', min: '1', max: l.max ?? null, step: '1', value: l.qty, inputmode: 'numeric', 'aria-label': `Quantity of ${l.itemName}` });
      const p = h('input', { class: 'input', type: 'number', min: '0', step: '0.01', value: Number(l.unitPrice).toFixed(2), inputmode: 'decimal', 'aria-label': `Unit price of ${l.itemName}` });
      q.addEventListener('input', () => { l.qty = q.value; update(); });
      p.addEventListener('input', () => { l.unitPrice = p.value; update(); });
      return h('div', { class: 'line' },
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, l.itemName), l.hint ? h('div', { class: 'muted small' }, l.hint) : null),
        q, p, iconBtn('x', `Remove ${l.itemName}`, () => { lines.splice(i, 1); drawLines(); drawOptions(); update(); }, 'danger'));
    }));
    if (!lines.length) list.replaceChildren(h('p', { class: 'muted small', style: 'margin:0' }, 'No items added yet.'));
  }

  function drawOptions() {
    const free = getOptions().filter(o => !lines.some(l => l.itemId === o.id));
    sel.replaceChildren(h('option', { value: '' }, free.length ? 'Choose an item…' : emptyText), ...free.map(o => h('option', { value: o.id }, o.name + (o.hint ? ` — ${o.hint}` : ''))));
    addRow.classList.toggle('disabled', !free.length);
    add.disabled = !free.length;
  }

  add.addEventListener('click', () => {
    const o = getOptions().find(x => x.id === sel.value);
    if (!o) return toast('Choose an item first', 'error');
    const q = Math.max(1, Number(qty.value) || 1);
    lines.push({ itemId: o.id, itemName: o.name, qty: o.max != null ? Math.min(q, o.max) : q, unitPrice: Number(o.price) || 0, hint: o.hint, max: o.max });
    qty.value = '1'; drawLines(); drawOptions(); update();
  });

  drawLines(); drawOptions(); update();
  return {
    node,
    getLines: () => lines.map(l => ({ itemId: l.itemId, itemName: l.itemName, qty: Number(l.qty), unitPrice: Number(l.unitPrice) })),
    reset: () => { lines = []; drawLines(); drawOptions(); update(); },
    refresh: () => { drawOptions(); },
  };
}
