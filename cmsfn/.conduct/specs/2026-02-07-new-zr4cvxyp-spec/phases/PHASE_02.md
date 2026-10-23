# PHASE_02: Roles CRUD + server-side enforcement

## Phase goal

Implement role management endpoints and enforce role permissions server-side on CmsFn endpoints that proxy or orchestrate ContentFn actions.

## In scope

- Endpoints:
  - `POST /cmsfn/roles/list`
  - `POST /cmsfn/roles/upsert`
  - `POST /cmsfn/roles/delete`
- Server-side permission enforcement for:
  - publish/unpublish (when implemented)
  - preview token minting
  - audit endpoints
  - ops import/export triggers

## Out of scope

- Studio UI role editor (may be minimal in this phase)

## Deliverables

- `cmsfn/server/src/http/roles.ts`
- `cmsfn/server/src/storage/roles.ts`
- `cmsfn/server/src/auth/authorize.ts` (role evaluation integration)
- Tests implementing:
  - TV-ROLE-UPSERT-001
  - TV-ROLE-LIST-001
  - TV-ROLE-DENY-001
  - TV-ENV-ERR-001

## Requirements covered

- ROLE-001
- ENV-001

## Implementation tasks

1. Define role storage schema and persistence via `@superfunctions/db` adapter.
2. Implement endpoints with deterministic validation errors.
3. Implement authorization middleware:
   - identify subject (deployment-defined)
   - load roles and evaluate rules deterministically
4. Add tests for allow and deny behavior.

## Verification steps

- Run role tests.

## Stop condition

- Roles CRUD works and denied actions are enforced server-side.

