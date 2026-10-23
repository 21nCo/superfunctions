# Fix build issues in datafn/svelte package

## Problem
The `tsup` DTS (declaration) build fails with type errors in `toReactiveSvelteStore`. TypeScript infers literal types from the initial value passed to `readable()`:
- `loading: true` → type `true` (not `boolean`)
- `error: null` → type `null` (not `DatafnError | null`)
- `refreshing: false` → type `false` (not `boolean`)

When `set()` is later called with `boolean`/`DatafnError | null` values, TS rejects them.

There's also a warning about `exports` field ordering in `package.json` — `"types"` should come before `"import"` and `"require"`.

## Changes

### 1. Fix type inference in `toSvelteStore.ts` (line 101)
Widen the literal types in the initial value of the `readable()` call inside `toReactiveSvelteStore` by casting to the correct types:
```ts
{ data: undefined as unknown as T, loading: true as boolean, error: null as DatafnError | null, refreshing: false as boolean }
```
This requires importing `DatafnError` as a value-level import won't work — we'll use the existing `import type` and inline cast.

### 2. Fix `exports` ordering in `package.json`
Move `"types"` before `"import"` and `"require"` in the exports field:
```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "require": "./dist/index.cjs"
  }
}
```
