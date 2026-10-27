// Payments UI shared by sales orders (customer pays us) and purchase orders (we pay the supplier).
// Dual currency: an order's own totals stay in USD, but a payment can be split across USD and LBP at once - the LBP
// side is converted using the tenant's live exchange rate (Ledgers -> Exchange rate) and stamped onto the payment.
import { h, icon, iconBtn, sheet, openForm, toast, money, day } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store } from '../data.js';
import { PAYMENT_METHODS, DEFAULT_EXCHANGE_RATE, paidTotalOf, salesNet, salesBalance, receivedValue, payableBalance } from '../../core.js';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lbp = (n) => `${Math.round(num(n)).toLocaleString()} LBP`;
const kv = (label, value, tone = '') => [h('dt', {}, label), h('dd', { style: tone ? `color:var(--${tone})` : '' }, value)];

// A printable sales receipt (money in) or payment voucher (money out) for one payment/refund. `e` is the common
// shape used both here and by the ledgers transaction log: { number, direction, date, party, orderNumber, usdAmount,
// lbpAmount, usdEquivalent, method, note, by }.
export function openVoucher(e) {
  const isIn = e.direction === 'in';
  const s = sheet({
    title: isIn ? 'Sales receipt' : 'Payment voucher',
    content: h('div', {},
      h('div', { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
        h('h2', { style: 'margin:0' }, e.number || '—'), h('b', { style: `color:var(--${isIn ? 'success' : 'danger'})` }, (isIn ? '+' : '−') + money(e.usdEquivalent))),
      h('dl', { class: 'kv', style: 'margin-top:10px' },
        kv('Date', day(e.date)), kv(isIn ? 'Received from' : 'Paid to', e.party), kv('Order', e.orderNumber || ''),
        kv('Method', PAYMENT_METHODS[e.method] || e.method),
        e.usdAmount ? kv('Amount (USD)', money(e.usdAmount)) : null, e.lbpAmount ? kv('Amount (LBP)', lbp(e.lbpAmount)) : null,
        kv('Total (USD equivalent)', money(e.usdEquivalent)), e.by ? kv('Recorded by', e.by) : null, e.note ? kv('Note', e.note) : null)),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Close'),
      h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, icon('receipt', 16), 'Print')],
  });
}

// Summary + list of payments for an order. kind: 'sales' | 'purchase'.
export function paymentsBlock(o, kind) {
  const sales = kind === 'sales';
  const paid = paidTotalOf(o), bal = sales ? salesBalance(o) : payableBalance(o);
  const payments = o.payments || [];
  const summary = sales
    ? [kv('Order total', money(o.total)), num(o.returnedValue) ? kv('Returned', '−' + money(o.returnedValue)) : null, num(o.returnedValue) ? kv('Net', money(salesNet(o))) : null, kv('Paid', money(paid))]
    : [kv('Received value', money(receivedValue(o))), num(o.returnedValue) ? kv('Returned to supplier', '−' + money(o.returnedValue)) : null, kv('Paid', money(paid))];
  const label = bal > 0.004 ? (sales ? 'Balance due' : 'You owe') : bal < -0.004 ? (sales ? 'Refund due to customer' : 'Supplier owes you') : (sales ? 'Balance' : 'Balance');
  const tone = bal > 0.004 ? 'warn' : bal < -0.004 ? 'danger' : 'success';
  return h('div', { class: 'card', style: 'margin-top:12px' },
    h('h3', {}, 'Payments'),
    h('dl', { class: 'kv' }, summary, kv(label, money(Math.abs(bal)), tone)),
    payments.length ? h('div', { style: 'margin-top:8px' }, payments.map(p => h('div', { class: 'offer' },
      h('div', { class: 'grow' },
        h('div', {}, p.number ? `${p.number} • ` : '', p.kind === 'refund' ? 'Refund' : 'Payment', ' • ', PAYMENT_METHODS[p.method] || p.method),
        h('div', { class: 'muted small' }, day(p.at), p.by ? ` • ${p.by}` : '', num(p.lbpAmount) ? ` • ${money(num(p.usdAmount))} + ${lbp(p.lbpAmount)}` : '', p.note ? ` • ${p.note}` : '')),
      h('div', { class: 'row', style: 'gap:4px' },
        h('b', { style: p.kind === 'refund' ? 'color:var(--danger)' : '' }, (p.kind === 'refund' ? '−' : '') + money(p.amount)),
        p.number ? iconBtn('receipt', sales === (p.kind !== 'refund') ? 'View receipt' : 'View voucher', () => openVoucher({
          number: p.number, direction: sales === (p.kind !== 'refund') ? 'in' : 'out', date: p.at, party: sales ? o.customerName : o.supplierName, orderNumber: o.number,
          usdAmount: p.usdAmount ?? p.amount, lbpAmount: p.lbpAmount || 0, usdEquivalent: p.amount, method: p.method, note: p.note, by: p.by,
        })) : null)))) : h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'No payments recorded yet.'));
}

// coll: 'salesOrders' | 'purchaseOrders'; refund = money going the other way.
export function openPaymentForm(coll, o, { refund = false } = {}) {
  const sales = coll === 'salesOrders';
  const bal = sales ? salesBalance(o) : payableBalance(o), paid = paidTotalOf(o);
  const suggested = Math.max(0, refund ? (Math.min(paid, Math.max(0, -bal)) || paid) : bal);
  const rate = num(store.settings?.exchangeRate) || DEFAULT_EXCHANGE_RATE;
  const title = refund ? (sales ? 'Refund customer' : 'Record refund from supplier') : (sales ? 'Record payment' : 'Pay supplier');

  const usd = h('input', { class: 'input', name: 'usdAmount', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: suggested ? suggested.toFixed(2) : '', 'aria-label': 'Amount in USD' });
  const lbpIn = h('input', { class: 'input', name: 'lbpAmount', type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: '0', 'aria-label': 'Amount in LBP' });
  const preview = h('div', { class: 'help' });
  const refreshPreview = () => {
    const total = round2(num(usd.value) + num(lbpIn.value) / rate);
    preview.textContent = num(lbpIn.value) ? `= ${money(total)} total, at 1 USD = ${rate.toLocaleString()} LBP` : `1 USD = ${rate.toLocaleString()} LBP`;
  };
  usd.addEventListener('input', refreshPreview); lbpIn.addEventListener('input', refreshPreview); refreshPreview();

  openForm({
    title: `${title} • ${o.number}`, submitLabel: refund ? 'Record refund' : 'Record payment',
    fields: [
      { node: h('div', { class: 'field' }, h('label', {}, `Amount in USD (${refund ? 'max ' + money(paid) : sales ? 'balance ' + money(bal) : 'owed ' + money(bal)})`), usd) },
      { node: h('div', { class: 'field' }, h('label', {}, 'Amount in LBP'), lbpIn, preview) },
      { name: 'method', label: 'Method', type: 'select', value: 'cash', options: Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label })) },
      { name: 'note', label: 'Note', placeholder: 'Optional (reference, cheque no…)' },
    ],
    onSubmit: async (v) => {
      if (!can(coll, 'update')) throw new Error('No permission');
      if (num(usd.value) <= 0 && num(lbpIn.value) <= 0) throw new Error('Enter an amount in USD and/or LBP');
      const res = await core.recordPayment(state.session, coll, o.id, { usdAmount: num(usd.value), lbpAmount: num(lbpIn.value), kind: refund ? 'refund' : 'payment', method: v.method, note: v.note });
      toast(`${refund ? 'Refund' : 'Payment'} recorded (${res.number})`, 'success');
    },
  });
}
