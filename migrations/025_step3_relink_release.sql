-- Step 3: connection-scoped authority is a durable, interval-qualified input.
-- NULL external id identifies a connection grant; transaction decisions retain
-- their original stable event key. Multiple reviewed intervals are distinct inputs.
ALTER TABLE core.identity_decision ALTER COLUMN subject_external_id DROP NOT NULL;
ALTER TABLE core.identity_decision DROP COLUMN event_key;
ALTER TABLE core.identity_decision ADD COLUMN event_key text GENERATED ALWAYS AS (
  CASE WHEN subject_external_id IS NULL THEN
    kind||':'||subject_connection_id::text||':connection:'||publication_id::text||':'||position::text
  ELSE kind||':'||subject_connection_id::text||':'||subject_external_id||':'||coalesce(object_external_id,'') END
) STORED UNIQUE;
ALTER TABLE core.identity_decision ADD CONSTRAINT connection_decision_shape CHECK (
  subject_external_id IS NOT NULL OR
  (kind IN ('source_authority','reversal') AND interval IS NOT NULL AND NOT isempty(interval)
    AND transaction_id IS NULL AND decided_by NOT LIKE 'system:%')
);

CREATE OR REPLACE FUNCTION core.apply_transition(p_org uuid, p_connection uuid, p_publication bigint,
  p_position int, p_t jsonb, p_received_at timestamptz, p_projection_version int)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE al core.transaction_alias%ROWTYPE; pal core.transaction_alias%ROWTYPE;
  old core.transaction%ROWTYPE; d core.identity_decision%ROWTYPE;
  tid uuid; s uuid; a uuid; o jsonb := p_t->'obj'; k text := p_t->>'kind';
  ext text := p_t->>'external_id'; pend text := p_t->>'object_external_id';
  curr text; amount_value numeric; cause text; rev int; stamp timestamptz;
  rebuilding bool := coalesce(current_setting('ledgerline.rebuild',true),'')='on';
BEGIN
  SELECT created_at INTO STRICT stamp FROM ops.publication WHERE id=p_publication AND org_id=p_org;
  IF nullif(ext,'') IS NULL OR k IS NULL OR k NOT IN ('pending_claim','upsert','removed','quarantine') THEN RAISE EXCEPTION 'invalid transition'; END IF;
  IF NOT EXISTS(SELECT 1 FROM raw.api_call WHERE id=(p_t->>'api_call_id')::bigint AND org_id=p_org AND connection_id=p_connection)
    THEN RAISE EXCEPTION 'invalid transition observation'; END IF;
  -- Check relink authority before alias/lifecycle handling: a demoted alias
  -- following reversal must still be withheld as relink_overlap on later pages.
  IF k IN ('upsert','pending_claim') AND EXISTS(
    SELECT 1 FROM core.source_connection WHERE connection_id=p_connection AND relink_of IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM core.identity_decision grant_decision
      WHERE org_id=p_org AND kind='source_authority' AND subject_connection_id=p_connection
        AND decided_by NOT LIKE 'system:%' AND interval @> p_received_at AND publication_id<=p_publication
        AND (grant_decision.evidence->>'source_account_id' IS NULL OR EXISTS(
          SELECT 1 FROM core.source_account sa WHERE sa.org_id=p_org AND sa.connection_id=p_connection
            AND sa.external_account_id=o->>'account_id'
            AND sa.source_account_id=(grant_decision.evidence->>'source_account_id')::uuid))
        AND NOT EXISTS(SELECT 1 FROM core.identity_decision r
          WHERE r.reverses_id=grant_decision.id AND r.publication_id<=p_publication)) THEN
    PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,'relink_overlap'); RETURN;
  END IF;
  SELECT * INTO al FROM core.transaction_alias WHERE org_id=p_org AND connection_id=p_connection AND external_id=ext;
  IF k='quarantine' THEN
    IF p_t->>'quarantine_kind' IS NULL OR p_t->>'quarantine_kind' NOT IN ('competing_claim','duplicate_claim') THEN RAISE EXCEPTION 'invalid quarantine transition'; END IF;
    PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,p_t->>'quarantine_kind'); RETURN;
  END IF;
  IF k='removed' THEN
    IF al.transaction_id IS NULL THEN PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,'unknown_removed'); RETURN; END IF;
    UPDATE core.transaction_alias SET state='removed',last_seen_publication_id=p_publication WHERE connection_id=p_connection AND external_id=ext;
    IF NOT al.authoritative THEN RETURN; END IF;
    SELECT * INTO STRICT old FROM core.transaction WHERE transaction_id=al.transaction_id;
    UPDATE core.transaction SET status='removed',removed_at=stamp,revision=revision+1,revision_publication_id=p_publication
      WHERE transaction_id=al.transaction_id;
    tid:=al.transaction_id; cause:='removed'; rev:=old.revision+1;
  ELSE
    IF al.transaction_id IS NOT NULL AND NOT al.authoritative THEN
      PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,'unknown_modified'); RETURN;
    END IF;
    IF jsonb_typeof(o) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'missing transaction object'; END IF;
    amount_value:=(o->>'amount')::numeric;
    IF amount_value IS NULL THEN RAISE EXCEPTION 'missing amount'; END IF;
    IF amount_value <> trunc(amount_value,2) THEN
      PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,'invalid_precision'); RETURN;
    END IF;
    curr:=coalesce(o->>'iso_currency_code',o->>'unofficial_currency_code');
    tid:=al.transaction_id;
    IF k='pending_claim' THEN
      IF nullif(pend,'') IS NULL OR pend=ext THEN RAISE EXCEPTION 'invalid pending claim'; END IF;
      SELECT * INTO pal FROM core.transaction_alias WHERE org_id=p_org AND connection_id=p_connection AND external_id=pend;
      IF pal.transaction_id IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM core.transaction_alias WHERE transaction_id=pal.transaction_id AND authoritative
          AND (connection_id,external_id) NOT IN ((p_connection,pend),(p_connection,ext))) THEN
          PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,'duplicate_claim'); RETURN;
        END IF;
        IF tid IS NOT NULL AND tid<>pal.transaction_id THEN RAISE EXCEPTION 'claimant already allocated'; END IF;
        tid:=pal.transaction_id;
      END IF;
    END IF;
    IF tid IS NULL AND curr IS DISTINCT FROM 'USD' THEN
      PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,'currency'); RETURN;
    END IF;
    s:=core.ensure_account(p_org,p_connection,o->>'account_id',p_publication,p_received_at);
    SELECT account_id INTO a FROM core.account_assignment WHERE org_id=p_org AND source_account_id=s AND valid @> p_received_at;
    IF a IS NULL THEN RAISE EXCEPTION 'no assignment at observation time'; END IF;
    IF tid IS NULL THEN
      IF rebuilding THEN
        SELECT transaction_id INTO tid FROM core.identity_allocation
          WHERE org_id=p_org AND first_connection_id=p_connection AND first_external_id=ext;
        IF tid IS NULL THEN RAISE EXCEPTION 'REBUILD_MISSING_ALLOCATION'; END IF;
      ELSE
        INSERT INTO core.identity_allocation(org_id,allocated_publication_id,first_connection_id,first_external_id)
        VALUES(p_org,p_publication,p_connection,ext) RETURNING transaction_id INTO tid;
      END IF;
    END IF;
    SELECT * INTO old FROM core.transaction WHERE transaction_id=tid;
    rev:=coalesce(old.revision,0)+1;
    cause:=CASE WHEN old.transaction_id IS NULL THEN 'added' WHEN curr IS DISTINCT FROM 'USD' THEN 'currency_quarantine'
      WHEN old.status='quarantined' THEN 'currency_restored' WHEN k='pending_claim' THEN 'pending_claimed'
      WHEN old.status='removed' THEN 'reactivated' ELSE 'modified' END;
    INSERT INTO core.transaction(org_id,transaction_id,source_account_id,account_id,amount,currency,posted_date,
      authorized_date,datetime,pending,description_raw,original_description,merchant_name,merchant_entity_id,
      pfc_primary,pfc_detailed,pfc_confidence,pfc_version,payment_channel,check_number,counterparties,location,payment_meta,
      status,revision,revision_publication_id,authoritative_connection_id,authoritative_external_id)
    VALUES(p_org,tid,s,a,-amount_value,curr,(o->>'date')::date,(o->>'authorized_date')::date,(o->>'datetime')::timestamptz,
      CASE WHEN k='pending_claim' THEN false ELSE coalesce((o->>'pending')::bool,false) END,
      o->>'name',o->>'original_description',o->>'merchant_name',o->>'merchant_entity_id',
      o->'personal_finance_category'->>'primary',o->'personal_finance_category'->>'detailed',
      o->'personal_finance_category'->>'confidence_level',o->>'personal_finance_category_version',
      o->>'payment_channel',o->>'check_number',o->'counterparties',o->'location',o->'payment_meta',
      CASE WHEN curr='USD' THEN 'active' ELSE 'quarantined' END,rev,p_publication,p_connection,ext)
    ON CONFLICT(transaction_id) DO UPDATE SET source_account_id=excluded.source_account_id,account_id=excluded.account_id,
      amount=excluded.amount,currency=excluded.currency,posted_date=excluded.posted_date,authorized_date=excluded.authorized_date,
      datetime=excluded.datetime,pending=excluded.pending,description_raw=excluded.description_raw,
      original_description=excluded.original_description,merchant_name=excluded.merchant_name,merchant_entity_id=excluded.merchant_entity_id,
      pfc_primary=excluded.pfc_primary,pfc_detailed=excluded.pfc_detailed,pfc_confidence=excluded.pfc_confidence,pfc_version=excluded.pfc_version,
      payment_channel=excluded.payment_channel,check_number=excluded.check_number,counterparties=excluded.counterparties,
      location=excluded.location,payment_meta=excluded.payment_meta,status=excluded.status,removed_at=NULL,
      revision=excluded.revision,revision_publication_id=excluded.revision_publication_id,
      authoritative_connection_id=excluded.authoritative_connection_id,authoritative_external_id=excluded.authoritative_external_id;
    IF k='pending_claim' THEN
      UPDATE core.transaction_alias SET authoritative=false,state='superseded',last_seen_publication_id=p_publication
        WHERE connection_id=p_connection AND external_id=pend;
    END IF;
    INSERT INTO core.transaction_alias(org_id,connection_id,external_id,transaction_id,role,authoritative,state,
      first_seen_publication_id,last_seen_publication_id)
    VALUES(p_org,p_connection,ext,tid,CASE WHEN k='pending_claim' OR NOT coalesce((o->>'pending')::bool,false) THEN 'posted' ELSE 'pending' END,
      true,'active',p_publication,p_publication)
    ON CONFLICT(connection_id,external_id) DO UPDATE SET state='active',role=excluded.role,last_seen_publication_id=p_publication;
    IF k='pending_claim' THEN
      IF NOT rebuilding THEN
        INSERT INTO core.identity_decision(org_id,publication_id,position,kind,subject_connection_id,subject_external_id,
          object_connection_id,object_external_id,transaction_id,decided_by)
        VALUES(p_org,p_publication,p_position,'pending_claim',p_connection,ext,p_connection,pend,tid,'system:v1')
        ON CONFLICT (event_key) DO NOTHING;
      END IF;
      SELECT * INTO d FROM core.identity_decision WHERE event_key='pending_claim:'||p_connection||':'||ext||':'||pend;
      IF d.id IS NULL THEN RAISE EXCEPTION 'REBUILD_MISSING_DECISION'; END IF;
      IF (d.org_id,d.transaction_id,d.object_connection_id,d.decided_by) IS DISTINCT FROM (p_org,tid,p_connection,'system:v1'::text)
        THEN RAISE EXCEPTION 'IDENTITY_DECISION_MISMATCH'; END IF;
      INSERT INTO core.transaction_alias(org_id,connection_id,external_id,transaction_id,role,authoritative,state,
        first_seen_publication_id,last_seen_publication_id)
      VALUES(p_org,p_connection,pend,tid,'pending',false,'superseded',p_publication,p_publication)
      ON CONFLICT(connection_id,external_id) DO NOTHING;
    END IF;
  END IF;
  INSERT INTO core.transaction_revision(org_id,transaction_id,revision,publication_id,position,cause,source_api_call_id,
    source_connection_id,source_external_id,predecessor_revision,projection_version)
  VALUES(p_org,tid,rev,p_publication,p_position,cause,(p_t->>'api_call_id')::bigint,p_connection,ext,old.revision,p_projection_version);
END $$;

CREATE OR REPLACE FUNCTION core.project_identity(d core.identity_decision) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE subject core.transaction_alias%ROWTYPE; object_alias core.transaction_alias%ROWTYPE;
  prev core.identity_decision%ROWTYPE; item jsonb; restored core.transaction%ROWTYPE;
  stamp timestamptz; old_rows jsonb; old_revision int; tid uuid; q record; release_position int; transition jsonb;
BEGIN
  SELECT created_at INTO STRICT stamp FROM ops.publication WHERE id=d.publication_id;
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO old_rows FROM core.transaction x WHERE org_id=d.org_id;
  -- A connection grant has no transaction subject. Replay the same observations
  -- in the same order at the ruling's publication, using durable allocations.
  IF d.subject_external_id IS NULL THEN
    release_position:=greatest(d.position,coalesce((SELECT max(position) FROM core.transaction_revision
      WHERE publication_id=d.publication_id),0));
    IF d.kind='source_authority' THEN
      FOR q IN SELECT withheld.*,page.received_at,acceptance.projection_version
        FROM core.quarantine withheld JOIN raw.sync_page page USING(api_call_id)
        JOIN raw.sync_acceptance acceptance ON page.id=ANY(acceptance.page_ids)
        WHERE withheld.org_id=d.org_id AND withheld.connection_id=d.subject_connection_id
          AND withheld.kind='relink_overlap' AND withheld.resolved_by_decision_id IS NULL
          AND withheld.raised_publication_id<=d.publication_id AND d.interval @> page.received_at
          AND (d.evidence->>'source_account_id' IS NULL OR EXISTS(
            SELECT 1 FROM core.source_account sa WHERE sa.org_id=d.org_id
              AND sa.connection_id=d.subject_connection_id AND sa.external_account_id=withheld.payload->>'account_id'
              AND sa.source_account_id=(d.evidence->>'source_account_id')::uuid))
        ORDER BY page.received_at,withheld.api_call_id,withheld.external_id COLLATE "C",withheld.raised_publication_id
      LOOP
        -- Regrant after a connection reversal reactivates its own allocated fact.
        -- Do not promote an alias that a separate merge has attached elsewhere.
        UPDATE core.transaction_alias al SET authoritative=true,state='active'
          FROM core.transaction t,core.identity_allocation allocation
          WHERE al.connection_id=d.subject_connection_id AND al.external_id=q.external_id
            AND t.transaction_id=al.transaction_id AND t.status='removed'
            AND allocation.transaction_id=t.transaction_id
            AND allocation.first_connection_id=al.connection_id AND allocation.first_external_id=al.external_id
            AND NOT EXISTS(SELECT 1 FROM core.transaction_alias a WHERE a.transaction_id=t.transaction_id AND a.authoritative);
        transition:=jsonb_build_object('kind','upsert','external_id',q.external_id,'api_call_id',q.api_call_id,'obj',q.payload);
        release_position:=release_position+1;
        PERFORM core.apply_transition(d.org_id,d.subject_connection_id,d.publication_id,release_position,
          transition,q.received_at,q.projection_version);
        UPDATE core.quarantine SET resolved_by_decision_id=d.id WHERE id=q.id;
      END LOOP;
    ELSIF d.kind='reversal' THEN
      SELECT * INTO STRICT prev FROM core.identity_decision WHERE org_id=d.org_id AND id=d.reverses_id;
      -- Include both released observations and pages accepted directly under the
      -- grant. Keep immutable original quarantine evidence, and raise fresh rows.
      FOR q IN
        SELECT DISTINCT ON (observations.external_id COLLATE "C") observations.* FROM (
          SELECT withheld.external_id,withheld.api_call_id,withheld.payload,page.received_at
          FROM core.quarantine withheld JOIN raw.sync_page page USING(api_call_id)
          WHERE withheld.org_id=d.org_id AND withheld.resolved_by_decision_id=prev.id AND withheld.kind='relink_overlap'
          UNION ALL
          SELECT revision.source_external_id,revision.source_api_call_id,obj.value,page.received_at
          FROM core.transaction_revision revision JOIN raw.sync_page page ON page.api_call_id=revision.source_api_call_id
          JOIN raw.api_call api ON api.id=page.api_call_id
          JOIN LATERAL (
            SELECT item.value FROM jsonb_array_elements(
              coalesce(api.payload->'added','[]')||coalesce(api.payload->'modified','[]')) WITH ORDINALITY item(value,n)
            WHERE item.value->>'transaction_id'=revision.source_external_id ORDER BY item.n DESC LIMIT 1
          ) obj ON true
          WHERE revision.org_id=d.org_id AND revision.source_connection_id=prev.subject_connection_id
            AND revision.publication_id>=prev.publication_id AND revision.publication_id<d.publication_id
            AND prev.interval @> page.received_at
            AND (prev.evidence->>'source_account_id' IS NULL OR EXISTS(
              SELECT 1 FROM core.source_account sa WHERE sa.org_id=d.org_id
                AND sa.connection_id=prev.subject_connection_id AND sa.external_account_id=obj.value->>'account_id'
                AND sa.source_account_id=(prev.evidence->>'source_account_id')::uuid))
        ) observations ORDER BY observations.external_id COLLATE "C",observations.received_at DESC,observations.api_call_id DESC
      LOOP
        release_position:=release_position+1;
        -- Preserve both allocations after a reviewed merge, and withhold any
        -- currently authoritative fact reached through this connection's alias.
        WITH changed AS (
          UPDATE core.transaction t SET status='removed',removed_at=stamp,revision=revision+1,revision_publication_id=d.publication_id
          WHERE t.org_id=d.org_id AND (EXISTS(SELECT 1 FROM core.identity_allocation a
            WHERE a.transaction_id=t.transaction_id AND a.first_connection_id=d.subject_connection_id AND a.first_external_id=q.external_id)
            OR EXISTS(SELECT 1 FROM core.transaction_alias a WHERE a.transaction_id=t.transaction_id
              AND a.connection_id=d.subject_connection_id AND a.external_id=q.external_id AND a.authoritative))
          RETURNING t.*
        ) INSERT INTO core.transaction_revision(org_id,transaction_id,revision,publication_id,position,cause,
          source_api_call_id,source_connection_id,source_external_id,predecessor_revision,projection_version)
        SELECT d.org_id,transaction_id,revision,d.publication_id,release_position,'relink_merged',q.api_call_id,
          d.subject_connection_id,q.external_id,revision-1,1 FROM changed;
        UPDATE core.transaction_alias SET authoritative=false,last_seen_publication_id=d.publication_id
          WHERE connection_id=d.subject_connection_id AND external_id=q.external_id;
        PERFORM core.put_quarantine(d.org_id,d.subject_connection_id,d.publication_id,
          jsonb_build_object('kind','upsert','external_id',q.external_id,'api_call_id',q.api_call_id,'obj',q.payload),'relink_overlap');
      END LOOP;
    ELSE RAISE EXCEPTION 'unsupported connection identity decision'; END IF;
    PERFORM core.invalidate_changes(d.org_id,d.publication_id,old_rows,true);
    RETURN;
  END IF;
  SELECT * INTO subject FROM core.transaction_alias WHERE org_id=d.org_id AND connection_id=d.subject_connection_id AND external_id=d.subject_external_id;
  IF subject.transaction_id IS NULL THEN RAISE EXCEPTION 'unknown decision subject'; END IF;
  IF d.kind='reversal' THEN
    SELECT * INTO STRICT prev FROM core.identity_decision WHERE org_id=d.org_id AND id=d.reverses_id;
    UPDATE core.transaction_alias SET authoritative=false WHERE org_id=d.org_id AND transaction_id IN
      (SELECT (value->>'transaction_id')::uuid FROM jsonb_array_elements(prev.evidence->'aliases'));
    FOR item IN SELECT value FROM jsonb_array_elements(prev.evidence->'aliases') LOOP
      UPDATE core.transaction_alias SET transaction_id=(item->>'transaction_id')::uuid,
        authoritative=(item->>'authoritative')::bool,state=item->>'state',role=item->>'role',last_seen_publication_id=d.publication_id
        WHERE org_id=d.org_id AND connection_id=(item->>'connection_id')::uuid AND external_id=item->>'external_id';
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(prev.evidence->'facts') LOOP
      restored:=jsonb_populate_record(NULL::core.transaction,item);
      SELECT revision INTO STRICT old_revision FROM core.transaction WHERE transaction_id=restored.transaction_id;
      restored.revision:=old_revision+1; restored.revision_publication_id:=d.publication_id;
      UPDATE core.transaction SET
        (source_account_id,account_id,amount,currency,posted_date,authorized_date,datetime,pending,description_raw,
        original_description,merchant_name,merchant_entity_id,pfc_primary,pfc_detailed,pfc_confidence,pfc_version,
        payment_channel,check_number,counterparties,location,payment_meta,status,removed_at,revision,revision_publication_id,
        authoritative_connection_id,authoritative_external_id)=
        (restored.source_account_id,restored.account_id,restored.amount,restored.currency,restored.posted_date,
        restored.authorized_date,restored.datetime,restored.pending,restored.description_raw,restored.original_description,
        restored.merchant_name,restored.merchant_entity_id,restored.pfc_primary,restored.pfc_detailed,restored.pfc_confidence,
        restored.pfc_version,restored.payment_channel,restored.check_number,restored.counterparties,restored.location,
        restored.payment_meta,restored.status,restored.removed_at,restored.revision,restored.revision_publication_id,
        restored.authoritative_connection_id,restored.authoritative_external_id)
        WHERE transaction_id=restored.transaction_id;
      INSERT INTO core.transaction_revision(org_id,transaction_id,revision,publication_id,position,cause,
        source_connection_id,source_external_id,predecessor_revision,projection_version)
      VALUES(d.org_id,restored.transaction_id,restored.revision,d.publication_id,d.position,'relink_merged',
        d.subject_connection_id,d.subject_external_id,old_revision,1);
    END LOOP;
  ELSE
    tid:=subject.transaction_id;
    IF d.kind='relink_merge' THEN
      SELECT * INTO STRICT object_alias FROM core.transaction_alias WHERE org_id=d.org_id AND
        connection_id=d.object_connection_id AND external_id=d.object_external_id;
      -- The subject fact remains as removed evidence of its original allocation.
      UPDATE core.transaction_alias SET authoritative=false,last_seen_publication_id=d.publication_id
        WHERE transaction_id IN (subject.transaction_id,object_alias.transaction_id);
      UPDATE core.transaction_alias SET transaction_id=object_alias.transaction_id
        WHERE connection_id=d.subject_connection_id AND external_id=d.subject_external_id;
      WITH changed AS (UPDATE core.transaction SET status='removed',removed_at=stamp,revision=revision+1,revision_publication_id=d.publication_id
        WHERE transaction_id=subject.transaction_id RETURNING *)
      INSERT INTO core.transaction_revision(org_id,transaction_id,revision,publication_id,position,cause,source_connection_id,
        source_external_id,predecessor_revision,projection_version)
      SELECT d.org_id,transaction_id,revision,d.publication_id,d.position,'relink_merged',d.subject_connection_id,d.subject_external_id,revision-1,1 FROM changed;
      tid:=object_alias.transaction_id;
    ELSIF d.kind<>'source_authority' THEN RAISE EXCEPTION 'unsupported identity decision'; END IF;
    -- The partial unique index is immediate; demote first to avoid dependence on
    -- heap update order, then set the single authority predicate in one statement.
    UPDATE core.transaction_alias SET authoritative=false WHERE transaction_id=tid;
    -- A single UPDATE sets the authority predicate on every alias of the target.
    UPDATE core.transaction_alias SET authoritative=(connection_id=d.subject_connection_id AND external_id=d.subject_external_id),
      last_seen_publication_id=d.publication_id WHERE transaction_id=tid;
    WITH changed AS (UPDATE core.transaction SET authoritative_connection_id=d.subject_connection_id,
      authoritative_external_id=d.subject_external_id,revision=revision+1,revision_publication_id=d.publication_id
      WHERE transaction_id=tid RETURNING *)
    INSERT INTO core.transaction_revision(org_id,transaction_id,revision,publication_id,position,cause,source_connection_id,
      source_external_id,predecessor_revision,projection_version)
    SELECT d.org_id,transaction_id,revision,d.publication_id,d.position,'relink_merged',d.subject_connection_id,d.subject_external_id,revision-1,1 FROM changed;
  END IF;
  PERFORM core.invalidate_changes(d.org_id,d.publication_id,old_rows,true);
END $$;

CREATE OR REPLACE FUNCTION core.apply_ruling(p_kind text,p_subject uuid,p_after jsonb,p_reason text,p_ruled_by text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_org uuid; pub bigint; rows_json jsonb; item jsonb; k text; subject uuid; aft jsonb; bef jsonb; pos int:=0;
  d core.identity_decision%ROWTYPE; prev core.identity_decision%ROWTYPE;
  al core.transaction_alias%ROWTYPE; ob core.transaction_alias%ROWTYPE; evidence_json jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF p_kind IS NULL OR p_kind NOT IN ('assignment','entity','dimension','account_entity','reporting_scope','account_meta',
    'source_authority','relink_merge','reversal') OR p_subject IS NULL OR jsonb_typeof(p_after) IS DISTINCT FROM 'object'
    OR nullif(btrim(p_reason),'') IS NULL OR nullif(btrim(p_ruled_by),'') IS NULL
    THEN RAISE EXCEPTION 'invalid ruling input' USING ERRCODE='22023'; END IF;
  v_org:=(p_after->>'org_id')::uuid;
  -- The simple connection-level API can infer tenancy from its durable subject.
  IF v_org IS NULL AND p_kind='source_authority' AND NOT (p_after ? 'subject_external_id') THEN
    SELECT org_id INTO v_org FROM core.source_connection WHERE connection_id=p_subject;
  ELSIF v_org IS NULL AND p_kind='reversal' THEN
    SELECT org_id INTO v_org FROM core.identity_decision WHERE id=p_subject;
  END IF;
  IF v_org IS NULL OR NOT EXISTS(SELECT 1 FROM core.org WHERE org_id=v_org) THEN RAISE EXCEPTION 'unknown ruling org' USING ERRCODE='22023'; END IF;
  rows_json:=coalesce(p_after->'rulings',jsonb_build_array(jsonb_build_object('kind',p_kind,'subject_id',p_subject,'after',p_after)));
  IF jsonb_typeof(rows_json) IS DISTINCT FROM 'array' OR jsonb_array_length(rows_json)=0 THEN RAISE EXCEPTION 'empty ruling' USING ERRCODE='22023'; END IF;
  pub:=nextval('ops.publication_seq');
  INSERT INTO ops.publication(id,org_id,kind,actor,payload) VALUES(pub,v_org,'ruling',p_ruled_by,jsonb_build_object('reason',p_reason));
  FOR item IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
    pos:=pos+1; k:=item->>'kind'; subject:=(item->>'subject_id')::uuid; aft:=item->'after';
    IF k IS NULL OR k NOT IN ('assignment','entity','dimension','account_entity','reporting_scope','account_meta',
      'source_authority','relink_merge','reversal') OR subject IS NULL OR jsonb_typeof(aft) IS DISTINCT FROM 'object' OR
      (aft ? 'org_id' AND (aft->>'org_id')::uuid IS DISTINCT FROM v_org) THEN RAISE EXCEPTION 'invalid ruling projection input' USING ERRCODE='22023'; END IF;
    IF k IN ('source_authority','relink_merge','reversal') THEN
      IF p_ruled_by LIKE 'system:%' THEN RAISE EXCEPTION 'human decision requires a human actor' USING ERRCODE='22023'; END IF;
      d:=NULL; ob:=NULL; al:=NULL;
      IF k='reversal' THEN
        SELECT * INTO STRICT prev FROM core.identity_decision WHERE org_id=v_org AND id=subject AND decided_by NOT LIKE 'system:%' AND kind<>'reversal';
        IF EXISTS(SELECT 1 FROM core.identity_decision WHERE reverses_id=prev.id) THEN RAISE EXCEPTION 'decision already reversed'; END IF;
        IF prev.subject_external_id IS NOT NULL THEN
          SELECT * INTO STRICT al FROM core.transaction_alias WHERE connection_id=prev.subject_connection_id AND external_id=prev.subject_external_id;
        END IF;
        d.reverses_id:=prev.id;
      ELSIF k='source_authority' AND NOT (aft ? 'subject_external_id') THEN
        IF subject IS DISTINCT FROM (aft->>'subject_connection_id')::uuid OR NOT EXISTS(
          SELECT 1 FROM core.source_connection WHERE org_id=v_org AND connection_id=subject AND relink_of IS NOT NULL)
          OR (aft->>'interval')::tstzrange IS NULL OR isempty((aft->>'interval')::tstzrange) THEN
          RAISE EXCEPTION 'connection authority requires a relink connection and nonempty interval' USING ERRCODE='22023';
        END IF;
        IF aft->>'source_account_id' IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM core.source_account WHERE org_id=v_org AND connection_id=subject
            AND source_account_id=(aft->>'source_account_id')::uuid) THEN
          RAISE EXCEPTION 'authority account belongs to another connection' USING ERRCODE='22023';
        END IF;
      ELSE
        SELECT * INTO STRICT al FROM core.transaction_alias WHERE org_id=v_org
          AND connection_id=(aft->>'subject_connection_id')::uuid AND external_id=aft->>'subject_external_id';
      END IF;
      IF (k='source_authority' AND NOT (aft ? 'subject_external_id')) OR
        (k='reversal' AND prev.subject_external_id IS NULL) THEN
        INSERT INTO core.identity_decision(org_id,publication_id,position,kind,subject_connection_id,subject_external_id,
          interval,evidence,decided_by,reverses_id)
        VALUES(v_org,pub,pos,k,CASE WHEN k='reversal' THEN prev.subject_connection_id ELSE subject END,NULL,
          CASE WHEN k='reversal' THEN prev.interval ELSE (aft->>'interval')::tstzrange END,
          jsonb_build_object('reason',p_reason,'source_account_id',
            CASE WHEN k='reversal' THEN prev.evidence->>'source_account_id' ELSE aft->>'source_account_id' END),
          p_ruled_by,d.reverses_id) RETURNING * INTO d;
        PERFORM core.project_identity(d);
        pos:=greatest(pos,coalesce((SELECT max(position) FROM core.transaction_revision WHERE publication_id=pub),0));
        CONTINUE;
      END IF;
      IF k='relink_merge' THEN
        SELECT * INTO STRICT ob FROM core.transaction_alias WHERE org_id=v_org
          AND connection_id=(aft->>'object_connection_id')::uuid AND external_id=aft->>'object_external_id';
        IF al.transaction_id=ob.transaction_id OR al.connection_id=ob.connection_id OR EXISTS(
          SELECT 1 FROM core.identity_decision x WHERE org_id=v_org AND kind='relink_merge'
          AND (x.transaction_id IN (al.transaction_id,ob.transaction_id)
            OR (x.subject_connection_id,x.subject_external_id) IN ((al.connection_id,al.external_id),(ob.connection_id,ob.external_id))
            OR (x.object_connection_id,x.object_external_id) IN ((al.connection_id,al.external_id),(ob.connection_id,ob.external_id)))
          AND NOT EXISTS(SELECT 1 FROM core.identity_decision r WHERE r.reverses_id=x.id)) THEN RAISE EXCEPTION 'relink merge is not one-to-one'; END IF;
      END IF;
      SELECT jsonb_build_object('aliases',(SELECT jsonb_agg(to_jsonb(x)) FROM core.transaction_alias x
        WHERE transaction_id IN (al.transaction_id,ob.transaction_id)),
        'facts',(SELECT jsonb_agg(to_jsonb(x)) FROM core.transaction x WHERE transaction_id IN (al.transaction_id,ob.transaction_id)),
        'reason',p_reason) INTO evidence_json;
      INSERT INTO core.identity_decision(org_id,publication_id,position,kind,subject_connection_id,subject_external_id,
        object_connection_id,object_external_id,transaction_id,interval,evidence,decided_by,reverses_id)
      VALUES(v_org,pub,pos,k,al.connection_id,al.external_id,ob.connection_id,
        CASE WHEN k='reversal' THEN subject::text ELSE ob.external_id END,coalesce(ob.transaction_id,al.transaction_id),
        (aft->>'interval')::tstzrange,evidence_json,p_ruled_by,d.reverses_id) RETURNING * INTO d;
      PERFORM core.project_identity(d);
    ELSE
      -- Preserve the exact metadata of an existing ruled target as input too.
      IF k='assignment' THEN
        SELECT to_jsonb(x) INTO bef FROM core.account x WHERE org_id=v_org AND account_id=(aft->>'account_id')::uuid;
        IF bef IS NOT NULL THEN aft:=aft||jsonb_build_object('account',bef||coalesce(aft->'account','{}')); END IF;
      END IF;
      bef:=NULL;
      CASE k
        WHEN 'entity' THEN SELECT to_jsonb(x) INTO bef FROM core.entity x WHERE org_id=v_org AND entity_id=subject;
        WHEN 'dimension' THEN SELECT to_jsonb(x) INTO bef FROM core.dimension x WHERE org_id=v_org AND dimension_id=subject;
        WHEN 'assignment' THEN SELECT to_jsonb(x) INTO bef FROM core.account_assignment x WHERE org_id=v_org AND source_account_id=subject AND upper_inf(valid);
        WHEN 'account_entity' THEN SELECT to_jsonb(x) INTO bef FROM core.account_entity x WHERE org_id=v_org AND account_id=subject AND upper_inf(valid);
        WHEN 'reporting_scope' THEN SELECT to_jsonb(x) INTO bef FROM core.account_reporting_scope x WHERE org_id=v_org AND account_id=subject AND upper_inf(valid);
        ELSE NULL;
      END CASE;
      INSERT INTO core.ruling_event(org_id,publication_id,position,kind,subject_id,before,after,reason,ruled_by)
      VALUES(v_org,pub,pos,k,subject,bef,aft,p_reason,p_ruled_by);
      PERFORM core.project_ruling(v_org,pub,pos,k,subject,aft,p_reason,p_ruled_by);
    END IF;
  END LOOP;
  RETURN pub;
END $$;

-- Human review index only: serving and identity projection never consult it.
-- Sign follows core.transaction; day_delta is new date minus candidate date.
CREATE VIEW serve.v_relink_candidates AS
SELECT q.id AS quarantine_id,q.connection_id AS new_connection_id,q.external_id AS new_external_id,
  -(q.payload->>'amount')::numeric AS new_amount,(q.payload->>'date')::date AS new_posted_date,
  q.payload->>'name' AS new_description,candidate.transaction_id AS candidate_transaction_id,
  candidate.external_id AS candidate_external_id,candidate.posted_date AS candidate_posted_date,
  candidate.description_raw AS candidate_description,
  (q.payload->>'date')::date-candidate.posted_date AS day_delta,
  count(candidate.transaction_id) OVER (PARTITION BY q.id) AS candidate_count
FROM core.quarantine q JOIN core.source_connection connection USING(org_id,connection_id)
LEFT JOIN LATERAL (
  SELECT t.transaction_id,alias.external_id,t.posted_date,t.description_raw
  FROM core.transaction t JOIN core.transaction_alias alias USING(org_id,transaction_id)
  WHERE t.org_id=q.org_id AND alias.connection_id=connection.relink_of
    AND alias.authoritative AND t.status='active'
    AND t.amount=-(q.payload->>'amount')::numeric
    AND t.posted_date BETWEEN (q.payload->>'date')::date-3 AND (q.payload->>'date')::date+3
) candidate ON true
WHERE q.kind='relink_overlap' AND q.resolved_by_decision_id IS NULL;
GRANT SELECT ON serve.v_relink_candidates TO ll_reader,ll_verify;
REVOKE ALL ON FUNCTION core.apply_transition(uuid,uuid,bigint,int,jsonb,timestamptz,int),
  core.project_identity(core.identity_decision),core.apply_ruling(text,uuid,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.apply_ruling(text,uuid,jsonb,text,text) TO ll_verify;
