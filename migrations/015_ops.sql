CREATE SEQUENCE ops.publication_seq AS bigint;
CREATE TABLE ops.publication (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id bigint DEFAULT nextval('ops.publication_seq'),
  kind text NOT NULL CHECK (kind IN ('acceptance','inventory','ruling','certification','rebuild_marker')),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  payload jsonb,
  PRIMARY KEY (id),
  UNIQUE (org_id, id)
);
ALTER SEQUENCE ops.publication_seq OWNED BY ops.publication.id;
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON ops.publication
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TABLE ops.sync_attempt (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id bigserial,
  connection_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  cursor_in text,
  status text NOT NULL CHECK (status IN ('fetching','validating','accepting','accepted','abandoned','failed','invalid','poisoned','exhausted')),
  restarts int NOT NULL DEFAULT 0,
  ended_at timestamptz,
  error text,
  process_id text,
  publication_id bigint,
  predecessor_publication_id bigint,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, connection_id) REFERENCES core.source_connection (org_id, connection_id),
  FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id),
  FOREIGN KEY (org_id, predecessor_publication_id) REFERENCES ops.publication (org_id, id)
);
-- predecessor_publication_id captures the committed head alongside cursor_in (§4.5).
CREATE TABLE ops.connection_state_event (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  cause text,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, connection_id) REFERENCES core.source_connection (org_id, connection_id)
);
CREATE TABLE ops.heartbeat (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  service text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  ok bool NOT NULL,
  detail jsonb,
  PRIMARY KEY (id),
  UNIQUE (org_id, id)
);
CREATE TABLE ops.alert (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warn','page')),
  dedupe_key text NOT NULL,
  subject text,
  detail jsonb,
  raised_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  acknowledged_at timestamptz,
  PRIMARY KEY (id),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX open_alert_dedupe ON ops.alert (dedupe_key) WHERE acknowledged_at IS NULL;
CREATE TABLE ops.alert_rule (
  key text PRIMARY KEY, threshold_interval interval NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warn','page')), description text NOT NULL
);
CREATE FUNCTION core.log_connection_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    INSERT INTO ops.connection_state_event (org_id, connection_id, from_state, to_state, cause)
    VALUES (NEW.org_id, NEW.connection_id, OLD.state, NEW.state, NEW.last_error_code);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_state_event AFTER UPDATE ON core.source_connection
FOR EACH ROW EXECUTE FUNCTION core.log_connection_transition();
ALTER TABLE core.source_connection ADD FOREIGN KEY (org_id, last_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.source_account ADD FOREIGN KEY (org_id, first_seen_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.identity_allocation ADD FOREIGN KEY (org_id, allocated_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.account_allocation ADD FOREIGN KEY (org_id, allocated_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.identity_decision ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.ruling_event ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE raw.sync_acceptance ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE raw.sync_acceptance ADD FOREIGN KEY (org_id, predecessor_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.account_assignment ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.transaction ADD FOREIGN KEY (org_id, revision_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.transaction_alias ADD FOREIGN KEY (org_id, first_seen_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.transaction_alias ADD FOREIGN KEY (org_id, last_seen_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.transaction_revision ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.balance_observation ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.quarantine ADD FOREIGN KEY (org_id, raised_publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.account_entity ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE core.account_reporting_scope ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE verify.recon_run ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE verify.recon_supersession ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE verify.certification ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE verify.invalidation ADD FOREIGN KEY (org_id, publication_id) REFERENCES ops.publication (org_id, id);
ALTER TABLE raw.sync_page ADD FOREIGN KEY (org_id, attempt_id) REFERENCES ops.sync_attempt (org_id, id);
ALTER TABLE raw.sync_acceptance ADD FOREIGN KEY (org_id, attempt_id) REFERENCES ops.sync_attempt (org_id, id);
