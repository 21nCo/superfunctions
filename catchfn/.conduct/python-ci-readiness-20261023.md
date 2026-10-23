# CatchFn Python CI — 2026-10-23

The hosted Python job failed on test import ordering. Corrected that ordering under the package Ruff configuration. A fresh development installation then exposed that the tests import SQLAlchemy and the local Superfunctions SQLAlchemy adapter, although the development extra did not declare them. Both are now explicit dev requirements; runtime requirements are unchanged.

Validation: fresh Python 3.11 development environment with the local core and SQLAlchemy adapter; package-scoped Ruff passes, mypy passes five source files, and all three tests pass. Existing Pydantic deprecation warnings remain visible. Logs: /tmp/catch-oct23-ruff.log, /tmp/catch-oct23-install-2.log, /tmp/catch-oct23-integrated-ci-final.log and /tmp/catch-oct23-tests-final.log. Shared CI separately installs local target dev dependencies before the target extra. Full hosted checks and combined screenshot acceptance remain open.

After merging the shared prerequisites, the actual CI entrypoint completed normal local dependency installation, isolated wheel/sdist build, Ruff, mypy over all eight source/test files, and all three tests. The first integrated attempt exposed the SQLAlchemy adapter missing py.typed; its shared package marker is now included and verified in a built wheel. Final receipt: /tmp/catch-oct23-integrated-ci-final.log.
