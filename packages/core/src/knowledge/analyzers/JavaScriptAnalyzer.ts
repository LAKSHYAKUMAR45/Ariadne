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
  findDescendants,
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
  defaultExport: boolean;
}

function findCollectedSymbolForNode(symbols: CollectedSymbol[], node: SyntaxNode): CollectedSymbol | null {
  return (
    symbols.find(
      (entry) =>
        entry.node.type.name === node.type.name && entry.node.from === node.from && entry.node.to === node.to,
    ) ?? null
  );
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

function unwrapExport(node: SyntaxNode): { target: SyntaxNode; exported: boolean; defaultExport: boolean } {
  if (node.type.name !== 'ExportDeclaration') {
    return { target: node, exported: false, defaultExport: false };
  }
  const children = childNodes(node);
  const defaultExport = children.some((child) => child.type.name === 'default');
  const target = childNodes(node).find((child) => child.type.name.endsWith('Declaration'));
  return { target: target ?? node, exported: true, defaultExport };
}

function explicitClassNameNode(node: SyntaxNode): SyntaxNode | null {
  const children = childNodes(node);
  const classIndex = children.findIndex((child) => child.type.name === 'class');
  const candidate = classIndex >= 0 ? children[classIndex + 1] : null;
  return candidate?.type.name === 'VariableDefinition' ? candidate : null;
}

function isKeywordNode(content: string, node: SyntaxNode, keyword: string): boolean {
  return node.type.name === keyword || (node.type.isError && nodeText(content, node).trim() === keyword);
}

function classHeritageNode(content: string, node: SyntaxNode, keyword: 'extends' | 'implements'): SyntaxNode | null {
  const children = childNodes(node);
  const keywordIndex = children.findIndex((child) => isKeywordNode(content, child, keyword));
  return keywordIndex >= 0 ? children[keywordIndex + 1] ?? null : null;
}

function symbolFromNode(
  node: SyntaxNode,
  content: string,
  sourceVersionId: string,
  moduleName: string,
  containerSymbolId: string | null,
  defaultExport: boolean,
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
      defaultExport: false,
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
      defaultExport: false,
    };
  }

  if (node.type.name === 'ClassDeclaration') {
    const nameNode = explicitClassNameNode(node);
    const classBody = findFirstChild(node, 'ClassBody');
    const name = nameNode ? identifierText(content, nameNode) : defaultExport ? 'default' : null;
    if (!name) return null;
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
      defaultExport,
    };
  }

  if (node.type.name === 'FunctionDeclaration') {
    const nameNode = findFirstChild(node, 'VariableDefinition');
    const block = findFirstChild(node, 'Block');
    const name = nameNode ? identifierText(content, nameNode) : defaultExport ? 'default' : null;
    if (!name) return null;
    const rawSignature = definitionSignature(nodeText(content, node)).replace(/^function\s*/, '');
    const signature = rawSignature.startsWith('(') ? `${name}${rawSignature}` : rawSignature;
    const span = headerSpan(content, node, block);
    return {
      symbol: {
        id: stableSymbolId(sourceVersionId, className ? 'method' : 'function', `${moduleName}.${className ? `${className}.` : ''}${name}`, span),
        kind: className ? 'method' : 'function',
        name,
        qualifiedName: `${moduleName}.${className ? `${className}.` : ''}${name}`,
        signature,
        detail: null,
        span,
        confidence: 1,
      },
      node,
      containerSymbolId,
      exported: false,
      defaultExport,
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
      defaultExport: false,
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
    const { target, exported, defaultExport } = unwrapExport(statement);
    const collected = symbolFromNode(
      target,
      content,
      sourceVersionId,
      moduleName,
      containerSymbolId,
      defaultExport,
      className,
    );
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
    symbols.push({ ...collected, exported, defaultExport });
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
  shadowedNames: Set<string>,
  name: string,
): ExtractedSymbol | null {
  if (importedNames.has(name) || shadowedNames.has(name)) {
    return null;
  }
  const matches = symbolsByName.get(name) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

function resolveLexicalCallTarget(
  symbolsByName: Map<string, ExtractedSymbol[]>,
  importedNames: Set<string>,
  shadowedNames: Set<string>,
  name: string,
): ExtractedSymbol | null {
  if (importedNames.has(name) || shadowedNames.has(name)) {
    return null;
  }
  const matches = (symbolsByName.get(name) ?? []).filter((symbol) => symbol.kind !== 'method');
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
    const statementText = nodeText(content, statement);
    const fromIndex = children.findIndex((child) => child.type.name === 'from');
    const defaultImportIndex = children.findIndex(
      (child, index) =>
        child.type.name === 'VariableDefinition' &&
        (fromIndex < 0 || index < fromIndex) &&
        children[index - 1]?.type.name !== 'as',
    );
    const defaultImport = defaultImportIndex >= 0 ? children[defaultImportIndex] : undefined;
    if (defaultImport) {
      const localName = identifierText(content, defaultImport);
      importedNames.add(localName);
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'imports',
          sourceSymbolId: null,
          targetSymbolId: null,
          targetReference: `${source}#default`,
          span: nodeSpan(content, defaultImport),
          metadata: {
            importKind: 'default',
            importedName: 'default',
            localName,
          },
        }),
      );
    }

    const mixedNamespaceMatch = /^import\s+[A-Za-z_$][\w$]*\s*,\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/u.exec(statementText);
    if (mixedNamespaceMatch) {
      const localName = mixedNamespaceMatch[1]!;
      const clauseText = `* as ${localName}`;
      const clauseStart = statementText.indexOf(clauseText);
      if (clauseStart >= 0) {
        importedNames.add(localName);
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'imports',
            sourceSymbolId: null,
            targetSymbolId: null,
            targetReference: `${source}#*`,
            span: spanFromOffsets(content, statement.from + clauseStart, statement.from + clauseStart + clauseText.length),
            metadata: {
              importKind: 'namespace',
              importedName: '*',
              localName,
            },
          }),
        );
        continue;
      }
    }

    const starIndex = children.findIndex((child) => child.type.name === 'Star');
    if (starIndex >= 0) {
      const starNode = children[starIndex]!;
      const localNode = children[starIndex + 2];
      if (localNode?.type.name === 'VariableDefinition') {
        const localName = identifierText(content, localNode);
        importedNames.add(localName);
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'imports',
            sourceSymbolId: null,
            targetSymbolId: null,
            targetReference: `${source}#*`,
            span: spanFromOffsets(content, starNode.from, localNode.to),
            metadata: {
              importKind: 'namespace',
              importedName: '*',
              localName,
            },
          }),
        );
      }
      continue;
    }

    const importGroup = findFirstChild(statement, 'ImportGroup');
    if (importGroup) {
      const groupChildren = childNodes(importGroup);
      for (let index = 0; index < groupChildren.length; index += 1) {
        const current = groupChildren[index]!;
        const next = groupChildren[index + 1];
        const following = groupChildren[index + 2];
        const hasAlias = next?.type.name === 'as';
        const importedNode =
          (current.type.name === 'VariableName' || current.type.name === 'default') &&
          hasAlias &&
          following?.type.name === 'VariableDefinition'
            ? current
            : current.type.name === 'VariableDefinition'
              ? current
              : null;
        const localNode =
          (current.type.name === 'VariableName' || current.type.name === 'default') &&
          hasAlias &&
          following?.type.name === 'VariableDefinition'
            ? following
            : current.type.name === 'VariableDefinition'
              ? current
              : null;
        if (hasAlias && following?.type.name !== 'VariableDefinition') {
          continue;
        }
        if (!importedNode || !localNode) {
          continue;
        }
        const importedName = importedNode.type.name === 'default' ? 'default' : identifierText(content, importedNode);
        const localName = identifierText(content, localNode);
        importedNames.add(identifierText(content, localNode));
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'imports',
            sourceSymbolId: null,
            targetSymbolId: null,
            targetReference: `${source}#${importedName}`,
            span: spanFromOffsets(content, current.from, localNode.to),
            metadata: {
              importKind: 'named',
              importedName,
              localName,
            },
          }),
        );
        if (localNode !== current) {
          index += 2;
        }
      }
      continue;
    }

  }
  return { relationships, importedNames };
}

function collectFunctionScopedBindings(content: string, owner: SyntaxNode, body: SyntaxNode): Set<string> {
  const bindings = new Set<string>();
  const params = findFirstChild(owner, 'ParamList');
  if (params) {
    for (const child of findDescendants(params, 'VariableDefinition')) {
      bindings.add(identifierText(content, child));
    }
  }

  const visit = (node: SyntaxNode): void => {
    if (
      node !== body &&
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration', 'ClassDeclaration'].includes(
        node.type.name,
      )
    ) {
      return;
    }
    if (node.type.name === 'VariableDeclaration') {
      const declarationKind = childNodes(node)[0]?.type.name;
      if (declarationKind === 'var') {
        for (const child of findDescendants(node, 'VariableDefinition')) {
          bindings.add(identifierText(content, child));
        }
      }
    }
    for (const child of childNodes(node)) {
      visit(child);
    }
  };

  visit(body);
  return bindings;
}

function collectTypeParameterBindings(content: string, owner: SyntaxNode): Set<string> {
  const bindings = new Set<string>();
  const typeParams = findFirstChild(owner, 'TypeParamList');
  if (!typeParams) {
    return bindings;
  }
  for (const child of findDescendants(typeParams, 'TypeDefinition')) {
    bindings.add(identifierText(content, child));
  }
  return bindings;
}

function collectTypeShadowBindings(content: string, owner: SyntaxNode, body: SyntaxNode): Set<string> {
  return collectTypeParameterBindings(content, owner);
}

function collectBlockTypeBindings(content: string, block: SyntaxNode): Set<string> {
  const bindings = new Set<string>();
  for (const child of childNodes(block)) {
    if (child.type.name === 'TypeAliasDeclaration' || child.type.name === 'InterfaceDeclaration') {
      const nameNode = findFirstChild(child, 'TypeDefinition');
      if (nameNode) {
        bindings.add(identifierText(content, nameNode));
      }
      continue;
    }
    if (child.type.name === 'ClassDeclaration') {
      const nameNode = findFirstChild(child, 'VariableDefinition');
      if (nameNode) {
        bindings.add(identifierText(content, nameNode));
      }
    }
  }
  return bindings;
}

function collectBlockScopedBindings(content: string, block: SyntaxNode): Set<string> {
  const bindings = new Set<string>();
  for (const child of childNodes(block)) {
    if (child.type.name === 'VariableDeclaration') {
      const declarationKind = childNodes(child)[0]?.type.name;
      if (declarationKind === 'var') {
        continue;
      }
      for (const grandchild of findDescendants(child, 'VariableDefinition')) {
        bindings.add(identifierText(content, grandchild));
      }
      continue;
    }
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(child.type.name)) {
      const nameNode = findFirstChild(child, 'VariableDefinition') ?? findFirstChild(child, 'PropertyDefinition');
      if (nameNode) {
        bindings.add(identifierText(content, nameNode));
      }
      continue;
    }
    if (child.type.name === 'CatchClause') {
      const nameNode = findFirstChild(child, 'VariableDefinition');
      if (nameNode) {
        bindings.add(identifierText(content, nameNode));
      }
    }
  }
  return bindings;
}

function mergeShadowedNames(functionScopedBindings: Set<string>, activeBlockBindings: Set<string>[]): Set<string> {
  const shadowed = new Set(functionScopedBindings);
  for (const bindings of activeBlockBindings) {
    for (const name of bindings) {
      shadowed.add(name);
    }
  }
  return shadowed;
}

function collectLoopScopedBindings(content: string, node: SyntaxNode): Set<string> {
  if (node.type.name !== 'ForStatement') {
    return new Set<string>();
  }

  const bindings = new Set<string>();
  const loopSpec = childNodes(node).find((child) =>
    ['ForOfSpec', 'ForInSpec', 'ForSpec'].includes(child.type.name),
  );
  if (!loopSpec) {
    return bindings;
  }

  for (const child of findDescendants(loopSpec, 'VariableDefinition')) {
    bindings.add(identifierText(content, child));
  }
  return bindings;
}

function collectCallRelationships(
  sourceVersionId: string,
  content: string,
  owner: ExtractedSymbol,
  ownerNode: SyntaxNode,
  block: SyntaxNode,
  symbolsByName: Map<string, ExtractedSymbol[]>,
  importedNames: Set<string>,
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const functionScopedBindings = collectFunctionScopedBindings(content, ownerNode, block);
  const visit = (node: SyntaxNode, activeBlockBindings: Set<string>[]): void => {
    if (
      node.type.name === 'FunctionDeclaration' ||
      node.type.name === 'FunctionExpression' ||
      node.type.name === 'ArrowFunction' ||
      node.type.name === 'ClassDeclaration' ||
      node.type.name === 'MethodDeclaration'
    ) {
      return;
    }
    if (node.type.name === 'Block') {
      const nextActiveBindings = [...activeBlockBindings, collectBlockScopedBindings(content, node)];
      for (const child of childNodes(node)) {
        visit(child, nextActiveBindings);
      }
      return;
    }
    if (node.type.name === 'ForStatement') {
      const loopBindings = collectLoopScopedBindings(content, node);
      for (const child of childNodes(node)) {
        const nextBindings =
          child.type.name === 'ForOfSpec' ||
          child.type.name === 'ForInSpec' ||
          child.type.name === 'ForSpec' ||
          child.type.name === 'for'
            ? activeBlockBindings
            : [...activeBlockBindings, loopBindings];
        visit(child, nextBindings);
      }
      return;
    }
    if (node.type.name === 'CatchClause') {
      const catchBindings = new Set<string>();
      const catchParam = findFirstChild(node, 'VariableDefinition');
      if (catchParam) {
        catchBindings.add(identifierText(content, catchParam));
      }
      const nextBindings = [...activeBlockBindings, catchBindings];
      for (const child of childNodes(node)) {
        visit(child, nextBindings);
      }
      return;
    }
    if (node.type.name === 'CallExpression' || node.type.name === 'NewExpression') {
      const targetNode = childNodes(node).find(
        (child) => child.type.name === 'VariableName' || child.type.name === 'MemberExpression',
      );
      const targetName = targetNode ? identifierText(content, targetNode) : null;
      if (targetName) {
        const shadowedNames = mergeShadowedNames(functionScopedBindings, activeBlockBindings);
        const localTarget = targetNode?.type.name === 'VariableName'
          ? resolveLexicalCallTarget(symbolsByName, importedNames, shadowedNames, targetName)
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
      visit(child, activeBlockBindings);
    }
  };
  const rootBlockBindings = collectBlockScopedBindings(content, block);
  for (const child of childNodes(block)) {
    visit(child, [rootBlockBindings]);
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
  functionScopedTypeBindings: Set<string>,
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const visit = (current: SyntaxNode, activeBlockBindings: Set<string>[]): void => {
    if (current !== node && ['FunctionDeclaration', 'MethodDeclaration', 'ClassDeclaration'].includes(current.type.name)) {
      return;
    }
    if (current.type.name === 'TypeName') {
      const targetName = identifierText(content, current);
      const localTarget = resolveLocalSymbol(
        symbolsByName,
        importedNames,
        mergeShadowedNames(functionScopedTypeBindings, activeBlockBindings),
        targetName,
      );
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
    if (current !== node && current.type.name === 'Block') {
      const blockBindings = collectBlockTypeBindings(content, current);
      for (const child of childNodes(current)) {
        visit(child, [...activeBlockBindings, blockBindings]);
      }
      return;
    }
    for (const child of childNodes(current)) {
      visit(child, activeBlockBindings);
    }
  };
  const rootBlockBindings = node.type.name === 'Block' ? [collectBlockTypeBindings(content, node)] : [];
  visit(node, rootBlockBindings);
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
          targetReference: entry.defaultExport ? 'default' : entry.symbol.name,
          span: entry.symbol.span,
          metadata: {
            exportKind: entry.defaultExport ? 'default' : 'declaration',
            localName: entry.symbol.name,
            exportedName: entry.defaultExport ? 'default' : entry.symbol.name,
          },
        }),
      );
    }
  }

  for (const statement of topLevelStatements.filter((node) => node.type.name === 'ExportDeclaration')) {
    const sourceNode = findFirstChild(statement, 'String');
    const source = sourceNode ? identifierText(content, sourceNode).replace(/^['"]|['"]$/g, '') : null;
    const starNode = findFirstChild(statement, 'Star');
    const exportGroup = findFirstChild(statement, 'ExportGroup');
    if (source && starNode) {
      const children = childNodes(statement);
      const asIndex = children.findIndex((child) => child.type.name === 'as');
      const aliasNode = asIndex >= 0 ? children[asIndex + 1] : null;
      const exportedName = aliasNode?.type.name === 'VariableName' ? identifierText(content, aliasNode) : '*';
      const span = spanFromOffsets(content, starNode.from, aliasNode?.type.name === 'VariableName' ? aliasNode.to : starNode.to);
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'exports',
          sourceSymbolId: null,
          targetSymbolId: null,
          targetReference: `${source}#*`,
          span,
          metadata: {
            exportKind: 'reexport',
            localName: '*',
            exportedName,
          },
        }),
      );
      continue;
    }

    if (!exportGroup) {
      continue;
    }

    const groupChildren = childNodes(exportGroup);
    for (let index = 0; index < groupChildren.length; index += 1) {
      const current = groupChildren[index]!;
      const maybeAs = groupChildren[index + 1];
      const maybeAlias = groupChildren[index + 2];
      if (current.type.name !== 'VariableName' && current.type.name !== 'default') {
        continue;
      }
      if (maybeAs?.type.name === 'as' && maybeAlias?.type.name !== 'VariableName') {
        continue;
      }
      const aliasNode = maybeAs?.type.name === 'as' && maybeAlias?.type.name === 'VariableName' ? maybeAlias : null;
      const localName = identifierText(content, current);
      const exportedName = identifierText(content, aliasNode ?? current);
      const localTarget = source
        ? null
        : resolveLocalSymbol(symbolsByName, importedNames, new Set<string>(), localName);
      const span = spanFromOffsets(content, current.from, (aliasNode ?? current).to);
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'exports',
          sourceSymbolId: localTarget?.id ?? null,
          targetSymbolId: null,
          targetReference: source ? `${source}#${localName}` : exportedName,
          span,
          metadata: {
            exportKind: source ? 'reexport' : 'named',
            localName,
            exportedName,
          },
        }),
      );
      if (aliasNode) {
        index += 2;
      }
    }
  }

  for (const statement of topLevelStatements) {
    const { target } = unwrapExport(statement);
    if (target.type.name !== 'ClassDeclaration') {
      continue;
    }
    const classSymbol = findCollectedSymbolForNode(symbols, target)?.symbol ?? null;
    if (!classSymbol) {
      continue;
    }

    const baseNode = classHeritageNode(content, target, 'extends');
    if (baseNode) {
      const baseName = identifierText(content, baseNode);
      const targetSymbol = resolveLocalSymbol(symbolsByName, importedNames, new Set<string>(), baseName);
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

    const implementsIndex = childNodes(target).findIndex((child) => isKeywordNode(content, child, 'implements'));
    if (implementsIndex >= 0) {
      for (const implementNode of childNodes(target).slice(implementsIndex + 1).filter((child) => child.type.name === 'TypeName')) {
        const targetName = identifierText(content, implementNode);
        const targetSymbol = resolveLocalSymbol(symbolsByName, importedNames, new Set<string>(), targetName);
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
    const typeShadowedNames = block ? collectTypeShadowBindings(content, entry.node, block) : new Set<string>();
    relationships.push(
      ...collectTypeReferenceRelationships(
        sourceVersionId,
        content,
        entry.symbol,
        entry.node,
        symbolsByName,
        importedNames,
        typeShadowedNames,
      ),
    );
    if (block) {
      relationships.push(
        ...collectCallRelationships(
          sourceVersionId,
          content,
          entry.symbol,
          entry.node,
          block,
          symbolsByName,
          importedNames,
        ),
      );
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
