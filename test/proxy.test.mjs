import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function listen(server,port=0) {
  await new Promise((resolve,reject) => server.listen(port,'127.0.0.1',resolve).once('error',reject));
  return server.address().port;
}
async function port() {
  const s=createServer();
  const p=await listen(s);
  await new Promise(r=>s.close(r));
  return p;
}
async function createFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'sidecar-proxy-'));
  const sockets=join(dir,'sockets'),workspace=join(dir,'workspace');
  mkdirSync(sockets,{mode:0o700});mkdirSync(workspace);
  const workspaceReal=realpathSync(workspace);
  const socket=join(sockets,'controller.sock');
  let nativeRequests=0;
  const stock=createServer(async (req,res)=>{
    let data='';
    for await (const part of req) data+=part;
    const m=JSON.parse(data);
    const reply=(result)=>{res.writeHead(200,{'content-type':'text/event-stream','mcp-session-id':'stock-transport','cache-control':'no-cache'});res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n\n');};
    if(m.method==='initialize')reply({protocolVersion:'2025-03-26',serverInfo:{name:'stock-codexify',version:'1'},capabilities:{tools:{}}});
    else if(m.method==='tools/list')reply({tools:[{name:'exec_command',description:'Execute shell',inputSchema:{type:'object',properties:{cmd:{type:'string'}},required:['cmd']}}]});
    else if(m.method==='tools/call'){
      if(m.params.name==='exec_command') nativeRequests++;
      if(m.params.name==='set_project_root') {
        return reply({structuredContent:{active_root:m.params.arguments.path},isError:false,content:[]});
      }
      if(m.params.name==='exec_command' && m.params.arguments?.cmd==='slow') await sleep(5000);
      const out={output:'done',exit_code:0};
      reply({content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out,isError:false});
    } else reply({});
  });
  const upstreamPort=await listen(stock);
  t.after(()=>new Promise(r=>stock.close(r)));
  const proxyPort=await port();
  const child=spawn(process.execPath,[new URL('../src/sidecar.mjs',import.meta.url).pathname],{
    env:{...process.env,PASEO_BRIDGE_MODE:'proxy',PASEO_BRIDGE_PORT:String(proxyPort),PASEO_BRIDGE_UPSTREAM:'http://127.0.0.1:'+upstreamPort+'/mcp',PASEO_BRIDGE_SOCKET:socket,PASEO_BRIDGE_WORKSPACE_ROOT:workspaceReal},
    stdio:['ignore','ignore','pipe'],
  });
  let stderr='';
  child.stderr.on('data',b=>stderr+=b.toString());
  t.after(async ()=>{
    child.kill('SIGTERM');
    await Promise.race([new Promise(r=>child.once('exit',r)),sleep(1000)]);
    rmSync(dir,{recursive:true,force:true});
  });
  let currentSession;
  let id=0;
  async function mcp(method,params={},meta=null){
    const headers={'content-type':'application/json','accept':'application/json,text/event-stream'};
    if(currentSession) headers['mcp-session-id']=currentSession;
    const result=await fetch('http://127.0.0.1:'+proxyPort+'/mcp',{
      method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,...(meta?{_meta:{'openai/session':meta}}:{})}}),
    });
    if(result.headers.get('mcp-session-id'))currentSession=result.headers.get('mcp-session-id');
    const text=await result.text();
    const entry=text.split('\n').find(x=>x.startsWith('data: {'));
    return JSON.parse(entry?entry.slice(6):text);
  }
  async function ctrl(req) {
    return new Promise((resolve,reject)=>{
      const conn=createConnection(socket);let buf='';
      conn.setEncoding('utf8');
      conn.on('error',reject);
      conn.on('connect',()=>conn.write(JSON.stringify({...req,id:'ctrl-'+(++id)})+'\n'));
      conn.on('data',part=>{
        buf+=part;
        if(buf.includes('\n')){conn.end();const msg=JSON.parse(buf.split('\n')[0]);msg.ok?resolve(msg.result):reject(Object.assign(new Error(msg.error?.message),{code:msg.error?.code}));}
      });
    });
  }
  for(let i=0;i<100;i++){
    try {await ctrl({op:'pool'});break;}catch(err){if(i===99)throw new Error('Proxy start failed '+stderr);await sleep(20);}
  }
  return {mcp,ctrl,workspace:workspaceReal,get nativeRequests(){return nativeRequests;}};
}

test('proxy injects tools, ties native telemetry to a model caller and forwards results',async t=>{
  const f=await createFixture(t);
  const init=await f.mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal(init.result.serverInfo.name,'stock-codexify');
  const names=(await f.mcp('tools/list')).result.tools.map(x=>x.name);
  assert(names.includes('exec_command'));
  assert(names.includes('paseo_backend_attach'));
  const attached=(await f.mcp('tools/call',{name:'paseo_backend_attach',arguments:{workspace:f.workspace}},'chat-a')).result.structuredContent;
  const run=await f.ctrl({op:'dispatch',workspace:f.workspace,prompt:'do it'});
  const cmd=(await f.mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:attached.session_id,wait:false}},'chat-a')).result.structuredContent;
  assert.equal(cmd.command.kind,'task');
  const tool=await f.mcp('tools/call',{name:'exec_command',arguments:{cmd:'pwd'}},'chat-a');
  assert.equal(tool.result.structuredContent.exit_code,0);
  assert.equal(f.nativeRequests,1);
  const timeline=(await f.ctrl({op:'status',session_id:attached.session_id})).timeline;
  assert.equal(timeline.length,2);
  assert.equal(timeline[0].kind,'tool_started');
  assert.equal(timeline[1].tool_status,'succeeded');
  assert.equal(JSON.parse(timeline[0].request_preview).cmd,'pwd');
  await f.mcp('tools/call',{name:'paseo_backend_exchange',arguments:{
    session_id:attached.session_id,wait:false,outbound:{kind:'result',command_seq:cmd.command.seq,content:'done'},
  }},'chat-a');
  assert.equal((await f.ctrl({op:'run',session_id:attached.session_id,run_id:run.run_id})).state,'succeeded');

  const denied=await f.mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:attached.session_id,wait:false}},'chat-b');
  assert.equal(denied.result.isError,true,'other ChatGPT conversations must not exchange');
});

test('proxy terminates the downstream native call on cancel and records cancellation',async t=>{
  const f=await createFixture(t);
  await f.mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const sid=(await f.mcp('tools/call',{name:'paseo_backend_attach',arguments:{workspace:f.workspace}})).result.structuredContent.session_id;
  const run=await f.ctrl({op:'dispatch',workspace:f.workspace,prompt:'slow'});
  const command=(await f.mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:sid,wait:false}})).result.structuredContent.command;
  const pending=f.mcp('tools/call',{name:'exec_command',arguments:{cmd:'slow'}});
  for(let i=0;i<50 && f.nativeRequests===0;i++)await sleep(20);
  assert.equal(f.nativeRequests,1);
  await f.ctrl({op:'cancel',session_id:sid,run_id:run.run_id,reason:'stop'});
  const native=await pending;
  assert.equal(native.result.isError,true);
  const timeline=(await f.ctrl({op:'status',session_id:sid})).timeline;
  assert.equal(timeline.at(-1).tool_status,'cancelled');
  const canceled=(await f.mcp('tools/call',{name:'paseo_backend_exchange',arguments:{session_id:sid,wait:false}})).result.structuredContent;
  assert.equal(canceled.command.kind,'cancel');
  await f.mcp('tools/call',{name:'paseo_backend_exchange',arguments:{
    session_id:sid,wait:false,outbound:{kind:'error',command_seq:command.seq,content:'stopped'},
  }});
  assert.equal((await f.ctrl({op:'run',session_id:sid,run_id:run.run_id})).state,'cancelled');
});
