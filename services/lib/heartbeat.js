import { log, requireEnv } from './log.js';
const warned = new Set();
export async function ping(name, pool, detail = {}, env = process.env) {
  name = name.toUpperCase();
  const variable = `HEALTHCHECKS_PING_${name}`;
  if (!env[variable]) {
    if (!warned.has(variable)) { log('warn', `missing variable: ${variable}`); warned.add(variable); }
    return false;
  }
  if (pool) {
    if (env.LL_ORG_SLUG) {
      await pool.query('SELECT ops.heartbeat(core.org_id_for_slug($1), $2, true, $3::jsonb)', [env.LL_ORG_SLUG, name.toLowerCase(), JSON.stringify(detail)]);
    } else {
      // Railway backup has no org slug; its read-only role can discover the
      // single seeded tenant. Multiple tenants require an explicit selection.
      const orgs = (await pool.query('SELECT org_id FROM core.org ORDER BY slug LIMIT 2')).rows;
      if (orgs.length !== 1) requireEnv(env, 'LL_ORG_SLUG');
      await pool.query('SELECT ops.heartbeat($1::uuid, $2, true, $3::jsonb)', [orgs[0].org_id, name.toLowerCase(), JSON.stringify(detail)]);
    }
  }
  const response = await fetch(env[variable], { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('heartbeat rejected');
  return true;
}
