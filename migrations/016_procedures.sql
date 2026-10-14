-- These callable routines are functions so callers can receive durable ids with SELECT.
-- All cross-schema mutations use the owner's authority and a fixed search_path.
CREATE FUNCTION core.register_connection(
  p_org_id uuid, p_external_id text, p_access_token_enc bytea,
  p_institution_id text DEFAULT NULL, p_institution_name text DEFAULT NULL,
  p_relink_of uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_id uuid;
BEGIN
  IF p_org_id IS NULL OR nullif(btrim(p_external_id), '') IS NULL OR
     p_access_token_enc IS NULL OR octet_length(p_access_token_enc) = 0 THEN
    RAISE EXCEPTION 'invalid connection input' USING ERRCODE = '22023';
  END IF;
  INSERT INTO core.source_connection (org_id, source, external_id, access_token_enc,
    institution_id, institution_name, state, relink_of)
  VALUES (p_org_id, 'plaid', p_external_id, p_access_token_enc,
    p_institution_id, p_institution_name, 'linked', p_relink_of) RETURNING connection_id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION core.update_connection_token(p_connection_id uuid, p_access_token_enc bytea)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF p_connection_id IS NULL OR p_access_token_enc IS NULL OR octet_length(p_access_token_enc) = 0 THEN
    RAISE EXCEPTION 'invalid token input' USING ERRCODE = '22023';
  END IF;
  UPDATE core.source_connection SET access_token_enc = p_access_token_enc WHERE connection_id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown connection' USING ERRCODE = '22023'; END IF;
END;
$$;

CREATE FUNCTION ops.open_attempt(p_connection_id uuid, p_process_id text DEFAULT NULL, p_restarts int DEFAULT 0)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_id bigint;
BEGIN
  IF p_connection_id IS NULL OR p_restarts IS NULL OR p_restarts < 0 THEN
    RAISE EXCEPTION 'invalid attempt input' USING ERRCODE = '22023';
  END IF;
  INSERT INTO ops.sync_attempt (org_id, connection_id, cursor_in, predecessor_publication_id,
    status, process_id, restarts)
  SELECT org_id, connection_id, cursor, last_publication_id, 'fetching', p_process_id, p_restarts
  FROM core.source_connection WHERE connection_id = p_connection_id RETURNING id INTO v_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown connection' USING ERRCODE = '22023'; END IF;
  RETURN v_id;
END;
$$;

CREATE FUNCTION ops.finish_attempt(p_attempt_id bigint, p_status text, p_error text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF p_attempt_id IS NULL OR p_status IS NULL OR p_status NOT IN
    ('validating','accepting','abandoned','failed','invalid','poisoned','exhausted') THEN
    RAISE EXCEPTION 'invalid attempt completion' USING ERRCODE = '22023';
  END IF;
  UPDATE ops.sync_attempt SET status = p_status, error = p_error,
    ended_at = CASE WHEN p_status IN ('validating','accepting') THEN NULL ELSE now() END
  WHERE id = p_attempt_id AND status NOT IN ('accepted','abandoned','failed','invalid','poisoned','exhausted');
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown or terminal attempt' USING ERRCODE = '22023'; END IF;
END;
$$;

CREATE FUNCTION ops.raise_alert(p_org_id uuid, p_kind text, p_dedupe_key text,
  p_subject text DEFAULT NULL, p_detail jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_id uuid; v_severity text;
BEGIN
  IF p_org_id IS NULL OR nullif(p_kind, '') IS NULL OR nullif(p_dedupe_key, '') IS NULL THEN
    RAISE EXCEPTION 'invalid alert input' USING ERRCODE = '22023';
  END IF;
  SELECT severity INTO v_severity FROM ops.alert_rule WHERE key = p_kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown alert rule' USING ERRCODE = '22023'; END IF;
  INSERT INTO ops.alert (org_id, kind, severity, dedupe_key, subject, detail)
  VALUES (p_org_id, p_kind, v_severity, p_dedupe_key, p_subject, p_detail)
  ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM ops.alert WHERE dedupe_key = p_dedupe_key
      AND org_id = p_org_id AND acknowledged_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'alert key belongs to another org' USING ERRCODE = '22023'; END IF;
  END IF;
  RETURN v_id;
END;
$$;

CREATE FUNCTION ops.heartbeat(p_org_id uuid, p_service text, p_ok bool, p_detail jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_id uuid;
BEGIN
  IF p_org_id IS NULL OR nullif(btrim(p_service), '') IS NULL OR p_ok IS NULL THEN
    RAISE EXCEPTION 'invalid heartbeat input' USING ERRCODE = '22023';
  END IF;
  INSERT INTO ops.heartbeat (org_id, service, ok, detail)
  VALUES (p_org_id, p_service, p_ok, p_detail) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION core.record_inventory(p_connection_id uuid, p_api_call_id bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE c core.source_connection%ROWTYPE; a raw.api_call%ROWTYPE;
  item jsonb; v_pub bigint; v_source uuid; v_account uuid; v_at timestamptz := now();
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF p_connection_id IS NULL OR p_api_call_id IS NULL THEN
    RAISE EXCEPTION 'invalid inventory input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM core.source_connection WHERE connection_id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown connection' USING ERRCODE = '22023'; END IF;
  SELECT * INTO a FROM raw.api_call WHERE id = p_api_call_id AND org_id = c.org_id
    AND connection_id = c.connection_id AND endpoint = '/accounts/get' AND http_status = 200 AND error_code IS NULL;
  IF NOT FOUND OR jsonb_typeof(a.payload->'accounts') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid inventory observation' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(a.payload->'accounts') x
    WHERE nullif(x->>'account_id', '') IS NULL) OR
    (SELECT count(*) <> count(DISTINCT x->>'account_id') FROM jsonb_array_elements(a.payload->'accounts') x) THEN
    RAISE EXCEPTION 'invalid inventory account ids' USING ERRCODE = '22023';
  END IF;
  v_pub := nextval('ops.publication_seq');
  INSERT INTO ops.publication (id, org_id, kind, actor, payload)
  VALUES (v_pub, c.org_id, 'inventory', session_user,
    jsonb_build_object('connection_id', c.connection_id, 'api_call_id', p_api_call_id));
  FOR item IN SELECT value FROM jsonb_array_elements(a.payload->'accounts') LOOP
    SELECT source_account_id INTO v_source FROM core.source_account
      WHERE connection_id = c.connection_id AND external_account_id = item->>'account_id';
    IF NOT FOUND THEN
      INSERT INTO core.source_account (org_id, connection_id, external_account_id, external_name,
        official_name, type, subtype, mask, persistent_account_id, capability, first_seen_publication_id, last_seen_at)
      VALUES (c.org_id, c.connection_id, item->>'account_id', btrim(item->>'name'), item->>'official_name',
        item->>'type', item->>'subtype', item->>'mask', item->>'persistent_account_id',
        coalesce(item->>'capability', 'unknown'), v_pub, v_at) RETURNING source_account_id INTO v_source;
      INSERT INTO core.account_allocation (org_id, allocated_publication_id, origin, source_account_id)
      VALUES (c.org_id, v_pub, 'placeholder', v_source) RETURNING account_id INTO v_account;
      INSERT INTO core.account (org_id, account_id, display_name, institution_name, mask, kind,
        balance_orientation, verification_method, currency, status, history_state, coverage_gap)
      VALUES (c.org_id, v_account, btrim(item->>'name'), c.institution_name, item->>'mask',
        'other', CASE WHEN item->>'type' IN ('credit','loan') THEN 'liability' ELSE 'asset' END,
        'unverified', coalesce(item->'balances'->>'iso_currency_code', 'USD'), 'placeholder', 'unknown', 'awaiting assignment');
      INSERT INTO core.account_assignment (org_id, source_account_id, account_id, valid, reason, ruled_by, publication_id)
      VALUES (c.org_id, v_source, v_account, tstzrange(v_at, NULL, '[)'), 'placeholder', session_user, v_pub);
      PERFORM ops.raise_alert(c.org_id, 'new_account', 'new_account:'||v_source::text, v_source::text, item);
    ELSE
      UPDATE core.source_account SET external_name = btrim(item->>'name'), official_name = item->>'official_name',
        type = item->>'type', subtype = item->>'subtype', mask = item->>'mask',
        persistent_account_id = item->>'persistent_account_id',
        capability = coalesce(item->>'capability', capability), last_seen_at = v_at, missing_since = NULL
      WHERE source_account_id = v_source AND org_id = c.org_id;
    END IF;
  END LOOP;
  UPDATE core.source_account SET missing_since = coalesce(missing_since, v_at)
  WHERE connection_id = c.connection_id AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(a.payload->'accounts') x WHERE x->>'account_id' = external_account_id
  );
  IF c.state = 'linked' THEN UPDATE core.source_connection SET state = 'inventoried' WHERE connection_id = c.connection_id; END IF;
  RETURN v_pub;
END;
$$;

CREATE FUNCTION core.record_health(p_connection_id uuid, p_api_call_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE c core.source_connection%ROWTYPE; a raw.api_call%ROWTYPE; item jsonb;
BEGIN
  IF p_connection_id IS NULL OR p_api_call_id IS NULL THEN
    RAISE EXCEPTION 'invalid health input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM core.source_connection WHERE connection_id = p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown connection' USING ERRCODE = '22023'; END IF;
  SELECT * INTO a FROM raw.api_call WHERE id = p_api_call_id AND org_id = c.org_id
    AND connection_id = c.connection_id AND endpoint = '/item/get';
  IF NOT FOUND OR a.payload IS NULL THEN RAISE EXCEPTION 'invalid health observation' USING ERRCODE = '22023'; END IF;
  item := a.payload->'item';
  UPDATE core.source_connection SET consent_expires_at = (item->>'consent_expiration_time')::timestamptz,
    last_error_code = coalesce(a.error_code, item->'error'->>'error_code'),
    last_error_reason = item->'error'->>'error_message',
    last_successful_update = (a.payload->'status'->'transactions'->>'last_successful_update')::timestamptz,
    state = CASE WHEN coalesce(a.error_code, item->'error'->>'error_code') = 'ITEM_LOGIN_REQUIRED'
      THEN 'login_required' ELSE state END
  WHERE connection_id = c.connection_id;
  IF coalesce(a.error_code, item->'error'->>'error_code') = 'ITEM_LOGIN_REQUIRED' THEN
    PERFORM ops.raise_alert(c.org_id, 'login_required', 'login_required:'||c.connection_id::text, c.connection_id::text, item->'error');
  END IF;
END;
$$;

CREATE FUNCTION core.accept_publication(p_attempt_id bigint, p_page_ids bigint[], p_cursor_out text,
  p_transitions jsonb, p_balances jsonb, p_projection_version int,
  p_dry_run_publication_only boolean DEFAULT false)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE a ops.sync_attempt%ROWTYPE; c core.source_connection%ROWTYPE; v_pub bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF p_attempt_id IS NULL OR cardinality(p_page_ids) IS NULL OR cardinality(p_page_ids) = 0 OR
    nullif(btrim(p_cursor_out), '') IS NULL OR p_projection_version IS NULL OR p_projection_version <= 0 OR
    jsonb_typeof(p_transitions) IS DISTINCT FROM 'array' OR jsonb_typeof(p_balances) IS DISTINCT FROM 'array' OR
    p_dry_run_publication_only IS NULL THEN
    RAISE EXCEPTION 'invalid acceptance input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO a FROM ops.sync_attempt WHERE id = p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown attempt' USING ERRCODE = '22023'; END IF;
  SELECT publication_id INTO v_pub FROM raw.sync_acceptance WHERE attempt_id = p_attempt_id;
  IF FOUND THEN RETURN v_pub; END IF;
  IF a.status NOT IN ('fetching','validating','accepting') THEN
    RAISE EXCEPTION 'attempt is not acceptable' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM core.source_connection WHERE org_id = a.org_id AND connection_id = a.connection_id FOR UPDATE;
  IF c.cursor IS DISTINCT FROM a.cursor_in OR c.last_publication_id IS DISTINCT FROM a.predecessor_publication_id THEN
    RAISE EXCEPTION 'stale attempt cursor or predecessor' USING ERRCODE = '23514';
  END IF;
  v_pub := nextval('ops.publication_seq');
  INSERT INTO ops.publication (id, org_id, kind, actor, payload)
  VALUES (v_pub, a.org_id, 'acceptance', session_user, jsonb_build_object('attempt_id', p_attempt_id));
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
  RAISE EXCEPTION 'not implemented (step 2)';
END;
$$;

CREATE FUNCTION core.apply_ruling(p_kind text, p_subject uuid, p_after jsonb, p_reason text, p_ruled_by text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_org uuid; v_pub bigint; v_rows jsonb; row jsonb; v_kind text; v_subject uuid;
  v_after jsonb; v_before jsonb; v_position int := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF p_kind IS NULL OR p_kind NOT IN ('assignment','entity','dimension','account_entity','reporting_scope','account_meta') OR
    p_subject IS NULL OR jsonb_typeof(p_after) IS DISTINCT FROM 'object' OR
    nullif(btrim(p_reason), '') IS NULL OR nullif(btrim(p_ruled_by), '') IS NULL THEN
    RAISE EXCEPTION 'invalid ruling input' USING ERRCODE = '22023';
  END IF;
  v_org := (p_after->>'org_id')::uuid;
  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM core.org WHERE org_id = v_org) THEN
    RAISE EXCEPTION 'unknown ruling org' USING ERRCODE = '22023';
  END IF;
  -- The seed's entities/dimensions form one atomic ruling publication (§3.4).
  -- A batch uses {org_id, rulings:[{kind,subject_id,after}]} in the existing JSON parameter.
  v_rows := coalesce(p_after->'rulings', jsonb_build_array(jsonb_build_object(
    'kind', p_kind, 'subject_id', p_subject, 'after', p_after)));
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'empty ruling' USING ERRCODE = '22023';
  END IF;
  v_pub := nextval('ops.publication_seq');
  INSERT INTO ops.publication (id, org_id, kind, actor, payload)
  VALUES (v_pub, v_org, 'ruling', p_ruled_by, jsonb_build_object('reason', p_reason));
  FOR row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    v_kind := row->>'kind'; v_subject := (row->>'subject_id')::uuid; v_after := row->'after'; v_before := NULL;
    IF v_subject IS NULL OR v_kind IS NULL OR
      v_kind NOT IN ('assignment','entity','dimension','account_entity','reporting_scope','account_meta') OR
      jsonb_typeof(v_after) IS DISTINCT FROM 'object' OR
      (v_after ? 'org_id' AND (v_after->>'org_id')::uuid IS DISTINCT FROM v_org) THEN
      RAISE EXCEPTION 'invalid ruling projection input' USING ERRCODE = '22023';
    END IF;
    IF v_kind NOT IN ('entity','dimension') THEN
      RAISE EXCEPTION 'not implemented (step 2)';
    END IF;
    IF nullif(v_after->>'slug', '') IS NULL OR nullif(v_after->>'display_name', '') IS NULL THEN
      RAISE EXCEPTION 'invalid ruling projection input' USING ERRCODE = '22023';
    END IF;
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
    ELSE
      RAISE EXCEPTION 'not implemented (step 2)';
    END IF;
    v_position := v_position + 1;
    INSERT INTO core.ruling_event (org_id, publication_id, position, kind, subject_id, before, after, reason, ruled_by)
    VALUES (v_org, v_pub, v_position, v_kind, v_subject, v_before, v_after, p_reason, p_ruled_by);
  END LOOP;
  RETURN v_pub;
END;
$$;

CREATE FUNCTION verify.import_statement(p_account_id uuid, p_period daterange, p_source text,
  p_file_sha256 text, p_header jsonb, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE v_org uuid; v_id uuid; v_version int; v_line jsonb; v_no int := 0;
  v_credits numeric; v_debits numeric;
BEGIN
  IF p_account_id IS NULL OR p_period IS NULL OR isempty(p_period) OR
    p_source IS NULL OR p_source NOT IN ('qbo_reconciliation','bank_csv','bank_pdf_transcribed') OR
    p_file_sha256 IS NULL OR p_file_sha256 !~ '^[a-fA-F0-9]{64}$' OR
    jsonb_typeof(p_header) IS DISTINCT FROM 'object' OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid statement input' USING ERRCODE = '22023';
  END IF;
  SELECT org_id INTO v_org FROM core.account WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown account' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(sum((x->>'amount')::numeric) FILTER (WHERE (x->>'amount')::numeric > 0), 0),
    coalesce(sum(-(x->>'amount')::numeric) FILTER (WHERE (x->>'amount')::numeric < 0), 0)
  INTO v_credits, v_debits FROM jsonb_array_elements(p_lines) x;
  IF (p_header->>'line_count')::int IS DISTINCT FROM jsonb_array_length(p_lines) OR
    (p_header->>'credits_total')::numeric IS DISTINCT FROM v_credits OR
    (p_header->>'debits_total')::numeric IS DISTINCT FROM v_debits OR
    p_header->>'opening_balance' IS NULL OR p_header->>'closing_balance' IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_lines) x WHERE x->>'amount' IS NULL OR
        (x->>'amount')::numeric <> round((x->>'amount')::numeric, 2) OR
        (x->>'cleared_period')::daterange IS DISTINCT FROM p_period
    ) THEN RAISE EXCEPTION 'statement lines or totals disagree' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM verify.statement
    WHERE account_id = p_account_id AND period = p_period;
  INSERT INTO verify.statement (org_id, account_id, version, period, opening_balance, closing_balance,
    debits_total, credits_total, line_count, source, file_sha256, file_uri, columns_seen, entered_by)
  VALUES (v_org, p_account_id, v_version, p_period, (p_header->>'opening_balance')::numeric,
    (p_header->>'closing_balance')::numeric, v_debits, v_credits, jsonb_array_length(p_lines), p_source,
    p_file_sha256, p_header->>'file_uri', ARRAY(SELECT jsonb_array_elements_text(p_header->'columns_seen')),
    coalesce(p_header->>'entered_by', session_user)) RETURNING id INTO v_id;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_no := v_no + 1;
    INSERT INTO verify.statement_line (org_id, statement_id, line_no, qbo_txn_date, bank_posted_date,
      cleared_period, amount, description, reference, qbo_txn_ref)
    VALUES (v_org, v_id, v_no, (v_line->>'qbo_txn_date')::date, (v_line->>'bank_posted_date')::date,
      p_period, (v_line->>'amount')::numeric, v_line->>'description', v_line->>'reference', v_line->>'qbo_txn_ref');
  END LOOP;
  RETURN v_id;
END;
$$;

CREATE FUNCTION verify.run_reconciliation(p_statement_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF p_statement_id IS NULL OR NOT EXISTS (SELECT 1 FROM verify.statement WHERE id = p_statement_id) THEN
    RAISE EXCEPTION 'unknown statement' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(7777);
  RAISE EXCEPTION 'not implemented (step 5)';
END;
$$;

CREATE FUNCTION verify.certify(p_recon_run_id uuid, p_export_uri text, p_sha text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE r verify.recon_run%ROWTYPE; v_head bigint; v_pub bigint; v_id uuid; v_period daterange;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF p_recon_run_id IS NULL OR nullif(btrim(p_export_uri), '') IS NULL OR p_sha IS NULL OR p_sha !~ '^[a-fA-F0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid certification input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM verify.recon_run WHERE id = p_recon_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown reconciliation run' USING ERRCODE = '22023'; END IF;
  SELECT max(id) INTO v_head FROM ops.publication;
  IF r.result IS DISTINCT FROM 'pass' OR r.publication_id IS DISTINCT FROM v_head OR EXISTS (
    SELECT 1 FROM verify.recon_run n WHERE n.statement_id = r.statement_id AND n.id <> r.id AND n.ran_at > r.ran_at
  ) OR EXISTS (SELECT 1 FROM verify.recon_supersession WHERE superseded_run_id = r.id) THEN
    RAISE EXCEPTION 'run is failed, stale, or superseded' USING ERRCODE = '23514';
  END IF;
  SELECT period INTO v_period FROM verify.statement WHERE org_id = r.org_id AND id = r.statement_id;
  v_pub := nextval('ops.publication_seq');
  INSERT INTO ops.publication (id, org_id, kind, actor, payload)
  VALUES (v_pub, r.org_id, 'certification', session_user, jsonb_build_object('recon_run_id', r.id));
  INSERT INTO verify.certification (org_id, account_id, period, recon_run_id, publication_id,
    certified_by, export_uri, export_sha256)
  VALUES (r.org_id, r.account_id, v_period, r.id, v_pub, session_user, p_export_uri, p_sha) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION core.rebuild_projections() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.org) THEN RAISE EXCEPTION 'no org to rebuild' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(7777);
  RAISE EXCEPTION 'not implemented (step 2)';
END;
$$;
