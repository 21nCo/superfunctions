# Fix Log: Core Part Event Contract

- timestamp: 2026-06-28T03:22:25Z
- requirements: CORE-002, ADAPT-001 support utility contract
- trigger: Audits found public part props used `handlers` instead of spec-required `on`.
- previous state: Core controllers and adapter bridges exposed event metadata as `handlers`, creating public API drift from the SFN-15 `UIFnPartProps` shape.
- final state: Core and adapter bridge code now use `on` for part event metadata with no compatibility alias.
- verification:
  - `rg -n "\\bhandlers\\b|\\.handlers|\\['handlers'\\]" uifn/core uifn/adapter-kit uifn/react uifn/svelte uifn/vue uifn/solid uifn/angular`
  - `npm --workspace @uifn/core run typecheck`
  - `npm --workspace @uifn/core run test`
  - `npm --workspace @uifn/adapter-kit run typecheck`
  - `npm --workspace @uifn/adapter-kit run test`
- honest limitation: framework package typechecks remain pending.
