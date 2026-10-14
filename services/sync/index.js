import { pathToFileURL } from 'node:url';
import { createPool } from '../lib/db.js';
import { createPlaid } from '../lib/plaid.js';
import { log, logFailure } from '../lib/log.js';
import { deliverPending } from '../lib/alerts.js';
import { ping } from '../lib/heartbeat.js';
import { syncConnection, inventoryConnection, healthConnection, evaluateAlerts } from './run.js';

export async function runSync({pool,plaid=createPlaid(),env=process.env,heartbeat=ping,deliver=deliverPending}={}) {
  const minutes=Number(env.SYNC_DEADLINE_MIN || 20);
  if (!Number.isFinite(minutes) || minutes<=0) throw new Error('Invalid sync deadline');
  const end=Date.now()+minutes*60_000;
  let failed=false;
  const results=[];
  const connections=(await pool.query('SELECT * FROM ops.sync_schedule ORDER BY last_synced_at NULLS FIRST,connection_id')).rows;
  const due = at => !at || Date.now()-new Date(at).getTime()>=86_400_000;
  for (const connection of connections) {
    if (Date.now()>=end) { failed=true; break; }
    try {
      const args={pool,plaid,connection,deadlineMs:Math.min(300_000,Math.max(1,end-Date.now()))};
      if (due(connection.inventory_at)) {
        const result=await inventoryConnection(args);
        if (result.status==='failed') { failed=true; results.push(result); continue; }
      }
      args.deadlineMs=Math.min(300_000,Math.max(1,end-Date.now()));
      const result=await syncConnection(args); results.push(result);
      if (['failed','poisoned','exhausted','invalid'].includes(result.status)) failed=true;
      if (due(connection.health_at) && result.state!=='login_required' && Date.now()<end) {
        const health=await healthConnection({...args,deadlineMs:Math.min(30_000,end-Date.now())});
        if (health.status==='failed') failed=true;
      }
    } catch (error) { failed=true; logFailure('connection sync failed',error); }
  }
  await evaluateAlerts(pool);
  await deliver(pool,{env});
  const counts=(await pool.query(`SELECT count(*) FILTER (WHERE acknowledged_at IS NULL) AS open,
    count(*) FILTER (WHERE delivered_at IS NULL) AS pending
    FROM ops.alert WHERE severity='page'`)).rows[0];
  if (Date.now()>=end) failed=true;
  if (!failed) await heartbeat('SYNC',pool,{},env);
  if (Number(counts.open)===0) await heartbeat('COVERAGE',pool,{},env);
  if (Number(counts.pending)===0) await heartbeat('ALERTS',pool,{},env);
  return {exitCode:failed ? 1 : 0,results};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    pool=createPool();
    const result=await runSync({pool}); process.exitCode=result.exitCode;
    log('info','sync completed',{connections:result.results.length,ok:result.exitCode===0});
  } catch (error) { logFailure('sync failed',error); process.exitCode=1; }
  finally { if (pool) await pool.end(); }
}
