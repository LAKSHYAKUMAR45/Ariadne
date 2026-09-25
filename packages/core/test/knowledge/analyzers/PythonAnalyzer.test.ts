import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultAnalyzerRegistry,
  hashDeterministicExtraction,
  offsetToPosition,
  PythonAnalyzer,
  stableExtractionStringify,
  validateDeterministicExtraction,
} from '../../../src/index.js';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'test/knowledge/fixtures/python', name), 'utf8');
}

function expectedSpan(content: string, snippet: string, occurrence = 1) {
  let startOffset = -1;
  let searchFrom = 0;
  for (let index = 0; index < occurrence; index += 1) {
    startOffset = content.indexOf(snippet, searchFrom);
    if (startOffset === -1) {
      throw new Error(`Could not find occurrence ${occurrence} of snippet: ${snippet}`);
    }
    searchFrom = startOffset + 1;
  }
  const endOffset = startOffset + snippet.length;
  const start = offsetToPosition(content, startOffset);
  const end = offsetToPosition(content, endOffset);
  return {
    startOffset,
    endOffset,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

describe('PythonAnalyzer', () => {
  it('extracts imports, constants, classes, methods, decorators, annotations, references, and unresolved calls with exact spans', async () => {
    const analyzer = new PythonAnalyzer();
    const content = fixture('jcnr_device_sample.py');
    const result = await analyzer.analyze({
      sourceVersionId: 'python-source-version',
      sourceKind: 'file',
      sourcePath: 'Libs/TaskManagers/JCNR/jcnr_device.py',
      mimeType: 'text/x-python',
      content,
    });

    expect(result.title).toBe('jcnr_device.py');
    expect(result.summary).toBe('"""JCNR device helpers."""');

    const classSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'JCNRDevice');
    expect(classSymbol).toEqual(
      expect.objectContaining({
        kind: 'class',
        name: 'JCNRDevice',
        qualifiedName: 'jcnr_device.JCNRDevice',
        confidence: 1,
        span: expectedSpan(content, 'class JCNRDevice(BaseDevice):'),
        metadata: expect.objectContaining({
          docstring: 'Represents a JCNR device.',
          decorators: ['logged'],
        }),
      }),
    );

    const constantSymbol = result.symbols.find((symbol) => symbol.kind === 'constant' && symbol.name === 'DEVICE_KIND');
    expect(constantSymbol).toEqual(
      expect.objectContaining({
        qualifiedName: 'jcnr_device.DEVICE_KIND',
        confidence: 1,
        span: expectedSpan(content, 'DEVICE_KIND = "leaf"'),
      }),
    );

    const connectMethod = result.symbols.find((symbol) => symbol.kind === 'method' && symbol.qualifiedName === 'jcnr_device.JCNRDevice.connect');
    expect(connectMethod).toEqual(
      expect.objectContaining({
        name: 'connect',
        confidence: 1,
        metadata: expect.objectContaining({
          docstring: 'Connect to the fabric interface.',
          annotations: ['endpoint: str', 'return: None'],
        }),
      }),
    );

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'inherits',
          sourceSymbolId: classSymbol?.id,
          targetSymbolId: result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'BaseDevice')?.id,
          targetReference: null,
          confidence: 1,
          span: expectedSpan(content, 'BaseDevice', 2),
        }),
        expect.objectContaining({
          type: 'contains',
          sourceSymbolId: classSymbol?.id,
          targetSymbolId: connectMethod?.id,
          targetReference: null,
          confidence: 1,
        }),
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: classSymbol?.id,
          targetSymbolId: constantSymbol?.id,
          targetReference: null,
          confidence: 1,
          span: expectedSpan(content, 'DEVICE_KIND', 2),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: connectMethod?.id,
          targetSymbolId: null,
          targetReference: 'JCNRFabricInterface',
          confidence: 1,
          span: expectedSpan(content, 'JCNRFabricInterface(endpoint)'),
        }),
      ]),
    );

    for (const record of [...result.sections, ...result.symbols, ...result.relationships]) {
      expect(record.confidence).toBe(1);
      expect(record.span ?? result.sections[0]?.span).toBeTruthy();
    }

    const rerun = await analyzer.analyze({
      sourceVersionId: 'python-source-version',
      sourceKind: 'file',
      sourcePath: 'Libs/TaskManagers/JCNR/jcnr_device.py',
      mimeType: 'text/x-python',
      content,
    });
    expect(stableExtractionStringify(rerun)).toBe(stableExtractionStringify(result));
    expect(hashDeterministicExtraction(rerun)).toBe(hashDeterministicExtraction(result));
    expect(validateDeterministicExtraction(result)).toEqual(result);
  });

  it('preserves exact CRLF spans and parser diagnostics for malformed-but-parseable source', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'import os',
      '',
      'class Example:',
      '    def broken(self):',
      '        value = missing(',
      '        return value',
      '',
    ].join('\r\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-crlf',
      sourceKind: 'file',
      sourcePath: 'example.py',
      mimeType: 'text/x-python',
      content,
    });

    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'class',
          qualifiedName: 'example.Example',
          confidence: 1,
          span: expectedSpan(content, 'class Example:'),
        }),
      ]),
    );
    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          targetReference: 'missing',
          targetSymbolId: null,
          confidence: 1,
          span: expectedSpan(content, 'missing('),
        }),
      ]),
    );
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity !== 'error')).toBe(true);
  });

  it('registers python sources by extension and MIME type', () => {
    const registry = createDefaultAnalyzerRegistry();

    expect(registry.require({ sourcePath: 'module.py', mimeType: 'text/plain' }).id).toBe('python-lezer');
    expect(registry.require({ sourcePath: 'module.pyi', mimeType: 'text/x-python' }).id).toBe('python-lezer');
    expect(() => registry.require({ sourcePath: 'module.rb', mimeType: 'application/x-ruby' })).toThrow(
      /no deterministic analyzer/i,
    );
  });
});
