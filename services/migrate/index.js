import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

const directory = new URL('../../migrations/', import.meta.url);
const connectionString = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
let client;
let locked = false;
let code = 0;
try {
  if (!connectionString) throw new Error('DATABASE_URL or MIGRATE_DATABASE_URL is required');
  client = new pg.Client({ connectionString });
  await client.connect();
  await client.query('SELECT pg_advisory_lock(7001)');
  locked = true;
  await client.query(`CREATE SCHEMA IF NOT EXISTS meta;
    CREATE TABLE IF NOT EXISTS meta.migration (
      name text PRIMARY KEY, sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), applied_by text NOT NULL
    )`);
  let applied = 0;
  let skipped = 0;
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const sha256 = createHash('sha256').update(sql).digest('hex');
    const previous = await client.query('SELECT sha256 FROM meta.migration WHERE name = $1', [name]);
    if (previous.rowCount) {
      if (previous.rows[0].sha256 !== sha256) {
        console.error(`checksum mismatch: ${name}`);
        code = 2;
        break;
      }
      skipped++;
      continue;
    }
    await client.query('BEGIN');
    try {
      if (name !== '000_roles.sql') await client.query('SET LOCAL ROLE ll_owner');
      await client.query(sql);
      await client.query('INSERT INTO meta.migration (name, sha256, applied_by) VALUES ($1, $2, session_user)', [name, sha256]);
      await client.query('COMMIT');
      applied++;
    } catch (error) {
      await client.query('ROLLBACK');
      // Avoid logging connection configuration or SQL values (which can contain tokens).
      console.error(`migration failed: ${name} (${error.code || 'error'})`);
      code = 1;
      break;
    }
  }
  if (!code) {
    console.log(`applied ${applied} skipped ${skipped}`);
    // Bind credentials to a session-local function; never interpolate them in SQL.
    await client.query(`CREATE FUNCTION pg_temp.bootstrap_role(role_name text, credential text)
      RETURNS void LANGUAGE plpgsql AS $$ BEGIN
        EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', role_name, credential);
      END $$`);
    let bootstrapped = 0;
    const rolePasswordVariables = {
      ll_sync: 'ROLE_PASSWORD_LL_SYNC',
      ll_app: 'ROLE_PASSWORD_LL_APP',
      ll_verify: 'ROLE_PASSWORD_LL_VERIFY',
      ll_backup: 'ROLE_PASSWORD_LL_BACKUP',
      ll_reader: 'ROLE_PASSWORD_LL_READER',
      ll_rebuild: 'ROLE_PASSWORD_LL_REBUILD',
    };
    for (const [role, variable] of Object.entries(rolePasswordVariables)) {
      const password = process.env[variable];
      if (password !== undefined) {
        await client.query('SELECT pg_temp.bootstrap_role($1, $2)', [role, password]);
        bootstrapped++;
      }
    }
    console.log(`roles bootstrapped: ${bootstrapped}`);
  }
} catch (error) {
  console.error(`migrate failed (${error.code || 'configuration/connection error'})`);
  code = 1;
} finally {
  if (locked) await client.query('SELECT pg_advisory_unlock(7001)').catch(() => {});
  if (client) await client.end().catch(() => {});
}
process.exitCode = code;
