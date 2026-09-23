import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateAriadneSkillAndAgent,
  SKILL_RELATIVE_PATH,
  AGENT_RELATIVE_PATH,
  SYNC_CONFIG_RELATIVE_PATH,
  buildSkillMarkdown,
  buildAgentMarkdown,
} from '../src/skillTemplates.js';

describe('generateAriadneSkillAndAgent', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-skillgen-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates .github/skills/ariadne/SKILL.md and .github/agents/ariadne.agent.md on a fresh project', () => {
    const results = generateAriadneSkillAndAgent(root);

    expect(results).toEqual([
      { path: SKILL_RELATIVE_PATH, action: 'created' },
      { path: AGENT_RELATIVE_PATH, action: 'created' },
      { path: SYNC_CONFIG_RELATIVE_PATH, action: 'created' },
    ]);
    expect(fs.existsSync(path.join(root, SKILL_RELATIVE_PATH))).toBe(true);
    expect(fs.existsSync(path.join(root, AGENT_RELATIVE_PATH))).toBe(true);
    expect(fs.existsSync(path.join(root, SYNC_CONFIG_RELATIVE_PATH))).toBe(true);
  });

  it('the generated SKILL.md has valid frontmatter matching the parent folder name', () => {
    generateAriadneSkillAndAgent(root);
    const content = fs.readFileSync(path.join(root, SKILL_RELATIVE_PATH), 'utf8');
    expect(content).toMatch(/^---\nname: ariadne\n/);
    expect(content).toContain('description:');
    // Folder is .github/skills/ariadne/ -- name must match it exactly.
    expect(path.basename(path.dirname(path.join(root, SKILL_RELATIVE_PATH)))).toBe('ariadne');
  });

  it('the generated agent file has valid frontmatter (description, tools)', () => {
    generateAriadneSkillAndAgent(root);
    const content = fs.readFileSync(path.join(root, AGENT_RELATIVE_PATH), 'utf8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('description:');
    expect(content).toContain('tools:');
  });

  it('is idempotent: re-running without --force leaves existing files untouched', () => {
    generateAriadneSkillAndAgent(root);
    const skillPath = path.join(root, SKILL_RELATIVE_PATH);
    fs.writeFileSync(skillPath, 'hand-edited content', 'utf8');

    const results = generateAriadneSkillAndAgent(root);

    expect(results.find((r) => r.path === SKILL_RELATIVE_PATH)?.action).toBe('skipped-exists');
    expect(fs.readFileSync(skillPath, 'utf8')).toBe('hand-edited content');
  });

  it('force: true overwrites existing files', () => {
    generateAriadneSkillAndAgent(root);
    const skillPath = path.join(root, SKILL_RELATIVE_PATH);
    fs.writeFileSync(skillPath, 'hand-edited content', 'utf8');

    const results = generateAriadneSkillAndAgent(root, { force: true });

    expect(results.find((r) => r.path === SKILL_RELATIVE_PATH)?.action).toBe('overwritten');
    expect(fs.readFileSync(skillPath, 'utf8')).toBe(buildSkillMarkdown());
  });

  it('never overwrites a customized project sync connection, even with force', () => {
    generateAriadneSkillAndAgent(root);
    const configPath = path.join(root, SYNC_CONFIG_RELATIVE_PATH);
    fs.writeFileSync(configPath, '{"custom":true}\n', 'utf8');

    const results = generateAriadneSkillAndAgent(root, { force: true });

    expect(results.find((r) => r.path === SYNC_CONFIG_RELATIVE_PATH)?.action).toBe('skipped-exists');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"custom":true}\n');
  });

  it('documents the one-command tunnel setup in both generated Copilot files', () => {
    generateAriadneSkillAndAgent(root);
    expect(buildSkillMarkdown()).toContain('ariadne sync setup');
    expect(buildAgentMarkdown()).toContain('ariadne sync setup');
    expect(buildSkillMarkdown()).toContain('never stores the SSH password');
    expect(buildSkillMarkdown()).toContain('ariadne capture [task-id]');
    expect(buildSkillMarkdown()).toContain('tracked, task-touched, plain-text files only');
    expect(buildAgentMarkdown()).toContain('ariadne capture [task-id]');
    expect(buildAgentMarkdown()).toContain('skipped path + reason');
    const generatedConfig = JSON.parse(fs.readFileSync(path.join(root, SYNC_CONFIG_RELATIVE_PATH), 'utf8'));
    expect(generatedConfig.sshHostKey).toMatch(/^SHA256:/);
  });

  it('guides operators through the guarded operations console', () => {
    const skill = buildSkillMarkdown();
    const agent = buildAgentMarkdown();

    expect(skill).toContain('http://127.0.0.1:14300/admin');
    expect(skill).toContain('ariadne sync setup');
    expect(skill).toMatch(
      /backup, restore, service restart, deployment,\s+rollback, and file-capture deletion/,
    );
    expect(skill).toMatch(/fresh safety backup before changing\s+production state/);
    expect(skill).toContain('Never display passwords, secrets, tokens, or private keys');
    expect(skill).toContain('Never use arbitrary shell commands');
    expect(agent).toContain('http://127.0.0.1:14300/admin');
    expect(agent).toContain('Never display passwords, secrets, tokens, or private keys');
    expect(agent).toContain('Never use arbitrary shell commands');
    expect(agent).toMatch(
      /backup, restore, service restart, deployment,\s+rollback, and file-capture deletion/,
    );
  });

  it('template builders produce non-empty, well-formed markdown', () => {
    expect(buildSkillMarkdown().length).toBeGreaterThan(100);
    expect(buildAgentMarkdown().length).toBeGreaterThan(100);
  });
});
