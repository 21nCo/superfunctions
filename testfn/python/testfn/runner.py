import time
import uuid
import platform
from typing import List, Optional, Any
from .types import TestRun, TestRunSummary, EnvironmentInfo, TestResult, ResultStatus, TestCase
from .core import RunOptions, FrameworkAdapter
from .adapters.pytest import PytestAdapter
from .storage import Storage
from .reporters import Reporter, ConsoleReporter
from .visual import VisualTester


class Runner:
    def __init__(
        self, 
        framework: str = "pytest", 
        storage: Optional[Storage] = None,
        reporters: Optional[List[Reporter]] = None,
        visual_tester: Optional[VisualTester] = None
    ):
        self.framework = framework
        self.adapters: List[FrameworkAdapter] = [PytestAdapter()]
        self.storage = storage or Storage()
        self.reporters = reporters if reporters is not None else [ConsoleReporter()]
        self.visual_tester = visual_tester

    def _get_adapter(self) -> FrameworkAdapter:
        for adapter in self.adapters:
            if adapter.supports(self.framework):
                return adapter
        raise ValueError(f"Unsupported framework: {self.framework}")

    def add_reporter(self, reporter: Reporter) -> None:
        self.reporters.append(reporter)

    async def run(self, pattern: List[str], options: Optional[RunOptions] = None) -> TestRun:
        options = options or RunOptions()
        adapter = self._get_adapter()

        # Discover
        tests = await adapter.discover(pattern)
        
        # Notify reporters of discovery
        # (Could add on_discovery_complete if needed)

        # Run
        start_time = time.time()
        
        results = await adapter.run(
            tests, 
            options, 
            on_test_complete=self._on_test_complete
        )
        
        # After run, we might have results but we didn't call on_test_complete 
        # for each because PytestAdapter doesn't support it yet via subprocess.
        # So we manually trigger them now if they weren't triggered.
        for result in results:
            for reporter in self.reporters:
                reporter.on_test_complete(result)

        end_time = time.time()

        # Summarize
        passed = sum(1 for r in results if r.status == ResultStatus.PASSED)
        failed = sum(1 for r in results if r.status == ResultStatus.FAILED)
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
                ci=False,
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