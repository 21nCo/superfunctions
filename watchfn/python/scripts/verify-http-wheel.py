"""Build/install seven local shared, LogFn, SendFn and WatchFn wheels; exercise HTTP and SES."""
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
    for package in ["packages/python-core", "packages/python-fastapi", "packages/python-flask", "packages/python-sqlalchemy", "logfn/python", "sendfn/python", "watchfn/python"]:
        subprocess.run(["uv", "build", "--wheel", "--out-dir", str(wheels), str(root / package)], check=True)
    # Base installation must support stored goals without the optional HTTP dispatcher.
    base = directory / "base"
    subprocess.run(["uv", "venv", "--python", "3.11", str(base)], check=True)
    base_python = base / "bin/python"
    base_wheels = [str(wheel) for wheel in wheels.glob("*.whl") if wheel.name.startswith(("watchfn-", "superfunctions_core-", "superfunctions_sqlalchemy-"))]
    subprocess.run(["uv", "pip", "install", "--python", str(base_python), *base_wheels], check=True)
    base_env = dict(os.environ)
    base_env.pop("PYTHONPATH", None)
    subprocess.run([str(base_python), "-c", "import importlib.util; assert importlib.util.find_spec('httpx') is None; from watchfn import WatchFn; w=WatchFn('base-goals'); w.system_metrics.start=lambda:None; w.process_metrics.start=lambda:None; w.start(); w.business.create_goal(dict(name='sales',target=100,metric='purchase.total',aggregation='sum',period='month',startDate='2026-01-31')); assert w.business.get_goal_progress(dict(name='sales',date='2026-02-14'))['actual']==0; assert w.synthetics.get_uptime(dict(checkId='absent'))['uptime'] is None; w.stop(); print('base-only stored goals and synthetic reports: no httpx installed')"], cwd=directory, env=base_env, check=True)
    environment = directory / "venv"
    subprocess.run(["uv", "venv", "--python", "3.11", str(environment)], check=True)
    python = environment / "bin/python"
    subprocess.run(["uv", "pip", "install", "--python", str(python), *[str(wheel) + ("[dispatch,email,logfn,synthetics]" if wheel.name.startswith("watchfn-") else "") for wheel in wheels.glob("*.whl")], "pytest", "pytest-asyncio"], check=True)
    shutil.copytree(root / "watchfn/python/tests", directory / "tests")
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    subprocess.run([str(python), "-c", "import watchfn, sendfn, logfn; assert 'site-packages' in watchfn.__file__, watchfn.__file__; assert 'site-packages' in sendfn.__file__, sendfn.__file__; assert 'site-packages' in logfn.__file__, logfn.__file__; print(watchfn.__file__, sendfn.__file__)"], cwd=directory, env=env, check=True)
    subprocess.run([str(python), "-m", "pytest", "tests", "-q"], cwd=directory, env=env, check=True)

    if env.get("WATCH_FUNNEL_WIRE_NODE"):
        wire_env = dict(env, WATCH_PYTHON=str(python))
        subprocess.run([env["WATCH_FUNNEL_WIRE_NODE"], str(root / "watchfn/scripts/funnel-cross-language-acceptance.mjs")], cwd=directory, env=wire_env, check=True)
