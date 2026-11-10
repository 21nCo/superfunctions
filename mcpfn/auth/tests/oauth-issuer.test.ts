import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";
import { MemoryMcpFnOAuthSessionStore, createMcpFnOAuthClientProvider } from "../src/oauth-client.js";
const resource = "https://resource.example/mcp", originalIssuer = "https://issuer-a.example", changedIssuer = "https://issuer-b.example";
const metadata = { redirect_uris: ["https://app.example/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_post" as const };
function providerWith(store: MemoryMcpFnOAuthSessionStore) {
  return createMcpFnOAuthClientProvider({ store, redirectUrl: metadata.redirect_uris[0], clientMetadata: metadata, openAuthorization: async () => {} });
}
describe("OAuth issuer-bound credential migration", () => {
  it.each([true, false])("never sends old issuer secrets after metadata changes (stamped=%s)", async stamped => {
    const store = new MemoryMcpFnOAuthSessionStore(); const provider = providerWith(store);
    await store.setClientInformation({ ...metadata, client_id: "client-A", client_secret: "SYNTHETIC-A-SECRET", ...(stamped ? { issuer: originalIssuer } : {}) });
    await store.setTokens({ access_token: "SYNTHETIC-A-ACCESS", refresh_token: "SYNTHETIC-A-REFRESH", token_type: "Bearer", ...(stamped ? { issuer: originalIssuer } : {}) });
    const requests: Array<{ url: string; body: string; authorization: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, body: String(init?.body ?? ""), authorization: new Headers(init?.headers).get("authorization") });
      if (url.includes("oauth-protected-resource")) return Response.json({ resource, authorization_servers: [changedIssuer] });
      if (url.includes("oauth-authorization-server")) return Response.json({ issuer: changedIssuer, authorization_endpoint: changedIssuer + "/authorize", token_endpoint: changedIssuer + "/token", registration_endpoint: changedIssuer + "/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"] });
      if (url === changedIssuer + "/register") return Response.json({ ...metadata, client_id: "client-B", client_secret: "SYNTHETIC-B-SECRET" });
      if (url === changedIssuer + "/token") return Response.json({ access_token: "SYNTHETIC-B-ACCESS", token_type: "Bearer" });
      return new Response("", { status: 404 });
    };
    expect(await auth(provider, { serverUrl: resource, fetchFn })).toBe("REDIRECT");
    expect(requests.some(request => request.url === changedIssuer + "/register")).toBe(true);
    expect(requests.some(request => request.url === changedIssuer + "/token")).toBe(false);
    expect(JSON.stringify(requests)).not.toContain("SYNTHETIC-A-");
    expect(await provider.clientInformation()).toMatchObject({ issuer: changedIssuer, client_id: "client-B" });
  });
  it("preserves fresh issuer-bound credentials unchanged", async () => {
    const store = new MemoryMcpFnOAuthSessionStore(); const provider = providerWith(store);
    const client = { client_id: "client-A", client_secret: "synthetic", issuer: originalIssuer };
    const tokens = { access_token: "synthetic", token_type: "Bearer", issuer: originalIssuer };
    await provider.saveClientInformation(client); await provider.saveTokens(tokens);
    expect(await provider.clientInformation()).toEqual(client); expect(await provider.tokens()).toEqual(tokens);
  });
  it("clears a legacy token without discarding a bound client", async () => {
    const store = new MemoryMcpFnOAuthSessionStore(); const provider = providerWith(store);
    await store.setClientInformation({ client_id: "fresh", issuer: changedIssuer });
    await store.setTokens({ access_token: "old", refresh_token: "old", token_type: "Bearer" });
    expect(await provider.tokens()).toBeUndefined(); expect(await store.getTokens()).toBeUndefined();
    expect(await provider.clientInformation()).toMatchObject({ client_id: "fresh", issuer: changedIssuer });
  });
  it("clears legacy registration, pending authorization, and tokens", async () => {
    const store = new MemoryMcpFnOAuthSessionStore(); const provider = providerWith(store);
    await store.setClientInformation({ client_id: "legacy" }); await store.setTokens({ access_token: "old", token_type: "Bearer" });
    await store.setCodeVerifier("old-verifier"); await store.setState("old-state");
    expect(await provider.clientInformation()).toBeUndefined(); expect(await store.getTokens()).toBeUndefined();
    expect(await store.getCodeVerifier()).toBeUndefined(); expect(await store.getState()).toBeUndefined();
  });
});

it("reports custom stores that silently strip issuer on save", async () => {
  class StrippingStore extends MemoryMcpFnOAuthSessionStore {
    async setClientInformation(value: Parameters<MemoryMcpFnOAuthSessionStore['setClientInformation']>[0]) {
      const { issuer: _issuer, ...rest } = value; await super.setClientInformation(rest);
    }
    async setTokens(value: Parameters<MemoryMcpFnOAuthSessionStore['setTokens']>[0]) {
      const { issuer: _issuer, ...rest } = value; await super.setTokens(rest);
    }
  }
  const provider = providerWith(new StrippingStore());
  await expect(provider.saveClientInformation({ client_id: 'client', issuer: originalIssuer })).rejects.toMatchObject({ code: 'MCPFN_OAUTH_STORE_DROPPED_ISSUER' });
  await expect(provider.saveTokens({ access_token: 'token', token_type: 'Bearer', issuer: originalIssuer })).rejects.toMatchObject({ code: 'MCPFN_OAUTH_STORE_DROPPED_ISSUER' });
});

it("clears legacy tokens locally without passing them to a remote revocation callback", async () => {
  const store = new MemoryMcpFnOAuthSessionStore();
  let revocations = 0;
  const provider = createMcpFnOAuthClientProvider({ store, redirectUrl: metadata.redirect_uris[0], clientMetadata: metadata,
    openAuthorization: async () => {}, revoke: async () => { revocations++; },
  });
  await store.setTokens({ access_token: 'legacy', refresh_token: 'legacy-refresh', token_type: 'Bearer' });
  await provider.revoke();
  expect(revocations).toBe(0); expect(await store.getTokens()).toBeUndefined();
});
