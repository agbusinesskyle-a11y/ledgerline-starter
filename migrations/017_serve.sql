CREATE VIEW serve.v_verified_intervals AS
SELECT c.org_id, c.account_id, c.period, c.id AS certification_id, c.publication_id,
  c.certified_at, c.export_uri, c.export_sha256
FROM verify.certification c
WHERE NOT EXISTS (SELECT 1 FROM verify.invalidation i
  WHERE i.org_id = c.org_id AND i.certification_id = c.id AND i.superseding_certification_id IS NULL);

CREATE VIEW serve.v_account_coverage AS
SELECT a.org_id, a.account_id, a.display_name, a.kind, a.verification_method,
  sc.connection_id, sa.source_account_id, sc.state AS connection_state,
  CASE WHEN aa.reason = 'placeholder' OR aa.id IS NULL THEN 'placeholder' ELSE 'assigned' END AS assignment_state,
  coalesce(s.scope, 'included') AS scope, a.history_state,
  CASE WHEN EXISTS (SELECT 1 FROM serve.v_verified_intervals v
    WHERE v.org_id = a.org_id AND v.account_id = a.account_id) THEN 'verified'
    WHEN EXISTS (SELECT 1 FROM verify.certification c WHERE c.org_id = a.org_id AND c.account_id = a.account_id)
    THEN 'invalidated' ELSE 'unverified' END AS verification_state,
  (SELECT max(ac.accepted_at) FROM raw.sync_acceptance ac
    WHERE ac.org_id = a.org_id AND ac.connection_id = sc.connection_id) AS last_acceptance_at,
  sc.last_successful_update, sa.capability, a.coverage_gap, a.status
FROM core.account a
LEFT JOIN core.account_assignment aa ON aa.org_id = a.org_id AND aa.account_id = a.account_id AND aa.valid @> now()
LEFT JOIN core.source_account sa ON sa.org_id = aa.org_id AND sa.source_account_id = aa.source_account_id
LEFT JOIN core.source_connection sc ON sc.org_id = sa.org_id AND sc.connection_id = sa.connection_id
LEFT JOIN core.account_reporting_scope s ON s.org_id = a.org_id AND s.account_id = a.account_id AND s.valid @> current_date;

CREATE VIEW serve.v_transaction_current AS
SELECT t.*, ae.entity_id, ae.dimension_id, coalesce(s.scope, 'included') AS scope
FROM core.transaction t
JOIN core.account a ON a.org_id = t.org_id AND a.account_id = t.account_id AND a.status <> 'placeholder'
LEFT JOIN core.account_entity ae ON ae.org_id = t.org_id AND ae.account_id = t.account_id AND ae.valid @> t.posted_date
LEFT JOIN core.account_reporting_scope s ON s.org_id = t.org_id AND s.account_id = t.account_id AND s.valid @> t.posted_date
WHERE t.status = 'active' AND NOT t.pending;

CREATE VIEW serve.v_transaction_pending AS
SELECT t.*, ae.entity_id, ae.dimension_id, coalesce(s.scope, 'included') AS scope
FROM core.transaction t
JOIN core.account a ON a.org_id = t.org_id AND a.account_id = t.account_id AND a.status <> 'placeholder'
LEFT JOIN core.account_entity ae ON ae.org_id = t.org_id AND ae.account_id = t.account_id AND ae.valid @> t.posted_date
LEFT JOIN core.account_reporting_scope s ON s.org_id = t.org_id AND s.account_id = t.account_id AND s.valid @> t.posted_date
WHERE t.status = 'active' AND t.pending;

CREATE VIEW serve.v_cash_position AS
SELECT c.*, a.currency, b.current, b.available, b.observed_at, b.provider_as_of,
  (b.observed_at IS NULL OR b.observed_at < now() - interval '36 hours') AS balance_stale
FROM serve.v_account_coverage c
JOIN core.account a ON a.org_id = c.org_id AND a.account_id = c.account_id
LEFT JOIN LATERAL (SELECT o.* FROM core.balance_observation o WHERE o.org_id = c.org_id AND o.account_id = c.account_id
  ORDER BY o.observed_at DESC, o.publication_id DESC LIMIT 1) b ON true
WHERE c.kind IN ('checking','savings','money_market');

CREATE VIEW serve.v_debt_position AS
SELECT c.*, a.currency, b.current AS owed_positive, b.available, b.limit_amount, b.observed_at, b.provider_as_of,
  (b.observed_at IS NULL OR b.observed_at < now() - interval '36 hours') AS balance_stale
FROM serve.v_account_coverage c
JOIN core.account a ON a.org_id = c.org_id AND a.account_id = c.account_id
LEFT JOIN LATERAL (SELECT o.* FROM core.balance_observation o WHERE o.org_id = c.org_id AND o.account_id = c.account_id
  ORDER BY o.observed_at DESC, o.publication_id DESC LIMIT 1) b ON true
WHERE c.kind IN ('credit_card','line_of_credit','loan','mortgage');

CREATE VIEW serve.v_cash_activity_month AS
SELECT t.org_id, t.account_id, t.entity_id, t.dimension_id, t.scope,
  date_trunc('month', t.posted_date)::date AS month, t.currency,
  sum(t.amount) AS net_amount, coalesce(sum(t.amount) FILTER (WHERE t.amount > 0), 0) AS inflows,
  coalesce(sum(-t.amount) FILTER (WHERE t.amount < 0), 0) AS outflows,
  NULL::boolean AS internal_movement, c.connection_state, c.assignment_state,
  c.history_state, c.verification_state, c.capability, c.coverage_gap,
  bool_and(EXISTS (SELECT 1 FROM serve.v_verified_intervals v WHERE v.org_id = t.org_id
    AND v.account_id = t.account_id AND v.period @> t.posted_date)) AS verified
FROM serve.v_transaction_current t
JOIN core.account a ON a.org_id = t.org_id AND a.account_id = t.account_id
JOIN serve.v_account_coverage c ON c.org_id = t.org_id AND c.account_id = t.account_id
WHERE a.kind IN ('checking','savings','money_market')
GROUP BY t.org_id, t.account_id, t.entity_id, t.dimension_id, t.scope, month, t.currency,
  c.connection_state, c.assignment_state, c.history_state, c.verification_state, c.capability, c.coverage_gap;

CREATE VIEW serve.v_card_activity_month AS
SELECT t.org_id, t.account_id, t.entity_id, t.dimension_id, t.scope,
  date_trunc('month', t.posted_date)::date AS month, t.currency, sum(t.amount) AS net_amount,
  NULL::boolean AS internal_movement, c.connection_state, c.assignment_state,
  c.history_state, c.verification_state, c.capability, c.coverage_gap,
  bool_and(EXISTS (SELECT 1 FROM serve.v_verified_intervals v WHERE v.org_id = t.org_id
    AND v.account_id = t.account_id AND v.period @> t.posted_date)) AS verified
FROM serve.v_transaction_current t
JOIN core.account a ON a.org_id = t.org_id AND a.account_id = t.account_id
JOIN serve.v_account_coverage c ON c.org_id = t.org_id AND c.account_id = t.account_id
WHERE a.kind = 'credit_card'
GROUP BY t.org_id, t.account_id, t.entity_id, t.dimension_id, t.scope, month, t.currency,
  c.connection_state, c.assignment_state, c.history_state, c.verification_state, c.capability, c.coverage_gap;
