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

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * Every part of a top-level initializer that runs code at import, at any depth: calls other than the allow-listed
 * pure builders (whose arguments are checked in turn), `new`, tagged templates, `await`, assignments, `++`/`--`,
 * `delete` and static class members. Function and method bodies are skipped because declaring them runs nothing.
 */
function initializerEffects(
  initializer: ts.Expression,
  file: ts.SourceFile,
  at: (node: ts.Node) => string,
  pureCallees: ReadonlySet<string>,
): string[] {
  const effects: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
    ) {
      // A computed method name still evaluates at import.
      if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && ts.isComputedPropertyName(node.name)) visit(node.name);
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression).getText(file);
      if (!pureCallees.has(callee)) {
        effects.push(`${at(node)} initializer calls ${callee}`);
        return;
      }
      node.arguments.forEach(visit);
      return;
    }
    if (ts.isNewExpression(node)) {
      effects.push(`${at(node)} initializer calls new ${node.expression.getText(file)}`);
      return;
    }
    if (ts.isTaggedTemplateExpression(node) || ts.isAwaitExpression(node) || ts.isDeleteExpression(node)) {
      effects.push(`${at(node)} initializer evaluates ${ts.SyntaxKind[node.kind]}`);
      return;
    }
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      effects.push(`${at(node)} initializer assigns ${node.left.getText(file)}`);
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      effects.push(`${at(node)} initializer evaluates ${ts.SyntaxKind[node.kind]}`);
      return;
    }
    if (ts.isClassExpression(node)) {
      for (const member of node.members) {
        const isStatic = ts.isClassStaticBlockDeclaration(member)
          || (ts.isPropertyDeclaration(member) && member.initializer && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword));
        if (isStatic) effects.push(`${at(member)} static class initializer runs at import`);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  return effects;
}

/**
 * Module-level helpers that only forward their parameters to an allow-listed builder, such as
 * `function policy(value) { return Object.freeze(value); }`. Calling one is as pure as calling the builder.
 */
function pureLocalHelpers(file: ts.SourceFile): Set<string> {
  const helpers = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || statement.body?.statements.length !== 1) continue;
    const [only] = statement.body.statements;
    if (!only || !ts.isReturnStatement(only) || !only.expression) continue;
    const returned = unwrap(only.expression);
    if (!ts.isCallExpression(returned) || !PURE_INITIALIZER_CALLEES.has(unwrap(returned.expression).getText(file))) continue;
    const parameters = new Set(statement.parameters.map((parameter) => parameter.name.getText(file)));
    if (returned.arguments.every((argument) => ts.isIdentifier(argument) && parameters.has(argument.text))) {
      helpers.add(statement.name.text);
    }
  }
  return helpers;
}

/** Each top-level statement of `source` that could have an import-time side effect, described for the report. */
function importTimeEffects(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const effects: string[] = [];
  const at = (node: ts.Node) => `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const pureCallees = new Set([...PURE_INITIALIZER_CALLEES, ...pureLocalHelpers(file)]);
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
        if (declaration.initializer) effects.push(...initializerEffects(declaration.initializer, file, at, pureCallees));
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
      'export const nested = Object.freeze({ a: register() });',
      'export const listed = [1, Object.freeze([track()])];',
      'export const picked = flag ? Object.freeze({}) : make();',
      'export const sum = 1 + count();',
      'export const built = Object.freeze({ cache: new Map() });',
      'export const tagged = Object.freeze({ css: css`a` });',
      'export const assigned = Object.freeze({ a: (total += 1) });',
      'export const bumped = [counter++];',
      'export const keyed = { [key()]: 1 };',
      'export const lazy = Object.freeze({ run: () => register(), method() { return register(); } });',
      'function wrap(value) { return Object.freeze(value); }',
      'export const wrapped = Object.freeze({ a: wrap({ b: 1 }), c: wrap({ d: register() }) });',
      'function leaky(value) { register(); return Object.freeze(value); }',
      'export const viaLeaky = leaky({});',
    ].join('\n');
    expect(importTimeEffects('fixture.ts', source)).toEqual([
      "fixture.ts:1 side-effect import './register'",
      'fixture.ts:3 initializer calls new Map',
      'fixture.ts:4 initializer calls registerPrimitive',
      'fixture.ts:6 top-level ExpressionStatement',
      'fixture.ts:7 static class initializer runs at import',
      'fixture.ts:9 initializer calls register',
      'fixture.ts:10 initializer calls track',
      'fixture.ts:11 initializer calls make',
      'fixture.ts:12 initializer calls count',
      'fixture.ts:13 initializer calls new Map',
      'fixture.ts:14 initializer evaluates TaggedTemplateExpression',
      'fixture.ts:15 initializer assigns total',
      'fixture.ts:16 initializer evaluates PostfixUnaryExpression',
      'fixture.ts:17 initializer calls key',
      'fixture.ts:20 initializer calls register',
      'fixture.ts:22 initializer calls leaky',
    ]);
  });
});
