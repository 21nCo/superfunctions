import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// package.json declares `"sideEffects": false`, which lets bundlers drop any @uifn/core module whose exports an
// app does not use. That is only safe while importing a module does nothing but declare bindings, so this test
// denies module-level code by default. Only imports with bindings, re-exports, declarations and default exports are
// accepted, and each is walked in full (binding patterns, initializers, enum values, non-ambient namespace bodies and
// class definitions), skipping only what JavaScript defers or erases: function, method and accessor bodies with
// their parameters, instance field initializers, types and ambient declarations. Anything evaluated that can run
// code is reported, except calls to the allow-listed freeze/contract builders and helpers that only forward to them.
// Property reads, spreads and destructuring are accepted: they run user code only through getters or iterators.

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
 * Walks everything a module evaluates when it loads and records each piece that runs code, at any depth. It denies by
 * default: every child node is walked except the positions JavaScript defers or erases, which are function, arrow,
 * method, accessor and constructor bodies with their parameter lists, instance field initializers and type nodes.
 * Within that, it records calls other than the allow-listed pure builders (whose arguments are walked in turn), `new`,
 * tagged templates, `await`, assignments, `++`/`--` and `delete`. Classes are walked the way JavaScript defines them:
 * the `extends` expression, computed member names, decorators and static initializers all run at import, and an
 * unrecognised class member is reported.
 */
function importTimeScanner(file: ts.SourceFile, at: (node: ts.Node) => string, pureCallees: ReadonlySet<string>) {
  const effects: string[] = [];

  const visitClass = (node: ts.ClassLikeDeclaration): void => {
    if (ts.getDecorators(node)?.length) effects.push(`${at(node)} class decorator runs at import`);
    for (const clause of node.heritageClauses ?? []) {
      // `implements` is type-only; `extends` evaluates its expression when the class is defined.
      if (clause.token === ts.SyntaxKind.ExtendsKeyword) clause.types.forEach((type) => visit(type.expression));
    }
    for (const member of node.members) {
      if (ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) {
        effects.push(`${at(member)} class member decorator runs at import`);
      }
      if (member.name && ts.isComputedPropertyName(member.name)) visit(member.name.expression);
      if (ts.isClassStaticBlockDeclaration(member)) {
        effects.push(`${at(member)} static class initializer runs at import`);
      } else if (ts.isPropertyDeclaration(member)) {
        // Instance field initializers run per construction; static ones run when the class is defined.
        if (member.initializer && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
          effects.push(`${at(member)} static class initializer runs at import`);
        }
      } else if (
        ts.isMethodDeclaration(member)
        || ts.isConstructorDeclaration(member)
        || ts.isGetAccessorDeclaration(member)
        || ts.isSetAccessorDeclaration(member)
      ) {
        // Bodies and parameter defaults are deferred, but parameter decorators run when the class is defined.
        for (const parameter of member.parameters) {
          if (ts.getDecorators(parameter)?.length) effects.push(`${at(parameter)} parameter decorator runs at import`);
        }
      } else if (!ts.isIndexSignatureDeclaration(member) && !ts.isSemicolonClassElement(member)) {
        effects.push(`${at(member)} class member ${ts.SyntaxKind[member.kind]}`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isExpressionWithTypeArguments(node)) {
      // An instantiation expression (`make<T>`) still evaluates its expression; only the type arguments are erased.
      visit(node.expression);
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isClassExpression(node)) {
      visitClass(node);
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      // An object-literal method body is deferred, but a computed name still evaluates at import.
      if (ts.isComputedPropertyName(node.name)) visit(node.name);
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
    ts.forEachChild(node, visit);
  };

  return { effects, visit, visitClass };
}

/**
 * Module-level helpers that only forward their plain parameters (no defaults, no destructuring) to an allow-listed
 * builder, such as `function policy(value) { return Object.freeze(value); }`. Calling one is as pure as calling the
 * builder.
 */
function pureLocalHelpers(file: ts.SourceFile): Set<string> {
  const helpers = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name || statement.body?.statements.length !== 1) continue;
    const [only] = statement.body.statements;
    if (!only || !ts.isReturnStatement(only) || !only.expression) continue;
    const returned = unwrap(only.expression);
    if (!ts.isCallExpression(returned) || !PURE_INITIALIZER_CALLEES.has(unwrap(returned.expression).getText(file))) continue;
    // A parameter default or destructuring pattern runs code on every call, so such a helper is not pure.
    if (statement.parameters.some((parameter) => parameter.initializer || !ts.isIdentifier(parameter.name))) continue;
    const parameters = new Set(statement.parameters.map((parameter) => parameter.name.getText(file)));
    if (returned.arguments.every((argument) => ts.isIdentifier(argument) && parameters.has(argument.text))) {
      helpers.add(statement.name.text);
    }
  }
  return helpers;
}

function isAmbient(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false);
}

/**
 * Each module-level construct of `source` that could have an import-time side effect, described for the report.
 * Statements are denied by default: only imports with bindings, re-exports, declarations and `export default`/
 * `export =` are accepted, and each of those is walked in full. A non-ambient namespace body runs at import, so its
 * statements are checked under the same rules; ambient (`declare`) statements and type-only declarations emit nothing.
 */
function importTimeEffects(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node) => `${fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const pureCallees = new Set([...PURE_INITIALIZER_CALLEES, ...pureLocalHelpers(file)]);
  const { effects, visit, visitClass } = importTimeScanner(file, at, pureCallees);

  const visitStatements = (statements: readonly ts.Statement[]): void => {
    for (const statement of statements) {
      if (ts.isImportDeclaration(statement)) {
        if (!statement.importClause) effects.push(`${at(statement)} side-effect import ${statement.moduleSpecifier.getText(file)}`);
        continue;
      }
      if (
        isAmbient(statement)
        || ts.isFunctionDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isEmptyStatement(statement)
      ) continue;
      if (ts.isModuleDeclaration(statement)) {
        // `namespace A.B {}` nests the inner namespace as the body.
        const body = statement.body;
        if (body && ts.isModuleBlock(body)) visitStatements(body.statements);
        else if (body && ts.isModuleDeclaration(body)) visitStatements([body]);
        continue;
      }
      if (ts.isClassDeclaration(statement)) {
        visitClass(statement);
        continue;
      }
      if (
        ts.isVariableStatement(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isExportDeclaration(statement)
        || ts.isExportAssignment(statement)
      ) {
        // Binding patterns (defaults, computed keys), initializers, enum member values and default exports all run.
        ts.forEachChild(statement, visit);
        continue;
      }
      effects.push(`${at(statement)} top-level ${ts.SyntaxKind[statement.kind]}`);
    }
  };

  visitStatements(file.statements);
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
      'export class Derived extends createBase() {}',
      'export const Anonymous = class extends make() {};',
      'class Keyed { [key()]() {} }',
      'export const KeyedField = class { [slot()] = 1; };',
      '@sealed class Sealed {}',
      'class Members { @logged method() {} }',
      'class Injected { constructor(@inject() dep: unknown) {} }',
      'export const DecoratedMember = class { @logged method() {} };',
      'function wrapDefault(value = register()) { return Object.freeze(value); }',
      'export const viaDefault = wrapDefault();',
      'function wrapPattern({ value }) { return Object.freeze(value); }',
      'export const viaPattern = wrapPattern({ value: 1 });',
      'export class Plain extends Base implements Shape { field = make(); method(value = register()) { return value; } }',
      'export const { a = register() } = {};',
      'export const [b = track()] = [];',
      'export const { [k()]: renamed } = source;',
      'export const { nested: { deep = make() } } = source;',
      'namespace Setup { register(); }',
      'export namespace Values { export const value = make(); }',
      'namespace Outer.Inner { setup(); }',
      'declare namespace Ambient { function f(): void; const v: number; }',
      'namespace Types { export interface Shape { a: number } export type Id = string; }',
      'declare const injected: number;',
      'enum Level { Low = 1, High = compute() }',
      'export default Object.freeze({ a: setup() });',
      'if (flag) setup();',
      'export const typed: Readonly<Record<string, number>> = Object.freeze({ a: 1 }) as Readonly<Record<string, number>>;',
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
      'fixture.ts:23 initializer calls createBase',
      'fixture.ts:24 initializer calls make',
      'fixture.ts:25 initializer calls key',
      'fixture.ts:26 initializer calls slot',
      'fixture.ts:27 class decorator runs at import',
      'fixture.ts:28 class member decorator runs at import',
      'fixture.ts:29 parameter decorator runs at import',
      'fixture.ts:30 class member decorator runs at import',
      'fixture.ts:32 initializer calls wrapDefault',
      'fixture.ts:34 initializer calls wrapPattern',
      'fixture.ts:36 initializer calls register',
      'fixture.ts:37 initializer calls track',
      'fixture.ts:38 initializer calls k',
      'fixture.ts:39 initializer calls make',
      'fixture.ts:40 top-level ExpressionStatement',
      'fixture.ts:41 initializer calls make',
      'fixture.ts:42 top-level ExpressionStatement',
      'fixture.ts:46 initializer calls compute',
      'fixture.ts:47 initializer calls setup',
      'fixture.ts:48 top-level IfStatement',
    ]);
  });
});
