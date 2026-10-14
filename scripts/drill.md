# Step 1 restore drill (host side)

Run against a disposable local Postgres cluster of the **same major as production**
(Railway `postgres-ssl:18` today; the Dockerfile's `postgresql-client-18` pin must track
it, because `pg_dump` refuses a newer server and an 18 dump emits settings older
servers reject), never production. The target is cleaned by `pg_restore`; globals
affect cluster-wide roles, so do not use a cluster shared with another application.
Have Node 22, `npm ci`, Postgres 18 client binaries on PATH (a root-free install is
fine: `dpkg -x` the PGDG `postgresql-18`, `postgresql-client-18`, `libpq5`, plus
`libnuma1` and `liburing2` into `~/pg18/root`, then prefix `PATH` and
`LD_LIBRARY_PATH`), Railway CLI linked to project `ledgerline` / environment
`production`, and the escrow identity at `~/.ledgerline/backup.age.key` (0600).
`BACKUP_S3_*` must be unsealed on backup so `railway run` injects them. No production
private-network database connection is needed for downloading or restoring.

Record the drill start time, chosen manifest timestamp, and finish time in the
your drill notes. Gates: RTO ≤ 4 h, newest demonstrated restorable backup ≤ 8 h.
Escrow role passwords and `TOKEN_KEK` must be available locally; sealed variables
are not returned by `railway run`.

1. Create the disposable target and verify binaries:

   ```sh
   pg_dump --version
   pg_restore --version
   createdb -h 127.0.0.1 -p 5499 -U postgres ll_drill
   ```

2. Execute the exact host restore command:

   ```sh
   railway run --service backup -- node services/backup/restore.js --latest --target postgres://postgres@127.0.0.1:5499/ll_drill --identity ~/.ledgerline/backup.age.key
   ```

   Require exit 0. The tool verifies ciphertext hashes and sizes before changing
   the target, applies password-free globals first (only existing-role errors are
   tolerated), decrypts both files, restores with `--clean --if-exists --no-owner
   --no-privileges`, and prints expected/restored counts for `core.transaction`,
   `raw.api_call`, and `ops.publication`. A mismatch exits nonzero. Pin a specific
   manifest on a repeat drill with `--ts <manifest-ts>` instead of `--latest`.

3. Check restored roles, seed and migrations:

   ```sh
   psql postgres://postgres@127.0.0.1:5499/ll_drill -X -v ON_ERROR_STOP=1 <<'SQL'
   SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname LIKE 'll_%' ORDER BY rolname;
   SELECT slug FROM core.org;
   SELECT count(*) FROM meta.migration;
   SELECT count(*) FROM core.transaction;
   SELECT count(*) FROM raw.api_call;
   SELECT count(*) FROM ops.publication;
   SQL
   ```

   Require all seven roles, `ll_owner` NOLOGIN, six runtime roles without SUPERUSER,
   and counts equal to the manifest. Globals intentionally contain no passwords.
   Restore runtime passwords from escrow using the migrator's parameterized role
   bootstrap; never paste an `ALTER ROLE ... PASSWORD` literal into logged SQL.
   For a runtime failover, also restore ownership/grants: the required `--no-owner
   --no-privileges` drill restore intentionally strips these. Use the following
   host helper only on this disposable restored target:

   ```sh
   DATABASE_URL=postgres://postgres@127.0.0.1:5499/ll_drill node scripts/drill-runtime.js
   ```

   The helper assigns application schemas/tables/routines to `ll_owner`, replays
   `090_grants.sql` plus the explicit Step 1 helper grants, and applies only
   `ROLE_PASSWORD_LL_*` values present in its environment. Load those values from
   escrow in a local environment without shell tracing. It does not run migrations
   or alter stored migration checksums. Re-run the runtime privilege-denial matrix
   against this target before calling the restore production-ready.

4. Decrypt a real escrowed token and check cursor continuity without printing it:

   ```sh
   DATABASE_URL=postgres://postgres@127.0.0.1:5499/ll_drill node scripts/check-drill.js
   ```

   Load `TOKEN_KEK` locally from escrow before this command. The helper decrypts
   tokens inside Postgres with bound parameters and reports only counts, then
   checks restored connection cursors against their latest durable acceptance.
   **No token/acceptance rows is an incomplete gate**, not a pass. Record a known
   fixture Item, cursor and publication before taking the source backup, then
   resume that fixture through the real Step 2b sync loop when available. Step 1
   does not implement cursor advancement: the sync entry point explicitly says
   `step 2b pending`. A decrypt plus cursor-consistency check alone does not prove
   successful sync resumption. Restore the separately escrowed statement/export
   objects referenced by `verify.statement.file_uri` and
   `verify.certification.export_uri` from `evidence/` and verify their recorded
   hashes; these objects are never included in DB dumps or retention thinning.

5. Inspect Railway-side PITR health (read-only):

   ```sh
   railway postgres pitr status --service Postgres
   ```

   `railway postgres pitr status` is the PITR status command. Require healthy WAL
   archiving and a usable restore window. A status read is not a PITR restore
   drill: perform an isolated PITR restore separately and verify the
   same roles, token, evidence and fixture cursor. If PITR is disabled or unhealthy,
   record the gate as failed. See [Railway PITR docs](https://docs.railway.com/volumes/point-in-time-recovery).

6. In an isolated monitoring test, suppress each configured heartbeat long enough
   for its grace window and force all three SMS attempts to fail. Require observed
   escalation and pending undelivered page rows. `SYNC` is never pinged by the
   Step 1 stub; `ALERTS` is pinged only after successful delivery/no pending pages.
   A backup failure exits nonzero and never pings `BACKUP`.

7. Keep drill notes (timestamps, counts, hash results, PITR and escalation
   observations; no secrets), then delete the disposable target:

   ```sh
   dropdb -h 127.0.0.1 -p 5499 -U postgres ll_drill
   ```

The automated tests exercise local interfaces. They do not certify production
R2 restorability, PITR, escrow access, evidence hashes, SMS escalation or live OAuth.
