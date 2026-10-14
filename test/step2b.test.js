import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { createHarness } from './harness.js';
import { createPlaidStub } from './plaid-stub.js';
import { createPlaid } from '../services/lib/plaid.js';
import { reducePages } from '../services/sync/reducer.js';
import { syncConnection,inventoryConnection,healthConnection,evaluateAlerts } from '../services/sync/run.js';
import { runSync } from '../services/sync/index.js';

let h,owner,pool,org,stub,plaid;
const kek='step2b-test-kek';
const previousEnv={...process.env};
const rows=async (sql,args=[]) => (await owner.query(sql,args)).rows;
const one=async (sql,args=[]) => (await rows(sql,args))[0];
const canonical=value=>JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sortKeys(value[k])]));
  return value;
}
const tx=(id,extra={})=>({transaction_id:id,account_id:'bank',amount:12.34,iso_currency_code:'USD',date:'2026-01-10',pending:false,name:'Shop',...extra});
const page=(cursor,extra={})=>({added:[],modified:[],removed:[],next_cursor:cursor,has_more:false,...extra});
const accounts=[{account_id:'bank',name:'Checking',type:'depository',subtype:'checking',capability:'transactions',balances:{current:100,available:80,iso_currency_code:'USD'}}];
before(async()=>{
  h=await createHarness(); owner=await h.asOwner();
  const url=new URL(h.databaseUrl);url.username='ll_sync';url.password='ll_sync';
  pool=new pg.Pool({connectionString:url.href,max:8});pool.on('error',()=>{});
  org=randomUUID();await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'step2b','Step 2b')",[org]);
  stub=await createPlaidStub();
  Object.assign(process.env,{TOKEN_KEK:kek,PLAID_CLIENT_ID:'stub-id',PLAID_SECRET:'stub-secret',PLAID_BASE_URL:stub.url});
  plaid=createPlaid();
});
after(async()=>{
  if (pool) await pool.end();if (stub) await stub.close();if(h) await h.drop();
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env,previousEnv);
});
async function connection(script={pages:[page('done')]}, {inventory=true}={}) {
  const token=randomUUID();stub.set(token,{accounts,...script});
  const c=(await one('SELECT core.register_connection($1,$2,pgp_sym_encrypt($3,$4)) AS id',[org,randomUUID(),token,kek])).id;
  const result={connection_id:c,org_id:org,token};
  if(inventory) await inventoryConnection({pool,plaid,connection:result});
  return result;
}
const sync=(connection,hooks,extra={})=>syncConnection({pool,plaid,connection,hooks,...extra});
const attempts=c=>rows('SELECT * FROM ops.sync_attempt WHERE connection_id=$1 ORDER BY id',[c.connection_id]);
const acceptances=c=>rows('SELECT * FROM raw.sync_acceptance WHERE connection_id=$1 ORDER BY publication_id',[c.connection_id]);
const facts=c=>rows(`SELECT a.external_id,t.amount,t.status,t.revision FROM core.transaction t JOIN core.transaction_alias a USING(transaction_id)
  WHERE a.connection_id=$1 AND a.authoritative ORDER BY a.external_id`,[c.connection_id]);
const head=c=>one('SELECT cursor,state,transactions_update_status FROM core.source_connection WHERE connection_id=$1',[c.connection_id]);
async function lockFree(c) {
  const client=await pool.connect();
  try {assert.equal((await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[c.connection_id])).rows[0].locked,true);
    await client.query('SELECT pg_advisory_unlock(hashtext($1))',[c.connection_id]);}
  finally {client.release();}
}
async function fixture(c,payloads) {
  const a=(await pool.query('SELECT ops.open_attempt($1) AS id',[c.connection_id])).rows[0].id;
  const pages=[];
  for (let i=0;i<payloads.length;i++) {
    await owner.query('BEGIN');
    try {
      const payload=page(`f${i}`,{...payloads[i],has_more:i<payloads.length-1});
      const api=(await one("INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload) VALUES($1,$2,'/transactions/sync',200,$3) RETURNING id",[org,c.connection_id,payload])).id;
      const p=(await one('INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [org,a,i+1,api,i ? `f${i-1}` : null,`f${i}`,payload.has_more])).id;
      await owner.query('COMMIT');pages.push({id:p,api_call_id:api,payload});
    } catch(error) {await owner.query('ROLLBACK');throw error;}
  }
  return pages;
}

test('Step2b: happy path accepts three pages, balances, facts and update status',async()=>{
  const c=await connection({pages:[page('p1',{has_more:true,added:[tx('A'),tx('B')],accounts}),
    page('p2',{has_more:true,modified:[tx('A',{amount:22})]}),page('p3',{removed:[{transaction_id:'B'}]})]});
  // B already exists so its final removal is an actual fact removal.
  const seed=await fixture(c,[{added:[tx('B')]}]);
  const ts=reducePages(seed);await pool.query('SELECT core.accept_publication($1,$2,$3,$4,$5,1)',
    [(await attempts(c))[0].id,seed.map(p=>p.id),'f0',JSON.stringify(ts),'[]']);
  stub.set(c.token,{accounts,pages:[page('p1',{cursor_in:'f0',has_more:true,added:[tx('A'),tx('B')],accounts}),
    page('p2',{has_more:true,modified:[tx('A',{amount:22})]}),page('p3',{removed:[{transaction_id:'B'}]})]});
  const result=await sync(c);assert.equal(result.status,'accepted');
  const accepted=(await acceptances(c)).filter(a=>a.attempt_id===result.attempt_id);assert.equal(accepted.length,1);
  const raw=await rows('SELECT page_no FROM raw.sync_page WHERE attempt_id=$1 ORDER BY page_no',[result.attempt_id]);
  assert.deepEqual(raw.map(p=>p.page_no),[1,2,3]);
  assert.deepEqual(await facts(c),[{external_id:'A',amount:'-22.00',status:'active',revision:1},{external_id:'B',amount:'-12.34',status:'removed',revision:2}]);
  assert.equal((await head(c)).cursor,'p3');assert.equal((await head(c)).transactions_update_status,'HISTORICAL_UPDATE_COMPLETE');
  assert.equal((await one('SELECT current FROM core.balance_observation WHERE publication_id=$1',[result.publication_id])).current,'100.00');
  const requests=stub.calls.filter(r=>r.path==='/transactions/sync' && r.body.access_token===c.token);
  assert.equal(requests[0].body.count,500);assert.deepEqual(requests[0].body.options,{include_original_description:true,personal_finance_category_version:'v2'});
  assert.equal((await one('SELECT payload FROM raw.api_call WHERE id=(SELECT api_call_id FROM raw.sync_page WHERE attempt_id=$1 LIMIT 1)',[result.attempt_id])).payload.access_token,undefined);
});

test('Step2b: reducer parity matches SQL for six page sets and binary ordering',async()=>{
  const fixtures=[
    [{removed:[{transaction_id:'P'}]},{added:[tx('Q',{pending_transaction_id:'P'})]}],
    [{added:[tx('Q',{pending_transaction_id:'P'})]},{removed:[{transaction_id:'P'}]}],
    [{removed:[{transaction_id:'S'}]},{added:[tx('S')]}],
    [{added:[tx('Q',{pending_transaction_id:'P'}),tx('R',{pending_transaction_id:'P'})],removed:[{transaction_id:'P'}]}],
    [{added:[tx('X')]},{modified:[tx('X',{amount:4})]}],
    [{added:[tx('é'),tx('z'),tx('A')],removed:[{transaction_id:'gone'}]}],
  ];
  for(const payloads of fixtures) {
    const c=await connection(),pages=await fixture(c,payloads);
    const sql=(await one('SELECT core.reduce_pages($1) AS t',[pages.map(p=>p.id)])).t;
    assert.equal(canonical(reducePages(pages)),canonical(sql));
  }
});

test('Step2b: reducer parity includes previously promoted pending authorities',async()=>{
  const c=await connection({pages:[page('done',{added:[tx('Q',{pending_transaction_id:'P'})]})]});await sync(c);
  const pages=await fixture(c,[{added:[tx('OTHER',{pending_transaction_id:'P'})]}]);
  const authorities=(await pool.query('SELECT pending_id,connection_id,external_id FROM ops.sync_claim_context WHERE subject_connection_id=$1',[c.connection_id])).rows;
  const sql=(await one('SELECT core.reduce_pages($1) AS t',[pages.map(p=>p.id)])).t;
  const reduced=reducePages(pages,{connectionId:c.connection_id,authorities});
  assert.equal(canonical(reduced),canonical(sql));assert.equal(reduced[0].quarantine_kind,'duplicate_claim');
});

for(const [name,mutate] of [
  ['non-consecutive page',({page})=>{page.page_no=page.page_no+1;}],
  ['cursor link mismatch',({page})=>{if(page.page_no===2)page.cursor_in='wrong';}],
  ['intermediate has_more false',({page})=>{if(page.page_no===1)page.has_more=false;}],
  ['first cursor mismatch',({page})=>{if(page.page_no===1)page.cursor_in='wrong';}],
]) test(`Step2b: chain validation rejects ${name}`,async()=>{
  const c=await connection({pages:[page('one',{has_more:true}),page('two')]});
  const result=await sync(c,{beforePagePersist:mutate});assert.equal(result.status,'invalid');
  assert.equal((await attempts(c))[0].status,'invalid');assert.equal((await head(c)).cursor,null);
  assert.equal((await acceptances(c)).length,0);
  assert.equal((await one("SELECT count(*) AS n FROM ops.alert WHERE dedupe_key=$1",[`poisoned_attempt:${c.connection_id}`])).n,'1');
});

test('Step2b: pagination mutation abandons and restarts from the original cursor',async()=>{
  const c=await connection({pages:[page('one',{has_more:true,added:[tx('A')]}),page('two')],errors:{1:'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'}});
  assert.equal((await sync(c)).status,'accepted');const a=await attempts(c);
  assert.deepEqual(a.map(x=>x.status),['abandoned','accepted']);assert.deepEqual(a.map(x=>x.cursor_in),[null,null]);
  assert.deepEqual(a.map(x=>x.restarts),[0,1]);assert.equal((await acceptances(c)).length,1);
});

test('Step2b: pagination mutation exhausts after three restarts without acceptance',async()=>{
  const c=await connection({pages:[page('one',{has_more:true}),page('two')],
    errors:i=>i%2 ? 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' : null});
  assert.equal((await sync(c)).status,'exhausted');assert.deepEqual((await attempts(c)).map(x=>x.status),['abandoned','abandoned','abandoned','exhausted']);
  assert.equal((await acceptances(c)).length,0);assert.equal((await head(c)).cursor,null);
  assert.ok(await one('SELECT id FROM ops.alert WHERE dedupe_key=$1',[`poisoned_attempt:${c.connection_id}`]));
});

test('Step2b: login required records failed attempt, state event and alert; rate limit retries',async()=>{
  for(const [code,state] of [['ITEM_LOGIN_REQUIRED','login_required'],['RATE_LIMIT_EXCEEDED','retryable_error'],[500,'retryable_error']]) {
    const c=await connection({pages:[],errors:{0:code}});assert.equal((await sync(c)).status,'failed');
    assert.equal((await attempts(c))[0].status,'failed');assert.equal((await head(c)).state,state);
    assert.ok(await one('SELECT id FROM ops.connection_state_event WHERE connection_id=$1 AND to_state=$2',[c.connection_id,state]));
    if(state==='login_required') assert.ok(await one('SELECT id FROM ops.alert WHERE dedupe_key=$1',[`login_required:${c.connection_id}`]));
  }
});

for(const boundary of ['beforePagePersist','afterPagePersist','beforeAccept','afterAcceptBeforeAck'])
  test(`Step2b: crash recovery at ${boundary} preserves facts and releases lock`,async()=>{
    const script={pages:[page('one',{has_more:true,added:[tx('A')]}),page('two',{modified:[tx('A',{amount:33})]})]};
    const reference=await connection(script);await sync(reference);
    const c=await connection(script);
    const hook={ [boundary]:async()=>{throw new Error('injected crash');} };
    if(boundary==='afterAcceptBeforeAck') assert.equal((await sync(c,hook)).recovered,true);
    else await assert.rejects(sync(c,hook),/injected crash/);
    await lockFree(c);await sync(c);await lockFree(c);
    assert.deepEqual(await facts(c),await facts(reference));assert.equal((await head(c)).cursor,(await head(reference)).cursor);
    const abandoned=(await attempts(c)).filter(a=>a.status==='abandoned');
    if(boundary!=='afterAcceptBeforeAck') {
      assert.equal(abandoned.length,1);
      assert.equal((await rows('SELECT * FROM raw.sync_acceptance WHERE attempt_id=$1',[abandoned[0].id])).length,0);
      const raw=await rows('SELECT id FROM raw.sync_page WHERE attempt_id=$1',[abandoned[0].id]);
      assert.equal(raw.length,boundary==='beforePagePersist' ? 0 : boundary==='afterPagePersist' ? 1 : 2);
    }
  });

test('Step2b: unknown commit outcome recovers acceptance by attempt without new revisions',async()=>{
  const c=await connection({pages:[page('done',{added:[tx('A')]})]});
  const reads=[];
  const recoveryPool={connect:()=>pool.connect(),query:(sql,args)=>{
    if(sql.includes('FROM raw.sync_acceptance')) reads.push(args);
    return pool.query(sql,args);
  }};
  const result=await sync(c,{afterAcceptBeforeAck:async({client})=>{await client.end();throw new Error('socket dropped');}},
    {pool:recoveryPool});
  assert.equal(result.recovered,true);assert.equal((await acceptances(c))[0].attempt_id,result.attempt_id);
  assert.deepEqual(reads,[[result.attempt_id]]);
  assert.equal((await attempts(c))[0].status,'accepted');
  assert.equal((await acceptances(c)).length,1);
  const before=await facts(c);await sync(c);assert.deepEqual(await facts(c),before);await lockFree(c);
});

test('Step2b: acceptance query losing its acknowledgement reads the raw receipt on another session',async()=>{
  const c=await connection({pages:[page('done',{added:[tx('A')]})]});
  const reads=[];
  const recoveryPool={connect:()=>pool.connect(),query:(sql,args)=>{
    if(sql.includes('FROM raw.sync_acceptance')) reads.push(args);
    return pool.query(sql,args);
  }};
  const result=await sync(c,{beforeAccept:async({client})=>{
    const query=client.query.bind(client);
    client.query=async(sql,args)=>{
      const response=await query(sql,args);
      if(sql.startsWith('SELECT core.accept_publication(')) {
        // Execute and commit in PostgreSQL, then discard the query result as a
        // socket failure would. The caller never receives the publication ID.
        await client.end();
        throw Object.assign(new Error('acceptance acknowledgement lost'),{code:'ECONNRESET'});
      }
      return response;
    };
  }},{pool:recoveryPool});
  assert.equal(result.status,'accepted');assert.equal(result.recovered,true);
  assert.deepEqual(reads,[[result.attempt_id]]);
  const accepted=await acceptances(c);assert.equal(accepted.length,1);
  assert.equal(result.publication_id,accepted[0].publication_id);
  assert.equal((await attempts(c))[0].status,'accepted');
  assert.equal((await head(c)).cursor,'done');await lockFree(c);
  const before=await facts(c);assert.equal(before[0].revision,1);
  await sync(c);assert.deepEqual(await facts(c),before);
  assert.equal((await rows('SELECT revision FROM core.transaction_revision WHERE source_connection_id=$1',[c.connection_id])).length,1);
  assert.equal((await rows('SELECT id FROM ops.alert WHERE dedupe_key=$1',[`poisoned_attempt:${c.connection_id}`])).length,0);
});

test('Step2b: unavailable receipt lookup preserves uncertainty without poisoning accepted facts',async()=>{
  const c=await connection({pages:[page('done',{added:[tx('A')]})]});
  const reads=[];
  const recoveryPool={connect:()=>pool.connect(),query:(sql,args)=>{
    if(sql.includes('FROM raw.sync_acceptance')) {
      reads.push(args);
      throw Object.assign(new Error('receipt connection unavailable'),{code:'ECONNRESET'});
    }
    return pool.query(sql,args);
  }};
  await assert.rejects(sync(c,{afterAcceptBeforeAck:async({client})=>{
    await client.end();throw new Error('socket dropped');
  }},{pool:recoveryPool}),/receipt connection unavailable/);
  const attempt=(await attempts(c))[0];assert.deepEqual(reads,[[attempt.id]]);
  assert.equal(attempt.status,'accepted');assert.equal((await acceptances(c)).length,1);
  assert.equal((await head(c)).cursor,'done');await lockFree(c);
  const before=await facts(c);await sync(c);assert.deepEqual(await facts(c),before);
  assert.equal((await rows('SELECT id FROM ops.alert WHERE dedupe_key=$1',[`poisoned_attempt:${c.connection_id}`])).length,0);
});

test('Step2b: sync can read only the raw acceptance lookup columns',async()=>{
  const c=await connection();const result=await sync(c);
  assert.deepEqual((await pool.query('SELECT attempt_id,publication_id FROM raw.sync_acceptance WHERE attempt_id=$1',
    [result.attempt_id])).rows,[{attempt_id:result.attempt_id,publication_id:result.publication_id}]);
  for(const sql of ['SELECT * FROM raw.sync_acceptance','SELECT page_ids FROM raw.sync_acceptance']) {
    await assert.rejects(pool.query(sql),error=>error.code==='42501');
  }
});

test('Step2b: concurrent workers produce one acceptance and report lock contention',async()=>{
  const c=await connection({pages:[page('done',{added:[tx('A')]})],delayMs:50});
  const result=await Promise.all([sync(c),sync(c)]);assert.deepEqual(result.map(r=>r.status).sort(),['accepted','skipped']);
  assert.equal(result.find(r=>r.status==='skipped').reason,'lock_contention');assert.equal((await acceptances(c)).length,1);
});

test('Step2b: NULL initial cursor and empty unchanged cursor both publish acceptances',async()=>{
  const c=await connection();assert.equal((await sync(c)).status,'accepted');
  assert.equal((await acceptances(c))[0].cursor_in,null);assert.equal((await head(c)).cursor,'done');
  await sync(c);const a=await acceptances(c);assert.equal(a.length,2);assert.equal(a[1].cursor_in,a[1].cursor_out);
  assert.ok(await one('SELECT id FROM ops.publication WHERE id=$1 AND kind=$2',[a[1].publication_id,'acceptance']));
});

function child(env) {
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,['services/sync/index.js'],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);p.on('error',reject);p.on('close',code=>resolve({code,output}));
  });
}
test('Step2b: process entrypoint fails login errors, pings successful SYNC and gates COVERAGE',async()=>{
  // Isolate this process from earlier fixtures without deleting immutable evidence.
  await owner.query("UPDATE core.source_connection SET state='removed' WHERE org_id=$1",[org]);
  const good=await connection(),bad=await connection({pages:[],errors:{0:'ITEM_LOGIN_REQUIRED'}});
  const env={DATABASE_URL:pool.options.connectionString,LL_ORG_SLUG:'step2b',
    HEALTHCHECKS_PING_SYNC:`${stub.url}/SYNC`,HEALTHCHECKS_PING_COVERAGE:`${stub.url}/COVERAGE`,HEALTHCHECKS_PING_ALERTS:`${stub.url}/ALERTS`};
  stub.pings.length=0;
  const failed=await child(env);assert.equal(failed.code,1,failed.output);assert.ok(!stub.pings.includes('/SYNC'));
  assert.ok(!stub.pings.includes('/COVERAGE'));assert.ok(!stub.pings.includes('/ALERTS'));
  await owner.query("UPDATE core.source_connection SET state='ok' WHERE connection_id=$1",[bad.connection_id]);
  stub.set(bad.token,{accounts,pages:[page('done')]});stub.pings.length=0;
  const success=await child(env);assert.equal(success.code,0,success.output);assert.ok(stub.pings.includes('/SYNC'));
  assert.ok(!stub.pings.includes('/COVERAGE'));
  assert.equal((await head(good)).state,'ok');
});

test('Step2b: stale bank update uses rule severity and deduplicates repeated evaluations',async()=>{
  const c=await connection();await sync(c);
  await owner.query("UPDATE core.source_connection SET last_successful_update=now()-interval '37 hours' WHERE connection_id=$1",[c.connection_id]);
  await evaluateAlerts(pool);await evaluateAlerts(pool);
  const alerts=await rows('SELECT * FROM ops.alert WHERE dedupe_key=$1',[`bank_update_stale:${c.connection_id}`]);assert.equal(alerts.length,1);
  assert.equal(alerts[0].severity,(await one("SELECT severity FROM ops.alert_rule WHERE key='bank_update_stale'")).severity);
});

test('Step2b: inventory, login age, poisoned attempts and placeholder coverage respect thresholds',async()=>{
  const c=await connection({pages:[],errors:{0:'ITEM_LOGIN_REQUIRED'}});await sync(c);
  await owner.query("UPDATE ops.alert_rule SET threshold_interval=interval '0 seconds' WHERE key IN ('inventory_stale','login_required','coverage_gap')");
  await evaluateAlerts(pool);await evaluateAlerts(pool);
  for(const kind of ['inventory_stale','login_required','coverage_gap']) {
    assert.equal((await rows('SELECT id FROM ops.alert WHERE dedupe_key=$1',[`${kind}:${c.connection_id}`])).length,1);
  }
  await owner.query("UPDATE ops.alert_rule SET threshold_interval=CASE key WHEN 'inventory_stale' THEN interval '48 hours' WHEN 'login_required' THEN interval '4 hours' ELSE interval '24 hours' END WHERE key IN ('inventory_stale','login_required','coverage_gap')");
});

test('Step2b: health records last successful update and login-required errors',async()=>{
  const c=await connection({pages:[page('done')],health:{item:{error:{error_code:'ITEM_LOGIN_REQUIRED',error_message:'relink'}},status:{transactions:{last_successful_update:'2026-01-01T00:00:00Z'}}}});
  await sync(c);await healthConnection({pool,plaid,connection:c});assert.equal((await head(c)).state,'login_required');
  assert.equal((await one('SELECT last_successful_update FROM core.source_connection WHERE connection_id=$1',[c.connection_id])).last_successful_update.toISOString(),'2026-01-01T00:00:00.000Z');
});

test('Step2b: connection and process deadlines suppress success heartbeat',async()=>{
  const c=await connection({pages:[page('one',{has_more:true}),page('two')],delayMs:20});
  const r=await sync(c,null,{deadlineMs:5});assert.equal(r.status,'exhausted');assert.equal((await head(c)).cursor,null);await lockFree(c);
  const pings=[];
  const result=await runSync({pool,plaid,env:{SYNC_DEADLINE_MIN:'0.000001'},heartbeat:async n=>pings.push(n),deliver:async()=>{}});
  assert.equal(result.exitCode,1);assert.ok(!pings.includes('SYNC'));
});

test('Step2b: a freshly linked connection is scheduled, inventoried, then synced by the loop (023)',async()=>{
  const c=await connection({pages:[page('c1',{added:[tx('linked-1')]})]},{inventory:false});
  assert.equal((await head(c)).state,'linked');
  const row=await one('SELECT state,inventory_at,last_synced_at FROM ops.sync_schedule WHERE connection_id=$1',[c.connection_id]);
  assert.ok(row,'linked connection must appear in ops.sync_schedule');
  assert.equal(row.state,'linked');assert.equal(row.inventory_at,null);
  const result=await runSync({pool,plaid,heartbeat:async()=>{},deliver:async()=>{}});
  assert.equal(result.exitCode,0);
  const after=await head(c);
  assert.equal(after.state,'ok');assert.equal(after.cursor,'c1');
  assert.deepEqual((await facts(c)).map(f=>f.external_id),['linked-1']);
});
test('Step2b: Plaid transport redacts echoed secrets and wraps fetch errors',async()=>{
  const secret='test-access-plaintext';
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>({status:400,headers:new Headers(),json:async()=>({access_token:secret,error_message:`echo ${secret}`,request_id:'r'})});
    const response=await plaid.post('/transactions/sync',{access_token:secret});assert.ok(!JSON.stringify(response).includes(secret));
    globalThis.fetch=async()=>{throw Object.assign(new Error(secret),{body:{access_token:secret}});};
    await assert.rejects(plaid.post('/transactions/sync',{access_token:secret}),error=>!JSON.stringify(error).includes(secret) && !error.message.includes(secret));
  } finally {globalThis.fetch=original;}
});

test('Step2b: failed acceptance rolls back facts and poisons the attempt with an alert',async()=>{
  const c=await connection({pages:[page('done',{added:[tx('BAD',{amount:'invalid'})]})]});
  assert.equal((await sync(c)).status,'poisoned');assert.equal((await head(c)).state,'poisoned');
  assert.equal((await head(c)).cursor,null);assert.equal((await acceptances(c)).length,0);assert.equal((await facts(c)).length,0);
  assert.ok(await one('SELECT id FROM ops.alert WHERE dedupe_key=$1',[`poisoned_attempt:${c.connection_id}`]));await lockFree(c);
});

test('Step2b: transport failures finish failed and classify as retryable',async()=>{
  const c=await connection();
  const broken=createPlaid({...process.env,PLAID_BASE_URL:'http://127.0.0.1:1'});
  const result=await sync(c,undefined,{plaid:broken});assert.equal(result.status,'failed');assert.equal(result.state,'retryable_error');
  assert.equal((await attempts(c))[0].status,'failed');assert.equal((await head(c)).state,'retryable_error');await lockFree(c);
});

test('Step2b: leftover fetching pages are abandoned under the lock on process restart',async()=>{
  const c=await connection({pages:[page('done',{added:[tx('A')]})]});
  const leftover=await fixture(c,[{added:[tx('ORPHAN')]}]);
  assert.equal((await sync(c)).status,'accepted');assert.deepEqual((await attempts(c)).map(a=>a.status),['abandoned','accepted']);
  assert.ok(await one('SELECT id FROM raw.sync_page WHERE id=$1',[leftover[0].id]));
  assert.equal((await facts(c))[0].external_id,'A');assert.equal((await acceptances(c)).length,1);
});

test('Step2b: health login errors suppress process SYNC heartbeat',async()=>{
  await owner.query("UPDATE core.source_connection SET state='removed' WHERE org_id=$1",[org]);
  const c=await connection({pages:[page('done')],health:{item:{error:{error_code:'ITEM_LOGIN_REQUIRED'}},status:{transactions:{last_successful_update:new Date().toISOString()}}}});
  const pings=[];
  const result=await runSync({pool,plaid,heartbeat:async n=>pings.push(n),deliver:async()=>{}});
  assert.equal(result.exitCode,1);assert.ok(!pings.includes('SYNC'));assert.equal((await head(c)).state,'login_required');
});

test('Step2b: acknowledged undelivered pages still block ALERTS while COVERAGE can ping',async()=>{
  await owner.query("UPDATE core.source_connection SET state='removed' WHERE org_id=$1",[org]);
  await connection();
  await owner.query('UPDATE ops.alert SET acknowledged_at=now() WHERE severity=$1',['page']);
  const pings=[];
  const options={pool,plaid,heartbeat:async n=>pings.push(n),deliver:async()=>{}};
  assert.equal((await runSync(options)).exitCode,0);
  assert.ok(pings.includes('SYNC'));assert.ok(pings.includes('COVERAGE'));assert.ok(!pings.includes('ALERTS'));
  await owner.query('UPDATE ops.alert SET delivered_at=now() WHERE severity=$1',['page']);pings.length=0;
  assert.equal((await runSync(options)).exitCode,0);assert.ok(pings.includes('ALERTS'));
});
