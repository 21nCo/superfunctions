import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { redactCredentialValues, stripUrlCredentials } from "../src/credentials.js";
import {
  buildOperationCatalog,
  containsCredentialIdentifier,
  containsCredentialValue,
  createReleaseDescriptor,
  validateClientFailureEvent,
  validateManifest,
} from "../src/index.js";
import { clone, fixture } from "./helpers.js";

const PROJECT_ROUTE = "/workspaces/{workspaceId}/projects/{projectId}";

const ED25519_PEM = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const RSA_PEM = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const pemBody = (pem: string) => pem.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));

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
  // An XML value runs from the end of the opening tag (with attributes) to the closing tag, CDATA included; unclosed, to the end.
  ['<password type="string">SEEDxml02</password>', true, ["SEEDxml02"]],
  ["<password><![CDATA[SEEDxml03]]></password>", true, ["SEEDxml03"]],
  ["<password>SEEDxml04 (retry)", true, ["SEEDxml04", "retry"]],
  // Every attribute value of a credential-named element, also on a self-closing tag.
  ['<password id="1" value="SEEDxml05"/>', true, ["SEEDxml05"]],
  ['<password a="b" c="SEEDxml06">x</password>', true, ["SEEDxml06"]],
  ["<password value='SEEDxml07'/>", true, ["SEEDxml07"]],
  // An escaped quote inside an escaped-quoted value does not close it, whatever precedes it.
  [JSON.stringify(JSON.stringify({ password: 'prefix"SEEDED-tail-9911' })), true, ["SEEDED-tail-9911"]],
  [JSON.stringify(JSON.stringify({ password: '[REDACTED]"SEEDED-tail-9912' })), true, ["SEEDED-tail-9912"]],
  ['password=\\"abc"SEEDambig01 rest', true, ["SEEDambig01", "rest"]],
  // PEM private keys through their END line, or to the end of the text when cut off.
  [ED25519_PEM, true, pemBody(ED25519_PEM)],
  [RSA_PEM.slice(0, 900), true, pemBody(RSA_PEM.slice(0, 900)).slice(0, -1)],
  [`key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUSEEDssh01\n-----END OPENSSH PRIVATE KEY-----\ndone`, true, ["SEEDssh01"]],
  // Connection strings and provider keys.
  ["Server=db;User Id=sa;Pwd=SEEDpwd01;", true, ["SEEDpwd01"]],
  ["AccountName=x;AccountKey=SEEDacct01+/==;", true, ["SEEDacct01"]],
  ["key=AIzaSyA1234567890abcdefghijklmnopqrstuv", true, ["AIzaSyA1234567890abcdefghijklmnopqrstuv"]],
  [`use ${"github_pat_" + "A1".repeat(41)} to clone`, true, ["github_pat_" + "A1".repeat(41)]],
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
  ["Send the <password> field, then retry", false],
  ["<password><![CDATA[<password>]]></password>", false],
  ["https://api.example.test/v1?tenant=eu", false],
  ["-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAitZFd5CIGdFlbiqZbNIkspX4T/RzE+0jHdbp5AYXJd4=\n-----END PUBLIC KEY-----\n", false],
  ['{"name":"X-Request-Id","value":"req-42"}', false],
  ['<add key="timeout" value="30"/>', false],
  ['{"name":"X-Api-Key","value":"<api key>"}', false],
  ["https:api.example.test/v1", false],
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
      for (const secret of secrets) expect(JSON.stringify({ catalog, diagnostics })).not.toContain(secret);
      // Redacted text is clean: redaction is idempotent.
      expect(containsCredentialValue(description!)).toBe(false);
    } else {
      expect(description).toBe(text);
    }

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(result.ok).toBe(!credential);
    if (!result.ok) expect(result.issues.map((issue) => `${issue.path} ${issue.code}`)).toEqual(["/failure/message CREDENTIAL_VALUE"]);
    for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret);
  });
});

// Name/value indirection: a value field whose container names a credential header or setting.
// Every name field x container syntax x member order.
const NAME_SEED = "SEEDnamed42x";
const NAME_FIELDS = ["name", "key", "header"];
const NAME_VALUE_SYNTAXES: Array<[syntax: string, render: (field: string, nameFirst: boolean) => string]> = [
  ["JSON", (field, nameFirst) => (nameFirst ? `{"${field}":"X-Api-Key","value":"${NAME_SEED}"}` : `{"value":"${NAME_SEED}","${field}":"X-Api-Key"}`)],
  ["escaped JSON", (field, nameFirst) => (nameFirst ? `{\\"${field}\\":\\"client_secret\\",\\"value\\":\\"${NAME_SEED}\\"}` : `{\\"value\\":\\"${NAME_SEED}\\",\\"${field}\\":\\"client_secret\\"}`)],
  ["JS literal in a list", (field, nameFirst) => (nameFirst ? `headers: [{${field}: 'x-api-key', value: '${NAME_SEED}'}]` : `headers: [{value: '${NAME_SEED}', ${field}: 'x-api-key'}]`)],
  ["XML attributes", (field, nameFirst) => (nameFirst ? `<add ${field}="password" value="${NAME_SEED}"/>` : `<add value="${NAME_SEED}" ${field}="password"/>`)],
];
const NAME_VALUE_MATRIX = NAME_FIELDS.flatMap((field) =>
  NAME_VALUE_SYNTAXES.flatMap(([syntax, render]) =>
    [true, false].map((nameFirst) => ({ name: `${syntax} ${field} ${nameFirst ? "name first" : "value first"}`, text: `Request failed: ${render(field, nameFirst)}` }))
  )
);

describe("name/value indirection", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(NAME_VALUE_MATRIX)("$name", ({ text }) => {
    expect(containsCredentialValue(text)).toBe(true);
    expect(redactCredentialValues(text)).not.toContain(NAME_SEED);

    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = text;
    const built = buildOperationCatalog(nextSpec, clone(manifest));
    expect(built.catalog).not.toBeNull();
    expect(JSON.stringify(built)).not.toContain(NAME_SEED);

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(NAME_SEED);
  });

  it("keeps the value of a container that names an ordinary header, even next to a credential container", () => {
    const text = `[{"name":"X-Request-Id","value":"req-42"},{"name":"Authorization","value":"Bearer ${NAME_SEED}"}]`;
    expect(redactCredentialValues(text)).toBe('[{"name":"X-Request-Id","value":"req-42"},{"name":"Authorization","value":"Bearer [REDACTED]"}]');
  });
});

// URL user info for special schemes needs no "//": URL parsers read it after any run of "/" or "\\", even none.
const URL_SEED = "hunter2pwSEED";
const USER_INFO_URLS = [
  `https:svc:${URL_SEED}@api.example.test/v1`,
  `https:/svc:${URL_SEED}@api.example.test/v1`,
  `https:\\\\svc:${URL_SEED}@api.example.test/v1`,
  `https:\\svc:${URL_SEED}@api.example.test/v1`,
  `HTTP:/\\svc:${URL_SEED}@api.example.test/v1`,
  `wss:svc:${URL_SEED}@api.example.test/v1`,
];
const URL_PLACES: Array<[place: string, apply: (spec: Record<string, any>, manifest: Record<string, any>, url: string) => void]> = [
  ["server", (spec, _manifest, url) => (spec.servers = [{ url }])],
  ["OAuth tokenUrl", (spec, _manifest, url) => (spec.components.securitySchemes.oauth.flows.clientCredentials.tokenUrl = url)],
  ["OpenID Connect URL", (spec, _manifest, url) => (spec.components.securitySchemes.oidc = { type: "openIdConnect", openIdConnectUrl: url })],
  ["provenance source", (_spec, manifest, url) => (manifest.provenance.source = url)],
];

describe("URL user info without //", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(USER_INFO_URLS.flatMap((url) => URL_PLACES.map(([place, apply]) => ({ name: `${place}: ${url}`, url, apply }))))("$name", ({ url, apply }) => {
    expect(containsCredentialValue(url)).toBe(true);
    const nextSpec = clone(spec);
    const nextManifest = clone(manifest);
    apply(nextSpec, nextManifest, url);
    const built = buildOperationCatalog(nextSpec, nextManifest);
    expect(built.catalog).not.toBeNull();
    expect(built.diagnostics.some((diagnostic) => diagnostic.code === "CREDENTIAL_REDACTED")).toBe(true);
    expect(JSON.stringify(built)).not.toContain(URL_SEED);
  });

  it.each(USER_INFO_URLS)("event message: fetch %s failed", (url) => {
    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "network", message: `fetch ${url} failed` } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(URL_SEED);
  });

  it("strips only the user info and keeps the scheme", () => {
    expect(stripUrlCredentials(`https:svc:${URL_SEED}@api.example.test/v1`)).toBe("https:api.example.test/v1");
    expect(stripUrlCredentials(`https:\\svc:${URL_SEED}@api.example.test/v1`)).toBe("https:\\api.example.test/v1");
    expect(stripUrlCredentials("https:api.example.test/v1")).toBe("https:api.example.test/v1");
    // A non-special scheme without "//" has no authority.
    expect(stripUrlCredentials("urn:example:svc@host")).toBe("urn:example:svc@host");
  });
});

// Identifiers use ":" as a namespace separator, but a token-shaped segment after a credential key is still a credential.
// [identifier, credential]: each row drives containsCredentialIdentifier, a catalog scope name and failure.errorCode.
const IDENTIFIER_CASES: Array<[string, boolean]> = [
  ["token:expired", false],
  ["password:too_short", false],
  ["secrets:read", false],
  ["rate:limited", false],
  ["password:hunter2SEED99", true],
  ["api_key:AbCdEf123456Ghij", true],
  ["auth:password:hunter2SEED99", true],
  ["token:abcdefghijklmnopqrst", true],
  ["token=abc123", true],
];

describe("credential identifier rules", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(IDENTIFIER_CASES)("%s -> credential: %s", (identifier, credential) => {
    expect(containsCredentialIdentifier(identifier)).toBe(credential);

    const nextSpec = clone(spec);
    nextSpec.components.securitySchemes.oauth.flows.clientCredentials.scopes[identifier] = "Scope";
    const { catalog, diagnostics } = buildOperationCatalog(nextSpec, clone(manifest));
    const rejected = diagnostics.filter((diagnostic) => diagnostic.code === "INVALID_SPEC" && diagnostic.pointer.includes("/scopes/"));
    expect(rejected.length > 0).toBe(credential);
    if (!credential) expect(catalog!.securitySchemes.oauth.flows!.clientCredentials.scopes).toContain(identifier);

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, errorCode: identifier } });
    expect(result.ok).toBe(!credential);
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

// YAML block values: every block indicator, 1-3 lines, and a key that is itself indented.
const BLOCK_INDICATORS = ["|", "|-", "|+", ">", ">-", ""];
const BLOCK_MATRIX = BLOCK_INDICATORS.flatMap((indicator) =>
  [1, 2, 3].flatMap((lines) =>
    ["", "  "].map((indent) => {
      const seeds = Array.from({ length: lines }, (_, index) => `${SEED}${index}`);
      const head = `${indent}password:${indicator === "" ? "" : ` ${indicator}`}`;
      const text = `config:\n${head}\n${seeds.map((seed) => `${indent}  ${seed}`).join("\n")}\n${indent}region: eu-west`;
      return { name: `${JSON.stringify(indicator || "none")} x ${lines} line(s)${indent ? ", indented key" : ""}`, text, seeds };
    })
  )
);

describe("YAML block values", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(BLOCK_MATRIX)("$name", ({ text, seeds }) => {
    const redacted = redactCredentialValues(text);
    expect(containsCredentialValue(text)).toBe(true);
    for (const seed of seeds) expect(redacted).not.toContain(seed);
    // The block ends at the first line indented no deeper than the key: later lines are kept.
    expect(redacted).toContain("region: eu-west");

    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = text;
    const built = buildOperationCatalog(nextSpec, clone(manifest));
    expect(built.catalog).not.toBeNull();
    for (const seed of seeds) expect(JSON.stringify(built)).not.toContain(seed);

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(result.ok).toBe(false);
    for (const seed of seeds) expect(JSON.stringify(result)).not.toContain(seed);
  });

  it.each([
    ["blank lines inside the block", `password: |\n  ${SEED}a\n\n  ${SEED}b\nnext: kept`, "next: kept"],
    ["mixed tab and space indentation fails closed to the end", `\tpassword:\n    ${SEED}a\n${SEED}b`, null],
    ["a placeholder block is kept", "password: |\n  <password>\nnext: kept", "password: |\n  <password>\nnext: kept"],
  ])("%s", (_name, text, kept) => {
    const redacted = redactCredentialValues(text);
    expect(redacted).not.toContain(SEED);
    if (kept === null) expect(containsCredentialValue(text)).toBe(true);
    else expect(redacted).toContain(kept);
  });
});

// Every rule is linear in the text: long runs that a backtracking pattern would rescan per character.
const LONG = 100_000;
const run = (unit: string) => unit.repeat(Math.ceil(LONG / unit.length)).slice(0, LONG);
const LONG_TEXTS: Array<[string, string]> = [
  ["a+ chain", run("a+")],
  ["dotted words", run("a.")],
  ["Authorization header word", `Authorization: ${run("a")}`],
  ["scheme-like run", `https://${run("a")}`],
  ["spaced words", run("ab ")],
  ["slashes", run("//a")],
  ["escaped quotes", `password="${run('\\"')}`],
  ["open brackets", `password=${run("[")}`],
  ["Bearer repeats", run("Bearer x")],
  ["key separators", run("token=a ")],
  ["YAML keys", run("password:\n")],
  ["YAML block lines", `password: |\n${run("  a\n")}`],
  ["Digest parameters", `Authorization: Digest ${run('a="b", ')}`],
  ["at signs", run("x@")],
  ["XML placeholder tags", run("<password> ")],
  ["unclosed XML elements", run("<password>x")],
  ["XML tags with attributes", run('<token a="b">')],
  ["namespace chain", run("a:")],
  ["credential namespaces", run("password:a")],
  ["distinct unclosed XML tags", Array.from({ length: LONG / 10 }, (_, index) => `<token_${index}> `).join("").slice(0, LONG)],
  ["distinct XML tags then closings", `${Array.from({ length: LONG / 20 }, (_, index) => `<token_${index}>a`).join("")}${Array.from({ length: LONG / 20 }, (_, index) => `</token_${index}>`).join("")}`],
  ["credential XML attributes", run('<password a="b" ')],
  ["named containers", run('{"name":"token","value":[')],
  ["named containers closed", run('[{"name":"token","value":"<x>"},')],
  ["stray closers", `{"name":"token"}${run("}]>")}`],
  ["deep nesting", `${run("[{")}"name":"token","value":"x"`],
  ["escaped quote values", run('password=\\"a\\\\')],
  ["PEM headers", run("-----BEGIN PRIVATE KEY PRIVATE KEY ")],
  ["special scheme runs", run("https:")],
  ["special scheme backslashes", `https:${run("\\")}`],
];

describe("credential rules run in linear time", () => {
  it.each(LONG_TEXTS)("%s", (_name, text) => {
    const started = performance.now();
    containsCredentialValue(text);
    containsCredentialIdentifier(text);
    redactCredentialValues(text);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("bounds validateManifest and buildOperationCatalog on long keys and descriptions", () => {
    const manifest = fixture("catalog/manifest.json");
    const spec = fixture("catalog/openapi.json");
    const started = performance.now();
    validateManifest({ ...clone(manifest), [run("a+")]: 1 });
    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = run("a+");
    expect(buildOperationCatalog(nextSpec, clone(manifest)).catalog).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
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
