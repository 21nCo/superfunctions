import { describe, expect, it } from "vitest";
import type { ContentfnSchema, ContentfnField } from "@contentfn/core";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { normalizeMarkdownFields, validateDocumentAgainstSchema } from "../storage/document-validation.js";
const string = { kind: "primitive", type: "string" } as const;
const makeSchema = (fields: ContentfnField[]): ContentfnSchema => ({ version: 1, documentTypes: [{ name: "post", fields }] });
function check(field: ContentfnField, value: unknown) {
  return validateDocumentAgainstSchema(makeSchema([field]), "post", { [field.name]: value });
}
describe("document schema validation", () => {
  it.each([null, undefined])("rejects required nullish values %s", value => {
    expect(check({ name: "title", type: string, required: true }, value).ok).toBe(false);
  });
  it("reports the nested required field path", () => {
    expect(check({ name: "details", type: { kind: "object", fields: [{ name: "title", type: string, required: true }] } }, {}))
      .toMatchObject({ ok: false, error: { details: { path: "details.title" } } });
  });
  it("enforces array unions, item types and maxLength", () => {
    const field: ContentfnField = { name: "items", type: { kind: "array", of: [string, { kind: "primitive", type: "number" }], maxLength: 2 } };
    expect(check(field, ["one", 2]).ok).toBe(true);
    for (const value of [[false], [null], [1, 2, 3]]) expect(check(field, value).ok).toBe(false);
  });
  it.each([
    [{ name: "x", type: string, validation: [{ rule: "min", value: 3 }] }, "ab"],
    [{ name: "x", type: string, validation: [{ rule: "max", value: 2 }] }, "abc"],
    [{ name: "x", type: string, validation: [{ rule: "regex", value: "^[a-z]+$" }] }, "123"],
    [{ name: "x", type: string, validation: [{ rule: "enum", value: ["yes"] }] }, "no"],
    [{ name: "x", type: { kind: "primitive", type: "number" }, validation: [{ rule: "min", value: 0 }] }, -1],
    [{ name: "x", type: { kind: "primitive", type: "number" }, validation: [{ rule: "max", value: 5 }] }, 6],
  ] as Array<[ContentfnField, unknown]>)("enforces declared rule %#", (field, value) => expect(check(field, value).ok).toBe(false));
  it("compares unique JSON array items independently of object key order", () => {
    const field: ContentfnField = { name: "items", type: { kind: "array", of: [{ kind: "primitive", type: "json" }] }, validation: [{ rule: "unique" }] };
    expect(check(field, [{ a: 1, b: 2 }, { b: 2, a: 1 }]).ok).toBe(false);
    expect(check(field, [{ a: 1 }, { a: 2 }]).ok).toBe(true);
  });
  it.each([["date", "2025-02-29"], ["datetime", "not a date"], ["datetime", "2026-02-30T12:00:00Z"]] as const)("rejects invalid %s %s", (type, value) => {
    expect(check({ name: "when", type: { kind: "primitive", type } }, value).ok).toBe(false);
  });
  it("rejects non-JSON values instead of losing them during persistence", () => {
    for (const value of [Infinity, NaN, 1n, () => 1, new Date()]) expect(check({ name: "data", type: { kind: "primitive", type: "json" } }, value).ok).toBe(false);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(check({ name: "data", type: { kind: "primitive", type: "json" } }, circular).ok).toBe(false);
  });
  it("checks canonical references, weak policy, and asset type", () => {
    const reference: ContentfnField = { name: "author", type: { kind: "reference", to: ["post"] } };
    for (const value of [{ _type: "reference", _ref: "" }, { _type: "reference", _ref: "id", _weak: "yes" }, { _type: "reference", _ref: "id", _weak: true }]) expect(check(reference, value).ok).toBe(false);
    expect(check({ name: "asset", type: { kind: "asset", assetType: "image" } }, { _type: "asset", _ref: "id", assetType: "file" }).ok).toBe(false);
  });
  it("validates portable blocks and mark allow lists", () => {
    const field: ContentfnField = { name: "body", type: { kind: "richtext", allowMarks: ["strong"] } };
    const block = { _type: "block", _key: "b", children: [{ _type: "span", _key: "s", text: "hello", marks: ["strong"] }] };
    expect(check(field, [block]).ok).toBe(true);
    expect(check(field, [block, block]).ok).toBe(false);
    const annotation: ContentfnField = { name: "body", type: { kind: "richtext", allowMarks: ["link"] } };
    expect(check(annotation, [{ ...block, markDefs: [{ _key: "link-1", _type: "link", href: "https://example.test" }], children: [{ ...block.children[0], marks: ["link-1"] }] }]).ok).toBe(true);
    expect(check(field, [{ ...block, markDefs: [null] }]).ok).toBe(false);
    expect(check(field, [{ ...block, children: [{ ...block.children[0], marks: ["script"] }] }]).ok).toBe(false);
  });
  it("normalizes nested and array Markdown without mutating caller values", () => {
    const schema = makeSchema([{ name: "sections", type: { kind: "array", of: [{ kind: "object", fields: [{ name: "body", type: { kind: "markdown" }, required: true }] }] } }]);
    const input = { sections: [{ body: "# Hello" }] };
    const normalized = normalizeMarkdownFields(schema, "post", input);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(validateDocumentAgainstSchema(schema, "post", normalized.value).ok).toBe(true);
    expect(input.sections[0].body).toBe("# Hello");
    expect(normalized.value.sections).not.toEqual(input.sections);
  });
  it("does not enforce evolved array field rules during read normalization", () => {
    const schema = makeSchema([{ name: "items", type: { kind: "array", of: [{ kind: "object", fields: [{ name: "title", type: string, required: true }] }] } }]);
    const oldSnapshot = { items: [{}] };
    expect(normalizeMarkdownFields(schema, "post", oldSnapshot)).toEqual({ ok: true, value: oldSnapshot });
    expect(validateDocumentAgainstSchema(schema, "post", oldSnapshot).ok).toBe(false);
  });
  it("protects generated identity and rejects invalid patches without changing the revision", async () => {
    const { api } = createContentfnServer({ db: memoryAdapter() });
    await api.datasets.create({ dataset: "prod" });
    await api.schema.upsert({ dataset: "prod", schema: makeSchema([{ name: "title", type: string, required: true }]) });
    const created = await api.docs.create({ dataset: "prod", id: "owned", type: "post", asDraft: true,
      doc: { title: "valid", _id: "spoof", _type: "spoof", _rev: "spoof", _createdAt: "spoof", _updatedAt: "spoof", _publishedAt: "spoof" } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.result).toMatchObject({ _id: "drafts.owned", _type: "post" });
    for (const key of ["_rev", "_createdAt", "_updatedAt"]) expect(created.result[key]).not.toBe("spoof");
    expect(created.result._publishedAt).toBeUndefined();
    expect(await api.docs.patch({ dataset: "prod", id: "drafts.owned", ifRev: created.result._rev, ops: [{ op: "set", path: "title", value: null }] }))
      .toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const stored = await api.docs.get({ dataset: "prod", id: created.result._id, perspective: "draft" });
    expect(stored).toMatchObject({ ok: true, result: { _rev: created.result._rev, title: "valid" } });
  });
});

describe("reference target validation through document writes", () => {
  async function fixture() {
    const { api } = createContentfnServer({ db: memoryAdapter() });
    await api.datasets.create({ dataset: "prod" });
    const schema: ContentfnSchema = { version: 1, documentTypes: [
      { name: "post", fields: [
        { name: "authors", type: { kind: "array", of: [{ kind: "reference", to: ["author"] }] } },
        { name: "optionalAuthor", type: { kind: "reference", to: ["author"], weak: true } },
      ] }, { name: "author", fields: [] },
    ] };
    expect((await api.schema.upsert({ dataset: "prod", schema })).ok).toBe(true);
    await api.docs.create({ dataset: "prod", id: "author", type: "author", doc: {} });
    await api.docs.create({ dataset: "prod", id: "other-post", type: "post", doc: {} });
    return api;
  }
  it("rejects missing and wrong-type nested targets but accepts declared target types", async () => {
    const api = await fixture();
    for (const target of ["missing", "other-post"]) {
      expect(await api.docs.create({ dataset: "prod", id: `invalid-${target}`, type: "post", doc: { authors: [{ _type: "reference", _ref: target }] } }))
        .toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", details: { path: "authors[0]" } } });
    }
    expect((await api.docs.create({ dataset: "prod", id: "valid", type: "post", doc: { authors: [{ _type: "reference", _ref: "author" }] } })).ok).toBe(true);
  });
  it("permits missing weak targets only when declared weak and still enforces existing target types", async () => {
    const api = await fixture();
    expect((await api.docs.create({ dataset: "prod", id: "weak", type: "post", doc: { optionalAuthor: { _type: "reference", _ref: "missing", _weak: true } } })).ok).toBe(true);
    expect((await api.docs.create({ dataset: "prod", id: "wrong", type: "post", doc: { optionalAuthor: { _type: "reference", _ref: "other-post", _weak: true } } })).ok).toBe(false);
  });
  it("resolves draft targets in draft writes and prevents invalid reference patches", async () => {
    const api = await fixture();
    await api.docs.create({ dataset: "prod", id: "draft-author", type: "author", doc: {}, asDraft: true });
    const created = await api.docs.create({ dataset: "prod", id: "draft-post", type: "post", asDraft: true, doc: { authors: [{ _type: "reference", _ref: "draft-author" }] } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await api.docs.patch({ dataset: "prod", id: created.result._id, ifRev: created.result._rev, ops: [{ op: "set", path: "authors", value: [{ _type: "reference", _ref: "missing" }] }] }))
      .toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await api.docs.get({ dataset: "prod", id: created.result._id, perspective: "draft" }))
      .toMatchObject({ ok: true, result: { _rev: created.result._rev } });
  });
});
