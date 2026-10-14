-- Verification may resolve only the inventory alerts whose assignment is now
-- usable. It receives no general alert UPDATE privilege or token access.
CREATE FUNCTION ops.resolve_assigned_account_alerts(p_org uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE resolved int;
BEGIN
  UPDATE ops.alert al SET acknowledged_at = now()
  WHERE al.org_id = p_org AND al.kind = 'new_account' AND al.acknowledged_at IS NULL
    AND EXISTS (
      SELECT 1 FROM core.source_account sa
      JOIN core.account_assignment aa ON aa.org_id = sa.org_id
        AND aa.source_account_id = sa.source_account_id AND aa.valid @> now()
      JOIN core.account a ON a.org_id = aa.org_id AND a.account_id = aa.account_id
      WHERE sa.org_id = p_org AND sa.source_account_id::text = al.subject
        AND a.status <> 'placeholder'
    );
  GET DIAGNOSTICS resolved = ROW_COUNT;
  RETURN resolved;
END $$;
REVOKE ALL ON FUNCTION ops.resolve_assigned_account_alerts(uuid)
  FROM PUBLIC, ll_sync, ll_app, ll_reader, ll_rebuild, ll_backup;
GRANT USAGE ON SCHEMA ops TO ll_verify;
GRANT EXECUTE ON FUNCTION ops.resolve_assigned_account_alerts(uuid) TO ll_verify;
