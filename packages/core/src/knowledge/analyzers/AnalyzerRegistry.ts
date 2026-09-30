import path from 'node:path';
import type { DeterministicExtraction } from '../KnowledgeExtraction.js';
import type { KnowledgeSourceKind } from '../KnowledgeTypes.js';
import {
  classifyUnsupportedSource,
  supportedAnalyzerCoverage,
  unsupportedCoverage,
  type AnalyzerCoverageSummary,
} from './AnalyzerCoverage.js';
import { JavaScriptAnalyzer } from './JavaScriptAnalyzer.js';
import { MarkdownAnalyzer } from './MarkdownAnalyzer.js';
import { PythonAnalyzer } from './PythonAnalyzer.js';
import { TextAnalyzer } from './TextAnalyzer.js';

export interface AnalyzerSelectionInput {
  sourceKind?: KnowledgeSourceKind | null;
  sourcePath?: string | null;
  mimeType?: string | null;
}

export interface AnalyzerInput extends AnalyzerSelectionInput {
  sourceVersionId: string;
  content: string;
}

export interface DeterministicAnalyzer {
  readonly id: string;
  readonly version: string;
  supports(input: AnalyzerSelectionInput): boolean;
  analyze(input: AnalyzerInput): Promise<DeterministicExtraction>;
}

export type AnalyzerResolution =
  | {
      kind: 'supported';
      analyzer: DeterministicAnalyzer;
      coverage: AnalyzerCoverageSummary;
    }
  | {
      kind: 'unsupported';
      coverage: AnalyzerCoverageSummary;
    };

function describeInput(input: AnalyzerSelectionInput): string {
  const mime = input.mimeType?.trim() || 'unknown MIME';
  const extension = input.sourcePath ? path.extname(input.sourcePath).toLowerCase() || 'unknown extension' : 'unknown extension';
  return `${mime} (${extension})`;
}

export class AnalyzerRegistry {
  private readonly analyzers: DeterministicAnalyzer[] = [];

  public register(analyzer: DeterministicAnalyzer): void {
    if (this.analyzers.some((candidate) => candidate.id === analyzer.id && candidate.version === analyzer.version)) {
      throw new Error(`Deterministic analyzer ${analyzer.id}@${analyzer.version} is already registered`);
    }
    this.analyzers.push(analyzer);
  }

  /** Deterministic, non-throwing selection that reports why a source is or is not analyzable. */
  public resolve(input: AnalyzerSelectionInput): AnalyzerResolution {
    const analyzer = this.analyzers.find((candidate) => candidate.supports(input));
    if (!analyzer) {
      return { kind: 'unsupported', coverage: unsupportedCoverage(classifyUnsupportedSource(input), input) };
    }
    return { kind: 'supported', analyzer, coverage: supportedAnalyzerCoverage(analyzer, input) };
  }

  /** Legacy path: throws for unsupported inputs. Prefer `resolve` for coverage-aware callers. */
  public require(input: AnalyzerSelectionInput): DeterministicAnalyzer {
    const resolution = this.resolve(input);
    if (resolution.kind === 'unsupported') {
      throw new Error(`No deterministic analyzer registered for ${describeInput(input)}`);
    }
    return resolution.analyzer;
  }
}

export function createDefaultAnalyzerRegistry(): AnalyzerRegistry {
  const registry = new AnalyzerRegistry();
  registry.register(new PythonAnalyzer());
  registry.register(new JavaScriptAnalyzer());
  registry.register(new MarkdownAnalyzer());
  registry.register(new TextAnalyzer());
  return registry;
}
