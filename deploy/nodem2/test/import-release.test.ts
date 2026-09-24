import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptsDir = path.join(repoRoot, 'deploy', 'nodem2', 'scripts');
const importScript = path.join(scriptsDir, 'import-release');
const tempRoots: string[] = [];

interface ReleaseFixture {
  root: string;
  source: string;
  prefix: string;
  worktree: string;
  bundle: string;
  archive: string;
  sha: string;
}

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 20_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

function createReleaseFixture(): ReleaseFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-import-'));
  tempRoots.push(root);
  const source = path.join(root, 'source');
  const prefix = path.join(root, 'host');
  const worktree = path.join(prefix, 'opt', 'ariadne', 'worktree');
  const bundle = path.join(root, 'release.bundle');
  const archive = path.join(root, 'release.tar');

  fs.mkdirSync(source, { recursive: true });
  run('git', ['init', '--quiet'], source);
  run('git', ['config', 'user.name', 'Ariadne Test'], source);
  run('git', ['config', 'user.email', 'ariadne@example.invalid'], source);
  fs.mkdirSync(path.join(source, 'deploy', 'nodem2'), { recursive: true });
  fs.writeFileSync(path.join(source, 'README.md'), 'reviewed release\n');
  fs.writeFileSync(path.join(source, 'deploy', 'nodem2', 'compose.yaml'), 'services: {}\n');
  fs.writeFileSync(path.join(source, 'obsolete.txt'), 'remove on next release\n');
  run('git', ['add', '.'], source);
  run('git', ['commit', '--quiet', '-m', 'test: reviewed release'], source);
  const sha = run('git', ['rev-parse', 'HEAD'], source);
  run('git', ['archive', '--format=tar', '--output', archive, sha], source);
  run('git', ['bundle', 'create', bundle, 'HEAD'], source);
  fs.chmodSync(bundle, 0o600);
  fs.chmodSync(archive, 0o600);

  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  run('git', ['clone', '--quiet', source, worktree]);
  fs.chmodSync(path.join(prefix, 'opt', 'ariadne'), 0o755);
  fs.chmodSync(worktree, 0o755);

  return { root, source, prefix, worktree, bundle, archive, sha };
}

function runImport(
  fixture: ReleaseFixture,
  args = [fixture.sha, fixture.bundle, fixture.archive],
  env: Record<string, string> = {},
) {
  return spawnSync(importScript, args, {
    env: {
      ...process.env,
      ARIADNE_IMPORT_SELFTEST: '1',
      ARIADNE_IMPORT_PREFIX: fixture.prefix,
      ARIADNE_IMPORT_OWNER_UID: String(process.getuid?.() ?? 0),
      ...env,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function createNextRelease(
  fixture: ReleaseFixture,
  changes: (source: string) => void,
): { sha: string; bundle: string; archive: string } {
  changes(fixture.source);
  run('git', ['add', '-A'], fixture.source);
  run('git', ['commit', '--quiet', '-m', 'test: next release'], fixture.source);
  const sha = run('git', ['rev-parse', 'HEAD'], fixture.source);
  const bundle = path.join(fixture.root, `release-${sha}.bundle`);
  const archive = path.join(fixture.root, `release-${sha}.tar`);
  run('git', ['archive', '--format=tar', '--output', archive, sha], fixture.source);
  run('git', ['bundle', 'create', bundle, 'HEAD'], fixture.source);
  fs.chmodSync(bundle, 0o600);
  fs.chmodSync(archive, 0o600);
  return { sha, bundle, archive };
}

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const target = tempRoots.pop();
    if (target) fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('release import script', () => {
  it('keeps the local rollout report ignored and out of Git tracking', () => {
    const report =
      '.superpowers/sdd/2026-09-23-complete-operations-console/task-10-report.md';
    const ignored = spawnSync('git', ['check-ignore', '--quiet', report], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', report], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(ignored.status).toBe(0);
    expect(tracked.status).not.toBe(0);
  });

  it('imports the reviewed commit, updates only the fixed trust ref, and leaves a clean exact worktree', () => {
    const fixture = createReleaseFixture();
    const sibling = path.join(fixture.prefix, 'opt', 'unrelated-workload');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'do not touch\n');

    const result = runImport(fixture);

    expect(result.status, output(result)).toBe(0);
    expect(run('git', ['rev-parse', 'refs/ariadne/deploy'], fixture.worktree)).toBe(fixture.sha);
    expect(run('git', ['rev-parse', 'HEAD'], fixture.worktree)).toBe(fixture.sha);
    expect(run('git', ['status', '--porcelain'], fixture.worktree)).toBe('');
    expect(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8')).toBe(
      'reviewed release\n',
    );
    expect(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8')).toBe('do not touch\n');
  });

  it('restores tracked file permissions from Git instead of the importer umask', () => {
    const fixture = createReleaseFixture();
    const migration = path.join(
      fixture.source,
      'packages',
      'sync-server',
      'migrations',
      '0010_complete_admin_operations.sql',
    );
    fs.mkdirSync(path.dirname(migration), { recursive: true });
    fs.writeFileSync(migration, 'SELECT 10;\n', { mode: 0o644 });
    const release = createNextRelease(fixture, () => {});

    const result = runImport(fixture, [release.sha, release.bundle, release.archive]);

    expect(result.status, output(result)).toBe(0);
    const importedMigration = path.join(
      fixture.worktree,
      'packages',
      'sync-server',
      'migrations',
      '0010_complete_admin_operations.sql',
    );
    expect(fs.statSync(importedMigration).mode & 0o777).toBe(0o644);
  });

  it('removes tracked files absent from the new archive without touching untracked siblings', () => {
    const fixture = createReleaseFixture();
    fs.rmSync(path.join(fixture.source, 'obsolete.txt'));
    fs.writeFileSync(path.join(fixture.source, 'README.md'), 'next reviewed release\n');
    run('git', ['add', '-A'], fixture.source);
    run('git', ['commit', '--quiet', '-m', 'test: next release'], fixture.source);
    fixture.sha = run('git', ['rev-parse', 'HEAD'], fixture.source);
    fs.rmSync(fixture.archive);
    fs.rmSync(fixture.bundle);
    run('git', ['archive', '--format=tar', '--output', fixture.archive, fixture.sha], fixture.source);
    run('git', ['bundle', 'create', fixture.bundle, 'HEAD'], fixture.source);
    fs.chmodSync(fixture.archive, 0o600);
    fs.chmodSync(fixture.bundle, 0o600);
    fs.appendFileSync(path.join(fixture.worktree, '.git', 'info', 'exclude'), 'local-cache/\n');
    fs.mkdirSync(path.join(fixture.worktree, 'local-cache'));
    fs.writeFileSync(path.join(fixture.worktree, 'local-cache', 'keep.txt'), 'preserve\n');

    const result = runImport(fixture);

    expect(result.status, output(result)).toBe(0);
    expect(fs.existsSync(path.join(fixture.worktree, 'obsolete.txt'))).toBe(false);
    expect(
      fs.readFileSync(path.join(fixture.worktree, 'local-cache', 'keep.txt'), 'utf8'),
    ).toBe('preserve\n');
    expect(run('git', ['status', '--porcelain'], fixture.worktree)).toBe('');
  });

  it('rejects missing or mismatched bundle, archive, and sha inputs', () => {
    const fixture = createReleaseFixture();
    const missing = runImport(fixture, [fixture.sha, `${fixture.bundle}.missing`, fixture.archive]);
    expect(missing.status).not.toBe(0);

    const badSha = runImport(fixture, ['A'.repeat(40), fixture.bundle, fixture.archive]);
    expect(badSha.status).not.toBe(0);

    const relative = runImport(fixture, [fixture.sha, 'release.bundle', fixture.archive]);
    expect(relative.status).not.toBe(0);

    fs.writeFileSync(path.join(fixture.source, 'README.md'), 'different archive\n');
    run('git', ['add', 'README.md'], fixture.source);
    run('git', ['commit', '--quiet', '-m', 'test: mismatched archive'], fixture.source);
    const otherSha = run('git', ['rev-parse', 'HEAD'], fixture.source);
    fs.rmSync(fixture.archive);
    run('git', ['archive', '--format=tar', '--output', fixture.archive, otherSha], fixture.source);
    fs.chmodSync(fixture.archive, 0o600);
    const mismatch = runImport(fixture);
    expect(mismatch.status).not.toBe(0);
    expect(output(mismatch).toLowerCase()).toMatch(/archive|match|mismatch/);
  });

  it('rejects a thin bundle that depends on history outside the copied artifact', () => {
    const fixture = createReleaseFixture();
    fs.writeFileSync(path.join(fixture.source, 'README.md'), 'next release\n');
    run('git', ['add', 'README.md'], fixture.source);
    run('git', ['commit', '--quiet', '-m', 'test: next release'], fixture.source);
    fixture.sha = run('git', ['rev-parse', 'HEAD'], fixture.source);
    fs.rmSync(fixture.archive);
    fs.rmSync(fixture.bundle);
    run('git', ['archive', '--format=tar', '--output', fixture.archive, fixture.sha], fixture.source);
    run('git', ['bundle', 'create', fixture.bundle, 'HEAD', '^HEAD~1'], fixture.source);
    fs.chmodSync(fixture.archive, 0o600);
    fs.chmodSync(fixture.bundle, 0o600);

    const result = runImport(fixture);

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toMatch(/complete|prerequisite|history/);
  });

  it('consumes only staged snapshots when caller-owned artifacts are replaced after staging', () => {
    const fixture = createReleaseFixture();
    const replacement = createNextRelease(fixture, (source) => {
      fs.writeFileSync(path.join(source, 'README.md'), 'attacker replacement\n');
    });
    const hook = path.join(fixture.root, 'replace-artifacts');
    const marker = path.join(fixture.root, 'snapshot-hook-ran');
    fs.writeFileSync(
      hook,
      `#!/bin/sh
cp -- "${replacement.bundle}" "$ARIADNE_TEST_SOURCE_BUNDLE"
cp -- "${replacement.archive}" "$ARIADNE_TEST_SOURCE_ARCHIVE"
printf 'ran\\n' > "${marker}"
`,
      { mode: 0o700 },
    );

    const result = runImport(fixture, undefined, {
      ARIADNE_IMPORT_SNAPSHOT_HOOK: hook,
      ARIADNE_TEST_SOURCE_BUNDLE: fixture.bundle,
      ARIADNE_TEST_SOURCE_ARCHIVE: fixture.archive,
    });

    expect(result.status, output(result)).toBe(0);
    expect(fs.readFileSync(marker, 'utf8')).toBe('ran\n');
    expect(
      run('sh', ['-c', 'git get-tar-commit-id < "$1"', 'sh', fixture.archive]),
    ).toBe(replacement.sha);
    expect(run('git', ['rev-parse', 'HEAD'], fixture.worktree)).toBe(fixture.sha);
    expect(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8')).toBe(
      'reviewed release\n',
    );
  });

  it('fails closed when an artifact changes while its staged snapshot is being copied', () => {
    const fixture = createReleaseFixture();
    const fakeBin = path.join(fixture.root, 'fake-bin');
    const fakeDd = path.join(fakeBin, 'dd');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      fakeDd,
      `#!/bin/sh
/usr/bin/dd "$@"
if [ -n "\${ARIADNE_TEST_MUTATE_SOURCE:-}" ]; then
  printf 'mutation\\n' >> "$ARIADNE_TEST_MUTATE_SOURCE"
  unset ARIADNE_TEST_MUTATE_SOURCE
fi
`,
      { mode: 0o700 },
    );

    const result = runImport(fixture, undefined, {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      ARIADNE_TEST_MUTATE_SOURCE: fixture.bundle,
    });

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toMatch(/changed while.*copied|snapshot size changed/);
    expect(run('git', ['rev-parse', 'HEAD'], fixture.worktree)).toBe(fixture.sha);
  });

  it('rejects an ignored file that exactly conflicts with a target tracked path', () => {
    const fixture = createReleaseFixture();
    const release = createNextRelease(fixture, (source) => {
      fs.writeFileSync(path.join(source, 'ignored.txt'), 'reviewed\n');
    });
    fs.appendFileSync(path.join(fixture.worktree, '.git', 'info', 'exclude'), 'ignored.txt\n');
    fs.writeFileSync(path.join(fixture.worktree, 'ignored.txt'), 'local state\n');

    const result = runImport(fixture, [release.sha, release.bundle, release.archive]);

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toMatch(/ignored.*conflict/);
    expect(fs.readFileSync(path.join(fixture.worktree, 'ignored.txt'), 'utf8')).toBe(
      'local state\n',
    );
    expect(run('git', ['rev-parse', 'HEAD'], fixture.worktree)).toBe(fixture.sha);
  });

  it('rejects ignored directory and file topology that blocks target tracked paths', () => {
    const fixture = createReleaseFixture();
    const release = createNextRelease(fixture, (source) => {
      fs.writeFileSync(path.join(source, 'blocked'), 'reviewed file\n');
      fs.mkdirSync(path.join(source, 'parent'));
      fs.writeFileSync(path.join(source, 'parent', 'child.txt'), 'reviewed child\n');
    });
    fs.appendFileSync(
      path.join(fixture.worktree, '.git', 'info', 'exclude'),
      'blocked/\nparent\n',
    );
    fs.mkdirSync(path.join(fixture.worktree, 'blocked'));
    fs.writeFileSync(path.join(fixture.worktree, 'blocked', 'keep.txt'), 'local directory\n');
    fs.writeFileSync(path.join(fixture.worktree, 'parent'), 'local file\n');

    const result = runImport(fixture, [release.sha, release.bundle, release.archive]);

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toMatch(/ignored.*conflict/);
    expect(fs.readFileSync(path.join(fixture.worktree, 'blocked', 'keep.txt'), 'utf8')).toBe(
      'local directory\n',
    );
    expect(fs.readFileSync(path.join(fixture.worktree, 'parent'), 'utf8')).toBe('local file\n');
    expect(run('git', ['rev-parse', 'HEAD'], fixture.worktree)).toBe(fixture.sha);
  });

  it('rejects archive path traversal and symlink entries', () => {
    const fixture = createReleaseFixture();
    const traversal = path.join(fixture.root, 'traversal.tar');
    const symlinkArchive = path.join(fixture.root, 'symlink.tar');
    const payload = path.join(fixture.root, 'payload');
    fs.mkdirSync(payload);
    fs.writeFileSync(path.join(payload, 'file'), 'payload\n');
    run('tar', ['-cf', traversal, '--transform=s#file#../escape#', 'file'], payload);
    fs.symlinkSync('/etc/passwd', path.join(payload, 'link'));
    run('tar', ['-cf', symlinkArchive, 'link'], payload);

    for (const archive of [traversal, symlinkArchive]) {
      const result = runImport(fixture, [fixture.sha, fixture.bundle, archive]);
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(path.join(fixture.prefix, 'opt', 'ariadne', 'escape'))).toBe(false);
    }
  });

  it('fails closed when the destination is dirty and preserves its contents and trust ref', () => {
    const fixture = createReleaseFixture();
    const originalRef = run('git', ['rev-parse', 'HEAD'], fixture.worktree);
    fs.writeFileSync(path.join(fixture.worktree, 'README.md'), 'local modification\n');

    const result = runImport(fixture);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8')).toBe(
      'local modification\n',
    );
    const ref = spawnSync('git', ['rev-parse', '--verify', 'refs/ariadne/deploy'], {
      cwd: fixture.worktree,
      encoding: 'utf8',
    });
    expect(ref.status).not.toBe(0);
    expect(run('git', ['rev-parse', 'HEAD'], fixture.worktree)).toBe(originalRef);
  });

  it('contains no Docker, systemd, remote Git, or broad unresolved deletion operations', () => {
    const script = fs.readFileSync(importScript, 'utf8');
    expect(script).not.toMatch(/\b(docker|systemctl|service)\b/);
    expect(script).not.toMatch(/\bgit\b[^\n]*\b(fetch|pull|clone|push)\b/);
    expect(script).not.toMatch(/\brm\s+-rf\s+["']?\$(?!ARIADNE_STAGE_DIR)/);
    expect(script).toContain('refs/ariadne/deploy');
    expect(script).toContain('--exclude=/.git');
  });
});
