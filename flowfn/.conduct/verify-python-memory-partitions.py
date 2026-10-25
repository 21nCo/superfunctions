"""Build a fresh wheel and run partition contracts outside the source checkout."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

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
        source = base / 'source'
        shutil.copytree(ROOT / 'flowfn/python', source, ignore=shutil.ignore_patterns(
            'build', 'dist', '*.egg-info', '__pycache__', '.venv', '.mypy_cache',
            '.pytest_cache', '.ruff_cache', '.coverage',
        ))
        run([sys.executable, '-m', 'build', '--wheel', '--outdir', str(wheels), str(source)], base, env)
        wheel = next(wheels.glob('flowfn-*.whl'))
        with ZipFile(wheel) as archive:
            assert 'flowfn/adapters/memory_stream.py' in archive.namelist()
            assert 'flowfn/adapters/memory_partitions.py' not in archive.namelist()
        for version in ('3.9', '3.11'):
            consumer = base / version
            consumer.mkdir()
            venv = consumer / '.venv'
            run([UV, 'venv', '--python', version, str(venv)], consumer, env)
            python = venv / 'bin/python'
            run([UV, 'pip', 'install', '--python', str(python), f'{wheel}[dev]'], consumer, env)
            tests = [consumer / name for name in ('test_memory_stream_partitions.py', 'test_memory_stream_receipts.py')]
            for test in tests:
                shutil.copyfile(ROOT / 'flowfn/python/tests' / test.name, test)
            run([str(python), '-c', 'import flowfn,sys; from pathlib import Path; assert Path(flowfn.__file__).is_relative_to(Path(sys.prefix)); print(flowfn.__file__)'], consumer, env)
            run([str(python), '-m', 'pytest', *[str(test) for test in tests], '--asyncio-mode=auto', '-q'], consumer, env)
            run([str(python), '-m', 'mypy', '--strict', *[str(test) for test in tests]], consumer, env)
            print(json.dumps({'python': version, 'wheel': wheel.name, 'focused_tests': 'passed', 'strict_consumer': 'passed'}), flush=True)
    assert not base.exists()
    print(json.dumps({'temporary_consumer_removed': True}), flush=True)


if __name__ == '__main__':
    main()
