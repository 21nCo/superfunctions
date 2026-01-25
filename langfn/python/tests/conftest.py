import sys
from pathlib import Path


def _prepend_local_superfunctions() -> None:
    """
    Ensure tests run against the monorepo's `packages/python-core` implementation.

    The published `superfunctions` package may differ across environments; in-repo tests
    should validate against the local shared abstractions.
    """
    here = Path(__file__).resolve()
    repo_root = here.parents[3]
    python_core = repo_root / "packages" / "python-core"
    if python_core.exists():
        sys.path.insert(0, str(python_core))


_prepend_local_superfunctions()

