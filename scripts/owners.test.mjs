import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  NEXT_MANIFEST,
  OwnersError,
  PUBLIC_MANIFEST,
  canonicalPythonName,
  createOwners,
  loadOwners,
  ownerOfPath,
  ownerOfRelease,
  parseManifest,
  readManifest,
  runOwnersCli,
} from "./owners.mjs";

const publicData = () => ({
  version: 1,
  paths: { datafn: "public", ".github": "public" },
  rootFiles: { public: ["package.json", "README.md"], generated: ["package-lock.json", "Package.resolved"] },
  releases: { "datafn-core": "public" },
  python: { datafn: "public" },
});
const nextData = () => ({
  version: 1,
  paths: { docsfn: "next" },
  rootFiles: { next: ["NEXT.md"] },
  releases: { "docsfn-core": "next" },
  python: { docsfn: "next" },
});

const owners = (pub = publicData(), next = nextData()) =>
  createOwners(parseManifest(pub, { kind: "public" }), next && parseManifest(next, { kind: "next" }));

const throwsCode = (fn, code) =>
  assert.throws(fn, (error) => error instanceof OwnersError && error.code === code, `expected OwnersError ${code}`);

test("public: a path outside the allow-list is an error, a listed one is public", () => {
  const oracle = owners(publicData(), null);
  assert.equal(oracle.defaultRepo, "public");
  assert.equal(oracle.ownerOfPath("datafn/core/src/index.ts"), "public");
  assert.equal(oracle.ownerOfPath("./datafn/"), "public");
  assert.equal(oracle.ownerOfPath(".github/workflows/ci.yml"), "public");
  throwsCode(() => oracle.ownerOfPath("docsfn/core/index.ts"), "unlisted-path");
  throwsCode(() => oracle.ownerOfPath("docsfn"), "unlisted-path");
});

test("next: an unlisted path is public-owned and a next-listed path is next-owned", () => {
  const oracle = owners();
  assert.equal(oracle.defaultRepo, "next");
  assert.equal(oracle.ownerOfPath("watchfn/core/src/index.ts", { repo: "next" }), "public");
  assert.equal(oracle.ownerOfPath("unknown-root-file.txt", { repo: "next" }), "public");
  assert.equal(oracle.ownerOfPath("docsfn/site/page.md", { repo: "next" }), "next");
  assert.equal(oracle.ownerOfPath("NEXT.md", { repo: "next" }), "next");
  assert.equal(oracle.ownerOfPath("datafn/core/x.ts", { repo: "next" }), "public");
  // The same oracle answers for the public repository, where next-owned paths must not exist.
  throwsCode(() => oracle.ownerOfPath("docsfn/site/page.md", { repo: "public" }), "unlisted-path");
  throwsCode(() => oracle.ownerOfPath("datafn/x", { repo: "main" }), "invalid-repo");
});

test("an entry listed in both manifests is a duplicate-owner error", () => {
  const both = (mutate) => {
    const next = nextData();
    mutate(next);
    return () => owners(publicData(), next);
  };
  throwsCode(both((next) => (next.releases["datafn-core"] = "next")), "duplicate-owner");
  throwsCode(both((next) => (next.python.datafn = "next")), "duplicate-owner");
  throwsCode(both((next) => (next.paths.datafn = "next")), "duplicate-owner");
  throwsCode(both((next) => next.rootFiles.next.push("package.json")), "duplicate-owner");
  throwsCode(both((next) => (next.paths["README.md"] = "next")), "duplicate-owner");
});

test("root files are classified as public or generated; nested files follow their directory", () => {
  const oracle = owners(publicData(), null);
  assert.equal(oracle.ownerOfPath("package.json"), "public");
  assert.equal(oracle.ownerOfPath("README.md"), "public");
  assert.equal(oracle.ownerOfPath("package-lock.json"), "generated");
  assert.equal(oracle.ownerOfPath("Package.resolved"), "generated");
  assert.equal(oracle.ownerOfPath("datafn/package-lock.json"), "public");
  throwsCode(() => oracle.ownerOfPath("notes.txt"), "unlisted-path");
  // A root-file name is not a directory: package.json/x is not covered by the root-file entry.
  throwsCode(() => oracle.ownerOfPath("package.json/x"), "unlisted-path");
});

test("releases and Python projects have exactly one publishing repository", () => {
  const oracle = owners();
  assert.equal(oracle.ownerOfRelease("datafn-core"), "public");
  assert.equal(oracle.ownerOfRelease("docsfn-core", { repo: "next" }), "next");
  assert.equal(oracle.ownerOfPython("datafn"), "public");
  assert.equal(oracle.ownerOfPython("docsfn", { repo: "next" }), "next");
  throwsCode(() => oracle.ownerOfRelease("docsfn-core", { repo: "public" }), "unlisted-release");
  // Unlike paths, an unlisted slug is not implicitly public on next: every publisher is assigned (D8).
  throwsCode(() => oracle.ownerOfRelease("mystery", { repo: "next" }), "unlisted-release");
  throwsCode(() => oracle.ownerOfPython("mystery", { repo: "next" }), "unlisted-python");
});

test("Python projects are one distribution per PEP 503 canonical name", () => {
  assert.equal(canonicalPythonName("Foo.Bar"), "foo-bar");
  assert.equal(canonicalPythonName("foo__-._bar"), "foo-bar");
  assert.equal(canonicalPythonName("datafn"), "datafn");
  // Alias lookups resolve to the listed project in both repos.
  const pub = publicData();
  pub.python = { "foo-bar": "public" };
  const oracle = owners(pub);
  for (const alias of ["foo-bar", "foo_bar", "Foo.Bar", "FOO__BAR"]) {
    assert.equal(oracle.ownerOfPython(alias, { repo: "public" }), "public", alias);
    assert.equal(oracle.ownerOfPython(alias, { repo: "next" }), "public", alias);
  }
  assert.equal(oracle.ownerOfPython("DocsFn", { repo: "next" }), "next");
  // A public/next alias is a duplicate owner, and the error keeps both spellings.
  const next = nextData();
  next.python = { "Foo.Bar": "next" };
  assert.throws(
    () => owners(pub, next),
    (error) => error.code === "duplicate-owner" && error.message.includes('"Foo.Bar"') && error.message.includes('"foo-bar"'),
  );
  // Two aliases in one manifest are malformed.
  throwsCode(() => parseManifest({ ...publicData(), python: { foo_bar: "public", "Foo-Bar": "public" } }, { kind: "public" }), "malformed-manifest");
  throwsCode(() => parseManifest({ ...nextData(), python: { "a.b": "next", A_B: "next" } }, { kind: "next" }), "malformed-manifest");
});

test("the optional ci section names the release CI as a workflow or a check run (SFNS-124)", () => {
  assert.equal(parseManifest(publicData(), { kind: "public" }).ci, null);
  assert.deepEqual(parseManifest({ ...publicData(), ci: { workflow: "ci.yml" } }, { kind: "public" }).ci, { kind: "workflow", name: "ci.yml", app: null });
  assert.deepEqual(parseManifest({ ...nextData(), ci: { checkRun: "Depot CI", app: "depot" } }, { kind: "next" }).ci, {
    kind: "check-run",
    name: "Depot CI",
    app: "depot",
  });
  for (const ci of [
    "CI",
    [],
    {},
    { workflow: "ci.yml", checkRun: "CI", app: "depot" },
    { workflow: "ci.yml", app: "depot" },
    { workflow: "" },
    // A workflow is named by its file, not by its display name, which any workflow's run-name can copy.
    { workflow: "CI" },
    { workflow: "../ci.yml" },
    // A check run needs its app, because any app with checks access can name a check run.
    { checkRun: "CI" },
    { checkRun: " CI", app: "depot" },
    { checkRun: "CI", app: "" },
    { checkRun: 1, app: "depot" },
    { checkRun: "CI", app: "depot", branch: "dev" },
  ]) {
    throwsCode(() => parseManifest({ ...nextData(), ci }, { kind: "next" }), "malformed-manifest");
  }
});

test("parseManifest rejects an unsupported kind with a typed error", () => {
  for (const kind of ["typo", "generated", "", null, 1]) {
    throwsCode(() => parseManifest({ version: 1, paths: { datafn: "typo" } }, { kind }), "malformed-manifest");
    throwsCode(() => parseManifest(publicData(), { kind }), "malformed-manifest");
  }
});

test("paths outside the repository are rejected", () => {
  const oracle = owners(publicData(), null);
  for (const bad of ["", "   ", "/etc/passwd", "C:/repo/datafn", "..", "../datafn", "datafn/../../x", ".", 7]) {
    throwsCode(() => oracle.ownerOfPath(bad), "invalid-path");
  }
});

test("a malformed manifest is a typed malformed-manifest error", () => {
  const cases = [
    [null, "public"],
    [[], "public"],
    [{ ...publicData(), version: 2 }, "public"],
    [{ ...publicData(), extra: true }, "public"],
    [{ ...publicData(), paths: undefined }, "public"],
    [{ ...publicData(), rootFiles: undefined }, "public"],
    [{ ...publicData(), paths: { datafn: "next" } }, "public"],
    [{ ...publicData(), paths: { "datafn/core": "public" } }, "public"],
    [{ ...publicData(), paths: { "..": "public" } }, "public"],
    [{ ...publicData(), paths: ["datafn"] }, "public"],
    [{ ...publicData(), releases: { "datafn-core": true } }, "public"],
    [{ ...publicData(), rootFiles: { public: "package.json" } }, "public"],
    [{ ...publicData(), rootFiles: { public: ["a", "a"] } }, "public"],
    [{ ...publicData(), rootFiles: { public: ["package-lock.json"], generated: ["package-lock.json"] } }, "public"],
    [{ ...publicData(), rootFiles: { public: ["datafn"] } }, "public"],
    [{ ...publicData(), rootFiles: { public: [], next: ["NEXT.md"] } }, "public"],
    [{ ...nextData(), paths: { docsfn: "public" } }, "next"],
    [{ ...nextData(), rootFiles: { public: ["x"] } }, "next"],
  ];
  for (const [data, kind] of cases) {
    throwsCode(() => parseManifest(data, { kind }), "malformed-manifest");
  }
});

test("readManifest reports invalid JSON, a missing public manifest and an absent optional next manifest", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "owners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, PUBLIC_MANIFEST);
  throwsCode(() => readManifest(file), "manifest-not-found");
  writeFileSync(file, "{ not json");
  throwsCode(() => readManifest(file), "malformed-manifest");
  assert.equal(readManifest(path.join(dir, NEXT_MANIFEST), { kind: "next", optional: true }), null);
});

test("loadOwners reads the next manifest when present and defaults to next semantics", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "owners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, PUBLIC_MANIFEST), JSON.stringify(publicData()));
  assert.equal(loadOwners({ root: dir }).defaultRepo, "public");
  throwsCode(() => loadOwners({ root: dir }).ownerOfPath("docsfn/x"), "unlisted-path");
  writeFileSync(path.join(dir, NEXT_MANIFEST), JSON.stringify(nextData()));
  const oracle = loadOwners({ root: dir });
  assert.equal(oracle.defaultRepo, "next");
  assert.equal(oracle.ownerOfPath("docsfn/x"), "next");
  assert.equal(oracle.ownerOfPath("anything/else"), "public");
});

test("the dev manifest makes catchfn and reviewfn public and assigns every release", () => {
  assert.equal(ownerOfPath("catchfn/typescript/package.json", { repo: "public" }), "public");
  assert.equal(ownerOfPath("reviewfn/core/package.json", { repo: "public" }), "public");
  assert.equal(ownerOfPath("package-lock.json", { repo: "public" }), "generated");
  assert.equal(ownerOfRelease("hostfn", { repo: "public" }), "public");
});

const cli = (argv) => {
  const out = [];
  const err = [];
  const status = runOwnersCli(argv, { stdout: (line) => out.push(line), stderr: (line) => err.push(line) });
  return { status, out, err: err.join("\n") };
};

test("the owners command prints each path's owner and fails on an unlisted path (SFNS-128)", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "owners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, PUBLIC_MANIFEST), JSON.stringify(publicData()));

  assert.deepEqual(cli(["--root", dir, "datafn/core/src/", "package-lock.json"]), {
    status: 0,
    out: ["datafn/core/src: public", "package-lock.json: generated"],
    err: "",
  });
  const unlisted = cli(["--root", dir, "datafn", "docsfn/x"]);
  assert.equal(unlisted.status, 1);
  assert.deepEqual(unlisted.out, ["datafn: public"]);
  assert.match(unlisted.err, /unlisted-path/);
  // Without the next manifest, --repo next cannot tell whether an unlisted path is next-owned: it must not say "public".
  const noNextManifest = cli(["--root", dir, "--repo=next", "datafn/x", "NEXT.md", "package-lock.json"]);
  assert.equal(noNextManifest.status, 1);
  assert.deepEqual(noNextManifest.out, ["datafn/x: public", "package-lock.json: generated"]);
  assert.match(noNextManifest.err, /next-manifest-needed.*"NEXT\.md".*superfunctions\.owners\.next\.json/);

  writeFileSync(path.join(dir, NEXT_MANIFEST), JSON.stringify(nextData()));
  assert.deepEqual(cli(["--root", dir, "docsfn/x", "NEXT.md", "--", "--odd"]).out, ["docsfn/x: next", "NEXT.md: next", "--odd: public"]);
  assert.deepEqual(cli(["--root", dir, "--repo", "public", "datafn"]), { status: 0, out: ["datafn: public"], err: "" });
});

test("the owners command rejects bad arguments and unreadable manifests", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "owners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["--repo", "elsewhere", "datafn"]).status, 2);
  assert.equal(cli(["--root"]).status, 2);
  // A flag or `--` where a value belongs is a missing value, not a root named "--repo=public".
  assert.equal(cli(["--root", "--repo=public", "AGENTS.md"]).status, 2);
  assert.match(cli(["--root", "--repo=public", "AGENTS.md"]).err, /--root needs a value/);
  assert.equal(cli(["--repo", "--", "AGENTS.md"]).status, 2);
  assert.equal(cli(["--bogus", "datafn"]).status, 2);
  const missing = cli(["--root", dir, "datafn"]);
  assert.equal(missing.status, 1);
  assert.match(missing.err, /manifest-not-found/);
  assert.match(cli(["/etc/passwd"]).err, /invalid-path/);
});

const hasControl = (value) => [...value].some((char) => /[\p{Cc}\u2028\u2029]/u.test(char));

test("the owners command resolves a path with a control character and prints it as one quoted record", (t) => {
  const cases = [
    ["catchfn/a\tb", '"catchfn/a\\tb": public'],
    ["catchfn/a\nNEXT.md: next", '"catchfn/a\\nNEXT.md: next": public'],
    ["catchfn/a\u2028NEXT.md", '"catchfn/a\\u2028NEXT.md": public'],
  ];
  for (const [target, record] of cases) {
    const result = cli(["AGENTS.md", target]);
    assert.deepEqual(result, { status: 0, out: ["AGENTS.md: public", record], err: "" }, JSON.stringify(target));
    assert.ok(!result.out.some(hasControl), "each record stays on one line");
  }
  // A path that itself starts with a double quote is quoted too, so it cannot pass for a quoted path.
  const dir = mkdtempSync(path.join(tmpdir(), "owners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, PUBLIC_MANIFEST), JSON.stringify(publicData()));
  writeFileSync(path.join(dir, NEXT_MANIFEST), JSON.stringify(nextData()));
  assert.deepEqual(cli(["--root", dir, '"x/y"']), { status: 0, out: ['"\\"x/y\\"": public'], err: "" });
  // Invalid paths are still rejected, with the control character escaped in the one diagnostic line.
  const outside = cli(["AGENTS.md", "../a\nAGENTS.md: public"]);
  assert.equal(outside.status, 1);
  assert.deepEqual(outside.out, ["AGENTS.md: public"]);
  assert.match(outside.err, /invalid-path/);
  assert.ok(!hasControl(outside.err));
});

// Each stderr line is a diagnostic or the usage line: an argument's line break never starts a line of its own.
const assertDiagnosticLines = (err) => {
  for (const line of err.split("\n")) {
    assert.ok(line.startsWith("error") || line.startsWith("usage: "), `unexpected stderr line ${JSON.stringify(line)}`);
    assert.ok(!hasControl(line), `stderr line has a raw control character: ${JSON.stringify(line)}`);
  }
};

test("the owners command escapes control characters in every diagnostic", () => {
  const forgedRoot = cli(["--root", "/nope\nAGENTS.md: public", "AGENTS.md"]);
  assert.equal(forgedRoot.status, 1);
  assert.deepEqual(forgedRoot.out, []);
  assert.match(forgedRoot.err, /manifest-not-found.*\/nope\\u000aAGENTS\.md: public/);
  assertDiagnosticLines(forgedRoot.err);

  for (const option of ["--bogus\nAGENTS.md: public", "--bogus AGENTS.md: public"]) {
    const unknown = cli([option, "AGENTS.md"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.err, /unknown option "--bogus\\(n|u2028)AGENTS\.md: public"/);
    assertDiagnosticLines(unknown.err);
  }

  const badRepo = cli(["--repo", "next AGENTS.md: public", "AGENTS.md"]);
  assert.equal(badRepo.status, 2);
  assert.match(badRepo.err, /--repo must be .* not "next\\u2028AGENTS\.md: public"/);
  assertDiagnosticLines(badRepo.err);
});

test("node scripts/owners.mjs <path> runs as a command in this checkout", () => {
  const script = fileURLToPath(new URL("owners.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "AGENTS.md", "catchfn/typescript"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "AGENTS.md: public\ncatchfn/typescript: public\n");
});

test("node scripts/owners.mjs runs through a symlinked checkout path and reports an invalid path", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "owners-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "scripts");
  symlinkSync(path.dirname(fileURLToPath(import.meta.url)), link, "dir");
  const script = path.join(link, "owners.mjs");
  assert.notEqual(script, realpathSync(script));
  const result = spawnSync(process.execPath, [script, "AGENTS.md", "../outside"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "AGENTS.md: public\n");
  assert.match(result.stderr, /invalid-path.*\.\.\/outside/);
});

test("node --preserve-symlinks-main scripts/owners.mjs through a symlinked checkout path still runs the command", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "owners-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "scripts");
  symlinkSync(path.dirname(fileURLToPath(import.meta.url)), link, "dir");
  const script = path.join(link, "owners.mjs");
  for (const args of [["--preserve-symlinks-main", script], ["--preserve-symlinks", "--preserve-symlinks-main", script]]) {
    const result = spawnSync(process.execPath, [...args, "AGENTS.md", "../outside"], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "AGENTS.md: public\n");
    assert.match(result.stderr, /invalid-path.*\.\.\/outside/);
  }
});

test("importing scripts/owners.mjs from an eval entry neither prints nor sets the exit status", () => {
  const script = fileURLToPath(new URL("owners.mjs", import.meta.url));
  const source = `await import(${JSON.stringify(pathToFileURL(script).href)})`;
  for (const flags of [["--input-type=module", "-e", source], ["--input-type=module", `--eval=${source}`], ["-p", `import(${JSON.stringify(pathToFileURL(script).href)}).then(() => "imported")`]]) {
    const result = spawnSync(process.execPath, [...flags, "--", script, "AGENTS.md"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /AGENTS\.md/);
  }
});

test("a preload of scripts/owners.mjs under another URL stays inert and the entry owns output and exit status", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "owners-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, "scripts");
  symlinkSync(path.dirname(fileURLToPath(import.meta.url)), link, "dir");
  const script = fileURLToPath(new URL("owners.mjs", import.meta.url));
  const linked = path.join(link, "owners.mjs");
  const url = pathToFileURL(script).href;
  // A later preload that resets the exit status: only the entry, which runs after every preload, may set it.
  const reset = ["--import", "data:text/javascript,process.exitCode=0"];
  const runs = [
    { args: ["--import", `${url}?preload`, ...reset, script] },
    // Node resolves an empty query or fragment to the entry's own URL: that preload is the entry instance,
    // evaluated early (once), so it prints the records once and sets the exit status.
    { args: ["--import", `${url}?`, script] },
    { args: ["--import", `${url}#`, script] },
    { args: ["--preserve-symlinks-main", "--import", url, ...reset, linked] },
    { args: ["--import", url, ...reset, linked], env: { NODE_OPTIONS: "--preserve-symlinks-main" } },
    { args: ["--import", url, ...reset, linked], env: { NODE_OPTIONS: '"--preserve-symlinks-main"' } },
    // Direct runs whose effective symlink setting differs from what a flag scan would see.
    { args: [linked], env: { NODE_OPTIONS: '"--preserve-symlinks-main"' } },
    { args: ["--preserve-symlinks-main", "--no-preserve-symlinks-main", linked] },
    { args: ["--title=--preserve-symlinks-main", linked] },
    // A preload that ends the process from a timer: the entry has already printed and set the exit status.
    { args: ["--import", "data:text/javascript,setTimeout(()=>process.exit(process.exitCode),500)", script] },
    { args: ["--preserve-symlinks-main", "--import", "data:text/javascript,setTimeout(()=>process.exit(process.exitCode),500)", linked] },
  ];
  for (const { args, env } of runs) {
    const options = { encoding: "utf8", env: { ...process.env, ...env } };
    const result = spawnSync(process.execPath, [...args, "AGENTS.md", "../outside"], options);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "AGENTS.md: public\n", args.join(" "));
    assert.equal(result.stderr.match(/invalid-path/g)?.length, 1, result.stderr);
    const clean = spawnSync(process.execPath, [...args, "AGENTS.md"], options);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout, "AGENTS.md: public\n");
  }
});
