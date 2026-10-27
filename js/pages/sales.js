// Sales cycle: order -> confirm -> fulfil (stock leaves FEFO, lots recorded) -> paid. Walk-in "sell now" shortcut.
import { h, icon, pageHead, searchBox, chipGroup, emptyState, fab, sheet, toast, errText, statCard, money, day, norm, exportButton, skeletons, setChildren, switchRow, badge, confirmDialog } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { salesSummary, SALES_STATUS, addDays, localDay, allocateFEFO, stockPosition, salesBalance, salesNet, isInvoiced, paymentState, paidTotalOf } from '../../core.js';
import { positionOf, itemById, batchesOf } from '../stock.js';
import { lineEditor } from '../components/lineEditor.js';
import { paymentsBlock, openPaymentForm } from '../components/payments.js';
import { branchLabel } from '../components/branchEditor.js';

const num = (v) => Number(v) || 0;
const TONE = { draft: '', confirmed: 'brand', fulfilled: 'ok', returned: 'warn', cancelled: 'bad' };

const PAY_BADGE = { paid: ['Paid', 'ok'], part: ['Part paid', 'warn'], unpaid: ['Unpaid', 'warn'], refund: ['Refund due', 'bad'], settled: ['Settled', ''] };
function statusBadges(o) {
  const partReturn = o.status === 'fulfilled' && num(o.returnedValue) > 0;
  const pay = isInvoiced(o) ? PAY_BADGE[paymentState(o)] : null;
  return [badge(partReturn ? 'Part returned' : (SALES_STATUS[o.status] || o.status), partReturn ? 'warn' : TONE[o.status]), pay ? badge(pay[0], pay[1]) : null];
}

function salesForm(existing = null) {
  const cust = h('select', { class: 'input', 'aria-label': 'Customer' }, h('option', { value: '' }, 'Walk-in customer'), ...store.customers.map(c => h('option', { value: c.id }, c.name)));
  const editor = lineEditor({
    initial: existing?.lines,
    emptyText: 'No stock available',
    getOptions: () => store.inventory.map(i => { const p = positionOf(i); return p.sellable > 0 ? { id: i.id, name: i.name, price: i.price, hint: `${p.sellable} available`, max: p.sellable } : null; }).filter(Boolean),
  });
  const now = switchRow('Fulfil now', 'Take the stock out immediately (walk-in sale)');
  const paid = switchRow('Mark as paid', 'Payment received');
  paid.node.classList.add('hidden');
  now.input.addEventListener('change', () => { paid.node.classList.toggle('hidden', !now.input.checked); if (!now.input.checked) paid.input.checked = false; sync(); });
  if (existing) cust.value = existing.customerId || '';
  const branchSel = h('select', { class: 'input', 'aria-label': 'Branch' });
  const branchField = h('div', { class: 'field hidden' }, h('label', {}, 'Branch (location)'), branchSel);
  function refreshBranches() {
    const branches = store.customers.find(x => x.id === cust.value)?.branches || [];
    branchField.classList.toggle('hidden', !branches.length);
    branchSel.replaceChildren(h('option', { value: '' }, 'No specific branch'), ...branches.map(b => h('option', { value: b.id, selected: b.id === existing?.branchId }, branchLabel(b))));
  }
  cust.addEventListener('change', refreshBranches);
  refreshBranches();
  const note = h('input', { class: 'input', placeholder: 'Optional note', 'aria-label': 'Note', value: existing?.note || '' });
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const draftBtn = h('button', { class: 'btn ghost', type: 'button' }, 'Save draft');
  const goBtn = h('button', { class: 'btn', type: 'button' }, 'Create order');
  const sync = () => { goBtn.textContent = now.input.checked ? (paid.input.checked ? 'Sell & mark paid' : 'Sell now') : 'Create order'; };
  paid.input.addEventListener('change', sync);
  const s = sheet({
    title: existing ? 'Edit ' + existing.number : 'New sales order',
    content: h('div', { class: 'form' }, err, h('div', { class: 'field' }, h('label', {}, 'Customer'), cust), branchField, editor.node, now.node, paid.node, h('div', { class: 'field' }, h('label', {}, 'Note'), note)),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), existing ? null : draftBtn, goBtn],
  });
  if (existing) { now.node.classList.add('hidden'); paid.node.classList.add('hidden'); goBtn.textContent = 'Save changes'; }
  async function submit(status) {
    err.classList.add('hidden'); draftBtn.disabled = goBtn.disabled = true;
    try {
      if (!can('salesOrders', 'create')) throw new Error('No permission');
      const c = store.customers.find(x => x.id === cust.value);
      const branch = (c?.branches || []).find(b => b.id === branchSel.value);
      const branchArgs = { branchId: branch?.id || null, branchName: branch ? branchLabel(branch) : '' };
      if (existing) {
        await core.updateDraftOrder(state.session, 'salesOrders', existing.id, { lines: editor.getLines(), note: note.value.trim(), customerId: c?.id || null, customerName: c?.name || '', ...branchArgs });
        toast(existing.number + ' updated', 'success'); s.close(); return;
      }
      const res = await core.createSalesOrder(state.session, { customerId: c?.id || null, customerName: c?.name || '', ...branchArgs, lines: editor.getLines(), note: note.value.trim(), status });
      if (status === 'confirmed' && now.input.checked) {
        try {
          await core.fulfilSalesOrder(state.session, res.id);
          if (paid.input.checked) await core.setSalesPaid(state.session, res.id, true);
          toast(`${res.number} sold`, 'success');
        } catch (e) { toast(`${res.number} saved but not fulfilled: ${errText(e)}`, 'error'); }
      } else toast(`${res.number} ${status === 'draft' ? 'saved as draft' : 'created'}`, 'success');
      s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); }
    finally { draftBtn.disabled = goBtn.disabled = false; }
  }
  draftBtn.addEventListener('click', () => submit('draft'));
  goBtn.addEventListener('click', () => submit('confirmed'));
}

// Manual batch choice: pre-filled with the FEFO suggestion; change the quantities per lot (or unbatched stock) and fulfil.
function openBatchPicker(order) {
  const today = localDay();
  const blocks = order.lines.map((l, idx) => {
    const item = itemById(l.itemId), all = batchesOf(l.itemId);
    if (!item) return null;
    const fefo = allocateFEFO(item, all, l.qty, today);
    const suggested = new Map(fefo.allocations.map(a => [a.batchId, a.qty]));
    const cands = all.filter(b => num(b.qtyRemaining) > 0 && !(b.expiryDate && b.expiryDate < today))
      .sort((a, b) => String(a.expiryDate || '9999').localeCompare(String(b.expiryDate || '9999')) || String(a.receivedAt).localeCompare(String(b.receivedAt)));
    const unb = stockPosition(item, all, today).unbatched;
    const rows = cands.map(b => ({ id: b.id, label: `Lot ${b.lotNo || '—'}${b.expiryDate ? ` • exp ${b.expiryDate}` : ''}`, left: num(b.qtyRemaining), value: suggested.get(b.id) || 0 }));
    if (unb > 0) rows.push({ id: null, label: 'Unbatched stock', left: unb, value: fefo.unbatched || 0 });
    const counter = h('b', {});
    const inputs = rows.map(r => {
      const inp = h('input', { class: 'input', type: 'number', min: '0', max: r.left, step: '1', value: r.value, inputmode: 'numeric', 'aria-label': `${l.itemName} ${r.label}` });
      inp.addEventListener('input', update);
      return { r, inp, node: h('div', { class: 'offer' }, h('div', { class: 'grow' }, h('div', {}, r.label), h('div', { class: 'muted small' }, `${r.left} available`)), h('div', { style: 'width:90px' }, inp)) };
    });
    function update() { const t = inputs.reduce((s, x) => s + num(x.inp.value), 0); counter.textContent = `${t} / ${l.qty}`; counter.style.color = t === Number(l.qty) ? 'var(--success)' : 'var(--danger)'; }
    update();
    return { idx, l, inputs, node: h('div', { class: 'card' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, l.itemName), h('span', {}, 'Selected ', counter)), inputs.length ? inputs.map(x => x.node) : h('p', { class: 'muted small' }, 'No sellable stock.')) };
  }).filter(Boolean);
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const go = h('button', { class: 'btn', type: 'button' }, 'Fulfil with these batches');
  const s = sheet({
    title: `Choose batches • ${order.number}`,
    content: h('div', { class: 'form' }, err, h('p', { class: 'muted small', style: 'margin:0' }, 'Suggested lots follow FEFO (soonest expiry first). Change the quantities to override. Expired lots are not listed.'), blocks.map(b => b.node)),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    err.classList.add('hidden'); go.disabled = true;
    try {
      if (!can('salesOrders', 'update')) throw new Error('No permission');
      const overrides = {};
      for (const b of blocks) overrides[b.idx] = b.inputs.map(x => ({ batchId: x.r.id, qty: num(x.inp.value) }));
      await core.fulfilSalesOrder(state.session, order.id, { overrides });
      toast('Fulfilled with your batch selection', 'success'); s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); }
    finally { go.disabled = false; }
  });
}

// Return items: choose a quantity per line (0 = keep). Stock goes back into the batches the goods came from.
function openReturnSheet(o) {
  const rows = o.lines.map((l, index) => ({ l, index, left: num(l.qty) - num(l.returnedQty) })).filter(r => r.left > 0);
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const total = h('b', {}, money(0));
  const inputs = rows.map(r => {
    const inp = h('input', { class: 'input', type: 'number', min: '0', max: r.left, step: '1', value: '0', inputmode: 'numeric', 'aria-label': `Return quantity of ${r.l.itemName}` });
    inp.addEventListener('input', recalc);
    return { r, inp, node: h('div', { class: 'offer' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, r.l.itemName), h('div', { class: 'muted small' }, `${r.left} of ${r.l.qty} can be returned • ${money(r.l.unitPrice)} each`)), h('div', { style: 'width:90px' }, inp)) };
  });
  function recalc() { total.textContent = money(inputs.reduce((t, x) => t + num(x.inp.value) * num(x.r.l.unitPrice), 0)); }
  const note = h('input', { class: 'input', placeholder: 'Reason (optional)', 'aria-label': 'Return reason' });
  const all = h('button', { class: 'btn soft sm', type: 'button', onclick: () => { inputs.forEach(x => { x.inp.value = x.r.left; }); recalc(); } }, 'Return everything');
  const go = h('button', { class: 'btn', type: 'button' }, 'Return items');
  const s = sheet({
    title: `Return items • ${o.number}`,
    content: h('div', { class: 'form' }, err, h('div', { class: 'row', style: 'justify-content:space-between' }, h('p', { class: 'muted small', style: 'margin:0' }, 'Enter how many of each item the customer is returning.'), all),
      inputs.map(x => x.node), h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, 'Credit to customer'), total), h('div', { class: 'field' }, h('label', {}, 'Reason'), note)),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    err.classList.add('hidden'); go.disabled = true;
    try {
      if (!can('salesOrders', 'update')) throw new Error('No permission');
      const items = inputs.map(x => ({ index: x.r.index, qty: num(x.inp.value) })).filter(x => x.qty > 0);
      const res = await core.returnSalesOrder(state.session, o.id, { items, note: note.value.trim() });
      toast(`${money(res.value)} credited - stock restored${res.fullyReturned ? '' : ' (part return)'}`, 'success'); s.close();
    } catch (e) { err.textContent = errText(e); err.classList.remove('hidden'); }
    finally { go.disabled = false; }
  });
}

function openDetail(orderId) {
  const body = h('div'), actions = h('div', { style: 'display:flex;gap:10px;flex:1;flex-wrap:wrap' });
  const s = sheet({ title: 'Sales order', content: body, footer: [actions], onClose: () => off() });
  const run = (fn, msg) => async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await fn(); if (msg) toast(msg, 'success'); } catch (err) { toast(errText(err), 'error'); } finally { b.disabled = false; }
  };
  const btn = (label, cls, fn, msg) => h('button', { class: 'btn ' + cls, type: 'button', onclick: run(fn, msg) }, label);
  const draw = () => {
    const o = store.salesOrders.find(x => x.id === orderId);
    if (!o) return s.close();
    const upd = can('salesOrders', 'update'), del = can('salesOrders', 'delete');
    const bal = salesBalance(o), canReturn = o.status === 'fulfilled' && o.lines.some(l => num(l.qty) - num(l.returnedQty) > 0);
    const lines = o.lines.map(l => h('div', { class: 'detail-line' },
      h('div', { class: 'top' }, h('span', {}, `${l.qty} × ${l.itemName}`), h('span', {}, money(num(l.qty) * num(l.unitPrice)))),
      h('div', { class: 'muted small' }, `${money(l.unitPrice)} each`, num(l.returnedQty) ? ` • ${l.returnedQty} returned` : ''),
      (l.allocations || []).map(a => h('div', { class: 'lot-line' }, h('span', {}, `Lot ${a.lotNo || '—'}${a.expiryDate ? ` • exp ${a.expiryDate}` : ''}`), h('span', {}, `${a.qty} units${num(a.returned) ? ` (${a.returned} returned)` : ''}`))),
      l.unbatched ? h('div', { class: 'lot-line' }, h('span', {}, 'Unbatched stock'), h('span', {}, `${l.unbatched} units`)) : null));
    setChildren(body,
      h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap' }, h('h3', { style: 'margin:0' }, o.number), h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, statusBadges(o))),
      h('dl', { class: 'kv', style: 'margin-top:10px' }, h('dt', {}, 'Customer'), h('dd', {}, o.customerName), o.branchName ? [h('dt', {}, 'Branch'), h('dd', {}, o.branchName)] : null, h('dt', {}, 'Created'), h('dd', {}, `${day(o.createdAt)} by ${o.createdBy || ''}`),
        o.fulfilledAt ? [h('dt', {}, 'Fulfilled'), h('dd', {}, day(o.fulfilledAt))] : null, o.invoiceNumber ? [h('dt', {}, 'Invoice'), h('dd', {}, o.invoiceNumber)] : null),
      h('div', { class: 'detail-lines' }, lines),
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, 'Total'), h('b', {}, money(o.total))),
      isInvoiced(o) ? [
        can('batches', 'read') ? h('dl', { class: 'kv', style: 'margin-top:8px' }, h('dt', {}, 'Cost of goods'), h('dd', {}, money(num(o.cost) - num(o.returnedCost))), h('dt', {}, 'Margin'), h('dd', {}, money(salesNet(o) - (num(o.cost) - num(o.returnedCost))))) : null,
        (o.returns || []).length ? h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Returns'), o.returns.map(r => h('div', { class: 'offer' },
          h('div', { class: 'grow' }, h('div', {}, r.number ? `${r.number} • ` : '', r.lines.map(x => `${x.qty} × ${x.itemName}`).join(', ')), h('div', { class: 'muted small' }, day(r.at), ` • ${r.by || ''}`, r.note ? ` • ${r.note}` : '')), h('b', { style: 'color:var(--danger)' }, '−' + money(r.total))))) : null,
        paymentsBlock(o, 'sales')] : null,
      o.note ? h('p', { class: 'muted small' }, o.note) : null);
    setChildren(actions,
      o.status === 'draft' && upd ? h('button', { class: 'btn soft', type: 'button', onclick: () => { s.close(); salesForm(o); } }, icon('edit', 16), 'Edit') : null,
      o.status === 'draft' && upd ? btn('Confirm order', '', () => core.advanceOrder(state.session, 'salesOrders', o.id, 'confirmed'), 'Order confirmed') : null,
      o.status === 'confirmed' && upd ? btn('Fulfil (FEFO)', '', () => core.fulfilSalesOrder(state.session, o.id), 'Fulfilled - stock updated') : null,
      o.status === 'confirmed' && upd && can('batches', 'read') ? h('button', { class: 'btn soft', type: 'button', onclick: () => openBatchPicker(o) }, icon('clock', 16), 'Choose batches') : null,
      isInvoiced(o) && upd && bal > 0.004 ? h('button', { class: 'btn', type: 'button', onclick: () => openPaymentForm('salesOrders', o) }, icon('dollar', 16), 'Record payment') : null,
      isInvoiced(o) && upd && bal < -0.004 ? h('button', { class: 'btn accent', type: 'button', onclick: () => openPaymentForm('salesOrders', o, { refund: true }) }, icon('dollar', 16), 'Record refund') : null,
      canReturn && upd ? h('button', { class: 'btn danger-soft', type: 'button', onclick: () => openReturnSheet(o) }, icon('back', 16), 'Return items') : null,
      ['draft', 'confirmed'].includes(o.status) && upd ? btn('Cancel order', 'danger-soft', async () => { if (await confirmDialog({ title: `Cancel ${o.number}?`, message: 'The order will be cancelled. No stock has been deducted.', confirmLabel: 'Cancel order', danger: true })) await core.advanceOrder(state.session, 'salesOrders', o.id, 'cancelled'); }) : null,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => window.print() }, icon('receipt', 16), 'Print'),
      ['draft', 'cancelled'].includes(o.status) && del ? btn('Delete', 'danger-soft', async () => { if (!can('salesOrders', 'delete')) throw new Error('No permission'); await core.removeDocs(state.session, 'salesOrders', [o.id]); toast('Order deleted'); s.close(); }) : null);
    if (!actions.children.length) actions.replaceChildren(h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Close'));
  };
  const off = onData(draw);
  draw();
}

const sheetsFor = () => {
  const orders = [...store.salesOrders].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    'Sales orders': [['Number', 'Invoice', 'Date', 'Customer', 'Branch', 'Status', 'Payment', 'Total', 'Returned', 'Return refs', 'Net', 'Paid', 'Balance', 'Cost', 'Margin', 'Created by', 'Fulfilled'],
      ...orders.map(o => [o.number, o.invoiceNumber || '', day(o.createdAt), o.customerName, o.branchName || '', SALES_STATUS[o.status] || o.status, isInvoiced(o) ? paymentState(o) : '', num(o.total), num(o.returnedValue), (o.returns || []).map(r => r.number).filter(Boolean).join(', '), isInvoiced(o) ? salesNet(o) : '', isInvoiced(o) ? paidTotalOf(o) : '', isInvoiced(o) ? salesBalance(o) : '', num(o.cost) - num(o.returnedCost), isInvoiced(o) ? Math.round((salesNet(o) - (num(o.cost) - num(o.returnedCost))) * 100) / 100 : '', o.createdBy || '', day(o.fulfilledAt)])],
    'Order lines': [['Number', 'Customer', 'Item', 'Qty', 'Unit price', 'Line total', 'Lots used'],
      ...orders.flatMap(o => o.lines.map(l => [o.number, o.customerName, l.itemName, num(l.qty), num(l.unitPrice), Math.round(num(l.qty) * num(l.unitPrice) * 100) / 100, (l.allocations || []).map(a => `${a.lotNo || '-'}×${a.qty}`).join(', ')]))],
  };
};

export default {
  mount(view) {
    let q = '', filter = 'all';
    const stats = h('div', { class: 'stats' }), list = h('div', { class: 'list two' });
    const draw = () => {
      const sum = salesSummary(store.salesOrders, addDays(localDay(), -30));
      setChildren(stats,
        statCard({ icon: 'dollar', label: 'Revenue, 30 days', value: money(sum.revenue), tone: 'green' }),
        statCard({ icon: 'cart', label: 'Orders, 30 days', value: sum.orders }),
        statCard({ icon: 'alert', label: 'To collect', value: money(sum.unpaid), tone: sum.unpaid ? 'gold' : 'green' }),
        statCard({ icon: 'clock', label: 'Open orders', value: sum.open, tone: sum.open ? 'gold' : '' }));
      if (!store.loaded.salesOrders) return setChildren(list, skeletons(3));
      const match = { all: () => true, open: o => ['draft', 'confirmed'].includes(o.status), unpaid: o => isInvoiced(o) && Math.abs(salesBalance(o)) > 0.004, done: o => isInvoiced(o) };
      const rows = [...store.salesOrders].filter(o => match[filter](o) && (!q || norm(o.number).includes(q) || norm(o.invoiceNumber).includes(q) || norm(o.customerName).includes(q) || norm(o.branchName).includes(q))).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      setChildren(list, rows.length ? rows.map(o => h('button', { class: 'item tap', type: 'button', style: 'width:100%;text-align:left', onclick: () => openDetail(o.id) },
        h('div', { class: 'avatar ' + (o.status === 'fulfilled' ? 'green' : o.status === 'cancelled' ? 'red' : 'gold') }, icon('cart', 20)),
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, `${o.number} • ${o.customerName}${o.branchName ? ` (${o.branchName})` : ''}`), h('div', { class: 'sub' }, `${day(o.createdAt)} • ${o.lines.length} item${o.lines.length === 1 ? '' : 's'}`), h('div', { class: 'row', style: 'gap:6px;margin-top:6px' }, statusBadges(o))),
        h('b', {}, money(o.total)), icon('chevron', 18)))
        : [emptyState('cart', store.salesOrders.length ? 'No matching orders' : 'No sales yet', can('salesOrders', 'create') ? 'Create an order, or use "Fulfil now" for a walk-in sale.' : 'Nothing to show yet.')]);
    };
    view.append(pageHead('Sales', [exportButton(sheetsFor, () => `${state.session.tenantId}-sales`)]), stats,
      h('div', { class: 'toolbar' }, searchBox('Search order or customer', v => { q = norm(v.trim()); draw(); }),
        chipGroup([{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'unpaid', label: 'Unpaid' }, { value: 'done', label: 'Fulfilled' }], filter, v => { filter = v; draw(); })),
      list, can('salesOrders', 'create') ? fab('New sale', () => salesForm()) : null);
    draw();
    return onData(draw);
  },
};
