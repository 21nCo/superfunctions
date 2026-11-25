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

  it.each(["#/components/schemas/Shared", "#%2Fcomponents%2Fschemas%2FShared", "#/components%2Fschemas/Shared"])(
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

  it.each([
    ["#/components/schemas/Shared/properties/a%2Fb", "a/b"],
    ["#/components/schemas/Shared/properties/100%", "100%"],
  ])("retains previously supported token encodings in %s", async (ref, key) => {
    const doc = documentWithReference(ref);
    Object.assign(doc.components.schemas.Shared, {
      type: "object",
      properties: { [key]: { type: "integer" } },
    });
    const result = await validateAndDereferenceOpenAPI(doc);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
  });

  it("keeps an encoded-slash token when its path passes through a reference", async () => {
    const doc = documentWithReference("#/components/schemas/Shared/properties/a%2Fb/properties/value");
    Object.assign(doc.components.schemas, {
      Shared: {
        type: "object",
        properties: {
          "a/b": { $ref: "#/components/schemas/Legacy" },
          a: { b: { properties: { value: { type: "string" } } } },
        },
      },
      Legacy: { type: "object", properties: { value: { type: "integer" } } },
    });
    const result = await validateAndDereferenceOpenAPI(doc);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
  });

  it("keeps a legacy slash-containing key when both pointer interpretations exist", async () => {
    const doc = documentWithReference("#/components/schemas/Shared/properties/a%2Fproperties/b");
    Object.assign(doc.components.schemas.Shared, {
      type: "object",
      properties: {
        "a/properties/b": { type: "integer" },
        a: { type: "object", properties: { b: { type: "string" } } },
      },
    });
    const result = await validateAndDereferenceOpenAPI(doc);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
  });

  it.each(["properties/a%2Fb", "properties%2Fa~1b"])(
    "resolves a chain of aliases using the pointer suffix %s", async (suffix) => {
      const depth = 16;
      let end: object = { type: "integer" };
      const schemas: Record<string, object> = {};
      for (let index = 0; index < depth; index += 1) {
        end = { type: "object", properties: { "a/b": end } };
        const next = index + 1 === depth ? "End" : `Alias${index + 1}`;
        schemas[`Alias${index}`] = { $ref: `#/components/schemas/${next}/${suffix}` };
      }
      const doc = documentWithReference("#/components/schemas/Alias0");
      Object.assign(doc.components.schemas, schemas, { End: end });
      const result = await validateAndDereferenceOpenAPI(doc);
      expect(result.errors).toEqual([]);
      expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    }
  );

  it("rejects a pointer that traverses an alias cycle", async () => {
    const doc = documentWithReference("#/components/schemas/First/properties/value");
    Object.assign(doc.components.schemas, {
      First: { $ref: "#/components/schemas/Second/properties%2Fvalue" },
      Second: { $ref: "#/components/schemas/First" },
    });
    await expect(validateOpenAPI(doc)).resolves.toEqual([
      { path: "openapi", message: "Circular OpenAPI $ref aliases cannot be traversed", severity: "error" },
    ]);
  });

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

  it.each([false, true])("preserves literal local and external-looking refs (allowlist=%s)", async (allowlist) => {
    const local = "#/components/schemas/Shared";
    const external = "https://example.invalid/sample.json";
    const doc = documentWithReference(local);
    Object.assign(doc.components.schemas.Shared, {
      type: "object",
      example: { $ref: local },
      default: { $ref: external },
    });
    const result = await validateAndDereferenceOpenAPI(doc, allowlist
      ? { externalReferences: new Map([["https://example.invalid/unused.json", "{}"]]) }
      : undefined);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toMatchObject({
      type: "object",
      example: { $ref: local },
      default: { $ref: external },
    });
  });

  it("keeps aliased example data separate from schema pointer normalization", async () => {
    const encoded = "#%2Fcomponents%2Fschemas%2FShared";
    const sharedNode = { type: "object", properties: { value: { $ref: encoded } } };
    const doc = {
      openapi: "3.1.0" as const,
      info: { title: "Example API", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          Shared: { type: "string" },
          Container: sharedNode,
          ExampleCarrier: { type: "object", examples: [sharedNode] },
        },
      },
    };
    const result = await validateAndDereferenceOpenAPI(doc);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Container).toMatchObject({
      properties: { value: { type: "string" } },
    });
    expect(result.document?.components?.schemas?.ExampleCarrier).toMatchObject({
      examples: [{ properties: { value: { $ref: encoded } } }],
    });
    expect(doc.components.schemas.Container.properties.value).toEqual({ $ref: encoded });
  });

  it("resolves a schema reference into an extension and preserves the extension data", async () => {
    const doc = {
      ...documentWithReference("#/x-schemas/Chosen"),
      "x-schemas": {
        $ref: "#example-tag",
        Chosen: { $ref: "#/components/schemas/Shared", description: "Chosen value" },
      },
      "x-apifn-reference-copies": { keep: true },
    };
    Object.assign(doc.components.schemas, {
      Root: { $ref: "#", title: "Root schema" },
    });
    const result = await validateAndDereferenceOpenAPI(doc);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toMatchObject({
      type: "string",
      description: "Chosen value",
    });
    expect(result.document).toHaveProperty("x-schemas", doc["x-schemas"]);
    expect(result.document).toHaveProperty("x-apifn-reference-copies", { keep: true });
    expect(Object.keys(result.document ?? {})).not.toContain("x-apifn-reference-copies-");
    expect(result.document?.components?.schemas?.Root).toHaveProperty("x-apifn-reference-copies", { keep: true });
    expect(Object.keys(result.document?.components?.schemas?.Root ?? {})).not.toContain("x-apifn-reference-copies-");

    Object.assign(doc.components.schemas, {
      Missing: { $ref: "#/x-apifn-reference-copies-/0" },
    });
    await expect(validateOpenAPI(doc)).resolves.toEqual([
      expect.objectContaining({ severity: "error" }),
    ]);
    Object.assign(doc.components.schemas, {
      Missing: { $ref: "#/components/schemas/Root/x-apifn-reference-copies-/0" },
    });
    await expect(validateOpenAPI(doc)).resolves.toEqual([
      expect.objectContaining({ severity: "error", message: "OpenAPI $ref target does not exist" }),
    ]);
    for (const ref of ["./#/x-apifn-reference-copies-/0", "./#\\x-apifn-reference-copies-\\0"]) {
      Object.assign(doc.components.schemas, { Missing: { $ref: ref } });
      await expect(validateOpenAPI(doc, {
        externalReferences: new Map([["https://example.invalid/unused.json", "{}"]]),
      })).resolves.toEqual([
        expect.objectContaining({ severity: "error" }),
      ]);
    }
  });

  it("does not shadow a slash-containing extension key with a temporary copy", async () => {
    const doc = {
      ...documentWithReference("#/x-apifn-reference-copies/0"),
      "x-apifn-reference-copies/0": false,
      "x-schemas": { Chosen: { type: "integer" } },
    };
    Object.assign(doc.components.schemas, { Copied: { $ref: "#/x-schemas/Chosen" } });
    const result = await validateAndDereferenceOpenAPI(doc);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toBe(false);
    expect(result.document?.components?.schemas?.Copied).toEqual({ type: "integer" });
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

  it("treats a document-relative URI as external even when it names the current directory", async () => {
    const directory = process.cwd().replaceAll("\\", "/").replace(/\/$/, "") + "/";
    const doc = documentWithReference("./#/components/schemas/Shared");
    const externalReferences = new Map([["https://example.invalid/unused.json", "{}"]]);
    await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
      { path: "openapi", message: expect.stringContaining("explicit allowlist"), severity: "error" },
    ]);

    externalReferences.set(directory.startsWith("/") ? directory : "/" + directory, JSON.stringify({
      components: { schemas: { Shared: { type: "integer" } } },
    }));
    const result = await validateAndDereferenceOpenAPI(doc, { externalReferences });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
  });

  it("resolves a preloaded file relative to a working directory containing a hash", async () => {
    const directory = "/virtual/C#/service";
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      const externalReferences = new Map([[directory + "/types.json", '{"type":"integer"}']]);
      const result = await validateAndDereferenceOpenAPI(documentWithReference("./types.json"), { externalReferences });
      expect(result.errors).toEqual([]);
      expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    } finally {
      cwd.mockRestore();
    }
  });

  it("resolves a query-relative reference from a preloaded local document", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/virtual/project");
    try {
      const externalReferences = new Map([
        ["/virtual/project/types.json?revision=1", '{"$ref":"?revision=2"}'],
        ["/virtual/project/types.json?revision=2", '{"type":"integer"}'],
      ]);
      const doc = documentWithReference("./types.json?revision=1");
      const result = await validateAndDereferenceOpenAPI(doc, { externalReferences });
      expect(result.errors).toEqual([]);
      expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    } finally {
      cwd.mockRestore();
    }
  });

  it("keeps a question mark in a filename distinct from a URI query", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/virtual/project");
    try {
      const doc = documentWithReference("./types.json%3Frevision=1");
      const externalReferences = new Map([["/virtual/project/types.json?revision=1", '{"type":"string"}']]);
      await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
        { path: "openapi", message: expect.stringContaining("explicit allowlist"), severity: "error" },
      ]);
      externalReferences.set("/virtual/project/types.json%3Frevision=1", '{"type":"integer"}');
      const result = await validateAndDereferenceOpenAPI(doc, { externalReferences });
      expect(result.errors).toEqual([]);
      expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    } finally {
      cwd.mockRestore();
    }
  });

  it("keeps a bare query delimiter in the exact local allowlist key", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/virtual/project");
    try {
      const doc = documentWithReference("./types.json?");
      const externalReferences = new Map([["/virtual/project/types.json", '{"type":"string"}']]);
      await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
        { path: "openapi", message: expect.stringContaining("explicit allowlist"), severity: "error" },
      ]);
      externalReferences.set("/virtual/project/types.json?", '{"type":"integer"}');
      const result = await validateAndDereferenceOpenAPI(doc, { externalReferences });
      expect(result.errors).toEqual([]);
      expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    } finally {
      cwd.mockRestore();
    }
  });

  it("unescapes JSON pointer tokens after percent-decoding a preloaded fragment", async () => {
    const uri = "https://example.invalid/schema-map.json";
    const externalReferences = new Map([[uri, '{"/":{"type":"integer"},"~1":{"type":"string"}}']]);
    const result = await validateAndDereferenceOpenAPI(documentWithReference(uri + "#/%7E1"), { externalReferences });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
  });

  it("can select a child of a directly self-referencing preloaded schema", async () => {
    const uri = "https://example.invalid/types.json";
    const contents = JSON.stringify({
      Self: { $ref: "#/Self", $defs: { Part: { type: "integer" } } },
    });
    const doc = documentWithReference(uri + "#/Self/$defs/Part");
    const result = await validateAndDereferenceOpenAPI(doc, {
      externalReferences: new Map([[uri, contents]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
  });

  it("dereferences literal data used as a schema through an intermediate alias", async () => {
    const doc = documentWithReference("#/components/schemas/Alias/default");
    const literal = { $ref: "#/components/schemas/Leaf" };
    Object.assign(doc.components.schemas, {
      Alias: { $ref: "#/components/schemas/Shared" },
      Leaf: { type: "integer" },
      Shared: { type: "object", default: literal },
    });
    const result = await validateAndDereferenceOpenAPI(doc);
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    expect(result.document?.components?.schemas?.Shared).toMatchObject({ default: literal });
  });

  it("resolves slash-delimited pointers in preloaded schemas and preserves literal examples", async () => {
    const ref = "https://example.invalid/preloaded.json";
    const pointer = "#/$defs/Shared";
    const contents = JSON.stringify({
      $defs: { Shared: { type: "string" } },
      $ref: pointer,
      examples: [{ $ref: pointer }],
      default: { $ref: "literal-example.json" },
    });
    const result = await validateAndDereferenceOpenAPI(documentWithReference(ref), {
      externalReferences: new Map([[ref, contents]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toMatchObject({
      type: "string",
      examples: [{ $ref: pointer }],
      default: { $ref: "literal-example.json" },
    });

    const encodedSchema = contents.replace(`"$ref":"${pointer}"`, '"$ref":"#%2F$defs%2FShared"');
    await expect(validateOpenAPI(documentWithReference(ref), {
      externalReferences: new Map([[ref, encodedSchema]]),
    })).resolves.toEqual([
      { path: "openapi", message: expect.stringContaining("JSON pointers"), severity: "error" },
    ]);
  });

  it("keeps the literal value of an Example Object referenced from a preloaded map", async () => {
    const ref = "https://example.invalid/schema-map.json";
    const pointer = "#/$defs/Shared";
    const doc = {
      openapi: "3.1.0" as const,
      info: { title: "Example API", version: "1.0.0" },
      paths: {},
      components: { examples: { Sample: { $ref: ref + "#/exampleRecords/Selected" } } },
    };
    const result = await validateAndDereferenceOpenAPI(doc, {
      externalReferences: new Map([[ref, JSON.stringify({
        $defs: { Shared: { type: "string" } },
        exampleRecords: { Selected: { value: { $ref: pointer } } },
      })]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.examples?.Sample).toEqual({ value: { $ref: pointer } });
  });

  it.each([false, true])("keeps preloaded Example Object payload refs literal (alias=%s)", async (useAlias) => {
    const ref = "https://example.invalid/example.json";
    const literal = { $ref: "literal-data.json", schema: { type: "integer" } };
    const example = useAlias ? ref + "#/Alias" : ref + "#";
    const contents = useAlias
      ? { Alias: { $ref: "#/Example" }, Example: { value: literal } }
      : { value: literal };
    const spec = documentWithReference(example + "/value/schema");
    const doc = {
      ...spec,
      components: {
        ...spec.components,
        examples: { Sample: { $ref: example } },
      },
    };
    const result = await validateAndDereferenceOpenAPI(doc, {
      externalReferences: new Map([[ref, JSON.stringify(contents)]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    expect(result.document?.components?.examples?.Sample).toEqual({ value: literal });
  });

  it("preserves parser support for YAML aliases when a local extension reference is present", async () => {
    const ref = "https://example.invalid/aliased-schema.yml";
    const doc = {
      ...documentWithReference("#/x-schemas/Chosen"),
      "x-schemas": { Chosen: { $ref: "#/components/schemas/Shared" } },
    };
    Object.assign(doc.components.schemas, { Outside: { $ref: ref } });
    const aliases = Array.from({ length: 102 }, () => "  - *example").join("\n");
    const contents = "type: object\nexamples:\n  - &example {example: value}\n" + aliases;
    const result = await validateAndDereferenceOpenAPI(doc, {
      externalReferences: new Map([[ref, contents]]),
    });
    expect(result.errors).toEqual([]);
    const outside = result.document?.components?.schemas?.Outside as { examples: unknown[] };
    expect(outside.examples).toHaveLength(103);
  });
});
