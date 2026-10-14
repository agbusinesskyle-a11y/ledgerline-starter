-- All helpers are owner-only. Projection row ids are stable functions of their
-- publication and natural key, so replay reproduces every non-clock column.
CREATE FUNCTION core.projection_id(p_key text) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, core, raw, verify, ops
AS $$ SELECT md5('ledgerline:v1:' || p_key)::uuid $$;

CREATE FUNCTION core.ensure_account(p_org uuid, p_connection uuid, p_external text,
  p_publication bigint, p_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE s uuid; a uuid; rebuilding bool := coalesce(current_setting('ledgerline.rebuild',true),'') = 'on';
BEGIN
  IF nullif(p_external,'') IS NULL THEN RAISE EXCEPTION 'missing account_id'; END IF;
  SELECT source_account_id INTO s FROM core.source_account
    WHERE org_id=p_org AND connection_id=p_connection AND external_account_id=p_external;
  IF s IS NULL THEN
    IF rebuilding THEN RAISE EXCEPTION 'REBUILD_MISSING_ACCOUNT_ALLOCATION'; END IF;
    INSERT INTO core.source_account(org_id,connection_id,external_account_id,capability,first_seen_publication_id,last_seen_at)
    VALUES(p_org,p_connection,p_external,'unknown',p_publication,p_at) RETURNING source_account_id INTO s;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM core.account_assignment WHERE source_account_id=s) THEN
    IF rebuilding THEN
      SELECT account_id INTO a FROM core.account_allocation WHERE org_id=p_org AND source_account_id=s AND origin='placeholder'
        ORDER BY allocated_publication_id LIMIT 1;
      IF a IS NULL THEN RAISE EXCEPTION 'REBUILD_MISSING_ACCOUNT_ALLOCATION'; END IF;
    ELSE
      INSERT INTO core.account_allocation(org_id,allocated_publication_id,origin,source_account_id)
      VALUES(p_org,p_publication,'placeholder',s) RETURNING account_id INTO a;
    END IF;
    INSERT INTO core.account(org_id,account_id,display_name,institution_name,kind,balance_orientation,
      verification_method,currency,status,history_state,coverage_gap)
    SELECT p_org,a,NULL,c.institution_name,'other','asset',
      'unverified','USD','placeholder','unknown','awaiting assignment'
    FROM core.source_account sa JOIN core.source_connection c USING(org_id,connection_id) WHERE sa.source_account_id=s;
    INSERT INTO core.account_assignment(org_id,id,source_account_id,account_id,valid,reason,ruled_by,publication_id)
    VALUES(p_org,core.projection_id('assignment:'||p_publication||':'||s),s,a,tstzrange(p_at,NULL,'[)'),
      'placeholder',(SELECT actor FROM ops.publication WHERE id=p_publication),p_publication);
    IF NOT rebuilding THEN PERFORM ops.raise_alert(p_org,'new_account','new_account:'||s,s::text,NULL); END IF;
  END IF;
  RETURN s;
END $$;

CREATE FUNCTION core.put_quarantine(p_org uuid,p_connection uuid,p_publication bigint,p_t jsonb,p_kind text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  INSERT INTO core.quarantine(org_id,id,kind,connection_id,external_id,api_call_id,raised_publication_id,payload)
  VALUES(p_org,core.projection_id('quarantine:'||p_publication||':'||p_connection||':'||(p_t->>'external_id')||':'||p_kind),
    p_kind,p_connection,p_t->>'external_id',(p_t->>'api_call_id')::bigint,p_publication,p_t->'obj')
  ON CONFLICT(kind,connection_id,external_id,raised_publication_id) DO NOTHING;
  IF coalesce(current_setting('ledgerline.rebuild',true),'') <> 'on' AND p_kind IN ('unknown_modified','competing_claim') THEN
    PERFORM ops.raise_alert(p_org,p_kind,p_kind||':'||p_connection||':'||(p_t->>'external_id'),p_t->>'external_id',p_t->'obj');
  END IF;
END $$;

CREATE FUNCTION core.apply_transition(p_org uuid, p_connection uuid, p_publication bigint,
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
    -- Relink overlap remains withheld until a reviewed interval grants authority.
    IF EXISTS(SELECT 1 FROM core.source_connection WHERE connection_id=p_connection AND relink_of IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM core.identity_decision WHERE org_id=p_org AND kind='source_authority'
        AND subject_connection_id=p_connection AND decided_by NOT LIKE 'system:%' AND interval @> p_received_at
        AND publication_id<=p_publication AND NOT EXISTS(SELECT 1 FROM core.identity_decision r
          WHERE r.reverses_id=core.identity_decision.id AND r.publication_id<=p_publication)) THEN
      PERFORM core.put_quarantine(p_org,p_connection,p_publication,p_t,'relink_overlap'); RETURN;
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

-- Porting contract for Step 2b: use these exact keys (no cause/connection keys).
CREATE FUNCTION core.reduce_pages(page_ids bigint[]) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE page record; o jsonb; ext text; f jsonb:='{}'; t jsonb; p text;
  claims jsonb:='[]'; upserts jsonb:='[]'; removals jsonb:='[]'; quarantines jsonb:='[]';
  claimed text[]:='{}'; count_claims int; connection uuid;
BEGIN
  -- 1. Fold added, modified, removed in that order within each page, pages in
  -- caller order. Last observation for an external id wins, including re-adds.
  FOR page IN SELECT a.payload,a.id,a.connection_id FROM unnest(page_ids) WITH ORDINALITY x(id,n)
    JOIN raw.sync_page s ON s.id=x.id JOIN raw.api_call a ON a.id=s.api_call_id ORDER BY x.n LOOP
    connection:=page.connection_id;
    FOR o IN SELECT value FROM jsonb_array_elements(coalesce(page.payload->'added','[]')||coalesce(page.payload->'modified','[]')) LOOP
      ext:=o->>'transaction_id';
      f:=f||jsonb_build_object(ext,jsonb_build_object('kind','upsert','external_id',ext,'api_call_id',page.id,'obj',o));
    END LOOP;
    FOR o IN SELECT value FROM jsonb_array_elements(coalesce(page.payload->'removed','[]')) LOOP
      ext:=o->>'transaction_id';
      f:=f||jsonb_build_object(ext,jsonb_build_object('kind','removed','external_id',ext,'api_call_id',page.id));
    END LOOP;
  END LOOP;
  -- 2. Group the surviving full objects by pending_transaction_id.
  -- 3. Resolve in C/binary external-id order: all competing claimants quarantine;
  -- an already-promoted P may only be claimed again by its authoritative Q.
  FOR ext,t IN SELECT key,value FROM jsonb_each(f) ORDER BY key COLLATE "C" LOOP
    p:=nullif(t->'obj'->>'pending_transaction_id','');
    IF t->>'kind'='upsert' AND p IS NOT NULL THEN
      SELECT count(*) INTO count_claims FROM jsonb_each(f) WHERE value->>'kind'='upsert' AND value->'obj'->>'pending_transaction_id'=p;
      IF count_claims>1 THEN
        quarantines:=quarantines||jsonb_build_array((t-'kind')||jsonb_build_object('kind','quarantine','quarantine_kind','competing_claim'));
      ELSIF EXISTS(SELECT 1 FROM core.transaction_alias pa JOIN core.transaction_alias qa USING(transaction_id)
        WHERE pa.connection_id=connection AND pa.external_id=p AND qa.authoritative
          AND (qa.connection_id,qa.external_id) NOT IN ((connection,p),(connection,ext))) THEN
        quarantines:=quarantines||jsonb_build_array((t-'kind')||jsonb_build_object('kind','quarantine','quarantine_kind','duplicate_claim'));
      ELSE
        claims:=claims||jsonb_build_array((t-'kind')||jsonb_build_object('kind','pending_claim','object_external_id',p));
        claimed:=array_append(claimed,p);
      END IF;
    ELSIF t->>'kind'='upsert' THEN upserts:=upserts||jsonb_build_array(t);
    END IF;
  END LOOP;
  -- 4. Emit sorted claims, ordinary upserts, removals minus promoted P, then
  -- quarantines. A competing claim does not suppress P's independent lifecycle.
  FOR ext,t IN SELECT key,value FROM jsonb_each(f) ORDER BY key COLLATE "C" LOOP
    IF t->>'kind'='removed' AND NOT ext=ANY(claimed) THEN removals:=removals||jsonb_build_array(t); END IF;
  END LOOP;
  RETURN claims||upserts||removals||quarantines;
END $$;

CREATE FUNCTION core.invalidate_changes(p_org uuid,p_pub bigint,p_before jsonb,p_ruling bool DEFAULT false)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF coalesce(current_setting('ledgerline.rebuild',true),'')='on' THEN RETURN; END IF;
  INSERT INTO verify.invalidation(org_id,id,certification_id,cause,publication_id,old_account_id,old_posted_date,new_account_id,new_posted_date,detected_at)
  SELECT DISTINCT p_org,core.projection_id('invalidation:'||p_pub||':'||c.id||':'||t.transaction_id),c.id,
    CASE WHEN r.cause IN ('currency_quarantine','currency_restored') THEN 'currency'
      WHEN r.cause='reassigned' THEN 'reassigned' WHEN p_ruling THEN 'ruling' ELSE 'fact_revision' END,
    p_pub,(b->>'account_id')::uuid,(b->>'posted_date')::date,t.account_id,t.posted_date,p.created_at
  FROM core.transaction t JOIN LATERAL (SELECT * FROM core.transaction_revision rr
    WHERE rr.transaction_id=t.transaction_id AND rr.publication_id=p_pub ORDER BY revision DESC LIMIT 1) r ON true
  JOIN ops.publication p ON p.id=p_pub
  LEFT JOIN LATERAL (SELECT value AS b FROM jsonb_array_elements(p_before) WHERE value->>'transaction_id'=t.transaction_id::text) old ON true
  JOIN verify.certification c ON c.org_id=p_org AND
    ((c.account_id=t.account_id AND c.period @> t.posted_date) OR
     (c.account_id=(b->>'account_id')::uuid AND c.period @> (b->>'posted_date')::date))
  WHERE t.org_id=p_org AND r.publication_id=p_pub AND NOT EXISTS(
    SELECT 1 FROM verify.invalidation i WHERE i.certification_id=c.id AND i.superseding_certification_id IS NULL);
END $$;

CREATE FUNCTION core.project_balances(p_org uuid,p_connection uuid,p_pub bigint,p_balances jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE b jsonb; s uuid; a uuid; at_time timestamptz; stamp timestamptz;
BEGIN
  SELECT created_at INTO stamp FROM ops.publication WHERE id=p_pub;
  FOR b IN SELECT value FROM jsonb_array_elements(p_balances) LOOP
    SELECT page.received_at INTO STRICT at_time FROM raw.sync_page page JOIN raw.sync_acceptance ac ON page.id=ANY(ac.page_ids)
      JOIN raw.api_call api ON api.id=page.api_call_id
      WHERE ac.publication_id=p_pub AND api.org_id=p_org AND api.connection_id=p_connection AND api.id=(b->>'api_call_id')::bigint;
    s:=core.ensure_account(p_org,p_connection,b->>'external_account_id',p_pub,at_time);
    SELECT account_id INTO STRICT a FROM core.account_assignment WHERE source_account_id=s AND valid @> at_time;
    INSERT INTO core.balance_observation(org_id,id,source_account_id,account_id,publication_id,observed_at,provider_as_of,
      current,available,limit_amount,currency,source,api_call_id)
    VALUES(p_org,core.projection_id('balance:'||p_pub||':'||s||':sync_page'),s,a,p_pub,stamp,(b->>'provider_as_of')::timestamptz,
      (b->>'current')::numeric,(b->>'available')::numeric,(b->>'limit')::numeric,b->>'iso_currency_code','sync_page',(b->>'api_call_id')::bigint)
    ON CONFLICT(source_account_id,publication_id,source) DO UPDATE SET current=excluded.current,available=excluded.available,
      limit_amount=excluded.limit_amount,currency=excluded.currency,api_call_id=excluded.api_call_id,provider_as_of=excluded.provider_as_of;
  END LOOP;
END $$;

CREATE FUNCTION core.balances_from_pages(p_ids bigint[]) RETURNS jsonb
LANGUAGE sql SET search_path = pg_catalog, core, raw, verify, ops AS $$
  SELECT coalesce(jsonb_agg(b ORDER BY n,ordinal),'[]') FROM (
    SELECT n,ordinal,jsonb_build_object('external_account_id',o->>'account_id','current',o->'balances'->'current',
      'available',o->'balances'->'available','limit',o->'balances'->'limit','iso_currency_code',o->'balances'->'iso_currency_code',
      'api_call_id',a.id,'provider_as_of',o->'balances'->'last_updated_datetime') b
    FROM unnest(p_ids) WITH ORDINALITY x(id,n) JOIN raw.sync_page s ON s.id=x.id JOIN raw.api_call a ON a.id=s.api_call_id,
      jsonb_array_elements(coalesce(a.payload->'accounts','[]')) WITH ORDINALITY items(o,ordinal)
  ) rows
$$;

CREATE FUNCTION core.project_acceptance(p_org uuid,p_connection uuid,p_pub bigint,p_transitions jsonb,p_balances jsonb,p_version int)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE t jsonb; pos int:=0; at_time timestamptz; before_rows jsonb; changes jsonb:='[]'; new_changes jsonb;
BEGIN
  FOR t IN SELECT value FROM jsonb_array_elements(p_transitions) LOOP
    pos:=pos+1;
    SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO before_rows FROM core.transaction x WHERE org_id=p_org;
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
    changes:=changes||new_changes;
  END LOOP;
  PERFORM core.project_balances(p_org,p_connection,p_pub,p_balances);
  PERFORM core.invalidate_coordinates(p_org,p_pub,changes);
END $$;

CREATE OR REPLACE FUNCTION core.accept_publication(p_attempt_id bigint, p_page_ids bigint[], p_cursor_out text,
  p_transitions jsonb, p_balances jsonb, p_projection_version int,
  p_dry_run_publication_only boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE a ops.sync_attempt%ROWTYPE; c core.source_connection%ROWTYPE; v_pub bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF p_attempt_id IS NULL THEN RAISE EXCEPTION 'invalid acceptance input' USING ERRCODE='22023'; END IF;
  SELECT * INTO a FROM ops.sync_attempt WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown attempt' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM core.source_connection WHERE org_id=a.org_id AND connection_id=a.connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown connection'; END IF;
  SELECT publication_id INTO v_pub FROM raw.sync_acceptance WHERE attempt_id=p_attempt_id;
  IF FOUND THEN RETURN v_pub; END IF;
  IF cardinality(p_page_ids) IS NULL OR cardinality(p_page_ids) = 0 OR
    nullif(btrim(p_cursor_out), '') IS NULL OR p_projection_version IS NULL OR p_projection_version <= 0 OR
    jsonb_typeof(p_transitions) IS DISTINCT FROM 'array' OR jsonb_typeof(p_balances) IS DISTINCT FROM 'array' OR
    p_dry_run_publication_only IS NULL THEN
    RAISE EXCEPTION 'invalid acceptance input' USING ERRCODE = '22023';
  END IF;
  IF a.status NOT IN ('fetching','validating','accepting') THEN
    RAISE EXCEPTION 'attempt is not acceptable' USING ERRCODE = '22023';
  END IF;
  IF c.cursor IS DISTINCT FROM a.cursor_in OR c.last_publication_id IS DISTINCT FROM a.predecessor_publication_id THEN
    RAISE EXCEPTION 'stale attempt cursor or predecessor' USING ERRCODE = '23514';
  END IF;
  v_pub := nextval('ops.publication_seq');
  INSERT INTO ops.publication (id, org_id, kind, actor, payload)
  VALUES (v_pub, a.org_id, 'acceptance', session_user, jsonb_build_object('attempt_id', p_attempt_id, 'balances', p_balances));
  -- Test-only escape hatch for the Step 0 publication ordering gate; no acceptance or facts are written.
  IF p_dry_run_publication_only THEN RETURN v_pub; END IF;
  INSERT INTO raw.sync_acceptance (org_id, publication_id, connection_id, attempt_id,
    predecessor_publication_id, cursor_in, cursor_out, page_ids, projection_version)
  VALUES (a.org_id, v_pub, a.connection_id, a.id, a.predecessor_publication_id,
    a.cursor_in, p_cursor_out, p_page_ids, p_projection_version);
  -- Validate the terminal cursor chain in addition to the page membership trigger.
  IF EXISTS (
    SELECT 1 FROM unnest(p_page_ids) WITH ORDINALITY requested(id, n)
    JOIN raw.sync_page p ON p.id = requested.id
    JOIN raw.api_call r ON r.id = p.api_call_id AND r.org_id = p.org_id
    LEFT JOIN raw.sync_page prev ON prev.id = p_page_ids[requested.n::int - 1]
    WHERE r.connection_id IS DISTINCT FROM a.connection_id OR r.http_status IS DISTINCT FROM 200 OR r.error_code IS NOT NULL OR
      (requested.n = 1 AND p.cursor_in IS DISTINCT FROM a.cursor_in) OR
      (requested.n > 1 AND p.cursor_in IS DISTINCT FROM prev.cursor_out) OR
      p.has_more IS DISTINCT FROM (requested.n < cardinality(p_page_ids)) OR
      (requested.n = cardinality(p_page_ids) AND p.cursor_out IS DISTINCT FROM p_cursor_out)
  ) THEN RAISE EXCEPTION 'invalid acceptance cursor chain' USING ERRCODE = '23514'; END IF;
  PERFORM core.project_acceptance(a.org_id,a.connection_id,v_pub,p_transitions,p_balances,p_projection_version);
  UPDATE core.source_connection SET cursor=p_cursor_out,cursor_updated_at=(SELECT created_at FROM ops.publication WHERE id=v_pub),
    last_publication_id=v_pub,transactions_update_status=(SELECT r.payload->>'transactions_update_status'
      FROM raw.sync_page p JOIN raw.api_call r ON r.id=p.api_call_id WHERE p.id=p_page_ids[cardinality(p_page_ids)])
    WHERE org_id=a.org_id AND connection_id=a.connection_id AND cursor IS NOT DISTINCT FROM a.cursor_in
      AND last_publication_id IS NOT DISTINCT FROM a.predecessor_publication_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'acceptance connection CAS must affect exactly one row'; END IF;
  UPDATE ops.sync_attempt SET status='accepted',publication_id=v_pub,ended_at=(SELECT created_at FROM ops.publication WHERE id=v_pub)
    WHERE id=p_attempt_id;
  RETURN v_pub;
END;
$$;


CREATE FUNCTION core.project_ruling(v_org uuid,v_pub bigint,v_position int,v_kind text,v_subject uuid,
  v_after jsonb,p_reason text,p_ruled_by text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_before jsonb; stamp timestamptz; date_start date; date_end date; aid uuid;
  old_rows jsonb; target jsonb; target_account core.account%ROWTYPE; rebuilding bool:=coalesce(current_setting('ledgerline.rebuild',true),'')='on';
BEGIN
  SELECT created_at INTO STRICT stamp FROM ops.publication WHERE id=v_pub;
  IF v_kind IN ('entity','dimension') AND (nullif(v_after->>'slug','') IS NULL OR nullif(v_after->>'display_name','') IS NULL)
    THEN RAISE EXCEPTION 'invalid ruling projection input' USING ERRCODE='22023'; END IF;
    IF v_kind = 'entity' THEN
      SELECT to_jsonb(e) INTO v_before FROM core.entity e WHERE org_id = v_org AND entity_id = v_subject;
      INSERT INTO core.entity (org_id, entity_id, slug, display_name, legal_name, legal_form,
        tax_classification, parent_entity_id, has_books, active)
      VALUES (v_org, v_subject, v_after->>'slug', v_after->>'display_name', v_after->>'legal_name',
        v_after->>'legal_form', v_after->>'tax_classification', (v_after->>'parent_entity_id')::uuid,
        coalesce((v_after->>'has_books')::bool, true), coalesce((v_after->>'active')::bool, true))
      ON CONFLICT (entity_id) DO UPDATE SET slug = EXCLUDED.slug, display_name = EXCLUDED.display_name,
        legal_name = EXCLUDED.legal_name, legal_form = EXCLUDED.legal_form,
        tax_classification = EXCLUDED.tax_classification, parent_entity_id = EXCLUDED.parent_entity_id,
        has_books = EXCLUDED.has_books, active = EXCLUDED.active WHERE core.entity.org_id = v_org;
      IF NOT FOUND THEN RAISE EXCEPTION 'cross-org ruling subject' USING ERRCODE = '23503'; END IF;
    ELSIF v_kind = 'dimension' THEN
      SELECT to_jsonb(d) INTO v_before FROM core.dimension d WHERE org_id = v_org AND dimension_id = v_subject;
      INSERT INTO core.dimension (org_id, dimension_id, entity_id, slug, display_name)
      VALUES (v_org, v_subject, (v_after->>'entity_id')::uuid, v_after->>'slug', v_after->>'display_name')
      ON CONFLICT (dimension_id) DO UPDATE SET entity_id = EXCLUDED.entity_id, slug = EXCLUDED.slug,
        display_name = EXCLUDED.display_name WHERE core.dimension.org_id = v_org;
      IF NOT FOUND THEN RAISE EXCEPTION 'cross-org ruling subject' USING ERRCODE = '23503'; END IF;

    ELSIF v_kind='assignment' THEN
      IF NOT EXISTS(SELECT 1 FROM core.source_account WHERE org_id=v_org AND source_account_id=v_subject) THEN
        RAISE EXCEPTION 'unknown assignment subject' USING ERRCODE='23503'; END IF;
      aid:=(v_after->>'account_id')::uuid;
      IF aid IS NULL THEN RAISE EXCEPTION 'missing assignment target'; END IF;
      target:=coalesce(v_after->'account','{}');
      IF NOT EXISTS(SELECT 1 FROM core.account WHERE org_id=v_org AND account_id=aid) THEN
        IF rebuilding THEN
          IF NOT EXISTS(SELECT 1 FROM core.account_allocation WHERE org_id=v_org AND account_id=aid) THEN
            RAISE EXCEPTION 'REBUILD_MISSING_ACCOUNT_ALLOCATION'; END IF;
        ELSE
          IF NOT EXISTS(SELECT 1 FROM core.account_allocation WHERE org_id=v_org AND account_id=aid) THEN
            INSERT INTO core.account_allocation(org_id,account_id,allocated_publication_id,origin)
            VALUES(v_org,aid,v_pub,'ruled');
          END IF;
        END IF;
        INSERT INTO core.account(org_id,account_id,display_name,kind,balance_orientation,verification_method,currency,status,history_state)
        VALUES(v_org,aid,coalesce(target->>'display_name','Ruled account'),coalesce(target->>'kind','checking'),
          coalesce(target->>'balance_orientation','asset'),coalesce(target->>'verification_method','cash_statement'),
          coalesce(target->>'currency','USD'),coalesce(target->>'status','active'),coalesce(target->>'history_state','unknown'));
      END IF;
      -- The ruling carries the target metadata as well as the assignment. This
      -- makes owner-seeded ruled accounts reconstructible without an extra input
      -- table, and captures every optional account column rather than defaults.
      SELECT * INTO STRICT target_account FROM core.account WHERE org_id=v_org AND account_id=aid;
      target_account:=jsonb_populate_record(target_account,target);
      UPDATE core.account SET (display_name,institution_name,mask,kind,balance_orientation,verification_method,currency,
        status,missing_since,closed_at,closed_evidence,required_start_date,observed_start_date,history_state,coverage_gap)=
        (target_account.display_name,target_account.institution_name,target_account.mask,target_account.kind,
        target_account.balance_orientation,target_account.verification_method,target_account.currency,target_account.status,
        target_account.missing_since,target_account.closed_at,target_account.closed_evidence,target_account.required_start_date,
        target_account.observed_start_date,target_account.history_state,target_account.coverage_gap) WHERE org_id=v_org AND account_id=aid;
      SELECT to_jsonb(x) INTO v_before FROM core.account_assignment x WHERE source_account_id=v_subject AND upper_inf(valid);
      UPDATE core.account_assignment SET valid=tstzrange(lower(valid),stamp,'[)') WHERE org_id=v_org AND source_account_id=v_subject AND upper_inf(valid);
      INSERT INTO core.account_assignment(org_id,id,source_account_id,account_id,valid,reason,ruled_by,publication_id)
      VALUES(v_org,core.projection_id('ruling-assignment:'||v_pub||':'||v_position),v_subject,aid,tstzrange(stamp,NULL,'[)'),
        'ruling',p_ruled_by,v_pub);
      SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO old_rows FROM core.transaction x WHERE org_id=v_org;
      WITH changed AS (
        UPDATE core.transaction SET account_id=aid,revision=revision+1,revision_publication_id=v_pub
        WHERE org_id=v_org AND source_account_id=v_subject AND account_id<>aid RETURNING *
      ) INSERT INTO core.transaction_revision(org_id,transaction_id,revision,publication_id,position,cause,
        source_connection_id,source_external_id,predecessor_revision,projection_version)
      SELECT v_org,transaction_id,revision,v_pub,v_position,'reassigned',authoritative_connection_id,authoritative_external_id,revision-1,1 FROM changed;
      PERFORM core.invalidate_changes(v_org,v_pub,old_rows,true);
    ELSIF v_kind IN ('account_entity','reporting_scope') THEN
      date_start:=coalesce((v_after->>'valid_from')::date,(v_after->>'date')::date,(stamp AT TIME ZONE
        (SELECT reporting_tz FROM core.org WHERE org_id=v_org))::date);
      date_end:=(v_after->>'valid_to')::date;
      IF v_after ? 'valid' THEN date_start:=lower((v_after->>'valid')::daterange); date_end:=upper((v_after->>'valid')::daterange); END IF;
      IF v_kind='account_entity' THEN
        SELECT to_jsonb(x) INTO v_before FROM core.account_entity x WHERE org_id=v_org AND account_id=v_subject AND upper_inf(valid);
        UPDATE core.account_entity SET valid=daterange(lower(valid),date_start,'[)')
          WHERE org_id=v_org AND account_id=v_subject AND upper_inf(valid);
        INSERT INTO core.account_entity(org_id,id,account_id,entity_id,dimension_id,valid,reason,ruled_by,publication_id)
        VALUES(v_org,core.projection_id('account-entity:'||v_pub||':'||v_position),v_subject,(v_after->>'entity_id')::uuid,
          (v_after->>'dimension_id')::uuid,daterange(date_start,date_end,'[)'),p_reason,p_ruled_by,v_pub);
      ELSE
        SELECT to_jsonb(x) INTO v_before FROM core.account_reporting_scope x WHERE org_id=v_org AND account_id=v_subject AND upper_inf(valid);
        UPDATE core.account_reporting_scope SET valid=daterange(lower(valid),date_start,'[)')
          WHERE org_id=v_org AND account_id=v_subject AND upper_inf(valid);
        INSERT INTO core.account_reporting_scope(org_id,id,account_id,scope,valid,reason,ruled_by,publication_id)
        VALUES(v_org,core.projection_id('scope:'||v_pub||':'||v_position),v_subject,v_after->>'scope',
          daterange(date_start,date_end,'[)'),p_reason,p_ruled_by,v_pub);
      END IF;
      IF NOT rebuilding THEN
        INSERT INTO verify.invalidation(org_id,id,certification_id,cause,publication_id,old_account_id,new_account_id,detected_at)
        SELECT v_org,core.projection_id('ruling-invalidation:'||v_pub||':'||v_position||':'||c.id),c.id,'ruling',v_pub,v_subject,v_subject,stamp
        FROM verify.certification c WHERE org_id=v_org AND account_id=v_subject AND period && daterange(date_start,date_end,'[)')
          AND NOT EXISTS(SELECT 1 FROM verify.invalidation i WHERE i.certification_id=c.id AND i.superseding_certification_id IS NULL);
      END IF;
    ELSE RAISE EXCEPTION 'not implemented (step 2): account_meta';
    END IF;
  RETURN v_before;
END $$;

-- Evidence holds the precise prior alias/fact state. Reversal restores business
-- fields and appends revisions instead of erasing the decision or revision chain.
CREATE FUNCTION core.project_identity(d core.identity_decision) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE subject core.transaction_alias%ROWTYPE; object_alias core.transaction_alias%ROWTYPE;
  prev core.identity_decision%ROWTYPE; item jsonb; restored core.transaction%ROWTYPE;
  stamp timestamptz; old_rows jsonb; old_revision int; tid uuid;
BEGIN
  SELECT created_at INTO STRICT stamp FROM ops.publication WHERE id=d.publication_id;
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO old_rows FROM core.transaction x WHERE org_id=d.org_id;
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
      d:=NULL; ob:=NULL;
      IF k='reversal' THEN
        SELECT * INTO STRICT prev FROM core.identity_decision WHERE org_id=v_org AND id=subject AND decided_by NOT LIKE 'system:%' AND kind<>'reversal';
        IF EXISTS(SELECT 1 FROM core.identity_decision WHERE reverses_id=prev.id) THEN RAISE EXCEPTION 'decision already reversed'; END IF;
        SELECT * INTO STRICT al FROM core.transaction_alias WHERE connection_id=prev.subject_connection_id AND external_id=prev.subject_external_id;
        d.reverses_id:=prev.id;
      ELSE
        SELECT * INTO STRICT al FROM core.transaction_alias WHERE org_id=v_org
          AND connection_id=(aft->>'subject_connection_id')::uuid AND external_id=aft->>'subject_external_id';
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

CREATE FUNCTION core.project_inventory(p_connection_id uuid,p_api_call_id bigint,v_pub bigint)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE c core.source_connection%ROWTYPE; a raw.api_call%ROWTYPE; item jsonb; s uuid; aid uuid; stamp timestamptz;
  rebuilding bool:=coalesce(current_setting('ledgerline.rebuild',true),'')='on';
BEGIN
  SELECT * INTO STRICT c FROM core.source_connection WHERE connection_id=p_connection_id;
  SELECT * INTO STRICT a FROM raw.api_call WHERE org_id=c.org_id AND connection_id=c.connection_id AND id=p_api_call_id
    AND endpoint='/accounts/get' AND http_status=200 AND error_code IS NULL;
  SELECT created_at INTO STRICT stamp FROM ops.publication WHERE id=v_pub;
  IF jsonb_typeof(a.payload->'accounts') IS DISTINCT FROM 'array' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(a.payload->'accounts') x WHERE nullif(x->>'account_id','') IS NULL) OR
    (SELECT count(*)<>count(DISTINCT x->>'account_id') FROM jsonb_array_elements(a.payload->'accounts') x) THEN
    RAISE EXCEPTION 'invalid inventory observation' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(a.payload->'accounts') LOOP
    -- source_account is permanent; only account/assignment projections are reset.
    IF NOT rebuilding THEN
      INSERT INTO core.source_account(org_id,connection_id,external_account_id,external_name,official_name,type,subtype,mask,
        persistent_account_id,capability,first_seen_publication_id,last_seen_at)
      VALUES(c.org_id,c.connection_id,item->>'account_id',btrim(item->>'name'),item->>'official_name',item->>'type',item->>'subtype',
        item->>'mask',item->>'persistent_account_id',coalesce(item->>'capability','unknown'),v_pub,stamp)
      ON CONFLICT(connection_id,external_account_id) DO UPDATE SET external_name=excluded.external_name,
        official_name=excluded.official_name,type=excluded.type,subtype=excluded.subtype,mask=excluded.mask,
        persistent_account_id=excluded.persistent_account_id,capability=coalesce(item->>'capability',core.source_account.capability),
        last_seen_at=stamp,missing_since=NULL;
    END IF;
    s:=core.ensure_account(c.org_id,c.connection_id,item->>'account_id',v_pub,stamp);
    SELECT account_id INTO aid FROM core.account_assignment WHERE source_account_id=s AND reason='placeholder' ORDER BY lower(valid) LIMIT 1;
    -- Initial account metadata comes from this observation, not the latest durable
    -- source_account row (which might describe a later inventory during replay).
    IF EXISTS(SELECT 1 FROM core.account_allocation WHERE account_id=aid AND allocated_publication_id=v_pub) THEN
      UPDATE core.account SET display_name=btrim(item->>'name'),mask=item->>'mask',currency=coalesce(item->'balances'->>'iso_currency_code','USD'),
        balance_orientation=CASE WHEN item->>'type' IN ('credit','loan') THEN 'liability' ELSE 'asset' END WHERE account_id=aid;
    END IF;
  END LOOP;
  IF NOT rebuilding THEN
    UPDATE core.source_account SET missing_since=coalesce(missing_since,stamp) WHERE connection_id=c.connection_id AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(a.payload->'accounts') x WHERE x->>'account_id'=external_account_id);
    IF c.state='linked' THEN UPDATE core.source_connection SET state='inventoried' WHERE connection_id=c.connection_id; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION core.record_inventory(p_connection_id uuid,p_api_call_id bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE c core.source_connection%ROWTYPE; pub bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF p_connection_id IS NULL OR p_api_call_id IS NULL THEN RAISE EXCEPTION 'invalid inventory input' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM core.source_connection WHERE connection_id=p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown connection' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS(SELECT 1 FROM raw.api_call WHERE id=p_api_call_id AND org_id=c.org_id AND connection_id=c.connection_id
    AND endpoint='/accounts/get' AND http_status=200 AND error_code IS NULL AND jsonb_typeof(payload->'accounts')='array')
    THEN RAISE EXCEPTION 'invalid inventory observation' USING ERRCODE='22023'; END IF;
  pub:=nextval('ops.publication_seq');
  INSERT INTO ops.publication(id,org_id,kind,actor,payload)
  VALUES(pub,c.org_id,'inventory',session_user,jsonb_build_object('connection_id',c.connection_id,'api_call_id',p_api_call_id));
  PERFORM core.project_inventory(p_connection_id,p_api_call_id,pub);
  RETURN pub;
END $$;

CREATE OR REPLACE FUNCTION core.rebuild_projections() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE p ops.publication%ROWTYPE; acceptance raw.sync_acceptance%ROWTYPE; event record; d core.identity_decision%ROWTYPE;
  f record; constraints_json jsonb; item jsonb; manifest jsonb:='{}'; table_name text; row_count bigint;
  previous_guc text:=coalesce(current_setting('ledgerline.rebuild',true),'');
  projections regclass[]:=ARRAY['core.transaction'::regclass,'core.transaction_alias'::regclass,'core.transaction_revision'::regclass,
    'core.balance_observation'::regclass,'core.quarantine'::regclass,'core.account'::regclass,'core.account_assignment'::regclass,
    'core.account_entity'::regclass,'core.account_reporting_scope'::regclass,'core.entity'::regclass,'core.dimension'::regclass];
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF NOT EXISTS(SELECT 1 FROM core.org) THEN RAISE EXCEPTION 'no org to rebuild' USING ERRCODE='22023'; END IF;
  PERFORM set_config('ledgerline.rebuild','on',true);
  -- Postgres TRUNCATE requires even empty incoming-FK tables in its list.
  -- Verification is durable and MUST NOT be truncated. Transactional DDL removes
  -- only its incoming constraints and reinstates/validates exactly the same FKs
  -- after replay. Failure rolls back both DDL and all projection changes.
  SELECT coalesce(jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,'definition',pg_get_constraintdef(oid))),'[]')
    INTO constraints_json FROM pg_constraint WHERE contype='f' AND confrelid=ANY(projections) AND NOT conrelid=ANY(projections);
  FOR item IN SELECT value FROM jsonb_array_elements(constraints_json) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item->>'table',item->>'name');
  END LOOP;
  TRUNCATE core.transaction_alias,core.transaction_revision,core.balance_observation,core.quarantine,
    core.account_assignment,core.account_entity,core.account_reporting_scope,core.dimension,core.transaction,core.account,core.entity;
  FOR p IN SELECT * FROM ops.publication ORDER BY id LOOP
    IF p.kind='inventory' THEN
      IF p.payload->>'api_call_id' IS NULL THEN RAISE EXCEPTION 'REBUILD_MISSING_INVENTORY'; END IF;
      PERFORM core.project_inventory((p.payload->>'connection_id')::uuid,(p.payload->>'api_call_id')::bigint,p.id);
    ELSIF p.kind='acceptance' THEN
      SELECT * INTO acceptance FROM raw.sync_acceptance WHERE publication_id=p.id;
      -- Step 0 publication-only probes have no acceptance and no projections.
      IF FOUND THEN
        PERFORM core.project_acceptance(p.org_id,acceptance.connection_id,p.id,core.reduce_pages(acceptance.page_ids),
          coalesce(p.payload->'balances',core.balances_from_pages(acceptance.page_ids)),acceptance.projection_version);
      END IF;
    ELSIF p.kind='ruling' THEN
      FOR event IN SELECT position,'ruling' AS type,id FROM core.ruling_event WHERE publication_id=p.id
        UNION ALL SELECT position,'identity',id FROM core.identity_decision WHERE publication_id=p.id AND decided_by NOT LIKE 'system:%'
        ORDER BY position LOOP
        IF event.type='ruling' THEN
          FOR f IN SELECT * FROM core.ruling_event WHERE id=event.id LOOP
            PERFORM core.project_ruling(f.org_id,f.publication_id,f.position,f.kind,f.subject_id,f.after,f.reason,f.ruled_by);
          END LOOP;
        ELSE
          SELECT * INTO STRICT d FROM core.identity_decision WHERE id=event.id;
          PERFORM core.project_identity(d);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(constraints_json) LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item->>'table',item->>'name',item->>'definition');
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['transaction','transaction_alias','transaction_revision','balance_observation','quarantine',
    'account','account_assignment','account_entity','account_reporting_scope','entity','dimension'] LOOP
    EXECUTE format('SELECT count(*) FROM core.%I',table_name) INTO row_count;
    manifest:=manifest||jsonb_build_object(table_name,row_count);
  END LOOP;
  INSERT INTO ops.publication(org_id,kind,actor,payload) SELECT org_id,'rebuild_marker',session_user,manifest FROM core.org ORDER BY org_id LIMIT 1;
  PERFORM set_config('ledgerline.rebuild',previous_guc,true);
END $$;

-- One row per affected certification and transaction. The current predicate is
-- evaluated against the pre-publication verification state by this single INSERT.
CREATE FUNCTION core.invalidate_coordinates(p_org uuid,p_pub bigint,p_changes jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF coalesce(current_setting('ledgerline.rebuild',true),'')='on' THEN RETURN; END IF;
  INSERT INTO verify.invalidation(org_id,id,certification_id,cause,publication_id,
    old_account_id,old_posted_date,new_account_id,new_posted_date,detected_at)
  SELECT DISTINCT ON (c.id,change->>'transaction_id') p_org,
    core.projection_id('invalidation:'||p_pub||':'||c.id||':'||(change->>'transaction_id')),c.id,
    CASE WHEN change->>'cause' IN ('currency_quarantine','currency_restored') THEN 'currency'
      WHEN change->>'cause'='reassigned' THEN 'reassigned' ELSE 'fact_revision' END,p_pub,
    (change->>'old_account_id')::uuid,(change->>'old_posted_date')::date,
    (change->>'new_account_id')::uuid,(change->>'new_posted_date')::date,p.created_at
  FROM jsonb_array_elements(p_changes) WITH ORDINALITY changes(change,n)
  JOIN ops.publication p ON p.id=p_pub
  JOIN verify.certification c ON c.org_id=p_org AND
    ((c.account_id=(change->>'old_account_id')::uuid AND c.period @> (change->>'old_posted_date')::date) OR
     (c.account_id=(change->>'new_account_id')::uuid AND c.period @> (change->>'new_posted_date')::date))
  WHERE NOT EXISTS(SELECT 1 FROM verify.invalidation i WHERE i.certification_id=c.id AND i.superseding_certification_id IS NULL)
  ORDER BY c.id,change->>'transaction_id',n;
END $$;
