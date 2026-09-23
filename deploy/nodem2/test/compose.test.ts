/**
 * Compose contract tests for the tracked nodem2 stack.
 *
 * These assert the boot-ordering contract between the root-owned operator
 * service and the unprivileged sync-server container: Docker must never be
 * able to fabricate the operator socket or the callback token as directories
 * when it starts a container before the operator has created them.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const deployDir = path.join(repoRoot, 'deploy', 'nodem2');
const composePath = path.join(deployDir, 'compose.yaml');
const tmpfilesPath = path.join(deployDir, 'tmpfiles', 'ariadne.conf');

// Host runtime directory owned by the operator, and the distinct container
// path it is mounted at: the container's own tmpfs already uses /run/ariadne
// for the decrypted key handoff.
const HOST_RUNTIME_DIR = '/run/ariadne';
const CONTAINER_RUNTIME_DIR = '/run/ariadne-operator';

function composeText(): string {
  return fs.readFileSync(composePath, 'utf8');
}

/** Returns the indented body of one top-level `services:` entry. */
function serviceBlock(name: string): string {
  const lines = composeText().split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `service ${name} is missing from compose.yaml`).toBeGreaterThanOrEqual(0);

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,2}\S/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** Returns the raw `host:container[:options]` entries of one service. */
function volumesOf(name: string): string[] {
  const lines = serviceBlock(name).split('\n');
  const start = lines.findIndex((line) => line.trim() === 'volumes:');
  if (start < 0) return [];

  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = /^\s+- (.+)$/.exec(line);
    if (!match) break;
    entries.push(match[1].trim());
  }
  return entries;
}

function bindSource(entry: string): string | null {
  const source = entry.split(':')[0];
  return source.startsWith('/') ? source : null;
}

describe('compose operator runtime mounts', () => {
  it('bind-mounts the operator runtime directory read-only into sync-server', () => {
    expect(volumesOf('sync-server')).toContain(
      `${HOST_RUNTIME_DIR}:${CONTAINER_RUNTIME_DIR}:ro`,
    );
  });

  it('never bind-mounts an individual operator file', () => {
    // A file bind mount whose host path does not exist yet makes Docker create
    // a *directory* at that path. On a fresh boot the container can start
    // before the operator has created its socket and callback token, which
    // would permanently shadow both with directories.
    for (const service of ['postgres', 'migrate', 'sync-server']) {
      for (const entry of volumesOf(service)) {
        const source = bindSource(entry);
        if (source === null) continue;
        expect(
          source.startsWith(`${HOST_RUNTIME_DIR}/`),
          `${service} bind-mounts the individual path ${source}`,
        ).toBe(false);
        expect(path.extname(source), `${service} bind-mounts the file ${source}`).toBe('');
      }
    }
  });

  it('resolves the socket and the callback token inside the mounted directory', () => {
    const block = serviceBlock('sync-server');
    expect(block).toContain(`OPERATOR_SOCKET_PATH: ${CONTAINER_RUNTIME_DIR}/operator.sock`);
    // The whole host directory is mounted, so the in-container file names are
    // exactly the names the operator creates on the host.
    expect(block).toContain(
      `OPERATOR_CALLBACK_TOKEN_PATH: ${CONTAINER_RUNTIME_DIR}/operator-callback-token`,
    );
  });

  it('keeps the container root filesystem read-only around the mount', () => {
    const block = serviceBlock('sync-server');
    expect(block).toContain('read_only: true');
    expect(block).toContain('no-new-privileges:true');
  });

  it('validates as Compose configuration', () => {
    const probe = spawnSync('docker', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return;

    const result = spawnSync(
      'docker',
      ['compose', '-f', composePath, '-p', 'ariadne-nodem2', 'config', '--quiet'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    if (result.error) return;
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/error/i);
    expect(result.status).toBe(0);
  });
});

describe('operator runtime directory at boot', () => {
  it('is created by tmpfiles before any container starts', () => {
    const text = fs.readFileSync(tmpfilesPath, 'utf8');
    const entry = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('d '));

    expect(entry).toBeDefined();
    expect(entry?.split(/\s+/).slice(0, 5)).toEqual([
      'd',
      HOST_RUNTIME_DIR,
      '0750',
      'root',
      'ariadne-web',
    ]);
  });

  it('is re-asserted by the operator unit on every start', () => {
    const unit = fs.readFileSync(
      path.join(deployDir, 'systemd', 'ariadne-operator.service'),
      'utf8',
    );
    expect(unit).toContain('RuntimeDirectory=ariadne');
    expect(unit).toContain('RuntimeDirectoryMode=0750');
    // Preserved so a restart never invalidates the token the running container
    // already mounted, and so the shared directory inode survives.
    expect(unit).toContain('RuntimeDirectoryPreserve=yes');
    expect(unit).toContain('Group=ariadne-web');
  });
});
