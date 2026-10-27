// Supplier price report: cheapest supplier per item, last price from each supplier, price history, Excel export.
import { h, icon, iconBtn, setChildren, pageHead, searchBox, emptyState, money, day, norm, exportButton, skeletons } from '../ui.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { buildPriceReport, priceReportSheets } from '../../core.js';
import { openSupplierPrices } from '../components/pricesSheet.js';

export default {
  mount(view) {
    let q = '';
    const list = h('div', { class: 'list' });
    const report = () => buildPriceReport(store.inventory, store.suppliers, store.supplierPrices);
    const sheetsFor = () => priceReportSheets(report().rows.filter(r => !q || norm(r.itemName).includes(q)));

    const draw = () => {
      if (!store.loaded.inventory || !store.loaded.suppliers || !store.loaded.supplierPrices) return list.replaceChildren(...skeletons(3).children);
      const { rows, unpriced } = report();
      const shown = rows.filter(r => !q || norm(r.itemName).includes(q));
      const cards = shown.map(r => {
        const best = r.cheapest;
        const offers = r.offers.map(o => {
          const isBest = best.includes(o);
          const supplier = store.suppliers.find(s => s.id === o.supplierId);
          const hist = o.history.length > 1 ? h('div', { class: 'muted small' }, 'History: ', [...o.history].reverse().map(x => `${money(x.price)} (${day(x.at)})`).join(' → ')) : null;
          return h('div', { class: 'offer' + (isBest ? ' best' : '') },
            h('div', { class: 'grow' }, h('div', { class: 'row' }, h('b', {}, o.supplierName), isBest ? h('span', { class: 'badge ok' }, icon('check', 12), 'Cheapest') : null), hist),
            h('div', { style: 'text-align:right' }, h('div', { class: 'price' }, money(o.price)), h('div', { class: 'muted small' }, day(o.updatedAt))),
            can('supplierPrices', 'update') && supplier ? iconBtn('edit', `Edit ${o.supplierName} prices`, () => openSupplierPrices(supplier)) : null);
        });
        return h('details', { class: 'card', open: !!q && shown.length === 1 },
          h('summary', { style: 'cursor:pointer;list-style:none;display:flex;align-items:center;gap:12px' },
            h('div', { class: 'avatar green' }, icon('tag', 20)),
            h('div', { class: 'grow' }, h('div', { class: 'title' }, r.itemName),
              h('div', { class: 'sub muted small' }, 'Cheapest: ', h('b', {}, best.map(o => o.supplierName).join(', ')), ' at ', h('b', {}, money(r.offers[0].price)),
                r.saving ? ` • save up to ${money(r.saving)}` : '')),
            h('span', { class: 'badge' }, `${r.offers.length} supplier${r.offers.length > 1 ? 's' : ''}`), icon('chevron', 18)),
          h('div', { style: 'margin-top:12px' }, offers));
      });
      const missing = unpriced.filter(i => !q || norm(i.name).includes(q));
      setChildren(list,
        ...(cards.length ? cards : [emptyState('tag', rows.length ? 'No matching items' : 'No supplier prices yet', rows.length ? 'Try another search.' : 'Open the Suppliers page and set the price of each item a supplier provides.')]),
        missing.length ? h('div', { class: 'card' }, h('h3', {}, 'No supplier price yet'), h('div', { class: 'row', style: 'flex-wrap:wrap' }, missing.map(i => h('span', { class: 'badge warn' }, i.name)))) : null);
    };
    view.append(pageHead('Supplier prices', [exportButton(sheetsFor, () => `${state.session.tenantId}-prices`)]),
      h('p', { class: 'muted small', style: 'margin:-6px 0 12px' }, 'Tap an item to compare what each supplier charges.'),
      h('div', { class: 'toolbar' }, searchBox('Search items', v => { q = norm(v.trim()); draw(); })), list);
    draw();
    return onData(draw);
  },
};
