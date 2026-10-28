/**
 * Every public declaration the package exports carries a JSDoc comment, so an
 * editor hover on `device.swipe` or `locator.tap` explains it instead of
 * showing a bare signature. Checked on the source the `.d.ts` files are
 * emitted from: each export of `index.ts`, and each public member (each
 * overload signature separately) of the classes and interfaces it exports.
 * Members named with `_`, `private`/`protected` ones and `@internal` ones
 * are not public.
 */

import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ENTRY = path.resolve(import.meta.dirname, '../index.ts');

/**
 * Exports whose members are exempt. The gRPC client is the low-level
 * transport `Device` wraps, exported for advanced use and documented at the
 * class level only.
 */
const MEMBERS_EXEMPT = new Set(['TapsmithGrpcClient']);

function hasJsDoc(node: ts.Node): boolean {
  if (ts.getJSDocCommentsAndTags(node).some((doc) => ts.isJSDoc(doc))) return true;
  // TypeScript parses no JSDoc onto an expression statement; read its comment.
  const text = node.getSourceFile().text;
  return (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
    .some((range) => text.startsWith('/**', range.pos));
}

function isInternal(node: ts.Node): boolean {
  return ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'internal');
}

function where(node: ts.Node): string {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(path.dirname(ENTRY), file.fileName)}:${line + 1}`;
}

/** The implementation of an overloaded function or method (not shown to callers). */
function isOverloadImplementation(decl: ts.Declaration, all: readonly ts.Declaration[]): boolean {
  return all.length > 1
    && (ts.isMethodDeclaration(decl) || ts.isFunctionDeclaration(decl))
    && decl.body !== undefined;
}

/**
 * The node a declaration's JSDoc attaches to: the statement for `const x = …`
 * and for an expando like `expect.soft = …`, the declaration itself otherwise.
 */
function docHost(decl: ts.Declaration): ts.Node {
  if (ts.isVariableDeclaration(decl)) return decl.parent.parent;
  let node: ts.Node = decl;
  if (ts.isPropertyAccessExpression(node) || ts.isBinaryExpression(node)) {
    while (!ts.isExpressionStatement(node) && node.parent) node = node.parent;
  }
  return node;
}

function undocumented(): string[] {
  const program = ts.createProgram([ENTRY], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(ENTRY)!)!;
  const missing: string[] = [];

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const decls = symbol.declarations ?? [];
    for (const decl of decls) {
      if (isOverloadImplementation(decl, decls)) continue;
      if (!hasJsDoc(docHost(decl))) missing.push(`${exported.name} (${where(decl)})`);
    }

    if (!(symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) continue;
    if (MEMBERS_EXEMPT.has(exported.name)) continue;
    for (const member of symbol.members?.values() ?? []) {
      const name = member.getName();
      if (name.startsWith('_') || name.startsWith('#') || name === '__constructor' || name === '__index') continue;
      const memberDecls = member.declarations ?? [];
      for (const decl of memberDecls) {
        if (ts.isTypeParameterDeclaration(decl)) continue;
        if (ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
        if (isInternal(decl) || isOverloadImplementation(decl, memberDecls)) continue;
        if (!hasJsDoc(decl)) missing.push(`${exported.name}.${name} (${where(decl)})`);
      }
    }
  }
  return missing;
}

describe('public API JSDoc', () => {
  it('documents every export and every public member', () => {
    expect(undocumented()).toEqual([]);
  }, 60_000);
});
