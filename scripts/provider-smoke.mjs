import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.POC_SANDBOX_DIR;
const providerFile = process.env.POC_PROVIDER_MODULE;
if (!root || !providerFile || !process.env.POC_CODEXIFY_URL) {
  throw new Error('Set POC_SANDBOX_DIR, POC_PROVIDER_MODULE and POC_CODEXIFY_URL');
}
const { createChatGptCodexifyProvider } = await import(pathToFileURL(resolve(providerFile)).href);
const workspace = realpathSync(join(root, 'workspace'));
const mcpSession = readFileSync(join(root, 'mcp-session-id'), 'utf8').trim();
async function call(id, name, args) {
  const response = await fetch(process.env.POC_CODEXIFY_URL, {
    method: 'POST',
    headers: { 'mcp-session-id': mcpSession, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  const entry = JSON.parse(body.split('\n').find(line => line.startsWith('data: {')).slice(6));
  assert.equal(entry.result.isError, false, JSON.stringify(entry));
  return entry.result.structuredContent;
}
const provider = createChatGptCodexifyProvider({ acquireRetryMs: 100 });
const conn = await provider.connect({ versions: [1], capabilities: ['prompt.message', 'prompt.steer', 'session.persistence'] });
const events = [];
conn.onEvent(event => events.push(event));
await conn.send({ type: 'session.open', requestId: 'poc-open', sessionId: 'poc-chat', config: { cwd: workspace, persist: true } });
await conn.send({
  type: 'session.prompt', sessionId: 'poc-chat',
  prompt: { clientMessageId: 'poc-message', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Run pwd and return it' }] } },
});
const worker = readFileSync(join(root, 'worker-id'), 'utf8').trim();
const task = await call(201, 'paseo__paseo_backend_exchange', { session_id: worker, wait: false });
assert.equal(task.command.content, 'Run pwd and return it');
const exec = await call(202, 'exec_command', { cmd: 'pwd' });
assert.equal(exec.exit_code, 0);
await call(203, 'paseo__paseo_backend_exchange', {
  session_id: worker, wait: false, outbound: { kind: 'result', command_seq: task.command.seq, content: exec.output },
});
for (let i = 0; i < 50 && !events.some(event => event.type === 'session.turn' && event.state === 'completed'); i++) {
  await new Promise(resolve => setTimeout(resolve, 100));
}
const answer = events.find(event => event.type === 'timeline.item' && event.item.type === 'assistant_message');
assert.equal(answer?.item?.text?.trim(), workspace);
const stored = events.filter(event => event.type === 'session.persistence').at(-1);
assert.equal(stored?.persistence?.version, 2);
assert.deepEqual(stored.persistence.data.timeline.map(t => t.item.type), ['user_message', 'assistant_message']);
console.log('PASEO_PROVIDER_STOCK_CODEXIFY_SIDECAR_E2E: PASS');
console.log('TYPES: ' + stored.persistence.data.timeline.map(t => t.item.type).join(', '));
await conn.close();

