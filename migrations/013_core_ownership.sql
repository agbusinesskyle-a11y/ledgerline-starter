CREATE TABLE core.entity (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  entity_id uuid DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  legal_name text,
  legal_form text,
  tax_classification text,
  parent_entity_id uuid,
  has_books bool NOT NULL,
  active bool NOT NULL,
  PRIMARY KEY (entity_id),
  UNIQUE (org_id, entity_id),
  FOREIGN KEY (org_id, parent_entity_id) REFERENCES core.entity (org_id, entity_id)
);
CREATE FUNCTION core.entity_acyclic() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  -- Serialize hierarchy writes so simultaneous opposite links cannot form a cycle.
  PERFORM pg_advisory_xact_lock(7777);
  IF NEW.parent_entity_id = NEW.entity_id OR EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT entity_id, parent_entity_id FROM core.entity
      WHERE org_id = NEW.org_id AND entity_id = NEW.parent_entity_id
      UNION
      SELECT e.entity_id, e.parent_entity_id FROM core.entity e
      JOIN ancestors a ON e.entity_id = a.parent_entity_id AND e.org_id = NEW.org_id
    ) SELECT 1 FROM ancestors WHERE entity_id = NEW.entity_id
  ) THEN RAISE EXCEPTION 'entity hierarchy cycle' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER entity_acyclic BEFORE INSERT OR UPDATE ON core.entity
FOR EACH ROW EXECUTE FUNCTION core.entity_acyclic();
CREATE TABLE core.dimension (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  dimension_id uuid DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL,
  slug text NOT NULL,
  display_name text NOT NULL,
  PRIMARY KEY (dimension_id),
  UNIQUE (org_id, dimension_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES core.entity (org_id, entity_id),
  UNIQUE (org_id, slug)
);
CREATE TABLE core.account_entity (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  dimension_id uuid,
  valid daterange NOT NULL,
  reason text,
  ruled_by text,
  publication_id bigint NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, account_id) REFERENCES core.account (org_id, account_id),
  FOREIGN KEY (org_id, entity_id) REFERENCES core.entity (org_id, entity_id),
  FOREIGN KEY (org_id, dimension_id) REFERENCES core.dimension (org_id, dimension_id),
  EXCLUDE USING gist (account_id WITH =, valid WITH &&)
);
CREATE FUNCTION core.check_dimension_entity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core, raw, verify, ops AS $$
BEGIN
  IF NEW.dimension_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.dimension WHERE org_id = NEW.org_id
      AND dimension_id = NEW.dimension_id AND entity_id = NEW.entity_id
  ) THEN RAISE EXCEPTION 'dimension does not belong to entity' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dimension_entity BEFORE INSERT OR UPDATE ON core.account_entity
FOR EACH ROW EXECUTE FUNCTION core.check_dimension_entity();
CREATE TABLE core.account_reporting_scope (
  org_id uuid NOT NULL REFERENCES core.org(org_id),
  id uuid DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  scope text CHECK (scope IN ('included','excluded')),
  valid daterange NOT NULL,
  reason text,
  ruled_by text,
  publication_id bigint NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, account_id) REFERENCES core.account (org_id, account_id),
  EXCLUDE USING gist (account_id WITH =, valid WITH &&)
);
