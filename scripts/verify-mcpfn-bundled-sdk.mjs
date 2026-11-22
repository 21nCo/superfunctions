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

// Data ban (MCP-13): the bundle inlines the SDK, so its executable code never
// needs the SDK package name as data. Every string literal, template fragment
// (cooked or raw text) and constant-folded string expression whose value
// contains `@modelcontextprotocol/sdk` fails the check, in any position: an
// import or export specifier, an argument of require, import(), call, apply,
// bind or any other function, a value held in a binding, member or parameter
// default. No callee or receiver is modeled, so an alias, wrapper or helper
// cannot hide a load. The bundle is parsed with the TypeScript parser:
// comments (the version stamp, esbuild path comments, JSDoc) and regular
// expressions are never read as strings, escapes are compared decoded, and a
// bundle that does not parse fails instead of passing.
//
// Folding covers `+`, `+=` and template substitutions over literals and
// identifiers, which resolve lexically (through the TypeScript checker) to
// every value their binding is assigned by a declaration initializer, `=`,
// `+=`, `||=`, `&&=` or `??=`. It follows parentheses, the last operand of a
// comma sequence and every operand of a conditional or logical expression,
// and unrolls a cycle (`p = p + "x"`) once. Each fold has a step budget and a
// candidate cap, and exceeding either fails closed. Out of scope: a specifier
// assembled at runtime from non-constant values (a call result, a parameter,
// a destructured or loop-bound value, character codes), which no static scan
// of the bundle can decide.
const { SyntaxKind } = ts;
const SEQUENCE_OPERATORS = new Set([SyntaxKind.CommaToken, SyntaxKind.EqualsToken]);
const LOGICAL_ASSIGNMENTS = [SyntaxKind.BarBarEqualsToken, SyntaxKind.AmpersandAmpersandEqualsToken, SyntaxKind.QuestionQuestionEqualsToken];
const EITHER_OPERATORS = new Set([SyntaxKind.BarBarToken, SyntaxKind.AmpersandAmpersandToken, SyntaxKind.QuestionQuestionToken, ...LOGICAL_ASSIGNMENTS]);
const VALUE_ASSIGNMENTS = new Set([SyntaxKind.EqualsToken, ...LOGICAL_ASSIGNMENTS]);
const CONCAT_OPERATORS = new Set([SyntaxKind.PlusToken, SyntaxKind.PlusEqualsToken]);
const MAX_STRING_VALUES = 64;
const MAX_RESOLUTION_STEPS = 10_000;
const hasSdkName = (text) => typeof text === "string" && text.includes(SDK_NAME);
const isTemplateFragment = (node) => ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
const isConcat = (node) => ts.isBinaryExpression(node) && CONCAT_OPERATORS.has(node.operatorToken.kind);

// The values each lexical binding of one bundle is assigned, from the
// TypeScript binder and checker.
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
  const values = new Map();
  const add = (id, value) => {
    const symbol = checker.getSymbolAtLocation(id);
    if (symbol !== undefined) values.set(symbol, [...(values.get(symbol) ?? []), value]);
  };
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) add(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && ts.isIdentifier(ts.skipParentheses(node.left))) {
      const kind = node.operatorToken.kind;
      // `x = y` (or `||=`, `&&=`, `??=`) can make x y; `x += y` makes it `x + y`.
      if (VALUE_ASSIGNMENTS.has(kind)) add(ts.skipParentheses(node.left), node.right);
      else if (kind === SyntaxKind.PlusEqualsToken) add(ts.skipParentheses(node.left), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { symbolOf: (id) => checker.getSymbolAtLocation(id), values: (symbol) => values.get(symbol) ?? [], active: new Map(), steps: 0 };
}

function step(scope) {
  scope.steps += 1;
  if (scope.steps > MAX_RESOLUTION_STEPS) {
    throw new BundledSdkError(`cannot fold a string expression in the bundle within ${MAX_RESOLUTION_STEPS} steps`);
  }
}

// The values of the binding `node` names. A binding reached again while it is
// expanded yields the values gathered for it so far.
function throughBinding(node, scope) {
  const symbol = scope.symbolOf(node);
  if (symbol === undefined) return [];
  if (scope.active.has(symbol)) return [...scope.active.get(symbol)];
  const gathered = [];
  scope.active.set(symbol, gathered);
  try {
    for (const value of scope.values(symbol)) gathered.push(...stringValues(value, scope));
    return gathered;
  } finally {
    scope.active.delete(symbol);
  }
}

function combine(parts) {
  return parts.reduce((left, right) => {
    if (left.length * right.length > MAX_STRING_VALUES) {
      throw new BundledSdkError(`cannot fold a string expression in the bundle: more than ${MAX_STRING_VALUES} candidate strings`);
    }
    return left.flatMap((a) => right.map((b) => a + b));
  }, [""]);
}

// The constant strings `node` can evaluate to; a non-constant part yields none.
function stringValues(node, scope) {
  step(scope);
  if (ts.isParenthesizedExpression(node)) return stringValues(node.expression, scope);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isNumericLiteral(node)) return [String(Number(node.text))];
  if (ts.isIdentifier(node)) return throughBinding(node, scope);
  if (ts.isConditionalExpression(node)) return [...stringValues(node.whenTrue, scope), ...stringValues(node.whenFalse, scope)];
  if (ts.isTemplateExpression(node)) {
    return combine([[node.head.text], ...node.templateSpans.flatMap((span) => [stringValues(span.expression, scope), [span.literal.text]])]);
  }
  if (!ts.isBinaryExpression(node)) return [];
  const kind = node.operatorToken.kind;
  if (SEQUENCE_OPERATORS.has(kind)) return stringValues(node.right, scope);
  if (EITHER_OPERATORS.has(kind)) return [...stringValues(node.left, scope), ...stringValues(node.right, scope)];
  if (CONCAT_OPERATORS.has(kind)) return combine([stringValues(node.left, scope), stringValues(node.right, scope)]);
  return [];
}

// The SDK name in executable data of the bundle, as `{ value, line }` entries.
function sdkReferences(file, code) {
  const fileName = `/${file}`;
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const [error] = source.parseDiagnostics ?? [{ start: 0, messageText: "parser reported no diagnostics" }];
  if (error) {
    const message = ts.flattenDiagnosticMessageText(error.messageText, " ");
    throw new BundledSdkError(`cannot scan the bundle for ${SDK_NAME} references: ${message} at offset ${error.start}`);
  }
  const scope = indexBindings(fileName, source);
  const found = new Map();
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node, value) => found.set(`${lineOf(node)}\0${value}`, { value, line: lineOf(node) });
  const fold = (node) => {
    Object.assign(scope, { steps: 0, active: new Map() });
    try {
      return stringValues(node, scope);
    } catch (error) {
      if (error instanceof BundledSdkError) error.message += ` at line ${lineOf(node)}`;
      throw error;
    }
  };
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || isTemplateFragment(node)) {
      for (const value of new Set([node.text, node.rawText])) if (hasSdkName(value)) report(node, value);
    } else if (isConcat(node) || ts.isTemplateExpression(node)) {
      for (const value of fold(node)) if (hasSdkName(value)) report(node, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found.values()];
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

// The bundle must inline the SDK (no SDK name in executable data) and carry
// the build-time stamp of exactly the pinned version.
function checkBundleCode(name, file, code, pinned) {
  const references = sdkReferences(file, code);
  if (references.length > 0) {
    const [{ value, line }] = references;
    throw new BundledSdkError(
      `${name} dist/${file} references ${SDK_NAME} in executable code instead of bundling it: ${JSON.stringify(value)} at line ${line}`,
      { bundle: file, references },
    );
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
