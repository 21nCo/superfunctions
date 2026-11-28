import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

import { compareCodePoints, sha256 } from "../canonical.js";
import { changeHunkPaths, isCommitId } from "../change.js";
import { ReviewFnError } from "../errors.js";
import { resolveTrustedExecutable } from "../executable.js";
import { GitOutputLimitError, runGit } from "../panel/git.js";
import type { ContextPair, PanelPolicy } from "../panel/types.js";
import type { ChangeHunkFile, ContextAdapter, ContextManifest, ContextRequest, ContextSource, PreflightDiagnostic, PreflightResult } from "../types.js";
import { compileGlob, compileGlobs, globPathspec, matchesAnyGlob, type CompiledGlob } from "./glob.js";
import { extractSymbols, symbolLanguage, type DeclaredSymbol } from "./symbols.js";

export const CODE_REFERENCES_ADAPTER_ID = "code-references";
/** Source IDs this adapter produces start with this prefix; such sources are review context, never authority. */
export const CODE_REFERENCES_SOURCE_PREFIX = `${CODE_REFERENCES_ADAPTER_ID}:`;
export const CODE_REFERENCES_SOURCE_ID = `${CODE_REFERENCES_SOURCE_PREFIX}map`;

/** Bounds of one code-reference map. The byte bound is further lowered to the context's `maxBytes`. */
export const CODE_REFERENCES_LIMITS = Object.freeze({
  maxSymbols: 60,
  maxReferencesPerSymbol: 30,
  maxBytes: 400 * 1024,
  /** A reference line's text is cut to this many characters; the cut is recorded. */
  maxLineCharacters: 240,
  /** A changed file larger than this is not read for symbols; the omission is recorded. */
  maxFileBytes: 1024 * 1024,
});

/** `contextExcludeGlobs` when the policy declares none: dependencies, build output, minified bundles, vendored code and lockfiles. */
export const DEFAULT_CONTEXT_EXCLUDE_GLOBS: readonly string[] = Object.freeze([
  "**/node_modules/**", "**/dist/**", "**/*.min.js", "**/vendor/**",
  "**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lockb", "**/bun.lock",
  "**/Cargo.lock", "**/go.sum", "**/Package.resolved", "**/Podfile.lock", "**/poetry.lock", "**/uv.lock", "**/Pipfile.lock",
  "**/Gemfile.lock", "**/composer.lock",
]);

const MARKDOWN_PATHSPECS = [":(top,glob,icase)**/*.md", ":(top,glob,icase)**/*.markdown", ":(top,glob,icase)**/*.mdx"];
const MARKDOWN_PATH = /\.(?:md|markdown|mdx)$/iu;
const REFERENCE_CONCURRENCY = 4;

export interface CodeReferencesOptions {
  /** The trusted panel policy's `contextPairs`; none when absent. */
  pairs?: readonly ContextPair[];
  /** The trusted panel policy's `contextExcludeGlobs`; `DEFAULT_CONTEXT_EXCLUDE_GLOBS` when absent. */
  excludeGlobs?: readonly string[];
}

/** Adapter options from a loaded panel policy, which must be the trusted (or trusted and tightened) copy. */
export function codeReferencesOptions(policy: Pick<PanelPolicy, "contextPairs" | "contextExcludeGlobs">): CodeReferencesOptions {
  return { ...(policy.contextPairs ? { pairs: policy.contextPairs } : {}), ...(policy.contextExcludeGlobs ? { excludeGlobs: policy.contextExcludeGlobs } : {}) };
}

export interface CodeReferenceMatch {
  path: string;
  /** One-based head line. */
  line: number;
  text: string;
  /** The text was cut to `CODE_REFERENCES_LIMITS.maxLineCharacters`. */
  textTruncated?: true;
}

/** The map one code-references source holds, as compact JSON. Every list is in a deterministic order. */
export interface CodeReferenceMap {
  version: 1;
  headCommit: string;
  /** Every changed path, sorted; files outside the recognized languages contribute only these. */
  changedPaths: string[];
  /** Symbols declared on added or modified head lines, in path and line order of their first declaration. */
  symbols: Array<{ name: string; declarations: Array<Omit<DeclaredSymbol, "name">> }>;
  /** Textual whole-word matches of each symbol at head, in path and line order; `truncated` past the per-symbol bound. */
  references: Array<{ symbol: string; matches: CodeReferenceMatch[]; truncated?: true }>;
  /** Tracked files at the conventional test paths of changed files. */
  testFiles: Array<{ path: string; covers: string[] }>;
  /** Tracked files a `contextPairs` rule pairs with changed files; `rules` are indexes into `contextPairs`. */
  pairedFiles: Array<{ path: string; pairedWith: string[]; rules: number[] }>;
  /** Markdown files that mention a changed symbol (as a whole word) or a changed path. */
  documents: Array<{ path: string; mentions: string[] }>;
}

/** Whether a context source is code-reference review context, which is never a requirement or waiver authority. */
export function isReviewContextSource(source: Pick<ContextSource, "id">): boolean {
  return source.id.startsWith(CODE_REFERENCES_SOURCE_PREFIX);
}

/** The code-reference maps of a frozen context, for a prompt's review context. */
export function codeReferenceMaps(context: Pick<ContextManifest, "sources">): CodeReferenceMap[] {
  const maps: CodeReferenceMap[] = [];
  for (const source of context.sources) {
    if (!isReviewContextSource(source) || source.status !== "available" || typeof source.content !== "string") continue;
    try { maps.push(JSON.parse(source.content) as CodeReferenceMap); } catch { /* Only this adapter writes these sources, always as JSON. */ }
  }
  return maps;
}

const WORD = /[A-Za-z0-9_]/u;

/** Whether `term` occurs in `text` delimited as Git's `--word-regexp` delimits it. */
function containsWord(text: string, term: string): boolean {
  for (let index = text.indexOf(term); index !== -1; index = text.indexOf(term, index + 1)) {
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + term.length] ?? "";
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

function cutLine(text: string): { text: string; truncated: boolean } {
  const characters = [...text.replace(/\r$/u, "")];
  return characters.length > CODE_REFERENCES_LIMITS.maxLineCharacters ? { text: characters.slice(0, CODE_REFERENCES_LIMITS.maxLineCharacters).join(""), truncated: true } : { text: characters.join(""), truncated: false };
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareCodePoints);

interface GitSession {
  run(args: string[], options?: { maxOutputBytes?: number; onOutput?: (chunk: Buffer) => void; successExitCodes?: number[]; signal?: AbortSignal }): Promise<string>;
}

/**
 * Split `git grep -z -n` records (`<rev>:<path>\0<line>\0<text>\n`) as they stream in. `onRecord` returns false to stop.
 */
function grepRecords(head: string, onRecord: (record: { path: string; line: number; text: string }) => boolean): { push(chunk: Buffer): boolean } {
  const prefix = `${head}:`;
  let pending: Buffer = Buffer.alloc(0);
  let open = true;
  return {
    push(chunk) {
      if (!open) return false;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (let end = pending.indexOf(0x0a); end !== -1 && open; end = pending.indexOf(0x0a)) {
        const record = pending.subarray(0, end).toString("utf8");
        pending = pending.subarray(end + 1);
        const first = record.indexOf("\0");
        const second = record.indexOf("\0", first + 1);
        if (first === -1 || second === -1 || !record.startsWith(prefix)) continue;
        open = onRecord({ path: record.slice(prefix.length, first), line: Number(record.slice(first + 1, second)), text: record.slice(second + 1) });
      }
      return open;
    },
  };
}

/**
 * Review context for every slot: the symbols the change declares, their textual references at head, the files policy
 * pairs with changed files, the conventional tests of changed files and the Markdown that mentions a changed symbol or
 * path. It produces one source of type `other`, `code-references:map`, which is never a requirement authority.
 * References are whole-word fixed-string matches (`git grep -n -w -F`) over files tracked at head, not type-resolved.
 * Every bound that cuts the map is recorded in `incompleteReasons`.
 */
export class CodeReferencesContextAdapter implements ContextAdapter {
  public readonly id = CODE_REFERENCES_ADAPTER_ID;
  private readonly pairs: ReadonlyArray<{ when: CompiledGlob; include: CompiledGlob[] }>;
  private readonly excludes: readonly CompiledGlob[];

  /** Unsupported globs in `options` are `REVIEWFN_GLOB_UNSUPPORTED`. */
  public constructor(options: CodeReferencesOptions = {}) {
    this.pairs = (options.pairs ?? []).map(pair => ({ when: compileGlob(pair.when), include: compileGlobs(pair.include) }));
    this.excludes = compileGlobs(options.excludeGlobs ?? DEFAULT_CONTEXT_EXCLUDE_GLOBS);
  }

  public async preflight(request: ContextRequest): Promise<PreflightResult> {
    const diagnostics: PreflightDiagnostic[] = [];
    try { await this.session(request); }
    catch (error) { diagnostics.push({ code: "REVIEWFN_CODE_REFERENCES_UNAVAILABLE", level: "error", message: `Code references need a Git work tree and a trusted Git: ${error instanceof Error ? error.message : String(error)}` }); }
    return { ok: diagnostics.length === 0, diagnostics };
  }

  public async fetch(request: ContextRequest): Promise<Omit<ContextManifest, "digest">> {
    const reasons: string[] = [];
    const empty = (rule: string): Omit<ContextManifest, "digest"> => ({ version: 1, sources: [], selection: { candidates: [], selected: [], rule }, limits: request.limits, incompleteReasons: reasons });
    const change = request.change;
    if (!change) {
      reasons.push("Code references: the run supplied no captured change, so no code references were collected.");
      return empty("code references: no change");
    }
    if (!isCommitId(change.headCommit)) throw new ReviewFnError("REVIEWFN_CONFIG_INVALID", "Code references need a full head commit ID.");
    const head = change.headCommit;
    const git = await this.session(request);
    const excluded = (file: string) => matchesAnyGlob(this.excludes, file);
    const hunks = change.hunks;
    const changedPaths = sorted([...change.changedPaths, ...(hunks ? changeHunkPaths(hunks) : [])]);

    const declared = hunks && hunks.headCommit === head ? await this.declaredSymbols(git, head, hunks.files, excluded, reasons) : [];
    if (!hunks) reasons.push("Code references: change hunks were not captured, so no changed symbols were extracted; tests, pairs and documents cover changed paths only.");
    else if (hunks.headCommit !== head) reasons.push(`Code references: the change hunks end at ${hunks.headCommit}, not the head ${head}, so no changed symbols were extracted.`);
    const byName = new Map<string, Array<Omit<DeclaredSymbol, "name">>>();
    for (const { name, ...declaration } of declared) byName.set(name, [...(byName.get(name) ?? []), declaration]);
    const allSymbols = [...byName].map(([name, declarations]) => ({ name, declarations }));
    const symbols = allSymbols.slice(0, CODE_REFERENCES_LIMITS.maxSymbols);
    if (allSymbols.length > symbols.length) reasons.push(`Code references: ${allSymbols.length} changed symbols exceed the limit of ${CODE_REFERENCES_LIMITS.maxSymbols}; ${allSymbols.length - symbols.length} were not searched (${allSymbols.slice(symbols.length).map(symbol => symbol.name).join(", ")}).`);

    const references = await this.references(git, head, symbols.map(symbol => symbol.name), excluded, reasons, request.signal);
    const tracked = (await git.run(["ls-tree", "-r", "-z", "--name-only", "--full-tree", head])).split("\0").filter(file => file && !excluded(file));
    const testFiles = conventionalTests(changedPaths, tracked);
    const pairedFiles = this.pairedFiles(changedPaths, tracked);
    const documents = await this.documents(git, head, symbols.map(symbol => symbol.name), changedPaths, excluded, request.signal);

    const budget = Math.min(CODE_REFERENCES_LIMITS.maxBytes, request.limits.maxBytes);
    const map: CodeReferenceMap = { version: 1, headCommit: head, changedPaths: [], symbols: [], references: [], testFiles: [], pairedFiles: [], documents: [] };
    let used = Buffer.byteLength(JSON.stringify(map));
    const take = <T>(section: T[], items: readonly T[], label: string): void => {
      let taken = 0;
      for (const item of items) {
        // Each item adds its own bytes and at most one separating comma.
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (used + size > budget) break;
        section.push(item);
        used += size;
        taken += 1;
      }
      if (taken < items.length) reasons.push(`Code references: the ${budget}-byte limit omitted ${items.length - taken} of ${items.length} ${label}.`);
    };
    take(map.changedPaths, changedPaths, "changed paths");
    take(map.symbols, symbols, "symbols");
    take(map.references, references, "symbol reference lists");
    take(map.testFiles, testFiles, "test files");
    take(map.pairedFiles, pairedFiles, "paired files");
    take(map.documents, documents, "documents");

    const content = JSON.stringify(map);
    const source: ContextSource = { id: CODE_REFERENCES_SOURCE_ID, type: "other", canonicalUrl: `code-references://${head}`, retrievedAt: new Date().toISOString(), digest: sha256(content), status: "available", content };
    return { version: 1, sources: [source], selection: { candidates: [source.id], selected: [source.id], rule: "code references: changed symbols, textual references, conventional tests, policy pairs and Markdown mentions at head" }, limits: request.limits, incompleteReasons: reasons };
  }

  /** One trusted Git, run at the top of the work tree that holds `request.root`, with hooks and external config disabled. */
  private async session(request: ContextRequest): Promise<GitSession> {
    const executable = await resolveTrustedExecutable("git");
    const root = await realpath(request.root);
    const base = (cwd: string): GitSession => ({
      run: (args, options = {}) => runGit(executable, ["-c", `core.hooksPath=${devNull}`, "-c", "core.quotePath=false", ...args], { cwd, ...options, signal: options.signal ?? request.signal }),
    });
    const top = (await base(root).run(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/u, "");
    if (!top) throw new Error(`${request.root} is not inside a Git work tree.`);
    return base(top);
  }

  private async declaredSymbols(git: GitSession, head: string, files: readonly ChangeHunkFile[], excluded: (file: string) => boolean, reasons: string[]): Promise<DeclaredSymbol[]> {
    const symbols: DeclaredSymbol[] = [];
    for (const file of files) {
      if (file.status === "deleted" || file.status === "binary" || !symbolLanguage(file.path) || excluded(file.path)) continue;
      const ranges = file.hunks.filter(hunk => hunk.newLines > 0);
      if (!ranges.length) continue;
      let text: string;
      try { text = await git.run(["cat-file", "blob", `${head}:${file.path}`], { maxOutputBytes: CODE_REFERENCES_LIMITS.maxFileBytes }); }
      catch (error) {
        reasons.push(error instanceof GitOutputLimitError
          ? `Code references: ${file.path} exceeds ${CODE_REFERENCES_LIMITS.maxFileBytes} bytes, so its changed symbols were not extracted.`
          : `Code references: ${file.path} could not be read at head, so its changed symbols were not extracted: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const lines = text.split("\n");
      const changed = ranges.flatMap(hunk => Array.from({ length: hunk.newLines }, (_, offset) => hunk.newStart + offset)).filter(line => line >= 1 && line <= lines.length);
      symbols.push(...extractSymbols(file.path, changed.map(line => ({ line, text: lines[line - 1].replace(/\r$/u, "") }))));
    }
    return symbols;
  }

  private exclusionPathspecs(): string[] {
    return this.excludes.map(glob => globPathspec(glob, true));
  }

  private async references(git: GitSession, head: string, names: readonly string[], excluded: (file: string) => boolean, reasons: string[], signal?: AbortSignal): Promise<CodeReferenceMap["references"]> {
    const results: CodeReferenceMap["references"] = new Array(names.length);
    let cut = 0;
    const search = async (name: string): Promise<CodeReferenceMap["references"][number]> => {
      signal?.throwIfAborted();
      const matches: CodeReferenceMatch[] = [];
      let truncated = false;
      const stop = new AbortController();
      const forward = () => stop.abort();
      signal?.addEventListener("abort", forward, { once: true });
      const records = grepRecords(head, record => {
        if (excluded(record.path)) return true;
        if (matches.length === CODE_REFERENCES_LIMITS.maxReferencesPerSymbol) { truncated = true; return false; }
        const line = cutLine(record.text);
        if (line.truncated) cut += 1;
        matches.push({ path: record.path, line: record.line, text: line.text, ...(line.truncated ? { textTruncated: true as const } : {}) });
        return true;
      });
      try {
        await git.run(["grep", "-n", "-z", "-I", "-w", "-F", "--no-color", "--no-recurse-submodules", "-e", name, head, "--", ":(top)", ...this.exclusionPathspecs()], {
          onOutput: chunk => { if (!records.push(chunk)) stop.abort(); }, successExitCodes: [1], signal: stop.signal,
        });
      } catch (error) {
        // Stopping at the bound aborts Git on purpose; anything else is a failure of the run.
        if (!truncated || signal?.aborted) throw error;
      } finally { signal?.removeEventListener("abort", forward); }
      return { symbol: name, matches, ...(truncated ? { truncated: true as const } : {}) };
    };
    let next = 0;
    const worker = async () => { for (let index = next++; index < names.length; index = next++) results[index] = await search(names[index]); };
    await Promise.all(Array.from({ length: Math.min(REFERENCE_CONCURRENCY, names.length) }, worker));
    // Reasons follow symbol order, not completion order, so the manifest and its digest are deterministic.
    for (const result of results) if (result.truncated) reasons.push(`Code references: ${result.symbol} has more than ${CODE_REFERENCES_LIMITS.maxReferencesPerSymbol} references; only the first ${CODE_REFERENCES_LIMITS.maxReferencesPerSymbol} are listed.`);
    if (cut) reasons.push(`Code references: ${cut} reference lines were cut to ${CODE_REFERENCES_LIMITS.maxLineCharacters} characters.`);
    return results;
  }

  private pairedFiles(changedPaths: readonly string[], tracked: readonly string[]): CodeReferenceMap["pairedFiles"] {
    const paired = new Map<string, { pairedWith: Set<string>; rules: Set<number> }>();
    this.pairs.forEach((pair, index) => {
      const triggers = changedPaths.filter(file => pair.when.matches(file));
      if (!triggers.length) return;
      for (const file of tracked) {
        if (!matchesAnyGlob(pair.include, file)) continue;
        const entry = paired.get(file) ?? { pairedWith: new Set<string>(), rules: new Set<number>() };
        for (const trigger of triggers) entry.pairedWith.add(trigger);
        entry.rules.add(index);
        paired.set(file, entry);
      }
    });
    return sorted(paired.keys()).map(file => ({ path: file, pairedWith: sorted(paired.get(file)!.pairedWith), rules: [...paired.get(file)!.rules].sort((a, b) => a - b) }));
  }

  private async documents(git: GitSession, head: string, names: readonly string[], changedPaths: readonly string[], excluded: (file: string) => boolean, signal?: AbortSignal): Promise<CodeReferenceMap["documents"]> {
    const terms = [...names.map(term => ({ term, word: true })), ...changedPaths.map(term => ({ term, word: false }))];
    if (!terms.length) return [];
    const mentions = new Map<string, Set<string>>();
    const records = grepRecords(head, record => {
      if (excluded(record.path) || !MARKDOWN_PATH.test(record.path)) return true;
      for (const { term, word } of terms) {
        if (word ? containsWord(record.text, term) : record.text.includes(term)) mentions.set(record.path, (mentions.get(record.path) ?? new Set()).add(term));
      }
      return true;
    });
    // Patterns go through a file, so any number of changed paths fits on the command line.
    const directory = await mkdtemp(path.join(tmpdir(), "reviewfn-code-references-"));
    try {
      const patterns = path.join(directory, "patterns");
      await writeFile(patterns, terms.map(({ term }) => term).join("\n") + "\n", { mode: 0o600 });
      await git.run(["grep", "-n", "-z", "-I", "-F", "--no-color", "--no-recurse-submodules", "-f", patterns, head, "--", ...MARKDOWN_PATHSPECS, ...this.exclusionPathspecs()], { onOutput: chunk => void records.push(chunk), successExitCodes: [1], signal });
    } finally { await rm(directory, { recursive: true, force: true }); }
    return sorted(mentions.keys()).map(file => ({ path: file, mentions: sorted(mentions.get(file)!) }));
  }
}

/**
 * Tracked files at the conventional test paths of each changed `<dir>/<name>.<ext>`: `<dir>/<name>.test.<ext>`,
 * `<dir>/<name>.spec.<ext>`, `<dir>/__tests__/<name>.<ext>`, `test/**\/<name>.test.<ext>`, for Python
 * `tests/**\/test_<name>.py` and for Swift `Tests/**\/<Name>Tests.swift` (`<Name>` with its first letter upper-cased).
 * The `test/`, `tests/` and `Tests/` directories are looked for at the repository root and in every ancestor directory
 * of the changed file, so a package's own test directory counts in a monorepo.
 */
export function conventionalTests(changedPaths: readonly string[], tracked: readonly string[]): CodeReferenceMap["testFiles"] {
  const trackedSet = new Set(tracked);
  const byBasename = new Map<string, string[]>();
  for (const file of tracked) {
    const basename = file.slice(file.lastIndexOf("/") + 1);
    byBasename.set(basename, [...(byBasename.get(basename) ?? []), file]);
  }
  const covers = new Map<string, Set<string>>();
  const add = (test: string, changed: string) => { if (test !== changed) covers.set(test, (covers.get(test) ?? new Set()).add(changed)); };
  for (const changed of changedPaths) {
    const slash = changed.lastIndexOf("/");
    const directory = slash === -1 ? "" : changed.slice(0, slash + 1);
    const base = changed.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    if (dot <= 0) continue;
    const name = base.slice(0, dot);
    const extension = base.slice(dot + 1);
    for (const candidate of [`${directory}${name}.test.${extension}`, `${directory}${name}.spec.${extension}`, `${directory}__tests__/${name}.${extension}`]) if (trackedSet.has(candidate)) add(candidate, changed);
    const ancestors = [""];
    for (let index = changed.indexOf("/"); index !== -1; index = changed.indexOf("/", index + 1)) ancestors.push(changed.slice(0, index + 1));
    const nested: Array<{ folder: string; file: string }> = [{ folder: "test/", file: `${name}.test.${extension}` }];
    if (extension === "py") nested.push({ folder: "tests/", file: `test_${name}.py` });
    if (extension === "swift") nested.push({ folder: "Tests/", file: `${name.charAt(0).toUpperCase()}${name.slice(1)}Tests.swift` });
    for (const { folder, file: basename } of nested) {
      for (const file of byBasename.get(basename) ?? []) if (ancestors.some(ancestor => file.startsWith(`${ancestor}${folder}`))) add(file, changed);
    }
  }
  return sorted(covers.keys()).map(file => ({ path: file, covers: sorted(covers.get(file)!) }));
}
