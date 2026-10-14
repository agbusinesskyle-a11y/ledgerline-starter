# ledgerline — technical reference

Deeper notes for whoever maintains this code. For setup, read the top-level README.md
and SETUP-FOR-CLAUDE.md first.

ledgerline keeps one Postgres database holding every observed bank transaction for every
account of every company you own — correctly, continuously, rebuildable from immutable raw
observations, and verifiable against independent reconciliation evidence. It deliberately
does facts only: no categories, no ledger, no UI beyond the Plaid Link page.

Design rules:
- Raw observations are never updated or deleted; projections (`core.*`) are rebuildable from them.
- Decisions about which company owns which account ("rulings") are stored as data, with dates.
- Every service runs as its own least-privilege database role.
- Tenant-aware schema (`org_id` everywhere), single-tenant deploy.

The "Step" names below are the build stages the code was written in; test files are named after them.

## Run

Prerequisites: Node.js 22 and Postgres 16 binaries (CI uses `/usr/lib/postgresql/16/bin`). Install dependencies with `npm ci`.

Run the gate against a throwaway superuser cluster with trust authentication:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5499/postgres npm test
```

`TEST_DATABASE_URL` defaults to that URL. The harness creates a fresh `ll_test_<random>` database, runs migrations, and drops the database and its newly created cluster roles afterward. Use a dedicated test cluster; migration 000 deliberately rejects existing ledgerline roles or schemas.

Apply migrations to a fresh deployment with a privileged bootstrap connection:

```sh
DATABASE_URL=postgres://postgres@127.0.0.1:5499/ledgerline npm run migrate
```

`MIGRATE_DATABASE_URL` may be used instead (it takes precedence). Migrations run once in lexical order under an advisory lock; changing an applied SQL file produces a checksum error and exit code 2. Subsequent migrations run as `ll_owner`. The bootstrap administrator creates the NOLOGIN owner and runtime roles; after successful migrations the migrator enables LOGIN and sets runtime passwords for each present `ROLE_PASSWORD_LL_*` variable using bound parameters. `ll_owner` remains NOLOGIN.

Only the test harness runs `ALTER ROLE <runtime-role> LOGIN PASSWORD '<runtime-role>'` after migration so tests can connect as each role. Production migrations never enable LOGIN or set passwords; `ll_owner` remains NOLOGIN in the harness. Callable SQL routines use `SELECT` and return identifiers. The acceptance procedure's `p_dry_run_publication_only` option is exclusively for the Step 0 ordering test; acceptance projects facts in Step 2a; reconciliation matching remains the `not implemented (step 5)` stub.

`npm test` runs all suites with `node --test --test-concurrency=1 test/*.test.js`. Serial execution isolates their cluster-wide role fixtures; each suite uses its own temporary database.

## Step 2a

Migration `020_apply_body.sql` implements SQL acceptance, rulings, and projection replay. `core.accept_publication` accepts canonical JSON transitions in array order: `pending_claim` (sorted by claimant external ID), `upsert`, `removed`, then `quarantine` (each sorted by external ID). Every element carries `external_id` and numeric `api_call_id`; claims also carry `object_external_id`, upserts/claims carry the unchanged Plaid `obj`, and quarantines carry `quarantine_kind` and `obj`. Drop removals of pending IDs promoted by a claim in that acceptance. Balance elements carry `external_account_id`, `current`, `available`, `limit`, `iso_currency_code`, `api_call_id`, and `provider_as_of`. Amounts invert Plaid's sign on write. `core.reduce_pages(bigint[])` is the SQL reference reducer for Step 2b.

Run `SELECT core.rebuild_projections();` as `ll_rebuild`. Replay reads durable allocations and decisions, rebuilds all eleven projection tables, preserves verification evidence, and appends a `rebuild_marker` with row counts. Missing replay inputs abort the entire rebuild. Human identity decisions use `core.apply_ruling` with `subject_connection_id`/`subject_external_id` in `after`; `relink_merge` adds `object_connection_id`/`object_external_id`. For `reversal`, pass the prior decision ID as the subject. Assignment rulings use a source-account subject and `account_id` (optional `account` metadata for a new ruled account); ownership/scope rulings use an account subject and `valid_from`/optional `valid_to` dates or a `valid` daterange. Step 2b supplies the matching Node reducer, sync loop, and local Plaid stub.

## Step 2b

Run `node services/sync/index.js` with `DATABASE_URL` for `ll_sync`, `TOKEN_KEK`,
`PLAID_CLIENT_ID`, and `PLAID_SECRET`. Sync uses `PLAID_ENV` (sandbox/development/production;
default production); `PLAID_BASE_URL` overrides it for the in-process test server. Set
`PG_QUERY_TIMEOUT_MS` (e.g. 900000) on sync: a first historical acceptance is one long SQL call. `options.days_requested`
belongs to Link setup and is never sent by sync. Each connection has a five-minute
budget; `SYNC_DEADLINE_MIN` sets the process budget (default 20 minutes).

Inventory and health run daily around sync for connections in `inventoried`,
`initial_sync`, `ok`, or `retryable_error`, ordered by last acceptance time with
unsynced connections first. A newly linked connection needs its first inventory
through `inventoryConnection` before joining that schedule. The fetch loop holds a
dedicated session lock, stores each API call and page atomically, validates the
cursor chain, and publishes the complete batch. Pagination mutations restart from
the original cursor up to three times. Failed acceptance poisons the attempt;
uncertain acceptance outcomes are checked against the durable receipt on another
session. Restart retires unfinished attempts without deleting their raw pages.

`reducePages(pages, { connectionId, authorities })` is pure. Its default page-only
input covers fresh identities; the optional authority snapshot is needed to match
SQL's previous-publication duplicate-claim checks. Transitions use exactly the keys
and binary external-ID order of migration 020. The four optional async crash hooks
are `beforePagePersist`, `afterPagePersist`, `beforeAccept`, and
`afterAcceptBeforeAck`; each receives its attempt and page/batch context. A durable
acceptance found after the last hook throws returns `accepted` with `recovered:true`.

Migration `021_sync_runtime.sql` adds operational views, generated-ID column reads
for `INSERT ... RETURNING`, and an owner-only attempt-state trigger. Migration
`022_sync_receipt_read.sql` grants `ll_sync` SELECT on only `attempt_id` and
`publication_id` in `raw.sync_acceptance`, so recovery queries the durable receipt
directly by attempt on another session before deciding the outcome. If that lookup
also fails, sync propagates the uncertainty without poisoning the attempt. These
column grants preserve the existing table privilege matrix. Accepted attempts
advance the connection to `ok` atomically. Existing migrations remain checksum-locked.

Alerts use `ops.alert_rule` thresholds and deduplicate by rule and connection.
SYNC pings only on process success, COVERAGE when no unacknowledged page alerts
remain, and ALERTS when no page alerts remain undelivered. Connection failures and
process deadline expiry produce a nonzero exit. `test/step2b.test.js` exercises real
`ll_sync` permissions against the local HTTP stub, including SQL reducer parity,
crash boundaries, socket loss, concurrency, alerts, and child-process heartbeats.


## Services

All services use the root Dockerfile: digest-pinned Node 22 bookworm slim and
version-pinned PGDG Postgres 16 clients. `npm ci --omit=dev` installs only runtime
dependencies. Railway supplies each start command. Postgres uses private networking.
Cron schedules below are UTC.

| Service | Start / schedule | Behavior | Variables (names only) |
|---|---|---|---|
| Postgres | Railway template, private only | Durable bank facts | Platform-managed database credentials |
| migrate | `node services/migrate/index.js`, each deploy, restart NEVER | Locked/checksummed migrations; idempotent runtime role bootstrap | `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `ROLE_PASSWORD_LL_SYNC`, `ROLE_PASSWORD_LL_APP`, `ROLE_PASSWORD_LL_VERIFY`, `ROLE_PASSWORD_LL_BACKUP`, `ROLE_PASSWORD_LL_READER`, `ROLE_PASSWORD_LL_REBUILD` |
| sync | `node services/sync/index.js`, `17 */3 * * *` | Daily inventory/health, paginated sync, atomic publication, freshness alerts and gated heartbeats | `DATABASE_URL`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_BASE_URL`, `PG_QUERY_TIMEOUT_MS`, `LL_ORG_SLUG`, `SYNC_DEADLINE_MIN`, `TOKEN_KEK`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_ALERT_TO`, `HEALTHCHECKS_PING_ALERTS`, `HEALTHCHECKS_PING_SYNC`, `HEALTHCHECKS_PING_COVERAGE` |
| backup | `node services/backup/index.js`, `41 */6 * * *` | Snapshot-consistent custom dump and password-free globals via administrator DSN, age encryption, R2 upload, manifest, retention, success heartbeat; hard 15-minute deadline | `DATABASE_URL`, `PG_SUPER_DATABASE_URL`, `LL_ORG_SLUG`, `BACKUP_S3_BUCKET`, `BACKUP_PREFIX`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_ENDPOINT`, `BACKUP_AGE_RECIPIENT`, `BACKUP_RETENTION_DRY_RUN`, `HEALTHCHECKS_PING_BACKUP` |
| app | `node services/app/index.js`, always on, `/healthz` | ll_app health, bcrypt/TOTP login, signed sessions, authenticated Plaid Link and in-database token encryption; update mode returns 501 | `DATABASE_URL`, `PORT`, `APP_LOGIN_PASSWORD_HASH`, `APP_TOTP_SECRET`, `APP_SESSION_SECRET`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_PRODUCTS`, `PLAID_BASE_URL`, `LL_ORG_SLUG`, `LINK_REDIRECT_URI`, `TOKEN_KEK`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_ALERT_TO`, `HEALTHCHECKS_PING_ALERTS` |

Feature variables are optional at startup. A feature fails with one clear log line
naming its first missing variable; values are never logged. Missing Twilio settings
leave pages undelivered; missing heartbeat URLs warn once and do nothing. Runtime
pools reject a postgres DSN unless `ALLOW_SUPERUSER` explicitly permits it; migrate
and the administrator dump/restore commands intentionally use elevated connections.
The backup service's ordinary `DATABASE_URL` remains ll_backup. It discovers the
single seeded organization if `LL_ORG_SLUG` is absent; multiple organizations
require an explicit slug for its heartbeat.

Migration `100_step1_ops.sql` adds narrow SECURITY DEFINER organization lookup and
alert delivery functions for app/sync. Backup can only append a heartbeat via the
existing function; it has no direct table writes. The exhaustive privilege test
covers these additions and all original denials. Alert delivery holds an advisory
lock, retries three times with backoff, deduplicates pages, and pings ALERTS only
when no delivery remains pending. Twilio retries can produce a duplicate SMS if a
remote request succeeds but its response is lost; the REST endpoint has no
transaction shared with Postgres.

App login requires the CSRF challenge from `GET /login`; all Link POSTs require
session CSRF. Every response is no-store and bodies are limited to 16 KB. Sessions
expire after 24 hours and live in process memory: redeploying invalidates them.
Use one app instance for this single-operator phase. The login rate limit uses the
socket peer IP (it does not trust spoofable forwarded headers); behind Railway's
proxy it may conservatively share a quota across operators. `PLAID_BASE_URL` exists
for local mock tests; omit it on production to select the endpoint via `PLAID_ENV`.
OAuth uses a separate SameSite=Lax nonce cookie and a same-origin return reload to
preserve the session's Strict cookie. `LINK_REDIRECT_URI` must be registered in Plaid
without a query or fragment. Browser responses contain only temporary Link tokens,
never access tokens.

Retention keeps complete backup sets together: all objects at most two days old,
newest complete set in each of the current/prior 13 UTC dates, current/prior seven
ISO weeks, and current/prior 11 calendar months. Unknown keys and `evidence/` are
untouched. Incomplete uploads cannot displace complete sets. R2 has no bucket
versioning; the job performs retention itself. Ciphertext hash fragments distinguish
files, and the manifest is uploaded last as the set's commit marker. Retention
dry-run reports deletion counts without deleting objects.

Offline checks: `node --test test/step1.test.js`. Full database and service gate:
`npm test`. Restore/escrow/production monitoring instructions:
[scripts/drill.md](scripts/drill.md). Local sync tests cover cursor recovery; production PITR/R2/SMS
behaviour has to be checked on your own deployment.

## Secrets

Seal `TOKEN_KEK`, `PLAID_SECRET`, and all `APP_*` values in Railway. Seal migrate's
`ROLE_PASSWORD_LL_*` values and escrow them independently. Keep the age identity
outside Railway, in the owner's password manager/offline escrow and drill host.
Generation and setup: [scripts/gen-keys.md](scripts/gen-keys.md).

Keep `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_S3_ENDPOINT`,
and other `BACKUP_S3_*` settings unsealed: the host restore drill needs them through
`railway run`, which omits sealed variables. The endpoint and bucket are
configuration; access credentials remain secrets with restricted bucket permissions
and escrow despite being unsealed. The public age recipient is not a private key.
Railway's [sealed variable behavior](https://docs.railway.com/variables) explains
why the drill requires this distinction. `.env*` is gitignored and excluded from
the Docker build context; service logs redact sensitive field names recursively.
