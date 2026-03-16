import { describe, expect, it, vi } from "vitest";
import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";
import { MemoryOAuthStateStore, MemoryTokenVault } from "@superfunctions/oauth-storage";
import { createOAuthFlowService, type OAuthFlowEvent } from "../index.js";

const provider: OAuthProviderDescriptor = {
  id: "google",
  authorizationUrl: "https://accounts.google.example/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.example/token",
  defaultScopes: ["openid", "email"],
  supportsPkce: true,
  supportsRefreshToken: true,
  scopeSeparator: " ",
  tokenAuthMethod: "client_secret_post"
};

class CountingStateStore extends MemoryOAuthStateStore {
  putCount = 0;

  override async put(record: Parameters<MemoryOAuthStateStore["put"]>[0]): Promise<void> {
    this.putCount += 1;
    await super.put(record);
  }
}

function createHarness(startAt = "2026-01-01T00:00:00.000Z") {
  let nowMs = Date.parse(startAt);
  const now = () => new Date(nowMs);
  const advanceMs = (ms: number) => {
    nowMs += ms;
  };

  const events: OAuthFlowEvent[] = [];
  const stateStore = new CountingStateStore();
  const tokenVault = new MemoryTokenVault();

  const tokenHttpClient = {
    exchangeToken: vi.fn(async () => ({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      tokenType: "Bearer",
      scope: "openid email"
    })),
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

  return { service, stateStore, tokenVault, events, tokenHttpClient, advanceMs };
}

describe("oauth-flow start/callback invariants", () => {
  it("start() validates input, persists state, includes PKCE, and emits started event", async () => {
    const { service, stateStore, events } = createHarness();

    const started = await service.start({
      providerId: "google",
      tenantId: "tenant_1",
      userId: "user_1",
      redirectUri: "https://app.example/callback",
      metadata: { requestId: "req_start_1" }
    });

    expect(started.providerId).toBe("google");
    expect(started.authorizationUrl).toContain("state=");
    expect(started.authorizationUrl).toContain("code_challenge=");
    expect(started.authorizationUrl).toContain("code_challenge_method=S256");

    const url = new URL(started.authorizationUrl);
    expect(url.searchParams.get("state")).toBe(started.stateId);
    expect(url.searchParams.get("client_id")).toBe("client_google");

    const state = await stateStore.get(started.stateId);
    expect(state?.tenantId).toBe("tenant_1");
    expect(state?.userId).toBe("user_1");
    expect(state?.providerId).toBe("google");
    expect(state?.expiresAt).toBeDefined();

    expect(events).toContainEqual({
      name: "oauth.flow.started",
      requestId: "req_start_1",
      providerId: "google",
      at: "2026-01-01T00:00:00.000Z",
      ok: true
    });
  });

  it("start() rejects non-allowlisted redirect before state creation", async () => {
    const { service, stateStore } = createHarness();

    await expect(
      service.start({
        providerId: "google",
        tenantId: "tenant_1",
        userId: "user_1",
        redirectUri: "https://evil.example/callback"
      })
    ).rejects.toMatchObject({
      code: "OAUTH_CALLBACK_MISMATCH",
      status: 400,
      retryable: false
    });

    expect(stateStore.putCount).toBe(0);
  });

  it("start() rejects unknown providers with deterministic validation error", async () => {
    const { service } = createHarness();

    await expect(
      service.start({
        providerId: "unknown-provider",
        tenantId: "tenant_1",
        userId: "user_1",
        redirectUri: "https://app.example/callback"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      status: 400,
      retryable: false
    });
  });

  it("handleCallback() succeeds once, persists token, and rejects replay deterministically", async () => {
    const { service, stateStore, tokenVault, events } = createHarness();

    const started = await service.start({
      providerId: "google",
      tenantId: "tenant_1",
      userId: "user_1",
      redirectUri: "https://app.example/callback"
    });

    const first = await service.handleCallback({
      code: "auth-code-1",
      state: started.stateId,
      redirectUri: "https://app.example/callback"
    });

    expect(first.providerId).toBe("google");
    expect(first.subject.tenantId).toBe("tenant_1");
    expect(first.subject.userId).toBe("user_1");
    expect(first.tokenSet.accessToken).toBe("access-token");

    const persistedToken = await tokenVault.get(first.tokenRecordId);
    expect(persistedToken?.connectionId).toBe(first.connectionId);
    expect(persistedToken?.providerId).toBe("google");

    const consumedState = await stateStore.get(started.stateId);
    expect(consumedState?.consumedAt).toBeDefined();

    expect(events.some((event) => event.name === "oauth.flow.callback.success")).toBe(true);

    await expect(
      service.handleCallback({
        code: "auth-code-2",
        state: started.stateId,
        redirectUri: "https://app.example/callback"
      })
    ).rejects.toMatchObject({
      code: "OAUTH_STATE_REPLAYED",
      status: 400,
      retryable: false
    });
  });

  it("handleCallback() rejects callback mismatch with deterministic code", async () => {
    const { service } = createHarness();
    const started = await service.start({
      providerId: "google",
      tenantId: "tenant_1",
      userId: "user_1",
      redirectUri: "https://app.example/callback"
    });

    await expect(
      service.handleCallback({
        code: "auth-code-1",
        state: started.stateId,
        redirectUri: "https://evil.example/callback"
      })
    ).rejects.toMatchObject({
      code: "OAUTH_CALLBACK_MISMATCH",
      status: 400,
      retryable: false
    });
  });

  it("handleCallback() rejects expired state with deterministic code", async () => {
    const { service, advanceMs } = createHarness();
    const started = await service.start({
      providerId: "google",
      tenantId: "tenant_1",
      userId: "user_1",
      redirectUri: "https://app.example/callback"
    });

    advanceMs(11 * 60 * 1000);

    await expect(
      service.handleCallback({
        code: "auth-code-expired",
        state: started.stateId,
        redirectUri: "https://app.example/callback"
      })
    ).rejects.toMatchObject({
      code: "OAUTH_STATE_INVALID",
      status: 400,
      retryable: false
    });
  });
});
