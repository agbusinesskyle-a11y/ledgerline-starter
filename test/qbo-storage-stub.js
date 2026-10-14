// Offline S3 contract stub; all evidence writes are conditional and retained.
export function evidenceStub() {
  const objects=new Map();
  const store={bucket:'synthetic',prefix:'backups/synthetic/',objects,puts:0,client:{async send(command){
    const {Key,Body,IfNoneMatch}=command.input;
    if(command.constructor.name==='HeadObjectCommand') {
      if(!objects.has(Key)) throw Object.assign(new Error('absent'),{$metadata:{httpStatusCode:404}});
      return {};
    }
    if(command.constructor.name==='GetObjectCommand') {
      if(!objects.has(Key)) throw Object.assign(new Error('absent'),{$metadata:{httpStatusCode:404}});
      return {Body:{transformToByteArray:async()=>objects.get(Key)}};
    }
    if(command.constructor.name==='PutObjectCommand') {
      if(IfNoneMatch!=='*') throw new Error('unsafe overwrite');
      if(objects.has(Key)) throw Object.assign(new Error('exists'),{$metadata:{httpStatusCode:412}});
      objects.set(Key,Buffer.from(Body)); store.puts++; return {};
    }
    throw new Error('unexpected storage command');
  }}};
  return store;
}
