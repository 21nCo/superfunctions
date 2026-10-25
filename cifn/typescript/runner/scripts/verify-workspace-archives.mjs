/** Owned filesystem acceptance using actual built public archive step entry points. No external provider calls. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeArtifactUpload,
  executeArtifactDownload,
  executeCacheSave,
  executeCacheRestore,
} from "../dist/index.mjs";
const root = mkdtempSync(join(tmpdir(), "cifn-built-archives-"));
const workspace = join(root, "source"),
  destination = join(root, "destination");
mkdirSync(workspace);
mkdirSync(destination);
const stored = new Map();
let uploads = 0;
const client = {
  upload: async (namespace, key, data) => {
    uploads++;
    stored.set(JSON.stringify([namespace, key]), Buffer.from(data));
    return "owned-file-id";
  },
  downloadByKey: async (namespace, key) =>
    stored.get(JSON.stringify([namespace, key])) ?? null,
};
const archive = (manifest, body = "payload") => {
  const bytes = Buffer.from(JSON.stringify(manifest)),
    header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes, Buffer.from(body)]);
};
try {
  mkdirSync(join(workspace, "dist"));
  writeFileSync(join(workspace, "dist", "one.txt"), "hello");
  writeFileSync(join(workspace, "two.txt"), "world");
  writeFileSync(join(root, "outside"), "private");
  assert.equal(
    (
      await executeArtifactUpload({
        name: "artifact",
        path: "dist",
        workspace,
        runId: "owned-run",
        fileFnClient: client,
      })
    ).success,
    true,
  );
  assert.equal(
    (
      await executeArtifactDownload({
        name: "artifact",
        workspace: destination,
        runId: "owned-run",
        fileFnClient: client,
      })
    ).success,
    true,
  );
  assert.equal(readFileSync(join(destination, "one.txt"), "utf8"), "hello");
  assert.equal(
    (
      await executeCacheSave({
        key: "cache",
        paths: ["dist", "two.txt"],
        workspace,
        fileFnClient: client,
      })
    ).success,
    true,
  );
  assert.equal(
    (
      await executeCacheRestore({
        key: "cache",
        workspace: destination,
        fileFnClient: client,
      })
    ).success,
    true,
  );
  assert.equal(
    readFileSync(join(destination, "dist", "one.txt"), "utf8"),
    "hello",
  );
  assert.equal(readFileSync(join(destination, "two.txt"), "utf8"), "world");
  symlinkSync(join(root, "outside"), join(workspace, "link"));
  linkSync(join(root, "outside"), join(workspace, "hard"));
  for (const path of ["../outside", "link", "hard"]) {
    const count = uploads;
    assert.equal(
      (
        await executeArtifactUpload({
          name: "bad",
          path,
          workspace,
          runId: "owned-run",
          fileFnClient: client,
        })
      ).success,
      false,
    );
    assert.equal(
      (
        await executeCacheSave({
          key: "bad",
          paths: [path],
          workspace,
          fileFnClient: client,
        })
      ).success,
      false,
    );
    assert.equal(uploads, count);
  }
  for (const bad of ["../outside", "link", "dangling"]) {
    if (bad === "link")
      symlinkSync(join(root, "outside"), join(destination, bad));
    if (bad === "dangling")
      symlinkSync(join(root, "never"), join(destination, bad));
    const data = archive([
      { relativePath: "not-written", offset: 0, size: 3 },
      { relativePath: bad, offset: 3, size: 4 },
    ]);
    const fileFnClient = { downloadByKey: async () => data };
    assert.equal(
      (
        await executeArtifactDownload({
          name: "bad",
          workspace: destination,
          runId: "owned-run",
          fileFnClient,
        })
      ).success,
      false,
    );
    assert.equal(
      (
        await executeCacheRestore({
          key: "bad",
          workspace: destination,
          fileFnClient,
        })
      ).success,
      false,
    );
    assert.equal(existsSync(join(destination, "not-written")), false);
    assert.equal(readFileSync(join(root, "outside"), "utf8"), "private");
    assert.equal(existsSync(join(root, "never")), false);
  }
  const count = uploads;
  assert.equal(
    (
      await executeCacheSave({
        key: "bounded",
        paths: ["dist"],
        workspace,
        fileFnClient: client,
        archiveLimits: { maxBytes: 4 },
      })
    ).success,
    false,
  );
  assert.equal(uploads, count);
  console.log(
    JSON.stringify({
      passed: true,
      builtPublicArchives: true,
      artifactAndCacheRoundTrip: true,
      escapeAndLinkSentinelsIntact: true,
      allManifestValidationBeforeWrites: true,
      configuredBounds: true,
      externalFileFn: false,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
}
