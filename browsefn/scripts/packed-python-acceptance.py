#!/usr/bin/env python3
"""Build local prerequisite wheels and test an isolated installed BrowseFn SDK."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--python', default='3.12')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
env = {key: value for key, value in os.environ.items() if key not in ('PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV')}

def run(*command, cwd):
    subprocess.run(command, cwd=cwd, env=env, check=True)

with tempfile.TemporaryDirectory(prefix='browsefn-wheel-') as temporary:
    consumer = Path(temporary)
    wheels = consumer / 'wheels'
    for package in ('packages/python-core', 'packages/python-sqlalchemy', 'browsefn/python'):
        run('uv', 'build', '--wheel', '--out-dir', str(wheels), str(root / package), cwd=consumer)
    run('uv', 'venv', '--python', args.python, str(consumer / 'venv'), cwd=consumer)
    python = str(consumer / 'venv/bin/python')
    run('uv', 'pip', 'install', '--python', python, 'pytest', 'pytest-asyncio',
        *(str(path) for path in sorted(wheels.glob('*.whl'))), cwd=consumer)
    # Preserve fixture-relative paths, but copy no Python package implementation.
    tests = consumer / 'browsefn/python/tests'
    shutil.copytree(root / 'browsefn/python/tests', tests, ignore=shutil.ignore_patterns('__pycache__'))
    for relative in ('browsefn/README.md', 'browsefn/scripts/verify-release.mjs',
                     'browsefn/typescript/src/core/provider-registry.ts'):
        target = consumer / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / relative, target)
    (tests / 'test_installed_origin.py').write_text('''from pathlib import Path
import browsefn
import superfunctions
import superfunctions_sqlalchemy

def test_installed_origins():
    for module in (browsefn, superfunctions, superfunctions_sqlalchemy):
        assert "site-packages" in str(Path(module.__file__).resolve())
''')
    run(python, '-m', 'pytest', str(tests), '-q', cwd=consumer)
