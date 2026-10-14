CREATE TABLE raw.api_call (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id bigserial,
  connection_id uuid,
  endpoint text NOT NULL,
  api_version text,
  request_options jsonb,
  plaid_request_id text,
  http_status int,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb,
  error_type text,
  error_code text,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, connection_id) REFERENCES core.source_connection (org_id, connection_id)
);
CREATE TABLE raw.sync_page (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id bigserial,
  attempt_id bigint NOT NULL,
  page_no int NOT NULL CHECK (page_no > 0),
  api_call_id bigint NOT NULL,
  cursor_in text,
  cursor_out text,
  has_more bool NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, api_call_id) REFERENCES raw.api_call (org_id, id),
  UNIQUE (attempt_id, page_no)
);
CREATE TABLE raw.sync_acceptance (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  publication_id bigint,
  connection_id uuid NOT NULL,
  attempt_id bigint NOT NULL UNIQUE,
  predecessor_publication_id bigint,
  cursor_in text,
  cursor_out text NOT NULL,
  page_ids bigint[] NOT NULL,
  projection_version int NOT NULL CHECK (projection_version > 0),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publication_id),
  UNIQUE (org_id, publication_id),
  FOREIGN KEY (org_id, connection_id) REFERENCES core.source_connection (org_id, connection_id)
);
CREATE FUNCTION raw.validate_acceptance_pages() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
DECLARE n int := cardinality(NEW.page_ids);
BEGIN
  IF n = 0 OR array_ndims(NEW.page_ids) IS DISTINCT FROM 1 OR (
    SELECT count(*) FROM unnest(NEW.page_ids) WITH ORDINALITY AS requested(id, ordinal)
    JOIN raw.sync_page p ON p.id = requested.id AND p.org_id = NEW.org_id
      AND p.attempt_id = NEW.attempt_id AND p.page_no = requested.ordinal
  ) <> n THEN
    RAISE EXCEPTION 'invalid acceptance pages: expected this attempt and page numbers 1..n' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_pages BEFORE INSERT ON raw.sync_acceptance
FOR EACH ROW EXECUTE FUNCTION raw.validate_acceptance_pages();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON raw.api_call
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON raw.sync_page
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
CREATE TRIGGER immutable_guard BEFORE UPDATE OR DELETE ON raw.sync_acceptance
FOR EACH ROW EXECUTE FUNCTION meta.immutable_guard();
