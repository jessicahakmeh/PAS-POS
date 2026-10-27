// Editor for a customer's branches (locations): name, city, area, a Google Maps link and an address description.
import { h, icon, iconBtn } from '../ui.js';

const newId = () => 'b' + Math.random().toString(36).slice(2, 9);

export function branchEditor(initial = []) {
  let branches = initial.map(b => ({ ...b, id: b.id || newId() }));
  const list = h('div', { class: 'stack' });

  function row(b, i) {
    const name = h('input', { class: 'input', placeholder: 'Branch name (e.g. Downtown)', value: b.name || '' });
    const city = h('input', { class: 'input', placeholder: 'City', value: b.city || '' });
    const area = h('input', { class: 'input', placeholder: 'Area / neighbourhood', value: b.area || '' });
    const map = h('input', { class: 'input', type: 'url', placeholder: 'Google Maps link', inputmode: 'url', value: b.mapLink || '' });
    const note = h('input', { class: 'input', placeholder: 'Address description', value: b.addressNote || '' });
    [['name', name], ['city', city], ['area', area], ['mapLink', map], ['addressNote', note]].forEach(([k, el]) => el.addEventListener('input', () => { b[k] = el.value; }));
    return h('div', { class: 'card' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' }, h('b', {}, `Branch ${i + 1}`), iconBtn('trash', 'Remove branch', () => { branches.splice(i, 1); draw(); }, 'danger')),
      h('div', { class: 'stack' }, name, h('div', { class: 'row' }, city, area), map, note));
  }
  function draw() {
    list.replaceChildren(...(branches.length ? branches.map(row) : [h('p', { class: 'muted small', style: 'margin:0' }, 'No branches yet. Add one for each location this customer orders from.')]));
  }
  const add = h('button', { class: 'btn soft sm', type: 'button', onclick: () => { branches.push({ id: newId() }); draw(); } }, icon('plus', 16), 'Add branch');
  draw();
  return {
    node: h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Branches (locations)'), list, add),
    getBranches: () => branches.filter(b => (b.name || b.city || b.area || b.mapLink || b.addressNote || '').trim())
      .map(b => ({ id: b.id, name: (b.name || '').trim(), city: (b.city || '').trim(), area: (b.area || '').trim(), mapLink: (b.mapLink || '').trim(), addressNote: (b.addressNote || '').trim() })),
  };
}

export const branchLabel = (b) => b.name || [b.city, b.area].filter(Boolean).join(', ') || 'Branch';
