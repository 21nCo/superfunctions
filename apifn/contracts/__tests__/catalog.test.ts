import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildOperationCatalog, canonicalJson, type Diagnostic, type OperationCatalog } from "../src/index.js";
import { clone, fixture, LINEAR_RATIO, matchFixture, readJson, reverseKeys, SCALING_TIMEOUT, scalingRatio, SCHEMAS } from "./helpers.js";

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
const REFERENCE_KEYWORDS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);

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
      if (REFERENCE_KEYWORDS.has(key) && typeof child === "string") target(child, at);
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

  it.each([
    ["a literal", '{"type":"object","default":{"__proto__":"x","a":1}}', "default"],
    ["a property name", '{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"string"}}}', "properties"],
  ])("keeps a __proto__ key in %s of an OpenAPI 3.0 document as 3.1 does", (_name, schema, member) => {
    const versioned = (version: string) =>
      build((nextSpec) => {
        nextSpec.openapi = version;
        inputSchema(nextSpec).properties.meta = JSON.parse(schema);
      });
    const legacy = versioned("3.0.3");
    expect(legacy.diagnostics).toEqual([]);
    expect(Object.keys((legacy.catalog!.schemas.ProjectInput as any).properties.meta[member])).toEqual(["__proto__", "a"]);
    expect(canonicalJson(legacy)).toBe(canonicalJson(versioned("3.1.0")));
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

  // Media type parameters other than charset=utf-8 change the bytes on the wire, so they are never dropped silently.
  it.each<[string, Record<string, unknown>, string, string]>([
    ["request", { "application/json; charset=utf-16": { schema: { type: "object" } } }, "requestBody", "only offers"],
    ["response", { "application/json;charset=ISO-8859-1": { schema: { type: "object" } } }, "responses/200", "only offers"],
    [
      "response next to the same schema without parameters",
      { "application/json": { schema: { type: "object" } }, "application/json; charset=utf-16": { schema: { type: "object" } } },
      "responses/200",
      "drops unsupported media types",
    ],
  ])("UNSUPPORTED_SERIALIZATION: a charset other than utf-8 in a %s", (place, content, at, phrase) => {
    const result = build((nextSpec) => {
      const operation = nextSpec.paths[LIST_ROUTE].get;
      if (place === "request") operation.requestBody = { content };
      else operation.responses["200"].content = content;
    });
    const reported = only(result.diagnostics, "UNSUPPORTED_SERIALIZATION");
    expect(reported).toEqual([expect.objectContaining({ pointer: `/paths/${LIST_ROUTE.replace(/\//g, "~1")}/get/${at}/content` })]);
    expect(reported[0].message).toContain(phrase);
    expect(reported[0].message).toContain("charset=utf-8");
    expect(result.catalog === null).toBe(phrase === "only offers");
    if (result.catalog) {
      const response = result.catalog.operations.find((operation) => operation.id === "projects.list")!.responses.find((entry) => entry.status === "200")!;
      expect(response.contents.map((entry) => entry.mediaType)).toEqual(["application/json"]);
    }
  });

  it("UNSUPPORTED_SERIALIZATION: a manifest media type with parameters", () => {
    const result = build((_nextSpec, nextManifest) => {
      nextManifest.serialization.mediaTypes.push("text/plain; charset=iso-8859-1");
    });
    expect(result.catalog).toBeNull();
    expect(only(result.diagnostics, "UNSUPPORTED_SERIALIZATION")).toEqual([expect.objectContaining({ source: "manifest", pointer: "/serialization/mediaTypes/3" })]);
  });

  it("resolves media types that normalize to the same value independently of key order", () => {
    const route = (nextSpec: any) => nextSpec.paths[PROJECT_ROUTE].get.responses["200"];
    const variants = {
      "text/plain;charset=utf-8": { schema: { type: "string", maxLength: 10 } },
      "Text/Plain": { schema: { type: "string", maxLength: 20 } },
      "application/xml": { schema: { type: "string" } },
      "application/yaml": { schema: { type: "string" } },
    };
    const forward = build((nextSpec) => Object.assign(route(nextSpec).content, variants));
    const reversed = build((nextSpec) => Object.assign(route(nextSpec).content, reverseKeys(variants)));
    expect(forward.catalog).toBeNull();
    expect(reversed.diagnostics).toEqual(forward.diagnostics);
    expect(only(forward.diagnostics, "UNSUPPORTED_SERIALIZATION").map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/describes "Text\/Plain" and "text\/plain;charset=utf-8" differently/),
      expect.stringMatching(/drops unsupported media types application\/xml, application\/yaml; clients use application\/json, application\/problem\+json, text\/plain\.$/),
    ]);

    const same = { "text/plain;charset=utf-8": { schema: { type: "string" } }, "text/plain; charset=\"UTF-8\"": { schema: { type: "string" } } };
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

  // Values are judged together: variables that only jointly form user info, a query or a fragment are hidden as a group.
  const COMPOSED_SEED = "SEEDEDjoin0070";
  const COMPOSITIONS: Array<[string, string, (field: "default" | "enum") => Record<string, unknown>, string[]]> = [
    ["prefix+suffix user info", "https://{prefix}{suffix}/v1", (field) => ({
      prefix: field === "default" ? { default: `svc:${COMPOSED_SEED}` } : { default: "api", enum: ["api", `svc:${COMPOSED_SEED}`] },
      suffix: { default: "@api.example.test" },
    }), ["prefix", "suffix"]],
    ["host carrying ?key=", "https://{host}/{p}", (field) => ({
      host: { default: "api.example.test?api_key=" },
      p: field === "default" ? { default: COMPOSED_SEED } : { default: "v1", enum: ["v1", COMPOSED_SEED] },
    }), ["host", "p"]],
    ["host carrying #", "https://{host}/{p}", (field) => ({
      host: { default: "api.example.test#" },
      p: field === "default" ? { default: COMPOSED_SEED } : { default: "v1", enum: ["v1", COMPOSED_SEED] },
    }), ["host", "p"]],
  ];
  const COMPOSED_CELLS = COMPOSITIONS.flatMap(([composition, url, variables, hidden]) =>
    SERVER_SCOPES.flatMap(([scope, pointer, place]) =>
      (["default", "enum"] as const).map((field) => [composition, scope, field, url, variables(field), hidden, pointer, place] as const)
    )
  );

  it.each(COMPOSED_CELLS)("hides server variables that together fill %s (%s server, %s)", (_composition, _scope, _field, url, variables, hidden, pointer, place) => {
    const result = build((nextSpec) => place(nextSpec, { url, variables }));
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(COMPOSED_SEED);
    const redacted = only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer);
    for (const name of hidden) expect(redacted).toContain(`${pointer}/variables/${name}/default`);
  });

  // Every combination of declared values is judged: one variable's scheme and another's user info meet only there.
  const JOINT_SEED = "SEEDEDcombo0083";
  const JOINT_CELLS = SERVER_SCOPES.flatMap(([scope, pointer, place]) =>
    (["default", "enum"] as const).map((field) => [scope, field, pointer, place] as const)
  );

  it.each(JOINT_CELLS)("hides variables whose enum values only jointly form user info (%s server, %s)", (_scope, field, pointer, place) => {
    const authority = `svc:${JOINT_SEED}@api.example.test`;
    const variables = field === "default"
      ? { base: { default: "/", enum: ["/", "https://"] }, authority: { default: authority, enum: [authority, "api.example.test"] } }
      : { base: { default: "/", enum: ["/", "https://"] }, authority: { default: "api.example.test", enum: ["api.example.test", authority] } };
    const result = build((nextSpec) => place(nextSpec, { url: "{base}{authority}", variables }));
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(JOINT_SEED);
    const redacted = only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer);
    expect(redacted).toContain(`${pointer}/variables/authority/default`);
  });

  it("hides variables when three enum values together form user info", () => {
    const result = build((nextSpec) => {
      nextSpec.servers = [{
        url: "{scheme}{user}{host}",
        variables: {
          scheme: { default: "/", enum: ["/", "https://"] },
          user: { default: "v1/", enum: ["v1/", JOINT_SEED] },
          host: { default: "api.example.test", enum: ["api.example.test", "@api.example.test"] },
        },
      }];
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(JOINT_SEED);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual(expect.arrayContaining(["/servers/0/variables/user/default", "/servers/0/variables/host/default"]));
    expect(result.catalog!.servers[0].variables.scheme).toEqual({ default: "/", enum: ["/", "https://"], description: null });
  });

  it("hides every variable when there are too many value combinations to judge", () => {
    const many = (prefix: string) => Array.from({ length: 70 }, (_, index) => `${prefix}${index}`);
    const result = build((nextSpec) => {
      nextSpec.servers = [{
        url: "{base}{authority}",
        variables: {
          base: { default: "/", enum: ["/", "https://", ...many("/v")] },
          authority: { default: "api.example.test", enum: ["api.example.test", `svc:${JOINT_SEED}@api.example.test`, ...many("eu")] },
        },
      }];
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(JOINT_SEED);
    expect(result.catalog!.servers[0].variables).toEqual({
      authority: { default: "[REDACTED]", enum: null, description: null },
      base: { default: "[REDACTED]", enum: null, description: null },
    });
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED")[0].message).toMatch(/more combinations than the catalog judges .*more than 4096,/);
  });

  // Each combination expands the whole URL, so the joint judgement also has a budget of expanded characters per build.
  const longServer = (index: number, length: number) => {
    const variables: Record<string, { default: string; enum: string[] }> = {};
    for (let variable = 0; variable < 12; variable += 1) {
      variables[`v${variable}`] = { default: `u@${"a".repeat(length)}`, enum: [`u@${"a".repeat(length)}`, `u@${"b".repeat(length)}`] };
    }
    return { url: `https://h${index}.example.test/${Object.keys(variables).map((name) => `{${name}}`).join("/")}`, variables };
  };

  it.each([
    ["one server, 12 variables x 2 values x 40000 characters", 1, 40_000],
    ["20 servers, 12 variables x 2 values x 10000 characters", 20, 10_000],
  ])("bounds the joint judgement of %s and fails closed", (_name, servers, length) => {
    const nextSpec = clone(spec);
    nextSpec.servers = Array.from({ length: servers }, (_, index) => longServer(index, length));
    const started = performance.now();
    const result = buildOperationCatalog(nextSpec, clone(manifest));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.catalog).not.toBeNull();
    expect(result.catalog!.servers.every((server) => Object.values(server.variables).every((variable) => variable.default === "[REDACTED]"))).toBe(true);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED")[0].message).toMatch(/more than 4000000 characters of expanded URLs/);
  });

  it("keeps many value combinations that hold no @, ? or #", () => {
    const many = (prefix: string) => Array.from({ length: 70 }, (_, index) => `${prefix}${index}`);
    const result = build((nextSpec) => {
      nextSpec.servers = [{ url: "https://{host}/{base}", variables: { host: { default: "eu0", enum: many("eu") }, base: { default: "v0", enum: many("v") } } }];
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.catalog!.servers[0].variables.host.enum).toEqual(many("eu"));
  });

  it("removes only the user info from a whole-URL variable value", () => {
    const result = build((nextSpec) => {
      nextSpec.servers = [{ url: "{base}", variables: { base: { default: `https://svc:${COMPOSED_SEED}@api.example.test`, enum: [`https://svc:${COMPOSED_SEED}@api.example.test`, "https://eu.example.test"] } } }];
    });
    expect(canonicalJson(result)).not.toContain(COMPOSED_SEED);
    expect(result.catalog!.servers[0].variables.base).toEqual({ default: "https://api.example.test", enum: ["https://api.example.test", "https://eu.example.test"], description: null });
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual(["/servers/0/variables/base/default", "/servers/0/variables/base/enum/0"]);
  });

  it("keeps the values of a scheme and host variable verbatim", () => {
    const result = build((nextSpec) => {
      nextSpec.servers = [{ url: "{scheme}://{host}", variables: { scheme: { default: "https", enum: ["https", "http"] }, host: { default: "api.example.test" } } }];
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.catalog!.servers[0].variables).toEqual({
      host: { default: "api.example.test", enum: null, description: null },
      scheme: { default: "https", enum: ["https", "http"], description: null },
    });
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

  it.each(["X-RateLimit-Remaining", "x-ratelimit-remaining"])("warns that response header %s is not described", (header) => {
    const result = build((nextSpec) => {
      nextSpec.paths[LIST_ROUTE].get.responses["200"].headers = { [header]: { schema: { type: "integer" } } };
    });
    expect(result.catalog).not.toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_SERIALIZATION", severity: "warning", pointer: `/paths/${LIST_ROUTE.replace(/\//g, "~1")}/get/responses/200/headers` }),
    ]);
  });

  // A server URL that is only a query or fragment has nothing left once they are removed; an empty url breaks the catalog schema.
  it.each(
    ["#main", "?tenant=a"].flatMap((url) =>
      [
        ["root", (nextSpec: any) => (nextSpec.servers = [{ url }]), "/servers/0/url"],
        ["path", (nextSpec: any) => (nextSpec.paths[PROJECT_ROUTE].servers = [{ url }]), `/paths/${PROJECT_ROUTE.replace(/\//g, "~1")}/servers/0/url`],
        ["operation", (nextSpec: any) => (nextSpec.paths[PROJECT_ROUTE].get.servers = [{ url }]), `/paths/${PROJECT_ROUTE.replace(/\//g, "~1")}/get/servers/0/url`],
      ].map(([scope, apply, pointer]) => ({ name: `${scope} server ${url}`, apply: apply as (nextSpec: any) => void, pointer: pointer as string }))
    )
  )("INVALID_SPEC: $name has no URL left", ({ apply, pointer }) => {
    const result = build(apply);
    expect(result.catalog).toBeNull();
    expect(result.digest).toBeNull();
    expect(only(result.diagnostics, "INVALID_SPEC").map((diagnostic) => diagnostic.pointer)).toEqual([pointer]);
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
    }, "/paths/[REDACTED]"],
    ["a parameter name", (nextSpec) => {
      nextSpec.paths[PROJECT_ROUTE].get.parameters.push({ name: ID_SECRET, in: "query", schema: { type: "string" } });
    }, `${GET}/parameters/1/name`],
    ["a property name", (nextSpec) => {
      inputSchema(nextSpec).properties[`token=${ID_SECRET}`] = { type: "string" };
    }, "/components/schemas/ProjectInput/properties/[REDACTED]"],
    ["a discriminator mapping value", (nextSpec) => {
      inputSchema(nextSpec).discriminator = { propertyName: "name", mapping: { [`token=${ID_SECRET}`]: "Project" } };
    }, "/components/schemas/ProjectInput/discriminator/mapping/[REDACTED]"],
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
      // A pointer segment holding a credential is replaced whole, like copied text.
      expect.objectContaining({ pointer: pointer.replace(ID_SECRET, "[REDACTED]") })
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

  it.each([
    ["a scalar", "owner-team"],
    ["an object", { tokenUrl: "https://internal.example.test/token", scopes: { admin: "Admin" } }],
  ])("ignores an x-* extension holding %s in OAuth flows", (_name, extension) => {
    const result = build((nextSpec) => {
      nextSpec.components.securitySchemes.oauth.flows["x-internal"] = extension;
    });
    expect(result.diagnostics).toEqual([]);
    expect(Object.keys(result.catalog!.securitySchemes.oauth.flows!)).toEqual(["clientCredentials"]);
    expect(result.catalog!.securitySchemes).toEqual(build().catalog!.securitySchemes);
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

// A literal on a schema whose subtree reaches a credential field could carry that field's value: shape x keyword.
const LITERAL_SEED = "SEEDliteral0071";
const LITERAL_SHAPES: Array<[shape: string, schema: Record<string, unknown>, literal: unknown]> = [
  ["properties", { type: "object", properties: { pin: { type: "string", format: "password" } } }, { pin: LITERAL_SEED }],
  ["items", { type: "array", items: { type: "string", format: "password" } }, [LITERAL_SEED]],
  ["$ref to a password component", { type: "object", properties: { pin: { $ref: "#/components/schemas/Pin" } } }, { pin: LITERAL_SEED }],
  ["sibling $ref to a password component", { $ref: "#/components/schemas/Pin" }, LITERAL_SEED],
];
const LITERAL_CELLS = LITERAL_SHAPES.flatMap(([shape, schema, literal]) =>
  (["default", "const", "enum"] as const).map((keyword) => ({ name: `${shape} ${keyword}`, keyword, schema: { ...schema, [keyword]: keyword === "enum" ? [literal] : literal } }))
);

describe("literals of schemas holding credential fields", () => {
  it.each(LITERAL_CELLS)("$name", ({ keyword, schema }) => {
    const result = build((nextSpec) => {
      nextSpec.components.schemas.Pin = { type: "string", format: "password" };
      inputSchema(nextSpec).properties.probe = schema;
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(LITERAL_SEED);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).not.toHaveProperty(keyword);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual([`/components/schemas/ProjectInput/properties/probe/${keyword}`]);
  });

  it("keeps the literal of an ordinary object schema", () => {
    const probe = { type: "object", properties: { size: { type: "string" }, tags: { type: "array", items: { $ref: "#/components/schemas/ProjectStatus" } } }, default: { size: "large", tags: ["active"] } };
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.probe = probe;
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual(probe);
  });
});

// An allOf member describes the same instance as its siblings: a literal anywhere in the group is judged against all of them.
const PASSWORD = { type: "string", format: "password" };
const PIN_REF = { $ref: "#/components/schemas/Pin" };
const GROUP_SHAPES: Array<[shape: string, place: (literal: Record<string, unknown>) => Record<string, unknown>, at: string]> = [
  ["inline password member", (literal) => ({ probe: { allOf: [PASSWORD, literal] } }), "ProjectInput/properties/probe/allOf/1"],
  ["$ref member to a password component", (literal) => ({ probe: { allOf: [PIN_REF, literal] } }), "ProjectInput/properties/probe/allOf/1"],
  ["$ref to an allOf component", (literal) => ({ probe: { $ref: "#/components/schemas/Mixed" }, Mixed: { allOf: [PASSWORD, literal] } }), "Mixed/allOf/1"],
  ["nested allOf", (literal) => ({ probe: { allOf: [{ allOf: [PIN_REF] }, { allOf: [literal] }] } }), "ProjectInput/properties/probe/allOf/1/allOf/0"],
  ["literal component beside a password member", (literal) => ({ probe: { allOf: [PASSWORD, { $ref: "#/components/schemas/Lit" }] }, Lit: { type: "string", ...literal } }), "Lit"],
  ["anyOf branch beside a password branch", (literal) => ({ probe: { anyOf: [PIN_REF, literal] } }), "ProjectInput/properties/probe/anyOf/1"],
];
const GROUP_CELLS = GROUP_SHAPES.flatMap(([shape, place, at]) =>
  (["default", "const", "enum"] as const).map((keyword) => ({ name: `${shape} ${keyword}`, keyword, place, at }))
);
/** Puts `probe` under ProjectInput's properties and every other entry under components.schemas. */
const placeGroup = (nextSpec: any, entries: Record<string, unknown>) => {
  nextSpec.components.schemas.Pin = clone(PASSWORD);
  for (const [name, schema] of Object.entries(clone(entries))) {
    if (name === "probe") inputSchema(nextSpec).properties.probe = schema;
    else nextSpec.components.schemas[name] = schema;
  }
};

describe("literals of allOf groups holding credential fields", () => {
  it.each(GROUP_CELLS)("$name", ({ keyword, place, at }) => {
    const result = build((nextSpec) => placeGroup(nextSpec, place({ [keyword]: keyword === "enum" ? [LITERAL_SEED] : LITERAL_SEED })));
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(LITERAL_SEED);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual([`/components/schemas/${at}/${keyword}`]);
  });

  it.each([
    ["an object default beside a member declaring a password property", { allOf: [{ type: "object", properties: { pin: PASSWORD } }, { type: "object", default: { pin: LITERAL_SEED } }] }, "allOf/1/default"],
    ["a member default under a password parent", { ...PASSWORD, allOf: [{ default: LITERAL_SEED }] }, "allOf/0/default"],
    ["a sibling $ref to a password component", { ...PIN_REF, default: LITERAL_SEED }, "default"],
  ])("drops %s", (_name, probe, at) => {
    const result = build((nextSpec) => placeGroup(nextSpec, { probe }));
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(LITERAL_SEED);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual([`/components/schemas/ProjectInput/properties/probe/${at}`]);
  });

  it("keeps the literals of an ordinary allOf group and of the components it shares", () => {
    const probe = { allOf: [{ type: "string", format: "uuid" }, { $ref: "#/components/schemas/Lit" }, { default: "6f1c2a52-0000-4000-8000-000000000000" }] };
    const result = build((nextSpec) => placeGroup(nextSpec, { probe, Lit: { type: "string", enum: ["6f1c2a52-0000-4000-8000-000000000000"] } }));
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual(probe);
    expect(result.catalog!.schemas.Lit).toEqual({ type: "string", enum: ["6f1c2a52-0000-4000-8000-000000000000"] });
  });

  it("judges a chain of allOf groups in linear time", () => {
    for (const last of [{ type: "string" }, PASSWORD]) {
      const specs = new Map(
        [2_500, 10_000].map((length) => {
          const nextSpec = clone(spec);
          for (let index = 0; index < length; index += 1) {
            const next = index + 1 < length ? { $ref: `#/components/schemas/G${index + 1}` } : last;
            nextSpec.components.schemas[`G${index}`] = { allOf: [next, { type: "string", default: "ok" }] };
          }
          inputSchema(nextSpec).properties.probe = { $ref: "#/components/schemas/G0" };
          return [length, nextSpec];
        })
      );
      const ratio = scalingRatio((length) => {
        const result = buildOperationCatalog(specs.get(length)!, clone(manifest));
        expect(result.catalog).not.toBeNull();
        expect(only(result.diagnostics, "CREDENTIAL_REDACTED").length).toBe(last === PASSWORD ? length : 0);
      }, 2_500, 2);
      expect(ratio).toBeLessThan(LINEAR_RATIO);
    }
  }, SCALING_TIMEOUT);
});

// An unrecognized member could hold a default under another name, so it is judged like a literal (S2).
const UNRECOGNIZED_SHAPES: Array<[shape: string, entries: Record<string, unknown>, at: string]> = [
  ["password property + unrecognized object", { probe: { type: "object", properties: { pin: PASSWORD }, fallback: { pin: LITERAL_SEED } } }, "ProjectInput/properties/probe/fallback"],
  ["$ref to a password component + unrecognized scalar", { probe: { ...PIN_REF, defaultValue: LITERAL_SEED } }, "ProjectInput/properties/probe/defaultValue"],
  ["password items + unrecognized array", { probe: { type: "array", items: PASSWORD, sampleValue: [LITERAL_SEED] } }, "ProjectInput/properties/probe/sampleValue"],
  ["allOf member beside a password member", { probe: { allOf: [PASSWORD, { sampleValue: LITERAL_SEED }] } }, "ProjectInput/properties/probe/allOf/1/sampleValue"],
  ["component reached beside a password member", { probe: { allOf: [PIN_REF, { $ref: "#/components/schemas/Lit" }] }, Lit: { type: "string", fallback: LITERAL_SEED } }, "Lit/fallback"],
];

describe("unrecognized members of schemas holding credential fields", () => {
  it.each(UNRECOGNIZED_SHAPES)("drops it: %s", (_shape, entries, at) => {
    const result = build((nextSpec) => placeGroup(nextSpec, entries));
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(LITERAL_SEED);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual([`/components/schemas/${at}`]);
  });

  it("keeps an unrecognized member of an ordinary schema", () => {
    const probe = { type: "object", properties: { size: { type: "string" } }, fallback: { size: "keepme" }, sampleValue: ["keepme"] };
    const result = build((nextSpec) => placeGroup(nextSpec, { probe }));
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual(probe);
  });
});

// Structured data follows the text name/value rule: a value field next to a name field naming a credential.
const PAIR_SEED = "SEEDpair0081";
const PAIRS: Array<[field: string, pair: Record<string, string>]> = [
  ["name", { name: "X-Api-Key", value: PAIR_SEED }],
  ["key", { key: "client_secret", value: PAIR_SEED }],
  ["header", { header: "Authorization", value: `Bearer ${PAIR_SEED}` }],
];
const PAIR_PLACES: Array<[place: string, keyword: "default" | "const" | "enum", literal: (pair: Record<string, string>) => unknown]> = [
  ["default", "default", (pair) => pair],
  ["const", "const", (pair) => pair],
  ["enum", "enum", (pair) => [pair]],
  ["nested object", "default", (pair) => ({ headers: { auth: pair } })],
  ["array element", "default", (pair) => ({ headers: [{ name: "X-Request-Id", value: "req-42" }, pair] })],
];
const PAIR_CELLS = PAIRS.flatMap(([field, pair]) => PAIR_PLACES.map(([place, keyword, literal]) => ({ name: `${field} field, ${place}`, keyword, literal: literal(pair) })));

describe("credential name/value pairs in literals", () => {
  it.each(PAIR_CELLS)("drops the literal: $name", ({ keyword, literal }) => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.probe = { type: "object", [keyword]: literal };
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(PAIR_SEED);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual({ type: "object" });
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual([`/components/schemas/ProjectInput/properties/probe/${keyword}`]);
  });

  it("keeps an ordinary name/value pair and a placeholder value", () => {
    const probe = { type: "object", default: { headers: [{ name: "X-Request-Id", value: "req-42" }, { name: "X-Api-Key", value: "<token>" }] } };
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.probe = probe;
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual(probe);
  });
});

// Positional pairs follow the text rule too: a two-element list whose first element is a credential key. key x place.
const POSITIONAL_PAIRS: Array<[key: string, pair: [string, string]]> = [
  ["X-Api-Key", ["X-Api-Key", PAIR_SEED]],
  ["client_secret", ["client_secret", PAIR_SEED]],
  ["Authorization", ["Authorization", `Bearer ${PAIR_SEED}`]],
];
const POSITIONAL_PLACES: Array<[place: string, keyword: "default" | "const" | "enum", literal: (pair: [string, string]) => unknown]> = [
  ["flat default", "default", (pair) => pair],
  ["flat const", "const", (pair) => pair],
  ["enum member", "enum", (pair) => [pair]],
  ["entries default", "default", (pair) => [["X-Request-Id", "req-42"], pair]],
  ["entries in an object", "const", (pair) => ({ headers: [pair] })],
];
const POSITIONAL_CELLS = POSITIONAL_PAIRS.flatMap(([key, pair]) => POSITIONAL_PLACES.map(([place, keyword, literal]) => ({ name: `${key}, ${place}`, keyword, literal: literal(pair) })));

describe("positional credential pairs in literals", () => {
  it.each(POSITIONAL_CELLS)("drops the literal: $name", ({ keyword, literal }) => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.probe = { [keyword]: literal };
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(PAIR_SEED);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual({});
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual([`/components/schemas/ProjectInput/properties/probe/${keyword}`]);
  });

  it("keeps ordinary and placeholder pairs, and an enum listing a credential word among values", () => {
    const probe = {
      type: "string",
      enum: ["password", "otp"],
      default: [["X-Request-Id", "req-42"], ["X-Api-Key", "<token>"]],
      const: ["password", "email", "name"],
    };
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.probe = probe;
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual(probe);
  });
});

// OpenAPI 3.0 boolean exclusive bounds become 2020-12 numeric bounds; 3.1 numeric bounds are copied verbatim.
describe("exclusive bounds", () => {
  const ajv = new Ajv2020({ strict: false });
  const bounded = (version: string, schema: Record<string, unknown>) => {
    const result = build((nextSpec) => {
      nextSpec.openapi = version;
      inputSchema(nextSpec).properties.count = schema;
    });
    expect(result.diagnostics).toEqual([]);
    return (result.catalog!.schemas.ProjectInput as any).properties.count;
  };

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["exclusiveMinimum: true", { type: "integer", minimum: 0, exclusiveMinimum: true }, { type: "integer", exclusiveMinimum: 0 }],
    ["exclusiveMinimum: false", { type: "integer", minimum: 0, exclusiveMinimum: false }, { type: "integer", minimum: 0 }],
    ["exclusiveMaximum: true", { type: "integer", maximum: 10, exclusiveMaximum: true }, { type: "integer", exclusiveMaximum: 10 }],
    ["exclusiveMaximum: false", { type: "integer", maximum: 10, exclusiveMaximum: false }, { type: "integer", maximum: 10 }],
    ["both bounds", { type: "integer", minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: false }, { type: "integer", exclusiveMinimum: 0, maximum: 10 }],
    ["a boolean without its bound", { type: "integer", exclusiveMinimum: true, exclusiveMaximum: true }, { type: "integer" }],
  ])("3.0 %s", (_name, schema, expected) => {
    const emitted = bounded("3.0.3", schema);
    expect(emitted).toEqual(expected);
    const validate = ajv.compile(emitted);
    expect(validate(0)).toBe(emitted.exclusiveMinimum === undefined);
    expect(validate(1)).toBe(true);
  });

  it("copies 3.1 numeric bounds verbatim", () => {
    const schema = { type: "integer", minimum: 0, exclusiveMinimum: 0, maximum: 10, exclusiveMaximum: 11 };
    expect(bounded("3.1.0", schema)).toEqual(schema);
  });
});

// Long component chains: the literal check walks them without recursion, and once per build.
type Link = "$ref" | "allOf";
const chain = (nextSpec: any, link: Link, length: number, last: Record<string, unknown>, literal?: [string, unknown]) => {
  const ref = (index: number) => ({ $ref: `#/components/schemas/C${index}` });
  for (let index = 0; index < length; index += 1) {
    const next = index + 1 < length ? ref(index + 1) : last;
    nextSpec.components.schemas[`C${index}`] = { ...(link === "$ref" ? next : { allOf: [next] }), ...(literal ? { [literal[0]]: literal[1] } : {}) };
  }
};
const CHAIN_CELLS = (["$ref", "allOf"] as const).flatMap((link) => (["default", "const", "enum"] as const).map((keyword) => ({ name: `${link} ${keyword}`, link, keyword })));

describe("literals of schemas at the head of long component chains", () => {
  it.each(CHAIN_CELLS)("builds a 5000-link $name chain and keeps the literal", ({ link, keyword }) => {
    const literal = keyword === "enum" ? ["ok"] : "ok";
    const result = build((nextSpec) => {
      chain(nextSpec, link, 5000, { type: "string" });
      inputSchema(nextSpec).properties.probe = { $ref: "#/components/schemas/C0", [keyword]: literal };
    });
    expect(result.catalog).not.toBeNull();
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe[keyword]).toEqual(literal);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED")).toEqual([]);
  });

  it.each(CHAIN_CELLS)("drops the literal when a 5000-link $name chain ends in a password field", ({ link, keyword }) => {
    const result = build((nextSpec) => {
      chain(nextSpec, link, 5000, { type: "string", format: "password" });
      inputSchema(nextSpec).properties.probe = { $ref: "#/components/schemas/C0", [keyword]: keyword === "enum" ? [LITERAL_SEED] : LITERAL_SEED };
    });
    expect(result.catalog).not.toBeNull();
    expect(canonicalJson(result)).not.toContain(LITERAL_SEED);
    expect(only(result.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toContain(`/components/schemas/ProjectInput/properties/probe/${keyword}`);
  });

  it.each(["$ref", "allOf"] as const)("judges a literal on every link of a %s chain in linear time", (link) => {
    for (const last of [{ type: "string" }, { type: "string", format: "password" }]) {
      const specs = new Map(
        [2_500, 10_000].map((length) => {
          const nextSpec = clone(spec);
          chain(nextSpec, link, length, last, ["default", "ok"]);
          inputSchema(nextSpec).properties.probe = { $ref: "#/components/schemas/C0" };
          return [length, nextSpec];
        })
      );
      const ratio = scalingRatio((length) => {
        const result = buildOperationCatalog(specs.get(length)!, clone(manifest));
        expect(result.catalog).not.toBeNull();
        expect(only(result.diagnostics, "CREDENTIAL_REDACTED").length).toBe(last.format ? length : 0);
      }, 2_500, 2);
      expect(ratio).toBeLessThan(LINEAR_RATIO);
    }
  }, SCALING_TIMEOUT);
});

// The emitted taint of a component never depends on the order its references were found: it is settled first.
describe("component taint under key reordering", () => {
  const tainted = (target: Record<string, unknown>) => (nextSpec: any) => {
    Object.assign(nextSpec.components.schemas, {
      A: { $ref: "#/components/schemas/X" },
      B: { $ref: "#/components/schemas/C" },
      C: { $ref: "#/components/schemas/X" },
      X: target,
    });
    inputSchema(nextSpec).properties.probe = { type: "object", properties: { a: { $ref: "#/components/schemas/A" }, password: { $ref: "#/components/schemas/B" } } };
  };

  it.each([
    ["a literal on the shared component", { type: "string", default: "token=abc123" }, true],
    ["a wrong-typed keyword on the shared component", { type: "string", enum: { "token=abc": 1 } }, false],
  ])("%s gives one result in either order", (_name, target, succeeds) => {
    const forward = build(tainted(target));
    const reversed = build((nextSpec) => {
      tainted(target)(nextSpec);
      // Every nested object, including the probe's properties (password before a), in reverse key order.
      Object.assign(nextSpec, reverseKeys(nextSpec));
    });
    expect(canonicalJson(reversed)).toBe(canonicalJson(forward));
    expect(forward.catalog !== null).toBe(succeeds);
    if (succeeds) {
      // X is reached from the password field, so it is emitted once, without the literal, with one diagnostic.
      expect(only(forward.diagnostics, "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer)).toEqual(["/components/schemas/X/default"]);
      expect(forward.catalog!.schemas.X).toEqual({ type: "string" });
    } else {
      expect(forward.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_SPEC", pointer: "/components/schemas/X/enum" }));
    }
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
    }, ["/components/schemas/ProjectInput/dependentRequired/[REDACTED]"]],
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

  // $dynamicRef and $recursiveRef are references too: their targets join catalog.schemas or the build fails.
  it.each(["$dynamicRef", "$recursiveRef"])("%s to a component schema is collected like $ref", (keyword) => {
    const result = build((nextSpec) => {
      nextSpec.components.schemas.ThingX = { type: "object", properties: { label: { type: "string" } } };
      inputSchema(nextSpec).properties.thing = { [keyword]: "#/components/schemas/ThingX" };
    });
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.thing).toEqual({ [keyword]: "#/components/schemas/ThingX" });
    expect(result.catalog!.schemas.ThingX).toEqual({ type: "object", properties: { label: { type: "string" } } });
  });

  it.each([
    ["$dynamicRef", "#/components/schemas/Nope"],
    ["$dynamicRef", "#meta"],
    ["$recursiveRef", "#"],
  ])("UNRESOLVED_REF: %s %s does not name a catalog schema", (keyword, ref) => {
    const result = build((nextSpec) => {
      inputSchema(nextSpec).properties.thing = { [keyword]: ref };
    });
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "UNRESOLVED_REF", pointer: `/components/schemas/ProjectInput/properties/thing/${keyword}` }),
    ]);
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

// Every schema keyword the catalog emits with a fixed JSON type is checked before any other rule reads it.
const KEYWORD_SEED = "SEEDkeyword5521";
const WRONG_TYPED_KEYWORDS: Array<[keyword: string, value: unknown]> = [
  ["type", 42],
  ["type", "file"],
  ["type", []],
  ["type", ["string", "string"]],
  ["enum", "bad"],
  ["enum", { password: KEYWORD_SEED }],
  ["enum", { name: "X-Api-Key", value: KEYWORD_SEED }],
  ["multipleOf", 0],
  ["multipleOf", "2"],
  ["maximum", "10"],
  ["minimum", null],
  ["exclusiveMaximum", "10"],
  ["exclusiveMinimum", {}],
  ...["maxLength", "minLength", "maxItems", "minItems", "maxProperties", "minProperties", "maxContains", "minContains"].flatMap((keyword): Array<[string, unknown]> => [
    [keyword, "12"],
    [keyword, -1],
    [keyword, 1.5],
  ]),
  ...["pattern", "format", "title", "description", "$comment", "contentMediaType", "contentEncoding"].map((keyword): [string, unknown] => [keyword, 7]),
  ...["uniqueItems", "readOnly", "writeOnly", "deprecated", "nullable"].map((keyword): [string, unknown] => [keyword, "true"]),
];

describe("schema keyword types", () => {
  it.each(WRONG_TYPED_KEYWORDS)("INVALID_SPEC: %s = %j", (keyword, value) => {
    const result = build((nextSpec) => (inputSchema(nextSpec).properties.probe = keyword === "type" ? { type: value } : { type: "string", [keyword]: value }));
    expect(result).toEqual({ catalog: null, digest: null, diagnostics: [expect.objectContaining({ code: "INVALID_SPEC", pointer: `/components/schemas/ProjectInput/properties/probe/${keyword.replace(/~/g, "~0")}` })] });
    expect(JSON.stringify(result)).not.toContain(KEYWORD_SEED);
  });

  it("checks keyword types inside a credential field too", () => {
    const result = build((nextSpec) => (inputSchema(nextSpec).properties.password = { type: "string", maxLength: "12" }));
    expect(result.catalog).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_SPEC", pointer: "/components/schemas/ProjectInput/properties/password/maxLength" }));
  });

  it("keeps every keyword of the right type", () => {
    const probe = {
      type: ["string", "null"], enum: ["a", null], multipleOf: 0.5, maximum: 10, minimum: 0, exclusiveMaximum: 11, exclusiveMinimum: -1,
      maxLength: 12, minLength: 0, pattern: "^[a-z]+$", format: "slug", title: "Probe", description: "A probe.", $comment: "c",
      contentMediaType: "text/plain", contentEncoding: "base64", readOnly: false, writeOnly: false, deprecated: false,
    };
    const result = build((nextSpec) => (inputSchema(nextSpec).properties.probe = probe));
    expect(result.diagnostics).toEqual([]);
    expect((result.catalog!.schemas.ProjectInput as any).properties.probe).toEqual(probe);
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
