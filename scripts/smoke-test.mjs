#!/usr/bin/env node
// Sanity-checks the *installed* CLI, MCP server, and VS Code extension —
// not unit tests, but "did the one-command install actually work?".
//
//   pnpm run verify:install
//
// Run this after install:cli / install:mcp / install:vscode (or install:all)
// to confirm each binary/extension is really usable, end to end.
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, ok, warn } from './_lib.mjs';

let failures = 0;

function section(title) {
  log(title);
}

function reportFail(msg) {
  console.error(`\x1b[31m✘ ${msg}\x1b[0m`);
  failures += 1;
}

// --- CLI ---------------------------------------------------------------
section('CLI: ariadne task new / status in a scratch workspace');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-smoke-'));
try {
  const version = execSync('ariadne --version', { cwd: tmpDir }).toString().trim();
  ok(`ariadne --version -> ${version}`);

  execSync('ariadne task new "Smoke test task"', { cwd: tmpDir, stdio: 'pipe' });
  const status = execSync('ariadne status', { cwd: tmpDir }).toString();
  if (status.includes('Smoke test task')) {
    ok('ariadne task new + status round-trip works');
  } else {
    reportFail(`ariadne status did not show the new task. Output:\n${status}`);
  }
} catch (err) {
  reportFail(`CLI smoke test failed: ${err.message}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- MCP server ----------------------------------------------------------
section('MCP server: initialize handshake over stdio');
await new Promise((resolve) => {
  const mcpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-mcp-smoke-'));
  const child = spawn('ariadne-mcp-server', [], { cwd: mcpTmpDir, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let settled = false;

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    reportFail('ariadne-mcp-server did not respond to initialize within 5s');
    child.kill();
    fs.rmSync(mcpTmpDir, { recursive: true, force: true });
    resolve();
  }, 5000);

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n').filter(Boolean);
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 1 && !settled) {
        settled = true;
        clearTimeout(timeout);
        if (msg.result?.serverInfo?.name) {
          ok(`ariadne-mcp-server responded: ${msg.result.serverInfo.name} v${msg.result.serverInfo.version}`);
        } else {
          reportFail(`Unexpected initialize response: ${line}`);
        }
        child.kill();
        fs.rmSync(mcpTmpDir, { recursive: true, force: true });
        resolve();
      }
    }
  });

  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reportFail(`Could not spawn ariadne-mcp-server: ${err.message}`);
    fs.rmSync(mcpTmpDir, { recursive: true, force: true });
    resolve();
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ariadne-smoke-test', version: '0.0.0' },
      },
    }) + '\n'
  );
});

// --- VS Code extension -----------------------------------------------------
section('VS Code extension: installed and listed by the code CLI');
let codeBin = null;
for (const bin of ['code', 'code-insiders']) {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    codeBin = bin;
    break;
  } catch {
    // try next
  }
}
if (!codeBin) {
  warn('No "code"/"code-insiders" CLI found — skipping extension check (not a failure).');
} else {
  const extensions = execSync(`${codeBin} --list-extensions`).toString();
  if (extensions.includes('ariadne-dev.ariadne-vscode')) {
    ok('ariadne-dev.ariadne-vscode is installed');
  } else {
    reportFail('ariadne-dev.ariadne-vscode is NOT in `code --list-extensions` output — run `pnpm run install:vscode`.');
  }
}

console.log('');
if (failures > 0) {
  console.error(`\x1b[31m${failures} smoke check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mAll smoke checks passed — CLI, MCP server, and VS Code extension are installed and working.\x1b[0m');
