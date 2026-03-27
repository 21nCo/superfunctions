# PHASE_05

- Phase goal: Make all public docs truthful and consistent with the shipped package contract.

## In scope

- root README
- adapter READMEs
- docs site guides and relevant API-model docs
- automated docs contract check

## Out of scope

- renderer implementation
- example app proof code

## Deliverables

- Modify `docsfn/README.md`
- Modify `docsfn/next/README.md`
- Modify `docsfn/sveltekit/README.md`
- Modify `docsfn/docs/content/docs/guides/sveltekit.md`
- Modify `docsfn/docs/content/docs/guides/customizing-components.md`
- Modify any dogfood docs pages that describe the API route/content model or search scopes
- Expand `docsfn/scripts/docs-contract-check.mjs`

## Requirements covered

- `DOCS-001`
- `PKG-001`
- `SITE-001`
- `BUILD-001`

## Implementation tasks

1. Remove machine-specific absolute command paths from docs.
2. Replace internal-source and unsupported import paths with supported public imports.
3. Align route/content model language around `/docs/api` and API search scope behavior.
4. Add automated checks for unsupported imports, absolute paths, and inconsistent route-model wording.

## Verification steps

1. Run: `node docsfn/scripts/docs-contract-check.mjs`
   Expected outcome: zero violations.
2. Manually spot-check the updated root README and Svelte guide.
   Expected outcome: every command is repo-relative or standard; every import path is public.

## Stop condition

- Report the set of public docs files brought under automated contract checking.
