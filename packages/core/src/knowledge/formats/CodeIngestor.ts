import path from 'node:path';
import { normalizeKnowledgePath } from '../KnowledgeIds.js';
import type { ExtractedSource, IngestInput, KnowledgeIngestor } from './IngestTypes.js';
import { baseExtraction } from './IngestTypes.js';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  java: 'java',
  js: 'javascript',
  jsx: 'javascript',
  kt: 'kotlin',
  mjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'typescript',
};

const SYMBOL_PATTERN =
  /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|def|func)\s+([A-Za-z_$][\w$]*)/g;

export class CodeIngestor implements KnowledgeIngestor {
  supports(input: IngestInput): boolean {
    return input.path !== undefined && LANGUAGE_BY_EXTENSION[path.extname(input.path).slice(1).toLowerCase()] !== undefined;
  }

  async extract(input: IngestInput): Promise<ExtractedSource> {
    if (input.path) normalizeKnowledgePath(input.path);
    const result = baseExtraction(input, input.content.replace(/\r\n?/g, '\n'));
    const extension = path.extname(input.path ?? '').slice(1).toLowerCase();
    result.metadata.language = LANGUAGE_BY_EXTENSION[extension] ?? 'text';

    const symbols: string[] = [];
    for (const match of input.content.matchAll(SYMBOL_PATTERN)) {
      const symbol = match[1];
      const startOffset = (match.index ?? 0) + match[0].lastIndexOf(symbol);
      symbols.push(symbol);
      result.spans.push({ label: 'symbol', text: symbol, startOffset, endOffset: startOffset + symbol.length });
    }
    const paths: string[] = [];
    for (const match of input.content.matchAll(/(["'`])((?:\.{0,2}\/|src\/|packages\/)[^"'`\s]+)\1/g)) {
      paths.push(match[2]);
      const startOffset = (match.index ?? 0) + match[0].indexOf(match[2]);
      result.spans.push({ label: 'path', text: match[2], startOffset, endOffset: startOffset + match[2].length });
    }
    result.metadata.symbols = [...new Set(symbols)];
    result.metadata.paths = [...new Set(paths)];
    return result;
  }
}
