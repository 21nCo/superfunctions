import { validateAndDereferenceOpenAPI, validateOpenAPI } from "../src/index.js";

function documentWithReference(ref: string) {
  return {
    openapi: "3.1.0" as const,
    info: { title: "Example API", version: "1.0.0" },
    paths: {},
    components: { schemas: { Shared: { type: "string" }, Value: { $ref: ref } } },
  };
}

describe("validateOpenAPI", () => {
  it("TV-OPENAPI-012: valid document returns empty errors", async () => {
    const doc = {
      openapi: "3.1.0" as const,
      info: { title: "Valid API", version: "1.0.0" },
      paths: {
        "/health": {
          get: {
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    };

    await expect(validateOpenAPI(doc)).resolves.toEqual([]);
  });

  it("TV-OPENAPI-012: invalid document returns errors with path/message", async () => {
    const invalidDoc = {
      openapi: "3.1.0" as const,
      info: { version: "1.0.0" },
      paths: {},
    } as unknown as Parameters<typeof validateOpenAPI>[0];

    const errors = await validateOpenAPI(invalidDoc);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.path).toBeTruthy();
    expect(errors[0]?.message).toBeTruthy();
    expect(errors[0]?.severity).toBe("error");
  });

  it.each(["file:///example-schema.json", "https://example.invalid/schema.json"])(
    "refuses an external reference to %s by default",
    async (ref) => {
      const doc = documentWithReference(ref);
      const snapshot = structuredClone(doc);
      await expect(validateOpenAPI(doc)).resolves.toEqual([
        { path: "openapi", message: expect.stringContaining("explicit allowlist"), severity: "error" },
      ]);
      expect(doc).toEqual(snapshot);
    }
  );

  it.each(["#/components/schemas/Shared", "#%2Fcomponents%2Fschemas%2FShared"])(
    "resolves the local pointer %s without changing the caller's document",
    async (ref) => {
      const doc = documentWithReference(ref);
      const snapshot = structuredClone(doc);
      const result = await validateAndDereferenceOpenAPI(doc);
      expect(result.errors).toEqual([]);
      expect(result.document?.components?.schemas?.Value).toEqual({ type: "string" });
      expect(doc).toEqual(snapshot);
    }
  );

  it("accepts literal fragment-shaped example data with or without an allowlist", async () => {
    const doc = documentWithReference("#/components/schemas/Shared");
    Object.assign(doc.components.schemas.Shared, {
      type: "object",
      examples: [{ $ref: "#example-tag" }],
    });
    await expect(validateOpenAPI(doc)).resolves.toEqual([]);
    await expect(validateOpenAPI(doc, {
      externalReferences: new Map([["https://example.invalid/unused.json", "{}"]]),
    })).resolves.toEqual([]);
  });

  it("refuses a named reference fragment regardless of unrelated allowlist entries", async () => {
    const doc = documentWithReference("#missing");
    const options = { externalReferences: new Map([["https://example.invalid/unused.json", "{}"]]) };
    for (const validationOptions of [undefined, options]) {
      await expect(validateOpenAPI(doc, validationOptions)).resolves.toEqual([
        { path: "openapi", message: expect.stringContaining("JSON pointers"), severity: "error" },
      ]);
    }
  });

  it("uses preloaded allowlist entries and rejects unlisted transitive references", async () => {
    const ref = "https://example.invalid/preloaded.json";
    const doc = documentWithReference(ref);
    const externalReferences = new Map([[ref, '{"type":"integer"}']]);
    const result = await validateAndDereferenceOpenAPI(doc, { externalReferences });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    expect(doc.components.schemas.Value).toEqual({ $ref: ref });

    externalReferences.set(ref, '{"$ref":"#missing"}');
    await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
      { path: "openapi", message: expect.stringContaining("JSON pointers"), severity: "error" },
    ]);

    externalReferences.set(ref, '{"example":{"$ref":"#missing"}}');
    await expect(validateOpenAPI(documentWithReference(ref + "#/example"), { externalReferences })).resolves.toEqual([
      { path: "openapi", message: expect.stringContaining("JSON pointers"), severity: "error" },
    ]);

    externalReferences.set(ref, '{"$ref":"another-example.json"}');
    await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
      { path: "openapi", message: expect.stringContaining("explicit allowlist"), severity: "error" },
    ]);
  });

  it("resolves encoded pointers in preloaded schemas and preserves literal examples", async () => {
    const ref = "https://example.invalid/preloaded.json";
    const encoded = "#%2F$defs%2FShared";
    const contents = JSON.stringify({
      $defs: { Shared: { type: "string" } },
      $ref: encoded,
      examples: [{ $ref: encoded }],
    });
    const result = await validateAndDereferenceOpenAPI(documentWithReference(ref), {
      externalReferences: new Map([[ref, contents]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toMatchObject({
      type: "string",
      examples: [{ $ref: encoded }],
    });
  });
});
