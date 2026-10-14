-- A freshly registered Item is 'linked' (core.register_connection) and only becomes
-- 'inventoried' when core.record_inventory runs — which the sync loop performs for
-- schedule rows whose inventory_at is NULL. The schedule excluded 'linked', so a new
-- bank was never inventoried or synced (observed: sync saw connections=0).
-- Include 'linked'; the loop inventories it first and run.js still refuses to open a
-- sync attempt until the state is inventoried or later.
CREATE OR REPLACE VIEW ops.sync_schedule AS
  SELECT c.connection_id,c.org_id,c.state,c.cursor_updated_at AS last_synced_at,
    (SELECT max(p.created_at) FROM ops.publication p WHERE p.kind='inventory'
      AND p.payload->>'connection_id'=c.connection_id::text) AS inventory_at,
    (SELECT max(a.received_at) FROM raw.api_call a WHERE a.connection_id=c.connection_id
      AND a.endpoint='/item/get') AS health_at
  FROM core.source_connection c WHERE c.state IN ('linked','inventoried','initial_sync','ok','retryable_error');
