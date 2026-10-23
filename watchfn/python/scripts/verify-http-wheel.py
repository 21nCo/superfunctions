"""Build/install local shared and WatchFn wheels; exercise real framework adapters."""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix="watchfn-http-wheel-") as temporary:
    directory = Path(temporary)
    wheels = directory / "wheels"
    wheels.mkdir()
    for package in ["packages/python-core", "packages/python-fastapi", "packages/python-flask", "watchfn/python"]:
        subprocess.run(["uv", "build", "--wheel", "--out-dir", str(wheels), str(root / package)], check=True)
    environment = directory / "venv"
    subprocess.run(["uv", "venv", str(environment)], check=True)
    python = environment / "bin/python"
    subprocess.run(["uv", "pip", "install", "--python", str(python), *map(str, wheels.glob("*.whl")), "pytest", "pytest-asyncio", "httpx", "flask[async]"], check=True)
    shutil.copytree(root / "watchfn/python/tests", directory / "tests")
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    subprocess.run([str(python), "-c", "import watchfn; assert 'site-packages' in watchfn.__file__, watchfn.__file__; print(watchfn.__file__)"], cwd=directory, env=env, check=True)
    subprocess.run([str(python), "-m", "pytest", "tests", "-q"], cwd=directory, env=env, check=True)
