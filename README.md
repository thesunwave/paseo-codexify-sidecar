# Paseo–Codexify Sidecar

**v0.2.0-alpha.1 · macOS installer · MIT**

Run the [Paseo ChatGPT provider](https://github.com/thesunwave/paseo-chatgpt-provider) against a **stock, unmodified Codexify** instance instead of maintaining a patched Codexify fork.

The sidecar acts as a local MCP HTTP proxy for ChatGPT and as a private Unix socket controller for Paseo:

~~~text
       ChatGPT connector (HTTPS tunnel)
                    |
            MCP proxy :38722
               /          \
   2 backend tools       All native tools
   attach / exchange       forwarded
         |                     |
       sidecar           stock Codexify :3000
         |                     |
 Unix controller         project shell/Git/files
         |
      Paseo provider
~~~

It observes native tool calls, correlates them with the attached model worker, and emits bounded tool previews for Paseo. Native shell sessions are interrupted using Codexify's existing write_stdin API when Paseo cancels a task. **No upstream Codexify modifications required.**

## Verified

- Official Codexify **v1.6.6** and **v1.7.0** on macOS, in isolated instances.
- Native tools exposed alongside sidecar attach/exchange; task dispatch → real exec_command → assistant response → durable Paseo timeline.
- Native Shell cards with start/complete events, command/output and exit status.
- Cancellation of real long-running sleep process via Ctrl-C, not merely HTTP abort.
- Per-caller backend isolation using OpenAI session metadata when supplied, falling back to transport session identity.
- Workspace selection through the stock set_project_root tool, so the current Codexify instance must run in multi-project mode.
- Stale-run recovery after a sidecar restart, preserved session IDs across reattach, and durable Paseo history.
- Six automated unit/integration tests.

**Not yet validated:** connecting a *real* ChatGPT conversation to this new proxy endpoint over an external authenticated HTTPS tunnel, or a completely clean-machine LaunchAgent install. These require interactive user access, not just simulated MCP traffic. Do not present this as production-grade until those tests pass.

## Installation

On a Mac under the **same desktop user that runs Paseo**:

~~~sh
git clone --branch v0.2.0-alpha.1 --depth 1 https://github.com/thesunwave/paseo-codexify-sidecar.git
cd paseo-codexify-sidecar

./install.sh --dry-run
./install.sh
./install.sh --check
~~~

The installer:

- Reuses a responding Codexify server without restarting it, or downloads a SHA-256-verified official **Codexify v1.7.0** binary and starts a **new independent per-user LaunchAgent** on localhost.
- Copies the sidecar to a private per-user state directory, starts a per-user proxy LaunchAgent, and preserves saved session state.
- Installs the pinned Paseo provider **v0.2.0-alpha.1** if the Paseo CLI/daemon is available, without overriding an existing installation.
- Configures the sidecar controller socket for future Paseo processes. The provider also auto-detects the sidecar's default socket.
- Never changes or restarts an existing installed Codexify binary, service, or configuration.

Use the options --check, --dry-run, --uninstall, --skip-provider, --skip-stock, --state-dir, --workspace-root, --upstream and --proxy-port as necessary. --uninstall stops the installer-owned sidecar agent and removes an installer-owned plugin only; it preserves Codexify and state files.

For an already configured Codexify instance, it must expose set_project_root (multiProject=true) and have access to the requested shared workspace root. **The installer will not silently change a running Codexify service's configuration.**

### Complete these interactive steps

1. **HTTPS connector/tunnel.** Expose the proxy's loopback endpoint (by default, http://127.0.0.1:38722/mcp) using your existing **authenticated HTTPS tunnel** and point the ChatGPT connector to that endpoint. Do not expose the unauthenticated loopback server directly to the public Internet. The original Codexify connector URL may require updating or a separate connector.
2. **Paseo.** Enable trusted plugins in Paseo Settings → Plugins. If it was already running when the installer changed the socket environment, restart Paseo when convenient; the v0.2 provider detects the default user-private socket automatically.
3. **ChatGPT.** Open a dedicated conversation with the new connector and ask it to attach to a workspace through paseo_backend_attach. Then keep calling paseo_backend_exchange with wait=true until finish, using ordinary Codexify tools to process tasks and returning an outbound result/error for each task.
4. **Check.** Open that workspace in Paseo and select Attached ChatGPT. Try a read-only command such as git status --short --branch. Check the user message, native Shell card and assistant reply, and then restart/reopen the same Paseo chat to verify history.

The ChatGPT assistant must remain in a long-lived exchange loop; the provider doesn't initiate new ChatGPT turns itself.

## Running without the installer

Set these environment variables and run Node >=20:

~~~sh
PASEO_BRIDGE_MODE=proxy \
PASEO_BRIDGE_PORT=38722 \
PASEO_BRIDGE_UPSTREAM=http://127.0.0.1:3000/mcp \
PASEO_BRIDGE_WORKSPACE_ROOT=/Users/Shared/PaseoWorkspaces \
PASEO_BRIDGE_SOCKET="$HOME/.local/share/paseo-codexify-sidecar/controller.sock" \
node src/sidecar.mjs
~~~

Only localhost is bound for the MCP proxy. The controller socket parent must be owned by the sidecar user and accessible only to that user (0700); its socket is 0600. This works when Codexify uses a *different service user* because communication between proxy and Codexify is over HTTP loopback; the Paseo provider and sidecar should use the same desktop user.

The older stdio-MCP plugin mode from the prototype remains for experimentation, but it cannot observe arbitrary Codexify-native tools and therefore is **not** the recommended integration.

## Security and limitations

- The proxy delegates all ordinary Codexify tool calls to the upstream with the same permissions as the Codexify process. Never install an untrusted Paseo or Codexify plugin.
- The sidecar holds short bounded request/response previews and session identifiers in an owner-private state file. Redaction is best-effort: avoid running commands that print secrets. Tool output itself is not a substitute for audited secret handling.
- A ChatGPT conversation is identified by the hashed openai/session metadata when supplied, or by its MCP transport session. If the transport changes without stable session metadata, reattach is needed; the proxy refuses ambiguous callers.
- The sidecar records *model-visible* tool calls. It doesn't observe internal sub-operations performed by Codexify tools.
- Cancellation actively interrupts tracked exec_command shell sessions by calling Codexify's write_stdin with Ctrl-C. Other types of side effects might already have occurred or continue in the upstream; cancellation cannot undo them.
- The MCP proxy buffers normal tool responses instead of streaming arbitrary event data from native tools. Native tool progress is represented in Paseo's controller polling timeline.
- Saved model workers are marked stale after sidecar restart until the same conversation reattaches. A failed in-flight run does not resume automatically; Paseo's previous user/assistant/tool history still replays independently.
- The controller uses a local private Unix socket. The installer currently supports macOS; runtime source may run on other Unix systems but Linux service packaging and Windows support are not guaranteed.
- Existing authenticated Codexify endpoints are forwarded through with authorization headers; HTTPS tunnel authentication must be configured independently.

## Development

~~~sh
npm test
node --check src/sidecar.mjs
node --check src/proxy.mjs
./install.sh --dry-run
./install.sh --check
~~~

The tests include transport-level tool telemetry, cancellation, caller isolation, and restart recovery. The stock Codexify E2E scripts in scripts/ are for an isolated test instance and must be configured through environment variables; do not point them at production services.

This code is licensed under MIT. The sidecar is intentionally separate from Codexify and Paseo core.

