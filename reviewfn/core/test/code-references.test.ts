import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODE_REFERENCES_LIMITS, CODE_REFERENCES_SOURCE_ID, CodeReferencesContextAdapter, DEFAULT_CONFIG, DEFAULT_POLICY, GENERAL_LENS, ReviewFnError, applyRepositoryPanelPolicy,
  authorizedPromptContext, buildReviewPrompt, buildSlotPrompt, changeHunksDiffArguments, codeReferencesOptions, collectReferences, compileGlob, conventionalTests, extractSymbols, finalizeContextManifest, lineSymbol, lineSymbols, parseChangeHunks,
  PANEL_VALIDATION_CODES, panelPolicySchema, parsePanelPolicy, prepareReview, SYMBOL_LINE_CHARACTER_LIMIT, validatePanelPolicy, validateReport,
  type CodeReferencesGitOptions,
  type ArtifactStore, type CodeReferenceMap, type ContextManifest, type ContextRequest, type PanelPolicy, type ReviewReport, type SymbolKind, type SymbolLanguage,
} from "../src/index.js";

const LIMITS: ContextManifest["limits"] = { maxSources: 10, maxBytes: 2_000_000, maxDepth: 4 };
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
}

function commit(root: string, message: string): string {
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD").trim();
}

/** A repository with `base` committed, then `head` written over it (null deletes a file), and the change between them. */
async function fixture(base: Record<string, string>, head: Record<string, string | null>): Promise<{ root: string; request: ContextRequest; baseCommit: string; headCommit: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "reviewfn-code-references-"));
  roots.push(root);
  git(root, "init", "--quiet");
  await write(root, base);
  const baseCommit = commit(root, "base");
  for (const [file, content] of Object.entries(head)) {
    if (content === null) await rm(path.join(root, file));
    else await write(root, { [file]: content });
  }
  const headCommit = commit(root, "head");
  const hunks = parseChangeHunks(git(root, "diff", ...changeHunksDiffArguments(baseCommit, headCommit)), baseCommit, headCommit);
  const changedPaths = git(root, "diff", "--name-only", "--no-renames", baseCommit, headCommit).split("\n").filter(Boolean);
  return { root, baseCommit, headCommit, request: { root, limits: LIMITS, change: { headCommit, changedPaths, hunks } } };
}

async function fetchMap(request: ContextRequest, adapter = new CodeReferencesContextAdapter()): Promise<{ map: CodeReferenceMap; manifest: Omit<ContextManifest, "digest"> }> {
  const manifest = await adapter.fetch(request);
  const source = manifest.sources.find(item => item.id === CODE_REFERENCES_SOURCE_ID);
  expect(source).toMatchObject({ type: "other", status: "available" });
  return { map: JSON.parse(source!.content!) as CodeReferenceMap, manifest };
}

const references = (map: CodeReferenceMap, symbol: string) => map.references.find(item => item.symbol === symbol);
const code = (error: unknown) => error instanceof ReviewFnError ? error.code : undefined;

describe("code references: acceptance fixture", () => {
  it("lists every textual reference of a renamed TypeScript function, including a same-named word in a comment", async () => {
    const callers = (name: string) => ({
      "src/b.ts": `import { ${name} } from "./a.js";\nexport const fromB = ${name}(1);\n`,
      "src/c.ts": `import { ${name} } from "./a.js";\nexport const fromC = ${name}(2);\n`,
      "src/d.ts": `import { ${name} } from "./a.js";\n// resolveTotal here means the ledger column, not the function\nexport const fromD = ${name}(3);\n`,
    });
    const { request, headCommit } = await fixture(
      { "src/a.ts": "export function computeTotal(value: number) {\n  return value;\n}\n", ...callers("computeTotal"), "README.md": "# Fixture\n" },
      { "src/a.ts": "export function resolveTotal(value: number) {\n  return value;\n}\n", ...callers("resolveTotal") },
    );
    const { map, manifest } = await fetchMap(request);
    expect(manifest.incompleteReasons).toEqual([]);
    expect(map.headCommit).toBe(headCommit);
    expect(map.symbols).toContainEqual({ name: "resolveTotal", declarations: [{ kind: "function", language: "typescript", path: "src/a.ts", line: 1 }] });
    const found = references(map, "resolveTotal")!;
    expect(found.truncated).toBeUndefined();
    expect([...new Set(found.matches.map(match => match.path))]).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(found.matches).toContainEqual({ path: "src/d.ts", line: 2, text: "// resolveTotal here means the ledger column, not the function" });
    expect(found.matches).toContainEqual({ path: "src/a.ts", line: 1, text: "export function resolveTotal(value: number) {" });
    expect(found.matches.length).toBeLessThanOrEqual(CODE_REFERENCES_LIMITS.maxReferencesPerSymbol);
    // The old name exists only at the base, so it is not a changed symbol.
    expect(references(map, "computeTotal")).toBeUndefined();
  });

  it("extracts symbols only from added or modified head lines", async () => {
    const { request } = await fixture(
      { "src/a.ts": "export function untouched() {}\nexport const kept = 1;\n" },
      { "src/a.ts": "export function untouched() {}\nexport const kept = 2;\nexport class Added {}\n" },
    );
    const { map } = await fetchMap(request);
    expect(map.symbols.map(symbol => symbol.name)).toEqual(["kept", "Added"]);
  });
});

type FormCase = [SymbolLanguage, SymbolKind, string, string, string];
const FORMS: FormCase[] = [
  ["typescript", "function", "export async function loadUser(id: string) {", "loadUser", "const loadUser = functional(id);"],
  ["typescript", "class", "export abstract class UserStore extends Base {", "UserStore", "const store = classify(UserStore);"],
  ["typescript", "interface", "export interface UserRecord {", "UserRecord", "const interfaces = [UserRecord];"],
  ["typescript", "type", "export type UserId<T> = Brand<T>;", "UserId", "  type: \"user\","],
  ["typescript", "enum", "export const enum Status {", "Status", "const enumerated = Status.Active;"],
  ["typescript", "const", "export const MAX_USERS: number = 3;", "MAX_USERS", "const MAX_USERS = 3;"],
  ["typescript", "let", "export let counter = 0;", "counter", "let counter = 0;"],
  ["typescript", "method", "  async save(user: User): Promise<void> {", "save", "  if (user.saved) {"],
  ["typescript", "method", "  onClick: (event: Event) => {", "onClick", "  onClick(event);"],
  ["python", "function", "    async def fetch_user(self, user_id):", "fetch_user", "    define_user(user_id)"],
  ["python", "class", "class UserRepository(Base):", "UserRepository", "classes = [UserRepository]"],
  ["swift", "function", "    public static func makeUser(id: String) -> User {", "makeUser", "    let user = makeUser(id: id)"],
  ["swift", "class", "final class UserCache: NSObject {", "UserCache", "    let cache = UserCache.classForCoder()"],
  ["swift", "struct", "public struct UserView: View {", "UserView", "let structure = UserView()"],
  ["swift", "enum", "indirect enum Tree {", "Tree", "let enumeration = Tree.leaf"],
  ["swift", "protocol", "protocol UserLoading: AnyObject {", "UserLoading", "let protocols: [UserLoading] = []"],
  ["swift", "extension", "extension UserView: Equatable {", "UserView", "let extensions = UserView.self"],
  ["go", "function", "func (s *Server) HandleUser(w http.ResponseWriter, r *http.Request) {", "HandleUser", "\tgo func() { s.HandleUser(w, r) }()"],
  ["go", "type", "type UserService struct {", "UserService", "\ttypeName := UserService{}"],
  ["rust", "function", "pub(crate) async fn load_user(id: u64) -> User {", "load_user", "    let user = load_user(id).await;"],
  ["rust", "struct", "pub struct UserRow {", "UserRow", "    let structure = UserRow::default();"],
  ["rust", "enum", "enum Role {", "Role", "    let role = Role::Admin;"],
  ["rust", "trait", "pub unsafe trait Storage {", "Storage", "    // trait Storage is documented elsewhere"],
  ["rust", "impl", "impl<T: Into<String>> Display for Wrapper<T> {", "Wrapper", "    implement_display(Wrapper);"],
];

type ManyCase = [string, SymbolLanguage, string, Array<{ name: string; kind: SymbolKind }>, string];
const MANY: ManyCase[] = [
  ["every declarator of an exported const", "typescript", "export const alpha = f(1, 2), beta: Map<string, number> = new Map(), gamma = 3;", [{ name: "alpha", kind: "const" }, { name: "beta", kind: "const" }, { name: "gamma", kind: "const" }], "const alpha = 1, beta = 2;"],
  ["every name an exported object pattern binds", "typescript", "export let { a, b: renamedB, c = g(1, 2), ...rest } = source;", [{ name: "a", kind: "let" }, { name: "renamedB", kind: "let" }, { name: "c", kind: "let" }, { name: "rest", kind: "let" }], "let { a, b } = source;"],
  ["every name an exported array pattern binds", "typescript", "export const [first, , { inner }, last = 1] = list;", [{ name: "first", kind: "const" }, { name: "inner", kind: "const" }, { name: "last", kind: "const" }], "const [first, last] = list;"],
  ["a Rust raw identifier with its prefix", "rust", "pub fn r#type() -> Kind {", [{ name: "r#type", kind: "function" }], "    let kind = r#type();"],
  ["a Rust impl target behind a reference and lifetime", "rust", "impl<'a> Display for &'a mut crate::model::Ledger<'a> where T: Clone {", [{ name: "Ledger", kind: "impl" }], "    // impl<'a> Display for &'a Ledger"],
];

describe("code references: symbol forms", () => {
  it.each(MANY)("recognizes %s and ignores the negative fixture", (_label, language, positive, expected, negative) => {
    expect(lineSymbols(language, positive)).toEqual(expected);
    expect(lineSymbols(language, negative)).toEqual([]);
  });

  it("matches pathological lines in linear time and skips lines over the length limit", () => {
    const spaces = " ".repeat(50_000);
    const lines: Array<[SymbolLanguage, string]> = [
      ["typescript", `a(): ${spaces}`], ["typescript", `a = (x): ${spaces}`], ["typescript", `function${spaces}`], ["typescript", `type A${spaces}`],
      ["typescript", `a${spaces}x`], ["typescript", `public ${"static ".repeat(8_000)}`], ["typescript", `export const ${"{ a, ".repeat(10_000)}`],
      ["typescript", `export const a = ${"[".repeat(50_000)}`], ["swift", "@a ".repeat(15_000)], ["rust", `impl<${"<".repeat(50_000)}`], ["rust", `impl ${"a ".repeat(20_000)}`],
      ["go", `func (${" ".repeat(50_000)}`], ["python", `def${spaces}`],
    ];
    const started = performance.now();
    for (const [language, text] of lines) lineSymbols(language, text);
    // Each of these took seconds to minutes with backtracking patterns; together they now take milliseconds.
    expect(performance.now() - started).toBeLessThan(2_000);
    const skipped: number[] = [];
    const long = `export function ${"x".repeat(SYMBOL_LINE_CHARACTER_LIMIT)}() {}`;
    expect(extractSymbols("src/a.ts", [{ line: 1, text: long }, { line: 2, text: "export function kept() {}" }], { onLongLine: line => skipped.push(line) }).map(symbol => symbol.name)).toEqual(["kept"]);
    expect(skipped).toEqual([1]);
  });

  it("records changed lines skipped for their length", async () => {
    const { request } = await fixture({ "README.md": "x\n" }, { "src/long.ts": `export const wide = "${"w".repeat(SYMBOL_LINE_CHARACTER_LIMIT)}";\nexport function short() {}\n` });
    const { map, manifest } = await fetchMap(request);
    expect(map.symbols.map(symbol => symbol.name)).toEqual(["short"]);
    expect(manifest.incompleteReasons).toContainEqual(`Code references: 1 changed lines are longer than ${SYMBOL_LINE_CHARACTER_LIMIT} characters and were not scanned for symbols: "src/long.ts:1".`);
  });

  it.each(FORMS)("%s %s: recognizes the positive fixture and ignores the negative one", (language, kind, positive, name, negative) => {
    expect(lineSymbol(language, positive)).toEqual({ name, kind });
    expect(lineSymbol(language, negative)).toBeUndefined();
  });

  it("ignores declaration keywords in comments and languages outside the closed set", async () => {
    expect(lineSymbol("typescript", "// export function commented() {")).toBeUndefined();
    expect(lineSymbol("python", "# def commented():")).toBeUndefined();
    const { request } = await fixture({ "README.md": "x\n" }, { "lib/app.rb": "def ruby_method\nend\n", "src/main.kt": "fun kotlinFunction() {}\n" });
    const { map } = await fetchMap(request);
    expect(map.symbols).toEqual([]);
    expect(map.changedPaths).toEqual(["lib/app.rb", "src/main.kt"]);
  });
});

describe("code references: bounds", () => {
  it("records the symbol limit and searches only the first symbols", async () => {
    const functions = Array.from({ length: CODE_REFERENCES_LIMITS.maxSymbols + 1 }, (_, index) => `export function symbol${String(index).padStart(2, "0")}() {}`).join("\n");
    const { request } = await fixture({ "README.md": "x\n" }, { "src/many.ts": `${functions}\n` });
    const { map, manifest } = await fetchMap(request);
    expect(map.symbols).toHaveLength(CODE_REFERENCES_LIMITS.maxSymbols);
    expect(map.references).toHaveLength(CODE_REFERENCES_LIMITS.maxSymbols);
    expect(references(map, "symbol60")).toBeUndefined();
    expect(manifest.incompleteReasons).toContainEqual(expect.stringMatching(/61 changed symbols exceed the limit of 60; 1 were not searched: "symbol60"\.$/));
  });

  it("names at most five omitted symbols and counts the rest", async () => {
    const functions = Array.from({ length: 500 }, (_, index) => `export function omitted${String(index).padStart(3, "0")}() {}`).join("\n");
    const { request } = await fixture({ "README.md": "x\n" }, { "src/many.ts": `${functions}\n` });
    const { manifest } = await fetchMap(request);
    const reason = manifest.incompleteReasons.find(item => item.includes("changed symbols exceed"))!;
    expect(reason).toBe('Code references: 500 changed symbols exceed the limit of 60; 440 were not searched: "omitted060", "omitted061", "omitted062", "omitted063", "omitted064" and 435 more.');
  });

  it("keeps a declaration-dense file to bounded partial context instead of failing", async () => {
    // 150,000 declarations of one method name: spreading them into one call overflowed the stack before.
    const { request } = await fixture({ "README.md": "x\n" }, { "src/dense.ts": "a(){}\n".repeat(150_000) });
    const { map, manifest } = await fetchMap(request);
    expect(map.symbols).toHaveLength(1);
    expect(map.symbols[0]).toMatchObject({ name: "a", omittedDeclarations: 150_000 - CODE_REFERENCES_LIMITS.maxDeclarationsPerSymbol });
    expect(map.symbols[0].declarations).toHaveLength(CODE_REFERENCES_LIMITS.maxDeclarationsPerSymbol);
    expect(manifest.incompleteReasons).toEqual(["Code references: a has more than 30 references; only the first 30 are listed."]);
  });

  it("omits the map and records why when the byte limit cannot hold an empty one", async () => {
    const { request } = await fixture({ "src/use.ts": "tiny();\n" }, { "src/tiny.ts": "export function tiny() {}\n" });
    const manifest = await new CodeReferencesContextAdapter().fetch({ ...request, limits: { ...LIMITS, maxBytes: 40 } });
    expect(manifest.sources).toEqual([]);
    expect(manifest.incompleteReasons).toContainEqual(expect.stringMatching(/the 40-byte limit is smaller than an empty map \(\d+ bytes\), so no code-reference map was included/));
  });

  it("records the per-symbol reference limit", async () => {
    const calls = Array.from({ length: CODE_REFERENCES_LIMITS.maxReferencesPerSymbol + 5 }, (_, index) => `popular(${index});`).join("\n");
    const { request } = await fixture({ "src/calls.ts": `${calls}\n` }, { "src/popular.ts": "export function popular(value: number) {}\n" });
    const { map, manifest } = await fetchMap(request);
    const found = references(map, "popular")!;
    expect(found.matches).toHaveLength(CODE_REFERENCES_LIMITS.maxReferencesPerSymbol);
    expect(found.truncated).toBe(true);
    expect(manifest.incompleteReasons).toContainEqual(expect.stringMatching(/popular has more than 30 references; only the first 30 are listed/));
  });

  it("records the 400 KB byte limit, marks and counts cut lines in the map only, and keeps the map within it", async () => {
    const names = Array.from({ length: CODE_REFERENCES_LIMITS.maxSymbols }, (_, index) => `wide${String(index).padStart(2, "0")}`);
    const line = `// ${names.join(" ")} ${"x".repeat(400)}`;
    const { request } = await fixture(
      { "src/usage.ts": `${Array.from({ length: CODE_REFERENCES_LIMITS.maxReferencesPerSymbol }, () => line).join("\n")}\n` },
      { "src/wide.ts": `${names.map(name => `export const ${name} = 1;`).join("\n")}\n` },
    );
    const manifest = await new CodeReferencesContextAdapter().fetch(request);
    const content = manifest.sources[0].content!;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(CODE_REFERENCES_LIMITS.maxBytes);
    const map = JSON.parse(content) as CodeReferenceMap;
    expect(map.references.length).toBeLessThan(names.length);
    expect(manifest.incompleteReasons).toContainEqual(expect.stringMatching(new RegExp(`the ${CODE_REFERENCES_LIMITS.maxBytes}-byte limit omitted \\d+ of 60 symbol reference lists`)));
    // A cut line shortens a listed entry, never what is listed, so it is not an incompleteness reason.
    expect(manifest.incompleteReasons.filter(reason => /cut|240/u.test(reason))).toEqual([]);
    expect(map.references[0].matches[1]).toMatchObject({ path: "src/usage.ts", textTruncated: true });
    expect([...map.references[0].matches[1].text]).toHaveLength(CODE_REFERENCES_LIMITS.maxLineCharacters);
    expect(map.referenceLinesCut).toBe(map.references.flatMap(list => list.matches).filter(match => match.textTruncated).length);
    expect(map.referenceLinesCut).toBeGreaterThan(0);
  });

  it("produces the same manifest digest on every fetch, whatever order the searches finish in", async () => {
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const calls = names.flatMap((name, index) => Array.from({ length: CODE_REFERENCES_LIMITS.maxReferencesPerSymbol + 1 + (names.length - index) * 400 }, () => `${name}();`)).join("\n");
    const { request } = await fixture({ "src/calls.ts": `${calls}\n` }, { "src/defs.ts": `${names.map(name => `export function ${name}() {}`).join("\n")}\n` });
    const digests = new Set<string>();
    for (let run = 0; run < 3; run += 1) {
      const manifest = await new CodeReferencesContextAdapter().fetch(request);
      expect(manifest.incompleteReasons.map(reason => /: (\w+) has more than/.exec(reason)?.[1])).toEqual(names);
      digests.add(finalizeContextManifest(manifest).digest);
    }
    expect(digests.size).toBe(1);
  });

  it("lowers the byte limit to the context's maxBytes", async () => {
    const { request } = await fixture({ "src/use.ts": "tiny();\n" }, { "src/tiny.ts": "export function tiny() {}\n" });
    const manifest = await new CodeReferencesContextAdapter().fetch({ ...request, limits: { ...LIMITS, maxBytes: 200 } });
    expect(Buffer.byteLength(manifest.sources[0].content!)).toBeLessThanOrEqual(200);
    expect(manifest.incompleteReasons).toContainEqual(expect.stringMatching(/the 200-byte limit omitted/));
  });

  it("records a run without captured hunks instead of reporting an empty symbol map as complete", async () => {
    const { request } = await fixture({ "src/a.ts": "x\n" }, { "src/a.ts": "export function a() {}\n" });
    const { map, manifest } = await fetchMap({ ...request, change: { ...request.change!, hunks: undefined } });
    expect(map.symbols).toEqual([]);
    expect(map.changedPaths).toEqual(["src/a.ts"]);
    expect(manifest.incompleteReasons).toContainEqual(expect.stringMatching(/change hunks were not captured/));
    const none = await new CodeReferencesContextAdapter().fetch({ root: request.root, limits: LIMITS });
    expect(none.sources).toEqual([]);
    expect(none.incompleteReasons).toContainEqual(expect.stringMatching(/no captured change/));
  });
});

describe("code references: exclusions, pairs, tests and documents", () => {
  it("excludes the default globs from references and honors the policy's own exclusions", async () => {
    const { request } = await fixture(
      {
        "node_modules/pkg/index.js": "shared();\n", "dist/out.js": "shared();\n", "vendor/lib.go": "shared()\n", "src/app.min.js": "shared();\n",
        "package-lock.json": "{\"shared\": 1}\n", "src/use.ts": "shared();\n", "generated/gen.ts": "shared();\n",
      },
      { "src/shared.ts": "export function shared() {}\n" },
    );
    const defaults = await fetchMap(request);
    expect(references(defaults.map, "shared")!.matches.map(match => match.path)).toEqual(["generated/gen.ts", "src/shared.ts", "src/use.ts"]);
    const custom = await fetchMap(request, new CodeReferencesContextAdapter({ excludeGlobs: ["generated/**"] }));
    expect(references(custom.map, "shared")!.matches.map(match => match.path)).toEqual(["dist/out.js", "node_modules/pkg/index.js", "package-lock.json", "src/app.min.js", "src/shared.ts", "src/use.ts", "vendor/lib.go"]);
  });

  it("includes the files a migrations/** -> src/db/** pair rule names", async () => {
    const { request } = await fixture(
      { "src/db/schema.ts": "export {};\n", "src/db/role/runtime.sql": "grant;\n", "src/api/route.ts": "export {};\n" },
      { "migrations/0002_users.sql": "create table users();\n" },
    );
    const adapter = new CodeReferencesContextAdapter(codeReferencesOptions({ contextPairs: [{ when: "migrations/**", include: ["src/db/**"] }, { when: "docs/**", include: ["src/api/**"] }] }));
    const { map } = await fetchMap(request, adapter);
    expect(map.pairedFiles).toEqual([
      { path: "src/db/role/runtime.sql", pairedWith: ["migrations/0002_users.sql"], rules: [0] },
      { path: "src/db/schema.ts", pairedWith: ["migrations/0002_users.sql"], rules: [0] },
    ]);
    const unpaired = await fetchMap(request);
    expect(unpaired.map.pairedFiles).toEqual([]);
  });

  it("discovers each conventional test path", async () => {
    const tests = {
      "src/user.test.ts": "", "src/user.spec.ts": "", "src/__tests__/user.ts": "", "test/unit/user.test.ts": "", "pkg/test/deep/api.test.ts": "",
      "tests/unit/test_models.py": "", "ios/Tests/AppTests/WidgetTests.swift": "", "src/other.test.ts": "", "test/unit/user.spec.ts": "",
    };
    const { request } = await fixture(
      { ...tests, "src/user.ts": "a\n", "pkg/src/api.ts": "a\n", "app/models.py": "a\n", "ios/Sources/App/widget.swift": "a\n" },
      { "src/user.ts": "b\n", "pkg/src/api.ts": "b\n", "app/models.py": "b\n", "ios/Sources/App/widget.swift": "b\n" },
    );
    const { map } = await fetchMap(request);
    expect(map.testFiles).toEqual([
      { path: "ios/Tests/AppTests/WidgetTests.swift", covers: ["ios/Sources/App/widget.swift"] },
      { path: "pkg/test/deep/api.test.ts", covers: ["pkg/src/api.ts"] },
      { path: "src/__tests__/user.ts", covers: ["src/user.ts"] },
      { path: "src/user.spec.ts", covers: ["src/user.ts"] },
      { path: "src/user.test.ts", covers: ["src/user.ts"] },
      { path: "test/unit/user.test.ts", covers: ["src/user.ts"] },
      { path: "tests/unit/test_models.py", covers: ["app/models.py"] },
    ]);
    // `test/` and `tests/` only count at the root or in an ancestor of the changed file.
    expect(conventionalTests(["pkg/src/api.ts"], ["other/test/api.test.ts", "pkg/test/api.test.ts"])).toEqual([{ path: "pkg/test/api.test.ts", covers: ["pkg/src/api.ts"] }]);
  });

  it("lists Markdown that mentions a changed symbol as a word or a changed path", async () => {
    const { request } = await fixture(
      { "README.md": "Call `parseInvoice` to read one.\n", "docs/guide.md": "See src/invoice.ts for details.\n", "docs/other.md": "parseInvoices is plural and unrelated.\n", "node_modules/x/README.md": "parseInvoice\n" },
      { "src/invoice.ts": "export function parseInvoice(text: string) {}\n" },
    );
    const { map } = await fetchMap(request);
    expect(map.documents).toEqual([{ path: "README.md", mentions: ["parseInvoice"] }, { path: "docs/guide.md", mentions: ["src/invoice.ts"] }]);
  });

  it("gives an exclusion glob the same meaning for references, documents, tests and pairs", async () => {
    const { request } = await fixture(
      { "lib/use.ts": "settle();\n", "lib/notes.md": "settle is documented here.\n", "lib/settle.test.ts": "settle();\n", "lib/pair.ts": "export {};\n" },
      { "lib/settle.ts": "export function settle() {}\n" },
    );
    const pairs = [{ when: "lib/settle.ts", include: ["lib/pair.ts"] }];
    // A literal directory is that path only, never its descendants (Git's pathspecs would also take its files).
    const literal = (await fetchMap(request, new CodeReferencesContextAdapter({ pairs, excludeGlobs: ["lib"] }))).map;
    expect(references(literal, "settle")!.matches.map(match => match.path)).toEqual(["lib/notes.md", "lib/settle.test.ts", "lib/settle.ts", "lib/use.ts"]);
    expect(literal.documents.map(document => document.path)).toEqual(["lib/notes.md"]);
    expect(literal.testFiles.map(test => test.path)).toEqual(["lib/settle.test.ts"]);
    expect(literal.pairedFiles.map(file => file.path)).toEqual(["lib/pair.ts"]);
    const descendants = (await fetchMap(request, new CodeReferencesContextAdapter({ pairs, excludeGlobs: ["lib/*.md", "lib/use.ts", "lib/*.test.ts", "lib/pair.ts"] }))).map;
    expect(references(descendants, "settle")!.matches.map(match => match.path)).toEqual(["lib/settle.ts"]);
    expect(descendants.documents).toEqual([]);
    expect(descendants.testFiles).toEqual([]);
    expect(descendants.pairedFiles).toEqual([]);
  });

  it("keeps tracked paths that hold a line feed and records changed ones it cannot search for", async () => {
    const { request } = await fixture(
      { "src/odd\nname.ts": "linefeed();\n", "docs/odd\nnotes.md": "linefeed is described here.\n" },
      { "src/linefeed.ts": "export function linefeed() {}\n", "src/new\nfile.txt": "x\n" },
    );
    const { map, manifest } = await fetchMap(request);
    expect(references(map, "linefeed")!.matches.map(match => match.path)).toEqual(["docs/odd\nnotes.md", "src/linefeed.ts", "src/odd\nname.ts"]);
    expect(map.documents).toEqual([{ path: "docs/odd\nnotes.md", mentions: ["linefeed"] }]);
    expect(manifest.incompleteReasons).toEqual(['Code references: 1 changed paths contain a line feed, so Markdown mentions of them were not searched: "src/new\\nfile.txt".']);
  });
});

describe("code references: reference search failure", () => {
  it("starts no search after one fails and settles every running search before rejecting", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `name${index}`);
    const started: string[] = [];
    let active = 0;
    let activeAtRejection = -1;
    const fake = (args: string[], options: CodeReferencesGitOptions = {}) => new Promise<string>((resolve, reject) => {
      const name = args[args.indexOf("-e") + 1];
      started.push(name);
      active += 1;
      const settle = (fn: () => void) => { active -= 1; fn(); };
      if (name === "name1") { setTimeout(() => settle(() => reject(new Error("git grep failed for name1"))), 5); return; }
      // The others run until stopped; each must be aborted by the failure.
      options.signal?.addEventListener("abort", () => setTimeout(() => settle(() => reject(new Error("aborted"))), 20), { once: true });
    });
    await expect(collectReferences(fake, "a".repeat(40), names, () => false).catch(error => { activeAtRejection = active; throw error; })).rejects.toThrow("git grep failed for name1");
    expect(activeAtRejection).toBe(0);
    expect(started).toEqual(["name0", "name1", "name2", "name3"]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(started).toHaveLength(4);
  });
});

describe("code references: glob grammar", () => {
  it.each(["src/{a,b}/**", "src/[ab].ts", "!src/**", "src/a**", "src\\*.ts", "/abs/**", "src//x", "../x"])("rejects %s with REVIEWFN_GLOB_UNSUPPORTED", pattern => {
    let error: unknown;
    try { compileGlob(pattern); } catch (caught) { error = caught; }
    expect(code(error)).toBe("REVIEWFN_GLOB_UNSUPPORTED");
  });

  it("matches **, * and ? by path segment", () => {
    expect(compileGlob("**/node_modules/**").matches("node_modules/a/b.js")).toBe(true);
    expect(compileGlob("**/node_modules/**").matches("pkg/node_modules/a.js")).toBe(true);
    expect(compileGlob("**/node_modules/**").matches("node_modules")).toBe(false);
    expect(compileGlob("src/*.ts").matches("src/a.ts")).toBe(true);
    expect(compileGlob("src/*.ts").matches("src/a/b.ts")).toBe(false);
    expect(compileGlob("src/?.ts").matches("src/ab.ts")).toBe(false);
    expect(compileGlob("a.(b)+.ts").matches("a.(b)+.ts")).toBe(true);
  });

  it("refuses unsupported globs in the adapter options and the panel policy", () => {
    expect(() => new CodeReferencesContextAdapter({ pairs: [{ when: "migrations/**", include: ["src/{db,api}/**"] }] })).toThrow(expect.objectContaining({ code: "REVIEWFN_GLOB_UNSUPPORTED" }));
    expect(() => new CodeReferencesContextAdapter({ excludeGlobs: ["[ab]/**"] })).toThrow(expect.objectContaining({ code: "REVIEWFN_GLOB_UNSUPPORTED" }));
    const invalid = { ...PANEL_POLICY, contextPairs: [{ when: "migrations/**", include: ["src/{db,api}/**"] }], contextExcludeGlobs: ["!dist/**"] };
    expect(validatePanelPolicy(invalid).issues).toEqual([
      expect.objectContaining({ code: "REVIEWFN_GLOB_UNSUPPORTED", path: "/contextPairs/0/include/0" }),
      expect.objectContaining({ code: "REVIEWFN_GLOB_UNSUPPORTED", path: "/contextExcludeGlobs/0" }),
    ]);
    expect(() => parsePanelPolicy(invalid)).toThrow(expect.objectContaining({ code: "REVIEWFN_CONFIG_INVALID", details: { issues: expect.arrayContaining([expect.objectContaining({ code: "REVIEWFN_GLOB_UNSUPPORTED" })]) } }));
    expect(validatePanelPolicy({ ...PANEL_POLICY, contextPairs: [{ when: "migrations/**", include: ["src/db/**"] }], contextExcludeGlobs: ["dist/**"] }).valid).toBe(true);
    expect(validatePanelPolicy({ ...PANEL_POLICY, contextPairs: [{ when: "migrations/**", include: [] }] }).valid).toBe(false);
  });

  it("lists REVIEWFN_GLOB_UNSUPPORTED in the closed set of panel validation codes", () => {
    const issues = validatePanelPolicy({ ...PANEL_POLICY, contextExcludeGlobs: ["{a,b}"] }).issues;
    expect(issues.map(issue => issue.code)).toEqual(["REVIEWFN_GLOB_UNSUPPORTED"]);
    for (const issue of issues) expect(PANEL_VALIDATION_CODES).toContain(issue.code);
  });

  it("keeps the JSON Schema and the structural validator in agreement on the new policy fields", () => {
    const schema = new Ajv({ allErrors: true, strict: true }).compile(panelPolicySchema);
    const variants: unknown[] = [
      { contextPairs: [{ when: "a/**", include: ["b/**"] }], contextExcludeGlobs: ["dist/**"] }, { contextPairs: [], contextExcludeGlobs: [] },
      { contextPairs: [{ when: "a/**", include: [] }] }, { contextPairs: [{ when: "a/**" }] }, { contextPairs: [{ when: " ", include: ["b"] }] },
      { contextPairs: [{ when: "a", include: ["b"], extra: true }] }, { contextPairs: {} }, { contextExcludeGlobs: [1] }, { contextExcludeGlobs: "dist/**" },
    ];
    for (const variant of variants) {
      const value = { ...PANEL_POLICY, ...(variant as object) };
      expect(validatePanelPolicy(value).valid, JSON.stringify(variant)).toBe(schema(value));
    }
  });

  it("takes contextPairs and contextExcludeGlobs only from the trusted panel policy", () => {
    const trusted: PanelPolicy = { ...PANEL_POLICY, contextPairs: [{ when: "migrations/**", include: ["src/db/**"] }] };
    expect(() => applyRepositoryPanelPolicy(trusted, { ...trusted, contextPairs: [{ when: "migrations/**", include: ["**"] }] })).toThrow(expect.objectContaining({ code: "REVIEWFN_PANEL_POLICY_WEAKENED", message: expect.stringContaining("changes contextPairs") }));
    expect(() => applyRepositoryPanelPolicy(trusted, { ...trusted, contextExcludeGlobs: ["src/**"] })).toThrow(expect.objectContaining({ message: expect.stringContaining("changes contextExcludeGlobs") }));
    expect(applyRepositoryPanelPolicy(trusted, structuredClone(trusted))).toEqual(trusted);
  });
});

const PANEL_POLICY: PanelPolicy = {
  version: 1,
  slots: [{ id: "alpha", stage: 1, harness: { adapter: "codex", version: "1" }, inference: { provider: "openai", model: "configured", auth: "api-key" }, lens: "general", budget: { timeoutMs: 1000, maxOutputBytes: 1000 } }],
  quorum: { stage1: 1, stage2: 0 },
  requirementsSlot: null,
  incremental: "full",
};

describe("code references: authority and delivery", () => {
  function requirementsReport(headCommit: string, contextDigest: string): ReviewReport {
    return {
      schemaVersion: 1, runId: "run", attemptId: "attempt", createdAt: "2026-01-01T00:00:00.000Z",
      change: { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit, mergeBaseCommit: "a".repeat(40), diffDigest: "d".repeat(64), changedPaths: ["src/a.ts"], capturedAt: "2026-01-01T00:00:00.000Z" },
      contextManifestDigest: contextDigest, contextManifestArtifact: "context", configuration: { schemaVersion: 1, policyDigest: "p", promptDigest: "q", harness: { id: "fixture", version: "1" }, inference: { provider: "fixture", model: "fixture", auth: "none" }, execution: { adapter: "fixture", timeoutMs: 1, maxOutputBytes: 1 }, contextAdapters: ["code-references", "fixture"], profile: "requirements" },
      execution: "completed", coverage: "complete", coverageReasons: [], verdict: "ready",
      requirements: [{ id: "R1", statement: "Rename the total", sources: [{ sourceId: "issue:1", anchor: "L1" }], category: "behavior", scope: "api", classification: "mandatory", dependencies: [], extraction: { harness: "fixture", promptDigest: "p" } }],
      assessments: [{ requirementId: "R1", status: "implemented", evidenceIds: ["E1"], reasoning: "renamed", gaps: [], confidence: 1 }],
      evidence: [{ id: "E1", kind: "code", description: "rename", code: { commit: headCommit, path: "src/a.ts", startLine: 1 } }], findings: [], tests: [], inspectedPaths: ["src/a.ts"], uninspected: [], limitations: [],
    };
  }

  it("produces only type other sources that 0.1 source authority ignores, even when the policy accepts other", async () => {
    const { request, headCommit } = await fixture({ "src/a.ts": "x\n" }, { "src/a.ts": "export function renamed() {}\n" });
    const fetched = await new CodeReferencesContextAdapter().fetch(request);
    expect(fetched.sources.map(source => source.type)).toEqual(["other"]);
    const issue = { id: "issue:1", type: "issue" as const, retrievedAt: "now", digest: "d", status: "available" as const, content: "Rename the total" };
    const context = finalizeContextManifest({ ...fetched, sources: [issue, ...fetched.sources], selection: { candidates: ["issue:1", CODE_REFERENCES_SOURCE_ID], selected: ["issue:1", CODE_REFERENCES_SOURCE_ID], rule: "fixture" } });
    const sourceControl = { id: "fixture", capture: async () => requirementsReport(headCommit, context.digest).change, currentHead: async () => headCommit, verifyAnchor: async () => true };
    for (const acceptedTypes of [DEFAULT_POLICY.sourceAuthority.acceptedTypes, [...DEFAULT_POLICY.sourceAuthority.acceptedTypes, "other" as const]]) {
      const policy = { ...DEFAULT_POLICY, requiredCategories: ["behavior" as const], sourceAuthority: { ...DEFAULT_POLICY.sourceAuthority, acceptedTypes } };
      const validation = await validateReport(requirementsReport(headCommit, context.digest), policy, sourceControl, request.root, context);
      expect(validation).toMatchObject({ valid: true, errors: [] });
      // A requirement cannot cite code-reference context as its source.
      const cited = requirementsReport(headCommit, context.digest);
      cited.requirements[0].sources = [{ sourceId: CODE_REFERENCES_SOURCE_ID, anchor: "L1" }];
      expect((await validateReport(cited, policy, sourceControl, request.root, context)).valid).toBe(false);
      expect(authorizedPromptContext(context, policy).context.sources.map(source => source.id)).toEqual(["issue:1"]);
    }
  });

  it("gives lens and requirements slots the map as review context", async () => {
    const { request, headCommit } = await fixture({ "src/use.ts": "renamed();\n" }, { "src/a.ts": "export function renamed() {}\n" });
    const context = finalizeContextManifest(await new CodeReferencesContextAdapter().fetch(request));
    const change = { ...requirementsReport(headCommit, context.digest).change };
    const input = { slot: PANEL_POLICY.slots[0], lens: GENERAL_LENS, change, context, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, tests: [], scope: { mode: "full" as const } };
    const payloads = (prompt: string) => prompt.split(/\n(?=\{\n)/u).slice(1).map(part => JSON.parse(part.slice(0, part.lastIndexOf("}") + 1)) as { codeReferences?: CodeReferenceMap[]; context?: ContextManifest });
    for (const requirements of [false, true]) {
      const prompt = buildSlotPrompt({ ...input, requirements }).prompt;
      // Exactly once: a requirements slot gets the map and its rule from its single-harness base prompt.
      expect(prompt.split('"codeReferences":')).toHaveLength(2);
      const withMap = payloads(prompt).filter(payload => payload.codeReferences);
      expect(withMap).toHaveLength(1);
      expect(withMap[0].codeReferences![0].references[0]).toMatchObject({ symbol: "renamed" });
      for (const payload of payloads(prompt)) if (payload.context) expect(payload.context.sources).toEqual([]);
    }
    const without = buildSlotPrompt({ ...input, context: { ...context, sources: [] }, requirements: false }).prompt;
    expect(without).not.toContain("codeReferences");
  });

  it("gives the single-harness review prompt the map, and leaves a prompt without one unchanged", async () => {
    const { request, headCommit } = await fixture({ "src/use.ts": "renamed();\n" }, { "src/a.ts": "export function renamed() {}\n" });
    const context = finalizeContextManifest(await new CodeReferencesContextAdapter().fetch(request));
    const change = { ...requirementsReport(headCommit, context.digest).change };
    const input = { change, context, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, tests: [] };
    const prompt = buildReviewPrompt(input).prompt;
    expect(prompt).toContain("codeReferences maps the changed symbols");
    const payload = JSON.parse(prompt.slice(prompt.indexOf("\n{\n") + 1)) as { codeReferences: CodeReferenceMap[]; context: ContextManifest; authoritativeSourceIds: string[] };
    expect(payload.codeReferences[0].references[0]).toMatchObject({ symbol: "renamed" });
    expect(payload.context.sources).toEqual([]);
    expect(payload.authoritativeSourceIds).toEqual([]);
    const without = buildReviewPrompt({ ...input, context: { ...context, sources: [] } }).prompt;
    expect(without).not.toContain("codeReferences");
  });

  it("receives the captured change and its hunks from prepareReview", async () => {
    const { request, baseCommit, headCommit } = await fixture({ "src/use.ts": "renamed();\n" }, { "src/a.ts": "export function renamed() {}\n" });
    const store = new Map<string, Uint8Array>();
    const artifacts: ArtifactStore = { put: async (kind, content) => { const id = `${kind}-${store.size}`; store.set(id, Buffer.from(content)); return { id, digest: id }; }, get: async id => store.get(id), deleteExpired: async () => ({ deleted: [], errors: [] }) };
    const snapshot = { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit, headCommit, mergeBaseCommit: baseCommit, diffDigest: "d".repeat(64), changedPaths: ["src/a.ts"], capturedAt: "2026-01-01T00:00:00.000Z" };
    const hunks = request.change!.hunks!;
    const prepared = await prepareReview({
      sourceControl: { id: "fixture", capture: async () => snapshot, currentHead: async () => headCommit, verifyAnchor: async () => true, changeHunks: async () => ({ status: "parsed", hunks }) },
      contexts: [new CodeReferencesContextAdapter()], execution: { id: "none", preflight: async () => ({ ok: true, diagnostics: [] }), run: async () => [] }, artifacts,
    }, { root: request.root, base: baseCommit, head: headCommit, config: { ...DEFAULT_CONFIG, context: [{ adapter: "code-references" }] }, policy: DEFAULT_POLICY });
    const source = prepared.context.sources.find(item => item.id === CODE_REFERENCES_SOURCE_ID)!;
    const map = JSON.parse(source.content!) as CodeReferenceMap;
    expect(map.symbols.map(symbol => symbol.name)).toEqual(["renamed"]);
    expect(references(map, "renamed")!.matches.map(match => match.path)).toEqual(["src/a.ts", "src/use.ts"]);
  });
});
