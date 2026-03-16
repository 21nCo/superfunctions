import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import {
  DbAdapterOAuthStateStore,
  DbAdapterTokenVault,
  OAuthDbAdapterError,
  createOAuthDbStorage
} from "../src/index.js";

describe("oauth-storage db adapter bridge", () => {
  it("supports oauth state and token lifecycle via @superfunctions/db adapter", async () => {
    const adapter = memoryAdapter();
    await adapter.initialize();

    const { stateStore, tokenVault, models } = createOAuthDbStorage({ adapter });
    expect(models.oauthStates).toBe("oauth_states");
    expect(models.oauthTokenVault).toBe("oauth_token_vault");

    await stateStore.put({
      stateId: "st_db_1",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      redirectUri: "https://app.example/callback",
      requestedScopes: ["openid"],
      codeVerifier: "verifier",
      nonce: "nonce",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z"
    });

    const state = await stateStore.get("st_db_1");
    expect(state?.providerId).toBe("google");

    const consumed = await stateStore.consume("st_db_1", "2026-01-01T00:01:00.000Z");
    expect(consumed?.consumedAt).toBe("2026-01-01T00:01:00.000Z");
    const replay = await stateStore.consume("st_db_1", "2026-01-01T00:02:00.000Z");
    expect(replay).toBeNull();

    await tokenVault.put({
      tokenId: "tok_db_1",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      connectionId: "conn_db_1",
      encryptedPayload: "{\"accessToken\":\"a1\"}",
      keyRef: "kms_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const tokenById = await tokenVault.get("tok_db_1");
    expect(tokenById?.connectionId).toBe("conn_db_1");

    const tokenByConnection = await tokenVault.getByConnection("conn_db_1");
    expect(tokenByConnection?.tokenId).toBe("tok_db_1");

    await tokenVault.rotateKey("tok_db_1", "kms_2");
    const rotated = await tokenVault.get("tok_db_1");
    expect(rotated?.keyRef).toBe("kms_2");

    await tokenVault.deleteByConnection("conn_db_1");
    expect(await tokenVault.getByConnection("conn_db_1")).toBeNull();
  });

  it("supports explicit model mapping overrides", async () => {
    const adapter = memoryAdapter();
    await adapter.initialize();

    const stateStore = new DbAdapterOAuthStateStore(adapter, "oauth_states_custom");
    const tokenVault = new DbAdapterTokenVault(adapter, "oauth_token_vault_custom");

    await stateStore.put({
      stateId: "st_custom_1",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      redirectUri: "https://app.example/callback",
      requestedScopes: ["openid"],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z"
    });

    await tokenVault.put({
      tokenId: "tok_custom_1",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      connectionId: "conn_custom_1",
      encryptedPayload: "{\"accessToken\":\"a1\"}",
      keyRef: "kms_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect((await stateStore.get("st_custom_1"))?.stateId).toBe("st_custom_1");
    expect((await tokenVault.getByConnection("conn_custom_1"))?.tokenId).toBe("tok_custom_1");
  });

  it("fails deterministically when required schema mapping is missing", async () => {
    const adapter = memoryAdapter();
    await adapter.initialize();

    expect(() => createOAuthDbStorage({ adapter, models: { oauthStates: "" } })).toThrowError(OAuthDbAdapterError);

    expect(() => createOAuthDbStorage({ adapter, models: { oauthStates: "" } })).toThrowError(
      "oauth_states model mapping required"
    );
  });
});
