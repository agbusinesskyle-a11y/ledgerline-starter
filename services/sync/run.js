import { decryptToken, createPlaid, scrub } from '../lib/plaid.js';
import { reducePages } from './reducer.js';
import { validateChain } from './validate.js';
import { log } from '../lib/log.js';

const MUTATION = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const allowedStates = new Set(['inventoried','initial_sync','ok','retryable_error']);
const codeOf = error => /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'SYNC_FAILED';
export async function raise(pool, connection, kind, detail = {}) {
  await pool.query('SELECT ops.raise_alert($1,$2,$3,$4,$5::jsonb)',
    [connection.org_id,kind,`${kind}:${connection.connection_id}`,connection.connection_id,JSON.stringify(detail)]);
}
async function fetchForConnection(pool, plaid, connection, endpoint, options, signal) {
  // Neither the token nor a request containing it is retained in page metadata.
  let token = await decryptToken(pool, connection.connection_id);
  try {
    const response = await plaid.post(endpoint, { access_token:token,...options }, { signal });
    return { ...response,json:scrub(response.json,token) };
  } finally { token = null; }
}
export async function persistApi(client, connection, endpoint, options, response) {
  const r = response.json;
  return (await client.query(`INSERT INTO raw.api_call(org_id,connection_id,endpoint,api_version,request_options,
    plaid_request_id,http_status,payload,error_type,error_code)
    VALUES($1,$2,$3,'2020-09-14',$4::jsonb,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
  [connection.org_id,connection.connection_id,endpoint,JSON.stringify(options),response.requestId || null,
    response.status,JSON.stringify(r),r?.error_type || null,r?.error_code || null])).rows[0].id;
}
async function classify(pool, connection, code) {
  const state = code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'retryable_error';
  if (state === 'login_required') await raise(pool,connection,'login_required',{code});
  return state;
}
async function observe({pool,plaid=createPlaid(),connection,endpoint,record,deadlineMs=30_000}) {
  const response = await fetchForConnection(pool,plaid,connection,endpoint,{},AbortSignal.timeout(Math.max(1,deadlineMs)));
  const api = await persistApi(pool,connection,endpoint,{},response);
  if (endpoint === '/item/get') {
    await pool.query('SELECT core.record_health($1,$2)',[connection.connection_id,api]);
  }
  const errorCode=response.json.error_code || response.json.item?.error?.error_code;
  if (response.status !== 200 || errorCode) {
    const state = await classify(pool,connection,errorCode || 'HTTP_ERROR');
    return {status:'failed',state};
  }
  if (record) await pool.query(`SELECT core.${record}($1,$2)`,[connection.connection_id,api]);
  return {status:'ok',api_call_id:api};
}
export const inventoryConnection = args => observe({...args,endpoint:'/accounts/get',record:'record_inventory'});
export const healthConnection = args => observe({...args,endpoint:'/item/get'});

export function balancesFromPages(pages) {
  return pages.flatMap(page => (page.payload.accounts || []).map(a => ({
    external_account_id:a.account_id,current:a.balances?.current ?? null,available:a.balances?.available ?? null,
    limit:a.balances?.limit ?? null,iso_currency_code:a.balances?.iso_currency_code ?? null,
    api_call_id:Number(page.api_call_id),provider_as_of:a.balances?.last_updated_datetime ?? null,
  })));
}
export async function syncConnection({pool,plaid=createPlaid(),connection,deadlineMs=300_000,hooks={}}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs<=0) return {status:'exhausted',reason:'deadline'};
  const end = Date.now()+deadlineMs;
  const client = await pool.connect();
  let locked=false, attempt, accepting=false, broken=false, terminal=false;
  const onError=()=>{broken=true;};
  client.on('error',onError);
  const id = typeof connection === 'string' ? connection : connection.connection_id;
  const checkDeadline = () => {
    if (Date.now()>=end) throw Object.assign(new Error('Sync deadline reached'),{code:'SYNC_DEADLINE'});
  };
  const finish = async (status,code=null) => {
    await pool.query('SELECT ops.finish_attempt($1,$2,$3)',[attempt.id,status,code]);
    terminal=!['validating','accepting'].includes(status);
  };
  // Read the durable receipt on a separate session; the accepting client may
  // have disconnected after PostgreSQL committed but before returning its ID.
  const receipt = async attemptId => (await pool.query(
    'SELECT publication_id FROM raw.sync_acceptance WHERE attempt_id=$1',[attemptId])).rows[0]?.publication_id;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[id])).rows[0].locked;
    if (!locked) return {status:'skipped',reason:'lock_contention'};
    connection=(await client.query('SELECT * FROM core.source_connection WHERE connection_id=$1',[id])).rows[0];
    if (!connection) throw Object.assign(new Error('Unknown connection'),{code:'UNKNOWN_CONNECTION'});
    if (!allowedStates.has(connection.state)) return {status:'skipped',reason:'connection_state',state:connection.state};
    // A process crash leaves fetching pages as immutable evidence. Never resume a
    // partial batch: retire it under the session lock, then fetch from the head.
    const unfinished=(await client.query(`SELECT id FROM ops.sync_attempt WHERE connection_id=$1
      AND status IN ('fetching','validating','accepting') ORDER BY id`,[id])).rows;
    for (const old of unfinished) {
      const accepted=await receipt(old.id);
      if (!accepted) await pool.query("SELECT ops.finish_attempt($1,'abandoned','PROCESS_RESTART')",[old.id]);
    }
    let restarts=0;
    for (;;) {
      const attemptId=(await client.query('SELECT ops.open_attempt($1,$2,$3) AS id',[id,String(process.pid),restarts])).rows[0].id;
      attempt=(await client.query('SELECT * FROM ops.sync_attempt WHERE id=$1',[attemptId])).rows[0];
      terminal=false;
      let cursor=attempt.cursor_in;
      const pages=[];
      let restart=false;
      for (;;) {
        checkDeadline();
        const options={count:500,options:{include_original_description:true,personal_finance_category_version:'v2'}};
        if (cursor !== null) options.cursor=cursor;
        const response=await fetchForConnection(client,plaid,connection,'/transactions/sync',options,
          AbortSignal.timeout(Math.max(1,end-Date.now())));
        checkDeadline();
        if (response.status!==200 || response.json.error_code) {
          await persistApi(client,connection,'/transactions/sync',options,response);
          const code=response.json.error_code || 'HTTP_ERROR';
          if (code===MUTATION) {
            // The initial fetch plus at most three fresh attempts (§4.2).
            if (restarts===3) {
              await finish('exhausted',code); await raise(pool,connection,'poisoned_attempt',{code});
              return {status:'exhausted',attempt_id:attempt.id};
            }
            await finish('abandoned',code); restarts++; restart=true; break;
          }
          await finish('failed',code);
          return {status:'failed',state:await classify(pool,connection,code),attempt_id:attempt.id};
        }
        const page={org_id:connection.org_id,connection_id:id,attempt_id:attempt.id,page_no:pages.length+1,
          cursor_in:cursor,cursor_out:response.json.next_cursor,has_more:response.json.has_more,payload:response.json};
        await hooks.beforePagePersist?.({client,connection,attempt,page,pages});
        checkDeadline();
        await client.query('BEGIN');
        try {
          page.api_call_id=await persistApi(client,connection,'/transactions/sync',options,response);
          page.id=(await client.query(`INSERT INTO raw.sync_page(org_id,attempt_id,page_no,api_call_id,cursor_in,cursor_out,has_more)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[page.org_id,page.attempt_id,page.page_no,page.api_call_id,
            page.cursor_in,page.cursor_out,page.has_more])).rows[0].id;
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
        pages.push(page);
        await hooks.afterPagePersist?.({client,connection,attempt,page,pages});
        cursor=response.json.next_cursor;
        if (response.json.has_more!==true) break;
      }
      if (restart) continue;
      await finish('validating');
      const validation=validateChain(pages,attempt);
      if (!validation.ok) {
        await finish('invalid',validation.reason); await raise(pool,connection,'poisoned_attempt',{reason:validation.reason});
        return {status:'invalid',reason:validation.reason,attempt_id:attempt.id};
      }
      const authorities=(await client.query('SELECT pending_id,connection_id,external_id FROM ops.sync_claim_context WHERE subject_connection_id=$1',[id])).rows;
      const transitions=reducePages(pages,{connectionId:id,authorities});
      const balances=balancesFromPages(pages);
      await hooks.beforeAccept?.({client,connection,attempt,pages,transitions,balances});
      checkDeadline();
      await finish('accepting');
      accepting=true;
      try {
        const publication=(await client.query('SELECT core.accept_publication($1,$2,$3,$4::jsonb,$5::jsonb,1) AS id',
          [attempt.id,pages.map(p=>p.id),cursor,JSON.stringify(transitions),JSON.stringify(balances)])).rows[0].id;
        await hooks.afterAcceptBeforeAck?.({client,connection,attempt,pages,publication_id:publication});
        return {status:'accepted',attempt_id:attempt.id,publication_id:publication};
      } catch (error) {
        // Use another pooled session: the accepting socket may already be dead.
        // If this read itself fails, propagate uncertainty without poisoning.
        const publication=await receipt(attempt.id);
        if (publication) return {status:'accepted',attempt_id:attempt.id,publication_id:publication,recovered:true};
        // A client-side timeout proves nothing about the server: the acceptance may still be
        // running (or queued on the publication lock behind another acceptance) and may commit
        // later. In production an attempt was once poisoned this way while waiting
        // 15 min behind an orphaned multi-page acceptance. Leave the attempt 'accepting';
        // the next run re-reads the receipt and abandons it only if nothing was committed.
        if (/timeout/i.test(error?.message || '')) {
          log('warn','acceptance timed out client-side; attempt left accepting for receipt recheck',{attempt_id:attempt.id});
          return {status:'failed',reason:'accept_timeout',attempt_id:attempt.id};
        }
        await finish('poisoned',codeOf(error));
        await raise(pool,connection,'poisoned_attempt',{code:codeOf(error)});
        return {status:'poisoned',attempt_id:attempt.id};
      }
    }
  } catch (error) {
    const code=Date.now()>=end ? 'SYNC_DEADLINE' : codeOf(error);
    if (attempt && !accepting && !terminal) {
      await finish(code==='SYNC_DEADLINE' ? 'exhausted' : code==='PLAID_REQUEST_FAILED' ? 'failed' : 'abandoned',code);
      if (code==='SYNC_DEADLINE') {
        await raise(pool,connection,'poisoned_attempt',{code}); return {status:'exhausted',reason:'deadline',attempt_id:attempt.id};
      }
      if (code==='PLAID_REQUEST_FAILED') return {status:'failed',state:await classify(pool,connection,code),attempt_id:attempt.id};
    }
    if (!attempt && code==='SYNC_DEADLINE') return {status:'exhausted',reason:'deadline'};
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))',[id]).catch(()=>{broken=true;});
    // Destroy a broken session so it can never retain a lock in the pool.
    client.release(broken ? new Error('connection lost') : undefined);
    client.removeListener('error',onError);
  }
}
export async function evaluateAlerts(pool) {
  const candidates=(await pool.query('SELECT * FROM ops.sync_alert_candidates')).rows;
  for (const c of candidates) await raise(pool,c,c.kind);
  return candidates.length;
}
