# PHASE_09: Observability, limits, compatibility

## Phase goal

Implement logging rules: MUST log evidence created (evidenceId, controlId, type, outcome; no payload), check run started/completed (checkId, outcome), export requested/completed (frameworkId, size). MUST NOT log full evidence payload or PII/secrets. Enforce and document limits (payload, export, framework requirements). Document schema versioning and compatibility (control/framework/evidence v1; breaking change policy).

## In scope

- Logging in evidence.create, checks.run, export.auditorPack: structured log with allowed fields only; no payload or raw response in log
- Configurable log level or logger injection (optional)
- Limits already enforced in Phase 03 (payload), Phase 06 (export), Phase 02 (framework); verify and document
- COMPAT-001: Document in SPEC or README schema version and stability (v1; additive only; breaking = new version)

## Out of scope

- Metrics/events (optional); log aggregation backend

## Deliverables

- `src/logger.ts` or use passed-in logger from config – log evidence created, check run, export with safe fields only
- Code review or test that no log statement includes full payload or evidence.body
- README or SPEC section: Limits (evidencePayloadMaxBytes, exportMaxBytes, max requirements/controlIds per framework)
- README or SPEC section: Compatibility / versioning (schema v1; additive changes; breaking = new version and deprecation)

## Requirements covered

- OBS-001, LIMIT-001 (verification), COMPAT-001

## Implementation tasks

1. Add logging in evidence.create: after insert, log { event: "evidence.created", evidenceId, controlId, type, outcome } (no payload, no actorId if PII). Use config.logger or console at info level.
2. Add logging in checks.run: start { event: "check.run.started", checkId, controlId }; end { event: "check.run.completed", checkId, outcome } (no adapter response body). On adapter error log { event: "check.run.error", checkId, code: "ADAPTER_ERROR" } (no stack or message with secrets).
3. Add logging in export.auditorPack: { event: "export.requested", frameworkId }; on success { event: "export.completed", frameworkId, sizeBytes } (no evidence content).
4. Audit codebase: no log line contains payload, evidence.payload, or full request body. Add test or manual checklist TV-OBS-001.
5. Document limits in SPEC.md or README: evidencePayloadMaxBytes default 512 KiB; exportMaxBytes default 50 MiB; max 1000 requirements per framework; max 100 controlIds per requirement.
6. Document compatibility: Control/Framework/Evidence schema v1; new optional fields are additive; removing required fields or changing semantics is breaking and requires new version and deprecation period.

## Verification steps

- Run full test suite; no regression.
- Grep or review: no log.*(payload|evidence\.payload|request\.body) in production paths.
- Docs updated; LIMIT-001 and COMPAT-001 acceptance criteria met.

## Stop condition

- Logging rules implemented and verified; limits documented; compatibility policy documented.
