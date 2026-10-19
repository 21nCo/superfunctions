# TypeScript trace propagation checkpoint

Queue jobs, stream headers, workflow checkpoints and durable schedule definitions
persist the producer's bounded W3C traceparent/tracestate fields. Consumer handlers
extract against an empty root context so absent, malformed, zero-ID or oversized
parents cannot inherit an unrelated worker span. Baggage is not captured.
Workflow public records continue to omit internal trace metadata.

Hosts configure their OpenTelemetry context manager and W3C propagator. FlowFn
uses the application's API registration and does not install global providers,
exporters or propagators. Disabled telemetry does not capture context.

## Local checks

Node 20.20.0, Vitest 4.1.12:

- Focused instrumentation suite: 6 passed.
- Full core suite: 157 passed, 59 native-provider cases skipped.
- Admin suite: 15 passed.
- Source and test TypeScript checks passed.
- CJS, ESM and declarations built successfully.
- Persisted workflow/message metadata, queued-job context and actual handler
  spans are checked; consumer execution includes unrelated ambient worker context.

Initial checks failed because local dependency links targeted a deleted temporary
installation. An isolated dependency set restored OpenTelemetry, Drizzle and UUID;
Drizzle's isolated package also needed access to the existing pg package. The
final checks above passed after resolving these installation failures. This is
not a clean-lock installation proof: preexisting root manifest/lock changes were
preserved, and the new core development dependency still needs target lock
reconciliation during sf-next delivery.

Docker's configured socket is unavailable. No native provider fixture was
created; this checkpoint does not prove Redis/PostgreSQL trace transport, restart
or cross-process recovery. Original native/cloud provider, partition, persisted
policy, workload throughput/latency, packed consumer and deployment gates remain.
