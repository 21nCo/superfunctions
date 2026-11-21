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

// Comments are skipped, string and no-substitution template literals keep
// their text, and template substitutions and regular expression literals are
// tracked, so only executable code is scanned (MCP-13). An unterminated literal
// or comment throws: a bundle the scan cannot read fails instead of passing.
const EXPRESSION_KEYWORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const SDK_LOADERS = new Set(["import", "require", "__require"]);
const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);
const BLOCK_KEYWORDS = new Set(["else", "try", "finally", "do"]);
const ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };

// The value of a string literal, template text or identifier: \xHH, \uHHHH,
// \u{H...}, single-character escapes and line continuations are decoded.
function decodeEscapes(raw) {
  return raw.replaceAll(/\\(?:x([\da-fA-F]{2})|u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|(\r\n|[\s\S]))/g, (_, hex, point, unit, other) => {
    const code = hex ?? point ?? unit;
    if (code) return String.fromCodePoint(Number.parseInt(code, 16));
    if (/^(?:\r\n|[\n\r\u2028\u2029])$/.test(other)) return "";
    return ESCAPES[other] ?? other;
  });
}

// Whether a token ends an operand, so a following `/` divides.
function endsOperand(token) {
  if (!token) return false;
  if (token.type === "name") return !EXPRESSION_KEYWORDS.has(token.value);
  if (token.type === "punct") return token.value === "]" || (token.value === ")" && !token.control) || (token.value === "}" && !token.block);
  return true;
}

function tokenize(code) {
  const tokens = [];
  const templates = []; // brace depth at each open template `${`
  const parens = []; // whether each open `(` follows if, while, for or with
  const blocks = []; // whether each open `{` starts a block rather than an object
  let braces = 0;
  let index = code.startsWith("#!") ? code.indexOf("\n") : 0;
  if (index < 0) index = code.length;
  const fail = (what) => {
    throw new BundledSdkError(`cannot scan the bundle for ${SDK_NAME} imports: unterminated ${what} at offset ${index}`);
  };
  // A `/` starts a regular expression unless it follows an operand, including
  // a postfix ++ or -- (`i++ / 2`); after `if (...)` or a block it starts one.
  const regexAllowed = () => {
    const [before, previous, last] = tokens.slice(-3);
    const postfix = last?.value === previous?.value && ["+", "-"].includes(last?.value) && endsOperand(before);
    return !postfix && !endsOperand(last);
  };
  // A `{` opens a block after `)`, `=>`, a statement boundary or else, try,
  // finally and do; otherwise it opens an object literal.
  const opensBlock = () => {
    const [previous, last] = tokens.slice(-2);
    if (!last || (last.type === "punct" && "{};".includes(last.value))) return true;
    if (last.type === "punct") return last.value === ")" || (last.value === ">" && previous?.value === "=");
    return last.type === "name" && BLOCK_KEYWORDS.has(last.value);
  };
  // Reads template text from `start` to the closing backtick or the next `${`.
  const readTemplate = (start) => {
    for (let at = start; at < code.length; at += 1) {
      if (code[at] === "\\") at += 1;
      else if (code[at] === "`") return { end: at + 1, open: false, text: code.slice(start, at) };
      else if (code[at] === "$" && code[at + 1] === "{") return { end: at + 2, open: true };
    }
    return fail("template literal");
  };
  const readUntil = (start, quote, what) => {
    let inClass = false;
    for (let at = start; at < code.length; at += 1) {
      const char = code[at];
      if (char === "\n" || char === "\r") break;
      if (char === "\\") at += 1;
      else if (quote === "/" && (char === "[" || char === "]")) inClass = char === "[";
      else if (char === quote && !inClass) return at;
    }
    return fail(what);
  };
  const word = /(?:[\w$\u0080-\uffff]|\\u[\da-fA-F]{4}|\\u\{[\da-fA-F]+\})+/y;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "/" && next === "/") {
      const end = code.indexOf("\n", index);
      index = end < 0 ? code.length : end;
    } else if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2);
      if (end < 0) fail("comment");
      index = end + 2;
    } else if (char === "'" || char === "\"") {
      const end = readUntil(index + 1, char, "string");
      tokens.push({ type: "string", value: decodeEscapes(code.slice(index + 1, end)) });
      index = end + 1;
    } else if (char === "`" || (char === "}" && templates.at(-1) === braces)) {
      if (char === "}") templates.pop();
      const template = readTemplate(index + 1);
      if (template.open) templates.push(braces);
      const literal = char === "`" && !template.open;
      tokens.push(literal ? { type: "string", value: decodeEscapes(template.text) } : { type: "template" });
      index = template.end;
    } else if (char === "/" && regexAllowed()) {
      index = readUntil(index + 1, "/", "regular expression") + 1;
      word.lastIndex = index;
      if (word.test(code)) index = word.lastIndex; // flags
      tokens.push({ type: "regex" });
    } else {
      word.lastIndex = index;
      if (word.test(code)) {
        tokens.push({ type: /^\d/.test(char) ? "number" : "name", value: decodeEscapes(code.slice(index, word.lastIndex)) });
        index = word.lastIndex;
      } else {
        const token = { type: "punct", value: char };
        if (char === "(") parens.push(tokens.at(-1)?.type === "name" && CONTROL_KEYWORDS.has(tokens.at(-1).value));
        if (char === ")") token.control = parens.pop() ?? false;
        if (char === "{") blocks.push(opensBlock());
        if (char === "}") token.block = blocks.pop() ?? false;
        if (char === "{") braces += 1;
        if (char === "}") braces -= 1;
        tokens.push(token);
        index += 1;
      }
    }
  }
  return tokens;
}

// Executable loads of the SDK: `from "<sdk>"`, `import "<sdk>"` and
// `import(`, `require(` or esbuild's `__require(` with an SDK specifier,
// across any whitespace, line breaks or comments.
function externalSdkImports(code) {
  const tokens = tokenize(code);
  const imports = [];
  tokens.forEach((token, at) => {
    if (token.type !== "string" || (token.value !== SDK_NAME && !token.value.startsWith(`${SDK_NAME}/`))) return;
    const [before, call] = [tokens[at - 1], tokens[at - 2]];
    if (before?.value === "(" && call?.type === "name" && SDK_LOADERS.has(call.value)) {
      imports.push(`${call.value}("${token.value}")`);
    } else if (before?.type === "name" && (before.value === "from" || before.value === "import")) {
      imports.push(`${before.value} "${token.value}"`);
    }
  });
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
  const imports = externalSdkImports(code);
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
