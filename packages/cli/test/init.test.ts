import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { closeRegistry } from '@ariadne-dev/core';
import { program } from '../src/index.js';
import { SKILL_RELATIVE_PATH, AGENT_RELATIVE_PATH, SYNC_CONFIG_RELATIVE_PATH } from '../src/skillTemplates.js';

// Functional coverage for `ariadne init`: bootstraps .ariadne/state.db in a
// fresh workspace and generates the project-local Copilot skill/agent files,
// per the same "parse argv through the real `program`" convention used by
// curation.test.ts/status.test.ts.
describe('ariadne init', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let previousRegistryPath: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-init-test-'));
    // findWorkspaceRoot() walks up from cwd looking for `.git` or `.ariadne`,
    // falling back to the start dir only if it reaches the filesystem root
    // without finding either. Give this temp dir its own `.git` marker so
    // resolution is hermetic regardless of stray `.ariadne`/`.git` dirs that
    // may exist higher up (e.g. directly under the OS temp dir).
    fs.mkdirSync(path.join(root, '.git'));
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(root, 'registry.db');
    closeRegistry();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates .ariadne/state.db and the skill/agent files on a fresh workspace', async () => {
    await program.parseAsync(['node', 'ariadne', 'init']);

    expect(fs.existsSync(path.join(root, '.ariadne', 'state.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, SKILL_RELATIVE_PATH))).toBe(true);
    expect(fs.existsSync(path.join(root, AGENT_RELATIVE_PATH))).toBe(true);
    expect(fs.existsSync(path.join(root, SYNC_CONFIG_RELATIVE_PATH))).toBe(true);
  });

  it('is idempotent: re-running without --force does not clobber a hand-edited skill file', async () => {
    await program.parseAsync(['node', 'ariadne', 'init']);
    const skillPath = path.join(root, SKILL_RELATIVE_PATH);
    fs.writeFileSync(skillPath, 'hand-edited', 'utf8');

    await program.parseAsync(['node', 'ariadne', 'init']);

    expect(fs.readFileSync(skillPath, 'utf8')).toBe('hand-edited');
  });

  it('--force overwrites a previously generated skill/agent file', async () => {
    await program.parseAsync(['node', 'ariadne', 'init']);
    const skillPath = path.join(root, SKILL_RELATIVE_PATH);
    fs.writeFileSync(skillPath, 'hand-edited', 'utf8');

    await program.parseAsync(['node', 'ariadne', 'init', '--force']);

    expect(fs.readFileSync(skillPath, 'utf8')).not.toBe('hand-edited');
  });
});
