import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import {
  createMcpAuthorizationCompatibilityHandler,
  McpFnHostedAuthorizationError,
  normalizeMcpClientRegistration,
  type McpFnNormalizedClientRegistration,
  type McpFnRedirectPolicy,
} from "@mcpfn/auth";

import {
  createHostedAuthorizationFixtures,
  runHostedAuthorizationRegression,
  type McpFnHostedAuthorizationCase,
  type McpFnHostedAuthorizationEvidence,
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

  /**
   * Records evidence per handler call and binds it to the Response that call
   * returned, so a retrying adapter reports the attempt it returned.
   */
  function evidenceRecorder() {
    const attempts = new AsyncLocalStorage<McpFnHostedAuthorizationEvidence>();
    const recorded = new WeakMap<Response, McpFnHostedAuthorizationEvidence>();
    const recorder = {
      /** Client resolutions across every call, for assertions. */
      total: 0,
      resolved() {
        recorder.total += 1;
        const attempt = attempts.getStore();
        if (attempt) attempt.clientResolutions += 1;
      },
      /** Wraps a policy hook so a rejection it raises is recorded as a denial. */
      policy<T>(hook: (input: T) => unknown) {
        return async (input: T) => {
          try {
            await hook(input);
          } catch (error) {
            const attempt = attempts.getStore();
            if (attempt) attempt.preClientResolutionDenial = true;
            throw error;
          }
        };
      },
      async call(handler: (request: Request) => Promise<Response>, request: Request) {
        const attempt = { clientResolutions: 0, preClientResolutionDenial: false };
        const response = await attempts.run(attempt, () => handler(request));
        recorded.set(response, attempt);
        return response;
      },
      authorizationEvidence: (response: Response) => recorded.get(response),
    };
    return recorder;
  }

  function runAgainstMcpFn(
    ids: string[],
    authorizationErrors?: AuthorizationErrorOptions,
    adjust: (fixture: ReturnType<typeof rejectionFixture>) => void = () => {},
    redirectPolicy?: McpFnRedirectPolicy,
    capabilities: { tokenEndpointAuthMethods?: string[]; supportedScopes?: string[] } = {},
  ) {
    const registrations = new Map<string, McpFnNormalizedClientRegistration>();
    const recorder = evidenceRecorder();
    const handler = createMcpAuthorizationCompatibilityHandler({
      issuer,
      clients: {
        resolve: async (clientId) => {
          recorder.resolved();
          return registrations.get(clientId) ?? null;
        },
      },
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
      ...capabilities,
      authorizationEvidence: recorder.authorizationEvidence,
      async prepareRegistration(fixture) {
        registrations.set(
          fixture.clientId,
          normalizeMcpClientRegistration({ ...fixture, redirectPolicy }),
        );
      },
      request: (request) => recorder.call(handler, request),
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
          const notClientError = (code: string) => ({
            status: "failed",
            error: `An ineligible client registration must be rejected as a client error, not ${code}`,
          });
          const errorPage = {
            status: "failed",
            error: "Authorization request did not redirect (HTTP 400)",
          };
          const json = (error: string) => () => Response.json({ error }, { status: 400 });
          for (const [render, expected] of [
            [json("invalid_client"), { status: "passed", responseStatus: 400, errorCode: "invalid_client" }],
            [json("invalid_target"), notClientError("invalid_target")],
            [json("invalid_scope"), notClientError("invalid_scope")],
            [htmlPage("<p><code>invalid_client</code></p>"), errorPage],
            [htmlPage("<!-- <code>invalid_client</code> --><p><code>invalid_target</code></p>"), errorPage],
          ] as const) {
            const [page] = await runHostedAuthorizationRegression({
              issuer,
              prepareRegistration: async () => {},
              request: async () => render(),
            }, [fixture]);
            expect(page).toMatchObject(expected);
          }
        },
      );

      it.each(INELIGIBLE)(
        "checks a JSON rejection for %s for redirect URI reflection",
        async (_name, metadata) => {
          // Raw, normalized and registered forms of the redirect URI differ.
          const requested = "HTTP://127.0.0.1:49152/callback";
          const ineligible = (fixture: ReturnType<typeof rejectionFixture>) => {
            redirect(LOOPBACK, requested)(fixture);
            Object.assign(fixture.registration.metadata, metadata);
            delete fixture.expected.errorCode;
          };
          const [real] = await runAgainstMcpFn([DYNAMIC], undefined, ineligible);
          expect(real).toMatchObject({ status: "passed", errorCode: "invalid_client" });
          const fixture = rejectionFixture(DYNAMIC);
          ineligible(fixture);
          const rejectWith = (description: string) => ({
            issuer,
            prepareRegistration: async () => {},
            request: async () => Response.json(
              { error: "invalid_client", error_description: description },
              { status: 400 },
            ),
          });
          for (const reflected of [requested, RUNTIME_PORT, LOOPBACK]) {
            const [result] = await runHostedAuthorizationRegression(
              rejectWith(`Client cannot use ${reflected}`),
              [fixture],
            );
            expect(result).toMatchObject({
              status: "failed",
              error: "Authorization error response must not reflect the client redirect URI",
            });
          }
          const [clean] = await runHostedAuthorizationRegression(
            rejectWith("Client is not compatible"),
            [fixture],
          );
          expect(clean).toMatchObject({ status: "passed", errorCode: "invalid_client" });
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

      const INDETERMINATE = expect.stringContaining("Registration eligibility is indeterminate");

      it.each([
        ["omitted", undefined],
        ["null", null],
      ])("decides a metadata document whose method is %s from the declared defaults", async (_name, method) => {
        const withoutMethod = (fixture: ReturnType<typeof rejectionFixture>) => {
          redirect(LOOPBACK, RUNTIME_PORT)(fixture);
          Object.assign(fixture.registration.metadata, { token_endpoint_auth_method: method });
        };
        // Without a method, a stored registration and a fetched document
        // both use none (Client ID Metadata Document draft, section 5): the
        // fixture is eligible wherever none is supported.
        for (const declared of [["none"], ["none", "client_secret_basic"]]) {
          const [stored] = await runAgainstMcpFn([METADATA_DOCUMENT], undefined, withoutMethod, undefined, {
            tokenEndpointAuthMethods: declared,
          });
          expect(stored).toMatchObject({ status: "passed" });
        }
        // A fetched document whose supported-methods list leaves out none
        // defaults to the first listed method, which a public document may
        // not use.
        const fixture = rejectionFixture(METADATA_DOCUMENT);
        withoutMethod(fixture);
        Object.assign(fixture.registration.metadata, { token_endpoint_auth_methods_supported: ["client_secret_basic"] });
        fixture.expected.errorCode = "invalid_client_metadata";
        const handler = createMcpAuthorizationCompatibilityHandler({
          issuer,
          clients: { resolve: async () => null },
          clientMetadataDocuments: {
            enabled: true,
            allow: async () => true,
            fetch: async () => Response.json({
              ...fixture.registration.metadata,
              client_id: fixture.registration.clientId,
            }),
          },
          capabilities: { tokenEndpointAuthMethods: ["none"] },
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
        const [fetched] = await runHostedAuthorizationRegression({
          issuer,
          tokenEndpointAuthMethods: ["none"],
          supportedScopes: ["mcp:read"],
          prepareRegistration: async () => {},
          request: (request) => handler(request),
        }, [fixture]);
        expect(fetched).toMatchObject({
          status: "passed",
          responseStatus: 400,
          errorCode: "invalid_client_metadata",
        });
        // A fetched document with an unsupported registered scope is rejected
        // as invalid_scope before the redirect URI is matched.
        delete fixture.registration.metadata.token_endpoint_auth_methods_supported;
        Object.assign(fixture.registration.metadata, { token_endpoint_auth_method: "none", scope: "mcp:admin" });
        fixture.expected.errorCode = "invalid_scope";
        const [unsupportedScope] = await runHostedAuthorizationRegression({
          issuer,
          tokenEndpointAuthMethods: ["none"],
          supportedScopes: ["mcp:read"],
          prepareRegistration: async () => {},
          request: (request) => handler(request),
        }, [fixture]);
        expect(unsupportedScope).toMatchObject({ status: "passed", errorCode: "invalid_scope" });
        withoutMethod(fixture);
        delete fixture.registration.metadata.scope;
        fixture.expected.errorCode = "invalid_target";
        // Both paths use none: with none supported, the registration is
        // eligible and a callback carrying the expected error passes.
        for (const declared of [["none"], ["none", "client_secret_basic"], undefined]) {
          const [callback] = await runHostedAuthorizationRegression(
            { ...callbackTarget(), tokenEndpointAuthMethods: declared },
            [fixture],
          );
          expect(callback).toMatchObject({ status: "passed", errorCode: "invalid_target" });
        }
        // A declared client_secret_basic document can only be stored, never
        // fetched: with both methods supported, a callback is indeterminate.
        fixture.registration.metadata.token_endpoint_auth_method = "client_secret_basic";
        const [storedOnly] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["none", "client_secret_basic"] },
          [fixture],
        );
        expect(storedOnly).toMatchObject({ status: "failed", error: INDETERMINATE });
        withoutMethod(fixture);
        // Neither path can accept it: the registration is ineligible.
        for (const declared of [["client_secret_basic"], ["client_secret_post"]]) {
          const [neither] = await runHostedAuthorizationRegression(
            { ...callbackTarget(), tokenEndpointAuthMethods: declared },
            [fixture],
          );
          expect(neither).toMatchObject({
            status: "failed",
            error: "Rejected redirect URI must not receive a callback",
          });
        }
        // Another source without a method is none.
        const dynamic = rejectionFixture(DYNAMIC);
        withoutMethod(dynamic);
        const [basicOnly] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["client_secret_basic"] },
          [dynamic],
        );
        expect(basicOnly).toMatchObject({
          status: "failed",
          error: "Rejected redirect URI must not receive a callback",
        });
      });

      it("requires an eligible registration for a code callback", async () => {
        const allowed = (id: string, adjust: (fixture: McpFnHostedAuthorizationCase) => void) => {
          const fixture = createHostedAuthorizationFixtures({ issuer, resource })
            .find((item) => item.id === id)!;
          delete fixture.token;
          redirect(LOOPBACK, RUNTIME_PORT)(fixture);
          adjust(fixture);
          return fixture;
        };
        type Capabilities = { tokenEndpointAuthMethods?: string[]; supportedScopes?: string[] };
        const codeTarget = (capabilities: Capabilities) => ({
          issuer,
          ...capabilities,
          prepareRegistration: async () => {},
          request: async (request: Request) => {
            const params = new URL(request.url).searchParams;
            const callback = new URL(params.get("redirect_uri")!);
            callback.searchParams.set("code", "test-authorization-code");
            callback.searchParams.set("state", params.get("state")!);
            return new Response(null, { status: 302, headers: { location: callback.toString() } });
          },
        });
        const REJECTED = "Rejected redirect URI must not receive a callback";
        const cases: [McpFnHostedAuthorizationCase, Capabilities, unknown, Capabilities][] = [
          [allowed(DYNAMIC, (fixture) => {
            fixture.registration.metadata.scope = "mcp:admin";
          }), { supportedScopes: ["mcp:read"] }, REJECTED, { supportedScopes: ["mcp:admin"] }],
          [allowed(DYNAMIC, (fixture) => {
            fixture.registration.metadata.token_endpoint_auth_method = "client_secret_post";
          }), { tokenEndpointAuthMethods: ["none"] }, REJECTED, { tokenEndpointAuthMethods: ["client_secret_post"] }],
          [allowed(METADATA_DOCUMENT, (fixture) => {
            fixture.registration.metadata.token_endpoint_auth_method = "none";
          }), { tokenEndpointAuthMethods: ["client_secret_post"] }, REJECTED, {
            tokenEndpointAuthMethods: ["none"],
          }],
        ];
        for (const [fixture, unsupported, error, supported] of cases) {
          const [rejected] = await runHostedAuthorizationRegression(codeTarget(unsupported), [fixture]);
          expect(rejected).toMatchObject({ status: "failed", error });
          for (const capabilities of [supported, {}]) {
            const [result] = await runHostedAuthorizationRegression(codeTarget(capabilities), [fixture]);
            expect(result).toMatchObject({ status: "passed", phase: "authorization-request" });
          }
        }
      });

      it("accepts invalid_scope only for a metadata document rejected on its scope alone", async () => {
        const scoped = (id: string, metadata: object = {}) => {
          const fixture = rejectionFixture(id);
          redirect(LOOPBACK, RUNTIME_PORT)(fixture);
          Object.assign(fixture.registration.metadata, { scope: "mcp:admin", ...metadata });
          delete fixture.expected.errorCode;
          return fixture;
        };
        const rejectWith = (error: string) => ({
          issuer,
          supportedScopes: ["mcp:read"],
          prepareRegistration: async () => {},
          request: async () => Response.json({ error }, { status: 400 }),
        });
        const [document] = await runHostedAuthorizationRegression(
          rejectWith("invalid_scope"),
          [scoped(METADATA_DOCUMENT)],
        );
        expect(document).toMatchObject({ status: "passed", errorCode: "invalid_scope" });
        for (const fixture of [
          scoped(DYNAMIC),
          scoped(PRE_REGISTERED),
          scoped(METADATA_DOCUMENT, { grant_types: ["refresh_token"] }),
        ]) {
          const [result] = await runHostedAuthorizationRegression(rejectWith("invalid_scope"), [fixture]);
          expect(result).toMatchObject({
            status: "failed",
            error: "An ineligible client registration must be rejected as a client error, not invalid_scope",
          });
        }
      });

      it("accepts invalid_scope only when the fetched document's method passed", async () => {
        const fixture = rejectionFixture(METADATA_DOCUMENT);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        // Without a method, a document listing only client_secret_basic would
        // be fetched with that method, which a public document may not use.
        Object.assign(fixture.registration.metadata, {
          scope: "mcp:admin",
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
        delete fixture.registration.metadata.token_endpoint_auth_method;
        delete fixture.expected.errorCode;
        const rejectWith = (error: string, tokenEndpointAuthMethods: string[]) => ({
          issuer,
          tokenEndpointAuthMethods,
          supportedScopes: ["mcp:read"],
          prepareRegistration: async () => {},
          request: async () => Response.json({ error }, { status: 400 }),
        });
        // Fetched, the document is refused on its method before its scope.
        const [basic] = await runHostedAuthorizationRegression(
          rejectWith("invalid_scope", ["client_secret_basic"]),
          [fixture],
        );
        expect(basic).toMatchObject({
          status: "failed",
          error: "An ineligible client registration must be rejected as a client error, not invalid_scope",
        });
        const [none] = await runHostedAuthorizationRegression(rejectWith("invalid_scope", ["none"]), [fixture]);
        expect(none).toMatchObject({
          status: "failed",
          error: "An ineligible client registration must be rejected as a client error, not invalid_scope",
        });
        // A client-stage rejection is a union over stored and fetched resolution.
        for (const error of ["invalid_client", "invalid_client_metadata"]) {
          const [result] = await runHostedAuthorizationRegression(rejectWith(error, ["none"]), [fixture]);
          expect(result).toMatchObject({ status: "passed", errorCode: error });
        }
        delete fixture.registration.metadata.token_endpoint_auth_methods_supported;
        fixture.registration.metadata.token_endpoint_auth_method = "none";
        for (const [error, status] of [
          ["invalid_scope", "passed"],
          ["invalid_client", "passed"],
          ["invalid_request", "failed"],
        ] as const) {
          const [result] = await runHostedAuthorizationRegression(rejectWith(error, ["none"]), [fixture]);
          expect(result).toMatchObject({ status });
        }
        // A client-stage code needs the client stage: evidence of no resolution
        // fails it unless that response is a pre-client-resolution denial.
        for (const [reported, status] of [
          [{ clientResolutions: 0, preClientResolutionDenial: false }, "failed"],
          [{ clientResolutions: 0, preClientResolutionDenial: true }, "passed"],
          [{ clientResolutions: 1, preClientResolutionDenial: false }, "passed"],
          [undefined, "passed"],
        ] as const) {
          for (const error of ["invalid_scope", "invalid_client", "invalid_client_metadata"]) {
            const [result] = await runHostedAuthorizationRegression(
              { ...rejectWith(error, ["none"]), authorizationEvidence: () => reported },
              [fixture],
            );
            expect(result).toMatchObject(status === "passed" ? { status, errorCode: error } : {
              status,
              error: "A client-stage rejection requires a client resolution, but the response's evidence shows none",
            });
          }
        }
      });

      it("never accepts a post-match response for an indeterminate metadata document", async () => {
        // A client_secret_basic document can be stored but never fetched.
        for (const declared of [["client_secret_basic"], ["none", "client_secret_basic"]]) {
          const fixture = rejectionFixture(METADATA_DOCUMENT);
          redirect(LOOPBACK, RUNTIME_PORT)(fixture);
          fixture.registration.metadata.token_endpoint_auth_method = "client_secret_basic";
          delete fixture.expected.errorCode;
          const respondWith = (render: () => Response) => ({
            issuer,
            tokenEndpointAuthMethods: declared,
            prepareRegistration: async () => {},
            request: async () => render(),
          });
          const json = (error: string) => () => Response.json({ error }, { status: 400 });
          for (const render of [htmlPage("<p><code>invalid_target</code></p>"), json("invalid_target")]) {
            const [result] = await runHostedAuthorizationRegression(respondWith(render), [fixture]);
            expect(result).toMatchObject({ status: "failed", error: INDETERMINATE });
          }
          for (const error of ["invalid_client", "invalid_client_metadata"]) {
            const [result] = await runHostedAuthorizationRegression(respondWith(json(error)), [fixture]);
            expect(result).toMatchObject({ status: "passed", responseStatus: 400, errorCode: error });
          }
        }
      });

      it.each([
        ["declares none outside its list", { token_endpoint_auth_method: "none", token_endpoint_auth_methods_supported: ["private_key_jwt"] }],
        ["lists a nested array", { token_endpoint_auth_methods_supported: [["none"]] }],
        ["lists nothing", { token_endpoint_auth_methods_supported: [] }],
      ])("never counts a metadata document that %s as fetchable", async (_name, extra) => {
        const fixture = rejectionFixture(METADATA_DOCUMENT);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        delete fixture.registration.metadata.token_endpoint_auth_method;
        Object.assign(fixture.registration.metadata, extra);
        fixture.expected.errorCode = "invalid_target";
        // Stored with none, the registration could succeed; fetched, it is
        // refused: a callback is indeterminate, never a pass.
        const [callback] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["none"] },
          [fixture],
        );
        expect(callback).toMatchObject({ status: "failed", error: INDETERMINATE });
      });

      it("does not count a document with an unsafe link as fetchable", async () => {
        const fixture = rejectionFixture(METADATA_DOCUMENT);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        delete fixture.registration.metadata.token_endpoint_auth_method;
        Object.assign(fixture.registration.metadata, {
          token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
          logo_uri: "http://client.example.com/logo.png",
        });
        fixture.expected.errorCode = "invalid_target";
        // Stored, the link is dropped and none is used; fetched, the
        // document is refused: a callback is indeterminate, never a pass.
        const [callback] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["none"] },
          [fixture],
        );
        expect(callback).toMatchObject({ status: "failed", error: INDETERMINATE });
        // Neither path answers invalid_scope for an unsupported scope: the
        // fetch refuses the link first, the store answers invalid_client.
        Object.assign(fixture.registration.metadata, { scope: "mcp:admin" });
        delete fixture.expected.errorCode;
        const [scope] = await runHostedAuthorizationRegression({
          issuer,
          tokenEndpointAuthMethods: ["none"],
          supportedScopes: ["mcp:read"],
          prepareRegistration: async () => {},
          request: async () => Response.json({ error: "invalid_scope" }, { status: 400 }),
        }, [fixture]);
        expect(scope).toMatchObject({
          status: "failed",
          error: "An ineligible client registration must be rejected as a client error, not invalid_scope",
        });
      });

      it("decides a metadata document that also offers none per resolution path", async () => {
        const fixture = rejectionFixture(METADATA_DOCUMENT);
        redirect(LOOPBACK, RUNTIME_PORT)(fixture);
        Object.assign(fixture.registration.metadata, {
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
        });
        fixture.expected.errorCode = "invalid_target";
        // Stored with private_key_jwt and fetched with none: with both
        // supported, both paths accept it.
        const [callback] = await runHostedAuthorizationRegression(
          { ...callbackTarget(), tokenEndpointAuthMethods: ["none", "private_key_jwt"] },
          [fixture],
        );
        expect(callback).toMatchObject({ status: "passed", errorCode: "invalid_target" });
        // Supporting only none, a stored client would be refused while the
        // fetched document is accepted. The harness cannot tell which path
        // answered, so even the real fetching handler's callback is
        // indeterminate rather than passed.
        const fetching = createMcpAuthorizationCompatibilityHandler({
          issuer,
          clients: { resolve: async () => null },
          clientMetadataDocuments: {
            enabled: true,
            allow: async () => true,
            fetch: async () => Response.json({
              ...fixture.registration.metadata,
              client_id: fixture.registration.clientId,
            }),
          },
          capabilities: { tokenEndpointAuthMethods: ["none"] },
          allowedResources: [resource],
          supportedScopes: ["mcp:read"],
          authorize: async () => new Response("unexpected authorize", { status: 500 }),
          tokenAuthority: {
            exchangeAuthorizationCode: async () => {
              throw new Error("unexpected token exchange");
            },
          },
        });
        const [real] = await runHostedAuthorizationRegression({
          issuer,
          tokenEndpointAuthMethods: ["none"],
          supportedScopes: ["mcp:read"],
          prepareRegistration: async () => {},
          request: (request) => fetching(request),
        }, [fixture]);
        expect(real).toMatchObject({ status: "failed", error: INDETERMINATE });
      });

      it.each([
        ["a mismatched URI", "https://other.example.com/cb"],
        ["a matching runtime-port URI", RUNTIME_PORT],
      ])("requires a client error for an ineligible registration requested with %s", async (_name, requested) => {
        const fixture = rejectionFixture(DYNAMIC);
        redirect(LOOPBACK, requested)(fixture);
        fixture.registration.metadata.response_types = ["token"];
        delete fixture.expected.errorCode;
        for (const [error, status] of [
          ["invalid_client", "passed"],
          ["invalid_request", "failed"],
          ["invalid_client_metadata", "failed"],
          ["invalid_scope", "failed"],
        ] as const) {
          const [result] = await runHostedAuthorizationRegression({
            issuer,
            prepareRegistration: async () => {},
            request: async () => Response.json({ error }, { status: 400 }),
          }, [fixture]);
          expect(result).toMatchObject(status === "passed" ? { status, errorCode: error } : {
            status,
            error: `An ineligible client registration must be rejected as a client error, not ${error}`,
          });
        }
      });

      const NOT_CLIENT_ERROR = (error: string) =>
        `An ineligible client registration must be rejected as a client error, not ${error}`;

      /** An ineligible dynamic and an indeterminate metadata-document fixture. */
      function notEligible(requested: string, expected?: string) {
        const ineligible = rejectionFixture(DYNAMIC);
        ineligible.registration.metadata.response_types = ["token"];
        // Storable with client_secret_basic, never fetchable.
        const indeterminate = rejectionFixture(METADATA_DOCUMENT);
        indeterminate.registration.metadata.token_endpoint_auth_method = "client_secret_basic";
        for (const fixture of [ineligible, indeterminate]) {
          redirect(LOOPBACK, requested)(fixture);
          if (expected) fixture.expected.errorCode = expected;
          else delete fixture.expected.errorCode;
        }
        return [ineligible, indeterminate] as const;
      }
      const URIS = ["https://other.example.com/cb", RUNTIME_PORT];

      const NO_RESOLUTION =
        "A post-match authorization response requires a client resolution, but the response's evidence shows none";
      const evidence = (clientResolutions: number, preClientResolutionDenial: boolean) =>
        ({ clientResolutions, preClientResolutionDenial });

      /**
       * The real handler with a beforeClientResolution policy that denies the
       * calls `denies` selects; stored lookups and metadata-document fetches
       * and the denial are recorded per call and bound to its response.
       */
      function policyTarget(policyError: string, denies: (call: number) => boolean) {
        const recorder = evidenceRecorder();
        const registrations = new Map<string, McpFnNormalizedClientRegistration>();
        let calls = 0;
        const handler = createMcpAuthorizationCompatibilityHandler({
          issuer,
          clients: {
            resolve: async (clientId) => {
              recorder.resolved();
              return registrations.get(clientId) ?? null;
            },
          },
          clientMetadataDocuments: {
            enabled: true,
            allow: async () => true,
            fetch: async () => {
              recorder.resolved();
              return new Response(null, { status: 404 });
            },
          },
          beforeClientResolution: recorder.policy(() => {
            calls += 1;
            if (denies(calls)) {
              throw new McpFnHostedAuthorizationError(policyError, "Client is blocked by policy");
            }
          }),
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
        const target = {
          issuer,
          tokenEndpointAuthMethods: ["none", "client_secret_basic"],
          async prepareRegistration(fixture: McpFnHostedAuthorizationCase["registration"]) {
            registrations.set(fixture.clientId, normalizeMcpClientRegistration(fixture));
          },
          request: (request: Request) => recorder.call(handler, request),
          authorizationEvidence: recorder.authorizationEvidence,
        };
        /** An adapter that retries once and returns the second attempt. */
        const retrying = (second: (request: Request) => Promise<Response> = handler) => ({
          ...target,
          request: async (request: Request) => {
            await recorder.call(handler, request.clone());
            return recorder.call(second, request);
          },
        });
        return { recorder, target, retrying };
      }

      it.each(["access_denied", "invalid_target"])(
        "accepts a %s policy denial whose response evidence shows no client resolution",
        async (policyError) => {
          const { recorder, target } = policyTarget(policyError, () => true);
          const { authorizationEvidence: _evidence, ...strict } = target;
          for (const requested of URIS) {
            for (const expected of [undefined, policyError]) {
              const fixtures = notEligible(requested, expected);
              const results = await runHostedAuthorizationRegression(target, [...fixtures]);
              for (const result of results) {
                expect(result).toMatchObject({ status: "passed", responseStatus: 400, errorCode: policyError });
              }
              // Without evidence, the stage is unknown: client-stage codes only.
              const [a, b] = await runHostedAuthorizationRegression(strict, [...fixtures]);
              expect(a).toMatchObject({ status: "failed", error: NOT_CLIENT_ERROR(policyError) });
              expect(b).toMatchObject({ status: "failed", error: INDETERMINATE });
            }
          }
          expect(recorder.total).toBe(0);
        },
      );

      it("rejects a non-client code that validation returned before any client resolution", async () => {
        const recorder = evidenceRecorder();
        const validating = {
          issuer,
          tokenEndpointAuthMethods: ["none", "client_secret_basic"],
          prepareRegistration: async () => {},
          request: (request: Request) => recorder.call(
            async () => Response.json({ error: "invalid_request" }, { status: 400 }),
            request,
          ),
          authorizationEvidence: recorder.authorizationEvidence,
        };
        for (const requested of URIS) {
          for (const expected of [undefined, "invalid_request"]) {
            const [a, b] = await runHostedAuthorizationRegression(validating, [...notEligible(requested, expected)]);
            expect(a).toMatchObject({ status: "failed", error: NOT_CLIENT_ERROR("invalid_request") });
            expect(b).toMatchObject({ status: "failed", error: INDETERMINATE });
          }
        }
        expect(recorder.total).toBe(0);
      });

      it("rejects a non-client code from a response whose evidence shows a client resolution", async () => {
        for (const code of ["invalid_target", "invalid_request"]) {
          for (const reported of [evidence(1, false), undefined]) {
            const target = {
              issuer,
              tokenEndpointAuthMethods: ["none", "client_secret_basic"],
              prepareRegistration: async () => {},
              request: async () => Response.json({ error: code }, { status: 400 }),
              authorizationEvidence: () => reported,
            };
            for (const requested of URIS) {
              for (const expected of [undefined, code]) {
                const [a, b] = await runHostedAuthorizationRegression(target, [...notEligible(requested, expected)]);
                expect(a).toMatchObject({ status: "failed", error: NOT_CLIENT_ERROR(code) });
                expect(b).toMatchObject({ status: "failed", error: INDETERMINATE });
              }
            }
          }
        }
      });

      it("never lets a response without client resolution permit a post-match response", async () => {
        const fixtures = [...notEligible(RUNTIME_PORT)];
        for (const reported of [evidence(0, false), evidence(0, true)]) {
          const unresolved = { tokenEndpointAuthMethods: ["none", "client_secret_basic"], authorizationEvidence: () => reported };
          const page = {
            issuer,
            ...unresolved,
            prepareRegistration: async () => {},
            request: async () => htmlPage("<p><code>access_denied</code></p>")(),
          };
          const callback = { ...callbackTarget(undefined, "access_denied"), ...unresolved };
          // An ineligible registration's page is not an unvetted error page at all.
          for (const [target, ineligibleError] of [
            [page, "Authorization request did not redirect (HTTP 400)"],
            [callback, "Rejected redirect URI must not receive a callback"],
          ] as const) {
            const [a, b] = await runHostedAuthorizationRegression(target, fixtures);
            expect(a).toMatchObject({ status: "failed", error: ineligibleError });
            expect(b).toMatchObject({ status: "failed", error: INDETERMINATE });
          }
          // Neither zero resolutions nor a denial excuses a reflected redirect URI.
          for (const requested of ["HTTP://127.0.0.1:49152/callback", RUNTIME_PORT, LOOPBACK]) {
            const reflecting = notEligible("HTTP://127.0.0.1:49152/callback");
            const results = await runHostedAuthorizationRegression({
              issuer,
              ...unresolved,
              prepareRegistration: async () => {},
              request: async () => Response.json(
                { error: "access_denied", error_description: `Blocked ${requested}` },
                { status: 400 },
              ),
            }, [...reflecting]);
            for (const result of results) {
              expect(result).toMatchObject({
                status: "failed",
                error: "Authorization error response must not reflect the client redirect URI",
              });
            }
          }
        }
      });

      /** Post-match responders for an eligible registration with a runtime port. */
      function postMatchResponders() {
        const eligible = rejectionFixture(DYNAMIC);
        redirect(LOOPBACK, RUNTIME_PORT)(eligible);
        const allowed = createHostedAuthorizationFixtures({ issuer, resource })
          .find((item) => item.id === DYNAMIC)!;
        delete allowed.token;
        redirect(LOOPBACK, RUNTIME_PORT)(allowed);
        const codeCallback = async (request: Request) => {
          const params = new URL(request.url).searchParams;
          const callback = new URL(params.get("redirect_uri")!);
          callback.searchParams.set("code", "test-authorization-code");
          callback.searchParams.set("state", params.get("state")!);
          return new Response(null, { status: 302, headers: { location: callback.toString() } });
        };
        return [
          [eligible, async () => htmlPage("<p><code>invalid_target</code></p>")()],
          [eligible, callbackTarget().request],
          [allowed, codeCallback],
        ] as [McpFnHostedAuthorizationCase, (request: Request) => Promise<Response>][];
      }

      it("never accepts a post-match response whose evidence shows no resolution or a denial", async () => {
        for (const [fixture, respond] of postMatchResponders()) {
          for (const reported of [evidence(0, false), evidence(0, true), evidence(1, false), undefined]) {
            const [result] = await runHostedAuthorizationRegression({
              issuer,
              prepareRegistration: async () => {},
              request: respond,
              authorizationEvidence: () => reported,
            }, [fixture]);
            const permitted = !reported || (reported.clientResolutions > 0 && !reported.preClientResolutionDenial);
            expect(result).toMatchObject(permitted
              ? { status: "passed", phase: "authorization-request" }
              : { status: "failed", error: NO_RESOLUTION });
          }
        }
        // Malformed or contradictory evidence fails every response, whatever
        // the registration's eligibility or the response format.
        const [ineligibleClient] = notEligible(RUNTIME_PORT);
        const mismatched = rejectionFixture(DYNAMIC);
        redirect(LOOPBACK, "https://other.example.com/cb")(mismatched);
        mismatched.expected.errorCode = "invalid_request";
        const malformedEvidence = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]
          .map((clientResolutions) => evidence(clientResolutions, false))
          .concat([evidence(1, true), { clientResolutions: 1, preClientResolutionDenial: "no" } as never]);
        for (const reported of malformedEvidence) {
          const [fixture, respond] = postMatchResponders()[0]!;
          for (const [target, cases] of [
            [{ issuer, prepareRegistration: async () => {}, request: respond }, [fixture]],
            [{
              issuer,
              tokenEndpointAuthMethods: ["none"],
              prepareRegistration: async () => {},
              request: async () => Response.json({ error: "invalid_client" }, { status: 400 }),
            }, [ineligibleClient]],
            [{
              issuer,
              prepareRegistration: async () => {},
              request: async () => Response.json({ error: "invalid_request" }, { status: 400 }),
            }, [mismatched]],
          ] as const) {
            const [result] = await runHostedAuthorizationRegression(
              { ...target, authorizationEvidence: () => reported },
              [...cases],
            );
            expect(result).toMatchObject({
              status: "failed",
              error: expect.stringContaining("Authorization evidence must report clientResolutions"),
            });
          }
        }
        // A denial with no resolution still requires a valid OAuth error code.
        const [ineligible] = notEligible(RUNTIME_PORT);
        const [malformed] = await runHostedAuthorizationRegression({
          issuer,
          authorizationEvidence: () => evidence(0, true),
          prepareRegistration: async () => {},
          request: async () => Response.json({ error: "\n" }, { status: 400 }),
        }, [ineligible]);
        expect(malformed).toMatchObject({ status: "failed", error: NOT_CLIENT_ERROR("\n") });
      });

      it("binds evidence to the attempt whose response a retrying adapter returned", async () => {
        // A discarded attempt that resolved the client, then a returned policy denial.
        const denied = policyTarget("access_denied", (call) => call % 2 === 0);
        for (const requested of URIS) {
          const results = await runHostedAuthorizationRegression(
            denied.retrying(),
            [...notEligible(requested)],
          );
          for (const result of results) {
            expect(result).toMatchObject({ status: "passed", responseStatus: 400, errorCode: "access_denied" });
          }
        }
        expect(denied.recorder.total).toBeGreaterThanOrEqual(2 * URIS.length);
        // A discarded attempt that resolved the client, then a returned
        // post-match response produced without any resolution.
        for (const [fixture, respond] of postMatchResponders()) {
          const resolving = policyTarget("access_denied", () => false);
          const [result] = await runHostedAuthorizationRegression(resolving.retrying(respond), [fixture]);
          expect(result).toMatchObject({ status: "failed", error: NO_RESOLUTION });
          expect(resolving.recorder.total).toBe(1);
        }
        // A discarded policy denial, then a returned eligible page that resolved the client.
        const [fixture] = postMatchResponders()[0]!;
        const deniedFirst = policyTarget("access_denied", (call) => call % 2 === 1);
        const [page] = await runHostedAuthorizationRegression(deniedFirst.retrying(), [fixture]);
        expect(page).toMatchObject({ status: "passed", responseStatus: 400, errorCode: "invalid_target" });
        expect(deniedFirst.recorder.total).toBe(1);
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

    it.each(["", " ", "request"])("accepts a JSON rejection of the blank or malformed redirect URI %j", async (malformed) => {
      const results = await runAgainstMcpFn([DYNAMIC, METADATA_DOCUMENT], undefined, (fixture) => {
        fixture.authorization.redirectUri = malformed;
        fixture.expected.errorCode = "invalid_request";
      });
      for (const result of results) {
        expect(result).toMatchObject({ status: "passed", responseStatus: 400, errorCode: "invalid_request" });
      }
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

    it.each(["", " "])("accepts the request-parsing rejection of the blank client_id %j", async (clientId) => {
      const handler = createMcpAuthorizationCompatibilityHandler({
        issuer,
        clients: { resolve: async () => null },
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
      const fixture = rejectionFixture(DYNAMIC);
      fixture.registration.clientId = clientId;
      fixture.authorization.clientId = clientId;
      delete fixture.expected.errorCode;
      const [result] = await runHostedAuthorizationRegression({
        issuer,
        prepareRegistration: async () => {},
        request: (request) => handler(request),
      }, [fixture]);
      expect(result).toMatchObject({ status: "passed", responseStatus: 400, errorCode: "invalid_request" });
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

    it("requires a client resolution for a client-stage rejection of any named client", async () => {
      const NO_CLIENT_RESOLUTION =
        "A client-stage rejection requires a client resolution, but the response's evidence shows none";
      const named = (id: string, code?: string, adjust: (fixture: ReturnType<typeof rejectionFixture>) => void = () => {}) => {
        const fixture = rejectionFixture(id);
        adjust(fixture);
        if (code) fixture.expected.errorCode = code;
        else delete fixture.expected.errorCode;
        return fixture;
      };
      const unknownClient = (fixture: ReturnType<typeof rejectionFixture>) => {
        fixture.authorization.clientId = "unknown-client";
      };
      const ineligible = (fixture: ReturnType<typeof rejectionFixture>) => {
        fixture.registration.metadata.response_types = ["token"];
      };
      const json = (code: string, reported?: McpFnHostedAuthorizationEvidence) => ({
        issuer,
        prepareRegistration: async () => {},
        request: async () => Response.json({ error: code }, { status: 400 }),
        authorizationEvidence: () => reported,
      });
      const cases = [
        ["an unknown client, expected", "invalid_client", named(DYNAMIC, "invalid_client", unknownClient)],
        ["an unknown client, no expected code", "invalid_client", named(DYNAMIC, undefined, unknownClient)],
        ["an eligible dynamic client", "invalid_client", named(DYNAMIC, "invalid_client")],
        ["an eligible pre-registered client", "invalid_client", named(PRE_REGISTERED, "invalid_client")],
        ["an eligible metadata document", "invalid_client_metadata", named(METADATA_DOCUMENT, "invalid_client_metadata")],
      ] as const;
      const resolved = { clientResolutions: 1, preClientResolutionDenial: false };
      const denied = { clientResolutions: 0, preClientResolutionDenial: true };
      for (const [name, code, fixture] of cases) {
        const [unresolved] = await runHostedAuthorizationRegression(
          json(code, { clientResolutions: 0, preClientResolutionDenial: false }),
          [fixture],
        );
        expect(unresolved, name).toMatchObject({ status: "failed", error: NO_CLIENT_RESOLUTION });
        for (const reported of [resolved, denied, undefined]) {
          const [result] = await runHostedAuthorizationRegression(json(code, reported), [fixture]);
          expect(result, name).toMatchObject({ status: "passed", responseStatus: 400, errorCode: code });
        }
      }
      // A genuine policy denial may also use invalid_client for an ineligible client.
      const [denial] = await runHostedAuthorizationRegression(
        json("invalid_client", denied),
        [named(DYNAMIC, "invalid_client", ineligible)],
      );
      expect(denial).toMatchObject({ status: "passed", responseStatus: 400, errorCode: "invalid_client" });
      // The real handler resolves an unknown client before rejecting it.
      for (const expected of ["invalid_client", undefined]) {
        const [real] = await runAgainstMcpFn([DYNAMIC], undefined, (fixture) => {
          unknownClient(fixture);
          if (expected) fixture.expected.errorCode = expected;
          else delete fixture.expected.errorCode;
        });
        expect(real).toMatchObject({ status: "passed", responseStatus: 400, errorCode: "invalid_client" });
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
