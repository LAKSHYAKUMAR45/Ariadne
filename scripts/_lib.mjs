// Shared helpers for the scripts/install-*.mjs one-command installers.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export function log(msg) {
  console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);
}

export function ok(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}

export function warn(msg) {
  console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
}

export function fail(msg) {
  console.error(`\x1b[31m✘ ${msg}\x1b[0m`);
  process.exit(1);
}

/** Runs a command, streaming output, from an optional cwd (defaults to repo root). */
export function run(cmd, cwd = repoRoot) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/** Runs a command and returns trimmed stdout, or null if it fails. */
export function tryCapture(cmd, cwd = repoRoot) {
  try {
    return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Runs scripts/preflight.mjs (checks Node/npm/git/pnpm) and `pnpm install`
 * (so a fresh clone/fresh server works with no manual setup) before an
 * install-*.mjs script does anything else. Exits the process if either step
 * fails — preflight.mjs and `pnpm install` both print actionable errors.
 */
export function ensureReady() {
  log('Preflight: checking required tools (Node, npm, git, pnpm)');
  run(`node ${path.join(repoRoot, 'scripts/preflight.mjs')}`);

  log('Ensuring workspace dependencies are installed (pnpm install)');
  run('pnpm install');
}

