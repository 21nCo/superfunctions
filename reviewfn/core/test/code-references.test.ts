import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { GitOutputLimitError, runGit, type GitRunOptions } from "../src/panel/git.js";

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

/** Bytes of a manifest's map and incompleteness reasons together, which the byte limit holds. */
function outputBytes(manifest: Pick<ContextManifest, "sources" | "incompleteReasons">): number {
  return manifest.sources.reduce((total, source) => total + Buffer.byteLength(source.content ?? ""), 0) + manifest.incompleteReasons.reduce((total, reason) => total + Buffer.byteLength(reason), 0);
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
  ["a Rust impl target path with spaced separators", "rust", "impl Trait for crate :: model :: Ledger {}", [{ name: "Ledger", kind: "impl" }], "    // impl Trait for crate :: Ledger {}"],
  ["a whole non-ASCII TypeScript class name", "typescript", "export class Café {}", [{ name: "Café", kind: "class" }], "const café = new Café();"],
  ["a non-ASCII TypeScript function name", "typescript", "export function café() {}", [{ name: "café", kind: "function" }], "café();"],
  ["a whole non-ASCII Swift function name", "swift", "func café() -> Int {", [{ name: "café", kind: "function" }], "let value = café()"],
  ["a whole Swift function name with an emoji its grammar allows", "swift", "func save🐱() {}", [{ name: "save🐱", kind: "function" }], "let saved = save🐱()"],
  ["a Swift extension type ending in a grammar-only character", "swift", "extension Outer.Inner🐱 {", [{ name: "Inner🐱", kind: "extension" }], "extension Outer.Inner🐱."],
  ["a non-ASCII Python function name", "python", "def café():", [{ name: "café", kind: "function" }], "café()"],
  ["a whole Go type name before a receive-only channel", "go", "type Recv <-chan int", [{ name: "Recv", kind: "type" }], "\tvar recv <-chan int"],
  ["a named default class, and no keyword for an anonymous one", "typescript", "export default class Named extends Base {", [{ name: "Named", kind: "class" }], "export default class extends Base {"],
  ["an implementing class, and no keyword for an anonymous one", "typescript", "export class Store implements Repo {", [{ name: "Store", kind: "class" }], "export default class implements Repo {"],
  ["a Swift class, and no keyword for a class member", "swift", "final class Cache {", [{ name: "Cache", kind: "class" }], "    final class var shared: Cache {"],
  ["every declarator after call type arguments", "typescript", "export const first = make<string, number>(), second = 2;", [{ name: "first", kind: "const" }, { name: "second", kind: "const" }], "const first = make<string, number>(), second = 2;"],
  ["every declarator after a regular expression literal", "typescript", "export const first = /a,b/g, second = 2;", [{ name: "first", kind: "const" }, { name: "second", kind: "const" }], "const first = /a,b/g, second = 2;"],
  ["every declarator after a comparison", "typescript", "export const less = a < b, other = c<d, last = 1;", [{ name: "less", kind: "const" }, { name: "other", kind: "const" }, { name: "last", kind: "const" }], "const less = a < b, other = 1;"],
  ["every declarator after a division", "typescript", "export const half = total / 2, rest = total/3, more = 1;", [{ name: "half", kind: "const" }, { name: "rest", kind: "const" }, { name: "more", kind: "const" }], "const half = total / 2;"],
  ["a PEP 695 generic function", "python", "def identity[T](x: T) -> T:", [{ name: "identity", kind: "function" }], "value = identity[int](x)"],
  ["a PEP 695 generic class", "python", "class Box[T]:", [{ name: "Box", kind: "class" }], "boxes = Box[int]()"],
  ["a generic arrow, and none of its type parameters", "typescript", "export const pick = <T, D = T>(v?: T, d?: D) => v ?? d;", [{ name: "pick", kind: "const" }], "const pick = <T, D = T>(v?: T, d?: D) => v ?? d;"],
  ["every declarator after a generic arrow", "typescript", "export const a = <T, U>(x: T) => x, b = 2;", [{ name: "a", kind: "const" }, { name: "b", kind: "const" }], "const a = <T, U>(x: T) => x, b = 2;"],
  ["every declarator after spaced call type arguments", "typescript", "export const a = factory <string, number>(), b = 2;", [{ name: "a", kind: "const" }, { name: "b", kind: "const" }], "const a = factory <string, number>(), b = 2;"],
  ["every declarator around block comments", "typescript", "export const /* c */ first = 1, /* note */ second = 2;", [{ name: "first", kind: "const" }, { name: "second", kind: "const" }], "const /* c */ first = 1, /* note */ second = 2;"],
  ["every declarator after a nested template literal", "typescript", "export const t = `x${a, `y${b}`}`, u = 2;", [{ name: "t", kind: "const" }, { name: "u", kind: "const" }], "const t = `x${a, `y${b}`}`, u = 2;"],
  ["a method whose parameters nest callbacks", "typescript", "  method(handler: (cb: (x: string) => void) => void) {}", [{ name: "method", kind: "method" }], "  method(handler: (cb: (x: string) => void) => void);"],
  ["a method with an object return type", "typescript", "  static get value(): { a: 1 } {", [{ name: "value", kind: "method" }], "  value(): { a: 1 };"],
  ["an arrow property whose parameters nest callbacks", "typescript", "  handler = (cb: (x: (y: number) => void) => void): void => {", [{ name: "handler", kind: "method" }], "  handler = (cb: (x: (y: number) => void) => void);"],
  ["a generic async arrow property", "typescript", "  handler: async <T>(cb: (x: T) => void): Promise<void> => {", [{ name: "handler", kind: "method" }], "  handler: Promise<void>;"],
  ["a Rust impl target right after for", "rust", "impl Display for&Ledger {}", [{ name: "Ledger", kind: "impl" }], "    // impl Display for&Ledger {}"],
  ["a Rust impl target after a block comment", "rust", "impl Display for /* note */ Ledger {}", [{ name: "Ledger", kind: "impl" }], "impl /* note */ Display for /* note */ (A, B) {}"],
  ["a Rust inherent impl after a block comment", "rust", "impl /* note */ Ledger {}", [{ name: "Ledger", kind: "impl" }], "impl /* Ledger */ {}"],
  ["a Rust impl target with a turbofish path", "rust", "impl<T> Trait for model::Vec::<T> {", [{ name: "Vec", kind: "impl" }], "impl<T> Trait for [T] {"],
  ["a Rust impl target path, never a qualifier without its segment", "rust", "impl Render for model::Ledger {", [{ name: "Ledger", kind: "impl" }], "impl Render for model::"],
  ["no type argument of an object type literal", "typescript", "export const store = configure<{ user: User; token: string }, Action, Deps>();", [{ name: "store", kind: "const" }], "const store = configure<{ user: User; token: string }, Action, Deps>();"],
  ["every declarator after call type arguments with a leading comment", "typescript", "export const first = make</* type */ A, B, C>(), second = 2;", [{ name: "first", kind: "const" }, { name: "second", kind: "const" }], "const first = make</* type */ A, B, C>(), second = 2;"],
  ["no type argument after a trailing comment", "typescript", "export const first = make<A /* t */, B, C>();", [{ name: "first", kind: "const" }], "const first = make<A /* t */, B, C>();"],
  ["every declarator after a shift", "typescript", "export const a = 1 << 2, b = 3;", [{ name: "a", kind: "const" }, { name: "b", kind: "const" }], "const a = 1 << 2, b = 3;"],
  ["a method, and nothing on a JSDoc continuation line", "typescript", "  save(user) {", [{ name: "save", kind: "method" }], " * save(user) {"],
  ["an arrow property, and nothing on a JSDoc continuation line", "typescript", "  handler: (event) => {", [{ name: "handler", kind: "method" }], " *   handler: (event) => {"],
  ["a qualified Swift extension's own type", "swift", "extension Outer.Inner {", [{ name: "Inner", kind: "extension" }], "let inner = Outer.Inner()"],
  ["a module-qualified Swift extension with a where clause", "swift", "extension Swift.Array where Element == Int {", [{ name: "Array", kind: "extension" }], "    let values: Swift.Array<Int> = []"],
  ["a Swift extension path with a comment before its dot", "swift", "extension Outer /* c */ . Inner {", [{ name: "Inner", kind: "extension" }], "extension Outer /* c */ . {"],
  ["a Swift extension path after a comment", "swift", "extension /* c */ Outer.Inner {", [{ name: "Inner", kind: "extension" }], "extension /* c */ Outer /* d */ Inner {"],
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
      ["typescript", `export const a = ${"a<".repeat(25_000)}`], ["typescript", `export const a = ${"/".repeat(50_000)}`], ["typescript", `export const a = ${"x / ".repeat(12_000)}`],
      ["typescript", `export const a = ${"f<(".repeat(15_000)}`], ["typescript", `export class ${"é".repeat(50_000)}!`], ["go", `type ${"a".repeat(50_000)}!`],
      ["rust", `impl ${"Trait<".repeat(10_000)}`], ["rust", `impl X for ${"a :: ".repeat(10_000)}!`], ["rust", `impl ${"( ".repeat(20_000)}`],
      ["typescript", `export const a = f(${"<T>x, ".repeat(8_000)})`], ["typescript", `export const a = ${"<a>".repeat(15_000)}`], ["typescript", `export const a = ${"<a {".repeat(12_000)}`],
      ["typescript", `export const a = ${"`${".repeat(15_000)}`], ["typescript", `  m(${"(".repeat(40_000)}`], ["typescript", `  m${"<".repeat(40_000)}`],
      ["typescript", `export const a = ${"/*".repeat(25_000)}`], ["typescript", `export const a = ${"factory <".repeat(5_000)}`], ["typescript", `  a = ${"async ".repeat(8_000)}x =>`],
      ["typescript", `  a(): ${"{ x: ".repeat(10_000)}`], ["typescript", `export const ${"a = 1, ".repeat(6_000)}`], ["typescript", `export const a = ${"<T,>".repeat(10_000)}`],
      ["typescript", `export const a = ${"a < ".repeat(12_000)}= 1`], ["typescript", `export const a = ${"f<{ x; ".repeat(6_000)}`], ["typescript", `export const a = ${"1 << ".repeat(10_000)}`],
      ["swift", `extension ${"A /* c */ . ".repeat(5_000)}B {`], ["swift", `extension ${"/* ".repeat(15_000)}`], ["swift", `extension A<${"/* c */ <".repeat(5_000)}`],
      ["typescript", `export const a = ${"g</* c */".repeat(5_000)}`], ["swift", `extension ${"A.".repeat(15_000)}B<${"<".repeat(10_000)}`],
      ["rust", `impl ${"/*".repeat(25_000)}`], ["rust", `impl<${"'a, ".repeat(12_000)}`], ["rust", `impl X for ${"&'a mut ".repeat(6_000)}`],
    ];
    const started = performance.now();
    for (const [language, text] of lines) for (const jsx of [false, true]) lineSymbols(language, text, undefined, { jsx });
    // Each of these took seconds to minutes with backtracking patterns; together they now take milliseconds.
    expect(performance.now() - started).toBeLessThan(2_000);
    const skipped: number[] = [];
    const long = `export function ${"x".repeat(SYMBOL_LINE_CHARACTER_LIMIT)}() {}`;
    expect(extractSymbols("src/a.ts", [{ line: 1, text: long }, { line: 2, text: "export function kept() {}" }], { onLongLine: line => skipped.push(line) }).map(symbol => symbol.name)).toEqual(["kept"]);
    expect(skipped).toEqual([1]);
  });

  it("reads a Rust impl header rustfmt split from the next head line, and never reports its trait", () => {
    expect(lineSymbols("rust", "impl<'a, T: Bound> SomeLongTrait<T>", "    for SomeLongType<'a, T>")).toEqual([{ name: "SomeLongType", kind: "impl" }]);
    expect(lineSymbols("rust", "impl Display for", "    Ledger {")).toEqual([{ name: "Ledger", kind: "impl" }]);
    expect(lineSymbols("rust", "impl<T> Inherent<T>", "where")).toEqual([{ name: "Inherent", kind: "impl" }]);
    expect(lineSymbols("rust", "impl<T> Inherent<T>", "{")).toEqual([{ name: "Inherent", kind: "impl" }]);
    expect(lineSymbols("rust", "impl<'a, T: Bound> SomeLongTrait<T>")).toEqual([]);
    expect(lineSymbols("rust", "impl<'a, T: Bound> SomeLongTrait<T>", "    // continued below")).toEqual([]);
  });

  it("never takes a name from inside type parameters, groups, JSX or comments", () => {
    const names = (text: string, jsx = false) => lineSymbols("typescript", text, undefined, { jsx }).map(symbol => symbol.name);
    expect(names("export const pick = <T, D = T>(v?: T, d?: D) => v ?? d;", true)).toEqual(["pick"]);
    expect(names("export const a = f(x, b = 2), c = [d, e = 3], g = { h: 1, i };")).toEqual(["a", "c", "g"]);
    expect(names("export const a = 1 /* , b = 2 */;")).toEqual(["a"]);
    expect(names("export const a = 1; // , b = 2")).toEqual(["a"]);
    // A `<` the bounded look-ahead classifies neither as type arguments nor as a comparison stops at the names proved.
    expect(names(`export const first = make<${"Payload".repeat(40)}, Second, Third>();`)).toEqual(["first"]);
    expect(names("export const first = make<A, B,")).toEqual(["first"]);
    expect(names("export const a = b < c")).toEqual(["a"]);
    expect(names("export const a = make<A, B> // , c = 1")).toEqual(["a"]);
    // A proved comparison keeps reading: `=`, `;` or a closing bracket the `<` did not open.
    expect(names("export const a = f() < g, h = 1;")).toEqual(["a", "h"]);
    expect(names("export const a = x <= y, b = 1;")).toEqual(["a", "b"]);
    expect(names("export const a = x < y > z, b = 1;")).toEqual(["a", "b"]);
    expect(names("export const a = make<{ x: string; y: number }, Opts>(), b = 2;")).toEqual(["a", "b"]);
    expect(names("  method(value = 1 << 2) {}")).toEqual(["method"]);
    expect(names(" *")).toEqual([]);
    expect(names("  *gen() {")).toEqual(["gen"]);
    const swift = (text: string) => lineSymbols("swift", text).map(symbol => symbol.name);
    expect(swift("public extension A.B.C<T>: Q where T: R {")).toEqual(["C"]);
    expect(swift("extension Outer . Inner: Equatable {")).toEqual(["Inner"]);
    expect(swift("extension Array<Int> {")).toEqual(["Array"]);
    // A qualifier is never reported, even when the line does not prove the extended type.
    expect(swift("extension Outer<T>.Inner {")).toEqual([]);
    expect(swift("extension Outer.")).toEqual([]);
    // Comments are trivia between path components, around a generic clause and before the follower.
    expect(swift("extension Outer /* c */ . Inner {")).toEqual(["Inner"]);
    expect(swift("extension Outer./* c */Inner /* d */ : P {")).toEqual(["Inner"]);
    expect(swift("extension /* a /* nested */ b */ Outer . /* c */ Inner<T> /* d */ where T: P {")).toEqual(["Inner"]);
    expect(swift("extension Outer // . Inner")).toEqual(["Outer"]);
    expect(swift("extension Array</* c */ Int> {")).toEqual(["Array"]);
    // Without a proven follower ({, :, where, the line's end or a line comment) nothing is reported, never a qualifier.
    expect(swift("extension Outer /* c */")).toEqual(["Outer"]);
    expect(swift("extension Outer /* the path goes on")).toEqual([]);
    expect(swift("extension Outer /* c */ Inner {")).toEqual([]);
    expect(swift("extension Outer<T> /* c */ . Inner {")).toEqual([]);
    expect(swift("extension Outer = {")).toEqual([]);
    expect(swift("extension Array</* > */ Int> {")).toEqual(["Array"]);
    expect(swift("extension Array<Int /* unclosed")).toEqual([]);
    // A name is never the prefix of a longer Swift identifier: Swift continues names with characters outside ID_Continue.
    expect(swift("func save🐱() {}")).not.toContain("save");
    expect(swift("struct Point\u0301 {")).toEqual(["Point\u0301"]);
    expect(swift("class A\u{1F600}B {")).toEqual(["A\u{1F600}B"]);
    // U+FEFF is a Swift identifier character, never whitespace between a keyword and a name.
    expect(swift("func \uFEFF\u{1F431}save() {}")).toEqual(["\uFEFF\u{1F431}save"]);
    expect(swift("struct \uFEFF\u{1F431}Type {}")).toEqual(["\uFEFF\u{1F431}Type"]);
    expect(swift("extension Outer.\uFEFF\u{1F431}Type {}")).toEqual(["\uFEFF\u{1F431}Type"]);
    expect(swift("func\uFEFF\u{1F431}() {}")).toEqual([]);
    expect(swift("extension\uFEFFOuter {")).toEqual([]);
    expect(swift("public\uFEFFfunc save() {}")).toEqual([]);
    // A Rust path needs a segment after every separator, also across a turbofish.
    const rust = (...lines: string[]) => lineSymbols("rust", ...lines).map(symbol => symbol.name);
    expect(rust("impl Render for model::")).toEqual([]);
    expect(rust("impl Render for model::Vec::<T>::")).toEqual([]);
    expect(rust("impl model:: {")).toEqual([]);
    expect(rust("impl Render for model::", "    Ledger {")).not.toContain("model");
    expect(names("export const first = <div>a, b = 1</div>, second = 2;", true)).toEqual(["first", "second"]);
    expect(names("export const a = f(<p>don't, x = 1</p>), b = 2;", true)).toEqual(["a", "b"]);
    expect(names("export const a = <Comp prop={x} label=\"y, z = 1\" {...rest} />, b = 2;", true)).toEqual(["a", "b"]);
    expect(names("export const a = <></>, b = 2;", true)).toEqual(["a", "b"]);
    expect(names("export const a = <T,>(x: T) => x, b = 2;", true)).toEqual(["a", "b"]);
    // A form the scanner does not model (here a TSX generic arrow it reads as an element) stops at the names it proved.
    expect(names("export const a = <T extends X>(x: T) => x, b = 2;", true)).toEqual(["a"]);
    expect(names("export const a = () => {")).toEqual(["a"]);
    expect(names("export const a = `multi-line ${b}, c = 1")).toEqual(["a"]);
    expect(names("  method(a = (b, c) => d, e) {")).toEqual(["method"]);
    expect(names("  method(a, (b) => c);")).toEqual([]);
    expect(lineSymbols("rust", "impl<T: Into<String>, U> Display for Wrapper<T, U> where T: Clone {").map(symbol => symbol.name)).toEqual(["Wrapper"]);
    expect(lineSymbols("rust", "impl /* for Ledger */ Display {").map(symbol => symbol.name)).toEqual(["Display"]);
  });

  it("reads JSX in every TypeScript and JavaScript file but .ts", () => {
    const names = (path: string, text: string) => extractSymbols(path, [{ line: 1, text }]).map(symbol => symbol.name);
    for (const path of ["src/view.tsx", "src/view.jsx", "src/view.js", "src/view.mjs", "src/view.cjs"]) expect(names(path, "export const first = <div>a,b</div>, second = 2;")).toEqual(["first", "second"]);
    // In a .ts file `<` where a value starts is a type assertion or type parameters.
    expect(names("src/view.ts", "export const a = <T>value, b = 2;")).toEqual(["a", "b"]);
    expect(names("src/view.d.ts", "export const a = <T, U>(x: T) => x, b = 2;")).toEqual(["a", "b"]);
  });

  it("reports a next line over the length limit that a split Rust impl header needed, once", () => {
    const long = "x".repeat(SYMBOL_LINE_CHARACTER_LIMIT + 1);
    const skipped: number[] = [];
    expect(extractSymbols("src/lib.rs", [{ line: 1, text: "impl Display for", next: long }], { onLongLine: line => skipped.push(line) })).toEqual([]);
    expect(skipped).toEqual([2]);
    skipped.length = 0;
    extractSymbols("src/lib.rs", [{ line: 1, text: "impl Display for", next: long }, { line: 2, text: long }], { onLongLine: line => skipped.push(line) });
    expect(skipped).toEqual([2]);
    skipped.length = 0;
    // A header complete on its line never reads the next one.
    expect(extractSymbols("src/lib.rs", [{ line: 1, text: "impl Display for Ledger {", next: long }], { onLongLine: line => skipped.push(line) }).map(symbol => symbol.name)).toEqual(["Ledger"]);
    expect(skipped).toEqual([]);
  });

  it("gives a split Rust impl header the type on the next line of the head file", async () => {
    const { request } = await fixture({ "README.md": "x\n" }, { "src/lib.rs": "impl<'a, T: Bound> SomeLongTrait<T>\n    for SomeLongType<'a, T>\n{\n}\n" });
    const { map } = await fetchMap(request);
    expect(map.symbols).toEqual([{ name: "SomeLongType", declarations: [{ kind: "impl", language: "rust", path: "src/lib.rs", line: 1 }] }]);
  });

  it("records changed lines skipped for their length", async () => {
    const { request } = await fixture({ "README.md": "x\n" }, { "src/long.ts": `export const wide = "${"w".repeat(SYMBOL_LINE_CHARACTER_LIMIT)}";\nexport function short() {}\n` });
    const { map, manifest } = await fetchMap(request);
    expect(map.symbols.map(symbol => symbol.name)).toEqual(["short"]);
    expect(manifest.incompleteReasons).toContainEqual(`Code references: 1 head lines are longer than ${SYMBOL_LINE_CHARACTER_LIMIT} characters and were not scanned for symbols: "src/long.ts:1".`);
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
    expect(manifest.incompleteReasons).toEqual(['Code references: 1 symbols have more than 30 references; only the first 30 of each are listed: "a".']);
  });

  it("omits the map and records why when the byte limit cannot hold an empty one", async () => {
    const { request } = await fixture({ "src/use.ts": "tiny();\n" }, { "src/tiny.ts": "export function tiny() {}\n" });
    const manifest = await new CodeReferencesContextAdapter().fetch({ ...request, limits: { ...LIMITS, maxBytes: 40 } });
    expect(manifest.sources).toEqual([]);
    expect(manifest.incompleteReasons).toContainEqual(expect.stringMatching(/the 40-byte limit is smaller than an empty map with its incompleteness reasons \(\d+ bytes\), so no code-reference map was included/));
  });

  it("records the per-symbol reference limit", async () => {
    const calls = Array.from({ length: CODE_REFERENCES_LIMITS.maxReferencesPerSymbol + 5 }, (_, index) => `popular(${index});`).join("\n");
    const { request } = await fixture({ "src/calls.ts": `${calls}\n` }, { "src/popular.ts": "export function popular(value: number) {}\n" });
    const { map, manifest } = await fetchMap(request);
    const found = references(map, "popular")!;
    expect(found.matches).toHaveLength(CODE_REFERENCES_LIMITS.maxReferencesPerSymbol);
    expect(found.truncated).toBe(true);
    expect(manifest.incompleteReasons).toContainEqual('Code references: 1 symbols have more than 30 references; only the first 30 of each are listed: "popular".');
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
      expect(manifest.incompleteReasons).toEqual(['Code references: 6 symbols have more than 30 references; only the first 30 of each are listed: "alpha", "beta", "gamma", "delta", "epsilon" and 1 more.']);
      digests.add(finalizeContextManifest(manifest).digest);
    }
    expect(digests.size).toBe(1);
  });

  it("lowers the byte limit to the context's maxBytes, which holds the map and its reasons together", async () => {
    const { request } = await fixture({ "src/use.ts": "tiny();\n".repeat(20) }, { "src/tiny.ts": "export function tiny() {}\n" });
    const manifest = await new CodeReferencesContextAdapter().fetch({ ...request, limits: { ...LIMITS, maxBytes: 900 } });
    expect(manifest.sources).toHaveLength(1);
    expect(outputBytes(manifest)).toBeLessThanOrEqual(900);
    expect(manifest.incompleteReasons).toContainEqual("Code references: the 900-byte limit omitted 1 of 1 symbol reference lists.");
  });

  it("bounds the changed paths each paired file lists and counts the rest", async () => {
    const changed = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`src/f${String(index).padStart(3, "0")}.txt`, "x\n"]));
    const paired = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`spec/p${String(index).padStart(3, "0")}.txt`, "x\n"]));
    const { request } = await fixture(paired, changed);
    const { map } = await fetchMap(request, new CodeReferencesContextAdapter({ pairs: [{ when: "src/**", include: ["spec/**"] }] }));
    expect(map.pairedFiles).toHaveLength(300);
    for (const file of map.pairedFiles) {
      expect(file.pairedWith).toEqual(Object.keys(changed).slice(0, CODE_REFERENCES_LIMITS.maxChangedPathsPerFile));
      expect(file.omittedPairedWith).toBe(300 - CODE_REFERENCES_LIMITS.maxChangedPathsPerFile);
    }
  });

  it("finds conventional tests in time linear in tracked files and bounds what each lists", () => {
    // 30,000 packages that each change index.ts and track test/index.test.ts, plus one root test that covers them all.
    const changed = Array.from({ length: 30_000 }, (_, index) => `pkg${index}/index.ts`);
    const tracked = [...changed.map(file => file.replace("index.ts", "test/index.test.ts")), "test/index.test.ts"];
    const started = performance.now();
    const tests = conventionalTests(changed, tracked);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(tests).toHaveLength(30_001);
    expect(tests.find(test => test.path === "pkg7/test/index.test.ts")).toEqual({ path: "pkg7/test/index.test.ts", covers: ["pkg7/index.ts"] });
    const root = tests.find(test => test.path === "test/index.test.ts")!;
    expect(root.covers).toHaveLength(CODE_REFERENCES_LIMITS.maxChangedPathsPerFile);
    expect(root.omittedCovers).toBe(30_000 - CODE_REFERENCES_LIMITS.maxChangedPathsPerFile);
  });

  it("keeps the map and its reasons within the byte limit, with one bounded reason for every cut reference list", async () => {
    const names = Array.from({ length: CODE_REFERENCES_LIMITS.maxSymbols }, (_, index) => `long${String(index).padStart(2, "0")}_${"n".repeat(800)}`);
    const { request } = await fixture(
      Object.fromEntries(names.map((name, index) => [`src/use${index}.ts`, `${name}();\n`.repeat(CODE_REFERENCES_LIMITS.maxReferencesPerSymbol + 1)])),
      { "src/long.ts": `${names.map(name => `export const ${name} = 1;`).join("\n")}\n` },
    );
    const manifest = await new CodeReferencesContextAdapter().fetch(request);
    expect(outputBytes(manifest)).toBeLessThanOrEqual(CODE_REFERENCES_LIMITS.maxBytes);
    const cut = manifest.incompleteReasons.filter(reason => reason.includes("references; only the first"));
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatch(/^Code references: 60 symbols have more than 30 references; only the first 30 of each are listed: "long00_n{113}…", .* and 55 more\.$/u);
    expect(Buffer.byteLength(cut[0])).toBeLessThan(1_000);
  });

  it("includes a map that exactly fits the byte limit", async () => {
    const { request } = await fixture({ "README.md": "x\n" }, { "x.txt": "x\n" });
    const full = await new CodeReferencesContextAdapter().fetch(request);
    const exact = Buffer.byteLength(full.sources[0].content!);
    const manifest = await new CodeReferencesContextAdapter().fetch({ ...request, limits: { ...LIMITS, maxBytes: exact } });
    expect(manifest.sources[0].content).toBe(full.sources[0].content);
    expect(manifest.incompleteReasons).toEqual([]);
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

  it("records a cut Markdown line even when a mention in its kept start was found", async () => {
    const { request } = await fixture(
      { "docs/long.md": `alpha ${"x".repeat(70_000)} beta\n` },
      { "src/both.ts": "export function alpha() {}\nexport function beta() {}\n" },
    );
    const { map, manifest } = await fetchMap(request);
    // beta lies past the kept 64 KiB, so it is not listed; the cut is recorded although alpha was found.
    expect(map.documents).toEqual([{ path: "docs/long.md", mentions: ["alpha"] }]);
    expect(manifest.incompleteReasons).toContainEqual("Code references: 1 matching Markdown lines are longer than 65536 bytes and were checked for mentions on their first 65536 bytes only, so mentions past that point are not listed.");
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

describe("code references: Git processes end before their callers settle", () => {
  // A stand-in Git that, when stopped, takes a while to exit and only then writes `closed-<name>`. A caller that
  // settled before its Git exited would find the marker missing.
  const FAKE_GIT = [
    "#!/bin/sh",
    'name=""; previous=""',
    'for arg in "$@"; do if [ "$previous" = "-e" ]; then name="$arg"; fi; previous="$arg"; done',
    "trap 'sleep 0.3; echo closed > \"$FAKE_GIT_DIR/closed-$name\"; exit 143' TERM",
    'echo started > "$FAKE_GIT_DIR/started-$name"',
    'case "$name" in',
    '  fail) sleep 0.2; echo "fatal: stand-in failure" >&2; exit 2 ;;',
    '  many) i=1; while [ $i -le 40 ]; do printf "%s:src/a.ts\\000%d\\000many();\\n" "$FAKE_HEAD" $i; i=$((i+1)); done ;;',
    "esac",
    "while :; do sleep 0.05; done",
  ].join("\n");
  const head = "a".repeat(40);

  async function standIn(): Promise<{ git: (args: string[], options?: CodeReferencesGitOptions) => Promise<string>; markers: () => Promise<{ started: string[]; closed: string[] }> }> {
    const directory = await mkdtemp(path.join(tmpdir(), "reviewfn-fake-git-"));
    roots.push(directory);
    const executable = path.join(directory, "git");
    await writeFile(executable, `${FAKE_GIT}\n`, { mode: 0o755 });
    const markerDirectory = path.join(directory, "markers");
    await mkdir(markerDirectory);
    return {
      git: (args, options = {}) => runGit(executable, args, { cwd: directory, env: { PATH: process.env.PATH, FAKE_GIT_DIR: markerDirectory, FAKE_HEAD: head }, ...options }),
      markers: async () => {
        const files = await readdir(markerDirectory);
        const named = (prefix: string) => files.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length)).sort();
        return { started: named("started-"), closed: named("closed-") };
      },
    };
  }

  it.skipIf(process.platform === "win32")("rejects on a sibling failure only after every stopped Git has exited", async () => {
    const { git, markers } = await standIn();
    await expect(collectReferences(git, head, ["s0", "fail", "s2", "s3", "s4"], () => false)).rejects.toThrow(/stand-in failure/);
    // Checked as soon as the call settles: every Git it stopped has already exited, and none started after the failure.
    expect(await markers()).toEqual({ started: ["fail", "s0", "s2", "s3"], closed: ["s0", "s2", "s3"] });
  });

  it.skipIf(process.platform === "win32")("rejects on the caller's abort only after every stopped Git has exited", async () => {
    const { git, markers } = await standIn();
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 150);
    await expect(collectReferences(git, head, ["c0", "c1"], () => false, caller.signal)).rejects.toThrow();
    expect(await markers()).toEqual({ started: ["c0", "c1"], closed: ["c0", "c1"] });
  });

  it.skipIf(process.platform === "win32")("returns a list cut at the per-symbol bound only after its stopped Git has exited", async () => {
    const { git, markers } = await standIn();
    const [list] = await collectReferences(git, head, ["many"], () => false);
    expect(list.matches).toHaveLength(CODE_REFERENCES_LIMITS.maxReferencesPerSymbol);
    expect(list.truncated).toBe(true);
    expect(await markers()).toEqual({ started: ["many"], closed: ["many"] });
  });

  /** A stand-in Git, run by `body`, that first starts a helper holding the inherited stdout and stderr for 20 seconds. */
  async function heldOutput(body: string[]): Promise<{ run: (options: Partial<GitRunOptions>) => Promise<string>; stopHelper: () => Promise<void> }> {
    const directory = await mkdtemp(path.join(tmpdir(), "reviewfn-fake-git-"));
    roots.push(directory);
    const executable = path.join(directory, "git");
    const pidFile = path.join(directory, "helper.pid");
    await writeFile(executable, ["#!/bin/sh", "sleep 20 &", 'echo $! > "$HELPER_PID"', ...body, ""].join("\n"), { mode: 0o755 });
    return {
      run: options => runGit(executable, ["cat-file", "blob", "HEAD:a"], { cwd: directory, env: { PATH: process.env.PATH, HELPER_PID: pidFile }, ...options }),
      stopHelper: async () => {
        const helper = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
        if (helper > 0) { try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ } }
      },
    };
  }

  it.skipIf(process.platform === "win32")("rejects on the caller's abort within a bound when a process Git started keeps its output open", async () => {
    const { run, stopHelper } = await heldOutput(["trap 'exit 143' TERM", "while :; do sleep 0.05; done"]);
    const caller = new AbortController();
    const started = Date.now();
    setTimeout(() => caller.abort(new Error("caller stopped the review")), 200);
    try {
      await expect(run({ signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally { await stopHelper(); }
  });

  it.skipIf(process.platform === "win32")("rejects on an abort that arrives after Git exited while its output is still held open", async () => {
    const { run, stopHelper } = await heldOutput(["exit 0"]);
    const caller = new AbortController();
    const started = Date.now();
    setTimeout(() => caller.abort(new Error("caller stopped the review")), 300);
    try {
      await expect(run({ signal: caller.signal })).rejects.toMatchObject({ name: "AbortError", cause: new Error("caller stopped the review") });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally { await stopHelper(); }
  });

  it.skipIf(process.platform === "win32")("rejects at the output limit within a bound when a process Git started keeps its output open", async () => {
    const { run, stopHelper } = await heldOutput(["while :; do echo output-line; done"]);
    const started = Date.now();
    try {
      await expect(run({ maxOutputBytes: 64 })).rejects.toBeInstanceOf(GitOutputLimitError);
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally { await stopHelper(); }
  });
});

describe("code references: an abort stops the fetch", () => {
  /** An adapter whose Git records each call, by subcommand and object, and runs `during` while a call is in flight. */
  class RecordingAdapter extends CodeReferencesContextAdapter {
    public readonly calls: string[] = [];
    public constructor(private readonly during: (args: readonly string[], running: Promise<string>) => void) { super(); }
    protected override async session(request: ContextRequest): Promise<(args: string[], options?: CodeReferencesGitOptions) => Promise<string>> {
      const real = await super.session(request);
      return async (args, options) => {
        this.calls.push(`${args[0]} ${args.at(-1)}`);
        const running = real(args, options);
        this.during(args, running);
        return running;
      };
    }
  }

  it("rejects with the abort during the first changed-file read and starts no further Git", async () => {
    const files = Object.fromEntries(["a", "b", "c"].map(name => [`src/${name}.ts`, `export function ${name}Fn() {}\n`]));
    const { request, headCommit } = await fixture({ "src/keep.ts": "x\n" }, files);
    const controller = new AbortController();
    const adapter = new RecordingAdapter(args => { if (args[0] === "cat-file") controller.abort(new Error("caller stopped the review")); });
    await expect(adapter.fetch({ ...request, signal: controller.signal })).rejects.toThrow("caller stopped the review");
    // The first blob read is the last Git call: no later blob, ls-tree or grep, and no unreadable-file reason.
    expect(adapter.calls).toEqual([`cat-file ${headCommit}:src/a.ts`]);
  });

  it("starts no file listing when the abort lands between stages", async () => {
    // No changed symbol, so no reference search would check the signal before the file listing.
    const { request, headCommit } = await fixture({ "src/keep.ts": "x\n" }, { "src/a.ts": "value = 1;\n" });
    const controller = new AbortController();
    // The read completes, then the abort lands before the next stage starts.
    const adapter = new RecordingAdapter((args, running) => { if (args[0] === "cat-file") void running.then(() => controller.abort(new Error("stopped after the read"))); });
    await expect(adapter.fetch({ ...request, signal: controller.signal })).rejects.toThrow("stopped after the read");
    expect(adapter.calls).toEqual([`cat-file ${headCommit}:src/a.ts`]);
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
    expect(compileGlob("**").matches("a/b")).toBe(true);
    expect(compileGlob("**/x").matches("x")).toBe(true);
    expect(compileGlob("lib").matches("lib/a.ts")).toBe(false);
    expect(compileGlob("src/?.ts").matches("src/é.ts")).toBe(true);
  });

  it("matches exactly as the segment grammar's regular expression would", () => {
    // The grammar written as the regular expression it denotes, a reference for small inputs only.
    const reference = (pattern: string) => {
      const segments = pattern.split("/");
      const source = segments.map((segment, index) => {
        const last = index === segments.length - 1;
        if (segment === "**") return last ? "[^]+" : "(?:[^/]+/)*";
        return [...segment].map(unit => unit === "*" ? "[^/]*" : unit === "?" ? "[^/]" : unit.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&")).join("") + (last ? "" : "/");
      }).join("");
      return new RegExp(`^${source}$`, "u");
    };
    const patterns = ["*", "?", "a*", "*a", "*.*", "a?b", "**", "a/**", "**/a", "**/*.b", "a/**/b", "**/**/a", "*/a/**", "a*b*a", "?*?", "**/a*/**"];
    const paths = ["a", "b", "ab", "aab", "a.b", "a/b", "a/a/b", "b/a", "ab/a.b", "a/b/a", "aba", "a.b.b", "x/y/z/a", "a/xb/a", "é", "a/é/b"];
    for (const pattern of patterns) {
      const compiled = compileGlob(pattern);
      const expected = reference(pattern);
      for (const path of paths) expect([pattern, path, compiled.matches(path)]).toEqual([pattern, path, expected.test(path)]);
    }
  });

  it("matches multi-star segments and ** runs in linear time on long paths", () => {
    const patterns = ["**/*.*.*.ts", "**/*a*b*c*d*e*.ts", "src/**/**/**/*x*y*z*", "*a*a*a*a*a*a*a*b", "**/a/**/a/**/a/**/b", "**/*?*?*?*?*#"];
    const paths = [
      "a.".repeat(2_000), `src/${"a".repeat(4_000)}`, "a/".repeat(2_000) + "c", `${"ab".repeat(2_000)}.t`, `x/${"a.b.".repeat(1_000)}/y`, "a/a".repeat(1_333),
    ];
    const compiled = patterns.map(compileGlob);
    const started = performance.now();
    for (const glob of compiled) for (const path of paths) glob.matches(path);
    // A backtracking regular expression took about a second for one 2,001-character path and one of these patterns.
    expect(performance.now() - started).toBeLessThan(1_000);
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
