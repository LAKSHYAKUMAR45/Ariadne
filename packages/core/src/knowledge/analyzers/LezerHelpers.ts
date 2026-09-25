import type { SyntaxNode, Tree } from '@lezer/common';
import { createKnowledgeId } from '../KnowledgeIds.js';
import type { ExtractionDiagnostic, KnowledgeSourceSpan } from '../KnowledgeExtraction.js';
import { spanFromOffsets } from './SourceText.js';

export function childNodes(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    children.push(child);
  }
  return children;
}

export function findFirstChild(node: SyntaxNode, typeName: string): SyntaxNode | null {
  return childNodes(node).find((child) => child.type.name === typeName) ?? null;
}

export function findChildren(node: SyntaxNode, typeName: string): SyntaxNode[] {
  return childNodes(node).filter((child) => child.type.name === typeName);
}

export function findDescendants(node: SyntaxNode, typeName: string): SyntaxNode[] {
  const matches: SyntaxNode[] = [];
  for (const child of childNodes(node)) {
    if (child.type.name === typeName) {
      matches.push(child);
    }
    matches.push(...findDescendants(child, typeName));
  }
  return matches;
}

export function nodeText(content: string, node: SyntaxNode): string {
  return content.slice(node.from, node.to);
}

export function nodeSpan(content: string, node: SyntaxNode): KnowledgeSourceSpan {
  return spanFromOffsets(content, node.from, node.to);
}

export function stableSymbolId(
  sourceVersionId: string,
  kind: string,
  qualifiedName: string,
  span: KnowledgeSourceSpan,
): string {
  return createKnowledgeId(
    'symbol',
    [sourceVersionId, kind, qualifiedName, span.startOffset, span.endOffset].join(':'),
  );
}

export function stableRelationshipId(
  sourceVersionId: string,
  type: string,
  sourceSymbolId: string | null | undefined,
  targetSymbolId: string | null | undefined,
  targetReference: string | null | undefined,
  span: KnowledgeSourceSpan | null | undefined,
): string {
  return createKnowledgeId(
    'relationship',
    [
      sourceVersionId,
      type,
      sourceSymbolId ?? 'null',
      targetSymbolId ?? 'null',
      targetReference ?? 'null',
      span?.startOffset ?? -1,
      span?.endOffset ?? -1,
    ].join(':'),
  );
}

export function stableSectionId(kind: string, span: KnowledgeSourceSpan): string {
  return `section:${kind}:${span.startLine}:${span.startColumn}`;
}

export function moduleNameFromPath(sourcePath: string | null | undefined, sourceVersionId: string): string {
  if (!sourcePath) {
    return sourceVersionId.replace(/[^a-zA-Z0-9_]+/g, '_');
  }
  const normalized = sourcePath.replace(/\\/g, '/');
  const baseName = normalized.split('/').pop() ?? sourceVersionId;
  return baseName.replace(/\.[^.]+$/, '') || sourceVersionId.replace(/[^a-zA-Z0-9_]+/g, '_');
}

export function normalizedDocstring(text: string): string {
  return text.trim().replace(/^(["']{3}|["'])|(["']{3}|["'])$/g, '').trim();
}

export function definitionSignature(text: string): string {
  return text
    .split(/\r\n|\n|\r/, 1)[0]!
    .trim()
    .replace(/\s*:\s*$/, '')
    .replace(/\s*\{\s*$/, '');
}

export function collectParseDiagnostics(content: string, tree: Tree): ExtractionDiagnostic[] {
  const diagnostics: ExtractionDiagnostic[] = [];
  const cursor = tree.cursor();
  do {
    if (!cursor.type.isError) {
      continue;
    }
    const span = spanFromOffsets(content, cursor.from, cursor.to);
    diagnostics.push({
      code: 'parser-recovery',
      message: 'Parser recovered from malformed syntax near this span.',
      severity: 'warning',
      span,
    });
  } while (cursor.next());
  return diagnostics;
}
