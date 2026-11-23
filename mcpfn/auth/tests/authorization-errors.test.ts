import { describe, expect, it, vi } from "vitest";

import {
  createMcpAuthorizationCompatibilityHandler,
  McpFnHostedAuthorizationError,
  normalizeMcpClientRegistration,
  renderMcpAuthorizationErrorPage,
  type McpFnAuthorizationCompatibilityOptions,
  type McpFnClientRegistrationSource,
  type McpFnNormalizedClientRegistration,
} from "../src/index.js";

const issuer = "https://login.example.com";
const resource = "https://mcp.example.com/mcp";
const evilRedirect = "https://evil.example/x";
const stateMarker = "state-marker-not-reflected";
const allSources: McpFnClientRegistrationSource[] = [
  "pre-registered",
  "enterprise",
  "dynamic",
  "client-metadata-document",
];

function fixedClient(
  clientId: string,
  source: McpFnClientRegistrationSource,
): McpFnNormalizedClientRegistration {
  return normalizeMcpClientRegistration({
    clientId,
    source,
    metadata: {
      redirect_uris: [evilRedirect],
      response_types: ["code"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    },
  });
}

function compatibilityHandler(
  overrides: Partial<McpFnAuthorizationCompatibilityOptions> = {},
) {
  const clients = new Map<string, McpFnNormalizedClientRegistration>();
  for (const source of ["pre-registered", "enterprise", "client-metadata-document"] as const) {
    const client = fixedClient(
      source === "client-metadata-document" ? "https://evil.example/client.json" : `${source}-client`,
      source,
    );
    clients.set(client.clientId, client);
  }
  const authorize = vi.fn(async () => Response.json({ ok: true }));
  const handle = createMcpAuthorizationCompatibilityHandler({
    issuer,
    allowedResources: [resource],
    clients: {
      resolve: async (clientId) => clients.get(clientId) ?? null,
      register: async (metadata) => {
        const registered = normalizeMcpClientRegistration({
          clientId: "dynamic-client",
          source: "dynamic",
          metadata,
        });
        clients.set(registered.clientId, registered);
        return registered;
      },
    },
    authorize,
    tokenAuthority: {
      exchangeAuthorizationCode: async () => ({ access_token: "opaque", token_type: "Bearer" }),
    },
    ...overrides,
  });
  return { handle, authorize };
}

async function registerDynamicClient(handle: (request: Request) => Promise<Response>) {
  const response = await handle(new Request(`${issuer}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [evilRedirect],
      token_endpoint_auth_method: "none",
    }),
  }));
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

function validAuthorizationUrl(clientId: string): URL {
  const url = new URL("/authorize", issuer);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", evilRedirect);
  url.searchParams.set("code_challenge", "c".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", stateMarker);
  url.searchParams.set("resource", resource);
  return url;
}

const invalidRequests: Array<{ name: string; error: string; mutate(url: URL): void }> = [
  {
    name: "missing code_challenge",
    error: "invalid_request",
    mutate: (url) => {
      url.searchParams.delete("code_challenge");
      url.searchParams.delete("code_challenge_method");
    },
  },
  {
    name: "missing state",
    error: "invalid_request",
    mutate: (url) => url.searchParams.delete("state"),
  },
  {
    name: "unsupported response_type",
    error: "unsupported_response_type",
    mutate: (url) => url.searchParams.set("response_type", "token"),
  },
  {
    name: "disallowed resource",
    error: "invalid_target",
    mutate: (url) => url.searchParams.set("resource", "https://other.example.com/mcp"),
  },
];

async function expectRenderedError(response: Response, error: string) {
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).toContain(error);
  expect(body).not.toContain("evil.example");
  expect(body).not.toContain(stateMarker);
}

describe("authorization endpoint error responses", () => {
  it("renders an error page instead of redirecting a dynamically registered client without PKCE", async () => {
    const { handle, authorize } = compatibilityHandler();
    const clientId = await registerDynamicClient(handle);
    const url = new URL("/authorize", issuer);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", evilRedirect);
    url.searchParams.set("response_type", "code");

    await expectRenderedError(await handle(new Request(url)), "invalid_request");
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(invalidRequests)(
    "renders an error page for a dynamic client with $name",
    async ({ error, mutate }) => {
      const { handle } = compatibilityHandler();
      const clientId = await registerDynamicClient(handle);
      const url = validAuthorizationUrl(clientId);
      mutate(url);
      await expectRenderedError(await handle(new Request(url)), error);
    },
  );

  it("renders an error page for a Client ID Metadata Document client", async () => {
    const { handle } = compatibilityHandler();
    const url = validAuthorizationUrl("https://evil.example/client.json");
    url.searchParams.delete("code_challenge");
    await expectRenderedError(await handle(new Request(url)), "invalid_request");
  });

  it.each(["pre-registered", "enterprise"] as const)(
    "still redirects errors to a %s client's registered callback with state",
    async (source) => {
      const { handle } = compatibilityHandler();
      const url = validAuthorizationUrl(`${source}-client`);
      url.searchParams.delete("code_challenge");
      const response = await handle(new Request(url));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(evilRedirect);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("error_description")).toBe(
        "code_challenge must be supplied exactly once",
      );
      expect(location.searchParams.get("state")).toBe(stateMarker);
    },
  );

  it("restores error redirects for dynamic clients when every source is allowed", async () => {
    const { handle } = compatibilityHandler({
      authorizationErrors: { redirectSources: allSources },
    });
    const clientId = await registerDynamicClient(handle);
    const url = validAuthorizationUrl(clientId);
    url.searchParams.delete("code_challenge");
    const response = await handle(new Request(url));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(evilRedirect);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe(stateMarker);
  });

  it("returns the host's custom render response with the error and client", async () => {
    const render = vi.fn(async () => new Response("host error page", { status: 418 }));
    const { handle } = compatibilityHandler({ authorizationErrors: { render } });
    const clientId = await registerDynamicClient(handle);
    const url = validAuthorizationUrl(clientId);
    url.searchParams.set("response_type", "token");
    const request = new Request(url);

    const response = await handle(request);

    expect(response.status).toBe(418);
    await expect(response.text()).resolves.toBe("host error page");
    expect(render).toHaveBeenCalledTimes(1);
    const [input] = render.mock.calls[0] as unknown as [{
      error: McpFnHostedAuthorizationError;
      client: McpFnNormalizedClientRegistration;
      request: Request;
    }];
    expect(input.error).toBeInstanceOf(McpFnHostedAuthorizationError);
    expect(input.error.code).toBe("unsupported_response_type");
    expect(input.client).toMatchObject({ clientId, source: "dynamic" });
    expect(input.request).toBe(request);
  });

  it("calls a method-style render with its host object as the receiver", async () => {
    const host = {
      label: "host-page",
      render(this: { label: string }, { error }: { error: McpFnHostedAuthorizationError }) {
        return new Response(`${this.label}:${error.code}`, { status: 400 });
      },
    };
    const { handle } = compatibilityHandler({ authorizationErrors: host });
    const clientId = await registerDynamicClient(handle);
    const url = validAuthorizationUrl(clientId);
    url.searchParams.delete("state");
    const response = await handle(new Request(url));
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("host-page:invalid_request");
  });

  it("never falls back to a redirect when the custom render fails", async () => {
    const { handle } = compatibilityHandler({
      authorizationErrors: {
        render: () => {
          throw new Error("render failed");
        },
      },
    });
    const clientId = await registerDynamicClient(handle);
    const url = validAuthorizationUrl(clientId);
    url.searchParams.delete("code_challenge");
    const response = await handle(new Request(url));
    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: "server_error" });
  });

  it("renders an error page for a fetched Client ID Metadata Document client", async () => {
    const clientId = "https://evil.example/fetched-client.json";
    const fetch = vi.fn(async () => Response.json({
      client_id: clientId,
      redirect_uris: [evilRedirect],
      token_endpoint_auth_method: "none",
    }));
    const { handle, authorize } = compatibilityHandler({
      clients: { resolve: async () => null },
      clientMetadataDocuments: { enabled: true, allow: async () => true, fetch },
    });
    const url = validAuthorizationUrl(clientId);
    url.searchParams.delete("code_challenge");
    await expectRenderedError(await handle(new Request(url)), "invalid_request");
    expect(fetch).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects unknown redirect sources at construction", () => {
    expect(() => compatibilityHandler({
      authorizationErrors: {
        redirectSources: ["dynamic", "anyone"] as unknown as McpFnClientRegistrationSource[],
      },
    })).toThrow(TypeError);
  });

  it("HTML-escapes the error code and description in the default page", async () => {
    const response = renderMcpAuthorizationErrorPage(new McpFnHostedAuthorizationError(
      "invalid_request<b>",
      `<script>alert("x")</script> & 'quoted'`,
    ));
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<b>");
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;");
    expect(body).toContain("invalid_request&lt;b&gt;");
  });
});
