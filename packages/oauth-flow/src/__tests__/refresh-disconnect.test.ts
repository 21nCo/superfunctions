import { describe, expect, it, vi } from "vitest";
import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";
import { OAuthHttpError } from "@superfunctions/oauth-http";
import { MemoryOAuthStateStore, MemoryTokenVault } from "@superfunctions/oauth-storage";
import { createOAuthFlowService, type OAuthFlowEvent } from "../index.js";

const provider: OAuthProviderDescriptor = {
  id: "google",
  authorizationUrl: "https://accounts.google.example/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.example/token",
  revocationUrl: "https://oauth2.googleapis.example/revoke",
  defaultScopes: ["openid", "email"],
  supportsPkce: true,
  supportsRefreshToken: true,
  scopeSeparator: " ",
  tokenAuthMethod: "client_secret_post"
};

function createHarness(startAt = "2026-01-01T00:00:00.000Z") {
  let nowMs = Date.parse(startAt);
  const now = () => new Date(nowMs);
  const advanceMs = (ms: number) => {
    nowMs += ms;
  };

  const events: OAuthFlowEvent[] = [];
  const stateStore = new MemoryOAuthStateStore();
  const tokenVault = new MemoryTokenVault();

  const tokenHttpClient = {
    exchangeToken: vi.fn(async (input) => {
      if (input.grantType === "authorization_code") {
        return {
          accessToken: "access-old",
          refreshToken: "refresh-old",
          expiresIn: 3600,
          tokenType: "Bearer",
          scope: "openid email"
        };
      }

      return {
        accessToken: "access-new",
        refreshToken: undefined,
        expiresIn: 7200,
        tokenType: "Bearer",
        scope: "openid email"
      };
    }),
    revokeToken: vi.fn(async () => {})
  };

  const service = createOAuthFlowService({
    providers: { google: provider },
    providerRuntimeConfig: {
      google: {
        clientId: "client_google",
        clientSecret: "secret_google",
        allowlistedRedirectUris: ["https://app.example/callback"]
      }
    },
    stateStore,
    tokenVault,
    tokenHttpClient,
    now,
    emitEvent: (event) => events.push(event)
  });

  return { service, tokenVault, events, tokenHttpClient, advanceMs };
}

async function seedConnection(service: ReturnType<typeof createHarness>["service"], connectionId: string): Promise<void> {
  const started = await service.start({
    providerId: "google",
    tenantId: "tenant_1",
    userId: "user_1",
    connectionId,
    redirectUri: "https://app.example/callback"
  });

  await service.handleCallback({
    code: "auth-code",
    state: started.stateId,
    redirectUri: "https://app.example/callback"
  });
}

describe("oauth-flow refresh/disconnect lifecycle", () => {
  it("refresh() preserves existing refresh token when provider omits replacement", async () => {
    const { service, tokenVault, advanceMs, events } = createHarness();
    await seedConnection(service, "conn_1");
    advanceMs(30_000);

    const refreshed = await service.refresh({
      connectionId: "conn_1",
      providerId: "google",
      redirectUri: "https://app.example/callback"
    });

    expect(refreshed.accessToken).toBe("access-new");
    expect(refreshed.refreshToken).toBe("refresh-old");
    expect(events.some((event) => event.name === "oauth.flow.refresh.success")).toBe(true);

    const stored = await tokenVault.getByConnection("conn_1");
    expect(stored).not.toBeNull();
    const payload = JSON.parse(stored!.encryptedPayload) as { accessToken: string; refreshToken: string };
    expect(payload.accessToken).toBe("access-new");
    expect(payload.refreshToken).toBe("refresh-old");
  });

  it("refresh() failure keeps prior token record intact", async () => {
    const { service, tokenVault, tokenHttpClient, events } = createHarness();
    await seedConnection(service, "conn_2");

    const before = await tokenVault.getByConnection("conn_2");
    expect(before).not.toBeNull();

    tokenHttpClient.exchangeToken = vi.fn(async (input) => {
      if (input.grantType === "authorization_code") {
        return {
          accessToken: "access-old",
          refreshToken: "refresh-old"
        };
      }

      throw new OAuthHttpError("invalid_grant", {
        code: "OAUTH_TOKEN_REFRESH_FAILED",
        status: 400,
        retryable: false
      });
    });

    await expect(
      service.refresh({
        connectionId: "conn_2",
        providerId: "google",
        redirectUri: "https://app.example/callback"
      })
    ).rejects.toMatchObject({
      code: "OAUTH_TOKEN_REFRESH_FAILED"
    });

    expect(events.some((event) => event.name === "oauth.flow.refresh.failed")).toBe(true);

    const after = await tokenVault.getByConnection("conn_2");
    expect(after).toEqual(before);
  });

  it("disconnect() returns cleanup flags when remote revoke succeeds", async () => {
    const { service, tokenVault, events } = createHarness();
    await seedConnection(service, "conn_3");

    const result = await service.disconnect({
      connectionId: "conn_3",
      providerId: "google",
      revokeRemote: true
    });

    expect(result).toEqual({
      disconnected: true,
      remoteRevokeAttempted: true,
      localTokenDeleted: true,
      connectionDeleted: true
    });
    expect(await tokenVault.getByConnection("conn_3")).toBeNull();
    expect(events.some((event) => event.name === "oauth.flow.disconnect.success")).toBe(true);
  });

  it("disconnect() still cleans local records when remote revoke fails", async () => {
    const { service, tokenVault, tokenHttpClient, events } = createHarness();
    await seedConnection(service, "conn_4");

    tokenHttpClient.revokeToken = vi.fn(async () => {
      throw new OAuthHttpError("upstream revoke failed", {
        code: "INTERNAL_ERROR",
        status: 500,
        retryable: false
      });
    });

    await expect(
      service.disconnect({
        connectionId: "conn_4",
        providerId: "google",
        revokeRemote: true
      })
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      details: {
        remoteRevokeAttempted: true,
        localTokenDeleted: true,
        connectionDeleted: true
      }
    });

    expect(await tokenVault.getByConnection("conn_4")).toBeNull();
    expect(events.some((event) => event.name === "oauth.flow.disconnect.failed")).toBe(true);
  });
});
