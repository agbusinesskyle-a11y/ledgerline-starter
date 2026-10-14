import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createHarness } from './harness.js';

const started = performance.now();
let h, owner, sync, verify, rebuild, org;
const period = '[2026-01-01,2026-02-01)';
const projectionTables = ['transaction','transaction_alias','transaction_revision','balance_observation','quarantine',
  'account','account_assignment','account_entity','account_reporting_scope','entity','dimension'];
before(async () => {
  h = await createHarness(); owner = await h.asOwner(); sync = await h.asRole('ll_sync');
  verify = await h.asRole('ll_verify'); rebuild = await h.asRole('ll_rebuild');
  org = randomUUID();
  await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'step2a','Step 2a')", [org]);
});
after(async () => { if (h) await h.drop(); assert.ok(performance.now()-started < 40_000); });
const rows = async (sql, args=[]) => (await owner.query(sql,args)).rows;
const one = async (sql,args=[]) => (await rows(sql,args))[0];
async function connection() {
  return (await one("SELECT core.register_connection($1,$2,decode('abcd','hex')) AS id",[org,randomUUID()])).id;
}
function obj(id, extra={}) {
  return {transaction_id:id,account_id:'bank-account',amount:12.34,iso_currency_code:'USD',date:'2026-01-10',
    authorized_date:'2026-01-09',pending:false,name:'Shop',original_description:'Original',merchant_name:'Merchant',
    merchant_entity_id:'merchant',personal_finance_category:{primary:'SHOPPING',detailed:'SHOPPING_GENERAL',confidence_level:'HIGH'},
    personal_finance_category_version:'v2',payment_channel:'in store',check_number:'123',counterparties:[],location:{city:'Phoenix'},
    payment_meta:{reference_number:'abc'},...extra};
}
async function fixturePage(c,payload,existingAttempt) {
  const attempt = existingAttempt || (await sync.query('SELECT ops.open_attempt($1) AS id',[c])).rows[0].id;
  const a = await one('SELECT * FROM ops.sync_attempt WHERE id=$1',[attempt]);
  const cursor = randomUUID();
  await owner.query('BEGIN');
  try {
    const api = (await one(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
      VALUES($1,$2,'/transactions/sync',200,$3) RETURNING id`,[org,c,{added:[],modified:[],removed:[],...payload,next_cursor:cursor,has_more:false}])).id;
    const page = (await one(`INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more)
      VALUES($1,$2,1,$3,$4,$5,false) RETURNING id`,[org,attempt,api,a.cursor_in,cursor])).id;
    await owner.query('COMMIT'); return {attempt,api,page,cursor,c};
  } catch(e) { await owner.query('ROLLBACK'); throw e; }
}
async function accept(f,transitions,balances=[]) {
  return (await sync.query('SELECT core.accept_publication($1,$2,$3,$4,$5,1) AS id',
    [f.attempt,[f.page],f.cursor,JSON.stringify(transitions),JSON.stringify(balances)])).rows[0].id;
}
async function send(c,objects=[],removed=[],specified) {
  const f = await fixturePage(c,{added:objects,removed:removed.map(transaction_id=>({transaction_id}))});
  // Fixtures explicitly supply the contract's canonical transitions. No sync loop
  // or production Node reducer is implemented in Step 2a.
  const transitions = specified ? specified(f.api) : [
    ...objects.filter(o=>o.pending_transaction_id).map(o=>({kind:'pending_claim',external_id:o.transaction_id,
      object_external_id:o.pending_transaction_id,api_call_id:Number(f.api),obj:o})),
    ...objects.filter(o=>!o.pending_transaction_id).map(o=>({kind:'upsert',external_id:o.transaction_id,api_call_id:Number(f.api),obj:o})),
    ...removed.map(external_id=>({kind:'removed',external_id,api_call_id:Number(f.api)}))];
  return {...f,pub:await accept(f,transitions),transitions};
}
const fact = c => one(`SELECT t.* FROM core.transaction t JOIN core.transaction_alias a USING(transaction_id)
  WHERE a.connection_id=$1 AND a.authoritative`,[c]);
const alias = (c,id) => one('SELECT * FROM core.transaction_alias WHERE connection_id=$1 AND external_id=$2',[c,id]);
async function ruling(kind,subject,after) {
  return (await verify.query("SELECT core.apply_ruling($1,$2,$3,'reviewed fixture','operator') AS id",[kind,subject,{org_id:org,...after}])).rows[0].id;
}
async function assign(c) {
  const s = await one('SELECT source_account_id FROM core.source_account WHERE connection_id=$1',[c]);
  const account = randomUUID(); const pub = await ruling('assignment',s.source_account_id,{account_id:account});
  return {account,pub,source:s.source_account_id};
}
async function certification(account,pub,interval=period) {
  const s = (await one(`INSERT INTO verify.statement(org_id,account_id,version,period,source)
    SELECT $1,$2,coalesce(max(version),0)+1,$3,'bank_csv' FROM verify.statement WHERE account_id=$2 RETURNING id`,[org,account,interval])).id;
  const run = (await one(`INSERT INTO verify.recon_run(org_id,account_id,statement_id,publication_id,result)
    VALUES($1,$2,$3,$4,'pass') RETURNING id`,[org,account,s,pub])).id;
  return (await one(`INSERT INTO verify.certification(org_id,account_id,period,recon_run_id,publication_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id`,[org,account,interval,run,pub])).id;
}
async function snapshot() {
  const result={};
  for (const table of projectionTables) {
    result[table] = (await rows(`SELECT to_jsonb(t) AS row FROM core.${table} t`)).map(({row}) =>
      Object.fromEntries(Object.entries(row).filter(([key])=>!key.endsWith('_at'))));
    result[table].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
async function counts() {
  return one(`SELECT (SELECT count(*) FROM core.identity_allocation) allocations,
    (SELECT count(*) FROM core.identity_decision) decisions,(SELECT count(*) FROM core.ruling_event) rulings,
    (SELECT count(*) FROM core.transaction_revision) revisions`);
}

test('Step2a: a simple added allocates identity and resolves a placeholder with inverted amount', async () => {
  const c=await connection(), f=await send(c,[obj('A')]), t=await fact(c), a=await alias(c,'A');
  assert.equal(t.amount,'-12.34'); assert.equal(t.revision,1); assert.equal(a.authoritative,true);
  assert.equal(a.transaction_id,t.transaction_id); assert.equal(t.pfc_detailed,'SHOPPING_GENERAL');
  assert.equal((await one('SELECT status FROM core.account WHERE account_id=$1',[t.account_id])).status,'placeholder');
  const allocation=await one('SELECT * FROM core.identity_allocation WHERE transaction_id=$1',[t.transaction_id]);
  assert.equal(allocation.first_external_id,'A'); assert.equal(allocation.allocated_publication_id,f.pub);
  const revision=await one('SELECT * FROM core.transaction_revision WHERE transaction_id=$1',[t.transaction_id]);
  assert.equal(revision.cause,'added'); assert.equal(revision.source_api_call_id,f.api); assert.equal(revision.predecessor_revision,null);
});

test('Step2a: b pending P then posted Q in a later acceptance preserves identity', async () => {
  const c=await connection(); await send(c,[obj('P',{pending:true})]); const id=(await fact(c)).transaction_id;
  await send(c,[obj('Q',{pending_transaction_id:'P',amount:20})]); const t=await fact(c);
  assert.equal(t.transaction_id,id); assert.equal(t.revision,2); assert.equal(t.pending,false);
  assert.equal((await alias(c,'P')).state,'superseded'); assert.equal((await alias(c,'P')).authoritative,false);
  assert.equal((await one('SELECT kind FROM core.identity_decision WHERE subject_connection_id=$1',[c])).kind,'pending_claim');
  await assign(c);
  assert.deepEqual((await rows('SELECT transaction_id,pending FROM serve.v_transaction_current WHERE authoritative_connection_id=$1',[c])),[{transaction_id:id,pending:false}]);
  assert.equal((await rows('SELECT * FROM serve.v_transaction_pending WHERE authoritative_connection_id=$1',[c])).length,0);
});

test('Step2a: c same-acceptance claim drops pending removal and preserves identity', async () => {
  const c=await connection(); await send(c,[obj('P',{pending:true})]); const id=(await fact(c)).transaction_id;
  const q=obj('Q',{pending_transaction_id:'P'});
  await send(c,[q],['P'],api=>[{kind:'pending_claim',external_id:'Q',object_external_id:'P',api_call_id:Number(api),obj:q}]);
  assert.equal((await fact(c)).transaction_id,id); assert.equal((await fact(c)).revision,2);
  assert.equal((await alias(c,'P')).state,'superseded'); assert.equal((await alias(c,'Q')).authoritative,true);
});

test('Step2a: d unknown pending claim records a superseded alias and prevents a ghost', async () => {
  const c=await connection(); await send(c,[obj('Q',{pending_transaction_id:'P'})]); const t=await fact(c);
  assert.equal((await alias(c,'P')).transaction_id,t.transaction_id);
  assert.equal((await rows('SELECT * FROM core.identity_decision WHERE subject_connection_id=$1',[c])).length,1);
  await send(c,[obj('P',{pending:true})]); assert.deepEqual(await fact(c),t);
  assert.equal((await one("SELECT kind FROM core.quarantine WHERE connection_id=$1",[c])).kind,'unknown_modified');
  assert.equal((await rows('SELECT * FROM serve.v_transaction_pending WHERE authoritative_connection_id=$1',[c])).length,0);
});

test('Step2a: e competing claimants quarantine together and leave P untouched', async () => {
  const c=await connection(); await send(c,[obj('P',{pending:true})]); const t=await fact(c);
  const objects=['Q1','Q2'].map(id=>obj(id,{pending_transaction_id:'P'}));
  await send(c,objects,[],api=>objects.map(o=>({kind:'quarantine',external_id:o.transaction_id,
    quarantine_kind:'competing_claim',api_call_id:Number(api),obj:o})));
  assert.deepEqual(await fact(c),t);
  const q=await rows('SELECT kind,payload FROM core.quarantine WHERE connection_id=$1 ORDER BY external_id',[c]);
  assert.deepEqual(q.map(x=>x.kind),['competing_claim','competing_claim']); assert.deepEqual(q.map(x=>x.payload),objects);
});

test('Step2a: f modification through a superseded alias cannot change the fact', async () => {
  const c=await connection(); await send(c,[obj('P',{pending:true})]); await send(c,[obj('Q',{pending_transaction_id:'P'})]);
  const t=await fact(c); await send(c,[obj('P',{pending:true,amount:999,date:'2026-01-20'})]);
  assert.deepEqual(await fact(c),t); assert.equal((await one('SELECT kind FROM core.quarantine WHERE connection_id=$1',[c])).kind,'unknown_modified');
});

test('Step2a: g pending removal leaves the fact; posted removal and reactivation write revisions', async () => {
  const c=await connection(); await send(c,[obj('P',{pending:true})]); await send(c,[obj('Q',{pending_transaction_id:'P'})]);
  const t=await fact(c); await send(c,[],['P']); assert.deepEqual(await fact(c),t); assert.equal((await alias(c,'P')).state,'removed');
  await send(c,[],['Q']); assert.equal((await fact(c)).status,'removed'); assert.equal((await fact(c)).revision,3);
  await send(c,[obj('Q')]); assert.equal((await fact(c)).status,'active'); assert.equal((await fact(c)).revision,4);
  assert.equal((await one('SELECT cause FROM core.transaction_revision WHERE transaction_id=$1 AND revision=4',[t.transaction_id])).cause,'reactivated');
});

test('Step2a: h currency quarantine and restoration invalidate current certifications', async () => {
  const c=await connection(); await send(c,[obj('EUR',{iso_currency_code:'EUR'})]); assert.equal(await fact(c),undefined);
  assert.equal((await rows('SELECT * FROM core.identity_allocation WHERE first_connection_id=$1',[c])).length,0);
  const first=await send(c,[obj('USD')]); const t=await fact(c); const cert=await certification(t.account_id,first.pub);
  await send(c,[obj('USD',{iso_currency_code:'EUR'})]); assert.equal((await fact(c)).status,'quarantined');
  assert.equal((await one('SELECT cause FROM verify.invalidation WHERE certification_id=$1',[cert])).cause,'currency');
  // "current" excludes an already invalidated certification; certify a new
  // immutable fixture before restoration to exercise the second invalidation.
  const cert2=await certification(t.account_id,(await fact(c)).revision_publication_id);
  await send(c,[obj('USD')]); assert.equal((await fact(c)).status,'active');
  assert.equal((await one('SELECT cause FROM verify.invalidation WHERE certification_id=$1',[cert2])).cause,'currency');
  assert.equal((await rows('SELECT * FROM verify.invalidation WHERE certification_id=ANY($1::uuid[])',[[cert,cert2]])).length,2);
});

test('Step2a: i duplicate acceptance returns its publication with zero new side effects', async () => {
  const c=await connection(); const f=await send(c,[obj('Q',{pending_transaction_id:'P'})]);
  await send(c,[obj('Q')]); // The original attempt now has a stale predecessor.
  const before=await counts(), snap=await snapshot();
  assert.equal(await accept(f,f.transitions),f.pub);
  assert.equal((await sync.query('SELECT core.accept_publication($1,NULL,NULL,NULL,NULL,NULL,NULL) AS id',[f.attempt])).rows[0].id,f.pub); assert.deepEqual(await counts(),before); assert.deepEqual(await snapshot(),snap);
});

test('Step2a: j cursor and predecessor mismatches roll back every publication and fact', async () => {
  for (const column of ['cursor','last_publication_id']) {
    const c=await connection(), f=await fixturePage(c,{added:[obj('X')]});
    await owner.query(`UPDATE core.source_connection SET ${column}=$1 WHERE connection_id=$2`,[column==='cursor'?'stale':
      (await one('SELECT min(id) AS id FROM ops.publication WHERE org_id=$1',[org])).id,c]);
    const before=await one('SELECT count(*) AS n FROM ops.publication'), durable=await counts();
    await assert.rejects(accept(f,[{kind:'upsert',external_id:'X',api_call_id:Number(f.api),obj:obj('X')}]),e=>e.code==='23514');
    assert.deepEqual(await one('SELECT count(*) AS n FROM ops.publication'),before); assert.deepEqual(await counts(),durable);
    assert.equal((await rows('SELECT * FROM raw.sync_acceptance WHERE attempt_id=$1',[f.attempt])).length,0);
  }
});

test('Step2a: k assignment reprojects facts and invalidates both old and new coordinates', async () => {
  const c=await connection(), f=await send(c,[obj('X')]), t=await fact(c), cert=await certification(t.account_id,f.pub);
  const moved=await assign(c); const now=await fact(c);
  assert.equal(now.account_id,moved.account); assert.equal(now.revision,2);
  assert.equal((await one('SELECT cause FROM core.transaction_revision WHERE transaction_id=$1 AND revision=2',[t.transaction_id])).cause,'reassigned');
  const inv=await one('SELECT * FROM verify.invalidation WHERE certification_id=$1',[cert]);
  assert.equal(inv.old_account_id,t.account_id); assert.equal(inv.new_account_id,moved.account);
  assert.equal(inv.old_posted_date.toISOString().slice(0,10),'2026-01-10'); assert.equal(inv.new_posted_date.toISOString().slice(0,10),'2026-01-10');
});

test('Step2a: l source authority, one-to-one relink merge, and reversal restore aliases', async () => {
  const c=await connection(), c2=await connection(); await send(c,[obj('OLD')]); await send(c2,[obj('NEW')]);
  const old=await fact(c), fresh=await fact(c2);
  await ruling('source_authority',fresh.transaction_id,{subject_connection_id:c2,subject_external_id:'NEW',interval:'[-infinity,infinity)'});
  const pub=await ruling('relink_merge',fresh.transaction_id,{subject_connection_id:c2,subject_external_id:'NEW',object_connection_id:c,object_external_id:'OLD'});
  assert.equal((await alias(c2,'NEW')).transaction_id,old.transaction_id); assert.equal((await alias(c,'OLD')).authoritative,false);
  const merged=await fact(c2); await send(c,[obj('OLD',{amount:999})]); assert.deepEqual(await fact(c2),merged);
  await assert.rejects(ruling('relink_merge',fresh.transaction_id,{subject_connection_id:c2,subject_external_id:'NEW',object_connection_id:c,object_external_id:'OLD'}),/one-to-one/);
  const decision=await one("SELECT id FROM core.identity_decision WHERE publication_id=$1 AND kind='relink_merge'",[pub]);
  await ruling('reversal',decision.id,{});
  assert.equal((await alias(c,'OLD')).authoritative,true); assert.equal((await alias(c2,'NEW')).transaction_id,fresh.transaction_id);
  await send(c,[obj('OLD',{amount:30})]); assert.equal((await fact(c)).amount,'-30.00');
});

test('Step2a: m two rebuilds equal live projections and preserve durable input counts', async () => {
  const c=await connection(), c2=await connection();
  await send(c,[obj('P',{pending:true})]); await send(c,[obj('Q',{pending_transaction_id:'P'})]); await assign(c);
  await send(c2,[obj('R')]);
  const fresh=await fact(c2); await ruling('relink_merge',fresh.transaction_id,{subject_connection_id:c2,subject_external_id:'R',object_connection_id:c,object_external_id:'Q'});
  const snap=await snapshot(), before=await counts(), alerts=await one('SELECT count(*) AS n FROM ops.alert');
  for(let i=0;i<2;i++) {
    await rebuild.query('SELECT core.rebuild_projections()');
    assert.deepEqual(await snapshot(),snap); assert.deepEqual(await counts(),before);
    assert.deepEqual(await one('SELECT count(*) AS n FROM ops.alert'),alerts);
  }
  const marker=await one("SELECT payload FROM ops.publication WHERE kind='rebuild_marker' ORDER BY id DESC LIMIT 1");
  for(const table of projectionTables) assert.equal(marker.payload[table],snap[table].length);
});

test('Step2a: n reducer drops a claimed pending removal in either page order', async () => {
  const c=await connection(), q=obj('Q',{pending_transaction_id:'P'});
  // Same raw observations in opposite reducer input order keep source API ids.
  const p=await fixturePage(c,{removed:[{transaction_id:'P'}]}); const posted=await fixturePage(c,{added:[q]});
  const a=(await one('SELECT core.reduce_pages($1) AS transitions',[[p.page,posted.page]])).transitions;
  const b=(await one('SELECT core.reduce_pages($1) AS transitions',[[posted.page,p.page]])).transitions;
  assert.deepEqual(a,b); assert.deepEqual(a,[{kind:'pending_claim',external_id:'Q',object_external_id:'P',api_call_id:Number(posted.api),obj:q}]);
});

test('Step2a: precision rejection and unknown removal quarantine without allocating facts', async () => {
  const c=await connection(); await send(c,[obj('BAD',{amount:1.234})],['MISSING']);
  assert.equal(await fact(c),undefined);
  assert.deepEqual((await rows('SELECT kind FROM core.quarantine WHERE connection_id=$1 ORDER BY kind',[c])).map(x=>x.kind),['invalid_precision','unknown_removed']);
  await send(c,[obj('GOOD')]); const t=await fact(c); await send(c,[obj('GOOD',{amount:1.234})]); assert.deepEqual(await fact(c),t);
});

test('Step2a: balance observations resolve accounts, preserve nulls, and replay exactly', async () => {
  const c=await connection();
  const account={account_id:'bank-account',balances:{current:55.12,available:null,limit:100,iso_currency_code:'USD',last_updated_datetime:'2026-01-09T12:00:00Z'}};
  const f=await fixturePage(c,{added:[obj('X')],accounts:[account]});
  const balances=[{external_account_id:'bank-account',current:55.12,available:null,limit:100,iso_currency_code:'USD',api_call_id:Number(f.api),provider_as_of:account.balances.last_updated_datetime}];
  const pub=await accept(f,[{kind:'upsert',external_id:'X',api_call_id:Number(f.api),obj:obj('X')}],balances);
  const b=await one('SELECT * FROM core.balance_observation WHERE publication_id=$1',[pub]);
  assert.equal(b.current,'55.12'); assert.equal(b.available,null); assert.equal(b.limit_amount,'100.00'); assert.equal(b.source,'sync_page');
  assert.equal(b.account_id,(await fact(c)).account_id); assert.equal(b.api_call_id,f.api);
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step2a: ownership and scope rulings close intervals and invalidate overlapping certifications', async () => {
  const c=await connection(); await send(c,[obj('X')]); const {account,pub}=await assign(c);
  const entity=randomUUID(); await ruling('entity',entity,{slug:'ruling-owner',display_name:'Owner'});
  const dimension=randomUUID(); await ruling('dimension',dimension,{slug:'ruling-dimension',display_name:'Division',entity_id:entity});
  await ruling('account_entity',account,{entity_id:entity,dimension_id:dimension,valid_from:'2026-01-01'});
  const cert=await certification(account,pub);
  await ruling('account_entity',account,{entity_id:entity,valid_from:'2026-01-15'});
  assert.equal((await one('SELECT cause FROM verify.invalidation WHERE certification_id=$1',[cert])).cause,'ruling');
  const cert2=await certification(account,pub);
  await ruling('reporting_scope',account,{scope:'included',valid_from:'2026-01-01'});
  assert.equal((await one('SELECT cause FROM verify.invalidation WHERE certification_id=$1',[cert2])).cause,'ruling');
  await ruling('reporting_scope',account,{scope:'excluded',valid_from:'2026-01-15'});
  assert.deepEqual((await rows('SELECT valid::text AS valid FROM core.account_reporting_scope WHERE account_id=$1 ORDER BY lower(valid)',[account])).map(x=>x.valid),['[2026-01-01,2026-01-15)','[2026-01-15,)']);
  const before=await one('SELECT count(*) AS n FROM ops.publication');
  await assert.rejects(ruling('reporting_scope',account,{scope:'included',valid_from:'2026-01-10'}));
  assert.deepEqual(await one('SELECT count(*) AS n FROM ops.publication'),before);
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step2a: reducer folds last observation and quarantines an already claimed pending id', async () => {
  const c=await connection(); await send(c,[obj('P',{pending:true})]); await send(c,[obj('Q',{pending_transaction_id:'P'})]);
  const duplicate=obj('OTHER',{pending_transaction_id:'P'}); const f=await fixturePage(c,{added:[duplicate]});
  const ts=(await one('SELECT core.reduce_pages($1) AS t',[[f.page]])).t;
  assert.equal(ts[0].kind,'quarantine'); assert.equal(ts[0].quarantine_kind,'duplicate_claim'); const t=await fact(c);
  await accept(f,ts); assert.deepEqual(await fact(c),t);
  const rm=await fixturePage(c,{removed:[{transaction_id:'LAST'}]}), add=await fixturePage(c,{added:[obj('LAST')]});
  assert.equal((await one('SELECT core.reduce_pages($1) AS t',[[rm.page,add.page]])).t[0].kind,'upsert');
  assert.equal((await one('SELECT core.reduce_pages($1) AS t',[[add.page,rm.page]])).t[0].kind,'removed');
});

test('Step2a: failure midway through transitions rolls back allocations, decisions, cursor, and publication', async () => {
  const c=await connection(), q=obj('Q',{pending_transaction_id:'P'}), f=await fixturePage(c,{added:[q,obj('BAD')]});
  const before=await counts(), snap=await snapshot(), pubs=await one('SELECT count(*) AS n FROM ops.publication');
  await assert.rejects(accept(f,[{kind:'pending_claim',external_id:'Q',object_external_id:'P',api_call_id:Number(f.api),obj:q},
    {kind:'upsert',external_id:'BAD',api_call_id:Number(f.api),obj:obj('BAD',{amount:'invalid'})}]));
  assert.deepEqual(await counts(),before); assert.deepEqual(await snapshot(),snap);
  assert.deepEqual(await one('SELECT count(*) AS n FROM ops.publication'),pubs);
  assert.equal((await one('SELECT cursor FROM core.source_connection WHERE connection_id=$1',[c])).cursor,null);
  assert.equal((await one('SELECT status FROM ops.sync_attempt WHERE id=$1',[f.attempt])).status,'fetching');
});

test('Step2a: inventory payload replays initial metadata after later inventories', async () => {
  const c=await connection();
  for (const name of ['First Name','Later Name']) {
    const api=(await one(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
      VALUES($1,$2,'/accounts/get',200,$3) RETURNING id`,[org,c,{accounts:[{account_id:'bank-account',name,type:'credit',mask:'1234',balances:{iso_currency_code:'USD'}}]}])).id;
    const pub=(await sync.query('SELECT core.record_inventory($1,$2) AS id',[c,api])).rows[0].id;
    assert.equal((await one('SELECT payload FROM ops.publication WHERE id=$1',[pub])).payload.api_call_id,Number(api));
  }
  await send(c,[obj('X')]);
  const t=await fact(c), a=await one('SELECT * FROM core.account WHERE account_id=$1',[t.account_id]);
  assert.equal(a.display_name,'First Name'); assert.equal(a.balance_orientation,'liability');
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step2a: missing rebuild inputs fail hard and restore projections and foreign keys', async () => {
  const c=await connection(); await send(c,[obj('Q',{pending_transaction_id:'P'})]);
  const admin=await h.asAdmin(), snap=await snapshot();
  const fkCount=(await admin.query("SELECT count(*) AS n FROM pg_constraint WHERE conrelid='verify.certification'::regclass AND contype='f'")).rows[0].n;
  // Deliberately corrupt evidence inside a rolled-back owner transaction; no
  // durable input is changed by the production rebuild or by fixture cleanup.
  try {
    for (const [table,error] of [['identity_allocation','REBUILD_MISSING_ALLOCATION'],['identity_decision','REBUILD_MISSING_DECISION'],['account_allocation','REBUILD_MISSING_ACCOUNT_ALLOCATION']]) {
      await admin.query('BEGIN');
      await admin.query(`ALTER TABLE core.${table} DISABLE TRIGGER ALL`);
      const filter=table==='identity_allocation'?'first_connection_id':table==='identity_decision'?'subject_connection_id':'source_account_id';
      const id=table==='account_allocation'?(await one('SELECT source_account_id FROM core.source_account WHERE connection_id=$1',[c])).source_account_id:c;
      await admin.query(`DELETE FROM core.${table} WHERE ${filter}=$1`,[id]);
      await admin.query('SAVEPOINT corrupt');
      await assert.rejects(admin.query('SELECT core.rebuild_projections()'),new RegExp(error));
      await admin.query('ROLLBACK TO SAVEPOINT corrupt');
      assert.equal((await admin.query("SELECT count(*) AS n FROM pg_constraint WHERE conrelid='verify.certification'::regclass AND contype='f'")).rows[0].n,fkCount);
      await admin.query('ROLLBACK'); assert.deepEqual(await snapshot(),snap);
    }
  } finally { await admin.query('ROLLBACK'); await admin.end(); }
});

test('Step2a: account and posted-date changes invalidate certifications at both coordinates', async () => {
  const c=await connection(), f=await send(c,[obj('A'),obj('B',{account_id:'second-account'})]);
  const t=await one('SELECT t.* FROM core.transaction t JOIN core.transaction_alias a USING(transaction_id) WHERE a.connection_id=$1 AND a.external_id=$2',[c,'A']);
  const other=await one('SELECT t.* FROM core.transaction t JOIN core.transaction_alias a USING(transaction_id) WHERE a.connection_id=$1 AND a.external_id=$2',[c,'B']);
  const oldCert=await certification(t.account_id,f.pub), newCert=await certification(other.account_id,f.pub,'[2026-02-01,2026-03-01)');
  await send(c,[obj('A',{account_id:'second-account',date:'2026-02-03'})]);
  const invalidations=await rows('SELECT * FROM verify.invalidation WHERE certification_id=ANY($1::uuid[])',[[oldCert,newCert]]);
  assert.equal(invalidations.length,2);
  for(const inv of invalidations) {
    assert.equal(inv.old_account_id,t.account_id); assert.equal(inv.new_account_id,other.account_id);
    assert.equal(inv.old_posted_date.toISOString().slice(0,10),'2026-01-10'); assert.equal(inv.new_posted_date.toISOString().slice(0,10),'2026-02-03');
  }
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step2a: owner-seeded ruled account metadata is captured for exact replay', async () => {
  const c=await connection(), f=await send(c,[obj('X')]), target=randomUUID();
  await owner.query("INSERT INTO core.account_allocation(org_id,account_id,allocated_publication_id,origin) VALUES($1,$2,$3,'ruled')",[org,target,f.pub]);
  await owner.query(`INSERT INTO core.account(org_id,account_id,display_name,institution_name,mask,kind,balance_orientation,
    verification_method,currency,status,required_start_date,observed_start_date,history_state,coverage_gap)
    VALUES($1,$2,'Bank Checking','Fixture Bank','9876','checking','asset','cash_statement','USD','active','2025-01-01','2026-01-01','partial','fixture gap')`,[org,target]);
  const source=(await one('SELECT source_account_id FROM core.source_account WHERE connection_id=$1',[c])).source_account_id;
  await ruling('assignment',source,{account_id:target});
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step2a: source authority demotes the old alias and reversal restores its prior state', async () => {
  const c=await connection(); await send(c,[obj('P',{pending:true})]); await send(c,[obj('Q',{pending_transaction_id:'P'})]);
  const t=await fact(c);
  const pub=await ruling('source_authority',t.transaction_id,{subject_connection_id:c,subject_external_id:'P',interval:'[-infinity,infinity)'});
  assert.equal((await alias(c,'P')).authoritative,true); assert.equal((await alias(c,'Q')).authoritative,false);
  const authorized=await fact(c); assert.equal(authorized.authoritative_external_id,'P'); assert.equal(authorized.amount,t.amount);
  await send(c,[obj('Q',{amount:999})]); assert.deepEqual(await fact(c),authorized);
  const decision=await one("SELECT id FROM core.identity_decision WHERE publication_id=$1 AND kind='source_authority'",[pub]);
  await ruling('reversal',decision.id,{});
  assert.equal((await alias(c,'Q')).authoritative,true); assert.equal((await alias(c,'P')).authoritative,false);
  assert.equal((await fact(c)).authoritative_external_id,'Q'); assert.equal((await fact(c)).revision,4);
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step2a: 024 preserves revisions and invalidations for claims and intermediate moves', async () => {
  const c=await connection();
  const initial=await send(c,[obj('M'),obj('R'),obj('P',{pending:true}),obj('D'),
    obj('B',{account_id:'second-account'}),obj('C',{account_id:'third-account'})]);
  const facts=await rows(`SELECT a.external_id,t.transaction_id,t.account_id FROM core.transaction t
    JOIN core.transaction_alias a USING(transaction_id) WHERE a.connection_id=$1`,[c]);
  const byId=Object.fromEntries(facts.map(t=>[t.external_id,t]));
  const a=byId.M.account_id, b=byId.B.account_id, third=byId.C.account_id;
  const certA=await certification(a,initial.pub);
  const certB=await certification(b,initial.pub,'[2026-02-01,2026-03-01)');
  const certC=await certification(third,initial.pub,'[2026-03-01,2026-04-01)');
  const untouched=await certification(third,initial.pub,'[2026-04-01,2026-05-01)');
  const added=obj('N'), modified=obj('M',{account_id:'second-account',date:'2026-02-03'});
  const posted=obj('Q',{pending_transaction_id:'P',date:'2026-01-11'});
  const move1=obj('D',{account_id:'second-account',date:'2026-02-04'});
  const move2=obj('D',{account_id:'third-account',date:'2026-03-05'});
  const f=await fixturePage(c,{added:[added,posted],modified:[modified,move1,move2],removed:[{transaction_id:'R'}]});
  const upsert=o=>({kind:'upsert',external_id:o.transaction_id,api_call_id:Number(f.api),obj:o});
  const transitions=[upsert(added),upsert(modified),{kind:'removed',external_id:'R',api_call_id:Number(f.api)},
    {kind:'pending_claim',external_id:'Q',object_external_id:'P',api_call_id:Number(f.api),obj:posted},
    upsert(move1),upsert(move2)];
  const pub=await accept(f,transitions,[{external_account_id:'bank-account',current:100,available:null,
    limit:null,iso_currency_code:'USD',api_call_id:Number(f.api)}]);
  const newId=(await alias(c,'N')).transaction_id;
  const revisions=await rows('SELECT * FROM core.transaction_revision WHERE publication_id=$1 ORDER BY position',[pub]);
  const expectedRevisions=[
    [newId,1,1,'added','N',null], [byId.M.transaction_id,2,2,'modified','M',1],
    [byId.R.transaction_id,2,3,'removed','R',1], [byId.P.transaction_id,2,4,'pending_claimed','Q',1],
    [byId.D.transaction_id,2,5,'modified','D',1], [byId.D.transaction_id,3,6,'modified','D',2]
  ].map(([transaction_id,revision,position,cause,source_external_id,predecessor_revision])=>({
    org_id:org,transaction_id,revision,publication_id:pub,position,cause,source_api_call_id:f.api,
    source_connection_id:c,source_external_id,predecessor_revision,projection_version:1
  }));
  assert.deepEqual(revisions,expectedRevisions);
  // A and B see the FIRST D move; C sees its SECOND move, whose old
  // coordinates are B/February rather than the start or end of the batch.
  const expectedChanges=[
    [certA,newId,null,null,a,'2026-01-10'],
    [certA,byId.M.transaction_id,a,'2026-01-10',b,'2026-02-03'],
    [certB,byId.M.transaction_id,a,'2026-01-10',b,'2026-02-03'],
    [certA,byId.R.transaction_id,a,'2026-01-10',a,'2026-01-10'],
    [certA,byId.P.transaction_id,a,'2026-01-10',a,'2026-01-11'],
    [certA,byId.D.transaction_id,a,'2026-01-10',b,'2026-02-04'],
    [certB,byId.D.transaction_id,a,'2026-01-10',b,'2026-02-04'],
    [certC,byId.D.transaction_id,b,'2026-02-04',third,'2026-03-05']
  ];
  const expected=expectedChanges.map(([certification_id,transactionId,old_account_id,old_posted_date,new_account_id,new_posted_date])=>{
    const hex=createHash('md5').update(`ledgerline:v1:invalidation:${pub}:${certification_id}:${transactionId}`).digest('hex');
    const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    return {id,certification_id,old_account_id,old_posted_date,new_account_id,new_posted_date,
      cause:'fact_revision',publication_id:pub,org_id:org,superseding_certification_id:null,publication_time:true};
  });
  const invalidations=await rows(`SELECT i.id,i.certification_id,i.old_account_id,i.old_posted_date::text,
    i.new_account_id,i.new_posted_date::text,i.cause,i.publication_id,i.org_id,i.superseding_certification_id,
    i.detected_at=p.created_at AS publication_time
    FROM verify.invalidation i JOIN ops.publication p ON p.id=i.publication_id
    WHERE i.publication_id=$1`,[pub]);
  const sorted=values=>values.sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
  assert.deepEqual(sorted(invalidations),sorted(expected));
  assert.equal((await rows('SELECT * FROM verify.invalidation WHERE certification_id=$1',[untouched])).length,0);
  assert.equal((await alias(c,'P')).state,'superseded');
  assert.equal((await alias(c,'Q')).transaction_id,byId.P.transaction_id);
  assert.equal((await one('SELECT status FROM core.transaction WHERE transaction_id=$1',[byId.R.transaction_id])).status,'removed');
  assert.deepEqual(await rows(`SELECT account_id,current,available FROM core.balance_observation WHERE publication_id=$1`,[pub]),
    [{account_id:a,current:'100.00',available:null}]);
});

test('Step2a: 024 accepts 6000 additions over 12 pages with 3000 existing facts in under 20 seconds',
  {skip:process.env.LL_SCALE_TEST!=='1'}, async t => {
    const c=await connection();
    const scaleObj=id=>({transaction_id:id,account_id:'bank-account',amount:1,iso_currency_code:'USD',
      date:'2025-01-10',pending:false,name:'Scale fixture'});
    await send(c,Array.from({length:3000},(_,i)=>scaleObj(`existing-${i}`)));
    assert.equal((await one('SELECT count(*) AS n FROM core.transaction WHERE authoritative_connection_id=$1',[c])).n,'3000');
    const attempt=(await sync.query('SELECT ops.open_attempt($1) AS id',[c])).rows[0].id;
    let cursor=(await one('SELECT cursor_in FROM ops.sync_attempt WHERE id=$1',[attempt])).cursor_in;
    const pages=[], transitions=[];
    await owner.query('BEGIN');
    try {
      for(let pageNo=1;pageNo<=12;pageNo++) {
        const objects=Array.from({length:500},(_,i)=>scaleObj(`batch-${(pageNo-1)*500+i}`));
        const next=randomUUID(), more=pageNo<12;
        const api=(await one(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
          VALUES($1,$2,'/transactions/sync',200,$3) RETURNING id`,[org,c,
          {added:objects,modified:[],removed:[],next_cursor:next,has_more:more}])).id;
        pages.push((await one(`INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[org,attempt,pageNo,api,cursor,next,more])).id);
        transitions.push(...objects.map(o=>({kind:'upsert',external_id:o.transaction_id,api_call_id:Number(api),obj:o})));
        cursor=next;
      }
      await owner.query('COMMIT');
    } catch(e) { await owner.query('ROLLBACK'); throw e; }
    const began=performance.now();
    const pub=(await sync.query('SELECT core.accept_publication($1,$2,$3,$4,$5,1) AS id',
      [attempt,pages,cursor,JSON.stringify(transitions),'[]'])).rows[0].id;
    const elapsed=performance.now()-began;
    t.diagnostic(`6000-transition acceptance with 3000 existing facts: ${elapsed.toFixed(1)} ms`);
    assert.equal((await one('SELECT count(*) AS n FROM core.transaction WHERE authoritative_connection_id=$1',[c])).n,'9000');
    assert.equal((await one('SELECT count(*) AS n FROM core.transaction_revision WHERE publication_id=$1',[pub])).n,'6000');
    assert.equal((await one('SELECT cardinality(page_ids) AS n FROM raw.sync_acceptance WHERE publication_id=$1',[pub])).n,12);
    assert.ok(elapsed<20_000,`acceptance took ${elapsed.toFixed(1)} ms; expected < 20000 ms`);
  });
