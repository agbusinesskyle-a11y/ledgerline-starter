import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { log, logFailure, requireEnv } from '../services/lib/log.js';
export async function rehydrateRuntime(env = process.env) {
  const dsn = requireEnv(env, 'DATABASE_URL');
  const url = new URL(dsn);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ll_drill') throw new Error('helper requires local ll_drill target');
  const client = new pg.Client({ connectionString: dsn });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT nspname FROM pg_namespace WHERE nspname IN ('core','raw','verify','ops','serve','meta') LOOP
        EXECUTE format('ALTER SCHEMA %I OWNER TO ll_owner', r.nspname);
      END LOOP;
      FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('core','raw','verify','ops','serve','meta') AND c.relkind IN ('r','p','v','m','S')
        ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END LOOP
        EXECUTE format('ALTER %s %I.%I OWNER TO ll_owner',
          CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
          r.nspname, r.relname);
      END LOOP;
      FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('core','raw','verify','ops','serve','meta') AND p.prokind='f' LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO ll_owner', r.signature);
      END LOOP;
    END $$`);
    await client.query('SET LOCAL ROLE ll_owner');
    await client.query(await readFile(new URL('../migrations/090_grants.sql', import.meta.url), 'utf8'));
    const step1 = await readFile(new URL('../migrations/100_step1_ops.sql', import.meta.url), 'utf8');
    for (const grant of step1.match(/(?:GRANT|REVOKE)\s+[^;]+;/g) || []) await client.query(grant);
    await client.query('RESET ROLE');
    await client.query(`CREATE FUNCTION pg_temp.drill_role(role_name text, credential text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', role_name, credential); END $$`);
    let count = 0;
    for (const role of ['ll_sync','ll_app','ll_verify','ll_backup','ll_reader','ll_rebuild']) {
      const password = env[`ROLE_PASSWORD_${role.toUpperCase()}`];
      if (password !== undefined) { await client.query('SELECT pg_temp.drill_role($1,$2)', [role, password]); count++; }
    }
    await client.query('COMMIT');
    log('info', 'drill ownership and grants restored', { roles_bootstrapped: count });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await client.end(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await rehydrateRuntime(); }
  catch (error) { logFailure('drill runtime setup failed (requires local ll_drill)', error); process.exitCode = 1; }
}
