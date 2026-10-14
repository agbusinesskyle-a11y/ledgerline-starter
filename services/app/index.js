import http from 'node:http';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { createPool } from '../lib/db.js';
import { log, logFailure, requireEnv } from '../lib/log.js';
import { deliverPending } from '../lib/alerts.js';
const random = () => randomBytes(32).toString('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function makeTotp(secret) {
  return new OTPAuth.TOTP({ issuer: 'ledgerline', label: 'operator', algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}
async function readBody(req) {
  const text = await new Promise((resolve, reject) => {
    let size = 0, overflow = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 16384) {
        if (!overflow) { overflow = true; chunks.length = 0; const error = new Error('body too large'); error.status = 413; reject(error); }
      } else if (!overflow) chunks.push(chunk);
    });
    req.on('end', () => { if (!overflow) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
  try {
    if ((req.headers['content-type'] || '').startsWith('application/json')) return JSON.parse(text || '{}');
    return Object.fromEntries(new URLSearchParams(text));
  } catch { const error = new Error('invalid body'); error.status = 400; throw error; }
}
export function createApp({ pool, env = process.env, plaidFetch = fetch, clock = Date.now } = {}) {
  const sessions = new Map(), loginChallenges = new Map(), limits = new Map();
  // No feature secrets are inspected at startup; health remains usable before provisioning.
  const signature = id => createHmac('sha256', requireEnv(env, 'APP_SESSION_SECRET')).update(id).digest('hex');
  function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('='))); }
  function session(req) {
    const cookie = cookies(req).ll_session;
    if (!cookie || cookie.length > 200) return null;
    const [id, signed, extra] = cookie.split('.');
    if (!id || !signed || extra || !same(signature(id), signed)) return null;
    const value = sessions.get(id);
    if (!value || value.expires <= clock()) { sessions.delete(id); return null; }
    return value;
  }
  function respond(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }
  async function plaid(endpoint, body) {
    const client_id = requireEnv(env, 'PLAID_CLIENT_ID'), secret = requireEnv(env, 'PLAID_SECRET');
    const environment = requireEnv(env, 'PLAID_ENV');
    if (!['sandbox', 'development', 'production'].includes(environment)) throw new Error('invalid Plaid environment');
    const response = await plaidFetch(`${env.PLAID_BASE_URL || `https://${environment}.plaid.com`}${endpoint}`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, client_id, secret }),
    });
    if (!response.ok) {
      // Surface Plaid's own error classification (never the request, which carries credentials).
      const detail = await response.json().catch(() => ({}));
      const error = new Error('Plaid request failed');
      error.code = /^[A-Z0-9_]{1,30}$/.test(detail.error_code || '') ? detail.error_code : 'PLAID_REQUEST_FAILED';
      error.diagnostic = `${endpoint} ${response.status} ${detail.error_type || ''} ${String(detail.error_message || '').slice(0, 200)} request_id=${detail.request_id || ''}`;
      throw error;
    }
    return response.json();
  }
  async function mint(s, url) {
    if (url.searchParams.has('update_mode')) { const error = new Error('Update mode is pending; step 1 does not decrypt existing tokens.'); error.status = 501; throw error; }
    const slug = requireEnv(env, 'LL_ORG_SLUG');
    const redirect = new URL(requireEnv(env, 'LINK_REDIRECT_URI'));
    if (redirect.search || redirect.hash) throw new Error('LINK_REDIRECT_URI must have no query or fragment');
    const products = requireEnv(env, 'PLAID_PRODUCTS').split(',').map(p => p.trim()).filter(Boolean);
    const result = await plaid('/link/token/create', {
      user: { client_user_id: slug }, client_name: 'ledgerline', products,
      country_codes: ['US'], language: 'en', transactions: { days_requested: 730 }, redirect_uri: redirect.href,
    });
    if (typeof result.link_token !== 'string' || !result.link_token) throw new Error('invalid Link response');
    s.linkToken = result.link_token;
    return result.link_token;
  }
  function linkPage(s, receivedRedirectUri) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>ledgerline Link</title></head><body>
<button id="open">Connect bank</button><p id="status"></p><input type="hidden" name="csrf" value="${escapeHtml(s.csrf)}">
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script><script>
const csrf = ${scriptJson(s.csrf)}, linkToken = ${scriptJson(s.linkToken)};
const handler = Plaid.create({token: linkToken, ${receivedRedirectUri ? `receivedRedirectUri: ${scriptJson(receivedRedirectUri)},` : ''}
onSuccess: async (public_token, metadata) => {
 const response = await fetch('/link/exchange', {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
 body:JSON.stringify({public_token, link_token:linkToken, institution_id:metadata.institution?.institution_id, institution_name:metadata.institution?.name})});
 document.getElementById('status').textContent = response.ok ? 'Bank connected. Reloading for the next bank…' : 'Connection failed (' + response.status + ').';
 if (response.ok) setTimeout(() => location.reload(), 1500); // a Link token is single-use; reload mints a fresh one
},
onExit: (error, metadata) => {
 document.getElementById('status').textContent = error
  ? 'Link exited with error: ' + (error.error_code || '') + ' ' + (error.display_message || error.error_message || '') + ' [' + (metadata?.status || '') + ' ' + (metadata?.link_session_id || '') + ']'
  : 'Link closed before finishing [' + (metadata?.status || 'no status') + ' ' + (metadata?.link_session_id || '') + ']';
},
onEvent: (name, metadata) => { if (name === 'ERROR') document.getElementById('status').textContent = 'Link error: ' + (metadata.error_code || '') + ' ' + (metadata.error_message || ''); }
}); document.getElementById('open').onclick=()=>handler.open(); ${receivedRedirectUri ? 'handler.open();' : ''}
</script></body></html>`;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/login') {
        const ip = req.socket.remoteAddress;
        const now = clock();
        let window = limits.get(ip);
        if (!window || now >= window.expires) { window = { count: 0, expires: now + 60000 }; limits.set(ip, window); }
        if (++window.count > 10) { res.setHeader('Retry-After', '60'); return respond(res, 429, { error: 'Login rate limit exceeded' }); }
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        await pool.query('SELECT 1'); return respond(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        const challenge = random(); loginChallenges.set(challenge, clock() + 600000);
        res.setHeader('Set-Cookie', `ll_login=${challenge}; HttpOnly; Secure; SameSite=Strict; Max-Age=600; Path=/login`);
        return respond(res, 200, `<!doctype html><html><body><form method="post" action="/login">
<input type="hidden" name="csrf" value="${challenge}"><label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<label>TOTP <input name="totp" inputmode="numeric" autocomplete="one-time-code" required></label><button>Log in</button></form></body></html>`, 'text/html');
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = await readBody(req);
        const hash = requireEnv(env, 'APP_LOGIN_PASSWORD_HASH'), secret = requireEnv(env, 'APP_TOTP_SECRET');
        requireEnv(env, 'APP_SESSION_SECRET');
        const challenge = cookies(req).ll_login;
        if (!challenge || !same(body.csrf, challenge) || (loginChallenges.get(challenge) || 0) <= clock()) return respond(res, 403, { error: 'Invalid CSRF token' });
        if (typeof body.password !== 'string' || typeof body.totp !== 'string' ||
            !await bcrypt.compare(body.password, hash) || makeTotp(secret).validate({ token: body.totp, window: 1 }) === null) return respond(res, 401, { error: 'Invalid credentials' });
        loginChallenges.delete(challenge);
        const id = random();
        sessions.set(id, { expires: clock() + 86400000, csrf: random(), state: random(), linkToken: null });
        res.setHeader('Set-Cookie', `ll_session=${id}.${signature(id)}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400; Path=/`);
        return respond(res, 200, { ok: true, redirect: '/link' });
      }
      if (!['/link', '/link/token', '/link/exchange', '/link/oauth'].includes(url.pathname)) return respond(res, 404, { error: 'Not found' });
      const s = session(req);
      // A cross-site OAuth navigation initially omits SameSite=Strict cookies.
      // A same-origin reload establishes them without weakening the session cookie.
      if (!s && req.method === 'GET' && url.pathname === '/link/oauth' &&
          url.searchParams.has('oauth_state_id') && cookies(req).ll_oauth_state && !url.searchParams.has('ll_resumed')) {
        const resumed = new URL(url); resumed.searchParams.set('ll_resumed', '1');
        return respond(res, 200, `<!doctype html><html><body><script>location.replace(${scriptJson(resumed.pathname + resumed.search)});</script></body></html>`, 'text/html');
      }
      if (!s) return respond(res, 401, { error: 'Login required' });
      if (req.method === 'GET' && url.pathname === '/link') {
        await mint(s, url);
        res.setHeader('Set-Cookie', `ll_oauth_state=${s.state}; HttpOnly; Secure; SameSite=Lax; Max-Age=86400; Path=/link/oauth`);
        return respond(res, 200, linkPage(s), 'text/html');
      }
      if (req.method === 'GET' && url.pathname === '/link/oauth') {
        const state = url.searchParams.get('state') || cookies(req).ll_oauth_state;
        if (!same(state, s.state) || !s.linkToken) return respond(res, 403, { error: 'Invalid OAuth state' });
        // Reuse the Link token that initiated OAuth; never mint a replacement here.
        const redirect = new URL(requireEnv(env, 'LINK_REDIRECT_URI'));
        const returned = new URL(url);
        returned.searchParams.delete('ll_resumed');
        returned.searchParams.delete('state');
        redirect.search = returned.search;
        return respond(res, 200, linkPage(s, redirect.href), 'text/html');
      }
      if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed' });
      const body = await readBody(req);
      if (!same(req.headers['x-csrf-token'] || body.csrf, s.csrf)) return respond(res, 403, { error: 'Invalid CSRF token' });
      if (url.pathname === '/link/token') {
        const link_token = await mint(s, url);
        res.setHeader('Set-Cookie', `ll_oauth_state=${s.state}; HttpOnly; Secure; SameSite=Lax; Max-Age=86400; Path=/link/oauth`);
        return respond(res, 200, { link_token });
      }
      if (url.pathname !== '/link/exchange') return respond(res, 405, { error: 'Method not allowed' });
      if (!s.linkToken || !same(body.link_token, s.linkToken)) return respond(res, 403, { error: 'Link token was not issued by this session' });
      if (typeof body.public_token !== 'string' || !body.public_token) return respond(res, 400, { error: 'Public token required' });
      const kek = requireEnv(env, 'TOKEN_KEK'), slug = requireEnv(env, 'LL_ORG_SLUG');
      const exchanged = await plaid('/item/public_token/exchange', { public_token: body.public_token });
      if (typeof exchanged.access_token !== 'string' || typeof exchanged.item_id !== 'string') throw new Error('invalid exchange response');
      const result = await pool.query(`SELECT core.register_connection(core.org_id_for_slug($1), $2,
        public.pgp_sym_encrypt($3::text, $4::text), $5::text, $6::text, $7::uuid) AS connection_id`,
      [slug, exchanged.item_id, exchanged.access_token, kek, typeof body.institution_id === 'string' ? body.institution_id : null,
        typeof body.institution_name === 'string' ? body.institution_name : null, null]);
      s.linkToken = null;
      // Delivery is best effort for the app; sync also drains pending pages.
      await deliverPending(pool, { env }).catch(error => logFailure('alert delivery failed', error));
      return respond(res, 200, { connection_id: result.rows[0].connection_id });
    } catch (error) {
      if (error.status) return respond(res, error.status, { error: error.status === 501 ? error.message : 'Invalid request' });
      logFailure('app request failed', error);
      respond(res, 503, { error: error.missingVariable ? `missing variable: ${error.missingVariable}` : 'Service unavailable' });
    }
  });
  const cleanup = setInterval(() => {
    for (const [id, s] of sessions) if (s.expires <= clock()) sessions.delete(id);
    for (const [id, expires] of loginChallenges) if (expires <= clock()) loginChallenges.delete(id);
    for (const [ip, window] of limits) if (window.expires <= clock()) limits.delete(ip);
  }, 60000);
  cleanup.unref();
  server.on('close', () => clearInterval(cleanup));
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    pool = createPool();
    const app = createApp({ pool });
    app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => log('info', 'app listening'));
    app.on('error', error => { logFailure('app server failed', error); process.exitCode = 1; pool.end(); });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => app.close(() => pool.end()));
  } catch (error) { logFailure('app startup failed', error); process.exitCode = 1; if (pool) await pool.end(); }
}
