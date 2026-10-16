import { describe, expect, it } from "vitest";
import { validateArtifact, type ContentfnExportArtifact } from "../importExport/format.js";
import { schemaHash } from "../hash/schemaHash.js";
const now = "2026-10-16T00:00:00.000Z";
function fixture(): ContentfnExportArtifact {
  const schemaJson = { version: 1, documentTypes: [{ name: "post", fields: [
    { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
  ] }] };
  const published = { _id: "post", _type: "post", _rev: "rev", _createdAt: now, _updatedAt: now, _publishedAt: now, title: "Hello" };
  return { formatVersion: 1, dataset: "prod", exportedAt: now,
    schema: { version: 1, schemaHash: schemaHash(schemaJson), schemaJson },
    publishedDocs: [published], draftDocs: [{ ...published, _id: "drafts.post", _rev: "draft-rev" }],
    revisions: [{ docId: "post", perspective: "published", rev: "rev", timestamp: now, docJson: { ...published } }],
    assets: [{ assetId: "asset", contentType: "text/plain", filename: "file.txt", size: 3, width: null, height: null, url: "memory://asset", createdAt: now }],
  };
}
describe("import artifact validation", () => {
  it("accepts export-shaped documents, drafts, revisions and asset metadata without mutation", () => {
    const artifact = fixture(), before = JSON.stringify(artifact);
    expect(validateArtifact(artifact)).toBe(true);
    expect(JSON.stringify(artifact)).toBe(before);
  });
  it.each([
    (a: ContentfnExportArtifact) => { a.formatVersion = 2; },
    (a: ContentfnExportArtifact) => { a.exportedAt = "yesterday"; },
    (a: ContentfnExportArtifact) => { a.dataset = "../prod"; },
    (a: ContentfnExportArtifact) => { a.schema!.version = 2; },
    (a: ContentfnExportArtifact) => { a.schema!.schemaHash = "forged"; },
    (a: ContentfnExportArtifact) => { a.schema = null; },
    (a: ContentfnExportArtifact) => { a.publishedDocs.push(a.publishedDocs[0]); },
    (a: ContentfnExportArtifact) => { a.publishedDocs[0]._id = "drafts.wrong"; },
    (a: ContentfnExportArtifact) => { a.draftDocs[0]._id = "wrong"; },
    (a: ContentfnExportArtifact) => { a.publishedDocs[0]._createdAt = "2026-02-30T00:00:00Z"; },
    (a: ContentfnExportArtifact) => { a.publishedDocs[0]._type = ""; },
    (a: ContentfnExportArtifact) => { a.assets.push(a.assets[0]); },
    (a: ContentfnExportArtifact) => { a.assets[0].size = -1; },
    (a: ContentfnExportArtifact) => { a.assets[0].width = 1.5; },
    (a: ContentfnExportArtifact) => { a.revisions.push(a.revisions[0]); },
    (a: ContentfnExportArtifact) => { a.revisions[0].perspective = "raw"; },
    (a: ContentfnExportArtifact) => { a.revisions[0].rev = "other"; },
    (a: ContentfnExportArtifact) => { a.revisions[0].docId = "other"; },
    (a: ContentfnExportArtifact) => { a.revisions[0].docJson.title = () => "not JSON"; },
  ])("rejects malformed artifact %#", change => {
    const artifact = fixture(); change(artifact);
    expect(validateArtifact(artifact)).toBe(false);
  });
  it("preserves current documents and historical snapshots after schema evolution", () => {
    const artifact = fixture();
    // Earlier schemas allowed title to be absent; upsert never rewrote these snapshots.
    delete artifact.publishedDocs[0].title;
    delete artifact.draftDocs[0].title;
    delete artifact.revisions[0].docJson.title;
    expect(validateArtifact(artifact)).toBe(true);
  });
  it("allows an empty dataset without schema but rejects malformed schema containers", () => {
    expect(validateArtifact({ ...fixture(), schema: null, publishedDocs: [], draftDocs: [], revisions: [] })).toBe(true);
    for (const schema of [undefined, [], {}, { version: 1, schemaHash: "x", schemaJson: { version: 1, documentTypes: [{}] } }]) {
      expect(validateArtifact({ ...fixture(), schema })).toBe(false);
    }
  });
});
