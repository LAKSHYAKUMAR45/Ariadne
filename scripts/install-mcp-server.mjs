#!/usr/bin/env node
// One-command build + global install for the Ariadne MCP server.
//
//   pnpm run install:mcp
//
// Builds @ariadne-dev/core and @ariadne-dev/mcp-server, `npm link`s it so the
// `ariadne-mcp-server` binary is available globally, then prints the config
// snippet to paste into any MCP-capable client (Copilot, Claude, etc.).
import { log, ok, run, tryCapture, warn, ensureReady, repoRoot } from './_lib.mjs';
import path from 'node:path';

ensureReady();

log('Building @ariadne-dev/core and @ariadne-dev/mcp-server');
run('pnpm --filter @ariadne-dev/core --filter @ariadne-dev/mcp-server run build');

log('Linking ariadne-mcp-server globally (npm link)');
run('npm link', path.join(repoRoot, 'packages/mcp-server'));

const bin = tryCapture('command -v ariadne-mcp-server || which ariadne-mcp-server');
ok(`ariadne-mcp-server installed${bin ? ` -> ${bin}` : ''}`);

if (bin) {
  console.log(`
Add this to your MCP client's server config (e.g. .vscode/mcp.json,
claude_desktop_config.json, or your Copilot MCP settings):

  {
    "servers": {
      "ariadne": {
        "command": "${bin}",
        "args": []
      }
    }
  }
`);
} else {
  warn('Could not resolve the linked binary path — run `which ariadne-mcp-server` to find it.');
}
