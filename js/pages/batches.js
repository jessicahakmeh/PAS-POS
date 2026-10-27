// Batches & waste management: receive stock in batches with expiry dates, watch what is expiring, write off waste.
import { h, icon, iconBtn, pageHead, searchBox, chipGroup, emptyState, fab, openForm, toast, statCard, barCard, money, day, norm, exportButton, skeletons, setChildren } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { batchStatus, localDay, addDays, WASTE_REASONS, wasteSummary } from '../../core.js';
import { itemById, daysLabel } from '../stock.js';
import { openWriteOff } from '../components/writeOff.js';

const num = (v) => Number(v) || 0;
const TONE = { expired: 'bad', expiring: 'warn', ok: 'ok', none: '' };

function receiveForm() {
  if (!store.inventory.length) return toast('Add inventory items first', 'error');
  openForm({
    title: 'Receive batch', submitLabel: 'Receive stock',
    fields: [
      { name: 'itemId', label: 'Item', type: 'select', required: true, options: [{ value: '', label: 'Choose an item…' }, ...store.inventory.map(i => ({ value: i.id, label: i.name + (i.perishable ? ' (perishable)' : '') }))] },
      { name: 'qty', label: 'Quantity received', type: 'number', min: 1, step: 1, inputMode: 'numeric', required: true },
      { name: 'expiryDate', label: 'Expiry date', type: 'date', help: 'Required for perishable items. Leave empty for non-food items.' },
      { name: 'unitCost', label: 'Unit cost', type: 'number', min: 0, step: '0.01', inputMode: 'decimal', help: 'What you paid per unit (used to value waste and margins).' },
      { name: 'lotNo', label: 'Lot / batch number', placeholder: 'Optional' },
      ...(store.suppliers.length ? [{ name: 'supplierId', label: 'Supplier', type: 'select', options: [{ value: '', label: 'Not specified' }, ...store.suppliers.map(s => ({ value: s.id, label: s.name }))] }] : []),
    ],
    onSubmit: async (v) => {
      if (!can('batches', 'create')) throw new Error('No permission');
      const sup = store.suppliers.find(s => s.id === v.supplierId);
      await core.receiveBatch(state.session, { itemId: v.itemId, qty: v.qty, unitCost: v.unitCost || 0, expiryDate: v.expiryDate || null, lotNo: v.lotNo || '', supplierId: sup?.id || null, supplierName: sup?.name || '' });
      toast('Batch received - stock updated', 'success');
    },
  });
}

const writeOffForm = (b) => openWriteOff({ item: itemById(b.itemId) || { id: b.itemId, name: b.itemName }, batch: b });

// Correct a typo in a batch's lot number, expiry date or unit cost.
function editBatchForm(b) {
  openForm({
    title: `Edit batch • ${b.itemName}`, submitLabel: 'Save changes',
    fields: [
      { name: 'lotNo', label: 'Lot / batch number', value: b.lotNo || '' },
      { name: 'expiryDate', label: 'Expiry date', type: 'date', value: b.expiryDate || '', help: itemById(b.itemId)?.perishable ? 'Required: this item is perishable.' : 'Leave empty for no expiry.' },
      { name: 'unitCost', label: 'Unit cost', type: 'number', min: 0, step: '0.01', inputMode: 'decimal', value: num(b.unitCost), help: 'Changes only affect future margins and waste values.' },
    ],
    onSubmit: async (v) => {
      if (!can('batches', 'update')) throw new Error('No permission');
      await core.updateBatch(state.session, b.id, { lotNo: v.lotNo, expiryDate: v.expiryDate || null, unitCost: v.unitCost === '' ? 0 : v.unitCost });
      toast('Batch updated', 'success');
    },
  });
}

const enrich = () => store.batches.map(b => { const item = itemById(b.itemId); return { ...b, item, ...batchStatus(b, item) }; });
const sheetsFor = () => {
  const today = localDay();
  return {
    Batches: [['Item', 'Lot', 'Supplier', 'Received', 'Expiry', 'Days left', 'Status', 'Qty received', 'Qty remaining', 'Unit cost', 'Value remaining'],
      ...enrich().map(b => [b.itemName, b.lotNo || '', b.supplierName || '', day(b.receivedAt), b.expiryDate || '', b.daysLeft ?? '', b.state === 'none' ? 'No expiry' : b.state, num(b.qtyReceived), num(b.qtyRemaining), num(b.unitCost), Math.round(num(b.qtyRemaining) * num(b.unitCost) * 100) / 100])],
    'Waste log': [['Date', 'Item', 'Lot', 'Qty', 'Reason', 'Unit cost', 'Value', 'Note', 'By'],
      ...[...store.wasteLog].sort((a, b) => String(b.at).localeCompare(String(a.at))).map(w => [day(w.at), w.itemName, w.lotNo || '', num(w.qty), WASTE_REASONS[w.reason] || w.reason, num(w.unitCost), num(w.value), w.note || '', w.by || ''])],
  };
};

export default {
  mount(view) {
    // Deep link from an inventory item: #/batches?q=<item name> opens the "All batches" tab filtered to that item.
    const initialQ = new URLSearchParams((location.hash.split('?')[1] || '')).get('q') || '';
    let q = norm(initialQ.trim()), tab = initialQ ? 'all' : 'attention';
    const stats = h('div', { class: 'stats' });
    const body = h('div');
    const tabs = h('div');

    function batchCard(b) {
      const low = b.state === 'expired';
      return h('div', { class: 'item', style: 'flex-wrap:wrap' },
        h('div', { class: 'avatar ' + (b.state === 'expired' ? 'red' : b.state === 'expiring' ? 'gold' : 'green') }, icon('clock', 20)),
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, b.itemName), h('div', { class: 'sub' }, b.lotNo ? `Lot ${b.lotNo} • ` : '', `${num(b.qtyRemaining)} of ${num(b.qtyReceived)} left`, b.unitCost ? ` • ${money(b.unitCost)} each` : '')),
        h('div', { class: 'tools' }, can('batches', 'update') ? iconBtn('edit', 'Edit batch', () => editBatchForm(b)) : null,
          can('waste', 'create') ? iconBtn('trash', 'Write off', () => writeOffForm(b), 'danger') : null),
        h('div', { style: 'flex-basis:100%;display:flex;gap:8px;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px dashed var(--line);flex-wrap:wrap' },
          b.expiryDate ? h('span', { class: 'badge ' + TONE[b.state] }, icon(low ? 'alert' : 'clock', 12), `${b.expiryDate} • ${daysLabel(b.daysLeft)}`) : h('span', { class: 'badge' }, 'No expiry'),
          b.supplierName ? h('span', { class: 'muted small' }, b.supplierName) : null,
          low && can('waste', 'create') ? h('button', { class: 'btn sm danger-soft', type: 'button', onclick: () => writeOffForm(b) }, icon('trash', 14), `Write off ${num(b.qtyRemaining)}`) : null));
    }

    const draw = () => {
      const loaded = store.loaded.batches;
      const all = enrich().filter(b => num(b.qtyRemaining) > 0);
      const attention = all.filter(b => b.state === 'expired' || b.state === 'expiring');
      const w30 = wasteSummary(store.wasteLog, addDays(localDay(), -30));
      setChildren(stats,
        statCard({ icon: 'alert', label: 'Expired batches', value: all.filter(b => b.state === 'expired').length, tone: all.some(b => b.state === 'expired') ? 'red' : 'green' }),
        statCard({ icon: 'clock', label: 'Expiring soon', value: all.filter(b => b.state === 'expiring').length, tone: all.some(b => b.state === 'expiring') ? 'gold' : 'green' }),
        statCard({ icon: 'box', label: 'Active batches', value: all.length }),
        can('waste', 'read') ? statCard({ icon: 'trash', label: 'Waste, last 30 days', value: money(w30.value), tone: w30.value ? 'red' : 'green' }) : null);
      setChildren(tabs, chipGroup([{ value: 'attention', label: `Needs attention (${attention.length})` }, { value: 'all', label: 'All batches' }, ...(can('waste', 'read') ? [{ value: 'waste', label: 'Waste log' }] : [])], tab, v => { tab = v; draw(); }));
      if (!loaded) return setChildren(body, skeletons(3));

      if (tab === 'waste') {
        const log = [...store.wasteLog].sort((a, b) => String(b.at).localeCompare(String(a.at))).filter(w => !q || norm(w.itemName).includes(q) || norm(w.lotNo).includes(q));
        const reasons = Object.entries(w30.byReason).map(([r, v]) => ({ label: WASTE_REASONS[r] || r, value: v, text: money(v) })).sort((a, b) => b.value - a.value);
        const items = Object.entries(w30.byItem).map(([n, v]) => ({ label: n, value: v, text: money(v) })).sort((a, b) => b.value - a.value).slice(0, 5);
        return setChildren(body,
          reasons.length ? h('div', { class: 'grid-2', style: 'margin-bottom:12px' }, barCard('Waste by reason (30 days)', reasons, 'warn'), barCard('Top wasted items (30 days)', items, 'warn')) : null,
          log.length ? h('div', { class: 'list two' }, log.map(w => h('div', { class: 'item' },
            h('div', { class: 'avatar red' }, icon('trash', 20)),
            h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, w.itemName), h('div', { class: 'sub' }, `${num(w.qty)} units`, w.lotNo ? ` • Lot ${w.lotNo}` : '', ` • ${day(w.at)} • ${w.by || ''}`), w.note ? h('div', { class: 'sub' }, w.note) : null),
            h('div', { style: 'text-align:right' }, h('b', {}, money(w.value)), h('div', {}, h('span', { class: 'badge bad' }, WASTE_REASONS[w.reason] || w.reason)))))) : emptyState('trash', 'No waste recorded', 'Written-off stock will show up here with its cost.'));
      }

      const rows = (tab === 'attention' ? attention : all).filter(b => !q || norm(b.itemName).includes(q) || norm(b.lotNo).includes(q))
        .sort((a, b) => (a.daysLeft ?? 99999) - (b.daysLeft ?? 99999) || String(a.itemName).localeCompare(String(b.itemName)));
      setChildren(body, rows.length ? h('div', { class: 'list two' }, rows.map(batchCard))
        : tab === 'attention' ? emptyState('check', 'Nothing expiring', 'No batch is expired or close to its expiry date.')
        : emptyState('clock', 'No batches yet', can('batches', 'create') ? 'Receive stock to start tracking batches and expiry dates.' : 'Nothing to show yet.'));
    };

    view.append(pageHead('Batches & waste', [
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { location.hash = '#/inventory'; } }, icon('box', 16), 'Inventory'),
      exportButton(sheetsFor, () => `${state.session.tenantId}-batches`)]), stats,
      h('div', { class: 'toolbar' }, searchBox('Search item or lot', v => { q = norm(v.trim()); draw(); }, initialQ), tabs), body,
      can('batches', 'create') ? fab('Receive batch', receiveForm) : null);
    draw();
    return onData(draw);
  },
};
