import Ajv from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSchemaCompiler, formatMcpFnSchemaIssues, validateSchemaCollection } from "../src/validation.js";

describe("schema validation engines", () => {
  it.each(["ajv", "cfworker"] as const)("reports structural property names with %s", engine => {
    const required = createSchemaCompiler(engine).compile({ type: "object", required: ['missing"field'] });
    expect(required({})).toBe(false);
    expect(formatMcpFnSchemaIssues(required.errors)).toContainEqual(expect.objectContaining({
      keyword: "required", missingProperty: 'missing"field',
    }));
    const closed = createSchemaCompiler(engine).compile({ type: "object", additionalProperties: false });
    expect(closed({ 'extra"field': true })).toBe(false);
    expect(formatMcpFnSchemaIssues(closed.errors)).toContainEqual(expect.objectContaining({
      keyword: "additionalProperties", rejectedProperty: 'extra"field',
    }));
  });
  it.each(["ajv", "cfworker"] as const)(
    "uses draft-07 $ref sibling semantics with %s",
    (engine) => {
      const validate = createSchemaCompiler(engine).compile({
        definitions: { value: { type: "string" } },
        $ref: "#/definitions/value",
        minLength: 5,
      });

      expect(validate("abc")).toBe(true);
    },
  );

  it.each([
    { type: "object", properties: { value: { minimum: "invalid" } } },
    { type: "object", required: "value" },
    { type: "string", pattern: "[" },
  ])("rejects malformed schemas before edge validation", (schema) => {
    expect(() => createSchemaCompiler("cfworker").compile(schema as object))
      .toThrow(/schema is invalid/);
  });

  it("normalizes fallback validation errors", () => {
    const validate = createSchemaCompiler("cfworker").compile({ type: "string" });

    expect(validate(42)).toBe(false);
    expect(validate.errors).toEqual([
      expect.objectContaining({
        instancePath: "",
        keyword: "type",
      }),
    ]);
  });

  it.each(["ajv", "cfworker"] as const)(
    "resolves previously registered external schemas with %s",
    (engine) => {
      const compiler = createSchemaCompiler(engine);
      compiler.compile({ $id: "https://example.test/value", type: "string" });
      const validate = compiler.compile({
        type: "object",
        properties: { value: { $ref: "https://example.test/value" } },
      });

      expect(validate({ value: "ok" })).toBe(true);
      expect(validate({ value: 42 })).toBe(false);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "preserves the shared base for relative schema identifiers with %s",
    (engine) => {
      const valueSchema = { $id: "shared", type: "string" };
      const referringSchema = {
        type: "object",
        properties: { value: { $ref: "shared" } },
      };
      const compiler = createSchemaCompiler(engine);
      compiler.compile(valueSchema);
      const validate = compiler.compile(referringSchema);

      expect(validate({ value: "ok" })).toBe(true);
      expect(validate({ value: 42 })).toBe(false);
      expect(() => validateSchemaCollection([valueSchema, referringSchema], engine))
        .not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "keeps dot-segment self references on anonymous roots using %s",
    (engine) => {
      for (const reference of [".", "./", "../"]) {
        const schema = {
          type: "object",
          properties: { child: { $ref: reference } },
        };
        const validate = createSchemaCompiler(engine).compile(schema);
        expect(validate({ child: { child: {} } })).toBe(true);
        expect(validate({ child: 42 })).toBe(false);
        expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
      }
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "resolves named fragments beneath anonymous roots using %s",
    (engine) => {
      for (const keyword of ["definitions", "$defs"] as const) {
        const schema = {
          type: "object",
          [keyword]: { value: { $id: "#value", type: "string" } },
          properties: { value: { $ref: "#value" } },
        };
        const validate = createSchemaCompiler(engine).compile(schema);
        expect(validate({ value: "ok" })).toBe(true);
        expect(validate({ value: 42 })).toBe(false);
        expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
      }
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "does not turn a root-path reference into an anonymous self reference using %s",
    (engine) => {
      const schema = { type: "object", properties: { child: { $ref: "/" } } };
      expect(() => createSchemaCompiler(engine).compile(schema)).toThrow();
      expect(() => validateSchemaCollection([schema], engine)).toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "does not alias relative references to absolute internal-looking identifiers with %s",
    (engine) => {
      const absoluteSchema = {
        $id: "https://0.schema-resource.mcpfn.invalid/shared",
        type: "string",
      };
      const referringSchema = { $ref: "shared" };
      const compiler = createSchemaCompiler(engine);
      compiler.compile(absoluteSchema);

      expect(() => compiler.compile(referringSchema))
        .toThrow(/resolve.*ref|can't resolve reference/i);
      expect(() => validateSchemaCollection([absoluteSchema, referringSchema], engine))
        .toThrow(/resolve.*ref|can't resolve reference/i);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "does not satisfy a missing absolute reference with a synthetic root using %s",
    (engine) => {
      const schema = { $ref: "https://schema-collection.mcpfn.invalid/0-0" };
      expect(() => createSchemaCompiler(engine).compile(schema))
        .toThrow(/resolve.*ref|can't resolve reference/i);
      expect(() => validateSchemaCollection([schema], engine))
        .toThrow(/resolve.*ref|can't resolve reference/i);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "resolves relative references inside $defs using %s",
    (engine) => {
      const shared = { $id: "shared", type: "string" };
      const referring = {
        type: "object",
        $defs: { value: { $ref: "shared" } },
        properties: { value: { $ref: "#/$defs/value" } },
      };
      const compiler = createSchemaCompiler(engine);
      compiler.compile(shared);
      const validate = compiler.compile(referring);
      expect(validate({ value: "ok" })).toBe(true);
      expect(validate({ value: 42 })).toBe(false);
      expect(() => validateSchemaCollection([shared, referring], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "resolves a relative identifier declared inside $defs using %s",
    (engine) => {
      const schema = {
        type: "object",
        $defs: { value: { $id: "shared", type: "string" } },
        properties: { value: { $ref: "shared" } },
      };
      const validate = createSchemaCompiler(engine).compile(schema);
      expect(validate({ value: "ok" })).toBe(true);
      expect(validate({ value: 42 })).toBe(false);
      expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "does not alias a nested absolute $defs identifier to a relative reference using %s",
    (engine) => {
      const schema = {
        $defs: { value: { $id: "https://0.schema-resource.mcpfn.invalid/shared", type: "string" } },
        properties: { value: { $ref: "shared" } },
      };
      expect(() => createSchemaCompiler(engine).compile(schema))
        .toThrow(/resolve.*ref|can't resolve reference/i);
      expect(() => validateSchemaCollection([schema], engine))
        .toThrow(/resolve.*ref|can't resolve reference/i);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects legacy identifiers inside $defs using %s",
    (engine) => {
      const schema = { $defs: { value: { id: "legacy", type: "string" } } };
      expect(() => createSchemaCompiler(engine).compile(schema))
        .toThrow(/keyword "id".*\$id/);
      expect(() => validateSchemaCollection([schema], engine))
        .toThrow(/keyword "id".*\$id/);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects malformed schemas inside $defs before registration using %s",
    (engine) => {
      const schema = {
        type: "object",
        $defs: { value: { type: 7 } },
        properties: { value: { $ref: "#/$defs/value" } },
      };
      expect(() => createSchemaCompiler(engine).compile(schema)).toThrow();
      expect(() => validateSchemaCollection([schema], engine)).toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "does not expose an earlier anonymous root through a later relative reference using %s",
    (engine) => {
      const anonymous = { type: "string" };
      const referring = {
        $id: "https://schema-collection.mcpfn.invalid/",
        $ref: "0-0",
      };
      const compiler = createSchemaCompiler(engine);
      const first = compiler.compile(anonymous);
      expect(() => compiler.compile(referring))
        .toThrow(/resolve.*ref|can't resolve reference/i);
      expect(() => validateSchemaCollection([anonymous, referring], engine))
        .toThrow(/resolve.*ref|can't resolve reference/i);
      expect(first("still valid")).toBe(true);
      expect(first(42)).toBe(false);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "keeps an explicit public identifier distinct from an anonymous root using %s",
    (engine) => {
      const anonymous = { type: "number" };
      const publicSchema = {
        $id: "https://schema-collection.mcpfn.invalid/0-0",
        type: "string",
      };
      const referring = { $ref: publicSchema.$id };
      const compiler = createSchemaCompiler(engine);
      const first = compiler.compile(anonymous);
      compiler.compile(publicSchema);
      const validate = compiler.compile(referring);
      expect(first(42)).toBe(true);
      expect(first("42")).toBe(false);
      expect(validate("ok")).toBe(true);
      expect(validate(42)).toBe(false);
      expect(() => validateSchemaCollection([anonymous, publicSchema, referring], engine))
        .not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "resolves nested references under an opaque URI base using %s",
    (engine) => {
      const schema = {
        $id: "urn:example:root",
        type: "object",
        $defs: { child: { $id: "child", type: "string" } },
        properties: { value: { $ref: "child" } },
      };
      const validate = createSchemaCompiler(engine).compile(schema);
      expect(validate({ value: "ok" })).toBe(true);
      expect(validate({ value: 42 })).toBe(false);
      expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects unresolved references under an opaque URI base using %s",
    (engine) => {
      const schema = { $id: "urn:example:root", $ref: "missing" };
      expect(() => createSchemaCompiler(engine).compile(schema)).toThrow();
      expect(() => validateSchemaCollection([schema], engine)).toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "keeps an empty reference within an opaque resource using %s",
    (engine) => {
      const schema = {
        $id: "urn:example:root",
        type: "object",
        properties: { child: { anyOf: [{ type: "null" }, { $ref: "" }] } },
      };
      const validate = createSchemaCompiler(engine).compile(schema);
      expect(validate({ child: null })).toBe(true);
      expect(validate({ child: {} })).toBe(true);
      expect(validate({ child: 42 })).toBe(false);
      expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "resolves RFC 3986 IPvFuture resources across compiler and collection using %s",
    (engine) => {
      for (const scheme of ["http", "https"]) {
        const root = {
          $id: `${scheme}://[v1.fe]/schema`,
          type: "object",
          $defs: { child: { $id: "child", type: "string" } },
          properties: { value: { $ref: "child" } },
        };
        const external = {
          type: "object",
          properties: { value: { $ref: `${scheme}://[v1.fe]/child` } },
        };
        const compiler = createSchemaCompiler(engine);
        const validateRoot = compiler.compile(root);
        const validateExternal = compiler.compile(external);
        expect(validateRoot({ value: "ok" })).toBe(true);
        expect(validateRoot({ value: 42 })).toBe(false);
        expect(validateExternal({ value: "ok" })).toBe(true);
        expect(validateExternal({ value: 42 })).toBe(false);
        expect(() => validateSchemaCollection([root, external], engine)).not.toThrow();
      }
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects missing RFC 3986 IPvFuture resources using %s",
    (engine) => {
      for (const scheme of ["http", "https"]) {
        const schema = { $id: `${scheme}://[v1.fe]/schema`, $ref: "missing" };
        expect(() => createSchemaCompiler(engine).compile(schema)).toThrow();
        expect(() => validateSchemaCollection([schema], engine)).toThrow();
      }
    },
  );

  it("keeps earlier edge validators correct after a resource rebase and a rejected registration", () => {
    const compiler = createSchemaCompiler("cfworker");
    const first = compiler.compile({ type: "string", minLength: 2 });
    const shared = compiler.compile({ $id: "shared", type: "number" });
    expect(() => compiler.compile({
      $ref: "https://schema-collection.mcpfn.invalid/0-0",
    })).toThrow(/resolve.*ref/i);
    // This absolute identifier occupies the former relative-resource origin.
    compiler.compile({ $id: "https://0.schema-resource.mcpfn.invalid/other", type: "null" });
    const referring = compiler.compile({ $ref: "shared" });
    expect(first("ok")).toBe(true);
    expect(first("x")).toBe(false);
    expect(shared(3)).toBe(true);
    expect(referring(3)).toBe(true);
    expect(referring("3")).toBe(false);
  });

  it("keeps a larger edge registry's independent validators available", () => {
    const compiler = createSchemaCompiler("cfworker");
    const validators = Array.from({ length: 120 }, (_, index) =>
      compiler.compile({ type: "integer", minimum: index }));
    for (const [index, validate] of validators.entries()) {
      expect(validate(index)).toBe(true);
      expect(validate(index - 1)).toBe(false);
    }
  });

  it.each(["ajv", "cfworker"] as const)(
    "rejects legacy identifiers, including beside empty references, with %s",
    (engine) => {
      const schema = {
        type: "object",
        definitions: {
          node: {
            id: "legacy-node",
            type: "object",
            properties: { child: { $ref: "" } },
          },
        },
      };

      expect(() => createSchemaCompiler(engine).compile(schema))
        .toThrow(/keyword "id".*\$id/);
      expect(() => validateSchemaCollection([schema], engine))
        .toThrow(/keyword "id".*\$id/);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects unresolved references while compiling with %s",
    (engine) => {
      expect(() => createSchemaCompiler(engine).compile({
        $ref: "https://example.test/missing",
      })).toThrow(/resolve.*ref|can't resolve reference/i);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "resolves local references inside draft-07 dependencies with %s",
    (engine) => {
      const schema = {
        type: "object",
        definitions: {
          value: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "string" } },
          },
        },
        properties: { type: { type: "boolean" }, value: {} },
        dependencies: { type: { $ref: "#/definitions/value" } },
      };
      const validate = createSchemaCompiler(engine).compile(schema);

      expect(validate({ type: true, value: "ok" })).toBe(true);
      expect(validate({ type: true, value: 42 })).toBe(false);
      expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects unresolved references inside draft-07 dependencies with %s",
    (engine) => {
      const schema = {
        type: "object",
        properties: { type: { type: "boolean" } },
        dependencies: { type: { $ref: "#/missing" } },
      };

      expect(() => createSchemaCompiler(engine).compile(schema))
        .toThrow(/resolve.*ref|can't resolve reference/i);
      expect(() => validateSchemaCollection([schema], engine))
        .toThrow(/resolve.*ref|can't resolve reference/i);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "accepts an empty reference to the current resource with %s",
    (engine) => {
      const schema = {
        $id: "https://example.test/node",
        type: "object",
        properties: {
          child: { anyOf: [{ type: "null" }, { $ref: "" }] },
        },
      };
      const validate = createSchemaCompiler(engine).compile(schema);

      expect(validate({ child: null })).toBe(true);
      expect(validate({ child: {} })).toBe(true);
      expect(validate({ child: 42 })).toBe(false);
      expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "validates schema collections as independent roots with %s",
    (engine) => {
      const schemaId = "https://example.test/batch-value";
      expect(() => validateSchemaCollection(
        [
          {
            type: "object",
            definitions: { value: { type: "string" } },
            properties: { value: { $ref: "#/definitions/value" } },
          },
          {
            type: "object",
            properties: { value: { $ref: schemaId } },
          },
          {
            definitions: {
              value: { $id: schemaId, type: "string" },
            },
          },
        ],
        engine,
      )).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects duplicate identifiers in schema collections with %s",
    (engine) => {
      const schema = { $id: "https://example.test/duplicate", type: "string" };

      expect(() => validateSchemaCollection([schema, { ...schema }], engine))
        .toThrow(/already exists|Duplicate schema URI/);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects unresolved references in schema collections with %s",
    (engine) => {
      expect(() => validateSchemaCollection([
        {
          type: "object",
          properties: { value: { $ref: "#/missing" } },
        },
      ], engine)).toThrow(/resolve.*ref|can't resolve reference/i);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "accepts cyclic references in schema collections with %s",
    (engine) => {
      expect(() => validateSchemaCollection([
        {
          $id: "https://example.test/left",
          type: "object",
          properties: { right: { $ref: "https://example.test/right" } },
        },
        {
          $id: "https://example.test/right",
          type: "object",
          properties: { left: { $ref: "https://example.test/left" } },
        },
      ], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "scopes schema identifiers to an owning %s compiler",
    (engine) => {
      const first = createSchemaCompiler(engine);
      const second = createSchemaCompiler(engine);
      const schema = { $id: "https://example.test/value", type: "string" };

      expect(() => first.compile(schema)).not.toThrow();
      expect(() => second.compile(schema)).not.toThrow();
      expect(() => first.compile({ ...schema })).toThrow(/already exists|Duplicate schema URI/);
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "keeps anonymous schemas independent within a %s compiler",
    (engine) => {
      const compiler = createSchemaCompiler(engine);

      expect(() => compiler.compile({ type: "string" })).not.toThrow();
      expect(() => compiler.compile({ type: "number" })).not.toThrow();
    },
  );

  it("does not reserve the fallback's former fixed synthetic identifier", () => {
    const compiler = createSchemaCompiler("cfworker");

    compiler.compile({ type: "object" });
    expect(() => compiler.compile({
      $id: "https://mcpfn.invalid/schema/0",
      type: "object",
    })).not.toThrow();
  });

  it("does not reserve collection identifiers while compiling with the fallback", () => {
    const compiler = createSchemaCompiler("cfworker");

    compiler.compile({
      $id: "https://schema-collection.mcpfn.invalid/1-0",
      type: "object",
    });
    expect(() => compiler.compile({ type: "object" })).not.toThrow();
  });

  it.each(["ajv", "cfworker"] as const)(
    "does not reserve collection-internal identifiers with %s",
    (engine) => {
      expect(() => validateSchemaCollection([
        { $id: "https://schema-collection.mcpfn.invalid/1-0", type: "string" },
        { type: "number" },
      ], engine)).not.toThrow();
      expect(() => validateSchemaCollection([
        { definitions: { value: { $id: "1-0", type: "string" } } },
        { type: "number" },
      ], engine)).not.toThrow();
    },
  );

  it.each(["ajv", "cfworker"] as const)(
    "rejects unsupported explicitly declared dialects with %s",
    (engine) => {
      expect(() => createSchemaCompiler(engine).compile({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string",
      })).toThrow();
    },
  );

  it.each([
    ["ajv", "http://json-schema.org/draft-07/schema#"],
    ["ajv", "http://json-schema.org/draft-07/schema"],
    ["cfworker", "http://json-schema.org/draft-07/schema#"],
    ["cfworker", "http://json-schema.org/draft-07/schema"],
  ] as const)("accepts the supported %s dialect alias %s", (engine, dialect) => {
    expect(() => createSchemaCompiler(engine).compile({
      $schema: dialect,
      type: "string",
    })).not.toThrow();
  });
});

describe("Ajv compilation of repeated schemas", () => {
  it("shares one compiled validator between equal schemas while each keeps its own errors", () => {
    const compiler = createSchemaCompiler("ajv");
    const schema = () => ({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] });
    const first = compiler.compile(schema());
    const second = compiler.compile(schema());
    expect(first({})).toBe(false);
    expect(second({ n: 1 })).toBe(true);
    expect(first.errors).toEqual([expect.objectContaining({ keyword: "required" })]);
    expect(second.errors).toBeNull();
    // A different schema is compiled on its own.
    const other = compiler.compile({ type: "object", properties: { n: { type: "string" } }, required: ["n"] });
    expect(other({ n: 1 })).toBe(false);
    expect(first({ n: 1 })).toBe(true);
  });

  it("still rejects a repeated $id and still rejects an invalid schema each time", () => {
    const compiler = createSchemaCompiler("ajv");
    const identified = () => ({ $id: "https://schemas.example.com/thing", type: "string" });
    compiler.compile(identified());
    expect(() => compiler.compile(identified())).toThrow(/already exists/);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => compiler.compile({ type: "string", pattern: "(" })).toThrow();
    }
  });

  it("does not equate a Date with its JSON string", () => {
    const compiler = createSchemaCompiler("ajv");
    const asString = compiler.compile({ const: "2026-01-01T00:00:00.000Z" });
    const asDate = compiler.compile({ const: new Date("2026-01-01T00:00:00.000Z") });
    expect(asString("2026-01-01T00:00:00.000Z")).toBe(true);
    expect(asDate("2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it.each([
    ["an enumerable toJSON", (schema: Record<string, unknown>, shown: object) => {
      schema.toJSON = () => shown;
    }],
    ["a non-enumerable toJSON", (schema: Record<string, unknown>, shown: object) => {
      Object.defineProperty(schema, "toJSON", { value: () => shown, enumerable: false });
    }],
    ["an inherited toJSON", (schema: Record<string, unknown>, shown: object) => {
      Object.setPrototypeOf(schema, { toJSON: () => shown });
    }],
  ] as const)("compiles a schema with %s from its own data, not its JSON form", (_label, disguise) => {
    const compiler = createSchemaCompiler("ajv");
    const stringSchema = { type: "object", properties: { n: { type: "string" } }, required: ["n"] };
    const viaString = compiler.compile(stringSchema);
    const integerSchema: Record<string, unknown> = {
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    };
    disguise(integerSchema, structuredClone(stringSchema));
    const viaInteger = compiler.compile(integerSchema);
    expect(viaString({ n: "x" })).toBe(true);
    expect(viaInteger({ n: 1 })).toBe(true);
    expect(viaInteger({ n: "x" })).toBe(false);
  });

  it("compiles a schema with a non-enumerable keyword as Ajv reads it, not as its JSON form", () => {
    const compiler = createSchemaCompiler("ajv");
    expect(compiler.compile({ type: "integer" })(1)).toBe(true);
    const bounded = { type: "integer" } as Record<string, unknown>;
    Object.defineProperty(bounded, "minimum", { value: 5, enumerable: false });
    const fresh = createSchemaCompiler("ajv").compile(bounded);
    expect(compiler.compile(bounded)(1)).toBe(fresh(1));
  });

  it("does not share a validator between a plain and a null-prototype const object", () => {
    const compiler = createSchemaCompiler("ajv");
    expect(compiler.compile({ const: { n: 5 } })({ n: 5 })).toBe(true);
    const nullPrototype = () => ({ const: Object.assign(Object.create(null) as object, { n: 5 }) });
    const fresh = createSchemaCompiler("ajv").compile(nullPrototype());
    expect(compiler.compile(nullPrototype())({ n: 5 })).toBe(fresh({ n: 5 }));
  });

  it("keeps a validator independent of later changes to an equal schema compiled earlier", () => {
    const compiler = createSchemaCompiler("ajv");
    const schema = () => ({ type: "object", properties: { v: { const: { n: 5 } } }, required: ["v"] });
    const first = schema();
    compiler.compile(first);
    const second = compiler.compile(schema());
    first.properties.v.const.n = 6;
    expect(second({ v: { n: 5 } })).toBe(true);
    expect(second({ v: { n: 6 } })).toBe(false);
  });

  it("validates a Proxy schema the same way whether or not an equal-looking schema was compiled first", () => {
    const proxy = () =>
      new Proxy({ type: "number", minimum: 1 } as Record<string, unknown>, {
        get: (target, key) => (key === "minimum" ? 5 : Reflect.get(target, key)),
      });
    const alone = createSchemaCompiler("ajv").compile(proxy());
    const compiler = createSchemaCompiler("ajv");
    compiler.compile({ type: "number", minimum: 1 });
    const afterEqual = compiler.compile(proxy());
    for (const value of [0, 2, 6]) expect(afterEqual(value)).toBe(alone(value));
  });

  it("compiles a Proxy schema with the values its get trap returns, as Ajv itself reads them", () => {
    const proxy = () =>
      new Proxy({ type: "number", minimum: 1 } as Record<string, unknown>, {
        get: (target, key) => (key === "minimum" ? 5 : Reflect.get(target, key)),
      });
    const direct = new Ajv().compile(proxy());
    const alone = createSchemaCompiler("ajv").compile(proxy());
    const compiler = createSchemaCompiler("ajv");
    expect(compiler.compile({ type: "number", minimum: 1 })(2)).toBe(true);
    const afterEqual = compiler.compile(proxy());
    expect(direct(2)).toBe(false);
    for (const value of [0, 2, 5, 6]) {
      expect(alone(value)).toBe(direct(value));
      expect(afterEqual(value)).toBe(direct(value));
    }
  });
});

describe("Ajv compilation of Proxy schemas", () => {
  const runtime = process as { getBuiltinModule?: unknown };
  const original = runtime.getBuiltinModule;
  afterEach(() => {
    runtime.getBuiltinModule = original;
    vi.restoreAllMocks();
  });
  // Node's isProxy where available; without it no schema is snapshotted.
  const detections = [
    ["with util.types.isProxy", () => {}],
    ["without util.types.isProxy", () => { runtime.getBuiltinModule = undefined; }],
  ] as const;

  const phantomMinLength = () =>
    new Proxy({ type: "string" } as Record<string, unknown>, {
      get: (target, key) => (key === "minLength" ? 3 : Reflect.get(target, key)),
    });
  const changedMinimum = () =>
    new Proxy({ type: "number", minimum: 1 } as Record<string, unknown>, {
      get: (target, key) => (key === "minimum" ? 5 : Reflect.get(target, key)),
    });
  // Answers 1 on the first read of minimum and 5 on every later read.
  const statefulMinimum = () => {
    let reads = 0;
    return new Proxy({ type: "number", minimum: 1 } as Record<string, unknown>, {
      get: (target, key) => (key === "minimum" ? (reads++ === 0 ? 1 : 5) : Reflect.get(target, key)),
    });
  };
  const phantomDefs = () =>
    new Proxy({ $ref: "#/$defs/x" } as Record<string, unknown>, {
      get: (target, key) =>
        key === "$defs" ? { x: { type: "string", maxLength: 2 } } : Reflect.get(target, key),
    });
  const lazyEmpty = () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => (key === "type" ? "string" : key === "maxLength" ? 2 : undefined),
    });

  it.each(detections)("applies a keyword a Proxy answers without owning it (%s)", (_label, setup) => {
    setup();
    const direct = new Ajv().compile(phantomMinLength());
    expect(direct("a")).toBe(false);
    const compiler = createSchemaCompiler("ajv");
    compiler.compile({ type: "string" });
    const afterPlain = compiler.compile(phantomMinLength());
    const alone = createSchemaCompiler("ajv").compile(phantomMinLength());
    for (const value of ["a", "abc", 1]) {
      expect(alone(value)).toBe(direct(value));
      expect(afterPlain(value)).toBe(direct(value));
    }
  });

  it.each(detections)("applies the value a get trap returns for an owned keyword (%s)", (_label, setup) => {
    setup();
    const direct = new Ajv().compile(changedMinimum());
    expect(direct(2)).toBe(false);
    const compiler = createSchemaCompiler("ajv");
    expect(compiler.compile({ type: "number", minimum: 1 })(2)).toBe(true);
    const afterPlain = compiler.compile(changedMinimum());
    const alone = createSchemaCompiler("ajv").compile(changedMinimum());
    for (const value of [0, 2, 5, 6]) {
      expect(alone(value)).toBe(direct(value));
      expect(afterPlain(value)).toBe(direct(value));
    }
  });

  it.each(detections)("matches direct Ajv for a Proxy over an empty object (%s)", (_label, setup) => {
    setup();
    const direct = new Ajv().compile(lazyEmpty());
    const compiler = createSchemaCompiler("ajv");
    compiler.compile({});
    const afterEmpty = compiler.compile(lazyEmpty());
    const nested = compiler.compile({ type: "object", properties: { v: lazyEmpty() } });
    const directNested = new Ajv().compile({ type: "object", properties: { v: lazyEmpty() } });
    for (const value of ["a", "abc", 1]) {
      expect(afterEmpty(value)).toBe(direct(value));
      expect(nested({ v: value })).toBe(directNested({ v: value }));
    }
  });

  it.each(detections)("matches direct Ajv for a get trap that answers differently per read (%s)", (_label, setup) => {
    setup();
    const direct = new Ajv().compile(statefulMinimum());
    expect(direct(2)).toBe(false);
    const compiler = createSchemaCompiler("ajv");
    compiler.compile({ type: "number", minimum: 1 });
    const afterPlain = compiler.compile(statefulMinimum());
    const alone = createSchemaCompiler("ajv").compile(statefulMinimum());
    for (const value of [0, 2, 5, 6]) {
      expect(alone(value)).toBe(direct(value));
      expect(afterPlain(value)).toBe(direct(value));
    }
  });

  it.each(detections)("resolves a reference into definitions only a get trap answers (%s)", (_label, setup) => {
    setup();
    const direct = new Ajv().compile(phantomDefs());
    const validate = createSchemaCompiler("ajv").compile(phantomDefs());
    for (const value of ["ab", "abc", 1]) expect(validate(value)).toBe(direct(value));
    expect(validate("abc")).toBe(false);
  });

  const plainSchema = () => ({ type: "object", properties: { n: { type: "integer", minimum: 1 } }, required: ["n"] });

  it("compiles equal plain schemas once with util.types.isProxy", () => {
    const compile = vi.spyOn(Ajv.prototype, "compile");
    const compiler = createSchemaCompiler("ajv");
    const first = compiler.compile(plainSchema());
    const second = compiler.compile(plainSchema());
    expect(compile).toHaveBeenCalledTimes(1);
    expect(first({ n: 0 })).toBe(false);
    expect(second({ n: 1 })).toBe(true);
  });

  it("compiles each plain schema from the caller's object without util.types.isProxy", () => {
    runtime.getBuiltinModule = undefined;
    const compile = vi.spyOn(Ajv.prototype, "compile");
    const compiler = createSchemaCompiler("ajv");
    const firstSchema = plainSchema();
    const secondSchema = plainSchema();
    const first = compiler.compile(firstSchema);
    const second = compiler.compile(secondSchema);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[0]?.[0]).toBe(firstSchema);
    expect(compile.mock.calls[1]?.[0]).toBe(secondSchema);
    expect(first({ n: 0 })).toBe(false);
    expect(second({ n: 1 })).toBe(true);
  });
});
