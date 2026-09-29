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
