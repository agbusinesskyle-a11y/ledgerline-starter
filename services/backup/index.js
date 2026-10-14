import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createPool } from '../lib/db.js';
import { log, logFailure, requireEnv } from '../lib/log.js';
import { ping } from '../lib/heartbeat.js';
import { storage, listObjects } from './storage.js';
import { selectRetention } from './retention.js';
import { runPg, rowCounts, encryptFile, digestFile, makeManifest } from './common.js';
export async function backup(env = process.env) {
  const superDsn = requireEnv(env, 'PG_SUPER_DATABASE_URL');
  const recipient = requireEnv(env, 'BACKUP_AGE_RECIPIENT');
  const store = storage(env);
  const pool = createPool(env);
  let dir, client;
  const deadline = setTimeout(() => { log('error', 'backup deadline exceeded'); process.exit(1); }, 15 * 60 * 1000);
  try {
    dir = await mkdtemp(join(tmpdir(), 'ledgerline-backup-'));
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
    const counts = await rowCounts(client);
    const version = (await client.query('SHOW server_version')).rows[0].server_version;
    const databaseSize = (await client.query('SELECT pg_database_size(current_database())::text AS size')).rows[0].size;
    const ts = new Date().toISOString();
    await runPg('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, '--file', join(dir, 'dump')], superDsn);
    await client.query('COMMIT');
    client.release(); client = undefined;
    await runPg('pg_dumpall', ['--globals-only', '--no-role-passwords', '--file', join(dir, 'globals.sql')], superDsn);
    const files = [];
    for (const suffix of ['dump', 'globals.sql']) {
      const encrypted = join(dir, `${suffix}.age`);
      await encryptFile(join(dir, suffix), encrypted, recipient);
      const metadata = await digestFile(encrypted);
      const key = `${store.prefix}${ts}-${metadata.sha256.slice(0, 16)}.${suffix}.age`;
      await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: key, Body: createReadStream(encrypted), ContentLength: metadata.size }));
      files.push({ key, ...metadata });
    }
    const manifest = makeManifest(ts, files, version, counts);
    const manifestBody = JSON.stringify(manifest);
    await writeFile(join(dir, 'manifest.json'), manifestBody, { mode: 0o600 });
    // Manifest is the commit marker, written after both successful uploads.
    await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: `${store.prefix}${ts}.manifest.json`, Body: manifestBody, ContentType: 'application/json' }));
    const selection = selectRetention(await listObjects(store), store.prefix);
    // Refuse unsafe deletes: evidence/ is permanent, and BACKUP_PREFIX is the boundary.
    if (selection.delete.some(key => !key.startsWith(store.prefix) || /(^|\/)evidence\//.test(key))) {
      throw new Error('unsafe retention selection');
    }
    for (let i = 0; i < selection.delete.length; i += 1000) {
      const keys = selection.delete.slice(i, i + 1000);
      if (env.BACKUP_RETENTION_DRY_RUN === '1') { log('info', 'retention dry run', { objects: keys.length }); continue; }
      const result = await store.client.send(new DeleteObjectsCommand({ Bucket: store.bucket, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }));
      if (result.Errors?.length) throw new Error('retention deletion failed');
    }
    const detail = { newest_restorable_age_seconds: Math.ceil((Date.now() - Date.parse(ts)) / 1000), pg_database_size: databaseSize };
    log('info', 'backup completed', detail);
    await ping('BACKUP', pool, detail, env);
    return manifest;
  } finally {
    try {
      if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
      await pool.end();
      store.client.destroy();
      if (dir) await rm(dir, { recursive: true, force: true });
    } finally { clearTimeout(deadline); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await backup(); } catch (error) { logFailure('backup failed', error); process.exitCode = 1; }
}
