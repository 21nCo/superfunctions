import { describe, expect, it } from "vitest";
import { redactCredentialValues } from "../src/credentials.js";
import { buildOperationCatalog, containsCredentialValue, createReleaseDescriptor, validateClientFailureEvent, validateManifest } from "../src/index.js";
import { clone, fixture } from "./helpers.js";

const PROJECT_ROUTE = "/workspaces/{workspaceId}/projects/{projectId}";

// One table for every consumer of the credential text rules: the catalog
// redacts exactly what the failure-event validator rejects.
const TEXT_CASES: Array<[text: string, credential: boolean, secrets?: string[]]> = [
  // A credential-named key, bare or quoted and percent-decoded, makes its whole value a credential: HTTP headers...
  ["Authorization: Basic dTpw", true, ["dTpw"]],
  ["authorization: basic YTpi", true, ["YTpi"]],
  ["Authorization: Bearer abc", true, ["abc"]],
  ["Authorization:Bearer tokenABCDEFG", true, ["tokenABCDEFG"]],
  ["authorization: abcdefgh", true, ["abcdefgh"]],
  ["Authorization: missing", true, ["missing"]],
  ["X-Api-Key: SEEDxak01", true, ["SEEDxak01"]],
  ["Proxy-Authorization: Digest username=\"u\", nonce=\"SEEDnonce01\", response=\"SEEDresp01\"", true, ["SEEDnonce01", "SEEDresp01"]],
  ["Cookie: session=credential123", true, ["credential123"]],
  ["Cookie: sid=\"SEEDcookie01\"", true, ["SEEDcookie01"]],
  ["Set-Cookie: sid=abc; Path=/", true, ["sid=abc"]],
  ["Set-Cookie: \"sid=SEEDcookie02; Path=/\"", true, ["SEEDcookie02"]],
  // ...JSON and JS object literals...
  ['{"Authorization":"Bearer abcdefghijkl"}', true, ["abcdefghijkl"]],
  ['{"Cookie":"session=abcdefgh"}', true, ["abcdefgh"]],
  ["headers: { authorization: 'Bearer abcdefghij' }", true, ["abcdefghij"]],
  ['Authorization="Bearer abcdefghijk"', true, ["abcdefghijk"]],
  // ...and query strings, where "_" and percent-encoding do not hide the key.
  ["client_secret=SEEDcs01 aws_secret_access_key=SEEDaws01 session_token=SEEDst01", true, ["SEEDcs01", "SEEDaws01", "SEEDst01"]],
  ["GET /v1?api%5Fkey=SEEDpct01", true, ["SEEDpct01"]],
  // The whole value is a credential: scheme words count outside Authorization headers, and a placeholder prefix hides nothing.
  ["token=Bearer abcdefgh", true, ["abcdefgh"]],
  ["client_secret=Bearer", true, ["Bearer"]],
  ["api_key=***SEEDstar01", true, ["SEEDstar01"]],
  ["Authorization: Bearer <token>SEEDph01", true, ["SEEDph01"]],
  // ...also on the next line (YAML block style) or as an XML element.
  ["password:\n  SEEDyaml01", true, ["SEEDyaml01"]],
  ["<password>SEEDxml01</password>", true, ["SEEDxml01"]],
  // Connection strings and provider keys.
  ["Server=db;User Id=sa;Pwd=SEEDpwd01;", true, ["SEEDpwd01"]],
  ["AccountName=x;AccountKey=SEEDacct01+/==;", true, ["SEEDacct01"]],
  ["key=AIzaSyA1234567890abcdefghijklmnopqrstuv", true, ["AIzaSyA1234567890abcdefghijklmnopqrstuv"]],
  // A standalone scheme counts only before a token-shaped word.
  ["sent Bearer abcdefgh12345678", true, ["abcdefgh12345678"]],
  ["retry with Basic dTpwYXNzWord.", true, ["dTpwYXNzWord"]],
  ["retry with bearer abc123def456", true, ["abc123def456"]],
  // Prose and placeholders are kept.
  ["Basic information about projects", false],
  ["basic validation failed", false],
  ["Basic internationalization support", false],
  ["Bearer authentication required", false],
  ["Bearer authentication/authorization required", false],
  ["sent Bearer abcdefghijklmnop", false],
  ["Requires HTTP Basic authentication", false],
  ["Basic HTTP/1.1 authentication", false],
  ["Send Bearer token-based credentials", false],
  ["Bearer OAuth2.0 tokens are accepted", false],
  ["Authorization failed for user", false],
  ["token expired", false],
  ["Send Authorization: Bearer <token>", false],
  ["Authorization: Bearer {{token}}", false],
  ["Authorization: Bearer [REDACTED]", false],
  ['Authorization: Digest username="<user>", response="<response>"', false],
  ["Cookie: session=<id>", false],
  ["token=<your token>", false],
  ['{"password": "<password>"}', false],
  ["https://api.example.test/v1?tenant=eu", false],
];

describe("credential text rules", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(TEXT_CASES)("%s -> credential: %s", (text, credential, secrets = []) => {
    expect(containsCredentialValue(text)).toBe(credential);

    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = text;
    const { catalog, diagnostics } = buildOperationCatalog(nextSpec, clone(manifest));
    const description = catalog!.operations.find((operation) => operation.id === "projects.get")!.description;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "CREDENTIAL_REDACTED")).toBe(credential);
    if (credential) {
      expect(description).toContain("[REDACTED]");
      for (const secret of secrets) expect(description).not.toContain(secret);
      // Redacted text is clean: redaction is idempotent.
      expect(containsCredentialValue(description!)).toBe(false);
    } else {
      expect(description).toBe(text);
    }

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(result.ok).toBe(!credential);
    if (!result.ok) expect(result.issues.map((issue) => `${issue.path} ${issue.code}`)).toEqual(["/failure/message CREDENTIAL_VALUE"]);
  });
});

// Every key form, separator and value shape: the redacted span must cover the whole value.
const SEED = "hunter2SEEDx9";
const KEY_FORMS: Array<[form: string, key: string, quote: string]> = [
  ["bare", "password", ""],
  ["quoted", '"password"', '"'],
  ["escaped-quoted", '\\"password\\"', '\\"'],
  ["two-word", "API key", ""],
];
const SEPARATORS = [":", "=", "=>", ":="];
const VALUE_SHAPES: Array<[shape: string, value: (quote: string) => string]> = [
  ["plain", () => SEED],
  ["quoted", (quote) => `${quote || '"'}${SEED}${quote || '"'}`],
  ["placeholder-prefixed", () => `<token>${SEED}`],
  ["scheme-prefixed", () => `Bearer ${SEED}`],
  ["object", (quote) => `{${quote || '"'}value${quote || '"'}: ${quote || '"'}${SEED}${quote || '"'}}`],
  ["array", (quote) => `[${quote || '"'}${SEED}${quote || '"'}]`],
];
const MATRIX = KEY_FORMS.flatMap(([form, key, quote]) =>
  SEPARATORS.flatMap((separator) =>
    ["", " "].flatMap((space) =>
      VALUE_SHAPES.map(([shape, value]) => ({ name: `${form} ${JSON.stringify(separator + space)} ${shape}`, text: `Failed: ${key}${space}${separator}${space}${value(quote)} (retry)` }))
    )
  )
);

describe("credential value spans", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(MATRIX)("$name", ({ text }) => {
    expect(containsCredentialValue(text)).toBe(true);
    expect(redactCredentialValues(text)).not.toContain(SEED);

    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = text;
    const built = buildOperationCatalog(nextSpec, clone(manifest));
    expect(built.catalog).not.toBeNull();
    expect(JSON.stringify(built)).not.toContain(SEED);

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SEED);
  });
});

// Keys are quoted back in pointers and messages, so every report goes through one sanitizer.
const KEY_SEEDS = [`https://user:${SEED}@host.test`, `//user:${SEED}@host.test`, `sk_live_${SEED}abcd`, `token=${SEED}`];

describe("reports never quote credential keys", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");
  const catalog = buildOperationCatalog(clone(spec), clone(manifest)).catalog!;

  it.each(KEY_SEEDS)("%s", (key) => {
    const property = clone(spec);
    property.components.schemas.ProjectInput.properties[key] = { type: "string" };
    const reference = clone(spec);
    reference.paths[PROJECT_ROUTE].get.parameters.push({ $ref: `#/components/parameters/${key.replace(/~/g, "~0").replace(/\//g, "~1")}` });
    const unknownField = { ...clone(manifest), [key]: 1 };
    const unknownBinding = clone(manifest);
    unknownBinding.operations[0][key] = true;

    const results: Array<[string, { diagnostics?: unknown[]; issues?: unknown[] }]> = [
      ["catalog property name", buildOperationCatalog(property, clone(manifest))],
      ["catalog $ref target", buildOperationCatalog(reference, clone(manifest))],
      ["manifest field", validateManifest(unknownField)],
      ["manifest binding field", buildOperationCatalog(clone(spec), unknownBinding)],
      ["event field", validateClientFailureEvent({ ...clone(event), failure: { kind: "unknown", [key]: 1 } }) as never],
      ["event attribute", validateClientFailureEvent({ ...clone(event), attributes: { [key]: 1 } }) as never],
      ["event non-plain value", validateClientFailureEvent({ ...clone(event), failure: { kind: "unknown", [key]: new Map() } }) as never],
      ["release non-plain value", createReleaseDescriptor({ catalog: { ...clone(catalog), [key]: new Date(0) } as never, generator: { name: "gen", version: "1.0.0" }, artifacts: [] })],
    ];
    for (const [name, result] of results) {
      const reports = result.diagnostics ?? result.issues ?? [];
      expect(reports.length, name).toBeGreaterThan(0);
      expect(JSON.stringify(result), name).not.toContain(SEED);
    }
  });
});
