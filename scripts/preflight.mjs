#!/usr/bin/env node
// Checks that a machine has what the install:* scripts need before running
// them — useful on a fresh server that's never had this repo's toolchain.
//
//   pnpm run preflight
//
// Node/npm/git are hard requirements (the script exits non-zero if missing).
// pnpm is auto-installed via corepack if Node has corepack. A C/C++ build
// toolchain (make/python3/a C++ compiler) is only needed as a *fallback* —
// better-sqlite3 ships prebuilt binaries for common platforms/Node
// versions and only compiles from source when no prebuild matches — so
// it's reported as a warning, not a hard failure.
import os from 'node:os';
import { log, ok, warn, run, tryCapture } from './_lib.mjs';

let hardFailure = false;

function requireVersion(name, cmd, versionRegex, minMajor) {
  const out = tryCapture(cmd);
  if (!out) {
    console.error(`\x1b[31m✘ ${name} not found on PATH. Install it and re-run this script.\x1b[0m`);
    hardFailure = true;
    return null;
  }
  const match = out.match(versionRegex);
  const major = match ? parseInt(match[1], 10) : null;
  if (minMajor && major !== null && major < minMajor) {
    console.error(`\x1b[31m✘ ${name} ${out} found, but >= ${minMajor} is required.\x1b[0m`);
    hardFailure = true;
    return out;
  }
  ok(`${name} ${out}`);
  return out;
}

log('Checking Node.js');
requireVersion('Node.js', 'node -v', /v(\d+)\./, 20);

log('Checking npm');
requireVersion('npm', 'npm -v', /(\d+)\./);

log('Checking git');
requireVersion('git', 'git --version', /(\d+)\./);

log('Checking pnpm');
let pnpmVersion = tryCapture('pnpm -v');
if (!pnpmVersion) {
  warn('pnpm not found — attempting to enable it via corepack');
  const corepack = tryCapture('corepack --version');
  if (corepack) {
    try {
      run('corepack enable');
      run('corepack prepare pnpm@10.34.4 --activate');
      pnpmVersion = tryCapture('pnpm -v');
    } catch {
      // fall through to the failure branch below
    }
  }
  if (!pnpmVersion) {
    console.error(
      '\x1b[31m✘ pnpm not found and corepack could not install it. Install pnpm manually: https://pnpm.io/installation\x1b[0m'
    );
    hardFailure = true;
  } else {
    ok(`pnpm ${pnpmVersion} (enabled via corepack)`);
  }
} else {
  ok(`pnpm ${pnpmVersion}`);
}

log('Checking optional native-build toolchain (only used if no better-sqlite3 prebuild matches this platform)');
const hasMake = !!tryCapture('make --version');
const hasPython = !!tryCapture('python3 --version');
const hasCxx = !!(tryCapture('g++ --version') || tryCapture('c++ --version') || tryCapture('clang++ --version'));
if (hasMake && hasPython && hasCxx) {
  ok('make, python3, and a C++ compiler are all present');
} else {
  const missing = [!hasMake && 'make', !hasPython && 'python3', !hasCxx && 'a C++ compiler (g++/clang++)']
    .filter(Boolean)
    .join(', ');
  const hint =
    os.platform() === 'linux'
      ? 'sudo apt-get install -y build-essential python3'
      : os.platform() === 'darwin'
        ? 'xcode-select --install'
        : 'install Visual Studio Build Tools (Desktop development with C++)';
  warn(
    `Missing: ${missing}. Usually fine — better-sqlite3 ships prebuilt binaries for most platforms. ` +
      `Only needed as a fallback if no prebuild matches your OS/arch/Node version. If install:* fails ` +
      `with a node-gyp/compile error, run: ${hint}`
  );
}

if (hardFailure) {
  console.error('\n\x1b[31mPreflight failed — fix the issues above before running pnpm run install:*.\x1b[0m');
  process.exit(1);
}
console.log('\n\x1b[32mPreflight passed — this machine can build and install Ariadne.\x1b[0m');
