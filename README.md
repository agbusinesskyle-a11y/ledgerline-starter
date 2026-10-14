# ledgerline (starter)

ledgerline is a small, careful "bank feed" service. It connects to your banks through
[Plaid](https://plaid.com), pulls every transaction and balance for every account, and keeps
them in your own Postgres database — permanently, with a full history of what the bank said and
when. It never edits or deletes what a bank reported; corrections arrive as new facts.

It does **not** do bookkeeping. Its job is to be the trustworthy source of "what happened in the
bank". Your bookkeeping app — **Financial Books** — reads from it.

What it keeps for you:

- **Bank connections** — each bank login you connect through Plaid (tokens stored encrypted).
- **Transactions** — posted and pending, with every later correction kept.
- **Balances** — current/available balance snapshots for each account over time.
- **Account ownership** — which of your companies owns which account (you decide; stored with dates).
- **Verified months** — optional: months you have proven match a bank reconciliation report.

Everything Financial Books needs is published through read-only **`serve.*` views**
(`serve.v_transaction_current`, `serve.v_transaction_pending`, `serve.v_cash_position`,
`serve.v_debt_position`, `serve.v_account_coverage`, `serve.v_verified_intervals`, ...).

> This is a starter copy: no real data, no one else's keys. You create your own Plaid account,
> your own secrets and your own database. **If you have Claude helping you, point it at
> [SETUP-FOR-CLAUDE.md](SETUP-FOR-CLAUDE.md)** — it is a step-by-step script it can follow.

---

## How it pairs with Financial Books

```
  your banks ──Plaid──▶ ledgerline (sync, every 3 h) ──▶ Postgres
                                                           │  serve.* views
                                                           ▼  (read-only role ll_reader)
                                                     Financial Books
```

On the **Financial Books** side you set two variables:

| Financial Books variable | Value |
|---|---|
| `LEDGERLINE_URL` | A Postgres URL that logs in as ledgerline's **read-only** role `ll_reader`, e.g. `postgres://ll_reader:<ROLE_PASSWORD_LL_READER>@<ledgerline-db-host>:5432/<db>` |
| `LEDGERLINE_ORG_ID` | Your ledgerline organization id. Unless you changed it in `migrations/030_seed_org.sql` it is `00000000-0000-4000-8000-000000000001`. |

How to find your org id: locally run `npm run local -- org-id`; on any connection to the
database run `SELECT org_id, slug, name FROM core.org;` (admin) or
`SELECT DISTINCT org_id FROM core.entity;` (as `ll_reader`).

`ll_reader` can only read the `serve.*` views, the `verify.*` tables and the company/account
tables — never Plaid tokens or raw bank responses.

---

## What you need

- **Node.js 22** (`node --version` should say v22.x).
- **PostgreSQL 16 or newer** on your computer for local use (the Railway template uses 18).
- **A Plaid account** (free to sign up at https://dashboard.plaid.com). Sandbox is free and uses
  fake banks; real banks need Plaid's production approval, which you request in their dashboard.
- Optional later: a Railway account (hosting), an S3-compatible bucket such as Cloudflare R2
  (backups), Twilio (text alerts), a heartbeat monitor (missed-run alerts).

## Local setup, step by step

1. **Get the code and install**
   ```sh
   npm ci
   ```
2. **Create your own secrets** (never reuse anyone else's):
   ```sh
   npm run setup
   ```
   This writes `.env` (your settings) and `.secrets/` (your backup key and a note of your
   web-page password and two-factor code). It refuses to overwrite existing files. Open
   `.secrets/SAVE-THESE-THEN-DELETE.txt`, put everything in your password manager, add the
   two-factor code to an authenticator app, then delete that note. Keep `.secrets/backup.age.key`
   somewhere safe offline.
3. **Add your Plaid keys** to `.env` — from https://dashboard.plaid.com:
   - *Developers → Keys*: `client_id` → `PLAID_CLIENT_ID`; the **Sandbox** secret → `PLAID_SECRET`.
   - *Developers → API → Allowed redirect URIs*: add `http://localhost:3000/link/oauth`.
   - Keep `PLAID_ENV=sandbox` for now.
4. **Name your companies.** Edit `migrations/030_seed_org.sql` *before the first migrate*:
   change the organization name and replace the example companies (`Example Company LLC`,
   `Example Farm LLC`, `Personal`) and the example division with your own. (You can also leave
   them and add your real companies later with the ownership file — see below.)
5. **Create the database.** Make an empty database (for example `createdb ledgerline`) on a
   Postgres server that has no other ledgerline copy on it (ledgerline creates server-wide roles
   named `ll_*`). Put its admin URL in `.env` as `LOCAL_PG_ADMIN_URL`, then:
   ```sh
   npm run local -- migrate
   ```

## Connect your first bank (sandbox first)

1. `npm run local -- app`, then open http://localhost:3000/login in Chrome.
2. Log in with your web-page password and the 6-digit code from your authenticator.
3. Go to http://localhost:3000/link and click **Connect bank**. In sandbox pick any bank
   (e.g. "First Platypus Bank") and log in with **user_good / pass_good**.
4. The page says "Bank connected". Connect more banks the same way.

## Run a sync

```sh
npm run local -- sync
```

The first sync inventories the new connection's accounts and pulls up to two years of history
(in sandbox: fake transactions). Run it again any time; on Railway it runs every 3 hours.
New accounts raise a "new account needs assignment" warning, and their transactions stay out of
the `serve.*` views (so Financial Books won't see them) until you assign them to a company.

## Tell ledgerline which company owns each account

1. Copy `docs/rulings/EXAMPLE-ownership.json` to e.g. `docs/rulings/my-ownership.json`.
2. List your companies (`entities`), any divisions (`dimensions`) and every account
   (`institution` + last-4 `mask` exactly as Plaid reports them, a friendly `name`, the owning `entity`).
3. Dry run (changes nothing; it tells you exactly which accounts are missing or don't match):
   ```sh
   npm run local -- ownership docs/rulings/my-ownership.json
   ```
4. When the dry run is clean, apply it:
   ```sh
   npm run local -- ownership docs/rulings/my-ownership.json --apply
   ```

Your ownership file contains your account names and last-4 digits — keep your own copy of this
repository **private**.

## Going live with real banks

When sandbox works: in the Plaid dashboard request production access, then change
`PLAID_ENV=production` and `PLAID_SECRET` to your **production** secret. Banks connected in
sandbox stay sandbox data; start your real database fresh (new empty database, migrate again).

## Run the tests

The tests need a **throwaway** Postgres server you don't use for anything else (they create and
drop roles server-wide). With one listening on port 5499 with no password for user `postgres`:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5499/postgres npm test
```

Put the Postgres programs (`pg_dump`, `psql`) on your PATH first. The tests never call real Plaid
(they use a local fake). On Windows two backup tests fail because Windows has no Unix file
permissions and its `pg_dump` words an error differently; on Linux/macOS (and GitHub Actions,
see `.github/workflows/ci.yml`) everything passes.

---

## Deploy your own copy to Railway

Everything lives in **one Railway project of your own**. All services build from this repository's
`Dockerfile`; you only change each service's start command / schedule.

1. **Project + database.** Create a new project, add **PostgreSQL** from Railway's templates.
   Keep it **private**: do not enable a public TCP proxy. Services reach it over Railway's private
   network using reference variables such as `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}` and
   `${{Postgres.PGDATABASE}}` (replace `Postgres` with your database service's name if different).
   The `Dockerfile` installs the Postgres 18 client to match Railway's template; if your database
   is another major version, change `PG_CLIENT_VERSION` and the package name in the `Dockerfile`.
2. **Push your copy of this repo to your own private GitHub repo**, then add it to the project
   four times as four services:

   | Service | Start command | Schedule / restart | Variables |
   |---|---|---|---|
   | `migrate` | `node services/migrate/index.js` | runs on each deploy; restart policy **Never** | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, the six `ROLE_PASSWORD_LL_*` |
   | `app` | `node services/app/index.js` | always on; healthcheck path `/healthz`; generate a public domain | `DATABASE_URL` as `ll_app`, `TOKEN_KEK`, `APP_LOGIN_PASSWORD_HASH`, `APP_TOTP_SECRET`, `APP_SESSION_SECRET`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `PLAID_PRODUCTS`, `LINK_REDIRECT_URI=https://<your-app-domain>/link/oauth`, `LL_ORG_SLUG` (+ optional Twilio / `HEALTHCHECKS_PING_ALERTS`) |
   | `sync` | `node services/sync/index.js` | cron `17 */3 * * *` (UTC) | `DATABASE_URL` as `ll_sync`, `TOKEN_KEK`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `LL_ORG_SLUG`, `PG_QUERY_TIMEOUT_MS=900000` (+ optional `SYNC_DEADLINE_MIN`, Twilio, `HEALTHCHECKS_PING_SYNC/COVERAGE/ALERTS`) |
   | `backup` | `node services/backup/index.js` | cron `41 */6 * * *` (UTC) | `DATABASE_URL` as `ll_backup`, `PG_SUPER_DATABASE_URL=${{Postgres.DATABASE_URL}}`, `LL_ORG_SLUG`, all `BACKUP_*`, optional `HEALTHCHECKS_PING_BACKUP` |

   A role URL looks like
   `postgres://ll_app:<ROLE_PASSWORD_LL_APP>@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}`.
   Use **new** random values on Railway (run `npm run setup -- --env-file .env.railway --secrets-dir .secrets-railway`
   to generate a fresh set) and mark the secret ones as *sealed*. Keep the backup private key
   off Railway. Add `https://<your-app-domain>/link/oauth` to Plaid's allowed redirect URIs.
3. Deploy `migrate` first and check its log ends successfully, then deploy the others.
4. Open `https://<your-app-domain>/login`, connect banks, and let `sync` run (or trigger it).
5. **Financial Books in the same project.** Add your Financial Books service to this *same*
   Railway project so it reads ledgerline over the private network, with
   `LEDGERLINE_URL=postgres://ll_reader:<ROLE_PASSWORD_LL_READER>@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${{Postgres.PGDATABASE}}`
   and `LEDGERLINE_ORG_ID=00000000-0000-4000-8000-000000000001` (or your own org id).
6. To apply your ownership file on Railway, commit it to your private repo, redeploy, open a
   shell in the `app` service (`railway ssh`) and run
   `DATABASE_URL=<ll_verify URL> node scripts/apply-ownership.js docs/rulings/my-ownership.json` (dry run), then add `--apply`.

Secrets and restores: [scripts/gen-keys.md](scripts/gen-keys.md) and
[scripts/drill.md](scripts/drill.md). How it works inside:
[docs/TECHNICAL-REFERENCE.md](docs/TECHNICAL-REFERENCE.md). Every setting: [.env.example](.env.example).

## License

MIT — see [LICENSE](LICENSE).
