# HTTP response caching

Express, Hono and Fastify bindings cache successful GET responses with their status and end-to-end headers. Express intercepts JSON responses and preserves their serialized wire representation; Hono supports binary and text responses; Fastify handles serialized string, Buffer and null payloads. Cache lookup/write failures fall through to the origin response. Handler failures propagate normally.

Keys use a separate HTTP prefix, host, URL (Express uses originalUrl), and normalized request headers specified in `vary`. Supply `vary: ['accept-language']`, for example, whenever representation depends on that header. Responses declaring unconfigured `Vary` fields or `Vary: *` are not cached. A custom key intentionally chooses the resource identity; it must include every application-specific representation dimension not covered by `vary`.

Authorization, cookies, conditional requests and range requests bypass shared caching. Responses with Set-Cookie, private/no-store/no-cache directives, errors or partial content are not stored. Origin-managed freshness (`max-age`, `s-maxage`, Expires or Age) currently bypasses storage so an application TTL cannot extend an origin lifetime. Public responses without those headers use the configured cache TTL. Cache-Control request bypass directives are respected.

Install caching after authentication/authorization hooks. Credential-less authorization or personalization using session state outside request headers requires `condition` to disable caching; the middleware cannot infer application permissions. Fastify lookup runs at preHandler; authentication must precede it. `condition` gates both lookup and storage. Cache hits do not refresh entry TTL.

Hono skips event streams and bounds buffered bodies to 1 MiB and one second; larger or slow streams continue to the client without being cached. Fastify streams are not cached. Express streaming/send responses are outside its JSON interceptor. Hop-by-hop headers, Content-Length and Date are not replayed.

These bindings implement cache interception at framework response lifecycle hooks, not alternate routing or database abstractions. They share one framework-neutral response-cache policy. Consumers continue to use `@superfunctions/http-*` directly for shared HTTP routing adapters; these bindings do not reexport those adapters.

Validation: 25 focused policy/lifecycle regression tests pass, covering falsy JSON bodies, status/headers, binary responses, auth/cookie/conditional/range bypass, unsafe response directives, Vary keys, failed cache operations and Fastify method/condition symmetry. Actual framework acceptance passes through Express 4.21.2 HTTP listen/fetch, Hono 4.11.9 request dispatch and Fastify 5.6.1 injection. These verify serialized response preservation, status/header replay, case-normalized Vary partitioning, and auth/cookie bypass. Integrated package type checking, including compiler-checked memoization consumer fixtures, now passes.

Acceptance runs as part of `npm test --workspace cachefn/typescript`. Express, Fastify and Hono are pinned development dependencies and included in the workspace lockfile. A broader middleware-ordering, streaming and real proxy/compression matrix remains acceptance work. This document does not claim production readiness.
