import pytest
from testfn.core import FrameworkAdapter
from testfn.runner import Runner
from testfn.storage import Storage
from testfn.reporters import Reporter
from testfn.types import TestResult as Result


class Adapter(FrameworkAdapter):
    name = "custom"

    def supports(self, framework):
        return True

    async def discover(self, pattern):
        return []

    async def run(self, tests, options, on_test_complete=None):
        result = Result(id="slow", status="timeout", duration=123)
        on_test_complete(result)
        return [result]


class Capture(Reporter):
    def __init__(self):
        self.results = []

    def on_test_complete(self, result):
        self.results.append(result)


@pytest.mark.asyncio
async def test_callback_only_once_and_timeout_is_failure():
    storage = Storage("sqlite:///:memory:")
    reporter = Capture()
    runner = Runner(storage=storage, reporters=[reporter])
    runner.adapters = [Adapter()]
    result = await runner.run([])
    assert len(reporter.results) == 1
    assert result.summary.failed == 1
    assert storage.get_run(result.id).results[0].status == "timeout"
    storage.close()
