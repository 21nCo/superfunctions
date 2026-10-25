"""Build a fresh wheel and run partition contracts outside the source checkout."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UV = shutil.which('uv')
if UV is None:
    raise SystemExit('uv is required for isolated supported-Python acceptance')


def run(args: list[str], cwd: Path, env: dict[str, str]) -> None:
    subprocess.run(args, cwd=cwd, env=env, check=True, timeout=180)


def main() -> None:
    env = dict(os.environ)
    env.pop('PYTHONPATH', None)
    with tempfile.TemporaryDirectory(prefix='flow-python-memory-wheel-') as temporary:
        base = Path(temporary)
        wheels = base / 'wheels'
        run([sys.executable, '-m', 'build', '--wheel', '--outdir', str(wheels), str(ROOT / 'flowfn/python')], base, env)
        wheel = next(wheels.glob('flowfn-*.whl'))
        for version in ('3.9', '3.11'):
            consumer = base / version
            consumer.mkdir()
            venv = consumer / '.venv'
            run([UV, 'venv', '--python', version, str(venv)], consumer, env)
            python = venv / 'bin/python'
            run([UV, 'pip', 'install', '--python', str(python), f'{wheel}[dev]'], consumer, env)
            test = consumer / 'test_memory_stream_partitions.py'
            shutil.copyfile(ROOT / 'flowfn/python/tests/test_memory_stream_partitions.py', test)
            run([str(python), '-c', 'import flowfn,sys; from pathlib import Path; assert Path(flowfn.__file__).is_relative_to(Path(sys.prefix)); print(flowfn.__file__)'], consumer, env)
            run([str(python), '-m', 'pytest', str(test), '--asyncio-mode=auto', '-q'], consumer, env)
            run([str(python), '-m', 'mypy', '--strict', str(test)], consumer, env)
            print(json.dumps({'python': version, 'wheel': wheel.name, 'focused_tests': 'passed', 'strict_consumer': 'passed'}), flush=True)
    assert not base.exists()
    print(json.dumps({'temporary_consumer_removed': True}), flush=True)


if __name__ == '__main__':
    main()
