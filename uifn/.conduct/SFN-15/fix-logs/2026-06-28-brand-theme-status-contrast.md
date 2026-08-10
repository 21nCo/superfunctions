# Fix Log: Brand Theme And Status Contrast

- timestamp: 2026-06-28T03:38:34Z
- requirements: STYLE-001, STYLE-002, STYLE-003
- trigger: Audits found no `createBrandTheme`, missing danger/warning/success token groups, and shallow contrast validation.
- previous state: first-party themes had surface/text/border/accent only; custom brand generation was not implemented; contrast validation checked only three hard-coded pairs.
- final state: token helpers parse OKLCH and hex input, status contrast pairs are validated, first-party themes include danger/warning/success groups, and `@uifn/theme` exports a typed `createBrandTheme` generator.
- verification:
  - `npm --workspace @uifn/tokens run typecheck`
  - `npm --workspace @uifn/tokens run test`
  - `npm --workspace @uifn/tokens run build`
  - `npm --workspace @uifn/theme run typecheck`
  - `npm --workspace @uifn/theme run test`
  - `npm --workspace @uifn/theme run build`
- honest limitation: release-gate wiring and component-level recipe adoption remain pending.
