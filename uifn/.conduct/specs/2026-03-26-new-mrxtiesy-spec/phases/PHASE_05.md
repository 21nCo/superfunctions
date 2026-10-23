# Phase Goal

Finalize documentation links and ship the canonical `verify:uifn-examples` command.

# In Scope / Out Of Scope

In scope:

- Example verification script implementation
- README updates in `uifn` and adapter packages
- Offline/network-forbidden checks
- Final root-command smoke

Out of scope:

- New scenarios or new playgrounds
- Publishing example apps
- Extending `verify:uifn-release` to include examples

# Deliverables

- Create `uifn/examples/scripts/verify.mjs`
- Modify `uifn/README.md`
- Modify `uifn/react/README.md`
- Modify `uifn/svelte/README.md`
- Modify `uifn/vue/README.md`
- Update `uifn/examples/README.md` if command details changed during implementation
- Modify `package.json` only if script wiring from Phase 00 needs finalization

# Requirements Covered

- `VERIFY-009`
- `DOC-010`
- `DET-011`
- `A11Y-012`

# Implementation Tasks

1. Implement `uifn/examples/scripts/verify.mjs` to perform workspace, manifest, build, docs, and offline checks in that order.
2. Emit the canonical JSON envelope and canonical error codes from the verification script.
3. Fail verification on missing required scripts, scenario/capability drift, broken docs links, or forbidden network primitives.
4. Update `uifn/README.md` to point to the example hub.
5. Update `uifn/react/README.md`, `uifn/svelte/README.md`, and `uifn/vue/README.md` to link to their playgrounds.
6. Preserve the Vue experimental label in both the example hub and Vue README.
7. Run the full root command and capture the success JSON shape.

# Verification Steps

1. Run:

```bash
npm run verify:uifn-examples
```

Expected outcome: exits `0` and prints the canonical JSON envelope with `ok: true`.

2. Run:

```bash
rg -n "examples/README.md|react-playground|svelte-playground|vue-playground|experimental" uifn/README.md uifn/react/README.md uifn/svelte/README.md uifn/vue/README.md uifn/examples/README.md
```

Expected outcome: each README contains the appropriate example link, and the Vue README still includes experimental wording.

3. Run:

```bash
rg -n "fetch\\(|XMLHttpRequest|WebSocket\\(|navigator\\.sendBeacon" uifn/examples
```

Expected outcome: no matches in example source or verification scripts.

# Stop Condition

Report the exact `verify:uifn-examples` JSON output summary and the README files updated. No further phase should begin because this is the final phase.
