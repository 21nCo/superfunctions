# Release Gate - audit-fix-o4u9k2m7

## Package Checklist

1. `authfn`: shared OAuth orchestration import present.
   Command: `rg -n "@superfunctions/oauth-flow" authfn/ts-sdk/src/social-oauth`
2. `plugfn`: shared oauth-flow adoption and deprecation shim warning present.
   Command: `rg -n "@superfunctions/oauth-flow|DEPRECATED_PATH|removal in plugfn@0.2.0" plugfn/typescript/src/core/connection-manager.ts plugfn/typescript/src/auth/oauth-flow.ts`
3. `recfn`: shared oauth/webhooks/envelope/errors/queue/config/metrics imports present.
   Command: `rg -n "@superfunctions/oauth-flow|@superfunctions/webhooks|@superfunctions/envelope|@superfunctions/errors|@superfunctions/queue|@superfunctions/config|@superfunctions/metrics" recfn/server/src`
4. `cifn`: shared webhooks/envelope/errors/queue imports present.
   Command: `rg -n "@superfunctions/webhooks|@superfunctions/envelope|@superfunctions/errors|@superfunctions/queue" cifn/typescript/control-plane/src`
5. `searchfn`: canonical adapter-source policy check passes.
   Command: `node scripts/check-searchfn-adapter-canonical.mjs`
6. `packages/storage*`: S3-compatible shared internal import present for s3/r2/minio.
   Command: `rg -n "@superfunctions/storage/internal/s3-compatible" packages/storage-s3/src/adapter.ts packages/storage-r2/src/adapter.ts packages/storage-minio/src/adapter.ts`

## Docs and Quality Checks

1. Build docs: `npm -w docs run build`
2. Shared package coverage: `npm -w docs run check:coverage`
3. Snippet import validation: `npm -w docs run check:snippets`
4. Link validation: `npm -w docs run check:links`

## Final Gate Command

Run: `npm run gate:audit-fix-o4u9k2m7`

The gate blocks completion when any package checklist item fails, docs checks fail, changelog/deprecation requirements are missing, or the gate document itself is missing.
