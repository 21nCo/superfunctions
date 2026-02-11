# PHASE_11: Ops import/export triggers

## Phase goal

Implement operational endpoints to trigger ContentFn dataset export/import with strict dataset isolation and deterministic responses.

## In scope

- Server endpoints:
  - `POST /cmsfn/ops/export`
  - `POST /cmsfn/ops/import`
- Permission enforcement:
  - require `audit.read` and/or a dedicated ops permission (documented; deterministic)
- Dataset isolation checks
- Studio UI triggers (minimal)

## Out of scope

- Background job queue UI (unless required by deployment scale; otherwise synchronous is acceptable)

## Deliverables

- `cmsfn/server/src/http/ops.ts`
- `cmsfn/server/src/ops/export.ts`
- `cmsfn/server/src/ops/import.ts`
- `cmsfn/studio/src/panes/ops/OpsPane.tsx`
- Tests implementing:
  - TV-OPS-EXPORT-001
  - TV-OPS-IMPORT-001
  - TV-OPS-IMPORT-002

## Requirements covered

- OPS-001

## Implementation tasks

1. Implement export:
   - call ContentFn dataset export for requested dataset
   - return artifact in envelope (or deterministic job handle if async)
2. Implement import:
   - validate artifact shape
   - call ContentFn dataset import for target dataset
3. Enforce dataset isolation (no import writes outside target dataset).
4. Add tests for success and malformed artifacts.

## Verification steps

- Run ops tests.

## Stop condition

- Ops endpoints behave deterministically and preserve dataset isolation.

