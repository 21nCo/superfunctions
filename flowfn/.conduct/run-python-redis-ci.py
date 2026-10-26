"""Run the normal Python CI command with one owned standalone Redis service."""
from __future__ import annotations

import os
import argparse
import sys
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=ROOT / 'flowfn/python')
parser.add_argument('--tests', nargs='+')
parser.add_argument('--postgres-url')
args = parser.parse_args()
redis = shutil.which('redis-server')
if redis is None:
    raise SystemExit('Native redis-server is required')
with tempfile.TemporaryDirectory(prefix='flow-redis-ci-') as temporary:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    with (Path(temporary) / 'redis.log').open('wb') as log:
        process = subprocess.Popen([redis, '--bind', '127.0.0.1', '--port', str(port),
            '--save', '', '--appendonly', 'no', '--dir', temporary], stdout=log, stderr=log)
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError('Owned Redis exited during startup')
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.05):
                        break
                except OSError:
                    time.sleep(.02)
            else:
                raise RuntimeError('Owned Redis startup timed out')
            env = dict(os.environ, FLOWFN_REDIS_URL=f'redis://127.0.0.1:{port}')
            env.pop('FLOWFN_POSTGRES_URL', None)
            if args.postgres_url:
                env['FLOWFN_POSTGRES_URL'] = args.postgres_url
            command = ([sys.executable, '-m', 'pytest', *args.tests, '--no-cov', '-q'] if args.tests
                       else ['node', 'scripts/ci-run-python-package.mjs', 'flowfn/python'])
            subprocess.run(command, cwd=args.source_root if args.tests else ROOT,
                           env=env, check=True, timeout=240)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    assert process.poll() is not None
assert not Path(temporary).exists()
print('Owned Redis process and private directory removed', flush=True)
