// Core logic (crypto, RBAC, tenant/user/role operations). No browser or SDK-URL imports, so the same code
// runs in the browser (app.js) and in Node (scripts/), with the Firestore functions injected via createCore().
//
// Security model (Spark plan, no Firebase Authentication - Firestore rules cannot identify callers):
//  - Tenant data lives under data/{dataKey}/..., dataKey = random secret; rules allow exact-path access only.
//  - A login record lives at tenants/{tenant}/logins/{id}. Both `id` and the AES key are derived from
//    (tenant, username, password) with PBKDF2, so the record is only findable/decryptable with the password.
//  - The platform admin has the same kind of login (platformLogins/{id}) that unlocks `adminKey`, which
//    decrypts every tenant's dataKey from platform/{adminKey}/tenants/{name}.
//  - RBAC (roles/permissions) is enforced by this client code. It cannot be enforced server-side without Auth.

// ---------- RBAC definitions ----------
export const RESOURCES = ['inventory', 'batches', 'waste', 'salesOrders', 'purchaseOrders', 'expenses', 'reports', 'ledgers', 'customers', 'suppliers', 'supplierPrices', 'settings', 'users', 'roles'];
export const ACTIONS = ['create', 'read', 'update', 'delete'];
export const DATA_COLLS = ['inventory', 'batches', 'wasteLog', 'stockLedger', 'salesOrders', 'purchaseOrders', 'expenses', 'customers', 'suppliers', 'supplierPrices', 'users', 'roles', 'meta'];
export const RESOURCE_LABELS = { inventory: 'Inventory', batches: 'Batches', waste: 'Waste', salesOrders: 'Sales orders', purchaseOrders: 'Purchase orders', expenses: 'Expenses', reports: 'Reports',
  ledgers: 'Ledgers', customers: 'Customers', suppliers: 'Suppliers', supplierPrices: 'Supplier prices', settings: 'Settings (exchange rate)', users: 'Users', roles: 'Roles' };

const flags = (create, read, update, del) => ({ create, read, update, delete: del });
const ALL = flags(true, true, true, true);
const NONE = flags(false, false, false, false);

export const fullPermissions = () => Object.fromEntries(RESOURCES.map(r => [r, { ...ALL }]));

// Normalises any stored permissions object into strict booleans for every resource/action.
export function normalizePermissions(p = {}) {
  return Object.fromEntries(RESOURCES.map(r => [r, Object.fromEntries(ACTIONS.map(a => [a, p?.[r]?.[a] === true]))]));
}

export const DEFAULT_ROLES = [
  // The Owner is the one protected, non-deletable, non-reassignable-by-others role a tenant always has exactly one
  // of (see transferOwnership). Admin exists for everything else that needs full access: unlike Owner, any number
  // of users can hold it, and (being an ordinary, non-system role) it can be freely edited or deleted like any other.
  { id: 'owner', name: 'Owner', system: true, permissions: fullPermissions() },
  { id: 'admin', name: 'Admin', system: false, permissions: fullPermissions() },
  { id: 'manager', name: 'Manager', system: false, permissions: normalizePermissions({
      inventory: ALL, batches: ALL, waste: flags(true, true, false, false), salesOrders: ALL, purchaseOrders: ALL, expenses: ALL, reports: flags(false, true, false, false), ledgers: flags(false, true, false, false), customers: ALL, suppliers: ALL, supplierPrices: ALL,
      settings: flags(false, true, true, false), users: flags(false, true, false, false), roles: flags(false, true, false, false) }) },
  { id: 'staff', name: 'Staff', system: false, permissions: normalizePermissions({
      inventory: flags(true, true, true, false), batches: flags(true, true, true, false), waste: flags(true, true, false, false), salesOrders: flags(true, true, true, false),
      purchaseOrders: flags(false, true, false, false), expenses: flags(true, true, false, false), customers: flags(true, true, true, false), suppliers: flags(true, true, true, false), supplierPrices: flags(true, true, true, false),
      settings: flags(false, true, false, false) }) },
  { id: 'viewer', name: 'Viewer', system: false, permissions: normalizePermissions({
      inventory: flags(false, true, false, false), batches: flags(false, true, false, false), waste: flags(false, true, false, false), salesOrders: flags(false, true, false, false),
      purchaseOrders: flags(false, true, false, false), expenses: flags(false, true, false, false), customers: flags(false, true, false, false), suppliers: flags(false, true, false, false), supplierPrices: flags(false, true, false, false),
      settings: flags(false, true, false, false) }) },
];

// ---------- Low stock (threshold is configurable per item via item.lowStock) ----------
export const DEFAULT_LOW_STOCK = 5;
export const lowStockOf = (item) => {
  const raw = item?.lowStock, n = Number(raw);
  return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOW_STOCK;
};
export const isLowStock = (item) => (Number(item?.qty) || 0) <= lowStockOf(item);

// ---------- Batches, expiry, waste (pure functions) ----------
// A batch = one receipt of stock: { itemId, itemName, supplierId, poId, lotNo, qtyReceived, qtyRemaining, unitCost, receivedAt, expiryDate|null }.
// inventory.qty stays the authoritative on-hand total. Stock not covered by any batch (e.g. entered by hand) is "unbatched".
export const DEFAULT_EXPIRY_ALERT_DAYS = 7;
export const expiryAlertOf = (item) => {
  const raw = item?.expiryAlertDays, n = Number(raw);
  return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_EXPIRY_ALERT_DAYS;
};
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const daysBetween = (fromDay, toDay) => Math.round((Date.parse(toDay + 'T00:00:00Z') - Date.parse(fromDay + 'T00:00:00Z')) / 86400000);
export const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const sum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// state: 'none' (no expiry) | 'ok' | 'expiring' (within the item's alert window) | 'expired'
export function batchStatus(batch, item, today = localDay()) {
  if (!batch?.expiryDate) return { state: 'none', daysLeft: null };
  const daysLeft = daysBetween(today, batch.expiryDate);
  return { state: daysLeft < 0 ? 'expired' : daysLeft <= expiryAlertOf(item) ? 'expiring' : 'ok', daysLeft };
}

// How an item's on-hand quantity splits between batches, expired stock and unbatched stock. `batches` = that item's batches.
export function stockPosition(item, batches, today = localDay()) {
  const active = batches.filter(b => Number(b.qtyRemaining) > 0);
  const batched = sum(active, b => b.qtyRemaining);
  const expired = sum(active.filter(b => b.expiryDate && b.expiryDate < today), b => b.qtyRemaining);
  const qty = Number(item?.qty) || 0;
  const unbatched = Math.max(0, qty - batched);
  return { qty, batched, expired, unbatched, sellable: unbatched + (batched - expired) };
}

// First-Expiry-First-Out: batches with an expiry (soonest first), then non-expiring batches (oldest first), then unbatched stock.
// Expired batches are never allocated (they must be written off). Returns { allocations, unbatched, shortfall }.
export function allocateFEFO(item, batches, qty, today = localDay()) {
  const usable = batches.filter(b => Number(b.qtyRemaining) > 0 && !(b.expiryDate && b.expiryDate < today)).sort((a, b) =>
    (a.expiryDate ? 0 : 1) - (b.expiryDate ? 0 : 1) || String(a.expiryDate || '').localeCompare(String(b.expiryDate || '')) || String(a.receivedAt || '').localeCompare(String(b.receivedAt || '')));
  let need = Number(qty), allocations = [];
  for (const b of usable) {
    if (need <= 0) break;
    const take = Math.min(need, Number(b.qtyRemaining));
    allocations.push({ batchId: b.id, lotNo: b.lotNo || '', expiryDate: b.expiryDate || null, unitCost: Number(b.unitCost) || 0, qty: take });
    need -= take;
  }
  const takeU = Math.min(need, stockPosition(item, batches, today).unbatched);
  need -= takeU;
  return { allocations, unbatched: takeU, shortfall: need };
}

// Manual override of FEFO: `picks` = [{ batchId | null (unbatched), qty }] must add up to `qty`. Expired batches can never be picked.
// Returns the same shape as allocateFEFO, or throws an Error explaining what is wrong.
export function manualAllocate(item, batches, qty, picks, today = localDay()) {
  qty = Number(qty);
  const used = new Map();
  const allocations = [];
  let unbatched = 0, total = 0;
  for (const p of picks || []) {
    const n = Number(p.qty);
    if (!Number.isFinite(n) || n < 0) throw new Error('Quantities must be 0 or more');
    if (n === 0) continue;
    total += n;
    if (p.batchId === null || p.batchId === undefined || p.batchId === '') { unbatched += n; continue; }
    const b = batches.find(x => x.id === p.batchId);
    if (!b) throw new Error('A selected batch no longer exists');
    if (b.expiryDate && b.expiryDate < today) throw new Error(`Lot ${b.lotNo || b.id} is expired and cannot be sold`);
    used.set(b.id, (used.get(b.id) || 0) + n);
    if (used.get(b.id) > Number(b.qtyRemaining)) throw new Error(`Lot ${b.lotNo || '—'} only has ${b.qtyRemaining} left`);
  }
  if (total !== qty) throw new Error(`Selected ${total} but the order needs ${qty}`);
  const avail = stockPosition(item, batches, today).unbatched;
  if (unbatched > avail) throw new Error(`Only ${avail} unbatched units available`);
  for (const [id, n] of used) { const b = batches.find(x => x.id === id); allocations.push({ batchId: id, lotNo: b.lotNo || '', expiryDate: b.expiryDate || null, unitCost: Number(b.unitCost) || 0, qty: n }); }
  allocations.sort((a, b) => String(a.expiryDate || '9999').localeCompare(String(b.expiryDate || '9999')));
  return { allocations, unbatched, shortfall: 0 };
}

// Reorder suggestions for low-stock items: cheapest supplier per item, grouped by supplier, minus what is already on order.
export function suggestReorders(items, suppliers, prices, purchaseOrders = []) {
  const onOrder = new Map();
  for (const po of purchaseOrders) if (['ordered', 'partial', 'draft'].includes(po.status)) for (const l of po.lines) onOrder.set(l.itemId, (onOrder.get(l.itemId) || 0) + Math.max(0, (Number(l.qty) || 0) - (Number(l.received) || 0)));
  const groups = new Map();
  for (const item of items) {
    const qty = Number(item.qty) || 0, level = lowStockOf(item), pending = onOrder.get(item.id) || 0;
    if (qty + pending > level) continue;
    const offer = prices.filter(p => p.itemId === item.id && suppliers.some(s => s.id === p.supplierId)).sort((a, b) => Number(a.price) - Number(b.price))[0];
    if (!offer) continue;
    const need = Math.max(1, level * 2 - qty - pending);
    const sup = suppliers.find(s => s.id === offer.supplierId);
    if (!groups.has(sup.id)) groups.set(sup.id, { supplierId: sup.id, supplierName: sup.name, lines: [] });
    groups.get(sup.id).lines.push({ itemId: item.id, itemName: item.name, qty: need, unitPrice: Number(offer.price) });
  }
  return [...groups.values()].map(g => ({ ...g, total: orderTotal(g.lines) })).sort((a, b) => a.supplierName.localeCompare(b.supplierName));
}

export const WASTE_REASONS = { expired: 'Expired', spoiled: 'Spoiled', damaged: 'Damaged', other: 'Other' };

export function wasteSummary(log, sinceDay = '0000-00-00') {
  const rows = log.filter(w => (w.at || '').slice(0, 10) >= sinceDay);
  const byReason = {}, byItem = {};
  for (const w of rows) {
    byReason[w.reason] = (byReason[w.reason] || 0) + (Number(w.value) || 0);
    byItem[w.itemName] = (byItem[w.itemName] || 0) + (Number(w.value) || 0);
  }
  return { count: rows.length, value: round2(sum(rows, w => w.value)), units: sum(rows, w => w.qty), byReason, byItem };
}

// ---------- Orders (pure) ----------
export const SALES_STATUS = { draft: 'Draft', confirmed: 'Confirmed', fulfilled: 'Fulfilled', returned: 'Returned', cancelled: 'Cancelled' };
export const PURCHASE_STATUS = { draft: 'Draft', ordered: 'Ordered', partial: 'Part received', received: 'Received', closed: 'Closed short', cancelled: 'Cancelled' };
export const orderTotal = (lines) => round2(sum(lines, l => (Number(l.qty) || 0) * (Number(l.unitPrice) || 0)));

// ---------- Payments, returns and balances (pure) ----------
// Payments are entries { id, kind: 'payment' | 'refund', usdAmount, lbpAmount, exchangeRate, amount, method, note,
// number, at, by } on an order. `amount` is always the USD-equivalent of usdAmount + lbpAmount/exchangeRate (rounded
// to cents) - every balance/statement calculation below works off `amount`, so it is unaffected by the currency mix
// a given payment was made in. `number` is that payment's own reference: REC-YY-#### for money in, PV-YY-#### for
// money out (see recordPayment / nextNumber).
// Sales orders (customer pays us):  net = total - returnedValue;  balance = net - paidTotal   (>0 customer owes, <0 refund due)
// Purchase orders (we pay supplier): payable = receivedValue - returnedValue - paidTotal       (>0 we owe, <0 supplier owes us)
export const PAYMENT_METHODS = { cash: 'Cash', card: 'Card', transfer: 'Bank transfer', cheque: 'Cheque', other: 'Other' };
// LBP per 1 USD. A starting default only - each tenant sets its own live rate (Ledgers -> Exchange rate), stored at
// data/{dataKey}/meta/settings and used to convert the LBP side of every payment into its USD equivalent.
export const DEFAULT_EXCHANGE_RATE = 89000;
// Starting expense categories - each tenant can add/remove its own list (Expenses -> Categories), stored alongside the exchange rate at meta/settings.
export const DEFAULT_EXPENSE_CATEGORIES = ['Rent', 'Utilities', 'Salaries', 'Transport', 'Maintenance', 'Marketing', 'Bank fees', 'Other'];
export const paidTotalOf = (o) => Array.isArray(o?.payments) ? round2(sum(o.payments, p => p.kind === 'refund' ? -Number(p.amount) : Number(p.amount))) : (o?.paid ? round2(Number(o.total) || 0) : 0);
export const salesNet = (o) => round2((Number(o?.total) || 0) - (Number(o?.returnedValue) || 0));
export const isInvoiced = (o) => o?.status === 'fulfilled' || o?.status === 'returned';
export const salesBalance = (o) => isInvoiced(o) ? round2(salesNet(o) - paidTotalOf(o)) : 0;
export const receivedValue = (po) => round2(sum(po?.lines || [], l => (Number(l.received) || 0) * (Number(l.unitPrice) || 0)));
export const payableBalance = (po) => ['draft', 'cancelled'].includes(po?.status) ? 0 : round2(receivedValue(po) - (Number(po.returnedValue) || 0) - paidTotalOf(po));
// 'paid' | 'part' | 'unpaid' | 'refund' (customer overpaid after a return) | 'settled' (nothing owed)
export function paymentState(o) {
  const bal = salesBalance(o), paid = paidTotalOf(o), net = salesNet(o);
  if (bal < -0.004) return 'refund';
  if (net <= 0.004 && Math.abs(bal) < 0.005) return 'settled';
  if (bal <= 0.004) return 'paid';
  return paid > 0.004 ? 'part' : 'unpaid';
}

// Sales KPIs since a day (ISO date). Revenue and cost are net of returns; `unpaid` is what customers still owe (all time).
export function salesSummary(orders, sinceDay = '0000-00-00') {
  const done = orders.filter(o => isInvoiced(o) && (o.fulfilledAt || '').slice(0, 10) >= sinceDay);
  const top = {};
  for (const o of done) for (const l of o.lines) top[l.itemName] = (top[l.itemName] || 0) + Math.max(0, (Number(l.qty) || 0) - (Number(l.returnedQty) || 0)) * (Number(l.unitPrice) || 0);
  const revenue = round2(sum(done, salesNet)), cost = round2(sum(done, o => (Number(o.cost) || 0) - (Number(o.returnedCost) || 0)));
  return {
    orders: done.filter(o => salesNet(o) > 0).length, revenue, cost, margin: round2(revenue - cost),
    unpaid: round2(sum(orders.filter(isInvoiced), o => Math.max(0, salesBalance(o)))),
    refundsDue: round2(sum(orders.filter(isInvoiced), o => Math.max(0, -salesBalance(o)))),
    open: orders.filter(o => o.status === 'draft' || o.status === 'confirmed').length,
    top: Object.entries(top).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value: round2(value) })).sort((a, b) => b.value - a.value),
  };
}

// ---------- Statements (customer / supplier ledgers), built from orders ----------
// Each entry: { date, ref, text, change, balance }. Customer balance > 0 = customer owes us. Supplier balance > 0 = we owe the supplier.
function withBalances(entries) {
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.seq || 0) - (b.seq || 0));
  let bal = 0;
  return entries.map(e => { bal = round2(bal + e.change); return { ...e, balance: bal }; });
}
const methodLabel = (m) => PAYMENT_METHODS[m] || m || '';
const paymentEntries = (o, sign) => (o.payments || []).map((p, i) => ({ date: p.at, ref: p.number || o.number, seq: 2 + i * 0.01,
  text: `${p.kind === 'refund' ? 'Refund' : 'Payment'}${p.number ? ' ' + p.number : ''} (${methodLabel(p.method)})`, change: (p.kind === 'refund' ? 1 : -1) * sign * Number(p.amount) }));

export function customerStatement(orders, customerId) {
  const mine = orders.filter(o => (o.customerId || null) === (customerId || null) && isInvoiced(o));
  const entries = [];
  for (const o of mine) {
    const invRef = o.invoiceNumber || o.number; // the sales invoice reference, falling back to the order number for orders fulfilled before invoice numbers existed
    entries.push({ date: o.fulfilledAt || o.createdAt, ref: invRef, seq: 0, text: `Sale ${invRef}`, change: Number(o.total) || 0 });
    (o.returns || []).forEach((r, i) => entries.push({ date: r.at, ref: r.number || o.number, seq: 1 + i * 0.01, text: `Return ${r.number || o.number}`, change: -Number(r.total) }));
    if (Array.isArray(o.payments)) entries.push(...paymentEntries(o, 1));
    else if (o.paid) entries.push({ date: o.paidAt || o.fulfilledAt, ref: o.number, seq: 2, text: 'Payment', change: -(Number(o.total) || 0) });
  }
  return withBalances(entries);
}

export function supplierStatement(pos, supplierId) {
  const mine = pos.filter(o => o.supplierId === supplierId && !['draft', 'cancelled'].includes(o.status));
  const entries = [];
  for (const o of mine) {
    if (Array.isArray(o.receipts) && o.receipts.length) o.receipts.forEach((r, i) => entries.push({ date: r.at, ref: r.number || o.number, seq: i * 0.01, text: `Goods received ${r.number || o.number}`, change: Number(r.value) || 0 }));
    else if (receivedValue(o) > 0) entries.push({ date: o.receivedAt || o.createdAt, ref: o.number, seq: 0, text: `Goods received ${o.number}`, change: receivedValue(o) });
    (o.returns || []).forEach((r, i) => entries.push({ date: r.at, ref: r.number || o.number, seq: 1 + i * 0.01, text: `Returned to supplier ${r.number || o.number}`, change: -Number(r.total) }));
    entries.push(...paymentEntries(o, 1).map(e => ({ ...e, change: e.change })));
  }
  return withBalances(entries);
}

// ---------- Transaction log: every money-in/money-out payment across all orders, in both currencies ----------
// One row per payment/refund ever recorded, regardless of which order it belongs to. `direction` is from the
// tenant's point of view: 'in' = a customer payment or a refund received back from a supplier; 'out' = a customer
// refund or a payment made to a supplier. usdAmount/lbpAmount are the actual currency mix handed over or received;
// usdEquivalent (== the payment's `amount`) is what that was worth in USD using the exchange rate at the time.
export function transactionLog(salesOrders, purchaseOrders, expenses) {
  const entries = [];
  for (const o of salesOrders || []) for (const p of o.payments || [])
    entries.push({ date: p.at, number: p.number || '', orderNumber: o.number, party: o.customerName || 'Walk-in customer', source: 'sale',
      direction: p.kind === 'payment' ? 'in' : 'out', usdAmount: Number(p.usdAmount ?? p.amount) || 0, lbpAmount: Number(p.lbpAmount) || 0,
      exchangeRate: Number(p.exchangeRate) || DEFAULT_EXCHANGE_RATE, usdEquivalent: Number(p.amount) || 0, method: p.method, note: p.note || '', by: p.by || '' });
  for (const o of purchaseOrders || []) for (const p of o.payments || [])
    entries.push({ date: p.at, number: p.number || '', orderNumber: o.number, party: o.supplierName || '', source: 'purchase',
      direction: p.kind === 'payment' ? 'out' : 'in', usdAmount: Number(p.usdAmount ?? p.amount) || 0, lbpAmount: Number(p.lbpAmount) || 0,
      exchangeRate: Number(p.exchangeRate) || DEFAULT_EXCHANGE_RATE, usdEquivalent: Number(p.amount) || 0, method: p.method, note: p.note || '', by: p.by || '' });
  for (const e of expenses || [])
    entries.push({ date: e.at, number: e.number || '', orderNumber: '', party: e.category || 'Expense', source: 'expense',
      direction: 'out', usdAmount: Number(e.usdAmount ?? e.amount) || 0, lbpAmount: Number(e.lbpAmount) || 0,
      exchangeRate: Number(e.exchangeRate) || DEFAULT_EXCHANGE_RATE, usdEquivalent: Number(e.amount) || 0, method: e.method, note: e.note || '', by: e.by || '' });
  return entries.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
// Totals for the transaction log: each currency's actual money in/out, plus one merged USD-equivalent net figure.
export function transactionSummary(entries) {
  const inE = entries.filter(e => e.direction === 'in'), outE = entries.filter(e => e.direction === 'out');
  return {
    inUsd: round2(sum(inE, e => e.usdAmount)), inLbp: round2(sum(inE, e => e.lbpAmount)),
    outUsd: round2(sum(outE, e => e.usdAmount)), outLbp: round2(sum(outE, e => e.lbpAmount)),
    netUsd: round2(sum(inE, e => e.usdEquivalent) - sum(outE, e => e.usdEquivalent)),
  };
}

// ---------- Income statement (a simple P&L, all in USD) ----------
// Revenue and cost of goods come from sales fulfilled inside [fromDay, toDay] (either bound optional, inclusive
// 'YYYY-MM-DD'); operating expenses come from the expenses log dated inside the same range.
export function incomeStatement(salesOrders, expenses, fromDay = null, toDay = null) {
  const inRange = (d) => (!fromDay || d >= fromDay) && (!toDay || d <= toDay);
  const done = (salesOrders || []).filter(o => isInvoiced(o) && inRange((o.fulfilledAt || '').slice(0, 10)));
  const revenue = round2(sum(done, salesNet));
  const cogs = round2(sum(done, o => (Number(o.cost) || 0) - (Number(o.returnedCost) || 0)));
  const grossProfit = round2(revenue - cogs);
  const mine = (expenses || []).filter(e => inRange(e.date || (e.at || '').slice(0, 10)));
  const byCategory = {};
  for (const e of mine) { const c = e.category || 'Other'; byCategory[c] = round2((byCategory[c] || 0) + (Number(e.amount) || 0)); }
  const expenseTotal = round2(sum(mine, e => e.amount));
  return { revenue, cogs, grossProfit, expenseTotal, byCategory: Object.entries(byCategory).map(([category, value]) => ({ category, value })).sort((a, b) => b.value - a.value), netProfit: round2(grossProfit - expenseTotal) };
}

// Balance per party for the ledger overview: [{ id, name, balance }] (customerId null = walk-in).
export function customerBalances(orders, customers) {
  const ids = new Set(orders.filter(isInvoiced).map(o => o.customerId || null));
  return [...ids].map(id => ({ id, name: id ? (customers.find(c => c.id === id)?.name || orders.find(o => o.customerId === id)?.customerName || 'Customer') : 'Walk-in customers',
    balance: round2(sum(orders.filter(o => isInvoiced(o) && (o.customerId || null) === id), salesBalance)) })).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.name.localeCompare(b.name));
}
export function supplierBalances(pos, suppliers) {
  const ids = new Set(pos.filter(o => !['draft', 'cancelled'].includes(o.status)).map(o => o.supplierId));
  return [...ids].map(id => ({ id, name: suppliers.find(s => s.id === id)?.name || pos.find(o => o.supplierId === id)?.supplierName || 'Supplier',
    balance: round2(sum(pos.filter(o => o.supplierId === id), payableBalance)) })).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.name.localeCompare(b.name));
}
export const STOCK_MOVEMENT = { opening: 'Opening stock', receipt: 'Received', sale: 'Sold', sale_return: 'Customer return', purchase_return: 'Returned to supplier', waste: 'Written off', adjustment: 'Adjustment' };

// ---------- Supplier price report (pure functions, also used for the Excel export) ----------
// One price doc per (supplier, item): { supplierId, itemId, price, updatedAt, updatedBy, history:[{price, at, by}] }.
export const priceDocId = (supplierId, itemId) => `${supplierId}__${itemId}`;
export const PRICE_HISTORY_LIMIT = 30;

// Returns one row per item that has at least one supplier price, offers sorted cheapest first.
// Prices for deleted items/suppliers are ignored. Items nobody supplies are listed in `unpriced`.
export function buildPriceReport(items, suppliers, prices) {
  const supplierById = new Map(suppliers.map(s => [s.id, s]));
  const byItem = new Map();
  for (const p of prices) {
    const sup = supplierById.get(p.supplierId);
    if (!sup) continue;
    const offer = { supplierId: p.supplierId, supplierName: sup.name, price: Number(p.price), updatedAt: p.updatedAt || '', updatedBy: p.updatedBy || '', history: p.history || [] };
    if (!byItem.has(p.itemId)) byItem.set(p.itemId, []);
    byItem.get(p.itemId).push(offer);
  }
  const rows = [], unpriced = [];
  for (const item of [...items].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const offers = (byItem.get(item.id) || []).sort((a, b) => a.price - b.price || a.supplierName.localeCompare(b.supplierName));
    if (!offers.length) { unpriced.push(item); continue; }
    const best = offers[0].price;
    rows.push({ itemId: item.id, itemName: item.name, offers, cheapest: offers.filter(o => o.price === best), saving: offers.length > 1 ? offers[offers.length - 1].price - best : 0 });
  }
  return { rows, unpriced };
}

// Sheets (array-of-arrays) for the Excel export. `rows` may be pre-filtered to a single item.
export function priceReportSheets(rows) {
  const cheapest = [['Item', 'Cheapest supplier(s)', 'Cheapest price', 'Price updated', '# suppliers', 'Highest price', 'Max saving']];
  const all = [['Item', 'Supplier', 'Current price', 'Updated', 'Updated by', 'Cheapest?']];
  const history = [['Item', 'Supplier', 'Price', 'Date', 'By']];
  for (const r of rows) {
    cheapest.push([r.itemName, r.cheapest.map(o => o.supplierName).join(', '), r.offers[0].price, (r.cheapest[0].updatedAt || '').slice(0, 10),
      r.offers.length, r.offers[r.offers.length - 1].price, r.saving]);
    for (const o of r.offers) {
      all.push([r.itemName, o.supplierName, o.price, (o.updatedAt || '').slice(0, 10), o.updatedBy, r.cheapest.includes(o) ? 'Yes' : '']);
      for (const h of [...o.history].reverse()) history.push([r.itemName, o.supplierName, Number(h.price), (h.at || '').slice(0, 10), h.by || '']);
    }
  }
  return { 'Cheapest per item': cheapest, 'All supplier prices': all, 'Price history': history };
}

// ---------- Validation ----------
export const TENANT_RE = /^[a-z0-9_-]{2,30}$/;
export const USERNAME_RE = /^[a-z0-9._-]{2,30}$/;
export const MIN_PASSWORD = 6;

// ---------- Crypto ----------
const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITERATIONS = 250000;

export const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Uint8Array.from(atob(t), c => c.charCodeAt(0));
};
const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));

const aesKeyFromBytes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
export const keyFromSecret = (secret) => aesKeyFromBytes(unb64u(secret));

// scope = "tenant|username" (or "@platform|username"); returns the public lookup id + the secret AES key.
export async function deriveCreds(scope, password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('pas:v2:' + scope), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, 512));
  return { id: hex(bits.slice(0, 32)), key: await aesKeyFromBytes(bits.slice(32)) };
}

export async function seal(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { iv: b64u(iv), data: b64u(new Uint8Array(ct)) };
}

export async function unseal(key, rec) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(rec.iv) }, key, unb64u(rec.data));
  return dec.decode(pt);
}

// ---------- Firestore-backed operations ----------
export function createCore(db, fs) {
  const { doc, collection, getDoc, getDocs, writeBatch, runTransaction, query, where } = fs;
  const now = () => new Date().toISOString();

  const dataDoc = (dk, coll, id) => doc(db, 'data', dk, coll, id);
  const loginDoc = (tenant, id) => doc(db, 'tenants', tenant, 'logins', id);
  const platformLoginDoc = (id) => doc(db, 'platformLogins', id);
  const registryDoc = (adminKey, name) => doc(db, 'platform', adminKey, 'tenants', name);

  async function deleteAll(refs) {
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      refs.slice(i, i + 400).forEach(r => batch.delete(r));
      await batch.commit();
    }
  }

  // ----- Platform admin -----
  async function seedAdmin(username, password) {
    if (!USERNAME_RE.test(username)) throw new Error('Invalid admin username');
    if (password.length < MIN_PASSWORD) throw new Error('Password too short');
    const { id, key } = await deriveCreds('@platform|' + username, password);
    const ref = platformLoginDoc(id);
    if ((await getDoc(ref)).exists()) throw new Error('Admin already seeded with these credentials');
    const adminKey = randomToken(32);
    const batch = writeBatch(db);
    batch.set(ref, { ...(await seal(key, adminKey)), createdAt: now() });
    await batch.commit();
    return adminKey;
  }

  async function adminLogin(username, password) {
    const { id, key } = await deriveCreds('@platform|' + username, password);
    const snap = await getDoc(platformLoginDoc(id));
    if (!snap.exists()) return null;
    try { return await unseal(key, snap.data()); } catch { return null; }
  }

  async function changeAdminPassword(username, oldPassword, newPassword) {
    if (newPassword.length < MIN_PASSWORD) throw new Error('Password too short');
    const adminKey = await adminLogin(username, oldPassword);
    if (!adminKey) throw new Error('Current password is wrong');
    const oldC = await deriveCreds('@platform|' + username, oldPassword);
    const newC = await deriveCreds('@platform|' + username, newPassword);
    const batch = writeBatch(db);
    batch.set(platformLoginDoc(newC.id), { ...(await seal(newC.key, adminKey)), createdAt: now() });
    if (oldC.id !== newC.id) batch.delete(platformLoginDoc(oldC.id));
    await batch.commit();
  }

  // ----- Tenant management (platform admin) -----
  async function tenantDataKey(adminKey, name) {
    const snap = await getDoc(registryDoc(adminKey, name));
    if (!snap.exists()) throw new Error('Tenant not found');
    return unseal(await keyFromSecret(adminKey), snap.data().access);
  }

  async function listTenants(adminKey) {
    const key = await keyFromSecret(adminKey);
    const snap = await getDocs(collection(db, 'platform', adminKey, 'tenants'));
    const out = [];
    for (const d of snap.docs) {
      const t = { name: d.id, createdAt: d.data().createdAt, status: 'unknown', users: 0 };
      try {
        const dk = await unseal(key, d.data().access);
        const meta = await getDoc(dataDoc(dk, 'meta', 'tenant'));
        t.status = meta.exists() ? meta.data().status : 'unknown';
        t.users = (await getDocs(collection(db, 'data', dk, 'users'))).size;
      } catch { /* unreadable entry */ }
      out.push(t);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function createTenant(adminKey, name, ownerUsername, ownerPassword) {
    name = name.trim().toLowerCase(); ownerUsername = ownerUsername.trim().toLowerCase();
    if (!TENANT_RE.test(name)) throw new Error('Tenant ID: 2-30 characters, letters, numbers, - or _');
    if (!USERNAME_RE.test(ownerUsername)) throw new Error('Owner username: 2-30 characters, letters, numbers, . - or _');
    if (ownerPassword.length < MIN_PASSWORD) throw new Error(`Owner password must be at least ${MIN_PASSWORD} characters`);
    if ((await getDoc(registryDoc(adminKey, name))).exists()) throw new Error('Tenant already exists');

    const dk = randomToken(32);
    const owner = await deriveCreds(`${name}|${ownerUsername}`, ownerPassword);
    const batch = writeBatch(db);
    // The tenants/{name} doc is create-only in the rules, so this batch fails if the name was ever used.
    batch.set(doc(db, 'tenants', name), { createdAt: now() });
    batch.set(loginDoc(name, owner.id), { ...(await seal(owner.key, dk)), createdAt: now() });
    batch.set(registryDoc(adminKey, name), { createdAt: now(), access: await seal(await keyFromSecret(adminKey), dk) });
    batch.set(dataDoc(dk, 'meta', 'tenant'), { name, status: 'active', createdAt: now() });
    DEFAULT_ROLES.forEach(r => batch.set(dataDoc(dk, 'roles', r.id), r));
    batch.set(dataDoc(dk, 'users', ownerUsername), { username: ownerUsername, roleId: 'owner', disabled: false, loginId: owner.id, createdAt: now() });
    try { await batch.commit(); }
    catch (e) { throw new Error('Could not create tenant - the Tenant ID is probably already used (' + (e.code || e.message) + ')'); }
    return dk;
  }

  async function setTenantStatus(dk, status) {
    const batch = writeBatch(db);
    batch.update(dataDoc(dk, 'meta', 'tenant'), { status });
    await batch.commit();
  }

  // Purges all tenant data and logins. The tenants/{name} name doc stays (rules make it undeletable), so the name stays reserved.
  async function deleteTenant(adminKey, name) {
    const dk = await tenantDataKey(adminKey, name);
    const users = await getDocs(collection(db, 'data', dk, 'users'));
    await deleteAll(users.docs.map(d => loginDoc(name, d.data().loginId)));
    for (const c of DATA_COLLS) {
      const snap = await getDocs(collection(db, 'data', dk, c));
      await deleteAll(snap.docs.map(d => d.ref));
    }
    await deleteAll([registryDoc(adminKey, name)]);
  }

  // ----- Tenant login (users and platform admin) -----
  async function loadPermissions(dk, roleId) {
    const r = await getDoc(dataDoc(dk, 'roles', roleId));
    // The system Owner role always has every permission, including resources added after the tenant was created.
    return r.exists() ? { roleName: r.data().name, permissions: r.data().system ? fullPermissions() : normalizePermissions(r.data().permissions) } : { roleName: '(missing role)', permissions: normalizePermissions({}) };
  }

  async function tenantLogin(tenant, username, password) {
    const fail = { error: 'Invalid tenant, username or password' };
    const { id, key } = await deriveCreds(`${tenant}|${username}`, password);
    const snap = await getDoc(loginDoc(tenant, id));
    if (!snap.exists()) return fail;
    let dk;
    try { dk = await unseal(key, snap.data()); } catch { return fail; }
    const u = await getDoc(dataDoc(dk, 'users', username));
    if (!u.exists() || u.data().loginId !== id) return fail;
    if (u.data().disabled) return { error: 'This user is disabled' };
    const meta = await getDoc(dataDoc(dk, 'meta', 'tenant'));
    if (meta.exists() && meta.data().status === 'suspended') return { error: 'This tenant is suspended' };
    const { roleName, permissions } = await loadPermissions(dk, u.data().roleId);
    return { session: { tenantId: tenant, username, dataKey: dk, roleId: u.data().roleId, roleName, permissions, isPlatformAdmin: false } };
  }

  // Re-validates a stored session (used when the page is reloaded): user still exists/enabled, tenant active, fresh permissions.
  async function refreshSession(s) {
    if (s.isPlatformAdmin) return s;
    const u = await getDoc(dataDoc(s.dataKey, 'users', s.username));
    if (!u.exists() || u.data().disabled) return null;
    const meta = await getDoc(dataDoc(s.dataKey, 'meta', 'tenant'));
    if (meta.exists() && meta.data().status === 'suspended') return null;
    const { roleName, permissions } = await loadPermissions(s.dataKey, u.data().roleId);
    return { ...s, roleId: u.data().roleId, roleName, permissions };
  }

  async function adminEnterTenant(adminKey, name) {
    const dk = await tenantDataKey(adminKey, name);
    return { tenantId: name, username: 'platform-admin', dataKey: dk, roleId: null, roleName: 'Platform admin', permissions: fullPermissions(), isPlatformAdmin: true };
  }

  // ----- User management (inside a tenant) -----
  async function addUser(s, { username, password, roleId }) {
    username = username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw new Error('Username: 2-30 characters, letters, numbers, . - or _');
    if (password.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
    if ((await getDoc(dataDoc(s.dataKey, 'users', username))).exists()) throw new Error('That username already exists in this tenant');
    if (roleId === 'owner') throw new Error('Use "Transfer ownership" to make someone the owner');
    if (!(await getDoc(dataDoc(s.dataKey, 'roles', roleId))).exists()) throw new Error('Choose a valid role');
    const c = await deriveCreds(`${s.tenantId}|${username}`, password);
    const batch = writeBatch(db);
    batch.set(loginDoc(s.tenantId, c.id), { ...(await seal(c.key, s.dataKey)), createdAt: now() });
    batch.set(dataDoc(s.dataKey, 'users', username), { username, roleId, disabled: false, loginId: c.id, createdAt: now() });
    await batch.commit();
  }

  async function resetPassword(s, username, newPassword) {
    if (newPassword.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
    const uref = dataDoc(s.dataKey, 'users', username);
    const u = await getDoc(uref);
    if (!u.exists()) throw new Error('User not found');
    const c = await deriveCreds(`${s.tenantId}|${username}`, newPassword);
    const batch = writeBatch(db);
    batch.set(loginDoc(s.tenantId, c.id), { ...(await seal(c.key, s.dataKey)), createdAt: now() });
    if (u.data().loginId !== c.id) batch.delete(loginDoc(s.tenantId, u.data().loginId));
    batch.update(uref, { loginId: c.id });
    await batch.commit();
  }

  async function changeOwnPassword(s, oldPassword, newPassword) {
    const u = await getDoc(dataDoc(s.dataKey, 'users', s.username));
    const old = await deriveCreds(`${s.tenantId}|${s.username}`, oldPassword);
    if (!u.exists() || u.data().loginId !== old.id) throw new Error('Current password is wrong');
    await resetPassword(s, s.username, newPassword);
  }

  async function deleteUser(s, username) {
    if (username === s.username) throw new Error('You cannot delete your own user');
    const uref = dataDoc(s.dataKey, 'users', username);
    const u = await getDoc(uref);
    if (!u.exists()) return;
    if (u.data().roleId === 'owner') throw new Error('The owner account cannot be deleted. Transfer ownership to someone else first.');
    const batch = writeBatch(db);
    batch.delete(loginDoc(s.tenantId, u.data().loginId));
    batch.delete(uref);
    await batch.commit();
  }

  async function updateUser(s, username, patch) {
    if (username === s.username && patch.disabled) throw new Error('You cannot disable your own user');
    if (patch.roleId === 'owner') throw new Error('Use "Transfer ownership" to make someone the owner');
    const uref = dataDoc(s.dataKey, 'users', username);
    const u = await getDoc(uref);
    if (u.exists() && u.data().roleId === 'owner' && patch.roleId && patch.roleId !== 'owner') throw new Error('Use "Transfer ownership" to change who owns this tenant');
    if (u.exists() && u.data().roleId === 'owner' && patch.disabled) throw new Error('The owner account cannot be disabled. Transfer ownership first.');
    const batch = writeBatch(db);
    batch.update(uref, patch);
    await batch.commit();
  }

  // Moves the 'owner' role from the current session's user to `toUsername`. The previous owner becomes `selfRoleId`
  // (any existing non-system role). Only the current owner can call this, and the target must be an enabled user.
  async function transferOwnership(s, { toUsername, selfRoleId }) {
    toUsername = String(toUsername || '').trim().toLowerCase();
    if (!toUsername) throw new Error('Choose who to make the owner');
    if (toUsername === s.username) throw new Error(`${s.username} is already the owner`);
    return runTransaction(db, async (tx) => {
      const selfRef = dataDoc(s.dataKey, 'users', s.username), toRef = dataDoc(s.dataKey, 'users', toUsername);
      const [selfSnap, toSnap, roleSnap] = await Promise.all([tx.get(selfRef), tx.get(toRef), tx.get(dataDoc(s.dataKey, 'roles', selfRoleId))]);
      if (!selfSnap.exists() || selfSnap.data().roleId !== 'owner') throw new Error('Only the current owner can transfer ownership');
      if (!toSnap.exists()) throw new Error('User not found');
      if (toSnap.data().disabled) throw new Error('Enable that user before making them the owner');
      if (!roleSnap.exists() || roleSnap.data().system) throw new Error('Choose a valid role to take on yourself');
      tx.update(toRef, { roleId: 'owner' });
      tx.update(selfRef, { roleId: selfRoleId });
    });
  }

  // ----- Supplier prices (inside a tenant) -----
  // Sets the price a supplier gives for an item; the previous price is kept in `history` (newest last).
  async function setPrice(s, { supplierId, itemId, price }) {
    price = Math.round(Number(price) * 100) / 100;
    if (!Number.isFinite(price) || price < 0) throw new Error('Enter a valid price (0 or more)');
    if (!supplierId || !itemId) throw new Error('Supplier and item are required');
    const ref = dataDoc(s.dataKey, 'supplierPrices', priceDocId(supplierId, itemId));
    const existing = await getDoc(ref);
    const history = existing.exists() ? [...(existing.data().history || [])] : [];
    if (!existing.exists() || Number(existing.data().price) !== price) history.push({ price, at: now(), by: s.username });
    const batch = writeBatch(db);
    batch.set(ref, { supplierId, itemId, price, updatedAt: now(), updatedBy: s.username, history: history.slice(-PRICE_HISTORY_LIMIT) });
    await batch.commit();
  }

  async function removePrices(s, refsOrIds) {
    for (let i = 0; i < refsOrIds.length; i += 400) {
      const batch = writeBatch(db);
      refsOrIds.slice(i, i + 400).forEach(id => batch.delete(dataDoc(s.dataKey, 'supplierPrices', id)));
      await batch.commit();
    }
  }

  // Bulk-creates plain docs (used by CSV/Excel import). Chunks writes into batches of 400 (Firestore's limit).
  async function importDocs(s, coll, docs) {
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of docs.slice(i, i + 400)) batch.set(doc(collection(db, 'data', s.dataKey, coll)), d);
      await batch.commit();
    }
  }

  async function removeDocs(s, coll, ids) {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach(id => batch.delete(dataDoc(s.dataKey, coll, id)));
      await batch.commit();
    }
  }

  // ----- Batches, waste, orders (inside a tenant). Stock-changing steps run in Firestore transactions so concurrent
  // users cannot oversell or double-receive. Rule: in a transaction all reads happen before any write. -----
  const newRef = (s, coll) => doc(collection(db, 'data', s.dataKey, coll));
  // Stock ledger: one entry per stock movement, written in the same transaction as the movement itself.
  // qty is signed (+ in, - out); balance is the item's on-hand quantity after the movement.
  const ledgerEntry = (tx, s, e) => tx.set(newRef(s, 'stockLedger'), { itemId: e.itemId, itemName: e.itemName, type: e.type, qty: e.qty, balance: e.balance,
    batchId: e.batchId || null, lotNo: e.lotNo || '', ref: e.ref || '', refId: e.refId || '', note: e.note || '', by: s.username, at: now() });
  const itemBatches = async (s, itemId) => (await getDocs(query(collection(db, 'data', s.dataKey, 'batches'), where('itemId', '==', itemId)))).docs.map(d => ({ id: d.id, ...d.data() }));
  const positive = (n, label) => { n = Number(n); if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be greater than 0`); return n; };
  const money0 = (n, label) => { n = Number(n); if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be 0 or more`); return round2(n); };
  const checkExpiry = (item, expiryDate) => {
    if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) throw new Error('Expiry date is invalid');
    if (item.perishable && !expiryDate) throw new Error(`${item.name} is perishable: an expiry date is required`);
  };
  // References are PREFIX-YY-#### (YY = current year, two digits) and restart from 0001 each year, per document
  // type (so, si, sr, po, pi, pr each count separately). The counter field is named e.g. "so_26" so a new year's
  // first number just starts a fresh field instead of needing any reset step.
  async function nextNumber(tx, s, key, prefix) {
    const yy = String(new Date().getFullYear()).slice(-2);
    const field = `${key}_${yy}`;
    const ref = dataDoc(s.dataKey, 'meta', 'counters');
    const snap = await tx.get(ref);
    const n = ((snap.exists() && snap.data()[field]) || 0) + 1;
    return { ref, field, n, label: `${prefix}-${yy}-${String(n).padStart(4, '0')}` };
  }

  // Sets a supplier's price for an item and appends to its history, inside a transaction (price docs are read by the caller).
  function priceWrite(tx, s, snap, { supplierId, itemId, price }) {
    const history = snap.exists() ? [...(snap.data().history || [])] : [];
    if (!snap.exists() || Number(snap.data().price) !== price) history.push({ price, at: now(), by: s.username });
    tx.set(snap.ref, { supplierId, itemId, price, updatedAt: now(), updatedBy: s.username, history: history.slice(-PRICE_HISTORY_LIMIT) });
  }

  async function receiveBatch(s, { itemId, supplierId = null, supplierName = '', qty, unitCost, expiryDate = null, lotNo = '', note = '' }) {
    qty = positive(qty, 'Quantity'); unitCost = money0(unitCost ?? 0, 'Unit cost');
    return runTransaction(db, async (tx) => {
      const itemSnap = await tx.get(dataDoc(s.dataKey, 'inventory', itemId));
      if (!itemSnap.exists()) throw new Error('Item not found');
      const item = itemSnap.data();
      checkExpiry(item, expiryDate || null);
      const ref = newRef(s, 'batches');
      tx.set(ref, { itemId, itemName: item.name, supplierId, supplierName, poId: null, lotNo: lotNo.trim(), qtyReceived: qty, qtyRemaining: qty, unitCost,
        receivedAt: now(), expiryDate: expiryDate || null, note, createdBy: s.username });
      tx.update(itemSnap.ref, { qty: (Number(item.qty) || 0) + qty });
      ledgerEntry(tx, s, { itemId, itemName: item.name, type: 'receipt', qty, balance: (Number(item.qty) || 0) + qty, batchId: ref.id, lotNo: lotNo.trim(), ref: 'Manual receipt' });
      return ref.id;
    });
  }

  // Writes off (part of) a batch, or unbatched stock when batchId is null, into the waste log.
  async function writeOff(s, { itemId, batchId = null, qty, reason = 'expired', note = '' }) {
    qty = positive(qty, 'Quantity');
    if (!WASTE_REASONS[reason]) throw new Error('Choose a waste reason');
    const known = batchId ? [] : await itemBatches(s, itemId);
    return runTransaction(db, async (tx) => {
      const itemSnap = await tx.get(dataDoc(s.dataKey, 'inventory', itemId));
      const batchSnap = batchId ? await tx.get(dataDoc(s.dataKey, 'batches', batchId)) : null;
      const batchSnaps = batchId ? [] : await Promise.all(known.map(b => tx.get(dataDoc(s.dataKey, 'batches', b.id))));
      if (!itemSnap.exists()) throw new Error('Item not found');
      const item = itemSnap.data();
      let unitCost = 0, lotNo = '';
      if (batchId) {
        if (!batchSnap.exists()) throw new Error('Batch not found');
        const b = batchSnap.data();
        if (qty > Number(b.qtyRemaining)) throw new Error(`Only ${b.qtyRemaining} left in this batch`);
        unitCost = Number(b.unitCost) || 0; lotNo = b.lotNo || '';
        tx.update(batchSnap.ref, { qtyRemaining: Number(b.qtyRemaining) - qty });
      } else {
        const unbatched = stockPosition(item, batchSnaps.filter(x => x.exists()).map(x => ({ id: x.id, ...x.data() }))).unbatched;
        if (qty > unbatched) throw new Error(`Only ${unbatched} unbatched units of ${item.name} can be written off here`);
        unitCost = Number(item.price) || 0;
      }
      if (qty > (Number(item.qty) || 0)) throw new Error('Not enough stock on hand');
      tx.update(itemSnap.ref, { qty: (Number(item.qty) || 0) - qty });
      const ref = newRef(s, 'wasteLog');
      tx.set(ref, { itemId, itemName: item.name, batchId, lotNo, qty, unitCost, value: round2(qty * unitCost), reason, note, at: now(), by: s.username });
      ledgerEntry(tx, s, { itemId, itemName: item.name, type: 'waste', qty: -qty, balance: (Number(item.qty) || 0) - qty, batchId, lotNo, ref: WASTE_REASONS[reason], refId: ref.id, note });
      return ref.id;
    });
  }

  const cleanLines = (lines, { needPrice = true } = {}) => {
    if (!lines?.length) throw new Error('Add at least one item');
    const seen = new Set();
    return lines.map(l => {
      if (seen.has(l.itemId)) throw new Error(`${l.itemName} is listed twice`); seen.add(l.itemId);
      return { itemId: l.itemId, itemName: l.itemName, qty: positive(l.qty, `Quantity for ${l.itemName}`), unitPrice: money0(l.unitPrice ?? 0, `Price for ${l.itemName}`) };
    });
  };

  // ----- Purchase orders: draft -> ordered -> partial -> received (or cancelled) -----
  async function createPurchaseOrder(s, { supplierId, supplierName, lines, note = '', status = 'ordered' }) {
    if (!supplierId) throw new Error('Choose a supplier');
    if (!['draft', 'ordered'].includes(status)) throw new Error('Invalid status');
    const clean = cleanLines(lines).map(l => ({ ...l, received: 0 }));
    return runTransaction(db, async (tx) => {
      const c = await nextNumber(tx, s, 'po', 'PO');
      const ref = newRef(s, 'purchaseOrders');
      tx.set(ref, { number: c.label, supplierId, supplierName, status, lines: clean, total: orderTotal(clean), note, payments: [], receipts: [], returns: [], returnedValue: 0, createdAt: now(), createdBy: s.username });
      tx.set(c.ref, { [c.field]: c.n }, { merge: true });
      return { id: ref.id, number: c.label };
    });
  }

  // receipts: [{ index (line), qty, expiryDate, lotNo }]. Creates batches, adds stock, optionally updates the supplier's price list.
  async function receivePurchaseOrder(s, poId, { receipts, updatePrices = true }) {
    const items = receipts.filter(r => Number(r.qty) > 0);
    if (!items.length) throw new Error('Enter a received quantity for at least one line');
    return runTransaction(db, async (tx) => {
      const poSnap = await tx.get(dataDoc(s.dataKey, 'purchaseOrders', poId));
      if (!poSnap.exists()) throw new Error('Order not found');
      const po = poSnap.data();
      if (!['ordered', 'partial'].includes(po.status)) throw new Error(`A ${po.status} order cannot be received`);
      const itemSnaps = new Map(), priceSnaps = new Map();
      for (const r of items) {
        const line = po.lines[r.index];
        if (!line) throw new Error('Unknown order line');
        itemSnaps.set(line.itemId, await tx.get(dataDoc(s.dataKey, 'inventory', line.itemId)));
        if (updatePrices) priceSnaps.set(line.itemId, await tx.get(dataDoc(s.dataKey, 'supplierPrices', priceDocId(po.supplierId, line.itemId))));
      }
      const inv = await nextNumber(tx, s, 'pi', 'PI'); // a purchase invoice reference for this goods receipt (a PO can be received - and invoiced - in several batches)
      const lines = po.lines.map(l => ({ ...l }));
      const addQty = new Map(), running = new Map();
      let value = 0;
      for (const r of items) {
        const line = lines[r.index], qty = positive(r.qty, `Received quantity for ${line.itemName}`);
        if (qty > line.qty - line.received) throw new Error(`${line.itemName}: only ${line.qty - line.received} still outstanding`);
        const itemSnap = itemSnaps.get(line.itemId);
        if (!itemSnap.exists()) throw new Error(`${line.itemName} no longer exists`);
        checkExpiry(itemSnap.data(), r.expiryDate || null);
        const bref = newRef(s, 'batches');
        tx.set(bref, { itemId: line.itemId, itemName: line.itemName, supplierId: po.supplierId, supplierName: po.supplierName, poId, poNumber: po.number,
          lotNo: (r.lotNo || '').trim(), qtyReceived: qty, qtyRemaining: qty, unitCost: line.unitPrice, receivedAt: now(), expiryDate: r.expiryDate || null, note: '', createdBy: s.username });
        line.received += qty;
        value += qty * line.unitPrice;
        addQty.set(line.itemId, (addQty.get(line.itemId) || 0) + qty);
        const bal = (running.get(line.itemId) ?? (Number(itemSnap.data().qty) || 0)) + qty;
        running.set(line.itemId, bal);
        ledgerEntry(tx, s, { itemId: line.itemId, itemName: line.itemName, type: 'receipt', qty, balance: bal, batchId: bref.id, lotNo: (r.lotNo || '').trim(), ref: po.number, refId: poId });
      }
      for (const [itemId, q] of addQty) tx.update(itemSnaps.get(itemId).ref, { qty: (Number(itemSnaps.get(itemId).data().qty) || 0) + q });
      if (updatePrices) for (const itemId of addQty.keys()) priceWrite(tx, s, priceSnaps.get(itemId), { supplierId: po.supplierId, itemId, price: lines.find(l => l.itemId === itemId).unitPrice });
      const complete = lines.every(l => l.received >= l.qty);
      tx.set(inv.ref, { [inv.field]: inv.n }, { merge: true });
      tx.update(poSnap.ref, { lines, status: complete ? 'received' : 'partial', receipts: [...(po.receipts || []), { at: now(), by: s.username, value: round2(value), number: inv.label }],
        ...(complete ? { receivedAt: now(), receivedBy: s.username } : {}) });
      return { invoiceNumber: inv.label };
    });
  }

  // ----- Sales orders: draft -> confirmed -> fulfilled (or cancelled); `paid` is tracked separately -----
  async function createSalesOrder(s, { customerId = null, customerName = '', branchId = null, branchName = '', lines, note = '', status = 'confirmed' }) {
    if (!['draft', 'confirmed'].includes(status)) throw new Error('Invalid status');
    const clean = cleanLines(lines);
    return runTransaction(db, async (tx) => {
      const c = await nextNumber(tx, s, 'so', 'SO');
      const ref = newRef(s, 'salesOrders');
      tx.set(ref, { number: c.label, customerId, customerName: customerName || 'Walk-in customer', branchId: branchId || null, branchName: branchId ? branchName : '',
        status, paid: false, payments: [], returns: [], returnedValue: 0, returnedCost: 0, lines: clean, total: orderTotal(clean), cost: 0, note, createdAt: now(), createdBy: s.username });
      tx.set(c.ref, { [c.field]: c.n }, { merge: true });
      return { id: ref.id, number: c.label };
    });
  }

  // Deducts stock FEFO (never from expired batches), records which lots were used and the cost of goods sold.
  // overrides (optional, manual batch choice): { [lineIndex]: [{ batchId | null, qty }] }; lines without an override use FEFO.
  async function fulfilSalesOrder(s, orderId, { overrides = null } = {}) {
    const pre = await getDoc(dataDoc(s.dataKey, 'salesOrders', orderId));
    if (!pre.exists()) throw new Error('Order not found');
    const candidates = new Map();
    for (const itemId of new Set(pre.data().lines.map(l => l.itemId))) candidates.set(itemId, await itemBatches(s, itemId));
    const today = localDay();
    return runTransaction(db, async (tx) => {
      const oSnap = await tx.get(pre.ref);
      const order = oSnap.data();
      if (!['draft', 'confirmed'].includes(order.status)) throw new Error(`A ${order.status} order cannot be fulfilled`);
      const itemSnaps = new Map(), batchState = new Map();
      for (const itemId of candidates.keys()) {
        itemSnaps.set(itemId, await tx.get(dataDoc(s.dataKey, 'inventory', itemId)));
        for (const b of candidates.get(itemId)) { const bs = await tx.get(dataDoc(s.dataKey, 'batches', b.id)); if (bs.exists()) batchState.set(b.id, { ref: bs.ref, data: { id: b.id, ...bs.data() } }); }
      }
      const inv = await nextNumber(tx, s, 'si', 'SI'); // a sale is invoiced the moment it is fulfilled
      const itemQty = new Map([...itemSnaps].map(([id, sn]) => [id, Number(sn.data()?.qty) || 0]));
      const lines = [], moves = [];
      let cost = 0;
      for (const [idx, l] of order.lines.entries()) {
        const itemSnap = itemSnaps.get(l.itemId);
        if (!itemSnap.exists()) throw new Error(`${l.itemName} no longer exists`);
        const item = { ...itemSnap.data(), qty: itemQty.get(l.itemId) };
        const mine = candidates.get(l.itemId).map(b => batchState.get(b.id)?.data).filter(Boolean);
        const alloc = overrides?.[idx] ? manualAllocate(item, mine, l.qty, overrides[idx], today) : allocateFEFO(item, mine, l.qty, today);
        if (alloc.shortfall > 0) {
          const pos = stockPosition(item, mine, today);
          throw new Error(`Not enough stock for ${l.itemName}: need ${l.qty}, ${pos.sellable} available${pos.expired ? ` (${pos.expired} expired - write it off)` : ''}`);
        }
        let bal = itemQty.get(l.itemId);
        for (const a of alloc.allocations) {
          const st = batchState.get(a.batchId); st.data.qtyRemaining = Number(st.data.qtyRemaining) - a.qty;
          bal -= a.qty; moves.push({ itemId: l.itemId, itemName: l.itemName, type: 'sale', qty: -a.qty, balance: bal, batchId: a.batchId, lotNo: a.lotNo, ref: order.number, refId: orderId });
        }
        if (alloc.unbatched) { bal -= alloc.unbatched; moves.push({ itemId: l.itemId, itemName: l.itemName, type: 'sale', qty: -alloc.unbatched, balance: bal, ref: order.number, refId: orderId, note: 'Unbatched stock' }); }
        itemQty.set(l.itemId, itemQty.get(l.itemId) - l.qty);
        const lineCost = round2(sum(alloc.allocations, a => a.qty * a.unitCost));
        cost += lineCost;
        lines.push({ ...l, cost: lineCost, allocations: alloc.allocations, unbatched: alloc.unbatched });
      }
      for (const st of batchState.values()) tx.update(st.ref, { qtyRemaining: st.data.qtyRemaining });
      for (const [itemId, q] of itemQty) tx.update(itemSnaps.get(itemId).ref, { qty: q });
      moves.forEach(m => ledgerEntry(tx, s, m));
      tx.set(inv.ref, { [inv.field]: inv.n }, { merge: true });
      tx.update(oSnap.ref, { status: 'fulfilled', lines, cost: round2(cost), fulfilledAt: now(), fulfilledBy: s.username, invoiceNumber: inv.label });
      return { invoiceNumber: inv.label };
    });
  }

  // Return items from a fulfilled sale, in full or in part. items = [{ index (line), qty }]; omit `items` to return everything left.
  // Stock goes back into the batches it came from (latest lot first, then unbatched stock; if a batch was deleted it becomes unbatched stock).
  // The order keeps status 'fulfilled' until every unit has been returned, then becomes 'returned'.
  async function returnSalesOrder(s, orderId, { items = null, note = '' } = {}) {
    return runTransaction(db, async (tx) => {
      const oSnap = await tx.get(dataDoc(s.dataKey, 'salesOrders', orderId));
      if (!oSnap.exists()) throw new Error('Order not found');
      const order = oSnap.data();
      if (order.status !== 'fulfilled') throw new Error(`Only fulfilled orders can be returned (this one is ${order.status})`);
      const want = new Map();
      if (items) for (const it of items) { const q = Number(it.qty); if (q > 0) want.set(Number(it.index), (want.get(Number(it.index)) || 0) + q); }
      else order.lines.forEach((l, i) => { const left = Number(l.qty) - (Number(l.returnedQty) || 0); if (left > 0) want.set(i, left); });
      if (!want.size) throw new Error('Choose at least one item to return');
      const itemSnaps = new Map(), batchSnaps = new Map();
      for (const [i] of want) {
        const l = order.lines[i];
        if (!l) throw new Error('Unknown order line');
        if (!itemSnaps.has(l.itemId)) itemSnaps.set(l.itemId, await tx.get(dataDoc(s.dataKey, 'inventory', l.itemId)));
        for (const a of l.allocations || []) if (a.batchId && !batchSnaps.has(a.batchId)) batchSnaps.set(a.batchId, await tx.get(dataDoc(s.dataKey, 'batches', a.batchId)));
      }
      const ret = await nextNumber(tx, s, 'sr', 'SR');
      const lines = order.lines.map(l => ({ ...l, allocations: (l.allocations || []).map(a => ({ ...a })) }));
      const batchAdd = new Map(), running = new Map(), moves = [];
      let value = 0, cost = 0;
      const retLines = [];
      for (const [i, q] of want) {
        const l = lines[i], left = Number(l.qty) - (Number(l.returnedQty) || 0);
        if (q > left) throw new Error(`${l.itemName}: only ${left} can still be returned`);
        let need = q, lineCost = 0;
        const itemSnap = itemSnaps.get(l.itemId);
        let bal = running.get(l.itemId) ?? (Number(itemSnap.data()?.qty) || 0);
        for (let k = l.allocations.length - 1; k >= 0 && need > 0; k--) {
          const a = l.allocations[k], take = Math.min(need, a.qty - (a.returned || 0));
          if (take <= 0) continue;
          a.returned = (a.returned || 0) + take; need -= take; lineCost += take * a.unitCost; bal += take;
          const exists = a.batchId && batchSnaps.get(a.batchId)?.exists();
          if (exists) batchAdd.set(a.batchId, (batchAdd.get(a.batchId) || 0) + take);
          moves.push({ itemId: l.itemId, itemName: l.itemName, type: 'sale_return', qty: take, balance: bal, batchId: exists ? a.batchId : null, lotNo: a.lotNo, ref: order.number, refId: orderId, note });
        }
        if (need > 0) { // unbatched part of the sale (or a legacy line without allocations)
          bal += need; moves.push({ itemId: l.itemId, itemName: l.itemName, type: 'sale_return', qty: need, balance: bal, ref: order.number, refId: orderId, note: note || 'Unbatched stock' });
          l.unbatchedReturned = (l.unbatchedReturned || 0) + need;
        }
        running.set(l.itemId, bal);
        l.returnedQty = (Number(l.returnedQty) || 0) + q;
        const lineValue = round2(q * Number(l.unitPrice));
        value += lineValue; cost += lineCost;
        retLines.push({ index: i, itemName: l.itemName, qty: q, value: lineValue });
      }
      for (const [id, n] of batchAdd) tx.update(batchSnaps.get(id).ref, { qtyRemaining: Number(batchSnaps.get(id).data().qtyRemaining) + n });
      for (const [id, bal] of running) if (itemSnaps.get(id).exists()) tx.update(itemSnaps.get(id).ref, { qty: bal });
      moves.forEach(m => ledgerEntry(tx, s, m));
      tx.set(ret.ref, { [ret.field]: ret.n }, { merge: true });
      const allBack = lines.every(l => (Number(l.returnedQty) || 0) >= Number(l.qty));
      tx.update(oSnap.ref, { lines, status: allBack ? 'returned' : 'fulfilled', returnedValue: round2((Number(order.returnedValue) || 0) + value), returnedCost: round2((Number(order.returnedCost) || 0) + cost),
        returns: [...(order.returns || []), { id: 'r' + ((order.returns || []).length + 1), number: ret.label, at: now(), by: s.username, note, lines: retLines, total: round2(value) }],
        ...(allBack ? { returnedAt: now(), returnedBy: s.username } : {}) });
      return { value: round2(value), fullyReturned: allBack, number: ret.label };
    });
  }

  // Return received goods to the supplier. picks = [{ batchId, qty }] taken from the batches this purchase order created.
  // Stock and batches go down; the order records a return whose value reduces what we owe the supplier.
  async function returnPurchaseGoods(s, poId, { picks, note = '' }) {
    const chosen = (picks || []).filter(p => Number(p.qty) > 0);
    if (!chosen.length) throw new Error('Choose at least one batch to return');
    return runTransaction(db, async (tx) => {
      const poSnap = await tx.get(dataDoc(s.dataKey, 'purchaseOrders', poId));
      if (!poSnap.exists()) throw new Error('Order not found');
      const po = poSnap.data();
      if (!['partial', 'received', 'closed'].includes(po.status)) throw new Error('Nothing has been received on this order yet');
      const bSnaps = new Map(), itemSnaps = new Map();
      for (const p of chosen) {
        const bs = await tx.get(dataDoc(s.dataKey, 'batches', p.batchId));
        if (!bs.exists() || bs.data().poId !== poId) throw new Error('That batch does not belong to this order');
        bSnaps.set(p.batchId, bs);
        if (!itemSnaps.has(bs.data().itemId)) itemSnaps.set(bs.data().itemId, await tx.get(dataDoc(s.dataKey, 'inventory', bs.data().itemId)));
      }
      const ret = await nextNumber(tx, s, 'pr', 'PR');
      const running = new Map(), lines = [], moves = [];
      let value = 0;
      const seen = new Map();
      for (const p of chosen) {
        const qty = positive(p.qty, 'Return quantity'), b = bSnaps.get(p.batchId).data();
        seen.set(p.batchId, (seen.get(p.batchId) || 0) + qty);
        if (seen.get(p.batchId) > Number(b.qtyRemaining)) throw new Error(`Lot ${b.lotNo || '—'} only has ${b.qtyRemaining} left to return`);
        const itemSnap = itemSnaps.get(b.itemId);
        if (!itemSnap.exists()) throw new Error(`${b.itemName} no longer exists`);
        const bal = (running.get(b.itemId) ?? (Number(itemSnap.data().qty) || 0)) - qty;
        if (bal < 0) throw new Error('Not enough stock on hand');
        running.set(b.itemId, bal);
        value += qty * Number(b.unitCost);
        lines.push({ batchId: p.batchId, itemName: b.itemName, lotNo: b.lotNo || '', qty, value: round2(qty * Number(b.unitCost)) });
        moves.push({ itemId: b.itemId, itemName: b.itemName, type: 'purchase_return', qty: -qty, balance: bal, batchId: p.batchId, lotNo: b.lotNo || '', ref: po.number, refId: poId, note });
      }
      for (const [id, n] of seen) tx.update(bSnaps.get(id).ref, { qtyRemaining: Number(bSnaps.get(id).data().qtyRemaining) - n });
      for (const [id, bal] of running) tx.update(itemSnaps.get(id).ref, { qty: bal });
      moves.forEach(m => ledgerEntry(tx, s, m));
      tx.set(ret.ref, { [ret.field]: ret.n }, { merge: true });
      const total = round2(value);
      tx.update(poSnap.ref, { returns: [...(po.returns || []), { id: 'r' + ((po.returns || []).length + 1), number: ret.label, at: now(), by: s.username, note, lines, total }], returnedValue: round2((Number(po.returnedValue) || 0) + total) });
      return { value: total, number: ret.label };
    });
  }

  // Reads the tenant's settings doc (the USD/LBP exchange rate and the list of expense categories), falling back to the defaults if none was ever saved.
  async function getSettings(s) {
    const snap = await getDoc(dataDoc(s.dataKey, 'meta', 'settings'));
    return { exchangeRate: DEFAULT_EXCHANGE_RATE, expenseCategories: DEFAULT_EXPENSE_CATEGORIES, ...(snap.exists() ? snap.data() : {}) };
  }
  // Either field can be updated alone; omit the other to leave it as is.
  async function updateSettings(s, { exchangeRate, expenseCategories }) {
    const patch = { updatedAt: now(), updatedBy: s.username };
    if (exchangeRate !== undefined) patch.exchangeRate = positive(exchangeRate, 'Exchange rate');
    if (expenseCategories !== undefined) {
      const list = [...new Set(expenseCategories.map(c => String(c).trim()).filter(Boolean))];
      if (!list.length) throw new Error('Keep at least one expense category');
      patch.expenseCategories = list;
    }
    const batch = writeBatch(db);
    batch.set(dataDoc(s.dataKey, 'meta', 'settings'), patch, { merge: true });
    await batch.commit();
  }

  // Record a payment (money in from a customer / out to a supplier) or a refund (the opposite direction) against an
  // order. The amount can be split across both currencies at once (usdAmount + lbpAmount): the LBP portion is
  // converted to USD using the exchange rate in effect right now, and that rate is stamped onto the payment so its
  // value never shifts if the rate changes later. Every payment/refund also gets its own reference - a sales receipt
  // (REC) for money coming in, a payment voucher (PV) for money going out - independent of the order's own number.
  async function recordPayment(s, coll, id, { usdAmount = 0, lbpAmount = 0, kind = 'payment', method = 'cash', note = '' }) {
    if (!['salesOrders', 'purchaseOrders'].includes(coll)) throw new Error('Unknown order type');
    if (!['payment', 'refund'].includes(kind)) throw new Error('Unknown payment type');
    usdAmount = money0(usdAmount || 0, 'USD amount'); lbpAmount = money0(lbpAmount || 0, 'LBP amount');
    if (usdAmount <= 0 && lbpAmount <= 0) throw new Error('Enter an amount in USD and/or LBP');
    if (!PAYMENT_METHODS[method]) throw new Error('Choose a payment method');
    return runTransaction(db, async (tx) => {
      const [snap, setSnap] = await Promise.all([tx.get(dataDoc(s.dataKey, coll, id)), tx.get(dataDoc(s.dataKey, 'meta', 'settings'))]);
      if (!snap.exists()) throw new Error('Order not found');
      const o = snap.data();
      const exchangeRate = (setSnap.exists() && Number(setSnap.data().exchangeRate) > 0 && Number(setSnap.data().exchangeRate)) || DEFAULT_EXCHANGE_RATE;
      const amount = round2(usdAmount + lbpAmount / exchangeRate);
      if (coll === 'salesOrders' && !isInvoiced(o)) throw new Error('Only fulfilled orders can take payments');
      if (coll === 'purchaseOrders' && ['draft', 'cancelled'].includes(o.status)) throw new Error('Place the order before recording payments');
      const paid = paidTotalOf(o);
      const balance = coll === 'salesOrders' ? salesBalance(o) : payableBalance(o);
      if (kind === 'payment' && coll === 'salesOrders' && amount > balance + 0.004) throw new Error(`The customer only owes ${balance.toFixed(2)}`);
      if (kind === 'refund' && amount > paid + 0.004) throw new Error(`Only ${paid.toFixed(2)} has been paid, so that is the most that can be refunded`);
      // Money in = a customer payment or a supplier refund; money out = a customer refund or a supplier payment.
      const moneyIn = (coll === 'salesOrders') === (kind === 'payment');
      const ref = await nextNumber(tx, s, moneyIn ? 'rec' : 'pv', moneyIn ? 'REC' : 'PV');
      const payments = [...(o.payments || (o.paid ? [{ id: 'p0', kind: 'payment', usdAmount: Number(o.total) || 0, lbpAmount: 0, exchangeRate, amount: Number(o.total) || 0, method: 'cash', note: 'Recorded before payment tracking', at: o.paidAt || o.fulfilledAt || o.createdAt, by: '' }] : [])),
        { id: 'p' + ((o.payments || []).length + 1), kind, usdAmount, lbpAmount, exchangeRate, amount, method, note, number: ref.label, at: now(), by: s.username }];
      const paidAfter = round2(payments.reduce((t, p) => t + (p.kind === 'refund' ? -p.amount : p.amount), 0));
      const patch = { payments, paidTotal: paidAfter };
      if (coll === 'salesOrders') { patch.paid = round2(salesNet(o) - paidAfter) <= 0.004; patch.paidAt = patch.paid ? now() : null; }
      tx.set(ref.ref, { [ref.field]: ref.n }, { merge: true });
      tx.update(snap.ref, patch);
      return { paidTotal: paidAfter, number: ref.label };
    });
  }

  // Records a business expense (rent, salaries, utilities, ...) - money out with no order behind it. Same
  // dual-currency handling as recordPayment, and gets its own payment voucher reference (it shares the tenant-wide
  // PV sequence with supplier/customer-refund vouchers, so every "money out" voucher is numbered in one series).
  async function recordExpense(s, { category, usdAmount = 0, lbpAmount = 0, method = 'cash', note = '', date = null }) {
    category = String(category || '').trim();
    if (!category) throw new Error('Choose a category');
    usdAmount = money0(usdAmount || 0, 'USD amount'); lbpAmount = money0(lbpAmount || 0, 'LBP amount');
    if (usdAmount <= 0 && lbpAmount <= 0) throw new Error('Enter an amount in USD and/or LBP');
    if (!PAYMENT_METHODS[method]) throw new Error('Choose a payment method');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Expense date is invalid');
    return runTransaction(db, async (tx) => {
      const setSnap = await tx.get(dataDoc(s.dataKey, 'meta', 'settings'));
      const exchangeRate = (setSnap.exists() && Number(setSnap.data().exchangeRate) > 0 && Number(setSnap.data().exchangeRate)) || DEFAULT_EXCHANGE_RATE;
      const amount = round2(usdAmount + lbpAmount / exchangeRate);
      const ref = await nextNumber(tx, s, 'pv', 'PV');
      const eref = newRef(s, 'expenses');
      tx.set(eref, { category, usdAmount, lbpAmount, exchangeRate, amount, method, note, number: ref.label, date: date || localDay(), at: now(), by: s.username });
      tx.set(ref.ref, { [ref.field]: ref.n }, { merge: true });
      return { id: eref.id, number: ref.label };
    });
  }

  // Manual stock correction (count, breakage found, etc.): sets on-hand to `newQty` (or adds `delta`) and logs it. Cannot go below batched stock.
  async function adjustStock(s, itemId, { newQty, delta, note = 'Manual adjustment' }) {
    const batches = await itemBatches(s, itemId);
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(dataDoc(s.dataKey, 'inventory', itemId));
      if (!snap.exists()) throw new Error('Item not found');
      const item = snap.data(), cur = Number(item.qty) || 0;
      const target = newQty !== undefined ? Number(newQty) : cur + Number(delta);
      if (!Number.isFinite(target) || target < 0) throw new Error('Quantity cannot be negative');
      const batched = stockPosition(item, batches).batched;
      if (target < batched) throw new Error(`Quantity can't be below ${batched}, the stock held in batches. Use Write off to remove batched stock.`);
      if (target === cur) return { changed: 0 };
      tx.update(snap.ref, { qty: target });
      ledgerEntry(tx, s, { itemId, itemName: item.name, type: 'adjustment', qty: target - cur, balance: target, ref: 'Adjustment', note });
      return { changed: target - cur };
    });
  }

  // Creates an inventory item; any opening quantity is logged in the stock ledger.
  async function createItem(s, data) {
    const ref = newRef(s, 'inventory');
    const qty = Number(data.qty) || 0;
    const batch = writeBatch(db);
    batch.set(ref, { ...data, qty, createdBy: s.username, createdAt: now() });
    if (qty > 0) batch.set(newRef(s, 'stockLedger'), { itemId: ref.id, itemName: data.name, type: 'opening', qty, balance: qty, batchId: null, lotNo: '', ref: 'Opening stock', refId: '', note: '', by: s.username, at: now() });
    await batch.commit();
    return ref.id;
  }

  // Recent stock movements (newest first), optionally for one item. Loaded on demand, not live, to keep reads low.
  async function stockMovements(s, { itemId = null, limit = 300 } = {}) {
    const ref = collection(db, 'data', s.dataKey, 'stockLedger');
    const snap = await getDocs(itemId ? query(ref, where('itemId', '==', itemId)) : ref);
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
  }
  // Corrects a batch's lot number, expiry date or unit cost (e.g. a typo at receiving).
  async function updateBatch(s, batchId, { lotNo, expiryDate, unitCost }) {
    return runTransaction(db, async (tx) => {
      const bSnap = await tx.get(dataDoc(s.dataKey, 'batches', batchId));
      if (!bSnap.exists()) throw new Error('Batch not found');
      const itemSnap = await tx.get(dataDoc(s.dataKey, 'inventory', bSnap.data().itemId));
      const item = itemSnap.exists() ? itemSnap.data() : {};
      const patch = {};
      if (lotNo !== undefined) patch.lotNo = String(lotNo).trim();
      if (expiryDate !== undefined) { checkExpiry(item, expiryDate || null); patch.expiryDate = expiryDate || null; }
      if (unitCost !== undefined) patch.unitCost = money0(unitCost, 'Unit cost');
      tx.update(bSnap.ref, patch);
    });
  }

  // Edit a DRAFT order (lines, note and customer/supplier). Placed or fulfilled orders are immutable.
  async function updateDraftOrder(s, coll, id, { lines, note = '', customerId = null, customerName = '', branchId = null, branchName = '', supplierId, supplierName }) {
    if (!['salesOrders', 'purchaseOrders'].includes(coll)) throw new Error('Unknown order type');
    const clean = cleanLines(lines).map(l => coll === 'purchaseOrders' ? { ...l, received: 0 } : l);
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(dataDoc(s.dataKey, coll, id));
      if (!snap.exists()) throw new Error('Order not found');
      if (snap.data().status !== 'draft') throw new Error('Only draft orders can be edited');
      const patch = { lines: clean, total: orderTotal(clean), note, updatedAt: now(), updatedBy: s.username };
      if (coll === 'salesOrders') Object.assign(patch, { customerId, customerName: customerName || 'Walk-in customer', branchId: branchId || null, branchName: branchId ? branchName : '' });
      else if (supplierId) Object.assign(patch, { supplierId, supplierName });
      tx.update(snap.ref, patch);
    });
  }

  const TRANSITIONS = {
    salesOrders: { draft: ['confirmed', 'cancelled'], confirmed: ['cancelled'] },
    purchaseOrders: { draft: ['ordered', 'cancelled'], ordered: ['cancelled'], partial: ['closed'] },
  };
  async function advanceOrder(s, coll, id, next) {
    if (!TRANSITIONS[coll]) throw new Error('Unknown order type');
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(dataDoc(s.dataKey, coll, id));
      if (!snap.exists()) throw new Error('Order not found');
      if (!(TRANSITIONS[coll][snap.data().status] || []).includes(next)) throw new Error(`Cannot change a ${snap.data().status} order to ${next}`);
      tx.update(snap.ref, { status: next, [`${next}At`]: now(), [`${next}By`]: s.username });
    });
  }
  // Convenience: paid=true records a payment for the whole remaining balance; paid=false clears all payments (undo).
  async function setSalesPaid(s, id, paid) {
    const snap = await getDoc(dataDoc(s.dataKey, 'salesOrders', id));
    if (!snap.exists()) throw new Error('Order not found');
    const o = snap.data();
    if (!isInvoiced(o)) throw new Error('Only fulfilled orders can be marked paid');
    if (paid) { const bal = salesBalance(o); if (bal > 0.004) await recordPayment(s, 'salesOrders', id, { usdAmount: bal, method: 'cash' }); return; }
    const batch = writeBatch(db);
    batch.update(snap.ref, { payments: [], paidTotal: 0, paid: false, paidAt: null });
    await batch.commit();
  }
  // ----- Role management (inside a tenant) -----
  async function saveRole(s, { id, name, permissions }) {
    name = (name || '').trim();
    if (!name) throw new Error('Role name is required');
    if (id) {
      const existing = await getDoc(dataDoc(s.dataKey, 'roles', id));
      if (existing.exists() && existing.data().system) throw new Error('The Owner role cannot be changed');
    }
    const rid = id || 'r_' + randomToken(9);
    const batch = writeBatch(db);
    batch.set(dataDoc(s.dataKey, 'roles', rid), { id: rid, name, system: false, permissions: normalizePermissions(permissions) });
    await batch.commit();
    return rid;
  }

  async function deleteRole(s, id) {
    const r = await getDoc(dataDoc(s.dataKey, 'roles', id));
    if (!r.exists()) return;
    if (r.data().system) throw new Error('The Owner role cannot be deleted');
    const users = await getDocs(collection(db, 'data', s.dataKey, 'users'));
    const inUse = users.docs.filter(d => d.data().roleId === id).length;
    if (inUse) throw new Error(`${inUse} user(s) still have this role. Reassign them first.`);
    const batch = writeBatch(db);
    batch.delete(r.ref);
    await batch.commit();
  }

  return {
    seedAdmin, adminLogin, changeAdminPassword,
    listTenants, createTenant, setTenantStatus, deleteTenant, adminEnterTenant,
    tenantLogin, refreshSession, addUser, transferOwnership, resetPassword, changeOwnPassword, deleteUser, updateUser, saveRole, deleteRole,
    setPrice, removePrices, removeDocs, importDocs, getSettings, updateSettings,
    receiveBatch, writeOff, createPurchaseOrder, receivePurchaseOrder, createSalesOrder, fulfilSalesOrder, returnSalesOrder, returnPurchaseGoods, recordPayment, recordExpense, adjustStock, createItem, stockMovements, updateBatch, updateDraftOrder, advanceOrder, setSalesPaid,
  };
}
