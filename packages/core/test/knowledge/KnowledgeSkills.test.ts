import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KnowledgeSkillRegistry,
  discoverKnowledgeSkills,
} from '../../src/knowledge/KnowledgeSkills.js';

describe('KnowledgeSkills', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function createRoot(): string {
    const root = mkdtempSync(join(process.cwd(), '.knowledge-skills-test-'));
    directories.push(root);
    return root;
  }

  function writeSkill(root: string, name: string, description = `${name} description`): void {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse the ${name} workflow.\n`,
      'utf8',
    );
  }

  it('uses local, project, then user precedence for duplicate skill names', () => {
    const localRoot = createRoot();
    const projectRoot = createRoot();
    const userRoot = createRoot();
    writeSkill(localRoot, 'release');
    writeSkill(projectRoot, 'release');
    writeSkill(userRoot, 'release');

    const discovered = discoverKnowledgeSkills({
      localRoots: [localRoot],
      projectRoots: [projectRoot],
      userRoots: [userRoot],
    });

    expect(discovered.skills).toHaveLength(1);
    expect(discovered.skills[0]).toMatchObject({
      name: 'release',
      scope: 'local',
      enabled: true,
      path: join(localRoot, 'release', 'SKILL.md'),
    });
  });

  it('reports malformed metadata without making the remaining skills unavailable', () => {
    const root = createRoot();
    writeSkill(root, 'valid');
    const invalid = join(root, 'invalid');
    mkdirSync(invalid, { recursive: true });
    writeFileSync(join(invalid, 'SKILL.md'), '---\nname: INVALID NAME\n---\nInstructions', 'utf8');

    const discovered = discoverKnowledgeSkills({ projectRoots: [root] });

    expect(discovered.skills.map((skill) => skill.name)).toEqual(['valid']);
    expect(discovered.errors).toEqual([
      expect.objectContaining({
        path: join(invalid, 'SKILL.md'),
        message: expect.stringMatching(/description|name/i),
      }),
    ]);
  });

  it('keeps disabled skills unavailable and only reveals selected skill instructions', () => {
    const root = createRoot();
    writeSkill(root, 'triage');
    const registry = new KnowledgeSkillRegistry({ projectRoots: [root] });
    registry.refresh();

    registry.setEnabled('triage', false);
    expect(registry.select('conversation_1', 'triage')).toBeUndefined();

    registry.setEnabled('triage', true);
    expect(registry.getSelected('conversation_1')).toBeUndefined();

    const selected = registry.select('conversation_1', 'triage');
    expect(selected).toMatchObject({ name: 'triage', enabled: true });
    expect(selected?.instructions).toContain('Use the triage workflow.');
    expect(registry.getSelected('conversation_1')).toEqual(selected);
  });

  it('accepts structured input data without executing actions', () => {
    const root = createRoot();
    writeSkill(root, 'triage');
    const registry = new KnowledgeSkillRegistry({ projectRoots: [root] });
    registry.refresh();
    registry.select('conversation_1', 'triage');

    expect(
      registry.createInputRequest('conversation_1', {
        issue: 'A build is failing',
        requestedAction: 'rm -rf /',
      }),
    ).toEqual({
      conversationId: 'conversation_1',
      skillName: 'triage',
      input: {
        issue: 'A build is failing',
        requestedAction: 'rm -rf /',
      },
    });
  });

  it('does not select a skill when durable use logging fails', () => {
    const root = createRoot();
    writeSkill(root, 'triage');
    const registry = new KnowledgeSkillRegistry({
      projectRoots: [root],
      projectId: 'project_1',
      operationLog: {
        appendKnowledgeOperation: () => {
          throw new Error('log unavailable');
        },
      },
    });
    registry.refresh();

    expect(() => registry.select('conversation_1', 'triage')).toThrow('log unavailable');
    expect(registry.getSelected('conversation_1')).toBeUndefined();
  });
});
