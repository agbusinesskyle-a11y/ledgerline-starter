import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHarness } from './harness.js';

let h, owner, sync, verify, rebuild, org, directory, file, originalFacts, applied;
const started = performance.now();
const rows = async (sql, args = []) => (await owner.query(sql, args)).rows;
const one = async (sql, args = []) => (await rows(sql, args))[0];
const publicationCount = async () => (await one('SELECT count(*) AS n FROM ops.publication')).n;
const projectionTables = ['transaction', 'transaction_alias', 'transaction_revision', 'balance_observation',
  'quarantine', 'account', 'account_assignment', 'account_entity', 'account_reporting_scope', 'entity', 'dimension'];
const bankAccounts = [
  { institution: 'Bank A', mask: '0001', type: 'depository', subtype: 'checking', entity: 'business', dimension: 'farm',
    expected: ['checking', 'asset', 'cash_statement'] },
  { institution: 'Bank A', mask: '0002', type: 'depository', subtype: 'savings', entity: 'business',
    expected: ['savings', 'asset', 'cash_statement'] },
  { institution: 'Bank A', mask: '0003', type: 'depository', subtype: 'money market', entity: 'personal',
    expected: ['money_market', 'asset', 'cash_statement'] },
  { institution: 'Bank A', mask: '0004', type: 'credit', subtype: 'credit card', entity: 'personal',
    expected: ['credit_card', 'liability', 'card_statement'] },
  { institution: 'Bank B', mask: '0001', type: 'loan', subtype: 'mortgage', entity: 'business',
    expected: ['mortgage', 'liability', 'loan_principal'] },
  { institution: 'Bank B', mask: '0002', type: 'loan', subtype: 'commercial', entity: 'business',
    note: 'LINE OF CREDIT; reviewed by owner', expected: ['line_of_credit', 'liability', 'loan_principal'] },
  { institution: 'Bank B', mask: '0003', type: 'loan', subtype: 'auto', entity: 'personal',
    expected: ['loan', 'liability', 'loan_principal'] },
];
const rulings = {
  ruled_by: 'Step 4 owner',
  entities: [{ slug: 'business', display_name: 'Business' }, { slug: 'personal', display_name: 'Personal' }],
  dimensions: [{ slug: 'farm', display_name: 'Farm', parent_entity: 'business' }],
  accounts: bankAccounts.map((a, i) => ({ institution: a.institution, mask: a.mask, name: `Owner account ${i}`,
    entity: a.entity, ...(a.dimension ? { dimension: a.dimension } : {}), ...(a.note ? { note: a.note } : {}) })),
};

async function inventoryAndAccept(institution, accounts, targetOrg = org, postedDate) {
  const c = (await one("SELECT core.register_connection($1,$2,decode('abcd','hex'),NULL,$3) AS id",
    [targetOrg, randomUUID(), institution])).id;
  const inventory = accounts.map((a, i) => ({ account_id: `source-${i}`, name: 'Bank supplied name', mask: a.mask,
    type: a.type, subtype: a.subtype, capability: 'transactions', balances: { current: 100, iso_currency_code: 'USD' } }));
  const api = (await sync.query(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
    VALUES($1,$2,'/accounts/get',200,$3) RETURNING id`, [targetOrg, c, { accounts: inventory }])).rows[0].id;
  await sync.query('SELECT core.record_inventory($1,$2)', [c, api]);
  const attempt = (await sync.query('SELECT ops.open_attempt($1) AS id', [c])).rows[0].id;
  const transactions = inventory.map((a, i) => ({ transaction_id: `tx-${i}`, account_id: a.account_id,
    amount: i + 1, iso_currency_code: 'USD', date: i === 0 ? '1890-01-01' : '2026-01-10', pending: false, name: 'Shop' }));
  // Include a second transaction and a removed fact so totals cannot use only the serving view.
  transactions.push({ ...transactions[0], transaction_id: 'extra', date: '2026-01-11' });
  if (postedDate !== undefined) for (const t of transactions) t.date = postedDate;
  const cursor = randomUUID();
  const payload = { accounts: inventory, added: transactions, modified: [], removed: [], next_cursor: cursor,
    has_more: false, transactions_update_status: institution === 'Bank A' ? 'HISTORICAL_UPDATE_COMPLETE' : 'INITIAL_UPDATE_COMPLETE' };
  const observation = (await sync.query(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
    VALUES($1,$2,'/transactions/sync',200,$3) RETURNING id`, [targetOrg, c, payload])).rows[0].id;
  const page = (await sync.query(`INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more)
    VALUES($1,$2,1,$3,NULL,$4,false) RETURNING id`, [targetOrg, attempt, observation, cursor])).rows[0].id;
  const transitions = (await one('SELECT core.reduce_pages($1) AS transitions', [[page]])).transitions;
  await sync.query('SELECT core.accept_publication($1,$2,$3,$4,$5,1)', [attempt, [page], cursor, JSON.stringify(transitions), '[]']);
  const removalAttempt = (await sync.query('SELECT ops.open_attempt($1) AS id', [c])).rows[0].id;
  const removalCursor = randomUUID();
  const removalApi = (await sync.query(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
    VALUES($1,$2,'/transactions/sync',200,$3) RETURNING id`, [targetOrg, c, { ...payload, added: [],
    removed: [{ transaction_id: 'extra' }], next_cursor: removalCursor }])).rows[0].id;
  const removalPage = (await sync.query(`INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more)
    VALUES($1,$2,1,$3,$4,$5,false) RETURNING id`, [targetOrg, removalAttempt, removalApi, cursor, removalCursor])).rows[0].id;
  const removalTransitions = (await one('SELECT core.reduce_pages($1) AS transitions', [[removalPage]])).transitions;
  await sync.query('SELECT core.accept_publication($1,$2,$3,$4,$5,1)', [removalAttempt, [removalPage], removalCursor,
    JSON.stringify(removalTransitions), '[]']);
  return c;
}

async function cli({ data, apply = false, adminRole = false, slug = 'step4' } = {}) {
  const path = data ? join(directory, `${randomUUID()}.json`) : file;
  if (data) await writeFile(path, JSON.stringify(data));
  const url = new URL(h.databaseUrl);
  if (!adminRole) { url.username = 'll_verify'; url.password = 'll_verify'; }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/apply-ownership.js', path, '--org-slug', slug,
      ...(apply ? ['--apply'] : []), ...(adminRole ? ['--role', 'll_verify'] : [])], {
      env: { ...process.env, DATABASE_URL: url.href, ALLOW_SUPERUSER: adminRole ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function snapshot() {
  const result = {};
  for (const table of projectionTables) {
    result[table] = (await rows(`SELECT to_jsonb(t) AS row FROM core.${table} t`)).map(({ row }) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !key.endsWith('_at'))));
    result[table].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

before(async () => {
  h = await createHarness(); owner = await h.asOwner(); sync = await h.asRole('ll_sync');
  verify = await h.asRole('ll_verify'); rebuild = await h.asRole('ll_rebuild');
  org = randomUUID();
  await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'step4','Step 4')", [org]);
  // An existing entity must be preserved, even when its display name/books flag differ from the file.
  await verify.query("SELECT core.apply_ruling('entity',$1,$2,'existing owner ruling','owner')",
    [randomUUID(), { org_id: org, slug: 'personal', display_name: 'Existing Personal', has_books: false, active: true }]);
  for (const bank of ['Bank A', 'Bank B']) await inventoryAndAccept(bank, bankAccounts.filter(a => a.institution === bank));
  const subject = (await one('SELECT source_account_id FROM core.source_account WHERE org_id=$1 LIMIT 1', [org])).source_account_id;
  await sync.query("SELECT ops.raise_alert($1,'coverage_gap',$2,$3)", [org, `other:${org}`, subject]);
  originalFacts = await rows('SELECT transaction_id,account_id,revision,revision_publication_id FROM core.transaction WHERE org_id=$1 ORDER BY transaction_id', [org]);
  directory = await mkdtemp(join(tmpdir(), 'ledgerline-step4-'));
  file = join(directory, 'rulings.json'); await writeFile(file, JSON.stringify(rulings));
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  if (h) await h.drop();
  assert.ok(performance.now() - started < 45_000, 'Step4 suite must finish within 45 seconds');
});

test('Step4: a dry run prints the resolved plan and writes nothing', async () => {
  const before = await snapshot(), publications = await publicationCount();
  const alerts = await rows('SELECT * FROM ops.alert ORDER BY id');
  const result = await cli();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /DRY RUN/); assert.match(result.stdout, /Bank A/);
  assert.match(result.stdout, /line_of_credit/); assert.match(result.stdout, /farm/);
  assert.equal(await publicationCount(), publications);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await rows('SELECT * FROM ops.alert ORDER BY id'), alerts);
});

test('Step4: b apply preserves account identity and revisions while projecting metadata and ownership', async () => {
  const publications = Number(await publicationCount());
  applied = await cli({ apply: true });
  assert.equal(applied.code, 0, applied.stdout + applied.stderr);
  assert.equal(Number(await publicationCount()) - publications, 3);
  const entities = await rows('SELECT * FROM core.entity WHERE org_id=$1 ORDER BY slug', [org]);
  assert.equal(entities.length, 2);
  assert.equal(entities.find(e => e.slug === 'personal').display_name, 'Existing Personal');
  assert.equal(entities.find(e => e.slug === 'personal').has_books, false);
  assert.equal(entities.find(e => e.slug === 'business').has_books, true);
  const dimension = await one('SELECT * FROM core.dimension WHERE org_id=$1', [org]);
  assert.equal(dimension.slug, 'farm'); assert.equal(dimension.entity_id, entities.find(e => e.slug === 'business').entity_id);
  const accounts = await rows(`SELECT a.*,c.institution_name AS bank,sa.mask AS source_mask,e.slug,ae.dimension_id,
    lower_inf(ae.valid) AS beginning,upper_inf(ae.valid) AS forever,aa.reason AS assignment_reason
    FROM core.source_account sa JOIN core.source_connection c USING(org_id,connection_id)
    JOIN core.account_assignment aa ON aa.org_id=sa.org_id AND aa.source_account_id=sa.source_account_id AND aa.valid @> now()
    JOIN core.account a ON a.org_id=aa.org_id AND a.account_id=aa.account_id
    JOIN core.account_entity ae ON ae.org_id=a.org_id AND ae.account_id=a.account_id
    JOIN core.entity e ON e.org_id=ae.org_id AND e.entity_id=ae.entity_id WHERE sa.org_id=$1`, [org]);
  assert.equal(accounts.length, 7);
  for (const [i, expected] of bankAccounts.entries()) {
    const account = accounts.find(a => a.bank === expected.institution && a.source_mask === expected.mask);
    assert.deepEqual([account.kind, account.balance_orientation, account.verification_method], expected.expected);
    assert.equal(account.display_name, `Owner account ${i}`); assert.equal(account.mask, expected.mask);
    assert.equal(account.status, 'active'); assert.equal(account.currency, 'USD'); assert.equal(account.coverage_gap, null);
    assert.equal(account.history_state, expected.institution === 'Bank A' ? 'complete' : 'loading');
    assert.equal(account.slug, expected.entity); assert.equal(account.dimension_id, expected.dimension ? dimension.dimension_id : null);
    assert.equal(account.beginning, true); assert.equal(account.forever, true); assert.equal(account.assignment_reason, 'ruling');
  }
  assert.deepEqual(await rows('SELECT transaction_id,account_id,revision,revision_publication_id FROM core.transaction WHERE org_id=$1 ORDER BY transaction_id', [org]), originalFacts);
  assert.equal((await one("SELECT count(*) AS n FROM core.transaction_revision WHERE org_id=$1 AND cause='reassigned'", [org])).n, '0');
  const served = await rows(`SELECT t.entity_id,t.dimension_id,e.slug,c.institution_name,sa.mask FROM serve.v_transaction_current t
    JOIN core.source_account sa USING(org_id,source_account_id) JOIN core.source_connection c USING(org_id,connection_id)
    JOIN core.entity e USING(org_id,entity_id) WHERE t.org_id=$1`, [org]);
  assert.equal(served.length, 7);
  for (const t of served) {
    const expected = bankAccounts.find(a => a.institution === t.institution_name && a.mask === t.mask);
    assert.equal(t.slug, expected.entity); assert.equal(t.dimension_id, expected.dimension ? dimension.dimension_id : null);
  }
});

test('Step4: c acknowledges only new_account alerts for assigned sources', async () => {
  const alerts = await rows('SELECT * FROM ops.alert WHERE org_id=$1', [org]);
  assert.equal(alerts.filter(a => a.kind === 'new_account').length, 7);
  assert.ok(alerts.filter(a => a.kind === 'new_account').every(a => a.acknowledged_at));
  assert.equal(alerts.find(a => a.kind === 'coverage_gap').acknowledged_at, null);
  await assert.rejects(verify.query('UPDATE ops.alert SET acknowledged_at=now()'), e => e.code === '42501');
});

test('Step4: d second apply is a no-op including publications and alerts', async () => {
  const publications = await publicationCount(), before = await snapshot();
  const alerts = await rows('SELECT * FROM ops.alert ORDER BY id');
  const result = await cli({ apply: true, adminRole: true });
  assert.equal(result.code, 0, result.stdout + result.stderr); assert.match(result.stdout, /nothing to do/);
  assert.equal(await publicationCount(), publications); assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await rows('SELECT * FROM ops.alert ORDER BY id'), alerts);
});

test('Step4: e unmatched rows all refuse with exit 2 and no publications', async () => {
  const publications = await publicationCount(), before = await snapshot();
  const result = await cli({ apply: true, data: { ...rulings, accounts: [...rulings.accounts,
    { institution: 'Unknown Bank', mask: '9998', name: 'Unmatched one', entity: 'business' },
    { institution: 'Unknown Bank', mask: '9999', name: 'Unmatched two', entity: 'personal' }] } });
  assert.equal(result.code, 2, result.stdout + result.stderr); assert.match(result.stdout, /9998/); assert.match(result.stdout, /9999/);
  assert.equal(await publicationCount(), publications); assert.deepEqual(await snapshot(), before);
});

test('Step4: e uncovered live accounts all refuse with exit 2 and no publications', async () => {
  const publications = await publicationCount(), before = await snapshot();
  const result = await cli({ apply: true, data: { ...rulings, accounts: rulings.accounts.slice(2) } });
  assert.equal(result.code, 2, result.stdout + result.stderr); assert.match(result.stdout, /uncovered.*Bank A.*0001/i);
  assert.match(result.stdout, /uncovered.*Bank A.*0002/i);
  assert.equal(await publicationCount(), publications); assert.deepEqual(await snapshot(), before);
});

test('Step4: f rebuild reproduces the live projection snapshot', async () => {
  const before = await snapshot(), alerts = await rows('SELECT * FROM ops.alert ORDER BY id');
  await rebuild.query('SELECT core.rebuild_projections()');
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await rows('SELECT * FROM ops.alert ORDER BY id'), alerts);
});

test('Step4: g entity transaction totals include removed facts and equal the org total', async () => {
  const totals = await rows(`SELECT e.slug,count(t.transaction_id)::int AS transactions FROM core.entity e
    LEFT JOIN core.account_entity ae ON ae.org_id=e.org_id AND ae.entity_id=e.entity_id
    LEFT JOIN core.transaction t ON t.org_id=ae.org_id AND t.account_id=ae.account_id AND ae.valid @> t.posted_date
    WHERE e.org_id=$1 GROUP BY e.slug ORDER BY e.slug`, [org]);
  assert.deepEqual(totals, [{ slug: 'business', transactions: 6 }, { slug: 'personal', transactions: 3 }]);
  assert.equal(totals.reduce((n, e) => n + e.transactions, 0), Number((await one('SELECT count(*) AS n FROM core.transaction WHERE org_id=$1', [org])).n));
  assert.match(applied.stdout, /business\s*\|\s*4\s*\|\s*6/);
  assert.match(applied.stdout, /personal\s*\|\s*3\s*\|\s*3/);
  assert.match(applied.stdout, /TOTAL\s*\|\s*7\s*\|\s*9/);
});

test('Step4: duplicate file accounts and wrong-parent dimensions refuse before writes', async () => {
  const publications = await publicationCount();
  for (const data of [
    { ...rulings, accounts: [...rulings.accounts, rulings.accounts[0]] },
    { ...rulings, accounts: rulings.accounts.map((a, i) => i === 2 ? { ...a, dimension: 'farm' } : a) },
  ]) {
    const result = await cli({ apply: true, data });
    assert.equal(result.code, 2, result.stdout + result.stderr); assert.equal(await publicationCount(), publications);
  }
});

test('Step4: ambiguous institution and mask matches refuse before writes', async () => {
  const otherOrg = randomUUID();
  await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'ambiguous','Ambiguous')", [otherOrg]);
  for (let i = 0; i < 2; i++) await inventoryAndAccept('Duplicate Bank', [bankAccounts[0]], otherOrg);
  const publications = await publicationCount();
  const result = await cli({ apply: true, slug: 'ambiguous', data: { ...rulings,
    accounts: [{ institution: 'Duplicate Bank', mask: '0001', name: 'Duplicate', entity: 'business' }] } });
  assert.equal(result.code, 2, result.stdout + result.stderr); assert.match(result.stdout, /ambiguous/i);
  assert.equal(await publicationCount(), publications);
});

test('Step4: alert helper leaves placeholders and other orgs untouched and has narrow grants', async () => {
  const unacknowledged = await rows('SELECT * FROM ops.alert WHERE acknowledged_at IS NULL ORDER BY id');
  assert.equal((await verify.query('SELECT ops.resolve_assigned_account_alerts($1) AS n', [org])).rows[0].n, 0);
  const otherOrg = (await one("SELECT org_id FROM core.org WHERE slug='ambiguous'")).org_id;
  assert.equal((await verify.query('SELECT ops.resolve_assigned_account_alerts($1) AS n', [otherOrg])).rows[0].n, 0);
  assert.deepEqual(await rows('SELECT * FROM ops.alert WHERE acknowledged_at IS NULL ORDER BY id'), unacknowledged);
  for (const role of ['ll_sync', 'll_app', 'll_reader', 'll_rebuild', 'll_backup']) {
    assert.equal((await one("SELECT has_function_privilege($1,'ops.resolve_assigned_account_alerts(uuid)','EXECUTE') AS allowed", [role])).allowed, false);
  }
});

test('Step4: totals failure rolls back all seed publications and alert acknowledgments', async () => {
  const badOrg = randomUUID();
  await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'bad-totals','Bad totals')", [badOrg]);
  await inventoryAndAccept('Bank A', [bankAccounts[0]], badOrg, null);
  const before = await snapshot(), publications = await publicationCount();
  const alerts = await rows('SELECT * FROM ops.alert ORDER BY id');
  const result = await cli({ apply: true, slug: 'bad-totals', data: { ...rulings, accounts: [rulings.accounts[0]] } });
  assert.equal(result.code, 1, result.stdout + result.stderr); assert.match(result.stdout, /totals check failed/);
  assert.equal(await publicationCount(), publications); assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await rows('SELECT * FROM ops.alert ORDER BY id'), alerts);
});

test('Step4: waits for inventory before starting its ruling transaction', async () => {
  const waitingOrg = randomUUID();
  await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'waiting','Waiting')", [waitingOrg]);
  const admin = await h.asAdmin();
  let running;
  await owner.query('SELECT pg_advisory_lock(7777)');
  try {
    running = cli({ apply: true, slug: 'waiting', data: { ...rulings, accounts: [rulings.accounts[0]] } });
    const deadline = performance.now() + 3000;
    while (!(await admin.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid)
      WHERE a.datname=current_database() AND l.locktype='advisory' AND l.objid=7777 AND NOT l.granted`)).rowCount) {
      assert.ok(performance.now() < deadline, 'seeder must wait on the publication lock');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await owner.query('BEGIN');
    const c = (await one("SELECT core.register_connection($1,$2,decode('abcd','hex'),NULL,'Bank A') AS id", [waitingOrg, randomUUID()])).id;
    const api = (await one(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
      VALUES($1,$2,'/accounts/get',200,$3) RETURNING id`, [waitingOrg, c, { accounts: [{ account_id: 'new',
        name: 'New account', mask: '0001', type: 'depository', subtype: 'checking' }] }])).id;
    await owner.query('SELECT core.record_inventory($1,$2)', [c, api]);
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK'); await owner.query('SELECT pg_advisory_unlock(7777)');
    if (running) await running; throw error;
  }
  await owner.query('SELECT pg_advisory_unlock(7777)');
  const result = await running;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal((await one('SELECT status FROM core.account WHERE org_id=$1', [waitingOrg])).status, 'active');
});
