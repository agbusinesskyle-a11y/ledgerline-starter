import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
export const sha256 = body => createHash('sha256').update(body).digest('hex');
export async function retainEvidence(store,key,body,contentType) {
  if(!/^evidence\/[a-f0-9]{64}\.[a-z0-9]+$/.test(key)) throw new Error('invalid evidence key');
  try {
    await store.client.send(new HeadObjectCommand({Bucket:store.bucket,Key:key})); return;
  }catch(error){if(error.$metadata?.httpStatusCode!==404 && error.name!=='NotFound' && error.name!=='NoSuchKey')throw error;}
  try {
    await store.client.send(new PutObjectCommand({Bucket:store.bucket,Key:key,Body:body,ContentType:contentType,IfNoneMatch:'*'}));
  }catch(error){if(error.$metadata?.httpStatusCode!==412 && error.name!=='PreconditionFailed')throw error;}
}
