# PHASE_00: Core types and validation

## Phase goal

Implement ChartSpec, ChartfnError, ChartfnEnvelope types and validateChartSpec() with limits (max series, max points per series, max payload size). No chartFn or adapters yet.

## In scope

- ChartType, ChartSpecData, ChartSpecOptions, ChartSpec types
- ChartfnErrorCode, ChartfnError types
- ChartfnEnvelope<T> type
- validateChartSpec(spec): ChartfnEnvelope<null> (success returns { ok: true, result: null }; failure returns { ok: false, error })
- Enforcement: max series 100, max data points per series 10_000, max JSON size 1 MiB
- Unit tests for validation (valid spec, missing type, empty series, unknown type, limits)

## Out of scope

- chartFn factory, render(), adapters, React/Svelte

## Deliverables

- `src/types.ts` (or `src/chart-spec.ts`, `src/errors.ts`) – types
- `src/validate.ts` – validateChartSpec()
- `src/constants.ts` or inline – limit constants (MAX_SERIES, MAX_POINTS_PER_SERIES, MAX_SPEC_BYTES)
- `__tests__/validate.test.ts` – tests for validation and limits

## Requirements covered

- API-002 (ChartSpec schema and validation), LIMIT-001 (series and payload limits), part of API-005 (error shape)

## Implementation tasks

1. Create package scaffold (tsconfig, build script) if not present.
2. Define ChartType, ChartSpecData, ChartSpecOptions, ChartSpec in types.
3. Define ChartfnErrorCode, ChartfnError, ChartfnEnvelope<T> in types.
4. Implement validateChartSpec(spec): ChartfnEnvelope<null>:
   - Check type is present and in ChartType union.
   - Check data.series is non-empty array.
   - Check each series has values (array of numbers) or equivalent; enforce max length 10_000 per series.
   - Enforce series.length <= 100.
   - Enforce JSON.stringify(spec).length <= 1_048_576.
   - Return { ok: false, error: { code: "SPEC_INVALID", message, details: { path } } } on failure.
   - Return { ok: true, result: null } on success.
5. Write tests: TV-SPEC-VALID-001, TV-SPEC-INVALID-001, TV-SPEC-INVALID-002, TV-SPEC-INVALID-003, TV-LIMIT-SERIES-001, TV-LIMIT-POINTS-001, TV-LIMIT-SIZE-001.

## Verification steps

- Run unit tests: `npm test` or `npx vitest run __tests__/validate.test.ts`
- Expected: All validation and limit tests pass.

## Stop condition

- All deliverables exist; validateChartSpec() passes all test vectors for this phase; build succeeds.
