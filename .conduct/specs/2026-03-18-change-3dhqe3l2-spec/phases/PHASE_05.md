# Phase goal

Finalize schema-support handling, documentation, examples, and release readiness for the Conduct dependency set.

# In scope / Out of scope

- **In scope**: `@superfunctions/cli` fallback/codegen path, docs/changelog updates, final dependency matrix tests.
- **Out of scope**: new feature scope beyond this spec.

# Deliverables

- `/Users/serro/Documents/dev/n/superfunctions/packages/cli/*` or documented direct Drizzle fallback artifacts
- `/Users/serro/Documents/dev/n/superfunctions/plugfn/README.md`
- `/Users/serro/Documents/dev/n/superfunctions/clifn/core/README.md`
- package changelog/doc updates for affected packages

# Requirements covered

- SCHEMA-001
- DOCS-001
- TEST-001

# Implementation tasks

- [ ] Decide whether `@superfunctions/cli` changes or direct Drizzle fallback is the supported path.
- [ ] Add tests for the supported Conduct schema path.
- [ ] Update package docs, examples, and changelog notes.
- [ ] Run the full dependency matrix one final time.

# Verification steps

1. Run the schema-support tests/harness.
   Expected: Conduct's composite index and CHECK-constraint needs are supported.
2. Run the full relevant test matrix.
   Expected: provider, `clifn`, and dependency harness suites all pass.
3. Inspect docs/examples.
   Expected: all new public contracts are documented using public imports.

# Stop condition

Report the final supported schema path, docs/changelog status, and full dependency matrix result.
