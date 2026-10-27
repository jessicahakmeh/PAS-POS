// Seeds the platform admin login. Usage: node scripts/seed-admin.mjs [username] [password]
// With no password a random one is generated and printed once (also saved to .admin-credentials.txt, git-ignored).
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { core } from './common.mjs';

const username = process.argv[2] || 'admin';
const generated = !process.argv[3];
const password = process.argv[3] || randomBytes(9).toString('base64url');

try {
  await core.seedAdmin(username, password);
  console.log(`Platform admin seeded.\n  username: ${username}\n  password: ${password}`);
  console.log('Log in with the Tenant ID field left BLANK.');
  if (generated) writeFileSync(new URL('../.admin-credentials.txt', import.meta.url), `username: ${username}\npassword: ${password}\n`);
} catch (e) {
  console.error('Seed failed:', e.message);
  process.exitCode = 1;
}
process.exit();
