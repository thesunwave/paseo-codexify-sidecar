#!/usr/bin/env python3
"""Generate new, per-user launchd services for stock Codexify and the standalone proxy."""
import os
import plistlib
import sys

path, label, binary, address, port, state, kind, *extras = sys.argv[1:]
if kind == 'stock':
    arguments = [binary, '--config', address, '--port', port]
    environment = {}
elif kind == 'bridge':
    if len(extras) != 2:
        raise SystemExit('bridge requires socket and workspace-root')
    socket, workspace = extras
    arguments = [binary, os.path.join(state, 'src', 'sidecar.mjs')]
    environment = {
        'PASEO_BRIDGE_MODE': 'proxy',
        'PASEO_BRIDGE_PORT': port,
        'PASEO_BRIDGE_UPSTREAM': address,
        'PASEO_BRIDGE_SOCKET': socket,
        'PASEO_BRIDGE_WORKSPACE_ROOT': workspace,
    }
else:
    raise SystemExit(f'unknown agent kind: {kind}')

agent = {
    'Label': label,
    'ProgramArguments': arguments,
    'RunAtLoad': True,
    'KeepAlive': True,
    'EnvironmentVariables': environment,
    'StandardOutPath': os.path.join(state, 'log', kind + '.stdout.log'),
    'StandardErrorPath': os.path.join(state, 'log', kind + '.stderr.log'),
}
if os.path.exists(path):
    raise SystemExit('Refusing to overwrite existing LaunchAgent: ' + path)
with open(path, 'wb') as f:
    plistlib.dump(agent, f)
