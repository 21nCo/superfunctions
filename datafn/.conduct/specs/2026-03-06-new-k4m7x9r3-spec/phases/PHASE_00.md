# PHASE 00: Core Capability Types & Resolution

## Phase goal
Define capability type definitions in `@datafn/core` and implement the `resolveCapabilities()` function.

## In scope
- Capability type definitions (`SimpleCapability`, `ShareableCapability`, `CapabilityEntry`, etc.)
- `resolveCapabilities(schema, resource)` function
- `getCapabilityFields(resolvedCapabilities)` function returning field definitions for injected fields
- `CAPABILITY_FIELD_DEFS` constant mapping capabilities to their injected field specs
- Update `DatafnSchema` and `DatafnResourceSchema` types to include optional `capabilities`

## Out of scope
- Schema validation integration (Phase 1)
- Codegen (Phase 2)
- Server execution (Phases 3-6)
- Client methods (Phase 7)

## Deliverables
- `datafn/core/src/capabilities.ts` (new file)
- `datafn/core/src/types.ts` (updated — add capabilities to schema types)
- `datafn/core/src/index.ts` (updated — export new types and functions)
- `datafn/core/src/__tests__/capabilities.test.ts` (new test file)

## Requirements covered
- CAP-001, CAP-002, CAP-006

## Implementation tasks
1. Define `SimpleCapability` type: `"timestamps" | "audit" | "trash" | "archivable"`
2. Define `AccessLevel` type: `"viewer" | "editor" | "owner"`
3. Define `ShareableCapability` type: `{ shareable: { levels: AccessLevel[]; default: "private" | "shared" } }`
4. Define `CapabilityEntry` type: `SimpleCapability | ShareableCapability`
5. Define `SchemaCapabilities` type: `CapabilityEntry[]`
6. Define `ResourceCapabilities` type: `CapabilityEntry[] | { exclude: SimpleCapability[] }`
7. Define `CAPABILITY_FIELD_DEFS` constant mapping each capability to its injected fields with type, nullable, readonly, and default properties
8. Implement `resolveCapabilities(globalCaps, resourceCaps)`:
   - If resourceCaps is undefined → return globalCaps
   - If resourceCaps is array → union with globalCaps (deduplicate)
   - If resourceCaps is `{ exclude: [...] }` → filter globalCaps
   - Return resolved list
9. Implement `getCapabilityFields(resolvedCaps)` → returns `DatafnFieldSchema[]` for injected fields
10. Update `DatafnSchema` type to include `capabilities?: SchemaCapabilities`
11. Update `DatafnResourceSchema` type to include `capabilities?: ResourceCapabilities`
12. Export all new types and functions from `datafn/core/src/index.ts`
13. Write unit tests for `resolveCapabilities`:
    - Global only
    - Resource additive
    - Resource exclusion
    - Both global and resource undefined
    - Deduplication
    - Shareable with config
14. Write unit tests for `getCapabilityFields`:
    - Each capability individually
    - Combined capabilities
    - Empty capabilities

## Verification steps
1. `cd datafn/core && npx vitest run src/__tests__/capabilities.test.ts` — all tests pass
2. `cd datafn/core && npx tsc --noEmit` — no type errors
3. Manual check: `resolveCapabilities(["timestamps", "audit"], ["trash"])` returns `["timestamps", "audit", "trash"]`
4. Manual check: `resolveCapabilities(["timestamps", "trash"], { exclude: ["trash"] })` returns `["timestamps"]`

## Stop condition
All unit tests pass. Types compile. Resolution algorithm handles all edge cases.
