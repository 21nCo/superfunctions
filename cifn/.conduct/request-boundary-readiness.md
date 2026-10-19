# Control-plane request body boundary

2026-10-19 UTC. Isolated `codex/cifn-readiness-sf-next-20261020`, based on shared sf-next prerequisite `d8d443a5c`. This is a bounded request-handling change, not overall CiFn production readiness.

## Behavior

The Node control-plane server previously buffered every incoming body without a cap before dispatching to Hono. It now uses the shared HTTP bounded parser through a streaming Node bridge. A 1,048,576-byte envelope cap returns HTTP 413 / `PAYLOAD_TOO_LARGE` for oversized Content-Length declarations before receiving the payload, and for chunked bodies when the running byte count exceeds the cap. Stream cancellation leaves the response socket available to deliver the error, then closes the rejected connection.

Run creation, runner registration and heartbeat also use shared bounded JSON parsing, including direct Hono consumers. Invalid JSON and non-object JSON return HTTP 400 / `BAD_REQUEST`; `null` heartbeat payloads no longer reach destructuring and throw. Webhooks use the bounded text reader so whitespace and Unicode remain intact for existing signature verification. Health and valid run creation remain functional. Unexpected application errors in the Node transport return a generic HTTP 500 envelope without an unhandled async request rejection.

The transport cap is distinct from the original 500 KB pipeline-document, 100-job, 100-step and other limits, which remain unchanged. It applies before application authentication in the Node transport, as the prior transport buffering did; this slice does not claim authorization-before-body admission. The new transport factory avoids importing startup environment validation during HTTP tests.

The only lockfile change adds the existing shared HTTP 0.3.1 dependency. Shared runtime dependencies are bundled into CJS/ESM outputs to keep their ESM-only entrypoints from breaking CJS consumers. No shared package source was changed.

## Validation

Node 20.20.0 / npm 10.8.2:

```sh
npm ci --ignore-scripts --workspace=./cifn/typescript/control-plane --workspace=@superfunctions/http --workspace=@superfunctions/observability --workspace=@superfunctions/webhooks --workspace=@superfunctions/queue --workspace=@superfunctions/envelope --workspace=@superfunctions/errors --include-workspace-root=false --no-audit --no-fund
npm run build --workspace=@superfunctions/observability --workspace=@superfunctions/http --workspace=@superfunctions/webhooks --workspace=@superfunctions/queue --workspace=@superfunctions/envelope --workspace=@superfunctions/errors
npm test --workspace=./cifn/typescript/control-plane
npm run lint --workspace=./cifn/typescript/control-plane
node node_modules/typescript/bin/tsc -p cifn/typescript/control-plane/tsconfig.boundary.json
npm run build --workspace=./cifn/typescript/control-plane
```

- Clean selected-workspace npm installation passed without peer bypass flags (241 packages). Unrelated registered DevFn engines produce Node >=22 warnings during resolution.
- Full control-plane suite: 152 tests passed. Nine new live HTTP/route cases cover declared size before body delivery, chunked overflow, exact UTF-8 byte boundary, malformed/non-object bodies on all three JSON endpoints, valid run creation, runner registration/heartbeat, health, webhook signatures, direct-Hono limits and contained application errors.
- Package lint/typecheck passes. Boundary tests and their imported source pass strict TypeScript with `skipLibCheck: false` under Bundler resolution and DOM libraries for shared HTTP web-platform types.
- ESM/CJS/declaration builds pass; built CJS library loads and exposes createApp. No full packed-consumer matrix is claimed.
- Python SDK source was checked: unknown server codes already fall back to `CiFnError`, preserving code and HTTP status. It will surface the new 413 envelope through that fallback; no Python SDK execution or typed error subclass coverage is claimed.

## Original requirements still open

`createApp` still defaults to `MemoryStore`, and its store option remains memory-store shaped. This slice adds no durable run/job/step persistence, restart recovery, multi-controller coordination, outbox, notification retries, or deduplication. Default notifications remain `MemorySendFnClient`; the email implementation is still a placeholder that logs success, and the run-status hook does not establish durable delivery or handle false delivery outcomes as retries. Original live queue/artifact/secret/log integrations, runner/executor acceptance, Python SDK readiness, durable performance/recovery requirements and deployment gates remain open. No deployment, push or PR was performed.
