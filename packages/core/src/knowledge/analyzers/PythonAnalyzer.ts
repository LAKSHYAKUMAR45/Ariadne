import path from 'node:path';
import { parser } from '@lezer/python';
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
  normalizedDocstring,
  stableRelationshipId,
  stableSectionId,
  stableSymbolId,
} from './LezerHelpers.js';
import { buildSummaryFromSections } from './SourceText.js';
import { spanFromOffsets } from './SourceText.js';

function collectImportBindings(content: string, node: SyntaxNode): Set<string> {
  const bindings = new Set<string>();
  const importText = nodeText(content, node);
  const children = childNodes(node);
  if (importText.startsWith('import ')) {
    for (const clause of collectBareImportClauses(content, node)) {
      bindings.add(clause.localName);
    }
    return bindings;
  }

  const importIndex = children.findIndex((child) => child.type.name === 'import');
  const importedChildren = children.slice(importIndex + 1);
  for (let index = 0; index < importedChildren.length; index += 1) {
    const current = importedChildren[index]!;
    const maybeAs = importedChildren[index + 1];
    const maybeAlias = importedChildren[index + 2];
    if (current.type.name !== 'VariableName') {
      continue;
    }
    if (maybeAs?.type.name === 'as' && maybeAlias?.type.name === 'VariableName') {
      bindings.add(identifierText(content, maybeAlias));
      index += 2;
      continue;
    }
    bindings.add(identifierText(content, current));
  }
  return bindings;
}

function collectBareImportClauses(
  content: string,
  node: SyntaxNode,
): { moduleReference: string; localName: string; span: ReturnType<typeof nodeSpan> }[] {
  const statementText = nodeText(content, node);
  const clauseText = statementText.replace(/^import\s+/, '');
  const clauses: { moduleReference: string; localName: string; span: ReturnType<typeof nodeSpan> }[] = [];
  let searchOffset = 0;
  for (const rawClause of clauseText.split(',')) {
    const clause = rawClause.trim();
    if (!clause) {
      searchOffset += rawClause.length + 1;
      continue;
    }
    const match = /^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?$/u.exec(clause);
    if (!match) {
      searchOffset += rawClause.length + 1;
      continue;
    }
    const moduleReference = match[1]!;
    const localName = match[2] ?? moduleReference.split('.')[0]!;
    const clauseStart = clauseText.indexOf(clause, searchOffset);
    const localStartInClause = match[2] ? clause.lastIndexOf(localName) : clause.indexOf(localName);
    const startOffset = node.from + statementText.indexOf('import ') + 'import '.length + clauseStart + localStartInClause;
    clauses.push({
      moduleReference,
      localName,
      span: spanFromOffsets(content, startOffset, startOffset + localName.length),
    });
    searchOffset = clauseStart + rawClause.length + 1;
  }
  return clauses;
}

const PYTHON_EXTENSIONS = new Set(['.py', '.pyi']);

interface CollectedSymbol {
  symbol: ExtractedSymbol;
  node: SyntaxNode;
  containerSymbolId: string | null;
}

interface SymbolContext {
  moduleName: string;
  sourceVersionId: string;
  className?: string;
  containerSymbolId: string;
  importedNames: Set<string>;
}

function isPythonMimeType(mimeType: string | null | undefined): boolean {
  const normalized = mimeType?.split(';', 1)[0].trim().toLowerCase();
  return normalized?.includes('python') ?? false;
}

function identifierText(content: string, node: SyntaxNode): string {
  return nodeText(content, node).trim();
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

function unwrapDecorated(content: string, node: SyntaxNode): { target: SyntaxNode; decorators: string[] } {
  if (node.type.name !== 'DecoratedStatement') {
    return { target: node, decorators: [] };
  }
  const decorators = findChildren(node, 'Decorator')
    .map((decorator) => findFirstChild(decorator, 'VariableName'))
    .filter((candidate): candidate is SyntaxNode => candidate !== null)
    .map((candidate) => identifierText(content, candidate));
  const target = childNodes(node).find((child) => child.type.name.endsWith('Definition'));
  return { target: target ?? node, decorators };
}

function moduleSymbol(sourceVersionId: string, moduleName: string, content: string): ExtractedSymbol {
  const span = { ...nodeSpan(content, parser.parse(content).topNode), endOffset: content.length };
  return {
    id: stableSymbolId(sourceVersionId, 'module', moduleName, span),
    kind: 'module',
    name: moduleName,
    qualifiedName: moduleName,
    signature: null,
    detail: null,
    span,
    confidence: 1,
  };
}

function definitionHeaderSpan(content: string, node: SyntaxNode, body: SyntaxNode | null): ReturnType<typeof nodeSpan> {
  if (!body) {
    return nodeSpan(content, node);
  }
  return spanFromOffsets(content, node.from, Math.min(body.from + 1, content.length));
}

function extractBodyDocstring(body: SyntaxNode | null, content: string): string | null {
  if (!body) {
    return null;
  }
  const statement = childNodes(body).find((child) => child.type.name === 'ExpressionStatement');
  const stringNode = statement ? findFirstChild(statement, 'String') : null;
  return stringNode ? normalizedDocstring(nodeText(content, stringNode)) : null;
}

function collectFunctionAnnotations(node: SyntaxNode, content: string): string[] {
  const annotations: string[] = [];
  const params = findFirstChild(node, 'ParamList');
  if (params) {
    const children = childNodes(params);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.type.name !== 'VariableName' || identifierText(content, child) === 'self') {
        continue;
      }
      const typeDef = children[index + 1];
      if (typeDef?.type.name === 'TypeDef') {
        annotations.push(`${identifierText(content, child)}${nodeText(content, typeDef)}`);
      }
    }
  }
  const typeDefs = findChildren(node, 'TypeDef');
  const returnType = typeDefs[typeDefs.length - 1];
  if (returnType && returnType.from > (params?.to ?? node.from)) {
    annotations.push(`return: ${nodeText(content, returnType).replace(/^->\s*/, '').trim()}`);
  }
  return annotations;
}

function symbolFromDefinition(
  node: SyntaxNode,
  content: string,
  context: SymbolContext,
  decorators: string[],
): CollectedSymbol | null {
  if (node.type.name === 'ClassDefinition') {
    const nameNode = findFirstChild(node, 'VariableName');
    const body = findFirstChild(node, 'Body');
    if (!nameNode) {
      return null;
    }
    const name = identifierText(content, nameNode);
    const qualifiedName = `${context.moduleName}.${name}`;
    const span = definitionHeaderSpan(content, node, body);
    const docstring = extractBodyDocstring(body, content);
    return {
      symbol: {
        id: stableSymbolId(context.sourceVersionId, 'class', qualifiedName, span),
        kind: 'class',
        name,
        qualifiedName,
        signature: definitionSignature(nodeText(content, node)),
        detail: docstring,
        span,
        confidence: 1,
        metadata: {
          docstring,
          decorators,
        },
      },
      node,
      containerSymbolId: context.containerSymbolId,
    };
  }

  if (node.type.name === 'FunctionDefinition') {
    const nameNode = findFirstChild(node, 'VariableName');
    const body = findFirstChild(node, 'Body');
    if (!nameNode) {
      return null;
    }
    const kind: ExtractedSymbolKind = context.className ? 'method' : 'function';
    const name = identifierText(content, nameNode);
    const qualifiedName = context.className
      ? `${context.moduleName}.${context.className}.${name}`
      : `${context.moduleName}.${name}`;
    const span = definitionHeaderSpan(content, node, body);
    const docstring = extractBodyDocstring(body, content);
    const annotations = collectFunctionAnnotations(node, content);
    return {
      symbol: {
        id: stableSymbolId(context.sourceVersionId, kind, qualifiedName, span),
        kind,
        name,
        qualifiedName,
        signature: definitionSignature(nodeText(content, node)).replace(/^def\s+/, ''),
        detail: docstring,
        span,
        confidence: 1,
        metadata: {
          docstring,
          decorators,
          annotations,
        },
      },
      node,
      containerSymbolId: context.containerSymbolId,
    };
  }

  if (!context.className && node.type.name === 'AssignStatement') {
    const nameNode = findFirstChild(node, 'VariableName');
    if (!nameNode || !/^[A-Z][A-Z0-9_]*$/.test(identifierText(content, nameNode))) {
      return null;
    }
    const name = identifierText(content, nameNode);
    const qualifiedName = `${context.moduleName}.${name}`;
    const span = nodeSpan(content, node);
    return {
      symbol: {
        id: stableSymbolId(context.sourceVersionId, 'constant', qualifiedName, span),
        kind: 'constant',
        name,
        qualifiedName,
        signature: definitionSignature(nodeText(content, node)),
        detail: null,
        span,
        confidence: 1,
      },
      node,
      containerSymbolId: context.containerSymbolId,
    };
  }

  return null;
}

function collectSymbolsFromStatements(
  statements: SyntaxNode[],
  content: string,
  context: SymbolContext,
): CollectedSymbol[] {
  const symbols: CollectedSymbol[] = [];
  for (const statement of statements) {
    const { target, decorators } = unwrapDecorated(content, statement);
    const collected = symbolFromDefinition(target, content, context, decorators);
    if (!collected) {
      continue;
    }
    symbols.push(collected);
    if (target.type.name === 'ClassDefinition') {
      const body = findFirstChild(target, 'Body');
      if (!body) {
        continue;
      }
      symbols.push(
        ...collectSymbolsFromStatements(childNodes(body), content, {
          ...context,
          className: collected.symbol.name,
          containerSymbolId: collected.symbol.id,
        }),
      );
    }
  }
  return symbols;
}

function localSymbolIndex(symbols: ExtractedSymbol[]): Map<string, ExtractedSymbol[]> {
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

function hasErrorNode(node: SyntaxNode): boolean {
  if (node.type.isError) {
    return true;
  }
  return childNodes(node).some((child) => hasErrorNode(child));
}

function callRelationshipSpan(content: string, callNode: SyntaxNode): ReturnType<typeof nodeSpan> {
  if (!hasErrorNode(callNode)) {
    return nodeSpan(content, callNode);
  }
  const argList = findFirstChild(callNode, 'ArgList');
  if (!argList) {
    return nodeSpan(content, callNode);
  }
  return spanFromOffsets(content, callNode.from, Math.min(argList.from + 1, content.length));
}

function collectImportRelationships(
  statements: SyntaxNode[],
  content: string,
  sourceVersionId: string,
): { relationships: ExtractedRelationship[]; importedNames: Set<string> } {
  const relationships: ExtractedRelationship[] = [];
  const importedNames = new Set<string>();

  for (const statement of statements.filter((node) => node.type.name === 'ImportStatement')) {
    if (nodeText(content, statement).startsWith('import ')) {
      for (const clause of collectBareImportClauses(content, statement)) {
        importedNames.add(clause.localName);
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'imports',
            sourceSymbolId: null,
            targetSymbolId: null,
            targetReference: clause.moduleReference,
            span: clause.span,
          }),
        );
      }
      continue;
    }

    const children = childNodes(statement);

    const importIndex = children.findIndex((child) => child.type.name === 'import');
    const moduleReference = children
      .slice(0, importIndex)
      .filter((child) => child.type.name === 'VariableName')
      .map((child) => identifierText(content, child))
      .join('.');
    const importedChildren = children.slice(importIndex + 1);
    for (let index = 0; index < importedChildren.length; index += 1) {
      const current = importedChildren[index]!;
      if (current.type.name !== 'VariableName') {
        continue;
      }
      const originalName = identifierText(content, current);
      const maybeAs = importedChildren[index + 1];
      const maybeAlias = importedChildren[index + 2];
      const aliasNode =
        maybeAs?.type.name === 'as' && maybeAlias?.type.name === 'VariableName' ? maybeAlias : null;
      const localNode = aliasNode ?? current;
      const localName = identifierText(content, localNode);
      importedNames.add(localName);
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'imports',
          sourceSymbolId: null,
          targetSymbolId: null,
          targetReference: moduleReference ? `${moduleReference}.${originalName}` : originalName,
          span: nodeSpan(content, localNode),
        }),
      );
      if (aliasNode) {
        index += 2;
      }
    }
  }

  return { relationships, importedNames };
}

function collectCallRelationships(
  sourceVersionId: string,
  content: string,
  owner: ExtractedSymbol,
  body: SyntaxNode,
  symbolsByName: Map<string, ExtractedSymbol[]>,
  importedNames: Set<string>,
  shadowedNames: Set<string>,
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type.name === 'FunctionDefinition' || node.type.name === 'ClassDefinition') {
      return;
    }
    if (node.type.name === 'CallExpression') {
      const callee = childNodes(node)[0] ?? null;
      const calleeName = callee ? nodeText(content, callee).trim() : null;
      if (calleeName) {
        const localTarget = resolveLexicalCallTarget(symbolsByName, importedNames, shadowedNames, calleeName);
        relationships.push(
          createRelationship(sourceVersionId, {
            type: 'calls',
            sourceSymbolId: owner.id,
            targetSymbolId: localTarget?.id ?? null,
            targetReference: localTarget ? null : calleeName,
            span: callRelationshipSpan(content, node),
          }),
        );
      }
    }
    for (const child of childNodes(node)) {
      visit(child);
    }
  };
  for (const child of childNodes(body)) {
    visit(child);
  }
  return relationships;
}

function collectScopeBindings(content: string, owner: SyntaxNode, body: SyntaxNode): Set<string> {
  const bindings = new Set<string>();
  const params = findFirstChild(owner, 'ParamList');
  if (params) {
    for (const child of childNodes(params)) {
      if (child.type.name === 'VariableName' && identifierText(content, child) !== 'self') {
        bindings.add(identifierText(content, child));
      }
    }
  }

  const visit = (node: SyntaxNode): void => {
    if (node !== body && (node.type.name === 'FunctionDefinition' || node.type.name === 'ClassDefinition')) {
      const nameNode = findFirstChild(node, 'VariableName');
      if (nameNode) {
        bindings.add(identifierText(content, nameNode));
      }
      return;
    }
    if (node.type.name === 'AssignStatement') {
      const children = childNodes(node);
      const lastAssignOpIndex = children.map((child) => child.type.name).lastIndexOf('AssignOp');
      for (const child of lastAssignOpIndex >= 0 ? children.slice(0, lastAssignOpIndex) : []) {
        if (child.type.name === 'VariableName') {
          bindings.add(identifierText(content, child));
        }
      }
    }
    if (node.type.name === 'ForStatement') {
      for (const child of childNodes(node)) {
        if (child.type.name === 'in') {
          break;
        }
        if (child.type.name === 'VariableName') {
          bindings.add(identifierText(content, child));
        }
      }
    }
    if (node.type.name === 'ImportStatement') {
      for (const binding of collectImportBindings(content, node)) {
        bindings.add(binding);
      }
    }
    if (node.type.name === 'TryStatement') {
      const children = childNodes(node);
      const asIndex = children.findIndex((child) => child.type.name === 'as');
      const aliasNode = asIndex >= 0 ? children[asIndex + 1] : null;
      if (aliasNode?.type.name === 'VariableName') {
        bindings.add(identifierText(content, aliasNode));
      }
    }
    for (const child of childNodes(node)) {
      visit(child);
    }
  };

  visit(body);
  return bindings;
}

function collectPythonRelationships(
  statements: SyntaxNode[],
  content: string,
  sourceVersionId: string,
  symbols: CollectedSymbol[],
  importedNames: Set<string>,
): ExtractedRelationship[] {
  const relationships: ExtractedRelationship[] = [];
  const symbolsByName = localSymbolIndex(symbols.map((entry) => entry.symbol));

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
  }

  for (const statement of statements) {
    const { target } = unwrapDecorated(content, statement);
    if (target.type.name !== 'ClassDefinition') {
      continue;
    }
    const classNameNode = findFirstChild(target, 'VariableName');
    const className = classNameNode ? identifierText(content, classNameNode) : undefined;
    if (!className) {
      continue;
    }
    const classSymbol = resolveLocalSymbol(symbolsByName, importedNames, new Set<string>(), className);
    if (!classSymbol) {
      continue;
    }
    const bases = findFirstChild(target, 'ArgList');
    for (const base of bases ? childNodes(bases).filter((child) => child.type.name === 'VariableName') : []) {
      const baseName = identifierText(content, base);
      const targetSymbol = resolveLocalSymbol(symbolsByName, importedNames, new Set<string>(), baseName);
      relationships.push(
        createRelationship(sourceVersionId, {
          type: 'inherits',
          sourceSymbolId: classSymbol.id,
          targetSymbolId: targetSymbol?.id ?? null,
          targetReference: targetSymbol ? null : baseName,
          span: nodeSpan(content, base),
        }),
      );
    }
    const body = findFirstChild(target, 'Body');
    if (!body) {
      continue;
    }
    const priorClassBindings = new Set<string>();
    for (const child of childNodes(body)) {
      if (child.type.name === 'AssignStatement') {
        const variableNames = findChildren(child, 'VariableName');
        const lhs = variableNames[0] ?? null;
        const rhs = variableNames[1] ?? null;
        if (rhs) {
          const rhsName = identifierText(content, rhs);
          const localTarget = resolveLocalSymbol(symbolsByName, importedNames, priorClassBindings, rhsName);
          relationships.push(
            createRelationship(sourceVersionId, {
              type: 'references',
              sourceSymbolId: classSymbol.id,
              targetSymbolId: localTarget?.id ?? null,
              targetReference: localTarget ? null : rhsName,
              span: nodeSpan(content, rhs),
            }),
          );
        }
        if (lhs) {
          priorClassBindings.add(identifierText(content, lhs));
        }
        continue;
      }
      if (child.type.name === 'ImportStatement') {
        for (const binding of collectImportBindings(content, child)) {
          priorClassBindings.add(binding);
        }
        continue;
      }
      if (child.type.name === 'FunctionDefinition' || child.type.name === 'ClassDefinition') {
        const nameNode = findFirstChild(child, 'VariableName');
        if (nameNode) {
          priorClassBindings.add(identifierText(content, nameNode));
        }
      }
    }
  }

  for (const entry of symbols.filter((candidate) => candidate.symbol.kind === 'function' || candidate.symbol.kind === 'method')) {
    const body = findFirstChild(entry.node, 'Body');
    if (!body) {
      continue;
    }
    const shadowedNames = collectScopeBindings(content, entry.node, body);
    relationships.push(
      ...collectCallRelationships(
        sourceVersionId,
        content,
        entry.symbol,
        body,
        symbolsByName,
        importedNames,
        shadowedNames,
      ),
    );
  }
  return relationships;
}

export class PythonAnalyzer implements DeterministicAnalyzer {
  public readonly id = 'python-lezer';
  public readonly version = '1.0.0';

  public supports(input: AnalyzerSelectionInput): boolean {
    if (isPythonMimeType(input.mimeType)) {
      return true;
    }
    return PYTHON_EXTENSIONS.has(path.extname(input.sourcePath ?? '').toLowerCase());
  }

  public async analyze(input: AnalyzerInput): Promise<DeterministicExtraction> {
    const tree = parser.parse(input.content);
    const moduleName = moduleNameFromPath(input.sourcePath, input.sourceVersionId);
    const title = path.basename(input.sourcePath ?? input.sourceVersionId);
    const statements = childNodes(tree.topNode);
    const module = moduleSymbol(input.sourceVersionId, moduleName, input.content);
    const sections: ExtractedSection[] = [];
    const moduleDocstringStatement = statements.find((statement) => statement.type.name === 'ExpressionStatement');
    const moduleString = moduleDocstringStatement ? findFirstChild(moduleDocstringStatement, 'String') : null;
    if (moduleDocstringStatement && moduleString) {
      sections.push(sectionForNode(input.content, 'docstring', moduleDocstringStatement, title));
    }
    for (const statement of statements.filter((node) => node.type.name === 'ImportStatement')) {
      sections.push(sectionForNode(input.content, 'import', statement));
    }

    const imports = collectImportRelationships(statements, input.content, input.sourceVersionId);
    const collectedSymbols = collectSymbolsFromStatements(statements, input.content, {
      moduleName,
      sourceVersionId: input.sourceVersionId,
      containerSymbolId: module.id,
      importedNames: imports.importedNames,
    });
    for (const collected of collectedSymbols) {
      sections.push(sectionForNode(input.content, collected.symbol.kind, collected.node, collected.symbol.name));
    }

    const symbols = [module, ...collectedSymbols.map((entry) => entry.symbol)];
    const relationships = [
      ...imports.relationships,
      ...collectPythonRelationships(
        statements,
        input.content,
        input.sourceVersionId,
        collectedSymbols,
        imports.importedNames,
      ),
    ];
    const summary = moduleString
      ? nodeText(input.content, moduleString)
      : buildSummaryFromSections(sections);

    return {
      analyzerId: this.id,
      analyzerVersion: this.version,
      sourceVersionId: input.sourceVersionId,
      title,
      summary,
      sections,
      symbols,
      relationships,
      links: [],
      diagnostics: collectParseDiagnostics(input.content, tree),
    };
  }
}
