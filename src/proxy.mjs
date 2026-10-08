import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const host = '127.0.0.1';
const port = Number(process.env.PASEO_BRIDGE_PORT || 38722);
const upstream = process.env.PASEO_BRIDGE_UPSTREAM || 'http://127.0.0.1:3000/mcp';
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PASEO_BRIDGE_PORT must be 1..65535');
const upstreamUrl = new URL(upstream);
if (!['http:', 'https:'].includes(upstreamUrl.protocol))
  throw new Error('PASEO_BRIDGE_UPSTREAM must be an HTTP(S) URL');

const LIMIT = 2 * 1024 * 1024;
const OWN_PREFIX = 'paseo_backend_';
const transportOwners = new Map();
const nativeProcesses = new Map();
const MAX_SHELL_INITIAL_YIELD_MS = 1000;
function recordProcess(caller, result, request, headers) {
  const raw = result?.result?.structuredContent;
  const response = raw?.upstream_result ?? raw;
  if (!caller || !response) return;
  const name = request?.params?.name;
  if (name !== 'exec_command' && name !== 'write_stdin') return;
  const processes = nativeProcesses.get(caller) || new Map();
  const original = request.params.arguments?.session_id;
  if (original != null && typeof response.exit_code === 'number') processes.delete(String(original));
  if (response.session_id != null) processes.set(String(response.session_id), {
    id:response.session_id, headers, meta:request.params._meta || {},
  });
  nativeProcesses.set(caller,processes);
}
async function cancelNative(caller) {
  const processes = nativeProcesses.get(caller);
  if (!processes?.size) return;
  nativeProcesses.delete(caller);
  await Promise.allSettled([...processes.values()].map(async proc => {
    const command = {
      jsonrpc:'2.0',id:'paseo-cancel-'+Date.now(),method:'tools/call',
      params:{name:'write_stdin',arguments:{session_id:proc.id,chars:'\u0003',yield_time_ms:1000},_meta:proc.meta},
    };
    const reply = await fetch(upstreamUrl,{method:'POST',headers:proc.headers,body:JSON.stringify(command),signal:AbortSignal.timeout(5000)});
    const result = decode(await reply.text());
    if (!reply.ok || result?.error || result?.result?.isError) throw new Error('Codexify process interruption failed');
  }));
}

function preview(value, limit = 5000) {
  function clean(x, key = '') {
    if (/password|api.?key|access.?token|authorization|secret|cookie/i.test(key)) return '[REDACTED]';
    if (typeof x === 'string') {
      return x.replace(/(?:sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]{12,}|Bearer\s+\S+)/gi, '[REDACTED]').slice(0, limit);
    }
    if (Array.isArray(x)) return x.slice(0, 35).map(item => clean(item));
    if (x && typeof x === 'object')
      return Object.fromEntries(Object.entries(x).slice(0, 45).map(([k,v]) => [k, clean(v,k)]));
    return x;
  }
  return JSON.stringify(clean(value)).slice(0, limit);
}
function decode(body) {
  if (!body) return null;
  const line = body.split('\n').find(v => v.startsWith('data: {'));
  try { return JSON.parse(line ? line.slice(6) : body); } catch { return null; }
}
function encodeLike(body, event) {
  const originalLine = body.split('\n').find(v => v.startsWith('data: {'));
  if (originalLine) return body.replace(originalLine, 'data: ' + JSON.stringify(event));
  return JSON.stringify(event);
}
function callerOf(request, headers) {
  const transport = headers['mcp-session-id'];
  const metaId = request?.params?._meta?.['openai/session'];
  if (typeof metaId === 'string' && metaId.trim() && metaId.length <= 512) {
    const key = 'openai:' + createHash('sha256').update(metaId).digest('hex');
    if (typeof transport === 'string') {
      const previous = transportOwners.get(transport);
      transportOwners.set(transport, previous && previous !== key ? 'ambiguous' : key);
    }
    return key;
  }
  if (typeof transport !== 'string' || transport.length > 512) return null;
  const recorded = transportOwners.get(transport);
  if (recorded === 'ambiguous') return null;
  return recorded || 'mcp:' + transport;
}
function toolReply(id, output, isError = false) {
  return {
    jsonrpc: '2.0', id, result: {
      content: [{ type:'text', text: isError ? String(output?.message || output) : JSON.stringify(output) }],
      structuredContent: isError ? { message: String(output?.message || output), code: output?.code || 'internal' } : output,
      isError,
    },
  };
}
function patchTools(body, tools) {
  const result = decode(body);
  if (!Array.isArray(result?.result?.tools)) return body;
  for (const tool of tools) {
    if (!result.result.tools.some(x => x.name === tool.name)) result.result.tools.push(tool);
  }
  return encodeLike(body, result);
}

async function bindWorkspace(workspace, original, headers) {
  const request = {
    jsonrpc:'2.0',id:'paseo-workspace-'+Date.now(),method:'tools/call',
    params:{name:'set_project_root',arguments:{path:workspace,createWorktree:false},
      ...(original.params?._meta ? {_meta:original.params._meta} : {})},
  };
  const response = await fetch(upstreamUrl,{method:'POST',headers,body:JSON.stringify(request),signal:AbortSignal.timeout(10000)});
  const payload=decode(await response.text());
  if(!response.ok || payload?.error || payload?.result?.isError || !payload?.result?.structuredContent?.active_root)
    throw new Error('Codexify workspace binding failed: enable multiProject and allow '+workspace);
  if(payload.result.structuredContent.active_root!==workspace)
    throw new Error('Codexify returned different active workspace; refusing to execute against it');
}
export function startProxy(runtime) {
  runtime.setNativeCanceller(cancelNative);
  const http = createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status:'ok', mode:'mcp-proxy' }));
      return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405); res.end(); return;
    }
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > LIMIT) throw new Error('MCP request too large');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const msg = req.method === 'POST' ? JSON.parse(data.toString()) : null;
      const caller = callerOf(msg, req.headers);
      const action = msg?.method === 'tools/call' ? msg?.params?.name : null;
      const forwardedHeaders = {};
      for (const key of ['accept','content-type','mcp-session-id','mcp-protocol-version','authorization']) {
        if (req.headers[key]) forwardedHeaders[key] = req.headers[key];
      }
      if (action && action.startsWith(OWN_PREFIX)) {
        if (!caller) throw new Error('No stable MCP/OpenAI caller identity. Initialize transport session first.');
        const args = msg.params.arguments || {};
        if (action === 'paseo_backend_attach') await bindWorkspace(args.workspace,msg,forwardedHeaders);
        const out = action === 'paseo_backend_attach'
          ? runtime.attach(args, caller)
          : action === 'paseo_backend_exchange'
            ? await runtime.exchangeAuthorized(args, caller)
            : runtime.reject('invalid_argument','Unknown Paseo tool');
        if (args.outbound && action === 'paseo_backend_exchange') nativeProcesses.delete(caller);
        res.writeHead(200, { 'content-type':'application/json' });
        res.end(JSON.stringify(toolReply(msg.id, out)));
        return;
      }

      const activity = action && caller ? runtime.toolStarted(caller, action, msg.params?.arguments, preview) : null;
      const shellInitial = action === 'exec_command' && activity;
      if (shellInitial) activity.abort.deferAbort = true;
      const abort = activity?.abort || new AbortController();
      // A 1s shell yield gives us Codexify's session_id promptly, so a later
      // cancel can interrupt the real OS process through native write_stdin.
      const forwarded = shellInitial ? Buffer.from(JSON.stringify({
        ...msg,params:{...msg.params,arguments:{...msg.params.arguments,
          yield_time_ms:Math.min(Number(msg.params.arguments.yield_time_ms)||MAX_SHELL_INITIAL_YIELD_MS,MAX_SHELL_INITIAL_YIELD_MS)}},
      })) : data;
      let response, body, parsed;
      try {
        response = await fetch(upstreamUrl, { method: req.method, headers: forwardedHeaders, body: req.method === 'POST' ? forwarded : undefined, signal: abort.signal });
        body = await response.text();
        parsed = decode(body);
        if (activity) recordProcess(caller,parsed,msg,forwardedHeaders);
        if (shellInitial && activity.abort.cancelRequested) {
          await cancelNative(caller);
        }
        if (msg?.method === 'tools/list' && response.ok) body = patchTools(body, runtime.tools);
        if (activity) runtime.toolFinished(activity, action, parsed?.result, preview, !response.ok || !!parsed?.error);
      } catch (error) {
        if (activity) runtime.toolFinished(activity, action, null, preview, error);
        if (abort.signal.aborted) {
          res.writeHead(200, { 'content-type':'application/json' });
          res.end(JSON.stringify(toolReply(msg.id, { code:'cancelled',message:'Task cancelled by Paseo' }, true)));
          return;
        }
        throw error;
      }
      if (activity?.abort.cancelRequested) {
        res.writeHead(200, { 'content-type':'application/json' });
        res.end(JSON.stringify(toolReply(msg.id, {code:'cancelled',message:'Task cancelled by Paseo'}, true)));
        return;
      }
      const responseHeaders = {};
      for (const key of ['content-type','mcp-session-id','cache-control']) {
        const value = response.headers.get(key);
        if (value) responseHeaders[key] = value;
      }
      res.writeHead(response.status, responseHeaders);
      res.end(body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(200, { 'content-type':'application/json' });
      res.end(JSON.stringify(toolReply(null, error, true)));
    }
  });
  return new Promise((resolve,reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      process.stderr.write('Paseo MCP proxy listening on ' + host + ':' + port + ', upstream=' + upstream + '\n');
      resolve(http);
    });
  });
}
