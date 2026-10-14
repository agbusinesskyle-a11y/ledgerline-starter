// Read-only production diagnostic for the sync lane. Run as a one-off start command
// on the sync service (it has the ll_sync DATABASE_URL and no public DB access exists):
// prints connection states, recent attempts, publications, raw call outcomes and open
// alerts. Never prints tokens, payload bodies or DSNs.
import { createPool } from '../lib/db.js';
import { log, logFailure } from '../lib/log.js';
const pool = createPool(process.env);
try {
  const q = async (label, sql) => {
    try { const r = await pool.query(sql); log('info', label, { rows: r.rows }); }
    catch (error) { logFailure(`diag query failed: ${label}`, error); }
  };
  // Server activity (full detail only for a superuser/pg_read_all_stats session).
  await q('activity', `SELECT pid, usename, application_name, state, wait_event_type, wait_event,
      xact_start::text, query_start::text, left(query, 140) AS query
    FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state IS NOT NULL
    ORDER BY xact_start NULLS LAST`);
  await q('advisory_locks', `SELECT l.pid, l.locktype, l.classid, l.objid, l.granted, a.state, a.wait_event
    FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE l.locktype = 'advisory' ORDER BY l.pid`);
  await q('connections', `SELECT connection_id, institution_name, state, cursor IS NOT NULL AS has_cursor,
    transactions_update_status, last_successful_update::text, created_at::text, cursor_updated_at::text FROM core.source_connection ORDER BY created_at`);
  await q('schedule', 'SELECT connection_id, state, last_synced_at::text, inventory_at::text, health_at::text FROM ops.sync_schedule');
  await q('attempts', `SELECT id, connection_id, status, error, restarts, process_id, started_at::text, ended_at::text, publication_id, predecessor_publication_id, cursor_in IS NOT NULL AS has_cursor_in
    FROM ops.sync_attempt ORDER BY id DESC LIMIT 12`);
  await q('publications', 'SELECT id, kind, created_at::text FROM ops.publication ORDER BY id DESC LIMIT 12');
  await q('api_calls', `SELECT id, connection_id, endpoint, http_status, error_type, error_code, received_at
    FROM raw.api_call ORDER BY id DESC LIMIT 12`);
  await q('pages', `SELECT attempt_id, count(*) AS pages, max(page_no) AS last_page, bool_or(has_more) AS any_has_more
    FROM raw.sync_page GROUP BY attempt_id ORDER BY attempt_id DESC LIMIT 6`);
  await q('alerts', `SELECT kind, severity, subject, raised_at::text, acknowledged_at IS NOT NULL AS acked, delivered_at IS NOT NULL AS delivered
    FROM ops.alert ORDER BY raised_at DESC LIMIT 12`);
  await q('state_events', 'SELECT connection_id, from_state, to_state, at::text FROM ops.connection_state_event ORDER BY at');
  // Coverage per bank account (readable by ll_backup; ll_sync cannot read fact tables by design).
  await q('coverage', `SELECT sc.institution_name, sa.external_name, sa.mask, sa.type, sa.subtype, sa.capability,
      sc.transactions_update_status, count(t.transaction_id) AS transactions,
      min(t.posted_date)::text AS earliest, max(t.posted_date)::text AS latest
    FROM core.source_account sa
    JOIN core.source_connection sc ON sc.org_id = sa.org_id AND sc.connection_id = sa.connection_id
    LEFT JOIN core.transaction t ON t.org_id = sa.org_id AND t.source_account_id = sa.source_account_id
    GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2`);
  // Optional focused listing: DIAG_MASK=1234 DIAG_FROM=2026-01-01 DIAG_TO=2026-02-01 (amounts/dates only).
  if (process.env.DIAG_MASK) {
    const r = await pool.query(`SELECT t.posted_date::text, t.authorized_date::text, t.amount::text, t.pending, t.status,
        left(coalesce(t.merchant_name, t.description_raw), 40) AS description
      FROM core.transaction t JOIN core.source_account sa ON sa.org_id = t.org_id AND sa.source_account_id = t.source_account_id
      WHERE sa.mask = $1 AND t.posted_date >= $2::date AND t.posted_date < $3::date ORDER BY t.posted_date, t.amount`,
      [process.env.DIAG_MASK, process.env.DIAG_FROM || '1900-01-01', process.env.DIAG_TO || '2999-01-01']).catch(e => ({ rows: [{ error: e.message }] }));
    log('info', 'mask_transactions', { rows: r.rows });
  }
  await q('counts', `SELECT (SELECT count(*) FROM core.transaction) AS transactions, (SELECT count(*) FROM core.transaction_alias) AS aliases,
    (SELECT count(*) FROM core.account) AS accounts, (SELECT count(*) FROM raw.api_call) AS api_calls, (SELECT count(*) FROM ops.publication) AS publications`);
} catch (error) { logFailure('diag failed', error); process.exitCode = 1; }
finally { await pool.end(); }
