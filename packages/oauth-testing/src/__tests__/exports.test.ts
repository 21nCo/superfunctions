import { describe, expect, it } from "vitest";
import { InMemoryOAuthStateStore, InMemoryTokenVault, createMockOAuthProviderDescriptor } from "../index.js";
import { MemoryOAuthStateStore, MemoryTokenVault } from "@superfunctions/oauth-storage";

describe("oauth-testing exports", () => {
  it("re-exports shared memory helpers", () => {
    expect(InMemoryOAuthStateStore).toBe(MemoryOAuthStateStore);
    expect(InMemoryTokenVault).toBe(MemoryTokenVault);
  });

  it("provides in-memory helpers", async () => {
    const descriptor = createMockOAuthProviderDescriptor();
    const store = new InMemoryOAuthStateStore();
    const vault = new InMemoryTokenVault();

    await store.put({
      stateId: "st_1",
      tenantId: "tenant_1",
      userId: "user_1",
      providerId: descriptor.id,
      redirectUri: "https://app.example/callback",
      requestedScopes: ["read"],
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z"
    });

    await vault.put({
      tokenId: "tok_1",
      tenantId: "tenant_1",
      userId: "user_1",
      providerId: descriptor.id,
      connectionId: "conn_1",
      encryptedPayload: "cipher",
      keyRef: "key_1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z"
    });

    expect((await store.get("st_1"))?.providerId).toBe("mock");
    expect((await vault.getByConnection("conn_1"))?.tokenId).toBe("tok_1");
  });
});
