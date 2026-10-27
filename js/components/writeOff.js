// Write-off sheet (waste): for a specific batch, or for unbatched stock of an item when `batch` is null.
import { openForm, toast } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { batchStatus, WASTE_REASONS } from '../../core.js';

export function openWriteOff({ item, batch = null, max }) {
  const limit = batch ? Number(batch.qtyRemaining) : Number(max);
  const expired = batch ? batchStatus(batch, item).state === 'expired' : false;
  openForm({
    title: `Write off • ${item.name}${batch?.lotNo ? ` (lot ${batch.lotNo})` : batch ? '' : ' (unbatched stock)'}`, submitLabel: 'Write off', danger: true,
    fields: [
      { name: 'qty', label: `Quantity (max ${limit})`, type: 'number', min: 1, max: limit, step: 1, inputMode: 'numeric', value: limit, required: true },
      { name: 'reason', label: 'Reason', type: 'select', value: expired ? 'expired' : 'spoiled', options: Object.entries(WASTE_REASONS).map(([value, label]) => ({ value, label })) },
      { name: 'note', label: 'Note', placeholder: 'Optional' },
    ],
    onSubmit: async (v) => {
      if (!can('waste', 'create')) throw new Error('No permission');
      await core.writeOff(state.session, { itemId: item.id, batchId: batch?.id || null, qty: v.qty, reason: v.reason, note: v.note });
      toast('Written off - stock reduced', 'success');
    },
  });
}
