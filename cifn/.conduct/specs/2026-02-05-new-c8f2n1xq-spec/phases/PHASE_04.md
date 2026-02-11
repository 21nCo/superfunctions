# Phase 04: Triggers and checkout step

## Phase goal
Implement trigger handlers: webhook (verify signature and create run), cron (flowfn scheduler), and workflow_dispatch (API body); and implement checkout step (clone repo at ref into workspace).

## In scope
- Webhook endpoint: POST /webhooks/github (or /webhooks/:provider); verify signature (HMAC or plugfn); parse payload for ref, repo; create run with pipelineRef from payload and trigger type push or pull_request.
- Cron: flowfn scheduler or cron process that triggers runs for pipelines with on.schedule; create run with trigger type schedule.
- workflow_dispatch: already in POST /runs body; ensure pipelineRef.repo, ref, configPath and trigger.type supported.
- Checkout step: clone repository at ref into workspace; use git clone with token from secfn or plugfn when private; workspace = clone root for subsequent steps.

## Out of scope
- Expression evaluation for if (can stub: always true); full plugfn OAuth (stub or env token); artifact/cache steps.

## Deliverables
- `cifn/typescript/control-plane/src/triggers/webhook.ts` (verify + create run).
- `cifn/typescript/control-plane/src/triggers/cron.ts` (schedule from flowfn or node-cron).
- `cifn/typescript/runner/src/steps/checkout.ts` (git clone; optional plugfn for token).
- Tests: webhook with valid/invalid signature; checkout step populates workspace.

## Requirements covered
- PIPE-004, INT-005, RUN-007, SEC-002.

## Implementation tasks
1. Webhook route: POST /webhooks/github; read X-Hub-Signature-256 or provider-specific header; verify HMAC with secret from secfn or env; parse body for repository.full_name, ref (e.g. refs/heads/main); build pipelineRef { repo, ref }; call createRun with trigger { type: 'webhook', payload: body }; return 200 or 401/403.
2. Cron: load pipelines that have on.schedule; for each cron expression, register with flowfn scheduler or setInterval; on tick, create run with trigger { type: 'schedule' } and pipelineRef from config.
3. Checkout step in runner: resolve repo and ref from run context (pipelineRef or trigger payload); clone into workspace (e.g. git clone --depth 1 -b <branch> <url> <workspace>); credentials from env (injected by control plane from secfn) or plugfn.
4. Runner executor: when step uses checkout, call checkout step with repo, ref, workspace path.
5. Tests: TV-SEC-004 (unverified webhook does not create run); TV-INT-005 (checkout at ref); create run via webhook with valid signature and assert run created.

## Verification steps
- Send POST to webhook with invalid signature → 401 or 403; no run created.
- Send POST with valid signature and payload { repository: { clone_url }, ref } → 201 or 200; run created with pipelineRef.
- Run with job that has checkout step and then run: pwd → workspace is repo root; TV-INT-005 pass.
- Run tests: `npm test` for triggers and checkout.

## Stop condition
- Webhook verification and run creation work; cron triggers runs (or stub); checkout step clones repo at ref. Report: "Phase 04 complete; triggers and checkout ready for Phase 05 (artifacts, cache)."
