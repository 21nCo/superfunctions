# Phase Goal

Create the shared example package that defines the canonical scenarios, capability matrix, and deterministic fixtures.

# In Scope / Out Of Scope

In scope:

- Shared workspace package creation
- Scenario registry
- Capability support records
- Fixture data exports
- Shared package build entry point

Out of scope:

- Rendering any framework UI
- Documentation cross-links outside the example hub
- Final verification script implementation

# Deliverables

- Create `uifn/examples/shared/package.json`
- Create `uifn/examples/shared/tsconfig.json`
- Create `uifn/examples/shared/src/index.ts`
- Create `uifn/examples/shared/src/scenarios.ts`
- Create `uifn/examples/shared/src/capabilities.ts`
- Create `uifn/examples/shared/src/fixtures.ts`

# Requirements Covered

- `SHARED-003`
- `DET-011`

# Implementation Tasks

1. Create `@uifn/examples-shared` as a private workspace package.
2. Define the exact `ExampleAdapterId`, `ExampleScenarioId`, `ExampleCapabilityId`, `ExampleScenarioDefinition`, and `ExampleCapabilitySupport` types.
3. Implement the four canonical scenarios with required ids, titles, order, descriptions, and supported adapters.
4. Implement the capability matrix with Vue `virtualized-list` marked unsupported and the canonical note string.
5. Implement deterministic fixture exports for settings, team, commands, and results.
6. Re-export all shared contracts from `src/index.ts`.
7. Add a minimal build script so downstream playgrounds can typecheck/import the shared package consistently.

# Verification Steps

1. Run:

```bash
npm --workspace @uifn/examples-shared run build
```

Expected outcome: exits `0`.

2. Run:

```bash
node --input-type=module -e "import { scenarios, capabilitySupport } from './uifn/examples/shared/dist/index.js'; const ids=scenarios.map((x)=>x.id).join(','); if(ids!=='settings-console,team-directory,command-center,virtualized-results') throw new Error(ids); const vueVirtualized=capabilitySupport.find((x)=>x.adapter==='vue' && x.capability==='virtualized-list'); if(!vueVirtualized || vueVirtualized.status!=='unsupported') throw new Error('bad vue virtualized-list support');"
```

Expected outcome: exits `0`.

3. Review fixture sources.

Expected outcome: no fixture uses runtime timestamps, random ids, or remote fetches.

# Stop Condition

Report the exact exported scenario ids, the Vue unsupported capability note, and the shared package build result before starting Phase 02.
