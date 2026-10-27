// Seeds the real "pas" tenant with a Lebanon-context demo dataset (items, suppliers, customers with Lebanese
// branches, purchase/sales cycles, dual-currency payments, expenses). Uses the platform admin key to enter the
// tenant directly, so no tenant owner password is needed.
// Usage: node scripts/seed-lebanon.mjs <adminUsername> <adminPassword> [tenantId=pas]
import { core, fs, db } from './common.mjs';
import { addDays, localDay } from '../core.js';

const [user, pw, tenantId = 'pas'] = process.argv.slice(2);
if (!user || !pw) { console.error('Usage: node scripts/seed-lebanon.mjs <adminUsername> <adminPassword> [tenantId=pas]'); process.exit(1); }

const adminKey = await core.adminLogin(user, pw);
if (!adminKey) { console.error('Invalid admin credentials'); process.exit(1); }
const s = await core.adminEnterTenant(adminKey, tenantId);
console.log(`Seeding tenant "${tenantId}" (Lebanon demo data)...`);

const addDoc = (coll, data) => fs.addDoc(fs.collection(db, 'data', s.dataKey, coll), data);
const today = localDay();

// ---- Exchange rate ----
await core.updateSettings(s, { exchangeRate: 89500, expenseCategories: ['Rent', 'Salaries', 'Electricity & generator', 'Transport & fuel', 'Municipality fees', 'Maintenance', 'Marketing', 'Bank fees', 'Other'] });
console.log('  exchange rate set: 1 USD = 89,500 LBP');

// ---- Inventory ----
const items = {};
const mkItem = async (name, qty, price, lowStock, extra = {}) => { items[name] = await core.createItem(s, { name, qty, price, lowStock, ...extra }); };
await mkItem('Zaatar Manakish Mix 500g', 40, 3.5, 10);
await mkItem('Lebanese Rice 5kg', 60, 8, 15);
await mkItem('Extra Virgin Olive Oil 1L', 30, 12, 8);
await mkItem('Halloumi Cheese 250g', 25, 6, 10, { perishable: true, expiryAlertDays: 5 });
await mkItem('Pine Nuts (Snobar) 200g', 15, 15, 5);
await mkItem('Lebanese Coffee 200g', 50, 4, 12);
await mkItem('Chickpeas 1kg', 45, 2.5, 10);
await mkItem('Bulgur Wheat 1kg', 35, 2, 10);
console.log(`  inventory: ${Object.keys(items).length} items`);

// ---- Suppliers + prices ----
const bekaa = (await addDoc('suppliers', { name: 'Bekaa Valley Farms', contact: '+961 8 123 456', createdAt: new Date().toISOString() })).id;
const beirutW = (await addDoc('suppliers', { name: 'Beirut Wholesale Foods', contact: '+961 1 987 654', createdAt: new Date().toISOString() })).id;
const tripoli = (await addDoc('suppliers', { name: 'Tripoli Trading Co.', contact: 'sales@tripolitrading.lb', createdAt: new Date().toISOString() })).id;
await core.setPrice(s, { supplierId: bekaa, itemId: items['Lebanese Rice 5kg'], price: 6.5 });
await core.setPrice(s, { supplierId: beirutW, itemId: items['Lebanese Rice 5kg'], price: 7 });
await core.setPrice(s, { supplierId: bekaa, itemId: items['Extra Virgin Olive Oil 1L'], price: 8.5 });
await core.setPrice(s, { supplierId: beirutW, itemId: items['Halloumi Cheese 250g'], price: 4 });
await core.setPrice(s, { supplierId: beirutW, itemId: items['Lebanese Coffee 200g'], price: 2.5 });
await core.setPrice(s, { supplierId: tripoli, itemId: items['Pine Nuts (Snobar) 200g'], price: 10 });
await core.setPrice(s, { supplierId: tripoli, itemId: items['Bulgur Wheat 1kg'], price: 1.2 });
console.log('  suppliers: 3, with prices set for the cheapest-supplier report');

// ---- Purchase orders, received into batches ----
const po1 = await core.createPurchaseOrder(s, { supplierId: bekaa, supplierName: 'Bekaa Valley Farms', status: 'ordered',
  lines: [{ itemId: items['Lebanese Rice 5kg'], itemName: 'Lebanese Rice 5kg', qty: 40, unitPrice: 6.5 }, { itemId: items['Extra Virgin Olive Oil 1L'], itemName: 'Extra Virgin Olive Oil 1L', qty: 20, unitPrice: 8.5 }] });
await core.receivePurchaseOrder(s, po1.id, { receipts: [{ index: 0, qty: 40, lotNo: 'BV-R1' }, { index: 1, qty: 20, lotNo: 'BV-O1' }], updatePrices: false });
const po2 = await core.createPurchaseOrder(s, { supplierId: beirutW, supplierName: 'Beirut Wholesale Foods', status: 'ordered',
  lines: [{ itemId: items['Halloumi Cheese 250g'], itemName: 'Halloumi Cheese 250g', qty: 25, unitPrice: 4 }, { itemId: items['Lebanese Coffee 200g'], itemName: 'Lebanese Coffee 200g', qty: 40, unitPrice: 2.5 }] });
await core.receivePurchaseOrder(s, po2.id, { receipts: [{ index: 0, qty: 25, lotNo: 'BW-H1', expiryDate: addDays(today, 12) }, { index: 1, qty: 40, lotNo: 'BW-C1' }], updatePrices: false });
console.log(`  purchase orders: ${po1.number}, ${po2.number} (received into batches)`);

// ---- Customers with Lebanese branches ----
const mkCustomer = (name, phone, branch) => addDoc('customers', { name, phone, branches: branch ? [{ id: 'b' + Math.random().toString(36).slice(2, 9), ...branch }] : [], createdAt: new Date().toISOString() });
const abouElie = (await mkCustomer('Abou Elie Grocery', '+961 3 111 222', { name: 'Achrafieh', city: 'Beirut', area: 'Sassine', mapLink: 'https://maps.google.com/?q=Achrafieh+Beirut', addressNote: 'Next to Sassine Square' })).id;
const seaCastle = (await mkCustomer('Sea Castle Market', '+961 9 222 333', { name: 'Kaslik', city: 'Jounieh', area: 'Kaslik', mapLink: 'https://maps.google.com/?q=Kaslik+Jounieh', addressNote: 'Near the highway exit' })).id;
const cedars = (await mkCustomer('Cedars Mini Mart', '+961 8 333 444', { name: 'Zahle Center', city: 'Zahle', area: 'Bekaa', mapLink: 'https://maps.google.com/?q=Zahle+Bekaa', addressNote: 'Main street, Zahle' })).id;
const manara = (await mkCustomer('Al Manara Supermarket', '+961 6 444 555', { name: 'El Mina', city: 'Tripoli', area: 'El Mina', mapLink: 'https://maps.google.com/?q=El+Mina+Tripoli', addressNote: 'Close to the port' })).id;
console.log('  customers: 4, each with a Lebanese branch (city, area, map link, address note)');

// ---- Sales, fulfilled, with dual-currency payments ----
const so1 = await core.createSalesOrder(s, { customerId: abouElie, customerName: 'Abou Elie Grocery',
  lines: [{ itemId: items['Lebanese Rice 5kg'], itemName: 'Lebanese Rice 5kg', qty: 10, unitPrice: 8 }, { itemId: items['Lebanese Coffee 200g'], itemName: 'Lebanese Coffee 200g', qty: 5, unitPrice: 4 }] });
await core.fulfilSalesOrder(s, so1.id); // total $100 - pay mixed USD/LBP
await core.recordPayment(s, 'salesOrders', so1.id, { usdAmount: 55, lbpAmount: 4027500, method: 'cash' }); // 55 + 4,027,500/89,500 = 100.00

const so2 = await core.createSalesOrder(s, { customerId: seaCastle, customerName: 'Sea Castle Market',
  lines: [{ itemId: items['Extra Virgin Olive Oil 1L'], itemName: 'Extra Virgin Olive Oil 1L', qty: 5, unitPrice: 12 }, { itemId: items['Halloumi Cheese 250g'], itemName: 'Halloumi Cheese 250g', qty: 8, unitPrice: 6 }] });
await core.fulfilSalesOrder(s, so2.id); // total $108 - paid fully in LBP
await core.recordPayment(s, 'salesOrders', so2.id, { lbpAmount: 108 * 89500, method: 'transfer' });

const so3 = await core.createSalesOrder(s, { customerId: cedars, customerName: 'Cedars Mini Mart',
  lines: [{ itemId: items['Zaatar Manakish Mix 500g'], itemName: 'Zaatar Manakish Mix 500g', qty: 10, unitPrice: 3.5 }] });
await core.fulfilSalesOrder(s, so3.id); // $35 - paid fully in USD
await core.recordPayment(s, 'salesOrders', so3.id, { usdAmount: 35, method: 'cash' });

const so4 = await core.createSalesOrder(s, { customerId: manara, customerName: 'Al Manara Supermarket',
  lines: [{ itemId: items['Chickpeas 1kg'], itemName: 'Chickpeas 1kg', qty: 12, unitPrice: 2.5 }, { itemId: items['Bulgur Wheat 1kg'], itemName: 'Bulgur Wheat 1kg', qty: 10, unitPrice: 2 }] });
await core.fulfilSalesOrder(s, so4.id); // $50 - left unpaid on purpose, to show "To collect"

const so5 = await core.createSalesOrder(s, { lines: [{ itemId: items['Pine Nuts (Snobar) 200g'], itemName: 'Pine Nuts (Snobar) 200g', qty: 2, unitPrice: 15 }], status: 'confirmed' });
await core.fulfilSalesOrder(s, so5.id); await core.setSalesPaid(s, so5.id, true); // walk-in, paid in full
console.log(`  sales orders: ${so1.number}, ${so2.number}, ${so3.number}, ${so4.number}, ${so5.number} (mixed USD/LBP payments, one left unpaid on purpose)`);

// ---- Expenses (payment vouchers) ----
await core.recordExpense(s, { category: 'Rent', usdAmount: 800, method: 'transfer', note: 'Beirut shop, monthly rent', date: today });
await core.recordExpense(s, { category: 'Salaries', usdAmount: 1200, method: 'transfer', note: 'Staff salaries', date: today });
await core.recordExpense(s, { category: 'Electricity & generator', lbpAmount: 3500000, method: 'cash', note: 'EDL bill + generator subscription', date: today });
await core.recordExpense(s, { category: 'Transport & fuel', lbpAmount: 1800000, method: 'cash', note: 'Delivery van fuel', date: today });
await core.recordExpense(s, { category: 'Municipality fees', lbpAmount: 900000, method: 'cash', note: 'Beirut municipality annual fee', date: today });
console.log('  expenses: 5 (Rent, Salaries in USD; Electricity, Transport, Municipality fees in LBP)');

console.log('\nDone. Sign in as the tenant owner and check Dashboard, Sales, Purchases, Expenses and Ledgers (Transactions / P&L).');
process.exit();
