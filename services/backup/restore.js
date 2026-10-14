import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { storage, listObjects, getObject } from './storage.js';
import { digestFile, decryptFile, validateManifest, runPg, rowCounts } from './common.js';
import { log, logFailure } from '../lib/log.js';
export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--latest' && !options.latest) options.latest = true;
    else if (['--ts', '--target', '--identity'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--') && !options[arg.slice(2)]) options[arg.slice(2)] = args[++i];
    else throw new Error('invalid restore arguments');
  }
  if (!!options.latest === !!options.ts || !options.target || !options.identity) throw new Error('usage: --latest|--ts <ts> --target <dsn> --identity <file>');
  return options;
}
export async function restore(options, env = process.env) {
  const store = storage(env);
  let dir, pool;
  try {
    let ts = options.ts;
    if (options.latest) {
      const keys = (await listObjects(store)).map(o => o.Key).filter(k =>
        k.startsWith(store.prefix) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.manifest\.json$/.test(k.slice(store.prefix.length))).sort();
      if (!keys.length) throw new Error('no backup manifest');
      ts = keys.at(-1).slice(store.prefix.length, -'.manifest.json'.length);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts || '')) throw new Error('invalid backup timestamp');
    const object = await getObject(store, `${store.prefix}${ts}.manifest.json`);
    const manifest = validateManifest(JSON.parse(await object.Body.transformToString()), store.prefix, ts);
    dir = await mkdtemp(join(tmpdir(), 'ledgerline-restore-'));
    const identity = await readFile(options.identity, 'utf8');
    for (const key of manifest.files) {
      const suffix = key.endsWith('.dump.age') ? 'dump' : 'globals.sql';
      const encrypted = join(dir, `${suffix}.age`);
      const response = await getObject(store, key);
      await pipeline(response.Body, createWriteStream(encrypted, { mode: 0o600 }));
      const actual = await digestFile(encrypted);
      if (actual.sha256 !== manifest.sha256s[key] || actual.size !== manifest.sizes[key]) throw new Error('backup checksum or size mismatch');
      await decryptFile(encrypted, join(dir, suffix), identity);
    }
    await runPg('psql', ['-X', '--set=ON_ERROR_STOP=off', '--file', join(dir, 'globals.sql')], options.target, { ignoreExistingRoles: true });
    await runPg('pg_restore', ['--dbname', decodeURIComponent(new URL(options.target).pathname.slice(1)), '--no-owner', '--no-privileges', '--clean', '--if-exists', '--exit-on-error', join(dir, 'dump')], options.target);
    pool = new pg.Pool({ connectionString: options.target, connectionTimeoutMillis: 5000 });
    const actual = await rowCounts(pool);
    log('info', 'restore row counts', { expected: manifest.row_counts, restored: actual });
    if (Object.entries(manifest.row_counts).some(([table, count]) => String(count) !== actual[table])) throw new Error('restore row counts mismatch');
    return manifest;
  } finally {
    if (pool) await pool.end();
    store.client.destroy();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await restore(parseArgs(process.argv.slice(2))); }
  catch (error) { logFailure('restore failed (check arguments, files, database and storage)', error); process.exitCode = 1; }
}
