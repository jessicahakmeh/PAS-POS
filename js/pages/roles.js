// Role management: granular Create/Read/Update/Delete permissions per resource.
import { h, icon, iconBtn, pageHead, emptyState, fab, openForm, confirmDialog, toast, errText, skeletons } from '../ui.js';
import { core } from '../firebase.js';
import { state, can } from '../state.js';
import { store, onData } from '../data.js';
import { RESOURCES, ACTIONS, RESOURCE_LABELS } from '../../core.js';

// Grouped purely for readability in the (long) permission grid - has no effect on what is saved.
const PERMISSION_GROUPS = [
  { label: 'Inventory & stock', resources: ['inventory', 'batches', 'waste'] },
  { label: 'Orders & money', resources: ['salesOrders', 'purchaseOrders', 'expenses', 'reports', 'ledgers'] },
  { label: 'Directory', resources: ['customers', 'suppliers', 'supplierPrices'] },
  { label: 'Administration', resources: ['settings', 'users', 'roles'] },
];
// Safety net: if a future resource is added to core.js and someone forgets to place it above, show it rather than silently dropping it.
{ const grouped = new Set(PERMISSION_GROUPS.flatMap(g => g.resources)); const leftover = RESOURCES.filter(r => !grouped.has(r));
  if (leftover.length) PERMISSION_GROUPS.push({ label: 'Other', resources: leftover }); }

function permissionGrid(perms = {}) {
  const grid = h('div', { class: 'perm-grid' });
  const boxes = {};
  for (const group of PERMISSION_GROUPS) {
    grid.append(h('div', { class: 'perm-group-label' }, group.label));
    for (const res of group.resources) {
      const resBoxes = {};
      const acts = h('div', { class: 'acts' });
      for (const a of ACTIONS) {
        const cb = h('input', { type: 'checkbox', checked: !!perms?.[res]?.[a] });
        boxes[`${res}.${a}`] = cb; resBoxes[a] = cb;
        acts.append(h('label', {}, cb, a));
      }
      // "All" is a shortcut that ticks/clears all four at once - it stays in sync however the individual boxes change.
      const allCb = h('input', { type: 'checkbox' });
      const syncAll = () => { allCb.checked = ACTIONS.every(a => resBoxes[a].checked); };
      syncAll();
      allCb.addEventListener('change', () => { for (const a of ACTIONS) resBoxes[a].checked = allCb.checked; });
      // create/update/delete are only useful with read access: keep the toggles consistent.
      const readCb = resBoxes.read;
      for (const a of ['create', 'update', 'delete']) resBoxes[a].addEventListener('change', e => { if (e.target.checked) readCb.checked = true; syncAll(); });
      readCb.addEventListener('change', () => { if (!readCb.checked) for (const a of ['create', 'update', 'delete']) resBoxes[a].checked = false; syncAll(); });
      grid.append(h('div', { class: 'perm-row' },
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('div', { class: 'name' }, RESOURCE_LABELS[res]), h('label', { class: 'perm-all' }, allCb, 'All')),
        acts));
    }
  }
  const read = () => Object.fromEntries(RESOURCES.map(res => [res, Object.fromEntries(ACTIONS.map(a => [a, boxes[`${res}.${a}`].checked]))]));
  return { node: h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Permissions'), grid), read };
}

function roleForm(role) {
  const grid = permissionGrid(role?.permissions);
  openForm({
    title: role ? `Edit ${role.name}` : 'New role', submitLabel: role ? 'Save changes' : 'Create role',
    fields: [{ name: 'name', label: 'Role name', value: role?.name, required: true, placeholder: 'e.g. Cashier' }, { node: grid.node }],
    onSubmit: async (v) => {
      if (!can('roles', role ? 'update' : 'create')) throw new Error('No permission');
      await core.saveRole(state.session, { id: role?.id, name: v.name, permissions: grid.read() });
      toast(role ? 'Role updated' : 'Role created', 'success');
    },
  });
}

async function removeRole(role) {
  if (!await confirmDialog({ title: `Delete ${role.name}?`, message: 'Users must be moved to another role first.', confirmLabel: 'Delete role', danger: true })) return;
  try { if (!can('roles', 'delete')) throw new Error('No permission'); await core.deleteRole(state.session, role.id); toast('Role deleted'); } catch (e) { toast(errText(e), 'error'); }
}

export default {
  mount(view) {
    const list = h('div', { class: 'list two' });
    const draw = () => {
      if (!store.loaded.roles) return list.replaceChildren(...skeletons(3).children);
      if (!store.roles.length) return list.replaceChildren(emptyState('shield', 'No roles'));
      list.replaceChildren(...store.roles.map(r => {
        const users = store.users.filter(u => u.roleId === r.id).length;
        const chips = RESOURCES.map(res => {
          const acts = ACTIONS.filter(a => r.permissions?.[res]?.[a]);
          return acts.length ? h('span', { class: 'badge ' + (acts.length === 4 ? 'ok' : 'brand') }, `${RESOURCE_LABELS[res]}: ${acts.length === 4 ? 'full' : acts.map(a => a[0].toUpperCase()).join('')}`) : null;
        });
        return h('div', { class: 'item', style: 'align-items:flex-start' },
          h('div', { class: 'avatar gold' }, icon('shield', 20)),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, r.name, r.system ? h('span', { class: 'badge', style: 'margin-left:8px' }, 'system') : null),
            h('div', { class: 'sub' }, `${users} user${users === 1 ? '' : 's'}`),
            h('div', { class: 'row', style: 'flex-wrap:wrap;margin-top:8px;gap:6px' }, chips.some(Boolean) ? chips : h('span', { class: 'muted small' }, 'No permissions'))),
          h('div', { class: 'tools' }, !r.system && can('roles', 'update') ? iconBtn('edit', 'Edit role', () => roleForm(r)) : null,
            !r.system && can('roles', 'delete') ? iconBtn('trash', 'Delete role', () => removeRole(r), 'danger') : null));
      }));
    };
    view.append(pageHead('Roles', [h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { location.hash = '#/users'; } }, icon('user', 16), 'Users')]),
      h('p', { class: 'muted small', style: 'margin:-6px 0 12px' }, 'C = create, R = read, U = update, D = delete.'), list,
      can('roles', 'create') ? fab('New role', () => roleForm(null)) : null);
    draw();
    return onData(draw);
  },
};
