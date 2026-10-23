from __future__ import annotations

import importlib
import json
import re
from pathlib import Path

from langfn import LangFn, __version__
from langfn.evaluation import DatasetItem
from langfn.observability import Budgets, CostMeter, Tracer
from langfn.prompts import ChatTemplate, PromptTemplate


REPO_ROOT = Path(__file__).resolve().parents[3]
TS_PACKAGE_JSON = REPO_ROOT / "langfn" / "typescript" / "package.json"
PYPROJECT = REPO_ROOT / "langfn" / "python" / "pyproject.toml"
TS_HTTP_ROUTES = REPO_ROOT / "langfn" / "typescript" / "src" / "http" / "routes.ts"
PY_HTTP_HANDLERS = REPO_ROOT / "langfn" / "python" / "langfn" / "http" / "handlers.py"
ROOT_README = REPO_ROOT / "langfn" / "README.md"
TS_README = REPO_ROOT / "langfn" / "typescript" / "README.md"
PY_README = REPO_ROOT / "langfn" / "python" / "README.md"


def _extract_pyproject_version() -> str:
    match = re.search(r'^version = "([^"]+)"$', PYPROJECT.read_text(), re.MULTILINE)
    assert match is not None
    return match.group(1)


def _extract_health_version(path: Path) -> str:
    match = re.search(r'version["\']?\s*[:=]\s*["\']([^"\']+)["\']', path.read_text())
    assert match is not None
    return match.group(1)


def test_public_import_contract() -> None:
    assert LangFn.__name__ == "LangFn"
    assert PromptTemplate.__name__ == "PromptTemplate"
    assert ChatTemplate.__name__ == "ChatTemplate"
    assert DatasetItem.__name__ == "DatasetItem"
    assert Tracer.__name__ == "Tracer"
    assert CostMeter.__name__ == "CostMeter"
    assert Budgets.__name__ == "Budgets"
    assert importlib.import_module("langfn.prompts")
    assert importlib.import_module("langfn.evaluation")
    assert importlib.import_module("langfn.observability")


def test_version_metadata_is_synchronized() -> None:
    ts_package = json.loads(TS_PACKAGE_JSON.read_text())
    ts_version = ts_package["version"]
    pyproject_version = _extract_pyproject_version()
    ts_health_version = _extract_health_version(TS_HTTP_ROUTES)
    py_health_version = _extract_health_version(PY_HTTP_HANDLERS)

    assert ts_package["name"] == "langfn"
    assert ts_version == pyproject_version == __version__ == ts_health_version == py_health_version


def test_readmes_reference_same_release_story() -> None:
    root_readme = ROOT_README.read_text()
    ts_readme = TS_README.read_text()
    py_readme = PY_README.read_text()

    for content in (root_readme, ts_readme, py_readme):
        assert "0.1.0" in content
        assert "npm install langfn@0.1.0" in content
        assert "pip install langfn==0.1.0" in content
