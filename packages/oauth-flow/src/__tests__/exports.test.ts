import { describe, expect, it } from "vitest";
import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";
import {
  OAuthFlowError,
  createOAuthFlowService,
  invokeIdentityHook
} from "../index.js";

const provider: OAuthProviderDescriptor = {
  id: "mock",
  authorizationUrl: "https://mock.example/auth",
  tokenUrl: "https://mock.example/token",
  defaultScopes: ["read"],
  supportsPkce: true,
  supportsRefreshToken: true,
  scopeSeparator: " ",
  tokenAuthMethod: "client_secret_post"
};

function createTestConfig() {
  return {
    providers: { mock: provider },
    providerRuntimeConfig: {
      mock: {
        clientId: "client_1",
        clientSecret: "secret_1",
        allowlistedRedirectUris: ["https://app.example/callback"]
      }
    },
    stateStore: {
      async put() {},
      async get() {
        return null;
      },
      async consume() {
        return null;
      },
      async deleteExpired() {
        return 0;
      }
    },
    tokenVault: {
      async put() {},
      async get() {
        return null;
      },
      async getByConnection() {
        return null;
      },
      async rotateKey() {},
      async deleteByConnection() {}
    }
  };
}

describe("oauth-flow exports", () => {
  it("exposes required service API surface", () => {
    const service = createOAuthFlowService(createTestConfig());

    expect(typeof service.start).toBe("function");
    expect(typeof service.handleCallback).toBe("function");
    expect(typeof service.refresh).toBe("function");
    expect(typeof service.disconnect).toBe("function");
  });

  it("invokes identity hooks and wraps hook failures deterministically", async () => {
    const callbackPayload = {
      providerId: "mock",
      subject: {
        tenantId: "tenant_1",
        userId: "user_1",
        connectionId: "conn_1"
      },
      tokenSet: {
        accessToken: "access_1",
        refreshToken: "refresh_1"
      },
      tokenRecordId: "tok_1",
      connectionId: "conn_1"
    };

    let onConnectedCalled = false;
    await invokeIdentityHook(
      {
        async onConnected(result) {
          onConnectedCalled = true;
          expect(result.providerId).toBe("mock");
          expect(result.connectionId).toBe("conn_1");
          expect(result.subject.tenantId).toBe("tenant_1");
          expect(result.subject.userId).toBe("user_1");
          expect(result.tokenSet.refreshToken).toBe("refresh_1");
        }
      },
      "onConnected",
      callbackPayload
    );
    expect(onConnectedCalled).toBe(true);

    await expect(
      invokeIdentityHook(
        {
          async onConnected() {
            throw new Error("boom");
          }
        },
        "onConnected",
        callbackPayload
      )
    ).rejects.toBeInstanceOf(OAuthFlowError);

    await expect(
      invokeIdentityHook(
        {
          async onConnected() {
            throw new Error("boom");
          }
        },
        "onConnected",
        callbackPayload
      )
    ).rejects.toMatchObject({
      code: "HOOK_FAILED",
      message: "identity hook failed"
    });
  });
});
