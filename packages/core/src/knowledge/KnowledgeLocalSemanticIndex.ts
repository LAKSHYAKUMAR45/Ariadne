import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import { markLocalSemanticModelStale } from './KnowledgeLocalSemanticInvalidation.js';
import {
  DEFAULT_SEMANTIC_LIMITS,
  KNOWLEDGE_SEMANTIC_MODEL_VERSION,
  MAX_EXPANSION_CANDIDATES,
  MAX_EXPANSION_TERMS,
  SEMANTIC_VECTOR_DIMENSION,
  buildSemanticModel,
  cosineSimilarity,
  dampenedNeighborWeight,
  isSemanticToken,
  projectWeights,
  type ProjectedVector,
  type SemanticLimits,
  type SemanticSourceInput,
} from './KnowledgeLocalSemanticProjection.js';
import {
  KNOWLEDGE_SEARCH_INDEX_VERSION,
  KnowledgeSearchIndex,
  MAX_RESULT_CANDIDATES,
  MAX_SEARCH_FIELDS,
} from './KnowledgeSearchIndex.js';

export {
  KNOWLEDGE_SEMANTIC_MODEL_VERSION,
  MAX_COOCCURRENCE_PAIRS,
  MAX_EXPANSION_CANDIDATES,
  MAX_EXPANSION_TERMS,
  MAX_MODEL_SOURCES,
  MAX_NEIGHBOR_TERMS,
  MAX_NEIGHBORS_PER_TERM,
  SEMANTIC_VECTOR_DIMENSION,
} from './KnowledgeLocalSemanticProjection.js';

export const SEMANTIC_REBUILD_LEASE_MS = 5 * 60 * 1000;
/** Largest candidate pool a single scoring call reads vectors for. */
export const MAX_SCORED_CANDIDATES = MAX_RESULT_CANDIDATES + MAX_EXPANSION_CANDIDATES;
const MAX_LOOKUP_TERMS = 64;

/** Stored `model_version`: it also encodes the search index version, so bumping either makes a model unusable. */
export function semanticModelStorageVersion(): number {
  return KNOWLEDGE_SEMANTIC_MODEL_VERSION * 1000 + KNOWLEDGE_SEARCH_INDEX_VERSION;
}

export type LocalSemanticState = 'absent' | 'building' | 'active' | 'stale' | 'incompatible';

export interface LocalSemanticStatus {
  projectId: string;
  state: LocalSemanticState;
  /** True only for an active, version-compatible model; anything else means lexical-only search. */
  usable: boolean;
  modelId: string | null;
  modelVersion: number | null;
  sourceCount: number;
  vectorCount: number;
  neighborCount: number;
  builtAt: string | null;
  rebuildInProgress: boolean;
}

export interface LocalSemanticRebuildReport {
  projectId: string;
  modelId: string;
  outcome: 'activated' | 'superseded_during_build';
  sourceCount: number;
  vectorCount: number;
  neighborCount: number;
  neighborTermCount: number;
  /** Indexed sources left out because the model is bounded to `maxModelSources`. */
  skippedSources: number;
}

export interface LocalSemanticExpansionQuery {
  projectId: string;
  terms: readonly string[];
}

export interface LocalSemanticExpansion {
  terms: Array<{ term: string; fromTerm: string; weight: number }>;
}

export interface LocalSemanticQuery {
  projectId: string;
  queryTerms: readonly string[];
  expansionTerms?: ReadonlyArray<{ term: string; weight: number }>;
  sourceVersionIds: readonly string[];
}

export interface LocalSemanticCandidateScore {
  sourceVersionId: string;
  score: number;
}

export interface KnowledgeLocalSemanticIndexOptions {
  now?: () => string;
  leaseMs?: number;
  limits?: Partial<SemanticLimits>;
  /** Runs after the build transaction and before activation; a seam for observing or interleaving a rebuild. */
  beforeActivate?: (context: { projectId: string; modelId: string }) => void;
}

interface ModelRow {
  id: string;
  model_version: number;
  status: 'building' | 'active' | 'stale';
  source_count: number;
  built_at: string | null;
  lease_expires_at: string | null;
}

function requireProjectId(projectId: string): string {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new Error('Knowledge local semantic index project ID must not be empty');
  }
  return projectId;
}

function semanticError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Project-local, providerless semantic model. Everything here is derived from redacted search-index fields and is
 * rebuildable; queries read only the active model through indexed lookups and never scan the corpus.
 */
export class KnowledgeLocalSemanticIndex {
  private readonly now: () => string;
  private readonly leaseMs: number;
  private readonly limits: SemanticLimits;

  public constructor(
    private readonly db: Database.Database,
    private readonly options: KnowledgeLocalSemanticIndexOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseMs = options.leaseMs ?? SEMANTIC_REBUILD_LEASE_MS;
    this.limits = { ...DEFAULT_SEMANTIC_LIMITS, ...options.limits };
  }

  public markStale(projectId: string): void {
    markLocalSemanticModelStale(this.db, requireProjectId(projectId), this.now());
  }

  public getStatus(projectId: string): LocalSemanticStatus {
    const scopedProjectId = requireProjectId(projectId);
    const rows = this.db
      .prepare(
        `SELECT id, model_version, status, source_count, built_at, lease_expires_at
         FROM knowledge_search_semantic_models WHERE project_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(scopedProjectId) as ModelRow[];
    const active = rows.find((row) => row.status === 'active');
    const stale = rows.find((row) => row.status === 'stale');
    const building = rows.some((row) => row.status === 'building');
    const model = active ?? stale ?? null;
    const state: LocalSemanticState = active
      ? active.model_version === semanticModelStorageVersion()
        ? 'active'
        : 'incompatible'
      : stale
        ? 'stale'
        : building
          ? 'building'
          : 'absent';
    const counts = model
      ? {
          vectors: this.count('knowledge_search_semantic_vectors', scopedProjectId, model.id),
          neighbors: this.count('knowledge_search_semantic_neighbors', scopedProjectId, model.id),
        }
      : { vectors: 0, neighbors: 0 };
    return {
      projectId: scopedProjectId,
      state,
      usable: state === 'active',
      modelId: model?.id ?? null,
      modelVersion: model?.model_version ?? null,
      sourceCount: model?.source_count ?? 0,
      vectorCount: counts.vectors,
      neighborCount: counts.neighbors,
      builtAt: model?.built_at ?? null,
      rebuildInProgress: building,
    };
  }

  /** The active, version-compatible model id, or null when queries must stay lexical-only. */
  public getUsableModelId(projectId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM knowledge_search_semantic_models
         WHERE project_id = ? AND status = 'active' AND model_version = ?`,
      )
      .get(requireProjectId(projectId), semanticModelStorageVersion()) as { id: string } | undefined;
    return row?.id ?? null;
  }

  public replaceForProject(projectId: string): LocalSemanticRebuildReport {
    const scopedProjectId = requireProjectId(projectId);
    const modelId = this.reserveBuild(scopedProjectId);
    try {
      const built = this.buildModel(scopedProjectId, modelId);
      this.options.beforeActivate?.({ projectId: scopedProjectId, modelId });
      const outcome = this.activate(scopedProjectId, modelId);
      return { projectId: scopedProjectId, modelId, outcome, ...built };
    } catch (error) {
      this.db.prepare(`DELETE FROM knowledge_search_semantic_models WHERE id = ? AND status = 'building'`).run(modelId);
      throw error;
    }
  }

  public expandQueryTerms(input: LocalSemanticExpansionQuery): LocalSemanticExpansion {
    const projectId = requireProjectId(input.projectId);
    const modelId = this.getUsableModelId(projectId);
    const queryTerms = [...new Set(input.terms.filter(isSemanticToken))].slice(0, MAX_LOOKUP_TERMS);
    if (!modelId || queryTerms.length === 0) return { terms: [] };
    const lookup = this.db.prepare(
      `SELECT neighbor_term, weight FROM knowledge_search_semantic_neighbors
       WHERE project_id = ? AND model_id = ? AND term = ?
       ORDER BY neighbor_rank ASC LIMIT ?`,
    );
    const excluded = new Set(queryTerms);
    const best = new Map<string, { term: string; fromTerm: string; weight: number }>();
    for (const fromTerm of queryTerms) {
      const rows = lookup.all(projectId, modelId, fromTerm, MAX_LOOKUP_TERMS) as Array<{ neighbor_term: string; weight: number }>;
      for (const row of rows) {
        if (excluded.has(row.neighbor_term)) continue;
        const known = best.get(row.neighbor_term);
        if (!known || row.weight > known.weight) {
          best.set(row.neighbor_term, { term: row.neighbor_term, fromTerm, weight: row.weight });
        }
      }
    }
    return {
      terms: [...best.values()]
        .sort((left, right) => right.weight - left.weight || (left.term < right.term ? -1 : 1))
        .slice(0, MAX_EXPANSION_TERMS),
    };
  }

  public rankCandidates(input: LocalSemanticQuery): LocalSemanticCandidateScore[] {
    const projectId = requireProjectId(input.projectId);
    const modelId = this.getUsableModelId(projectId);
    if (!modelId) return [];
    const weights = new Map<string, number>();
    for (const term of input.queryTerms) {
      if (isSemanticToken(term)) weights.set(term, 1);
    }
    for (const expansion of input.expansionTerms ?? []) {
      if (isSemanticToken(expansion.term) && !weights.has(expansion.term)) {
        weights.set(expansion.term, dampenedNeighborWeight(expansion.weight));
      }
    }
    const query = projectWeights(weights);
    const versionIds = [...new Set(input.sourceVersionIds)].slice(0, MAX_SCORED_CANDIDATES);
    if (!query || versionIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT source_version_id, vector_json, norm FROM knowledge_search_semantic_vectors
         WHERE project_id = ? AND model_id = ?
           AND source_version_id IN (SELECT value FROM json_each(?))`,
      )
      .all(projectId, modelId, JSON.stringify(versionIds)) as Array<{ source_version_id: string; vector_json: string; norm: number }>;
    const scores: LocalSemanticCandidateScore[] = [];
    for (const row of rows) {
      const candidate = parseStoredVector(row.vector_json, row.norm);
      if (candidate) scores.push({ sourceVersionId: row.source_version_id, score: cosineSimilarity(query, candidate) });
    }
    return scores.sort((left, right) => right.score - left.score || (left.sourceVersionId < right.sourceVersionId ? -1 : 1));
  }

  private count(table: 'knowledge_search_semantic_vectors' | 'knowledge_search_semantic_neighbors', projectId: string, modelId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ? AND model_id = ?`)
      .get(projectId, modelId) as { count: number };
    return row.count;
  }

  /** Reclaims an expired or invalidated build, then reserves the single building slot or fails fast. */
  private reserveBuild(projectId: string): string {
    return this.db.transaction((): string => {
      const project = this.db.prepare('SELECT 1 AS present FROM knowledge_projects WHERE id = ?').get(projectId);
      if (!project) throw new Error(`Knowledge project not found: ${projectId}`);
      const timestamp = this.now();
      this.db
        .prepare(
          `DELETE FROM knowledge_search_semantic_models
           WHERE project_id = ? AND status = 'building' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        )
        .run(projectId, timestamp);
      const held = this.db
        .prepare(`SELECT 1 AS held FROM knowledge_search_semantic_models WHERE project_id = ? AND status = 'building'`)
        .get(projectId);
      if (held) {
        throw semanticError('semantic_rebuild_in_progress', 'another semantic rebuild holds this project');
      }
      const modelId = createKnowledgeId('semantic_model');
      this.db
        .prepare(
          `INSERT INTO knowledge_search_semantic_models
             (id, project_id, model_version, status, source_count, built_at, lease_expires_at, created_at, updated_at)
           VALUES (@id, @projectId, @modelVersion, 'building', 0, NULL, @lease, @now, @now)`,
        )
        .run({
          id: modelId,
          projectId,
          modelVersion: semanticModelStorageVersion(),
          lease: new Date(Date.parse(timestamp) + this.leaseMs).toISOString(),
          now: timestamp,
        });
      return modelId;
    }).immediate();
  }

  private buildModel(
    projectId: string,
    modelId: string,
  ): Pick<LocalSemanticRebuildReport, 'sourceCount' | 'vectorCount' | 'neighborCount' | 'neighborTermCount' | 'skippedSources'> {
    return this.db.transaction(() => {
      const searchIndex = new KnowledgeSearchIndex(this.db);
      const indexed = searchIndex.getStatus(projectId).indexedCount;
      const usable = searchIndex.listUsableIndexes(projectId, this.limits.maxModelSources);
      const readFields = this.db.prepare(
        `SELECT field_text FROM knowledge_search_index_fields
         WHERE project_id = ? AND index_id = ? ORDER BY field_order ASC LIMIT ?`,
      );
      const inputs: SemanticSourceInput[] = usable.map((entry) => ({
        sourceVersionId: entry.sourceVersionId,
        windows: (readFields.all(projectId, entry.indexId, MAX_SEARCH_FIELDS) as Array<{ field_text: string }>).map(
          (row) => row.field_text,
        ),
      }));
      const model = buildSemanticModel(inputs, this.limits);
      const timestamp = this.now();
      const insertVector = this.db.prepare(
        `INSERT INTO knowledge_search_semantic_vectors (id, project_id, model_id, source_version_id, vector_json, norm, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of model.vectors) {
        insertVector.run(
          createKnowledgeId('semantic_vector', `${modelId}:${entry.sourceVersionId}`),
          projectId,
          modelId,
          entry.sourceVersionId,
          JSON.stringify(entry.vector),
          entry.norm,
          timestamp,
        );
      }
      const insertNeighbor = this.db.prepare(
        `INSERT INTO knowledge_search_semantic_neighbors (id, project_id, model_id, term, neighbor_term, neighbor_rank, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const neighbor of model.neighbors) {
        insertNeighbor.run(
          createKnowledgeId('semantic_neighbor', `${modelId}:${neighbor.term}:${neighbor.neighborTerm}`),
          projectId,
          modelId,
          neighbor.term,
          neighbor.neighborTerm,
          neighbor.rank,
          neighbor.weight,
        );
      }
      this.db
        .prepare('UPDATE knowledge_search_semantic_models SET source_count = ?, updated_at = ? WHERE id = ? AND project_id = ?')
        .run(usable.length, timestamp, modelId, projectId);
      return {
        sourceCount: usable.length,
        vectorCount: model.vectors.length,
        neighborCount: model.neighbors.length,
        neighborTermCount: new Set(model.neighbors.map((neighbor) => neighbor.term)).size,
        skippedSources: Math.max(0, indexed - usable.length),
      };
    }).immediate();
  }

  /** Swaps the built model in, or leaves it stale when the index changed during the build. */
  private activate(projectId: string, modelId: string): LocalSemanticRebuildReport['outcome'] {
    return this.db.transaction((): LocalSemanticRebuildReport['outcome'] => {
      const row = this.db
        .prepare('SELECT status, lease_expires_at FROM knowledge_search_semantic_models WHERE id = ? AND project_id = ?')
        .get(modelId, projectId) as { status: string; lease_expires_at: string | null } | undefined;
      if (!row || row.status !== 'building') {
        throw semanticError('semantic_rebuild_reclaimed', 'the building model was reclaimed before activation');
      }
      const superseded = row.lease_expires_at === null;
      const timestamp = this.now();
      this.db
        .prepare(`DELETE FROM knowledge_search_semantic_models WHERE project_id = ? AND id <> ? AND status IN ('active', 'stale')`)
        .run(projectId, modelId);
      this.db
        .prepare(
          `UPDATE knowledge_search_semantic_models
           SET status = ?, built_at = ?, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND project_id = ?`,
        )
        .run(superseded ? 'stale' : 'active', superseded ? null : timestamp, timestamp, modelId, projectId);
      return superseded ? 'superseded_during_build' : 'activated';
    }).immediate();
  }
}

function parseStoredVector(vectorJson: string, norm: number): ProjectedVector | null {
  try {
    const vector: unknown = JSON.parse(vectorJson);
    if (
      !Array.isArray(vector) ||
      vector.length !== SEMANTIC_VECTOR_DIMENSION ||
      !vector.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      !Number.isFinite(norm) ||
      norm <= 0
    ) {
      return null;
    }
    return { vector: vector as number[], norm };
  } catch {
    return null;
  }
}
