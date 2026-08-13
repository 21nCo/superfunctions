# @cifn/admin

Function-owned Super Console administration for the CiFn control plane.

The manifest exposes only operations implemented by CiFn today:

- runs: list, detail, trigger, retry, and cancellation;
- jobs and steps materialized within a run;
- secret-redacted job logs;
- retained artifact metadata and signed download issuance.

It intentionally does not advertise stored projects, pipeline definitions,
runner management, secret management, schedules, webhooks, job retry/cancel, or
artifact deletion. The current control plane has no corresponding storage and
service APIs.

## Installation

```ts
import {
  createCiFnAdminAdapter,
  createCiFnControlPlaneAdminService,
} from "@cifn/admin";

const adapter = createCiFnAdminAdapter(
  createCiFnControlPlaneAdminService({
    resolveConnection: async (context) => ({
      baseUrl: await controlPlaneUrlFor(context.scope),
      apiKey: await serviceCredentialFor(context.scope),
    }),
  }),
);
```

`resolveConnection` is the tenant boundary. It receives the already authorized
admin context and must resolve only the CiFn installation belonging to that
scope. A single self-hosted installation may instead provide a static
`connection`.

The connector forwards request, correlation, actor, source, scope, and
idempotency metadata as control-plane headers. The control plane API key is a
service credential and is never projected into console responses.

## Typed SDK

`createCiFnAdminClient` exposes named methods with typed domain input/output:
`listRuns`, `getRun`, `listJobs`, `getJob`, `listLogs`, `listArtifacts`,
`triggerRun`, `retryRun`, `cancelRun`, and `downloadArtifact`.

Retry requires the original run to retain a repository pipeline reference.
Inline pipeline runs cannot be reconstructed by the current control plane and
fail with `precondition_failed`. Artifact download requires an HTTPS signed URL
from the configured FileFn adapter; memory-only artifacts fail closed.
