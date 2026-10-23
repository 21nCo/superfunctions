# Phase 05

## Phase goal

Update documentation/examples/release notes for new package model and migration mapping.

## In scope / Out of scope

- **In scope**: READMEs, docs pages, code snippets, migration section.
- **Out of scope**: release publication automation.

## Deliverables

- Updated docs in `searchfn/*`, affected examples, and release notes/changelog entries.

## Requirements covered

- DOC-001
- REL-001

## Implementation tasks

1. Replace stale `@searchfn/adapters` snippets in docs.
2. Add migration mapping table old→new packages/imports.
3. Add explicit breaking-change section.

## Verification steps

```bash
rg -n '@searchfn/adapters' searchfn/docs searchfn/server/README.md datafn/examples/todo-app recfn -S
```

Expected outcomes:

- No active docs or examples recommend legacy package.

## Stop condition

Documentation and release metadata are aligned with implementation.
