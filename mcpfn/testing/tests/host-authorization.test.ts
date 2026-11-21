import { describe, expect, it } from "vitest";
import {
  createMcpAuthorizationCompatibilityHandler,
  normalizeMcpClientRegistration,
  type McpFnNormalizedClientRegistration,
  type McpFnRedirectPolicy,
} from "@mcpfn/auth";

import {
  createHostedAuthorizationFixtures,
  runHostedAuthorizationRegression,
} from "../src/index.js";

const TOKEN_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

function tokenJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(TOKEN_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }
  return Response.json(body, { ...init, headers });
}

describe("hosted role-3 regression harness", () => {
  it("keeps registration and request inputs independent across named hosts and grant errors", async () => {
    const issuer = "https://login.example.com";
    const resource = "https://mcp.example.com/mcp";
    const registrations = new Map<string, McpFnNormalizedClientRegistration>();
    const handler = createMcpAuthorizationCompatibilityHandler({
      issuer,
      clients: {
        resolve: async (clientId) => registrations.get(clientId) ?? null,
      },
      allowedResources: [resource],
      capabilities: { requireRefreshResource: true },
      supportedScopes: ["mcp:read"],
      authorize: async (input) => {
        const callback = new URL(input.redirectUri);
        callback.searchParams.set("code", `${input.client.clientId}-code`);
        if (input.state) callback.searchParams.set("state", input.state);
        return Response.redirect(callback, 302);
      },
      tokenAuthority: {
        exchangeAuthorizationCode: async () => ({
          access_token: "role3-access-token",
          token_type: "Bearer",
          refresh_token: "role3-refresh-token",
        }),
        refreshToken: async () => ({
          access_token: "role3-refreshed-token",
          token_type: "Bearer",
          refresh_token: "role3-rotated-token",
        }),
      },
    });
    const fixtures = createHostedAuthorizationFixtures({ issuer, resource });
    const drift = fixtures.find((fixture) => fixture.id === "chatgpt-unregistered-redirect")!;
    expect(drift.registration.metadata.redirect_uris).not.toContain(
      drift.authorization.redirectUri,
    );

    const results = await runHostedAuthorizationRegression({
      issuer,
      async prepareRegistration(fixture) {
        registrations.set(fixture.clientId, normalizeMcpClientRegistration(fixture));
      },
      request: async (request) => {
        if (new URL(request.url).pathname.endsWith("token")) {
          const body = new URLSearchParams(await request.clone().text());
          if (body.get("grant_type") === "authorization_code") {
            expect(body.get("code")).toBe(`${body.get("client_id")}-code`);
          }
        }
        return handler(request);
      },
    }, fixtures);

    expect(results).toHaveLength(6);
    expect(results.filter((result) => result.status !== "passed")).toEqual([]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "claude-client-metadata-extensible-grants",
        phase: "token-refresh",
      }),
      expect.objectContaining({
        id: "chatgpt-unregistered-redirect",
        errorCode: "invalid_request",
        phase: "authorization-request",
      }),
      expect.objectContaining({
        id: "actual-unsupported-token-grant",
        errorCode: "unsupported_grant_type",
        phase: "token-exchange",
      }),
    ]));
  });
  it.each(["throw", "no-redirect", "missing-code", "wrong-state", "wrong-callback", "empty-token", "token-redirect"])("fails broken hosted flow: %s", async (fault) => {
    const issuer = "https://login.example.com";
    const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" })[0]!;
    const results = await runHostedAuthorizationRegression({
      issuer, prepareRegistration: async () => {},
      request: async (request) => {
        if (fault === "throw") throw new Error("transport aborted");
        if (new URL(request.url).pathname.endsWith("authorize")) {
          if (fault === "no-redirect") return new Response("", { status: 200 });
          const callback = new URL(fault === "wrong-callback" ? "https://evil.example/callback" : fixture.authorization.redirectUri);
          if (fault !== "missing-code") callback.searchParams.set("code", "real-code");
          callback.searchParams.set("state", fault === "wrong-state" ? "wrong" : fixture.authorization.state);
          return Response.redirect(callback, 302);
        }
        expect(request.redirect).toBe("manual");
        if (fault === "token-redirect") return Response.redirect("https://evil.example/token", 307);
        return tokenJson(fault === "empty-token" ? {} : { access_token: "valid-token", token_type: "Bearer", refresh_token: "valid-refresh" });
      },
    }, [fixture]);
    expect(results[0]?.status).toBe("failed");
  });

});

it.each(["status", "state", "destination"])("rejects malformed OAuth rejection %s", async (fault) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" })[0]!;
  fixture.expected = { outcome: "rejected", errorCode: "invalid_request" };
  const results = await runHostedAuthorizationRegression({ issuer, prepareRegistration: async () => {},
    request: async () => {
      if (fault === "status") return Response.json({ error: "invalid_request" });
      const callback = new URL(fault === "destination" ? "https://evil.example/cb" : fixture.authorization.redirectUri);
      callback.searchParams.set("error", "invalid_request");
      callback.searchParams.set("state", fault === "state" ? "wrong" : fixture.authorization.state);
      return Response.redirect(callback, 302);
    },
  }, [fixture]);
  expect(results[0]?.status).toBe("failed");
});


it.each([304, 305])("rejects status %s as an OAuth error redirect", async (status) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" })[0]!;
  fixture.expected = { outcome: "rejected", errorCode: "invalid_request" };
  const callback = new URL(fixture.authorization.redirectUri);
  callback.searchParams.set("error", "invalid_request"); callback.searchParams.set("state", fixture.authorization.state);
  const results = await runHostedAuthorizationRegression({ issuer, prepareRegistration: async () => {}, request: async () => new Response(null, { status, headers: { location: callback.toString() } }) }, [fixture]);
  expect(results[0]?.status).toBe("failed");
});

it.each([400, 401, 403])("rejects a Location-only token error with status %s", async (status) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" }).find((item) => item.id === "actual-unsupported-token-grant")!;
  const callback = new URL(fixture.authorization.redirectUri);
  callback.searchParams.set("code", "test-code"); callback.searchParams.set("state", fixture.authorization.state);
  const results = await runHostedAuthorizationRegression({ issuer, prepareRegistration: async () => {}, request: async (request) =>
    new URL(request.url).pathname.endsWith("authorize") ? Response.redirect(callback, 302) : new Response(null, { status, headers: { location: "https://login.example.com/error?error=unsupported_grant_type" } })
  }, [fixture]);
  expect(results[0]?.status).toBe("failed");
});

it.each([[400, 'application/json', 'passed'], [400, 'Application/JSON; charset=utf-8', 'passed'], [401, 'application/json', 'failed'], [403, 'application/json', 'failed'], [400, 'text/notjson', 'failed']])('validates token rejection media type and status %s %s', async (status, contentType, outcome) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" }).find(item => item.id === "actual-unsupported-token-grant")!;
  const callback = new URL(fixture.authorization.redirectUri);
  callback.searchParams.set("code", "test-code"); callback.searchParams.set("state", fixture.authorization.state);
  const results = await runHostedAuthorizationRegression({ issuer, prepareRegistration: async () => {}, request: async request =>
    new URL(request.url).pathname.endsWith("authorize") ? Response.redirect(callback, 302) : new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: status as number, headers: { 'content-type': contentType as string } })
  }, [fixture]);
  expect(results[0]?.status).toBe(outcome);
});

it.each([
  ["token-exchange", 400, "passed"],
  ["token-exchange", 401, "failed"],
  ["token-refresh", 400, "passed"],
  ["token-refresh", 401, "failed"],
] as const)("requires HTTP 400 for public-client invalid_client during %s (%s)", async (phase, status, outcome) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({
    issuer,
    resource: "https://mcp.example.com/mcp",
  }).find(item => item.token?.refreshAfterExchange)!;
  fixture.expected = { outcome: "rejected", errorCode: "invalid_client", phase };
  const callback = new URL(fixture.authorization.redirectUri);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", fixture.authorization.state);

  const [result] = await runHostedAuthorizationRegression({
    issuer,
    prepareRegistration: async () => {},
    request: async request => {
      if (new URL(request.url).pathname.endsWith("authorize")) {
        return Response.redirect(callback, 302);
      }
      expect(request.headers.has("authorization")).toBe(false);
      const refresh = new URLSearchParams(await request.clone().text())
        .get("grant_type") === "refresh_token";
      if (phase === "token-refresh" && !refresh) {
        return tokenJson({
          access_token: "token",
          token_type: "Bearer",
          refresh_token: "refresh",
        });
      }
      return Response.json({ error: "invalid_client" }, { status });
    },
  }, [fixture]);

  expect(result).toMatchObject({
    status: outcome,
    phase,
    responseStatus: status,
    ...(status === 400
      ? { errorCode: "invalid_client" }
      : { error: "OAuth error response has invalid HTTP status" }),
  });
});


it("rejects direct authorization JSON 401 invalid_client", async () => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" })[0]!;
  fixture.expected = { outcome: "rejected", errorCode: "invalid_client" };
  const results = await runHostedAuthorizationRegression({ issuer, prepareRegistration: async () => {}, request: async () =>
    new Response(JSON.stringify({ error: "invalid_client" }), { status: 401, headers: { "content-type": "application/json" } })
  }, [fixture]);
  expect(results[0]?.status).toBe("failed");
});

it.each(["token-exchange", "token-refresh"])("rejects non-JSON successful %s", async phase => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({ issuer, resource: "https://mcp.example.com/mcp" }).find(item => item.token?.refreshAfterExchange)!;
  const callback = new URL(fixture.authorization.redirectUri);
  callback.searchParams.set("code", "test-code"); callback.searchParams.set("state", fixture.authorization.state);

  const results = await runHostedAuthorizationRegression({ issuer, prepareRegistration: async () => {}, request: async request => {
    if (new URL(request.url).pathname.endsWith("authorize")) return Response.redirect(callback, 302);
    const refresh = new URLSearchParams(await request.clone().text()).get("grant_type") === "refresh_token";
    return new Response(JSON.stringify({ access_token: "token", token_type: "Bearer", refresh_token: "refresh" }), { headers: { ...TOKEN_RESPONSE_HEADERS, "content-type": refresh === (phase === "token-refresh") ? "text/plain" : "application/json" } });
  } }, [fixture]);
  expect(results[0]).toMatchObject({ status: "failed", phase, responseStatus: 200 });
});

it.each([
  ["token-exchange", "cache-control"],
  ["token-exchange", "pragma"],
  ["token-refresh", "cache-control"],
  ["token-refresh", "pragma"],
] as const)("rejects successful %s without %s", async (phase, missingHeader) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({
    issuer,
    resource: "https://mcp.example.com/mcp",
  }).find(item => item.token?.refreshAfterExchange)!;
  const callback = new URL(fixture.authorization.redirectUri);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", fixture.authorization.state);

  const [result] = await runHostedAuthorizationRegression({
    issuer,
    prepareRegistration: async () => {},
    request: async request => {
      if (new URL(request.url).pathname.endsWith("authorize")) {
        return Response.redirect(callback, 302);
      }
      const refresh = new URLSearchParams(await request.clone().text())
        .get("grant_type") === "refresh_token";
      const isTargetPhase = refresh === (phase === "token-refresh");
      const headers = new Headers({
        "content-type": "application/json",
        ...TOKEN_RESPONSE_HEADERS,
      });
      if (isTargetPhase) headers.delete(missingHeader);
      return new Response(JSON.stringify({
        access_token: "token",
        token_type: "Bearer",
        refresh_token: "refresh",
      }), { headers });
    },
  }, [fixture]);

  expect(result).toMatchObject({ status: "failed", phase, responseStatus: 200 });
});

it.each([
  ["token-exchange", "cache-control", "no-store=false"],
  ["token-exchange", "pragma", "no-cache=false"],
  ["token-refresh", "cache-control", "no-store=false"],
  ["token-refresh", "pragma", "no-cache=false"],
] as const)("rejects parameterized cache directive during %s", async (phase, header, value) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({
    issuer,
    resource: "https://mcp.example.com/mcp",
  }).find(item => item.token?.refreshAfterExchange)!;
  const callback = new URL(fixture.authorization.redirectUri);
  callback.searchParams.set("code", "test-code");
  callback.searchParams.set("state", fixture.authorization.state);

  const [result] = await runHostedAuthorizationRegression({
    issuer,
    prepareRegistration: async () => {},
    request: async request => {
      if (new URL(request.url).pathname.endsWith("authorize")) {
        return Response.redirect(callback, 302);
      }
      const refresh = new URLSearchParams(await request.clone().text())
        .get("grant_type") === "refresh_token";
      const headers = new Headers({
        "content-type": "application/json",
        ...TOKEN_RESPONSE_HEADERS,
      });
      if (refresh === (phase === "token-refresh")) headers.set(header, value);
      return new Response(JSON.stringify({
        access_token: "token",
        token_type: "Bearer",
        refresh_token: "refresh",
      }), { headers });
    },
  }, [fixture]);

  expect(result).toMatchObject({ status: "failed", phase, responseStatus: 200 });
});

it.each(["Bearer", "bEaReR", "MAC"])("validates hosted token type %s and reports actual final status", async tokenType => {
  const fixture = createHostedAuthorizationFixtures({issuer: "https://login.example.com", resource: "https://mcp.example.com/mcp"}).find(item => item.token?.refreshAfterExchange)!;
  const [result] = await runHostedAuthorizationRegression({issuer: "https://login.example.com", prepareRegistration: () => {}, request: async request => {
    if (new URL(request.url).pathname.endsWith("authorize")) {
      const callback = new URL(fixture.authorization.redirectUri); callback.searchParams.set("code", "code"); callback.searchParams.set("state", fixture.authorization.state);
      return Response.redirect(callback, 302);
    }
    return tokenJson({access_token: "token", token_type: tokenType, refresh_token: "refresh"}, {status: 200});
  }}, [fixture]);
  expect(result.status).toBe(tokenType === "MAC" ? "failed" : "passed");
  if (tokenType !== "MAC") expect(result.responseStatus).toBe(200);
});
it("rejects a direct JSON authorization error for a registered callback", async () => {
  const fixture = createHostedAuthorizationFixtures({issuer: "https://login.example.com", resource: "https://mcp.example.com/mcp"})[0];
  fixture.expected = {outcome: "rejected", errorCode: "invalid_request"};
  const [result] = await runHostedAuthorizationRegression({issuer: "https://login.example.com", prepareRegistration: () => {}, request: async () => Response.json({error: "invalid_request"}, {status: 400})}, [fixture]);
  expect(result.status).toBe("failed");
});


it.each(['token-exchange', 'token-refresh'])('rejects HTTP 201 during %s and preserves status', async phase => {
  const fixture = createHostedAuthorizationFixtures({issuer: 'https://login.example.com', resource: 'https://mcp.example.com/mcp'}).find(item => item.token?.refreshAfterExchange)!;
  const [result] = await runHostedAuthorizationRegression({ issuer: 'https://login.example.com', prepareRegistration: () => {}, request: async request => {
    if (new URL(request.url).pathname.endsWith('authorize')) {
      const callback = new URL(fixture.authorization.redirectUri); callback.searchParams.set('code', 'code'); callback.searchParams.set('state', fixture.authorization.state);
      return Response.redirect(callback, 302);
    }
    const refresh = new URLSearchParams(await request.text()).get('grant_type') === 'refresh_token';
    return tokenJson({ access_token: 'token', token_type: 'Bearer', refresh_token: 'refresh' }, { status: refresh === (phase === 'token-refresh') ? 201 : 200 });
  } }, [fixture]);
  expect(result).toMatchObject({ status: 'failed', phase, responseStatus: 201 });
});

it.each(["blank", "network", "embedded space", "invalid:character", "bad=padding"])("rejects invalid token evidence: %s", async mode => {
  const fixture = createHostedAuthorizationFixtures({issuer: "https://login.example.com", resource: "https://mcp.example.com/mcp"})[0];
  const [result] = await runHostedAuthorizationRegression({issuer: "https://login.example.com", prepareRegistration: () => {}, request: async request => {
    if (new URL(request.url).pathname.endsWith("authorize")) {
      const callback = new URL(fixture.authorization.redirectUri);
      callback.searchParams.set("code", "code"); callback.searchParams.set("state", fixture.authorization.state);
      return Response.redirect(callback, 302);
    }
    if (mode === "network") throw new Error("network failure");
    return tokenJson({ access_token: mode === "blank" ? "   " : mode, token_type: "Bearer", refresh_token: "refresh" });
  }}, [fixture]);
  expect(result.status).toBe("failed");
  expect(result.responseStatus).toBe(mode === "network" ? undefined : 200);
});

it("rejects invalid-client errors even on a registered state-matching redirect", async () => {
  const fixture = createHostedAuthorizationFixtures({issuer: "https://login.example.com", resource: "https://mcp.example.com/mcp"}).find(item => item.expected.errorCode === "invalid_client")!;
  const [result] = await runHostedAuthorizationRegression({ issuer: "https://login.example.com", prepareRegistration: () => {}, request: async () => {
    const callback = new URL(fixture.authorization.redirectUri);
    callback.searchParams.set("error", "invalid_client"); callback.searchParams.set("state", fixture.authorization.state);
    return Response.redirect(callback, 302);
  } }, [fixture]);
  expect(result.status).toBe("failed");
});

it("submits an independently configured authorization code", async () => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({
    issuer,
    resource: "https://mcp.example.com/mcp",
  })[0]!;
  fixture.token = {
    grantType: "authorization_code",
    code: "independent-fixture-code",
  };
  let submittedCode: string | null = null;
  const [result] = await runHostedAuthorizationRegression({
    issuer,
    prepareRegistration: async () => {},
    request: async request => {
      if (new URL(request.url).pathname.endsWith("authorize")) {
        const callback = new URL(fixture.authorization.redirectUri);
        callback.searchParams.set("code", "redirect-code");
        callback.searchParams.set("state", fixture.authorization.state);
        return Response.redirect(callback, 302);
      }
      submittedCode = new URLSearchParams(await request.text()).get("code");
      return tokenJson({ access_token: "token", token_type: "Bearer" });
    },
  }, [fixture]);
  expect(result.status).toBe("passed");
  expect(submittedCode).toBe("independent-fixture-code");
});

it.each([
  ["matching issuer", "https://login.example.com", "passed"],
  ["mismatched issuer", "https://other.example.com", "failed"],
] as const)("allows authorization-response extensions with a %s", async (_label, responseIssuer, status) => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({
    issuer,
    resource: "https://mcp.example.com/mcp",
  })[0]!;
  fixture.token = undefined;
  const [result] = await runHostedAuthorizationRegression({
    issuer,
    prepareRegistration: async () => {},
    request: async () => {
      const callback = new URL(fixture.authorization.redirectUri);
      callback.searchParams.set("code", "server-issued-code");
      callback.searchParams.set("state", fixture.authorization.state);
      callback.searchParams.set("iss", responseIssuer);
      callback.searchParams.set("extension_parameter", "extension-value");
      return Response.redirect(callback, 302);
    },
  }, [fixture]);
  expect(result.status).toBe(status);
});

it("classifies a direct refresh grant as token refresh", async () => {
  const issuer = "https://login.example.com";
  const fixture = createHostedAuthorizationFixtures({
    issuer,
    resource: "https://mcp.example.com/mcp",
  })[0]!;
  fixture.token = { grantType: "refresh_token", refreshToken: "expired-refresh" };
  fixture.expected = {
    outcome: "rejected",
    errorCode: "invalid_grant",
    phase: "token-refresh",
  };
  const [result] = await runHostedAuthorizationRegression({
    issuer,
    prepareRegistration: async () => {},
    request: async request => {
      if (new URL(request.url).pathname.endsWith("authorize")) {
        const callback = new URL(fixture.authorization.redirectUri);
        callback.searchParams.set("code", "redirect-code");
        callback.searchParams.set("state", fixture.authorization.state);
        return Response.redirect(callback, 302);
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    },
  }, [fixture]);
  expect(result).toMatchObject({
    status: "passed",
    phase: "token-refresh",
    errorCode: "invalid_grant",
  });
});

it.each([null, undefined, false, 0, ""])( "records falsy adapter rejections without skipping remaining fixtures (%j)", async failure => {
  const fixtures = createHostedAuthorizationFixtures({ issuer: "https://login.example.com", resource: "https://mcp.example.com" });
  const results = await runHostedAuthorizationRegression({
    issuer: "https://login.example.com",
    prepareRegistration: async () => { throw failure; },
    request: async () => { throw new Error("unexpected request"); },
  }, fixtures);
  expect(results).toHaveLength(fixtures.length);
  expect(results.every(result => result.status === "failed")).toBe(true);
});

describe("unvetted-client authorization rejections", () => {
  const issuer = "https://login.example.com";
  const resource = "https://mcp.example.com/mcp";
  type AuthorizationErrorOptions = Parameters<
    typeof createMcpAuthorizationCompatibilityHandler
  >[0]["authorizationErrors"];

  function rejectionFixture(id: string) {
    const fixture = createHostedAuthorizationFixtures({ issuer, resource })
      .find((item) => item.id === id)!;
    delete fixture.token;
    fixture.authorization.resource = "https://other.example.com/mcp";
    fixture.expected = {
      outcome: "rejected",
      errorCode: "invalid_target",
      phase: "authorization-request",
    };
    return fixture;
  }

  const DYNAMIC = "dynamic-registration-code-pkce";
  const METADATA_DOCUMENT = "claude-client-metadata-extensible-grants";
  const PRE_REGISTERED = "chatgpt-pre-registered-code-pkce";

  function runAgainstMcpFn(
    ids: string[],
    authorizationErrors?: AuthorizationErrorOptions,
    adjust: (fixture: ReturnType<typeof rejectionFixture>) => void = () => {},
    redirectPolicy?: McpFnRedirectPolicy,
  ) {
    const registrations = new Map<string, McpFnNormalizedClientRegistration>();
    const handler = createMcpAuthorizationCompatibilityHandler({
      issuer,
      clients: { resolve: async (clientId) => registrations.get(clientId) ?? null },
      allowedResources: [resource],
      supportedScopes: ["mcp:read"],
      redirectPolicy,
      authorizationErrors,
      authorize: async () => new Response("unexpected authorize", { status: 500 }),
      tokenAuthority: {
        exchangeAuthorizationCode: async () => {
          throw new Error("unexpected token exchange");
        },
        refreshToken: async () => {
          throw new Error("unexpected token refresh");
        },
      },
    });
    return runHostedAuthorizationRegression({
      issuer,
      redirectPolicy,
      tokenEndpointAuthMethods: ["none"],
      supportedScopes: ["mcp:read"],
      async prepareRegistration(fixture) {
        registrations.set(
          fixture.clientId,
          normalizeMcpClientRegistration({ ...fixture, redirectPolicy }),
        );
      },
      request: (request) => handler(request),
    }, ids.map((id) => {
      const fixture = rejectionFixture(id);
      adjust(fixture);
      return fixture;
    }));
  }

  function htmlPage(body: string) {
    return () => new Response(body, {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  it("accepts McpFn's default HTML error page for dynamic and metadata-document clients", async () => {
    const results = await runAgainstMcpFn([DYNAMIC, METADATA_DOCUMENT]);
    expect(results).toEqual([DYNAMIC, METADATA_DOCUMENT].map((id) => ({
      formatVersion: 1,
      id,
      host: expect.any(String),
      status: "passed",
      phase: "authorization-request",
      layer: "authorization-server",
      responseStatus: 400,
      errorCode: "invalid_target",
    })));
  });

  it("fails an HTML error page whose code differs from the expected code", async () => {
    const [result] = await runAgainstMcpFn([DYNAMIC], {
      render: htmlPage("<p>Error: <code>invalid_request</code></p>"),
    });
    expect(result).toMatchObject({
      status: "failed",
      responseStatus: 400,
      errorCode: "invalid_request",
      error: "Expected rejected:invalid_target, received rejected:invalid_request",
    });
  });

  it("requires a code in the HTML error page only when the fixture expects one", async () => {
    const render = htmlPage("<p>Authorization request failed</p>");
    const [expectingCode] = await runAgainstMcpFn([DYNAMIC], { render });
    expect(expectingCode).toMatchObject({
      status: "failed",
      responseStatus: 400,
      error: "Expected rejected:invalid_target, received rejected",
    });
    expect(expectingCode).not.toHaveProperty("errorCode");
    const [withoutCode] = await runAgainstMcpFn([DYNAMIC], { render }, (fixture) => {
      delete fixture.expected.errorCode;
    });
    expect(withoutCode).toMatchObject({ status: "passed", responseStatus: 400 });
    expect(withoutCode).not.toHaveProperty("errorCode");
  });

  it("takes the first HTML code element that is a valid OAuth error code", async () => {
    const [result] = await runAgainstMcpFn([DYNAMIC], {
      render: htmlPage(
        "<p><code>&quot;quoted&quot;</code> <code><b>bold</b></code> <CODE class=\"e\">invalid&#95;target</CODE> <code>invalid_request</code></p>",
      ),
    });
    expect(result).toMatchObject({ status: "passed", errorCode: "invalid_target" });
  });

  it("accepts error redirects when the host opts unvetted sources back in", async () => {
    const results = await runAgainstMcpFn([DYNAMIC, METADATA_DOCUMENT, PRE_REGISTERED], {
      redirectSources: ["pre-registered", "enterprise", "dynamic", "client-metadata-document"],
    });
    for (const result of results) {
      expect(result).toMatchObject({
        status: "passed",
        responseStatus: 302,
        errorCode: "invalid_target",
      });
    }
  });

  it("keeps the error callback requirement for pre-registered clients", async () => {
    const [redirected] = await runAgainstMcpFn([PRE_REGISTERED]);
    expect(redirected).toMatchObject({
      status: "passed",
      responseStatus: 302,
      errorCode: "invalid_target",
    });
    const [rendered] = await runAgainstMcpFn([PRE_REGISTERED], { redirectSources: [] });
    expect(rendered).toMatchObject({ status: "failed", responseStatus: 400 });
  });

  it("takes the error code from a JSON envelope rendered for an unvetted client", async () => {
    const results = await runAgainstMcpFn([DYNAMIC, METADATA_DOCUMENT], {
      render: ({ error }) => Response.json(
        { error: error.code, error_description: error.message },
        { status: 400 },
      ),
    });
    for (const result of results) {
      expect(result).toMatchObject({
        status: "passed",
        responseStatus: 400,
        errorCode: "invalid_target",
      });
    }
    const [wrongCode] = await runAgainstMcpFn([DYNAMIC], {
      render: () => Response.json({ error: "invalid_request" }, { status: 400 }),
    });
    expect(wrongCode).toMatchObject({ status: "failed", errorCode: "invalid_request" });
  });

  it.each([
    ["reflected redirect URI", (redirectUri: string) =>
      new Response(`<a href="${redirectUri}">Back</a>`, {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8" },
      })],
    ["reflected redirect URI in JSON", (redirectUri: string) =>
      Response.json({ error: "invalid_target", redirect_uri: redirectUri }, { status: 400 })],
    ["non-400 status", () =>
      new Response("<p>denied</p>", {
        status: 403,
        headers: { "content-type": "text/html" },
      })],
    ["location header", (redirectUri: string) =>
      new Response("<p>denied</p>", {
        status: 400,
        headers: { "content-type": "text/html", location: redirectUri },
      })],
    ["plain-text body", () =>
      new Response("denied", {
        status: 400,
        headers: { "content-type": "text/plain" },
      })],
  ] as const)("rejects an unvetted-client error response with %s", async (_name, render) => {
    const [result] = await runAgainstMcpFn([DYNAMIC], {
      render: ({ request }) => render(new URL(request.url).searchParams.get("redirect_uri")!),
    });
    expect(result?.status).toBe("failed");
  });

  describe("registered redirect decision", () => {
    const LOOPBACK = "http://127.0.0.1/callback";
    const RUNTIME_PORT = "http://127.0.0.1:49152/callback";
    const ALL_SOURCES = {
      redirectSources: ["pre-registered", "enterprise", "dynamic", "client-metadata-document"],
    } satisfies AuthorizationErrorOptions;

    function redirect(registered: string, requested: string) {
      return (fixture: ReturnType<typeof rejectionFixture>) => {
        fixture.registration.metadata.redirect_uris = [registered];
        fixture.authorization.redirectUri = requested;
      };
    }

    /** A target that sends every authorization error to the requested URI. */
    function callbackTarget(redirectPolicy?: McpFnRedirectPolicy, error = "invalid_target") {
      return {
        issuer,
        redirectPolicy,
        prepareRegistration: async () => {},
        request: async (request: Request) => {
          const params = new URL(request.url).searchParams;
          const callback = new URL(params.get("redirect_uri")!);
          callback.searchParams.set("error", error);
          callback.searchParams.set("state", params.get("state")!);
          return new Response(null, { status: 302, headers: { location: callback.toString() } });
        },
      };
    }

    it("matches a runtime loopback port like the authorization server", async () => {
      const results = await runAgainstMcpFn(
        [DYNAMIC, METADATA_DOCUMENT],
        undefined,
        redirect(LOOPBACK, RUNTIME_PORT),
      );
      for (const result of results) {
        expect(result).toMatchObject({
          status: "passed",
          responseStatus: 400,
          errorCode: "invalid_target",
        });
      }
    });

    it("treats a runtime loopback port as a mismatch when the redirect policy disables it", async () => {
      const policy = { allowDynamicLoopbackPort: false };
      const [result] = await runAgainstMcpFn([DYNAMIC], undefined, (fixture) => {
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        fixture.expected.errorCode = "invalid_request";
      }, policy);
      expect(result).toMatchObject({
        status: "passed",
        responseStatus: 400,
        errorCode: "invalid_request",
      });
      const fixture = rejectionFixture(DYNAMIC);
      redirect(LOOPBACK, RUNTIME_PORT)(fixture);
      const [callback] = await runHostedAuthorizationRegression(callbackTarget(policy), [fixture]);
      expect(callback).toMatchObject({
        status: "failed",
        error: "Rejected redirect URI must not receive a callback",
      });
    });

    it("matches a canonical HTTPS equivalent of the registered URI", async () => {
      const equivalent = redirect(
        "https://client.example.com/callback",
        "https://CLIENT.example.com:443/callback",
      );
      const [page] = await runAgainstMcpFn([DYNAMIC], undefined, equivalent);
      expect(page).toMatchObject({ status: "passed", responseStatus: 400, errorCode: "invalid_target" });
      const [callback] = await runAgainstMcpFn([DYNAMIC], ALL_SOURCES, equivalent);
      expect(callback).toMatchObject({ status: "passed", responseStatus: 302, errorCode: "invalid_target" });
    });

    it("accepts runtime-port error callbacks for every source the host redirects", async () => {
      const results = await runAgainstMcpFn(
        [DYNAMIC, METADATA_DOCUMENT, PRE_REGISTERED],
        ALL_SOURCES,
        redirect(LOOPBACK, RUNTIME_PORT),
      );
      for (const result of results) {
        expect(result).toMatchObject({
          status: "passed",
          responseStatus: 302,
          errorCode: "invalid_target",
        });
      }
    });

    it.each([
      ["a different URI", "https://client.example.com/callback", "https://client.example.com/other"],
      ["a plain-HTTP non-loopback URI", "http://client.example.com/callback", "http://client.example.com/callback"],
      ["a URI with a fragment", "https://client.example.com/callback#f", "https://client.example.com/callback#f"],
    ])("never classifies %s as registered", async (_name, registered, requested) => {
      for (const id of [DYNAMIC, PRE_REGISTERED]) {
        const fixture = rejectionFixture(id);
        redirect(registered, requested)(fixture);
        const [callback] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
        expect(callback).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
      }
      const fixture = rejectionFixture(DYNAMIC);
      redirect(registered, requested)(fixture);
      const [page] = await runHostedAuthorizationRegression({
        issuer,
        prepareRegistration: async () => {},
        request: htmlPage("<p><code>invalid_target</code></p>"),
      }, [fixture]);
      expect(page).toMatchObject({
        status: "failed",
        error: "Authorization request did not redirect (HTTP 400)",
      });
    });

    it("registers nothing when any registered redirect URI is malformed", async () => {
      const malformedSibling = (fixture: ReturnType<typeof rejectionFixture>) => {
        fixture.registration.metadata.redirect_uris = [
          "http://client.example.com/callback",
          "https://client.example.com/callback",
        ];
        fixture.authorization.redirectUri = "https://CLIENT.example.com:443/callback";
        fixture.expected.errorCode = "invalid_client_metadata";
      };
      for (const id of [DYNAMIC, PRE_REGISTERED]) {
        const fixture = rejectionFixture(id);
        malformedSibling(fixture);
        const [envelope] = await runHostedAuthorizationRegression({
          issuer,
          prepareRegistration: async () => {},
          request: async () => Response.json({ error: "invalid_client_metadata" }, { status: 400 }),
        }, [fixture]);
        expect(envelope).toMatchObject({ status: "passed", errorCode: "invalid_client_metadata" });
        const [callback] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
        expect(callback).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
      }
    });

    it.each(["response_types", "grant_types"] as const)(
      "accepts the JSON rejection of a stored registration with malformed %s",
      async (field) => {
        const stored = new Map<string, McpFnNormalizedClientRegistration>();
        const handler = createMcpAuthorizationCompatibilityHandler({
          issuer,
          clients: { resolve: async (clientId) => stored.get(clientId) ?? null },
          allowedResources: [resource],
          supportedScopes: ["mcp:read"],
          authorize: async () => new Response("unexpected authorize", { status: 500 }),
          tokenAuthority: {
            exchangeAuthorizationCode: async () => {
              throw new Error("unexpected token exchange");
            },
            refreshToken: async () => {
              throw new Error("unexpected token refresh");
            },
          },
        });
        for (const requested of [
          "https://client.example.com/callback",
          "https://CLIENT.example.com:443/callback",
        ]) {
          const fixture = rejectionFixture(PRE_REGISTERED);
          redirect("https://client.example.com/callback", requested)(fixture);
          Object.assign(fixture.registration.metadata, { [field]: "code" });
          fixture.expected.errorCode = "invalid_client_metadata";
          const [result] = await runHostedAuthorizationRegression({
            issuer,
            async prepareRegistration(registration) {
              stored.set(registration.clientId, registration as McpFnNormalizedClientRegistration);
            },
            request: (request) => handler(request),
          }, [fixture]);
          expect(result).toMatchObject({
            status: "passed",
            responseStatus: 400,
            errorCode: "invalid_client_metadata",
          });
          for (const error of ["invalid_client_metadata", "invalid_target"]) {
            const [redirected] = await runHostedAuthorizationRegression(
              callbackTarget(undefined, error),
              [fixture],
            );
            expect(redirected).toMatchObject({
              status: "failed",
              error: "Rejected redirect URI must not receive a callback",
            });
          }
        }
        const fixture = rejectionFixture(PRE_REGISTERED);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        Object.assign(fixture.registration.metadata, { [field]: "code" });
        const [callback] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
        expect(callback).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
      },
    );

    describe("registration eligibility", () => {
      const INELIGIBLE = [
        ["response_types [token]", { response_types: ["token"] }],
        ["grant_types [refresh_token]", { grant_types: ["refresh_token"] }],
      ] as const;
      const REQUESTS = [
        ["a runtime loopback port", LOOPBACK, RUNTIME_PORT],
        ["a canonical HTTPS equivalent", "https://client.example.com/callback", "https://CLIENT.example.com:443/callback"],
        ["a literal URI", LOOPBACK, LOOPBACK],
      ] as const;

      it.each(INELIGIBLE.flatMap(([name, metadata]) =>
        REQUESTS.map(([kind, registered, requested]) =>
          [name, kind, metadata, registered, requested] as const)))(
        "registers nothing for %s requested with %s",
        async (_name, _kind, metadata, registered, requested) => {
          const ineligible = (fixture: ReturnType<typeof rejectionFixture>) => {
            redirect(registered, requested)(fixture);
            Object.assign(fixture.registration.metadata, metadata);
            delete fixture.expected.errorCode;
          };
          const [real] = await runAgainstMcpFn([DYNAMIC], undefined, ineligible);
          expect(real).toMatchObject({ status: "passed", errorCode: "invalid_client" });
          for (const id of [DYNAMIC, METADATA_DOCUMENT, PRE_REGISTERED]) {
            const fixture = rejectionFixture(id);
            ineligible(fixture);
            const [callback] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
            expect(callback).toMatchObject({
              status: "failed",
              error: "Rejected redirect URI must not receive a callback",
            });
          }
          const fixture = rejectionFixture(DYNAMIC);
          ineligible(fixture);
          const [page] = await runHostedAuthorizationRegression({
            issuer,
            prepareRegistration: async () => {},
            request: htmlPage("<p><code>invalid_target</code></p>"),
          }, [fixture]);
          expect(page).toMatchObject({
            status: "failed",
            error: "Authorization request did not redirect (HTTP 400)",
          });
        },
      );

      it("checks the token endpoint authentication method only when the target declares it", async () => {
        const fixture = rejectionFixture(PRE_REGISTERED);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        fixture.registration.metadata.token_endpoint_auth_method = "client_secret_post";
        const [declared] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["none"] },
          [fixture],
        );
        expect(declared).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
        const [undeclared] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
        expect(undeclared).toMatchObject({ status: "passed", errorCode: "invalid_target" });
        const [supported] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["none", "client_secret_post"] },
          [fixture],
        );
        expect(supported).toMatchObject({ status: "passed", errorCode: "invalid_target" });
      });

      it("applies the server's client_secret_basic default to a metadata document", async () => {
        const fixture = rejectionFixture(METADATA_DOCUMENT);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        delete fixture.registration.metadata.token_endpoint_auth_method;
        const [none] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["none"] },
          [fixture],
        );
        expect(none).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
        const [basic] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["client_secret_basic"] },
          [fixture],
        );
        expect(basic).toMatchObject({ status: "passed", errorCode: "invalid_target" });
      });

      it("checks registered scopes only when the target declares supported scopes", async () => {
        const [real] = await runAgainstMcpFn([DYNAMIC], undefined, (fixture) => {
          redirect(LOOPBACK, RUNTIME_PORT)(fixture);
          fixture.registration.metadata.scope = "mcp:read mcp:admin";
          delete fixture.expected.errorCode;
        });
        expect(real).toMatchObject({ status: "passed", errorCode: "invalid_client" });
        const fixture = rejectionFixture(PRE_REGISTERED);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        fixture.registration.metadata.scope = "mcp:read mcp:admin";
        const [declared] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), supportedScopes: ["mcp:read"] },
          [fixture],
        );
        expect(declared).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
        const [undeclared] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
        expect(undeclared).toMatchObject({ status: "passed", errorCode: "invalid_target" });
        fixture.registration.metadata.scope = "mcp:read";
        const [within] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), supportedScopes: ["mcp:read"] },
          [fixture],
        );
        expect(within).toMatchObject({ status: "passed", errorCode: "invalid_target" });
        Object.assign(fixture.registration.metadata, { scope: ["mcp:read"] });
        const [malformed] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
        expect(malformed).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
      });
    });

    it("never accepts an invalid_client_metadata error callback", async () => {
      const fixture = rejectionFixture(PRE_REGISTERED);
      redirect(LOOPBACK, RUNTIME_PORT)(fixture);
      fixture.expected.errorCode = "invalid_client_metadata";
      const [callback] = await runHostedAuthorizationRegression(
        callbackTarget(undefined, "invalid_client_metadata"),
        [fixture],
      );
      expect(callback).toMatchObject({
        status: "failed",
        error: "Invalid-client authorization failures must not redirect",
      });
    });

    it("never lets another client's registration match an unknown client's redirect", async () => {
      for (const requested of [LOOPBACK, RUNTIME_PORT]) {
        const fixture = rejectionFixture(DYNAMIC);
        redirect(LOOPBACK, requested)(fixture);
        fixture.authorization.clientId = "unknown-client";
        delete fixture.expected.errorCode;
        const [callback] = await runHostedAuthorizationRegression(callbackTarget(), [fixture]);
        expect(callback).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
      }
    });

    it.each([
      ["the requested runtime-port URI in HTML", () =>
        htmlPage(`<a href="${RUNTIME_PORT}">Back</a>`)()],
      ["the requested runtime-port URI in JSON", () =>
        Response.json({ error: "invalid_target", redirect_uri: RUNTIME_PORT }, { status: 400 })],
      ["the registered URI it matched", () =>
        htmlPage(`<code>invalid_target</code> <a href="${LOOPBACK}">Back</a>`)()],
    ])("rejects an error response that reflects %s", async (_name, render) => {
      const [result] = await runAgainstMcpFn(
        [DYNAMIC],
        { render },
        redirect(LOOPBACK, RUNTIME_PORT),
      );
      expect(result).toMatchObject({
        status: "failed",
        error: "Authorization error response must not reflect the client redirect URI",
      });
    });
  });
});
