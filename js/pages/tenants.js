// Platform admin console: create, suspend/activate, delete tenants, and open any tenant.
import { h, icon, iconBtn, pageHead, emptyState, fab, openForm, confirmDialog, typedConfirm, toast, errText, day, skeletons } from '../ui.js';
import { core } from '../firebase.js';
import { state, setSession } from '../state.js';

export default {
  mount(view) {
    const list = h('div', { class: 'list two' });
    let alive = true;
    const key = () => state.admin.adminKey;
    const dataKeyOf = async (name) => (await core.adminEnterTenant(key(), name)).dataKey;

    async function load() {
      list.replaceChildren(...skeletons(3).children);
      try {
        const tenants = await core.listTenants(key());
        if (!alive) return;
        if (!tenants.length) return list.replaceChildren(emptyState('building', 'No tenants yet', 'Create the first tenant to get started.'));
        list.replaceChildren(...tenants.map(t => {
          const suspended = t.status === 'suspended';
          return h('div', { class: 'item' },
            h('div', { class: 'avatar ' + (suspended ? 'red' : 'green') }, icon('building', 20)),
            h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, t.name),
              h('div', { class: 'row', style: 'margin-top:4px;flex-wrap:wrap;gap:6px' }, h('span', { class: 'badge ' + (suspended ? 'bad' : 'ok') }, t.status), h('span', { class: 'badge' }, `${t.users} user${t.users === 1 ? '' : 's'}`), h('span', { class: 'muted small' }, day(t.createdAt)))),
            h('div', { class: 'tools' },
              iconBtn('external', `Open ${t.name}`, () => open(t.name)),
              iconBtn(suspended ? 'play' : 'pause', suspended ? 'Activate tenant' : 'Suspend tenant', () => toggle(t, suspended)),
              iconBtn('trash', 'Delete tenant', () => remove(t), 'danger')));
        }));
      } catch (e) { list.replaceChildren(emptyState('alert', 'Could not load tenants', errText(e))); }
    }

    async function open(name) {
      try { setSession(await core.adminEnterTenant(key(), name)); } catch (e) { toast(errText(e), 'error'); }
    }
    async function toggle(t, suspended) {
      if (!suspended && !await confirmDialog({ title: `Suspend ${t.name}?`, message: 'Its users will not be able to log in until you activate it again.', confirmLabel: 'Suspend', danger: true })) return;
      try { await core.setTenantStatus(await dataKeyOf(t.name), suspended ? 'active' : 'suspended'); toast(suspended ? 'Tenant activated' : 'Tenant suspended', 'success'); load(); } catch (e) { toast(errText(e), 'error'); }
    }
    async function remove(t) {
      if (!await typedConfirm({ title: `Delete ${t.name}?`, message: 'This permanently deletes ALL of its data and users. The tenant ID stays reserved.', expected: t.name, confirmLabel: 'Delete forever' })) return;
      try { await core.deleteTenant(key(), t.name); toast('Tenant deleted'); load(); } catch (e) { toast(errText(e), 'error'); }
    }
    function create() {
      openForm({
        title: 'New tenant', submitLabel: 'Create tenant',
        fields: [
          { name: 'tenant', label: 'Tenant ID', required: true, help: 'Letters, numbers, - _ (2-30). Users log in with this.', autocomplete: 'off' },
          { name: 'owner', label: 'Owner username', required: true, autocomplete: 'off' },
          { name: 'ownerPassword', label: 'Owner password', type: 'password', required: true, help: 'At least 6 characters', autocomplete: 'new-password' },
        ],
        onSubmit: async (v) => { await core.createTenant(key(), v.tenant, v.owner, v.ownerPassword); toast(`Tenant ${v.tenant.trim().toLowerCase()} created`, 'success'); if (alive) load(); },
      });
    }

    view.append(pageHead('Tenants'), list, fab('New tenant', create));
    load();
    return () => { alive = false; };
  },
};
