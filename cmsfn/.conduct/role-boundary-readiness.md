# Role endpoint authorization and body boundary

2026-10-19 UTC. Isolated branch `codex/cmsfn-readiness-sf-next-20261020`, based on shared sf-next readiness commit `9b841ff4abe4ff458acee42630114e5cb821e52e`. This is a bounded role-management change, not a CmsFn production-readiness claim.

## Behavior

All three role endpoints require `authorizeRoles` to resolve to literal `true` before attaching a request-body reader. Missing callbacks, false/truthy non-boolean values, and thrown/rejected authorization return `PERMISSION_DENIED` without disclosing callback errors. Existing applications must configure this callback to retain role-management access; it must perform their actual authentication and authorization checks.

Authorized bodies use `@superfunctions/http`'s bounded JSON parser, capped at 65,536 UTF-8 bytes. Oversized declared or streamed bodies return `PAYLOAD_TOO_LARGE`; malformed JSON and non-object JSON return `VALIDATION_FAILED`. The Node stream bridge cancels iteration without destroying the socket, permitting the error envelope to reach the client. Existing HTTP-200 envelope transport remains unchanged. This limit covers role requests, independently of the specification's content-upload limit.

Core/server are registered as npm workspaces. Server shared dependencies match the existing DB 0.4.0 and HTTP 0.3.1 stack. The lockfile changes contain only this workspace closure. Shared ESM implementations are bundled into the relevant CJS outputs so Node 18.18 can load them; the prior core output failed with `ERR_REQUIRE_ESM` for the errors package.

## Validation

Node 20.20.0 / npm 10.8.2:

```sh
npm ci --ignore-scripts --workspace=./cmsfn/core --workspace=./cmsfn/server --workspace=@superfunctions/http --workspace=@superfunctions/db --workspace=@superfunctions/observability --workspace=@superfunctions/envelope --workspace=@superfunctions/errors --include-workspace-root=false --no-audit --no-fund
npm run build --workspace=@superfunctions/observability --workspace=@superfunctions/envelope --workspace=@superfunctions/errors --workspace=@superfunctions/http --workspace=@superfunctions/db
npm run build --workspace=./cmsfn/core --workspace=./cmsfn/server
npm test --workspace=./cmsfn/core --workspace=./cmsfn/server
node node_modules/typescript/bin/tsc -p cmsfn/server/tsconfig.roles.json
npm run typecheck --workspace=./cmsfn/core
```

- Installation succeeded without peer bypass flags; shared closure and core/server ESM, CJS, and declaration builds passed. Unrelated registered DevFn packages produce Node >=22 engine warnings during npm resolution.
- Full core suite: 24 passed. Full server suite: 56 passed.
- Focused role suite: 29 passed on both Node 20.20.0 and declared minimum Node 18.18.0. Includes delayed authorization, all three endpoints' denial cases, declared-size rejection before reading, streamed size enforcement, exact byte boundary, multibyte overflow, malformed/non-object bodies, and live sockets with Content-Length and chunked uploads.
- Scoped strict TypeScript check passes with `skipLibCheck: false`. Its DOM libraries satisfy shared HTTP's web-platform declarations and Vitest's Worker type. This scoped config does not replace the full package check.
- Built core/server CJS require and server ESM import smoke checks passed on Node 18.18.0.
- Full server typecheck remains failing: 145 diagnostics. A temporary copy of committed baseline server sources, using the same installed dependencies and built core declarations, produced the exact same normalized diagnostics. Examples include `Response.json()` unknown types, missing `@contentfn/core` declarations, error-code widening, and missing `CmsfnReleasePublishResult`. Temporary baseline files were removed. No full typecheck pass is claimed.
- A broad `--workspace=cmsfn` selector also selects the existing admin package by directory; its build requires ContentFn packages and fails in this bounded installation. Use the exact core/server workspace paths above.

## Original scope still open

This does not establish schema ownership or real database adapter compatibility, comprehensive role-rule validation, protection/body limits for other HTTP endpoints, audit identity completeness, release scheduling, ContentFn live integration, studio editing/preview/media workflows, or a packed-consumer declaration matrix. Existing role/release storage still needs the function-owned schema wrapper. CmsFn has no Python implementation in this tree. The original SPEC/PLAN requirements remain open. No remote changes, deployment, or PR were made.
