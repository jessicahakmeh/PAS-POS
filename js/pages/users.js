// User management inside a tenant: add, change role, disable, reset password, delete.
import { h, icon, iconBtn, pageHead, searchBox, emptyState, fab, openForm, confirmDialog, toast, errText, norm, initials, skeletons } from '../ui.js';
import { core } from '../firebase.js';
import { state, can, replaceStoredSession } from '../state.js';
import { store, onData } from '../data.js';

// The 'owner' role can only change hands via "Transfer ownership" - it is never offered as an assignable role here.
const roleOptions = () => store.roles.filter(r => !r.system).map(r => ({ value: r.id, label: r.name }));
const roleName = (id) => store.roles.find(r => r.id === id)?.name || '(missing role)';

function addUser() {
  if (!store.roles.length) return toast('Roles are still loading, try again', 'error');
  openForm({
    title: 'New user', submitLabel: 'Add user',
    fields: [
      { name: 'username', label: 'Username', required: true, help: 'Letters, numbers, . - _ (2-30 characters)', autocomplete: 'off' },
      { name: 'password', label: 'Password', type: 'password', required: true, help: 'At least 6 characters', autocomplete: 'new-password' },
      { name: 'roleId', label: 'Role', type: 'select', options: roleOptions(), value: 'staff' },
    ],
    onSubmit: async (v) => { if (!can('users', 'create')) throw new Error('No permission'); await core.addUser(state.session, v); toast(`User ${v.username.trim().toLowerCase()} added`, 'success'); },
  });
}

function editUser(u) {
  openForm({
    title: `Edit ${u.username}`, submitLabel: 'Save changes',
    fields: [
      { name: 'roleId', label: 'Role', type: 'select', options: roleOptions(), value: u.roleId },
      { name: 'disabled', label: 'Disabled', type: 'switch', value: !!u.disabled, help: 'Disabled users cannot log in' },
      { name: 'password', label: 'New password', type: 'password', help: 'Leave blank to keep the current password', autocomplete: 'new-password' },
    ],
    onSubmit: async (v) => {
      if (!can('users', 'update')) throw new Error('No permission');
      await core.updateUser(state.session, u.username, { roleId: v.roleId, disabled: v.disabled });
      if (v.password) await core.resetPassword(state.session, u.username, v.password);
      toast('User updated', 'success');
    },
  });
}

async function removeUser(u) {
  if (!await confirmDialog({ title: `Delete ${u.username}?`, message: 'They will no longer be able to log in.', confirmLabel: 'Delete user', danger: true })) return;
  try { if (!can('users', 'delete')) throw new Error('No permission'); await core.deleteUser(state.session, u.username); toast('User deleted'); } catch (e) { toast(errText(e), 'error'); }
}

// Only the current owner sees this, on every user except themselves and any disabled user. The owner picks their own
// new role, since the outgoing owner cannot stay "Owner" (that role must belong to exactly one user).
function transferOwnershipFlow(target) {
  const options = store.roles.filter(r => !r.system);
  if (!options.length) return toast('Create another role first - you will need one after transferring ownership', 'error');
  openForm({
    title: `Make ${target.username} the owner?`, submitLabel: 'Transfer ownership', danger: true,
    fields: [{ name: 'selfRoleId', label: 'Your role after the transfer', type: 'select', options: options.map(r => ({ value: r.id, label: r.name })), value: options[0].id }],
    onSubmit: async (v) => {
      await core.transferOwnership(state.session, { toUsername: target.username, selfRoleId: v.selfRoleId });
      replaceStoredSession(await core.refreshSession(state.session)); // your own permissions changed - pick them up now, not just after a reload
      toast(`${target.username} is now the owner`, 'success');
    },
  });
}

export default {
  mount(view) {
    let q = '';
    const list = h('div', { class: 'list two' });
    const draw = () => {
      if (!store.loaded.users) return list.replaceChildren(...skeletons(3).children);
      const rows = store.users.filter(u => !q || norm(u.username).includes(q) || norm(roleName(u.roleId)).includes(q));
      if (!rows.length) return list.replaceChildren(emptyState('user', 'No matching users'));
      const amOwner = state.session.roleId === 'owner';
      list.replaceChildren(...rows.map(u => {
        const me = u.username === state.session.username, isOwner = u.roleId === 'owner';
        return h('div', { class: 'item' },
          h('div', { class: 'avatar ' + (u.disabled ? 'red' : isOwner ? 'gold' : '') }, initials(u.username)),
          h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, u.username, me ? h('span', { class: 'badge brand', style: 'margin-left:8px' }, 'you') : null),
            h('div', { class: 'row', style: 'margin-top:4px;flex-wrap:wrap' }, h('span', { class: 'badge brand' }, icon('shield', 12), roleName(u.roleId)), u.disabled ? h('span', { class: 'badge bad' }, 'disabled') : null),
            isOwner && me ? h('div', { class: 'muted small', style: 'margin-top:4px' }, 'To change your role, use "Transfer ownership" on another user first') : null),
          h('div', { class: 'tools' },
            !isOwner && can('users', 'update') ? iconBtn('edit', 'Edit user', () => editUser(u)) : null,
            amOwner && !me && !isOwner && !u.disabled ? iconBtn('key', 'Make owner', () => transferOwnershipFlow(u)) : null,
            can('users', 'delete') && !me && !isOwner ? iconBtn('trash', 'Delete user', () => removeUser(u), 'danger') : null));
      }));
    };
    view.append(pageHead('Users', [
      can('roles', 'read') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { location.hash = '#/roles'; } }, icon('shield', 16), 'Roles') : null]),
      h('div', { class: 'toolbar' }, searchBox('Search users', v => { q = norm(v.trim()); draw(); })), list,
      can('users', 'create') ? fab('Add user', addUser) : null);
    draw();
    return onData(draw);
  },
};
