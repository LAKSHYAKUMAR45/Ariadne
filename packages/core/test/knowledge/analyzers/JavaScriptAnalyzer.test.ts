import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultAnalyzerRegistry,
  hashDeterministicExtraction,
  JavaScriptAnalyzer,
  offsetToPosition,
  stableExtractionStringify,
  validateDeterministicExtraction,
} from '../../../src/index.js';

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'test/knowledge/fixtures/typescript', name), 'utf8');
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

describe('JavaScriptAnalyzer', () => {
  it('extracts imports, exports, interfaces, classes, implements, methods, functions, calls, and references', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = fixture('service.ts');
    const result = await analyzer.analyze({
      sourceVersionId: 'typescript-source-version',
      sourceKind: 'file',
      sourcePath: 'src/service.ts',
      mimeType: 'text/plain',
      content,
    });

    expect(result.title).toBe('service.ts');
    expect(result.summary).toBe("import type { Disposable } from './contracts';");

    const interfaceSymbol = result.symbols.find((symbol) => symbol.kind === 'interface' && symbol.name === 'ServiceConfig');
    const classSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'DeviceService');
    const startMethod = result.symbols.find((symbol) => symbol.kind === 'method' && symbol.qualifiedName === 'service.DeviceService.start');
    const functionSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'buildService');

    expect(interfaceSymbol).toEqual(
      expect.objectContaining({
        qualifiedName: 'service.ServiceConfig',
        confidence: 1,
        span: expectedSpan(content, 'export interface ServiceConfig {'),
      }),
    );
    expect(classSymbol).toEqual(
      expect.objectContaining({
        qualifiedName: 'service.DeviceService',
        confidence: 1,
        span: expectedSpan(content, 'export class DeviceService extends BaseService implements Disposable {'),
      }),
    );
    expect(functionSymbol).toEqual(
      expect.objectContaining({
        qualifiedName: 'service.buildService',
        confidence: 1,
        signature: 'buildService(config: ServiceConfig): DeviceService',
      }),
    );

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'imports',
          sourceSymbolId: null,
          targetSymbolId: null,
          targetReference: './contracts#Disposable',
          confidence: 1,
          span: expectedSpan(content, "Disposable } from './contracts'"),
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: interfaceSymbol?.id,
          targetSymbolId: null,
          targetReference: 'ServiceConfig',
          confidence: 1,
        }),
        expect.objectContaining({
          type: 'inherits',
          sourceSymbolId: classSymbol?.id,
          targetSymbolId: result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'BaseService')?.id,
          targetReference: null,
          confidence: 1,
          span: expectedSpan(content, 'BaseService', 2),
        }),
        expect.objectContaining({
          type: 'implements',
          sourceSymbolId: classSymbol?.id,
          targetSymbolId: null,
          targetReference: 'Disposable',
          confidence: 1,
          span: expectedSpan(content, 'Disposable', 2),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: startMethod?.id,
          targetSymbolId: null,
          targetReference: 'createLogger',
          confidence: 1,
          span: expectedSpan(content, 'createLogger(this.config.name)'),
        }),
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: functionSymbol?.id,
          targetSymbolId: interfaceSymbol?.id,
          targetReference: null,
          confidence: 1,
          span: expectedSpan(content, 'ServiceConfig', 3),
        }),
      ]),
    );

    for (const record of [...result.sections, ...result.symbols, ...result.relationships]) {
      expect(record.confidence).toBe(1);
    }

    const rerun = await analyzer.analyze({
      sourceVersionId: 'typescript-source-version',
      sourceKind: 'file',
      sourcePath: 'src/service.ts',
      mimeType: 'text/plain',
      content,
    });
    expect(stableExtractionStringify(rerun)).toBe(stableExtractionStringify(result));
    expect(hashDeterministicExtraction(rerun)).toBe(hashDeterministicExtraction(result));
    expect(validateDeterministicExtraction(result)).toEqual(result);
  });

  it('selects TypeScript and JSX dialects from file extensions and preserves CRLF spans', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'type Props = { title: string };',
      'export function Panel(props: Props) {',
      '  return <section>{props.title}</section>;',
      '}',
      '',
    ].join('\r\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'tsx-source-version',
      sourceKind: 'file',
      sourcePath: 'src/Panel.tsx',
      mimeType: 'text/plain',
      content,
    });

    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'type', qualifiedName: 'Panel.Props', confidence: 1 }),
        expect.objectContaining({
          kind: 'function',
          qualifiedName: 'Panel.Panel',
          confidence: 1,
          span: expectedSpan(content, 'export function Panel(props: Props) {'),
        }),
      ]),
    );
    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          targetReference: null,
          confidence: 1,
          span: expectedSpan(content, 'Props', 2),
        }),
      ]),
    );
  });

  it('registers JavaScript and TypeScript sources by extension and MIME type', () => {
    const registry = createDefaultAnalyzerRegistry();

    expect(registry.require({ sourcePath: 'src/service.ts', mimeType: 'application/typescript' }).id).toBe(
      'javascript-lezer',
    );
    expect(registry.require({ sourcePath: 'src/view.jsx', mimeType: 'text/javascript' }).id).toBe('javascript-lezer');
    expect(registry.require({ sourcePath: 'src/module.cjs', mimeType: 'application/javascript' }).id).toBe(
      'javascript-lezer',
    );
  });
});
