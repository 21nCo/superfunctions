# Phase goal

Complete the TypeScript geo surface across reverse geocoding, forward geocoding, search, and place details.

## In scope / Out of scope

- **In scope**:
  - Google Maps and Mapbox providers
  - Nominatim normalization
  - geocode, reverse geocode, search, and place details
  - alias normalization for geo provider IDs
- **Out of scope**:
  - Python geo parity
  - docs rewrite

## Deliverables

- `browsefn/typescript/src/geo/geocoder.ts`
- `browsefn/typescript/src/geo/providers/nominatim.ts`
- `browsefn/typescript/src/geo/providers/google-maps.ts`
- `browsefn/typescript/src/geo/providers/mapbox.ts`
- `browsefn/typescript/src/core/browse-fn.ts`
- `browsefn/typescript/src/core/types.ts`
- `browsefn/typescript/tests/geocoder.test.ts`
- `browsefn/typescript/tests/geo-providers.test.ts`

## Requirements covered

- GEO-001
- API-001
- ERR-001

## Implementation tasks

1. Register all documented builtin geo providers through the canonical provider registry.
2. Normalize `googleMaps` input to `google-maps` and emit canonical output IDs.
3. Implement search and place-details semantics, including the limited/unsupported Nominatim branch.
4. Add tests for alias normalization, place-details behavior, and normalized result models.

## Verification steps

1. Run `npm --prefix browsefn/typescript run test -- --run geocoder geo-providers`.
Expected: geo tests pass.
2. Run `npm --prefix browsefn/typescript run typecheck`.
Expected: typecheck exits `0`.

## Stop condition

Report the final geo provider IDs, the Nominatim place-details behavior, and the geocoder test results.
