import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,mkdirSync,rmSync,readFileSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

test('restart marks in-flight task stale and reattaches same transport worker id safely',async t=>{
  const root=mkdtempSync(join(tmpdir(),'sidecar-restart-'));
  const sockDir=join(root,'socket'),workspace=join(root,'workspace');
  mkdirSync(sockDir,{mode:0o700});mkdirSync(workspace);
  const socket=join(sockDir,'controller.sock');
  const state=join(sockDir,'state.json');
  const holder=createServer();
  await new Promise(resolve=>holder.listen(0,'127.0.0.1',resolve));
  const port=holder.address().port;
  await new Promise(resolve=>holder.close(resolve));
  const stock=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const message=JSON.parse(raw);
    const result={content:[],isError:false,structuredContent:{active_root:message.params?.arguments?.path}};
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  await new Promise(resolve=>stock.listen(0,'127.0.0.1',resolve));
  t.after(()=>stock.close());
  const stockUrl='http://127.0.0.1:'+stock.address().port+'/mcp';
  const env={...process.env,PASEO_BRIDGE_MODE:'proxy',
    PASEO_BRIDGE_SOCKET:socket,PASEO_BRIDGE_WORKSPACE_ROOT:workspace,PASEO_BRIDGE_PORT:String(port),
    PASEO_BRIDGE_UPSTREAM:stockUrl};
  let child;
  async function boot(){
    child=spawn(process.execPath,[new URL('../src/sidecar.mjs',import.meta.url).pathname],{env,stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',b=>stderr+=b);
    for(let i=0;i<100;i++){
      try {await ctrl({op:'pool'});return;}catch(e){if(i===99)throw new Error('Sidecar did not start: '+stderr);await sleep(20);}
    }
  }
  async function shutdown(){
    if(!child || child.exitCode!==null)return;
    const done=new Promise(resolve=>child.once('exit',resolve));
    child.kill('SIGTERM');
    await Promise.race([done,sleep(1000)]);
  }
  t.after(async()=>{await shutdown();rmSync(root,{recursive:true,force:true});});
  async function ctrl(req){
    return new Promise((resolve,reject)=>{
      const conn=createConnection(socket);let buffer='';
      conn.setEncoding('utf8');conn.on('error',reject);
      conn.on('connect',()=>conn.write(JSON.stringify({...req,id:'q'})+'\n'));
      conn.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){conn.end();const result=JSON.parse(buffer.split('\n')[0]);result.ok?resolve(result.result):reject(new Error(result.error.message));}});
    });
  }
  async function attach(){
    const res=await fetch('http://127.0.0.1:'+port+'/mcp',{method:'POST',headers:{
      'content-type':'application/json','mcp-session-id':'stable-session'},
    body:JSON.stringify({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'paseo_backend_attach',arguments:{workspace:realpathSync(workspace)}}})});
    return (await res.json()).result.structuredContent;
  }
  await boot();
  const id=(await attach()).session_id;
  const run=await ctrl({op:'dispatch',workspace:realpathSync(workspace),prompt:'uncompleted'});
  assert.equal(run.state,'queued');
  await shutdown();
  const disk=JSON.parse(readFileSync(state,'utf8'));
  assert.equal(disk.workers.length,1);
  assert.equal(disk.runs.length,1);
  await boot();
  const inspected=await ctrl({op:'status',session_id:id});
  assert.equal(inspected.session.live,false);
  assert.equal((await ctrl({op:'run',session_id:id,run_id:run.run_id})).state,'stale');
  const returned=(await attach()).session_id;
  assert.equal(returned,id,'caller identity and session id survive restart');
  const again=await ctrl({op:'dispatch',workspace:realpathSync(workspace),prompt:'new task'});
  assert.equal(again.state,'queued');
});
