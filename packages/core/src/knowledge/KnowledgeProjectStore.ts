import type Database from 'better-sqlite3';
import path from 'node:path';
import { createKnowledgeId, normalizeKnowledgePath } from './KnowledgeIds.js';
import type { KnowledgeProjectId } from './KnowledgeTypes.js';

export type KnowledgeProjectStatus = 'active' | 'archived';

export interface KnowledgeProject {
  id: KnowledgeProjectId;
  workspaceRoot: string;
  name: string;
  description: string | null;
  status: KnowledgeProjectStatus;
  roots: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeProjectInput {
  id?: KnowledgeProjectId;
  workspaceRoot: string;
  name: string;
  description?: string | null;
  roots?: string[];
  createdAt?: string;
}

export interface UpdateKnowledgeProjectInput {
  workspaceRoot?: string;
  name?: string;
  description?: string | null;
  roots?: string[];
}

export interface ListKnowledgeProjectsOptions {
  status?: KnowledgeProjectStatus;
}

interface ProjectRow {
  id: string;
  workspace_root: string;
  name: string;
  description: string | null;
  status: KnowledgeProjectStatus;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Knowledge project ${label} must not be empty`);
}

function normalizeWorkspaceRoot(value: string): string {
  requireNonEmpty(value, 'workspace root');
  return path.resolve(value);
}

function normalizeRoots(roots: string[] = []): string[] {
  return [...new Set(roots.map((root) => normalizeKnowledgePath(root)))];
}

export class KnowledgeProjectStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateKnowledgeProjectInput): KnowledgeProject {
    requireNonEmpty(input.name, 'name');
    const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot);
    const roots = normalizeRoots(input.roots);
    const createdAt = input.createdAt ?? nowIso();
    const id = input.id ?? (createKnowledgeId('project') as KnowledgeProjectId);

    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO knowledge_projects
           (id, workspace_root, name, description, status, created_at, updated_at)
           VALUES (@id, @workspaceRoot, @name, @description, 'active', @createdAt, @updatedAt)`,
        )
        .run({ id, workspaceRoot, name: input.name, description: input.description ?? null, createdAt, updatedAt: createdAt });
      this.replaceRoots(id, roots, createdAt);
    });
    create();
    return this.get(id)!;
  }

  get(id: string): KnowledgeProject | undefined {
    requireNonEmpty(id, 'ID');
    const row = this.db
      .prepare(
        `SELECT id, workspace_root, name, description, status, created_at, updated_at
         FROM knowledge_projects WHERE id = ?`,
      )
      .get(id) as ProjectRow | undefined;
    return row ? this.toProject(row) : undefined;
  }

  list(options: ListKnowledgeProjectsOptions = {}): KnowledgeProject[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_root, name, description, status, created_at, updated_at
         FROM knowledge_projects
         ${options.status ? 'WHERE status = @status' : ''}
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(options.status ? { status: options.status } : {}) as ProjectRow[];
    return rows.map((row) => this.toProject(row));
  }

  update(id: string, input: UpdateKnowledgeProjectInput): KnowledgeProject {
    const current = this.requireProject(id);
    const workspaceRoot = input.workspaceRoot === undefined ? current.workspaceRoot : normalizeWorkspaceRoot(input.workspaceRoot);
    const name = input.name === undefined ? current.name : input.name;
    requireNonEmpty(name, 'name');
    const description = input.description === undefined ? current.description : input.description;
    const roots = input.roots === undefined ? current.roots : normalizeRoots(input.roots);
    const updatedAt = nowIso();

    const update = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE knowledge_projects
           SET workspace_root = @workspaceRoot, name = @name, description = @description, updated_at = @updatedAt
           WHERE id = @id`,
        )
        .run({ id, workspaceRoot, name, description, updatedAt });
      if (input.roots !== undefined) this.replaceRoots(id as KnowledgeProjectId, roots, updatedAt);
    });
    update();
    return this.get(id)!;
  }

  archive(id: string): KnowledgeProject {
    this.requireProject(id);
    this.db
      .prepare(`UPDATE knowledge_projects SET status = 'archived', updated_at = ? WHERE id = ?`)
      .run(nowIso(), id);
    return this.get(id)!;
  }

  private requireProject(id: string): KnowledgeProject {
    const project = this.get(id);
    if (!project) throw new Error(`Knowledge project not found: ${id}`);
    return project;
  }

  private replaceRoots(projectId: KnowledgeProjectId, roots: string[], timestamp: string): void {
    this.db.prepare(`DELETE FROM knowledge_project_roots WHERE project_id = ?`).run(projectId);
    const insert = this.db.prepare(
      `INSERT INTO knowledge_project_roots (id, project_id, root_path, created_at, updated_at)
       VALUES (@id, @projectId, @rootPath, @createdAt, @updatedAt)`,
    );
    for (const rootPath of roots) {
      insert.run({ id: createKnowledgeId('root', `${projectId}:${rootPath}`), projectId, rootPath, createdAt: timestamp, updatedAt: timestamp });
    }
  }

  private toProject(row: ProjectRow): KnowledgeProject {
    const roots = this.db
      .prepare(`SELECT root_path FROM knowledge_project_roots WHERE project_id = ? ORDER BY root_path ASC`)
      .all(row.id) as Array<{ root_path: string }>;
    return {
      id: row.id as KnowledgeProjectId,
      workspaceRoot: row.workspace_root,
      name: row.name,
      description: row.description,
      status: row.status,
      roots: roots.map(({ root_path }) => root_path),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
