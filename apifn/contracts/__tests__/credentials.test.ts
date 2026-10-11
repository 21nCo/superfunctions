import { describe, expect, it } from "vitest";
import { buildOperationCatalog, containsCredentialValue, validateClientFailureEvent } from "../src/index.js";
import { clone, fixture } from "./helpers.js";

const PROJECT_ROUTE = "/workspaces/{workspaceId}/projects/{projectId}";

// One table for every consumer of the credential text rules: the catalog
// redacts exactly what the failure-event validator rejects.
const TEXT_CASES: Array<[text: string, credential: boolean, secret?: string]> = [
  // Header context is a credential at any length.
  ["Authorization: Basic dTpw", true, "dTpw"],
  ["authorization: basic YTpi", true, "YTpi"],
  ["Authorization: Bearer abc", true, "abc"],
  ["Authorization: Bearer tokenABCDEFG", true, "tokenABCDEFG"],
  ["Proxy-Authorization: Digest c2VjcmV0", true, "c2VjcmV0"],
  ["Authorization: a1b2c3d4", true, "a1b2c3d4"],
  ["Cookie: session=credential123", true, "credential123"],
  ["Set-Cookie: sid=abc; Path=/", true, "sid=abc"],
  // A standalone scheme counts only before a token-shaped word.
  ["sent Bearer abcdefghijklmnop", true, "abcdefghijklmnop"],
  ["retry with Basic dTpwYXNz.", true, "dTpwYXNz"],
  ["retry with bearer abc123", true, "abc123"],
  // Prose and placeholders are kept.
  ["Basic information about projects", false],
  ["basic validation failed", false],
  ["Bearer authentication required", false],
  ["Requires HTTP Basic authentication", false],
  ["Send Bearer token-based credentials", false],
  ["Bearer OAuth tokens are accepted", false],
  ["Send Authorization: Bearer <token>", false],
  ["Authorization: Bearer {{token}}", false],
  ["Authorization: missing", false],
  ["Cookie: session=<id>", false],
];

describe("credential text rules", () => {
  const spec = fixture("catalog/openapi.json");
  const manifest = fixture("catalog/manifest.json");
  const event = fixture("client-failure/valid/network-minimal.json");

  it.each(TEXT_CASES)("%s -> credential: %s", (text, credential, secret) => {
    expect(containsCredentialValue(text)).toBe(credential);

    const nextSpec = clone(spec);
    nextSpec.paths[PROJECT_ROUTE].get.description = text;
    const { catalog, diagnostics } = buildOperationCatalog(nextSpec, clone(manifest));
    const description = catalog!.operations.find((operation) => operation.id === "projects.get")!.description;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "CREDENTIAL_REDACTED")).toBe(credential);
    if (credential) {
      expect(description).toContain("[REDACTED]");
      expect(description).not.toContain(secret);
    } else {
      expect(description).toBe(text);
    }

    const result = validateClientFailureEvent({ ...clone(event), failure: { kind: "http", httpStatus: 401, message: text } });
    expect(result.ok).toBe(!credential);
    if (!result.ok) expect(result.issues.map((issue) => `${issue.path} ${issue.code}`)).toEqual(["/failure/message CREDENTIAL_VALUE"]);
  });
});
