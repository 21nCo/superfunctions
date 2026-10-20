# PR destination correction

This branch starts at sf-next/next b21477fc9 and applies the browsefn implementation from 64185926c. It replaces the misplaced origin draft #247; no changes from the broader origin/dev history are imported. Existing sf-next specifications and historical artifacts are preserved.

Prior package tests and packed/browser checks belong to the original implementation checkout. This new target has older shared packages and a different workspace graph: clean installation, lock reconciliation and target-context validation remain open before merge. Shared prerequisite publication or synchronization is required where package manifests request newer versions. This draft is not a completion claim.

## Shared prerequisite integration

Merged shared prerequisite head0ef7b9cb6 and aligned BrowseFn to DB0.4.0. Regenerated the root lock using npm11; default npm10 scoped clean installation passes. Shared packages and BrowseFn core/admin build; core130 and admin24 tests pass, including native SQLite persistence after rebuilding better-sqlite3, and both source typechecks pass. Build dependencies before dependents (npm workspace selection does not imply topological ordering).

Packed core and admin consumers pass on exact Node20.19.0: ESM real-HTTP scraping, synchronous CJS router/limiter APIs, scoped admin service, and NodeNext declarations. Each production dependency audit reports zero vulnerabilities. The packed harness accepts NPM_CLI because npm10 hits its internal edgesOut failure during isolated local-tarball installation; npm11 succeeds.

## Fresh Python target package acceptance — 2026-10-20

The earlier prerequisite blocker is resolved in this branch: shared Python core is
`superfunctions-core` 0.1.1 and SQLAlchemy is 0.1.1. The new
`scripts/packed-python-acceptance.py` builds all three local wheels, installs them
with normal dependency resolution in an isolated environment, copies the tests and
required non-Python fixtures, and asserts package imports originate in site-packages.
No Python implementation is copied into the consumer tree. Temporary environments
are removed on completion or failure.

Python 3.10 and 3.12 each pass all 94 existing tests plus the installed-origin check
(95 total). This includes actual local HTTP/image/cache/SQLAlchemy tests. Eighteen
shared Pydantic deprecation warnings remain; they do not fail these runs. Receipts:
`/tmp/browsefn-python-wheel-310.log` and `/tmp/browsefn-python-wheel-312.log`.

Reproduce: `python3 browsefn/scripts/packed-python-acceptance.py --python 3.10`
and repeat with `--python 3.12`. Requires uv and Node for the release-script fixture.
These checks do not establish live paid-provider behavior, full browser/platform
coverage, hosted CI, release or deployment. Full original readiness remains open.
