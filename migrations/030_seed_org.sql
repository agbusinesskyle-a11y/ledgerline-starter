-- EXAMPLE SEED. Edit this file BEFORE your first `npm run migrate` against your real database:
-- rename the organization and replace the example entities (companies) and dimension
-- (divisions/DBAs) with your own. After it has been applied, migrations are checksum-locked;
-- add or change entities later with scripts/apply-ownership.js (see docs/rulings/EXAMPLE-ownership.json).
-- The org_id below is a fixed default. Financial Books uses it as LEDGERLINE_ORG_ID.
-- Entity/dimension ids only need to be unique UUIDs; the patterned ones below are fine.
INSERT INTO core.org (org_id, slug, name) VALUES ('00000000-0000-4000-8000-000000000001', 'main', 'My Organization');
SELECT core.apply_ruling('entity', '00000000-0000-4000-8000-000000000100', $seed${"org_id": "00000000-0000-4000-8000-000000000001", "rulings": [{"kind": "entity", "subject_id": "00000000-0000-4000-8000-000000000100", "after": {"slug": "example_company", "display_name": "Example Company LLC", "has_books": true, "active": true}},{"kind": "entity", "subject_id": "00000000-0000-4000-8000-000000000101", "after": {"slug": "example_farm", "display_name": "Example Farm LLC", "has_books": true, "active": true}},{"kind": "entity", "subject_id": "00000000-0000-4000-8000-000000000102", "after": {"slug": "personal", "display_name": "Personal", "has_books": false, "active": true}},{"kind": "dimension", "subject_id": "00000000-0000-4000-8000-000000000200", "after": {"slug": "example_division", "display_name": "Example Division", "entity_id": "00000000-0000-4000-8000-000000000100"}}]}$seed$::jsonb, 'initial entity and dimension roster', 'migration:030');
INSERT INTO ops.alert_rule (key, threshold_interval, severity, description) VALUES
('bank_update_stale', interval '36 hours', 'page', 'Bank transaction update is stale'),
('inventory_stale', interval '48 hours', 'page', 'Account inventory is stale'),
('login_required', interval '4 hours', 'page', 'Connection needs login repair'),
('poisoned_attempt', interval '0', 'page', 'Acceptance failed atomically'),
('new_account', interval '0', 'warn', 'New source account needs assignment'),
('unknown_modified', interval '0', 'warn', 'Modification has no authoritative alias'),
('competing_claim', interval '0', 'warn', 'Multiple posted transactions claim one pending transaction'),
('backup_age', interval '10 hours', 'page', 'Restorable backup is stale'),
('coverage_gap', interval '24 hours', 'warn', 'Account coverage needs attention');
