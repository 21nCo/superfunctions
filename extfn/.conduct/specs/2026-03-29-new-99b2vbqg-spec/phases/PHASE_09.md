# Phase goal

Finalize repository documentation, consumer guidance, and the verification matrix for adoption in external repos such as `nucleus`.

# In scope / Out of scope

- In scope:
  - repository docs for `extfn` and `datafn/extfn`
  - CLI command documentation for `extfn dev`, `extfn build`, `extfn package`, and `extfn scan`
  - consumer host abstraction guidance
  - migration guidance for SvelteKit-coupled shared components
  - example verification scripts or documented commands
- Out of scope:
  - making changes in external repositories

# Deliverables

- Create `extfn/README.md`
- Create `extfn/docs/cli.md`
- Create `extfn/docs/scan.md`
- Create `extfn/docs/consumer-host-abstraction.md`
- Create `extfn/docs/multi-content-and-background-handlers.md`
- Create `datafn/extfn/README.md`
- Update example package READMEs under `extfn/examples/*`
- Update verification command docs under `extfn/docs/`

# Requirements covered

- `DOC-001`
- `OBS-001`
- `EX-001`

# Implementation tasks

- Document the code-first config model and package responsibilities.
- Document the mandatory CLI workflow and strict scan behavior.
- Document target support and capability gating for Firefox MV3 and Chromium MV3.
- Document the recommended consumer host abstraction approach for shared UI code that currently imports `$app/*`.
- Document how to migrate SvelteKit-coupled consumer components toward consumer-owned host adapters.
- Document how to use raw browser globals versus the Promise-first browser facade.
- Document how to use `@datafn/extfn` from popup, options, sidepanel, and content contexts.
- Document the validation commands for all example extensions and CLI workflows.

# Verification steps

- Run `rg -n "\$app/" extfn datafn/extfn`
- Run `npm exec extfn -- --help`
- Run `npm run build -- --filter=vanilla-messaging-demo`
- Run `npm run build -- --filter=svelte-multi-content-demo`
- Run `npm run build -- --filter=svelte-datafn-demo`
- Expected outcomes:
  - `extfn` and `datafn/extfn` docs exist
  - CLI commands are documented consistently with the shipped binary
  - example validation commands are documented and executable from repo root
  - migration guidance explicitly covers the SvelteKit host-coupling problem

# Stop condition

Stop after repository docs cover consumer migration concerns without modifying any external repository.
