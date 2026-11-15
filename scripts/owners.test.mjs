import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  NEXT_MANIFEST,
  OwnersError,
  PUBLIC_MANIFEST,
  createOwners,
  loadOwners,
  ownerOfPath,
  ownerOfRelease,
  parseManifest,
  readManifest,
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
