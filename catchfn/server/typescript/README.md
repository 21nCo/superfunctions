# @catchfn/server

Validated bug-report storage and shared HTTP routes. The service wraps the incoming
`@superfunctions/db` adapter with its own schema; callers do not supply adapterSchema.
Create the physical tables using `getCatchFnSchema()` and your migration system before
serving requests.

```typescript
import { createCatchFnServer } from "@catchfn/server";

const { service, router } = createCatchFnServer({
  db, // application-owned shared database adapter
  app: "my-app", // authenticated application scope
  retentionDays: 30,
  http: { authorize: request => authenticate(request) },
});
// Mount router using your @superfunctions/http-* adapter.
await service.cleanup(); // schedule retention cleanup in your application
```

Routes: `POST /bugs`, `GET /bugs/:id`, and `GET /bugs`. Lists accept `limit` (1–200),
`offset`, app, severity, repeated `tag`, from/to timestamps in milliseconds, sessionId,
replayId and issueId. Stored payloads preserve nested JSON. Duplicate identifiers are
idempotent for identical content and conflict for different content. Retention uses
server receipt time. Authentication is application-provided; bind `app` from trusted
configuration rather than request data.

The current HTTP service accepts the SDK's flat `BugReportEvent`. Canonical WatchFn
ingestion/shared datastore integration and BotFn issue creation remain outstanding;
see `../../.conduct/readiness.md`. Attachment upload is application-owned and is not
implemented by this package.
