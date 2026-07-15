import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Thin passthrough wrapper around the `graphify` CLI
 * (https://github.com/Graphify-Labs/graphify, PyPI package `graphifyy`).
 *
 * Ariadne does not reimplement any of graphify's graph-building/querying
 * logic — graphify is a separate, independently-installed Python tool that
 * maps a codebase (and docs/PDFs/images/video) into a local knowledge graph
 * (`graph.json` + `graph.html` + `GRAPH_REPORT.md`) and exposes commands
 * like `update`, `query`, `explain`, `path`, and `affected` to query it.
 *
 * This module just runs the real `graphify` binary — streaming its output
 * live for the CLI, or capturing it as text for the MCP server / VS Code
 * extension — so every Ariadne surface can shell out to it consistently
 * and (optionally) log the invocation against the current task, the same
 * way `ariadne exec` records arbitrary shell commands.
 */

export type GraphifySpawnFn = typeof spawn;

const DEFAULT_BINARY = 'graphify';

export const GRAPHIFY_INSTALL_HINT =
  'graphify CLI not found on PATH. Install it with "uv tool install graphifyy" (or "pipx install graphifyy"), then re-run. See https://github.com/Graphify-Labs/graphify';

export interface GraphifyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunGraphifyOptions {
  /** Working directory to run graphify in (default: process.cwd()). */
  cwd?: string;
  /**
   * 'inherit' streams stdout/stderr directly to the parent process's own
   * streams (no capture) — used by the CLI passthrough command so
   * interactive/long-running graphify output (e.g. `watch`) shows live.
   * 'capture' buffers stdout/stderr and returns them as strings — used by
   * the MCP server and VS Code extension, which need the text back to
   * relay to the assistant/chat rather than a terminal. Default: 'capture'.
   */
  mode?: 'inherit' | 'capture';
  /** Injectable for tests. */
  spawnImpl?: GraphifySpawnFn;
  /** Command/path to invoke (default: 'graphify', resolved from PATH). */
  binary?: string;
}

/**
 * Checks whether the `graphify` CLI is reachable on PATH. Synchronous and
 * cheap (`graphify --help`) — used to fail fast with `GRAPHIFY_INSTALL_HINT`
 * instead of letting a spawn ENOENT bubble up as an opaque error.
 */
export function isGraphifyInstalled(binary: string = DEFAULT_BINARY): boolean {
  const result = spawnSync(binary, ['--help'], { stdio: 'ignore' });
  return result.error === undefined && result.status !== null;
}

/** Runs `graphify <args>` asynchronously. See `RunGraphifyOptions.mode` for streaming vs. capture behavior. */
export function runGraphify(args: string[], options: RunGraphifyOptions = {}): Promise<GraphifyResult> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const binary = options.binary ?? DEFAULT_BINARY;
  const mode = options.mode ?? 'capture';

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawnImpl(binary, args, {
        cwd: options.cwd,
        stdio: mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      }) as ChildProcess;
    } catch (err) {
      resolve({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (mode === 'capture') {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }

    let settled = false;
    child.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: 1, stdout, stderr: stderr || err.message });
    });

    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/** Synchronous variant of `runGraphify`, always capturing output — used by callers (VS Code's chat participant) that can't await a promise. */
export function runGraphifySync(args: string[], options: Omit<RunGraphifyOptions, 'mode' | 'spawnImpl'> = {}): GraphifyResult {
  const binary = options.binary ?? DEFAULT_BINARY;
  const result = spawnSync(binary, args, { cwd: options.cwd, encoding: 'utf8' });
  if (result.error) {
    return { exitCode: 1, stdout: result.stdout ?? '', stderr: result.error.message };
  }
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Builds a short, single-line summary of a graphify invocation suitable for
 * a checkpoint/command-log entry — the command plus a trimmed snippet of
 * its first non-empty output line, not the full (potentially huge) stdout.
 */
export function summarizeGraphifyRun(args: string[], result: GraphifyResult): string {
  const cmd = [DEFAULT_BINARY, ...args].join(' ');
  const firstLine = (result.stdout || result.stderr).split('\n').find((l) => l.trim().length > 0) ?? '';
  const status = result.exitCode === 0 ? 'ok' : `exit ${result.exitCode}`;
  const snippet = firstLine.trim().slice(0, 200);
  return `ran "${cmd}" (${status})${snippet ? `: ${snippet}` : ''}`;
}
