import { test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeArtifactUpload } from "./steps/artifact-upload.js";
import { executeArtifactDownload } from "./steps/artifact-download.js";
import { executeCacheSave } from "./steps/cache-save.js";
import { executeCacheRestore } from "./steps/cache-restore.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cifn-archive-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(root, "outside"), "private");
  return { root, workspace };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function archive(entries: unknown[], body = "payload") {
  const manifest = Buffer.from(JSON.stringify(entries)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(manifest.length);
  return Buffer.concat([header, manifest, Buffer.from(body)]);
}
async function restore(
  kind: "artifact" | "cache",
  workspace: string,
  data: Buffer,
) {
  const fileFnClient = { downloadByKey: async () => data };
  return kind === "artifact"
    ? executeArtifactDownload({
        name: "owned",
        workspace,
        runId: "run",
        fileFnClient,
      })
    : executeCacheRestore({ key: "owned", workspace, fileFnClient });
}
test("artifact and cache restore reject traversal before modifying any file", async () => {
  for (const kind of ["artifact", "cache"] as const) {
    const { root, workspace } = fixture();
    const data = archive([
      { relativePath: "valid", offset: 0, size: 7 },
      { relativePath: "../outside", offset: 0, size: 7 },
    ]);
    expect((await restore(kind, workspace, data)).success).toBe(false);
    expect(readFileSync(join(root, "outside"), "utf8")).toBe("private");
    expect(existsSync(join(workspace, "valid"))).toBe(false);
  }
});
test("all save paths reject traversal and preexisting symlink sources without uploading", async () => {
  for (const path of ["../outside", "link"]) {
    const { workspace, root } = fixture();
    symlinkSync(join(root, "outside"), join(workspace, "link"));
    let uploads = 0;
    const fileFnClient = {
      upload: async () => {
        uploads++;
        return "id";
      },
    };
    expect(
      (
        await executeArtifactUpload({
          name: "owned",
          path,
          workspace,
          runId: "r",
          fileFnClient,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await executeCacheSave({
          key: "owned",
          paths: [path],
          workspace,
          fileFnClient,
        })
      ).success,
    ).toBe(false);
    expect(uploads).toBe(0);
  }
});
test("restore rejects preexisting symlink destinations without changing their targets", async () => {
  for (const kind of ["artifact", "cache"] as const) {
    const { root, workspace } = fixture();
    symlinkSync(join(root, "outside"), join(workspace, "link"));
    expect(
      (
        await restore(
          kind,
          workspace,
          archive([{ relativePath: "link", offset: 0, size: 7 }]),
        )
      ).success,
    ).toBe(false);
    expect(readFileSync(join(root, "outside"), "utf8")).toBe("private");
  }
});

test("validates every manifest before writes: paths, duplicate aliases, shapes and byte ranges", async () => {
  const invalid = [
    [{ relativePath: "/absolute", offset: 0, size: 7 }],
    [{ relativePath: "C:/drive", offset: 0, size: 7 }],
    [{ relativePath: "dir\\file", offset: 0, size: 7 }],
    [{ relativePath: "a/./file", offset: 0, size: 7 }],
    [{ relativePath: "", offset: 0, size: 7 }],
    [{ relativePath: "nul\0", offset: 0, size: 7 }],
    [{ relativePath: "ok", offset: -1, size: 7 }],
    [{ relativePath: "ok", offset: 0, size: 8 }],
    [{ relativePath: "ok", offset: 0, size: 1.5 }],
    [{ relativePath: "ok", offset: Number.MAX_SAFE_INTEGER + 1, size: 7 }],
    [null],
    [{ relativePath: "ok", offset: 0, size: 0 }],
    [
      { relativePath: "a", offset: 0, size: 3 },
      { relativePath: "A", offset: 3, size: 4 },
    ],
    [
      { relativePath: "a", offset: 0, size: 3 },
      { relativePath: "a/b", offset: 3, size: 4 },
    ],
    [
      { relativePath: "a", offset: 0, size: 3 },
      { relativePath: "b", offset: 0, size: 4 },
    ],
  ];
  for (const kind of ["artifact", "cache"] as const)
    for (const entries of invalid) {
      const { workspace, root } = fixture();
      const result = await restore(kind, workspace, archive(entries));
      expect(result.success, JSON.stringify(entries)).toBe(false);
      expect(existsSync(join(workspace, "ok"))).toBe(false);
      expect(readFileSync(join(root, "outside"), "utf8")).toBe("private");
    }
});
test("rejects hardlinked files and symlink parents in both directions", async () => {
  for (const kind of ["artifact", "cache"] as const) {
    const { root, workspace } = fixture();
    mkdirSync(join(root, "outside-dir"));
    writeFileSync(join(root, "outside-dir", "file"), "private");
    symlinkSync(join(root, "outside-dir"), join(workspace, "parent"));
    linkSync(join(root, "outside"), join(workspace, "hard"));
    for (const path of ["parent/file", "hard"]) {
      let uploads = 0;
      const fileFnClient = {
        upload: async () => {
          uploads++;
          return "id";
        },
      };
      const result =
        kind === "artifact"
          ? await executeArtifactUpload({
              name: "x",
              path,
              workspace,
              runId: "r",
              fileFnClient,
            })
          : await executeCacheSave({
              key: "x",
              paths: [path],
              workspace,
              fileFnClient,
            });
      expect(result.success).toBe(false);
      expect(uploads).toBe(0);
      expect(
        (
          await restore(
            kind,
            workspace,
            archive([{ relativePath: path, offset: 0, size: 7 }]),
          )
        ).success,
      ).toBe(false);
    }
    expect(readFileSync(join(root, "outside"), "utf8")).toBe("private");
    expect(readFileSync(join(root, "outside-dir", "file"), "utf8")).toBe(
      "private",
    );
  }
});
test("enforces explicit archive bytes, manifest, entry and depth limits before writes or upload", async () => {
  for (const archiveLimits of [
    { maxBytes: 5 },
    { maxManifestBytes: 2 },
    { maxEntries: 1 },
    { maxDepth: 1 },
  ]) {
    const { workspace } = fixture();
    mkdirSync(join(workspace, "a"));
    writeFileSync(join(workspace, "a", "one"), "hello");
    writeFileSync(join(workspace, "two"), "world");
    let uploads = 0;
    const fileFnClient = {
      upload: async () => {
        uploads++;
        return "id";
      },
    };
    expect(
      (
        await executeArtifactUpload({
          name: "x",
          path: ".",
          workspace,
          runId: "r",
          fileFnClient,
          archiveLimits,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await executeCacheSave({
          key: "x",
          paths: ["."],
          workspace,
          fileFnClient,
          archiveLimits,
        })
      ).success,
    ).toBe(false);
    expect(uploads).toBe(0);
    const other = fixture(),
      data = archive(
        [
          { relativePath: "a/one", offset: 0, size: 5 },
          { relativePath: "two", offset: 5, size: 5 },
        ],
        "helloworld",
      );
    const downloadByKey = async () => data;
    expect(
      (
        await executeArtifactDownload({
          name: "x",
          workspace: other.workspace,
          runId: "r",
          fileFnClient: { downloadByKey },
          archiveLimits,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await executeCacheRestore({
          key: "x",
          workspace: other.workspace,
          fileFnClient: { downloadByKey },
          archiveLimits,
        })
      ).success,
    ).toBe(false);
    expect(existsSync(join(other.workspace, "a"))).toBe(false);
  }
});
test("malformed configuration and truncated headers fail closed with sanitized errors", async () => {
  const { workspace } = fixture();
  writeFileSync(join(workspace, "file"), "hello");
  for (const archiveLimits of [
    { maxBytes: NaN },
    { maxEntries: 0 },
    { maxDepth: 1.5 },
  ])
    expect(
      (
        await executeCacheSave({
          key: "x",
          paths: ["file"],
          workspace,
          fileFnClient: {
            upload: async () => {
              throw Error("must not call");
            },
          },
          archiveLimits,
        })
      ).success,
    ).toBe(false);
  for (const data of [
    Buffer.alloc(0),
    Buffer.alloc(3),
    Buffer.from([255, 255, 255, 255]),
    Buffer.from([0, 0, 0, 1, 255]),
  ])
    expect((await restore("artifact", workspace, data)).success).toBe(false);
  const result = await executeArtifactDownload({
    name: "x",
    workspace,
    runId: "r",
    fileFnClient: {
      downloadByKey: async () => {
        throw Error("provider-secret");
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain("provider-secret");
});
test("dangling destination symlink and a later existing directory reject before any write", async () => {
  for (const kind of ["artifact", "cache"] as const)
    for (const mode of ["dangling", "directory"]) {
      const { root, workspace } = fixture();
      if (mode === "dangling")
        symlinkSync(join(root, "absent"), join(workspace, "bad"));
      else mkdirSync(join(workspace, "bad"));
      const result = await restore(
        kind,
        workspace,
        archive([
          { relativePath: "first", offset: 0, size: 3 },
          { relativePath: "bad", offset: 3, size: 4 },
        ]),
      );
      expect(result.success).toBe(false);
      expect(existsSync(join(workspace, "first"))).toBe(false);
      expect(existsSync(join(root, "absent"))).toBe(false);
    }
});
test("entry budget includes distinct parent directories before extraction", async () => {
  const { workspace } = fixture();
  const data = archive([{ relativePath: "a/b/c", offset: 0, size: 7 }]);
  const result = await executeArtifactDownload({
    name: "x",
    runId: "r",
    workspace,
    fileFnClient: { downloadByKey: async () => data },
    archiveLimits: { maxEntries: 2 },
  });
  expect(result.success).toBe(false);
  expect(existsSync(join(workspace, "a"))).toBe(false);
});
