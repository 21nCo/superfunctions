"""Lazy utility module exports for browsefn."""

from importlib import import_module
from typing import Any, Dict

_EXPORTS: Dict[str, str] = {
    "url_utils": "browsefn.utils.url_utils",
    "html_utils": "browsefn.utils.html_utils",
    "validation": "browsefn.utils.validation",
}

__all__ = list(_EXPORTS.keys())


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(f"module 'browsefn.utils' has no attribute {name!r}")

    module = import_module(_EXPORTS[name])
    globals()[name] = module
    return module
