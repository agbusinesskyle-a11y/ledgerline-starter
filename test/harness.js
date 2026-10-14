import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { symlinkSync, unlinkSync, lstatSync } from 'node:fs';

export const runtimeRoles = ['ll_sync', 'll_app', 'll_verify', 'll_rebuild', 'll_backup', 'll_reader'];
const root = fileURLToPath(new URL('../', import.meta.url));

// Node 22 resolves an explicit directory argument through index.js rather than
// discovering test files. Keep the mandated test command and create a temporary
// loader only for its duration; it is never part of the deliverable patch.
const loader = fileURLToPath(new URL('./index.js', import.meta.url));
if (process.argv[2] === '--prepare') {
  try {
    const existing = lstatSync(loader);
    if (!existing.isSymbolicLink()) throw new Error('test loader path already exists');
    unlinkSync(loader);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  symlinkSync('all.test.js', loader);
}

// node:test's TAP reporter must finish flushing before the worker exits.
process.once('beforeExit', code => {
  if (process.argv[2] !== '--prepare') {
    try { if (lstatSync(loader).isSymbolicLink()) unlinkSync(loader); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  process.stdout.write('', () => process.exit(process.exitCode || code));
});

export function runMigrate(databaseUrl, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['services/migrate/index.js'], {
      cwd: root,
      env: { ...process.env, ...env, DATABASE_URL: databaseUrl, MIGRATE_DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

export async function createHarness() {
  const adminUrl = new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5499/postgres');
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  const database = `ll_test_${randomBytes(8).toString('hex')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${database}`;
  const clients = new Set();
  const initialRoles = new Set((await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'll_%'")).rows.map(r => r.rolname));
  let created = false;
  async function connect(url) {
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    clients.add(client);
    client.once('end', () => clients.delete(client));
    return client;
  }
  async function drop() {
    await Promise.all([...clients].map(client => client.end()));
    try {
      if (created) {
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        created = false;
      }
      // Roles are cluster-wide, unlike schemas. Remove only this harness's roles
      // after dropping their database so another test run starts from a clean cluster.
      for (const role of [...runtimeRoles, 'll_owner']) {
        if (!initialRoles.has(role) && (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount) {
          await admin.query(`DROP ROLE ${role}`);
        }
      }
    } finally {
      await admin.end();
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    const migration = await runMigrate(databaseUrl.href);
    if (migration.code !== 0) throw new Error(migration.stderr);
    // Only the test harness enables runtime LOGIN and predictable fixture passwords.
    // ll_owner stays NOLOGIN; production migration SQL never enables LOGIN.
    for (const role of runtimeRoles) await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${role}'`);
    return {
      database, databaseUrl: databaseUrl.href, migration,
      async asRole(role) {
        if (!runtimeRoles.includes(role)) throw new Error('unknown runtime role');
        const url = new URL(databaseUrl);
        url.username = role;
        url.password = role;
        return connect(url);
      },
      async asOwner() {
        const client = await connect(databaseUrl);
        await client.query('SET ROLE ll_owner');
        return client;
      },
      async asAdmin() { return connect(databaseUrl); },
      drop,
    };
  } catch (error) {
    await drop();
    throw error;
  }
}
