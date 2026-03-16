# PHASE_01

## Phase goal
Implement SPV2 capability schema/types and validation in core.

## In scope / Out of scope
In scope:
- Extend shareable capability shape for SPV2.
- Validate `visibilityDefault`, scope support, relation inheritance options.
- Add new error code plumbing in core validation envelopes.

Out of scope:
- Server execution logic.
- Client API methods.

## Deliverables
- `datafn/core/src/capabilities.ts`
- `datafn/core/src/schema.ts`
- `datafn/core/src/types.ts`
- `datafn/core/src/__tests__/capabilities.test.ts`
- `datafn/core/src/__tests__/schema-capabilities.test.ts`

## Requirements covered
- ARCH-003
- ARCH-005
- API-001

## Implementation tasks
1. Add SPV2 shareable config type extensions and defaults.
2. Add schema validation for unsupported `visibilityDefault` values and invalid scope configs.
3. Preserve legacy `default` behavior for compatibility parsing.
4. Add tests for valid and invalid SPV2 capability configs.

## Verification steps
1. `npm test --workspace datafn/core`
Expected outcome: all core tests pass.
2. `rg -n "visibilityDefault|supportsScopeGrants|relationInheritance" datafn/core/src`
Expected outcome: new fields are present in types and validation.

## Stop condition
Core schema accepts valid SPV2 configs, rejects invalid configs, and keeps v1 compatibility tests green.
