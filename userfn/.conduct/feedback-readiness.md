# UserFn feedback acceptance boundary — 2026-10-19

Branch `codex/userfn-readiness-sf-next-20261020` starts at shared prerequisite `d8d443a5c`. The tree was new and clean. Local remote-tracking trees contain UserFn in sf-next/next and not origin/dev; publication belongs in sf-next. No remote action was performed.

## Original requirement and bounded implementation

The unchanged specification requires a dedicated UserFn configuration/data service using shared HTTP and DB packages (architecture lines 25–28, storage lines 106–114), feedback CRUD/voting and multi-source ingestion, and separate WatchFn analytics. The tracked UserFn tree has no service implementation or typed HTTP feedback client. Building that backend is still required.

The TypeScript feedback engine previously logged the submission and resolved successfully, and board lookup returned an unconditional empty list. Python exposed feedback dataclasses but no submission API. This slice removes false success and adds a temporary injected service contract, without duplicating HTTP/DB storage abstractions or claiming to implement them:

- TypeScript `feedbackService.submit(submission, context)` and Python `feedback_service.submit(submission, context)` are awaited. Context contains source `in_app` and current identity; reset produces null/None.
- Acceptance requires a nonempty identifier and `accepted: true`. Missing configuration, invalid input, absent/negative receipts and service failures reject. Existing TypeScript `submitFeedback(): Promise<void>` and widget await semantics are preserved. Python adds async `submit_feedback` and package exports.
- The feedback engine no longer logs submission content. Board reads explicitly report that the board service is unimplemented.
- Existing Python option positional order is preserved; the new service field is appended.

A supplied service must return acceptance only after its backing service accepts the submission. The SDK cannot verify a fabricated receipt. Endpoint/API-key options alone do not configure delivery. This boundary is compatibility progress, not proof of persistence or completed feedback delivery.

## Validation

- npm 10.8.2 / Node 20.20.0: scoped clean install with ignored lifecycle scripts completed (342 packages); no package manifest or lock changes.
- `npm run build -w userfn/typescript`: ESM, CommonJS and declarations pass.
- `npm run typecheck -w userfn/typescript`: passes.
- `npm test -w userfn/typescript`: **23 tests across 6 files pass**, including 7 feedback cases.
- `uv run --isolated --no-project --python 3.10 --with pytest python -m pytest userfn/python/tests -q`: **17 tests pass**, including 7 feedback cases.
- Tests cover deferred acceptance (no early completion), exact payload/context forwarding, identity reset, storage failure propagation, missing configuration, invalid receipts and validation before invoking the service. Test services are controlled doubles, not real persistence providers.
- Built ESM and CommonJS imports separately verify exported error and configured/unconfigured submission behavior. This is a built-output check, not fresh npm tarball installation.
- `git diff --check` passes. No changes outside UserFn.

## Remaining gates

Dedicated shared HTTP/DB service and internally owned schemas; real authentication/tenancy and persistence; idempotency, retries/offline delivery; feedback board/voting/status and external-source ingestion; privacy/moderation/rate limits; screenshots/annotation; deployed or live transport acceptance; packaged Python consumer and Python 3.9 validation. Existing flag/bootstrap, analytics, survey delivery, roadmap/changelog and UI accessibility requirements also remain open. No browser widget acceptance was run in this slice. No push, PR, release, or deployment occurred.

## Subsequent dedicated-service checkpoint

The 2026-10-20 [feedback service checkpoint](feedback-service-readiness.md) implements shared HTTP/DB submission/readback and both SDK HTTP transports with local SQLite reopen acceptance. The original observations above describe the earlier bounded change; the new checkpoint supersedes the missing-feedback-backend finding while retaining the broader product and deployment gates.
