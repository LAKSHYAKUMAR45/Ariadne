import path from 'node:path';
import type {
  DeterministicExtraction,
  ExtractedLink,
  ExtractedRelationship,
  ExtractedSection,
} from '../KnowledgeExtraction.js';
import type { AnalyzerInput, AnalyzerSelectionInput, DeterministicAnalyzer } from './AnalyzerRegistry.js';
import {
  buildChunkId,
  buildSummaryFromSections,
  parseSourceLines,
  type SectionChunk,
  spanFromOffsets,
  splitLineRange,
} from './SourceText.js';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);

interface HeadingContext {
  level: number;
  id: string;
}

interface LinkMatch {
  section: ExtractedSection;
  link: ExtractedLink;
  relationship: ExtractedRelationship;
}

function slugifyHeading(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function addContainsRelationship(relationships: ExtractedRelationship[], fromId: string, toId: string): void {
  relationships.push({
    id: `relationship:contains:${fromId}->${toId}`,
    type: 'contains',
    fromId,
    toId,
  });
}

function isListLine(text: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(text);
}

function isHeadingLine(text: string): boolean {
  return /^#{1,6}\s+/.test(text);
}

function isFenceLine(text: string): boolean {
  return /^```/.test(text);
}

function findLinks(content: string, section: ExtractedSection): LinkMatch[] {
  const results: LinkMatch[] = [];
  const markdownPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const wikilinkPattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  for (const match of section.text.matchAll(markdownPattern)) {
    const absoluteStart = section.span.startOffset + (match.index ?? 0);
    const absoluteEnd = absoluteStart + match[0].length;
    const span = spanFromOffsets(content, absoluteStart, absoluteEnd);
    const sectionId = `section:link:${span.startLine}:${span.startColumn}`;
    results.push({
      section: {
        id: sectionId,
        kind: 'link',
        title: match[1],
        text: match[2],
        span,
      },
      link: {
        id: `link:${span.startLine}:${span.startColumn}`,
        target: match[2],
        title: match[1],
        span,
      },
      relationship: {
        id: `relationship:links_to:${section.id}->${sectionId}`,
        type: 'links_to',
        fromId: section.id,
        toId: sectionId,
        span,
      },
    });
  }

  for (const match of section.text.matchAll(wikilinkPattern)) {
    const absoluteStart = section.span.startOffset + (match.index ?? 0);
    const absoluteEnd = absoluteStart + match[0].length;
    const span = spanFromOffsets(content, absoluteStart, absoluteEnd);
    const target = match[1].trim();
    const title = (match[2] ?? match[1]).trim();
    const sectionId = `section:wikilink:${span.startLine}:${span.startColumn}`;
    results.push({
      section: {
        id: sectionId,
        kind: 'wikilink',
        title,
        text: target,
        span,
      },
      link: {
        id: `link:${span.startLine}:${span.startColumn}`,
        target,
        title,
        span,
      },
      relationship: {
        id: `relationship:links_to:${section.id}->${sectionId}`,
        type: 'links_to',
        fromId: section.id,
        toId: sectionId,
        span,
      },
    });
  }

  results.sort((left, right) => left.section.span.startOffset - right.section.span.startOffset);
  return results;
}

function findProtectedLinkRanges(startOffset: number, text: string): SectionChunk[] {
  const ranges: SectionChunk[] = [];
  const markdownPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const wikilinkPattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  for (const match of text.matchAll(markdownPattern)) {
    const matchStart = startOffset + (match.index ?? 0);
    ranges.push({
      startOffset: matchStart,
      endOffset: matchStart + match[0].length,
    });
  }

  for (const match of text.matchAll(wikilinkPattern)) {
    const matchStart = startOffset + (match.index ?? 0);
    ranges.push({
      startOffset: matchStart,
      endOffset: matchStart + match[0].length,
    });
  }

  return ranges.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
}

export class MarkdownAnalyzer implements DeterministicAnalyzer {
  public readonly id = 'markdown';
  public readonly version = '1.0.0';

  public supports(input: AnalyzerSelectionInput): boolean {
    const mimeType = input.mimeType?.split(';', 1)[0].trim().toLowerCase();
    if (mimeType?.includes('markdown')) {
      return true;
    }
    return MARKDOWN_EXTENSIONS.has(path.extname(input.sourcePath ?? '').toLowerCase());
  }

  public async analyze(input: AnalyzerInput): Promise<DeterministicExtraction> {
    const content = input.content;
    const lines = parseSourceLines(content);
    const sections: ExtractedSection[] = [];
    const relationships: ExtractedRelationship[] = [];
    const links: ExtractedLink[] = [];
    const headingCounts = new Map<string, number>();
    const headingStack: HeadingContext[] = [];

    let lineIndex = 0;
    while (lineIndex < lines.length) {
      const line = lines[lineIndex]!;
      const trimmed = line.text.trim();
      if (trimmed.length === 0) {
        lineIndex += 1;
        continue;
      }

      const headingMatch = line.text.match(/^(#{1,6})\s+(.*\S)\s*$/);
      if (headingMatch) {
        const title = headingMatch[2].trim();
        const baseSlug = slugifyHeading(title);
        const count = (headingCounts.get(baseSlug) ?? 0) + 1;
        headingCounts.set(baseSlug, count);
        const id = `section:heading:${baseSlug}${count > 1 ? `-${count}` : ''}`;
        const section: ExtractedSection = {
          id,
          kind: 'heading',
          title,
          text: line.text,
          span: spanFromOffsets(content, line.startOffset, line.endOffset),
        };
        while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= headingMatch[1].length) {
          headingStack.pop();
        }
        if (headingStack.length > 0) {
          addContainsRelationship(relationships, headingStack[headingStack.length - 1]!.id, section.id);
        }
        headingStack.push({ level: headingMatch[1].length, id: section.id });
        sections.push(section);
        lineIndex += 1;
        continue;
      }

      if (isFenceLine(line.text)) {
        const startIndex = lineIndex;
        let endIndex = lineIndex;
        while (endIndex + 1 < lines.length) {
          endIndex += 1;
          if (/^```\s*$/.test(lines[endIndex]!.text)) {
            break;
          }
        }
        const codeLines = lines.slice(startIndex, endIndex + 1);
        const section: ExtractedSection = {
          id: `section:code:${line.lineNumber}`,
          kind: 'code',
          title: line.text.slice(3).trim() || undefined,
          text: content.slice(codeLines[0]!.startOffset, codeLines[codeLines.length - 1]!.endOffset),
          span: spanFromOffsets(
            content,
            codeLines[0]!.startOffset,
            codeLines[codeLines.length - 1]!.endOffset,
          ),
        };
        sections.push(section);
        if (headingStack.length > 0) {
          addContainsRelationship(relationships, headingStack[headingStack.length - 1]!.id, section.id);
        }
        lineIndex = endIndex + 1;
        continue;
      }

      if (isListLine(line.text)) {
        const startIndex = lineIndex;
        let endIndex = lineIndex;
        while (endIndex + 1 < lines.length && isListLine(lines[endIndex + 1]!.text)) {
          endIndex += 1;
        }
        const blockStartOffset = lines[startIndex]!.startOffset;
        const blockEndOffset = lines[endIndex]!.endOffset;
        const protectedRanges = findProtectedLinkRanges(blockStartOffset, content.slice(blockStartOffset, blockEndOffset));
        const chunks = splitLineRange(content, lines, startIndex, endIndex, protectedRanges);
        chunks.forEach((chunk, chunkIndex) => {
          const section: ExtractedSection = {
            id: buildChunkId('list', line.lineNumber, chunkIndex),
            kind: 'list',
            text: content.slice(chunk.startOffset, chunk.endOffset),
            span: spanFromOffsets(content, chunk.startOffset, chunk.endOffset),
          };
          sections.push(section);
          if (headingStack.length > 0) {
            addContainsRelationship(relationships, headingStack[headingStack.length - 1]!.id, section.id);
          }
          for (const linkMatch of findLinks(content, section)) {
            sections.push(linkMatch.section);
            links.push(linkMatch.link);
            relationships.push(linkMatch.relationship);
          }
        });
        lineIndex = endIndex + 1;
        continue;
      }

      const startIndex = lineIndex;
      let endIndex = lineIndex;
      while (
        endIndex + 1 < lines.length &&
        lines[endIndex + 1]!.text.trim().length > 0 &&
        !isHeadingLine(lines[endIndex + 1]!.text) &&
        !isFenceLine(lines[endIndex + 1]!.text) &&
        !isListLine(lines[endIndex + 1]!.text)
      ) {
        endIndex += 1;
      }
      const blockStartOffset = lines[startIndex]!.startOffset;
      const blockEndOffset = lines[endIndex]!.endOffset;
      const protectedRanges = findProtectedLinkRanges(blockStartOffset, content.slice(blockStartOffset, blockEndOffset));
      const chunks = splitLineRange(content, lines, startIndex, endIndex, protectedRanges);
      chunks.forEach((chunk, chunkIndex) => {
        const paragraph: ExtractedSection = {
          id: buildChunkId('paragraph', line.lineNumber, chunkIndex),
          kind: 'paragraph',
          text: content.slice(chunk.startOffset, chunk.endOffset),
          span: spanFromOffsets(content, chunk.startOffset, chunk.endOffset),
        };
        sections.push(paragraph);
        if (headingStack.length > 0) {
          addContainsRelationship(relationships, headingStack[headingStack.length - 1]!.id, paragraph.id);
        }
        for (const linkMatch of findLinks(content, paragraph)) {
          sections.push(linkMatch.section);
          links.push(linkMatch.link);
          relationships.push(linkMatch.relationship);
        }
      });
      lineIndex = endIndex + 1;
    }

    return {
      analyzerId: this.id,
      analyzerVersion: this.version,
      sourceVersionId: input.sourceVersionId,
      title: path.basename(input.sourcePath ?? input.sourceVersionId),
      summary: buildSummaryFromSections(sections),
      sections,
      symbols: [],
      relationships,
      links,
      diagnostics: [],
    };
  }
}
