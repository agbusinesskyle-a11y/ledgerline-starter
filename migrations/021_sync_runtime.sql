-- Operational views expose only sync metadata under the existing ops SELECT
-- grant. Runtime roles still cannot write core or read arbitrary raw payloads.
CREATE VIEW ops.sync_acceptance AS
  SELECT attempt_id,publication_id FROM raw.sync_acceptance;
CREATE VIEW ops.sync_claim_context AS
  SELECT pa.connection_id AS subject_connection_id,pa.external_id AS pending_id,
    qa.connection_id,qa.external_id
  FROM core.transaction_alias pa JOIN core.transaction_alias qa USING(transaction_id)
  WHERE qa.authoritative;
CREATE VIEW ops.sync_schedule AS
  SELECT c.connection_id,c.org_id,c.state,c.cursor_updated_at AS last_synced_at,
    (SELECT max(p.created_at) FROM ops.publication p WHERE p.kind='inventory'
      AND p.payload->>'connection_id'=c.connection_id::text) AS inventory_at,
    (SELECT max(a.received_at) FROM raw.api_call a WHERE a.connection_id=c.connection_id
      AND a.endpoint='/item/get') AS health_at
  FROM core.source_connection c WHERE c.state IN ('inventoried','initial_sync','ok','retryable_error');
CREATE VIEW ops.sync_alert_candidates AS
  SELECT DISTINCT c.org_id,r.key AS kind,c.connection_id FROM core.source_connection c CROSS JOIN ops.alert_rule r
  WHERE c.state NOT IN ('removed','replaced') AND CASE r.key
    WHEN 'bank_update_stale' THEN now()-coalesce(c.last_successful_update,c.created_at)>r.threshold_interval
    WHEN 'inventory_stale' THEN now()-coalesce((SELECT max(p.created_at) FROM ops.publication p
      WHERE p.kind='inventory' AND p.payload->>'connection_id'=c.connection_id::text),c.created_at)>r.threshold_interval
    WHEN 'login_required' THEN c.state='login_required' AND now()-coalesce((SELECT max(e.at) FROM ops.connection_state_event e
      WHERE e.connection_id=c.connection_id AND e.to_state='login_required'),c.created_at)>r.threshold_interval
    WHEN 'poisoned_attempt' THEN EXISTS(SELECT 1 FROM ops.sync_attempt a WHERE a.connection_id=c.connection_id
      AND a.status IN ('poisoned','invalid','exhausted') AND now()-a.ended_at>=r.threshold_interval
      AND NOT EXISTS(SELECT 1 FROM ops.sync_attempt recovered WHERE recovered.connection_id=c.connection_id
        AND recovered.status='accepted' AND recovered.started_at>a.started_at))
    WHEN 'coverage_gap' THEN EXISTS(SELECT 1 FROM core.source_account s JOIN core.account_assignment aa USING(source_account_id)
      JOIN core.account a USING(account_id) JOIN ops.publication p ON p.id=s.first_seen_publication_id
      WHERE s.connection_id=c.connection_id AND upper_inf(aa.valid) AND a.status='placeholder'
        AND now()-p.created_at>r.threshold_interval)
    ELSE false END
;
GRANT SELECT ON ops.sync_acceptance,ops.sync_claim_context,ops.sync_schedule,ops.sync_alert_candidates TO ll_sync,ll_backup;

-- State is a consequence of attempt lifecycle, so the existing open/finish/accept
-- entrypoints remain the only runtime mutation paths. SQL acceptance and state
-- advancement commit atomically; raw/attempt fixtures on linked items stay legal.
CREATE FUNCTION ops.project_sync_attempt_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE c core.source_connection%ROWTYPE; target text;
BEGIN
  SELECT * INTO STRICT c FROM core.source_connection WHERE connection_id=NEW.connection_id FOR UPDATE;
  IF c.state NOT IN ('inventoried','initial_sync','ok','retryable_error') THEN RETURN NEW; END IF;
  IF c.state='inventoried' THEN
    UPDATE core.source_connection SET state='initial_sync' WHERE connection_id=c.connection_id;
    c.state:='initial_sync';
  END IF;
  target:=CASE NEW.status WHEN 'accepted' THEN 'ok' WHEN 'poisoned' THEN 'poisoned'
    WHEN 'failed' THEN CASE WHEN NEW.error='ITEM_LOGIN_REQUIRED' THEN 'login_required' ELSE 'retryable_error' END
    ELSE c.state END;
  IF target='poisoned' AND c.state='initial_sync' THEN
    UPDATE core.source_connection SET state='retryable_error',last_error_code=NEW.error,
      last_error_reason=NEW.error WHERE connection_id=c.connection_id;
  END IF;
  UPDATE core.source_connection SET state=target,
    last_error_code=CASE WHEN NEW.status='accepted' THEN NULL ELSE NEW.error END,
    last_error_reason=CASE WHEN NEW.status='accepted' THEN NULL ELSE NEW.error END
    WHERE connection_id=c.connection_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ops.project_sync_attempt_state() FROM PUBLIC;
CREATE TRIGGER project_sync_attempt_state AFTER INSERT OR UPDATE ON ops.sync_attempt
  FOR EACH ROW EXECUTE FUNCTION ops.project_sync_attempt_state();
-- INSERT ... RETURNING needs SELECT on only the generated identifier columns.
GRANT SELECT(id) ON raw.api_call,raw.sync_page TO ll_sync;
