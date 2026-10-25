"""Build real wheels and validate optional HTTP and base-only consumers with uv."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
ENV = {key: value for key, value in os.environ.items()
       if not key.startswith(("PYTHON", "PYTEST_"))
       and key not in {"MYPYPATH", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"}}

IMPORT_CHECK = """import importlib, pathlib, sys, sysconfig
prefix = pathlib.Path(sys.prefix).resolve()
assert prefix == pathlib.Path(sys.argv[1]).resolve(), (prefix, sys.argv[1])
site = pathlib.Path(sysconfig.get_path('purelib')).resolve()
assert prefix in site.parents, (prefix, site)
for name in sys.argv[2:]:
    module = importlib.import_module(name)
    path = pathlib.Path(module.__file__).resolve()
    assert site in path.parents, (name, path, site)
    print('verified installed import', name, path)
"""


def run(*args, cwd=ROOT):
    subprocess.run(args, cwd=cwd, check=True, timeout=180, env=ENV)


with tempfile.TemporaryDirectory(prefix="logfn-http-wheels-") as directory:
    owned = Path(directory)
    tests = owned / "tests"
    shutil.copytree(ROOT / "logfn/python/tests", tests, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copyfile(ROOT / "logfn/python/pyproject.toml", owned / "pyproject.toml")
    wheels = owned / "wheels"
    wheels.mkdir()
    for package in ["packages/python-core", "packages/python-fastapi", "packages/python-flask", "logfn/python"]:
        run("uv", "build", "--wheel", "--out-dir", str(wheels), str(ROOT / package))
    http_env = owned / "http"
    run("uv", "venv", "--python", "3.11", str(http_env))
    python = str(http_env / "bin/python")
    run("uv", "pip", "install", "--python", python, *map(str, wheels.glob("*.whl")), "pytest", "pytest-asyncio", "pytest-cov", "respx", "mypy")
    run(python, "-I", "-c", IMPORT_CHECK, str(http_env), "logfn", "logfn.http", "superfunctions", "superfunctions.http", "superfunctions_fastapi", "superfunctions_flask", cwd=owned)
    run(python, "-I", "-m", "pytest", str(tests), "--no-cov", "-q", cwd=owned)
    consumer = owned / "consumer.py"
    consumer.write_text('''from typing import Callable
from logfn import Logger, SinkConsole
from logfn.http import request_logger, get_request_logger
from superfunctions.http import Middleware
middleware: Middleware = request_logger(logger=Logger("installed", sinks=[SinkConsole()]))
assert get_request_logger() is None
logger = Logger("attached", sinks=[SinkConsole()])
detach: Callable[[], None] = logger.add_sink(lambda events: None)
detach()
''')
    run(python, "-I", "-m", "mypy", "--strict", str(consumer), cwd=owned)
    run(python, "-I", str(consumer), cwd=owned)
    base_env = owned / "base"
    run("uv", "venv", "--python", "3.9", str(base_env))
    base = str(base_env / "bin/python")
    log_wheel = next(wheels.glob("logfn-*.whl"))
    run("uv", "pip", "install", "--python", base, str(log_wheel), "pytest", "pytest-asyncio", "pytest-cov", "respx")
    run(base, "-I", "-c", IMPORT_CHECK, str(base_env), "logfn", cwd=owned)
    run(base, "-I", "-c", "import importlib.util,logfn; assert importlib.util.find_spec('superfunctions') is None; events=[]; logfn.Logger('base',sinks=[events.extend]).info('works'); assert events[0]['msg']=='works'", cwd=owned)
    run(base, "-I", "-m", "pytest", str(tests), "--no-cov", "-q", cwd=owned)
    result = subprocess.run(["uv", "pip", "install", "--python", base, str(log_wheel) + "[http]", "--find-links", str(wheels), "--dry-run"], capture_output=True, text=True, timeout=60, cwd=owned, env=ENV)
    if result.returncode == 0:
        raise AssertionError("HTTP extra must not resolve on Python3.9")
    if "Python" not in result.stderr or "3.10" not in result.stderr:
        raise AssertionError("Unexpected resolver failure: " + result.stderr)
    print("installed HTTP Python3.11, base-only Python3.9 and honest HTTP incompatibility passed")
