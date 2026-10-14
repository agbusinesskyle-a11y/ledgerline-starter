import { createServer } from 'node:http';

export async function createPlaidStub() {
  const scripts=new Map(),calls=[],pings=[];
  const server=createServer(async (req,res) => {
    if (req.method==='GET') { pings.push(req.url); res.end('ok'); return; }
    let body;
    try {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      body=JSON.parse(Buffer.concat(chunks).toString());
    } catch { res.writeHead(400); res.end('{}'); return; }
    const script=scripts.get(body.access_token);
    calls.push({path:req.url,body});
    let status=200, json;
    if (!script) { status=400; json={error_code:'ITEM_LOGIN_REQUIRED'}; }
    else if (req.url==='/transactions/sync') {
      const index=script.calls++;
      const error=typeof script.errors==='function' ? script.errors(index,body) : script.errors?.[index];
      if (script.delayMs) await new Promise(resolve=>setTimeout(resolve,script.delayMs));
      if (error) {
        status=typeof error==='number' ? error : 400;
        json={error_type:'ITEM_ERROR',error_code:typeof error==='number' ? 'INTERNAL_SERVER_ERROR' : error};
      } else {
        const n=script.pages.findIndex((p,i)=>(p.cursor_in ?? (i ? script.pages[i-1].next_cursor : null))===(body.cursor ?? null));
        json=n>=0 ? script.pages[n] : {added:[],modified:[],removed:[],next_cursor:body.cursor || 'empty',has_more:false};
        json={added:[],modified:[],removed:[],transactions_update_status:'HISTORICAL_UPDATE_COMPLETE',...json};
      }
    } else if (req.url==='/accounts/get') json={accounts:script.accounts || []};
    else if (req.url==='/item/get') json=script.health || {item:{consent_expiration_time:null,error:null},status:{transactions:{last_successful_update:new Date().toISOString()}}};
    else { status=404; json={}; }
    json={...json,request_id:`stub-${calls.length}`};
    res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(json));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,pings,
    set(token,script) { scripts.set(token,{...script,calls:0}); },
    close:() => new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}),
  };
}
