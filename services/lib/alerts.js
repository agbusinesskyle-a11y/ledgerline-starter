import { setTimeout as delay } from 'node:timers/promises';
import { log } from './log.js';
import { ping } from './heartbeat.js';
const vars = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'TWILIO_ALERT_TO'];
const warned = new Set();
export const transport = {
  sleep: delay,
  async send(alert, env) {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded' },
      // Only operational identifiers, never detail (which can contain bank payloads).
      body: new URLSearchParams({ From: env.TWILIO_FROM, To: env.TWILIO_ALERT_TO,
        Body: `ledgerline page: ${alert.kind}; alert ${alert.id}` }),
    });
    if (!response.ok) throw new Error('SMS rejected');
  },
};
export async function deliverPending(pool, { env = process.env, sender = transport } = {}) {
  const missing = vars.find(name => !env[name]);
  if (missing) {
    if (!warned.has(missing)) { log('warn', `missing variable: ${missing}`); warned.add(missing); }
    return { delivered: 0, pending: true };
  }
  const client = pool.connect ? await pool.connect() : pool;
  let locked = false;
  try {
    // Session lock prevents two service instances sending the same pending page.
    locked = (await client.query('SELECT pg_try_advisory_lock(7002) AS locked')).rows[0].locked;
    if (!locked) return { delivered: 0, pending: true };
    const { rows } = await client.query('SELECT * FROM ops.pending_alerts()');
    const seen = new Set();
    let delivered = 0, pending = false;
    for (const alert of rows) {
      if (seen.has(alert.dedupe_key)) continue;
      seen.add(alert.dedupe_key);
      for (let attempt = 0; attempt < 3; attempt++) {
        let sent = false;
        try { await sender.send(alert, env); sent = true; } catch { /* no remote error text */ }
        await client.query('SELECT ops.record_alert_attempt($1, $2)', [alert.id, sent]);
        if (sent) { delivered++; break; }
        if (attempt < 2) await sender.sleep(250 * 2 ** attempt);
        else { pending = true; log('error', 'alert delivery failed', { alert_id: alert.id, attempts: 3 }); }
      }
    }
    if (!pending) await ping('ALERTS', undefined, {}, env);
    return { delivered, pending };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(7002)').catch(() => {});
    if (client !== pool) client.release();
  }
}
