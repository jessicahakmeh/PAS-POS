// Purchase cycle: order from a supplier (only items they price, at their price) -> receive into batches (expiry/lot) -> stock + price list updated.
import { h, icon, pageHead, searchBox, chipGroup, emptyState, fab, sheet, toast, errText, statCard, money, day, norm, exportButton, skeletons, setChildren, switchRow, badge, confirmDialog } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { PURCHASE_STATUS, suggestReorders, payableBalance, receivedValue, paidTotalOf } from '../../core.js';
import { itemById } from '../stock.js';
import { lineEditor } from '../components/lineEditor.js';
import { paymentsBlock, openPaymentForm } from '../components/payments.js';

const num = (v) => Number(v) || 0;
const TONE = { draft: '', ordered: 'brand', partial: 'warn', received: 'ok', closed: 'warn', cancelled: 'bad' };
const outstanding = (po) => po.lines.reduce((t, l) => t + Math.max(0, num(l.qty) - num(l.received)) * num(l.unitPrice), 0);

function purchaseForm(existing = null) {
  if (!store.suppliers.length) return toast('Add a supplier first', 'error');
  const sup = h('select', { class: 'input', 'aria-label': 'Supplier' }, h('option', { value: '' }, 'Choose a supplier…'), ...store.suppliers.map(s => h('option', { value: s.id }, s.name)));
  const offersFor = (supplierId) => store.supplierPrices.filter(p => p.supplierId === supplierId && itemById(p.itemId));
  const editor = lineEditor({
    initial: existing?.lines,
    emptyText: 'No priced items for this supplier',
    getOptions: () => offersFor(sup.value).map(p => {
      const item = itemById(p.itemId);
      const cheaper = store.supplierPrices.filter(x => x.itemId === p.itemId && x.supplierId !== sup.value && num(x.price) < num(p.price)).sort((a, b) => num(a.price) - num(b.price))[0];
      const other = cheaper && store.suppliers.find(s => s.id === cheaper.supplierId);
      return { id: item.id, name: item.name, price: p.price, hint: other ? `cheaper at ${other.name} (${money(cheaper.price)})` : `${money(p.price)}` };
    }),
  });
  if (existing) { sup.value = existing.supplierId; sup.disabled = true; editor.refresh(); }
  sup.addEventListener('change', () => editor.reset());
  const note = h('input', { class: 'input', placeholder: 'Optional note', 'aria-label': 'Note', value: existing?.note || '' });
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const draftBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Save draft'), goBtn = h('button', { class: 'btn', type: 'button' }, 'Place order');
  const s = sheet({
    title: existing ? 'Edit ' + existing.number : 'New purchase order',
    content: h('div', { class: 'form' }, err, h('div', { class: 'field' }, h('label', {}, 'Supplier *'), sup,
      h('div', { class: 'help' }, 'Only items this supplier has a price for can be ordered (set prices under Suppliers).')), editor.node, h('div', { class: 'field' }, h('label', {}, 'Note'), note)),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), existing ? null : draftBtn, goBtn],
  });
  if (existing) goBtn.textContent = 'Save changes';
  async function submit(status) {
    err.classList.add('hidden'); draftBtn.disabled = goBtn.disabled = true;
    try {
      if (!can('purchaseOrders', 'create')) throw new Error('No permission');
      const supplier = store.suppliers.find(x => x.id === sup.value);
      if (existing) {
        await core.updateDraftOrder(state.session, 'purchaseOrders', existing.id, { lines: editor.getLines(), note: note.value.trim(), supplierId: supplier?.id, supplierName: supplier?.name || '' });
        toast(existing.number + ' updated', 'success'); s.close(); return;
      }
      const res = await core.createPurchaseOrder(state.session, { supplierId: supplier?.id, supplierName: supplier?.name || '', lines: editor.getLines(), note: note.value.trim(), status });
      toast(`${res.number} ${status === 'draft' ? 'saved as draft' : 'placed'}`, 'success'); s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); }
    finally { draftBtn.disabled = goBtn.disabled = false; }
  }
  draftBtn.addEventListener('click', () => submit('draft'));
  goBtn.addEventListener('click', () => submit('ordered'));
}

// Receive stock: each outstanding line can arrive as several batches (own quantity, expiry date and lot each).
function receiveForm(po) {
  const rows = po.lines.map((l, index) => ({ l, index, left: num(l.qty) - num(l.received), item: itemById(l.itemId) })).filter(r => r.left > 0);
  const canPrice = can('supplierPrices', 'update') || can('supplierPrices', 'create');
  const upd = switchRow('Update supplier price list', 'Save the prices on this order as the supplier\'s latest prices', canPrice);
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const ui = rows.map(r => {
    const batches = [], list = h('div', { class: 'stack' }), total = h('span', { class: 'small' });
    const refresh = () => {
      const t = batches.reduce((s, b) => s + num(b.qty.value), 0);
      total.textContent = `Receiving ${t} of ${r.left}`; total.style.color = t > r.left ? 'var(--danger)' : 'var(--muted)';
    };
    const addBatch = (qtyValue) => {
      const qty = h('input', { class: 'input', type: 'number', min: '0', max: r.left, step: '1', value: qtyValue, inputmode: 'numeric', 'aria-label': `Received quantity for ${r.l.itemName}` });
      const exp = h('input', { class: 'input', type: 'date', 'aria-label': `Expiry date for ${r.l.itemName}` });
      const lot = h('input', { class: 'input', placeholder: 'Lot no.', 'aria-label': `Lot number for ${r.l.itemName}` });
      qty.addEventListener('input', refresh);
      const entry = { qty, exp, lot };
      const remove = batches.length ? h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Remove batch', onclick: () => { batches.splice(batches.indexOf(entry), 1); entry.node.remove(); refresh(); } }, icon('x', 16)) : h('span');
      entry.node = h('div', { class: 'three' }, h('label', {}, batches.length ? `Batch ${batches.length + 1} qty` : 'Received', qty), h('label', {}, r.item?.perishable ? 'Expiry *' : 'Expiry', exp), h('label', {}, 'Lot', lot), remove);
      batches.push(entry); list.append(entry.node); refresh();
    };
    addBatch(r.left);
    const more = h('button', { class: 'btn soft sm', type: 'button', onclick: () => addBatch(0) }, icon('plus', 14), 'Add another batch');
    return { r, batches, node: h('div', { class: 'receive-line' },
      h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap' }, h('b', {}, r.l.itemName), r.item?.perishable ? badge('perishable', 'warn') : null, h('span', { class: 'muted small' }, `${r.left} outstanding`)),
      list, h('div', { class: 'row', style: 'justify-content:space-between' }, more, total)) };
  });
  const go = h('button', { class: 'btn', type: 'button' }, 'Receive stock');
  const s = sheet({
    title: `Receive ${po.number}`,
    content: h('div', { class: 'form' }, err, h('p', { class: 'muted small', style: 'margin:0' }, 'Enter what actually arrived. Split a line into several batches when lots or expiry dates differ; you can receive the rest later.'), ui.map(x => x.node), canPrice ? upd.node : null),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    err.classList.add('hidden'); go.disabled = true;
    try {
      if (!can('purchaseOrders', 'update') || !can('batches', 'create')) throw new Error('You need permission to update purchase orders and create batches');
      const receipts = ui.flatMap(x => x.batches.map(b => ({ index: x.r.index, qty: b.qty.value, expiryDate: b.exp.value || null, lotNo: b.lot.value })));
      await core.receivePurchaseOrder(state.session, po.id, { receipts, updatePrices: canPrice && upd.input.checked });
      toast('Stock received - batches created', 'success'); s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); }
    finally { go.disabled = false; }
  });
}

// Suggested reorders for low-stock items: cheapest supplier per item, grouped by supplier, as draft purchase orders.
function reorderSheet() {
  const groups = suggestReorders(store.inventory, store.suppliers, store.supplierPrices, store.purchaseOrders);
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const go = h('button', { class: 'btn', type: 'button', disabled: !groups.length }, groups.length ? `Create ${groups.length} draft order${groups.length > 1 ? 's' : ''}` : 'Nothing to order');
  const s = sheet({
    title: 'Suggested reorders',
    content: h('div', { class: 'form' }, err,
      groups.length ? h('p', { class: 'muted small', style: 'margin:0' }, 'Low-stock items, bought from the cheapest supplier, minus what is already on order. Review the drafts before placing them.') : null,
      groups.length ? groups.map(g => h('div', { class: 'card' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, g.supplierName), h('b', {}, money(g.total))),
        g.lines.map(l => h('div', { class: 'offer' }, h('span', {}, `${l.qty} × ${l.itemName}`), h('span', { class: 'muted' }, money(l.unitPrice) + ' each'))))) : emptyState('check', 'Nothing to reorder', 'No low-stock item with a supplier price needs ordering right now.')),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Close'), go],
  });
  go.addEventListener('click', async () => {
    go.disabled = true; err.classList.add('hidden');
    try {
      if (!can('purchaseOrders', 'create')) throw new Error('No permission');
      for (const g of groups) await core.createPurchaseOrder(state.session, { supplierId: g.supplierId, supplierName: g.supplierName, lines: g.lines, note: 'Suggested reorder (low stock)', status: 'draft' });
      toast(`${groups.length} draft order${groups.length > 1 ? 's' : ''} created`, 'success'); s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); go.disabled = false; }
  });
}
// Return received goods to the supplier: pick quantities from the batches this order created.
function openReturnGoods(po) {
  const batches = store.batches.filter(b => b.poId === po.id && num(b.qtyRemaining) > 0);
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const total = h('b', {}, money(0));
  const rows = batches.map(b => {
    const inp = h('input', { class: 'input', type: 'number', min: '0', max: b.qtyRemaining, step: '1', value: '0', inputmode: 'numeric', 'aria-label': `Return quantity of ${b.itemName} lot ${b.lotNo || ''}` });
    inp.addEventListener('input', recalc);
    return { b, inp, node: h('div', { class: 'offer' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, b.itemName), h('div', { class: 'muted small' }, `Lot ${b.lotNo || '—'}${b.expiryDate ? ` • exp ${b.expiryDate}` : ''} • ${b.qtyRemaining} still in stock • ${money(b.unitCost)} each`)), h('div', { style: 'width:90px' }, inp)) };
  });
  function recalc() { total.textContent = money(rows.reduce((t, x) => t + num(x.inp.value) * num(x.b.unitCost), 0)); }
  const note = h('input', { class: 'input', placeholder: 'Reason (optional)', 'aria-label': 'Return reason' });
  const go = h('button', { class: 'btn', type: 'button', disabled: !rows.length }, 'Return goods');
  const s = sheet({
    title: `Return goods • ${po.number}`,
    content: h('div', { class: 'form' }, err,
      rows.length ? h('p', { class: 'muted small', style: 'margin:0' }, 'Only stock still on hand can go back. Stock and batches are reduced and the amount you owe the supplier drops.') : emptyState('box', 'Nothing to return', 'None of the batches from this order have stock left.'),
      rows.map(x => x.node), rows.length ? h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, 'Credit from supplier'), total) : null,
      rows.length ? h('div', { class: 'field' }, h('label', {}, 'Reason'), note) : null),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    err.classList.add('hidden'); go.disabled = true;
    try {
      if (!can('purchaseOrders', 'update') || !can('batches', 'update')) throw new Error('You need permission to update purchase orders and batches');
      const res = await core.returnPurchaseGoods(state.session, po.id, { picks: rows.map(x => ({ batchId: x.b.id, qty: num(x.inp.value) })), note: note.value.trim() });
      toast(`${money(res.value)} returned to supplier - stock reduced`, 'success'); s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); go.disabled = false; }
  });
}

function openDetail(poId) {
  const body = h('div'), actions = h('div', { style: 'display:flex;gap:10px;flex:1;flex-wrap:wrap' });
  const s = sheet({ title: 'Purchase order', content: body, footer: [actions], onClose: () => off() });
  const btn = (label, cls, fn, msg) => h('button', { class: 'btn ' + cls, type: 'button', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); if (msg) toast(msg, 'success'); } catch (err) { toast(errText(err), 'error'); } finally { b.disabled = false; } } }, label);
  const draw = () => {
    const po = store.purchaseOrders.find(x => x.id === poId);
    if (!po) return s.close();
    const upd = can('purchaseOrders', 'update'), del = can('purchaseOrders', 'delete');
    const lots = store.batches.filter(b => b.poId === po.id);
    setChildren(body,
      h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap' }, h('h3', { style: 'margin:0' }, po.number), badge(PURCHASE_STATUS[po.status] || po.status, TONE[po.status])),
      h('dl', { class: 'kv', style: 'margin-top:10px' }, h('dt', {}, 'Supplier'), h('dd', {}, po.supplierName), h('dt', {}, 'Created'), h('dd', {}, `${day(po.createdAt)} by ${po.createdBy || ''}`), po.receivedAt ? [h('dt', {}, 'Received'), h('dd', {}, day(po.receivedAt))] : null),
      h('div', { class: 'detail-lines' }, po.lines.map(l => h('div', { class: 'detail-line' },
        h('div', { class: 'top' }, h('span', {}, `${l.qty} × ${l.itemName}`), h('span', {}, money(num(l.qty) * num(l.unitPrice)))),
        h('div', { class: 'muted small' }, `${money(l.unitPrice)} each • received ${num(l.received)} of ${l.qty}`),
        lots.filter(b => b.itemId === l.itemId).map(b => h('div', { class: 'lot-line' }, h('span', {}, `Lot ${b.lotNo || '—'}${b.expiryDate ? ` • exp ${b.expiryDate}` : ''}`), h('span', {}, `${b.qtyReceived} units`)))))),
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, 'Total'), h('b', {}, money(po.total))),
      ['ordered', 'partial', 'received', 'closed'].includes(po.status) ? [
        (po.receipts || []).length ? h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Goods received'), po.receipts.map(r => h('div', { class: 'offer' },
          h('div', { class: 'grow' }, h('div', {}, r.number || 'Invoice pending'), h('div', { class: 'muted small' }, day(r.at), ` • ${r.by || ''}`)), h('b', {}, money(r.value))))) : null,
        (po.returns || []).length ? h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Returned to supplier'), po.returns.map(r => h('div', { class: 'offer' },
          h('div', { class: 'grow' }, h('div', {}, r.number ? `${r.number} • ` : '', r.lines.map(x => `${x.qty} × ${x.itemName}${x.lotNo ? ` (lot ${x.lotNo})` : ''}`).join(', ')), h('div', { class: 'muted small' }, day(r.at), ` • ${r.by || ''}`, r.note ? ` • ${r.note}` : '')),
          h('b', { style: 'color:var(--danger)' }, '−' + money(r.total))))) : null,
        paymentsBlock(po, 'purchase')] : null,
      po.note ? h('p', { class: 'muted small' }, po.note) : null);
    setChildren(actions,
      po.status === 'draft' && upd ? h('button', { class: 'btn soft', type: 'button', onclick: () => { s.close(); purchaseForm(po); } }, icon('edit', 16), 'Edit') : null,
      po.status === 'draft' && upd ? btn('Place order', '', () => core.advanceOrder(state.session, 'purchaseOrders', po.id, 'ordered'), 'Order placed') : null,
      ['ordered', 'partial'].includes(po.status) && upd ? h('button', { class: 'btn', type: 'button', onclick: () => receiveForm(po) }, icon('download', 16), 'Receive stock') : null,
      ['ordered', 'partial', 'received', 'closed'].includes(po.status) && upd && payableBalance(po) > 0.004 ? h('button', { class: 'btn', type: 'button', onclick: () => openPaymentForm('purchaseOrders', po) }, icon('dollar', 16), 'Pay supplier') : null,
      ['ordered', 'partial', 'received', 'closed'].includes(po.status) && upd && payableBalance(po) < -0.004 ? h('button', { class: 'btn accent', type: 'button', onclick: () => openPaymentForm('purchaseOrders', po, { refund: true }) }, icon('dollar', 16), 'Record refund') : null,
      ['partial', 'received', 'closed'].includes(po.status) && upd && can('batches', 'update') ? h('button', { class: 'btn danger-soft', type: 'button', onclick: () => openReturnGoods(po) }, icon('back', 16), 'Return goods') : null,
      po.status === 'partial' && upd ? btn('Close order (short)', 'ghost', async () => { if (await confirmDialog({ title: `Close ${po.number}?`, message: `The remaining ${po.lines.reduce((t, l) => t + Math.max(0, num(l.qty) - num(l.received)), 0)} units will not be received. Stock already received is kept.`, confirmLabel: 'Close order' })) { await core.advanceOrder(state.session, 'purchaseOrders', po.id, 'closed'); toast('Order closed', 'success'); } }) : null,
      ['draft', 'ordered'].includes(po.status) && upd ? btn('Cancel order', 'danger-soft', async () => { if (await confirmDialog({ title: `Cancel ${po.number}?`, message: 'The order will be cancelled.', confirmLabel: 'Cancel order', danger: true })) await core.advanceOrder(state.session, 'purchaseOrders', po.id, 'cancelled'); }) : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => window.print() }, icon('receipt', 16), 'Print'),
      ['draft', 'cancelled'].includes(po.status) && del ? btn('Delete', 'danger-soft', async () => { if (!can('purchaseOrders', 'delete')) throw new Error('No permission'); await core.removeDocs(state.session, 'purchaseOrders', [po.id]); toast('Order deleted'); s.close(); }) : null);
    if (!actions.children.length) actions.replaceChildren(h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Close'));
  };
  const off = onData(draw);
  draw();
}

const sheetsFor = () => {
  const pos = [...store.purchaseOrders].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    'Purchase orders': [['Number', 'Invoices', 'Date', 'Supplier', 'Status', 'Total', 'Outstanding value', 'Received value', 'Returned', 'Return refs', 'Paid', 'Payable', 'Created by', 'Received'], ...pos.map(o => [o.number, (o.receipts || []).map(r => r.number).filter(Boolean).join(', '), day(o.createdAt), o.supplierName, PURCHASE_STATUS[o.status] || o.status, num(o.total), ['ordered', 'partial'].includes(o.status) ? Math.round(outstanding(o) * 100) / 100 : 0, receivedValue(o), num(o.returnedValue), (o.returns || []).map(r => r.number).filter(Boolean).join(', '), paidTotalOf(o), payableBalance(o), o.createdBy || '', day(o.receivedAt)])],
    'Order lines': [['Number', 'Supplier', 'Item', 'Ordered', 'Received', 'Unit price', 'Line total'], ...pos.flatMap(o => o.lines.map(l => [o.number, o.supplierName, l.itemName, num(l.qty), num(l.received), num(l.unitPrice), Math.round(num(l.qty) * num(l.unitPrice) * 100) / 100]))],
  };
};

export default {
  mount(view) {
    let q = '', filter = 'open';
    const stats = h('div', { class: 'stats' }), list = h('div', { class: 'list two' });
    const draw = () => {
      const open = store.purchaseOrders.filter(o => ['draft', 'ordered', 'partial'].includes(o.status));
      setChildren(stats,
        statCard({ icon: 'receipt', label: 'Open orders', value: open.length, tone: open.length ? 'gold' : '' }),
        statCard({ icon: 'truck', label: 'Awaiting delivery', value: store.purchaseOrders.filter(o => ['ordered', 'partial'].includes(o.status)).length }),
        statCard({ icon: 'dollar', label: 'On order (value)', value: money(store.purchaseOrders.filter(o => ['ordered', 'partial'].includes(o.status)).reduce((t, o) => t + outstanding(o), 0)), tone: 'gold' }),
        statCard({ icon: 'alert', label: 'You owe suppliers', value: money(store.purchaseOrders.reduce((t, o) => t + Math.max(0, payableBalance(o)), 0)), tone: store.purchaseOrders.some(o => payableBalance(o) > 0.004) ? 'red' : 'green' }));
      if (!store.loaded.purchaseOrders) return setChildren(list, skeletons(3));
      const match = { open: o => ['draft', 'ordered', 'partial'].includes(o.status), received: o => ['received', 'closed'].includes(o.status), unpaid: o => payableBalance(o) > 0.004, all: () => true };
      const rows = [...store.purchaseOrders].filter(o => match[filter](o) && (!q || norm(o.number).includes(q) || norm(o.supplierName).includes(q) || (o.receipts || []).some(r => norm(r.number).includes(q)) || (o.returns || []).some(r => norm(r.number).includes(q)))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      setChildren(list, rows.length ? rows.map(o => h('button', { class: 'item tap', type: 'button', style: 'width:100%;text-align:left', onclick: () => openDetail(o.id) },
        h('div', { class: 'avatar ' + (o.status === 'received' ? 'green' : o.status === 'cancelled' ? 'red' : 'gold') }, icon('receipt', 20)),
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, `${o.number} • ${o.supplierName}`), h('div', { class: 'sub' }, `${day(o.createdAt)} • ${o.lines.length} item${o.lines.length === 1 ? '' : 's'}`), h('div', { class: 'row', style: 'gap:6px;margin-top:6px' }, badge(PURCHASE_STATUS[o.status] || o.status, TONE[o.status]))),
        h('b', {}, money(o.total)), icon('chevron', 18)))
        : [emptyState('receipt', store.purchaseOrders.length ? 'No matching orders' : 'No purchase orders yet', can('purchaseOrders', 'create') ? 'Order from a supplier, then receive the delivery into batches.' : 'Nothing to show yet.')]);
    };
    view.append(pageHead('Purchases', [can('purchaseOrders', 'create') && can('supplierPrices', 'read') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: reorderSheet }, icon('alert', 16), 'Reorder low stock') : null, exportButton(sheetsFor, () => `${state.session.tenantId}-purchases`)]), stats,
      h('div', { class: 'toolbar' }, searchBox('Search order or supplier', v => { q = norm(v.trim()); draw(); }),
        chipGroup([{ value: 'open', label: 'Open' }, { value: 'received', label: 'Received' }, { value: 'unpaid', label: 'Unpaid' }, { value: 'all', label: 'All' }], filter, v => { filter = v; draw(); })),
      list, can('purchaseOrders', 'create') ? fab('New order', () => purchaseForm()) : null);
    draw();
    return onData(draw);
  },
};
