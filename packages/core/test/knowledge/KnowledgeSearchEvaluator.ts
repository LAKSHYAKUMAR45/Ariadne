import type Database from 'better-sqlite3';

export interface KnowledgeAccuracyQuestion {
  id: string;
  prompt: string;
  expectedPaths: string[];
  expectedSymbols: string[];
  required: boolean;
}

export interface KnowledgeAccuracyCorpus {
  corpusVersion: string;
  questions: KnowledgeAccuracyQuestion[];
}

export interface KnowledgeAccuracyFailure {
  id: string;
  prompt: string;
  expectedPaths: string[];
  returnedPaths: string[];
  missing: string[];
}

export interface KnowledgeAccuracyReport {
  corpusVersion: string;
  questionCount: number;
  top1PathHits: number;
  top3PathHits: number;
  spanCitationHits: number;
  typedGraphEvidenceHits: number;
  failures: KnowledgeAccuracyFailure[];
}

export interface KnowledgeAccuracySearchResult {
  title: string;
  citations: ReadonlyArray<{ span: unknown }>;
}

interface ProjectedKnowledgeAccuracyResult {
  title: string;
  hasSpanCitation: boolean;
}

interface GraphEvidenceRow {
  node_type: string;
  edge_type: string;
  evidence_json: string;
}

const TYPED_EDGE_TYPES = new Set(['calls', 'contains', 'defines', 'imports', 'inherits', 'references']);
const TYPED_EVIDENCE_TYPES = new Set(['explicit_link', 'semantic_relationship']);

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return trimmed;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function parseStringArray(
  value: unknown,
  label: string,
  options?: { minLength?: number },
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const entries = value.map((item, index) => expectString(item, `${label}[${index}]`));
  if ((options?.minLength ?? 0) > entries.length) {
    throw new Error(`${label} must contain at least ${options?.minLength ?? 0} item(s)`);
  }
  return [...entries];
}

function parseQuestion(value: unknown, index: number): KnowledgeAccuracyQuestion {
  const candidate = expectObject(value, `questions[${index}]`);
  const id = expectString(candidate.id, `questions[${index}].id`);
  const prompt = expectString(candidate.prompt, `questions[${index}].prompt`);
  const expectedPaths = parseStringArray(candidate.expectedPaths, `questions[${index}].expectedPaths`, { minLength: 1 });
  const expectedSymbols = parseStringArray(candidate.expectedSymbols, `questions[${index}].expectedSymbols`);
  const required = expectBoolean(candidate.required, `questions[${index}].required`);
  return {
    id,
    prompt,
    expectedPaths,
    expectedSymbols,
    required,
  };
}

export function parseKnowledgeAccuracyCorpus(input: unknown): KnowledgeAccuracyCorpus {
  const candidate = expectObject(input, 'knowledge accuracy corpus');
  const corpusVersion = expectString(candidate.corpusVersion, 'corpusVersion');
  const questionsValue = candidate.questions;
  if (!Array.isArray(questionsValue)) {
    throw new Error('questions must be an array');
  }

  const questions: KnowledgeAccuracyQuestion[] = [];
  const seenIds = new Set<string>();
  for (const [index, question] of questionsValue.entries()) {
    const parsed = parseQuestion(question, index);
    if (seenIds.has(parsed.id)) {
      throw new Error(`Found duplicate question id "${parsed.id}"`);
    }
    seenIds.add(parsed.id);
    questions.push(parsed);
  }

  return {
    corpusVersion,
    questions: [...questions],
  };
}

function hasNonNullSpan(result: KnowledgeAccuracySearchResult): boolean {
  return result.citations.some((citation) => citation.span !== null);
}

function projectKnowledgeAccuracyResults(
  results: readonly KnowledgeAccuracySearchResult[],
): ProjectedKnowledgeAccuracyResult[] {
  return results.map((result) => ({
    title: result.title,
    hasSpanCitation: hasNonNullSpan(result),
  }));
}

export function hasKnowledgeTypedGraphEvidence(
  db: Database.Database,
  options: {
    projectId: string;
    sourcePath: string;
    expectedSymbols: readonly string[];
  },
): boolean {
  const { expectedSymbols, projectId, sourcePath } = options;
  if (expectedSymbols.length === 0) return false;

  const placeholders = expectedSymbols.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT node.node_type, edge.edge_type, edge.evidence_json
     FROM knowledge_graph_nodes node
     JOIN knowledge_sources source
       ON source.project_id = node.project_id
      AND source.source_path = ?
     JOIN knowledge_source_versions version
       ON version.project_id = source.project_id
      AND version.source_id = source.id
      AND version.id = node.source_version_id
     JOIN knowledge_graph_edges edge
       ON edge.project_id = node.project_id
      AND (edge.source_node_id = node.id OR edge.target_node_id = node.id)
     WHERE node.project_id = ?
       AND node.label IN (${placeholders})`,
  ).all(sourcePath, projectId, ...expectedSymbols) as GraphEvidenceRow[];

  return rows.some((row) => {
    if (!['class', 'function', 'method', 'module'].includes(row.node_type)) return false;
    if (!TYPED_EDGE_TYPES.has(row.edge_type)) return false;
    const storedEvidence: unknown = JSON.parse(row.evidence_json);
    if (typeof storedEvidence !== 'object' || storedEvidence === null || Array.isArray(storedEvidence)) return false;
    const evidence = (storedEvidence as { evidence?: unknown }).evidence;
    return Array.isArray(evidence) && evidence.some(
      (kind) => typeof kind === 'string' && TYPED_EVIDENCE_TYPES.has(kind),
    );
  });
}

export function scoreKnowledgeAccuracy(
  corpus: KnowledgeAccuracyCorpus,
  search: (prompt: string) => readonly KnowledgeAccuracySearchResult[],
  hasTypedGraphEvidence: (question: KnowledgeAccuracyQuestion, path: string) => boolean,
): KnowledgeAccuracyReport {
  let top1PathHits = 0;
  let top3PathHits = 0;
  let spanCitationHits = 0;
  let typedGraphEvidenceHits = 0;
  const failures: KnowledgeAccuracyFailure[] = [];

  for (const question of corpus.questions) {
    if (!question.required) {
      continue;
    }

    const results = projectKnowledgeAccuracyResults(search(question.prompt));
    const returnedPaths = results.map((result) => result.title);
    const expectedPaths = [...question.expectedPaths];

    const top1 = returnedPaths[0] !== undefined && expectedPaths.includes(returnedPaths[0]);
    const top3 = returnedPaths.slice(0, 3).some((path) => expectedPaths.includes(path));
    const spanCitation = results.some((result) => expectedPaths.includes(result.title) && result.hasSpanCitation);

    let typedGraphEvidence = false;
    for (const path of expectedPaths) {
      if (hasTypedGraphEvidence(question, path)) {
        typedGraphEvidence = true;
        break;
      }
    }

    if (top1) top1PathHits += 1;
    if (top3) top3PathHits += 1;
    if (spanCitation) spanCitationHits += 1;
    if (typedGraphEvidence) typedGraphEvidenceHits += 1;

    const missing = [
      top1 ? null : 'top1',
      top3 ? null : 'top3',
      spanCitation ? null : 'spanCitation',
      typedGraphEvidence ? null : 'typedGraphEvidence',
    ].filter((value): value is string => value !== null);

    if (missing.length > 0) {
      failures.push({
        id: question.id,
        prompt: question.prompt,
        expectedPaths,
        returnedPaths,
        missing,
      });
    }
  }

  return {
    corpusVersion: corpus.corpusVersion,
    questionCount: corpus.questions.length,
    top1PathHits,
    top3PathHits,
    spanCitationHits,
    typedGraphEvidenceHits,
    failures,
  };
}
