import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Encrypter, Decrypter } from 'age-encryption';
export const countTables = ['core.transaction', 'raw.api_call', 'ops.publication'];
export async function rowCounts(pool) {
  const rows = {};
  for (const table of countTables) rows[table] = (await pool.query(`SELECT count(*)::text AS count FROM ${table}`)).rows[0].count;
  return rows;
}
export async function digestFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { size: (await stat(file)).size, sha256: hash.digest('hex') };
}
export async function encryptFile(input, output, recipient) {
  const e = new Encrypter();
  e.addRecipient(recipient);
  const stream = await e.encrypt(Readable.toWeb(createReadStream(input)));
  await pipeline(Readable.fromWeb(stream), createWriteStream(output, { mode: 0o600 }));
}
export async function decryptFile(input, output, identity) {
  const d = new Decrypter();
  for (const line of identity.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))) d.addIdentity(line);
  const stream = await d.decrypt(Readable.toWeb(createReadStream(input)));
  await pipeline(Readable.fromWeb(stream), createWriteStream(output, { mode: 0o600 }));
}
export function makeManifest(ts, files, pgVersion, counts) {
  const manifest = { ts, files: files.map(f => f.key),
    sizes: Object.fromEntries(files.map(f => [f.key, f.size])),
    sha256s: Object.fromEntries(files.map(f => [f.key, f.sha256])), pg_version: pgVersion, row_counts: counts };
  return manifest;
}
export function validateManifest(m, prefix, ts) {
  if (m.ts !== ts || !Number.isFinite(Date.parse(ts)) || !Array.isArray(m.files) || m.files.length !== 2 ||
      typeof m.pg_version !== 'string' || !countTables.every(t => /^\d+$/.test(String(m.row_counts?.[t])))) throw new Error('invalid manifest');
  for (const suffix of ['dump', 'globals.sql']) {
    const key = m.files.find(k => typeof k === 'string' && k.startsWith(`${prefix}${ts}-`) && k.endsWith(`.${suffix}.age`));
    const sha = m.sha256s?.[key];
    if (!key || !/^[a-f0-9]{64}$/.test(sha || '') || key !== `${prefix}${ts}-${sha.slice(0, 16)}.${suffix}.age` ||
        !Number.isSafeInteger(m.sizes?.[key]) || m.sizes[key] <= 0) throw new Error('invalid manifest file');
  }
  return m;
}
export function runPg(command, args, dsn, { ignoreExistingRoles = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    // DSNs never enter argv or diagnostic output; all psql user startup files disabled.
    const url = new URL(dsn);
    const connectionEnv = { ...process.env, PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password) };
    for (const name of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'channel_binding']) {
      if (url.searchParams.has(name)) connectionEnv[`PG${name.toUpperCase()}`] = url.searchParams.get(name);
    }
    const child = spawn(command, args, { env: connectionEnv, signal,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { if (stdout.length < 1024 * 1024) stdout += b; });
    child.stderr.on('data', b => { if (stderr.length < 1024 * 1024) stderr += b; });
    child.on('error', () => reject(new Error(`${command} could not run`)));
    child.on('close', code => {
      const errors = stderr.split('\n').filter(line => /ERROR:|FATAL:/.test(line));
      const unexpected = errors.filter(line => !(ignoreExistingRoles && /ERROR:\s+role ".*" already exists\s*$/.test(line)));
      if (code !== 0 || unexpected.length) {
        // Bounded tool diagnostic (no DSN ever reaches argv/stderr): the first server or
        // client error line, else the first stderr line, else the exit code.
        const lines = stderr.split('\n').map(line => line.trim()).filter(Boolean);
        const picked = unexpected[0] || lines.find(line => /error:/i.test(line)) || lines[0] || `exit ${code}`;
        const error = new Error(`${command} failed`);
        error.code = `${command.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_FAILED`;
        error.diagnostic = picked.replace(/postgres(ql)?:\/\/\S+/g, 'postgres://***').slice(0, 300);
        reject(error);
      } else resolve(stdout.trim());
    });
  });
}
