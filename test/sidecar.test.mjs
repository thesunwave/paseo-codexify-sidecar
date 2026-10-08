import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const sidecar = new URL('../src/sidecar.mjs', import.meta.url).pathname;

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'paseo-bridge-poc-'));
  const workspace = join(root, 'workspace');
  const state = join(root, 'state');
  mkdirSync(workspace); mkdirSync(state, { mode: 0o700 });
  const socket = join(state, 'controller.sock');
  const child = spawn(process.execPath, [sidecar], {
    env: {
      ...process.env,
      PASEO_BRIDGE_WORKSPACE_ROOT: root,
      PASEO_BRIDGE_SOCKET: socket,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const requests = new Map();
  let serial = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const msg = JSON.parse(line);
    const req = requests.get(msg.id);
    if (req) { requests.delete(msg.id); req(msg); }
  });
  const mcp = (method, params = {}) => {
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MCP timeout: ' + method)), 15000);
      requests.set(id, msg => { clearTimeout(timeout); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const ctrl = data => new Promise((resolve, reject) => {
    const client = createConnection(socket);
    let buffer = '';
    client.setEncoding('utf8');
    client.on('error', reject);
    client.on('connect', () => client.write(JSON.stringify({ id: 'test-' + ++serial, ...data }) + '\n'));
    client.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        client.end();
        const reply = JSON.parse(buffer.split('\n')[0]);
        if (!reply.ok) reject(Object.assign(new Error(reply.error?.message), { code: reply.error?.code }));
        else resolve(reply.result);
      }
    });
  });
  for (let i = 0; i < 100; i++) {
    try {
      await ctrl({ op: 'pool' });
      break;
    } catch {
      if (i === 99) throw new Error('Controller failed to start: ' + stderr);
      await delay(20);
    }
  }
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    rmSync(root, { recursive: true, force: true });
  });
  return { workspace: realpathSync(workspace), root: realpathSync(root), mcp, ctrl, child };
}
function structured(msg) {
  assert.equal(msg.result?.isError, false, JSON.stringify(msg));
  return msg.result.structuredContent;
}

test('stock MCP handshake, explicit worker attach, dispatch, result, second turn, finish', async t => {
  const { workspace, mcp, ctrl } = await fixture(t);
  const hello = await mcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(hello.result.serverInfo.name, 'paseo-codexify-sidecar-poc');
  const tools = (await mcp('tools/list')).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['paseo_backend_attach', 'paseo_backend_exchange']);
  const attached = structured(await mcp('tools/call', { name: 'paseo_backend_attach', arguments: { workspace } }));
  assert.equal(attached.state, 'ready');
  const pool = await ctrl({ op: 'pool', workspace });
  assert.equal(pool.available_capacity, 1);

  const submitted = await ctrl({ op: 'dispatch', workspace, rebind: true, prompt: 'Run git status' });
  assert.equal(submitted.state, 'queued');
  const command = structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange',
    arguments: { session_id: attached.session_id, wait: false },
  }));
  assert.equal(command.command.kind, 'task');
  assert.equal(command.command.content, 'Run git status');
  const ready = await ctrl({ op: 'status', session_id: attached.session_id });
  assert.equal(ready.tasks.at(-1).command_seq, command.command.seq);
  assert.equal(ready.timeline.length, 0, 'No automatic tool telemetry from stock Codexify');

  structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange',
    arguments: {
      session_id: attached.session_id,
      wait: false,
      outbound: { kind: 'result', command_seq: command.command.seq, content: '## main' },
    },
  }));
  const finished = await ctrl({ op: 'wait', session_id: attached.session_id, run_id: submitted.run_id, timeout_ms: 100 });
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.result, '## main');
  assert.equal((await ctrl({ op: 'pool', workspace })).available_capacity, 1);

  const again = await ctrl({ op: 'submit', session_id: attached.session_id, prompt: 'Hello again' });
  const second = structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange', arguments: { session_id: attached.session_id, wait: false },
  }));
  assert.equal(second.command.content, 'Hello again');
  structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange', arguments: {
      session_id: attached.session_id, wait: false,
      outbound: { kind: 'result', command_seq: second.command.seq, content: 'Hi' },
    },
  }));
  assert.equal((await ctrl({ op: 'run', session_id: attached.session_id, run_id: again.run_id })).result, 'Hi');

  await ctrl({ op: 'finish', session_id: attached.session_id });
  const end = structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange', arguments: { session_id: attached.session_id, wait: false },
  }));
  assert.equal(end.assistant_turn_may_end, true);
});

test('controller cancel is delivered only at exchange; running tools are not automatically interrupted', async t => {
  const { workspace, ctrl, mcp } = await fixture(t);
  const attached = structured(await mcp('tools/call', { name: 'paseo_backend_attach', arguments: { workspace } }));
  const run = await ctrl({ op: 'dispatch', workspace, prompt: 'Do long task' });
  const initial = structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange', arguments: { session_id: attached.session_id, wait: false },
  }));
  const receipt = await ctrl({ op: 'cancel', session_id: attached.session_id, run_id: run.run_id, reason: 'Stop now' });
  assert.equal(receipt.accepted, true);
  const stillRunning = await ctrl({ op: 'wait', session_id: attached.session_id, run_id: run.run_id });
  assert.equal(stillRunning.state, 'cancelling');
  const cancel = structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange', arguments: { session_id: attached.session_id, wait: false },
  }));
  assert.equal(cancel.command.kind, 'cancel');
  assert.equal(cancel.command.command_seq, initial.command.seq);
  structured(await mcp('tools/call', {
    name: 'paseo_backend_exchange', arguments: {
      session_id: attached.session_id, wait: false,
      outbound: { kind: 'error', command_seq: initial.command.seq, content: 'Stopped' },
    },
  }));
  assert.equal((await ctrl({ op: 'run', session_id: attached.session_id, run_id: run.run_id })).state, 'cancelled');
});

test('workspace authorization and guessed backend sessions are rejected', async t => {
  const { mcp, ctrl, root } = await fixture(t);
  const denied = await mcp('tools/call', {
    name: 'paseo_backend_attach', arguments: { workspace: '/' },
  });
  assert.equal(denied.result.isError, true);
  const error = await mcp('tools/call', {
    name: 'paseo_backend_exchange', arguments: { session_id: 'guess', wait: false },
  });
  assert.equal(error.result.isError, true);
  await assert.rejects(ctrl({ op: 'dispatch', workspace: root, prompt: 'None attached' }), { code: 'unavailable' });
});

