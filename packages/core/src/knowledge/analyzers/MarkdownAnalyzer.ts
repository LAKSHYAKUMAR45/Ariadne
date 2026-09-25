import path from 'node:path';
import { offsetToPosition } from '../KnowledgeExtraction.js';
import type {
  DeterministicExtraction,
  ExtractedLink,
  ExtractedRelationship,
  ExtractedSection,
  KnowledgeSourceSpan,
} from '../KnowledgeExtraction.js';
import type { AnalyzerInput, AnalyzerSelectionInput, DeterministicAnalyzer } from './AnalyzerRegistry.js';

const SUMMARY_LIMIT = 280;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);

interface ParsedLine {
  text: string;
  startOffset: number;
  lineNumber: number;
}

interface HeadingContext {
  level: number;
  id: string;
}

interface LinkMatch {
  section: ExtractedSection;
  link: ExtractedLink;
  relationship: ExtractedRelationship;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function parseLines(content: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let lineNumber = 1;
  let lineStart = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content[index] === '\n') {
      lines.push({ text: content.slice(lineStart, index), startOffset: lineStart, lineNumber });
      lineNumber += 1;
      lineStart = index + 1;
    }
  }
  if (content.length === 0) {
    return [{ text: '', startOffset: 0, lineNumber: 1 }];
  }
  return lines;
}

function spanFromOffsets(content: string, startOffset: number, endOffset: number): KnowledgeSourceSpan {
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

function buildSummary(sections: ExtractedSection[]): string {
  const candidate = sections.find(
    (section) =>
      section.kind !== 'heading' &&
      section.kind !== 'link' &&
      section.kind !== 'wikilink' &&
      section.text.trim().length > 0,
  );
  return (candidate?.text.trim() ?? '').slice(0, SUMMARY_LIMIT);
}

function findLinks(content: string, paragraph: ExtractedSection): LinkMatch[] {
  const results: LinkMatch[] = [];
  const markdownPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const wikilinkPattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  for (const match of paragraph.text.matchAll(markdownPattern)) {
    const absoluteStart = paragraph.span.startOffset + (match.index ?? 0);
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
        id: `relationship:links_to:${paragraph.id}->${sectionId}`,
        type: 'links_to',
        fromId: paragraph.id,
        toId: sectionId,
        span,
      },
    });
  }

  for (const match of paragraph.text.matchAll(wikilinkPattern)) {
    const absoluteStart = paragraph.span.startOffset + (match.index ?? 0);
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
        id: `relationship:links_to:${paragraph.id}->${sectionId}`,
        type: 'links_to',
        fromId: paragraph.id,
        toId: sectionId,
        span,
      },
    });
  }

  results.sort((left, right) => left.section.span.startOffset - right.section.span.startOffset);
  return results;
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
    const content = normalizeContent(input.content);
    const lines = parseLines(content);
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
          span: spanFromOffsets(content, line.startOffset, line.startOffset + line.text.length),
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
          text: codeLines.map((entry) => entry.text).join('\n'),
          span: spanFromOffsets(
            content,
            codeLines[0]!.startOffset,
            codeLines[codeLines.length - 1]!.startOffset + codeLines[codeLines.length - 1]!.text.length,
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
        const listLines = lines.slice(startIndex, endIndex + 1);
        const section: ExtractedSection = {
          id: `section:list:${line.lineNumber}`,
          kind: 'list',
          text: listLines.map((entry) => entry.text).join('\n'),
          span: spanFromOffsets(
            content,
            listLines[0]!.startOffset,
            listLines[listLines.length - 1]!.startOffset + listLines[listLines.length - 1]!.text.length,
          ),
        };
        sections.push(section);
        if (headingStack.length > 0) {
          addContainsRelationship(relationships, headingStack[headingStack.length - 1]!.id, section.id);
        }
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
      const paragraphLines = lines.slice(startIndex, endIndex + 1);
      const paragraph: ExtractedSection = {
        id: `section:paragraph:${line.lineNumber}`,
        kind: 'paragraph',
        text: paragraphLines.map((entry) => entry.text).join('\n'),
        span: spanFromOffsets(
          content,
          paragraphLines[0]!.startOffset,
          paragraphLines[paragraphLines.length - 1]!.startOffset + paragraphLines[paragraphLines.length - 1]!.text.length,
        ),
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
      lineIndex = endIndex + 1;
    }

    return {
      analyzerId: this.id,
      analyzerVersion: this.version,
      sourceVersionId: input.sourceVersionId,
      title: path.basename(input.sourcePath ?? input.sourceVersionId),
      summary: buildSummary(sections),
      sections,
      symbols: [],
      relationships,
      links,
      diagnostics: [],
    };
  }
}
