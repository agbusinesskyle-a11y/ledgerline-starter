#!/usr/bin/env node
// Run a ledgerline service on your own computer using the settings in `.env`
// (created by `npm run setup`). It builds the right DATABASE_URL for each
// service's database role from LOCAL_PG_ADMIN_URL + the generated role passwords.
//
//   npm run local -- migrate                 create/upgrade the database (admin connection)
//   npm run local -- app                     web page for connecting banks (http://localhost:3000/link)
//   npm run local -- sync                    pull new transactions/balances from Plaid once
//   npm run local -- ownership FILE [--apply] assign accounts to your companies (dry run unless --apply)
//   npm run local -- reader-url              print the read-only URL Financial Books should use
//   npm run local -- org-id                  print the org id Financial Books should use
//
// Use --env-file PATH to read a different settings file.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
let args = process.argv.slice(2);
let envFile = `${root}.env`;
const at = args.indexOf('--env-file');
if (at >= 0) { envFile = args[at + 1]; args = args.filter((_, i) => i !== at && i !== at + 1); }
if (!existsSync(envFile)) { console.error(`No ${envFile}. Run "npm run setup" first.`); process.exit(1); }
process.loadEnvFile(envFile);

const [command, ...rest] = args;
const admin = process.env.LOCAL_PG_ADMIN_URL;
if (!admin) { console.error('LOCAL_PG_ADMIN_URL is missing from .env'); process.exit(1); }
function roleUrl(role) {
  const password = process.env[`ROLE_PASSWORD_${role.toUpperCase()}`];
  if (!password) { console.error(`ROLE_PASSWORD_${role.toUpperCase()} is missing from .env`); process.exit(1); }
  const url = new URL(admin);
  url.username = role; url.password = password;
  return url.href;
}
function run(script, env, extra = []) {
  const child = spawn(process.execPath, [script, ...extra], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', code => process.exit(code ?? 1));
}

switch (command) {
  case 'migrate':
    run('services/migrate/index.js', { DATABASE_URL: admin, MIGRATE_DATABASE_URL: admin });
    break;
  case 'app':
    run('services/app/index.js', { DATABASE_URL: roleUrl('ll_app') });
    break;
  case 'sync':
    run('services/sync/index.js', { DATABASE_URL: roleUrl('ll_sync'), PG_QUERY_TIMEOUT_MS: process.env.PG_QUERY_TIMEOUT_MS || '900000' });
    break;
  case 'ownership':
    run('scripts/apply-ownership.js', { DATABASE_URL: roleUrl('ll_verify') }, rest);
    break;
  case 'reader-url':
    console.log(roleUrl('ll_reader'));
    break;
  case 'org-id': {
    const client = new pg.Client({ connectionString: roleUrl('ll_reader') });
    await client.connect();
    const rows = (await client.query('SELECT DISTINCT org_id FROM core.entity')).rows;
    await client.end();
    for (const r of rows) console.log(r.org_id);
    break;
  }
  default:
    console.error('usage: npm run local -- <migrate | app | sync | ownership FILE [--apply] | reader-url | org-id>');
    process.exit(2);
}
