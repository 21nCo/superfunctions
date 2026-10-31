import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

import pytest

PACKAGE_DIR = Path(__file__).resolve().parents[1]
SOURCES = PACKAGE_DIR / "src" / "logfn"


def newest_wheel() -> Path | None:
    wheels = sorted((PACKAGE_DIR / "dist").glob("logfn-*-py3-none-any.whl"), key=lambda path: path.stat().st_mtime)
    return wheels[-1] if wheels else None


def test_built_wheel_in_a_clean_virtual_environment(tmp_path: Path) -> None:
    wheel = newest_wheel()
    if wheel is None:
        pytest.skip("no wheel in dist/; run `python -m build --wheel` first (CI builds it before pytest)")
    newest_source = max(path.stat().st_mtime for path in SOURCES.rglob("*.py"))
    if wheel.stat().st_mtime < newest_source:
        pytest.skip(f"{wheel.name} is older than the sources; rebuild it")

    environment = tmp_path / "venv"
    venv.create(environment, with_pip=True, clear=True)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run(
        [str(python), "-m", "pip", "install", "--no-index", "--no-deps", "--disable-pip-version-check", str(wheel)],
        check=True,
        capture_output=True,
    )

    workdir = tmp_path / "consumer"
    workdir.mkdir()
    for source in (
        PACKAGE_DIR / "scripts" / "clean_consumer.py",
        PACKAGE_DIR / "tests" / "conformance_harness.py",
        PACKAGE_DIR / "tests" / "conformance" / "redaction-vectors.json",
    ):
        shutil.copy(source, workdir / source.name)

    result = subprocess.run(
        [str(python), "-I", "clean_consumer.py", "conformance_harness.py", "redaction-vectors.json"],
        cwd=workdir,
        capture_output=True,
        text=True,
        env={"PATH": os.environ.get("PATH", ""), "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '"ok": true' in result.stdout
    assert str(environment) in result.stdout or "site-packages" in result.stdout
    print(result.stdout, file=sys.stderr)
