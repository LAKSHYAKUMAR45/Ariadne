import path from 'node:path';
import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import type {
  DeterministicExtraction,
  ExtractedRelationship,
  ExtractedSection,
  ExtractedSymbol,
  ExtractedSymbolKind,
} from '../KnowledgeExtraction.js';
import type { AnalyzerInput, AnalyzerSelectionInput, DeterministicAnalyzer } from './AnalyzerRegistry.js';
import {
  childNodes,
  collectParseDiagnostics,
  definitionSignature,
  findChildren,
  findFirstChild,
  moduleNameFromPath,
  nodeSpan,
  nodeText,
  stableRelationshipId,
  stableSectionId,
  stableSymbolId,
} from './LezerHelpers.js';
import { buildSummaryFromSections, spanFromOffsets } from './SourceText.js';

const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

interface CollectedSymbol {
  symbol: ExtractedSymbol;
  node: SyntaxNode;
  containerSymbolId: string | null;
  exported: boolean;
}

function identifierText(content: string, node: SyntaxNode): string {
  return nodeText(content, node).trim();
}

function isJavaScriptMimeType(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.split(';', 1)[0].trim().toLowerCase();
  return normalized?.includes('javascript') || normalized?.includes('ecmascript') || normalized?.includes('typescript') || false;
}

function dialectForPath(sourcePath: string | null | undefined): string {
  const extension = path.extname(sourcePath ?? '').toLowerCase();
  const parts: string[] = [];
  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    parts.push('ts');
  }
  if (JSX_EXTENSIONS.has(extension)) {
    parts.push('jsx');
  }
  return parts.join(' ');
}

function sectionForNode(content: string, kind: string, node: SyntaxNode, title?: string): ExtractedSection {
  const span = nodeSpan(content, node);
  return {
    id: stableSectionId(kind, span),
    kind,
    title,
    text: nodeText(content, node),
    span,
    confidence: 1,
  };
}

function headerSpan(content: string, node: SyntaxNode, endNode: SyntaxNode | null): ReturnType<typeof nodeSpan> {
  if (!endNode) {
    return nodeSpan(content, node);
  }
  return spanFromOffsets(content, node.from, Math.min(endNode.from + 1, content.length));
}

function unwrapExport(node: SyntaxNode): { target: SyntaxNode; exported: boolean } {
  if (node.type.name !== 'ExportDeclaration') {
    return { target: node, exported: false };
  }
  const target = childNodes(node).find((child) => child.type.name.endsWith('Declaration'));
  return { target: target ?? node, exported: true };
}

function symbolFromNode(
  node: SyntaxNode,
  content: string,
  sourceVersionId: string,
  moduleName: string,
  containerSymbolId: string | null,
  className?: string,
): CollectedSymbol | null {
  if (node.type.name === 'InterfaceDeclaration') {
    const nameNode = findFirstChild(node, 'TypeDefinition');
    const objectType = findFirstChild(node, 'ObjectType');
    if (!nameNode) return null;
    const name = identifierText(content, nameNode);
    const span = headerSpan(content, node, objectType);
    return {
      symbol: {
        id: stableSymbolId(sourceVersionId, 'interface', `${moduleName}.${name}`, span),
        kind: 'interface',
        name,
        qualifiedName: `${moduleName}.${name}`,
        signature: definitionSignature(nodeText(content, node)),
        detail: null,
        span,
        confidence: 1,
      },
      node,
      containerSymbolId,
      exported: false,
    };
  }

  if (node.type.name === 'TypeAliasDeclaration') {
    const nameNode = findFirstChild(node, 'TypeDefinition');
    if (!nameNode) return null;
    const name = identifierText(content, nameNode);
    const span = nodeSpan(content, node);
    return {
      symbol: {
        id: stableSymbolId(sourceVersionId, 'type', `${moduleName}.${name}`, span),
        kind: 'type',
        name,
        qualifiedName: `${moduleName}.${name}`,
        signature: definitionSignature(nodeText(content, node)),
        detail: null,
        span,
        confidence: 1,
      },
      node,
      containerSymbolId,
      exported: false,
    };
  }

  if (node.type.name === 'ClassDeclaration') {
    const nameNode = findFirstChild(node, 'VariableDefinition');
    const classBody = findFirstChild(node, 'ClassBody');
    if (!nameNode) return null;
    const name = identifierText(content, nameNode);
    const span = headerSpan(content, node, classBody);
    return {
      symbol: {
        id: stableSymbolId(sourceVersionId, 'class', `${moduleName}.${name}`, span),
        kind: 'class',
        name,
        qualifiedName: `${moduleName}.${name}`,
        signature: definitionSignature(nodeText(content, node)),
        detail: null,
        span,
        confidence: 1,
      },
      node,
      containerSymbolId,
      exported: false,
    };
  }

  if (node.type.name === 'FunctionDeclaration') {
    const nameNode = findFirstChild(node, 'VariableDefinition');
    const block = findFirstChild(node, 'Block');
    if (!nameNode) return null;
    const name = identifierText(content, nameNode);
    const span = headerSpan(content, node, block);
    return {
      symbol: {
        id: stableSymbolId(sourceVersionId, className ? 'method' : 'function', `${moduleName}.${className ? `${className}.` : ''}${name}`, span),
        kind: className ? 'method' : 'function',
        name,
        qualifiedName: `${moduleName}.${className ? `${className}.` : ''}${name}`,
        signature: definitionSignature(nodeText(content, node)).replace(/^function\s+/, ''),
        detail: null,
        span,
        confidence: 1,
      },
      node,
      containerSymbolId,
      exported: false,
    };
  }

  if (node.type.name === 'MethodDeclaration') {
    const nameNode = findFirstChild(node, 'PropertyDefinition');
    const block = findFirstChild(node, 'Block');
    if (!nameNode || !className) return null;
    const name = identifierText(content, nameNode);
    const span = headerSpan(content, node, block);
    return {
      symbol: {
        id: stableSymbolId(sourceVersionId, 'method', `${moduleName}.${className}.${name}`, span),
        kind: 'method',
        name,
        qualifiedName: `${moduleName}.${className}.${name}`,
        signature: definitionSignature(nodeText(content, node)),
        detail: null,
        span,
        confidence: 1,
      },
      node,
      containerSymbolId,
      exported: false,
    };
  }

  return null;
}

function collectSymbolsFromStatements(
  statements: SyntaxNode[],
  content: string,
  sourceVersionId: string,
  moduleName: string,
  containerSymbolId: string | null,
  className?: string,
): CollectedSymbol[] {
  const symbols: CollectedSymbol[] = [];
  for (const statement of statements) {
    const { target, exported } = unwrapExport(statement);
    const collected = symbolFromNode(target, content, sourceVersionId, moduleName, containerSymbolId, className);
    if (!collected) {
      continue;
    }
    if (exported) {
      const span = spanFromOffsets(content, statement.from, collected.symbol.span.endOffset);
      collected.symbol = {
        ...collected.symbol,
        id: stableSymbolId(
          sourceVersionId,
          collected.symbol.kind,
          collected.symbol.qualifiedName ?? `${moduleName}.${collected.symbol.name}`,
          span,
        ),
        span,
      };
    }
    symbols.push({ ...collected, exported });
    if (target.type.name === 'ClassDeclaration') {
      const body = findFirstChild(target, 'ClassBody');
      if (!body) {
        continue;
      }
      symbols.push(
        ...collectSymbolsFromStatements(
          childNodes(body),
          content,
          sourceVersionId,
          moduleName,
          collected.symbol.id,
          collected.symbol.name,
        ),
      );
    }
  }
  return symbols;
}

function createRelationship(
  sourceVersionId: string,
  relationship: Omit<ExtractedRelationship, 'id' | 'confidence'>,
): ExtractedRelationship {
  return {
    ...relationship,
    id: stableRelationshipId(
      sourceVersionId,
      relationship.type,
      relationship.sourceSymbolId,
      relationship.targetSymbolId,
      relationship.targetReference,
      relationship.span,
    ),
    confidence: 1,
  };
}

function symbolIndex(symbols: ExtractedSymbol[]): Map<string, ExtractedSymbol[]> {
  const index = new Map<string, ExtractedSymbol[]>();
  for (const symbol of symbols) {
    index.set(symbol.name, [...(index.get(symbol.name) ?? []), symbol]);
  }
  return index;
}

function resolveLocalSymbol(
  symbolsByName: Map<string, ExtractedSymbol[]>,
  importedNames: Set<string>,
  name: string,
): ExtractedSymbol | null {
  if (importedNames.has(name)) {
    return null;
  }
  const matches = symbolsByName.get(name) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

function collectImportRelationships(
  statements: SyntaxNode[],
  content: string,
  sourceVersionId: string,
): { relationships: ExtractedRelationship[]; importedNames: Set<string> } {
  const relationships: ExtractedRelationship[] = [];
  const importedNames = new Set<string>();
  for (const statement of statements.filter((node) => node.type.name === 'ImportDeclaration')) {
    const children = childNodes(statement);
    const sourceNode = findFirstChild(statement, 'String');
    const source = sourceNode ? identifierText(content, sourceNode).replace(/^['"]|['"]$/g, '') : 'unknown';
    const importGroup = findFirstChild(statement, 'ImportGroup');
    if (importGroup) {
      const groupChildren = childNodes(importGroup);
      for (let index = 0; index < groupChildren.length; index += 1) {
        const current = groupChildren[index]!;
        const next = groupChildren[index + 1];
        const following = groupChildren[index + 2];
        const importedNode =
          current.type.name === 'VariableName' && next?.type.name === 'as' && following?.type.name === 'VariableDefinition'
            ? current
            : current.type.name === 'VariableDefinition'
              ? current
              : null;
        const localNode =
          current.type.name === 'VariableName' && next?.type.name === 'as' && following?.type.name === 'VariableDefinition'
            ? following
            : current.type.name === 'VariableDefinition'
              ? current
              : null;
        if (!importedNode || !localNode) {
          continue;
        }
        importedNames.add(identifierText(content, localNode));
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'imports',
            sourceSymbolId: null,
            targetSymbolId: null,
            targetReference: `${source}#${identifierText(content, importedNode)}`,
            span: sourceNode ? spanFromOffsets(content, localNode.from, sourceNode.to) : nodeSpan(content, localNode),
          }),
        );
        if (localNode !== current) {
          index += 2;
        }
      }
      continue;
    }

    const starIndex = children.findIndex((child) => child.type.name === 'Star');
    if (starIndex >= 0) {
      const localNode = children[starIndex + 2];
      if (localNode?.type.name === 'VariableDefinition') {
        importedNames.add(identifierText(content, localNode));
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'imports',
            sourceSymbolId: null,
            targetSymbolId: null,
            targetReference: `${source}#*`,
            span: sourceNode ? spanFromOffsets(content, localNode.from, sourceNode.to) : nodeSpan(content, localNode),
          }),
        );
      }
      continue;
    }

    const defaultImport = children.find((child) => child.type.name === 'VariableDefinition');
    if (defaultImport) {
      importedNames.add(identifierText(content, defaultImport));
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'imports',
          sourceSymbolId: null,
          targetSymbolId: null,
          targetReference: `${source}#default`,
          span: sourceNode ? spanFromOffsets(content, defaultImport.from, sourceNode.to) : nodeSpan(content, defaultImport),
        }),
      );
    }
  }
  return { relationships, importedNames };
}

function collectCallRelationships(
  sourceVersionId: string,
  content: string,
  owner: ExtractedSymbol,
  block: SyntaxNode,
  symbolsByName: Map<string, ExtractedSymbol[]>,
  importedNames: Set<string>,
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type.name === 'FunctionDeclaration' || node.type.name === 'ClassDeclaration' || node.type.name === 'MethodDeclaration') {
      return;
    }
    if (node.type.name === 'CallExpression' || node.type.name === 'NewExpression') {
      const targetNode = childNodes(node).find(
        (child) => child.type.name === 'VariableName' || child.type.name === 'MemberExpression',
      );
      const targetName = targetNode ? identifierText(content, targetNode) : null;
      if (targetName) {
        const localTarget = targetNode?.type.name === 'VariableName'
          ? resolveLocalSymbol(symbolsByName, importedNames, targetName)
          : null;
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'calls',
            sourceSymbolId: owner.id,
            targetSymbolId: localTarget?.id ?? null,
            targetReference: localTarget ? null : targetName,
            span: nodeSpan(content, node),
          }),
        );
      }
    }
    for (const child of childNodes(node)) {
      visit(child);
    }
  };
  for (const child of childNodes(block)) {
    visit(child);
  }
  return relationships;
}

function collectTypeReferenceRelationships(
  sourceVersionId: string,
  content: string,
  owner: ExtractedSymbol,
  node: SyntaxNode,
  symbolsByName: Map<string, ExtractedSymbol[]>,
  importedNames: Set<string>,
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const visit = (current: SyntaxNode): void => {
    if (current !== node && ['FunctionDeclaration', 'MethodDeclaration', 'ClassDeclaration'].includes(current.type.name)) {
      return;
    }
    if (current.type.name === 'TypeName') {
      const targetName = identifierText(content, current);
      const localTarget = resolveLocalSymbol(symbolsByName, importedNames, targetName);
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'references',
          sourceSymbolId: owner.id,
          targetSymbolId: localTarget?.id ?? null,
          targetReference: localTarget ? null : targetName,
          span: nodeSpan(content, current),
        }),
      );
    }
    for (const child of childNodes(current)) {
      visit(child);
    }
  };
  visit(node);
  return relationships;
}

function collectSymbolRelationships(
  topLevelStatements: SyntaxNode[],
  content: string,
  sourceVersionId: string,
  symbols: CollectedSymbol[],
  importedNames: Set<string>,
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const symbolsByName = symbolIndex(symbols.map((entry) => entry.symbol));

  for (const entry of symbols) {
    if (entry.containerSymbolId) {
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'contains',
          sourceSymbolId: entry.containerSymbolId,
          targetSymbolId: entry.symbol.id,
          targetReference: null,
          span: entry.symbol.span,
        }),
      );
    }
    if (entry.exported) {
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'exports',
          sourceSymbolId: entry.symbol.id,
          targetSymbolId: null,
          targetReference: entry.symbol.name,
          span: entry.symbol.span,
        }),
      );
    }
  }

  for (const statement of topLevelStatements) {
    const { target } = unwrapExport(statement);
    if (target.type.name !== 'ClassDeclaration') {
      continue;
    }
    const classNameNode = findFirstChild(target, 'VariableDefinition');
    const className = classNameNode ? identifierText(content, classNameNode) : null;
    const classSymbol = className ? resolveLocalSymbol(symbolsByName, new Set<string>(), className) : null;
    if (!classSymbol) {
      continue;
    }

    const extendsIndex = childNodes(target).findIndex((child) => child.type.name === 'extends');
    if (extendsIndex >= 0) {
      const baseNode = childNodes(target)[extendsIndex + 1] ?? null;
      if (baseNode) {
        const baseName = identifierText(content, baseNode);
        const targetSymbol = resolveLocalSymbol(symbolsByName, importedNames, baseName);
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'inherits',
            sourceSymbolId: classSymbol.id,
            targetSymbolId: targetSymbol?.id ?? null,
            targetReference: targetSymbol ? null : baseName,
            span: nodeSpan(content, baseNode),
          }),
        );
      }
    }

    const implementsIndex = childNodes(target).findIndex((child) => child.type.name === 'implements');
    if (implementsIndex >= 0) {
      for (const implementNode of childNodes(target).slice(implementsIndex + 1).filter((child) => child.type.name === 'TypeName')) {
        const targetName = identifierText(content, implementNode);
        const targetSymbol = resolveLocalSymbol(symbolsByName, importedNames, targetName);
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'implements',
            sourceSymbolId: classSymbol.id,
            targetSymbolId: targetSymbol?.id ?? null,
            targetReference: targetSymbol ? null : targetName,
            span: nodeSpan(content, implementNode),
          }),
        );
      }
    }
  }

  for (const entry of symbols.filter((item) => item.symbol.kind === 'function' || item.symbol.kind === 'method')) {
    const block = findFirstChild(entry.node, 'Block');
    relationships.push(...collectTypeReferenceRelationships(sourceVersionId, content, entry.symbol, entry.node, symbolsByName, importedNames));
    if (block) {
      relationships.push(...collectCallRelationships(sourceVersionId, content, entry.symbol, block, symbolsByName, importedNames));
    }
  }

  return relationships;
}

export class JavaScriptAnalyzer implements DeterministicAnalyzer {
  public readonly id = 'javascript-lezer';
  public readonly version = '1.0.0';

  public supports(input: AnalyzerSelectionInput): boolean {
    if (isJavaScriptMimeType(input.mimeType)) {
      return true;
    }
    return JAVASCRIPT_EXTENSIONS.has(path.extname(input.sourcePath ?? '').toLowerCase());
  }

  public async analyze(input: AnalyzerInput): Promise<DeterministicExtraction> {
    const tree = parser.configure({ dialect: dialectForPath(input.sourcePath) }).parse(input.content);
    const moduleName = moduleNameFromPath(input.sourcePath, input.sourceVersionId);
    const title = path.basename(input.sourcePath ?? input.sourceVersionId);
    const statements = childNodes(tree.topNode);
    const sections: ExtractedSection[] = [];
    for (const statement of statements.filter((node) => node.type.name === 'ImportDeclaration')) {
      sections.push(sectionForNode(input.content, 'import', statement));
    }
    const collectedSymbols = collectSymbolsFromStatements(
      statements,
      input.content,
      input.sourceVersionId,
      moduleName,
      null,
    );
    for (const collected of collectedSymbols) {
      sections.push(sectionForNode(input.content, collected.symbol.kind, collected.node, collected.symbol.name));
    }
    const imports = collectImportRelationships(statements, input.content, input.sourceVersionId);
    const relationships = [
      ...imports.relationships,
      ...collectSymbolRelationships(statements, input.content, input.sourceVersionId, collectedSymbols, imports.importedNames),
    ];

    return {
      analyzerId: this.id,
      analyzerVersion: this.version,
      sourceVersionId: input.sourceVersionId,
      title,
      summary: buildSummaryFromSections(sections),
      sections,
      symbols: collectedSymbols.map((entry) => entry.symbol),
      relationships,
      links: [],
      diagnostics: collectParseDiagnostics(input.content, tree),
    };
  }
}
