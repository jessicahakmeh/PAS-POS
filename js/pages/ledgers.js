// Ledgers: customer statements (what customers owe), supplier statements (what we owe), the stock ledger (every
// stock movement) and the transaction log (every cash payment/refund, in USD, in LBP, and merged).
import { h, icon, pageHead, searchBox, chipGroup, emptyState, openForm, statCard, money, day, norm, exportXlsx, skeletons, setChildren, toast, errText } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { customerBalances, supplierBalances, customerStatement, supplierStatement, transactionLog, transactionSummary, incomeStatement, localDay, STOCK_MOVEMENT, PAYMENT_METHODS, DEFAULT_EXCHANGE_RATE } from '../../core.js';
import { openVoucher } from '../components/payments.js';
import { openStatement } from '../components/statement.js';

const num = (v) => Number(v) || 0;
const lbp = (n) => `${Math.round(num(n)).toLocaleString()} LBP`;

const partyCard = (p, { owedLabel, creditLabel, onclick, iconName = 'book' }) => h('button', { class: 'item tap', type: 'button', style: 'width:100%;text-align:left', onclick },
  h('div', { class: 'avatar ' + (p.balance > 0.004 ? 'gold' : p.balance < -0.004 ? 'red' : 'green') }, icon(iconName, 20)),
  h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, p.name),
    h('div', { class: 'row', style: 'margin-top:4px' }, h('span', { class: 'badge ' + (p.balance > 0.004 ? 'warn' : p.balance < -0.004 ? 'bad' : 'ok') }, p.balance > 0.004 ? `${owedLabel} ${money(p.balance)}` : p.balance < -0.004 ? `${creditLabel} ${money(-p.balance)}` : 'Settled'))),
  icon('chevron', 18));

// The exchange rate is read live by anyone (payments need it); only someone with settings-update can change it.
function openExchangeRate() {
  const rate = num(store.settings?.exchangeRate) || DEFAULT_EXCHANGE_RATE;
  if (!can('settings', 'update')) return toast(`1 USD = ${rate.toLocaleString()} LBP`);
  openForm({
    title: 'Exchange rate', submitLabel: 'Save',
    fields: [{ name: 'exchangeRate', label: 'LBP per 1 USD', type: 'number', min: '1', step: '1', inputMode: 'numeric', value: rate, required: true,
      help: 'Used to convert the LBP side of a payment into its USD equivalent. Payments already recorded keep the rate they were made at.' }],
    onSubmit: async (v) => { if (!can('settings', 'update')) throw new Error('No permission'); await core.updateSettings(state.session, { exchangeRate: v.exchangeRate }); toast('Exchange rate updated', 'success'); },
  });
}

export default {
  mount(view) {
    const hasSales = can('salesOrders', 'read'), hasPurch = can('purchaseOrders', 'read');
    let tab = hasSales ? 'customers' : hasPurch ? 'suppliers' : 'stock', q = '', itemId = '', txFilter = 'all', txFrom = '', txTo = '';
    let pnlFrom = localDay().slice(0, 8) + '01', pnlTo = localDay();
    let moves = null, loading = false, loadedFor = null;
    const stats = h('div', { class: 'stats' }), body = h('div'), tabs = h('div'), tools = h('div', { class: 'toolbar' });

    async function loadMoves(force = false) {
      const key = itemId || '*';
      if (loading || (!force && loadedFor === key)) return;
      loading = true; draw();
      try { moves = await core.stockMovements(state.session, { itemId: itemId || null, limit: 300 }); loadedFor = key; }
      catch (e) { toast(errText(e), 'error'); moves = []; }
      finally { loading = false; draw(); }
    }

    const stockSheets = () => ({ 'Stock ledger': [['Date', 'Item', 'Movement', 'Reference', 'Lot', 'Quantity', 'Balance after', 'Note', 'By'],
      ...(moves || []).map(m => [(m.at || '').replace('T', ' ').slice(0, 16), m.itemName, STOCK_MOVEMENT[m.type] || m.type, m.ref || '', m.lotNo || '', num(m.qty), num(m.balance), m.note || '', m.by || ''])] });
    const txSheets = (entries) => ({ 'Transactions': [['Date', 'Reference', 'Direction', 'Party', 'Order', 'USD', 'LBP', 'USD equivalent', 'Method', 'Note', 'By'],
      ...entries.map(e => [(e.date || '').replace('T', ' ').slice(0, 16), e.number, e.direction === 'in' ? 'Money in' : 'Money out', e.party, e.orderNumber,
        e.usdAmount, e.lbpAmount, e.usdEquivalent, PAYMENT_METHODS[e.method] || e.method, e.note, e.by])] });

    function draw() {
      const cb = hasSales ? customerBalances(store.salesOrders, store.customers) : [], sb = hasPurch ? supplierBalances(store.purchaseOrders, store.suppliers) : [];
      const owed = cb.reduce((t, b) => t + Math.max(0, b.balance), 0), owe = sb.reduce((t, b) => t + Math.max(0, b.balance), 0);
      setChildren(stats,
        hasSales ? statCard({ icon: 'dollar', label: 'Customers owe you', value: money(owed), tone: owed ? 'gold' : 'green' }) : null,
        hasPurch ? statCard({ icon: 'alert', label: 'You owe suppliers', value: money(owe), tone: owe ? 'red' : 'green' }) : null,
        hasSales ? statCard({ icon: 'users', label: 'Customers with balance', value: cb.filter(b => Math.abs(b.balance) > 0.004).length }) : null,
        hasPurch ? statCard({ icon: 'truck', label: 'Suppliers to pay', value: sb.filter(b => b.balance > 0.004).length }) : null);
      setChildren(tabs, chipGroup([...(hasSales ? [{ value: 'customers', label: 'Customers' }] : []), ...(hasPurch ? [{ value: 'suppliers', label: 'Suppliers' }] : []),
        { value: 'transactions', label: 'Transactions' }, ...(hasSales && can('expenses', 'read') ? [{ value: 'pnl', label: 'P&L' }] : []), { value: 'stock', label: 'Stock ledger' }], tab, v => { tab = v; if (v === 'stock') loadMoves(); draw(); }));
      const itemSel = h('select', { class: 'input', 'aria-label': 'Filter by item' }, h('option', { value: '' }, 'All items'), ...store.inventory.map(i => h('option', { value: i.id, selected: i.id === itemId }, i.name)));
      itemSel.addEventListener('change', () => { itemId = itemSel.value; loadMoves(); });

      if (tab === 'transactions') {
        const entries = transactionLog(store.salesOrders, store.purchaseOrders, store.expenses).filter(e => {
          const d = (e.date || '').slice(0, 10);
          return (txFilter === 'all' || e.direction === txFilter) && (!txFrom || d >= txFrom) && (!txTo || d <= txTo)
            && (!q || norm(e.party).includes(q) || norm(e.number).includes(q) || norm(e.orderNumber).includes(q));
        });
        const sum = transactionSummary(entries);
        const txFromInput = h('input', { class: 'input', type: 'date', value: txFrom, 'aria-label': 'From date' });
        const txToInput = h('input', { class: 'input', type: 'date', value: txTo, 'aria-label': 'To date' });
        txFromInput.addEventListener('change', () => { txFrom = txFromInput.value; draw(); });
        txToInput.addEventListener('change', () => { txTo = txToInput.value; draw(); });
        const txThisMonth = () => { txFrom = localDay().slice(0, 8) + '01'; txTo = localDay(); draw(); };
        const txAllTime = () => { txFrom = ''; txTo = ''; draw(); };
        setChildren(tools, searchBox('Search reference, order or party', v => { q = norm(v.trim()); draw(); }, q),
          h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center' },
            h('div', { class: 'field', style: 'margin:0' }, h('label', {}, 'From'), txFromInput), h('div', { class: 'field', style: 'margin:0' }, h('label', {}, 'To'), txToInput),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: txThisMonth }, 'This month'), h('button', { class: 'btn ghost sm', type: 'button', onclick: txAllTime }, 'All time')),
          h('div', { class: 'row', style: 'justify-content:space-between;flex-wrap:wrap;gap:8px' },
            chipGroup([{ value: 'all', label: 'All' }, { value: 'in', label: 'Money in' }, { value: 'out', label: 'Money out' }], txFilter, v => { txFilter = v; draw(); }),
            h('button', { class: 'btn soft sm', type: 'button', disabled: !entries.length, onclick: () => exportXlsx(`${state.session.tenantId}-transactions-${new Date().toISOString().slice(0, 10)}.xlsx`, txSheets(entries)) }, icon('download', 16), 'Export')));
        return setChildren(body,
          h('div', { class: 'stats' },
            statCard({ icon: 'plus', label: 'Money in (USD)', value: money(sum.inUsd), tone: 'green' }),
            statCard({ icon: 'plus', label: 'Money in (LBP)', value: lbp(sum.inLbp), tone: 'green' }),
            statCard({ icon: 'minus', label: 'Money out (USD)', value: money(sum.outUsd), tone: 'red' }),
            statCard({ icon: 'minus', label: 'Money out (LBP)', value: lbp(sum.outLbp), tone: 'red' }),
            statCard({ icon: 'dollar', label: 'Net (merged, USD)', value: money(sum.netUsd), tone: sum.netUsd >= 0 ? 'green' : 'red' })),
          entries.length ? h('div', { class: 'list two', style: 'margin-top:12px' }, entries.map(e => h('button', { class: 'item tap', type: 'button', style: 'width:100%;text-align:left', onclick: () => openVoucher(e) },
            h('div', { class: 'avatar ' + (e.direction === 'in' ? 'green' : 'red') }, icon(e.direction === 'in' ? 'plus' : 'minus', 18)),
            h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, e.number || e.orderNumber, ' • ', e.party),
              h('div', { class: 'sub' }, e.source === 'sale' ? `Sale ${e.orderNumber}` : e.source === 'purchase' ? `Purchase ${e.orderNumber}` : 'Expense', ' • ', PAYMENT_METHODS[e.method] || e.method),
              h('div', { class: 'muted small' }, day(e.date), e.by ? ` • ${e.by}` : '', e.note ? ` • ${e.note}` : '')),
            h('div', { style: 'text-align:right' },
              h('b', { style: `color:var(--${e.direction === 'in' ? 'success' : 'danger'})` }, (e.direction === 'in' ? '+' : '−') + money(e.usdEquivalent)),
              h('div', { class: 'muted small' }, e.usdAmount ? money(e.usdAmount) : '', e.usdAmount && e.lbpAmount ? ' + ' : '', e.lbpAmount ? lbp(e.lbpAmount) : ''))))) :
            emptyState('book', 'No transactions yet', 'Every sales payment/refund, supplier payment/refund and expense appears here, in both currencies.'));
      }

      if (tab === 'pnl') {
        const fromInput = h('input', { class: 'input', type: 'date', value: pnlFrom, 'aria-label': 'From date' });
        const toInput = h('input', { class: 'input', type: 'date', value: pnlTo, 'aria-label': 'To date' });
        fromInput.addEventListener('change', () => { pnlFrom = fromInput.value; draw(); });
        toInput.addEventListener('change', () => { pnlTo = toInput.value; draw(); });
        const thisMonth = () => { pnlFrom = localDay().slice(0, 8) + '01'; pnlTo = localDay(); draw(); };
        const stmt = incomeStatement(store.salesOrders, store.expenses, pnlFrom, pnlTo);
        setChildren(tools, h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center' },
          h('div', { class: 'field', style: 'margin:0' }, h('label', {}, 'From'), fromInput), h('div', { class: 'field', style: 'margin:0' }, h('label', {}, 'To'), toInput),
          h('button', { class: 'btn ghost sm', type: 'button', onclick: thisMonth }, 'This month'),
          h('button', { class: 'btn soft sm', type: 'button', onclick: () => exportXlsx(`${state.session.tenantId}-income-statement-${pnlFrom}-to-${pnlTo}.xlsx`, {
            'Income statement': [['', 'USD'], ['Revenue (net of returns)', stmt.revenue], ['Cost of goods sold', -stmt.cogs], ['Gross profit', stmt.grossProfit],
              ...stmt.byCategory.map(c => [`Expense: ${c.category}`, -c.value]), ['Total expenses', -stmt.expenseTotal], ['Net profit', stmt.netProfit]],
          }) }, icon('download', 16), 'Export')));
        const row = (label, value, opts = {}) => h('div', { class: 'row', style: `justify-content:space-between;padding:8px 0;${opts.border !== false ? 'border-top:1px solid var(--line)' : ''}` },
          h('span', { style: opts.bold ? 'font-weight:800' : '' }, label), h('b', { style: `color:var(--${value < 0 ? 'danger' : opts.bold ? (value >= 0 ? 'success' : 'danger') : ''})` }, (value < 0 ? '−' : '') + money(Math.abs(value))));
        return setChildren(body,
          h('div', { class: 'stats' },
            statCard({ icon: 'dollar', label: 'Revenue', value: money(stmt.revenue), tone: 'green' }),
            statCard({ icon: 'box', label: 'Cost of goods', value: money(stmt.cogs) }),
            statCard({ icon: 'minus', label: 'Expenses', value: money(stmt.expenseTotal), tone: stmt.expenseTotal ? 'red' : 'green' }),
            statCard({ icon: 'trend', label: 'Net profit', value: money(stmt.netProfit), tone: stmt.netProfit >= 0 ? 'green' : 'red' })),
          h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Income statement'),
            row('Revenue (net of returns)', stmt.revenue, { border: false }), row('Cost of goods sold', -stmt.cogs), row('Gross profit', stmt.grossProfit, { bold: true }),
            stmt.byCategory.map(c => row(c.category, -c.value)), row('Total expenses', -stmt.expenseTotal, { bold: true }), row('Net profit', stmt.netProfit, { bold: true })),
          !stmt.byCategory.length && !stmt.revenue ? emptyState('trend', 'Nothing in this range yet', 'Fulfil a sale or record an expense to see it here.') : null);
      }

      setChildren(tools, tab === 'stock' ? [itemSel, h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'muted small' }, moves ? `Showing the latest ${moves.length} movement${moves.length === 1 ? '' : 's'}` : ''),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => loadMoves(true) }, 'Refresh'),
          h('button', { class: 'btn soft sm', type: 'button', disabled: !moves?.length, onclick: () => exportXlsx(`${state.session.tenantId}-stock-ledger-${new Date().toISOString().slice(0, 10)}.xlsx`, stockSheets()) }, icon('download', 16), 'Export')))]
        : searchBox(tab === 'customers' ? 'Search customers' : 'Search suppliers', v => { q = norm(v.trim()); draw(); }, q));

      if (tab === 'customers') {
        const rows = cb.filter(b => !q || norm(b.name).includes(q));
        return setChildren(body, rows.length ? h('div', { class: 'list two' }, rows.map(p => partyCard(p, { owedLabel: 'Owes you', creditLabel: 'You owe them', iconName: 'users', onclick: () => openStatement({
          title: p.name, subtitle: 'Customer statement', owedLabel: 'Owes you', creditLabel: 'You owe them', entries: customerStatement(store.salesOrders, p.id) }) })))
          : emptyState('users', 'No customer activity yet', 'Sales appear here once they are fulfilled.'));
      }
      if (tab === 'suppliers') {
        const rows = sb.filter(b => !q || norm(b.name).includes(q));
        return setChildren(body, rows.length ? h('div', { class: 'list two' }, rows.map(p => partyCard(p, { owedLabel: 'You owe', creditLabel: 'Supplier owes you', iconName: 'truck', onclick: () => openStatement({
          title: p.name, subtitle: 'Supplier statement', owedLabel: 'You owe', creditLabel: 'Supplier owes you', entries: supplierStatement(store.purchaseOrders, p.id) }) })))
          : emptyState('truck', 'No supplier activity yet', 'Placed purchase orders appear here.'));
      }
      if (loading || !moves) return setChildren(body, skeletons(4));
      setChildren(body, moves.length ? h('div', { class: 'list two' }, moves.map(m => h('div', { class: 'item' },
        h('div', { class: 'avatar ' + (m.qty > 0 ? 'green' : 'red') }, icon(m.qty > 0 ? 'plus' : 'minus', 18)),
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, m.itemName), h('div', { class: 'sub' }, STOCK_MOVEMENT[m.type] || m.type, m.ref ? ` • ${m.ref}` : '', m.lotNo ? ` • lot ${m.lotNo}` : ''),
          h('div', { class: 'muted small' }, (m.at || '').replace('T', ' ').slice(0, 16), m.by ? ` • ${m.by}` : '', m.note ? ` • ${m.note}` : '')),
        h('div', { style: 'text-align:right' }, h('b', { style: `color:var(--${m.qty > 0 ? 'success' : 'danger'})` }, (m.qty > 0 ? '+' : '') + m.qty), h('div', { class: 'muted small' }, `bal ${m.balance}`)))))
        : emptyState('book', 'No stock movements yet', 'Receipts, sales, returns, waste and adjustments are logged here.'));
    }

    view.append(pageHead('Ledgers', [h('button', { class: 'btn ghost sm', type: 'button', onclick: openExchangeRate }, icon('tag', 16), 'Exchange rate')]), stats, tabs, tools, body);
    draw();
    if (tab === 'stock') loadMoves();
    return onData(draw);
  },
};
