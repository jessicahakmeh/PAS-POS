// Statement of account: a running-balance list of everything owed/paid for one customer or supplier, shared by the
// Ledgers page and by the Customers/Suppliers detail rows (so it's reachable from either place). Prints and exports.
import { h, icon, sheet, money, day, emptyState, exportXlsx } from '../ui.js';
import { state } from '../state.js';

const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));

// entries: [{ date, ref, text, change, balance }] (see core.js customerStatement/supplierStatement).
// owedLabel/creditLabel describe a positive/negative balance from the tenant's point of view (e.g. "Owes you" / "You owe them").
export function openStatement({ title, subtitle, entries, owedLabel, creditLabel }) {
  const bal = entries.length ? entries.at(-1).balance : 0;
  const rows = [...entries].reverse().map(e => h('div', { class: 'offer' },
    h('div', { class: 'grow' }, h('div', {}, e.text), h('div', { class: 'muted small' }, day(e.date))),
    h('div', { style: 'text-align:right' }, h('div', { style: `font-weight:700;color:var(--${e.change > 0 ? (owedLabel === 'Owes you' ? 'warn' : 'danger') : 'success'})` }, signed(e.change)), h('div', { class: 'muted small' }, 'bal ' + money(e.balance)))));
  const s = sheet({
    title,
    content: h('div', {},
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' }, h('span', { class: 'muted' }, subtitle),
        h('b', { style: `color:var(--${bal > 0.004 ? 'warn' : bal < -0.004 ? 'danger' : 'success'})` }, bal > 0.004 ? `${owedLabel} ${money(bal)}` : bal < -0.004 ? `${creditLabel} ${money(-bal)}` : 'Settled')),
      rows.length ? rows : emptyState('book', 'No entries yet')),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Close'),
      h('button', { class: 'btn soft', type: 'button', onclick: () => window.print() }, icon('receipt', 16), 'Print'),
      h('button', { class: 'btn soft', type: 'button', onclick: () => exportXlsx(`${state.session.tenantId}-statement-${title.replace(/\W+/g, '-').toLowerCase()}.xlsx`,
        { Statement: [['Date', 'Reference', 'Description', 'Amount', 'Balance'], ...entries.map(e => [day(e.date), e.ref || '', e.text, e.change, e.balance])] }) }, icon('download', 16), 'Export')],
  });
  return s;
}
