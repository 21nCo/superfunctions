---
title: Deployment
description: Run McpFn over HTTP on Node or Cloudflare Workers and keep the transport boundary secure.
---

Serve HTTP with `createWebStandardHandler()` and mount the resulting Web Standard handler in your application's router. The official SDK owns Streamable HTTP and protocol behavior. Wrap protected endpoints with `createOAuthResourceServerHandler()` and derive trusted context from verified request metadata. See [authorization](/docs/authorization) for the resource-server boundary.

## Stateless and sessionful HTTP

Stateless mode creates and disposes an isolated SDK server and transport for every request. For server-initiated operations that must correlate across requests, provide a cryptographically secure `sessionIdGenerator` and retain the session transport. A `configureRequestServer` hook runs before the transport connection and can attach protocol instrumentation; a rejected initialization can invoke it without retaining a session.

Initialization metadata is available only to sessionful client-profile hooks. Stateless profiles must be marked `requiresReportedClient: false` and depend on verified identity and request context. Keep a separate runtime instance per connection while sharing a registry or declaration.

## Local servers and HTTP sessions

A Streamable HTTP server on `127.0.0.1` or `localhost` is reachable from any web page through DNS rebinding: the page's own host name resolves to the loopback address, so the browser treats the request as same-origin. `createWebStandardHandler()` refuses requests whose `Origin` header is not listed in `allowedOrigins` (a loopback origin equal to the request's `Host` is accepted), which covers browser requests that carry `Origin`. Browsers can omit `Origin` on a same-origin GET, so also check `Host` in front of the handler and accept only the names the server listens on, or pass `enableDnsRebindingProtection: true` with `allowedHosts` (and `allowedOrigins`) so the SDK transport does both checks. Cap request bodies before building the Web `Request`. `examples/calculator-http-server.ts` does all three.

Sessionful handlers bind each session to the principal that created it and answer 404 to a request from anyone else, so a leaked `mcp-session-id` is not enough to read another user's event stream or end their session. By default the principal is the subject (`authInfo.extra.subject`) and client ID of the request's `authInfo`, or the access token itself when the verifier sets no subject (a refreshed token then needs a new session); supply `sessionPrincipal` to derive it from other trusted request data (never the body). Authenticate `initialize` so anonymous callers cannot create sessions.

## Cloudflare Workers

`@mcpfn/core` and `@mcpfn/auth` ship self-contained SDK bundles. Enable Cloudflare's `nodejs_compat` flag because the SDK uses Node built-ins such as `node:crypto`. Serve the Web Standard handler from the Worker. To call remote MCP servers from a Worker, import the remote-only `@mcpfn/client` main entry; it does not need `nodejs_compat`. Do not import `@mcpfn/client/stdio` or the Node-oriented CLI, testing, or inspector packages into the edge bundle.

Schema validation uses Ajv draft-07 on Node and `@cfworker/json-schema` in runtimes that forbid runtime code generation. The repository's `cloudflare:worker-startup` release-gate step boots this shape under `workerd` with a protected request. For the exact compatibility and bundling policy, see the [core reference](/docs/reference/core) and [architecture](/docs/reference/architecture).
