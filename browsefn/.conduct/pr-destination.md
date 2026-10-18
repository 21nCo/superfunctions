# PR destination correction

This branch starts at sf-next/next b21477fc9 and applies the browsefn implementation from 64185926c. It replaces the misplaced origin draft #247; no changes from the broader origin/dev history are imported. Existing sf-next specifications and historical artifacts are preserved.

Prior package tests and packed/browser checks belong to the original implementation checkout. This new target has older shared packages and a different workspace graph: clean installation, lock reconciliation and target-context validation remain open before merge. Shared prerequisite publication or synchronization is required where package manifests request newer versions. This draft is not a completion claim.

## Shared prerequisite integration

Merged shared prerequisite head0ef7b9cb6 and aligned BrowseFn to DB0.4.0. Regenerated the root lock using npm11; default npm10 scoped clean installation passes. Shared packages and BrowseFn core/admin build; core130 and admin24 tests pass, including native SQLite persistence after rebuilding better-sqlite3, and both source typechecks pass. Build dependencies before dependents (npm workspace selection does not imply topological ordering).

Packed core and admin consumers pass on exact Node20.19.0: ESM real-HTTP scraping, synchronous CJS router/limiter APIs, scoped admin service, and NodeNext declarations. Each production dependency audit reports zero vulnerabilities. The packed harness accepts NPM_CLI because npm10 hits its internal edgesOut failure during isolated local-tarball installation; npm11 succeeds.

Python target validation is still blocked: sf-next shared python-core identifies itself as superfunctions instead of required superfunctions-core (unavailable from registry), and shared SQLAlchemy0.1.0 is older than required0.1.1. Synchronize and validate those prerequisites before readiness. Prior Python/browser evidence from the original implementation checkout is not target-context proof. Full original requirements and hosted checks remain open.
