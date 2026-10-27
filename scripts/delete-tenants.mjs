// Deletes tenants (all data + logins) as platform admin. Usage: node scripts/delete-tenants.mjs <adminUsername> <adminPassword> <tenantId>...
import { core } from './common.mjs';

const [user, pw, ...names] = process.argv.slice(2);
const adminKey = await core.adminLogin(user, pw);
if (!adminKey) { console.error('Invalid admin credentials'); process.exit(1); }
for (const n of names) {
  try { await core.deleteTenant(adminKey, n); console.log('deleted', n); } catch (e) { console.log('skip', n, '-', e.message); }
}
console.log('remaining:', (await core.listTenants(adminKey)).map(t => t.name).join(', ') || '(none)');
process.exit();
