import { describe, expect, it } from "vitest";
import type { OAuthService, OAuthProviderDescriptor } from "../index.js";

describe("oauth-core exports", () => {
  it("exposes compile-time contracts", () => {
    const descriptor: OAuthProviderDescriptor = {
      id: "example",
      authorizationUrl: "https://example.com/auth",
      tokenUrl: "https://example.com/token",
      defaultScopes: ["read"],
      supportsPkce: true,
      supportsRefreshToken: true
    };

    expect(descriptor.id).toBe("example");
    expectType<OAuthService>();
  });
});

function expectType<T>(): void {
  void (0 as unknown as T);
}
