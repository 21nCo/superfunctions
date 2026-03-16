import { describe, expect, it } from "vitest";
import { ProviderPolicyError, createDefaultProviderPolicyRegistry } from "../src/index.js";

describe("oauth-providers policy registry", () => {
  it("accepts allowed scopes and records consent metadata", () => {
    const registry = createDefaultProviderPolicyRegistry(() => "2026-03-11T00:00:00.000Z");
    const result = registry.validateScopes({
      providerId: "google",
      feature: "mail.read.metadata",
      requestedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      tenantId: "t1",
      userId: "u1",
      purpose: "mail.read.metadata"
    });

    expect(result.authorized).toBe(true);
    expect(result.consentRecord.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(result.consentRecord.purpose).toBe("mail.read.metadata");
    expect(result.consentRecord.policyVersion).toBe("2026-03-11");
    expect(registry.getConsentRecords()).toHaveLength(1);
  });

  it("rejects disallowed scopes with OAUTH_SCOPE_DISALLOWED", () => {
    const registry = createDefaultProviderPolicyRegistry(() => "2026-03-11T00:00:00.000Z");

    expect(() =>
      registry.validateScopes({
        providerId: "google",
        feature: "mail.read.metadata",
        requestedScopes: ["https://mail.google.com/"],
        tenantId: "t1",
        userId: "u1",
        purpose: "mail.read.metadata"
      })
    ).toThrowError(
      expect.objectContaining({
        code: "OAUTH_SCOPE_DISALLOWED",
        message: "requested scope not allowed for feature"
      })
    );
  });

  it("allows provider operation when policy permits it", () => {
    const registry = createDefaultProviderPolicyRegistry();
    const decision = registry.assertOperationAllowed({
      providerId: "google",
      operation: "mail.watch.create",
      featureMode: "metadata-only"
    });

    expect(decision.allowed).toBe(true);
    expect(decision.policyVersion).toBe("2026-03-11");
  });

  it("blocks disallowed operation in metadata-only mode", () => {
    const registry = createDefaultProviderPolicyRegistry();

    expect(() =>
      registry.assertOperationAllowed({
        providerId: "google",
        operation: "mail.read.fullbody",
        featureMode: "metadata-only"
      })
    ).toThrowError(
      expect.objectContaining({
        code: "PROVIDER_POLICY_BLOCKED",
        message: "operation not allowed by policy"
      })
    );
  });

  it("audit-logs policy version changes", () => {
    const registry = createDefaultProviderPolicyRegistry(() => "2026-03-12T12:00:00.000Z");
    const audit = registry.recordPolicyVersionUpdate({
      providerId: "google",
      newVersion: "2026-03-12",
      actor: "admin-user",
      reason: "provider compliance update"
    });

    expect(audit.fromVersion).toBe("2026-03-11");
    expect(audit.toVersion).toBe("2026-03-12");
    expect(audit.actor).toBe("admin-user");
    expect(registry.getPolicy("google").policyVersion).toBe("2026-03-12");
    expect(registry.getPolicyAuditEvents()).toHaveLength(1);
  });

  it("throws validation error for unknown provider policy", () => {
    const registry = createDefaultProviderPolicyRegistry();

    expect(() => registry.getPolicy("unknown" as never)).toThrowError(ProviderPolicyError);
  });
});
