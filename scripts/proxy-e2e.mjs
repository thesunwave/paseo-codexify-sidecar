import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const providerModule = process.env.POC_PROVIDER_MODULE || '../../paseo-chatgpt-provider/server/provider.ts';
const { createChatGptCodexifyProvider } = await import(pathToFileURL(resolve(providerModule)).href);

const base=process.env.POC_PROXY_URL||'http://127.0.0.1:38722/mcp';
const workspace=realpathSync(process.env.POC_WORKSPACE);
const socket=process.env.CODEXIFY_CHATGPT_BACKEND_SOCKET;
let sid=null,id=1;
async function mcp(method, params={}) {
  const headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
  if (sid) headers['mcp-session-id']=sid;
  const res=await fetch(base,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params})});
  if(res.headers.get('mcp-session-id'))sid=res.headers.get('mcp-session-id');
  const txt=await res.text();
  const line=txt.split('\n').find(x=>x.startsWith('data: {'));
  const parsed=JSON.parse(line?line.slice(6):txt);
  if(parsed.error || parsed.result?.isError)throw new Error(JSON.stringify(parsed));
  return parsed.result;
}
async function ctrl(o) {
  return new Promise((resolve,reject)=>{
    const s=createConnection(socket);s.setEncoding('utf8');let buf='';
    const correlation='test'+id++;
    s.on('connect',()=>s.write(JSON.stringify({...o,id:correlation})+'\n'));
    s.on('error',reject);
    s.on('data',x=>{buf+=x;if(buf.includes('\n')){s.end();const msg=JSON.parse(buf.split('\n')[0]);if(!msg.ok)reject(new Error(msg.error?.message));else resolve(msg.result);}});
  });
}
const init=await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'proxy-test',version:'0'}});
assert.equal(init.serverInfo.name,'codexify');
const list=await mcp('tools/list');
const tools=list.tools.map(x=>x.name);
console.log('MODEL_TOOLS',tools.length,tools.filter(x=>x.startsWith('paseo_')));
assert(tools.includes('paseo_backend_attach') && tools.includes('exec_command'));
const worker=(await mcp('tools/call',{name:'paseo_backend_attach',arguments:{workspace}})).structuredContent;
assert.equal(worker.state,'ready');console.log('ATTACHED',worker.session_id,'transport',sid);

const provider=createChatGptCodexifyProvider({acquireRetryMs:100});
const conn=await provider.connect({versions:[1],capabilities:['prompt.message','prompt.steer','session.persistence']});
const events=[];conn.onEvent(e=>events.push(e));
await conn.send({type:'session.open',requestId:'open',sessionId:'test-session',config:{cwd:workspace,persist:true}});
await conn.send({type:'session.prompt',sessionId:'test-session',prompt:{clientMessageId:'msg1',delivery:'auto',input:{type:'message',content:[{type:'text',text:'Run pwd'}]}}});
const task=(await mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:worker.session_id,wait:false}})).structuredContent;
assert.equal(task.command.content,'Run pwd');

let output=(await mcp('tools/call',{name:'exec_command',arguments:{cmd:'pwd'}})).structuredContent;
if(output.session_id){
  output=(await mcp('tools/call',{name:'write_stdin',arguments:{session_id:output.session_id,chars:'',yield_time_ms:1000}})).structuredContent;
}
output=output.upstream_result??output;
console.log('EXEC_RESULT',output);
assert.equal(output.exit_code,0);
await mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:worker.session_id,wait:false,outbound:{kind:'result',command_seq:task.command.seq,content:output.output}}});
for(let i=0;i<100 && !events.some(e=>e.type==='session.turn'&&e.state==='completed');i++)await new Promise(r=>setTimeout(r,50));
const records=events.filter(e=>e.type==='timeline.item').map(e=>e.item);
console.log('TIMELINE',records.map(x=>x.type+':'+(x.status||'')).join(' | '));
assert(records.some(x=>x.type==='user_message'));
assert(records.some(x=>x.type==='assistant_message'&&x.text.trim()===workspace));
const calls=records.filter(x=>x.type==='tool_call'&&x.name==='shell');
assert(calls.length>0,'Tool telemetry missing!');
console.log('CALL_DETAIL', JSON.stringify(calls.map(x=>x.detail)));
assert(calls.some(x=>x.detail.command==='pwd'));
assert(calls.at(-1).status==='completed');
const snapshot=events.filter(e=>e.type==='session.persistence').at(-1)?.persistence?.data?.timeline;
assert(snapshot.some(x=>x.item.type==='tool_call'));
console.log('PROXY_END_TO_END_PASS',sid);
await conn.close();
