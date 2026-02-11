# Phase 06 — Real integrations (flowfn/filefn/secfn/logfn) via adapters

## Phase goal (1 sentence)

Replace “memory-only” integrations with a **configurable adapter layer** that supports both memory (tests/dev) and real superfunctions-backed implementations for production.

## In scope

- Define adapter interfaces and configuration for:
  - flowfn queue
  - filefn artifacts (and optionally cache)
  - secfn secrets/token validation
  - logfn event emission + job log storage
- Provide:
  - memory adapters (keep existing behavior for tests)
  - at least one “real” adapter implementation per integration (using superfunctions packages and/or HTTP APIs)
- Ensure the control plane uses adapters everywhere (no hard-coded Memory* clients).

## Out of scope

- testfn SDK migration (Phase 07) aside from wiring required dependencies.
- Deploy artifacts (Phase 10).

## Deliverables (explicit list of files/modules)

- Create:
  - `cifn/typescript/control-plane/src/integrations/types.ts`
  - `cifn/typescript/control-plane/src/integrations/config.ts`
  - `cifn/typescript/control-plane/src/integrations/flowfn.ts`
  - `cifn/typescript/control-plane/src/integrations/filefn.ts`
  - `cifn/typescript/control-plane/src/integrations/secfn.ts`
  - `cifn/typescript/control-plane/src/integrations/logfn.ts`
- Modify:
  - `cifn/typescript/control-plane/src/queue/flowfn-client.ts`
  - `cifn/typescript/control-plane/src/filefn/memory-filefn.ts` (either move under adapters or keep as memory adapter)
  - `cifn/typescript/control-plane/src/secrets/secfn-client.ts`
  - `cifn/typescript/control-plane/src/api/routes.ts`
  - `cifn/typescript/control-plane/src/index.ts`
  - `cifn/typescript/control-plane/src/queue/queue.test.ts`
  - `cifn/typescript/control-plane/src/api/api.test.ts`

## Requirements covered

- INT-001
- INT-002
- INT-003
- INT-004
- OBS-001

## Implementation tasks (ordered checklist)

- [ ] Define adapter interfaces:
  - [ ] Queue: enqueue, dequeue/claim, ack/fail, visibility timeout (minimal v1 subset).
  - [ ] Artifacts: upload, download, list, signed URL.
  - [ ] Secrets: getSecret, validateToken, listApiKeys (as needed).
  - [ ] Logs: emitEvent, appendJobLogLine(s), readJobLogs.
- [ ] Implement memory adapters:
  - [ ] Wrap existing MemoryQueue/MemoryFileFn/MemorySecFn/MemoryLogFn logic behind interfaces.
- [ ] Implement “real” adapters:
  - [ ] flowfn: use `@flowfn/core` adapter(s) or HTTP integration.
  - [ ] filefn: use filefn server HTTP API to store artifacts and produce signed URLs.
  - [ ] secfn: use `@secfn/core` vault or a secfn service client (implementation-defined).
  - [ ] logfn: use `logfn` library sinks (e.g. HTTP sink) and durable storage for job logs.
- [ ] Add configuration:
  - [ ] Document required env vars (base URLs, tokens, adapter type selection).
  - [ ] Fail fast on missing required config for chosen adapter.
- [ ] Ensure tests can run using memory adapters by default.
- [ ] Add at least one contract/integration test per adapter interface (TV-INT-001..004) using memory adapters; “real” adapter tests may be smoke/manual if external services are required.

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/control-plane test`
- Expected:
  - All tests pass under memory adapters.
  - Adapter selection is configurable and validated.

## Stop condition (what to report back before starting the next phase)

Report:

- The final adapter interfaces and configuration surface (env vars / config file).
- Evidence that the control-plane test suite is green using memory adapters.

