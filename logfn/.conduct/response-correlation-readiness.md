# HTTP response correlation checkpoint

The original middleware requirement in `spec.md` calls for IDs on requests/responses and the request logger. Express, Fastify, Hono and the shared HTTP middleware now emit `x-request-id`, `x-trace-id` and `x-span-id` from their existing validated correlation extraction. Valid W3C input retains trace/span IDs, request IDs are generated locally, and invalid input is never reflected as a correlation response header. No synthetic W3C sampling flags, user identity or tenant identity are emitted.

Automatic log sampling does not suppress headers. The IDs match the request logger before any caller-supplied pipeline transformation. Fastify retains native `request.log` and uses `request.logfn`. Express/Fastify set reserved headers before handlers; callers must not overwrite them. Hono/shared annotate returned responses, including framework-handled errors. Fetch responses copy headers and retain the body stream without buffering, including immutable redirect responses and repeated cookies. Opaque/network-error status-zero sentinels remain unchanged. Errors escaping the middleware cannot annotate a response created later by an external host. The host owns CORS expose-headers configuration. The follow-up below covers Cloudflare WebSocket upgrade responses in the native local Workers runtime.

Validation:

- Focused real framework/shared middleware matrix: 35 tests passed initially.
- Full TypeScript suite: 264 tests / 25 files passed, single worker.
- Final dedicated correlation suite: 18 passed after adding all-adapter invalid-input and streamed-body/cookie cases.
- Typecheck and build passed.
- Fresh three-tarball installed HTTP consumer: Node18.18.0, Node20.19.0 and Node22.23.4 passed actual response/header/event identity assertions. Strict Node16/NodeNext declarations passed; production dependency audit reported zero vulnerabilities. Orchestrated with Node22/npm11 normal installation; temporary consumer removed in finally.

The tests exercise success and handled503 responses with automatic sampling both enabled and disabled; all emitted event IDs match response headers. Native Express uses an owned loopback server; Fastify inject, Hono request and shared router run their real framework response paths. Owned servers close in finally. Source tests/build use Node20.20.0. Python has an ID-enrichment pipeline but no equivalent HTTP middleware in the current package; no Python parity claim is made. This is a scoped middleware checkpoint, not full LogFn readiness or deployment evidence.

## WebSocket upgrade correction

A native local workerd fixture reproduced HTTP500 instead of101 on a real Hono `upgradeWebSocket` route: reconstructing only status/statusText/headers omitted Cloudflare's required `webSocket` handle. The helper now constructs `new Response(response.body, response)` before setting correlation headers, preserving the runtime's complete Response initializer. This is also the copying pattern used by the installed Hono Context response setter.

References: [Cloudflare Response contract](https://developers.cloudflare.com/workers/runtime-apis/response/), [WebSocket upgrade contract](https://developers.cloudflare.com/workers/examples/websockets/). No replacement sampling flags or WebSocket wrapping are introduced.

Reproduce with Node22 and an existing Miniflare installation:

```sh
LOGFN_MINIFLARE=/absolute/path/to/miniflare node logfn/scripts/workerd-response-acceptance.mjs
```

The script bundles actual LogFn/Hono/shared-router code and runs a local workerd runtime. It does not download a runtime or deploy a Worker. Miniflare5's explicit v4-options conversion is supported alongside Miniflare4. Validation used Miniflare5.20261019.2-beta/workerd1.20261019.1, Node22.22.0, compatibility date2026-10-23. Both actual Hono and shared-router upgrade routes return101, retain a WebSocket, echo an owned message, and match correlation headers to both request/completion events. Sockets close and Miniflare disposes in finally. No external URL/provider was contacted.

The original regression is retained in `/tmp/log-response-workerd-baseline.log`; final native pass is in `/tmp/log-response-workerd-final.log`. Standard HTTP focused36 tests, typecheck and build also pass after the correction, including immutable redirects, streamed bodies and repeated cookies. This proves the local runtime upgrade contract, not hosted Cloudflare deployment or every runtime-specific Response extension.
