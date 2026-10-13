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
import { clone, fixture, LINEAR_RATIO, SCALING_TIMEOUT, scalingRatio } from "./helpers.js";

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

// A placeholder exempts a value only when all of it is placeholders: the value runs to its real delimiter, so
// text straight after a placeholder is judged with it. placeholder x suffix x syntax.
const SUFFIX_SEED = "SEEDtail9911";
const PLACEHOLDERS = ["[REDACTED]", "{{token}}", "<token>", "$TOKEN"];
const PLACEHOLDER_SYNTAXES: Array<[syntax: string, render: (value: string) => string]> = [
  ["key=", (value) => `token=${value}`],
  ["Authorization:", (value) => `Authorization: ${value}`],
  ["JSON value", (value) => `{"token":"${value}"}`],
];
const PLACEHOLDER_MATRIX = PLACEHOLDERS.flatMap((placeholder) =>
  ["", SUFFIX_SEED].flatMap((suffix) =>
    PLACEHOLDER_SYNTAXES.map(([syntax, render]) => ({ name: `${syntax} ${placeholder}${suffix ? " + suffix" : ""}`, text: render(`${placeholder}${suffix}`), credential: suffix !== "" }))
  )
);

describe("placeholder values", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(PLACEHOLDER_MATRIX)("$name", ({ text, credential }) => {
    expect(containsCredentialValue(text)).toBe(credential);

    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = text;
    const built = buildOperationCatalog(nextSpec, clone(manifest));
    expect(built.catalog).not.toBeNull();
    expect(JSON.stringify(built)).not.toContain(SUFFIX_SEED);
    if (!credential) expect(built.catalog!.operations.find((operation) => operation.id === "projects.get")!.description).toBe(text);

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(result.ok).toBe(!credential);
    expect(JSON.stringify(result)).not.toContain(SUFFIX_SEED);
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

// Container boundaries skip strings: a delimiter inside a sibling string never splits the name field from the value field.
// delimiter x position of the sibling x member order x syntax (XML attributes only for < and >).
const DELIMITERS = ["{", "}", "[", "]", "<", ">"];
const SIBLING_POSITIONS = ["before name", "between", "after value"] as const;
const QUOTED_DELIMITER_SYNTAXES: Array<[syntax: string, delimiters: string[], render: (members: Array<[string, string]>) => string]> = [
  ["JSON", DELIMITERS, (members) => `{${members.map(([key, value]) => `"${key}":"${value}"`).join(",")}}`],
  ["escaped JSON", DELIMITERS, (members) => `{${members.map(([key, value]) => `\\"${key}\\":\\"${value}\\"`).join(",")}}`],
  ["JS literal", DELIMITERS, (members) => `[{${members.map(([key, value]) => `${key}: '${value}'`).join(", ")}}]`],
  ["XML attributes", ["<", ">"], (members) => `<add ${members.map(([key, value]) => `${key}="${value}"`).join(" ")}/>`],
];
const QUOTED_DELIMITER_MATRIX = QUOTED_DELIMITER_SYNTAXES.flatMap(([syntax, delimiters, render]) =>
  delimiters.flatMap((delimiter) =>
    SIBLING_POSITIONS.flatMap((position) =>
      [true, false].map((nameFirst) => {
        const pair: Array<[string, string]> = nameFirst ? [["name", "password"], ["value", NAME_SEED]] : [["value", NAME_SEED], ["name", "password"]];
        const note: [string, string] = ["note", delimiter];
        const members = position === "before name" ? [note, ...pair] : position === "between" ? [pair[0], note, pair[1]] : [...pair, note];
        return { name: `${syntax} "${delimiter}" ${position} ${nameFirst ? "name first" : "value first"}`, text: `Request failed: ${render(members)}` };
      })
    )
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

  it.each([
    ["headerName/headerValue", `{"headerName":"x-api-key","headerValue":"${NAME_SEED}"}`],
    ["header_name/header_value", `{"header_name":"x-api-key","header_value":"${NAME_SEED}"}`],
    ["paramName/paramValue", `{"paramName":"api_key","paramValue":"${NAME_SEED}"}`],
    ["parameter/parameterValue", `{"parameter":"api_key","parameterValue":"${NAME_SEED}"}`],
    ["fieldName/fieldValue", `{"fieldName":"password","fieldValue":"${NAME_SEED}"}`],
    ["name/default", `{"name":"api_key","in":"query","default":"${NAME_SEED}"}`],
    ["name/example", `{"name":"api_key","in":"query","example":"${NAME_SEED}"}`],
  ])("value-field vocabulary mirrors the name fields: %s", (_name, text) => {
    expect(containsCredentialValue(text)).toBe(true);
    expect(redactCredentialValues(text)).not.toContain(NAME_SEED);
  });

  // When the structure cannot be trusted, the whole text is one container.
  it.each([
    ["closer that skips a container", `[{"name":"password"], {"value":"${NAME_SEED}"}`],
    ["unterminated quote", `{"name":"password"} it's {"value":"${NAME_SEED}"}`],
    ["ambiguous escaped quote", `{\\"name\\":\\"password\\"} \\"x" {"value":"${NAME_SEED}"}`],
  ])("fails closed on a %s", (_name, text) => {
    expect(containsCredentialValue(text)).toBe(true);
    expect(redactCredentialValues(text)).not.toContain(NAME_SEED);
  });

  // An unquoted closer (in a regex, comment, prose or a bare attribute) leaves a stray closer behind: the structure
  // cannot be trusted, so the whole text is one container.
  it.each([
    ["regex literal", `{name: "password", re: /}/, value: "${NAME_SEED}"}`],
    ["line comment", `{name: "password", // }\n value: "${NAME_SEED}"}`],
    ["prose in parentheses", `{ name: password (see }) value: ${NAME_SEED} }`],
    ["bare bracket value", `[name: password, note: ], value: ${NAME_SEED}]`],
    ["bare XML attribute holding >", `<add key="password" note=a>b value="${NAME_SEED}"/>`],
  ])("fails closed on an unquoted closer in a %s", (_name, text) => {
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

  it("keeps the value of an ordinary header container when sibling strings hold brackets", () => {
    const text = `[{"name":"X-Request-Id","note":"}","value":"req-42"},{"name":"password","note":"{","value":"${NAME_SEED}"}]`;
    expect(redactCredentialValues(text)).toBe('[{"name":"X-Request-Id","note":"}","value":"req-42"},{"name":"password","note":"{","value":"[REDACTED]"}]');
  });

  it.each(QUOTED_DELIMITER_MATRIX)("quoted delimiter: $name", ({ text }) => {
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

/** Each surface that derives from the text rule: detection, a catalog description, a catalog string literal and an event message. */
function expectSeedRemovedEverywhere(text: string, seed: string) {
  expect(containsCredentialValue(text)).toBe(true);
  expect(redactCredentialValues(text)).not.toContain(seed);

  const nextSpec = clone(fixture("catalog/openapi.json"));
  nextSpec.paths[PROJECT_ROUTE].get.description = text;
  nextSpec.components.schemas.ProjectInput.properties.probe = { type: "string", default: text };
  const built = buildOperationCatalog(nextSpec, clone(fixture("catalog/manifest.json")));
  expect(built.catalog).not.toBeNull();
  expect(JSON.stringify(built)).not.toContain(seed);

  const event = fixture("client-failure/valid/network-minimal.json");
  const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(seed);
}

// The value of a credential-named XML element runs to the closing tag that matches it by nesting. A closing tag
// inside CDATA or a comment does not count; where the structure cannot be trusted the value runs to the end.
const XML_SEED = "SEEDxml4411";
const XML_FORMS: Array<[form: string, text: string]> = [
  ["nested same-name element", `<password><password></password>${XML_SEED}</password>`],
  ["nested non-placeholder element", `<password><password>a</password>${XML_SEED}</password>`],
  ["CDATA holding a closing tag", `<password><![CDATA[</password>${XML_SEED}]]></password>`],
  ["comment holding a closing tag", `<password><!-- </password> -->${XML_SEED}</password>`],
  ["nested self-closing element", `<token><token />${XML_SEED}</token>`],
  ["stray closing tag after the element", `<password>a</password>${XML_SEED}</password>`],
  ["closing tag with no opening tag", `log: ${XML_SEED}</password> done`],
  ["unterminated CDATA", `<password><![CDATA[${XML_SEED}</password>`],
  ["unterminated comment", `<password><!-- x ${XML_SEED}</password>`],
  ["element inside a comment", `<!-- <client_secret>${XML_SEED}</client_secret> -->`],
  ["element inside CDATA", `<![CDATA[<client_secret>${XML_SEED}</client_secret>]]>`],
  // An element left open while a closing tag of its name closes a nested element, or falls in a comment, is ambiguous.
  ["open element around a closed same-name element", `<password> <password></password>${XML_SEED}`],
  ["bare tag around a closed same-name element", `<token> x <token>a</token>${XML_SEED}`],
  ["bare tag before a comment holding its closing tag", `<token> <!-- </token> --> ${XML_SEED}`],
];

describe("XML element boundaries", () => {
  it.each(XML_FORMS)("%s", (_form, text) => expectSeedRemovedEverywhere(text, XML_SEED));

  it.each([
    ["flat placeholder", "<password>[REDACTED]</password>"],
    ["CDATA placeholder", "<password><![CDATA[[REDACTED]]]></password>"],
    ["bare placeholder tag in a comment", "<!-- <token> --> then text"],
    ["ordinary nested elements", "<config><timeout>30</timeout><config>x</config></config>"],
    ["lone bare placeholder tag in prose", "Send <token> with each request."],
    ["pair of bare placeholder tags with no closing tag", "Use <token> or <token> here."],
  ])("keeps a %s", (_name, text) => {
    expect(containsCredentialValue(text)).toBe(false);
    expect(redactCredentialValues(text)).toBe(text);
  });
});

// A two-element list opening with a credential key holds its value second, as header entries do. syntax x key.
const POSITIONAL_SEED = "SEEDpair7731";
const POSITIONAL_KEYS: Array<[key: string, value: string]> = [
  ["X-Api-Key", POSITIONAL_SEED],
  ["client_secret", POSITIONAL_SEED],
  ["Authorization", `Bearer ${POSITIONAL_SEED}`],
];
const POSITIONAL_SYNTAXES: Array<[syntax: string, render: (key: string, value: string) => string]> = [
  ["JSON entries", (key, value) => `[["X-Request-Id","req-42"],["${key}","${value}"]]`],
  ["escaped JSON", (key, value) => `{\\"headers\\":[[\\"${key}\\",\\"${value}\\"]]}`],
  ["JS Headers literal", (key, value) => `new Headers([['${key.toLowerCase()}', '${value}']])`],
  ["flat JSON pair", (key, value) => `["${key}", "${value}"]`],
];
const POSITIONAL_MATRIX = POSITIONAL_SYNTAXES.flatMap(([syntax, render]) =>
  POSITIONAL_KEYS.map(([key, value]) => ({ name: `${syntax} ${key}`, text: `Request failed: ${render(key, value)}` }))
);

describe("positional name/value pairs", () => {
  it.each(POSITIONAL_MATRIX)("$name", ({ text }) => expectSeedRemovedEverywhere(text, POSITIONAL_SEED));

  it("keeps the scheme of an Authorization pair", () => {
    expect(redactCredentialValues(`[["Authorization","Bearer ${POSITIONAL_SEED}"]]`)).toBe('[["Authorization","Bearer [REDACTED]"]]');
  });

  it.each([
    ["ordinary header", '[["X-Request-Id","req-42"]]'],
    ["placeholder value", '[["X-Api-Key","[REDACTED]"]]'],
    ["template placeholder", "new Headers([['authorization', `Bearer ${token}`]])"],
    ["list of three field names", '["password","email","name"]'],
    ["unquoted variable names", "const [token, setToken] = useState()"],
  ])("keeps a %s", (_name, text) => {
    expect(containsCredentialValue(text)).toBe(false);
    expect(redactCredentialValues(text)).toBe(text);
  });
});

// One pair grammar for text and structured data: `[` or `(`, the key trimmed inside its quotes, a comma, the value,
// an optional trailing comma, then the matching `]` or `)`. form x key.
const PAIR_FORMS: Array<[form: string, render: (key: string, value: string) => string, structured?: (key: string, value: string) => unknown]> = [
  ["trailing comma", (key, value) => `["${key}","${value}",]`, (key, value) => [key, value]],
  ["Python tuple", (key, value) => `('${key}', '${value}')`],
  ["tuple in a list", (key, value) => `dict_items([('${key}', '${value}')])`],
  ["key padded inside its quotes", (key, value) => `[" ${key} ","${value}"]`, (key, value) => [` ${key} `, value]],
];
const PAIR_GRAMMAR_MATRIX = PAIR_FORMS.flatMap(([form, render, structured]) =>
  POSITIONAL_KEYS.map(([key, value]) => ({ name: `${form} ${key}`, text: `Request failed: ${render(key, value)}`, literal: structured?.(key, value) }))
);

describe("pair grammar", () => {
  it.each(PAIR_GRAMMAR_MATRIX)("$name", ({ text, literal }) => {
    expectSeedRemovedEverywhere(text, POSITIONAL_SEED);
    if (literal === undefined) return;
    const nextSpec = clone(fixture("catalog/openapi.json"));
    nextSpec.components.schemas.ProjectInput.properties.probe = { type: "array", default: literal };
    const built = buildOperationCatalog(nextSpec, clone(fixture("catalog/manifest.json")));
    expect(built.catalog).not.toBeNull();
    expect(JSON.stringify(built)).not.toContain(POSITIONAL_SEED);
    expect(built.diagnostics).toContainEqual(expect.objectContaining({ code: "CREDENTIAL_REDACTED", pointer: "/components/schemas/ProjectInput/properties/probe/default" }));
  });

  it("keeps the scheme of an Authorization tuple", () => {
    expect(redactCredentialValues(`('Authorization', 'Bearer ${POSITIONAL_SEED}')`)).toBe("('Authorization', 'Bearer [REDACTED]')");
  });

  it.each([
    ["ordinary header with a trailing comma", '["X-Request-Id","req-42",]'],
    ["ordinary header tuple", "dict_items([('X-Request-Id', 'req-42')])"],
    ["placeholder tuple", "('X-Api-Key', '[REDACTED]')"],
    ["tuple of three field names", "('password', 'email', 'name')"],
    ["list of three with a trailing comma", '["password","email","name",]'],
  ])("keeps a %s", (_name, text) => {
    expect(containsCredentialValue(text)).toBe(false);
    expect(redactCredentialValues(text)).toBe(text);
  });
});

// An unquoted value runs to the end of its line, never stopping at a space inside it; only a delimiter of the
// surrounding syntax ends it earlier. syntax x surface.
const PLAIN_SEED = "SEEDplain5521";
const PLAIN_FORMS: Array<[form: string, text: string]> = [
  ["YAML inline", `password: first ${PLAIN_SEED}`],
  ["connection string", `Server=db;Pwd=first ${PLAIN_SEED};`],
  ["X-Api-Key header", `X-Api-Key: first ${PLAIN_SEED}`],
  ["logfmt", `level=error password=first ${PLAIN_SEED} msg=x`],
  ["query string", `?password=first ${PLAIN_SEED}&x=1`],
  ["JS unquoted", `{password: first ${PLAIN_SEED}, x: 1}`],
  ["prose", `The API key: first ${PLAIN_SEED} was rejected`],
  ["placeholder then text", `password: <token> ${PLAIN_SEED}`],
  ["unbalanced group in the value", `{password: f(${PLAIN_SEED}, x: 1}`],
  ["stray closer in the value", `password: a) ${PLAIN_SEED}`],
  ["comma outside a container", `token=a, ${PLAIN_SEED}`],
];

// A quote escaped at any depth delimits like a quote escaped once: JSON stringified one to three times.
const stringified = (value: unknown, depth: number): string => (depth === 0 ? JSON.stringify(value) : JSON.stringify(stringified(value, depth - 1)));
const ESCAPED_FORMS: Array<[form: string, text: string]> = [1, 2, 3].flatMap((depth): Array<[string, string]> => [
  [`key/value stringified ${depth}x`, stringified({ password: PLAIN_SEED }, depth)],
  [`pair stringified ${depth}x`, stringified([["X-Api-Key", PLAIN_SEED]], depth)],
  [`name/value stringified ${depth}x`, stringified({ name: "client_secret", value: PLAIN_SEED }, depth)],
  [`escaped quote inside a value stringified ${depth}x`, stringified({ password: `a"${PLAIN_SEED}` }, depth)],
]);

describe("unquoted value boundaries", () => {
  it.each(PLAIN_FORMS)("%s", (_form, text) => expectSeedRemovedEverywhere(text, PLAIN_SEED));

  it.each([
    ["a container member ends at its comma", `{password: first ${PLAIN_SEED}, x: 1}`, "{password: [REDACTED], x: 1}"],
    ["a container member ends at its closer", `[password=first ${PLAIN_SEED}] next`, "[password=[REDACTED]] next"],
    ["a query parameter ends at &", `?password=first ${PLAIN_SEED}&x=1`, "?password=[REDACTED]&x=1"],
    ["a connection setting ends at ;", `Server=db;Pwd=first ${PLAIN_SEED};Database=x`, "Server=db;Pwd=[REDACTED];Database=x"],
    ["a YAML value ends at a comment", `password: first ${PLAIN_SEED} # rotate monthly\nnext: kept`, "password: [REDACTED] # rotate monthly\nnext: kept"],
    ["a value in a string ends at its closing quote", `{"m":"password: first ${PLAIN_SEED}","x":1}`, '{"m":"password: [REDACTED]","x":1}'],
    ["a comma in a string does not end the value", `{"m":"password: a, ${PLAIN_SEED}","x":1}`, '{"m":"password: [REDACTED]","x":1}'],
    ["a value ends at the end of its line", `password: first ${PLAIN_SEED}\nnext: kept`, "password: [REDACTED]\nnext: kept"],
    ["a pair value ends at the pair's closer", `('client_secret', first ${PLAIN_SEED}) next`, "('client_secret', [REDACTED]) next"],
  ])("%s", (_name, text, redacted) => {
    expect(redactCredentialValues(text)).toBe(redacted);
  });

  it.each([
    ["placeholder alone after prose", "Enter your password: <password>"],
    ["placeholder value", "password: <token>"],
    ["placeholders and whitespace", "password: <token> {{token}}"],
    ["placeholder member of a container", "{password: <token>, user: me}"],
    ["ordinary header line", "X-Request-Id: req 42"],
    ["ordinary header pair", '["X-Request-Id", "req-42"]'],
  ])("keeps a %s", (_name, text) => {
    expect(containsCredentialValue(text)).toBe(false);
    expect(redactCredentialValues(text)).toBe(text);
  });
});

describe("quotes escaped at any depth", () => {
  it.each(ESCAPED_FORMS)("%s", (_form, text) => expectSeedRemovedEverywhere(text, PLAIN_SEED));

  it.each([1, 2, 3])("keeps the delimiters and ordinary members stringified %ix", (depth) => {
    const text = stringified({ password: PLAIN_SEED, region: "eu" }, depth);
    expect(redactCredentialValues(text)).toBe(stringified({ password: "[REDACTED]", region: "eu" }, depth));
  });

  it.each([1, 2, 3])("keeps an ordinary pair and a placeholder stringified %ix", (depth) => {
    const text = stringified({ headers: [["X-Request-Id", "req-42"]], password: "<password>" }, depth);
    expect(containsCredentialValue(text)).toBe(false);
  });
});

// A quoted name counts as the structured rule reads it: trimmed, of one or more words.
const PADDED_NAMES: Array<[form: string, name: string]> = [
  ["padded trailing", "X-Api-Key "],
  ["padded leading", " X-Api-Key"],
  ["two-word", "API key"],
];
const NAME_SYNTAXES: Array<[syntax: string, render: (name: string, value: string) => string]> = [
  ["JSON", (name, value) => JSON.stringify({ name, value })],
  ["escaped JSON", (name, value) => stringified({ name, value }, 1)],
  ["JS list literal", (name, value) => `[{name: '${name}', value: '${value}'}]`],
  ["XML attributes", (name, value) => `<add key="${name}" value="${value}"/>`],
];
const PADDED_NAME_MATRIX = PADDED_NAMES.flatMap(([form, name]) =>
  NAME_SYNTAXES.map(([syntax, render]): [string, string] => [`${form} name in ${syntax}`, render(name, NAME_SEED)])
);

describe("name/value names read like structured names", () => {
  it.each(PADDED_NAME_MATRIX)("%s", (_form, text) => expectSeedRemovedEverywhere(text, NAME_SEED));

  it.each(NAME_SYNTAXES)("keeps a padded ordinary name in %s", (_syntax, render) => {
    const text = render("X-Request-Id ", "req-42");
    expect(containsCredentialValue(text)).toBe(false);
    expect(redactCredentialValues(text)).toBe(text);
  });
});

// When the text rule fires on a catalog string, the whole string is replaced: no part of the value survives a boundary misread.
const ABSENT_SEED = "SEEDabsent6631";
const PARTIAL_FORMS: Array<[form: string, text: string]> = [
  ["shell double-quote concatenation", `PASSWORD="first"${ABSENT_SEED}`],
  ["shell concatenation after a quoted placeholder", `PASSWORD="***"${ABSENT_SEED}`],
  ["single-quote concatenation", `password='abc'${ABSENT_SEED}`],
  ["quoted value then text", `password: "first" ${ABSENT_SEED}`],
  ["pair value quoted then text", `["X-Api-Key", "first"${ABSENT_SEED}]`],
  ["escaped concatenation", `{\\"password\\":\\"first\\"${ABSENT_SEED}}`],
  ["apostrophe before the key", `Can't authenticate with password: abc'${ABSENT_SEED}`],
  ["apostrophes around the value", `Bob's password: first O'Brien ${ABSENT_SEED}`],
];

describe("detected credentials are absent from the catalog", () => {
  /** The fixture with `text` as an operation description and as a string default. */
  const built = (text: string) => {
    const nextSpec = clone(fixture("catalog/openapi.json"));
    nextSpec.paths[PROJECT_ROUTE].get.description = text;
    nextSpec.components.schemas.ProjectInput.properties.probe = { type: "string", default: text };
    const result = buildOperationCatalog(nextSpec, clone(fixture("catalog/manifest.json")));
    const operation = result.catalog?.operations.find((entry) => entry.path === PROJECT_ROUTE && entry.method === "get");
    const probe = (result.catalog?.schemas.ProjectInput as any)?.properties.probe;
    return { result, description: operation?.description, literal: probe?.default };
  };

  it.each(PARTIAL_FORMS)("%s", (_form, text) => {
    expect(containsCredentialValue(text)).toBe(true);
    const event = fixture("client-failure/valid/network-minimal.json");
    const rejected = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain(ABSENT_SEED);
    const { result, description, literal } = built(text);
    expect(result.catalog).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(ABSENT_SEED);
    expect([description, literal]).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "CREDENTIAL_REDACTED").map((diagnostic) => diagnostic.pointer).sort()).toEqual([
      "/components/schemas/ProjectInput/properties/probe/default",
      `/paths/${PROJECT_ROUTE.replace(/\//g, "~1")}/get/description`,
    ]);
  });

  it.each([
    ["ordinary prose", "Returns the project; callers need read access."],
    ["ordinary header line", "X-Request-Id: req-42"],
    ["ordinary header pair", '["X-Request-Id", "req-42"]'],
    ["placeholder value", "password: <token>"],
    ["placeholder after prose", "Enter your password: <password>"],
  ])("keeps %s", (_name, text) => {
    const { result, description, literal } = built(text);
    expect([description, literal]).toEqual([text, text]);
    expect(result.diagnostics).toEqual([]);
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
    // A comment after the key is text of its own: the block consumes the key's value, not what the comment holds.
    ["a credential in a comment above a block", `password: # token=${SEED}a\n  ${SEED}b\nnext: kept`, "password: # token=[REDACTED]\n  [REDACTED]\nnext: kept"],
    ["a credential in a comment above a placeholder block", `password: # token=${SEED}a\n  <password>\nnext: kept`, "password: # token=[REDACTED]\n  <password>\nnext: kept"],
  ])("%s", (_name, text, kept) => {
    const redacted = redactCredentialValues(text);
    expect(redacted).not.toContain(SEED);
    if (kept === null) expect(containsCredentialValue(text)).toBe(true);
    else expect(redacted).toContain(kept);
  });
});

// Every rule is linear in the text: long runs that a backtracking pattern, or a per-match scan reaching past the
// span the match consumes, would rescan per character. Each row is timed at n and 4n characters.
const LONG = 100_000;
const repeat = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const run = (unit: string) => (size: number) => repeat(unit, size);
const LONG_TEXTS: Array<[string, (size: number) => string]> = [
  ["a+ chain", run("a+")],
  ["dotted words", run("a.")],
  ["Authorization header word", (n) => `Authorization: ${repeat("a", n)}`],
  ["scheme-like run", (n) => `https://${repeat("a", n)}`],
  ["spaced words", run("ab ")],
  ["slashes", run("//a")],
  ["escaped quotes", (n) => `password="${repeat('\\"', n)}`],
  ["open brackets", (n) => `password=${repeat("[", n)}`],
  ["Bearer repeats", run("Bearer x")],
  ["key separators", run("token=a ")],
  ["YAML keys", run("password:\n")],
  ["YAML block lines", (n) => `password: |\n${repeat("  a\n", n)}`],
  ["Digest parameters", (n) => `Authorization: Digest ${repeat('a="b", ', n)}`],
  ["at signs", run("x@")],
  ["XML placeholder tags", run("<password> ")],
  ["unclosed XML elements", run("<password>x")],
  ["XML tags with attributes", run('<token a="b">')],
  ["namespace chain", run("a:")],
  ["credential namespaces", run("password:a")],
  ["distinct unclosed XML tags", (n) => Array.from({ length: n / 10 }, (_, index) => `<token_${index}> `).join("").slice(0, n)],
  ["distinct XML tags then closings", (n) => `${Array.from({ length: n / 20 }, (_, index) => `<token_${index}>a`).join("")}${Array.from({ length: n / 20 }, (_, index) => `</token_${index}>`).join("")}`],
  ["credential XML attributes", run('<password a="b" ')],
  ["named containers", run('{"name":"token","value":[')],
  ["named containers closed", run('[{"name":"token","value":"<x>"},')],
  ["quoted brackets", run('{"name":"token","note":"}]>{[<a","value":"<x>"},')],
  ["unterminated quotes", (n) => `{"name":"token"} ${repeat("'{[<a ", n)}`],
  ["stray closers", (n) => `{"name":"token"}${repeat("}]>", n)}`],
  ["unquoted closers in prose", (n) => `{"name":"token","value":"x"} ${repeat("a } b ] c > ", n)}`],
  ["placeholders followed by text", run("token=[REDACTED]a{{b}}c ")],
  ["deep nesting", (n) => `${repeat("[{", n)}"name":"token","value":"x"`],
  ["escaped quote values", run('password=\\"a\\\\')],
  ["PEM headers", run("-----BEGIN PRIVATE KEY PRIVATE KEY ")],
  ["special scheme runs", run("https:")],
  ["special scheme backslashes", (n) => `https:${repeat("\\", n)}`],
  ["deep same-name XML nesting", (n) => `${repeat("<password>", n)}a${repeat("</password>", n)}`],
  ["XML CDATA sections", run("<password><![CDATA[</password>a]]>")],
  ["XML comments holding closing tags", run("<token><!-- </token> -->")],
  ["unterminated XML comment", (n) => `<password>${repeat("<!-- </password> ", n)}`],
  ["stray XML closing tags", run("a</password>")],
  ["positional pairs", run('[["token","a"],')],
  ["unterminated positional pairs", (n) => `${repeat('["token", ', n)}"a`],
  // Forms whose value check once read to the end of the line or text on every match.
  ["placeholders then a space", run("token=[REDACTED] ")],
  ["template placeholders then a space", run("token={{a}} ")],
  ["bracketed Authorization values", run("Authorization: [x], ")],
  ["pairs with bracketed values", run('["token", [x]] ')],
  ["YAML comments after =", run("token=#a ")],
  ["YAML comments after :", run("password: #x ")],
  ["keys in a YAML comment above a long line", (n) => `password: # ${repeat("a: # ", n / 2)}\n${repeat("x", n / 2)}`],
  ["longer lists nested in pair values", (n) => `${'["token", '.repeat(n / 14)}[x]${", 1]".repeat(n / 14)}`],
  ["tuple pairs", run("('token', 'a'), ")],
  ["ambiguous escaped quotes", run('password=\\"a" ')],
  ["XML closings around open same-name elements", run("<token> <token>a</token> ")],
  // Unquoted values that run to the end of their line, and quotes escaped at depth.
  ["spaced unquoted values", run("password: a b ")],
  ["spaced values in containers", run("{password: a b, x: (c d)}, ")],
  ["spaced pair values", run("('token', a b) ")],
  ["unbalanced groups in values", run("password: a( ")],
  ["values in strings", run('"password: a b", ')],
  ["double-escaped pairs", run('[\\\\\\"X-Api-Key\\\\\\",\\\\\\"a\\\\\\"], ')],
  ["double-escaped key/values", run('{\\\\\\"password\\\\\\":\\\\\\"a\\\\\\"}, ')],
  ["long backslash runs", (n) => `password=${repeat("\\", n)}"`],
  ["nested pair values before many lines", (n) => `${'("token", '.repeat(n / 20)}x${")".repeat(n / 20)}${repeat("\n", n / 2)}`],
  // Padded and two-word names, and the quote forms whose catalog strings are replaced whole.
  ["padded and two-word names", run('{"name":" API key ","value":"a"},')],
  ["apostrophes in prose", run("Bob's password: first O'Brien x ")],
  ["quoted values then text", run('password: "first" a ')],
];

describe("credential rules run in linear time", () => {
  it.each(LONG_TEXTS)("%s", (_name, build) => {
    const texts = new Map([LONG / 4, LONG].map((size) => [size, build(size)]));
    const ratio = scalingRatio((size) => {
      const text = texts.get(size)!;
      containsCredentialValue(text);
      containsCredentialIdentifier(text);
      redactCredentialValues(text);
    }, LONG / 4);
    expect(ratio).toBeLessThan(LINEAR_RATIO);
  }, SCALING_TIMEOUT);

  it("bounds validateManifest and buildOperationCatalog on long keys and descriptions", () => {
    const manifest = fixture("catalog/manifest.json");
    const spec = fixture("catalog/openapi.json");
    const started = performance.now();
    validateManifest({ ...clone(manifest), [repeat("a+", LONG)]: 1 });
    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = repeat("a+", LONG);
    expect(buildOperationCatalog(nextSpec, clone(manifest)).catalog).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
  }, SCALING_TIMEOUT);

  const MEGABYTE = 1_000_000;
  it.each([
    "token=[REDACTED] ",
    "token={{a}} ",
    "Authorization: [x], ",
    '["token", [x]] ',
    "token=#a ",
    "password: #x ",
    "password: a b ",
    '[\\\\\\"X-Api-Key\\\\\\",\\\\\\"a\\\\\\"], ',
    '{"name":" API key ","value":"a"},',
    "Bob's password: first O'Brien x ",
    'password: "first" a ',
  ])("buildOperationCatalog scales linearly up to a 1 MB description of %j", (unit) => {
    const manifest = fixture("catalog/manifest.json");
    const specs = new Map(
      [MEGABYTE / 4, MEGABYTE].map((size) => {
        const nextSpec = clone(fixture("catalog/openapi.json"));
        nextSpec.paths[PROJECT_ROUTE].get.description = repeat(unit, size);
        return [size, nextSpec];
      })
    );
    const ratio = scalingRatio((size) => expect(buildOperationCatalog(specs.get(size)!, clone(manifest)).catalog).not.toBeNull(), MEGABYTE / 4, 2);
    expect(ratio).toBeLessThan(LINEAR_RATIO);
  }, SCALING_TIMEOUT);
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
