CREATE TABLE core.org (
  org_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE,
  name text NOT NULL, reporting_tz text NOT NULL DEFAULT 'America/Phoenix',
  base_currency char(3) NOT NULL DEFAULT 'USD', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.source_connection (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  connection_id uuid DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source = 'plaid'),
  external_id text NOT NULL,
  institution_id text,
  institution_name text,
  access_token_enc bytea,
  state text NOT NULL CHECK (state IN ('linked','inventoried','initial_sync','ok','retryable_error','login_required','poisoned','replaced','removed')),
  cursor text,
  cursor_updated_at timestamptz,
  last_publication_id bigint,
  consent_expires_at timestamptz,
  last_error_code text,
  last_error_reason text,
  last_successful_update timestamptz,
  transactions_update_status text,
  relink_of uuid,
  replaced_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id),
  UNIQUE (org_id, connection_id),
  UNIQUE (org_id, source, external_id),
  FOREIGN KEY (org_id, relink_of) REFERENCES core.source_connection (org_id, connection_id)
);
CREATE TABLE core.connection_transition (
  from_state text NOT NULL, to_state text NOT NULL, PRIMARY KEY (from_state, to_state)
);
INSERT INTO core.connection_transition VALUES
('linked','inventoried'), ('inventoried','initial_sync'), ('initial_sync','ok'),
('initial_sync','retryable_error'), ('initial_sync','login_required'),
('ok','retryable_error'), ('ok','login_required'), ('ok','poisoned'),
('retryable_error','ok'), ('retryable_error','login_required'), ('retryable_error','poisoned'),
('login_required','ok'), ('login_required','replaced'), ('poisoned','ok'), ('poisoned','replaced'),
('ok','replaced'), ('linked','removed'), ('inventoried','removed'), ('initial_sync','removed'),
('ok','removed'), ('retryable_error','removed'), ('login_required','removed'),
('poisoned','removed'), ('replaced','removed');
CREATE FUNCTION core.enforce_connection_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT EXISTS (
    SELECT 1 FROM core.connection_transition WHERE from_state = OLD.state AND to_state = NEW.state
  ) THEN RAISE EXCEPTION 'illegal connection transition: % -> %', OLD.state, NEW.state USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_transition BEFORE UPDATE ON core.source_connection
FOR EACH ROW EXECUTE FUNCTION core.enforce_connection_transition();
-- The event trigger is attached in 015 once its target table exists.
CREATE TABLE core.source_account (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  source_account_id uuid DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  external_account_id text NOT NULL,
  external_name text,
  official_name text,
  type text,
  subtype text,
  mask text,
  persistent_account_id text,
  capability text NOT NULL CHECK (capability IN ('transactions','balance_only','unsupported','unknown')),
  first_seen_publication_id bigint NOT NULL,
  last_seen_at timestamptz NOT NULL,
  missing_since timestamptz,
  PRIMARY KEY (source_account_id),
  UNIQUE (org_id, source_account_id),
  FOREIGN KEY (org_id, connection_id) REFERENCES core.source_connection (org_id, connection_id),
  UNIQUE (connection_id, external_account_id)
);
CREATE TABLE core.identity_allocation (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  transaction_id uuid DEFAULT gen_random_uuid(),
  allocated_publication_id bigint NOT NULL,
  first_connection_id uuid NOT NULL,
  first_external_id text NOT NULL,
  PRIMARY KEY (transaction_id),
  UNIQUE (org_id, transaction_id),
  FOREIGN KEY (org_id, first_connection_id) REFERENCES core.source_connection (org_id, connection_id),
  UNIQUE (first_connection_id, first_external_id)
);
CREATE TABLE core.account_allocation (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  account_id uuid DEFAULT gen_random_uuid(),
  allocated_publication_id bigint NOT NULL,
  origin text NOT NULL CHECK (origin IN ('placeholder','ruled','relink')),
  source_account_id uuid,
  PRIMARY KEY (account_id),
  UNIQUE (org_id, account_id),
  FOREIGN KEY (org_id, source_account_id) REFERENCES core.source_account (org_id, source_account_id)
);
CREATE TABLE core.identity_decision (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  publication_id bigint NOT NULL,
  position int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pending_claim','relink_merge','duplicate_quarantine','source_authority','reversal')),
  subject_connection_id uuid NOT NULL,
  subject_external_id text NOT NULL,
  object_connection_id uuid,
  object_external_id text,
  transaction_id uuid,
  interval tstzrange,
  evidence jsonb,
  decided_by text NOT NULL,
  reverses_id uuid,
  event_key text GENERATED ALWAYS AS (kind||':'||subject_connection_id::text||':'||subject_external_id||':'||coalesce(object_external_id,'')) STORED,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  UNIQUE (publication_id, position),
  UNIQUE (event_key),
  FOREIGN KEY (org_id, subject_connection_id) REFERENCES core.source_connection (org_id, connection_id),
  FOREIGN KEY (org_id, object_connection_id) REFERENCES core.source_connection (org_id, connection_id),
  FOREIGN KEY (org_id, transaction_id) REFERENCES core.identity_allocation (org_id, transaction_id),
  FOREIGN KEY (org_id, reverses_id) REFERENCES core.identity_decision (org_id, id)
);
CREATE TABLE core.ruling_event (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  publication_id bigint NOT NULL,
  position int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assignment','entity','dimension','account_entity','reporting_scope','account_meta')),
  subject_id uuid NOT NULL,
  before jsonb,
  after jsonb NOT NULL,
  ruled_by text NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  UNIQUE (publication_id, position)
);
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON core.identity_allocation
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON core.account_allocation
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON core.identity_decision
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON core.ruling_event
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
