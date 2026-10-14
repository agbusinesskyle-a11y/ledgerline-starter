import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarness, runMigrate, runtimeRoles } from './harness.js';
import pg from 'pg';

const started = performance.now();
let h, owner, admin;
const clients = {};
const fixture = { org: randomUUID(), otherOrg: randomUUID(), otherEntity: randomUUID() };
const sha = 'a'.repeat(64);
const period = '[2026-01-01,2026-02-01)';

async function rejectsSql(client, sql, values, code, message) {
  await assert.rejects(client.query(sql, values), error => {
    assert.equal(error.code, code, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}
async function rollback(work) {
  await owner.query('BEGIN');
  try { await work(); } finally { await owner.query('ROLLBACK'); }
}
async function publication(client = owner, org = fixture.org) {
  await client.query('SELECT pg_advisory_xact_lock(7777)');
  return (await client.query("INSERT INTO ops.publication (org_id, kind, actor) VALUES ($1, 'inventory', 'fixture') RETURNING id", [org])).rows[0].id;
}
async function newAttempt(client = clients.ll_sync, connection = fixture.connection) {
  return (await client.query('SELECT ops.open_attempt($1) AS id', [connection])).rows[0].id;
}
async function page(attempt, pageNo = 1, connection = fixture.connection, client = owner) {
  // Raw call/page observations are committed together, including in fixture setup.
  await client.query('BEGIN');
  try {
    const api = (await client.query("SELECT nextval('raw.api_call_id_seq') AS id")).rows[0].id;
    await client.query(`INSERT INTO raw.api_call (id, org_id, connection_id, endpoint, http_status, payload)
      VALUES ($3, $1, $2, '/transactions/sync', 200, '{"added":[],"modified":[],"removed":[]}')`,
    [fixture.org, connection, api]);
    const id = (await client.query("SELECT nextval('raw.sync_page_id_seq') AS id")).rows[0].id;
    await client.query(`INSERT INTO raw.sync_page (org_id, attempt_id, page_no, api_call_id,
      cursor_in, cursor_out, has_more, id) VALUES ($1,$2,$3,$4,NULL,'next',false,$5)`,
    [fixture.org, attempt, pageNo, api, id]);
    await client.query('COMMIT');
    return { id, api };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
const acceptSql = "SELECT core.accept_publication($1,$2,'next','[]','[]',1,$3) AS id";

before(async () => {
  h = await createHarness();
  owner = await h.asOwner();
  admin = await h.asAdmin();
  for (const role of runtimeRoles) clients[role] = await h.asRole(role);
  await owner.query("INSERT INTO core.org (org_id, slug, name) VALUES ($1,'fixture','Fixture'), ($2,'other','Other')", [fixture.org, fixture.otherOrg]);
  fixture.connection = (await owner.query("SELECT core.register_connection($1,'fixture-item',decode('abcd','hex')) AS id", [fixture.org])).rows[0].id;
  const api = (await owner.query(`INSERT INTO raw.api_call (org_id, connection_id, endpoint, http_status, payload)
    VALUES ($1,$2,'/accounts/get',200,$3) RETURNING id`, [fixture.org, fixture.connection, {
    accounts: [{ account_id: 'fixture-account', name: ' Fixture Checking ', type: 'depository',
      subtype: 'checking', capability: 'transactions', balances: { iso_currency_code: 'USD' } }],
  }])).rows[0].id;
  fixture.publication = (await owner.query('SELECT core.record_inventory($1,$2) AS id', [fixture.connection, api])).rows[0].id;
  const account = (await owner.query('SELECT source_account_id, account_id FROM core.account_assignment WHERE org_id=$1', [fixture.org])).rows[0];
  fixture.sourceAccount = account.source_account_id;
  fixture.account = account.account_id;
  await owner.query(`INSERT INTO core.entity (org_id,entity_id,slug,display_name,has_books,active)
    VALUES ($1,$2,'other','Other',true,true)`, [fixture.otherOrg, fixture.otherEntity]);
});

after(async () => {
  if (h) await h.drop();
  assert.ok(performance.now() - started < 40_000, 'whole suite including cleanup must take under 40 seconds');
});

test('Gate 1: migrator applies once and skips every migration on rerun', async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort();
  assert.equal(h.migration.stdout, `applied ${files.length} skipped 0\nroles bootstrapped: 0\n`);
  const result = await runMigrate(h.databaseUrl);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `applied 0 skipped ${files.length}\nroles bootstrapped: 0\n`);
  const rows = (await owner.query('SELECT name,sha256,applied_at,applied_by FROM meta.migration ORDER BY name')).rows;
  assert.deepEqual(rows.map(r => r.name), files);
  assert.ok(rows.every(r => /^[a-f0-9]{64}$/.test(r.sha256) && r.applied_at && r.applied_by));
});

test('Gate 1: changed applied SQL exits 2 and names the checksum mismatch', async () => {
  const path = new URL('../migrations/020_apply_body.sql', import.meta.url);
  const original = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([original, Buffer.from('\n-- checksum gate tamper\n')]));
    const result = await runMigrate(h.databaseUrl);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /checksum mismatch: 020_apply_body.sql/);
    assert.ok(!result.stderr.includes(h.databaseUrl));
  } finally { await writeFile(path, original); }
  assert.equal((await runMigrate(h.databaseUrl)).code, 0);
});

for (const role of runtimeRoles) {
  test(`Gate 2: ${role} cannot mutate raw, delete facts, assume owner, drop tables, or allocate publications`, async () => {
    const client = clients[role];
    const forbidden = [
      'UPDATE raw.api_call SET endpoint=endpoint', 'DELETE FROM raw.api_call', 'TRUNCATE raw.api_call',
      'DELETE FROM core.transaction', 'SET ROLE ll_owner', 'DROP TABLE raw.api_call',
      "SELECT nextval('ops.publication_seq')",
    ];
    for (const sql of forbidden) await rejectsSql(client, sql, [], '42501', /permission denied|must be owner/);
    if (role === 'll_app') await rejectsSql(client, 'SELECT access_token_enc FROM core.source_connection', [], '42501', /permission denied/);
    if (role === 'll_reader') {
      for (const sql of ['SELECT * FROM raw.api_call','SELECT * FROM core.source_connection','SELECT * FROM ops.publication'])
        await rejectsSql(client, sql, [], '42501', /permission denied/);
    }
    if (role === 'll_sync') {
      for (const sql of [
        'INSERT INTO core.transaction DEFAULT VALUES', 'INSERT INTO raw.sync_acceptance DEFAULT VALUES',
        'INSERT INTO ops.publication DEFAULT VALUES', 'INSERT INTO verify.statement DEFAULT VALUES',
      ]) await rejectsSql(client, sql, [], '42501', /permission denied/);
    }
  });
}

test('Gate 2: every table and routine privilege matches the runtime role matrix', async () => {
  const tables = (await owner.query(`SELECT n.nspname AS schema, c.relname AS name, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('core','raw','verify','ops','serve','meta') AND c.relkind IN ('r','v')`)).rows;
  const coreReader = ['entity','dimension','account','account_entity','account_reporting_scope'];
  const coreSync = ['source_connection','source_account','account_assignment'];
  const coreApp = ['source_account','account','account_assignment'];
  for (const role of runtimeRoles) {
    for (const table of tables) {
      const qualified = `${table.schema}.${table.name}`;
      const actual = (await admin.query(`SELECT has_table_privilege($1,$2::oid,'SELECT') AS sel,
        has_table_privilege($1,$2::oid,'INSERT') AS ins, has_table_privilege($1,$2::oid,'UPDATE') AS upd,
        has_table_privilege($1,$2::oid,'DELETE') AS del, has_table_privilege($1,$2::oid,'TRUNCATE') AS trunc`, [role, table.oid])).rows[0];
      const expectedSelect = role === 'll_backup' ||
        (role === 'll_sync' && (table.schema === 'ops' || (table.schema === 'core' && coreSync.includes(table.name)))) ||
        (role === 'll_app' && table.schema === 'core' && coreApp.includes(table.name)) ||
        (role === 'll_verify' && (['verify','serve'].includes(table.schema) || (table.schema === 'core' && table.name !== 'source_connection'))) ||
        (role === 'll_rebuild' && ['raw','core'].includes(table.schema)) ||
        (role === 'll_reader' && (['verify','serve'].includes(table.schema) || (table.schema === 'core' && coreReader.includes(table.name))));
      assert.equal(actual.sel, expectedSelect, `${role} SELECT ${qualified}`);
      assert.equal(actual.ins, role === 'll_sync' && table.schema === 'raw' && ['api_call','sync_page'].includes(table.name), `${role} INSERT ${qualified}`);
      for (const permission of ['upd','del','trunc']) assert.equal(actual[permission], false, `${role} ${permission} ${qualified}`);
    }
  }
  for (const role of ['ll_app','ll_verify']) {
    const cols = (await admin.query(`SELECT attname, has_column_privilege($1,'core.source_connection',attname,'SELECT') AS allowed
      FROM pg_attribute WHERE attrelid='core.source_connection'::regclass AND attnum>0 AND NOT attisdropped`, [role])).rows;
    for (const c of cols) assert.equal(c.allowed, c.attname !== 'access_token_enc', `${role} column ${c.attname}`);
  }
  const allowed = {
    ll_sync: ['core.accept_publication','core.record_inventory','core.record_health','ops.open_attempt','ops.finish_attempt','ops.raise_alert','ops.heartbeat','core.org_id_for_slug','ops.pending_alerts','ops.record_alert_attempt'],
    ll_app: ['core.register_connection','core.update_connection_token','ops.raise_alert','core.org_id_for_slug','ops.pending_alerts','ops.record_alert_attempt'],
    ll_verify: ['verify.import_statement','verify.run_reconciliation','verify.record_statement_adjustments','verify.resolve_exception','verify.certify','core.apply_ruling','ops.resolve_assigned_account_alerts'],
    ll_rebuild: ['core.rebuild_projections'], ll_backup: ['core.org_id_for_slug','ops.heartbeat'], ll_reader: [],
  };
  const routines = (await owner.query(`SELECT p.oid, n.nspname||'.'||p.proname AS name, p.prosecdef,
    p.proconfig, pg_get_userbyid(p.proowner) AS owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('core','raw','verify','ops','meta')`)).rows;
  for (const routine of routines) {
    for (const role of runtimeRoles) assert.equal(
      (await admin.query('SELECT has_function_privilege($1,$2::oid,\'EXECUTE\') AS ok', [role,routine.oid])).rows[0].ok,
      allowed[role].includes(routine.name), `${role} EXECUTE ${routine.name}`);
    assert.equal(routine.owner, 'll_owner');
    if (Object.values(allowed).some(names => names.includes(routine.name))) {
      assert.equal(routine.prosecdef, true, routine.name);
      assert.deepEqual(routine.proconfig, ['search_path=pg_catalog, core, raw, verify, ops']);
    }
  }
  const memberships = await admin.query(`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
    WHERE r.rolname = ANY($1::text[])`, [runtimeRoles]);
  assert.equal(memberships.rowCount, 0);
});

test('Gate 2: ll_app registers and updates a connection without reading its token', async () => {
  const id = (await clients.ll_app.query("SELECT core.register_connection($1,'app-item',decode('cafe','hex'),'bank','Bank') AS id", [fixture.org])).rows[0].id;
  await clients.ll_app.query("SELECT core.update_connection_token($1,decode('beef','hex'))", [id]);
  assert.equal((await owner.query("SELECT encode(access_token_enc,'hex') AS token FROM core.source_connection WHERE connection_id=$1", [id])).rows[0].token, 'beef');
  const visible = await clients.ll_app.query('SELECT connection_id,state FROM core.source_connection WHERE connection_id=$1', [id]);
  assert.equal(visible.rows[0].state, 'linked');
  const a = (await clients.ll_app.query("SELECT ops.raise_alert($1,'login_required','app-login',$2) AS id", [fixture.org,id])).rows[0].id;
  assert.equal((await clients.ll_app.query("SELECT ops.raise_alert($1,'login_required','app-login',$2) AS id", [fixture.org,id])).rows[0].id, a);
});

test('Gate 2: ll_sync inventories, opens an attempt, accepts an empty fixture and finishes it', async () => {
  const connection = (await clients.ll_app.query("SELECT core.register_connection($1,'sync-item',decode('abcd','hex')) AS id", [fixture.org])).rows[0].id;
  const call = (await clients.ll_sync.query("SELECT nextval('raw.api_call_id_seq') AS id")).rows[0].id;
  await clients.ll_sync.query(`INSERT INTO raw.api_call (id,org_id,connection_id,endpoint,http_status,payload)
    VALUES ($4,$1,$2,'/accounts/get',200,$3)`, [fixture.org, connection, { accounts: [{
    account_id: 'sync-account', name: ' Sync Account ', type: 'depository', capability: 'transactions',
  }] },call]);
  const pub = (await clients.ll_sync.query('SELECT core.record_inventory($1,$2) AS id', [connection,call])).rows[0].id;
  const a = (await owner.query(`SELECT sa.*,aa.account_id,a.status,aa.reason FROM core.source_account sa
    JOIN core.account_assignment aa USING (org_id,source_account_id)
    JOIN core.account a USING (org_id,account_id) WHERE sa.connection_id=$1`, [connection])).rows[0];
  assert.equal(a.external_name, 'Sync Account');
  assert.equal(a.first_seen_publication_id, pub);
  assert.equal(a.status, 'placeholder');
  assert.equal(a.reason, 'placeholder');
  const attempt = await newAttempt(clients.ll_sync, connection);
  const p = await page(attempt,1,connection,clients.ll_sync);
  const before = (await owner.query('SELECT count(*) FROM ops.publication')).rows[0].count;
  await clients.ll_sync.query(acceptSql, [attempt,[p.id],false]);
  assert.equal(Number((await owner.query('SELECT count(*) FROM ops.publication')).rows[0].count), Number(before)+1);
  assert.equal((await owner.query('SELECT count(*) FROM raw.sync_acceptance WHERE attempt_id=$1', [attempt])).rows[0].count, '1');
  assert.equal((await clients.ll_sync.query('SELECT cursor FROM core.source_connection WHERE connection_id=$1', [connection])).rows[0].cursor, 'next');
  const finished = (await clients.ll_sync.query('SELECT status,ended_at FROM ops.sync_attempt WHERE id=$1', [attempt])).rows[0];
  assert.equal(finished.status,'accepted'); assert.ok(finished.ended_at);
  await clients.ll_sync.query("SELECT ops.heartbeat($1,'sync',true,'{}')", [fixture.org]);
  const empty = (await clients.ll_sync.query("SELECT nextval('raw.api_call_id_seq') AS id")).rows[0].id;
  await clients.ll_sync.query(`INSERT INTO raw.api_call (id,org_id,connection_id,endpoint,http_status,payload)
    VALUES ($3,$1,$2,'/accounts/get',200,'{"accounts":[]}')`, [fixture.org,connection,empty]);
  await clients.ll_sync.query('SELECT core.record_inventory($1,$2)', [connection,empty]);
  assert.ok((await clients.ll_sync.query('SELECT missing_since FROM core.source_account WHERE source_account_id=$1', [a.source_account_id])).rows[0].missing_since);
  await clients.ll_sync.query('SELECT core.record_inventory($1,$2)', [connection,call]);
  assert.equal((await clients.ll_sync.query('SELECT missing_since FROM core.source_account WHERE source_account_id=$1', [a.source_account_id])).rows[0].missing_since, null);
});

test('Gate 2: ll_verify imports evidence and certifies an owner-fixtured pass; matching rejects missing facts', async () => {
  const header = { opening_balance: 0, closing_balance: 10, credits_total: 10, debits_total: 0,
    line_count: 1, columns_seen: ['amount','bank_posted_date'] };
  const lines = [{ amount: 10, cleared_period: period, bank_posted_date: '2026-01-15', description: 'Deposit' }];
  const statement = (await clients.ll_verify.query('SELECT verify.import_statement($1,$2,\'bank_csv\',$3,$4,$5) AS id', [fixture.account,period,sha,header,JSON.stringify(lines)])).rows[0].id;
  assert.equal((await clients.ll_verify.query('SELECT count(*) FROM verify.statement_line WHERE statement_id=$1',[statement])).rows[0].count,'1');
  const computed = (await clients.ll_verify.query('SELECT verify.run_reconciliation($1) AS id',[statement])).rows[0].id;
  const failed = (await clients.ll_verify.query('SELECT result,unmatched_lines FROM verify.recon_run WHERE id=$1',[computed])).rows[0];
  assert.equal(failed.result,'fail');
  assert.equal(failed.unmatched_lines,1);
  await rejectsSql(clients.ll_verify,'SELECT verify.certify($1,$2,$3)',[computed,'evidence/failed.csv',sha],'23514',/failed/);
  const head = (await owner.query('SELECT max(id) AS id FROM ops.publication')).rows[0].id;
  // Retain the owner fixture to independently exercise certification privileges.
  const run = (await owner.query(`INSERT INTO verify.recon_run (org_id,account_id,statement_id,publication_id,result,
    opening_ok,closing_ok,debit_diff,credit_diff,unmatched_lines,unmatched_transactions,unresolved_pairs)
    VALUES ($1,$2,$3,$4,'pass',true,true,0,0,0,0,0) RETURNING id`,[fixture.org,fixture.account,statement,head])).rows[0].id;
  const certification = (await clients.ll_verify.query('SELECT verify.certify($1,\'evidence/test.csv\',$2) AS id',[run,sha])).rows[0].id;
  assert.equal((await clients.ll_reader.query('SELECT count(*) FROM serve.v_verified_intervals WHERE certification_id=$1',[certification])).rows[0].count,'1');
  await rejectsSql(clients.ll_verify,'SELECT verify.certify($1,\'evidence/stale.csv\',$2)',[run,sha],'23514',/stale/);
  await owner.query('BEGIN');
  try {
    const pub = await publication();
    await owner.query(`INSERT INTO verify.invalidation (org_id,certification_id,cause,publication_id)
      VALUES ($1,$2,'fact_revision',$3)`,[fixture.org,certification,pub]);
    assert.equal((await owner.query('SELECT count(*) FROM serve.v_verified_intervals WHERE certification_id=$1',[certification])).rows[0].count,'0');
  } finally { await owner.query('ROLLBACK'); }
});

test('Gate 2: ll_reader selects all serving views and coverage exposes every declared axis', async () => {
  for (const view of ['v_account_coverage','v_transaction_current','v_transaction_pending','v_verified_intervals',
    'v_cash_position','v_debt_position','v_cash_activity_month','v_card_activity_month']) {
    await clients.ll_reader.query(`SELECT * FROM serve.${view} LIMIT 1`);
  }
  const coverage = await clients.ll_reader.query('SELECT * FROM serve.v_account_coverage WHERE account_id=$1',[fixture.account]);
  const names = coverage.fields.map(f => f.name);
  for (const name of ['org_id','connection_state','assignment_state','scope','history_state','verification_state',
    'last_acceptance_at','last_successful_update','capability']) assert.ok(names.includes(name),name);
  assert.equal(coverage.rows[0].assignment_state,'placeholder');
});

test('Gate 3: cross-org account_entity references fail the composite FK with 23503', async () => {
  await rejectsSql(owner,`INSERT INTO core.account_entity (org_id,account_id,entity_id,valid,publication_id)
    VALUES ($1,$2,$3,'[2026-01-01,2027-01-01)',$4)`,[fixture.org,fixture.account,fixture.otherEntity,fixture.publication],'23503');
});

test('Gate 3: overlapping account_assignment observation intervals fail with 23P01', async () => {
  await rejectsSql(owner,`INSERT INTO core.account_assignment (org_id,source_account_id,account_id,valid,reason,publication_id)
    VALUES ($1,$2,$3,tstzrange(now(),NULL,'[)'),'ruling',$4)`,[fixture.org,fixture.sourceAccount,fixture.account,fixture.publication],'23P01');
});

test('Gate 3: overlapping account_reporting_scope date intervals fail with 23P01', async () => {
  await rollback(async () => {
    const sql = `INSERT INTO core.account_reporting_scope (org_id,account_id,scope,valid,publication_id)
      VALUES ($1,$2,'included',$3,$4)`;
    await owner.query(sql,[fixture.org,fixture.account,'[2026-01-01,2027-01-01)',fixture.publication]);
    await rejectsSql(owner,sql,[fixture.org,fixture.account,period,fixture.publication],'23P01');
  });
});

test('Gate 3: two authoritative aliases for one transaction fail the partial unique index with 23505', async () => {
  await rollback(async () => {
    const id = randomUUID();
    await owner.query(`INSERT INTO core.identity_allocation (org_id,transaction_id,allocated_publication_id,first_connection_id,first_external_id)
      VALUES ($1,$2,$3,$4,'alias-fixture')`,[fixture.org,id,fixture.publication,fixture.connection]);
    await owner.query(`INSERT INTO core.transaction (org_id,transaction_id,source_account_id,account_id,revision,revision_publication_id)
      VALUES ($1,$2,$3,$4,1,$5)`,[fixture.org,id,fixture.sourceAccount,fixture.account,fixture.publication]);
    const sql = `INSERT INTO core.transaction_alias (org_id,connection_id,external_id,transaction_id,role,authoritative,state,
      first_seen_publication_id,last_seen_publication_id) VALUES ($1,$2,$3,$4,'posted',$5,'active',$6,$6)`;
    await owner.query(sql,[fixture.org,fixture.connection,'posted-1',id,true,fixture.publication]);
    // Multiple non-authoritative aliases remain legal.
    await owner.query(sql,[fixture.org,fixture.connection,'pending-1',id,false,fixture.publication]);
    await owner.query(sql,[fixture.org,fixture.connection,'pending-2',id,false,fixture.publication]);
    await rejectsSql(owner,sql,[fixture.org,fixture.connection,'posted-2',id,true,fixture.publication],'23505');
  });
});

test('Gate 3: entity parent cycles fail with 23514', async () => {
  await rollback(async () => {
    const child = randomUUID();
    await owner.query(`INSERT INTO core.entity (org_id,entity_id,slug,display_name,parent_entity_id,has_books,active)
      VALUES ($1,$2,'child','Child',$3,true,true)`,[fixture.otherOrg,child,fixture.otherEntity]);
    await rejectsSql(owner,'UPDATE core.entity SET parent_entity_id=$1 WHERE entity_id=$2',[child,fixture.otherEntity],'23514',/cycle/);
  });
});

test('Gate 3: account_entity dimensions must belong to its entity (23514)', async () => {
  await rollback(async () => {
    const entity = randomUUID(), wrongEntity = randomUUID(), dimension = randomUUID();
    await owner.query(`INSERT INTO core.entity (org_id,entity_id,slug,display_name,has_books,active)
      VALUES ($1,$2,'a','A',true,true),($1,$3,'b','B',true,true)`,[fixture.org,entity,wrongEntity]);
    await owner.query("INSERT INTO core.dimension (org_id,dimension_id,entity_id,slug,display_name) VALUES ($1,$2,$3,'bad-dimension','Bad')",[fixture.org,dimension,wrongEntity]);
    await rejectsSql(owner,`INSERT INTO core.account_entity (org_id,account_id,entity_id,dimension_id,valid,publication_id)
      VALUES ($1,$2,$3,$4,$5,$6)`,[fixture.org,fixture.account,entity,dimension,period,fixture.publication],'23514',/dimension/);
  });
});

test('Gate 3: acceptance rejects pages from another attempt with 23514', async () => {
  const attempt = await newAttempt(), other = await newAttempt();
  const p = await page(other);
  await rejectsSql(owner,`INSERT INTO raw.sync_acceptance (org_id,publication_id,connection_id,attempt_id,
    cursor_out,page_ids,projection_version) VALUES ($1,$2,$3,$4,'next',$5,1)`,
  [fixture.org,fixture.publication,fixture.connection,attempt,[p.id]],'23514',/pages/);
});

test('Gate 3: acceptance rejects non-consecutive and duplicate page numbers with 23514', async () => {
  const attempt = await newAttempt();
  const one = await page(attempt,1), three = await page(attempt,3);
  for (const ids of [[three.id],[one.id,three.id],[one.id,one.id],[null],[]]) {
    await rejectsSql(owner,`INSERT INTO raw.sync_acceptance (org_id,publication_id,connection_id,attempt_id,
      cursor_out,page_ids,projection_version) VALUES ($1,$2,$3,$4,'next',$5,1)`,
    [fixture.org,fixture.publication,fixture.connection,attempt,ids],'23514',/pages/);
  }
});

test('Gate 3: owner UPDATE and DELETE on raw.api_call raise IMMUTABLE_ROW', async () => {
  const id = (await owner.query('SELECT id FROM raw.api_call LIMIT 1')).rows[0].id;
  for (const sql of ['UPDATE raw.api_call SET endpoint=endpoint WHERE id=$1','DELETE FROM raw.api_call WHERE id=$1'])
    await rejectsSql(owner,sql,[id],'P0001',/IMMUTABLE_ROW/);
});

test('Gate 3: every required durable table has an unconditional immutable guard', async () => {
  const expected = ['raw.api_call','raw.sync_page','raw.sync_acceptance','ops.publication',
    'core.ruling_event','core.identity_decision','core.identity_allocation','core.account_allocation',
    'verify.recon_run','verify.recon_match','verify.certification','verify.statement_adjustment'];
  const guarded = (await owner.query(`SELECT n.nspname||'.'||c.relname AS name, t.tgtype, t.tgqual
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE t.tgfoid='meta.immutable_guard()'::regprocedure`)).rows;
  assert.deepEqual(guarded.map(r => r.name).sort(),expected.sort());
  assert.ok(guarded.every(t => t.tgtype === 27 && t.tgqual === null)); // ROW|BEFORE|DELETE|UPDATE
});

test('Gate 3: duplicate identity_decision event keys fail with 23505', async () => {
  await rollback(async () => {
    const sql = `INSERT INTO core.identity_decision (org_id,publication_id,position,kind,subject_connection_id,
      subject_external_id,object_external_id,decided_by) VALUES ($1,$2,$3,'pending_claim',$4,'posted','pending','system:v1')`;
    await owner.query(sql,[fixture.org,fixture.publication,1,fixture.connection]);
    assert.equal((await owner.query('SELECT event_key FROM core.identity_decision WHERE subject_external_id=\'posted\'')).rows[0].event_key,
      `pending_claim:${fixture.connection}:posted:pending`);
    await rejectsSql(owner,sql,[fixture.org,fixture.publication,2,fixture.connection],'23505');
  });
});

test('Gate 4: all 24 declared connection transitions succeed and append exactly one state event', async () => {
  const edges = (await owner.query('SELECT * FROM core.connection_transition ORDER BY from_state,to_state')).rows;
  const expected = [
    'linked>inventoried','inventoried>initial_sync','initial_sync>ok','initial_sync>retryable_error','initial_sync>login_required',
    'ok>retryable_error','ok>login_required','ok>poisoned','retryable_error>ok','retryable_error>login_required',
    'retryable_error>poisoned','login_required>ok','login_required>replaced','poisoned>ok','poisoned>replaced','ok>replaced',
    ...['linked','inventoried','initial_sync','ok','retryable_error','login_required','poisoned','replaced'].map(s => `${s}>removed`),
  ].sort();
  assert.deepEqual(edges.map(e => `${e.from_state}>${e.to_state}`).sort(),expected);
  for (const edge of edges) {
    await rollback(async () => {
      const c = (await owner.query(`INSERT INTO core.source_connection (org_id,source,external_id,state)
        VALUES ($1,'plaid',$2,$3) RETURNING connection_id`,[fixture.org,randomUUID(),edge.from_state])).rows[0].connection_id;
      await owner.query('UPDATE core.source_connection SET state=$1 WHERE connection_id=$2',[edge.to_state,c]);
      const events = (await owner.query('SELECT from_state,to_state FROM ops.connection_state_event WHERE connection_id=$1',[c])).rows;
      assert.deepEqual(events,[edge]);
      assert.equal((await owner.query('SELECT state FROM core.source_connection WHERE connection_id=$1',[c])).rows[0].state,edge.to_state);
      await owner.query('UPDATE core.source_connection SET institution_name=\'changed\' WHERE connection_id=$1',[c]);
      assert.equal((await owner.query('SELECT count(*) FROM ops.connection_state_event WHERE connection_id=$1',[c])).rows[0].count,'1');
    });
  }
});

test('Gate 4: five sampled illegal connection transitions fail with 23514 and emit no event', async () => {
  for (const [from,to] of [['linked','ok'],['inventoried','ok'],['ok','linked'],['removed','linked'],['replaced','ok']]) {
    await rollback(async () => {
      const c = (await owner.query(`INSERT INTO core.source_connection (org_id,source,external_id,state)
        VALUES ($1,'plaid',$2,$3) RETURNING connection_id`,[fixture.org,randomUUID(),from])).rows[0].connection_id;
      await owner.query('SAVEPOINT illegal_edge');
      await rejectsSql(owner,'UPDATE core.source_connection SET state=$1 WHERE connection_id=$2',[to,c],'23514',/illegal connection transition/);
      await owner.query('ROLLBACK TO SAVEPOINT illegal_edge');
      assert.equal((await owner.query('SELECT count(*) FROM ops.connection_state_event WHERE connection_id=$1',[c])).rows[0].count,'0');
      assert.equal((await owner.query('SELECT state FROM core.source_connection WHERE connection_id=$1',[c])).rows[0].state,from);
    });
  }
});

test('Gate 5: real concurrent accept sessions serialize publications and pg_locks proves third-session blocking', { timeout: 10_000 }, async () => {
  const a = await h.asRole('ll_sync'), b = await h.asRole('ll_sync'), blocker = await h.asOwner();
  const attemptA = await newAttempt(a), attemptB = await newAttempt(b);
  const pageA = await page(attemptA), pageB = await page(attemptB);
  const pidB = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  let pending;
  async function waitForBlock() {
    const end = performance.now() + 2500;
    while (performance.now() < end) {
      const locks = await admin.query(`SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'
        AND classid=0 AND objid=7777 AND NOT granted`,[pidB]);
      if (locks.rowCount) return;
      await delay(15);
    }
    assert.fail('second acceptance was not waiting on publication lock 7777');
  }
  try {
    await a.query('BEGIN');
    const idA = (await a.query(acceptSql,[attemptA,[pageA.id],true])).rows[0].id;
    await b.query('BEGIN');
    pending = b.query(acceptSql,[attemptB,[pageB.id],true]);
    // Attach a rejection observer immediately so cleanup cannot create an unhandled rejection.
    pending.catch(() => {});
    await waitForBlock();
    assert.equal((await admin.query('SELECT count(*) FROM ops.publication WHERE id=$1',[idA])).rows[0].count,'0');
    await a.query('COMMIT');
    const idB = (await pending).rows[0].id;
    await b.query('COMMIT');
    assert.ok(BigInt(idA) < BigInt(idB));
    assert.deepEqual((await admin.query('SELECT id FROM ops.publication WHERE id=ANY($1::bigint[]) ORDER BY id',[[idA,idB]])).rows.map(r => r.id),[idA,idB]);
    // A third real session holding the lock must also prevent allocation by B.
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(7777)');
    const head = (await admin.query('SELECT max(id) AS id FROM ops.publication')).rows[0].id;
    await b.query('BEGIN');
    pending = b.query(acceptSql,[attemptB,[pageB.id],true]);
    pending.catch(() => {});
    await waitForBlock();
    assert.equal((await admin.query('SELECT max(id) AS id FROM ops.publication')).rows[0].id,head);
    await blocker.query('COMMIT');
    const idC = (await pending).rows[0].id;
    await b.query('COMMIT');
    assert.ok(BigInt(idB) < BigInt(idC));
    assert.equal((await admin.query('SELECT count(*) FROM raw.sync_acceptance WHERE attempt_id=ANY($1::bigint[])',[[attemptA,attemptB]])).rows[0].count,'0');
  } finally {
    // Release locks before draining a potentially blocked query.
    await a.query('ROLLBACK'); await blocker.query('ROLLBACK');
    if (pending) await pending.catch(() => {});
    await b.query('ROLLBACK');
    await Promise.all([a.end(),b.end(),blocker.end()]);
  }
});

test('Gate 6: the example org has three entities, one correctly parented dimension, nine exact alert rules, and one seed ruling publication', async () => {
  const org = (await owner.query("SELECT org_id FROM core.org WHERE slug='main'")).rows[0].org_id;
  const entities = (await owner.query('SELECT slug FROM core.entity WHERE org_id=$1 ORDER BY slug',[org])).rows.map(r => r.slug);
  assert.deepEqual(entities,['example_company','example_farm','personal'].sort());
  const dimensions = (await owner.query(`SELECT d.slug,e.slug AS entity FROM core.dimension d
    JOIN core.entity e ON e.org_id=d.org_id AND e.entity_id=d.entity_id WHERE d.org_id=$1 ORDER BY d.slug`,[org])).rows;
  assert.deepEqual(dimensions,[{slug:'example_division',entity:'example_company'}]);
  const rules = (await owner.query('SELECT key,extract(epoch FROM threshold_interval)::int AS seconds,severity FROM ops.alert_rule ORDER BY key')).rows;
  const expected = [
    ['bank_update_stale',36,'page'],['inventory_stale',48,'page'],['login_required',4,'page'],['poisoned_attempt',0,'page'],
    ['new_account',0,'warn'],['unknown_modified',0,'warn'],['competing_claim',0,'warn'],['backup_age',10,'page'],['coverage_gap',24,'warn'],
  ].map(([key,hours,severity]) => ({key,seconds:hours*3600,severity})).sort((a,b) => a.key.localeCompare(b.key));
  assert.deepEqual(rules,expected);
  const publications = (await owner.query("SELECT id FROM ops.publication WHERE org_id=$1 AND kind='ruling'",[org])).rows;
  assert.equal(publications.length,1);
  const events = (await owner.query('SELECT kind,position FROM core.ruling_event WHERE publication_id=$1 ORDER BY position',[publications[0].id])).rows;
  assert.deepEqual(events.map(e => e.position),Array.from({length:4},(_,i) => i+1));
  assert.deepEqual(events.map(e => e.kind),[...Array(3).fill('entity'),'dimension']);
});

test('Gate 2: backup reads durable evidence and rebuild refuses an unreplayable owner fixture atomically', async () => {
  assert.ok((await clients.ll_backup.query('SELECT count(*) FROM raw.api_call')).rows[0].count > 0);
  assert.ok((await clients.ll_backup.query('SELECT count(*) FROM meta.migration')).rows[0].count > 0);
  await clients.ll_rebuild.query('SELECT * FROM raw.api_call LIMIT 1');
  const before = (await owner.query('SELECT count(*) FROM core.entity')).rows[0].count;
  await publication(); // Deliberately lacks the inventory raw-call pointer.
  await rejectsSql(clients.ll_rebuild,'SELECT core.rebuild_projections()',[],'P0001',/REBUILD_MISSING_INVENTORY/);
  assert.equal((await owner.query('SELECT count(*) FROM core.entity')).rows[0].count,before);
});

test('Gate 2: ll_verify projects real entity, dimension, and assignment rulings', async () => {
  const entity = randomUUID(), dimension = randomUUID();
  const pub = (await clients.ll_verify.query('SELECT core.apply_ruling(\'entity\',$1,$2,\'fixture ruling\',\'operator\') AS id',
    [entity,{org_id:fixture.org,slug:'ruling-entity',display_name:'Ruling Entity',has_books:true,active:true}])).rows[0].id;
  assert.equal((await clients.ll_verify.query('SELECT display_name FROM core.entity WHERE entity_id=$1',[entity])).rows[0].display_name,'Ruling Entity');
  const dimensionPub = (await clients.ll_verify.query('SELECT core.apply_ruling(\'dimension\',$1,$2,\'fixture dimension\',\'operator\') AS id',
    [dimension,{org_id:fixture.org,entity_id:entity,slug:'ruling-dimension',display_name:'Ruling Dimension'}])).rows[0].id;
  assert.ok(BigInt(dimensionPub)>BigInt(pub));
  assert.equal((await owner.query('SELECT count(*) FROM core.ruling_event WHERE publication_id=ANY($1::bigint[])',[[pub,dimensionPub]])).rows[0].count,'2');
  const before = (await owner.query('SELECT count(*) FROM ops.publication')).rows[0].count;
  await clients.ll_verify.query('SELECT core.apply_ruling(\'assignment\',$1,$2,\'assignment\',\'operator\')',
    [fixture.sourceAccount,{org_id:fixture.org,account_id:fixture.account}]);
  assert.equal(Number((await owner.query('SELECT count(*) FROM ops.publication')).rows[0].count),Number(before)+1);
});

test('Gate 2: malformed procedure input is refused before creating operational rows', async () => {
  await rejectsSql(clients.ll_app,"SELECT core.register_connection($1,'',decode('ab','hex'))",[fixture.org],'22023');
  await rejectsSql(clients.ll_sync,'SELECT ops.open_attempt($1,NULL,-1)',[fixture.connection],'22023');
  await rejectsSql(clients.ll_sync,"SELECT ops.heartbeat($1,'',true)",[fixture.org],'22023');
  await rejectsSql(clients.ll_sync,"SELECT ops.raise_alert($1,'not-a-rule','bad')",[fixture.org],'22023');
  await rejectsSql(clients.ll_sync,acceptSql,[null,[],false],'22023');
  const header = {opening_balance:0,closing_balance:10,credits_total:10,debits_total:0,line_count:0};
  await rejectsSql(clients.ll_verify,"SELECT verify.import_statement($1,$2,'bank_csv',$3,$4,'[]')",
    [fixture.account,period,sha,header],'23514',/totals disagree/);
});

test('Gate 3: acceptance refuses stale cursor/predecessor and invalid terminal chains atomically', async () => {
  const attempt = await newAttempt();
  const p = await page(attempt);
  await rollback(async () => {
    await owner.query("UPDATE core.source_connection SET cursor='different' WHERE connection_id=$1",[fixture.connection]);
    await rejectsSql(owner,acceptSql,[attempt,[p.id],false],'23514',/stale attempt/);
  });
  await rollback(async () => {
    const pub = await publication();
    await owner.query('UPDATE core.source_connection SET last_publication_id=$1 WHERE connection_id=$2',[pub,fixture.connection]);
    await rejectsSql(owner,acceptSql,[attempt,[p.id],false],'23514',/stale attempt/);
  });
  const brokenAttempt = await newAttempt();
  await owner.query('BEGIN');
  let id;
  try {
    const api = (await owner.query(`INSERT INTO raw.api_call (org_id,connection_id,endpoint,http_status,payload)
      VALUES ($1,$2,'/transactions/sync',200,'{}') RETURNING id`,[fixture.org,fixture.connection])).rows[0].id;
    id = (await owner.query(`INSERT INTO raw.sync_page (org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more)
      VALUES ($1,$2,1,$3,'wrong','next',false) RETURNING id`,[fixture.org,brokenAttempt,api])).rows[0].id;
    await owner.query('COMMIT');
  } catch (e) { await owner.query('ROLLBACK'); throw e; }
  await rejectsSql(clients.ll_sync,acceptSql,[brokenAttempt,[id],false],'23514',/cursor chain/);
  assert.equal((await owner.query('SELECT count(*) FROM raw.sync_acceptance WHERE attempt_id=$1',[brokenAttempt])).rows[0].count,'0');
});

test('Gate 7: complete Step 0 gate stays within the 40-second budget on the test cluster', () => {
  assert.ok(performance.now()-started < 40_000);
});

test('Step 1 database helpers: app encrypts in SQL; runtime delivery records attempts without table grants', async () => {
  const registered = (await clients.ll_app.query(`SELECT core.register_connection(core.org_id_for_slug($1), $2,
    public.pgp_sym_encrypt($3::text, $4::text), $5::text, $6::text, $7::uuid) AS id`,
  ['fixture', 'step1-item', 'fixture-access-token', 'fixture-kek', 'ins_fixture', 'Fixture Bank', null])).rows[0].id;
  assert.equal((await owner.query('SELECT public.pgp_sym_decrypt(access_token_enc,$2) AS token FROM core.source_connection WHERE connection_id=$1',
    [registered,'fixture-kek'])).rows[0].token, 'fixture-access-token');
  const alertId = (await clients.ll_app.query("SELECT ops.raise_alert($1,'login_required','step1-delivery') AS id", [fixture.org])).rows[0].id;
  assert.ok((await clients.ll_app.query('SELECT * FROM ops.pending_alerts()')).rows.some(r => r.id === alertId));
  await clients.ll_sync.query('SELECT ops.record_alert_attempt($1,false)', [alertId]);
  await clients.ll_app.query('SELECT ops.record_alert_attempt($1,true)', [alertId]);
  const row = (await owner.query('SELECT attempts,delivered_at FROM ops.alert WHERE id=$1', [alertId])).rows[0];
  assert.equal(row.attempts, 2); assert.ok(row.delivered_at);
  assert.ok(!(await clients.ll_app.query('SELECT * FROM ops.pending_alerts()')).rows.some(r => r.id === alertId));
  await rejectsSql(clients.ll_app,'UPDATE ops.alert SET attempts=99 WHERE id=$1',[alertId],'42501');
  await clients.ll_backup.query("SELECT ops.heartbeat(core.org_id_for_slug('fixture'),'backup',true,'{}')");
});

test('Step 1 database bootstrap: quoted password binds safely and reruns idempotently', async () => {
  const password = "fixture-'$;\\-password";
  const result = await runMigrate(h.databaseUrl, { ROLE_PASSWORD_LL_READER: password });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /roles bootstrapped: 1\n$/);
  assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
  assert.equal((await admin.query("SELECT rolcanlogin,rolsuper FROM pg_roles WHERE rolname='ll_reader'")).rows[0].rolsuper, false);
  assert.ok((await admin.query("SELECT rolpassword IS NOT NULL AS set FROM pg_authid WHERE rolname='ll_reader'")).rows[0].set);
  const url = new URL(h.databaseUrl); url.username = 'll_reader'; url.password = password;
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'll_reader');
  } finally { await client.end(); }
  const rerun = await runMigrate(h.databaseUrl, { ROLE_PASSWORD_LL_READER: password });
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.match(rerun.stdout, /applied 0 skipped \d+\nroles bootstrapped: 1\n$/);
  await runMigrate(h.databaseUrl, { ROLE_PASSWORD_LL_READER: 'll_reader' });
});

test('Step 1 database bootstrap: all six role password variables enable their matching login', async () => {
  const passwords = Object.fromEntries(runtimeRoles.map(role => [`ROLE_PASSWORD_${role.toUpperCase()}`, `fixture-${role}-'$;\\-password`]));
  try {
    const result = await runMigrate(h.databaseUrl, passwords);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /roles bootstrapped: 6\n$/);
    for (const role of runtimeRoles) {
      const password = passwords[`ROLE_PASSWORD_${role.toUpperCase()}`];
      assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
      const url = new URL(h.databaseUrl); url.username = role; url.password = password;
      const client = new pg.Client({ connectionString: url.href });
      try {
        await client.connect();
        assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, role);
      } finally { await client.end(); }
    }
  } finally {
    const reset = await runMigrate(h.databaseUrl, Object.fromEntries(runtimeRoles.map(role => [`ROLE_PASSWORD_${role.toUpperCase()}`, role])));
    assert.equal(reset.code, 0, reset.stderr);
  }
});
