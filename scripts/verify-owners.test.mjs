import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NEXT_MANIFEST, OwnersError, PUBLIC_MANIFEST } from "./owners.mjs";
import { gitBinary } from "./verify-package-lockfiles.mjs";
import {
  REPOSITORY_GUARD,
  REUSABLE_CALL_INPUT,
  REUSABLE_WORKFLOW_GUARD,
  REUSABLE_WORKFLOW_GUARD_ALWAYS,
  SHARED_WORKFLOWS,
  hasRepositoryGuard,
  pyprojectName,
  repoFromEnv,
  verifyOwners,
  workflowGuardErrors,
  workflowInputs,
  workflowTriggers,
} from "./verify-owners.mjs";

const script = fileURLToPath(new URL("./verify-owners.mjs", import.meta.url));

const guardedWorkflow = `name: CI\non: push\njobs:\n  test:\n    if: ${REPOSITORY_GUARD}\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n`;

const manifest = () => ({
  version: 1,
  paths: { datafn: "public", ".github": "public" },
  rootFiles: { public: ["package.json", "release-packages.json", PUBLIC_MANIFEST], generated: ["package-lock.json", "Package.resolved"] },
  releases: { "datafn-core": "public" },
  python: { datafn: "public" },
});

function fixture(t, { owners = manifest(), next, releases = [{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }], files = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "verify-owners-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const all = {
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "release-packages.json": JSON.stringify(releases),
    [PUBLIC_MANIFEST]: JSON.stringify(owners),
    ".github/workflows/ci.yml": guardedWorkflow,
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
  const releases = [
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
    { slug: "docs-site", path: "docsfn/site", name: "@docsfn/site" },
  ];
  const errors = verifyOwners({ root: fixture(t, { owners, next, releases, files: { "docsfn/site/a.md": "a\n" } }), repo: "next" });
  assert.deepEqual(errors, ['docsfn/site: release "docs-site" is public-published but its path is next-owned']);
});

// A next tree with a public release in the public file and a next release in the next file.
function nextReleaseFixture(t, { publicReleases = [], nextReleases = [] } = {}) {
  const next = { version: 1, paths: { docsfn: "next" }, releases: { "docs-site": "next" } };
  const files = {
    "docsfn/site/a.md": "a\n",
    "release-packages.next.json": JSON.stringify([{ slug: "docs-site", path: "docsfn/site", name: "@docsfn/site" }, ...nextReleases]),
  };
  const releases = [{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }, ...publicReleases];
  return fixture(t, { next, releases, files });
}

test("a release slug with more than one entry fails and names the slug and both sources", (t) => {
  const twice = [
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
  ];
  const result = run(fixture(t, { releases: twice }), "--repo", "public");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('datafn/core: release "datafn-core" is listed more than once in release-packages.json'), result.stderr);

  const both = verifyOwners({ root: nextReleaseFixture(t, { nextReleases: [{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }] }), repo: "next" });
  assert.ok(
    both.includes('datafn/core: release "datafn-core" is listed in both release-packages.json and release-packages.next.json; a release has exactly one entry'),
    both.join("\n"),
  );
});

test("a release listed in the other repository's release file fails and names the expected file", (t) => {
  const nextInPublic = verifyOwners({ root: nextReleaseFixture(t, { publicReleases: [{ slug: "docs-site", path: "docsfn/site", name: "@docsfn/site" }] }), repo: "next" });
  assert.ok(
    nextInPublic.includes('docsfn/site: release "docs-site" is next-published but listed in release-packages.json; it belongs in release-packages.next.json'),
    nextInPublic.join("\n"),
  );

  const next = { version: 1, paths: { docsfn: "next" } };
  const files = { "docsfn/a.md": "a\n", "release-packages.next.json": JSON.stringify([{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }]) };
  const publicInNext = verifyOwners({ root: fixture(t, { next, releases: [], files }), repo: "next" });
  assert.deepEqual(publicInNext, [
    'datafn/core: release "datafn-core" is public-published but listed in release-packages.next.json; it belongs in release-packages.json',
  ]);
});

test("a bare release publishes from the repository that publishes its core and CLI", (t) => {
  const bare = { slug: "datafn", path: "datafn/bare", name: "datafn", kind: "bare", core: "datafn-core", cli: "docs-site" };
  const files = { "datafn/bare/package.json": "{}\n" };
  const owners = manifest();
  owners.releases.datafn = "public";
  const next = { version: 1, paths: { docsfn: "next" }, releases: { "docs-site": "next" } };
  const nextFiles = {
    ...files,
    "docsfn/site/a.md": "a\n",
    "release-packages.next.json": JSON.stringify([{ slug: "docs-site", path: "docsfn/site", name: "@docsfn/site" }]),
  };
  const releases = [{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }, bare];
  assert.deepEqual(verifyOwners({ root: fixture(t, { owners, next, releases, files: nextFiles }), repo: "next" }), [
    'datafn/bare: bare release "datafn" is public-published but its cli "docs-site" is next-published; a bare package publishes from its product\'s repository',
  ]);
  const sameOwner = [{ slug: "datafn-core", path: "datafn/core", name: "@datafn/core" }, { ...bare, cli: undefined, core: "datafn-core" }];
  assert.deepEqual(verifyOwners({ root: fixture(t, { owners, releases: sameOwner, files }), repo: "public" }), []);
});

test("on next each release in its publisher's release file passes", (t) => {
  assert.deepEqual(verifyOwners({ root: nextReleaseFixture(t), repo: "next" }), []);
});

test("two release slugs with one npm name fail and name both slugs, the name and the files", (t) => {
  const owners = manifest();
  owners.releases["datafn-core-alias"] = "public";
  const sameFile = [
    { slug: "datafn-core", path: "datafn/core", name: "@datafn/core" },
    { slug: "datafn-core-alias", path: "datafn/core", name: "@datafn/core" },
  ];
  const result = run(fixture(t, { owners, releases: sameFile }), "--repo", "public");
  assert.equal(result.status, 1);
  const expected =
    'datafn/core: release "datafn-core-alias" from release-packages.json has npm name "@datafn/core", which release "datafn-core" from release-packages.json also has; a package has exactly one release entry';
  assert.ok(result.stderr.includes(expected), result.stderr);

  const distinctNames = verifyOwners({ root: nextReleaseFixture(t), repo: "next" });
  assert.deepEqual(distinctNames, []);
  const next = { version: 1, paths: { docsfn: "next" }, releases: { "docs-site": "next" } };
  const files = {
    "docsfn/site/a.md": "a\n",
    "release-packages.next.json": JSON.stringify([{ slug: "docs-site", path: "docsfn/site", name: "@datafn/core" }]),
  };
  const errors = verifyOwners({ root: fixture(t, { next, files }), repo: "next" });
  assert.deepEqual(errors, [
    'docsfn/site: release "docs-site" from release-packages.next.json has npm name "@datafn/core", which release "datafn-core" from release-packages.json also has; a package has exactly one release entry',
  ]);
});

test("a release entry without an npm name is a malformed release file", (t) => {
  const result = run(fixture(t, { releases: [{ slug: "datafn-core", path: "datafn/core" }] }), "--repo", "public");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("error (malformed-manifest): release-packages.json: entry 0 needs a non-empty slug, path and name"), result.stderr);

  const next = { version: 1, paths: { docsfn: "next" } };
  const files = { "docsfn/a.md": "a\n", "release-packages.next.json": JSON.stringify([{ slug: "docs-site", path: "docsfn/site", name: "" }]) };
  assert.throws(
    () => verifyOwners({ root: fixture(t, { next, files }), repo: "next" }),
    (error) => error instanceof OwnersError && error.code === "malformed-manifest" && error.message.includes("release-packages.next.json: entry 0"),
  );
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

test("a workflow job without the repository guard fails unless the workflow is on the shared list", (t) => {
  assert.deepEqual(SHARED_WORKFLOWS, ["publish-tag.yml", "publish-python.yml"]);
  const unguarded = "name: X\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - if: github.repository == '21nCo/superfunctions'\n        run: echo hi\n";
  const root = fixture(t, {
    files: {
      ".github/workflows/deploy.yml": unguarded,
      ".github/workflows/publish-tag.yml": unguarded,
      ".github/workflows/publish-python.yml": unguarded,
      ".github/workflows/README.md": "not a workflow\n",
    },
  });
  const result = run(root, "--repo", "public");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.github\/workflows\/deploy\.yml: job "build" has no if:/);
  assert.doesNotMatch(result.stderr, /publish-tag|publish-python|README|ci\.yml/);
  // Both repositories run the check: .github is public-owned and synced to next.
  assert.deepEqual(
    verifyOwners({ root, repo: "next" }).filter((message) => message.includes(".github/workflows")),
    ['.github/workflows/deploy.yml: job "build" has no if:; jobs outside the shared list must start their if: with ' + REPOSITORY_GUARD],
  );
});

test("hasRepositoryGuard accepts only the guard or the guard joined by && to one parenthesised condition", () => {
  const guard = REPOSITORY_GUARD;
  for (const condition of [
    guard,
    `\${{ ${guard} }}`,
    `${guard} && (always())`,
    `${guard}   &&   (github.event_name == 'pull_request' && github.base_ref == 'dev')`,
    `${guard} && (contains(github.ref, ')') || github.ref == 'refs/heads/dev')`,
    `${guard} && (github.actor == 'it''s')`,
  ]) {
    assert.equal(hasRepositoryGuard(condition), true, condition);
  }
  for (const condition of [
    "always()",
    `${guard} || always()`,
    `always() && ${guard}`,
    `${guard} && (a) || (b)`,
    `${guard} && a == 'b'`,
    `${guard} && (a`,
    "github.repository == '21nCo/super-functions.next'",
    "github.repository != '21nCo/superfunctions'",
  ]) {
    assert.equal(hasRepositoryGuard(condition), false, condition);
  }
});

test("workflowGuardErrors reads every if: spelling, names each unguarded job and fails closed on layouts it cannot read", () => {
  const workflow = (jobs) => `name: X\non: push\njobs:\n${jobs}`;
  const guard = REPOSITORY_GUARD;
  const ok = [
    `  a:\n    name: A\n    if: ${guard}\n    runs-on: x\n`,
    `  a:\n    if: '${guard.replaceAll("'", "''")} && (always())'\n`,
    `  a:\n    if: "${guard} && (always())" # quoted\n`,
    `  a:\n    if: \${{ ${guard} }} # comment\n`,
    `  a:\n    if: >-\n      ${guard} &&\n      (needs.plan.outputs.run == 'true')\n    runs-on: x\n`,
    `  # a comment\n  a:\n\n    if: ${guard}\n    steps:\n      - run: |\n          if: not a key\n  'b':\n    needs: a\n    if: ${guard} && (always())\n`,
  ];
  for (const jobs of ok) assert.deepEqual(workflowGuardErrors("w.yml", workflow(jobs)), [], jobs);

  assert.deepEqual(workflowGuardErrors("w.yml", workflow(`  a:\n    runs-on: x\n  b:\n    if: always()\n  c:\n    if: ${guard}\n`)), [
    `w.yml: job "a" has no if:; jobs outside the shared list must start their if: with ${guard}`,
    `w.yml: job "b" has if: "always()"; jobs outside the shared list must start their if: with ${guard}`,
  ]);
  // An if: nested under steps or with: is not the job's condition.
  assert.equal(workflowGuardErrors("w.yml", workflow(`  a:\n    steps:\n      - if: ${guard}\n    with:\n      if: ${guard}\n`)).length, 1);
  assert.match(workflowGuardErrors("w.yml", "name: X\non: push\n")[0], /has no block-style top-level jobs/);
  assert.match(workflowGuardErrors("w.yml", "name: X\njobs: { a: { runs-on: x } }\n")[0], /has no block-style top-level jobs/);
  assert.match(workflowGuardErrors("w.yml", "name: X\njobs:\nenv: {}\n")[0], /has no jobs/);
  assert.match(workflowGuardErrors("w.yml", workflow("  a: { runs-on: x }\n"))[0], /not a block-style job key/);
  assert.match(workflowGuardErrors("w.yml", workflow(`  a:\n    if: '${guard}\n`))[0], /cannot be read/);
});

test("a plain if: scalar is folded with its continuation lines, so a continued || cannot bypass the guard", () => {
  const workflow = (jobs) => `name: X\non: push\njobs:\n${jobs}`;
  const guard = REPOSITORY_GUARD;
  // YAML folds a plain scalar's deeper-indented lines into it: this if: is `guard || always()`.
  assert.deepEqual(workflowGuardErrors("w.yml", workflow(`  a:\n    if: ${guard}\n      || always()\n    runs-on: x\n`)), [
    `w.yml: job "a" has if: "${guard} || always()"; jobs outside the shared list must start their if: with ${guard}`,
  ]);
  assert.equal(workflowGuardErrors("w.yml", workflow(`  a:\n    if:\n      ${guard}\n      || always()\n`)).length, 1);
  // A guarded continuation is still accepted.
  assert.deepEqual(workflowGuardErrors("w.yml", workflow(`  a:\n    if: ${guard}\n      && (always())\n    runs-on: x\n`)), []);
  assert.deepEqual(workflowGuardErrors("w.yml", workflow(`  a:\n    if:\n      ${guard}\n`)), []);
  // Forms the line reader cannot follow fail closed instead of reading the first line only.
  for (const value of [
    `${guard} # comment\n      || always()`,
    `${guard}\n      # comment\n      || always()`,
    `'${guard.replaceAll("'", "''")}\n      || always()'`,
    `&anchor ${guard}`,
    "*anchor",
    `!!str ${guard}`,
    `[${guard}]`,
    `{ a: b }`,
  ]) {
    assert.match(workflowGuardErrors("w.yml", workflow(`  a:\n    if: ${value}\n    runs-on: x\n`))[0] ?? "", /cannot be read/, value);
  }
});

test("workflowTriggers reads the top-level on: key in each spelling and fails closed otherwise", () => {
  assert.deepEqual(workflowTriggers("on: push\njobs: {}\n"), ["push"]);
  assert.deepEqual(workflowTriggers("on: [push, workflow_call] # c\n"), ["push", "workflow_call"]);
  assert.deepEqual(workflowTriggers("'on':\n  workflow_call:\n    inputs:\n      a:\n        type: string\n  # comment\n  workflow_dispatch:\njobs:\n"), [
    "workflow_call",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflowTriggers("on:\n  - push\n  - workflow_call\n"), ["push", "workflow_call"]);
  assert.equal(workflowTriggers("name: X\njobs:\n"), null);
  assert.equal(workflowTriggers("on: { push: {} }\n"), null);
  assert.equal(workflowTriggers("on:\n    push:\n  workflow_call:\n"), null);
});

/**
 * Evaluates the subset of the GitHub Actions expression language the guards use (||, &&, !, ==, !=, parentheses,
 * context property paths and literals) with its loose equality: strings compare case-insensitively, a boolean compares
 * as a number against a string, and a missing property is null.
 */
function evaluateExpression(expression, contexts) {
  const tokens = expression.match(/'(?:[^']|'')*'|\|\||&&|==|!=|!|\(|\)|[A-Za-z_][A-Za-z0-9_.-]*/g);
  assert.equal(tokens.join(""), expression.replaceAll(/\s+/g, ""), `unsupported expression ${expression}`);
  let at = 0;
  const value = (token) => {
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    return token.split(".").reduce((object, key) => (object == null ? null : (object[key] ?? null)), contexts);
  };
  const toNumber = (operand) => (typeof operand === "boolean" ? Number(operand) : operand === null ? 0 : Number(operand));
  const equal = (left, right) => {
    if (typeof left === "string" && typeof right === "string") return left.toLowerCase() === right.toLowerCase();
    if (typeof left === typeof right) return left === right;
    return toNumber(left) === toNumber(right);
  };
  const primary = () => {
    const token = tokens[at++];
    if (token === "!") return !primary();
    if (token !== "(") return value(token);
    const inner = or();
    assert.equal(tokens[at++], ")");
    return inner;
  };
  const comparison = () => {
    const left = primary();
    if (tokens[at] !== "==" && tokens[at] !== "!=") return left;
    const negate = tokens[at++] === "!=";
    return equal(left, primary()) !== negate;
  };
  const and = () => {
    let result = comparison();
    while (tokens[at] === "&&") (at += 1), (result = comparison() && result);
    return result;
  };
  const or = () => {
    let result = and();
    while (tokens[at] === "||") (at += 1), (result = and() || result);
    return result;
  };
  const result = or();
  assert.equal(at, tokens.length, `unparsed tail of ${expression}`);
  return Boolean(result);
}

test("the reusable api-check runs for every caller and for a direct dispatch only in the public repository", () => {
  const file = ".github/workflows/apifn-api-check.yml";
  const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
  assert.deepEqual(workflowGuardErrors(file, source), []);
  // A job's properties may come in any order (api-check lists needs: next to if:), so each job's block is searched.
  const jobCondition = (job) => {
    const block = source.match(new RegExp(`^ {2}${job}:\\n((?: {4}.*\\n|\\s*\\n)*)`, "m"))?.[1] ?? "";
    return block.match(/^ {4}if: (.*)$/m)?.[1];
  };
  assert.equal(jobCondition("evaluate"), REUSABLE_WORKFLOW_GUARD);
  // api-check runs whatever evaluate's result, so a failed evaluate fails it instead of skipping it; beside always()
  // it runs exactly when the evaluate guard holds.
  assert.equal(jobCondition("api-check"), REUSABLE_WORKFLOW_GUARD_ALWAYS);
  const condition = REUSABLE_WORKFLOW_GUARD_ALWAYS.slice("always() && (".length, -1);
  assert.equal(condition, REUSABLE_WORKFLOW_GUARD);
  // GitHub builds a called workflow's inputs from its workflow_call declarations (defaults plus the caller's with:)
  // and a direct run's inputs from its workflow_dispatch declarations; github is always the caller's or the run's.
  const inputsOf = (trigger, given = {}) => {
    const inputs = {};
    for (const [name, { type, default: fallback }] of workflowInputs(source, trigger)) {
      if (fallback !== undefined) inputs[name] = type === "boolean" ? fallback === "true" : fallback;
    }
    return { ...inputs, ...given };
  };
  const runs = (github, trigger) => evaluateExpression(condition, { github, inputs: inputsOf(trigger) });
  const external = { repository: "octo/service", workflow_ref: "octo/service/.github/workflows/apifn-api-check.yml@refs/heads/main" };
  assert.equal(runs({ ...external, event_name: "pull_request" }, "workflow_call"), true, "external pull_request caller");
  // An external caller whose own file has this name, started by workflow_dispatch, still runs (the old github-based guard skipped it).
  assert.equal(runs({ ...external, event_name: "workflow_dispatch" }, "workflow_call"), true, "external same-name dispatch caller");
  assert.equal(runs({ repository: "21nCo/super-functions.next", event_name: "push" }, "workflow_call"), true, "a caller on next is guarded on its own");
  assert.equal(runs({ repository: "21nCo/superfunctions", event_name: "workflow_dispatch" }, "workflow_dispatch"), true, "direct dispatch on public");
  assert.equal(runs({ repository: "21nCo/super-functions.next", event_name: "workflow_dispatch" }, "workflow_dispatch"), false, "direct dispatch on next");
  assert.equal(evaluateExpression(REPOSITORY_GUARD, { github: { repository: "21NCO/SuperFunctions" } }), true);
});

test("the reusable-workflow guard is accepted only with a call-only marker input on a call or dispatch workflow", () => {
  assert.equal(REUSABLE_WORKFLOW_GUARD, `${REPOSITORY_GUARD} || inputs.${REUSABLE_CALL_INPUT} == true`);
  const marker = `      ${REUSABLE_CALL_INPUT}:\n        type: boolean\n        default: true\n`;
  const callOn = (inputs = marker) => `  workflow_call:\n    inputs:\n      spec:\n        type: string\n${inputs}`;
  const reusable = (condition, on = `on:\n${callOn()}  workflow_dispatch:\n    inputs:\n      spec:\n        type: string\n`) =>
    `name: X\n${on}jobs:\n  api-check:\n    if: ${condition}\n    runs-on: ubuntu-latest\n`;
  const file = ".github/workflows/any.yml";
  for (const condition of [REUSABLE_WORKFLOW_GUARD, `\${{ ${REUSABLE_WORKFLOW_GUARD} }}`, REPOSITORY_GUARD, REUSABLE_WORKFLOW_GUARD_ALWAYS, `\${{ ${REUSABLE_WORKFLOW_GUARD_ALWAYS} }}`]) {
    assert.deepEqual(workflowGuardErrors(file, reusable(condition)), [], condition);
  }
  assert.deepEqual(workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD, `on:\n${callOn()}`)), []);
  assert.deepEqual(workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD, `on:\n${callOn(`      '${REUSABLE_CALL_INPUT}':\n        required: false\n        default: true # call\n        type: boolean\n`)}`)), []);
  const rejected = [
    [`on:\n${callOn("")}`, /does not declare the input called_as_reusable_workflow/],
    [`on:\n${callOn(`      ${REUSABLE_CALL_INPUT}:\n        type: boolean\n        default: false\n`)}`, /does not declare the input/],
    [`on:\n${callOn(`      ${REUSABLE_CALL_INPUT}:\n        type: string\n        default: true\n`)}`, /does not declare the input/],
    [`on:\n${callOn(`      ${REUSABLE_CALL_INPUT}:\n        type: boolean\n        default: true\n        required: true\n`)}`, /does not declare the input/],
    [`on:\n${callOn()}  workflow_dispatch:\n    inputs:\n${marker}`, /workflow_dispatch also declares called_as_reusable_workflow/],
    [`on:\n${callOn()}  workflow_dispatch:\n    inputs: [a]\n`, /workflow_dispatch inputs cannot be read/],
    [`on:\n${callOn()}  push:\n`, /not triggered only by workflow_call and workflow_dispatch \(triggers: workflow_call, push\)/],
    ["on: workflow_call\n", /does not declare the input/],
    ["on: [workflow_call, pull_request]\n", /not triggered only by/],
    [`on:\n  workflow_dispatch:\n    inputs:\n${marker}`, /not triggered only by/],
  ];
  for (const [on, message] of rejected) {
    assert.match(workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD, on))[0] ?? "", message, on);
  }
  // GitHub's inputs context is case-insensitive, so inputs.called_as_reusable_workflow reads a case alias too.
  const aliasMarker = (name) => `      ${name}:\n        type: boolean\n        default: true\n`;
  for (const alias of ["CALLED_AS_REUSABLE_WORKFLOW", "Called_As_Reusable_Workflow", "called_AS_reusable_workflow", "'CALLED_AS_REUSABLE_WORKFLOW'"]) {
    const name = alias.replaceAll("'", "");
    const dispatchOn = `on:\n${callOn()}  workflow_dispatch:\n    inputs:\n${aliasMarker(alias)}`;
    const errors = workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD, dispatchOn));
    assert.equal(errors.length, 1, alias);
    assert.match(errors[0], new RegExp(`workflow_dispatch also declares ${name} \\(inputs are case-insensitive`), alias);
    assert.match(
      workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD, `on:\n${callOn()}  workflow_dispatch:\n    inputs:\n      spec:\n        type: string\n${aliasMarker(alias)}`))[0] ?? "",
      /workflow_dispatch also declares/,
      `${alias} after another dispatch input`,
    );
    // A case alias under workflow_call is the marker itself, so it serves a call like the lowercase name.
    assert.deepEqual(workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD, `on:\n${callOn(aliasMarker(alias))}`)), [], `${alias} under workflow_call`);
  }
  // Two case variants under workflow_call are ambiguous, and fail closed.
  assert.match(
    workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD, `on:\n${callOn(`${marker}${aliasMarker("CALLED_AS_REUSABLE_WORKFLOW").replace("default: true", "default: false")}`)}`))[0] ?? "",
    /does not declare the input called_as_reusable_workflow/,
  );
  assert.match(workflowGuardErrors(file, reusable(`${REUSABLE_WORKFLOW_GUARD} || always()`))[0] ?? "", /job "api-check" has if:/);
  // Only always() joined by && to the whole parenthesised guard counts; every other status form is rejected.
  for (const condition of [
    `!cancelled() && (${REUSABLE_WORKFLOW_GUARD})`,
    `(${REUSABLE_WORKFLOW_GUARD}) && always()`,
    `always() || (${REUSABLE_WORKFLOW_GUARD})`,
    `always() && ${REUSABLE_WORKFLOW_GUARD}`,
    `always() && (${REUSABLE_WORKFLOW_GUARD}) || true`,
    `always() && (${REPOSITORY_GUARD} || inputs.${REUSABLE_CALL_INPUT})`,
  ]) {
    // Wrapped in ${{ }}, since a plain YAML scalar cannot start with "!".
    assert.match(workflowGuardErrors(file, reusable(`\${{ ${condition} }}`))[0] ?? "", /job "api-check" has if:/, condition);
  }
  assert.match(
    workflowGuardErrors(file, reusable(REUSABLE_WORKFLOW_GUARD_ALWAYS, `on:\n${callOn("")}`))[0] ?? "",
    /carries the reusable-workflow guard, but workflow_call does not declare the input called_as_reusable_workflow/,
  );
  assert.match(workflowGuardErrors(file, reusable(`${REPOSITORY_GUARD} || inputs.${REUSABLE_CALL_INPUT}`))[0] ?? "", /job "api-check" has if:/);
});

test("workflowInputs reads a trigger's declared inputs and fails closed on layouts it cannot read", () => {
  const source = `on:\n  workflow_call:\n    inputs:\n      a:\n        description: >-\n          long\n        type: boolean\n        default: true\n      "b":\n        type: string\n  workflow_dispatch:\n  push: {}\njobs:\n`;
  assert.deepEqual([...workflowInputs(source, "workflow_call")], [["a", { type: "boolean", default: "true" }], ["b", { type: "string" }]]);
  assert.deepEqual([...workflowInputs(source, "workflow_dispatch")], []);
  assert.deepEqual([...workflowInputs(source, "push")], []);
  assert.equal(workflowInputs(source, "pull_request"), null);
  assert.equal(workflowInputs("on: workflow_call\n", "workflow_call"), null);
  assert.equal(workflowInputs("on:\n  workflow_call:\n    inputs:\n      a:\n        type: boolean\n      a:\n        type: string\n", "workflow_call"), null);
  assert.equal(workflowInputs("on:\n  workflow_call:\n    inputs:\n      <<: *x\n", "workflow_call"), null);
  assert.equal(workflowInputs("on:\n  workflow_call:\n    inputs:\n      a: { type: boolean }\n", "workflow_call"), null);
  assert.equal(workflowInputs("on:\n  workflow_call:\n    inputs:\n      a:\n        default: 'x\n          y'\n", "workflow_call"), null);
});

test("quoted, unmodelled or repeated job property keys and embedded ${{ }} never count as a guard", () => {
  const workflow = (jobs) => `name: X\non: push\njobs:\n${jobs}`;
  const guard = REPOSITORY_GUARD;
  // Quoted keys are the same keys to YAML, so they are read.
  assert.deepEqual(workflowGuardErrors("w.yml", workflow(`  a:\n    'if': ${guard}\n    runs-on: x\n  b:\n    "if": ${guard}\n`)), []);
  assert.match(workflowGuardErrors("w.yml", workflow(`  a:\n    "if": always()\n`))[0] ?? "", /job "a" has if: "always\(\)"/);
  const shared = ".github/workflows/publish-tag.yml";
  for (const key of ["'uses'", '"uses"', "uses"]) {
    assert.match(workflowGuardErrors(shared, workflow(`  call:\n    ${key}: ./.github/workflows/apifn-api-check.yml\n`))[0] ?? "", /job "call" has uses: "\.\/\.github\/workflows\/apifn-api-check\.yml" and has no if:/, key);
  }
  // Keys the reader does not model, or a property indented less than the first, fail closed.
  for (const [jobs, message] of [
    [`  a:\n    <<: *defaults\n    if: ${guard}\n`, /line 5 is not a job property key the reader can follow/],
    [`  a:\n    "i\\x66": always()\n    if: ${guard}\n`, /line 5 is not a job property key/],
    [`  a:\n    ? if\n    : always()\n`, /line 5 is not a job property key/],
    [`  a:\n      runs-on: x\n    if: always()\n`, /line 6 is indented less than the job properties/],
    [`  a:\n    if: ${guard}\n    if: always()\n`, /job "a" has more than one if: key/],
    [`  a:\n    if: ${guard}\n    'if': always()\n`, /job "a" has more than one if: key/],
  ]) {
    assert.match(workflowGuardErrors("w.yml", workflow(jobs))[0] ?? "", message, jobs);
  }
  // GitHub reads an if: with a ${{ }} that does not wrap the whole value as an always-true string template.
  for (const condition of [
    `${guard} && (\${{ always() }})`,
    `${guard} && (github.ref == '\${{ github.ref }}')`,
    `\${{ ${guard} }} && (\${{ always() }})`,
    `${guard} && (contains(github.ref, '}}'))`,
  ]) {
    assert.equal(hasRepositoryGuard(condition), false, condition);
    assert.match(workflowGuardErrors("w.yml", workflow(`  a:\n    if: ${condition}\n`))[0] ?? "", /always-true string/, condition);
    assert.match(workflowGuardErrors(shared, workflow(`  a:\n    if: ${condition}\n    uses: ./.github/workflows/ci.yml\n`))[0] ?? "", /always-true string/, condition);
  }
  const reusableOn = `on:\n  workflow_call:\n    inputs:\n      ${REUSABLE_CALL_INPUT}:\n        type: boolean\n        default: true\n`;
  const templated = `${REPOSITORY_GUARD} || inputs.${REUSABLE_CALL_INPUT} == \${{ true }}`;
  assert.match(workflowGuardErrors("w.yml", `${reusableOn}jobs:\n  a:\n    if: ${templated}\n`)[0] ?? "", /always-true string/);
});

test("every caller of a guarded workflow carries the guard; a shared workflow's unguarded job may call only a shared workflow by its local path", (t) => {
  const guard = REPOSITORY_GUARD;
  const caller = (condition, uses = "./.github/workflows/apifn-api-check.yml") =>
    `name: Caller\non: push\njobs:\n  call:\n${condition ? `    if: ${condition}\n` : ""}    uses: ${uses}\n`;
  const called = `name: Called\non:\n  workflow_call:\n    inputs:\n      ${REUSABLE_CALL_INPUT}:\n        type: boolean\n        default: true\njobs:\n  api-check:\n    if: ${REUSABLE_WORKFLOW_GUARD}\n    runs-on: x\n`;
  const root = fixture(t, {
    files: {
      ".github/workflows/apifn-api-check.yml": called,
      ".github/workflows/apifn-api-check-smoke.yml": caller(null),
      ".github/workflows/publish-tag.yml": caller(null),
      ".github/workflows/publish-python.yml": `${caller(null, "./.github/workflows/publish-tag.yml")}  build:\n    runs-on: x\n`,
    },
  });
  assert.deepEqual(
    verifyOwners({ root, repo: "public" }).filter((message) => message.includes(".github/workflows")),
    [
      `.github/workflows/apifn-api-check-smoke.yml: job "call" has no if:; jobs outside the shared list must start their if: with ${guard}`,
      `.github/workflows/publish-tag.yml: job "call" has uses: "./.github/workflows/apifn-api-check.yml" and has no if:; a shared workflow's job with uses: must start its if: with ${guard} unless it calls a shared workflow by its ./.github/workflows/<file> path`,
    ],
  );
  const shared = ".github/workflows/publish-tag.yml";
  assert.deepEqual(workflowGuardErrors(shared, caller(guard)), []);
  assert.deepEqual(workflowGuardErrors(shared, caller(`${guard} && (always())`)), []);
  assert.deepEqual(workflowGuardErrors(shared, caller(null, "./.github/workflows/publish-python.yml")), []);
  assert.deepEqual(workflowGuardErrors(".github/workflows/publish-python.yml", caller(null, "./.github/workflows/publish-tag.yml")), []);
  // Any other job-level uses: is not exempt: this repository under its current name, its redirect alias, its next fork
  // (whose copy runs through the call-only input), any letter case, an arbitrary owner/repo, a non-canonical or
  // non-shared local path, a remote shared workflow and an expression all need the guard.
  for (const uses of [
    "21nCo/super-functions.next/.github/workflows/apifn-api-check.yml@dev",
    "21nCo/super-functions/.github/workflows/apifn-api-check.yml@dev",
    "21NCO/SuperFunctions/.github/workflows/apifn-api-check.yml@dev",
    "21nCo/superfunctions/.github/workflows/publish-python.yml@dev",
    "octo/repo/.github/workflows/x.yml@v1",
    "21nCo/superfunctions-tools/.github/workflows/x.yml@v1",
    "./.github/workflows/../workflows/publish-python.yml",
    "./.github/workflows/ci.yml",
    "./ci/check.yml",
    "${{ inputs.workflow }}",
  ]) {
    assert.match(workflowGuardErrors(shared, caller(null, uses))[0] ?? "", /a shared workflow's job with uses: must start its if:/, uses);
    assert.deepEqual(workflowGuardErrors(shared, caller(guard, uses)), [], uses);
    assert.deepEqual(workflowGuardErrors(shared, caller(`${guard} && (always())`, uses)), [], uses);
  }
});

test("the checked-out repository matches its manifest", () => {
  // OWNERS_REPO is set by CI on both repositories; locally the presence of the next manifest decides.
  assert.deepEqual(verifyOwners({ repo: repoFromEnv() }), []);
});
