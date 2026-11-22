// Checks that a built McpFn package which inlines @modelcontextprotocol/sdk
// (tsup `noExternal`) bundled exactly the SDK version its package.json pins
// (MCP-13). Consumers cannot override bundled code, so a stale or mismatched
// bundle would ship SDK advisories that the manifest claims are fixed.
//
// The package's tsup config writes `bundledSdkBanner()` at the top of every
// bundle. The banner names the SDK version installed when tsup ran, so the
// version is part of the built bytes: a dist built from another SDK release
// keeps its old stamp (or has none) even after node_modules and the pin
// change. esbuild chains the SDK's own source maps, so the source-map entries
// name SDK `src/*.ts` files that are not published and carry no
// sourcesContent; they only show where the SDK was resolved from.
//
// Usage: node scripts/verify-mcpfn-bundled-sdk.mjs, run from the package
// directory (the core and auth build scripts run it after tsup). The CLI only
// accepts the McpFn packages that inline the SDK.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SDK_NAME = "@modelcontextprotocol/sdk";
const SDK_SEGMENT = `node_modules/${SDK_NAME}/`;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const STAMP = /\/\*! bundled @modelcontextprotocol\/sdk@([^\s*]+) \*\//g;
const BUNDLES = [
  { file: "index.js", map: "index.js.map" },
  { file: "index.cjs", map: "index.cjs.map" },
];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLING_PACKAGES = ["mcpfn/core", "mcpfn/auth"].map((directory) => path.join(REPO_ROOT, directory));

export class BundledSdkError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BundledSdkError";
    this.details = details;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Finds the SDK that a bare `@modelcontextprotocol/sdk/...` import from
 * `packageRoot` resolves to (the nearest node_modules copy, as Node and
 * esbuild resolve it) and returns `{ root, version }`.
 */
export function resolveInstalledSdk(packageRoot) {
  let dir = path.resolve(packageRoot);
  for (;;) {
    const manifest = path.join(dir, "node_modules", SDK_NAME, "package.json");
    if (existsSync(manifest)) return { root: path.dirname(manifest), version: readJson(manifest).version };
    const parent = path.dirname(dir);
    if (parent === dir) throw new BundledSdkError(`${SDK_NAME} is not installed for ${packageRoot}`);
    dir = parent;
  }
}

/** The banner the package's tsup config writes at the top of each bundle. */
export function bundledSdkBanner(packageRoot) {
  return `/*! bundled ${SDK_NAME}@${resolveInstalledSdk(packageRoot).version} */`;
}

// Executable loads of the SDK: `import ... from "<sdk>"`, `export ... from
// "<sdk>"`, `import "<sdk>"`, and a call through `import(`, `require(`,
// esbuild's `__require(`, a `createRequire(...)` result or a `require` method
// whose specifier can evaluate to the SDK (MCP-13). The bundle is parsed with
// the TypeScript parser, so comments, strings, template text and regular
// expressions are never mistaken for code, every ECMAScript line terminator
// and escape is handled, and specifiers and identifiers are compared decoded.
// A bundle that does not parse fails instead of passing.
//
// Callee and specifier go through one normalization (`operands`): parentheses
// are stripped, a comma sequence or an assignment yields its last operand, a
// conditional or logical expression yields both operands, and an identifier
// also yields every value assigned to the binding it resolves to lexically.
// `(0, require)(("<sdk>"))`, `const r = require; r(id)` with `const id =
// "<sdk>"` in scope, and `"@modelcontextprotocol/" + "sdk"` are all loads.
const { SyntaxKind } = ts;
const SDK_LOADERS = new Set(["require", "__require"]);
const SEQUENCE_OPERATORS = new Set([SyntaxKind.CommaToken, SyntaxKind.EqualsToken]);
const EITHER_OPERATORS = new Set([SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken, SyntaxKind.QuestionQuestionToken]);
const CONCAT_OPERATORS = new Set([SyntaxKind.PlusToken, SyntaxKind.PlusEqualsToken]);
const LOGICAL_ASSIGNMENTS = new Set([SyntaxKind.BarBarEqualsToken, SyntaxKind.AmpersandAmpersandEqualsToken, SyntaxKind.QuestionQuestionEqualsToken]);
const MAX_STRING_VALUES = 64;
const MAX_RESOLUTION_STEPS = 10_000;
const isSdkName = (text) => text === SDK_NAME || text.startsWith(`${SDK_NAME}/`);
const isFunction = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);
const keyText = (name) => (ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined);

// An identifier in a property-name or label position, which names no binding.
function isNamePosition(node) {
  const { parent } = node;
  if (ts.isPropertyAccessExpression(parent) || ts.isMetaProperty(parent)) return parent.name === node;
  if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isAccessor(parent)) return parent.name === node;
  if (ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) return parent.propertyName === node;
  return ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent);
}

// The lexical bindings of one bundle, from the TypeScript binder and checker:
// what each binding is assigned, and where each name is used.
function indexBindings(file, source) {
  const host = {
    getSourceFile: (name) => (name === file ? source : undefined),
    fileExists: (name) => name === file,
    readFile: () => undefined,
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const checker = ts.createProgram([file], { allowJs: true, noLib: true, noResolve: true, types: [] }, host).getTypeChecker();
  const symbolOf = (id) =>
    ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
  const values = new Map();
  const uses = new Map();
  let dynamicScope = false;
  const add = (map, key, value) => key !== undefined && map.set(key, [...(map.get(key) ?? []), value]);
  const visit = (node) => {
    if (ts.isIdentifier(node) && !isNamePosition(node)) add(uses, ts.idText(node), node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) add(values, symbolOf(node.name), node.initializer);
    // `const { require: r } = x` and `({ require: r } = x)` bind a require method.
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && keyText(node.propertyName ?? node.name) === "require") add(values, symbolOf(node.name), node);
    if (ts.isBinaryExpression(node) && ts.isIdentifier(ts.skipParentheses(node.left))) {
      // `x += y` can make x `x + y`; `x ||= y`, `&&=` and `??=` can make it y.
      const target = symbolOf(ts.skipParentheses(node.left));
      if (node.operatorToken.kind === SyntaxKind.PlusEqualsToken) add(values, target, node);
      if (LOGICAL_ASSIGNMENTS.has(node.operatorToken.kind)) add(values, target, node.right);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      const target = ts.skipParentheses(node.left);
      if (ts.isIdentifier(target)) add(values, symbolOf(target), node.right);
      if (ts.isObjectLiteralExpression(target)) {
        for (const property of target.properties) {
          if (ts.isPropertyAssignment(property) && keyText(property.name) === "require" && ts.isIdentifier(property.initializer)) add(values, symbolOf(property.initializer), property);
        }
      }
    }
    // `with` and any reference to `eval` (a direct eval, even parenthesized,
    // can rebind locals) disable the inert-receiver exemption.
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && ts.idText(node) === "eval" && !isNamePosition(node))) dynamicScope = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { symbolOf, values: (symbol) => values.get(symbol) ?? [], uses: (name) => uses.get(name) ?? [], dynamicScope, active: new Map(), proofs: new Map(), steps: 0, incomplete: false };
}

// Every value resolution shares one step budget per call and tracks the
// bindings it is expanding, so it terminates on any bundle; a bundle whose
// values cannot be resolved within the budget fails instead of passing. A
// binding reached again while it is expanded (`p = p + "x"`) yields the values
// gathered for it so far, so a cycle is unrolled once instead of dropped.
function step(scope) {
  scope.steps += 1;
  if (scope.steps > MAX_RESOLUTION_STEPS) {
    throw new BundledSdkError(`cannot resolve the values of a call in the bundle within ${MAX_RESOLUTION_STEPS} steps`);
  }
}

function throughBinding(node, scope, resolve) {
  const symbol = scope.symbolOf(node);
  if (symbol === undefined || scope.values(symbol).length === 0) {
    scope.incomplete = true;
    return [];
  }
  if (!scope.active.has(resolve)) scope.active.set(resolve, new Map());
  const expanding = scope.active.get(resolve);
  if (expanding.has(symbol)) {
    scope.incomplete = true;
    return [...expanding.get(symbol)];
  }
  const gathered = [];
  expanding.set(symbol, gathered);
  try {
    for (const value of scope.values(symbol)) gathered.push(...resolve(value, scope));
    return gathered;
  } finally {
    expanding.delete(symbol);
  }
}

// One normalization for callee and specifier: `operands` follows parentheses,
// the last operand of a comma sequence or assignment, and both operands of a
// conditional or logical expression.
function operands(node) {
  if (ts.isParenthesizedExpression(node)) return [node.expression];
  if (ts.isBinaryExpression(node) && SEQUENCE_OPERATORS.has(node.operatorToken.kind)) return [node.right];
  if (ts.isBinaryExpression(node) && EITHER_OPERATORS.has(node.operatorToken.kind)) return shortCircuit(node);
  if (ts.isConditionalExpression(node)) {
    const truthy = literalTruthiness(node.condition);
    return truthy === undefined ? [node.whenTrue, node.whenFalse] : [truthy ? node.whenTrue : node.whenFalse];
  }
  return undefined;
}

// Whether a literal is truthy, null-ish (`nullish: true`), or undefined when
// `node` is not a literal and either outcome is possible.
function literalTruthiness(node) {
  const literal = ts.skipParentheses(node);
  if (ts.isStringLiteralLike(literal)) return literal.text !== "";
  if (ts.isNumericLiteral(literal)) return Number(literal.text) !== 0;
  if (literal.kind === SyntaxKind.TrueKeyword) return true;
  if (literal.kind === SyntaxKind.FalseKeyword || literal.kind === SyntaxKind.NullKeyword) return false;
  return undefined;
}

// The operands of `a || b`, `a && b` or `a ?? b` that can be its value; a
// literal left operand decides the outcome statically.
function shortCircuit(node) {
  const truthy = literalTruthiness(node.left);
  if (truthy === undefined) return [node.left, node.right];
  const kind = node.operatorToken.kind;
  if (kind === SyntaxKind.QuestionQuestionToken) return [ts.skipParentheses(node.left).kind === SyntaxKind.NullKeyword ? node.right : node.left];
  return [(kind === SyntaxKind.BarBarToken) === truthy ? node.left : node.right];
}

// The expressions `node` can evaluate to, through operands and the values of
// the bindings it names.
function leaves(node, scope) {
  step(scope);
  const inner = operands(node);
  if (inner) return inner.flatMap((operand) => leaves(operand, scope));
  return ts.isIdentifier(node) ? [node, ...throughBinding(node, scope, leaves)] : [node];
}

function combine(parts) {
  return parts.reduce((left, right) => {
    if (left.length * right.length > MAX_STRING_VALUES) {
      throw new BundledSdkError(`cannot resolve the values of a call in the bundle: more than ${MAX_STRING_VALUES} candidate strings`);
    }
    return left.flatMap((a) => right.map((b) => a + b));
  }, [""]);
}

// The strings `node` can evaluate to, folding `+` and template substitutions.
function stringValues(node, scope) {
  step(scope);
  const inner = operands(node);
  if (inner) return inner.flatMap((operand) => stringValues(operand, scope));
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isIdentifier(node)) return throughBinding(node, scope, stringValues);
  if (ts.isBinaryExpression(node) && CONCAT_OPERATORS.has(node.operatorToken.kind)) {
    return combine([stringValues(node.left, scope), stringValues(node.right, scope)]);
  }
  if (ts.isTemplateExpression(node)) {
    return combine([[node.head.text], ...node.templateSpans.flatMap((span) => [stringValues(span.expression, scope), [span.literal.text]])]);
  }
  scope.incomplete = true;
  return [];
}

// The keys a member access `x.name` or `x[key]` can read, and whether every
// value of `key` was resolved. A key past the resolution budget is unresolved.
function memberKeys(node, scope) {
  if (ts.isPropertyAccessExpression(node)) return { keys: [ts.idText(node.name)], complete: true };
  const outer = { steps: scope.steps, incomplete: scope.incomplete };
  Object.assign(scope, { steps: 0, incomplete: false });
  try {
    const keys = stringValues(node.argumentExpression, scope);
    return { keys, complete: !scope.incomplete };
  } catch (error) {
    if (!(error instanceof BundledSdkError)) throw error;
    return { keys: [], complete: false };
  } finally {
    Object.assign(scope, outer);
  }
}

const isMemberAccess = (node) => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

// Whether member access `node` can read `name` (an unresolved key can).
function mayRead(node, name, scope) {
  if (!isMemberAccess(node)) return false;
  const { keys, complete } = memberKeys(node, scope);
  return !complete || keys.includes(name);
}

// Whether member access `node` reads only `name`.
function readsOnly(node, name, scope) {
  if (!isMemberAccess(node)) return false;
  const { keys, complete } = memberKeys(node, scope);
  return complete && keys.length > 0 && keys.every((key) => key === name);
}

// Whether `node` (a receiver use) is `node.require(...)` or `node["require"](...)`
// called directly, possibly through parentheses or a comma sequence.
function isRequireCallReceiver(node, scope) {
  const member = node.parent;
  if (!isMemberAccess(member) || member.expression !== node || !readsOnly(member, "require", scope)) return false;
  let callee = member;
  while (ts.isParenthesizedExpression(callee.parent) || (ts.isBinaryExpression(callee.parent) && callee.parent.operatorToken.kind === SyntaxKind.CommaToken && callee.parent.right === callee)) {
    callee = callee.parent;
  }
  return ts.isCallExpression(callee.parent) && callee.parent.expression === callee;
}

// A function that cannot load anything: it refers only to its own parameters,
// never to `this` or `super`, and makes no call, `new`, tagged template or
// property access.
function isInertFunction(fn) {
  const parameters = new Set();
  const bind = (name) => (ts.isIdentifier(name) ? parameters.add(ts.idText(name)) : name.elements.forEach((element) => ts.isBindingElement(element) && bind(element.name)));
  fn.parameters.forEach((parameter) => bind(parameter.name));
  const inert = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || isMemberAccess(node) || ts.isMetaProperty(node)) return false;
    if (node.kind === SyntaxKind.ThisKeyword || node.kind === SyntaxKind.SuperKeyword) return false;
    if (ts.isIdentifier(node) && !isNamePosition(node) && !parameters.has(ts.idText(node))) return false;
    return !ts.forEachChild(node, (child) => !inert(child));
  };
  return fn.parameters.every(inert) && (fn.body === undefined || inert(fn.body));
}

// Receiver contract (MCP-13): a `require` method call with an SDK specifier is
// a load unless its receiver is an identifier, other than `module`, whose
// lexical binding at the call is declared exactly once, as a variable
// initialized with an object literal whose only `require` member is an inert
// function (`const helper = { require: (id) => id }`), and whose every use is
// the receiver of such a direct call, so it is never aliased, exported,
// reassigned or mutated. A same-name identifier the checker cannot resolve to
// another binding also counts as a use. `module`, an alias of it, a forwarding
// wrapper `{ require: (id) => require(id) }`, a global and any other receiver
// fail closed.
function isInertRequireReceiver(receiver, scope) {
  if (!ts.isIdentifier(receiver) || ts.idText(receiver) === "module" || scope.dynamicScope) return false;
  const symbol = scope.symbolOf(receiver);
  if (symbol === undefined) return false;
  if (!scope.proofs.has(symbol)) scope.proofs.set(symbol, isInertRequireBinding(receiver, symbol, scope));
  return scope.proofs.get(symbol);
}

function isInertRequireBinding(receiver, symbol, scope) {
  const [declaration, ...others] = symbol.declarations ?? [];
  if (!declaration || others.length > 0 || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  for (const use of scope.uses(ts.idText(receiver))) {
    if (use === declaration.name) continue;
    const useSymbol = ts.isExportSpecifier(use.parent) ? undefined : scope.symbolOf(use);
    if (useSymbol !== undefined && useSymbol !== symbol) continue;
    if (useSymbol === undefined || !isRequireCallReceiver(use, scope)) return false;
  }
  const object = declaration.initializer && ts.skipParentheses(declaration.initializer);
  if (!object || !ts.isObjectLiteralExpression(object) || object.properties.some((property) => ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name)))) return false;
  const members = object.properties.filter((property) => keyText(property.name) === "require");
  if (members.length !== 1) return false;
  const [member] = members;
  const fn = ts.isPropertyAssignment(member) ? ts.skipParentheses(member.initializer) : member;
  return isFunction(fn) && isInertFunction(fn);
}

const createsRequire = (node, scope) => (ts.isIdentifier(node) ? ts.idText(node) === "createRequire" : mayRead(node, "createRequire", scope));

// The loader `callee` can be, or undefined when none of its values loads.
function loaderName(callee, scope) {
  for (const leaf of leaves(callee, scope)) {
    if (ts.isIdentifier(leaf) && SDK_LOADERS.has(ts.idText(leaf))) return ts.idText(leaf);
    if (ts.isBindingElement(leaf) || ts.isPropertyAssignment(leaf)) return ".require";
    if (mayRead(leaf, "require", scope) && !isInertRequireReceiver(ts.skipParentheses(leaf.expression), scope)) return ".require";
    if (ts.isCallExpression(leaf) && leaves(leaf.expression, scope).some((inner) => createsRequire(inner, scope))) return "createRequire()";
  }
  return undefined;
}

function sdkLoad(node, scope) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && isSdkName(node.moduleSpecifier.text)) {
    return `${ts.isImportDeclaration(node) ? "import" : "export"} "${node.moduleSpecifier.text}"`;
  }
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return undefined;
  // The callee is resolved first, so only a call that can load spends the
  // budget on its specifier; a callee past the budget counts as a loader.
  const loader = node.expression.kind === SyntaxKind.ImportKeyword ? "import" : calleeLoader(node.expression, scope);
  if (!loader) return undefined;
  scope.steps = 0;
  const specifier = stringValues(node.arguments[0], scope).find(isSdkName);
  return specifier === undefined ? undefined : `${loader}("${specifier}")`;
}

function calleeLoader(callee, scope) {
  scope.steps = 0;
  try {
    return loaderName(callee, scope);
  } catch (error) {
    if (!(error instanceof BundledSdkError)) throw error;
    return "unresolved callee";
  }
}

function externalSdkImports(file, code) {
  const fileName = `/${file}`;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const [error] = source.parseDiagnostics ?? [{ start: 0, messageText: "parser reported no diagnostics" }];
  if (error) {
    const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
    throw new BundledSdkError(`cannot scan the bundle for ${SDK_NAME} imports: ${message} at offset ${error.start}`);
  }
  const scope = indexBindings(fileName, source);
  const imports = [];
  const visit = (node) => {
    const load = sdkLoad(node, scope);
    if (load) imports.push(load);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

function readPin(manifest) {
  const pinned = manifest.dependencies?.[SDK_NAME];
  if (typeof pinned !== "string" || !EXACT_VERSION.test(pinned)) {
    throw new BundledSdkError(
      `${manifest.name} must pin ${SDK_NAME} to an exact version, found ${JSON.stringify(pinned)}`,
      { pinned },
    );
  }
  return pinned;
}

// The bundle must inline the SDK (no executable SDK import) and carry the
// build-time stamp of exactly the pinned version.
function checkBundleCode(name, file, code, pinned) {
  const imports = externalSdkImports(file, code);
  if (imports.length > 0) {
    throw new BundledSdkError(`${name} dist/${file} imports ${SDK_NAME} instead of bundling it`, {
      bundle: file,
      imports,
    });
  }
  const stamps = [...new Set([...code.matchAll(STAMP)].map((match) => match[1]))];
  if (stamps.length === 0) {
    throw new BundledSdkError(
      `${name} dist/${file} has no bundled ${SDK_NAME} version stamp; rebuild it with npm run build`,
      { bundle: file },
    );
  }
  const wrongStamps = stamps.filter((version) => version !== pinned);
  if (wrongStamps.length > 0) {
    throw new BundledSdkError(
      `${name} dist/${file} bundles ${SDK_NAME} ${wrongStamps.join(", ")} but package.json pins ${pinned}`,
      { bundle: file, pinned, stamped: stamps },
    );
  }
}

// Where the bundled SDK sources were resolved from must be the pinned SDK.
// Returns the SDK version installed at each source-map SDK root.
function sourceMapSdkVersions(name, file, map, mapPath) {
  const sourceMap = readJson(mapPath);
  const sources = (sourceMap.sources ?? []).filter((source) =>
    source.replaceAll("\\", "/").includes(SDK_SEGMENT),
  );
  if (sources.length === 0) {
    throw new BundledSdkError(`${name} dist/${map} contains no ${SDK_NAME} sources`, { bundle: file });
  }
  const versions = {};
  for (const source of sources) {
    const absolute = path
      .resolve(path.dirname(mapPath), sourceMap.sourceRoot ?? "", source)
      .replaceAll("\\", "/");
    const sdkRoot = absolute.slice(0, absolute.lastIndexOf(SDK_SEGMENT) + SDK_SEGMENT.length - 1);
    if (sdkRoot in versions) continue;
    const sdkManifest = path.join(sdkRoot, "package.json");
    if (!existsSync(sdkManifest)) {
      throw new BundledSdkError(`${name} dist/${map} bundles ${SDK_NAME} from ${sdkRoot}, which is not installed`, {
        bundle: file,
        sdkRoot,
      });
    }
    versions[sdkRoot] = readJson(sdkManifest).version;
  }
  return { versions, sources: sources.length };
}

/**
 * Verifies the built bundles of the package at `packageRoot`.
 * Returns `{ name, pinned, bundles: [{ bundle, stamped, sdkRoots, versions, sources }] }`
 * or throws a BundledSdkError naming the mismatch.
 */
export function verifyBundledSdk(packageRoot) {
  const root = path.resolve(packageRoot);
  const manifest = readJson(path.join(root, "package.json"));
  const pinned = readPin(manifest);
  const bundles = [];
  for (const { file, map } of BUNDLES) {
    const bundlePath = path.join(root, "dist", file);
    const mapPath = path.join(root, "dist", map);
    if (!existsSync(bundlePath) || !existsSync(mapPath)) {
      throw new BundledSdkError(`${manifest.name} has no built ${file} with ${map}; build it first`, {
        bundle: file,
      });
    }
    checkBundleCode(manifest.name, file, readFileSync(bundlePath, "utf8"), pinned);
    const { versions, sources } = sourceMapSdkVersions(manifest.name, file, map, mapPath);
    const mismatched = Object.entries(versions).filter(([, version]) => version !== pinned);
    if (mismatched.length > 0) {
      throw new BundledSdkError(
        `${manifest.name} dist/${map} resolves ${SDK_NAME} from ${mismatched
          .map(([sdkRoot, version]) => `${sdkRoot} (${version})`)
          .join(", ")} but package.json pins ${pinned}`,
        { bundle: file, pinned, versions },
      );
    }
    bundles.push({
      bundle: file,
      stamped: pinned,
      sdkRoots: Object.keys(versions).map((sdkRoot) => path.relative(root, sdkRoot)),
      versions: [...new Set(Object.values(versions))],
      sources,
    });
  }
  return { name: manifest.name, pinned, bundles };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    // Only a known McpFn package directory is verified; no path comes from the
    // command line.
    const workingDirectory = realpathSync(process.cwd());
    const packageRoot = BUNDLING_PACKAGES.find((directory) => existsSync(directory) && realpathSync(directory) === workingDirectory);
    if (!packageRoot) {
      throw new BundledSdkError(
        `run this check from one of ${BUNDLING_PACKAGES.map((directory) => path.relative(REPO_ROOT, directory)).join(", ")}`,
      );
    }
    process.stdout.write(`${JSON.stringify(verifyBundledSdk(packageRoot))}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: error.message, details: error.details ?? {} })}\n`,
    );
    process.exit(1);
  }
}
