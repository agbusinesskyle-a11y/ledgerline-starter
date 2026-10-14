CREATE TABLE verify.statement (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  version int NOT NULL,
  period daterange NOT NULL,
  opening_balance numeric(14,2),
  closing_balance numeric(14,2),
  debits_total numeric(14,2),
  credits_total numeric(14,2),
  line_count int,
  source text CHECK (source IN ('qbo_reconciliation','bank_csv','bank_pdf_transcribed')),
  file_sha256 text,
  file_uri text,
  columns_seen text[],
  entered_by text,
  entered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, account_id) REFERENCES core.account (org_id, account_id),
  UNIQUE (account_id, period, version)
);
CREATE TABLE verify.statement_line (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  statement_id uuid NOT NULL,
  line_no int NOT NULL,
  qbo_txn_date date,
  bank_posted_date date,
  cleared_period daterange NOT NULL,
  amount numeric(14,2),
  description text,
  reference text,
  qbo_txn_ref text,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, statement_id) REFERENCES verify.statement (org_id, id),
  UNIQUE (statement_id, line_no)
);
CREATE TABLE verify.recon_run (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  publication_id bigint NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  ran_by text,
  result text CHECK (result IN ('pass','fail','fail_with_exceptions')),
  opening_ok bool,
  closing_ok bool,
  debit_diff numeric(14,2),
  credit_diff numeric(14,2),
  unmatched_lines int,
  unmatched_transactions int,
  unresolved_pairs int,
  detail jsonb,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, account_id) REFERENCES core.account (org_id, account_id),
  FOREIGN KEY (org_id, statement_id) REFERENCES verify.statement (org_id, id)
);
CREATE TABLE verify.recon_match (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  recon_run_id uuid NOT NULL,
  statement_line_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  method text CHECK (method IN ('reference','exact','window','human')),
  corroboration text,
  actor text,
  reason text,
  FOREIGN KEY (org_id, recon_run_id) REFERENCES verify.recon_run (org_id, id),
  FOREIGN KEY (org_id, statement_line_id) REFERENCES verify.statement_line (org_id, id),
  FOREIGN KEY (org_id, transaction_id) REFERENCES core.transaction (org_id, transaction_id),
  UNIQUE (recon_run_id, statement_line_id),
  UNIQUE (recon_run_id, transaction_id)
);
CREATE TABLE verify.recon_supersession (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  superseded_run_id uuid NOT NULL,
  superseding_run_id uuid NOT NULL,
  publication_id bigint NOT NULL,
  cause text,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, superseded_run_id) REFERENCES verify.recon_run (org_id, id),
  FOREIGN KEY (org_id, superseding_run_id) REFERENCES verify.recon_run (org_id, id)
);
CREATE TABLE verify.exception (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  recon_run_id uuid NOT NULL,
  amount numeric(14,2),
  description text,
  evidence jsonb,
  owner text,
  expires_on date,
  resolved_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, recon_run_id) REFERENCES verify.recon_run (org_id, id)
);
CREATE TABLE verify.certification (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  period daterange NOT NULL,
  recon_run_id uuid NOT NULL,
  publication_id bigint NOT NULL,
  certified_at timestamptz NOT NULL DEFAULT now(),
  certified_by text,
  export_uri text,
  export_sha256 text,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, account_id) REFERENCES core.account (org_id, account_id),
  FOREIGN KEY (org_id, recon_run_id) REFERENCES verify.recon_run (org_id, id)
);
CREATE TABLE verify.invalidation (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  certification_id uuid NOT NULL,
  cause text CHECK (cause IN ('fact_revision','ruling','currency','statement_version','rerun_failed','reassigned')),
  publication_id bigint NOT NULL,
  old_account_id uuid,
  old_posted_date date,
  new_account_id uuid,
  new_posted_date date,
  detected_at timestamptz NOT NULL DEFAULT now(),
  superseding_certification_id uuid,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, certification_id) REFERENCES verify.certification (org_id, id),
  FOREIGN KEY (org_id, old_account_id) REFERENCES core.account (org_id, account_id),
  FOREIGN KEY (org_id, new_account_id) REFERENCES core.account (org_id, account_id),
  FOREIGN KEY (org_id, superseding_certification_id) REFERENCES verify.certification (org_id, id)
);
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON verify.recon_run
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON verify.recon_match
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON verify.certification
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
