"""Install fresh shared/SendFn wheels and exercise owned SES protocol fixtures."""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix="sendfn-ses-wheel-") as temporary:
    directory = Path(temporary)
    wheels = directory / "wheels"
    wheels.mkdir()
    for package in [
        "packages/python-core",
        "packages/python-fastapi",
        "packages/python-flask",
        "packages/python-sqlalchemy",
        "sendfn/python",
    ]:
        subprocess.run(
            ["uv", "build", "--wheel", "--out-dir", str(wheels), str(root / package)], check=True
        )
    environment = directory / "venv"
    subprocess.run(["uv", "venv", str(environment)], check=True)
    python = environment / "bin/python"
    packages = [
        str(wheel) + ("[dev,email,push,fastapi,flask]" if wheel.name.startswith("sendfn-") else "")
        for wheel in wheels.glob("*.whl")
    ]
    subprocess.run(["uv", "pip", "install", "--python", str(python), *packages], check=True)
    shutil.copytree(root / "sendfn/python/tests", directory / "tests")
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    subprocess.run(
        [
            str(python),
            "-c",
            "import sendfn; assert 'site-packages' in sendfn.__file__, sendfn.__file__; print(sendfn.__file__)",
        ],
        cwd=directory,
        env=env,
        check=True,
    )
    subprocess.run(
        [str(python), "-m", "pytest", "tests", "-q", "--asyncio-mode=auto"],
        cwd=directory,
        env=env,
        check=True,
    )
