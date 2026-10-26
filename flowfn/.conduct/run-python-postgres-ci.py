"""Run normal Python CI with private, owned PostgreSQL and Redis services."""
from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
initdb, pg_ctl = shutil.which('initdb'), shutil.which('pg_ctl')
if not initdb or not pg_ctl:
    raise SystemExit('Native PostgreSQL initdb and pg_ctl are required')
with tempfile.TemporaryDirectory(prefix='flow-pg-ci-') as temporary:
    directory = Path(temporary)
    data = directory / 'data'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    try:
        subprocess.run([initdb, '-D', str(data), '-U', 'postgres', '-A', 'trust', '--no-locale'], check=True, capture_output=True, timeout=30)
        subprocess.run([pg_ctl, '-D', str(data), '-l', str(directory / 'server.log'), '-o', f"-h 127.0.0.1 -p {port} -k ''", '-w', 'start'], check=True, capture_output=True, timeout=30)
        subprocess.run([sys.executable, str(ROOT / 'flowfn/.conduct/run-python-redis-ci.py'), '--postgres-url', f'postgresql://postgres@127.0.0.1:{port}/postgres'], cwd=ROOT, check=True, timeout=300)
    finally:
        if (data / 'postmaster.pid').exists():
            subprocess.run([pg_ctl, '-D', str(data), '-m', 'immediate', '-w', 'stop'], check=True, capture_output=True, timeout=15)
assert not directory.exists()
print('Owned PostgreSQL process and private directory removed', flush=True)
