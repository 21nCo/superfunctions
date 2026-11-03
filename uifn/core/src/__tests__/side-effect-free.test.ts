import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// package.json declares `"sideEffects": false`, which lets bundlers drop any @uifn/core module whose exports an
// app does not use. That is only safe while importing a module does nothing but declare bindings, so this test
// rejects top-level statements that could run observable code at import time.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoot = join(packageRoot, 'src');

// Top-level initializers may call only these, which build and freeze a value without touching shared state.
const PURE_INITIALIZER_CALLEES = new Set(['Object.freeze', 'defineUIFnStaticContract', 'freezeUIFnParts']);

function shippedModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : shippedModules(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** Each top-level statement of `source` that could have an import-time side effect, described for the report. */
function importTimeEffects(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const effects: string[] = [];
  const at = (node: ts.Node) => `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause) effects.push(`${at(statement)} side-effect import ${statement.moduleSpecifier.getText(file)}`);
      continue;
    }
    if (
      ts.isExportDeclaration(statement)
      || ts.isFunctionDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isModuleDeclaration(statement)
    ) continue;
    if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        const isStatic = ts.isClassStaticBlockDeclaration(member)
          || (ts.isPropertyDeclaration(member) && member.initializer && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword));
        if (isStatic) effects.push(`${at(member)} static class initializer runs at import`);
      }
      if (ts.getDecorators(statement)?.length) effects.push(`${at(statement)} class decorator runs at import`);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue;
        const initializer = unwrap(declaration.initializer);
        if (ts.isCallExpression(initializer) || ts.isNewExpression(initializer)) {
          const callee = initializer.expression.getText(file);
          if (ts.isNewExpression(initializer) || !PURE_INITIALIZER_CALLEES.has(callee)) {
            effects.push(`${at(declaration)} initializer calls ${ts.isNewExpression(initializer) ? 'new ' : ''}${callee}`);
          }
        } else if (ts.isTaggedTemplateExpression(initializer) || ts.isAwaitExpression(initializer)) {
          effects.push(`${at(declaration)} initializer evaluates ${ts.SyntaxKind[initializer.kind]}`);
        }
      }
      continue;
    }
    effects.push(`${at(statement)} top-level ${ts.SyntaxKind[statement.kind]}`);
  }
  return effects;
}

describe('@uifn/core import-time side effects', () => {
  it('declares sideEffects: false so bundlers can drop unused primitives', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { sideEffects?: unknown };
    expect(manifest.sideEffects).toBe(false);
  });

  it('keeps every shipped module free of import-time side effects', () => {
    const modules = shippedModules(sourceRoot);
    expect(modules.length).toBeGreaterThan(50);
    const effects = modules.flatMap((path) => importTimeEffects(relative(packageRoot, path), readFileSync(path, 'utf8')));
    expect(effects).toEqual([]);
  });

  it('reports the statements that would make sideEffects: false unsafe', () => {
    const source = [
      "import './register';",
      "import type { Foo } from './foo';",
      'const registry = new Map();',
      'export const ready = registerPrimitive("Tabs");',
      'export const frozen = Object.freeze({ a: 1 });',
      'globalThis.uifn = true;',
      'class Registry { static instance = createRegistry(); }',
      'export function pure() { return registerPrimitive("Menu"); }',
    ].join('\n');
    expect(importTimeEffects('fixture.ts', source)).toEqual([
      "fixture.ts:1 side-effect import './register'",
      'fixture.ts:3 initializer calls new Map',
      'fixture.ts:4 initializer calls registerPrimitive',
      'fixture.ts:6 top-level ExpressionStatement',
      'fixture.ts:7 static class initializer runs at import',
    ]);
  });
});
