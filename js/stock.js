// Stock helpers derived from the live store (batches per item, expiry state, sellable quantity).
import { store } from './data.js';
import { stockPosition, batchStatus, localDay } from '../core.js';

export const batchesOf = (itemId) => store.batches.filter(b => b.itemId === itemId);
export const positionOf = (item) => stockPosition(item, batchesOf(item.id), localDay());
export const itemById = (id) => store.inventory.find(i => i.id === id);

// Worst expiry state among an item's active batches: 'expired' | 'expiring' | 'ok' | 'none', plus counts and the soonest expiry.
export function expiryOverview(item, today = localDay()) {
  const active = batchesOf(item.id).filter(b => Number(b.qtyRemaining) > 0 && b.expiryDate);
  let expired = 0, expiring = 0, soonest = null;
  for (const b of active) {
    const st = batchStatus(b, item, today);
    if (st.state === 'expired') expired++; else if (st.state === 'expiring') expiring++;
    if (!soonest || b.expiryDate < soonest.expiryDate) soonest = { expiryDate: b.expiryDate, daysLeft: st.daysLeft };
  }
  return { state: expired ? 'expired' : expiring ? 'expiring' : active.length ? 'ok' : 'none', expired, expiring, soonest };
}

export const daysLabel = (d) => d < 0 ? `expired ${-d} day${d === -1 ? '' : 's'} ago` : d === 0 ? 'expires today' : `${d} day${d === 1 ? '' : 's'} left`;
