-- Sync must resolve unknown commit outcomes by reading the durable receipt by
-- attempt_id (§4.5). Grant only its lookup key and publication ID: no table-wide
-- raw reads, payload access, or direct writes are added to the runtime role.
GRANT SELECT (attempt_id, publication_id) ON raw.sync_acceptance TO ll_sync;
