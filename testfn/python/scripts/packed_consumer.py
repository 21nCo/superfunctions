"""Run with an interpreter that installed the wheel, from outside the source tree."""
import asyncio
import json
from importlib.metadata import version
import os
import tempfile
from pathlib import Path

import testfn
from testfn import JsonReporter, RunOptions, Storage, test_fn

async def main():
    assert 'site-packages' in str(Path(testfn.__file__))
    assert Path(testfn.__file__).with_name('py.typed').exists()
    old = Path.cwd()
    with tempfile.TemporaryDirectory(prefix='testfn-packed-') as directory:
        os.chdir(directory)
        try:
            Path('test_case.py').write_text('''import os, pytest
class TestGroup:
    @pytest.mark.parametrize("x", [1,2])
    def test_ok(self,x): assert x > 0 and os.environ["PACKED"] == "yes"
def test_fail(): assert False
''')
            storage = Storage('sqlite:///runs.db')
            runner = test_fn(storage=storage, reporters=[JsonReporter('report.json')])
            run = await runner.run(['test_*.py'], RunOptions(env={'PACKED':'yes'}))
            assert (run.summary.total, run.summary.passed, run.summary.failed) == (3,2,1)
            assert '::TestGroup::' in run.results[0].id
            storage.close()
            reopened = Storage('sqlite:///runs.db')
            assert reopened.get_run(run.id).model_dump() == run.model_dump()
            reopened.close()
            assert json.loads(Path('report.json').read_text())['summary']['failed'] == 1
            print('Installed wheel execution, exact IDs, persistence, reporter and type marker passed:', version('testfn'))
        finally:
            os.chdir(old)

asyncio.run(main())
