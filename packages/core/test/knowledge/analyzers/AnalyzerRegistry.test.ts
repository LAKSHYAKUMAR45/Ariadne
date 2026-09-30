import { describe, expect, it } from 'vitest';
import { AnalyzerRegistry, createDefaultAnalyzerRegistry } from '../../../src/knowledge/analyzers/index.js';
import type { AnalyzerInput, AnalyzerSelectionInput, DeterministicAnalyzer } from '../../../src/knowledge/analyzers/index.js';

class StubAnalyzer implements DeterministicAnalyzer {
  public constructor(
    public readonly id: string,
    public readonly version: string,
    private readonly supported: boolean,
  ) {}

  public supports(_input: AnalyzerSelectionInput): boolean {
    return this.supported;
  }

  public async analyze(input: AnalyzerInput) {
    return {
      analyzerId: this.id,
      analyzerVersion: this.version,
      sourceVersionId: input.sourceVersionId,
      title: input.sourcePath ?? input.sourceVersionId,
      summary: '',
      sections: [],
      symbols: [],
      relationships: [],
      links: [],
      diagnostics: [],
    };
  }
}

describe('AnalyzerRegistry', () => {
  it('rejects duplicate analyzer registrations for the same id and version', () => {
    const registry = new AnalyzerRegistry();
    registry.register(new StubAnalyzer('text', '1.0.0', false));

    expect(() => registry.register(new StubAnalyzer('text', '1.0.0', true))).toThrow(/already registered/i);
  });

  it('selects the first matching analyzer deterministically', () => {
    const registry = new AnalyzerRegistry();
    const first = new StubAnalyzer('first', '1.0.0', true);
    const second = new StubAnalyzer('second', '1.0.0', true);
    registry.register(first);
    registry.register(second);

    expect(registry.require({ sourcePath: 'docs/example.txt', mimeType: 'text/plain' })).toBe(first);
  });

  it('rejects unsupported extensions when no deterministic analyzer matches', () => {
    const registry = createDefaultAnalyzerRegistry();

    expect(() => registry.require({ sourcePath: 'scripts/example.rb', mimeType: 'application/x-ruby' })).toThrow(
      /no deterministic analyzer/i,
    );
  });
});
