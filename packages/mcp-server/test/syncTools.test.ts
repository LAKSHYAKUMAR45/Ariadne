import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { syncPush, syncPull, syncListRemote, syncProfileList } from '../src/syncTools.js';

/**
 * syncTools.ts is a thin wrapper shelling out to the `ariadne` CLI binary
 * rather than reimplementing sync logic in this package — these tests
 * verify the argv it builds and that stderr/stdout are surfaced sensibly on
 * failure, not the sync behavior itself (that's covered by the CLI's own
 * test suite).
 */
describe('mcp-server sync tools (shell out to the ariadne CLI)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('syncPush builds `ariadne sync push` with --task/--profile only when given', () => {
    vi.mocked(execFileSync).mockReturnValue('Pushed 1 task.\n');
    const out = syncPush({ cwd: '/ws' });
    expect(execFileSync).toHaveBeenCalledWith('ariadne', ['sync', 'push'], expect.objectContaining({ cwd: '/ws' }));
    expect(out).toBe('Pushed 1 task.\n');

    syncPush({ cwd: '/ws', taskId: 'abc', profile: 'work' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'push', '--task', 'abc', '--profile', 'work'], expect.anything());
  });

  it('syncPull builds `ariadne sync pull` with --import-new only when requested', () => {
    vi.mocked(execFileSync).mockReturnValue('Nothing to pull.\n');
    syncPull({ cwd: '/ws' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'pull'], expect.anything());

    syncPull({ cwd: '/ws', importNew: true, profile: 'work' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'pull', '--import-new', '--profile', 'work'], expect.anything());
  });

  it('syncListRemote and syncProfileList build the expected argv', () => {
    vi.mocked(execFileSync).mockReturnValue('ok\n');
    syncListRemote({ cwd: '/ws', profile: 'team-b' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'list-remote', '--profile', 'team-b'], expect.anything());

    syncProfileList({ cwd: '/ws' });
    expect(execFileSync).toHaveBeenLastCalledWith('ariadne', ['sync', 'profile', 'list'], expect.anything());
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
