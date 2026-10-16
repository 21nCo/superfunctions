import os
import platform
import time
import uuid
from typing import List, Optional

from .adapters.pytest import PytestAdapter
from .core import FrameworkAdapter, RunOptions
from .reporters import ConsoleReporter, Reporter
from .storage import Storage
from .types import EnvironmentInfo, ResultStatus, TestResult, TestRun, TestRunSummary
from .visual import VisualTester


class Runner:
    def __init__(
        self,
        framework: str = "pytest",
        storage: Optional[Storage] = None,
        reporters: Optional[List[Reporter]] = None,
        visual_tester: Optional[VisualTester] = None,
    ):
        self.framework = framework
        self.adapters: List[FrameworkAdapter] = [PytestAdapter()]
        self.storage = storage or Storage()
        self.reporters: List[Reporter] = (
            reporters if reporters is not None else [ConsoleReporter()]
        )
        self.visual_tester = visual_tester

    def _get_adapter(self) -> FrameworkAdapter:
        for adapter in self.adapters:
            if adapter.supports(self.framework):
                return adapter
        raise ValueError(f"Unsupported framework: {self.framework}")

    def add_reporter(self, reporter: Reporter) -> None:
        self.reporters.append(reporter)

    async def run(
        self, pattern: List[str], options: Optional[RunOptions] = None
    ) -> TestRun:
        options = options or RunOptions()
        adapter = self._get_adapter()

        # Discover
        discovery = getattr(adapter, "discover_with_options", None)
        tests = (
            await discovery(pattern, options)
            if discovery
            else await adapter.discover(pattern)
        )

        # Notify reporters of discovery
        # (Could add on_discovery_complete if needed)

        # Run
        start_time = time.monotonic()

        reported = set()

        def completed(result: TestResult) -> None:
            if result.id not in reported:
                reported.add(result.id)
                self._on_test_complete(result)

        results = await adapter.run(tests, options, on_test_complete=completed)

        # Support adapters that return final results without streaming callbacks.
        for result in results:
            completed(result)

        end_time = time.monotonic()

        # Summarize
        passed = sum(1 for r in results if r.status == ResultStatus.PASSED)
        failed = sum(
            1
            for r in results
            if r.status in (ResultStatus.FAILED, ResultStatus.TIMEOUT)
        )
        skipped = sum(1 for r in results if r.status == ResultStatus.SKIPPED)

        # Total duration in ms
        total_duration = (end_time - start_time) * 1000

        summary = TestRunSummary(
            total=len(results),
            passed=passed,
            failed=failed,
            skipped=skipped,
            duration=total_duration,
        )

        run = TestRun(
            id=str(uuid.uuid4()),
            timestamp=time.time(),
            environment=EnvironmentInfo(
                platform=platform.system(),
                python_version=platform.python_version(),
                ci=bool(os.environ.get("CI")),
            ),
            summary=summary,
            results=results,
        )

        # Persistence
        self.storage.save_run(run)

        # Notify reporters of completion
        for reporter in self.reporters:
            reporter.on_run_complete(run)

        return run

    def _on_test_complete(self, result: TestResult) -> None:
        # This will be used by adapters that can report per-test
        for reporter in self.reporters:
            reporter.on_test_complete(result)
