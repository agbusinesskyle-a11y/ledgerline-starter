import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHarness, runtimeRoles } from './harness.js';

const june = await readFile(new URL('./fixtures/qbo-rec/june.txt', import.meta.url), 'utf8');
const july = await readFile(new URL('./fixtures/qbo-rec/july.txt', import.meta.url), 'utf8');
const parser = () => import('../services/verify/qbo-rec.js');
const started = performance.now();
let h, owner, verify, sync, org;
const period = '[2026-06-01,2026-07-01)';
const one = async (sql, args=[]) => (await owner.query(sql,args)).rows[0];
before(async()=>{
  h=await createHarness(); owner=await h.asOwner(); verify=await h.asRole('ll_verify'); sync=await h.asRole('ll_sync');
  org=randomUUID(); await owner.query("INSERT INTO core.org(org_id,slug,name) VALUES($1,'step5','Synthetic Step 5')",[org]);
});
after(async()=>{if(h)await h.drop(); assert.ok(performance.now()-started<45000);});
const line=(date,amount,reference='',payee='')=>({qbo_txn_date:date,type:'Expense',reference,payee,amount});
const expected=(month)=>({company:'Example Co, LLC',accountName:'BANK-1234',periodEnd:`2026-${month}-${month==='06'?'30':'31'}`,
  reconciledOn:'2026-10-09',reconciledBy:'someone@example.com',opening:month==='06'?'3000.00':'600.00',closing:month==='06'?'600.00':'2250.00',
  cleared:{payments:{count:2,total:month==='06'?'-2400.00':'-400.00',lines:month==='06'?[line('2026-06-01','-1900.00','','Some Bank'),line('2026-06-10','-500.00','','Other Bank')]:[line('2026-07-01','-100.00','17','Synthetic shop'),line('2026-07-10','-300.00')]},
    deposits:{count:month==='06'?0:2,total:month==='06'?'0.00':'2050.00',lines:month==='06'?[]:[{...line('2026-07-02','1850.00'),type:'Deposit'},{...line('2026-07-20','200.00'),type:'Deposit'}]}},
  adjustments:[],sectionsSeen:['DATE','TYPE','REF NO.','PAYEE','AMOUNT (USD)']});

test('Step5: a synthetic monthly reports exclude uncleared lines',async()=>{
  const {parseQboReconciliation,toStatementInput}=await parser();
  assert.deepEqual(parseQboReconciliation(june),expected('06')); assert.deepEqual(parseQboReconciliation(july),expected('07'));
  const s=toStatementInput(expected('06'),{periodStart:'2026-06-01'});
  assert.equal(s.header.debits_total,'2400.00'); assert.equal(s.header.line_count,2);
  assert.equal(s.lines[0].description,'Some Bank'); assert.equal(s.lines[0].cleared_period,period);
});
test('Step5: a card headings and parser refusals',async()=>{
  const {parseQboReconciliation,ParseError}=await parser();
  assert.deepEqual(parseQboReconciliation(june.replaceAll('Checks and payments','Charges and cash advances').replaceAll('Deposits and other credits','Payments and credits')),expected('06'));
  for(const text of [june.replaceAll('Checks and payments','Mystery items'),june.replace('cleared (2)','cleared (3)'),june.replace('-2,400.00','-2,401.00')]) assert.throws(()=>parseQboReconciliation(text),ParseError);
});
async function send(c, objects, removed=[]) {
  const attempt=(await sync.query('SELECT ops.open_attempt($1) AS id',[c])).rows[0].id;
  const prior=await one('SELECT * FROM ops.sync_attempt WHERE id=$1',[attempt]), cursor=randomUUID();
  const api=(await one(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,http_status,payload)
    VALUES($1,$2,'/transactions/sync',200,$3) RETURNING id`,[org,c,{added:objects,modified:[],removed:removed.map(transaction_id=>({transaction_id})),next_cursor:cursor,has_more:false}])).id;
  const page=(await one(`INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more)
    VALUES($1,$2,1,$3,$4,$5,false) RETURNING id`,[org,attempt,api,prior.cursor_in,cursor])).id;
  return (await sync.query('SELECT core.accept_publication($1,$2,$3,$4,$5,1) AS id',[attempt,[page],cursor,
    JSON.stringify([...objects.map(o=>({kind:'upsert',external_id:o.transaction_id,api_call_id:Number(api),obj:o})),
      ...removed.map(external_id=>({kind:'removed',external_id,api_call_id:Number(api)}))]), '[]'])).rows[0].id;
}
function objects(lines) {return lines.map((l,i)=>({transaction_id:`f${i}`,account_id:'bank',amount:-Number(l.amount),
  iso_currency_code:'USD',date:l.qbo_txn_date,pending:false,name:l.payee||'Synthetic bank fact',check_number:l.reference||null}));}
async function ruling(subject,account,metadata={}) {
  return (await verify.query("SELECT core.apply_ruling('assignment',$1,$2,'synthetic assignment','operator') AS id",
    [subject,{org_id:org,account_id:account,account:{institution_name:'Synthetic Bank',mask:'1234',...metadata}}])).rows[0].id;
}
async function account(facts,metadata={}) {
  const c=(await one("SELECT core.register_connection($1,$2,decode('abcd','hex')) AS id",[org,randomUUID()])).id;
  await send(c,objects(facts));
  const source=(await one('SELECT source_account_id FROM core.source_account WHERE connection_id=$1',[c])).source_account_id;
  const id=randomUUID(); await ruling(source,id,metadata); return {id,c,source};
}
async function reconcile(a, lines, {opening='3000.00',closing,interval=period,adjustments=[]}={}) {
  closing ??= (Number(opening)+lines.reduce((n,l)=>n+Number(l.amount),0)).toFixed(2);
  const header={opening_balance:opening,closing_balance:closing,line_count:lines.length,
    debits_total:lines.reduce((n,l)=>n+Math.max(0,-Number(l.amount)),0).toFixed(2),
    credits_total:lines.reduce((n,l)=>n+Math.max(0,Number(l.amount)),0).toFixed(2),columns_seen:['DATE','AMOUNT']};
  const statement=(await verify.query("SELECT verify.import_statement($1,$2,'qbo_reconciliation',$3,$4,$5) AS id",
    [a.id,interval,createHash('sha256').update(randomUUID()).digest('hex'),header,JSON.stringify(lines.map(l=>({...l,description:l.payee||l.type,cleared_period:interval})))])).rows[0].id;
  if(adjustments.length) await verify.query('SELECT verify.record_statement_adjustments($1,$2)',[statement,JSON.stringify(adjustments)]);
  return run(statement);
}
async function run(statement) {
  const id=(await verify.query('SELECT verify.run_reconciliation($1) AS id',[statement])).rows[0].id;
  const r=await one('SELECT * FROM verify.recon_run WHERE id=$1',[id]);
  r.matches=(await owner.query('SELECT * FROM verify.recon_match WHERE recon_run_id=$1',[id])).rows;
  return r;
}
const juneLines=expected('06').cleared.payments.lines;
test('Step5: b exact pass and consecutive opening chain',async()=>{
  const p=expected('07'), lines=[...juneLines,...p.cleared.payments.lines,...p.cleared.deposits.lines];
  const a=await account(lines), r=await reconcile(a,juneLines,{closing:'600.00'});
  assert.equal(r.result,'pass'); assert.ok(r.matches.every(m=>m.method==='exact')); assert.equal(r.matches.length,2);
  assert.equal(r.detail.anchor,true);
  const second=await reconcile(a,lines.slice(2),{opening:'600.00',closing:'2250.00',interval:'[2026-07-01,2026-08-01)'});
  assert.equal(second.result,'pass'); assert.equal(second.detail.anchor,false);
});
test('Step5: c unique two day window',async()=>{
  const l=[line('2026-06-10','-50.00')],a=await account([line('2026-06-12','-50.00')]);
  const r=await reconcile(a,l); assert.equal(r.result,'pass'); assert.equal(r.matches[0].method,'window'); assert.match(r.matches[0].corroboration,/unique amount/);
});
test('Step5: d equal total substitution fails',async()=>{
  const l=[line('2026-06-01','-10.00'),line('2026-06-15','-20.00')],a=await account([line('2026-06-01','-20.00'),line('2026-06-15','-10.00')]);
  const r=await reconcile(a,l); assert.equal(r.result,'fail'); assert.equal(r.debit_diff,'0.00');
  assert.equal(r.unmatched_lines,2); assert.equal(r.unmatched_transactions,2);
});
test('Step5: e collisions stay unresolved until reference corroboration',async()=>{
  const l=[line('2026-06-10','-50.00'),line('2026-06-11','-50.00')];
  const a=await account(l),r=await reconcile(a,l); assert.notEqual(r.result,'pass'); assert.ok(r.unresolved_pairs>0); assert.equal(r.matches.length,0);
  const refs=[{...l[0],reference:'CHECK-7'},l[1]], b=await account(refs), resolved=await reconcile(b,refs);
  assert.equal(resolved.result,'pass'); assert.ok(resolved.matches.some(m=>m.method==='reference'));
});
test('Step5: f missing and extra lines fail',async()=>{
  const l=[line('2026-06-01','-10.00'),line('2026-06-15','-20.00')],a=await account(l);
  const missing=await reconcile(a,l.slice(0,1)); assert.equal(missing.result,'fail'); assert.equal(missing.unmatched_transactions,1);
  const extra=await reconcile(a,[...l,line('2026-06-20','-30.00')]); assert.equal(extra.result,'fail'); assert.equal(extra.unmatched_lines,1);
});
test('Step5: g adjustment ownership is not resolution',async()=>{
  const l=[line('2026-06-01','-10.00')],a=await account(l);
  const {parseQboReconciliation}=await parser();
  const parsed=parseQboReconciliation(june.replace('Details','Synthetic forced adjustment                     0.00\nDetails'));
  assert.equal(parsed.adjustments.length,1);
  const r=await reconcile(a,l,{adjustments:parsed.adjustments});
  assert.equal(r.result,'fail_with_exceptions');
  const e=await one('SELECT * FROM verify.exception WHERE recon_run_id=$1',[r.id]); assert.equal(e.owner,null);
  await owner.query("UPDATE verify.exception SET owner='operator' WHERE id=$1",[e.id]);
  assert.equal((await run(r.statement_id)).result,'fail_with_exceptions');
  await verify.query('SELECT verify.resolve_exception($1,$2,$3)',[e.id,'operator','Reviewed synthetic adjustment']);
  const resolved=await run(r.statement_id); assert.equal(resolved.result,'pass');
  assert.ok((await one('SELECT count(*) AS n FROM verify.recon_supersession WHERE superseded_run_id=$1',[r.id])).n>0);
});
test('Step5: h certification retained after date revision and reassignment',async()=>{
  const {certifyRun}=await import('../scripts/import-qbo-rec.js');
  const {evidenceStub}=await import('./qbo-storage-stub.js');
  for(const change of ['date','assignment']) {
    const l=[line('2026-06-10','-10.00')],a=await account(l),r=await reconcile(a,l),store=evidenceStub();
    const cert=await certifyRun(verify,r.id,store);
    const before=await one('SELECT * FROM verify.certification WHERE id=$1',[cert]);
    assert.match(before.export_uri,/^r2:\/\/synthetic\/evidence\/[a-f0-9]{64}\.json$/);
    const body=store.objects.get(before.export_uri.replace('r2://synthetic/',''));
    assert.equal(createHash('sha256').update(body).digest('hex'),before.export_sha256);
    assert.equal(JSON.parse(body).facts.length,1);
    if(change==='date') await send(a.c,objects([line('2026-07-10','-10.00')])); else await ruling(a.source,randomUUID());
    const invalid=await one('SELECT * FROM verify.invalidation WHERE certification_id=$1',[cert]);
    assert.ok(invalid); assert.equal(invalid.cause,change==='date'?'fact_revision':'reassigned');
    assert.deepEqual(await one('SELECT * FROM verify.certification WHERE id=$1',[cert]),before);
  }
});
test('Step5: i runtime immutability and stale certification',async()=>{
  const a=await account(juneLines),r=await reconcile(a,juneLines);
  for(const role of runtimeRoles) {
    const client=await h.asRole(role);
    for(const table of ['recon_run','recon_match']) for(const operation of ['UPDATE','DELETE']) {
      const sql=operation==='UPDATE'?`UPDATE verify.${table} SET org_id=org_id`:`DELETE FROM verify.${table}`;
      await assert.rejects(client.query(sql),{code:'42501'});
    }
    await client.end();
  }
  for(const table of ['recon_run','recon_match']) for(const sql of [`UPDATE verify.${table} SET org_id=org_id`,`DELETE FROM verify.${table}`]) await assert.rejects(owner.query(sql),/IMMUTABLE_ROW/);
  await send(a.c,[]);
  await assert.rejects(verify.query('SELECT verify.certify($1,$2,$3)',[r.id,'r2://synthetic/evidence/export.json','a'.repeat(64)]),/stale/);
});
async function cli(args,env) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/import-qbo-rec.js',...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    child.once('error',reject);child.once('close',code=>resolve({code,output}));
  });
}
test('Step5: j CLI dry run and duplicate apply are idempotent',async()=>{
  const {importQboRec}=await import('../scripts/import-qbo-rec.js');
  const {evidenceStub}=await import('./qbo-storage-stub.js');
  const a=await account(juneLines,{institution_name:'CLI Synthetic Bank',mask:'9876'}),store=evidenceStub();
  const dir=await mkdtemp(join(tmpdir(),'ll-qbo-'));
  try {
    const file=join(dir,'synthetic.pdf');await writeFile(file,'SYNTHETIC PDF fixture: extraction uses LL_QBO_TEXT_FILE');
    const args=[file,'--institution','CLI Synthetic Bank','--mask','9876','--role','ll_verify','--dsn-env','LL_TEST_DSN'];
    const env={...process.env,LL_TEST_DSN:h.databaseUrl,ALLOW_SUPERUSER:'1',LL_QBO_TEXT_FILE:join(process.cwd(),'test/fixtures/qbo-rec/june.txt')};
    const before=await one('SELECT count(*) AS n FROM verify.statement');
    const dry=await cli(args,env);assert.equal(dry.code,0,dry.output);assert.match(dry.output,/no writes/);
    assert.deepEqual(await one('SELECT count(*) AS n FROM verify.statement'),before);
    const output=[],write=message=>output.push(message);
    await importQboRec([...args,'--apply','--certify'],{env,store,write});
    assert.equal(store.objects.size,2);assert.ok(output.some(x=>x.includes('pass')));
    const puts=store.puts;
    await importQboRec([...args,'--apply'],{env,store,write});assert.match(output.at(-1),/already imported/);assert.equal(store.puts,puts);
    assert.equal((await one('SELECT count(*) AS n FROM verify.statement WHERE account_id=$1',[a.id])).n,'1');
    const sha=createHash('sha256').update(await readFile(file)).digest('hex');
    await importQboRec(['--evidence-sha',sha,...args.slice(1),'--apply'],{env,store,write});assert.match(output.at(-1),/already imported/);
    store.objects.set(`evidence/${sha}.pdf`,Buffer.from('tampered'));
    await assert.rejects(importQboRec(['--evidence-sha',sha,...args.slice(1)],{env,store,write}),/hash/);
    const unknown=await cli([file,'--institution','Unknown','--mask','0000','--role','ll_verify'],{...env,DATABASE_URL:h.databaseUrl});
    assert.equal(unknown.code,2,unknown.output);
    const badText=join(dir,'bad.txt');await writeFile(badText,june.replaceAll('Checks and payments','Mystery items'));
    const bad=await cli([...args,'--apply'],{...env,LL_QBO_TEXT_FILE:badText});assert.equal(bad.code,2,bad.output);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('Step5: evidence upload never overwrites',async()=>{
  const {uploadEvidence}=await import('../scripts/upload-evidence.js');
  const {evidenceStub}=await import('./qbo-storage-stub.js');const store=evidenceStub();
  const dir=await mkdtemp(join(tmpdir(),'ll-evidence-'));
  try {
    const file=join(dir,'synthetic.pdf');await writeFile(file,'SYNTHETIC');
    const a=await uploadEvidence(file,{store,write:()=>{}}),b=await uploadEvidence(file,{store,write:()=>{}});
    assert.deepEqual(a,b);assert.equal(store.puts,1);assert.equal(a.key,`evidence/${a.sha}.pdf`);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('Step5: k optional real PDF evidence', {skip:!process.env.LL_EVIDENCE_DIR},async(t)=>{
  const {extractText,parseQboReconciliation}=await parser();
  const files=(await readdir(process.env.LL_EVIDENCE_DIR)).filter(f=>f.toLowerCase().endsWith('.pdf'));
  assert.ok(files.length>0,'evidence directory must contain PDFs');
  for(const file of files) {
    // Never emit filenames, PDF text, parsed values, or provider error output.
    const parsed=parseQboReconciliation(await extractText(join(process.env.LL_EVIDENCE_DIR,file),{...process.env,LL_QBO_TEXT_FILE:''}));
    for(const section of Object.values(parsed.cleared)) {
      assert.equal(section.lines.length,section.count);
      assert.equal(section.lines.reduce((sum,l)=>sum+Math.round(Number(l.amount)*100),0),Math.round(Number(section.total)*100));
    }
  }
  t.diagnostic(`Parsed ${files.length} PDFs; cleared counts and totals verified. No evidence copied.`);
});
test('Step5: liability reports normalize bank signs and subtract fact amounts',async()=>{
  const {parseQboReconciliation,toStatementInput}=await parser();
  const card=june.replaceAll('Checks and payments','Charges and cash advances').replaceAll('Deposits and other credits','Payments and credits')
    .replaceAll('-2,400.00','2,400.00').replaceAll('-1,900.00','1,900.00').replaceAll('-500.00','500.00').replace('600.00','5,400.00');
  const parsed=parseQboReconciliation(card),input=toStatementInput(parsed,{periodStart:'2026-06-01',balanceOrientation:'liability'});
  assert.deepEqual(input.lines.map(l=>l.amount),['-1900.00','-500.00']);
  const a=await account(juneLines,{balance_orientation:'liability',kind:'credit_card'});
  const r=await reconcile(a,juneLines,{closing:'5400.00'}); assert.equal(r.result,'pass'); assert.equal(r.closing_ok,true);
});
test('Step5: payee collision corroboration is literal and case insensitive',async()=>{
  const l=[line('2026-06-10','-50.00','','Alice'),line('2026-06-11','-50.00')];
  const a=await account([{...l[0],payee:'ACH ALICE payment'},l[1]]),r=await reconcile(a,l);
  assert.equal(r.result,'pass');assert.ok(r.matches.some(m=>m.corroboration==='payee: Alice'));
  assert.equal(r.matches.find(m=>m.corroboration==='payee: Alice').method,'window');
  const b=await account([{...l[0],payee:'ACH Alice payment'},{...l[1],payee:'ACH Alice payment'}]);
  const blocked=await reconcile(b,l);assert.equal(blocked.result,'fail');assert.equal(blocked.matches.length,0);assert.ok(blocked.unresolved_pairs>0);
});
test('Step5: latest statement version controls the opening chain',async()=>{
  const a=await account([...juneLines,line('2026-07-02','10.00')]);
  await reconcile(a,juneLines,{closing:'600.00'});
  await reconcile(a,juneLines,{closing:'601.00'});
  const next=await reconcile(a,[line('2026-07-02','10.00')],{opening:'600.00',closing:'610.00',interval:'[2026-07-01,2026-08-01)'});
  assert.equal(next.opening_ok,false);assert.equal(next.result,'fail');
});
test('Step5: snapshots exclude pending removed and other period facts',async()=>{
  const l=[line('2026-06-10','-10.00')],a=await account(l);
  await send(a.c,[...objects(l),{...objects([line('2026-06-10','-20.00')])[0],transaction_id:'pending',pending:true},
    {...objects([line('2026-07-10','-30.00')])[0],transaction_id:'outside'},
    {...objects([line('2026-06-10','-40.00')])[0],transaction_id:'removed'}]);
  await send(a.c,[],['removed']);
  const r=await reconcile(a,l);assert.equal(r.result,'pass');assert.equal(r.detail.facts.length,1);
});
test('Step5: missing pdftotext has an actionable error',async()=>{
  const {extractText}=await parser();
  await assert.rejects(extractText('/tmp/synthetic.pdf',{PDFTOTEXT_BIN:'/tmp/ll-no-such-pdftotext'}),/binary missing; install poppler-utils/);
});
test('Step5: adjustment evidence cannot change after a run',async()=>{
  const l=[line('2026-06-01','-10.00')],a=await account(l);
  const r=await reconcile(a,l,{adjustments:[{description:'Synthetic adjustment',amount:'0.00'}]});
  await assert.rejects(verify.query('SELECT verify.record_statement_adjustments($1,$2)',[r.statement_id,'[]']),/must precede/);
  for(const sql of ['UPDATE verify.statement_adjustment SET adjustments=adjustments','DELETE FROM verify.statement_adjustment']) await assert.rejects(owner.query(sql),/IMMUTABLE_ROW/);
  await assert.rejects(verify.query('SELECT verify.resolve_exception($1,$2,$3)',[randomUUID(),'owner','']),/owner and reason/);
});
test('Step5: liability refunds retain their opposite sign',async()=>{
  const {toStatementInput}=await parser();
  const report=expected('06');
  report.cleared.payments.lines=[line('2026-06-01','100.00'),line('2026-06-02','-25.00')];
  report.cleared.deposits.lines=[line('2026-06-03','-40.00')];
  const input=toStatementInput(report,{balanceOrientation:'liability'});
  assert.deepEqual(input.lines.map(l=>l.amount),['-100.00','25.00','40.00']);
  assert.equal(input.header.debits_total,'100.00');assert.equal(input.header.credits_total,'65.00');
});
test('Step5: identical adjustments each require their own resolution',async()=>{
  const l=[line('2026-06-01','-10.00')],a=await account(l),adjustment={description:'Synthetic repeated adjustment',amount:'0.00'};
  const r=await reconcile(a,l,{adjustments:[adjustment,adjustment]});
  const exceptions=(await owner.query('SELECT id FROM verify.exception WHERE recon_run_id=$1 ORDER BY id',[r.id])).rows;
  assert.equal(exceptions.length,2);
  await verify.query('SELECT verify.resolve_exception($1,$2,$3)',[exceptions[0].id,'operator','Reviewed first adjustment']);
  assert.equal((await run(r.statement_id)).result,'fail_with_exceptions');
  await verify.query('SELECT verify.resolve_exception($1,$2,$3)',[exceptions[1].id,'operator','Reviewed second adjustment']);
  assert.equal((await run(r.statement_id)).result,'pass');
});
