// One-off migration: adds the built-in "Admin" role (full permissions, id 'admin') to a tenant that was created
// before Admin existed in DEFAULT_ROLES (new tenants get it automatically at creation). Safe to re-run - saveRole
// just overwrites the same role doc with the current full-permissions set.
// Usage: node scripts/backfill-admin-role.mjs <adminUsername> <adminPassword> <tenantId> [tenantId...]
import { core } from './common.mjs';
import { fullPermissions } from '../core.js';

const [user, pw, ...tenantIds] = process.argv.slice(2);
if (!user || !pw || !tenantIds.length) { console.error('Usage: node scripts/backfill-admin-role.mjs <adminUsername> <adminPassword> <tenantId> [tenantId...]'); process.exit(1); }

const adminKey = await core.adminLogin(user, pw);
if (!adminKey) { console.error('Invalid admin credentials'); process.exit(1); }
for (const t of tenantIds) {
  try {
    const s = await core.adminEnterTenant(adminKey, t);
    await core.saveRole(s, { id: 'admin', name: 'Admin', permissions: fullPermissions() });
    console.log(`  ${t}: Admin role added/updated`);
  } catch (e) { console.log(`  ${t}: skipped - ${e.message}`); }
}
process.exit();
