import { describe, expect, it } from "vitest";

import {
  createOAuthAuthorizationRequestUrl,
  parseOAuthCallback,
} from "../src/playwright.js";

describe("McpFn Playwright OAuth helpers", () => {
  it("builds stateful PKCE requests and parses callbacks", () => {
    const request = createOAuthAuthorizationRequestUrl({
      authorizationEndpoint: "https://login.example.com/authorize",
      clientId: "https://client.example.com/metadata",
      redirectUri: "https://client.example.com/callback",
      state: "fixed-state",
      scopes: ["mcp:read"],
      resource: "https://mcp.example.com/mcp",
    });
    const url = new URL(request.url);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
    expect(request.pkce.verifier.length).toBeGreaterThan(43);
    expect(parseOAuthCallback(
      "https://client.example.com/callback?code=abc&state=fixed-state",
    ).parameters).toEqual({ code: "abc", state: "fixed-state" });
  });
});
