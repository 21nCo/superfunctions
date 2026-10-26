# SQLAlchemy first-use transaction reflection

The adapter now reflects uncached tables through the active SQLAlchemy connection when called inside a transaction. Previously engine-level reflection could check out the same SQLite StaticPool DBAPI connection and roll back an earlier insert. A transaction inserting into two first-use tables returned successfully with only the second insert retained.

All existing transaction CRUD methods, conditional `update_many`, and the additive transaction `count` method use the owned connection. Ordinary adapter methods keep their existing engine behavior. This does not add transaction `upsert` or bulk-delete APIs, change shared protocols, or establish cross-thread StaticPool transaction isolation.

## Validation (2026-10-26)

- Exact committed baseline adapter loaded from a temporary copy of `git show HEAD:packages/python-sqlalchemy/superfunctions_sqlalchemy/adapter.py`: native SQLite first/second table counts `(0, 1)` after successful callback. Temporary copy removed. Receipt: `/tmp/shared-sqlalchemy-reflection-exact-baseline.log`.
- Final full package suite: 37 passed, including 14 new native StaticPool cases spanning create/find-one/find-many/update/conditional-update/delete/count with successful commit and callback exception rollback. Execution-only fake-connection tests explicitly reflect their tables first, leaving their original error assertions intact. Receipt: `/tmp/shared-sqlalchemy-reflection-tests-final.log`.
- Built fresh `superfunctions-core` and `superfunctions-sqlalchemy` wheels, installed them in an owned Python 3.11 environment, removed PYTHONPATH/PYTHONHOME overrides, and asserted both imports resolve under that environment. Copied tests outside checkout and ran under `python -I`: 37 passed. Normal package mypy (two source files) and Ruff passed. Receipt: `/tmp/shared-sqlalchemy-reflection-wheel-final.log`.
- Initial validation found three execution-only fake connections could not perform reflection; fixture preparation was corrected. Initial fresh-wheel run then identified three test formatting violations; corrected and repeated the final isolated acceptance. No gate was weakened.

All owned temporary consumers, engines and baseline copies were closed/removed. No external databases, package release, deployment, root dependency changes or ignore changes. Existing Pydantic deprecation warnings remain. Native SQLite evidence does not replace independent PostgreSQL/MySQL provider acceptance.
