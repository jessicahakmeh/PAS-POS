// Expenses: business costs that aren't tied to a purchase order (rent, salaries, utilities, ...). Each one is
// recorded as money out, in USD and/or LBP, and gets its own payment voucher reference (PV-YY-####).
import { h, icon, iconBtn, pageHead, searchBox, chipGroup, emptyState, fab, openForm, sheet, confirmDialog, toast, errText, money, day, norm, exportButton, skeletons, setChildren, statCard } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { PAYMENT_METHODS, DEFAULT_EXCHANGE_RATE, DEFAULT_EXPENSE_CATEGORIES, localDay } from '../../core.js';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const lbp = (n) => `${Math.round(num(n)).toLocaleString()} LBP`;
const categories = () => (store.settings?.expenseCategories?.length ? store.settings.expenseCategories : DEFAULT_EXPENSE_CATEGORIES);

function expenseForm() {
  const rate = num(store.settings?.exchangeRate) || DEFAULT_EXCHANGE_RATE;
  const usd = h('input', { class: 'input', name: 'usdAmount', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', 'aria-label': 'Amount in USD' });
  const lbpIn = h('input', { class: 'input', name: 'lbpAmount', type: 'number', min: '0', step: '1', inputmode: 'numeric', placeholder: '0', 'aria-label': 'Amount in LBP' });
  const preview = h('div', { class: 'help' });
  const refresh = () => { const total = round2(num(usd.value) + num(lbpIn.value) / rate); preview.textContent = num(lbpIn.value) ? `= ${money(total)} total, at 1 USD = ${rate.toLocaleString()} LBP` : `1 USD = ${rate.toLocaleString()} LBP`; };
  usd.addEventListener('input', refresh); lbpIn.addEventListener('input', refresh); refresh();
  openForm({
    title: 'New expense', submitLabel: 'Add expense',
    fields: [
      { name: 'category', label: 'Category', type: 'select', options: categories().map(c => ({ value: c, label: c })) },
      { name: 'date', label: 'Date', type: 'date', value: localDay(), required: true },
      { node: h('div', { class: 'field' }, h('label', {}, 'Amount in USD'), usd) },
      { node: h('div', { class: 'field' }, h('label', {}, 'Amount in LBP'), lbpIn, preview) },
      { name: 'method', label: 'Method', type: 'select', value: 'cash', options: Object.entries(PAYMENT_METHODS).map(([value, label]) => ({ value, label })) },
      { name: 'note', label: 'Note', placeholder: 'Optional (e.g. invoice number)' },
    ],
    onSubmit: async (v) => {
      if (!can('expenses', 'create')) throw new Error('No permission');
      if (num(usd.value) <= 0 && num(lbpIn.value) <= 0) throw new Error('Enter an amount in USD and/or LBP');
      const res = await core.recordExpense(state.session, { category: v.category, usdAmount: num(usd.value), lbpAmount: num(lbpIn.value), method: v.method, note: v.note, date: v.date });
      toast(`Expense recorded (${res.number})`, 'success');
    },
  });
}

async function deleteExpense(e) {
  if (!await confirmDialog({ title: `Delete this ${e.category} expense?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) return;
  try { if (!can('expenses', 'delete')) throw new Error('No permission'); await core.removeDocs(state.session, 'expenses', [e.id]); toast('Expense deleted'); }
  catch (err) { toast(errText(err), 'error'); }
}

// Add/remove categories. Read-only for anyone without settings-update: just shows the current list.
function openCategories() {
  const current = categories();
  if (!can('settings', 'update')) return toast(current.join(', '));
  let rows = [...current];
  const body = h('div', { class: 'stack' });
  const draw = () => body.replaceChildren(...(rows.length ? rows.map((c, i) => h('div', { class: 'row', style: 'justify-content:space-between;gap:8px' }, h('span', {}, c),
    h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': `Remove ${c}`, onclick: () => { rows = rows.filter((_, x) => x !== i); draw(); } }, icon('x', 16))))
    : [h('p', { class: 'muted small' }, 'No categories - add at least one.')]));
  draw();
  const addInput = h('input', { class: 'input', placeholder: 'New category', 'aria-label': 'New category' });
  const addOne = () => { const v = addInput.value.trim(); if (v && !rows.includes(v)) { rows.push(v); addInput.value = ''; draw(); } };
  addInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addOne(); } });
  const s = sheet({
    title: 'Expense categories',
    content: h('div', { class: 'form' }, body, h('div', { class: 'row', style: 'gap:8px' }, addInput, h('button', { class: 'btn soft', type: 'button', onclick: addOne }, icon('plus', 16), 'Add'))),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close() }, 'Cancel'),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await core.updateSettings(state.session, { expenseCategories: rows }); toast('Categories updated', 'success'); s.close(); } catch (e) { toast(errText(e), 'error'); }
      } }, 'Save')],
  });
}

const sheetsFor = () => ({ Expenses: [['Date', 'Reference', 'Category', 'USD', 'LBP', 'USD equivalent', 'Method', 'Note', 'By'],
  ...store.expenses.map(e => [e.date || (e.at || '').slice(0, 10), e.number || '', e.category, num(e.usdAmount), num(e.lbpAmount), num(e.amount), PAYMENT_METHODS[e.method] || e.method, e.note || '', e.by || ''])] });

export default {
  mount(view) {
    let q = '', cat = 'all';
    const stats = h('div', { class: 'stats' }), list = h('div', { class: 'list two' });
    const draw = () => {
      if (!store.loaded.expenses) { setChildren(stats); return list.replaceChildren(...skeletons(3).children); }
      const month = localDay().slice(0, 7);
      const thisMonth = store.expenses.filter(e => (e.date || '').startsWith(month));
      const totalMonth = round2(thisMonth.reduce((t, e) => t + num(e.amount), 0));
      const byCat = {};
      for (const e of thisMonth) byCat[e.category] = round2((byCat[e.category] || 0) + num(e.amount));
      const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
      setChildren(stats,
        statCard({ icon: 'minus', label: 'This month', value: money(totalMonth), tone: totalMonth ? 'red' : 'green' }),
        statCard({ icon: 'layers', label: 'Expenses this month', value: thisMonth.length }),
        statCard({ icon: 'tag', label: 'Top category', value: top ? top[0] : '—', tone: top ? 'gold' : '' }));

      const cats = categories();
      const rows = store.expenses.filter(e => (cat === 'all' || e.category === cat) &&
        (!q || norm(e.category).includes(q) || norm(e.number).includes(q) || norm(e.note).includes(q))).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      if (!rows.length) return list.replaceChildren(store.expenses.length ? emptyState('search', 'No matching expenses') : emptyState('minus', 'No expenses yet', can('expenses', 'create') ? 'Record rent, salaries, utilities and other costs here.' : 'Nothing to show yet.'));
      list.replaceChildren(...rows.map(e => h('div', { class: 'item' },
        h('div', { class: 'avatar red' }, icon('minus', 20)),
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, e.category, e.number ? h('span', { class: 'muted small' }, ' • ', e.number) : null),
          h('div', { class: 'sub' }, day(e.date || e.at), ' • ', PAYMENT_METHODS[e.method] || e.method, e.by ? ` • ${e.by}` : ''),
          num(e.lbpAmount) ? h('div', { class: 'muted small' }, money(num(e.usdAmount)), ' + ', lbp(e.lbpAmount)) : null,
          e.note ? h('div', { class: 'muted small' }, e.note) : null),
        h('div', { class: 'tools', style: 'flex-direction:column;align-items:flex-end;gap:4px' },
          h('b', { style: 'color:var(--danger)' }, '−' + money(e.amount)),
          can('expenses', 'delete') ? iconBtn('trash', 'Delete expense', () => deleteExpense(e), 'danger') : null))));
    };
    view.append(pageHead('Expenses', [
      can('settings', 'update') || can('settings', 'read') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: openCategories }, icon('tag', 16), 'Categories') : null,
      exportButton(sheetsFor, () => `${state.session.tenantId}-expenses`)]), stats,
      h('div', { class: 'toolbar' }, searchBox('Search category, reference or note', v => { q = norm(v.trim()); draw(); }),
        chipGroup([{ value: 'all', label: 'All' }, ...categories().map(c => ({ value: c, label: c }))], cat, v => { cat = v; draw(); })),
      list, can('expenses', 'create') ? fab('Add expense', expenseForm) : null);
    draw();
    return onData(draw);
  },
};
