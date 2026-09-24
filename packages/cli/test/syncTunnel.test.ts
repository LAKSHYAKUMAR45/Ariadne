import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROJECT_SYNC_CONFIG_RELATIVE_PATH,
  bootstrapSshAccess,
  canReachSyncServer,
  ensureSshTunnel,
  readProjectSyncConnection,
  type SyncTunnelConfig,
} from '../src/syncTunnel.js';

describe('sync tunnel setup', () => {
  let root: string;

  const tunnel: SyncTunnelConfig = {
    sshHost: 'nodem2',
    sshUser: 'root',
    sshHostKey: 'SHA256:5EwJ7UMeWUqsBH7Ws3AoCXT9GAvHw+cI4jbx/hxX6qY',
    remotePort: 4300,
    localPort: 14300,
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-sync-tunnel-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads and validates the project-local nodem2 connection configuration', () => {
    const configPath = path.join(root, PROJECT_SYNC_CONFIG_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        profile: 'nodem2',
        sshHost: 'nodem2',
        sshUser: 'root',
        sshHostKey: 'SHA256:5EwJ7UMeWUqsBH7Ws3AoCXT9GAvHw+cI4jbx/hxX6qY',
        remotePort: 4300,
        localPort: 14300,
      }),
      'utf8',
    );

    expect(readProjectSyncConnection(root)).toEqual({
      profile: 'nodem2',
      tunnel,
      serverUrl: 'http://127.0.0.1:14300',
    });
  });

  it('rejects unsafe SSH host/user values instead of passing them to ssh', () => {
    const configPath = path.join(root, PROJECT_SYNC_CONFIG_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        profile: 'nodem2',
        sshHost: 'nodem2;rm -rf /',
        sshUser: 'root',
        sshHostKey: 'SHA256:5EwJ7UMeWUqsBH7Ws3AoCXT9GAvHw+cI4jbx/hxX6qY',
        remotePort: 4300,
        localPort: 14300,
      }),
      'utf8',
    );

    expect(() => readProjectSyncConnection(root)).toThrow('Invalid sshHost');
  });

  it('reuses an already-reachable tunnel without spawning ssh', async () => {
    const runCommand = vi.fn();
    await ensureSshTunnel(tunnel, {
      canReachServer: vi.fn().mockResolvedValue(true),
      isTunnelActive: vi.fn().mockReturnValue(true),
      runCommand,
      homeDir: root,
    });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rejects a healthy-looking local port when it is not owned by the configured SSH control master', async () => {
    await expect(
      ensureSshTunnel(tunnel, {
        canReachServer: vi.fn().mockResolvedValue(true),
        isTunnelActive: vi.fn().mockReturnValue(false),
        runCommand: vi.fn(),
        homeDir: root,
      }),
    ).rejects.toThrow('already in use by a process that is not the Ariadne SSH tunnel');
  });

  it('only treats the Ariadne health endpoint as a reachable sync server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await expect(canReachSyncServer('http://127.0.0.1:14300')).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:14300/healthz', expect.objectContaining({ method: 'GET' }));

    fetchSpy.mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(canReachSyncServer('http://127.0.0.1:14300')).resolves.toBe(false);
    fetchSpy.mockRestore();
  });

  it('starts a hardened background tunnel and verifies it became reachable', async () => {
    const canReachServer = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const runCommand = vi.fn().mockReturnValue({ status: 0 });

    await ensureSshTunnel(tunnel, {
      canReachServer,
      isTunnelActive: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      runCommand,
      homeDir: root,
    });

    expect(runCommand).toHaveBeenCalledWith('ssh', [
      '-M',
      '-S',
      expect.stringContaining('ariadne-'),
      '-f',
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      expect.stringContaining('UserKnownHostsFile='),
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=60',
      '-o',
      'ServerAliveCountMax=3',
      '-L',
      '127.0.0.1:14300:127.0.0.1:4300',
      'root@nodem2',
    ]);
    expect(canReachServer).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly when ssh exits successfully but the forwarded endpoint is still unreachable', async () => {
    await expect(
      ensureSshTunnel(tunnel, {
        canReachServer: vi.fn().mockResolvedValue(false),
        isTunnelActive: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
        runCommand: vi.fn().mockReturnValue({ status: 0 }),
        homeDir: root,
      }),
    ).rejects.toThrow('SSH tunnel started but the Ariadne sync server is not reachable');
  });

  it('pins and explicitly trusts the configured host key before installing a login key', async () => {
    const homeDir = path.join(root, 'home');
    const knownHostsPath = path.join(homeDir, '.ariadne', 'ssh', 'known_hosts');
    fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true });
    fs.writeFileSync(knownHostsPath, 'other-host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherHostKeyMaterial\n', 'utf8');
    const runCommand = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: 'nodem2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVtQWzBM6KlFJpEM4Ve5YRiI9Wv2KkFQIBxHGFQTEst\n',
      })
      .mockReturnValueOnce({ status: 255 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 });

    const fingerprint = `SHA256:${Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIKVtQWzBM6KlFJpEM4Ve5YRiI9Wv2KkFQIBxHGFQTEst', 'base64'),
      ),
    )
      .toString('base64')
      .replace(/=+$/, '')}`;
    const pinnedTunnel = { ...tunnel, sshHostKey: fingerprint };

    await bootstrapSshAccess(pinnedTunnel, {
      fileExists: vi.fn().mockReturnValue(false),
      runCommand,
      homeDir,
      platform: 'linux',
      commandExists: vi.fn().mockReturnValue(true),
      confirmTrust: vi.fn().mockResolvedValue(true),
    });

    expect(runCommand).toHaveBeenCalledWith('ssh-keyscan', ['-T', '5', '-t', 'ed25519', 'nodem2']);
    expect(runCommand).toHaveBeenCalledWith(
      'ssh-copy-id',
      expect.arrayContaining(['-i', path.join(homeDir, '.ssh', 'id_ed25519.pub'), 'root@nodem2']),
    );
    const knownHosts = fs.readFileSync(knownHostsPath, 'utf8');
    expect(knownHosts).toContain('other-host ssh-ed25519');
    expect(knownHosts).toContain('nodem2 ssh-ed25519');
    expect(fs.statSync(knownHostsPath).mode & 0o777).toBe(0o600);
  });

  it('rejects a scanned SSH host key that does not match the pinned project fingerprint', async () => {
    await expect(
      bootstrapSshAccess(tunnel, {
        runCommand: vi.fn().mockReturnValue({
          status: 0,
          stdout: 'nodem2 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVtQWzBM6KlFJpEM4Ve5YRiI9Wv2KkFQIBxHGFQTEst\n',
        }),
        homeDir: root,
        platform: 'linux',
        commandExists: vi.fn().mockReturnValue(true),
        confirmTrust: vi.fn(),
      }),
    ).rejects.toThrow('does not match the pinned fingerprint');
  });

  it('fails clearly on unsupported platforms before invoking OpenSSH', async () => {
    const runCommand = vi.fn();
    await expect(
      bootstrapSshAccess(tunnel, {
        runCommand,
        homeDir: root,
        platform: 'win32',
        confirmTrust: vi.fn(),
      }),
    ).rejects.toThrow('requires Unix-like OpenSSH');
    expect(runCommand).not.toHaveBeenCalled();
  });
});
