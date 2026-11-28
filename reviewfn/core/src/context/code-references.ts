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
import { compileGlob, compileGlobs, matchesAnyGlob, type CompiledGlob } from "./glob.js";
import { SYMBOL_LINE_CHARACTER_LIMIT, symbolDeclarations, symbolLanguage, type DeclaredSymbol } from "./symbols.js";

export const CODE_REFERENCES_ADAPTER_ID = "code-references";
/** Source IDs this adapter produces start with this prefix; such sources are review context, never authority. */
export const CODE_REFERENCES_SOURCE_PREFIX = `${CODE_REFERENCES_ADAPTER_ID}:`;
export const CODE_REFERENCES_SOURCE_ID = `${CODE_REFERENCES_SOURCE_PREFIX}map`;

/** Bounds of one code-reference map. The byte bound is further lowered to the context's `maxBytes`. */
export const CODE_REFERENCES_LIMITS = Object.freeze({
  maxSymbols: 60,
  maxReferencesPerSymbol: 30,
  maxBytes: 400 * 1024,
  /** A reference line's text is cut to this many characters; the map marks and counts each cut line. */
  maxLineCharacters: 240,
  /** A changed file larger than this is not read for symbols; the omission is recorded. */
  maxFileBytes: 1024 * 1024,
  /** Declarations listed for one symbol; the map counts the rest. */
  maxDeclarationsPerSymbol: 20,
  /** Changed paths listed for one paired or test file; the map counts the rest. */
  maxChangedPathsPerFile: 20,
});

/** Names or paths quoted in one incompleteness reason; the reason counts the rest. */
const MAX_REASON_ITEMS = 5;
/** Characters of one quoted name, path or error in a reason; a longer one is cut and marked. */
const MAX_REASON_ITEM_CHARACTERS = 120;
/** Bytes of one Git grep line kept for a reference's text: enough for `maxLineCharacters` of any UTF-8 text. */
const MAX_REFERENCE_TEXT_BYTES = CODE_REFERENCES_LIMITS.maxLineCharacters * 4;
/** Bytes of one Git grep line kept when looking for Markdown mentions; a longer line is checked on its start. */
const MAX_DOCUMENT_TEXT_BYTES = 64 * 1024;
/** Bytes of one path field kept from Git grep; a longer path (beyond any file system's limit) is dropped. */
const MAX_PATH_BYTES = 64 * 1024;

/** `contextExcludeGlobs` when the policy declares none: dependencies, build output, minified bundles, vendored code and lockfiles. */
export const DEFAULT_CONTEXT_EXCLUDE_GLOBS: readonly string[] = Object.freeze([
  "**/node_modules/**", "**/dist/**", "**/*.min.js", "**/vendor/**",
  "**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lockb", "**/bun.lock",
  "**/Cargo.lock", "**/go.sum", "**/Package.resolved", "**/Podfile.lock", "**/poetry.lock", "**/uv.lock", "**/Pipfile.lock",
  "**/Gemfile.lock", "**/composer.lock",
]);

// Pathspecs only narrow what Git reads; every path is then checked in JavaScript (Markdown and the exclusion globs),
// so a glob's meaning is `compileGlob`'s everywhere and never Git's pathspec matching (which also takes descendants).
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
  /**
   * Symbols declared on added or modified head lines, in path and line order of their first declaration, with at most
   * `maxDeclarationsPerSymbol` declarations each; `omittedDeclarations` counts the rest.
   */
  symbols: Array<{ name: string; declarations: Array<Omit<DeclaredSymbol, "name">>; omittedDeclarations?: number }>;
  /** Textual whole-word matches of each symbol at head, in path and line order; `truncated` past the per-symbol bound. */
  references: Array<{ symbol: string; matches: CodeReferenceMatch[]; truncated?: true }>;
  /**
   * Tracked files at the conventional test paths of changed files, each with at most `maxChangedPathsPerFile` of the
   * changed paths it covers (the first in order); `omittedCovers` counts the rest.
   */
  testFiles: Array<{ path: string; covers: string[]; omittedCovers?: number }>;
  /**
   * Tracked files a `contextPairs` rule pairs with changed files; `rules` are indexes into `contextPairs`. Each lists at
   * most `maxChangedPathsPerFile` of the changed paths it is paired with; `omittedPairedWith` counts the rest.
   */
  pairedFiles: Array<{ path: string; pairedWith: string[]; rules: number[]; omittedPairedWith?: number }>;
  /** Markdown files that mention a changed symbol (as a whole word) or a changed path. */
  documents: Array<{ path: string; mentions: string[] }>;
  /**
   * How many listed reference lines were cut to `maxLineCharacters` (each is marked `textTruncated`). A cut shortens
   * a listed line only, never what is listed, so it is not an incompleteness reason.
   */
  referenceLinesCut?: number;
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

function cutLine(text: string, cut: boolean): { text: string; truncated: boolean } {
  const characters = [...(cut ? text : text.replace(/\r$/u, ""))];
  return characters.length > CODE_REFERENCES_LIMITS.maxLineCharacters || cut ? { text: characters.slice(0, CODE_REFERENCES_LIMITS.maxLineCharacters).join(""), truncated: true } : { text: characters.join(""), truncated: false };
}

/** `items` for a reason: the first few, each cut to a bounded length, then how many more. */
function quoteItems(items: readonly string[]): string {
  const quote = (item: string) => {
    const characters = [...item];
    return JSON.stringify(characters.length > MAX_REASON_ITEM_CHARACTERS ? `${characters.slice(0, MAX_REASON_ITEM_CHARACTERS).join("")}…` : item);
  };
  const shown = items.slice(0, MAX_REASON_ITEMS).map(quote).join(", ");
  return items.length > MAX_REASON_ITEMS ? `${shown} and ${items.length - MAX_REASON_ITEMS} more` : shown;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareCodePoints);

/** Options of one Git command a code-references fetch runs. */
export interface CodeReferencesGitOptions {
  maxOutputBytes?: number;
  onOutput?: (chunk: Buffer) => void;
  successExitCodes?: number[];
  signal?: AbortSignal;
}

/** Runs one Git command at the top of the work tree and returns its standard output. */
export type CodeReferencesGit = (args: string[], options?: CodeReferencesGitOptions) => Promise<string>;

/** One `git grep -z -n` record. `textCut` is set when the line was longer than the kept bytes. */
interface GrepRecord { path: string; line: number; text: string; textCut: boolean }

/**
 * Parse `git grep -z -n` records (`<rev>:<path>\0<line>\0<text>\n`) as they stream in. The path ends at its NUL, so a
 * path that holds a line feed stays whole, and fields may span chunks. At most `maxTextBytes` of a line's text are
 * kept. `onRecord` returns false to stop.
 */
function grepRecords(head: string, maxTextBytes: number, onRecord: (record: GrepRecord) => boolean): { push(chunk: Buffer): boolean } {
  const prefix = `${head}:`;
  let field: 0 | 1 | 2 = 0;
  let parts: Buffer[] = [];
  let kept = 0;
  let cut = false;
  let recordPath = "";
  let line = 0;
  let open = true;
  return {
    push(chunk) {
      for (let at = 0; open && at < chunk.length;) {
        const end = chunk.indexOf(field === 2 ? 0x0a : 0x00, at);
        const stop = end === -1 ? chunk.length : end;
        const room = (field === 2 ? maxTextBytes : MAX_PATH_BYTES) - kept;
        if (stop - at > room) cut = true;
        if (room > 0) {
          const piece = Buffer.from(chunk.subarray(at, Math.min(stop, at + room)));
          parts.push(piece);
          kept += piece.length;
        }
        if (end === -1) break;
        const value = Buffer.concat(parts).toString("utf8");
        const valueCut = cut;
        parts = [];
        kept = 0;
        cut = false;
        at = end + 1;
        if (field === 0) { recordPath = valueCut ? "" : value; field = 1; }
        else if (field === 1) { line = Number(value); field = 2; }
        else {
          field = 0;
          if (recordPath.startsWith(prefix)) open = onRecord({ path: recordPath.slice(prefix.length), line, text: value, textCut: valueCut });
        }
      }
      return open;
    },
  };
}

/**
 * Whole-word fixed-string references (`git grep -n -w -F`) of each name at `head`, at most
 * `maxReferencesPerSymbol` each, skipping `excluded` paths. Searches run a few at a time. When one fails, no further
 * search starts, the running ones are stopped, and the first failure is thrown only once every started search has
 * settled, so no Git process outlives the call. Results follow `names`, whatever order the searches finish in.
 */
export async function collectReferences(git: CodeReferencesGit, head: string, names: readonly string[], excluded: (file: string) => boolean, signal?: AbortSignal): Promise<CodeReferenceMap["references"]> {
  const results: CodeReferenceMap["references"] = new Array(names.length);
  const failure = new AbortController();
  let failed: { error: unknown } | undefined;
  const search = async (name: string): Promise<CodeReferenceMap["references"][number]> => {
    const matches: CodeReferenceMatch[] = [];
    let truncated = false;
    const stop = new AbortController();
    const forward = () => stop.abort();
    signal?.addEventListener("abort", forward, { once: true });
    failure.signal.addEventListener("abort", forward, { once: true });
    const records = grepRecords(head, MAX_REFERENCE_TEXT_BYTES, record => {
      if (excluded(record.path)) return true;
      if (matches.length === CODE_REFERENCES_LIMITS.maxReferencesPerSymbol) { truncated = true; return false; }
      const line = cutLine(record.text, record.textCut);
      matches.push({ path: record.path, line: record.line, text: line.text, ...(line.truncated ? { textTruncated: true as const } : {}) });
      return true;
    });
    try {
      signal?.throwIfAborted();
      await git(["grep", "-n", "-z", "-I", "-w", "-F", "--no-color", "--no-recurse-submodules", "-e", name, head, "--", ":(top)"], {
        onOutput: chunk => { if (!records.push(chunk)) stop.abort(); }, successExitCodes: [1], signal: stop.signal,
      });
    } catch (error) {
      // Stopping at the bound aborts Git on purpose; anything else is a failure of the run.
      if (!truncated || signal?.aborted || failure.signal.aborted) throw error;
    } finally {
      signal?.removeEventListener("abort", forward);
      failure.signal.removeEventListener("abort", forward);
    }
    return { symbol: name, matches, ...(truncated ? { truncated: true as const } : {}) };
  };
  let next = 0;
  const worker = async () => {
    while (!failed && next < names.length) {
      const index = next++;
      try { results[index] = await search(names[index]); }
      catch (error) {
        if (!failed) { failed = { error }; failure.abort(); }
      }
    }
  };
  // Workers never reject, so this settles only after every started search has.
  await Promise.all(Array.from({ length: Math.min(REFERENCE_CONCURRENCY, names.length) }, worker));
  if (failed) throw failed.error;
  return results;
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

    const symbols = hunks && hunks.headCommit === head ? await this.declaredSymbols(git, head, hunks.files, excluded, reasons) : [];
    if (!hunks) reasons.push("Code references: change hunks were not captured, so no changed symbols were extracted; tests, pairs and documents cover changed paths only.");
    else if (hunks.headCommit !== head) reasons.push(`Code references: the change hunks end at ${hunks.headCommit}, not the head ${head}, so no changed symbols were extracted.`);
    const names = symbols.map(symbol => symbol.name);

    const references = await collectReferences(git, head, names, excluded, request.signal);
    // One reason for every cut list, naming symbols in symbol order (not completion order), so the manifest and its
    // digest are deterministic and the reason stays bounded however many lists were cut.
    const cutLists = references.filter(result => result.truncated).map(result => result.symbol);
    if (cutLists.length) reasons.push(`Code references: ${cutLists.length} symbols have more than ${CODE_REFERENCES_LIMITS.maxReferencesPerSymbol} references; only the first ${CODE_REFERENCES_LIMITS.maxReferencesPerSymbol} of each are listed: ${quoteItems(cutLists)}.`);
    const tracked = (await git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", head])).split("\0").filter(file => file && !excluded(file));
    const testFiles = conventionalTests(changedPaths, tracked);
    const pairedFiles = this.pairedFiles(changedPaths, tracked);
    const documents = await this.documents(git, head, names, changedPaths, excluded, reasons, request.signal);

    // The byte limit holds the map and the incompleteness reasons together. Every reason is bounded (a count and a few
    // quoted items), and when the sections do not all fit, the longest omission reason each section could add is
    // reserved before any item is taken.
    const budget = Math.min(CODE_REFERENCES_LIMITS.maxBytes, request.limits.maxBytes);
    const map: CodeReferenceMap = { version: 1, headCommit: head, changedPaths: [], symbols: [], references: [], testFiles: [], pairedFiles: [], documents: [] };
    const cutBound = references.reduce((count, list) => count + list.matches.filter(match => match.textTruncated).length, 0);
    // The envelope holds the largest cut count the taken lists can have, so setting the real one later stays within it.
    const envelope = Buffer.byteLength(JSON.stringify(cutBound ? { ...map, referenceLinesCut: cutBound } : map));
    const sections = [
      { section: map.changedPaths, items: changedPaths, label: "changed paths" },
      { section: map.symbols, items: symbols, label: "symbols" },
      { section: map.references, items: references, label: "symbol reference lists" },
      { section: map.testFiles, items: testFiles, label: "test files" },
      { section: map.pairedFiles, items: pairedFiles, label: "paired files" },
      { section: map.documents, items: documents, label: "documents" },
    ] as Array<{ section: unknown[]; items: readonly unknown[]; label: string }>;
    const omission = (omitted: number, total: number, label: string) => `Code references: the ${budget}-byte limit omitted ${omitted} of ${total} ${label}.`;
    // Each item adds its own bytes and, after a section's first item, one separating comma. Items are sized only until
    // the limit is reached, so a long section costs no more than the bytes the map can hold.
    const size = (item: unknown, index: number) => Buffer.byteLength(JSON.stringify(item)) + (index ? 1 : 0);
    const fixed = envelope + reasons.reduce((total, reason) => total + Buffer.byteLength(reason), 0);
    let all = fixed;
    for (const { items } of sections) for (let index = 0; index < items.length && all <= budget; index += 1) all += size(items[index], index);
    const reserve = all <= budget ? 0 : sections.reduce((total, { items, label }) => total + Buffer.byteLength(omission(items.length, items.length, label)), 0);
    if (fixed + reserve > budget) {
      reasons.push(`Code references: the ${budget}-byte limit is smaller than an empty map with its incompleteness reasons (${fixed + reserve} bytes), so no code-reference map was included.`);
      return empty("code references: over the byte limit");
    }
    let used = fixed;
    for (const { section, items, label } of sections) {
      let taken = 0;
      for (const item of items) {
        const bytes = size(item, taken);
        if (used + bytes + reserve > budget) break;
        section.push(item);
        used += bytes;
        taken += 1;
      }
      if (taken < items.length) reasons.push(omission(items.length - taken, items.length, label));
    }
    const linesCut = map.references.reduce((count, list) => count + list.matches.filter(match => match.textTruncated).length, 0);
    if (linesCut) map.referenceLinesCut = linesCut;

    const content = JSON.stringify(map);
    const source: ContextSource = { id: CODE_REFERENCES_SOURCE_ID, type: "other", canonicalUrl: `code-references://${head}`, retrievedAt: new Date().toISOString(), digest: sha256(content), status: "available", content };
    return { version: 1, sources: [source], selection: { candidates: [source.id], selected: [source.id], rule: "code references: changed symbols, textual references, conventional tests, policy pairs and Markdown mentions at head" }, limits: request.limits, incompleteReasons: reasons };
  }

  /** One trusted Git, run at the top of the work tree that holds `request.root`, with hooks and external config disabled. */
  private async session(request: ContextRequest): Promise<CodeReferencesGit> {
    const executable = await resolveTrustedExecutable("git");
    const root = await realpath(request.root);
    const at = (cwd: string): CodeReferencesGit => (args, options = {}) => runGit(executable, ["-c", `core.hooksPath=${devNull}`, "-c", "core.quotePath=false", ...args], { cwd, ...options, signal: options.signal ?? request.signal });
    const top = (await at(root)(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/u, "");
    if (!top) throw new Error(`${request.root} is not inside a Git work tree.`);
    return at(top);
  }

  /**
   * The changed symbols, by name in order of first declaration, at most `maxSymbols` with at most
   * `maxDeclarationsPerSymbol` declarations each. Declarations are read one at a time, so a declaration-dense file
   * costs no more than its lines; every omission is recorded in `reasons`.
   */
  private async declaredSymbols(git: CodeReferencesGit, head: string, files: readonly ChangeHunkFile[], excluded: (file: string) => boolean, reasons: string[]): Promise<CodeReferenceMap["symbols"]> {
    const kept = new Map<string, CodeReferenceMap["symbols"][number]>();
    const omitted = new Set<string>();
    const tooLarge: string[] = [];
    const unreadable: string[] = [];
    const longLines: string[] = [];
    for (const file of files) {
      if (file.status === "deleted" || file.status === "binary" || !symbolLanguage(file.path) || excluded(file.path)) continue;
      const ranges = file.hunks.filter(hunk => hunk.newLines > 0);
      if (!ranges.length) continue;
      let text: string;
      try { text = await git(["cat-file", "blob", `${head}:${file.path}`], { maxOutputBytes: CODE_REFERENCES_LIMITS.maxFileBytes }); }
      catch (error) {
        if (error instanceof GitOutputLimitError) tooLarge.push(file.path);
        else unreadable.push(`${file.path} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      const lines = text.split("\n");
      function* changedLines(): Generator<{ line: number; text: string }> {
        for (const hunk of ranges) {
          for (let line = Math.max(1, hunk.newStart); line < hunk.newStart + hunk.newLines && line <= lines.length; line += 1) {
            // The head line after a changed one, changed or not, completes a Rust impl header rustfmt split.
            yield { line, text: lines[line - 1].replace(/\r$/u, ""), ...(line < lines.length ? { next: lines[line].replace(/\r$/u, "") } : {}) };
          }
        }
      }
      for (const { name, ...declaration } of symbolDeclarations(file.path, changedLines(), { onLongLine: line => longLines.push(`${file.path}:${line}`) })) {
        const entry = kept.get(name);
        if (entry) {
          if (entry.declarations.length < CODE_REFERENCES_LIMITS.maxDeclarationsPerSymbol) entry.declarations.push(declaration);
          else entry.omittedDeclarations = (entry.omittedDeclarations ?? 0) + 1;
        } else if (kept.size < CODE_REFERENCES_LIMITS.maxSymbols) kept.set(name, { name, declarations: [declaration] });
        else omitted.add(name);
      }
    }
    if (tooLarge.length) reasons.push(`Code references: ${tooLarge.length} changed files exceed ${CODE_REFERENCES_LIMITS.maxFileBytes} bytes, so their changed symbols were not extracted: ${quoteItems(tooLarge)}.`);
    if (unreadable.length) reasons.push(`Code references: ${unreadable.length} changed files could not be read at head, so their changed symbols were not extracted: ${quoteItems(unreadable)}.`);
    if (longLines.length) reasons.push(`Code references: ${longLines.length} changed lines are longer than ${SYMBOL_LINE_CHARACTER_LIMIT} characters and were not scanned for symbols: ${quoteItems(longLines)}.`);
    if (omitted.size) reasons.push(`Code references: ${kept.size + omitted.size} changed symbols exceed the limit of ${CODE_REFERENCES_LIMITS.maxSymbols}; ${omitted.size} were not searched: ${quoteItems([...omitted])}.`);
    return [...kept.values()];
  }

  /**
   * Tracked files a pair rule includes, with the changed paths that trigger it. Each rule's triggers are found once and
   * a paired file only names its rules, so the work is linear in tracked files times rules; the listed changed paths
   * of a file are bounded and shared by every file paired by the same rules.
   */
  private pairedFiles(changedPaths: readonly string[], tracked: readonly string[]): CodeReferenceMap["pairedFiles"] {
    const active = this.pairs.map((pair, index) => ({ include: pair.include, index, triggers: changedPaths.filter(file => pair.when.matches(file)) })).filter(rule => rule.triggers.length);
    if (!active.length) return [];
    const unions = new Map<string, { listed: string[]; omitted: number }>();
    const paired: CodeReferenceMap["pairedFiles"] = [];
    for (const file of tracked) {
      const rules = active.filter(rule => matchesAnyGlob(rule.include, file));
      if (!rules.length) continue;
      const key = rules.map(rule => rule.index).join(",");
      let union = unions.get(key);
      if (!union) {
        const all = sorted(rules.flatMap(rule => rule.triggers));
        union = { listed: all.slice(0, CODE_REFERENCES_LIMITS.maxChangedPathsPerFile), omitted: Math.max(0, all.length - CODE_REFERENCES_LIMITS.maxChangedPathsPerFile) };
        unions.set(key, union);
      }
      paired.push({ path: file, pairedWith: union.listed, rules: rules.map(rule => rule.index), ...(union.omitted ? { omittedPairedWith: union.omitted } : {}) });
    }
    return paired.sort((a, b) => compareCodePoints(a.path, b.path));
  }

  private async documents(git: CodeReferencesGit, head: string, names: readonly string[], changedPaths: readonly string[], excluded: (file: string) => boolean, reasons: string[], signal?: AbortSignal): Promise<CodeReferenceMap["documents"]> {
    // Git reads one fixed-string pattern per line of the pattern file, so a path holding a line feed cannot be one.
    const unsearchable = changedPaths.filter(term => term.includes("\n"));
    if (unsearchable.length) reasons.push(`Code references: ${unsearchable.length} changed paths contain a line feed, so Markdown mentions of them were not searched: ${quoteItems(unsearchable)}.`);
    const terms = [...names.map(term => ({ term, word: true })), ...changedPaths.filter(term => !term.includes("\n")).map(term => ({ term, word: false }))];
    if (!terms.length) return [];
    const mentions = new Map<string, Set<string>>();
    let cutLines = 0;
    const records = grepRecords(head, MAX_DOCUMENT_TEXT_BYTES, record => {
      if (excluded(record.path) || !MARKDOWN_PATH.test(record.path)) return true;
      for (const { term, word } of terms) {
        if (word ? containsWord(record.text, term) : record.text.includes(term)) mentions.set(record.path, (mentions.get(record.path) ?? new Set()).add(term));
      }
      // Only the kept start of a very long line is checked, so any mention past it, of any term, may be missing.
      if (record.textCut) cutLines += 1;
      return true;
    });
    // Patterns go through a file, so any number of changed paths fits on the command line.
    const directory = await mkdtemp(path.join(tmpdir(), "reviewfn-code-references-"));
    try {
      const patterns = path.join(directory, "patterns");
      await writeFile(patterns, terms.map(({ term }) => term).join("\n") + "\n", { mode: 0o600 });
      await git(["grep", "-n", "-z", "-I", "-F", "--no-color", "--no-recurse-submodules", "-f", patterns, head, "--", ...MARKDOWN_PATHSPECS], { onOutput: chunk => void records.push(chunk), successExitCodes: [1], signal });
    } finally { await rm(directory, { recursive: true, force: true }); }
    if (cutLines) reasons.push(`Code references: ${cutLines} matching Markdown lines are longer than ${MAX_DOCUMENT_TEXT_BYTES} bytes and were checked for mentions on their first ${MAX_DOCUMENT_TEXT_BYTES} bytes only, so mentions past that point are not listed.`);
    return sorted(mentions.keys()).map(file => ({ path: file, mentions: sorted(mentions.get(file)!) }));
  }
}

const TEST_FOLDERS = ["test/", "tests/", "Tests/"] as const;

/**
 * Tracked files at the conventional test paths of each changed `<dir>/<name>.<ext>`: `<dir>/<name>.test.<ext>`,
 * `<dir>/<name>.spec.<ext>`, `<dir>/__tests__/<name>.<ext>`, `test/**\/<name>.test.<ext>`, for Python
 * `tests/**\/test_<name>.py` and for Swift `Tests/**\/<Name>Tests.swift` (`<Name>` with its first letter upper-cased).
 * The `test/`, `tests/` and `Tests/` directories are looked for at the repository root and in every ancestor directory
 * of the changed file, so a package's own test directory counts in a monorepo. Only tracked files with a wanted
 * basename are indexed, by each test directory above them, so the work is linear in tracked files plus the matches.
 * Each test file lists at most `maxChangedPathsPerFile` covered paths (the first in order) and counts the rest.
 */
export function conventionalTests(changedPaths: readonly string[], tracked: readonly string[]): CodeReferenceMap["testFiles"] {
  const parsed = sorted(changedPaths).flatMap(changed => {
    const slash = changed.lastIndexOf("/");
    const base = changed.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return [];
    const name = base.slice(0, dot);
    const extension = base.slice(dot + 1);
    const nested: Array<{ folder: string; file: string }> = [{ folder: "test/", file: `${name}.test.${extension}` }];
    if (extension === "py") nested.push({ folder: "tests/", file: `test_${name}.py` });
    if (extension === "swift") nested.push({ folder: "Tests/", file: `${name.charAt(0).toUpperCase()}${name.slice(1)}Tests.swift` });
    return [{ changed, directory: slash === -1 ? "" : changed.slice(0, slash + 1), name, extension, nested }];
  });
  const wanted = new Set(parsed.flatMap(entry => entry.nested.map(item => item.file)));
  // `<test folder path>\0<basename>` -> tracked files below that folder with that basename.
  const nestedIndex = new Map<string, string[]>();
  for (const file of tracked) {
    const basename = file.slice(file.lastIndexOf("/") + 1);
    if (!wanted.has(basename)) continue;
    for (let start = 0; start < file.length - basename.length; start = file.indexOf("/", start) + 1) {
      const folder = TEST_FOLDERS.find(item => file.startsWith(item, start));
      if (folder) {
        const key = `${file.slice(0, start)}${folder}\0${basename}`;
        const list = nestedIndex.get(key);
        if (list) list.push(file); else nestedIndex.set(key, [file]);
      }
      if (file.indexOf("/", start) === -1) break;
    }
  }
  const trackedSet = new Set(tracked);
  const covers = new Map<string, { covers: string[]; omitted: number }>();
  for (const { changed, directory, name, extension, nested } of parsed) {
    const found = new Set<string>();
    for (const candidate of [`${directory}${name}.test.${extension}`, `${directory}${name}.spec.${extension}`, `${directory}__tests__/${name}.${extension}`]) if (trackedSet.has(candidate)) found.add(candidate);
    const ancestors = [""];
    for (let index = changed.indexOf("/"); index !== -1; index = changed.indexOf("/", index + 1)) ancestors.push(changed.slice(0, index + 1));
    for (const { folder, file } of nested) for (const ancestor of ancestors) for (const test of nestedIndex.get(`${ancestor}${folder}\0${file}`) ?? []) found.add(test);
    found.delete(changed);
    // Changed paths arrive in order, so each test file lists the first ones it covers.
    for (const test of found) {
      const entry = covers.get(test) ?? { covers: [], omitted: 0 };
      if (entry.covers.length < CODE_REFERENCES_LIMITS.maxChangedPathsPerFile) entry.covers.push(changed); else entry.omitted += 1;
      covers.set(test, entry);
    }
  }
  return sorted(covers.keys()).map(file => {
    const entry = covers.get(file)!;
    return { path: file, covers: entry.covers, ...(entry.omitted ? { omittedCovers: entry.omitted } : {}) };
  });
}
