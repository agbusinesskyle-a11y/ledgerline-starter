-- Runtime helpers preserve the Step 0 ban on direct operational table writes.
CREATE FUNCTION core.org_id_for_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, raw, verify, ops AS $$
  SELECT org_id FROM core.org WHERE slug = p_slug
$$;
REVOKE ALL ON FUNCTION core.org_id_for_slug(text) FROM PUBLIC, ll_verify, ll_rebuild, ll_backup, ll_sync, ll_app, ll_reader;
GRANT EXECUTE ON FUNCTION core.org_id_for_slug(text) TO ll_app, ll_sync, ll_backup;

CREATE FUNCTION ops.pending_alerts() RETURNS SETOF ops.alert
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, raw, verify, ops AS $$
  SELECT * FROM ops.alert WHERE delivered_at IS NULL AND severity = 'page' ORDER BY raised_at, id
$$;
REVOKE ALL ON FUNCTION ops.pending_alerts() FROM PUBLIC, ll_verify, ll_rebuild, ll_backup, ll_sync, ll_app, ll_reader;
CREATE FUNCTION ops.record_alert_attempt(p_id uuid, p_delivered bool) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, core, raw, verify, ops AS $$
  WITH attempted AS (
    UPDATE ops.alert SET attempts = attempts + 1,
      delivered_at = CASE WHEN p_delivered THEN now() ELSE delivered_at END
    WHERE id = p_id AND delivered_at IS NULL AND severity = 'page'
    RETURNING org_id, dedupe_key
  )
  UPDATE ops.alert a SET delivered_at = now() FROM attempted t
  WHERE p_delivered AND a.org_id = t.org_id AND a.dedupe_key = t.dedupe_key
    AND a.id <> p_id AND a.delivered_at IS NULL AND a.severity = 'page'
$$;
REVOKE ALL ON FUNCTION ops.record_alert_attempt(uuid, bool) FROM PUBLIC, ll_verify, ll_rebuild, ll_backup, ll_sync, ll_app, ll_reader;
GRANT EXECUTE ON FUNCTION ops.pending_alerts(), ops.record_alert_attempt(uuid, bool) TO ll_sync, ll_app;
-- Backup has only this append-only health-reporting capability, never table writes.
GRANT EXECUTE ON FUNCTION ops.heartbeat(uuid, text, bool, jsonb) TO ll_backup;
