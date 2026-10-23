from collections.abc import Callable

import pytest

from testfn.core import FrameworkAdapter, RunOptions
from testfn.reporters import Reporter
from testfn.runner import Runner
from testfn.storage import Storage
from testfn.types import ResultStatus
from testfn.types import TestCase as Case
from testfn.types import TestResult as Result


class Adapter(FrameworkAdapter):
    name = "custom"

    def supports(self, framework: str) -> bool:
        return True

    async def discover(self, pattern: list[str]) -> list[Case]:
        return []

    async def run(
        self,
        tests: list[Case],
        options: RunOptions,
        on_test_complete: Callable[[Result], None] | None = None,
    ) -> list[Result]:
        result = Result(id="slow", status=ResultStatus.TIMEOUT, duration=123)
        assert on_test_complete is not None
        on_test_complete(result)
        return [result]


class Capture(Reporter):
    def __init__(self) -> None:
        self.results: list[Result] = []

    def on_test_complete(self, result: Result) -> None:
        self.results.append(result)


@pytest.mark.asyncio
async def test_callback_only_once_and_timeout_is_failure() -> None:
    storage = Storage("sqlite:///:memory:")
    reporter = Capture()
    runner = Runner(storage=storage, reporters=[reporter])
    runner.adapters = [Adapter()]
    result = await runner.run([])
    assert len(reporter.results) == 1
    assert result.summary.failed == 1
    saved = storage.get_run(result.id)
    assert saved is not None
    assert saved.results[0].status == "timeout"
    storage.close()
