import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEXT_MANIFEST, OwnersError, PUBLIC_MANIFEST } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";
import { pyprojectName, repoFromEnv, verifyOwners } from "./verify-owners.mjs";

const script = fileURLToPath(new URL("./verify-owners.mjs", import.meta.url));

const manifest = () => ({
  version: 1,
  paths: { datafn: "public", ".github": "public" },
  rootFiles: { public: ["package.json", "release-packages.json", PUBLIC_MANIFEST], generated: ["package-lock.json", "Package.resolved"] },
  releases: { "datafn-core": "public" },
  python: { datafn: "public" },
});

function fixture(t, { owners = manifest(), next, releases = [{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }], files = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "verify-owners-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const all = {
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "release-packages.json": JSON.stringify(releases),
    [PUBLIC_MANIFEST]: JSON.stringify(owners),
    ".github/workflows/ci.yml": "name: CI\n",
    "datafn/core/package.json": "{}\n",
    "datafn/python/pyproject.toml": '[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "datafn"\nversion = "0.1.0"\n',
    ...(next ? { [NEXT_MANIFEST]: JSON.stringify(next) } : {}),
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  execFileSync(gitBinary(), ["init", "-q"], { cwd: root });
  execFileSync(gitBinary(), ["add", "-A"], { cwd: root });
  return root;
}

// CI sets OWNERS_REPO for the checkout; fixtures choose their semantics explicitly, so it is cleared here.
const run = (root, ...args) => runWith({}, root, ...args);
const runWith = (env, root, ...args) =>
  spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8", env: { ...process.env, OWNERS_REPO: "", ...env } });

test("a manifest that matches the tree passes", (t) => {
  const result = run(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /match the tree/);
});

test("an unlisted top-level directory fails and names the directory", (t) => {
  const result = run(fixture(t, { files: { "newfn/core/index.ts": "export {};\n" } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /newfn\/: top-level directory is not listed in superfunctions\.owners\.json paths/);
});

test("a release entry missing from the manifest fails and names its slug and path", (t) => {
  const releases = [
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
    { slug: "datafn-cli", path: "datafn/cli", name: "@datafn/cli" },
  ];
  const result = run(fixture(t, { releases }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/cli: release "datafn-cli" from release-packages\.json is not listed/);
});

test("a Python project missing from the manifest fails and names its pyproject.toml", (t) => {
  const result = run(fixture(t, { files: { "datafn/extra/pyproject.toml": '[project]\nname = "datafn-extra"\n' } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /datafn\/extra\/pyproject\.toml: Python project "datafn-extra" is not listed/);
});

test("unlisted root files, stale entries and a next manifest on public fail", (t) => {
  const owners = manifest();
  owners.paths.gonefn = "public";
  owners.releases["gone-core"] = "public";
  owners.python.gone = "public";
  owners.rootFiles.public.push("turbo.json");
  const next = { version: 1, paths: { docsfn: "next" } };
  const result = run(fixture(t, { owners, next, files: { "notes.txt": "x\n" } }), "--repo", "public");
  assert.equal(result.status, 1);
  for (const expected of [
    /notes\.txt: root file is not listed/,
    /gonefn\/: listed in superfunctions\.owners\.json paths but is not a tracked top-level directory/,
    /turbo\.json: listed in superfunctions\.owners\.json rootFiles\.public but is not a tracked root file/,
    /release "gone-core" has no entry in the release files/,
    /Python project "gone" has no tracked pyproject\.toml/,
    /superfunctions\.owners\.next\.json: exists only on next/,
  ]) {
    assert.match(result.stderr, expected);
  }
  // Generated root files may be absent (Package.resolved is listed but not in the tree).
  assert.doesNotMatch(result.stderr, /Package\.resolved/);
});

test("a release whose path belongs to another owner fails", (t) => {
  const owners = manifest();
  owners.releases["docs-site"] = "public";
  const next = { version: 1, paths: { docsfn: "next" } };
  const files = {
    "docsfn/site/a.md": "a\n",
    "release-packages.next.json": JSON.stringify([{ slug: "docs-site", path: "docsfn/site" }]),
  };
  const errors = verifyOwners({ root: fixture(t, { owners, next, files }), repo: "next" });
  assert.deepEqual(errors, ['docsfn/site: release "docs-site" is public-published but its path is next-owned']);
});

test("a release path that cannot be owned fails on public and names its path and slug", (t) => {
  const next = { version: 1, paths: { docsfn: "next" } };
  for (const releasePath of ["../datafn/core", "/abs/x", "nonexistentfn/core"]) {
    const releases = [{ slug: "datafn-core", path: releasePath, name: "@datafn/core" }];
    const result = run(fixture(t, { releases }), "--repo", "public");
    assert.equal(result.status, 1, releasePath);
    const expected = `${releasePath}: release "datafn-core" from release-packages.json has a path that cannot be owned`;
    assert.ok(result.stderr.includes(expected), result.stderr);
    // On next an invalid path still fails; an unlisted relative path is public-owned there.
    const onNext = run(fixture(t, { releases, next, files: { "docsfn/a.md": "a\n" } }), "--repo", "next");
    if (releasePath === "nonexistentfn/core") assert.equal(onNext.status, 0, onNext.stderr);
    else {
      assert.equal(onNext.status, 1, releasePath);
      assert.match(onNext.stderr, /release "datafn-core" from release-packages\.json has a path that cannot be owned \(invalid-path\)/);
    }
  }
});

test("on next a release under an unlisted relative path is public-owned and passes", (t) => {
  const owners = manifest();
  owners.releases["watchfn-core"] = "public";
  const next = { version: 1, paths: { docsfn: "next" } };
  const releases = [
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
    { slug: "watchfn-core", path: "watchfn/core", name: "@watchfn/core" },
  ];
  const root = fixture(t, { owners, next, releases, files: { "docsfn/a.md": "a\n", "watchfn/core/index.ts": "export {};\n" } });
  assert.deepEqual(verifyOwners({ root, repo: "next" }), []);
});

test("an invalid OWNERS_REPO is named in the error", (t) => {
  const result = runWith({ OWNERS_REPO: "main" }, fixture(t));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error \(invalid-repo\): OWNERS_REPO must be "public" or "next", not "main"/);
});

test("on next an unlisted directory is public-owned and next entries must exist", (t) => {
  const next = { version: 1, paths: { docsfn: "next", ghostfn: "next" }, rootFiles: { next: ["NEXT.md"] } };
  const root = fixture(t, { next, files: { "docsfn/a.md": "a\n", "NEXT.md": "n\n", "watchfn/core/index.ts": "export {};\n" } });
  const errors = verifyOwners({ root });
  assert.deepEqual(errors, ["ghostfn/: listed in superfunctions.owners.next.json paths but is not a tracked top-level directory"]);
});

test("a malformed manifest fails with its typed error", (t) => {
  const result = run(fixture(t, { owners: { ...manifest(), version: "1" } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error \(malformed-manifest\): superfunctions\.owners\.json: version must be 1/);
  assert.equal(run(fixture(t), "--repo", "main").status, 1);
});

const throwsUnreadable = (source, pattern) =>
  assert.throws(
    () => pyprojectName(source, "x/pyproject.toml"),
    (error) => error instanceof OwnersError && error.code === "unreadable-pyproject" && pattern.test(error.message),
  );

test("pyprojectName reads only the [project] table", () => {
  assert.equal(pyprojectName('[tool.x]\nname = "tool"\n[project]\n# c\nname = \'lib\'  # n\n'), "lib");
  assert.equal(pyprojectName('[tool.ruff]\nline-length = 100\n'), null);
  assert.equal(pyprojectName('[tool.x]\nproject.name = "nested"\n'), null);
  throwsUnreadable('[project]\nversion = "1"\n', /x\/pyproject\.toml: project metadata has no name/);
});

test("pyprojectName reads every TOML spelling of the project name", () => {
  for (const source of [
    '["project"]\nname = "a"\n',
    "[ 'project' ] # c\nname = \"a\"\n",
    '[ "project" ]\n"name" = "a"\n',
    "[project]\n'name'='a'\n",
    'project.name = "a"\nproject.version = "1"\n[tool.x]\nname = "tool"\n',
    '"project" . \'name\' = "a"\n',
    '[project]\nname = "\\u0061"\n',
  ]) {
    assert.equal(pyprojectName(source), "a", source);
  }
});

test("pyprojectName accepts subtables and arrays of tables under project in either order", () => {
  const authors = '[[project.authors]]\nname = "21n"\nemail = "a@b"\n';
  assert.equal(pyprojectName(`[project]\nname = "datafn"\nversion = "0.1.0"\n${authors}`), "datafn");
  assert.equal(pyprojectName(`[[project.maintainers]]\nname = "m"\n[project]\nname = "datafn"\n`), "datafn");
  assert.equal(pyprojectName(`project.name = "datafn"\n${authors}[project.urls]\nname = "u"\n`), "datafn");
  assert.equal(pyprojectName(`[project]\nname = "datafn"\n[[project.authors]]\n[project.optional-dependencies]\nname = ["x"]\n`), "datafn");
  throwsUnreadable(authors, /x\/pyproject\.toml: project metadata has no name/);
  throwsUnreadable('[[project]]\nname = "a"\n', /array of tables/);
  throwsUnreadable('[project]\nname = "a"\n[[ "project" ]]\n', /x\/pyproject\.toml:3: project metadata must not be an array of tables/);
});

test("pyprojectName skips multi-line values and fails closed on unreadable project metadata", () => {
  const multiline = [
    'description = """',
    "[project]",
    'name = "fake"',
    '"""',
    "deps = [",
    '  "a[x]",',
    '  ["b"],',
    "]",
    "[project]",
    'name = "real"',
  ].join("\n");
  assert.equal(pyprojectName(multiline), "real");
  throwsUnreadable('[project.urls]\nhome = "h"\n', /no name/);
  throwsUnreadable('[[project]]\nname = "a"\n', /array of tables/);
  throwsUnreadable('[project]\nname = "a"\n[project]\nname = "b"\n', /more than once/);
  throwsUnreadable('[project\nname = "a"\n', /x\/pyproject\.toml:1: cannot read table header/);
  throwsUnreadable('[tool.x]\ny = """\n', /unterminated/);
});

test("pyprojectName reads an inline-table project and only its top-level name", () => {
  assert.equal(pyprojectName('project = { name = "datafn", version = "0.1.0" }\n'), "datafn");
  assert.equal(pyprojectName('project = { authors = [{ name = "a" }], urls = { name = "u" }, "name" = "datafn" }\n'), "datafn");
  assert.equal(pyprojectName("project = { 'name' = \"datafn\", optional-dependencies.name = [\"x\"] }\n"), "datafn");
  // TOML 1.1 allows newlines and a trailing comma inside an inline table.
  assert.equal(pyprojectName('project = {\n  version = "1",\n  name = "datafn",\n}\n'), "datafn");
  throwsUnreadable('project = { version = "1", authors = [{ name = "a" }], urls = { name = "u" } }\n', /x\/pyproject\.toml: project metadata has no name/);
  throwsUnreadable('project = { name = "a" }\n[project]\nname = "b"\n', /x\/pyproject\.toml:2: project is defined more than once/);
  throwsUnreadable('project = { name = "a" }\nproject.version = "1"\n', /x\/pyproject\.toml:2: project is defined more than once/);
  throwsUnreadable('project = { name = "a", "name" = "b" }\n', /project\.name is defined more than once/);
  throwsUnreadable('project = "datafn"\n', /x\/pyproject\.toml:1: project metadata must be a table/);
});

test("pyprojectName reads every TOML string kind as the name", () => {
  for (const source of [
    '[project]\nname = """datafn"""\n',
    "[project]\nname = '''datafn'''\n",
    '[project]\nname = """\ndatafn"""\n',
    "[project]\nname = '''\ndatafn'''\n",
    '[project]\nname = """\\\n   data\\\n   fn"""\n',
    '[project]\nname = """data\\u0066n"""\n',
    '[project]\r\nname = """\r\ndatafn"""\r\n',
  ]) {
    assert.equal(pyprojectName(source), "datafn", source);
  }
  assert.equal(pyprojectName('[project]\nname = """"datafn""""\n'), '"datafn"');
  throwsUnreadable('[project]\nname = """data\nfn"""\n', /x\/pyproject\.toml:2: project name must not contain a line break/);
  throwsUnreadable("[project]\nname = '''\n'''\n", /x\/pyproject\.toml:2: project name is empty/);
  throwsUnreadable("[project]\nname = 1\n", /x\/pyproject\.toml:2: project name must be a string/);
  throwsUnreadable('[project]\nname = """datafn\n', /x\/pyproject\.toml:2: unterminated multi-line string/);
});

test("pyprojectName follows the TOML rules for dotted keys and table headers", () => {
  // Dotted keys may extend a table that only a longer header named; headers may add subtables to dotted tables.
  assert.equal(pyprojectName('[a.b.c]\n[a]\nb.d = 1\n[project]\nname = "x"\n'), "x");
  assert.equal(pyprojectName('[fruit]\napple.color = "red"\n[fruit.apple.texture]\n[project]\nname = "x"\n'), "x");
  assert.equal(pyprojectName('a = 1979-05-27 07:32:00Z\nb = [1, 2, # c\n 3,]\nc = +inf\n[project]\nname = "x"\n'), "x");
  throwsUnreadable('[project]\nname = "x"\nurls.home = "h"\n[project.urls]\n', /:4: project\.urls is defined more than once/);
  throwsUnreadable('project.name = "x"\n[project]\n', /:2: project is defined more than once/);
  throwsUnreadable('[project]\nname = "x" y\n', /:2: unexpected text after value/);
  throwsUnreadable('[project]\nname = "a\\qb"\n', /:2: invalid escape \\q/);
});

test("pyprojectName accepts every TOML 1.1 change", () => {
  // \xHH escapes in a basic name, a multi-line basic name and a quoted key.
  assert.equal(pyprojectName('[project]\nname = "\\x64atafn"\n'), "datafn");
  assert.equal(pyprojectName('[project]\nname = """\\x64ata\\x66n"""\n'), "datafn");
  assert.equal(pyprojectName('[project]\n"n\\x61me" = "datafn"\n'), "datafn");
  // An escape in an unrelated string must not break discovery, since the whole document is parsed.
  assert.equal(pyprojectName('[tool.x]\ny = "\\x41\\xff"\nz = "\\e"\n[project]\nname = "datafn"\n'), "datafn");
  assert.equal(pyprojectName('[project]\nname = "datafn"\ncolor = "\\e[1m"\n'), "datafn");
  // Newlines, comments and a trailing comma inside an inline table.
  assert.equal(pyprojectName('project = {\n  # metadata\n  name = "datafn", # the name\n  version = "1",\n}\n'), "datafn");
  // Datetimes and times without seconds.
  assert.equal(pyprojectName('[tool.x]\nat = 1979-05-27T07:32Z\nlocal = 1979-05-27 07:32\nt = 07:32\n[project]\nname = "datafn"\n'), "datafn");
  throwsUnreadable('[project]\nname = "\\x6"\n', /x\/pyproject\.toml:2: invalid escape \\x/);
  throwsUnreadable('[project]\nname = "\\xG1"\n', /x\/pyproject\.toml:2: invalid escape \\x/);
  throwsUnreadable('[project]\nname = "datafn\\x"\n', /x\/pyproject\.toml:2: invalid escape \\x/);
});

test("an unreadable pyproject.toml fails the check and names the file", (t) => {
  const result = run(fixture(t, { files: { "datafn/extra/pyproject.toml": '["project"]\nname = 1\n' } }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /error \(unreadable-pyproject\): datafn\/extra\/pyproject\.toml:2: project name must be a string/);
  const quoted = run(fixture(t, { files: { "datafn/extra/pyproject.toml": '[ "project" ]\n"name" = "datafn-extra"\n' } }));
  assert.equal(quoted.status, 1);
  assert.match(quoted.stderr, /datafn\/extra\/pyproject\.toml: Python project "datafn-extra" is not listed/);
});

test("an inline-table pyproject.toml passes when listed and fails naming its file when unlisted", (t) => {
  const files = { "datafn/extra/pyproject.toml": 'project = { version = "0.1.0", name = """datafn-extra""" }\n' };
  const unlisted = run(fixture(t, { files }));
  assert.equal(unlisted.status, 1);
  assert.match(unlisted.stderr, /datafn\/extra\/pyproject\.toml: Python project "datafn-extra" is not listed/);
  const owners = manifest();
  owners.python["datafn-extra"] = "public";
  const listed = run(fixture(t, { owners, files }));
  assert.equal(listed.status, 0, listed.stderr);
});

test("Python projects are matched by their PEP 503 canonical name", (t) => {
  // A pyproject spelling of a listed project passes, and the manifest entry is not reported stale.
  const aliased = run(fixture(t, { files: { "datafn/python/pyproject.toml": '[project]\nname = "DataFn"\n' } }));
  assert.equal(aliased.status, 0, aliased.stderr);
  const owners = manifest();
  owners.python = { "foo-bar": "public" };
  const files = { "datafn/python/pyproject.toml": null, "datafn/foo/pyproject.toml": '[project]\nname = "Foo_Bar"\n' };
  const listed = run(fixture(t, { owners, files }));
  assert.equal(listed.status, 0, listed.stderr);
  // Two pyproject.toml files that spell one distribution differently fail and name both files.
  files["datafn/foo2/pyproject.toml"] = '[project]\nname = "foo.bar"\n';
  const twice = run(fixture(t, { owners, files }));
  assert.equal(twice.status, 1);
  assert.ok(
    twice.stderr.includes('datafn/foo2/pyproject.toml: Python project "foo.bar" is also defined by datafn/foo/pyproject.toml (as "Foo_Bar")'),
    twice.stderr,
  );
  assert.ok(!twice.stderr.includes("has no tracked pyproject.toml"), twice.stderr);
});

test("the self-check uses the checkout's semantics, so a next-shaped tree passes", (t) => {
  const next = { version: 1, paths: { docsfn: "next" }, rootFiles: { next: ["NEXT.md"] } };
  const root = fixture(t, { next, files: { "docsfn/a.md": "a\n", "NEXT.md": "n\n", "watchfn/core/index.ts": "export {};\n" } });
  assert.equal(repoFromEnv({}), undefined);
  assert.equal(repoFromEnv({ OWNERS_REPO: "" }), undefined);
  assert.equal(repoFromEnv({ OWNERS_REPO: "next" }), "next");
  assert.deepEqual(verifyOwners({ root, repo: repoFromEnv({ OWNERS_REPO: "next" }) }), []);
  assert.deepEqual(verifyOwners({ root, repo: repoFromEnv({}) }), []);
  // The same tree under public semantics is the old, wrong self-check.
  assert.notDeepEqual(verifyOwners({ root, repo: "public" }), []);
  assert.equal(runWith({ OWNERS_REPO: "next" }, root).status, 0);
  assert.equal(runWith({}, root).status, 0);
  const forcedPublic = runWith({ OWNERS_REPO: "public" }, root);
  assert.equal(forcedPublic.status, 1);
  assert.match(forcedPublic.stderr, /docsfn\/: top-level directory is not listed/);
  assert.equal(runWith({ OWNERS_REPO: "public" }, root, "--repo", "next").status, 0);
});

test("the checked-out repository matches its manifest", () => {
  // OWNERS_REPO is set by CI on both repositories; locally the presence of the next manifest decides.
  assert.deepEqual(verifyOwners({ repo: repoFromEnv() }), []);
});
