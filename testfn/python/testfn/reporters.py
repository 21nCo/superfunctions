import json
import os
import tempfile
from pathlib import Path

from .types import ResultStatus, TestCase, TestResult, TestRun


class Reporter:
    def on_test_start(self, test: TestCase) -> None:
        pass

    def on_test_complete(self, result: TestResult) -> None:
        pass

    def on_run_complete(self, run: TestRun) -> None:
        pass


class ConsoleReporter(Reporter):
    def on_test_start(self, test: TestCase) -> None:
        print(f"Running {test.id}...", end="\r")

    def on_test_complete(self, result: TestResult) -> None:
        symbol = "✓" if result.status == ResultStatus.PASSED else "✗"
        print(f"{symbol} {result.id} - {result.duration:.2f}ms")
        if result.error:
            print(f"  Error: {result.error.message}")

    def on_run_complete(self, run: TestRun) -> None:
        print("\nTest Run Summary:")
        print(f"Total:   {run.summary.total}")
        print(f"Passed:  {run.summary.passed}")
        print(f"Failed:  {run.summary.failed}")
        print(f"Skipped: {run.summary.skipped}")
        print(f"Duration: {run.summary.duration/1000:.2f}s")


class JsonReporter(Reporter):
    def __init__(self, output_path: str = "report.json"):
        self.output_path = output_path

    def on_run_complete(self, run: TestRun) -> None:
        destination = Path(self.output_path)
        fd, temporary = tempfile.mkstemp(
            prefix=".testfn-report-", dir=destination.parent
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(run.model_dump(mode="json"), stream, indent=2)
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)
        print(f"Report saved to {self.output_path}")
