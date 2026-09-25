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

  it('avoids false target resolution when parameters or locals shadow top-level symbols', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class BaseDevice:',
      '    pass',
      '',
      'def run(BaseDevice):',
      '    BaseDevice()',
      '',
      'class Example(BaseDevice):',
      '    def method(self, DEVICE_KIND):',
      '        DEVICE_KIND()',
      '        helper = BaseDevice',
      '        return helper',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-shadowing',
      sourceKind: 'file',
      sourcePath: 'example.py',
      mimeType: 'text/x-python',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');
    const methodSymbol = result.symbols.find((symbol) => symbol.kind === 'method' && symbol.name === 'method');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'BaseDevice',
          span: expectedSpan(content, 'BaseDevice()'),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: methodSymbol?.id,
          targetSymbolId: null,
          targetReference: 'DEVICE_KIND',
          span: expectedSpan(content, 'DEVICE_KIND()'),
        }),
      ]),
    );
  });

  it('preserves exact CR-only spans for parser-confirmed Python records', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class BaseDevice:',
      '    pass',
      '',
      'def run():',
      '    BaseDevice()',
      '',
    ].join('\r');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-cr',
      sourceKind: 'file',
      sourcePath: 'cr_only.py',
      mimeType: 'text/x-python',
      content,
    });

    expect(result.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'class',
          qualifiedName: 'cr_only.BaseDevice',
          span: expectedSpan(content, 'class BaseDevice:'),
        }),
      ]),
    );
    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          targetReference: null,
          span: expectedSpan(content, 'BaseDevice()'),
        }),
      ]),
    );
  });

  it('leaves loop-variable shadowed Python calls unresolved', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class BaseDevice:',
      '    pass',
      '',
      'def run(items):',
      '    for BaseDevice in items:',
      '        BaseDevice()',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-loop-shadowing',
      sourceKind: 'file',
      sourcePath: 'loop_shadowing.py',
      mimeType: 'text/x-python',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'BaseDevice',
          span: expectedSpan(content, 'BaseDevice()'),
        }),
      ]),
    );
  });

  it('does not treat imported source names as local aliases for from-import shadowing', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class Service:',
      '    pass',
      '',
      'def run():',
      '    from pkg import Service as ImportedService',
      '    Service()',
      '    ImportedService()',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-import-alias-shadowing',
      sourceKind: 'file',
      sourcePath: 'import_alias.py',
      mimeType: 'text/x-python',
      content,
    });

    const classSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'Service');
    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: classSymbol?.id,
          targetReference: null,
          span: expectedSpan(content, 'Service()'),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'ImportedService',
          span: expectedSpan(content, 'ImportedService()'),
        }),
      ]),
    );
  });

  it('treats dotted import statements as binding the leading module name', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'def pkg():',
      '    pass',
      '',
      'def run():',
      '    import pkg.subpkg',
      '    pkg()',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-dotted-import-shadowing',
      sourceKind: 'file',
      sourcePath: 'dotted_import.py',
      mimeType: 'text/x-python',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'pkg',
          span: expectedSpan(content, 'pkg()', 2),
        }),
      ]),
    );
  });

  it('treats comma-separated bare imports as separate Python shadow bindings with exact spans', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'import pkg.subpkg, other',
      '',
      'def pkg():',
      '    pass',
      '',
      'def other():',
      '    pass',
      '',
      'def run():',
      '    import pkg.subpkg, other',
      '    pkg()',
      '    other()',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-multi-import-shadowing',
      sourceKind: 'file',
      sourcePath: 'multi_import.py',
      mimeType: 'text/x-python',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'imports',
          targetReference: 'pkg.subpkg',
          span: expectedSpan(content, 'pkg', 1),
        }),
        expect.objectContaining({
          type: 'imports',
          targetReference: 'other',
          span: expectedSpan(content, 'other', 1),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'pkg',
          span: expectedSpan(content, 'pkg()', 2),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'other',
          span: expectedSpan(content, 'other()', 2),
        }),
      ]),
    );
  });

  it('resolves class-body references using prior class bindings only', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class Service:',
      '    pass',
      '',
      'class Example:',
      '    alias = Service',
      '    Service = alias',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-class-body-order',
      sourceKind: 'file',
      sourcePath: 'class_body.py',
      mimeType: 'text/x-python',
      content,
    });

    const classSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'Example');
    const serviceSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'Service');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: classSymbol?.id,
          targetSymbolId: serviceSymbol?.id,
          targetReference: null,
          span: expectedSpan(content, 'Service', 2),
        }),
      ]),
    );
  });

  it('treats prior class-body imports as local Python shadows', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class Service:',
      '    pass',
      '',
      'class Example:',
      '    import pkg as Service',
      '    alias = Service',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-class-body-import-shadow',
      sourceKind: 'file',
      sourcePath: 'class_body_import.py',
      mimeType: 'text/x-python',
      content,
    });

    const classSymbol = result.symbols.find((symbol) => symbol.kind === 'class' && symbol.name === 'Example');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'references',
          sourceSymbolId: classSymbol?.id,
          targetSymbolId: null,
          targetReference: 'Service',
          span: expectedSpan(content, 'Service', 3),
        }),
      ]),
    );
  });

  it('treats exception aliases as local Python shadows', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class Service:',
      '    pass',
      '',
      'def run():',
      '    try:',
      '        pass',
      '    except Exception as Service:',
      '        Service()',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-except-shadowing',
      sourceKind: 'file',
      sourcePath: 'except_shadow.py',
      mimeType: 'text/x-python',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'Service',
          span: expectedSpan(content, 'Service()'),
        }),
      ]),
    );
  });

  it('treats tuple assignment and loop bindings as local Python shadows', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class BaseDevice:',
      '    pass',
      '',
      'def run(items):',
      '    first, BaseDevice = items',
      '    BaseDevice()',
      '    for first, BaseDevice in items:',
      '        BaseDevice()',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-tuple-shadowing',
      sourceKind: 'file',
      sourcePath: 'tuple_shadow.py',
      mimeType: 'text/x-python',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'BaseDevice',
          span: expectedSpan(content, 'BaseDevice()'),
        }),
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'BaseDevice',
          span: expectedSpan(content, 'BaseDevice()', 2),
        }),
      ]),
    );
  });

  it('treats chained assignment targets as local Python shadows', async () => {
    const analyzer = new PythonAnalyzer();
    const content = [
      'class BaseDevice:',
      '    pass',
      '',
      'def run(items):',
      '    first = BaseDevice = items',
      '    BaseDevice()',
      '',
    ].join('\n');

    const result = await analyzer.analyze({
      sourceVersionId: 'python-chained-shadowing',
      sourceKind: 'file',
      sourcePath: 'chained_shadow.py',
      mimeType: 'text/x-python',
      content,
    });

    const runSymbol = result.symbols.find((symbol) => symbol.kind === 'function' && symbol.name === 'run');

    expect(result.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'calls',
          sourceSymbolId: runSymbol?.id,
          targetSymbolId: null,
          targetReference: 'BaseDevice',
          span: expectedSpan(content, 'BaseDevice()', 1),
        }),
      ]),
    );
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
