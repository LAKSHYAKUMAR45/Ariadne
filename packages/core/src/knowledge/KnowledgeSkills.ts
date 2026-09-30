import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { KnowledgeOperationLog } from './KnowledgeOperationLog.js';

const SKILL_FILE_NAME = 'SKILL.md';
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type KnowledgeSkillScope = 'local' | 'project' | 'user';
export type KnowledgeSkillInput = null | boolean | number | string | KnowledgeSkillInput[] | { [key: string]: KnowledgeSkillInput };

export interface KnowledgeSkill {
  name: string;
  description: string;
  scope: KnowledgeSkillScope;
  path: string;
  enabled: boolean;
}

export interface SelectedKnowledgeSkill extends KnowledgeSkill {
  instructions: string;
}

export interface KnowledgeSkillDiscoveryError {
  path: string;
  message: string;
}

export interface KnowledgeSkillDiscovery {
  skills: KnowledgeSkill[];
  errors: KnowledgeSkillDiscoveryError[];
}

export interface KnowledgeSkillDiscoveryOptions {
  localRoots?: readonly string[];
  projectRoots?: readonly string[];
  userRoots?: readonly string[];
}

export interface KnowledgeSkillInputRequest {
  conversationId: string;
  skillName: string;
  input: KnowledgeSkillInput;
}

export interface KnowledgeSkillRegistryOptions extends KnowledgeSkillDiscoveryOptions {
  operationLog?: Pick<KnowledgeOperationLog, 'appendKnowledgeOperation'>;
  projectId?: string;
}

interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Knowledge skill ${label} must not be empty`);
}

function parseFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSkill(filePath: string): ParsedSkill {
  const content = readFileSync(filePath, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(content);
  if (!match) throw new Error('Skill metadata must use YAML frontmatter');

  const metadata = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    metadata.set(line.slice(0, separator).trim(), parseFrontmatterValue(line.slice(separator + 1)));
  }
  const name = metadata.get('name');
  const description = metadata.get('description');
  if (!name || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error('Skill metadata name must be lowercase alphanumeric with hyphens');
  }
  if (!description?.trim()) throw new Error('Skill metadata description must not be empty');

  return { name, description, instructions: match[2].trim() };
}

function rootsForScope(options: KnowledgeSkillDiscoveryOptions): Array<{ scope: KnowledgeSkillScope; roots: readonly string[] }> {
  return [
    { scope: 'local', roots: options.localRoots ?? [] },
    { scope: 'project', roots: options.projectRoots ?? [] },
    { scope: 'user', roots: options.userRoots ?? [] },
  ];
}

function listSkillFiles(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, SKILL_FILE_NAME))
    .filter((filePath) => existsSync(filePath) && statSync(filePath).isFile())
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Discovers valid SKILL.md files without loading their instructions into the
 * returned catalog. Local skill roots take precedence over project roots,
 * followed by user roots.
 */
export function discoverKnowledgeSkills(options: KnowledgeSkillDiscoveryOptions = {}): KnowledgeSkillDiscovery {
  const errors: KnowledgeSkillDiscoveryError[] = [];
  const skills = new Map<string, KnowledgeSkill>();

  for (const { scope, roots } of rootsForScope(options)) {
    for (const root of roots) {
      for (const filePath of listSkillFiles(root)) {
        try {
          const parsed = parseSkill(filePath);
          if (path.basename(path.dirname(filePath)) !== parsed.name) {
            throw new Error('Skill metadata name must match its parent directory');
          }
          if (skills.has(parsed.name)) continue;
          skills.set(parsed.name, {
            name: parsed.name,
            description: parsed.description,
            scope,
            path: filePath,
            enabled: true,
          });
        } catch (error) {
          errors.push({
            path: filePath,
            message: error instanceof Error ? error.message : 'Unable to read skill metadata',
          });
        }
      }
    }
  }

  return {
    skills: [...skills.values()].sort((left, right) => left.name.localeCompare(right.name)),
    errors: errors.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function copyStructuredInput(value: unknown): KnowledgeSkillInput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Knowledge skill input numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(copyStructuredInput);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, copyStructuredInput(item)]),
    );
  }
  throw new Error('Knowledge skill input must be structured JSON data');
}

/**
 * Maintains enablement and explicit per-conversation selection. It never
 * invokes skill-provided actions: callers receive only validated data and
 * selected instructions for their own approved orchestration.
 */
export class KnowledgeSkillRegistry {
  private readonly options: KnowledgeSkillRegistryOptions;
  private skills = new Map<string, KnowledgeSkill>();
  private readonly selectedByConversation = new Map<string, string>();
  private readonly enabledByName = new Map<string, boolean>();

  public constructor(options: KnowledgeSkillRegistryOptions = {}) {
    this.options = options;
  }

  public refresh(): KnowledgeSkillDiscovery {
    const discovery = discoverKnowledgeSkills(this.options);
    this.skills = new Map(
      discovery.skills.map((skill) => {
        const enabled = this.enabledByName.get(skill.name) ?? true;
        return [skill.name, { ...skill, enabled }];
      }),
    );
    for (const [conversationId, skillName] of this.selectedByConversation) {
      if (!this.skills.get(skillName)?.enabled) this.selectedByConversation.delete(conversationId);
    }
    return { ...discovery, skills: this.list() };
  }

  public list(): KnowledgeSkill[] {
    return [...this.skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  public setEnabled(name: string, enabled: boolean): KnowledgeSkill {
    requireNonEmpty(name, 'name');
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Knowledge skill not found: ${name}`);
    this.enabledByName.set(name, enabled);
    const updated = { ...skill, enabled };
    this.skills.set(name, updated);
    if (!enabled) {
      for (const [conversationId, selectedName] of this.selectedByConversation) {
        if (selectedName === name) this.selectedByConversation.delete(conversationId);
      }
    }
    return updated;
  }

  public select(conversationId: string, name: string): SelectedKnowledgeSkill | undefined {
    requireNonEmpty(conversationId, 'conversation ID');
    requireNonEmpty(name, 'name');
    const skill = this.skills.get(name);
    if (!skill || !skill.enabled) return undefined;
    const parsed = parseSkill(skill.path);
    const selected = { ...skill, instructions: parsed.instructions };
    this.recordUse(conversationId, name);
    this.selectedByConversation.set(conversationId, name);
    return selected;
  }

  public getSelected(conversationId: string): SelectedKnowledgeSkill | undefined {
    requireNonEmpty(conversationId, 'conversation ID');
    const name = this.selectedByConversation.get(conversationId);
    return name ? this.selectWithoutRecording(conversationId, name) : undefined;
  }

  public createInputRequest(conversationId: string, input: unknown): KnowledgeSkillInputRequest {
    const selected = this.getSelected(conversationId);
    if (!selected) throw new Error(`No enabled knowledge skill is selected for conversation: ${conversationId}`);
    return { conversationId, skillName: selected.name, input: copyStructuredInput(input) };
  }

  private selectWithoutRecording(conversationId: string, name: string): SelectedKnowledgeSkill | undefined {
    const skill = this.skills.get(name);
    if (!skill?.enabled) return undefined;
    const parsed = parseSkill(skill.path);
    return { ...skill, instructions: parsed.instructions };
  }

  private recordUse(conversationId: string, skillName: string): void {
    if (!this.options.operationLog || !this.options.projectId) return;
    this.options.operationLog.appendKnowledgeOperation({
      projectId: this.options.projectId,
      operationKind: 'skill-selected',
      status: 'success',
      detail: { conversationId, skillName },
    });
  }
}
