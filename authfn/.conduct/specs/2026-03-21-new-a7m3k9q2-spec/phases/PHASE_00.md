# Phase goal

Create the new `authfn` package layout, public contracts, and plugin/schema composition skeleton.

# In scope / Out of scope

- In scope: package creation, exports, core types, plugin interfaces, schema composer stubs
- Out of scope: working auth behavior, cookies, persistence logic

# Deliverables

- `authfn/core/package.json`
- `authfn/core/tsconfig.json`
- `authfn/core/src/index.ts`
- `authfn/core/src/types.ts`
- `authfn/core/src/plugin-types.ts`
- `authfn/core/src/plugin-runner.ts`
- `authfn/core/src/schema.ts`
- `authfn/client/package.json`
- `authfn/client/src/index.ts`
- `authfn/svelte/package.json`
- `authfn/svelte/src/index.ts`
- `authfn/python/authfn/__init__.py`
- `authfn/python/authfn/types.py`
- `authfn/python/authfn/schema.py`

# Requirements covered

- `ARCH-001`
- `CORE-002`

# Implementation tasks

1. Create the new workspace packages and retire `authfn/ts-sdk` from the active build graph.
2. Define `AuthFnConfig`, `AuthFnSession`, plugin interfaces, and hook contracts in TypeScript.
3. Define matching Python config/types.
4. Implement deterministic schema composition with collision detection.
5. Expose package entrypoints and empty plugin factory stubs.

# Verification steps

- Run `npm test --workspace @authfn/core`
- Run `npm run build --workspace @authfn/core`
- Run `python -m pytest authfn/python/tests/test_schema.py`
- Expected outcome: packages build, schema composer returns deterministic table order, collisions fail with structured errors.

# Stop condition

Report the final package layout, exported API signatures, and proof that schema composition is deterministic.
