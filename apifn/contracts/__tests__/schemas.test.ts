import { readdirSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  API_ID_PATTERN,
  CREDENTIAL_KEY_PATTERN,
  NAME_PATTERN,
  OCCURRED_AT_PATTERN,
  OPERATION_ID_PATTERN,
  PACKAGE_NAME_PATTERN,
  RELEASE_ID_PATTERN,
  SEMVER_PATTERN,
  TARGET_PATTERN,
  VERSION_PATTERN,
  buildOperationCatalog,
  createReleaseDescriptor,
  isCredentialKey,
  validateClientFailureEvent,
  type CreateReleaseInput,
} from "../src/index.js";
import { clone, FIXTURES, fixture, readJson, SCHEMAS } from "./helpers.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const schema = (name: string) => readJson(path.join(SCHEMAS, `${name}.v1.schema.json`));
const validators = Object.fromEntries(
  ["manifest", "operation-catalog", "release-descriptor", "client-failure-event"].map((name) => [name, ajv.compile(schema(name))])
);

function check(name: string, value: unknown): boolean {
  return validators[name](value) as boolean;
}

describe("published JSON Schemas", () => {
  it("accept the committed manifest, catalog and release fixtures", () => {
    for (const file of ["catalog/manifest.json", "parity/manifest.json"]) expect(check("manifest", fixture(file))).toBe(true);
    expect(check("operation-catalog", fixture("catalog/catalog.json")), JSON.stringify(validators["operation-catalog"].errors)).toBe(true);
    expect(check("release-descriptor", fixture("catalog/release-descriptor.json"))).toBe(true);
  });

  it("reject manifests that bind an operation both ways or neither way", () => {
    const base = { manifestVersion: 1, api: { id: "example.projects", version: "1" } };
    expect(check("manifest", { ...base, operations: [{ id: "a", operationId: "x", method: "get", path: "/x" }] })).toBe(false);
    expect(check("manifest", { ...base, operations: [{ id: "a" }] })).toBe(false);
    expect(check("manifest", { ...base, operations: [{ id: "a", method: "get", path: "/x" }] })).toBe(true);
  });

  it("agree with the TypeScript validator on every failure-event fixture", () => {
    const dir = path.join(FIXTURES, "client-failure");
    for (const file of readdirSync(path.join(dir, "valid"))) {
      const event = readJson(path.join(dir, "valid", file));
      expect(check("client-failure-event", event), file).toBe(true);
      expect(validateClientFailureEvent(event).ok, file).toBe(true);
    }
    // Byte limits, credential-like values and total size are enforced only by
    // validateClientFailureEvent; the schema's description documents this.
    const runtimeOnly = new Set(["credential-value-message.json", "oversize-attribute-value.json", "oversize-event.json"]);
    for (const file of readdirSync(path.join(dir, "invalid"))) {
      const { event } = readJson(path.join(dir, "invalid", file));
      expect(validateClientFailureEvent(event).ok, file).toBe(false);
      expect(check("client-failure-event", event), file).toBe(runtimeOnly.has(file));
    }
  });

  it("agree with the TypeScript validator on Object.prototype member names", () => {
    const event = fixture("client-failure/valid/network-minimal.json");
    const inputs = [
      `{"constructor":"x",${JSON.stringify(event).slice(1)}`,
      JSON.stringify({ ...event, failure: { ...event.failure, toString: "x".repeat(4000) } }),
      JSON.stringify({ ...event, failure: { ...event.failure, constructor: "x" } }),
      JSON.stringify(event).replace('"release":{', '"release":{"__proto__":{"x":1},'),
    ];
    for (const input of inputs) {
      const parsed = JSON.parse(input);
      expect(check("client-failure-event", parsed), input.slice(0, 60)).toBe(false);
      expect(validateClientFailureEvent(parsed).ok, input.slice(0, 60)).toBe(false);
    }
  });

  it("accept catalogs with form encoding, server variables and server overrides", () => {
    const spec = clone(fixture("catalog/openapi.json"));
    const manifest = clone(fixture("catalog/manifest.json"));
    manifest.serialization.mediaTypes.push("multipart/form-data");
    spec.servers = [{ url: "https://{region}.api.example.test/v1", variables: { region: { default: "eu" } } }, { url: "/relative/@scope" }];
    spec.paths["/health"].servers = [{ url: "//status.example.test" }];
    spec.paths["/workspaces/{workspaceId}/projects"].post.requestBody.content["multipart/form-data"] = {
      schema: { type: "object" },
      encoding: { file: { contentType: "image/png", explode: false } },
    };
    const { catalog, diagnostics } = buildOperationCatalog(spec, manifest);
    expect(diagnostics).toEqual([]);
    expect(check("operation-catalog", catalog), JSON.stringify(validators["operation-catalog"].errors)).toBe(true);
    expect(check("operation-catalog", { ...catalog, servers: [{ url: "https://user@api.example.test", description: null, variables: {} }] })).toBe(false);
    // Special schemes need no "//" before user info; a non-special scheme without "//" has no authority.
    const serverUrl = (url: string) => check("operation-catalog", { ...catalog, servers: [{ url, description: null, variables: {} }] });
    for (const url of ["https:svc:pw@api.example.test", "https:/svc:pw@api.example.test", "https:\\\\svc:pw@api.example.test", "HTTP:\\svc:pw@api.example.test", "wss:/\\svc:pw@api.example.test"]) {
      expect(serverUrl(url), url).toBe(false);
    }
    for (const url of ["https:api.example.test/v1", "https:\\\\api.example.test\\v1", "urn:example:svc@host"]) expect(serverUrl(url), url).toBe(true);
  });

  it("share identifier patterns with the TypeScript contract", () => {
    const manifest = schema("manifest");
    const failure = schema("client-failure-event");
    const binding = manifest.$defs.binding.properties;
    expect(manifest.properties.api.properties.id.pattern).toBe(API_ID_PATTERN.source);
    expect(manifest.properties.api.properties.version.pattern).toBe(VERSION_PATTERN.source);
    expect(binding.id.pattern).toBe(OPERATION_ID_PATTERN.source);
    expect(binding.name.pattern).toBe(NAME_PATTERN.source);
    expect(binding.sdk.properties.excludeTargets.items.pattern).toBe(TARGET_PATTERN.source);
    expect(failure.properties.release.properties.releaseId.pattern).toBe(RELEASE_ID_PATTERN.source);
    expect(failure.properties.occurredAt.pattern).toBe(OCCURRED_AT_PATTERN.source);
    expect(failure.properties.attributes.propertyNames.not.pattern).toBe(CREDENTIAL_KEY_PATTERN);
    const release = schema("release-descriptor");
    expect(release.properties.releaseId.pattern).toBe(RELEASE_ID_PATTERN.source);
    expect(release.properties.generator.properties.name.pattern).toBe(PACKAGE_NAME_PATTERN.source);
    expect(release.properties.generator.properties.version.pattern).toBe(SEMVER_PATTERN.source);
    expect(release.properties.artifacts.items.properties.package.properties.name.pattern).toBe(PACKAGE_NAME_PATTERN.source);
  });

});

describe("schema and runtime agreement", () => {
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(["pass_word", "s.e.c.r.e.t", "api-key", "x.session-id", "auth.token", "private.key", "region", "page.size", "retry.count", "sessions"])(
    "attribute key %s: the schema and the validator agree",
    (key) => {
      const candidate = { ...clone(event), attributes: { [key]: "v" } };
      const runtime = validateClientFailureEvent(candidate).ok;
      expect(check("client-failure-event", candidate)).toBe(runtime);
      expect(runtime).toBe(!isCredentialKey(key));
    }
  );

  // Agent exposure needs an execution policy in the published catalog schema and in createReleaseDescriptor,
  // not only in buildOperationCatalog: [label, agent.expose, executionPolicyRef, valid].
  it.each<[string, boolean, string | null, boolean]>([
    ["exposed with a policy", true, "policy.read-only", true],
    ["exposed without a policy", true, null, false],
    ["not exposed, no policy", false, null, true],
  ])("operation %s: the catalog schema and the release agree", (_label, expose, executionPolicyRef, valid) => {
    const catalog = clone(fixture("catalog/catalog.json"));
    for (const operation of catalog.operations) Object.assign(operation, { agent: { expose }, executionPolicyRef });
    expect(check("operation-catalog", catalog)).toBe(valid);
    const { descriptor, diagnostics } = createReleaseDescriptor({
      catalog: catalog as CreateReleaseInput["catalog"],
      generator: { name: "gen", version: "1.0.0" },
      artifacts: [{ kind: "agent-tools", target: "mcp", package: { name: "tools", version: "1.0.0" } }],
    });
    expect(descriptor !== null).toBe(valid);
    if (!valid) expect(diagnostics.map((diagnostic) => diagnostic.pointer)).toContain("/catalog/operations/0/executionPolicyRef");
  });

  // Each security scheme type's required members, as OpenAPI 3.0/3.1 define them: [label, declared scheme, INVALID_SPEC pointers].
  // An empty pointer list is a valid control. The runtime rejects the spec and the catalog schema rejects the scheme as emitted.
  const SCHEME = "/components/securitySchemes/auth";
  const flows = (value: Record<string, unknown>) => ({ type: "oauth2", flows: value });
  it.each<[string, Record<string, unknown>, string[]]>([
    ["apiKey without in or name", { type: "apiKey" }, [`${SCHEME}/in`, `${SCHEME}/name`]],
    ["apiKey in body", { type: "apiKey", in: "body", name: "key" }, [`${SCHEME}/in`]],
    ["apiKey with an empty name", { type: "apiKey", in: "header", name: "" }, [`${SCHEME}/name`]],
    ["http without a scheme", { type: "http" }, [`${SCHEME}/scheme`]],
    ["openIdConnect without a URL", { type: "openIdConnect" }, [`${SCHEME}/openIdConnectUrl`]],
    ["oauth2 without flows", { type: "oauth2" }, [`${SCHEME}/flows`]],
    ["oauth2 with no flow", flows({}), [`${SCHEME}/flows`]],
    ["oauth2 with only an extension", flows({ "x-internal": "owner-team" }), [`${SCHEME}/flows`]],
    ["an unknown flow", flows({ deviceCode: { tokenUrl: "https://auth.example.test/token", scopes: {} } }), [`${SCHEME}/flows/deviceCode`]],
    ["clientCredentials without tokenUrl or scopes", flows({ clientCredentials: {} }), [`${SCHEME}/flows/clientCredentials/scopes`, `${SCHEME}/flows/clientCredentials/tokenUrl`]],
    ["clientCredentials without scopes", flows({ clientCredentials: { tokenUrl: "https://auth.example.test/token" } }), [`${SCHEME}/flows/clientCredentials/scopes`]],
    ["password without tokenUrl", flows({ password: { scopes: {} } }), [`${SCHEME}/flows/password/tokenUrl`]],
    ["implicit without authorizationUrl", flows({ implicit: { scopes: {} } }), [`${SCHEME}/flows/implicit/authorizationUrl`]],
    ["implicit with an empty authorizationUrl", flows({ implicit: { authorizationUrl: "", scopes: {} } }), [`${SCHEME}/flows/implicit/authorizationUrl`]],
    ["authorizationCode without authorizationUrl", flows({ authorizationCode: { tokenUrl: "https://auth.example.test/token", scopes: {} } }), [`${SCHEME}/flows/authorizationCode/authorizationUrl`]],
    ["authorizationCode without tokenUrl", flows({ authorizationCode: { authorizationUrl: "https://auth.example.test/authorize", scopes: {} } }), [`${SCHEME}/flows/authorizationCode/tokenUrl`]],
    ["valid apiKey", { type: "apiKey", in: "cookie", name: "sid" }, []],
    ["valid http", { type: "http", scheme: "bearer" }, []],
    ["valid mutualTLS", { type: "mutualTLS" }, []],
    ["valid openIdConnect", { type: "openIdConnect", openIdConnectUrl: "https://auth.example.test/.well-known/openid-configuration" }, []],
    ["valid implicit", flows({ implicit: { authorizationUrl: "https://auth.example.test/authorize", scopes: {} } }), []],
    ["valid password", flows({ password: { tokenUrl: "https://auth.example.test/token", scopes: { read: "Read" } } }), []],
    ["valid clientCredentials with empty scopes", flows({ clientCredentials: { tokenUrl: "https://auth.example.test/token", scopes: {} } }), []],
    [
      "valid authorizationCode with an extension member",
      flows({ authorizationCode: { authorizationUrl: "https://auth.example.test/authorize", tokenUrl: "https://auth.example.test/token", scopes: {} }, "x-internal": "owner-team" }),
      [],
    ],
  ])("security scheme %s: the runtime and the catalog schema agree", (_label, declared, pointers) => {
    const spec = clone(fixture("catalog/openapi.json"));
    spec.components.securitySchemes.auth = declared;
    spec.paths["/workspaces/{workspaceId}/projects/{projectId}"].get.security = [{ auth: [] }];
    const built = buildOperationCatalog(spec, clone(fixture("catalog/manifest.json")));
    const invalid = built.diagnostics.filter((diagnostic) => diagnostic.code === "INVALID_SPEC").map((diagnostic) => diagnostic.pointer);
    expect(invalid.sort()).toEqual([...pointers].sort());
    expect(built.catalog === null).toBe(pointers.length > 0);
    expect(built.digest === null).toBe(pointers.length > 0);

    // The scheme as the catalog would emit it: scopes become a sorted list and extension members are dropped.
    const emitted: Record<string, unknown> = { ...declared, description: null };
    if (declared.flows) {
      emitted.flows = Object.fromEntries(
        Object.entries(declared.flows as Record<string, Record<string, unknown>>)
          .filter(([name]) => !name.startsWith("x-"))
          .map(([name, flow]) => {
            const { scopes, ...rest } = flow;
            return [name, scopes === undefined ? rest : { ...rest, scopes: Object.keys(scopes as object).sort() }];
          })
      );
    }
    const catalog = clone(fixture("catalog/catalog.json"));
    catalog.securitySchemes.auth = emitted;
    expect(check("operation-catalog", catalog), JSON.stringify(validators["operation-catalog"].errors)).toBe(pointers.length === 0);
    if (built.catalog) expect(built.catalog.securitySchemes.auth).toEqual(emitted);
  });

  // [errorCode, valid at runtime, valid by the schema]. errorCode is an identifier, so ":" is a namespace
  // separator; credential values are checked only at runtime, as the schema description documents.
  it.each<[string, boolean, boolean]>([
    ["token:expired", true, true],
    ["password:too_short", true, true],
    ["rate:limited", true, true],
    ["token=abc123", false, false],
    ["sk_live_abcdefgh12345678", false, true],
    ["secrets:read", true, true],
    ["password:hunter2SEED99", false, true],
    ["api_key:AbCdEf123456Ghij", false, true],
  ])("failure.errorCode %s: identifier rule at runtime, pattern in the schema", (errorCode, runtime, schemaValid) => {
    const candidate = { ...clone(event), failure: { ...event.failure, errorCode } };
    expect(validateClientFailureEvent(candidate).ok).toBe(runtime);
    expect(check("client-failure-event", candidate)).toBe(schemaValid);
  });

  // [label, JSON pointer, largest valid value]; one more character must fail in both.
  const EVENT_BOUNDS: Array<[string, string[], string]> = [
    ["eventId", ["eventId"], "e".repeat(64)],
    ["operation.name", ["operation", "name"], "n".repeat(128)],
    ["failure.errorCode", ["failure", "errorCode"], "E".repeat(128)],
    ["failure.message", ["failure", "message"], "m".repeat(1024)],
    ["release.sdk.package", ["release", "sdk", "package"], "p".repeat(214)],
    ["runtime.version", ["runtime", "version"], "v".repeat(64)],
    ["correlation.traceId", ["correlation", "traceId"], "t".repeat(128)],
  ];

  it.each(EVENT_BOUNDS)("event %s: the schema and the validator share the length bound", (_label, path, value) => {
    for (const [candidateValue, valid] of [[value, true], [`${value}x`, false]] as const) {
      const candidate: any = { ...clone(event), release: { releaseId: "rel_1", sdk: { target: "typescript", package: "p", version: "1.0.0" } }, runtime: { name: "node" }, correlation: {} };
      let target = candidate;
      for (const segment of path.slice(0, -1)) target = target[segment] ??= {};
      target[path[path.length - 1]] = candidateValue;
      expect(check("client-failure-event", candidate), `${path.join(".")} ${candidateValue.length}`).toBe(valid);
      expect(validateClientFailureEvent(candidate).ok, `${path.join(".")} ${candidateValue.length}`).toBe(valid);
    }
  });

  const catalog = buildOperationCatalog(fixture("catalog/openapi.json"), fixture("catalog/manifest.json")).catalog!;
  const releaseInput = (): CreateReleaseInput => ({
    catalog: clone(catalog),
    generator: { name: "@apifn/contracts-fixture", version: "0.1.0" },
    artifacts: [{ kind: "sdk", target: "typescript", package: { name: "@example/projects-sdk", version: "1.0.0" } }],
  });

  // [label, set the field on a release input, set the same field on a descriptor, value, valid]
  const RELEASE_CASES: Array<[string, (input: any, value: string) => void, (descriptor: any, value: string) => void, string, boolean]> = [];
  const release = (label: string, onInput: (input: any, value: string) => void, onDescriptor: (descriptor: any, value: string) => void, cases: Array<[string, boolean]>) =>
    cases.forEach(([value, valid]) => RELEASE_CASES.push([label, onInput, onDescriptor, value, valid]));
  release("generator.name", (input, value) => { input.generator.name = value; }, (descriptor, value) => { descriptor.generator.name = value; }, [
    ["g".repeat(214), true], ["g".repeat(215), false], ["Not A Package", false], ["@scope/name", true],
  ]);
  release("generator.version", (input, value) => { input.generator.version = value; }, (descriptor, value) => { descriptor.generator.version = value; }, [
    [`1.0.0-${"a".repeat(58)}`, true], [`1.0.0-${"a".repeat(59)}`, false], ["latest", false],
  ]);
  release("package.name", (input, value) => { input.artifacts[0].package.name = value; }, (descriptor, value) => { descriptor.artifacts[0].package.name = value; }, [
    ["p".repeat(214), true], ["p".repeat(215), false],
  ]);
  release("package.version", (input, value) => { input.artifacts[0].package.version = value; }, (descriptor, value) => { descriptor.artifacts[0].package.version = value; }, [
    ["1".repeat(64), true], ["1".repeat(65), false],
  ]);
  release("target", (input, value) => { input.artifacts[0].target = value; }, (descriptor, value) => { descriptor.artifacts[0].target = value; }, [
    ["t".repeat(32), true], ["t".repeat(33), false],
  ]);
  release("releaseId", (input, value) => { input.releaseId = value; }, (descriptor, value) => { descriptor.releaseId = value; }, [
    ["r".repeat(128), true], ["r".repeat(129), false],
  ]);

  it.each(RELEASE_CASES)("release %s = %#: the schema and createReleaseDescriptor agree", (_label, onInput, onDescriptor, value, valid) => {
    const input = releaseInput();
    onInput(input, value);
    const { descriptor } = createReleaseDescriptor(input);
    expect(descriptor !== null).toBe(valid);
    if (descriptor) expect(check("release-descriptor", descriptor), JSON.stringify(validators["release-descriptor"].errors)).toBe(true);

    const base = createReleaseDescriptor(releaseInput()).descriptor!;
    onDescriptor(base, value);
    expect(check("release-descriptor", base)).toBe(valid);
  });
});
