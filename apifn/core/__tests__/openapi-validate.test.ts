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
        { path: "components.schemas.Value.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
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
      { path: "components.schemas.First.$ref", message: "Circular OpenAPI $ref aliases cannot be traversed", severity: "error" },
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

  it("checks string references in name maps before attaching temporary copies", async () => {
    const doc = {
      ...documentWithReference("#/x-schemas/Chosen"),
      "x-schemas": { Chosen: { type: "integer" } },
    };
    Object.assign(doc.components.schemas, {
      WithProperties: { type: "object", properties: { $ref: "#/x-apifn-reference-copies/0" } },
    });
    await expect(validateOpenAPI(doc)).resolves.toEqual([
      expect.objectContaining({ message: "OpenAPI $ref target does not exist", severity: "error" }),
    ]);
  });

  it("refuses a named reference fragment regardless of unrelated allowlist entries", async () => {
    const doc = documentWithReference("#missing");
    const options = { externalReferences: new Map([["https://example.invalid/unused.json", "{}"]]) };
    for (const validationOptions of [undefined, options]) {
      await expect(validateOpenAPI(doc, validationOptions)).resolves.toEqual([
        { path: "components.schemas.Value.$ref", message: expect.stringContaining("JSON pointers"), severity: "error" },
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
      { path: "components.schemas.Value.$ref", message: expect.stringContaining("JSON pointers"), severity: "error" },
    ]);

    externalReferences.set(ref, '{"example":{"$ref":"#missing"}}');
    await expect(validateOpenAPI(documentWithReference(ref + "#/example"), { externalReferences })).resolves.toEqual([
      { path: "components.schemas.Value.$ref", message: expect.stringContaining("JSON pointers"), severity: "error" },
    ]);

    externalReferences.set(ref, '{"$ref":"another-example.json"}');
    await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
      { path: "components.schemas.Value.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
    ]);
  });

  it("treats a document-relative URI as external even when it names the current directory", async () => {
    const directory = process.cwd().replaceAll("\\", "/").replace(/\/$/, "") + "/";
    const doc = documentWithReference("./#/components/schemas/Shared");
    const externalReferences = new Map([["https://example.invalid/unused.json", "{}"]]);
    await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
      { path: "components.schemas.Value.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
    ]);

    externalReferences.set(directory, JSON.stringify({
      components: { schemas: { Shared: { type: "integer" } } },
    }));
    const result = await validateAndDereferenceOpenAPI(doc, { externalReferences });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
  });

  it.each([
    ["a mapping", "{ id: 1 }", 1, /alias count/i],
    ["an empty sequence", "[]", 4, /alias expansion/i],
  ])("bounds nested YAML alias expansion over %s", async (_label, leaf, depth, message) => {
    const uri = "https://example.invalid/types.yaml";
    const copies = (name: string) => Array.from({ length: 10 }, () => "*" + name).join(", ");
    const groups = Array.from({ length: depth }, (_, index) =>
      `x-group${index + 1}: &group${index + 1} [${copies("group" + index)}]`
    );
    const schema = [
      "type: object",
      "x-leaf: &group0 " + leaf,
      ...groups,
      "examples: [" + copies("group" + depth) + "]",
    ].join("\n");
    const errors = await validateOpenAPI(documentWithReference(uri), { externalReferences: new Map([[uri, schema]]) });
    expect(errors).toEqual([
      { path: "components.schemas.Value.$ref", message: expect.stringMatching(message), severity: "error" },
    ]);
  });

  it.each([
    { reversed: false, preloaded: false },
    { reversed: true, preloaded: false },
    { reversed: false, preloaded: true },
    { reversed: true, preloaded: true },
  ])("identifies the importing alias (reversed=$reversed, preloaded=$preloaded)", async ({ reversed, preloaded }) => {
    const uri = "https://example.invalid/types.yaml";
    const schemas = Object.entries({
      Alias: { $ref: uri },
      Value: { $ref: "#/components/schemas/Alias/properties/item" },
    });
    const doc = {
      ...documentWithReference("#/components/schemas/Alias"),
      components: { schemas: Object.fromEntries(reversed ? schemas.reverse() : schemas) },
    };
    const externalReferences = preloaded ? new Map([[uri, "$ref: ./unlisted.yaml"]]) : undefined;
    await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
      { path: "components.schemas.Alias.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
    ]);
  });

  it("reports the schema when an unlisted reference shares an object with literal data", async () => {
    const doc = documentWithReference("https://example.invalid/types.yaml");
    await expect(validateOpenAPI({ ...doc, "x-sample": doc.components.schemas.Value })).resolves.toEqual([
      { path: "components.schemas.Value.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
    ]);
  });

  it.each([false, true])("locates the extension selected by the schema pointer (reversed=%s)", async (reversed) => {
    const doc = documentWithReference("#/components/schemas/Alias/properties/item");
    const schemas = {
      Alias: { $ref: "#/x-templates/Proxy" },
      Value: doc.components.schemas.Value,
    };
    const proxy = { $ref: "https://example.invalid/types.yaml" };
    const extensions = Object.entries({ "x-templates": { Proxy: proxy }, "x-other": proxy });
    await expect(validateOpenAPI({
      ...doc,
      components: { schemas },
      ...Object.fromEntries(reversed ? extensions.reverse() : extensions),
    })).resolves.toEqual([
      { path: "x-templates.Proxy.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
    ]);
  });

  it.each([
    { directory: "/virtual/C#/service", ref: "./types.json", key: "/virtual/C#/service/types.json" },
    { directory: "C:\\project", ref: "./shared.yaml", key: "C:\\project\\shared.yaml" },
    { directory: "C:\\project", ref: "C:\\project\\shared.yaml", key: "C:\\project\\shared.yaml" },
    { directory: "C:\\project", ref: "\\shared.yaml", key: "C:\\shared.yaml", other: "/shared.yaml" },
    { directory: "C:\\project", ref: "../../shared.yaml", key: "C:\\shared.yaml", other: "/shared.yaml" },
    {
      directory: "\\\\server\\share\\project",
      ref: "./shared.yaml",
      key: "//server/share/project/shared.yaml",
      other: "C:/project/shared.yaml",
    },
    {
      directory: "\\\\server\\share\\project",
      ref: "../../shared.yaml",
      key: "\\\\server\\share\\shared.yaml",
      other: "//server/shared.yaml",
    },
    {
      directory: "/virtual/project\\branch",
      ref: "./shared.yaml",
      key: "/virtual/project%5Cbranch/shared.yaml",
      other: "/virtual/project/branch/shared.yaml",
    },
  ])("resolves $ref from $directory to $key", async ({ directory, ref, key, other }) => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      const externalReferences = new Map([[key, "type: integer"]]);
      if (other) externalReferences.set(other, "type: string");
      const result = await validateAndDereferenceOpenAPI(documentWithReference(ref), { externalReferences });
      expect(result.errors).toEqual([]);
      expect(result.document?.components?.schemas?.Value).toEqual({ type: "integer" });
    } finally {
      cwd.mockRestore();
    }
  });

  it.each([
    ["\\\\server\\share\\project\\parent.yaml", "integer"],
    ["file://server/share/project/parent.yaml", "string"],
  ])("resolves %s using its own allowlist key and base", async (ref, type) => {
    const externalReferences = new Map([
      ["\\\\server\\share\\project\\parent.yaml", "$ref: ./child.yaml"],
      ["//server/share/project/child.yaml", "type: integer"],
      ["file://server/share/project/parent.yaml", "type: string"],
    ]);
    const result = await validateAndDereferenceOpenAPI(documentWithReference(ref), { externalReferences });
    expect(result.errors).toEqual([]);
    expect(result.document?.components?.schemas?.Value).toEqual({ type });
  });

  it("keeps an encoded backslash distinct from a Windows path separator", async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("C:\\project");
    try {
      const externalReferences = new Map([["C:\\project\\nested\\value.yaml", "type: integer"]]);
      await expect(validateOpenAPI(documentWithReference("./nested%5Cvalue.yaml"), { externalReferences })).resolves.toEqual([
        { path: "components.schemas.Value.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
      ]);
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

  it.each([
    ["types.json%3Frevision=1", "types.json?revision=1"],
    ["types.json?", "types.json"],
  ])("requires the exact allowlist key for %s instead of %s", async (filename, differentFilename) => {
    const directory = "/virtual/project";
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      const doc = documentWithReference("./" + filename);
      const externalReferences = new Map([[directory + "/" + differentFilename, '{"type":"string"}']]);
      await expect(validateOpenAPI(doc, { externalReferences })).resolves.toEqual([
        { path: "components.schemas.Value.$ref", message: expect.stringContaining("explicit allowlist"), severity: "error" },
      ]);
      externalReferences.set(directory + "/" + filename, '{"type":"integer"}');
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
      { path: "components.schemas.Value.$ref", message: expect.stringContaining("JSON pointers"), severity: "error" },
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
