# HTTP response correlation checkpoint

The original middleware requirement in `spec.md` calls for IDs on requests/responses and the request logger. Express, Fastify, Hono and the shared HTTP middleware now emit `x-request-id`, `x-trace-id` and `x-span-id` from their existing validated correlation extraction. Valid W3C input retains trace/span IDs, request IDs are generated locally, and invalid input is never reflected as a correlation response header. No synthetic W3C sampling flags, user identity or tenant identity are emitted.

Automatic log sampling does not suppress headers. The IDs match the request logger before any caller-supplied pipeline transformation. Fastify retains native `request.log` and uses `request.logfn`. Express/Fastify set reserved headers before handlers; callers must not overwrite them. Hono/shared annotate returned responses, including framework-handled errors. Fetch responses copy headers and retain the body stream without buffering, including immutable redirect responses and repeated cookies. Opaque/network-error status-zero sentinels remain unchanged. Errors escaping the middleware cannot annotate a response created later by an external host. The host owns CORS expose-headers configuration and nonstandard response extensions (such as upgrade transports); this checkpoint tests standard HTTP Fetch responses.

Validation:

- Focused real framework/shared middleware matrix: 35 tests passed initially.
- Full TypeScript suite: 264 tests / 25 files passed, single worker.
- Final dedicated correlation suite: 18 passed after adding all-adapter invalid-input and streamed-body/cookie cases.
- Typecheck and build passed.
- Fresh three-tarball installed HTTP consumer: Node18.18.0, Node20.19.0 and Node22.23.4 passed actual response/header/event identity assertions. Strict Node16/NodeNext declarations passed; production dependency audit reported zero vulnerabilities. Orchestrated with Node22/npm11 normal installation; temporary consumer removed in finally.

The tests exercise success and handled503 responses with automatic sampling both enabled and disabled; all emitted event IDs match response headers. Native Express uses an owned loopback server; Fastify inject, Hono request and shared router run their real framework response paths. Owned servers close in finally. Source tests/build use Node20.20.0. Python has an ID-enrichment pipeline but no equivalent HTTP middleware in the current package; no Python parity claim is made. This is a scoped middleware checkpoint, not full LogFn readiness or deployment evidence.
