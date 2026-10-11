import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildOperationCatalog, canonicalJson, type Diagnostic, type OperationCatalog } from "../src/index.js";
import { clone, fixture, matchFixture, readJson, reverseKeys, SCHEMAS } from "./helpers.js";

const validateCatalog = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).compile(
  readJson(path.join(SCHEMAS, "operation-catalog.v1.schema.json"))
);

const spec = fixture("catalog/openapi.json");
const manifest = fixture("catalog/manifest.json");
const PROJECT_ROUTE = "/workspaces/{workspaceId}/projects/{projectId}";
const LIST_ROUTE = "/workspaces/{workspaceId}/projects";

/** Literal instance data, where a "$ref" key is data rather than a reference. */
const LITERAL_KEYWORDS = new Set(["default", "const", "enum"]);

/**
 * Closure of a successful catalog: every schema $ref and discriminator
 * mapping target names a schema in catalog.schemas, and every security
 * requirement names a scheme in catalog.securitySchemes.
 */
function closureViolations(catalog: OperationCatalog): string[] {
  const violations: string[] = [];
  const target = (ref: string, at: string) => {
    const name = ref.startsWith("#/components/schemas/") ? ref.slice("#/components/schemas/".length).replace(/~1/g, "/").replace(/~0/g, "~") : null;
    if (name === null || !Object.hasOwn(catalog.schemas, name)) violations.push(`${at} -> ${ref}`);
  };
  const walk = (value: unknown, at: string): void => {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${at}/${index}`));
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (LITERAL_KEYWORDS.has(key)) continue;
      if (key === "$ref" && typeof child === "string") target(child, at);
      else if (key === "discriminator" && child && typeof child === "object" && "mapping" in child) {
        for (const [value, ref] of Object.entries((child as { mapping: Record<string, string> }).mapping)) target(ref, `${at}/discriminator/mapping/${value}`);
      } else walk(child, `${at}/${key}`);
    }
  };
  walk(catalog.operations, "/operations");
  walk(catalog.schemas, "/schemas");
  for (const operation of catalog.operations) {
    for (const term of operation.security.alternatives.flat()) {
      if (!Object.hasOwn(catalog.securitySchemes, term.scheme)) violations.push(`${operation.id} security -> ${term.scheme}`);
    }
  }
  return violations;
}

function build(mutate?: (spec: any, manifest: any) => void) {
  const nextSpec = clone(spec);
  const nextManifest = clone(manifest);
  mutate?.(nextSpec, nextManifest);
  const result = buildOperationCatalog(nextSpec, nextManifest);
  // Every successful catalog must satisfy the published schema and be closed.
  if (result.catalog) {
    expect(validateCatalog(result.catalog), JSON.stringify(validateCatalog.errors)).toBe(true);
    expect(closureViolations(result.catalog)).toEqual([]);
  }
  return result;
}

function only(diagnostics: Diagnostic[], code: Diagnostic["code"]) {
  return diagnostics.filter((diagnostic) => diagnostic.code === code);
}

describe("buildOperationCatalog", () => {
  it("matches the committed catalog fixture and digest vector", () => {
    const result = build();
    expect(result.diagnostics).toEqual([]);
    expect(result.catalog).toEqual(matchFixture("catalog/catalog.json", result.catalog));
    expect(result.digest).toBe(fixture("catalog/release-descriptor.json").catalogDigest);
  });

  it("produces byte-identical output and digests regardless of source key order or input form", () => {
    const first = build();
    const again = build();
    const reordered = buildOperationCatalog(reverseKeys(clone(spec)), reverseKeys(clone(manifest)));
    const fromString = buildOperationCatalog(JSON.stringify(spec, null, 2), clone(manifest));
    for (const other of [again, reordered, fromString]) {
      expect(canonicalJson(other.catalog)).toBe(canonicalJson(first.catalog));
      expect(other.digest).toBe(first.digest);
    }
    expect(reordered.catalog!.source.specDigest).toBe(first.catalog!.source.specDigest);
    expect(reordered.catalog!.source.manifestDigest).toBe(first.catalog!.source.manifestDigest);
  });

  it("normalizes OpenAPI 3.0 documents through @apifn/core to the same catalog", () => {
    const legacy = clone(spec);
    legacy.openapi = "3.0.3";
    legacy.components.schemas.Project.properties.owner = { type: "string", nullable: true };
    legacy.components.schemas.ProjectPage.properties.nextCursor = { type: "string", nullable: true };
    const result = buildOperationCatalog(legacy, clone(manifest));
    expect(result.diagnostics).toEqual([]);
    expect(result.digest).toBe(build().digest);
  });

  it("keeps API identity and stable operation IDs across operationId and name alias changes", () => {
    const base = build().catalog!;
    const renamed = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.operationId = "fetchProject";
    }).catalog!;
    const aliased = build((_spec, nextManifest) => {
      nextManifest.operations.find((binding: any) => binding.id === "projects.get").name = "fetchProject";
    }).catalog!;

    for (const catalog of [renamed, aliased]) {
      expect(catalog.api).toEqual(base.api);
      expect(catalog.operations.map((operation) => operation.id)).toEqual(base.operations.map((operation) => operation.id));
    }
    const get = (catalog: typeof base) => catalog.operations.find((operation) => operation.id === "projects.get")!;
    expect(get(renamed)).toEqual({ ...get(base), openapiOperationId: "fetchProject" });
    expect(get(aliased)).toEqual({ ...get(base), name: "fetchProject" });
  });

  it("keeps inherited path parameters in template order and lets operations override them", () => {
    const get = build().catalog!.operations.find((operation) => operation.id === "projects.get")!;
    expect(get.parameters.map((parameter) => `${parameter.in}:${parameter.name}`)).toEqual([
      "path:workspaceId",
      "path:projectId",
    ]);
    expect(get.parameters[0].schema).toEqual({ type: "string", format: "uuid" });
    expect(get.parameters[1]).toMatchObject({ description: "Project slug or ID", schema: { pattern: "^[a-z0-9-]+$" } });
  });

  it("never derives authorization, idempotency or exposure from method, schema or inclusion", () => {
    const { operations } = build().catalog!;
    const byId = Object.fromEntries(operations.map((operation) => [operation.id, operation]));
    const keys = Object.keys(byId["projects.get"]).sort();
    for (const operation of operations) expect(Object.keys(operation).sort()).toEqual(keys);
    expect(keys.some((key) => /idempot|authoriz|safe|readOnly/i.test(key))).toBe(false);

    // A GET with schemas and default SDK inclusion is still not agent-exposed and has no policy.
    expect(byId["projects.get"]).toMatchObject({ method: "get", sdk: { include: true }, agent: { expose: false }, executionPolicyRef: null });
    // SDK inclusion and agent exposure are independent switches.
    expect(byId["system.health"]).toMatchObject({ sdk: { include: false }, agent: { expose: false } });
    expect(byId["projects.list"]).toMatchObject({ sdk: { include: true }, agent: { expose: true }, executionPolicyRef: "policy.read-only" });
    // Explicit `security: []` is anonymous access, not an elevated grant.
    expect(byId["system.health"].security).toEqual({ alternatives: [[]] });
    expect(byId["projects.create"].security.alternatives).toEqual([
      [{ scheme: "apiKeyAuth", scopes: [] }, { scheme: "bearerAuth", scopes: [] }],
      [{ scheme: "oauth", scopes: ["projects:write"] }],
    ]);
  });
});

describe("catalog diagnostics", () => {
  it("INVALID_SPEC: unreadable documents and undeclared path parameters", () => {
    const unreadable = buildOperationCatalog({ swagger: "2.0", info: {}, paths: {} }, clone(manifest));
    expect(unreadable.catalog).toBeNull();
    expect(only(unreadable.diagnostics, "INVALID_SPEC")[0].message).toMatch(/missing openapi version/);

    const undeclared = build((nextSpec) => {
      nextSpec.paths["/workspaces/{workspaceId}/projects/{projectId}/archive"].parameters.pop();
    });
    expect(only(undeclared.diagnostics, "INVALID_SPEC")[0]).toMatchObject({
      pointer: "/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}~1archive/post",
      operation: "projects.archive",
      message: expect.stringMatching(/"projectId".*not declared/),
    });
  });

  it.each<[string, unknown, unknown, Diagnostic["code"]]>([
    ["a null spec", null, manifest, "INVALID_SPEC"],
    ["a numeric spec", 42, manifest, "INVALID_SPEC"],
    ["an array spec", [], manifest, "INVALID_SPEC"],
    ["a null manifest", spec, null, "INVALID_MANIFEST"],
    ["a string manifest", spec, "manifest", "INVALID_MANIFEST"],
    ["an array manifest", spec, [], "INVALID_MANIFEST"],
  ])("%s fails with a named diagnostic", (_name, nextSpec, nextManifest, code) => {
    const result = buildOperationCatalog(clone(nextSpec) as never, clone(nextManifest));
    expect(result).toEqual({ catalog: null, digest: null, diagnostics: [expect.objectContaining({ code, pointer: "", severity: "error" })] });
  });

  it("INVALID_MANIFEST: rejects misspelled fields instead of ignoring them", () => {
    const result = build((_spec, nextManifest) => {
      nextManifest.operations[4].sdk = { exclude: ["python"] };
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "INVALID_MANIFEST")).toEqual([
      expect.objectContaining({ source: "manifest", pointer: "/operations/4/sdk/exclude", message: expect.stringMatching(/Unknown manifest field "exclude"/) }),
    ]);
  });

  it("MISSING_OPERATION_ID: every spec operation needs a stable binding", () => {
    const result = build((_spec, nextManifest) => {
      nextManifest.operations = nextManifest.operations.filter((binding: any) => binding.id !== "system.health");
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "MISSING_OPERATION_ID")).toEqual([
      expect.objectContaining({ pointer: "/paths/~1health/get", message: expect.stringMatching(/GET \/health \(operationId "getHealth"\).*add a manifest binding/) }),
    ]);
  });

  it("DUPLICATE_OPERATION_ID: repeated stable IDs, double bindings and repeated OpenAPI operationIds", () => {
    const result = build((nextSpec, nextManifest) => {
      nextManifest.operations.push({ id: "projects.get", operationId: "getHealth" });
      nextManifest.operations.push({ id: "projects.fetch", operationId: "getProject" });
      nextSpec.paths[LIST_ROUTE].post.operationId = "listProjects";
    });
    expect(result.catalog).toBeNull();
    const messages = only(result.diagnostics, "DUPLICATE_OPERATION_ID").map((diagnostic) => `${diagnostic.pointer} ${diagnostic.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/operations\/6\/id Stable operation ID "projects.get" is declared more than once/),
        expect.stringMatching(/^\/operations\/7 GET .* is bound by both "projects.get" and "projects.fetch"/),
        expect.stringMatching(/\/post\/operationId OpenAPI operationId "listProjects" is used by both GET .* and POST/),
      ])
    );
  });

  it("UNMATCHED_OPERATION_BINDING: stale bindings are reported", () => {
    const result = build((_spec, nextManifest) => {
      nextManifest.operations.push({ id: "projects.restore", method: "post", path: "/projects/{projectId}/restore" });
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "UNMATCHED_OPERATION_BINDING")).toEqual([
      expect.objectContaining({ pointer: "/operations/6", operation: "projects.restore", message: expect.stringMatching(/POST \/projects\/\{projectId\}\/restore, which is not in the spec/) }),
    ]);
  });

  it("NAME_COLLISION: names that collide across camelCase and snake_case targets", () => {
    const result = build((_spec, nextManifest) => {
      nextManifest.operations.find((binding: any) => binding.id === "projects.archive").name = "get_project";
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "NAME_COLLISION")).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/"projects.archive" and "projects.get" resolve to colliding names "archiveProject"|"projects.get".*"get_project"/) }),
    ]);
  });

  it("UNRESOLVED_REF: missing local targets and unbundled external documents", () => {
    const result = build((nextSpec) => {
      nextSpec.components.schemas.ProjectPage.properties.items.items.$ref = "#/components/schemas/Missing";
      nextSpec.paths[LIST_ROUTE].post.requestBody.content["application/json"].schema = { $ref: "./schemas.yaml#/ProjectInput" };
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "UNRESOLVED_REF").map((diagnostic) => diagnostic.message)).toEqual([
      'Reference "#/components/schemas/Missing" does not resolve to a value in the spec.',
      'External reference "./schemas.yaml#/ProjectInput" is not supported; bundle external documents into the spec before building the catalog.',
    ]);
  });

  it("does not treat example payloads as references or redact schema patterns", () => {
    const result = build((nextSpec) => {
      nextSpec.components.schemas.Project.example.link = { $ref: "#/not/a/reference" };
      nextSpec.components.schemas.ProjectInput.properties.slug.pattern = "^token=[a-z]+$";
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.slug.pattern).toBe("^token=[a-z]+$");
  });

  it("UNKNOWN_SECURITY_SCHEME: requirements must name declared schemes", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.security = [{ sessionCookie: [] }];
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "UNKNOWN_SECURITY_SCHEME")).toEqual([
      expect.objectContaining({ operation: "projects.get", pointer: `/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}/get/security/0/sessionCookie` }),
    ]);
  });

  it("UNSUPPORTED_SERIALIZATION: media types, parameter styles and manifest serialization", () => {
    const result = build((nextSpec, nextManifest) => {
      nextSpec.paths[LIST_ROUTE].get.responses["200"].content = { "application/xml": { schema: { type: "string" } } };
      nextSpec.paths[LIST_ROUTE].get.parameters[0].style = "pipeDelimited";
      nextSpec.paths[PROJECT_ROUTE].get.responses["200"].content["application/xml"] = { schema: { type: "string" } };
      nextManifest.serialization.mediaTypes.push("application/xml");
    });
    expect(result.catalog).toBeNull();
    // A manifest cannot opt into serialization the catalog cannot describe.
    expect(only(result.diagnostics, "UNSUPPORTED_SERIALIZATION")).toEqual([
      expect.objectContaining({ source: "manifest", pointer: "/serialization/mediaTypes/3", severity: "error" }),
    ]);

    const specOnly = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.responses["200"].content = { "application/xml": { schema: { type: "string" } } };
      nextSpec.paths[LIST_ROUTE].get.parameters[0].style = "pipeDelimited";
      nextSpec.paths[PROJECT_ROUTE].get.responses["200"].content["application/xml"] = { schema: { type: "string" } };
    });
    expect(specOnly.catalog).toBeNull();
    expect(only(specOnly.diagnostics, "UNSUPPORTED_SERIALIZATION").map(({ severity, message }) => `${severity}: ${message}`)).toEqual([
      expect.stringMatching(/^error: Parameter "limit" of operation "projects.list" uses style "pipeDelimited"; supported query styles are form, deepObject/),
      // application/xml cannot be listed in the manifest, so only a spec change helps.
      expect.stringMatching(/^error: Response 200 of operation "projects.list" only offers application\/xml; the catalog cannot describe application\/xml, so the spec must also offer one of application\/json/),
      expect.stringMatching(/^warning: Response 200 of operation "projects.get" drops unsupported media types application\/xml/),
    ]);

    const listable = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.responses["200"].content = { "application/octet-stream": { schema: { type: "string" } } };
    });
    expect(only(listable.diagnostics, "UNSUPPORTED_SERIALIZATION").map(({ message }) => message)).toEqual([
      expect.stringMatching(/or add application\/octet-stream to manifest serialization\.mediaTypes\.$/),
    ]);
  });

  it("UNKNOWN_REPLACEMENT: deprecations must point at another catalog operation", () => {
    const result = build((_spec, nextManifest) => {
      nextManifest.operations.find((binding: any) => binding.id === "projects.delete").deprecation.replacement = "projects.restore";
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "UNKNOWN_REPLACEMENT")).toEqual([
      expect.objectContaining({ pointer: "/operations/3/deprecation/replacement", operation: "projects.delete" }),
    ]);
  });

  it("AGENT_POLICY_REQUIRED: agent exposure needs an explicit execution policy", () => {
    const result = build((_spec, nextManifest) => {
      delete nextManifest.operations[0].executionPolicy;
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "AGENT_POLICY_REQUIRED")).toEqual([
      expect.objectContaining({ pointer: "/operations/0/agent/expose", operation: "projects.list" }),
    ]);
  });
});

describe("credential safety", () => {
  const SEEDED = [
    "sk_live_SEEDEDsecret0001",
    "SEEDEDquerykey0002",
    "SEEDED-example-0003",
    "SEEDED-ext-0004",
    "SEEDED-ext-0005",
    "SEEDEDbearer0006abcdef",
    "SEEDED-default-0007",
    "SEEDED-default-0008",
    "SEEDED-header-0009",
    "SEEDED-prov-0010",
    "SEEDED-param-example-0011",
    "SEEDED-client-secret-0012",
  ];

  it("CREDENTIAL_REDACTED: seeded credentials never reach the serialized catalog", () => {
    const result = build((nextSpec, nextManifest) => {
      nextSpec.servers[0].url = `https://svc:${SEEDED[0]}@api.example.test/v1?api_key=${SEEDED[1]}`;
      nextSpec.components.schemas.Project.example.token = SEEDED[2];
      nextSpec.components.securitySchemes.bearerAuth["x-test-token"] = SEEDED[3];
      nextSpec.paths[PROJECT_ROUTE].get["x-internal-key"] = SEEDED[4];
      nextSpec.paths[PROJECT_ROUTE].get.description = `Call with Authorization: Bearer ${SEEDED[5]}`;
      nextSpec.paths[LIST_ROUTE].get.parameters.push({ name: "access_token", in: "query", schema: { type: "string", default: SEEDED[6] } });
      nextSpec.components.schemas.ProjectInput.properties.apiKey = { type: "string", default: SEEDED[7], const: SEEDED[7] };
      nextSpec.paths[LIST_ROUTE].get.parameters.push({ name: "Authorization", in: "header", example: SEEDED[8], schema: { type: "string", default: SEEDED[8] } });
      nextManifest.provenance.source = `https://ci:${SEEDED[9]}@git.example.test/projects.git`;
      nextSpec.paths[LIST_ROUTE].get.parameters[0].example = SEEDED[10];
      nextSpec.components.securitySchemes.oauth.flows.clientCredentials.tokenUrl = `https://auth.example.test/oauth/token?client_secret=${SEEDED[11]}`;
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const serialized = canonicalJson(result) + JSON.stringify(result.diagnostics);
    for (const secret of SEEDED) expect(serialized).not.toContain(secret);

    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => `${diagnostic.source}:${diagnostic.pointer}`)).toEqual([
      "manifest:/provenance/source",
      "spec:/components/schemas/ProjectInput/properties/apiKey/const",
      "spec:/components/schemas/ProjectInput/properties/apiKey/default",
      "spec:/components/securitySchemes/oauth/flows/clientCredentials/tokenUrl",
      "spec:/paths/~1workspaces~1{workspaceId}~1projects/get/parameters/2/schema/default",
      `spec:/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}/get/description`,
      "spec:/servers/0/url",
    ]);
    const catalog = result.catalog!;
    expect(catalog.servers[0].url).toBe("https://api.example.test/v1");
    expect(catalog.source.provenance.source).toBe("https://git.example.test/projects.git");
    const list = catalog.operations.find((operation) => operation.id === "projects.list")!;
    // OpenAPI ignores Authorization header parameters; credentials are modelled by security schemes.
    expect(list.parameters.some((parameter) => parameter.name === "Authorization")).toBe(false);
    expect(list.parameters.find((parameter) => parameter.name === "access_token")!.schema).toEqual({ type: "string" });
  });

  const SECRET = "SEEDEDliteral0013";
  const inputProperties = (nextSpec: any) => nextSpec.components.schemas.ProjectInput.properties;

  it.each<[string, (nextSpec: any) => void]>([
    ["anyOf under a credential property", (nextSpec) => {
      inputProperties(nextSpec).password = { anyOf: [{ type: "string", default: SECRET }, { type: "null" }] };
    }],
    ["oneOf const under a credential property", (nextSpec) => {
      inputProperties(nextSpec).apiKey = { oneOf: [{ const: SECRET }, { type: "string" }] };
    }],
    ["allOf, not and prefixItems under a credential property", (nextSpec) => {
      inputProperties(nextSpec).tokens = { type: "array", prefixItems: [{ allOf: [{ enum: [SECRET] }] }], items: { not: { const: SECRET } } };
    }],
    ["nested properties of a credential object", (nextSpec) => {
      inputProperties(nextSpec).credentials = { type: "object", properties: { value: { type: "string", default: SECRET } } };
    }],
    ["a component schema referenced from a credential property", (nextSpec) => {
      nextSpec.components.schemas.Secret = { type: "string", default: SECRET, examples: [SECRET] };
      inputProperties(nextSpec).token = { $ref: "#/components/schemas/Secret" };
    }],
    ["a component first reached normally, then from a credential property", (nextSpec) => {
      nextSpec.components.schemas.Shared = { type: "object", properties: { label: { type: "string", default: SECRET } } };
      nextSpec.components.schemas.ProjectPage.properties.shared = { $ref: "#/components/schemas/Shared" };
      inputProperties(nextSpec).secretShared = { $ref: "#/components/schemas/Shared" };
    }],
    ["a format: password schema", (nextSpec) => {
      inputProperties(nextSpec).pin = { type: "string", format: "password", default: SECRET };
    }],
    ["anyOf under a credential query parameter", (nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.parameters.push({ name: "api_key", in: "query", schema: { anyOf: [{ type: "string", default: SECRET }] } });
    }],
    ["an object literal with credential-named keys", (nextSpec) => {
      inputProperties(nextSpec).settings = { type: "object", default: { password: SECRET }, enum: [{ nested: { token: SECRET } }] };
    }],
    ["a credential-named server variable", (nextSpec) => {
      nextSpec.servers[0] = { url: "https://{token}.api.example.test", variables: { token: { default: SECRET, enum: [SECRET] } } };
    }],
    ["an unrecognized member holding credential-named keys", (nextSpec) => {
      inputProperties(nextSpec).settings = { type: "object", defaultValue: { password: SECRET } };
    }],
    ["an unrecognized member inside a credential field", (nextSpec) => {
      inputProperties(nextSpec).password = { type: "string", fallback: SECRET };
    }],
  ])("drops seeded literals reached through %s", (_name, mutate) => {
    const result = build((nextSpec) => mutate(nextSpec));
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(SECRET);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").length).toBeGreaterThan(0);
  });

  it("keeps literals of ordinary fields and of components only reached normally", () => {
    const result = build();
    expect((result.catalog!.schemas.ProjectStatus as any).enum).toEqual(["active", "archived"]);
  });

  it.each([
    ["several @ in the authority", "https://x@SEEDEDurl0014@api.example.test/v1", "https://api.example.test/v1"],
    ["user info without a password", "https://SEEDEDurl0014@api.example.test/v1", "https://api.example.test/v1"],
    ["a protocol-relative URL", "//svc:SEEDEDurl0014@api.example.test/v1", "//api.example.test/v1"],
    ["a server URL query and fragment", "https://api.example.test/v1?tenant=SEEDEDurl0014#SEEDEDurl0014", "https://api.example.test/v1"],
  ])("removes URL user info from %s", (_name, url, expected) => {
    const result = build((nextSpec) => {
      nextSpec.servers[0].url = url;
    });
    expect(result.catalog!.servers[0].url).toBe(expected);
    expect(canonicalJson(result)).not.toContain("SEEDEDurl0014");
  });

  it("keeps benign OAuth query parameters while removing credential ones", () => {
    const result = build((nextSpec) => {
      nextSpec.components.securitySchemes.oauth.flows.clientCredentials.tokenUrl =
        "https://auth.example.test/oauth/token?audience=projects&client_secret=SEEDEDurl0015&x=sk_live_SEEDEDurl0016";
    });
    expect(result.catalog!.securitySchemes.oauth.flows!.clientCredentials.tokenUrl).toBe("https://auth.example.test/oauth/token?audience=projects");
    expect(canonicalJson(result)).not.toMatch(/SEEDEDurl001[56]/);
  });

  it("does not redact prose that names an authentication scheme", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.summary = "Requires HTTP Basic authentication";
      nextSpec.paths[PROJECT_ROUTE].get.description = "Send Bearer token-based credentials; Bearer authentication is required.";
    });
    const get = result.catalog!.operations.find((operation) => operation.id === "projects.get")!;
    expect(get.summary).toBe("Requires HTTP Basic authentication");
    expect(get.description).toBe("Send Bearer token-based credentials; Bearer authentication is required.");
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED")).toEqual([]);
  });
});

describe("prototype-safe JSON records", () => {
  const PROTO_SPEC = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string","default":"p"},"constructor":{"type":"integer"},"toString":{"type":"boolean"}}}'
  );

  it("keeps __proto__, constructor and toString property names as data and in the digest", () => {
    const result = build((nextSpec) => {
      nextSpec.components.schemas.ProjectInput.properties.meta = clone(PROTO_SPEC);
    });
    expect(result.diagnostics).toEqual([]);
    const meta = (result.catalog!.schemas.ProjectInput as any).properties.meta;
    expect(Object.keys(meta.properties)).toEqual(["__proto__", "constructor", "toString"]);
    expect(canonicalJson(meta)).toBe(
      '{"properties":{"__proto__":{"default":"p","type":"string"},"constructor":{"type":"integer"},"toString":{"type":"boolean"}},"type":"object"}'
    );
    const without = build((nextSpec) => {
      const meta = clone(PROTO_SPEC);
      delete meta.properties.__proto__;
      nextSpec.components.schemas.ProjectInput.properties.meta = meta;
    });
    expect(without.digest).not.toBe(result.digest);
    expect(without.catalog!.source.specDigest).not.toBe(result.catalog!.source.specDigest);
  });

  it("does not resolve component or security scheme names through Object.prototype", () => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.owner = { $ref: "#/components/schemas/constructor" };
      nextSpec.paths[PROJECT_ROUTE].get.security = [{ toString: [] }];
    });
    expect(result.catalog).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual(["UNKNOWN_SECURITY_SCHEME", "UNRESOLVED_REF"]);
  });
});

const inputSchema = (nextSpec: any) => nextSpec.components.schemas.ProjectInput;

describe("OpenAPI context traversal", () => {
  it.each(["example", "examples", "x-tenant", "default", "$ref"])("checks references under a schema property named %s", (name) => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties[name] = { $ref: "#/components/schemas/Missing" };
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "UNRESOLVED_REF")).toEqual([
      expect.objectContaining({ pointer: `/components/schemas/ProjectInput/properties/${name.replace("/", "~1")}/$ref` }),
    ]);
  });

  it("checks references in headers and components whose names start with x-", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.responses["200"].headers = { "x-request-id": { schema: { $ref: "#/components/schemas/Missing" } } };
      nextSpec.components.parameters["x-tenant"] = { name: "tenant", in: "query", schema: { $ref: "#/components/schemas/Gone" } };
    });
    expect(only(result.diagnostics, "UNRESOLVED_REF").map((diagnostic) => diagnostic.pointer)).toEqual([
      "/components/parameters/x-tenant/schema/$ref",
      "/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}/get/responses/200/headers/x-request-id/schema/$ref",
    ]);
  });

  it("treats $ref-shaped literal data as data", () => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.slug.default = { $ref: "#/not/a/reference" };
      inputSchema(nextSpec).properties.slug.const = { $ref: "#/not/a/reference" };
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.slug.default).toEqual({ $ref: "#/not/a/reference" });
  });

  it("skips extension keys in responses and paths and rejects other non-status response keys", () => {
    const extensions = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.responses["x-meta"] = { description: "not a response" };
      nextSpec.paths["x-internal"] = { get: { responses: {} } };
    });
    expect(extensions.diagnostics).toEqual([]);
    const withoutSpecDigest = (catalog: any) => ({ ...catalog, source: { ...catalog.source, specDigest: null } });
    expect(withoutSpecDigest(extensions.catalog)).toEqual(withoutSpecDigest(build().catalog));

    const invalid = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.responses.ok = { description: "not a status" };
    });
    expect(invalid.catalog).toBeNull();
    expect(only(invalid.diagnostics, "INVALID_SPEC")).toEqual([
      expect.objectContaining({ pointer: "/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}/get/responses/ok", operation: "projects.get" }),
    ]);
  });
});

describe("serialization metadata", () => {
  const FORM = "application/x-www-form-urlencoded";
  const formManifest = (nextManifest: any) => nextManifest.serialization.mediaTypes.push(FORM, "multipart/form-data");
  const formBody = (nextSpec: any, encoding: unknown) => {
    nextSpec.paths[LIST_ROUTE].post.requestBody.content[FORM] = { schema: { $ref: "#/components/schemas/ProjectInput" }, encoding };
  };
  const createBody = (result: ReturnType<typeof build>) =>
    result.catalog!.operations.find((operation) => operation.id === "projects.create")!.requestBody!.contents;

  it("keeps form encoding so explode and allowReserved change the catalog", () => {
    const exploded = build((nextSpec, nextManifest) => {
      formManifest(nextManifest);
      formBody(nextSpec, { tags: { style: "form", explode: true } });
    });
    const joined = build((nextSpec, nextManifest) => {
      formManifest(nextManifest);
      formBody(nextSpec, { tags: { style: "form", explode: false, allowReserved: true, contentType: "text/plain" } });
    });
    expect(exploded.diagnostics).toEqual([]);
    expect(createBody(exploded).find((content) => content.mediaType === FORM)!.encoding).toEqual({
      tags: { contentType: null, style: "form", explode: true, allowReserved: false },
    });
    expect(createBody(joined).find((content) => content.mediaType === FORM)!.encoding).toEqual({
      tags: { contentType: "text/plain", style: "form", explode: false, allowReserved: true },
    });
    expect(exploded.digest).not.toBe(joined.digest);
    expect(createBody(exploded).find((content) => content.mediaType === "application/json")!.encoding).toEqual({});
  });

  it("reports encoding it cannot describe", () => {
    const result = build((nextSpec, nextManifest) => {
      formManifest(nextManifest);
      formBody(nextSpec, { tags: { style: "pipeDelimited" }, name: { headers: { "X-Part": { schema: { type: "string" } } } } });
    });
    expect(only(result.diagnostics, "UNSUPPORTED_SERIALIZATION").map(({ severity, pointer }) => `${severity} ${pointer.split("/").slice(-2).join("/")}`)).toEqual([
      "error tags/style",
      "warning name/headers",
    ]);
  });

  it("keeps parameter allowReserved", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.parameters[0].allowReserved = true;
    });
    const list = result.catalog!.operations.find((operation) => operation.id === "projects.list")!;
    expect(list.parameters.find((parameter) => parameter.name === "limit")!.allowReserved).toBe(true);
    expect(result.digest).not.toBe(build().digest);
  });

  it("resolves media types that normalize to the same value independently of key order", () => {
    const route = (nextSpec: any) => nextSpec.paths[PROJECT_ROUTE].get.responses["200"];
    const variants = {
      "text/plain;charset=utf-8": { schema: { type: "string", maxLength: 10 } },
      "text/plain;charset=us-ascii": { schema: { type: "string", maxLength: 20 } },
      "application/xml": { schema: { type: "string" } },
      "application/yaml": { schema: { type: "string" } },
    };
    const forward = build((nextSpec) => Object.assign(route(nextSpec).content, variants));
    const reversed = build((nextSpec) => Object.assign(route(nextSpec).content, reverseKeys(variants)));
    expect(forward.catalog).toBeNull();
    expect(reversed.diagnostics).toEqual(forward.diagnostics);
    expect(only(forward.diagnostics, "UNSUPPORTED_SERIALIZATION").map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/describes "text\/plain;charset=us-ascii" and "text\/plain;charset=utf-8" differently/),
      expect.stringMatching(/drops unsupported media types application\/xml, application\/yaml; clients use application\/json, application\/problem\+json, text\/plain\.$/),
    ]);

    const same = { "text/plain;charset=utf-8": { schema: { type: "string" } }, "text/plain; charset=us-ascii": { schema: { type: "string" } } };
    const merged = build((nextSpec) => Object.assign(route(nextSpec).content, same));
    const mergedReversed = build((nextSpec) => Object.assign(route(nextSpec).content, reverseKeys(same)));
    expect(merged.diagnostics).toEqual([]);
    expect(mergedReversed.digest).toBe(merged.digest);
  });
});

describe("OpenAPI fields that change client behavior", () => {
  it("keeps server variables and path- or operation-level server overrides", () => {
    const result = build((nextSpec) => {
      nextSpec.servers[0] = { url: "https://{region}.api.example.test/v1", description: "Production", variables: { region: { default: "eu", enum: ["eu", "us"], description: "Data region" } } };
      nextSpec.paths["/health"].servers = [{ url: "https://status.example.test" }];
      nextSpec.paths[PROJECT_ROUTE].get.servers = [{ url: "https://read.example.test/v1", description: "Read replica" }];
    });
    expect(result.diagnostics).toEqual([]);
    const catalog = result.catalog!;
    expect(catalog.servers).toEqual([
      { url: "https://{region}.api.example.test/v1", description: "Production", variables: { region: { default: "eu", enum: ["eu", "us"], description: "Data region" } } },
    ]);
    const byId = Object.fromEntries(catalog.operations.map((operation) => [operation.id, operation]));
    expect(byId["system.health"].servers).toEqual([{ url: "https://status.example.test", description: null, variables: {} }]);
    expect(byId["projects.get"].servers).toEqual([{ url: "https://read.example.test/v1", description: "Read replica", variables: {} }]);
    expect(byId["projects.delete"].servers).toBeNull();
  });

  it.each<[string, string, Record<string, unknown>, string]>([
    ["the whole authority", "https://{authority}/v1", { default: "svc:SEEDEDhost0041@api.example.test", enum: ["svc:SEEDEDhost0041@api.example.test", "api.example.test"] }, "api.example.test"],
    ["the host before a literal domain", "https://{tenant}.example.test/v1", { default: "u:SEEDEDhost0041@eu" }, "eu"],
    ["several @ in one value", "https://{authority}/v1", { default: "a@b:SEEDEDhost0041@api.example.test" }, "api.example.test"],
  ])("removes user info that a server variable puts into %s", (_name, url, variable, host) => {
    const result = build((nextSpec) => {
      nextSpec.servers[0] = { url, variables: { site: variable } };
      nextSpec.servers[0].url = url.replace(/\{[a-z]+\}/, "{site}");
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain("SEEDEDhost0041");
    const site = result.catalog!.servers[0].variables.site;
    expect(site.default).toBe(host);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toContain("/servers/0/variables/site/default");
  });

  it("keeps an @ that a server variable puts into the path", () => {
    const result = build((nextSpec) => {
      nextSpec.servers[0] = { url: "https://api.example.test/{base}", variables: { base: { default: "users/@me", enum: ["users/@me", "v1"] } } };
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.catalog!.servers[0].variables.base).toEqual({ default: "users/@me", enum: ["users/@me", "v1"], description: null });
  });

  // A variable is judged by where the original template uses it: values that fill the user info, query or fragment
  // (which the catalog removes) are dropped, whatever the variable is called.
  const SERVER_SEED = "SEEDEDvar0060";
  const SERVER_POSITIONS: Array<[string, string]> = [
    ["user", "https://{v}:x@api.example.test/v1"],
    ["password", "https://svc:{v}@api.example.test/v1"],
    ["whole user info", "https://{v}@api.example.test/v1"],
    ["user info and path", "https://{v}@api.example.test/{v}"],
    ["query value", "https://api.example.test/v1?api_key={v}"],
    ["fragment", "https://api.example.test/v1#{v}"],
    ["no occurrence", "https://api.example.test/v1"],
  ];
  const SERVER_SCOPES: Array<[string, string, (nextSpec: any, server: unknown) => void]> = [
    ["root", "/servers/0", (nextSpec, server) => { nextSpec.servers = [server]; }],
    ["path", `/paths/${LIST_ROUTE.replace(/\//g, "~1")}/servers/0`, (nextSpec, server) => { nextSpec.paths[LIST_ROUTE].servers = [server]; }],
    ["operation", `/paths/${LIST_ROUTE.replace(/\//g, "~1")}/get/servers/0`, (nextSpec, server) => { nextSpec.paths[LIST_ROUTE].get.servers = [server]; }],
  ];
  const SERVER_CELLS = SERVER_POSITIONS.flatMap(([position, url]) =>
    SERVER_SCOPES.flatMap(([scope, pointer, place]) =>
      (["default", "enum"] as const).map((field) => [position, scope, field, url, pointer, place] as const)
    )
  );

  it.each(SERVER_CELLS)("drops server variable values that fill the %s (%s server, %s)", (_position, _scope, field, url, pointer, place) => {
    const variable = field === "default" ? { default: SERVER_SEED } : { default: "svc", enum: ["svc", SERVER_SEED] };
    const result = build((nextSpec) => place(nextSpec, { url, variables: { v: variable } }));
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(SERVER_SEED);
    const redacted = only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer);
    expect(redacted).toContain(field === "default" ? `${pointer}/variables/v/default` : `${pointer}/variables/v/enum/1`);
  });

  it("keeps the values of a variable used only in the host or path", () => {
    const result = build((nextSpec) => {
      nextSpec.servers = [{ url: "https://{host}/{base}", variables: { host: { default: "api.example.test", enum: ["api.example.test", "eu.example.test"] }, base: { default: "v1" } } }];
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.catalog!.servers[0].variables).toEqual({
      base: { default: "v1", enum: null, description: null },
      host: { default: "api.example.test", enum: ["api.example.test", "eu.example.test"], description: null },
    });
  });

  it("warns that response headers are not described", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.responses["200"].headers = { "X-RateLimit-Remaining": { schema: { type: "integer" } } };
    });
    expect(result.catalog).not.toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_SERIALIZATION", severity: "warning", pointer: `/paths/${LIST_ROUTE.replace(/\//g, "~1")}/get/responses/200/headers` }),
    ]);
  });

  it("INVALID_SPEC: parameters without a usable name or location, and path parameters missing from the template", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.parameters.push({ name: "filter", in: "body", schema: { type: "string" } });
      nextSpec.paths[PROJECT_ROUTE].get.parameters = [{ name: "version", in: "path", required: true, schema: { type: "string" } }];
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "INVALID_SPEC").map(({ operation, message }) => `${operation} ${message}`)).toEqual([
      expect.stringMatching(/^projects.list Parameter at .* needs a name and an "in" of path, query, header, cookie/),
      expect.stringMatching(/^projects.get Path parameter "version" .* does not appear in the path template/),
    ]);
  });
});

describe("credential fields from declared apiKey schemes", () => {
  const SECRET = "SEEDEDapikey0020";
  const listParameters = (nextSpec: any) => nextSpec.paths[LIST_ROUTE].get.parameters;

  it.each<[string, Record<string, unknown>, (nextSpec: any, parameter: Record<string, unknown>) => void]>([
    ["a header parameter, matched case-insensitively", { type: "apiKey", in: "header", name: "X-Auth" }, (nextSpec, parameter) => {
      listParameters(nextSpec).push({ ...parameter, name: "x-auth", in: "header" });
    }],
    ["a cookie parameter", { type: "apiKey", in: "cookie", name: "sid" }, (nextSpec, parameter) => {
      listParameters(nextSpec).push({ ...parameter, name: "sid", in: "cookie" });
    }],
    ["a query parameter", { type: "apiKey", in: "query", name: "key" }, (nextSpec, parameter) => {
      listParameters(nextSpec).push({ ...parameter, name: "key", in: "query" });
    }],
    ["a path-level parameter", { type: "apiKey", in: "query", name: "key" }, (nextSpec, parameter) => {
      nextSpec.paths[LIST_ROUTE].parameters.push({ ...parameter, name: "key", in: "query" });
    }],
    ["a component parameter reached by $ref", { type: "apiKey", in: "query", name: "key" }, (nextSpec, parameter) => {
      nextSpec.components.parameters.Key = { ...parameter, name: "key", in: "query" };
      listParameters(nextSpec).push({ $ref: "#/components/parameters/Key" });
    }],
  ])("drops literals of %s", (_name, scheme, addParameter) => {
    const parameter = { schema: { anyOf: [{ type: "string", default: SECRET, enum: [SECRET] }] } };
    const withScheme = build((nextSpec) => {
      nextSpec.components.securitySchemes.custom = scheme;
      addParameter(nextSpec, parameter);
    });
    expect(withScheme.catalog).not.toBeNull();
    expect(canonicalJson(withScheme)).not.toContain(SECRET);
    expect(only(withScheme.diagnostics, "CREDENTIAL_REDACTED").length).toBeGreaterThan(0);

    // Without the scheme declaration the same parameter is ordinary data.
    const withoutScheme = build((nextSpec) => addParameter(nextSpec, parameter));
    expect(canonicalJson(withoutScheme.catalog)).toContain(SECRET);
  });
});

describe("author strings copied into the catalog", () => {
  it.each<[string, (nextSpec: any) => void, string]>([
    ["tags", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.tags.push("token=SEEDEDtag0021");
    }, "SEEDEDtag0021"],
    ["security scheme bearerFormat", (nextSpec) => {
      nextSpec.components.securitySchemes.bearerAuth.bearerFormat = "Bearer SEEDEDformat0022";
    }, "SEEDEDformat0022"],
  ])("redacts credentials in the text of %s", (_name, mutate, secret) => {
    const result = build(mutate);
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(secret);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").length).toBeGreaterThan(0);
  });

  const ID_SECRET = "sk_live_SEEDEDident0030";
  const GET = "/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}/get";

  it.each<[string, (nextSpec: any, nextManifest: any) => void, string]>([
    ["an OpenAPI operationId", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.operationId = ID_SECRET;
    }, `${GET}/operationId`],
    ["a path template", (nextSpec, nextManifest) => {
      nextSpec.paths[`/token=${ID_SECRET}`] = { get: { operationId: "probe", responses: { "200": { description: "ok" } } } };
      nextManifest.operations.push({ id: "probe.get", operationId: "probe" });
    }, `/paths/~1token=${ID_SECRET}`],
    ["a parameter name", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.parameters.push({ name: ID_SECRET, in: "query", schema: { type: "string" } });
    }, `${GET}/parameters/1/name`],
    ["a property name", (nextSpec) => {
      inputSchema(nextSpec).properties[`token=${ID_SECRET}`] = { type: "string" };
    }, `/components/schemas/ProjectInput/properties/token=${ID_SECRET}`],
    ["a discriminator mapping value", (nextSpec) => {
      inputSchema(nextSpec).discriminator = { propertyName: "name", mapping: { [`token=${ID_SECRET}`]: "Project" } };
    }, `/components/schemas/ProjectInput/discriminator/mapping/token=${ID_SECRET}`],
    ["a security scheme name", (nextSpec) => {
      nextSpec.components.securitySchemes[ID_SECRET] = { type: "http", scheme: "basic" };
    }, `/components/securitySchemes/${ID_SECRET}`],
    ["an apiKey scheme parameter name", (nextSpec) => {
      nextSpec.components.securitySchemes.apiKeyAuth.name = ID_SECRET;
    }, "/components/securitySchemes/apiKeyAuth/name"],
    ["an OAuth scope name", (nextSpec) => {
      nextSpec.components.securitySchemes.oauth.flows.clientCredentials.scopes[ID_SECRET] = "x";
    }, `/components/securitySchemes/oauth/flows/clientCredentials/scopes/${ID_SECRET}`],
    ["a security requirement scope", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.security = [{ oauth: [ID_SECRET] }];
    }, `${GET}/security/0/oauth/0`],
  ])("INVALID_SPEC: a credential in %s is rejected, not copied", (_name, mutate, pointer) => {
    const result = build(mutate);
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "INVALID_SPEC")).toContainEqual(
      expect.objectContaining({ pointer: pointer.replace(ID_SECRET, "[REDACTED]").replace(`token=[REDACTED]`, "token=[REDACTED]") })
    );
    expect(JSON.stringify(result)).not.toContain("SEEDEDident0030");
  });

  it("keeps namespaced scope names such as secrets:read", () => {
    const result = build((nextSpec) => {
      nextSpec.components.securitySchemes.oauth.flows.clientCredentials.scopes["secrets:read"] = "Read secrets";
      nextSpec.paths[PROJECT_ROUTE].get.security = [{ oauth: ["secrets:read"] }];
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.catalog!.securitySchemes.oauth.flows!.clientCredentials.scopes).toContain("secrets:read");
  });

  it("INVALID_MANIFEST: a credential in a manifest identifier", () => {
    const result = build((_spec, nextManifest) => {
      nextManifest.operations[0].name = ID_SECRET;
    });
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "INVALID_MANIFEST", pointer: "/operations/0/name" })]);
    expect(JSON.stringify(result)).not.toContain("SEEDEDident0030");
  });

  it("drops a schema pattern that holds a credential and keeps ordinary patterns", () => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.pin = { type: "string", format: "password", pattern: `^${ID_SECRET}$` };
      inputSchema(nextSpec).properties.slug2 = { type: "string", pattern: "^Bearer [A-Za-z0-9._~+/-]+=*$" };
    });
    expect(result.catalog).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain("SEEDEDident0030");
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED")).toEqual([
      expect.objectContaining({ pointer: "/components/schemas/ProjectInput/properties/pin/pattern" }),
    ]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.slug2.pattern).toBe("^Bearer [A-Za-z0-9._~+/-]+=*$");
  });

  // A pattern can spell the credential in any regex syntax, so a credential field carries none.
  const PATTERN_FORMS = ["^hunter2SEEDx9$", "^(hunter2SEEDx9)$", "^hunter2SEEDx9{1}$", "^(?:hunter2SEEDx9)$", "^[h]unter2SEEDx9$", "^hunter2SEEDx9|hunter2SEEDx9$", "^[0-9]{6}$"];
  const CREDENTIAL_FIELDS: Array<[string, (nextSpec: any, pattern: string) => string]> = [
    ["a credential-named property", (nextSpec, pattern) => {
      inputSchema(nextSpec).properties.password = { type: "string", pattern };
      return "/components/schemas/ProjectInput/properties/password/pattern";
    }],
    ["a format: password property", (nextSpec, pattern) => {
      inputSchema(nextSpec).properties.pin = { type: "string", format: "password", pattern };
      return "/components/schemas/ProjectInput/properties/pin/pattern";
    }],
    ["an apiKey query parameter", (nextSpec, pattern) => {
      nextSpec.components.securitySchemes.custom = { type: "apiKey", in: "query", name: "key" };
      nextSpec.paths[LIST_ROUTE].get.parameters.push({ name: "key", in: "query", schema: { type: "string", pattern } });
      return "/paths/~1workspaces~1{workspaceId}~1projects/get/parameters/2/schema/pattern";
    }],
  ];
  const PATTERN_MATRIX = CREDENTIAL_FIELDS.flatMap(([field, add]) => PATTERN_FORMS.map((pattern) => ({ name: `${field}: ${pattern}`, add, pattern })));

  it.each(PATTERN_MATRIX)("drops every pattern of $name", ({ add, pattern }) => {
    let pointer = "";
    const result = build((nextSpec) => {
      pointer = add(nextSpec, pattern);
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain("hunter2");
    expect(canonicalJson(result.catalog)).not.toContain(JSON.stringify(pattern).slice(1, -1));
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED")).toEqual([expect.objectContaining({ pointer })]);
  });

  it.each(PATTERN_FORMS)("keeps %s on an ordinary field", (pattern) => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.kind = { type: "string", pattern };
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.kind.pattern).toBe(pattern);
  });

  it("reports unparseable documents by line and column without quoting source text", () => {
    const yaml = 'openapi: 3.1.0\ninfo:\n  title: x\n  password: "SEEDEDyaml0025\n paths: [';
    const result = buildOperationCatalog(yaml, clone(manifest));
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "INVALID_SPEC", message: expect.stringMatching(/^Cannot parse the OpenAPI document as JSON or YAML \(line \d+, column \d+\)\.$/) })]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("SEEDEDyaml0025");
  });
});

describe("literal instance data", () => {
  it("copies default, const, enum and property-name maps verbatim, x- keys included", () => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.mode = {
        type: "object",
        const: { "x-a": 1 },
        default: { "x-mode": "fast", nested: { "x-b": [{ "x-c": true }] } },
        enum: [{ "x-mode": "fast" }],
        dependentRequired: { "x-tenant": ["region"], password: ["user"] },
        required: ["password"],
        xml: { name: "mode", "x-ext": 1 },
        "x-ext": 1,
      };
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.mode).toEqual({
      type: "object",
      const: { "x-a": 1 },
      default: { "x-mode": "fast", nested: { "x-b": [{ "x-c": true }] } },
      enum: [{ "x-mode": "fast" }],
      dependentRequired: { "x-tenant": ["region"], password: ["user"] },
      required: ["password"],
      xml: { name: "mode" },
    });
  });
});

describe("property-name references", () => {
  const named = (nextSpec: any, name: string) => {
    inputSchema(nextSpec).properties = { [name]: { type: "string" }, region: { type: "string" } };
    inputSchema(nextSpec).required = [name];
    inputSchema(nextSpec).dependentRequired = { region: [name], [name]: ["region"] };
    inputSchema(nextSpec).additionalProperties = false;
  };

  it("copies required and dependentRequired names verbatim, so they still match properties", () => {
    const result = build((nextSpec) => named(nextSpec, "secrets:read"));
    expect(result.diagnostics).toEqual([]);
    const schema = result.catalog!.schemas.ProjectInput as any;
    expect(Object.keys(schema.properties)).toEqual(["region", "secrets:read"]);
    expect(schema.required).toEqual(["secrets:read"]);
    expect(schema.dependentRequired).toEqual({ region: ["secrets:read"], "secrets:read": ["region"] });
  });

  it.each<[string, (nextSpec: any) => void, string[]]>([
    ["required", (nextSpec) => {
      inputSchema(nextSpec).required = ["token=SEEDEDname0040"];
    }, ["/components/schemas/ProjectInput/required/0"]],
    ["a dependentRequired key", (nextSpec) => {
      inputSchema(nextSpec).dependentRequired = { "token=SEEDEDname0040": ["name"] };
    }, ["/components/schemas/ProjectInput/dependentRequired/token=[REDACTED]"]],
    ["a dependentRequired value", (nextSpec) => {
      inputSchema(nextSpec).dependentRequired = { name: ["token=SEEDEDname0040"] };
    }, ["/components/schemas/ProjectInput/dependentRequired/name/0"]],
  ])("INVALID_SPEC: a credential in %s is rejected, never rewritten", (_name, mutate, pointers) => {
    const result = build(mutate);
    expect(result.catalog).toBeNull();
    expect(canonicalJson(result)).not.toContain("SEEDEDname0040");
    expect(only(result.diagnostics, "INVALID_SPEC").map((diagnostic) => diagnostic.pointer)).toEqual(pointers);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED")).toEqual([]);
  });
});

describe("security requirements", () => {
  it.each<[string, unknown, string]>([
    ["a null requirement", [null], "/security/0"],
    ["a scope string instead of an array", [{ oauth: "projects:write" }], "/security/0/oauth"],
    ["non-string scopes", [{ oauth: ["projects:write", 7] }], "/security/0/oauth"],
    ["a security object instead of an array", { oauth: [] }, "/security"],
  ])("INVALID_SPEC: %s never becomes anonymous access or empty scopes", (_name, security, suffix) => {
    const result = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.security = security;
    });
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "INVALID_SPEC", operation: "projects.get", pointer: `/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}/get${suffix}` }),
    ]);
  });

  it("keeps an explicit empty requirement as the anonymous alternative", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.security = [{}, { oauth: ["projects:read"] }];
    });
    const get = result.catalog!.operations.find((operation) => operation.id === "projects.get")!;
    expect(get.security.alternatives).toEqual([[], [{ scheme: "oauth", scopes: ["projects:read"] }]]);
  });
});

describe("component schema closure", () => {
  const pets = (nextSpec: any, mapping: Record<string, string>) => {
    Object.assign(nextSpec.components.schemas, {
      Pet: { type: "object", discriminator: { propertyName: "petType", mapping }, properties: { petType: { type: "string" } } },
      Dog: { allOf: [{ $ref: "#/components/schemas/Pet" }, { type: "object", properties: { bark: { type: "boolean" } } }] },
      Cat: { allOf: [{ $ref: "#/components/schemas/Pet" }] },
    });
    inputSchema(nextSpec).properties.pet = { $ref: "#/components/schemas/Pet" };
  };

  it("emits discriminator mapping targets as component references and includes their schemas", () => {
    const result = build((nextSpec) => pets(nextSpec, { dog: "#/components/schemas/Dog", cat: "Cat" }));
    expect(result.diagnostics).toEqual([]);
    const { schemas } = result.catalog!;
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining(["Cat", "Dog", "Pet"]));
    expect((schemas.Pet as any).discriminator).toEqual({
      propertyName: "petType",
      mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
    });
  });

  it.each([
    ["a missing mapping target", { ghost: "#/components/schemas/Missing" }, "/components/schemas/Pet/discriminator/mapping/ghost"],
    ["a mapping target outside components.schemas", { dog: "#/components/schemas/Dog/allOf/1" }, "/components/schemas/Pet/discriminator/mapping/dog"],
  ])("UNRESOLVED_REF: %s", (_name, mapping, pointer) => {
    const result = build((nextSpec) => pets(nextSpec, mapping));
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "UNRESOLVED_REF", pointer })]);
  });

  it.each([
    ["a percent-encoded tilde escape", "#/components/schemas/a%7E1b", "a/b", "#/components/schemas/a~1b"],
    ["a percent-encoded name", "#/components/schemas/Pro%6Aect", "Project", "#/components/schemas/Project"],
    ["an escaped tilde", "#/components/schemas/a~0b", "a~b", "#/components/schemas/a~0b"],
  ])("emits a schema reference through %s in normal form", (_name, ref, name, normal) => {
    const result = build((nextSpec) => {
      nextSpec.components.schemas[name] ??= { type: "string" };
      inputSchema(nextSpec).properties.z = { $ref: ref };
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.z).toEqual({ $ref: normal });
    expect(Object.hasOwn(result.catalog!.schemas, name)).toBe(true);
  });

  it("UNRESOLVED_REF: a schema reference into a component instead of to it", () => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.owner = { $ref: "#/components/schemas/Project/properties/id" };
    });
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "UNRESOLVED_REF", pointer: "/components/schemas/ProjectInput/properties/owner/$ref" }),
    ]);
  });
});

describe("catalog output conformance", () => {
  it("INVALID_MANIFEST: a derived name longer than the catalog allows needs a manifest name", () => {
    const longId = `list${"x".repeat(125)}`;
    const rebind = (nextSpec: any, nextManifest: any) => {
      nextSpec.paths[LIST_ROUTE].get.operationId = longId;
      nextManifest.operations.find((binding: any) => binding.id === "projects.list").operationId = longId;
    };
    const derived = build(rebind);
    expect(derived.catalog).toBeNull();
    expect(derived.diagnostics).toEqual([
      expect.objectContaining({ code: "INVALID_MANIFEST", source: "manifest", operation: "projects.list", message: expect.stringMatching(/129 characters.*set a shorter manifest name/) }),
    ]);

    const named = build((nextSpec, nextManifest) => {
      rebind(nextSpec, nextManifest);
      nextManifest.operations.find((binding: any) => binding.id === "projects.list").name = "listProjects";
    });
    expect(named.diagnostics).toEqual([]);
  });
});

describe("malformed object targets", () => {
  const GET = "/paths/~1workspaces~1{workspaceId}~1projects~1{projectId}/get";

  it.each<[string, (nextSpec: any) => void, Diagnostic["code"], string]>([
    ["a referenced component schema that is null", (nextSpec) => {
      nextSpec.components.schemas.ProjectInput = null;
    }, "UNRESOLVED_REF", `/paths/~1workspaces~1{workspaceId}~1projects/post/requestBody/content/application~1json/schema/$ref`],
    ["a property schema that is null", (nextSpec) => {
      inputSchema(nextSpec).properties.broken = null;
    }, "INVALID_SPEC", "/components/schemas/ProjectInput/properties/broken"],
    ["a security scheme without a type", (nextSpec) => {
      delete nextSpec.components.securitySchemes.bearerAuth.type;
    }, "INVALID_SPEC", "/components/securitySchemes/bearerAuth/type"],
    ["a referenced component response that is null", (nextSpec) => {
      nextSpec.components.responses.NotFound = null;
    }, "UNRESOLVED_REF", `${GET}/responses/404/$ref`],
    ["a parameter reference to a string", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.parameters.push({ $ref: "#/info/title" });
    }, "UNRESOLVED_REF", `${GET}/parameters/1/$ref`],
    ["a null parameter", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.parameters.push(null);
    }, "INVALID_SPEC", `${GET}/parameters/1`],
    ["a response reference to a string", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.responses["200"] = { $ref: "#/info/title" };
    }, "UNRESOLVED_REF", `${GET}/responses/200/$ref`],
    ["a null media type", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.responses["200"].content["application/json"] = null;
    }, "INVALID_SPEC", `${GET}/responses/200/content/application~1json`],
    ["a null OAuth flow", (nextSpec) => {
      nextSpec.components.securitySchemes.oauth.flows.clientCredentials = null;
    }, "INVALID_SPEC", "/components/securitySchemes/oauth/flows/clientCredentials"],
    ["a non-string tag", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.tags.push(7);
    }, "INVALID_SPEC", `${GET}/tags/1`],
  ])("%s is reported, never dropped silently", (_name, mutate, code, pointer) => {
    const result = build(mutate);
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code, pointer }));
  });
});

// Every member the catalog reads, set to a value of the wrong type: a present
// container or flag of the wrong type is reported, never replaced by a default.
const WRONG_TYPED_MEMBERS: Array<[pointer: string, value: unknown]> = [
  ["/info/title", 7],
  ["/servers", { url: "https://other.example.test" }],
  ["/servers/0/description", 7],
  ["/servers/0/variables", []],
  ["/components", []],
  ["/components/schemas", []],
  ["/components/securitySchemes", "bearerAuth"],
  [`/paths/${escape(LIST_ROUTE)}/get/responses`, null],
  [`/paths/${escape(LIST_ROUTE)}/get/responses`, []],
  [`/paths/${escape(LIST_ROUTE)}/get/responses/200/description`, 7],
  [`/paths/${escape(LIST_ROUTE)}/get/responses/200/content`, "application/json"],
  [`/paths/${escape(LIST_ROUTE)}/get/responses/200/headers`, []],
  [`/paths/${escape(LIST_ROUTE)}/get`, []],
  [`/paths/${escape(LIST_ROUTE)}/get`, null],
  [`/paths/${escape(LIST_ROUTE)}/get`, 1],
  [`/paths/${escape(LIST_ROUTE)}/get`, "x"],
  [`/paths/${escape(LIST_ROUTE)}/get/responses/200/content/application~1json/encoding`, []],
  [`/paths/${escape(LIST_ROUTE)}/post/requestBody/content`, []],
  [`/paths/${escape(LIST_ROUTE)}/post/requestBody/required`, "yes"],
  [`/paths/${escape(PROJECT_ROUTE)}/servers`, "https://other.example.test"],
  [`/paths/${escape(PROJECT_ROUTE)}/get/servers`, { url: "https://other.example.test" }],
  [`/paths/${escape(PROJECT_ROUTE)}/get/tags`, "projects"],
  [`/paths/${escape(PROJECT_ROUTE)}/get/deprecated`, "yes"],
  [`/paths/${escape(PROJECT_ROUTE)}/get/operationId`, 7],
  [`/paths/${escape(PROJECT_ROUTE)}/get/summary`, ["Get"]],
  [`/paths/${escape(PROJECT_ROUTE)}/get/parameters/0/required`, "true"],
  [`/paths/${escape(PROJECT_ROUTE)}/get/parameters/0/style`, 7],
  [`/paths/${escape(PROJECT_ROUTE)}/get/parameters/0/explode`, "no"],
  [`/paths/${escape(PROJECT_ROUTE)}/get/parameters/0/allowReserved`, 1],
  [`/paths/${escape(PROJECT_ROUTE)}/get/parameters/0/description`, 7],
  ["/components/schemas/ProjectInput/properties", []],
  ["/components/schemas/ProjectInput/required", "name"],
  ["/components/schemas/ProjectInput/allOf", {}],
  ["/components/schemas/ProjectInput/dependentRequired", []],
  ["/components/schemas/Project/discriminator", "status"],
  ["/components/securitySchemes/apiKeyAuth/name", 7],
  ["/components/securitySchemes/bearerAuth/bearerFormat", 7],
  ["/components/securitySchemes/oauth/flows/clientCredentials/scopes", []],
  ["/components/securitySchemes/oauth/flows/clientCredentials/tokenUrl", 7],
];

function escape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function setAt(document: any, pointer: string, value: unknown): void {
  const segments = pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const parent = segments.slice(0, -1).reduce((node, segment) => node[segment], document);
  parent[segments[segments.length - 1]] = value;
}

describe("wrong-typed members", () => {
  it.each(WRONG_TYPED_MEMBERS)("INVALID_SPEC: %s = %j", (pointer, value) => {
    const result = build((nextSpec) => setAt(nextSpec, pointer, value));
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_SPEC", pointer }));
  });

  it.each([[[]], [null], [1], ["x"]])("INVALID_SPEC: an unbound operation %j is reported, never skipped", (value) => {
    const result = buildOperationCatalog(
      { openapi: "3.1.0", info: { title: "T", version: "1" }, paths: { "/a": { get: value } } },
      { manifestVersion: 1, api: { id: "t", version: "1" }, operations: [] }
    );
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "INVALID_SPEC", pointer: "/paths/~1a/get" })]);
  });

  it("UNRESOLVED_REF: a schema reference reached through a parameter outside components", () => {
    const result = build((nextSpec) => {
      nextSpec["x-param"] = { name: "q", in: "query", schema: { $ref: "#/components/schemas/Missing" } };
      nextSpec.paths[PROJECT_ROUTE].get.parameters.push({ $ref: "#/x-param" });
    });
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "UNRESOLVED_REF", pointer: "/x-param/schema/$ref" }));
  });
});

describe("header parameter names", () => {
  it("merges path- and operation-level headers case-insensitively, operation level winning", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].parameters.push({ name: "X-Trace", in: "header", schema: { type: "string" } });
      nextSpec.paths[LIST_ROUTE].get.parameters.push({ name: "x-trace", in: "header", schema: { type: "integer" } });
    });
    const list = result.catalog!.operations.find((operation) => operation.id === "projects.list")!;
    expect(list.parameters.filter((parameter) => parameter.in === "header")).toEqual([
      expect.objectContaining({ name: "x-trace", schema: { type: "integer" } }),
    ]);
  });

  it("INVALID_SPEC: the same header twice at one level, in any case", () => {
    const result = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.parameters.push({ name: "X-A", in: "header" }, { name: "x-a", in: "header" });
    });
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "INVALID_SPEC", message: expect.stringMatching(/"x-a" in header is declared twice/) })]);
  });
});
