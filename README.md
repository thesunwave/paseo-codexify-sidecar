# paseo-codexify-sidecar — architectural PoC

A **standalone MCP sidecar** that connects Paseo to a **stock, unmodified Codexify**. It uses two external MCP tools and a controller socket compatible with the existing Paseo ChatGPT provider.

Status: feasibility proof only. **Do not install this instead of the published alpha yet.**

## Verified

Tested on macOS with the official Codexify **v1.6.6** release in an isolated instance (not the installed Codexify service):

1. Codexify launches this Node.js process through its standard mcpServers configuration, with mode=direct.
2. It exposes paseo__paseo_backend_attach and paseo__paseo_backend_exchange alongside its normal exec_command tool.
3. attach returns a temporary worker session for an explicit workspace.
4. The existing Paseo controller protocol dispatches a task through the sidecar socket.
5. exchange delivers the task and accepts the answer. A real Codexify exec_command successfully ran pwd.
6. The unchanged Paseo provider accepted the sidecar as its controller, completed a real turn, and persisted user and assistant timeline messages.

Automated sidecar unit tests also cover a second turn, explicit cancellation delivery, private workspace boundaries, finish, and unknown worker rejection.

## Process layout

~~~text
Paseo provider ----------------- Unix socket ----> sidecar controller
                                                       |
ChatGPT -> stock Codexify -> MCP bridge -> sidecar attach/exchange
                |
                +-- ordinary Codexify exec_command / git / filesystem tools
~~~

The controller and the MCP service are two interfaces of the same sidecar process. Stock Codexify already implements the MCP client/bridge, so it requires no source changes for basic dispatch.

## Running it on an isolated stock Codexify

Requirements: Node.js >= 20, macOS, official Codexify >= 1.6.6 and an existing test workspace. Use **one OS user** for stock Codexify and Paseo while testing. The socket parent and socket are deliberately user-private (0700/0600).

In an isolated Codexify config, register this upstream:

~~~json
{
  "mcpServers": {
    "paseo": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/paseo-codexify-sidecar/src/sidecar.mjs"],
      "mode": "direct",
      "env": {
        "PASEO_BRIDGE_SOCKET": "/absolute/private/path/controller.sock",
        "PASEO_BRIDGE_WORKSPACE_ROOT": "/absolute/path/to/allowed/workspaces"
      }
    }
  }
}
~~~

The sidecar creates the controller socket's parent directory (if missing) and requires it to be owned by the same user with no group/world permissions. It rejects workspace paths outside the configured allowed root, including symlink traversal.

With Codexify running, enable the corresponding Paseo provider socket environment in the **Paseo daemon**, not merely in an unrelated terminal:

~~~sh
CODEXIFY_CHATGPT_BACKEND_SOCKET=/absolute/private/path/controller.sock
~~~

Attach from a ChatGPT conversation using the sidecar's externally bridged MCP tools:

- paseo__paseo_backend_attach with the absolute workspace.
- paseo__paseo_backend_exchange with session_id and wait=true; poll again after idle.
- When a task command arrives, call ordinary Codexify coding tools and send outbound result/error using command_seq.
- Keep the ChatGPT turn active until the sidecar sends finish.

No new tool definitions or runtime changes are necessary inside stock Codexify for the *basic* flow. Starting an **isolated** Codexify instance for testing is recommended; do not restart a production service.

## Tests

~~~sh
npm test
~~~

The stock Codexify verification was performed manually using its HTTP MCP endpoint plus the sidecar controller socket. The existing Paseo provider was also exercised against it: user message -> task -> native exec_command -> assistant message, with persistence v2. These are integration results, **not** evidence of a fresh-machine production installation.

## Gaps before replacing the fork

| Gap | Reason | Required approach |
| --- | --- | --- |
| Stable worker identity | Stock Codexify's upstream MCP bridge does not forward the ChatGPT conversation identity; attach takes an explicit workspace and returns a bearer-like random session ID instead | Minimal generic stable-caller identity hook, or rework of caller authorization |
| Automatic live tool timeline | External MCP server cannot observe arbitrary native Codexify tool starts, output previews and completions; controller timeline stays empty | General tool lifecycle event stream/hook, ideally redacted and bounded |
| Timely cancel/steer during native tools | Commands are queued for the next exchange. A running exec_command does not automatically receive them, unlike the fork's injected control handling | Generic per-conversation control/cancellation hook |
| Cross-user service | Sidecar socket is private to the Codexify user; Paseo under another macOS UID cannot connect | Explicitly authenticated, owner-safe IPC with identity/permission design |
| Crash/restart durability | Sidecar session pool lives in memory; restarting the Codexify process loses attached workers | Durable sidecar worker state or explicit reattach. Paseo provider already replays its own history |
| Workspace rebinding | Workers are explicitly bound to a single canonical workspace, not dynamically rebound as in the fork | A safe workspace-selection API or explicit worker-per-workspace strategy |
| Automation/security | Unsandboxed MCP upstream runs with Codexify user's authority | Explicit installation/approval, access control, audit, and threat model |

The minimal upstream proposal is **not** a Paseo-specific feature or a dynamic Rust plugin API: expose a stable caller identity and a bounded tool-lifecycle/cancel hook to trusted MCP extensions. This allows keeping orchestration outside Codexify and avoids tracking a full fork.

## What was not changed

- No Codexify source code was edited.
- No existing Codexify LaunchDaemon, binary or user config was modified.
- No Paseo provider source was modified.
- This is a local prototype with tests; do not confuse it with the public provider alpha.


