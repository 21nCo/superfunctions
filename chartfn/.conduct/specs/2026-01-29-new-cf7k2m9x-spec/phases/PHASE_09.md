# PHASE_09: Observability and versioning

## Phase goal

Document and enforce logging rules (no full series data in production); document ChartSpec version and adapter interface stability (versioning strategy).

## In scope

- Logging: implementation MUST NOT log full data.series in production; MAY log adapter name, spec type, error code/path at debug level
- Add debug logging (optional, configurable) for adapter registration and render (adapter name, spec type)
- Documentation: ChartSpec v1 stability; adapter interface additive-only; Semver for package
- Tests: TV-OBS-001 (manual or automated: assert no log line contains full series in production config)
- REQUIREMENTS: OBS-001, COMPAT-001

## Out of scope

- New features; framework bindings

## Deliverables

- `src/logger.ts` or config: logger that redacts or omits data.series in production; in debug, log adapter name and spec type
- SPEC.md or README: "Observability" section (what MUST/MUST NOT log); "Compatibility / versioning" section (ChartSpec v1, adapter additive, Semver)
- Test or audit: TV-OBS-001 (ensure no full series in logs when production config)
- Tracker/logs update when phase complete

## Requirements covered

- OBS-001, COMPAT-001

## Implementation tasks

1. Introduce logger (or use existing): in production mode, never log spec.data.series; in debug, allow logging adapter name, spec.type, error.code, error.details.path.
2. Use logger in chartFn: on registerAdapter log adapter name (debug); on render log adapter name and spec.type (debug); on error log code and path only, not full spec.
3. Update SPEC.md or README: Observability (MUST NOT log full series; MAY log adapter, type, code, path at debug); Compatibility (ChartSpec v1 stable; breaking changes require version field; adapter interface additive; Semver).
4. Add test or manual check: run render with production config, capture logs, assert no line includes full series array (TV-OBS-001).
5. Finalize INTENT_AUDIT.md if not already complete; ensure "No missing intent items" stated.

## Verification steps

- Run full test suite; all phases pass.
- Manual: production config, render chart, inspect logs → no data.series in log output.
- Docs: SPEC or README contains Observability and Versioning sections.

## Stop condition

- OBS-001 and COMPAT-001 satisfied; INTENT_AUDIT.md complete; all phases verified; ready for completion report.
