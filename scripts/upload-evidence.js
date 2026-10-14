#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storage } from '../services/backup/storage.js';
import { sha256, retainEvidence } from '../services/verify/evidence.js';
import { logFailure } from '../services/lib/log.js';
export async function uploadEvidence(file,{env=process.env,store,write=console.log}={}) {
  const ext=extname(file).slice(1).toLowerCase();
  if(!/^[a-z0-9]+$/.test(ext)) throw new Error('evidence file requires an extension');
  const body=await readFile(file),sha=sha256(body),key=`evidence/${sha}.${ext}`;
  store ??= storage(env);
  const contentType={pdf:'application/pdf',json:'application/json',txt:'text/plain',csv:'text/csv',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'}[ext]||'application/octet-stream';
  await retainEvidence(store,key,body,contentType);write(`${sha} ${key}`);return {sha,key};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.length!==3) {console.error('usage: scripts/upload-evidence.js <file>');process.exitCode=2;}
  else try{await uploadEvidence(process.argv[2]);}catch(error){logFailure('evidence upload failed',error);process.exitCode=1;}
}
