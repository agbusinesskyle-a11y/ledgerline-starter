import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createHarness } from './harness.js';
import { createPlaidStub } from './plaid-stub.js';
import { createPlaid } from '../services/lib/plaid.js';
import { syncConnection, inventoryConnection } from '../services/sync/run.js';

let h, owner, verify, rebuild, pool, stub, plaid, org, ordering;
const started=performance.now(), previousEnv={...process.env}, kek='step3-fixture-kek';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rows=async(sql,args=[]) => (await owner.query(sql,args)).rows;
const one=async(sql,args=[]) => (await rows(sql,args))[0];
const tx=(id,extra={})=>({transaction_id:id,account_id:'bank',amount:12.34,iso_currency_code:'USD',date:'2026-01-10',pending:false,name:'Original shop',...extra});
const page=(cursor,extra={})=>({added:[],modified:[],removed:[],next_cursor:cursor,has_more:false,...extra});
const accounts=[{account_id:'bank',name:'Checking',type:'depository',subtype:'checking',capability:'transactions',balances:{current:100,available:null,iso_currency_code:'USD'}}];
before(async()=>{
  h=await createHarness(); owner=await h.asOwner(); verify=await h.asRole('ll_verify'); rebuild=await h.asRole('ll_rebuild');
  const url=new URL(h.databaseUrl); url.username='ll_sync'; url.password='ll_sync';
  pool=new pg.Pool({connectionString:url.href,max:8});
  org=randomUUID(); await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'step3','Step 3')",[org]);
  stub=await createPlaidStub(); Object.assign(process.env,{TOKEN_KEK:kek,PLAID_CLIENT_ID:'stub',PLAID_SECRET:'stub',PLAID_BASE_URL:stub.url});
  plaid=createPlaid();
});
after(async()=>{
  if(pool) await pool.end(); if(stub) await stub.close(); if(h) await h.drop();
  for(const key of Object.keys(process.env)) if(!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env,previousEnv); assert.ok(performance.now()-started<45_000,'Step3 suite must finish within 45 seconds');
});
async function connection(pages=[page('done')],relinkOf=null,accountList=accounts){
  const token=randomUUID(); stub.set(token,{accounts:accountList,pages});
  const c=(await one('SELECT core.register_connection($1,$2,pgp_sym_encrypt($3,$4),p_relink_of => $5) AS id',[org,randomUUID(),token,kek,relinkOf])).id;
  const registered=await one('SELECT relink_of FROM core.source_connection WHERE connection_id=$1',[c]);
  assert.equal(registered.relink_of,relinkOf,'registration must persist the requested relink relationship');
  const result={connection_id:c,org_id:org,token};
  await inventoryConnection({pool,plaid,connection:result}); return result;
}
async function sync(c,hooks={}){
  const result=await syncConnection({pool,plaid,connection:c,hooks}); assert.equal(result.status,'accepted'); return result;
}
async function next(c,objects,hooks={}){
  const cursor=(await one('SELECT cursor FROM core.source_connection WHERE connection_id=$1',[c.connection_id])).cursor;
  stub.set(c.token,{accounts,pages:[page(randomUUID(),{cursor_in:cursor,added:objects})]}); return sync(c,hooks);
}
async function ruling(kind,subject,after={}){
  return (await verify.query("SELECT core.apply_ruling($1,$2,$3,'reviewed fixture','operator') AS id",[kind,subject,{org_id:org,...after}])).rows[0].id;
}
async function assign(c,externalAccount='bank'){
  const source=(await one('SELECT source_account_id FROM core.source_account WHERE connection_id=$1 AND external_account_id=$2',[c.connection_id,externalAccount])).source_account_id;
  const account=randomUUID(), pub=await ruling('assignment',source,{account_id:account}); return {source,account,pub};
}
async function certification(account,pub){
  const statement=(await one(`INSERT INTO verify.statement(org_id,account_id,version,period,source)
    VALUES($1,$2,1,'[2026-01-01,2026-02-01)','bank_csv') RETURNING id`,[org,account])).id;
  const run=(await one(`INSERT INTO verify.recon_run(org_id,account_id,statement_id,publication_id,result)
    VALUES($1,$2,$3,$4,'pass') RETURNING id`,[org,account,statement,pub])).id;
  const cert=(await one(`INSERT INTO verify.certification(org_id,account_id,period,recon_run_id,publication_id)
    VALUES($1,$2,'[2026-01-01,2026-02-01)',$3,$4) RETURNING id`,[org,account,run,pub])).id;
  return {cert,run};
}
async function snapshot(){
  const result={};
  for(const table of ['transaction','transaction_alias','transaction_revision','balance_observation','quarantine','account','account_assignment','account_entity','account_reporting_scope','entity','dimension']){
    result[table]=(await rows(`SELECT to_jsonb(t) AS row FROM core.${table} t`)).map(({row})=>Object.fromEntries(Object.entries(row).filter(([key])=>!key.endsWith('_at'))));
    result[table].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
const aliases=c=>rows('SELECT * FROM core.transaction_alias WHERE connection_id=$1 ORDER BY external_id',[c.connection_id]);
const quarantine=c=>rows("SELECT q.*,p.received_at FROM core.quarantine q JOIN raw.sync_page p USING(api_call_id) WHERE q.connection_id=$1 AND q.kind='relink_overlap' ORDER BY p.received_at,q.external_id",[c.connection_id]);
const current=(...cs)=>rows('SELECT transaction_id FROM serve.v_transaction_current WHERE authoritative_connection_id=ANY($1::uuid[]) ORDER BY transaction_id',[cs.map(c=>c.connection_id)]);
async function relink(){
  // Six transactions span ten days. The repeated amount has two candidates within the window.
  const amounts=[10,20,20,30,40,50], dates=['01','03','05','07','09','10'], shifted=['02','04','04','08','08','11'];
  const c1=await connection([page('old',{added:amounts.map((amount,i)=>tx(`old${i}`,{amount,date:`2026-01-${dates[i]}`}))})]);
  await assign(c1); await sync(c1);
  const c2=await connection(amounts.map((amount,i)=>page(`new${i}`,{has_more:i<5,added:[tx(`new${i}`,{amount,date:`2026-01-${shifted[i]}`,name:`Changed description ${i}`})]})),c1.connection_id);
  await assign(c2);
  // Separate observation timestamps without editing immutable raw evidence.
  await sync(c2,{afterPagePersist:()=>sleep(5)});
  return {c1,c2,q:await quarantine(c2)};
}
async function grant(c,interval='[-infinity,infinity)',extra={}){
  const pub=await ruling('source_authority',c.connection_id,{subject_connection_id:c.connection_id,interval,...extra});
  const decision=await one("SELECT * FROM core.identity_decision WHERE publication_id=$1 AND kind='source_authority'",[pub]);
  return {pub,decision};
}

test('Step3: a publication ordering under acceptance and ruling contention',async()=>{
  const a=await connection(), b=await connection([page('B',{added:[tx('B')]})]);
  const assignment=await assign(b);
  const attempt=(await pool.query('SELECT ops.open_attempt($1) AS id',[a.connection_id])).rows[0].id;
  const api=(await one("INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload) VALUES($1,$2,'/transactions/sync',200,$3) RETURNING id",[org,a.connection_id,page('A',{added:[tx('A')]})])).id;
  const rawPage=(await one("INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more) VALUES($1,$2,1,$3,NULL,'A',false) RETURNING id",[org,attempt,api])).id;
  const client=await h.asRole('ll_sync'), commits=[]; let pending=[];
  try{
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(7777)');
    const pubA=(await client.query("SELECT core.accept_publication($1,$2,'A',$3,'[]',1) AS id",[attempt,[rawPage],JSON.stringify([{kind:'upsert',external_id:'A',api_call_id:Number(api),obj:tx('A')}])])).rows[0].id;
    const acceptance=sync(b,{afterAcceptBeforeAck:({publication_id})=>{commits.push(publication_id);}}).then(r=>r.publication_id);
    const decision=ruling('assignment',assignment.source,{account_id:assignment.account}).then(id=>{commits.push(id);return id;});
    pending=[acceptance,decision];
    assert.equal(await Promise.race([Promise.race(pending).then(()=>false),sleep(300).then(()=>true)]),true);
    // Both producers have reached the transactional publication lock.
    assert.equal((await one("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND objid=7777 AND NOT granted")).n,'2');
    await client.query('COMMIT');
    const ids=await Promise.all(pending);
    assert.ok(ids.every(id=>BigInt(id)>BigInt(pubA)));
    assert.ok(BigInt(commits[0])<BigInt(commits[1]),'publication ids follow observed commit acknowledgements');
    const publications=await rows('SELECT id,created_at FROM ops.publication WHERE id=ANY($1::bigint[]) ORDER BY id',[[pubA,...ids]]);
    assert.deepEqual(publications.map(p=>p.id),[pubA,...commits]);
    assert.ok(publications.every(p=>p.created_at instanceof Date));
    ordering={a,b};
  }finally{await client.query('ROLLBACK'); await Promise.allSettled(pending); await client.end();}
});

test('Step3: b publication prefixes retain the same revision snapshot',async()=>{
  const publications=await rows('SELECT id FROM ops.publication ORDER BY id');
  // Revision pointers cannot reconstruct every historical business field; exercise the explicit contract fallback.
  const asOf=pub=>rows(`SELECT DISTINCT ON(transaction_id) transaction_id,revision,cause FROM core.transaction_revision
    WHERE org_id=$1 AND publication_id<=$2 ORDER BY transaction_id,revision DESC`,[org,pub]);
  const before=[];
  for(const p of publications) before.push(await asOf(p.id));
  await next(ordering.b,[tx('B',{amount:99,date:'2026-02-02'}),tx('LATER')]);
  for(let i=0;i<publications.length;i++) assert.deepEqual(await asOf(publications[i].id),before[i]);
});

test('Step3: c stale certification is refused while the prior interval stays current',async()=>{
  const c=await connection([page('cert',{added:[tx('CERT')]})]); await assign(c); const accepted=await sync(c);
  const t=await one('SELECT account_id FROM core.transaction WHERE authoritative_connection_id=$1',[c.connection_id]);
  const {cert,run}=await certification(t.account_id,accepted.publication_id);
  await next(c,[]);
  assert.equal((await rows('SELECT * FROM serve.v_verified_intervals WHERE certification_id=$1',[cert])).length,1);
  await assert.rejects(verify.query('SELECT verify.certify($1,$2,$3)',[run,'fixture://export','a'.repeat(64)]),{code:'23514',message:'run is failed, stale, or superseded'});
  assert.equal((await rows('SELECT * FROM verify.invalidation WHERE certification_id=$1',[cert])).length,0);
});

test('Step3: d relink withholds all facts and exposes human candidates',async()=>{
  const {c1,c2,q}=await relink(); assert.equal(q.length,6); assert.ok(q.every(r=>r.resolved_by_decision_id===null));
  assert.equal((await aliases(c2)).length,0); assert.equal((await current(c1,c2)).length,6);
  const candidates=await rows('SELECT * FROM serve.v_relink_candidates WHERE new_connection_id=$1 ORDER BY new_external_id,candidate_external_id',[c2.connection_id]);
  assert.equal(new Set(candidates.map(r=>r.quarantine_id)).size,6);
  assert.deepEqual(candidates.filter(r=>r.new_external_id==='new1').map(r=>[r.candidate_external_id,Number(r.candidate_count),r.day_delta]),[['old1',2,1],['old2',2,-1]]);
  assert.deepEqual(candidates.filter(r=>r.new_external_id==='new0').map(r=>[r.candidate_external_id,Number(r.candidate_count),r.day_delta]),[['old0',1,1]]);
  // Unmatched imports still get a row in the candidate index and remain withheld.
  await next(c2,[tx('NO-MATCH',{amount:999})]);
  const unmatched=await one("SELECT * FROM serve.v_relink_candidates WHERE new_connection_id=$1 AND new_external_id='NO-MATCH'",[c2.connection_id]);
  assert.equal(Number(unmatched.candidate_count),0); assert.equal(unmatched.candidate_transaction_id,null);
});

test('Step3: e interval ruling releases facts without merging and reviewed merge demotes the old alias',async()=>{
  const {c1,c2}=await relink(), {decision,pub}=await grant(c2);
  assert.equal(decision.subject_external_id,null); assert.equal(decision.decided_by,'operator'); assert.equal(decision.publication_id,pub);
  assert.ok((await quarantine(c2)).every(q=>q.resolved_by_decision_id===decision.id));
  const old=await aliases(c1), fresh=await aliases(c2); assert.equal(fresh.length,6); assert.ok(fresh.every(a=>a.authoritative));
  assert.ok(fresh.every(a=>!old.some(b=>a.transaction_id===b.transaction_id))); assert.equal((await current(c1,c2)).length,12);
  await ruling('relink_merge',fresh[0].transaction_id,{subject_connection_id:c2.connection_id,subject_external_id:'new0',object_connection_id:c1.connection_id,object_external_id:'old0'});
  assert.equal((await current(c1,c2)).length,11); assert.equal((await aliases(c1))[0].authoritative,false);
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step3: f partial observation interval releases exactly three pages',async()=>{
  const {c1,c2,q}=await relink(); assert.ok(q[2].received_at<q[3].received_at);
  const {decision}=await grant(c2,`[-infinity,${q[3].received_at.toISOString()})`);
  const after=await quarantine(c2); assert.equal(after.filter(r=>r.resolved_by_decision_id===decision.id).length,3);
  assert.equal(after.filter(r=>r.resolved_by_decision_id===null).length,3); assert.equal((await aliases(c2)).length,3);
  assert.equal((await current(c1,c2)).length,9);
});

test('Step3: g reversed connection grant re-quarantines facts and rebuild matches live',async()=>{
  const {c1,c2}=await relink(), {decision}=await grant(c2);
  const pub=await ruling('reversal',decision.id);
  assert.equal((await current(c1,c2)).length,6); assert.ok((await aliases(c2)).every(a=>!a.authoritative));
  const q=(await quarantine(c2)).filter(r=>r.resolved_by_decision_id===null); assert.equal(q.length,6);
  assert.ok(q.every(r=>r.raised_publication_id===pub));
  const facts=await rows('SELECT status FROM core.transaction WHERE authoritative_connection_id=$1',[c2.connection_id]);
  assert.equal(facts.length,6); assert.ok(facts.every(t=>t.status==='removed'));
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
  // The connection can receive a second reviewed interval after reversal, using the same durable identities.
  await grant(c2); assert.equal((await current(c1,c2)).length,12);
  const again=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),again);
});

test('Step3: h later pages obey the granted observation interval',async()=>{
  const {c1,c2}=await relink(); const end=new Date(Date.now()+500);
  await grant(c2,`[-infinity,${end.toISOString()})`);
  await next(c2,[tx('IN1'),tx('IN2')]); assert.equal((await aliases(c2)).length,8); assert.equal((await current(c1,c2)).length,14);
  assert.equal((await quarantine(c2)).filter(q=>q.resolved_by_decision_id===null).length,0);
  await sleep(Math.max(0,end-Date.now()+5)); await next(c2,[tx('OUT')]);
  const unresolved=(await quarantine(c2)).filter(q=>q.resolved_by_decision_id===null);
  assert.deepEqual(unresolved.map(q=>q.external_id),['OUT']); assert.equal((await current(c1,c2)).length,14);
});

test('Step3: i runtime roles enforce ruling and candidate-view privileges',async()=>{
  const syncRole=await h.asRole('ll_sync'), reader=await h.asRole('ll_reader'), app=await h.asRole('ll_app');
  await assert.rejects(syncRole.query("SELECT core.apply_ruling('source_authority',$1,$2,'fixture','operator')",[randomUUID(),{org_id:org}]),{code:'42501'});
  assert.ok((await reader.query('SELECT * FROM serve.v_relink_candidates LIMIT 1')).rowCount===1);
  await verify.query('SELECT * FROM serve.v_relink_candidates LIMIT 1');
  await assert.rejects(app.query('SELECT * FROM serve.v_relink_candidates'),{code:'42501'});
});


test('Step3: account-scoped grants validate tenancy and keep other accounts withheld',async()=>{
  const second={...accounts[0],account_id:'second'};
  const c1=await connection([page('two-old',{added:[tx('oldA'),tx('oldB',{account_id:'second'})]})],null,[...accounts,second]);
  const firstAssignment=await assign(c1); await assign(c1,'second'); await sync(c1);
  const c2=await connection([page('two-new',{added:[tx('newA'),tx('newB',{account_id:'second'})]})],c1.connection_id,[...accounts,second]);
  const a=await assign(c2); await assign(c2,'second'); await sync(c2);
  const head=await one('SELECT max(id) AS id FROM ops.publication');
  await assert.rejects(grant(c2,'empty'),{code:'22023'});
  await assert.rejects(grant(c2,'[-infinity,infinity)',{source_account_id:firstAssignment.source}),{code:'22023'});
  await assert.rejects(ruling('source_authority',c2.connection_id,{subject_connection_id:c2.connection_id}),{code:'22023'});
  assert.deepEqual(await one('SELECT max(id) AS id FROM ops.publication'),head);
  const {decision}=await grant(c2,'[-infinity,infinity)',{source_account_id:a.source});
  assert.deepEqual((await aliases(c2)).map(a=>a.external_id),['newA']);
  assert.deepEqual((await quarantine(c2)).filter(q=>q.resolved_by_decision_id===decision.id).map(q=>q.external_id),['newA']);
  await next(c2,[tx('laterA'),tx('laterB',{account_id:'second'})]);
  assert.deepEqual((await aliases(c2)).map(a=>a.external_id),['laterA','newA']);
  assert.deepEqual((await quarantine(c2)).filter(q=>q.resolved_by_decision_id===null).map(q=>q.external_id).sort(),['laterB','newB']);
  // Exercise the specified connection API without an org_id field.
  await verify.query("SELECT core.apply_ruling('source_authority',$1,$2,'reviewed fixture','operator')",[c2.connection_id,{subject_connection_id:c2.connection_id,interval:'[-infinity,infinity)'}]);
  assert.equal((await aliases(c2)).length,4);
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});

test('Step3: reversal also withholds later directly accepted facts',async()=>{
  const {c1,c2}=await relink(), {decision}=await grant(c2);
  await next(c2,[tx('DIRECT',{amount:10}),tx('DIRECT',{amount:99})]); assert.equal((await current(c1,c2)).length,13);
  const pub=await ruling('reversal',decision.id);
  assert.equal((await current(c1,c2)).length,6);
  const unresolved=(await quarantine(c2)).filter(q=>q.resolved_by_decision_id===null);
  assert.equal(unresolved.length,7); assert.ok(unresolved.every(q=>q.raised_publication_id===pub));
  assert.equal(unresolved.find(q=>q.external_id==='DIRECT').payload.amount,99,'reversal keeps the final object in a page');
  await next(c2,[tx('AFTER'),tx('DIRECT',{amount:99})]);
  assert.equal((await current(c1,c2)).length,6);
  assert.equal((await rows("SELECT * FROM core.quarantine WHERE connection_id=$1 AND kind='unknown_modified'",[c2.connection_id])).length,0);
  const snap=await snapshot(); await rebuild.query('SELECT core.rebuild_projections()'); assert.deepEqual(await snapshot(),snap);
});
