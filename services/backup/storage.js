import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { requireEnv } from '../lib/log.js';
export function storage(env = process.env) {
  const bucket = requireEnv(env, 'BACKUP_S3_BUCKET');
  const prefix = requireEnv(env, 'BACKUP_PREFIX');
  // An isolated backup prefix is mandatory; evidence can never be a retention root.
  if (!prefix.endsWith('/') || prefix.startsWith('/') || prefix.split('/').includes('..') ||
      prefix.split('/').includes('evidence')) throw new Error('invalid backup prefix');
  const client = new S3Client({ region: 'auto', forcePathStyle: true,
    // R2 does not implement every optional AWS streaming checksum extension.
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    endpoint: requireEnv(env, 'BACKUP_S3_ENDPOINT'),
    credentials: { accessKeyId: requireEnv(env, 'BACKUP_S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv(env, 'BACKUP_S3_SECRET_ACCESS_KEY') } });
  return { client, bucket, prefix };
}
export async function listObjects({ client, bucket, prefix }) {
  const objects = [];
  let continuation;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuation }));
    objects.push(...(page.Contents || []));
    continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuation) throw new Error('incomplete object listing');
  } while (continuation);
  return objects;
}
export async function getObject(store, key) {
  if (!key.startsWith(store.prefix)) throw new Error('object outside backup prefix');
  return store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: key }));
}
