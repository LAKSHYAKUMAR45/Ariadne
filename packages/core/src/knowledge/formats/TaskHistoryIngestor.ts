import { normalizeKnowledgePath } from '../KnowledgeIds.js';
import type { ExtractedSource, IngestInput, KnowledgeIngestor } from './IngestTypes.js';
import { baseExtraction } from './IngestTypes.js';

interface TaskEntity {
  id: string;
  title?: string;
  goal?: string | null;
}

interface HistoryPayload {
  task?: TaskEntity;
  checkpoints?: Array<{ id: string; summary: string }>;
  decisions?: Array<{ id: string; text: string }>;
  todos?: Array<{ id: string; text: string }>;
  errors?: Array<{ id: string; message: string }>;
}

function readHistory(content: string): HistoryPayload {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') throw new Error('Task history must be a JSON object');
    return parsed as HistoryPayload;
  } catch (error) {
    throw new Error(`Invalid task history: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class TaskHistoryIngestor implements KnowledgeIngestor {
  supports(input: IngestInput): boolean {
    return input.sourceKind === 'task_history' || input.path?.includes('task-history') === true;
  }

  async extract(input: IngestInput): Promise<ExtractedSource> {
    if (input.path) normalizeKnowledgePath(input.path);
    const payload = readHistory(input.content);
    const result = baseExtraction(input, '');
    const entities: Array<{ kind: string; id: string; label: string }> = [];
    const lines: string[] = [];
    const add = (kind: string, entity: { id: string; label: string }): void => {
      entities.push({ kind, ...entity });
      lines.push(`${kind}: ${entity.label}`);
      result.provenance.push({ kind: kind as 'task' | 'checkpoint' | 'decision', id: entity.id });
    };

    if (payload.task?.id && payload.task.title) add('task', { id: payload.task.id, label: payload.task.title });
    for (const checkpoint of payload.checkpoints ?? []) add('checkpoint', { id: checkpoint.id, label: checkpoint.summary });
    for (const decision of payload.decisions ?? []) add('decision', { id: decision.id, label: decision.text });
    for (const todo of payload.todos ?? []) add('todo', { id: todo.id, label: todo.text });
    for (const error of payload.errors ?? []) add('error', { id: error.id, label: error.message });

    result.text = lines.join('\n');
    result.normalizedText = result.text;
    result.metadata.entities = entities;
    return result;
  }
}
