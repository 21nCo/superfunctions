# PHASE_00: Core scaffolding (types + permission evaluator)

## Phase goal

Create package scaffolding and implement canonical core types for CmsFn, including permission evaluation and desk model types.

## In scope

- Package scaffolding:
  - `cmsfn/core` (`@cmsfn/core`)
  - `cmsfn/server` (`@cmsfn/server`) (types-only here)
  - `cmsfn/studio` (`@cmsfn/studio`) (boot skeleton here)
- Core types:
  - `CmsfnErrorCode`, `CmsfnError`, `CmsfnEnvelope<T>`
  - `CmsfnRole`, actions, rules, and deterministic evaluator
  - desk node types and deterministic node key generation
  - workflow `_cms` metadata model
  - release model types

## Out of scope

- Any server endpoints
- Any UI panes beyond a boot placeholder

## Deliverables

- `cmsfn/core/package.json`, `tsconfig.json`, `src/index.ts`
- `cmsfn/core/src/errors.ts`, `envelope.ts`
- `cmsfn/core/src/roles/types.ts`, `roles/evaluate.ts`
- `cmsfn/core/src/desk/types.ts`, `desk/keys.ts`
- `cmsfn/core/src/workflow/types.ts`
- `cmsfn/core/src/releases/types.ts`
- Basic unit tests for:
  - role evaluator allow/deny determinism
  - desk key determinism

## Requirements covered

- ENV-001 (types)
- ROLE-001 (permission evaluation core; partial)
- STUDIO-001 (desk model types; partial)
- WF-001 (workflow metadata types; partial)
- REL-001 (release types; partial)

## Implementation tasks

1. Create ESM-first package scaffolds.
2. Implement envelope/error types.
3. Implement role evaluator:
   - input: role rules + dataset/type/action
   - output: allow/deny boolean
   - deterministic conflict behavior when multiple rules match
4. Implement desk keying function:
   - stable keys derived from config path
5. Add unit tests for determinism and negative cases.

## Verification steps

- `turbo run build --filter=@cmsfn/*` succeeds.
- Unit tests pass.

## Stop condition

- Core types exist, compile, and are deterministic.

