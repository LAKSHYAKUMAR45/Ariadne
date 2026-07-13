#!/usr/bin/env node
// One-command build + install for all three Ariadne surfaces: CLI, MCP
// server, and VS Code extension.
//
//   pnpm run install:all
import { log } from './_lib.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const scripts = ['install-cli.mjs', 'install-mcp-server.mjs', 'install-vscode-extension.mjs'];

for (const script of scripts) {
  log(`Running ${script}`);
  execFileSync('node', [path.join(dir, script)], { stdio: 'inherit' });
}

log('All surfaces installed: ariadne (CLI), ariadne-mcp-server, and the VS Code extension.');
