import Ajv2020 from "ajv/dist/2020.js";
import { BreadcrumbCollector, evidenceEventSchema, validateEvidenceEvent } from "catchfn";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, promises as fsp, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVIDENCE_FAILURE_CODES } from "../src/index.js";
import { verifyEvidence } from "../src/node.js";
import { makeTree, optionsFor, permissionsApply, recordWith, removeTrees, sha256, summary, writeArtifact } from "./artifacts.js";
import { records } from "./fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeTrees();
});

const CATCHFN_FORMAT = "catchfn.evidence-event/v1";
const validateCatchfnEvent = new Ajv2020({ strict: true, allErrors: true }).compile(evidenceEventSchema);

/** Events from a catchfn collector's collect(), as the JSON text a producer writes, checked against catchfn's v1 schema. */
function catchfnEventsFile(): string {
  const collector = new BreadcrumbCollector(10);
  collector.addNavigation("/settings", "/settings/keys");
  collector.addUser("click", "save");
  const events = JSON.parse(JSON.stringify(collector.collect())) as unknown[];
  expect(events).toHaveLength(2);
  for (const event of events) {
    expect(validateCatchfnEvent(event), JSON.stringify(validateCatchfnEvent.errors)).toBe(true);
    expect(validateEvidenceEvent(event)).toEqual([]);
  }
  return `${JSON.stringify(events, null, 2)}\n`;
}

/** A tree with a plain report and a catchfn events file, and the passing record listing both. */
function passingTree() {
  const root = makeTree();
  const report = writeArtifact(root, "reports/unit.json", '{"passed":12}\n');
  const events = writeArtifact(root, "catchfn/events.json", catchfnEventsFile(), CATCHFN_FORMAT);
  return { root, report, events, record: recordWith([report, events]) };
}

const artifactPointer = (index: number, member: "path" | "sha256") => `/source/artifactHashes/${index}/${member}`;

describe("verifyEvidence: artifacts that match", () => {
  it("re-hashes a report and a catchfn evidence event v1 file and passes", async () => {
    const { root, events, record } = passingTree();
    const result = await verifyEvidence(record, optionsFor(root));
    expect(result).toEqual({ ok: true, failures: [] });
    // The record carries catchfn's file as opaque bytes: its format label and the hash of the bytes the collector produced.
    expect(record.source.artifactHashes[1]).toEqual({ path: "catchfn/events.json", sha256: sha256(readFileSync(path.join(root, "catchfn", "events.json"))), format: CATCHFN_FORMAT });
    expect(events.format).toBe(CATCHFN_FORMAT);
  });

  it("streams files larger than one read and hashes empty files", async () => {
    const root = makeTree();
    const large = Buffer.alloc(1024 * 1024 + 7);
    for (let index = 0; index < large.length; index += 1) large[index] = index % 251;
    const record = recordWith([writeArtifact(root, "large.bin", large), writeArtifact(root, "empty.txt", "")]);
    expect(await verifyEvidence(record, optionsFor(root))).toEqual({ ok: true, failures: [] });
    large[large.length - 1] = 0xff;
    writeFileSync(path.join(root, "large.bin"), large);
    expect(summary(await verifyEvidence(record, optionsFor(root)))).toEqual([{ code: "EVIDENCE_ARTIFACT_HASH_MISMATCH", path: artifactPointer(0, "sha256"), artifact: "large.bin" }]);
  });

  it("allows a symlinked artifactRoot with regular files below it", async () => {
    const { root, record } = passingTree();
    const link = path.join(makeTree(), "checkout");
    symlinkSync(root, link, "dir");
    expect(await verifyEvidence(record, optionsFor(link))).toEqual({ ok: true, failures: [] });
  });
});

describe("verifyEvidence: artifacts that fail", () => {
  it("reports one changed byte as a hash mismatch with both hashes", async () => {
    const { root, report, record } = passingTree();
    writeFileSync(path.join(root, "reports", "unit.json"), '{"passed":13}\n');
    const result = await verifyEvidence(record, optionsFor(root));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      {
        code: "EVIDENCE_ARTIFACT_HASH_MISMATCH",
        path: artifactPointer(0, "sha256"),
        detail: { artifact: "reports/unit.json", expected: report.sha256, actual: sha256('{"passed":13}\n') },
      },
    ]);
  });

  it("reports a removed file, a missing parent directory and a file named with a trailing slash as missing", async () => {
    const { root, record } = passingTree();
    rmSync(path.join(root, "reports", "unit.json"));
    rmSync(path.join(root, "catchfn"), { recursive: true });
    writeArtifact(root, "notes.txt", "note");
    const listed = recordWith([...record.source.artifactHashes, { path: "notes.txt/", sha256: sha256("note") }]);
    expect(summary(await verifyEvidence(listed, optionsFor(root)))).toEqual([
      { code: "EVIDENCE_ARTIFACT_MISSING", path: artifactPointer(0, "path"), artifact: "reports/unit.json" },
      { code: "EVIDENCE_ARTIFACT_MISSING", path: artifactPointer(1, "path"), artifact: "catchfn/events.json" },
      { code: "EVIDENCE_ARTIFACT_MISSING", path: artifactPointer(2, "path"), artifact: "notes.txt/" },
    ]);
  });

  it("reports a directory at the artifact path as not a regular file", async () => {
    const { root, record } = passingTree();
    rmSync(path.join(root, "reports", "unit.json"));
    mkdirSync(path.join(root, "reports", "unit.json"));
    expect(summary(await verifyEvidence(record, optionsFor(root)))).toEqual([
      { code: "EVIDENCE_ARTIFACT_NOT_REGULAR_FILE", path: artifactPointer(0, "path"), artifact: "reports/unit.json" },
    ]);
  });

  it.skipIf(process.platform === "win32")("reports a FIFO at the artifact path as not a regular file without blocking on it", async () => {
    const root = makeTree();
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    const record = recordWith([{ path: "pipe", sha256: sha256("") }]);
    expect(summary(await verifyEvidence(record, optionsFor(root)))).toEqual([{ code: "EVIDENCE_ARTIFACT_NOT_REGULAR_FILE", path: artifactPointer(0, "path"), artifact: "pipe" }]);
  });

  it("reports a symlinked file and a file under a symlinked directory, even when the targets are inside the root", async () => {
    const { root, report, events } = passingTree();
    symlinkSync(path.join(root, "reports", "unit.json"), path.join(root, "linked.json"), "file");
    symlinkSync(path.join(root, "reports"), path.join(root, "linked-reports"), "dir");
    const outside = makeTree();
    writeArtifact(outside, "unit.json", '{"passed":12}\n');
    symlinkSync(path.join(outside, "unit.json"), path.join(root, "outside.json"), "file");
    symlinkSync(path.join(root, "absent.json"), path.join(root, "dangling.json"), "file");
    const record = recordWith([
      { path: "linked.json", sha256: report.sha256 },
      { path: "linked-reports/unit.json", sha256: report.sha256 },
      { path: "outside.json", sha256: report.sha256 },
      { path: "dangling.json", sha256: report.sha256 },
      events,
    ]);
    const result = await verifyEvidence(record, optionsFor(root));
    expect(summary(result)).toEqual([
      { code: "EVIDENCE_ARTIFACT_SYMLINK", path: artifactPointer(0, "path"), artifact: "linked.json" },
      { code: "EVIDENCE_ARTIFACT_SYMLINK", path: artifactPointer(1, "path"), artifact: "linked-reports/unit.json" },
      { code: "EVIDENCE_ARTIFACT_SYMLINK", path: artifactPointer(2, "path"), artifact: "outside.json" },
      { code: "EVIDENCE_ARTIFACT_SYMLINK", path: artifactPointer(3, "path"), artifact: "dangling.json" },
    ]);
    expect(result.failures[1]?.detail).toEqual({ artifact: "linked-reports/unit.json", symlink: "linked-reports" });
  });

  it("reports an artifact whose real path resolves outside the root", async () => {
    const { root, record } = passingTree();
    const realRoot = realpathSync(root);
    const elsewhere = realpathSync(makeTree());
    // Nothing on a POSIX tree reaches outside without a symlink, so stand in for a
    // mount or bind that does: the artifact's real path is under another directory.
    const realpath = fsp.realpath.bind(fsp);
    vi.spyOn(fsp, "realpath").mockImplementation(async (target, ...rest) =>
      target === path.join(realRoot, "reports", "unit.json") ? path.join(elsewhere, "unit.json") : realpath(target, ...rest),
    );
    expect(summary(await verifyEvidence(record, optionsFor(root)))).toEqual([{ code: "EVIDENCE_ARTIFACT_OUTSIDE_ROOT", path: artifactPointer(0, "path"), artifact: "reports/unit.json" }]);
  });

  it.skipIf(!permissionsApply)("reports a file without read permission and a directory without search permission as unreadable", async () => {
    const { root, record } = passingTree();
    const file = path.join(root, "reports", "unit.json");
    const directory = path.join(root, "catchfn");
    chmodSync(file, 0o000);
    chmodSync(directory, 0o600);
    try {
      const result = await verifyEvidence(record, optionsFor(root));
      expect(summary(result)).toEqual([
        { code: "EVIDENCE_ARTIFACT_UNREADABLE", path: artifactPointer(0, "path"), artifact: "reports/unit.json" },
        { code: "EVIDENCE_ARTIFACT_UNREADABLE", path: artifactPointer(1, "path"), artifact: "catchfn/events.json" },
      ]);
      expect(result.failures.map((failure) => failure.detail?.reason)).toEqual(["EACCES", "EACCES"]);
    } finally {
      chmodSync(file, 0o600);
      chmodSync(directory, 0o700);
    }
  });

  it("reports record failures and artifact failures together", async () => {
    const { root, report, record } = passingTree();
    writeFileSync(path.join(root, "reports", "unit.json"), "changed\n");
    const otherCommit = recordWith(record.source.artifactHashes, { source: { ...record.source, commit: "2".repeat(40) } });
    const result = await verifyEvidence(otherCommit, optionsFor(root));
    expect(result.failures).toEqual([
      { code: "EVIDENCE_COMMIT_MISMATCH", path: "/source/commit", detail: { expectedCommit: "1".repeat(40) } },
      { code: "EVIDENCE_ARTIFACT_HASH_MISMATCH", path: artifactPointer(0, "sha256"), detail: { artifact: "reports/unit.json", expected: report.sha256, actual: sha256("changed\n") } },
    ]);
  });

  it("checks the artifact list as validated, even when the caller changes the record while verification runs", async () => {
    const { root, record } = passingTree();
    rmSync(path.join(root, "reports", "unit.json"));
    const pending = verifyEvidence(record, optionsFor(root));
    record.source.artifactHashes[0]!.path = "catchfn/events.json";
    record.source.artifactHashes.length = 0;
    expect(summary(await pending)).toEqual([{ code: "EVIDENCE_ARTIFACT_MISSING", path: artifactPointer(0, "path"), artifact: "reports/unit.json" }]);
  });

  it("produces each artifact code from the closed set", () => {
    const artifactCodes = EVIDENCE_FAILURE_CODES.filter((code) => code.startsWith("EVIDENCE_ARTIFACT_"));
    // Each is returned alone by one of the tests above.
    expect(artifactCodes).toEqual([
      "EVIDENCE_ARTIFACT_MISSING",
      "EVIDENCE_ARTIFACT_NOT_REGULAR_FILE",
      "EVIDENCE_ARTIFACT_SYMLINK",
      "EVIDENCE_ARTIFACT_OUTSIDE_ROOT",
      "EVIDENCE_ARTIFACT_UNREADABLE",
      "EVIDENCE_ARTIFACT_HASH_MISMATCH",
    ]);
  });
});

describe("verifyEvidence: what it reads", () => {
  function spyOnFilesystem() {
    return {
      open: vi.spyOn(fsp, "open"),
      lstat: vi.spyOn(fsp, "lstat"),
      readFile: vi.spyOn(fsp, "readFile"),
      realpath: vi.spyOn(fsp, "realpath"),
      stat: vi.spyOn(fsp, "stat"),
    };
  }

  it.each([
    ["a missing record", undefined, "EVIDENCE_MISSING"],
    ["a record without its source", { ...(records.minimal as object), source: undefined }, "EVIDENCE_MISSING_FIELD"],
    ["a record with a malformed artifact path", recordWith([{ path: "../escape.json", sha256: sha256("") }]), "EVIDENCE_MALFORMED"],
  ])("reads no artifact for %s", async (_name, record, code) => {
    const { root } = passingTree();
    const calls = spyOnFilesystem();
    const result = await verifyEvidence(record, optionsFor(root));
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(code);
    expect(result.failures.every((failure) => !failure.code.startsWith("EVIDENCE_ARTIFACT_"))).toBe(true);
    expect(calls.open).not.toHaveBeenCalled();
    expect(calls.lstat).not.toHaveBeenCalled();
    expect(calls.readFile).not.toHaveBeenCalled();
    // Only the root itself is resolved, to check the option.
    expect(calls.realpath.mock.calls.map(([target]) => target)).toEqual([root]);
    expect(calls.stat.mock.calls.map(([target]) => target)).toEqual([realpathSync(root)]);
  });

  it("reads no artifact for a malformed record that also lists a changed artifact", async () => {
    const { root, record } = passingTree();
    writeFileSync(path.join(root, "reports", "unit.json"), "changed\n");
    const calls = spyOnFilesystem();
    const result = await verifyEvidence({ ...record, recordId: "" }, optionsFor(root));
    expect(summary(result)).toEqual([{ code: "EVIDENCE_MALFORMED", path: "/recordId" }]);
    expect(calls.open).not.toHaveBeenCalled();
  });
});

describe("verifyEvidence: artifactRoot", () => {
  it.each([
    ["a relative path", () => "reports"],
    ["a missing directory", () => path.join(makeTree(), "absent")],
    ["not a string", () => 42 as unknown as string],
    ["an empty string", () => ""],
  ])("rejects %s as EVIDENCE_OPTIONS_INVALID", async (_name, artifactRoot) => {
    const { record } = passingTree();
    const result = await verifyEvidence(record, optionsFor(artifactRoot()));
    expect(result).toEqual({ ok: false, failures: [{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: ["artifactRoot"] } }] });
  });

  it("rejects a regular file as the root", async () => {
    const tree = makeTree();
    writeArtifact(tree, "file.txt", "x");
    const result = await verifyEvidence(passingTree().record, optionsFor(path.join(tree, "file.txt")));
    expect(result.failures).toEqual([{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: ["artifactRoot"] } }]);
  });

  it("names artifactRoot with the other invalid options and returns no record failures", async () => {
    const result = await verifyEvidence({ ...(records.minimal as object), status: "failed" }, { ...optionsFor("relative"), expectedCommit: "nope" });
    expect(result.failures).toEqual([{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: ["expectedCommit", "artifactRoot"] } }]);
  });

  it("returns only EVIDENCE_OPTIONS_INVALID for a malformed record and a missing root", async () => {
    const result = await verifyEvidence({ recordId: "" }, optionsFor(path.join(makeTree(), "absent")));
    expect(result.failures).toEqual([{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: ["artifactRoot"] } }]);
  });

  it("rejects options that are not an object", async () => {
    const result = await verifyEvidence(records.minimal, null as never);
    expect(result.failures).toEqual([{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: ["options"] } }]);
  });
});
