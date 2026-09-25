import { offsetToPosition } from '../KnowledgeExtraction.js';
import type { KnowledgeSourceSpan } from '../KnowledgeExtraction.js';

export const MAX_SECTION_CHARACTERS = 2000;
export const MAX_SECTION_LINES = 80;
export const SUMMARY_LIMIT = 280;

export interface ParsedLine {
  text: string;
  startOffset: number;
  endOffset: number;
  lineNumber: number;
}

export interface SectionChunk {
  startOffset: number;
  endOffset: number;
}

function splitOffsetRange(startOffset: number, endOffset: number, protectedRanges: SectionChunk[]): SectionChunk[] {
  const chunks: SectionChunk[] = [];
  const sortedProtectedRanges = protectedRanges
    .filter((range) => range.startOffset < endOffset && range.endOffset > startOffset)
    .sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  let cursor = startOffset;

  while (cursor < endOffset) {
    let boundary = Math.min(cursor + MAX_SECTION_CHARACTERS, endOffset);

    while (boundary < endOffset) {
      const protectedRange = sortedProtectedRanges.find(
        (range) => range.startOffset < boundary && boundary < range.endOffset,
      );
      if (!protectedRange) {
        break;
      }
      if (protectedRange.startOffset > cursor) {
        boundary = protectedRange.startOffset;
        break;
      }
      if (protectedRange.endOffset - cursor <= MAX_SECTION_CHARACTERS) {
        boundary = protectedRange.endOffset;
        continue;
      }
      break;
    }

    if (boundary <= cursor) {
      boundary = Math.min(cursor + MAX_SECTION_CHARACTERS, endOffset);
    }
    chunks.push({ startOffset: cursor, endOffset: boundary });
    cursor = boundary;
  }

  return chunks;
}

export function parseSourceLines(content: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let lineNumber = 1;
  let lineStart = 0;
  let index = 0;

  while (index < content.length) {
    if (content[index] === '\r' || content[index] === '\n') {
      lines.push({
        text: content.slice(lineStart, index),
        startOffset: lineStart,
        endOffset: index,
        lineNumber,
      });
      if (content[index] === '\r' && content[index + 1] === '\n') {
        index += 2;
      } else {
        index += 1;
      }
      lineNumber += 1;
      lineStart = index;
      continue;
    }
    index += 1;
  }

  lines.push({
    text: content.slice(lineStart),
    startOffset: lineStart,
    endOffset: content.length,
    lineNumber,
  });
  return lines;
}

export function spanFromOffsets(content: string, startOffset: number, endOffset: number): KnowledgeSourceSpan {
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

export function splitLineRange(
  content: string,
  lines: ParsedLine[],
  startIndex: number,
  endIndex: number,
  protectedRanges: SectionChunk[] = [],
): SectionChunk[] {
  const chunks: SectionChunk[] = [];
  let currentStartOffset: number | null = null;
  let currentEndOffset: number | null = null;
  let currentLineCount = 0;

  const flushCurrent = (): void => {
    if (currentStartOffset === null || currentEndOffset === null) {
      return;
    }
    chunks.push({ startOffset: currentStartOffset, endOffset: currentEndOffset });
    currentStartOffset = null;
    currentEndOffset = null;
    currentLineCount = 0;
  };

  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines[index]!;
    const lineLength = line.endOffset - line.startOffset;

    if (lineLength > MAX_SECTION_CHARACTERS) {
      flushCurrent();
      chunks.push(...splitOffsetRange(line.startOffset, line.endOffset, protectedRanges));
      continue;
    }

    const candidateStartOffset = currentStartOffset ?? line.startOffset;
    const candidateEndOffset = line.endOffset;
    const candidateLineCount = currentLineCount + 1;
    const candidateLength = content.slice(candidateStartOffset, candidateEndOffset).length;

    if (currentStartOffset !== null && (candidateLineCount > MAX_SECTION_LINES || candidateLength > MAX_SECTION_CHARACTERS)) {
      flushCurrent();
    }

    currentStartOffset ??= line.startOffset;
    currentEndOffset = line.endOffset;
    currentLineCount += 1;

    const currentLength = content.slice(currentStartOffset, currentEndOffset).length;
    if (currentLineCount >= MAX_SECTION_LINES || currentLength >= MAX_SECTION_CHARACTERS) {
      flushCurrent();
    }
  }

  flushCurrent();
  return chunks;
}

export function buildSummaryFromSections(sections: Array<{ kind: string; text: string }>): string {
  const candidate = sections.find((section) => section.kind !== 'link' && section.kind !== 'wikilink' && section.text.trim().length > 0);
  return candidate ? candidate.text.slice(0, SUMMARY_LIMIT) : '';
}

export function buildChunkId(kind: string, lineNumber: number, chunkIndex: number): string {
  return `section:${kind}:${lineNumber}${chunkIndex > 0 ? `:${chunkIndex + 1}` : ''}`;
}
