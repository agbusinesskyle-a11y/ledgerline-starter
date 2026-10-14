import pg from 'pg';
import { requireEnv } from './log.js';
export function createPool(env = process.env) {
  const connectionString = requireEnv(env, 'DATABASE_URL');
  const user = decodeURIComponent(new URL(connectionString).username);
  if (user === 'postgres' && env.ALLOW_SUPERUSER !== '1') {
    throw new Error('postgres runtime connection refused; ALLOW_SUPERUSER=1 required');
  }
  // Client-side query timeout. The sync service must raise it (PG_QUERY_TIMEOUT_MS) because a
  // first historical acceptance runs one long SQL call: a large bank's first one took ~58 s, the
  // 30 s default fired, and the poison path then raced the still-running server transaction.
  const queryTimeout = (env.PG_QUERY_TIMEOUT_MS ?? '') === '' ? 30000 : Number(env.PG_QUERY_TIMEOUT_MS);
  if (!Number.isInteger(queryTimeout) || queryTimeout < 1000 || queryTimeout > 3_600_000) throw new Error('PG_QUERY_TIMEOUT_MS must be 1000..3600000');
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, query_timeout: queryTimeout, max: 5 });
  pool.on('error', () => {}); // Callers log sanitized errors; never print a DSN.
  return pool;
}
