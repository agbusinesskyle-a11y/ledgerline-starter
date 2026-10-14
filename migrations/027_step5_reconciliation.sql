-- Step 5 (reconciliation). Facts and statement lines use the bank sign: inflow positive,
-- outflow negative. Asset closing = opening + sum(amount); liability closing =
-- opening - sum(amount). Card PDFs are normalized to this sign by the CLI.
-- V1: PDF evidence; V2: mutual uniqueness over the entire +/- 3 day window.
-- Existing recon_run/recon_match/certification immutable guards in 014 remain.

CREATE TABLE verify.statement_adjustment (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  statement_id uuid PRIMARY KEY,
  adjustments jsonb NOT NULL CHECK (jsonb_typeof(adjustments)='array'),
  FOREIGN KEY (org_id,statement_id) REFERENCES verify.statement(org_id,id)
);
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON verify.statement_adjustment
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();

CREATE FUNCTION verify.record_statement_adjustments(p_statement_id uuid,p_adjustments jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE s verify.statement%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  SELECT * INTO s FROM verify.statement WHERE id=p_statement_id FOR UPDATE;
  IF NOT FOUND OR jsonb_typeof(p_adjustments) IS DISTINCT FROM 'array' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_adjustments) a WHERE jsonb_typeof(a) IS DISTINCT FROM 'object'
      OR nullif(btrim(a->>'description'),'') IS NULL OR a->>'amount' IS NULL
      OR (a->>'amount')::numeric <> round((a->>'amount')::numeric,2)) THEN
    RAISE EXCEPTION 'invalid statement adjustments' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM verify.recon_run WHERE statement_id=s.id) THEN
    RAISE EXCEPTION 'adjustments must precede reconciliation' USING ERRCODE='23514';
  END IF;
  INSERT INTO verify.statement_adjustment VALUES(s.org_id,s.id,p_adjustments);
END $$;

CREATE FUNCTION verify.resolve_exception(p_exception_id uuid,p_owner text,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  IF nullif(btrim(p_owner),'') IS NULL OR nullif(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION 'exception resolution needs owner and reason' USING ERRCODE='22023';
  END IF;
  UPDATE verify.exception SET owner=p_owner,resolved_at=clock_timestamp(),
    evidence=evidence||jsonb_build_object('resolution_reason',p_reason,'resolved_by',session_user)
    WHERE id=p_exception_id AND resolved_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown or already resolved exception' USING ERRCODE='22023'; END IF;
  -- A rerun, never a mutation of the prior run, is required to pass.
END $$;

CREATE OR REPLACE FUNCTION verify.run_reconciliation(p_statement_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE s verify.statement%ROWTYPE; prior verify.statement%ROWTYPE;
  head bigint; rid uuid:=gen_random_uuid(); orientation text;
  fact_sum numeric; debits numeric; credits numeric; opening_ok bool; closing_ok bool;
  debit_diff numeric; credit_diff numeric; unmatched_lines int; unmatched_transactions int; unresolved int;
  edges jsonb; chosen jsonb; matches jsonb:='[]'; facts jsonb; adjustment jsonb; adjustment_no bigint; adjustments jsonb;
  old_exception verify.exception%ROWTYPE; unresolved_exceptions int:=0; detail jsonb; result text; phase int;
BEGIN
  PERFORM pg_advisory_xact_lock(7777);
  SELECT * INTO s FROM verify.statement WHERE id=p_statement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown statement' USING ERRCODE='22023'; END IF;
  SELECT max(id) INTO head FROM ops.publication;
  IF head IS NULL THEN RAISE EXCEPTION 'no publication snapshot' USING ERRCODE='23514'; END IF;
  SELECT balance_orientation INTO orientation FROM core.account WHERE account_id=s.account_id;
  SELECT * INTO prior FROM verify.statement WHERE account_id=s.account_id AND upper(period)=lower(s.period)
    ORDER BY lower(period) DESC,version DESC,id LIMIT 1;
  opening_ok:=prior.id IS NULL OR s.opening_balance=prior.closing_balance;
  SELECT coalesce(sum(amount),0),coalesce(sum(-amount) FILTER(WHERE amount<0),0),
    coalesce(sum(amount) FILTER(WHERE amount>0),0),coalesce(jsonb_agg(jsonb_build_object(
      'transaction_id',transaction_id,'revision',revision,'revision_publication_id',revision_publication_id,
      'posted_date',posted_date,'amount',amount) ORDER BY transaction_id),'[]')
    INTO fact_sum,debits,credits,facts
    FROM core.transaction WHERE org_id=s.org_id AND account_id=s.account_id
      AND status='active' AND NOT pending AND posted_date <@ s.period;
  closing_ok:=s.closing_balance=s.opening_balance+CASE WHEN orientation='liability' THEN -fact_sum ELSE fact_sum END;
  debit_diff:=s.debits_total-debits; credit_diff:=s.credits_total-credits;
  -- References must agree on amount, but may identify a fact anywhere in-period.
  -- Other candidates always use the full window (including exact-date candidates).
  SELECT coalesce(jsonb_agg(jsonb_build_object('l',l.id,'t',t.transaction_id,
    'exact',coalesce(l.bank_posted_date,l.qbo_txn_date)=t.posted_date,'ref',c.ref,
    'corroboration',CASE WHEN c.ref THEN 'reference: '||l.reference
      WHEN c.payee THEN 'payee: '||l.description ELSE NULL END) ORDER BY l.line_no,t.transaction_id),'[]') INTO edges
  FROM verify.statement_line l JOIN core.transaction t ON t.org_id=l.org_id AND t.account_id=s.account_id AND t.amount=l.amount
  CROSS JOIN LATERAL (SELECT
    nullif(btrim(l.reference),'') IS NOT NULL AND
      (l.reference=t.check_number OR strpos(lower(coalesce(t.description_raw,'')),lower(l.reference))>0) AS ref,
    nullif(btrim(l.description),'') IS NOT NULL AND l.description NOT IN ('Expense','Deposit','Transfer','Check','Payment','Credit Card Expense')
      AND strpos(lower(coalesce(t.description_raw,'')),lower(l.description))>0 AS payee) c
  WHERE l.statement_id=s.id AND t.status='active' AND NOT t.pending AND t.posted_date <@ s.period
    AND (c.ref OR abs(t.posted_date-coalesce(l.bank_posted_date,l.qbo_txn_date))<=3);
  -- Select batches with mutual uniqueness. Never choose by row order. Repeat only
  -- after justified matches remove vertices; a reference can disambiguate a group.
  FOR phase IN 1..2 LOOP
    LOOP
      WITH e AS (SELECT value FROM jsonb_array_elements(edges)), eligible AS (
        SELECT value FROM e WHERE CASE WHEN phase=1 THEN (value->>'ref')::bool ELSE
          ((SELECT count(*) FROM e x WHERE x.value->>'l'=e.value->>'l')=1
           AND (SELECT count(*) FROM e x WHERE x.value->>'t'=e.value->>'t')=1)
          OR value->>'corroboration' IS NOT NULL END
      ), unique_edges AS (
        SELECT value FROM eligible e WHERE
          (SELECT count(*) FROM eligible x WHERE x.value->>'l'=e.value->>'l')=1 AND
          (SELECT count(*) FROM eligible x WHERE x.value->>'t'=e.value->>'t')=1
      ) SELECT coalesce(jsonb_agg(value||jsonb_build_object('method',CASE WHEN (value->>'ref')::bool THEN 'reference'
        WHEN (value->>'exact')::bool
          AND (SELECT count(*) FROM e x WHERE x.value->>'l'=u.value->>'l')=1
          AND (SELECT count(*) FROM e x WHERE x.value->>'t'=u.value->>'t')=1
          THEN 'exact' ELSE 'window' END,
        'corroboration',coalesce(value->>'corroboration','unique amount/date within +/-3 days')) ORDER BY value->>'l',value->>'t'),'[]') INTO chosen FROM unique_edges u;
      EXIT WHEN jsonb_array_length(chosen)=0;
      matches:=matches||chosen;
      SELECT coalesce(jsonb_agg(value),'[]') INTO edges FROM jsonb_array_elements(edges) e
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(chosen) c WHERE c->>'l'=e.value->>'l' OR c->>'t'=e.value->>'t');
    END LOOP;
  END LOOP;
  unresolved:=jsonb_array_length(edges);
  SELECT count(*) INTO unmatched_lines FROM verify.statement_line l WHERE statement_id=s.id
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(matches||edges) e WHERE e->>'l'=l.id::text);
  SELECT count(*) INTO unmatched_transactions FROM jsonb_array_elements(facts) t
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(matches||edges) e WHERE e->>'t'=t->>'transaction_id');
  SELECT coalesce(a.adjustments,'[]') INTO adjustments FROM verify.statement_adjustment a WHERE a.statement_id=s.id;
  adjustments:=coalesce(adjustments,'[]');
  FOR adjustment,adjustment_no IN SELECT value,ordinality FROM jsonb_array_elements(adjustments) WITH ORDINALITY LOOP
    -- A resolution persists across reruns of the same immutable statement evidence.
    SELECT e.* INTO old_exception FROM verify.exception e JOIN verify.recon_run r ON r.id=e.recon_run_id
      WHERE r.statement_id=s.id AND e.evidence->'adjustment'=adjustment AND e.evidence->>'adjustment_no'=adjustment_no::text
        AND nullif(btrim(e.owner),'') IS NOT NULL AND e.resolved_at IS NOT NULL
      ORDER BY e.resolved_at DESC,e.id LIMIT 1;
    IF old_exception.id IS NULL THEN unresolved_exceptions:=unresolved_exceptions+1; END IF;
  END LOOP;
  result:=CASE WHEN opening_ok AND closing_ok AND debit_diff=0 AND credit_diff=0
    AND unmatched_lines=0 AND unmatched_transactions=0 AND unresolved=0
    THEN CASE WHEN unresolved_exceptions=0 THEN 'pass' ELSE 'fail_with_exceptions' END ELSE 'fail' END;
  detail:=jsonb_build_object('anchor',prior.id IS NULL,'prior_statement_id',prior.id,
    'balance_orientation',orientation,'facts',facts,'unresolved_candidates',edges,'unresolved_exceptions',unresolved_exceptions,
    'unmatched_lines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY line_no),'[]') FROM verify.statement_line l
      WHERE statement_id=s.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(matches) m WHERE m->>'l'=l.id::text)),
    'unmatched_transactions',(SELECT coalesce(jsonb_agg(t),'[]') FROM jsonb_array_elements(facts) t
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(matches) m WHERE m->>'t'=t->>'transaction_id')));
  INSERT INTO verify.recon_run(org_id,id,account_id,statement_id,publication_id,ran_by,result,opening_ok,closing_ok,
    debit_diff,credit_diff,unmatched_lines,unmatched_transactions,unresolved_pairs,detail)
  VALUES(s.org_id,rid,s.account_id,s.id,head,session_user,result,opening_ok,closing_ok,debit_diff,credit_diff,
    unmatched_lines,unmatched_transactions,unresolved,detail);
  INSERT INTO verify.recon_match(org_id,recon_run_id,statement_line_id,transaction_id,method,corroboration)
    SELECT s.org_id,rid,(m->>'l')::uuid,(m->>'t')::uuid,m->>'method',m->>'corroboration' FROM jsonb_array_elements(matches) m;
  FOR adjustment,adjustment_no IN SELECT value,ordinality FROM jsonb_array_elements(adjustments) WITH ORDINALITY LOOP
    SELECT e.* INTO old_exception FROM verify.exception e JOIN verify.recon_run r ON r.id=e.recon_run_id
      WHERE r.statement_id=s.id AND e.evidence->'adjustment'=adjustment AND e.evidence->>'adjustment_no'=adjustment_no::text
        AND nullif(btrim(e.owner),'') IS NOT NULL AND e.resolved_at IS NOT NULL
      ORDER BY e.resolved_at DESC,e.id LIMIT 1;
    INSERT INTO verify.exception(org_id,recon_run_id,amount,description,evidence,owner,resolved_at)
    VALUES(s.org_id,rid,(adjustment->>'amount')::numeric,adjustment->>'description',
      coalesce(old_exception.evidence,jsonb_build_object('adjustment',adjustment,'adjustment_no',adjustment_no,'file_sha256',s.file_sha256)),
      old_exception.owner,old_exception.resolved_at);
  END LOOP;
  INSERT INTO verify.recon_supersession(org_id,superseded_run_id,superseding_run_id,publication_id,cause)
    SELECT s.org_id,r.id,rid,head,'statement rerun' FROM verify.recon_run r WHERE r.statement_id=s.id AND r.id<>rid
      AND NOT EXISTS(SELECT 1 FROM verify.recon_supersession x WHERE x.superseded_run_id=r.id);
  IF result<>'pass' THEN
    INSERT INTO verify.invalidation(org_id,certification_id,cause,publication_id)
      SELECT s.org_id,c.id,'rerun_failed',head FROM verify.certification c JOIN verify.recon_run r ON r.id=c.recon_run_id
      WHERE r.statement_id=s.id AND NOT EXISTS(SELECT 1 FROM verify.invalidation i
        WHERE i.certification_id=c.id AND i.superseding_certification_id IS NULL);
  END IF;
  RETURN rid;
END $$;
REVOKE ALL ON FUNCTION verify.record_statement_adjustments(uuid,jsonb),verify.resolve_exception(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify.record_statement_adjustments(uuid,jsonb),verify.resolve_exception(uuid,text,text),verify.run_reconciliation(uuid) TO ll_verify;
-- 090 runs after this migration on a fresh database; explicit table grants also
-- make an incremental migration behave identically on an existing deployment.
GRANT SELECT ON verify.statement_adjustment TO ll_verify,ll_reader,ll_backup;
