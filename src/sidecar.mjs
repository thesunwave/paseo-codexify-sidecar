import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';

const socketPath = process.env.PASEO_BRIDGE_SOCKET ||
  join(homedir(), '.local/share/paseo-codexify-bridge/controller.sock');
const permittedRoot = realpathSync(process.env.PASEO_BRIDGE_WORKSPACE_ROOT || homedir());
const workers = new Map();
const runs = new Map();

class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function reject(code, message) { throw new BridgeError(code, message); }
function workspaceOf(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) reject('invalid_argument', 'Absolute workspace is required');
  let resolved;
  try { resolved = realpathSync(path); }
  catch { reject('invalid_argument', 'Workspace must exist and be accessible'); }
  if (resolved !== permittedRoot && !resolved.startsWith(permittedRoot + sep))
    reject('permission_denied', 'Workspace outside PASEO_BRIDGE_WORKSPACE_ROOT');
  return resolved;
}
function now() { return Date.now(); }
function isAvailable(worker) {
  return worker.live && !worker.draining && worker.activeRun === null;
}
function inspect(worker) {
  return {
    session_id: worker.id, state: worker.live ? (worker.draining ? 'draining' : 'ready') : 'stale',
    live: worker.live, accepting_tasks: isAvailable(worker),
    workspace: { active_root: worker.workspace },
    active_run_id: worker.activeRun, pending_commands: worker.commands.length,
    completed_tasks: worker.completed, failed_tasks: worker.failed,
    last_activity_at_ms: worker.lastActivity,
  };
}
function getWorker(id) {
  const worker = workers.get(id);
  if (!worker) reject('not_found', 'Unknown backend session');
  return worker;
}
function getRun(worker, id) {
  const run = runs.get(id);
  if (!run || run.session_id !== worker.id) reject('not_found', 'Unknown backend run');
  return run;
}
function takeCommand(worker) {
  const command = worker.commands.shift();
  if (command && command.kind === 'task') {
    const run = getRun(worker, command.run_id);
    run.state = 'running';
    run.started_at_ms = now();
  }
  if (command) worker.lastActivity = now();
  return command;
}
function notify(worker) {
  const waiter = worker.waiters.shift();
  if (waiter) waiter();
}
function enqueue(worker, command) {
  worker.commands.push(command);
  notify(worker);
}
async function nextCommand(worker, wait) {
  let command = takeCommand(worker);
  if (command || !wait) return command;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      const i = worker.waiters.indexOf(wake);
      if (i >= 0) worker.waiters.splice(i, 1);
      resolve();
    }, 10000);
    function wake() { clearTimeout(timer); resolve(); }
    worker.waiters.push(wake);
  });
  return takeCommand(worker);
}
function startRun(worker, prompt) {
  if (!isAvailable(worker)) reject('busy', 'Worker is occupied or draining');
  if (typeof prompt !== 'string' || !prompt.trim()) reject('invalid_argument', 'Nonempty prompt required');
  const run = {
    session_id: worker.id, run_id: randomUUID(), state: 'queued',
    queued_at_ms: now(), command_seq: ++worker.seq,
  };
  worker.activeRun = run.run_id;
  worker.tasks.push({ command_seq: run.command_seq });
  runs.set(run.run_id, run);
  enqueue(worker, { kind: 'task', seq: run.command_seq, content: prompt, run_id: run.run_id, workspace: worker.workspace });
  return run;
}
async function exchange(args) {
  const worker = getWorker(args.session_id);
  if (!worker.live) reject('unavailable', 'Worker session is finished');
  if (args.outbound) {
    const outbound = args.outbound;
    const run = worker.activeRun && getRun(worker, worker.activeRun);
    if (!run || outbound.command_seq !== run.command_seq)
      reject('invalid_argument', 'Outbound references no active task');
    if (!['result', 'error'].includes(outbound.kind)) reject('invalid_argument', 'Invalid outbound kind');
    const cancelled = run.state === 'cancelling';
    run.state = outbound.kind === 'result' ? 'succeeded' : (cancelled ? 'cancelled' : 'failed');
    run.completed_at_ms = now();
    run[outbound.kind === 'result' ? 'result' : 'error'] = String(outbound.content ?? '');
    if (run.state === 'succeeded') worker.completed++; else worker.failed++;
    worker.activeRun = null;
  }
  const command = await nextCommand(worker, args.wait !== false);
  if (command?.kind === 'finish') {
    worker.live = false;
    worker.draining = true;
    return { session_id: worker.id, state: 'finished', assistant_turn_may_end: true };
  }
  return command
    ? { session_id: worker.id, state: 'command', command, assistant_turn_may_end: false }
    : { session_id: worker.id, state: 'idle', assistant_turn_may_end: false };
}
function attach(args) {
  const workspace = workspaceOf(args.workspace);
  const worker = {
    id: randomUUID(), workspace, seq: 0, commands: [], waiters: [], tasks: [],
    activeRun: null, live: true, draining: false, lastActivity: now(), completed: 0, failed: 0,
  };
  workers.set(worker.id, worker);
  return {
    session_id: worker.id, state: 'ready', workspace,
    assistant_turn_may_end: false, required_next_action: 'exchange',
    warning: 'PoC: no stable ChatGPT conversation identity forwarded by stock Codexify',
  };
}
function runView(run) {
  const { command_seq, ...publicFields } = run;
  return publicFields;
}
function controller(request) {
  const { op, session_id: sessionId } = request;
  if (op === 'sessions') return [...workers.values()].map(inspect);
  if (op === 'pool') {
    const scoped = [...workers.values()].filter(w => !request.workspace || w.workspace === request.workspace);
    return {
      workspace: request.workspace || null, total_sessions: scoped.length,
      available_capacity: scoped.filter(isAvailable).length,
      busy_sessions: scoped.filter(w => w.live && !isAvailable(w)).length,
      draining_sessions: scoped.filter(w => w.draining).length,
      unavailable_sessions: scoped.filter(w => !w.live).length,
    };
  }
  if (op === 'dispatch') {
    const workspace = workspaceOf(request.workspace);
    const worker = [...workers.values()].find(w => w.workspace === workspace && isAvailable(w));
    if (!worker) reject('unavailable', 'No attached backend for this workspace');
    return runView(startRun(worker, request.prompt));
  }
  if (op === 'acquire') {
    const worker = [...workers.values()].find(w =>
      (!request.workspace || w.workspace === request.workspace) && isAvailable(w));
    if (!worker) reject('unavailable', 'No available worker');
    return inspect(worker);
  }
  const worker = getWorker(sessionId);
  if (op === 'status') return { session: inspect(worker), tasks: worker.tasks, timeline: [] };
  if (op === 'submit') return runView(startRun(worker, request.prompt));
  if (op === 'run' || op === 'wait') return runView(getRun(worker, request.run_id));
  if (op === 'steer' || op === 'cancel') {
    const run = getRun(worker, request.run_id);
    if (!['running', 'queued', 'cancelling'].includes(run.state))
      reject('invalid_argument', 'Run already terminal');
    if (op === 'cancel') run.state = 'cancelling';
    enqueue(worker, {
      kind: op, seq: ++worker.seq, command_seq: run.command_seq,
      content: op === 'cancel' ? (request.reason || 'Cancelled') : request.instruction,
    });
    return { accepted: true, session_id: worker.id, run_id: run.run_id, action: op };
  }
  if (op === 'drain') {
    worker.draining = true;
    return { accepted: true, session_id: worker.id, action: op };
  }
  if (op === 'abandon') {
    worker.live = false;
    worker.draining = true;
    if (worker.activeRun) {
      const run = getRun(worker, worker.activeRun);
      run.state = 'stale';
      run.error = request.reason || 'Worker abandoned';
    }
    return { accepted: true, session_id: worker.id, action: op };
  }
  if (op === 'finish') {
    if (worker.activeRun) reject('busy', 'Cannot finish an active task');
    worker.draining = true;
    enqueue(worker, { kind: 'finish', seq: ++worker.seq });
    return { accepted: true, session_id: worker.id, action: op };
  }
  reject('invalid_argument', 'Unknown controller operation');
}
function socketConnection(connection) {
  let buffer = '';
  connection.setEncoding('utf8');
  connection.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { connection.destroy(); return; }
    const i = buffer.indexOf('\n');
    if (i === -1) return;
    const line = buffer.slice(0, i);
    buffer = '';
    let id;
    try {
      const request = JSON.parse(line);
      id = request.id;
      const result = controller(request);
      connection.end(JSON.stringify({ id, ok: true, result }) + '\n');
    } catch (e) {
      connection.end(JSON.stringify({
        id, ok: false, error: { code: e.code || 'internal', message: e.message },
      }) + '\n');
    }
  });
}
function startController() {
  const directory = dirname(socketPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error('Controller parent must be a non-symlink, owner-private directory');
  const server = createServer(socketConnection);
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  function cleanup() {
    server.close();
    try { unlinkSync(socketPath); } catch {}
  }
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
}
const tools = [
  {
    name: 'paseo_backend_attach',
    description: 'Attach this ChatGPT turn as a temporary Paseo coding worker. Supply the absolute workspace. Then call paseo_backend_exchange repeatedly until finish.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' } }, required: ['workspace'], additionalProperties: false },
  },
  {
    name: 'paseo_backend_exchange',
    description: 'Long-lived nonterminal exchange: receive Paseo tasks, run them via ordinary Codexify tools, then send a result or error. Never end the ChatGPT turn before finish.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['session_id'],
      properties: {
        session_id: { type: 'string' }, wait: { type: 'boolean' },
        outbound: {
          type: 'object', required: ['kind', 'command_seq', 'content'], additionalProperties: false,
          properties: { kind: { type: 'string', enum: ['result', 'error'] }, command_seq: { type: 'integer' }, content: { type: 'string' } },
        },
      },
    },
  },
];
function mcpResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function mcpError(id, e) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id, error: { code: -32000, message: e.message },
  }) + '\n');
}
async function mcpMessage(message) {
  if (message.id === undefined) return; // Notifications require no response.
  try {
    let result;
    switch (message.method) {
      case 'initialize':
        result = {
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          serverInfo: { name: 'paseo-codexify-sidecar-poc', version: '0.0.1' },
          capabilities: { tools: { listChanged: false } },
        };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools }; break;
      case 'tools/call': {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        let output;
        if (name === 'paseo_backend_attach') output = attach(args);
        else if (name === 'paseo_backend_exchange') output = await exchange(args);
        else reject('invalid_argument', 'Unknown MCP tool');
        result = { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output, isError: false };
        break;
      }
      default: reject('invalid_argument', 'Unknown MCP method');
    }
    mcpResponse(message.id, result);
  } catch (e) {
    if (message.method === 'tools/call') {
      mcpResponse(message.id, {
        content: [{ type: 'text', text: e.message }],
        structuredContent: { code: e.code || 'internal', message: e.message },
        isError: true,
      });
    } else mcpError(message.id, e);
  }
}
startController();
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdinBuffer += chunk;
  if (stdinBuffer.length > 1024 * 1024) process.exit(1);
  for (;;) {
    const i = stdinBuffer.indexOf('\n');
    if (i < 0) break;
    const line = stdinBuffer.slice(0, i);
    stdinBuffer = stdinBuffer.slice(i + 1);
    if (!line.trim()) continue;
    try { void mcpMessage(JSON.parse(line)); }
    catch (e) { process.stderr.write('Malformed MCP JSON: ' + e.message + '\n'); }
  }
});

