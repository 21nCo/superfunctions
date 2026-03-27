# Phase goal

Reset the public PlugFn contract so package naming, readiness claims, provider scope, and client boundary are truthful and internally consistent.

# In scope / Out of scope

- In scope: docs/status truth, package-name alignment, provider readiness matrix, browser/client boundary docs, path portability cleanup
- Out of scope: shared OAuth runtime refactors, workflow durability, Python security implementation

# Deliverables

- `plugfn/README.md`
- `plugfn/SPEC.md`
- `plugfn/typescript/README.md`
- `plugfn/python/README.md`
- `plugfn/python/SUMMARY.md`
- `plugfn/.conduct/STATUS.md`
- `plugfn/docs/getting-started.md`
- `plugfn/docs/operations/release-gates.md`
- `plugfn/docs/provider-readiness-matrix.md`
- `plugfn/docs/client-sdk-boundary.md`
- `plugfn/typescript/package.json`
- `plugfn/cli/package.json`

# Requirements covered

- `CONTRACT-001`
- `PKG-001`
- `PROVIDER-001`
- `SDK-001`
- `DOCS-001`

# Implementation tasks

1. Align all PlugFn docs on the package names `plugfn` and `@plugfn/cli`.
2. Remove or rephrase blanket production-ready and parity claims that are not yet validated.
3. Create `plugfn/docs/provider-readiness-matrix.md` with explicit provider status and TS/Python readiness columns.
4. Create `plugfn/docs/client-sdk-boundary.md` defining the server-only security boundary and the optional thin browser-helper scope.
5. Remove machine-specific absolute paths from PlugFn release docs and getting-started docs.
6. Ensure `plugfn/.conduct/STATUS.md` conditions any production-ready wording on a passing future release gate.

# Verification steps

- Run `rg -n "@superfunctions/plugfn|@superfunctions/plugfn-cli" plugfn/README.md plugfn/typescript/README.md plugfn/docs/getting-started.md`
- Run `rg -n '(^|[^[:alnum:]_])(Users/|[A-Za-z]:\\\\|file:/+)' plugfn/README.md plugfn/typescript/README.md plugfn/python/README.md plugfn/python/SUMMARY.md plugfn/.conduct/STATUS.md plugfn/docs/getting-started.md plugfn/docs/operations/release-gates.md`
- Run `rg -n "github|linear|clickup|gmail" plugfn/docs/provider-readiness-matrix.md`
- Expected outcome: old package names are gone from public docs, no machine-specific absolute paths remain in targeted PlugFn docs, and the provider matrix explicitly names the core provider set.

# Stop condition

Report the final docs inventory, the chosen core provider set, and the exact wording used for production-ready scope.
