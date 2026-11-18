#!/usr/bin/env node
/**
 * Typechecks the TypeScript code blocks of the BillFn recipes against the
 * current workspace packages (their built declarations).
 *
 * Every ```ts / ```typescript block is a module. A block whose first line is a
 * path comment (`// src/billing.ts`) is that file, so other blocks of the page
 * can import it (`./billing`); any other block gets a file of its own. A path
 * comment that ends in `(browser)` puts the block in the page's browser
 * program (DOM types); the others use the page's default environment. `stubs`
 * stand in for modules the page tells the reader to write themselves; they
 * join the default environment's program.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(docsDir, "../..");

const browser = { lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], types: [] };
const workers = { lib: ["lib.es2022.d.ts"], types: ["@cloudflare/workers-types"] };

export const RECIPES = [
  {
    file: "billfn/docs/content/docs/recipes/multi-region-workers.mdx",
    environment: workers,
    stubs: {
      "src/database.ts": [
        'import type { Adapter } from "@superfunctions/db";',
        'import type { Env } from "./env";',
        "export declare function createDatabase(env: Env): Adapter;",
      ].join("\n"),
      "src/mail.ts": [
        'import type { Env } from "./env";',
        "export declare function sendPlanEmail(",
        "  env: Env,",
        "  input: { billingAccountId: string; template: string; idempotencyKey: string; data: Record<string, unknown> },",
        "): Promise<void>;",
      ].join("\n"),
      "src/discount-tiers.ts": [
        'import type { Env } from "./env";',
        "export declare function discountTierOf(env: Env, billingAccountId: string): Promise<string | null>;",
      ].join("\n"),
    },
  },
];

const FENCE = /^```(ts|typescript)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const PATH_COMMENT = /^\/\/ ((?:[\w.-]+\/)*[\w.-]+\.ts)( \(browser\))?[ \t]*$/;

/** The page's TypeScript blocks as `{ path, browser, code, line }`. */
export function extractBlocks(markdown) {
  const blocks = [];
  for (const match of markdown.matchAll(FENCE)) {
    const code = match[2];
    const line = markdown.slice(0, match.index).split("\n").length + 1;
    const pathComment = PATH_COMMENT.exec(code.split("\n", 1)[0]);
    blocks.push({
      path: pathComment ? pathComment[1] : `block-line-${line}.ts`,
      browser: Boolean(pathComment?.[2]),
      code,
      line,
    });
  }
  return blocks;
}

function compilerOptions(environment) {
  return {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    skipLibCheck: true,
    lib: environment.lib,
    types: environment.types,
  };
}

/** Typechecks one program of virtual files rooted at `rootDir`; returns formatted diagnostics. */
function typecheck(rootDir, files, environment, describe) {
  const options = compilerOptions(environment);
  const host = ts.createCompilerHost(options, true);
  const virtual = new Map(Object.entries(files).map(([path, code]) => [resolve(rootDir, path), code]));
  const virtualDirs = new Set([...virtual.keys()].flatMap((file) => {
    const dirs = [];
    for (let dir = dirname(file); dir.startsWith(rootDir); dir = dirname(dir)) dirs.push(dir);
    return dirs;
  }));
  const { fileExists, readFile, getSourceFile, directoryExists } = host;
  host.fileExists = (file) => virtual.has(resolve(file)) || fileExists.call(host, file);
  host.readFile = (file) => virtual.get(resolve(file)) ?? readFile.call(host, file);
  host.directoryExists = (dir) => virtualDirs.has(resolve(dir)) || (directoryExists ? directoryExists.call(host, dir) : true);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    const code = virtual.get(resolve(file));
    return code === undefined
      ? getSourceFile.call(host, file, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(file, code, languageVersion, true);
  };
  const program = ts.createProgram({ rootNames: [...virtual.keys()], options, host });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (!diagnostic.file) return `TS${diagnostic.code}: ${message}`;
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${describe(diagnostic.file.fileName, line)}:${character + 1} TS${diagnostic.code}: ${message}`;
  });
}

/** Typechecks a recipe's blocks; returns `{ blocks, diagnostics }`. */
export function checkRecipe(recipe, markdown = readFileSync(join(repoRoot, recipe.file), "utf8")) {
  const blocks = extractBlocks(markdown);
  const diagnostics = [];
  if (blocks.length === 0) diagnostics.push(`${recipe.file}: no TypeScript code blocks`);
  // A virtual directory inside the docs package, so imports resolve through the workspace's node_modules.
  const rootDir = join(docsDir, ".recipe-check", recipe.file.replace(/[^\w.-]+/g, "_"));
  const byPath = new Map();
  for (const block of blocks) {
    if (byPath.has(block.path)) diagnostics.push(`${recipe.file}:${block.line}: ${block.path} is also the path of the block at line ${byPath.get(block.path).line}`);
    byPath.set(block.path, block);
  }
  const describe = (fileName, line) => {
    const path = relative(rootDir, fileName);
    const block = byPath.get(path);
    return block ? `${recipe.file}:${block.line + line}` : `${recipe.file} (${path}):${line + 1}`;
  };
  for (const isBrowser of [false, true]) {
    const group = blocks.filter((block) => block.browser === isBrowser);
    if (group.length === 0) continue;
    const stubs = isBrowser ? {} : recipe.stubs;
    const files = { ...stubs, ...Object.fromEntries(group.map((block) => [block.path, block.code])) };
    diagnostics.push(...typecheck(rootDir, files, isBrowser ? browser : recipe.environment, describe));
  }
  return { blocks, diagnostics };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let failed = false;
  for (const recipe of RECIPES) {
    const { blocks, diagnostics } = checkRecipe(recipe);
    if (diagnostics.length > 0) {
      failed = true;
      console.error(`${recipe.file}: ${diagnostics.length} type error(s)\n${diagnostics.map((d) => `  ${d}`).join("\n")}`);
    } else {
      console.log(`${recipe.file}: ${blocks.length} TypeScript block(s) typecheck`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
