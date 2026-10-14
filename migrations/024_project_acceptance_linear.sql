-- Capture approach (1): immediately before each transition, read only the
-- transactions resolved by its external_id and (for a pending claim) its
-- object_external_id, using the same org/connection alias scope as apply_transition.
-- Deduplicate transaction ids because both aliases can point at the same fact.
-- transaction_revision has no account_id/posted_date state to recover later.
-- Refresh this small snapshot for EVERY transition so intermediate moves retain
-- their own old/new coordinates. Existing alias UNIQUE and transaction PRIMARY
-- KEY indexes cover these reads; the index below covers revision discovery.
-- Resolve each alias separately and read each fact by its primary key: an IN
-- list plus a join can cache an org/connection prefix scan on small projections
-- and continue filtering every existing row as the batch grows. The alias's
-- composite foreign key guarantees that each resolved fact belongs to p_org.
-- Accumulate changes in an expanded PostgreSQL array, then convert once:
-- repeated concatenation of a growing jsonb array also copies the whole prefix.
-- Preserve transition/element order because invalidate_coordinates
-- chooses the first matching change for each certification and transaction.
-- CREATE OR REPLACE preserves the owner and existing function grants.

CREATE INDEX IF NOT EXISTS transaction_revision_publication_position
  ON core.transaction_revision (publication_id, position);

CREATE OR REPLACE FUNCTION core.project_acceptance(p_org uuid,p_connection uuid,p_pub bigint,p_transitions jsonb,p_balances jsonb,p_version int)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE t jsonb; pos int:=0; at_time timestamptz; before_rows jsonb;
  change_rows jsonb[]:='{}'; changes jsonb; new_changes jsonb; new_change jsonb;
  external_tid uuid; pending_tid uuid; touched_tid uuid; before_row jsonb;
BEGIN
  FOR t IN SELECT value FROM jsonb_array_elements(p_transitions) LOOP
    pos:=pos+1;
    SELECT a.transaction_id INTO external_tid FROM core.transaction_alias a
      WHERE a.org_id=p_org AND a.connection_id=p_connection AND a.external_id=t->>'external_id';
    pending_tid:=NULL;
    IF t->>'kind'='pending_claim' THEN
      SELECT a.transaction_id INTO pending_tid FROM core.transaction_alias a
        WHERE a.org_id=p_org AND a.connection_id=p_connection AND a.external_id=t->>'object_external_id';
    END IF;
    before_rows:='[]';
    FOR touched_tid IN SELECT DISTINCT id FROM unnest(ARRAY[external_tid,pending_tid]) touched(id)
      WHERE id IS NOT NULL LOOP
      SELECT jsonb_build_object('transaction_id',fact.transaction_id,
        'account_id',fact.account_id,'posted_date',fact.posted_date) INTO before_row
        FROM core.transaction fact WHERE fact.transaction_id=touched_tid;
      IF FOUND THEN before_rows:=before_rows||jsonb_build_array(before_row); END IF;
    END LOOP;
    SELECT page.received_at INTO STRICT at_time FROM raw.sync_page page JOIN raw.sync_acceptance ac ON page.id=ANY(ac.page_ids)
      WHERE ac.publication_id=p_pub AND page.api_call_id=(t->>'api_call_id')::bigint AND page.org_id=p_org;
    PERFORM core.apply_transition(p_org,p_connection,p_pub,pos,t,at_time,p_version);
    -- Save both coordinates for EVERY revision, including intermediate moves in
    -- a supplied array. Invalidation is deferred until balances have been written.
    SELECT coalesce(jsonb_agg(jsonb_build_object('transaction_id',fact.transaction_id,
      'old_account_id',old.b->'account_id','old_posted_date',old.b->'posted_date',
      'new_account_id',fact.account_id,'new_posted_date',fact.posted_date,'cause',r.cause)),'[]') INTO new_changes
    FROM core.transaction_revision r JOIN core.transaction fact USING(transaction_id)
    LEFT JOIN LATERAL (SELECT value AS b FROM jsonb_array_elements(before_rows)
      WHERE value->>'transaction_id'=fact.transaction_id::text) old ON true
    WHERE r.publication_id=p_pub AND r.position=pos;
    FOR new_change IN SELECT value FROM jsonb_array_elements(new_changes) LOOP
      change_rows:=array_append(change_rows,new_change);
    END LOOP;
  END LOOP;
  changes:=to_jsonb(change_rows);
  PERFORM core.project_balances(p_org,p_connection,p_pub,p_balances);
  PERFORM core.invalidate_coordinates(p_org,p_pub,changes);
END $$;
