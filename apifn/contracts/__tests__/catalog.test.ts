import { describe, expect, it } from "vitest";
import { buildOperationCatalog, canonicalJson, type Diagnostic } from "../src/index.js";
import { clone, fixture, matchFixture, reverseKeys } from "./helpers.js";

const spec = fixture("catalog/openapi.json");
const manifest = fixture("catalog/manifest.json");
const PROJECT_ROUTE = "/workspaces/{workspaceId}/projects/{projectId}";
const LIST_ROUTE = "/workspaces/{workspaceId}/projects";

function build(mutate?: (spec: any, manifest: any) => void) {
  const nextSpec = clone(spec);
  const nextManifest = clone(manifest);
  mutate?.(nextSpec, nextManifest);
  return buildOperationCatalog(nextSpec, nextManifest);
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
      expect.stringMatching(/^error: Response 200 of operation "projects.list" only offers application\/xml; add a supported media type/),
      expect.stringMatching(/^warning: Response 200 of operation "projects.get" drops unsupported media types application\/xml/),
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
