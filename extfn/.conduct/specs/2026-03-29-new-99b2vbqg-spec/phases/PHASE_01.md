# Phase goal

Implement the code-first extension config model, target validation, and surface declarations.

# In scope / Out of scope

- In scope:
  - `defineExtension`
  - config types
  - config loading
  - target validation
  - page and background declarations
- Out of scope:
  - browser facade
  - messaging transport
  - content-script mount runtime

# Deliverables

- Create `packages/cli/src/utils/load-config-module.ts`
- Create `packages/cli/src/__tests__/load-config-module.test.ts`
- Modify `packages/cli/src/index.ts`
- Modify `packages/cli/package.json`
- Create `extfn/core/src/config.ts`
- Create `extfn/core/src/types.ts`
- Create `extfn/core/src/errors.ts`
- Create `extfn/core/src/index.ts`
- Create `extfn/core/__tests__/config.test.ts`
- Create `extfn/vite/src/loadExtensionConfig.ts`
- Create `extfn/vite/__tests__/loadExtensionConfig.test.ts`

# Requirements covered

- `CFG-001`
- `CFG-002`
- `SURF-001`
- `SURF-002`
- `REUSE-001`

# Implementation tasks

- Implement `defineExtension(config)` as a typed identity helper with runtime validation hooks.
- Define `BrowserTarget`, surface configs, content-script configs, and manifest override types.
- Implement config loading from `extfn.config.ts` by reusing or extracting the existing shared TypeScript config loader pattern from `packages/cli`.
- Reject missing default export and invalid target declarations.
- Enforce target scoping rules for unsupported features such as sidepanel on unsupported targets.
- Validate `background.serviceWorker` and optional `background.messageHandlersDir`.
- Validate page surface entry file references.

# Verification steps

- Run `npm run test -- --filter=@superfunctions/extfn`
- Run `npm run test -- --filter=@superfunctions/extfn-vite`
- Expected outcomes:
  - valid config fixtures load
  - invalid target fixtures fail with `E_CONFIG_INVALID` or `E_TARGET_UNSUPPORTED`
  - missing entry fixtures fail with `E_ENTRY_NOT_FOUND`
  - config loader tests do not require a duplicated TS runtime loader inside `extfn`

# Stop condition

Stop after config fixtures cover both supported targets and surface validation errors are deterministic.
