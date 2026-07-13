import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { syncPush, syncPull, syncListRemote } from '../src/syncCommands.js';

/**
 * syncCommands.ts is a thin wrapper shelling out to the `ariadne` CLI
 * binary (mirroring packages/mcp-server/src/syncTools.ts) — these tests
 * verify the argv it builds and error surfacing, not sync behavior itself
 * (covered by the CLI's own test suite).
 */
describe('vscode-extension sync commands (shell out to the ariadne CLI)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('syncPush builds `ariadne sync push` with --profile only when given', () => {
    vi.mocked(execFileSync).mockReturnValue('Pushed 1 task.\n');
    syncPush({ cwd: '/ws' });
    expect(execFileSync).toHaveBeenCalledWith('ariadne', ['sync', 'push'], expect.objectContaining({ cwd: '/ws' }));

    syncPush({ cwd: '/ws', profile: 'work' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'push', '--profile', 'work'], expect.anything());
  });

  it('syncPull builds `ariadne sync pull` with --import-new only when requested', () => {
    vi.mocked(execFileSync).mockReturnValue('Nothing to pull.\n');
    syncPull({ cwd: '/ws' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'pull'], expect.anything());

    syncPull({ cwd: '/ws', importNew: true, profile: 'work' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'pull', '--import-new', '--profile', 'work'], expect.anything());
  });

  it('syncListRemote builds the expected argv', () => {
    vi.mocked(execFileSync).mockReturnValue('ok\n');
    syncListRemote({ cwd: '/ws', profile: 'team-b' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'list-remote', '--profile', 'team-b'], expect.anything());
  });

  it('surfaces stderr from a failed CLI invocation as a normal Error', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'Not logged in. Run `ariadne sync login` first.';
      throw err;
    });
    expect(() => syncPush({ cwd: '/ws' })).toThrow(/Not logged in/);
  });
});
