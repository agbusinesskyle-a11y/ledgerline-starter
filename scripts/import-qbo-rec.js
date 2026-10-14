#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { storage } from '../services/backup/storage.js';
import { createPool } from '../services/lib/db.js';
import { logFailure } from '../services/lib/log.js';
import { extractText, parseQboReconciliation, toStatementInput, ParseError } from '../services/verify/qbo-rec.js';
import { sha256, retainEvidence } from '../services/verify/evidence.js';

export class ImportRefusal extends Error {}
const refuse=message=>{throw new ImportRefusal(message);};
function options(args) {
  const o={apply:false,certify:false,dsnEnv:'DATABASE_URL'};
  const fields={'--institution':'institution','--mask':'mask','--period-start':'periodStart','--evidence-sha':'sha','--role':'role','--dsn-env':'dsnEnv'};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--apply') o.apply=true;
    else if(arg==='--certify')o.certify=true;
    else if(fields[arg]) {
      const value=args[++i];if(!value || value.startsWith('--'))refuse(`missing value: ${arg}`);
      if(o[fields[arg]] && fields[arg]!=='dsnEnv')refuse(`duplicate option: ${arg}`);
      o[fields[arg]]=value;
    }else if(arg.startsWith('-') || o.file)refuse('unexpected argument'); else o.file=arg;
  }
  if(Boolean(o.file)===Boolean(o.sha) || !o.institution?.trim() || !/^\d{4}$/.test(o.mask||'') ||
    (o.sha && !/^[a-f0-9]{64}$/i.test(o.sha)) || (o.certify && !o.apply) ||
    (o.role && !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(o.role)) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.dsnEnv)) {
    refuse('usage: import-qbo-rec.js <pdf | --evidence-sha SHA> --institution NAME --mask NNNN [--period-start YYYY-MM-DD] [--apply] [--certify] [--role ll_verify] [--dsn-env NAME]');
  }
  if(o.sha)o.sha=o.sha.toLowerCase();return o;
}
async function resolveAccount(client,o) {
  const rows=(await client.query(`SELECT account_id,balance_orientation FROM core.account
    WHERE institution_name=$1 AND mask=$2 AND status<>'placeholder'`,[o.institution,o.mask])).rows;
  if(rows.length!==1)refuse(`account resolution refused: ${rows.length} non-placeholder matches`);
  return rows[0];
}
async function duplicate(client,account,period,sha) {
  return (await client.query('SELECT id FROM verify.statement WHERE account_id=$1 AND period=$2 AND lower(file_sha256)=$3',[account,period,sha])).rows[0];
}
export async function certifyRun(client,runId,store) {
  // The export uses the immutable run snapshot, never today's fact projections.
  const run=(await client.query('SELECT * FROM verify.recon_run WHERE id=$1',[runId])).rows[0];
  if(!run || run.result!=='pass')refuse('certification requires a passing run');
  const statement=(await client.query('SELECT * FROM verify.statement WHERE id=$1',[run.statement_id])).rows[0];
  const matches=(await client.query('SELECT * FROM verify.recon_match WHERE recon_run_id=$1 ORDER BY statement_line_id,transaction_id',[runId])).rows;
  const body=Buffer.from(JSON.stringify({run,matches,statement,facts:run.detail.facts}));
  const sha=sha256(body),key=`evidence/${sha}.json`,uri=`r2://${store.bucket}/${key}`;
  await retainEvidence(store,key,body,'application/json');
  // Network finished before certify acquires the publication lock; its existing
  // freshness and supersession checks reject changes made during the upload.
  return (await client.query('SELECT verify.certify($1,$2,$3) AS id',[runId,uri,sha])).rows[0].id;
}
function printRun(run,write) {
  const {id,result,opening_ok,closing_ok,debit_diff,credit_diff,unmatched_lines,unmatched_transactions,unresolved_pairs}=run;
  write(JSON.stringify({run_id:id,result,opening_ok,closing_ok,debit_diff,credit_diff,unmatched_lines,unmatched_transactions,unresolved_pairs}));
  const unresolved=new Set(run.detail.unresolved_candidates.map(e=>e.l));
  for(const line of run.detail.unmatched_lines)write(`${unresolved.has(line.id)?'unresolved':'unmatched'} line ${line.qbo_txn_date||line.bank_posted_date} ${Number(line.amount).toFixed(2)}`);
  for(const fact of run.detail.unmatched_transactions)write(`unmatched or unresolved fact ${fact.posted_date} ${Number(fact.amount).toFixed(2)}`);
}
export async function importQboRec(args,{env=process.env,store,write=console.log}={}) {
  const o=options(args);let dir,pool,client,inTransaction=false;
  try {
    let body,path=o.file;
    if(o.sha) {
      store ??=storage(env);
      const response=await store.client.send(new GetObjectCommand({Bucket:store.bucket,Key:`evidence/${o.sha}.pdf`}));
      body=Buffer.from(await response.Body.transformToByteArray());
      if(sha256(body)!==o.sha)refuse('evidence hash verification failed');
      dir=await mkdtemp(join(tmpdir(),'ll-qbo-rec-'));path=join(dir,'evidence.pdf');await writeFile(path,body);
    }else body=await readFile(path);
    const sha=sha256(body),parsed=parseQboReconciliation(await extractText(path,env));
    // All parsing and account refusals happen before evidence or database writes.
    pool=createPool({...env,DATABASE_URL:env[o.dsnEnv]});client=await pool.connect();
    if(o.role)await client.query(`SET ROLE "${o.role}"`);
    const account=await resolveAccount(client,o);
    const input=toStatementInput(parsed,{periodStart:o.periodStart,balanceOrientation:account.balance_orientation});
    const period=input.lines[0]?.cleared_period || `[${o.periodStart||`${parsed.periodEnd.slice(0,7)}-01`},${new Date(new Date(`${parsed.periodEnd}T00:00:00Z`).getTime()+86400000).toISOString().slice(0,10)})`;
    if(await duplicate(client,account.account_id,period,sha)){write('already imported');return;}
    if(!o.apply){write(JSON.stringify({mode:'dry run',account_id:account.account_id,period,sha,header:input.header,adjustments:parsed.adjustments}));write('dry run complete; no writes');return;}
    store ??=storage(env);
    await retainEvidence(store,`evidence/${sha}.pdf`,body,'application/pdf');
    input.header.file_uri=`r2://${store.bucket}/evidence/${sha}.pdf`;
    await client.query('BEGIN');inTransaction=true;
    await client.query('SELECT pg_advisory_xact_lock(7777)');
    const current=await resolveAccount(client,o);
    if(current.account_id!==account.account_id || current.balance_orientation!==account.balance_orientation)refuse('account changed during evidence upload; retry');
    if(await duplicate(client,account.account_id,period,sha)){await client.query('ROLLBACK');inTransaction=false;write('already imported');return;}
    const statement=(await client.query("SELECT verify.import_statement($1,$2,'qbo_reconciliation',$3,$4,$5) AS id",
      [account.account_id,period,sha,input.header,JSON.stringify(input.lines)])).rows[0].id;
    if(parsed.adjustments.length)await client.query('SELECT verify.record_statement_adjustments($1,$2)',[statement,JSON.stringify(parsed.adjustments)]);
    const runId=(await client.query('SELECT verify.run_reconciliation($1) AS id',[statement])).rows[0].id;
    const run=(await client.query('SELECT * FROM verify.recon_run WHERE id=$1',[runId])).rows[0];
    await client.query('COMMIT');inTransaction=false;printRun(run,write);
    if(o.certify) {const id=await certifyRun(client,runId,store);write(`certified ${id}`);}
    return run;
  }finally {
    if(inTransaction)await client.query('ROLLBACK').catch(()=>{});
    if(client)client.release();if(pool)await pool.end();if(dir)await rm(dir,{recursive:true,force:true});
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{await importQboRec(process.argv.slice(2));}
  catch(error) {
    if(error instanceof ParseError || error instanceof ImportRefusal){console.error(error.message);process.exitCode=2;}
    else{logFailure('QBO reconciliation import failed',error);process.exitCode=1;}
  }
}
