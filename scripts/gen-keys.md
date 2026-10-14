# Owner secret generation and escrow

> Shortcut: `npm run setup` (scripts/setup.js) generates every value below in one go into a
> local `.env` plus `.secrets/` and refuses to overwrite existing files. This page explains
> the individual commands if you ever need to regenerate one secret.

Run from this checkout with Node 22 after `npm ci`. These setup commands intentionally
print newly generated values for the owner to paste into Railway and escrow; service
logs never print values. Do not enable shell tracing or put secrets in argv, repo
files, terminal transcripts, or `.env` files committed to git.

Store a copy in the owner's password manager and an encrypted offline copy. Include
role passwords, `TOKEN_KEK`, Plaid credentials, Twilio credentials, healthcheck URLs,
Railway project configuration, and the age identity. Test access to both escrow copies.

## Backup age key (X25519)

```sh
mkdir -p ~/.ledgerline
chmod 700 ~/.ledgerline
node scripts/gen-age-key.js ~/.ledgerline/backup.age.key
```

The script uses `age-encryption`'s `generateIdentity` and `identityToRecipient` APIs,
prints only the public recipient, and creates the private identity file with mode
0600 and exclusive creation (it refuses to overwrite). Paste the public recipient
into `BACKUP_AGE_RECIPIENT` on backup. Keep the identity on the drill host and in
escrow, never in Railway. This replaces an `age-keygen` CLI dependency.

## Token KEK and session signing secret

Run the following command once for `TOKEN_KEK`, then independently again for
`APP_SESSION_SECRET`:

```sh
node --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(32).toString("base64"))'
```

`TOKEN_KEK` is the exact passphrase supplied to pgcrypto; preserve it unchanged for
restores and future token decryption. The two secrets must be different.

## Password hash

Read the password without terminal echo and pipe it to the hashing script:

```sh
read -r -s -p 'New app password: ' LL_PASSWORD_INPUT
printf '\n'
printf '%s' "$LL_PASSWORD_INPUT" | node scripts/hash-password.js
unset LL_PASSWORD_INPUT
```

Paste the bcrypt hash into `APP_LOGIN_PASSWORD_HASH`. The script reads only stdin,
uses cost 12, and rejects inputs beyond bcrypt's 72-byte boundary. Escrow the operator
password separately from its hash.

## TOTP

```sh
node scripts/gen-totp.js
```

Import the printed `otpauth://` URI into the owner's authenticator (or a local QR
renderer). The URI's `secret` query parameter is `APP_TOTP_SECRET`. Escrow that URI;
do not send it to an online QR service. The generator uses SHA1, six digits, and
30-second periods, matching the app.

## Railway provisioning

Seal `TOKEN_KEK`, `PLAID_SECRET`, and `APP_*` variables in Railway. Keep the
`BACKUP_S3_*` variables unsealed because the host-side `railway run` restore drill
needs them; restrict their R2 token to the backup bucket. The age recipient and
`BACKUP_PREFIX` are configuration, not secret keys. `BACKUP_S3_ENDPOINT` is also
configuration. Seal role passwords on migrate and escrow them independently.

Supply missing feature variables when ready. The app can serve `/healthz` before
login/Link secrets exist. A feature with a missing variable logs one clear line with
the variable name and fails; no values enter service logs. Missing Twilio configuration
leaves pages pending. Missing healthcheck configuration warns once and does no work.

Railway does not expose sealed variables to `railway run`; retrieve sealed drill
secrets locally from escrow rather than trying to export them from Railway.
See [Railway variable documentation](https://docs.railway.com/variables).
