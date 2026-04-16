# Phase goal

Ship adoption and migration guidance that positions `clifn` as the shared generic CLI toolkit for extfn and other Superfunctions CLIs.

# In scope / Out of scope

- In scope:
  - adoption docs
  - repository CLI comparison guidance
  - extfn-specific generic reuse boundary
  - verification of documentation examples
- Out of scope:
  - migrating every existing repository CLI
  - implementing extfn-specific behavior in clifn

# Deliverables

- Modify `clifn/core/README.md`
- Create `clifn/.conduct/walkthrough.md`
- Create `clifn/core/tests/readme-examples.test.ts` or equivalent doc-example verification

# Requirements covered

- `ADOPT-001`
- `COMP-001`
- `PARS-001`

# Implementation tasks

- Document which repeated patterns from current CLIs now belong in `clifn`.
- Document which product-specific concerns remain in each owning CLI.
- Add an explicit extfn section listing what extfn/cli SHOULD use from clifn and what MUST stay extfn-owned.
- Add brief adoption notes for representative existing CLIs such as:
  - `packages/cli`
  - `apifn/cli`
  - `hostfn/cli`
  - `recfn/cli`
- Verify README examples compile or execute in tests where practical.

# Verification steps

- Run `npm run test -- --filter=clifn -- readme-examples`
- Review `clifn/core/README.md` and `clifn/.conduct/walkthrough.md`
- Expected outcomes:
  - documentation examples stay in sync with the implementation
  - extfn reuse boundary is explicit
  - adoption guidance references current repository CLI patterns accurately

# Stop condition

Stop after the package is documented well enough that extfn and other CLI builders can adopt it without guessing where the boundary lies.

