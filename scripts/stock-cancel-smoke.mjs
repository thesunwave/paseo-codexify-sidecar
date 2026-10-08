import { createConnection } from 'node:net';
import assert from 'node:assert/strict';
const base=process.env.POC_PROXY_URL, sock=process.env.CODEXIFY_CHATGPT_BACKEND_SOCKET, workspace=process.env.POC_WORKSPACE;
let transport=null, i=1;
async function mcp(method,params={}){
  const headers={'content-type':'application/json','accept':'application/json,text/event-stream'};
  if(transport)headers['mcp-session-id']=transport;
  const res=await fetch(base,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:i++,method,params})});
  if(res.headers.get('mcp-session-id'))transport=res.headers.get('mcp-session-id');
  const body=await res.text();const line=body.split('\n').find(x=>x.startsWith('data: {'));
  return JSON.parse(line?line.slice(6):body).result;
}
function ctrl(req){
  return new Promise((resolve,reject)=>{
    const socket=createConnection(sock);let buf='';socket.setEncoding('utf8');socket.on('error',reject);
    socket.on('connect',()=>socket.write(JSON.stringify({...req,id:'control-'+i++})+'\n'));
    socket.on('data',x=>{buf+=x;if(buf.includes('\n')){socket.end();const out=JSON.parse(buf.split('\n')[0]);out.ok?resolve(out.result):reject(new Error(out.error?.message));}});
  });
}
await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'cancel-smoke',version:'1'}});
const worker=(await mcp('tools/call',{name:'paseo_backend_attach',arguments:{workspace}})).structuredContent;
const task=await ctrl({op:'dispatch',workspace,prompt:'sleep'});
const assigned=(await mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:worker.session_id,wait:false}})).structuredContent;
assert.equal(assigned.command.kind,'task');
const pending=mcp('tools/call',{name:'exec_command',arguments:{cmd:'sleep 17',yield_time_ms:30000}});
await new Promise(r=>setTimeout(r,650));
const at=Date.now();
await ctrl({op:'cancel',session_id:worker.session_id,run_id:task.run_id,reason:'Paseo interrupt'});
const returned=await pending;
console.log('NATIVE_CANCEL_RESULT',returned.isError,returned.structuredContent,'wait_ms',Date.now()-at);
const timeline=(await ctrl({op:'status',session_id:worker.session_id})).timeline;
console.log('TOOL_TIMELINE',timeline.map(e=>e.kind+':'+e.tool_status).join(' / '));
const control=(await mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:worker.session_id,wait:false}})).structuredContent;
console.log('COMMAND',control.command?.kind);
await mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:worker.session_id,wait:false,outbound:{kind:'error',command_seq:assigned.command.seq,content:'cancelled'}}});
const end=await ctrl({op:'run',session_id:worker.session_id,run_id:task.run_id});
console.log('RUN_FINAL',end.state);
assert.equal(end.state,'cancelled');
