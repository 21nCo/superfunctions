"""Import baseline tests for sendfn packaging."""

import importlib
import sys

import pytest


def _clear_sendfn_modules() -> None:
    for module_name in list(sys.modules):
        if module_name == "sendfn" or module_name.startswith("sendfn."):
            sys.modules.pop(module_name, None)


def test_base_import_succeeds_without_optional_web_extras() -> None:
    """The base package should import without importing optional web adapters."""
    _clear_sendfn_modules()

    module = importlib.import_module("sendfn")

    assert module.__version__ == "0.1.0"
    assert "sendfn.http.fastapi" not in sys.modules


def test_fastapi_import_requires_extra(
    block_imports,
) -> None:
    """Importing the FastAPI adapter without extras should raise a typed error."""
    _clear_sendfn_modules()
    block_imports(["superfunctions_fastapi"])

    with pytest.raises(Exception) as exc_info:
        importlib.import_module("sendfn.http.fastapi")

    error = exc_info.value
    assert str(error) == "FastAPI integration requires the `fastapi` extra"
    assert getattr(error, "code", None) == "SENDFN_OPTIONAL_DEPENDENCY_MISSING"
