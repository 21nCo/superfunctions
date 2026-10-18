# Shared Python prerequisites for sf-next

The core distribution is `superfunctions-core` 0.1.1 (imports remain `superfunctions`). SQLAlchemy 0.1.1 requires this distribution, exports the current adapter version, uses the current connection-error class and Pydantic capability/health field names. `WhereClause.connector` preserves explicit AND/OR semantics instead of discarding the connector during validation. Existing SQLAlchemy OR-query and error tests cover these boundaries.

Target-only legacy modules (`auth.py`, `db.py`, `oauth.py`) remain intact. Two existing OAuth test fixtures now provide the intent ID required by the existing browser-subject contract. No OAuth runtime behavior changed.

## Validation, 2026-10-18

- Python 3.11.14 fresh virtual environments; source suites: **41 passed**.
- Built fresh isolated Hatch wheels for both shared packages and BrowseFn 0.2.0 from target checkout HEAD `cc142313b198091e0a33d94e64d04b6d61744ebc`.
- Installed all three wheel paths in a separate environment with normal dependency resolution. Distribution metadata `direct_url.json` identifies local wheels; module paths resolve inside consumer `site-packages`.
- Copied test files unchanged into a temporary directory without any Python package sources. Copied only BrowseFn README, release-gate script and TypeScript provider registry as non-Python test fixtures. Renamed the copied BrowseFn test parent to avoid pytest creating a conflicting `browsefn` namespace. **135 passed**: shared 41 plus BrowseFn 94.
- Existing class-based Pydantic configuration emits deprecation warnings (54 in direct collection; 36 captured by pytest when imports are preloaded for provenance assertions); no skipped tests.
- No BrowseFn worktree edits, registry publication or cloud changes.

## Reproduction

Build with `python -m build --wheel --outdir <wheel-directory> packages/python-core`, repeat for `packages/python-sqlalchemy` and target `browsefn/python`. Install those three wheel paths plus `pytest` and `pytest-asyncio` in a fresh Python 3.11 environment. Copy shared and BrowseFn tests into an isolated directory as described above; run `python -m pytest packages/python-core/tests packages/python-sqlalchemy/tests consumer/python/tests --import-mode=importlib --asyncio-mode=auto -q`.

Session logs: `/tmp/sf-next-python-source311.log`, `/tmp/sf-next-python-wheel-tests.log`, `/tmp/sf-next-python-build-final.log`. Wheels: `/tmp/sf-next-python-wheels-20261018`; isolated consumer: `/tmp/sf-next-python-consumer-20261018`.
