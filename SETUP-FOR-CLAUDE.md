# SETUP-FOR-CLAUDE.md

Instructions for an AI assistant (Claude) setting up ledgerline for its owner. Follow the steps in
order. Stop and ask the owner whenever a step says **ASK**. Read README.md once first.

## Ground rules

- Never print, paste into chat, or commit secret values (`.env`, `.secrets*/`, Plaid secrets,
  passwords, `TOKEN_KEK`, role passwords, the age private key). Refer to variables by **name**.
- Never use anyone else's keys or accounts. Every key comes from the owner's own dashboards or
  from `npm run setup`.
- Use **Plaid sandbox** until the owner explicitly says to go live.
- The owner's own repository must be **private** once it contains her ownership file.
- `npm test` needs a throwaway Postgres server: it creates and drops server-wide `ll_*` roles.
  Never point tests at a server that holds a real ledgerline or other important databases.
- Migrations are checksum-locked once applied. Never edit an applied migration; add a new one.

## Step 1 — prerequisites

1. Check `node --version` is v22.x. If not, install Node 22 (or `nvm use`, see `.nvmrc`).
2. Check a Postgres server (16+) is available and its programs (`psql`, `createdb`, `pg_dump`) are
   on PATH. If not, install PostgreSQL. **ASK** the owner before installing software.
3. Run `npm ci`.

## Step 2 — run the tests (optional but recommended)

1. Start a separate throwaway Postgres cluster on port 5499 with trust auth, e.g.
   `initdb -D <tmpdir> -A trust -U postgres` then `pg_ctl -D <tmpdir> -o "-p 5499 -c listen_addresses=127.0.0.1" -w start`.
2. `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5499/postgres npm test`
3. Expected: all tests pass on Linux/macOS (2 are skipped on purpose). On Windows, exactly two
   Step 1 tests fail for platform reasons (POSIX file mode `0600`; Windows `pg_dump` error wording).
   Anything else failing is a real problem — stop and report it.
4. Stop and delete the throwaway cluster afterwards.

## Step 3 — generate the owner's secrets

1. Run `npm run setup` (interactive; the owner may type a web-page password) or
   `npm run setup -- --non-interactive --admin-url <admin URL of the empty database>`.
2. Tell the owner to open `.secrets/SAVE-THESE-THEN-DELETE.txt`, save the contents and a copy of
   `.env` and `.secrets/backup.age.key` in her password manager, add the two-factor code to an
   authenticator app, then delete the note. Do not read the values out loud in chat.

## Step 4 — Plaid keys (owner action)

**ASK** the owner to:
1. Sign in at https://dashboard.plaid.com (create an account if needed).
2. *Developers → Keys*: copy `client_id` into `PLAID_CLIENT_ID` and the **Sandbox** secret into
   `PLAID_SECRET` in `.env` (she can paste them herself, or give them to you to write into `.env`
   without echoing them).
3. *Developers → API → Allowed redirect URIs*: add `http://localhost:3000/link/oauth`.
Leave `PLAID_ENV=sandbox`.

## Step 5 — companies

**ASK** the owner for her companies (legal entities), whether each keeps its own books, and any
divisions/DBAs. Then edit `migrations/030_seed_org.sql` *before the first migrate*: change the
org name (`'My Organization'`), and replace the example entities and dimension. Keep the slug
`main` unless you also change `LL_ORG_SLUG`. Keep the org_id
`00000000-0000-4000-8000-000000000001` unless she wants another (Financial Books' `LEDGERLINE_ORG_ID`
must equal it). Each entity/dimension needs a unique UUID; `has_books=false` for "Personal".

## Step 6 — create the database

1. `createdb ledgerline` (or any name) on a Postgres server with **no** other ledgerline on it.
2. Make sure `LOCAL_PG_ADMIN_URL` in `.env` points at it (admin user).
3. `npm run local -- migrate` → expect a success log and exit code 0.

## Step 7 — connect a sandbox bank and sync

1. `npm run local -- app` (leave running). Owner opens http://localhost:3000/login in Chrome,
   logs in with her password + 6-digit code, goes to http://localhost:3000/link,
   clicks **Connect bank**, chooses a sandbox bank and logs in with `user_good` / `pass_good`.
2. In another terminal: `npm run local -- sync`. Expect exit code 0. (Heartbeat/Twilio warnings
   are normal when those optional settings are empty.)
3. Check data arrived (as reader): `psql "$(npm run -s local -- reader-url)" -c "SELECT count(*) FROM serve.v_transaction_current"`
   — this is **0 until step 8**: newly seen accounts are placeholders and the `serve.*`
   transaction views hide them until they are assigned to a company.

## Step 8 — account ownership

1. Copy `docs/rulings/EXAMPLE-ownership.json` to `docs/rulings/my-ownership.json`.
2. Fill in her entities/dimensions (same slugs as step 5) and one row per account.
3. `npm run local -- ownership docs/rulings/my-ownership.json` (dry run). It lists every
   "unmatched file account" and "uncovered live account" — fix the file until it's clean.
   **ASK** the owner which company owns each account; never guess.
4. `npm run local -- ownership docs/rulings/my-ownership.json --apply`.

## Step 9 — hook up Financial Books (locally)

In the Financial Books `.env`:
- `LEDGERLINE_URL` = output of `npm run -s local -- reader-url`
- `LEDGERLINE_ORG_ID` = output of `npm run -s local -- org-id`
Then follow Financial Books' own instructions (Settings → Bank connections).

## Step 10 — deploy to Railway (only when the owner asks)

Follow README.md "Deploy your own copy to Railway" exactly, in the owner's **own** Railway
project. Generate a fresh secret set for Railway with
`npm run setup -- --non-interactive --env-file .env.railway --secrets-dir .secrets-railway`.
Postgres stays private (no public proxy). Deploy `migrate` first. Put Financial Books in the
same project with `LEDGERLINE_URL` pointing at `ll_reader` over the private network.

## Step 11 — going live

Only when the owner says so and Plaid has approved production: create a **new empty** database,
migrate it, set `PLAID_ENV=production` and the production `PLAID_SECRET`, add the production
redirect URI in Plaid, and connect the real banks.

## Troubleshooting

- `migration 000` refuses: the server already has `ll_*` roles from another ledgerline → use a
  different Postgres server/cluster.
- `missing variable: X` in a log: set X in `.env` (or on that Railway service). Values are never logged.
- `postgres runtime connection refused`: a runtime service was given the superuser URL; give it
  its own `ll_*` role URL.
- Plaid `INVALID_API_KEYS`: `PLAID_SECRET` doesn't match `PLAID_ENV` (sandbox vs production secret).
- Link fails with a redirect error: the exact `LINK_REDIRECT_URI` is not in Plaid's allowed list.
