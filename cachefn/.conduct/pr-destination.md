# Target branch validation

CacheFn draft52 targets the shared sf-next prerequisite branch codex/shared-readiness-sf-next-20261018 (PR55,988fba320). Prerequisites were merged into the existing product branch without rewriting pushed history. No origin/dev history is imported. Historical artifacts are retained.

## 2026-10-18 clean target checks

Root lock regenerated with npm11.21.0; clean scoped npm10.8.2 ci installed508packages. Core217 and admin8tests passed with Vitest4.1.11; MCP/admin/core/product-admin builds and both product typechecks passed. Python3.12:55tests; Python3.10:52tests and3version-specific eager-task skips. Python dependencies resolved from the current package in isolated uv environments.

Fresh delivery acceptance used explicit locally packed shared MCP0.0.6/admin0.1.5 prerequisites, regenerated a separate consumer install, rebuilt/retested core+admin, passed packed ESM/CJS/types consumers and Chrome15427assertions. Exact fourtarball runtime graph passed with0production advisories. npm10 failed resolving that independent consumer with an internal edgesOut error; rerun using npm11's CLI succeeded. These are scoped graph checks, not a whole-repository install/audit claim.

Root lock includes current CacheFn manifest and framework/toolchain dependency upgrades, no version downgrades. Root .gitignore unchanged. Hosted checks, nativeSafari/Firefox acceptance, TestFn integration on this target and final full-contract verification remain. No publication/deployment or full-goal completion is claimed.
