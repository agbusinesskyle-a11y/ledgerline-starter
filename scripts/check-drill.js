import pg from 'pg';
import { log, logFailure, requireEnv } from '../services/lib/log.js';
let client;
try {
  const dsn = requireEnv(process.env, 'DATABASE_URL'), kek = requireEnv(process.env, 'TOKEN_KEK');
  const url = new URL(dsn);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ll_drill') throw new Error('helper requires local ll_drill target');
  client = new pg.Client({ connectionString: dsn }); await client.connect();
  const tokens = (await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE length(public.pgp_sym_decrypt(access_token_enc, $1::text)) > 0)::int AS decrypted
    FROM core.source_connection`, [kek])).rows[0];
  const cursors = (await client.query(`SELECT count(*)::int AS accepted,
    count(*) FILTER (WHERE c.cursor IS NOT DISTINCT FROM a.cursor_out AND c.last_publication_id = a.publication_id)::int AS consistent
    FROM core.source_connection c JOIN raw.sync_acceptance a ON a.connection_id = c.connection_id
    WHERE a.publication_id = (SELECT max(b.publication_id) FROM raw.sync_acceptance b WHERE b.connection_id = c.connection_id)`)).rows[0];
  log('info', 'drill decryption and cursor consistency', { connections: tokens.total, decrypted: tokens.decrypted, ...cursors });
  if (!tokens.total || tokens.decrypted !== tokens.total || !cursors.accepted || cursors.consistent !== cursors.accepted) {
    throw new Error('drill incomplete or inconsistent');
  }
} catch (error) { logFailure('drill incomplete: require decryptable fixture and consistent restored acceptance; real sync resumption still required', error); process.exitCode = 1; }
finally { if (client) await client.end(); }
