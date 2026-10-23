# Real Adapter Conformance: Solid

- timestamp: 2026-06-28T03:44:45Z
- requirements: ADAPT-001, ADAPT-005, TEST-001
- reference audits:
  - `uifn/.conduct/audits/2026-06-28-k8p4s2nq-full-audit.md`
  - `uifn/.conduct/audits/2026-06-28-m3v7q9xk-full-audit.md`

## Previous State

Solid adapter conformance did not prove the Solid adapter. The verifier rejected the package because the conformance source still used the adapter-kit minimal fixture path, and the executable public surface was mostly limited to Switch.

## Implemented Change

- Added Solid public signal APIs:
  - `createDialog`
  - `createCheckbox`
- Added Solid JSX components:
  - `DialogRoot`, `DialogTrigger`, `DialogContent`, `DialogTitle`, `DialogDescription`, `DialogClose`
  - `CheckboxRoot`, `CheckboxIndicator`
- Replaced Solid conformance with a fixture that instantiates the public Solid APIs and translates Solid event props.
- Hardened `scripts/verify-uifn-adapter.mjs` so Solid must include Dialog/Checkbox APIs, components, tests, and a real conformance fixture.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run test -- src/__tests__/solid-core-adapter.test.tsx`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-adapter.mjs --framework solid`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/solid run build`

## Residual Risk

This fixes the fake conformance path and broadens Solid beyond Switch, but ADAPT-005 is not complete until Solid implements the full primitive set and conformance vectors cover more than Dialog and Checkbox.
