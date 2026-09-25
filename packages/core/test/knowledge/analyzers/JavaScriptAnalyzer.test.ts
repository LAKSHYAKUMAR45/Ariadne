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
          span: expectedSpan(content, 'Disposable'),
          metadata: {
            importKind: 'named',
            importedName: 'Disposable',
            localName: 'Disposable',
          },
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: interfaceSymbol?.id,
          targetSymbolId: null,
          targetReference: 'ServiceConfig',
          confidence: 1,
          metadata: {
            exportKind: 'declaration',
            localName: 'ServiceConfig',
            exportedName: 'ServiceConfig',
          },
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

  it('extracts mixed default-plus-named imports and export list/default forms with exact spans and alias metadata', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      "import Foo, { bar as baz, qux } from 'm';",
      'const local = qux;',
      'function named() {',
      '  return local;',
      '}',
      'export { local, named as renamed, named as default };',
      "export { thing, source as alias } from 'pkg';",
      'export default function namedDefault() {}',
      'export default function() {}',
      'export default class NamedClass {}',
      'export default class {}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-exports',
      sourceKind: 'file',
      sourcePath: 'src/exports.ts',
      mimeType: 'text/plain',
      content,
    });

    const namedFunction = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'named');
    const namedDefaultFunction = result.symbols.find(
      (symbol) => symbol.kind === 'function' && symbol.name === 'namedDefault',
    );
    const anonymousDefaultFunction = result.symbols.find(
      (symbol) => symbol.kind === 'function' && symbol.name === 'default',
    );
    const namedDefaultClass = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'NamedClass');
    const anonymousDefaultClass = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'default');

    expect(anonymousDefaultFunction).toEqual(
      expect.objectContaining({
        qualifiedName: 'exports.default',
        span: expectedSpan(content, 'export default function() {'),
      }),
    );
    expect(anonymousDefaultClass).toEqual(
      expect.objectContaining({
        qualifiedName: 'exports.default',
        span: expectedSpan(content, 'export default class ', 2),
      }),
    );

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm#default',
          span: expectedSpan(content, 'Foo'),
          metadata: {
            importKind: 'default',
            importedName: 'default',
            localName: 'Foo',
          },
        }),
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm#bar',
          span: expectedSpan(content, 'bar as baz'),
          metadata: {
            importKind: 'named',
            importedName: 'bar',
            localName: 'baz',
          },
        }),
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm#qux',
          span: expectedSpan(content, 'qux'),
          metadata: {
            importKind: 'named',
            importedName: 'qux',
            localName: 'qux',
          },
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: namedFunction?.id,
          targetReference: 'renamed',
          span: expectedSpan(content, 'named as renamed'),
          metadata: {
            exportKind: 'named',
            localName: 'named',
            exportedName: 'renamed',
          },
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: namedFunction?.id,
          targetReference: 'default',
          span: expectedSpan(content, 'named as default'),
          metadata: {
            exportKind: 'named',
            localName: 'named',
            exportedName: 'default',
          },
        }),
        expect.objectContaining({
          type: 'exports',
          targetReference: 'pkg#thing',
          span: expectedSpan(content, 'thing'),
          metadata: {
            exportKind: 'reexport',
            localName: 'thing',
            exportedName: 'thing',
          },
        }),
        expect.objectContaining({
          type: 'exports',
          targetReference: 'pkg#source',
          span: expectedSpan(content, 'source as alias'),
          metadata: {
            exportKind: 'reexport',
            localName: 'source',
            exportedName: 'alias',
          },
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: namedDefaultFunction?.id,
          targetReference: 'default',
          span: expectedSpan(content, 'export default function namedDefault() {'),
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: anonymousDefaultFunction?.id,
          targetReference: 'default',
          span: expectedSpan(content, 'export default function() {'),
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: namedDefaultClass?.id,
          targetReference: 'default',
          span: expectedSpan(content, 'export default class NamedClass {'),
        }),
        expect.objectContaining({
          type: 'exports',
          sourceSymbolId: anonymousDefaultClass?.id,
          targetReference: 'default',
          span: expectedSpan(content, 'export default class ', 2),
        }),
      ]),
    );
  });

  it('extracts default-plus-namespace and default-as-named imports without misresolving imported bindings', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      "import Foo, * as ns from 'm';",
      "import { default as FooAlias } from 'm2';",
      'function ns(): void {}',
      'function run(): void {',
      '  ns();',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-namespace-imports',
      sourceKind: 'file',
      sourcePath: 'src/namespace-imports.ts',
      mimeType: 'text/plain',
      content,
    });

    const nsFunction = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'ns');
    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm#default',
          span: expectedSpan(content, 'Foo'),
          metadata: {
            importKind: 'default',
            importedName: 'default',
            localName: 'Foo',
          },
        }),
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm#*',
          span: expectedSpan(content, '* as ns'),
          metadata: {
            importKind: 'namespace',
            importedName: '*',
            localName: 'ns',
          },
        }),
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm2#default',
          span: expectedSpan(content, 'default as FooAlias'),
          metadata: {
            importKind: 'named',
            importedName: 'default',
            localName: 'FooAlias',
          },
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'ns',
          span: expectedSpan(content, 'ns()', 2),
        }),
      ]),
    );
    expect(result.relationships).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: nsFunction?.id,
          targetReference: null,
          span: expectedSpan(content, 'ns()', 2),
        }),
      ]),
    );
  });

  it('avoids fabricating default imports for namespace syntax and preserves default re-export targets', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      "import * as ns from 'm';",
      "export { default as Foo } from 'pkg';",
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-namespace-reexport',
      sourceKind: 'file',
      sourcePath: 'src/namespace.ts',
      mimeType: 'text/plain',
      content,
    });

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm#*',
          span: expectedSpan(content, '* as ns'),
          metadata: {
            importKind: 'namespace',
            importedName: '*',
            localName: 'ns',
          },
        }),
        expect.objectContaining({
          type: 'exports',
          targetReference: 'pkg#default',
          span: expectedSpan(content, 'default as Foo'),
          metadata: {
            exportKind: 'reexport',
            localName: 'default',
            exportedName: 'Foo',
          },
        }),
      ]),
    );
    expect(result.relationships).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'imports',
          targetReference: 'm#default',
        }),
      ]),
    );
  });

  it('avoids false target resolution when parameters or locals shadow top-level symbols', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'class Service {}',
      'function helper(): void {}',
      'function run(Service: () => void): void {',
      '  Service();',
      '}',
      'function outer(): void {',
      '  const helper = Service;',
      '  helper();',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/shadowing.ts',
      mimeType: 'text/plain',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');
    const outerSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'outer');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'Service',
          span: expectedSpan(content, 'Service()'),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: outerSymbol?.id,
          targetSymbolId: null,
          targetReference: 'helper',
          span: expectedSpan(content, 'helper()', 2),
        }),
      ]),
    );
  });

  it('keeps safe resolutions outside nested block shadowing and leaves block-local shadows unresolved', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'function helper(): void {}',
      'function run(flag: boolean): void {',
      '  helper();',
      '  if (flag) {',
      '    const helper = () => {};',
      '    helper();',
      '  }',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-block-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/block-shadowing.ts',
      mimeType: 'text/plain',
      content,
    });

    const helperSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'helper');
    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: helperSymbol?.id,
          targetReference: null,
          span: expectedSpan(content, 'helper()', 2),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'helper',
          span: expectedSpan(content, 'helper()', 3),
        }),
      ]),
    );
  });

  it('preserves type-space references when only value-space parameters shadow the same name', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'class Service {}',
      'function run(Service: Service): void {}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-type-space',
      sourceKind: 'file',
      sourcePath: 'src/type-space.ts',
      mimeType: 'text/plain',
      content,
    });

    const classSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'Service');
    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: classSymbol?.id,
          targetReference: null,
          span: expectedSpan(content, 'Service', 3),
        }),
      ]),
    );
  });

  it('treats block-scoped for-loop bindings as local shadows', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'function helper(): void {}',
      'function run(xs: Array<() => void>): void {',
      '  for (const helper of xs) {',
      '    helper();',
      '  }',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-for-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/for-shadowing.ts',
      mimeType: 'text/plain',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'helper',
          span: expectedSpan(content, 'helper()', 2),
        }),
      ]),
    );
  });

  it('treats destructured parameter and local bindings as local shadows', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'function helper(): void {}',
      'function fromParam({ helper }: { helper: () => void }): void {',
      '  helper();',
      '}',
      'function fromLocal(source: { helper: () => void }): void {',
      '  const { helper } = source;',
      '  helper();',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-destructuring-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/destructuring-shadowing.ts',
      mimeType: 'text/plain',
      content,
    });

    const fromParamSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'fromParam');
    const fromLocalSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'fromLocal');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: fromParamSymbol?.id,
          targetSymbolId: null,
          targetReference: 'helper',
          span: expectedSpan(content, 'helper()', 2),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: fromLocalSymbol?.id,
          targetSymbolId: null,
          targetReference: 'helper',
          span: expectedSpan(content, 'helper()', 3),
        }),
      ]),
    );
  });

  it('treats type-parameter bindings as local type-space shadows', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'class Service {}',
      'function run<Service>(arg: Service): void {}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-type-parameter-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/type-parameter.ts',
      mimeType: 'text/plain',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'Service',
          span: expectedSpan(content, 'Service', 3),
        }),
      ]),
    );
  });

  it('applies loop bindings even when a for-loop body is a single statement', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'function helper(): void {}',
      'function run(xs: Array<() => void>): void {',
      '  for (const helper of xs)',
      '    helper();',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-single-statement-loop',
      sourceKind: 'file',
      sourcePath: 'src/single-loop.ts',
      mimeType: 'text/plain',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'helper',
          span: expectedSpan(content, 'helper()', 2),
        }),
      ]),
    );
  });

  it('treats catch-clause parameters as local shadows', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'function helper(): void {}',
      'function run(): void {',
      '  try {} catch (helper) {',
      '    helper();',
      '  }',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-catch-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/catch-shadowing.ts',
      mimeType: 'text/plain',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'helper',
          span: expectedSpan(content, 'helper()', 2),
        }),
      ]),
    );
  });

  it('treats function-local type declarations as local type-space shadows', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'class Service {}',
      'function run(): void {',
      '  type Service = string;',
      "  const value: Service = '';",
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-local-type-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/local-type-shadowing.ts',
      mimeType: 'text/plain',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'Service',
          span: expectedSpan(content, 'Service', 3),
        }),
      ]),
    );
  });

  it('keeps top-level type resolutions outside nested block-local type shadows', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'class Service {}',
      'function run(flag: boolean): void {',
      '  if (flag) {',
      '    type Service = string;',
      "    const inner: Service = '';",
      '  }',
      '  const outer: Service = new Service();',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-block-type-shadowing',
      sourceKind: 'file',
      sourcePath: 'src/block-type-shadowing.ts',
      mimeType: 'text/plain',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');
    const serviceSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'Service');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'Service',
          span: expectedSpan(content, 'Service', 3),
        }),
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: serviceSymbol?.id,
          targetReference: null,
          span: expectedSpan(content, 'Service', 4),
        }),
      ]),
    );
  });

  it('surfaces diagnostics for malformed-but-parseable TypeScript without inventing unsupported export facts', async () => {
    const analyzer = new JavaScriptAnalyzer();
    const content = [
      'function local() {}',
      'export { local as };',
      'export default function broken( {',
      '  return local();',
      '}',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'javascript-malformed',
      sourceKind: 'file',
      sourcePath: 'src/broken.ts',
      mimeType: 'text/plain',
      content,
    });

    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(result.relationships).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'exports',
          span: expectedSpan(content, 'local as'),
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
