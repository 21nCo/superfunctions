# PHASE_17: Registry and CLI

## Phase Goal

Implement the registry compiler, source installer, lock file, diffing, and package import guidance.

## In Scope

- Registry schema.
- Registry builder.
- CLI commands.
- Source install.
- Lock file.
- Diff/update validation.
- Package import info.

## Out of Scope

- Remote registry hosting.
- Bit publishing.

## Deliverables

- `uifn/registry/src/cli.ts`
- `uifn/registry/src/schema.ts`
- `uifn/registry/src/build-registry.ts`
- `uifn/registry/src/add.ts`
- `uifn/registry/src/diff.ts`
- `uifn/registry/src/update.ts`
- `uifn/registry/src/lockfile.ts`
- CLI fixture repos

## Requirements Covered

REG-001, REG-002, DOCS-001, SEC-001

## Implementation Tasks

1. Implement manifest validation.
2. Implement registry build from catalog files.
3. Implement `list`, `info`, `add`, `diff`, `update`, and `validate`.
4. Implement lockfile writer.
5. Implement checksum validation.
6. Add fixture tests for every framework.
7. Add redaction for CLI diagnostics.

## Verification Steps

```bash
npm --workspace @uifn/registry run test
npm run verify:uifn-registry
```

Expected outcome: CLI fixture tests pass and source installs create expected files and locks.

## Stop Condition

Report CLI UX, lockfile format, and unsupported cases.
