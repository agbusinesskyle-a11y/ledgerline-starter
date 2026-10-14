import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Encrypter, Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import bcrypt from 'bcryptjs';
import { selectRetention } from '../services/backup/retention.js';
import { makeManifest, validateManifest, encryptFile, decryptFile, digestFile, runPg } from '../services/backup/common.js';
import { parseArgs } from '../services/backup/restore.js';
import { deliverPending, transport } from '../services/lib/alerts.js';
import { ping } from '../services/lib/heartbeat.js';
import { redact, logFailure } from '../services/lib/log.js';
import { createPool } from '../services/lib/db.js';
import { createApp, makeTotp } from '../services/app/index.js';
const started = performance.now();
const prefix = 'backups/';
function keysAt(ts) { return [`${prefix}${ts}-${'a'.repeat(16)}.dump.age`, `${prefix}${ts}-${'b'.repeat(16)}.globals.sql.age`, `${prefix}${ts}.manifest.json`]; }

test('Step 1 retention: exact keep/delete over 400 days, complete backup sets, evidence untouched', () => {
  const now = new Date('2026-10-11T23:00:00.000Z');
  const byDay = Array.from({ length: 400 }, (_, i) => [12, 22].map(hour => {
    const d = new Date(+now - i * 86400000); d.setUTCHours(hour, 0, 0, 0); return keysAt(d.toISOString());
  }));
  const objects = byDay.flat(2).concat(['evidence/statement.pdf', 'backups/evidence/statement.pdf', 'backups/manual.txt', 'other/old.dump.age']);
  const keptDays = new Set([...Array(14).keys(), 14, 21, 28, 35, 42, 49, 41, 72, 103, 133, 164, 194, 225, 253, 284, 315]);
  const expectedKeep = byDay.flatMap((b, i) => [...(i < 2 ? b[0] : []), ...(keptDays.has(i) ? b[1] : [])]).sort();
  const expectedDelete = byDay.flat(2).filter(k => !expectedKeep.includes(k)).sort();
  const result = selectRetention(objects, prefix, now);
  assert.deepEqual(result.keep, expectedKeep);
  assert.deepEqual(result.delete, expectedDelete);
  assert.deepEqual(result.untouched, ['backups/evidence/statement.pdf', 'backups/manual.txt', 'evidence/statement.pdf', 'other/old.dump.age']);
});
test('Step 1 retention: boundary at two days is kept and ISO week crosses year', () => {
  const now = new Date('2026-01-05T12:00:00.000Z');
  const a = keysAt('2026-01-03T12:00:00.000Z'), b = keysAt('2026-01-03T11:59:59.000Z');
  const old = keysAt('2025-12-28T12:00:00.000Z');
  const result = selectRetention([...a, ...b, ...old], prefix, now);
  assert.deepEqual(result.keep, [...a, ...old].sort());
  assert.deepEqual(result.delete, b.sort());
});
test('Step 1 retention: backup-shaped evidence keys survive even with an evidence retention root', () => {
  for (const evidencePrefix of ['evidence/', 'backups/evidence/']) {
    const objects = keysAt('2025-01-01T12:00:00.000Z').map(key => ({ Key: key.replace(prefix, evidencePrefix) }));
    const result = selectRetention(objects, evidencePrefix, new Date('2026-10-11T23:00:00.000Z'));
    assert.deepEqual(result.keep, []);
    assert.deepEqual(result.delete, []);
    assert.deepEqual(result.untouched, objects.map(object => object.Key).sort());
  }
});
test('Step 1 retention: orphan uploads never displace a complete restorable set', () => {
  const complete = keysAt('2026-09-30T12:00:00.000Z');
  const orphan = keysAt('2026-09-30T22:00:00.000Z').slice(0, 2);
  const selection = selectRetention([...complete, ...orphan], prefix, new Date('2026-10-11T23:00:00.000Z'));
  assert.deepEqual(selection.keep, complete.sort());
  assert.deepEqual(selection.delete, orphan.sort());
});
test('Step 1 age: generated X25519 identity encrypts/decrypts in process', async () => {
  const identity = await generateIdentity(), recipient = await identityToRecipient(identity);
  const e = new Encrypter(); e.addRecipient(recipient);
  const encrypted = await e.encrypt('bank-facts fixture');
  const d = new Decrypter(); d.addIdentity(identity);
  assert.equal(await d.decrypt(encrypted, 'text'), 'bank-facts fixture');
  assert.notEqual(Buffer.from(encrypted).toString(), 'bank-facts fixture');
});
test('Step 1 age: production streaming helpers round-trip binary files and hash ciphertext', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'll-age-test-'));
  try {
    const identity = await generateIdentity(), recipient = await identityToRecipient(identity);
    const input = Buffer.alloc(150000, 123);
    await writeFile(join(dir, 'input'), input);
    await encryptFile(join(dir, 'input'), join(dir, 'cipher'), recipient);
    await decryptFile(join(dir, 'cipher'), join(dir, 'output'), `# escrow identity\n${identity}\n`);
    assert.deepEqual(await readFile(join(dir, 'output')), input);
    const ciphertext = await readFile(join(dir, 'cipher'));
    assert.deepEqual(await digestFile(join(dir, 'cipher')), { size: ciphertext.length, sha256: createHash('sha256').update(ciphertext).digest('hex') });
    assert.equal((await stat(join(dir, 'output'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
const ts = '2026-10-11T12:00:00.000Z';
const files = ['dump', 'globals.sql'].map((suffix, i) => ({ key: `${prefix}${ts}-${(i ? 'b' : 'a').repeat(16)}.${suffix}.age`, size: 1024 + i, sha256: (i ? 'b' : 'a').repeat(64) }));
const counts = { 'core.transaction': '10', 'raw.api_call': '20', 'ops.publication': '30' };
test('Step 1 manifest: shape includes both files, ciphertext hashes/sizes, version and counts', () => {
  const m = makeManifest(ts, files, '16.15', counts);
  assert.deepEqual(Object.keys(m), ['ts', 'files', 'sizes', 'sha256s', 'pg_version', 'row_counts']);
  assert.deepEqual(m.files, files.map(f => f.key));
  assert.deepEqual(m.row_counts, counts);
  assert.equal(validateManifest(m, prefix, ts), m);
});
test('Step 1 manifest: rejects outside-prefix files, wrong hashes, missing counts', () => {
  const m = makeManifest(ts, files, '16.15', counts);
  assert.throws(() => validateManifest({ ...m, files: ['evidence/file.age', m.files[1]] }, prefix, ts));
  assert.throws(() => validateManifest({ ...m, sha256s: {} }, prefix, ts));
  assert.throws(() => validateManifest({ ...m, row_counts: {} }, prefix, ts));
});
test('Step 1 restore: CLI requires exactly one selector, target and identity', () => {
  assert.deepEqual(parseArgs(['--latest', '--target', 'postgres://local/drill', '--identity', '/tmp/key']), { latest: true, target: 'postgres://local/drill', identity: '/tmp/key' });
  assert.equal(parseArgs(['--ts', ts, '--target', 'postgres://local/drill', '--identity', '/tmp/key']).ts, ts);
  assert.throws(() => parseArgs(['--latest', '--ts', ts, '--target', 'x', '--identity', 'y']));
  assert.throws(() => parseArgs(['--latest']));
});
const twilioEnv = { TWILIO_ACCOUNT_SID: 'fixture', TWILIO_AUTH_TOKEN: 'fixture', TWILIO_FROM: 'fixture', TWILIO_ALERT_TO: 'fixture' };
function fakeAlerts(rows) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pending_alerts')) return { rows };
    return { rows: [] };
  } };
}
const alert = { id: 'fixture-1', kind: 'login_required', dedupe_key: 'same' };
test('Step 1 alerts: retries three times with backoff and records successful delivery', async () => {
  const pool = fakeAlerts([alert]), waits = [];
  let attempts = 0;
  const result = await deliverPending(pool, { env: twilioEnv, sender: {
    async send() { if (++attempts < 3) throw new Error('fixture failure'); }, async sleep(ms) { waits.push(ms); },
  } });
  assert.equal(attempts, 3); assert.deepEqual(waits, [250, 500]);
  assert.deepEqual(pool.calls.filter(c => c.sql.includes('record_alert_attempt')).map(c => c.params), [[alert.id, false], [alert.id, false], [alert.id, true]]);
  assert.deepEqual(result, { delivered: 1, pending: false });
});
test('Step 1 alerts: exhausted retries leave page undelivered', async () => {
  const pool = fakeAlerts([alert]); let attempts = 0;
  const result = await deliverPending(pool, { env: twilioEnv, sender: { async send() { attempts++; throw new Error('failure'); }, async sleep() {} } });
  assert.equal(attempts, 3); assert.equal(result.pending, true);
  assert.ok(pool.calls.filter(c => c.sql.includes('record_alert_attempt')).every(c => !c.params[1]));
});
test('Step 1 alerts: dedupe key sends one page per pending key', async () => {
  const pool = fakeAlerts([alert, { ...alert, id: 'fixture-2' }]); let sent = 0;
  await deliverPending(pool, { env: twilioEnv, sender: { async send() { sent++; }, async sleep() {} } });
  assert.equal(sent, 1);
});
test('Step 1 alerts: missing vars warn once and leave rows untouched', async () => {
  const pool = fakeAlerts([alert]), output = [], original = console.log;
  console.log = line => output.push(JSON.parse(line));
  try {
    await deliverPending(pool, { env: {} }); await deliverPending(pool, { env: {} });
  } finally { console.log = original; }
  assert.equal(output.length, 1); assert.equal(output[0].message, 'missing variable: TWILIO_ACCOUNT_SID');
  assert.equal(pool.calls.length, 0);
});
test('Step 1 alerts: transport seam uses REST basic auth and excludes bank details', async () => {
  const original = globalThis.fetch; let request;
  globalThis.fetch = async (url, options) => { request = { url, ...options }; return { ok: true }; };
  try { await transport.send({ ...alert, detail: { access_token: 'never-send' } }, twilioEnv); }
  finally { globalThis.fetch = original; }
  assert.equal(request.url, 'https://api.twilio.com/2010-04-01/Accounts/fixture/Messages.json');
  assert.match(request.headers.Authorization, /^Basic /);
  assert.equal(request.method, 'POST');
  assert.ok(!request.body.toString().includes('never-send'));
});
test('Step 1 log redaction masks access_token and nested URL/password values', () => {
  assert.deepEqual(redact({ access_token: 'bank-secret', safe: [{ password: 'x', nested: { DATABASE_URL: 'dsn', count: 1 } }], monkey: 'also masked' }),
    { access_token: '***', safe: [{ password: '***', nested: { DATABASE_URL: '***', count: 1 } }], monkey: '***' });
});
test('Step 1 failure log carries bounded diagnostics but never the raw message or a DSN', async () => {
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(JSON.parse(line));
  try {
    const sys = Object.assign(new Error('getaddrinfo ENOTFOUND db.example.internal'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'db.example.internal' });
    logFailure('backup failed', sys);
    const raw = Object.assign(new Error('password=hunter2 postgres://u:p@h/db'), { code: 'weird code' });
    logFailure('backup failed', raw);
    await assert.rejects(runPg('pg_dump', ['--no-such-flag'], 'postgres://x:y@127.0.0.1:1/x'), error => {
      assert.equal(error.code, 'PG_DUMP_FAILED');
      assert.match(error.diagnostic, /unrecognized option/);
      assert.ok(!error.diagnostic.includes('x:y@'));
      logFailure('backup failed', error);
      return true;
    });
  } finally { console.log = original; }
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0].code, lines[0].syscall, lines[0].hostname], ['ENOTFOUND', 'getaddrinfo', 'db.example.internal']);
  assert.equal(lines[1].code, 'FAILED');
  assert.ok(!JSON.stringify(lines).includes('hunter2') && !JSON.stringify(lines).includes('u:p@h'));
  assert.equal(lines[2].code, 'PG_DUMP_FAILED');
  assert.match(lines[2].diagnostic, /unrecognized option/);
});
test('Step 1 database refuses decoded postgres username unless explicitly allowed', async () => {
  assert.throws(() => createPool({ DATABASE_URL: 'postgres://%70ostgres@localhost/x' }), /postgres runtime connection refused/);
  assert.throws(() => createPool({}), /DATABASE_URL/);
  const pool = createPool({ DATABASE_URL: 'postgres://postgres@localhost/x', ALLOW_SUPERUSER: '1' });
  assert.equal(pool.options.query_timeout, 30000);
  await pool.end();
  const slow = createPool({ DATABASE_URL: 'postgres://ll_sync@localhost/x', PG_QUERY_TIMEOUT_MS: '900000' });
  assert.equal(slow.options.query_timeout, 900000);
  await slow.end();
  assert.throws(() => createPool({ DATABASE_URL: 'postgres://ll_sync@localhost/x', PG_QUERY_TIMEOUT_MS: '10' }), /PG_QUERY_TIMEOUT_MS/);
});
test('Step 1 heartbeat: missing URL warns once, performs no network or DB calls', async () => {
  const output = [], original = console.log; let calls = 0;
  console.log = line => output.push(JSON.parse(line));
  try { assert.equal(await ping('COVERAGE', { async query() { calls++; } }, {}, {}), false); await ping('COVERAGE', null, {}, {}); }
  finally { console.log = original; }
  assert.equal(calls, 0); assert.equal(output.length, 1);
  assert.equal(output[0].message, 'missing variable: HEALTHCHECKS_PING_COVERAGE');
});
test('Step 1 heartbeat: GET and append-only function carry operational payload', async () => {
  const requests = [], server = http.createServer((req, res) => { requests.push(req.method); res.end('ok'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const calls = [];
  try {
    await ping('BACKUP', { async query(...args) { calls.push(args); } }, { pg_database_size: '100' },
      { HEALTHCHECKS_PING_BACKUP: `http://127.0.0.1:${server.address().port}/`, LL_ORG_SLUG: 'fixture' });
    assert.deepEqual(requests, ['GET']); assert.match(calls[0][0], /ops\.heartbeat/);
    assert.deepEqual(calls[0][1], ['fixture', 'backup', '{"pg_database_size":"100"}']);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('Step 1 heartbeat: backup discovers its single tenant without LL_ORG_SLUG', async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async () => ({ ok: true });
  try {
    await ping('BACKUP', { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ org_id: 'fixture-org' }] }; } }, {},
      { HEALTHCHECKS_PING_BACKUP: 'https://example.test/fixture' });
    assert.match(calls[0].sql, /FROM core.org/);
    assert.deepEqual(calls[1].params, ['fixture-org', 'backup', '{}']);
  } finally { globalThis.fetch = original; }
});
const testPassword = 'fixture-login-pass';
const passwordHash = await bcrypt.hash(testPassword, 4);
const totpSecret = 'JBSWY3DPEHPK3PXP';
async function withApp(work, overrides = {}) {
  const plaidRequests = [], dbCalls = [];
  const plaid = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    plaidRequests.push({ path: req.url, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/link/token/create' ? { link_token: `link-fixture-${plaidRequests.length}` } : { access_token: 'never-return-this', item_id: 'fixture-item' }));
  });
  plaid.listen(0, '127.0.0.1'); await once(plaid, 'listening');
  let now = Date.now();
  const env = { APP_LOGIN_PASSWORD_HASH: passwordHash, APP_TOTP_SECRET: totpSecret, APP_SESSION_SECRET: 'fixture-session-secret',
    PLAID_CLIENT_ID: 'fixture-client', PLAID_SECRET: 'fixture-secret', PLAID_ENV: 'sandbox', PLAID_PRODUCTS: 'transactions',
    LL_ORG_SLUG: 'fixture', LINK_REDIRECT_URI: 'https://example.test/link/oauth', TOKEN_KEK: 'fixture-kek',
    PLAID_BASE_URL: `http://127.0.0.1:${plaid.address().port}`, ...overrides };
  const pool = { async query(sql, params) { dbCalls.push({ sql, params }); return { rows: [{ connection_id: 'fixture-connection' }] }; } };
  const app = createApp({ pool, env, clock: () => now });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, options) => fetch(base + path, options);
  async function login(password = testPassword) {
    const challenge = await request('/login');
    const cookie = challenge.headers.get('set-cookie').split(';')[0];
    const csrf = (await challenge.text()).match(/name="csrf" value="([^"]+)"/)[1];
    const response = await request('/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrf, password, totp: makeTotp(totpSecret).generate() }) });
    return { response, cookie: response.headers.get('set-cookie')?.split(';')[0], challengeCookie: cookie, csrf };
  }
  async function linkedSession() {
    const { cookie, response } = await login(); assert.equal(response.status, 200);
    const page = await request('/link', { headers: { Cookie: cookie } }); assert.equal(page.status, 200);
    const html = await page.text();
    return { cookie, csrf: html.match(/name="csrf" value="([^"]+)"/)[1],
      linkToken: JSON.parse(html.match(/linkToken = ("[^"]+")/)[1]),
      stateCookie: page.headers.get('set-cookie').split(';')[0] };
  }
  try { await work({ request, login, linkedSession, plaidRequests, dbCalls, advance(ms) { now += ms; } }); }
  finally {
    app.closeAllConnections(); plaid.closeAllConnections();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => plaid.close(resolve))]);
  }
}
test('Step 1 app: health 200 and no-store, Link requires session', async () => withApp(async ({ request, dbCalls }) => {
  const health = await request('/healthz'); assert.equal(health.status, 200); assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(dbCalls[0].sql, 'SELECT 1');
  const page = await request('/link'); assert.equal(page.status, 401); assert.equal(page.headers.get('cache-control'), 'no-store');
}));
test('Step 1 app: wrong password 401, rate limit after ten login requests', async () => withApp(async ({ request }) => {
  const challenge = await request('/login');
  const cookie = challenge.headers.get('set-cookie').split(';')[0];
  const csrf = (await challenge.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const options = { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, password: 'wrong', totp: makeTotp(totpSecret).generate() }) };
  for (let i = 0; i < 9; i++) assert.equal((await request('/login', options)).status, 401);
  assert.equal((await request('/login', options)).status, 429);
}));
test('Step 1 app: password + TOTP establishes cookie with exact security flags', async () => withApp(async ({ login }) => {
  const { response } = await login(); assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^ll_session=[a-f0-9]{64}\.[a-f0-9]{64}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400; Path=\/$/);
}));
test('Step 1 app: wrong TOTP fails and login POST requires CSRF', async () => withApp(async ({ request }) => {
  const challenge = await request('/login'), cookie = challenge.headers.get('set-cookie').split(';')[0];
  const csrf = (await challenge.text()).match(/name="csrf" value="([^"]+)"/)[1];
  let response = await request('/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, password: testPassword, totp: 'invalid' }) });
  assert.equal(response.status, 401);
  response = await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: testPassword, totp: makeTotp(totpSecret).generate() }) });
  assert.equal(response.status, 403);
}));
test('Step 1 app: token rejects missing CSRF and stale session', async () => withApp(async ({ request, linkedSession, advance, plaidRequests }) => {
  const s = await linkedSession();
  const options = { method: 'POST', headers: { Cookie: s.cookie, 'Content-Type': 'application/json' }, body: '{}' };
  assert.equal((await request('/link/token', options)).status, 403);
  advance(86400001);
  options.headers['X-CSRF-Token'] = s.csrf;
  assert.equal((await request('/link/token', options)).status, 401);
  assert.equal(plaidRequests.length, 1);
}));
test('Step 1 app: exchange rejects a Link token not issued by this session', async () => withApp(async ({ request, linkedSession, plaidRequests }) => {
  const s = await linkedSession();
  const response = await request('/link/exchange', { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_token: 'foreign-token', public_token: 'public-fixture' }) });
  assert.equal(response.status, 403); assert.equal(plaidRequests.length, 1);
}));
test('Step 1 app: mock Plaid mint uses history/org/products, exchange encrypts bound parameters in SQL', async () => withApp(async ({ request, linkedSession, plaidRequests, dbCalls }) => {
  const s = await linkedSession();
  assert.equal(plaidRequests[0].body.user.client_user_id, 'fixture');
  assert.deepEqual(plaidRequests[0].body.products, ['transactions']);
  assert.equal(plaidRequests[0].body.transactions.days_requested, 730);
  assert.equal(plaidRequests[0].body.redirect_uri, 'https://example.test/link/oauth');
  const options = { method: 'POST', headers: { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_token: s.linkToken, public_token: 'public-fixture', institution_id: 'ins_1', institution_name: 'Fixture Bank' }) };
  const response = await request('/link/exchange', options);
  assert.equal(response.status, 200); const raw = await response.text(); assert.ok(!raw.includes('never-return-this'));
  const call = dbCalls.find(c => c.sql.includes('register_connection'));
  assert.match(call.sql, /public\.pgp_sym_encrypt\(\$3::text, \$4::text\)/);
  assert.deepEqual(call.params, ['fixture', 'fixture-item', 'never-return-this', 'fixture-kek', 'ins_1', 'Fixture Bank', null]);
  assert.equal((await request('/link/exchange', options)).status, 403);
}));
test('Step 1 app: new mint invalidates previous token; update mode returns explicit 501', async () => withApp(async ({ request, linkedSession, plaidRequests }) => {
  const s = await linkedSession();
  const headers = { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/json' };
  const response = await request('/link/token', { method: 'POST', headers, body: '{}' }); assert.equal(response.status, 200);
  assert.notEqual((await response.json()).link_token, s.linkToken);
  assert.equal((await request('/link/exchange', { method: 'POST', headers, body: JSON.stringify({ link_token: s.linkToken, public_token: 'public' }) })).status, 403);
  const update = await request('/link/token?update_mode=fixture', { method: 'POST', headers, body: '{}' });
  assert.equal(update.status, 501); assert.match((await update.json()).error, /Update mode/);
  assert.equal(plaidRequests.length, 2);
}));
test('Step 1 app: OAuth validates session state and reuses original Link token', async () => withApp(async ({ request, linkedSession, plaidRequests }) => {
  const s = await linkedSession();
  assert.equal((await request('/link/oauth?state=wrong', { headers: { Cookie: s.cookie } })).status, 403);
  const state = s.stateCookie.split('=')[1];
  const response = await request(`/link/oauth?state=${state}&oauth_state_id=fixture`, { headers: { Cookie: `${s.cookie}; ${s.stateCookie}` } });
  assert.equal(response.status, 200); const html = await response.text();
  assert.ok(html.includes(s.linkToken)); assert.ok(html.includes('receivedRedirectUri'));
  assert.ok(!html.includes(`state=${state}`)); assert.equal(plaidRequests.length, 1);
}));
test('Step 1 app: 16 KB body limit returns 413 and no-store', async () => withApp(async ({ request, linkedSession }) => {
  const s = await linkedSession();
  const response = await request('/link/token', { method: 'POST', headers: { Cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ too_big: 'x'.repeat(16384) }) });
  assert.equal(response.status, 413); assert.equal(response.headers.get('cache-control'), 'no-store');
}));
test('Step 1 app: optional feature secrets do not block health/startup', async () => withApp(async ({ request, login }) => {
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await login()).response.status, 503);
}, { APP_LOGIN_PASSWORD_HASH: '' }));
test('Step 1 offline suite stays under 20 seconds', () => { assert.ok(performance.now() - started < 20000); });
