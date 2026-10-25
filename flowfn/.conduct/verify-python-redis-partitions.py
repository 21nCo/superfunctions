"""Build a fresh wheel and run Redis partition contracts outside the source checkout."""
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
    for executable in ('node', 'redis-server'):
        if shutil.which(executable) is None:
            raise RuntimeError(executable + ' is required for native acceptance')
    env = dict(os.environ)
    env.pop('PYTHONPATH', None)
    env['FLOWFN_TS_REDIS_MODULE'] = str(ROOT / 'flowfn/typescript/dist/adapters/redis.mjs')
    if not Path(env['FLOWFN_TS_REDIS_MODULE']).exists():
        raise RuntimeError('Build the actual TypeScript Redis adapter before cross-language acceptance')
    source_map = Path(env['FLOWFN_TS_REDIS_MODULE'] + '.map')
    mapped = json.loads(source_map.read_text())
    for name, content in zip(mapped['sources'], mapped['sourcesContent']):
        if name.endswith(('stream/redis-partitions.ts', 'adapters/redis.ts')):
            assert content == (source_map.parent / name).resolve().read_text()
    with tempfile.TemporaryDirectory(prefix='flow-python-redis-wheel-') as temporary:
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
            for name in ('redis_partitions.py', 'redis_partition_scripts.py', 'redis_partition_subscription.py'):
                assert 'flowfn/adapters/' + name in archive.namelist()
        for version in ('3.9', '3.11'):
            consumer = base / version
            consumer.mkdir()
            venv = consumer / '.venv'
            run([UV, 'venv', '--python', version, str(venv)], consumer, env)
            python = venv / 'bin/python'
            run([UV, 'pip', 'install', '--python', str(python), f'{wheel}[dev]'], consumer, env)
            tests = [consumer / name for name in ('test_redis_partitions.py', 'test_owned_wait.py')]
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
