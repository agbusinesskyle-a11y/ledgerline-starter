import { redact, requireEnv } from './log.js';

// Remote errors can echo a request verbatim; scrub both fields and token values.
export function scrub(value, token) {
  const safe = redact(value);
  if (typeof safe === 'string') return token ? safe.split(token).join('***') : safe;
  if (Array.isArray(safe)) return safe.map(item => scrub(item, token));
  if (safe && typeof safe === 'object') return Object.fromEntries(Object.entries(safe).map(([k,v]) => [k,scrub(v,token)]));
  return safe;
}
// PLAID_BASE_URL (tests) wins; otherwise PLAID_ENV picks sandbox/development/production.
// With neither set, sync talks to production Plaid (the original default).
export function plaidBaseUrl(env = process.env) {
  if (env.PLAID_BASE_URL) return env.PLAID_BASE_URL;
  const environment = env.PLAID_ENV || 'production';
  if (!['sandbox', 'development', 'production'].includes(environment)) throw new Error('invalid Plaid environment');
  return `https://${environment}.plaid.com`;
}
export function createPlaid(env = process.env) {
  return {
    async post(path, body, { signal } = {}) {
      try {
        const response = await fetch(`${plaidBaseUrl(env)}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'PLAID-VERSION':'2020-09-14',
            'PLAID-CLIENT-ID': requireEnv(env, 'PLAID_CLIENT_ID'), 'PLAID-SECRET': requireEnv(env, 'PLAID_SECRET') },
          body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        const json = scrub(await response.json(), body.access_token);
        return { status: response.status, json, requestId: json.request_id || response.headers.get('plaid-request-id') };
      } catch (cause) {
        const error = new Error('Plaid request failed');
        error.code = 'PLAID_REQUEST_FAILED';
        error.body = scrub(body, body.access_token);
        if (cause.missingVariable) error.missingVariable = cause.missingVariable;
        throw error;
      }
    },
  };
}
export const post = (...args) => createPlaid().post(...args);
export async function decryptToken(pool, connectionId) {
  try {
    const result = await pool.query('SELECT pgp_sym_decrypt(access_token_enc, $1) AS token FROM core.source_connection WHERE connection_id=$2',
      [requireEnv(process.env, 'TOKEN_KEK'), connectionId]);
    if (!result.rows[0]?.token) throw new Error('missing connection token');
    return result.rows[0].token;
  } catch {
    throw Object.assign(new Error('Token decryption failed'), { code: 'TOKEN_DECRYPT_FAILED' });
  }
}
