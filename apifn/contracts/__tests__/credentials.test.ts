import { describe, expect, it } from "vitest";
import { buildOperationCatalog, containsCredentialValue, validateClientFailureEvent } from "../src/index.js";
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
