#!/usr/bin/env node
// One-command build + package + install for the Ariadne VS Code extension.
//
//   pnpm run install:vscode
//
// Detects the current OS/arch, builds the matching multi-ABI .vsix (works in
// both desktop/Electron VS Code and VS Code Server/Remote-SSH), and installs
// it via the `code` CLI. Falls back to `code-insiders` if `code` isn't on PATH.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { log, ok, warn, fail, run, tryCapture, repoRoot } from './_lib.mjs';

const SUPPORTED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

function detectTarget() {
  const platform = os.platform(); // 'linux' | 'darwin' | 'win32'
  const arch = os.arch(); // 'x64' | 'arm64'
  const target = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.includes(target)) {
    fail(
      `No prebuilt package target for ${target}. Supported: ${SUPPORTED_TARGETS.join(', ')}.\n` +
        `Run "pnpm --filter ariadne-vscode run package:<target>" manually for the closest match.`
    );
  }
  return target;
}

function findCodeBin() {
  for (const bin of ['code', 'code-insiders']) {
    if (tryCapture(`command -v ${bin}`)) return bin;
  }
  return null;
}

const extDir = path.join(repoRoot, 'packages/vscode-extension');
const target = detectTarget();

log(`Building @ariadne-dev/core and the extension bundle`);
run('pnpm --filter @ariadne-dev/core run build');

log(`Packaging the extension for ${target} (dual desktop + server ABI support)`);
run(`pnpm --filter ariadne-vscode run package:${target}`);

const vsixPath = path.join(extDir, 'dist-vsix', `ariadne-${target}.vsix`);
if (!fs.existsSync(vsixPath)) {
  fail(`Expected package at ${vsixPath} but it wasn't produced.`);
}
ok(`Packaged ${vsixPath}`);

const codeBin = findCodeBin();
if (!codeBin) {
  warn(
    `No "code" or "code-insiders" CLI found on PATH. Install it manually:\n` +
      `  ${codeBin ?? 'code'} --install-extension ${vsixPath} --force`
  );
  process.exit(0);
}

log(`Installing via ${codeBin}`);
run(`${codeBin} --install-extension "${vsixPath}" --force`);
ok('Extension installed.');
console.log(
  '\nIf VS Code (or a Remote-SSH/Server window) was already open, run\n' +
    '"Developer: Reload Window" from the Command Palette to pick it up —\n' +
    'reinstalling a .vsix does not restart an already-running extension host.'
);
