import asyncio
import glob
import inspect
import json
import os
import signal
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional, cast

from ..core import FrameworkAdapter, RunOptions
from ..types import ResultStatus, TestCase, TestError, TestResult


class PytestAdapter(FrameworkAdapter):
    @property
    def name(self) -> str:
        return "pytest"

    def supports(self, framework: str) -> bool:
        return framework == "pytest"

    async def _invoke(
        self,
        args: list[str],
        timeout: Optional[float],
        env: dict[str, str],
        on_result: Optional[Any] = None,
    ) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="testfn-pytest-") as directory:
            report = Path(directory) / "report.json"
            events = Path(directory) / "events.jsonl"
            child_env = {
                **os.environ,
                **env,
                "TESTFN_REPORT": str(report),
                "TESTFN_EVENTS": str(events),
            }
            # Do not inherit pytest options that override discovery/reporting semantics.
            child_env.pop("PYTEST_ADDOPTS", None)
            with tempfile.TemporaryFile() as output:
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "pytest",
                    "-p",
                    "testfn._pytest_plugin",
                    "-o",
                    "addopts=",
                    *args,
                    stdout=output,
                    stderr=output,
                    env=child_env,
                    start_new_session=os.name == "posix",
                )
                offset = 0

                async def drain_events() -> None:
                    nonlocal offset
                    if not on_result or not events.exists():
                        return
                    with events.open(encoding="utf-8") as stream:
                        stream.seek(offset)
                        while line := stream.readline():
                            if not line.endswith("\n"):
                                break
                            offset = stream.tell()
                            row = TestResult.model_validate(json.loads(line))
                            row.metadata["attempts"] = 1
                            callback = on_result(row)
                            if inspect.isawaitable(callback):
                                await callback

                async def observe() -> None:
                    if on_result:
                        while process.returncode is None:
                            await drain_events()
                            await asyncio.sleep(0.02)
                    await process.wait()
                    await drain_events()

                try:
                    await asyncio.wait_for(observe(), timeout)
                except BaseException:
                    try:
                        if os.name == "posix":
                            os.killpg(process.pid, signal.SIGKILL)
                        else:
                            process.kill()
                    except ProcessLookupError:
                        pass
                    await asyncio.shield(process.wait())
                    raise
                output.seek(0, os.SEEK_END)
                output.seek(max(0, output.tell() - 16_384))
                diagnostic = output.read().decode(errors="replace")
            if process.returncode not in (0, 1, 5):
                raise RuntimeError(f"pytest exited {process.returncode}: {diagnostic}")
            try:
                payload = json.loads(report.read_text(encoding="utf-8"))
                if (
                    payload["exitstatus"] != process.returncode
                    or not isinstance(payload["results"], list)
                    or not isinstance(payload["collected"], list)
                ):
                    raise ValueError("invalid protocol fields")
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise RuntimeError(
                    f"pytest did not produce a valid result report: {diagnostic}"
                ) from error
            if process.returncode == 1 and not any(
                row.get("status") == "failed" for row in payload["results"]
            ):
                raise RuntimeError(
                    f"pytest failed without a failing test result: {diagnostic}"
                )
            return cast(dict[str, Any], payload)

    async def discover_with_options(
        self, pattern: list[str], options: RunOptions
    ) -> list[TestCase]:
        return await self.discover(pattern, options.env)

    async def discover(
        self, pattern: list[str], env: Optional[dict[str, str]] = None
    ) -> list[TestCase]:
        paths = []
        for value in pattern:
            if not value or value.startswith("-"):
                raise ValueError(
                    "Test patterns must be nonempty paths or node IDs, not options"
                )
            if "::" not in value and glob.has_magic(value):
                paths.extend(sorted(glob.glob(value, recursive=True)))
            else:
                paths.append(value)
        if pattern and not paths:
            return []
        payload = await self._invoke(
            ["--collect-only", "-q", "--", *dict.fromkeys(paths)], 60, env or {}
        )
        return [TestCase.model_validate(row) for row in payload["collected"]]

    async def run(
        self,
        tests: list[TestCase],
        options: RunOptions,
        on_test_complete: Optional[Any] = None,
    ) -> list[TestResult]:
        if len({test.id for test in tests}) != len(tests):
            raise ValueError("Duplicate test IDs")
        if not tests:
            return []
        def selection(selected: list[TestCase]) -> list[str]:
            roots = {test.rootdir for test in selected if test.rootdir is not None}
            if len(roots) > 1:
                raise ValueError("A pytest session requires tests discovered under the same rootdir")
            root_args = ["--rootdir", next(iter(roots))] if roots else []
            selectors = []
            for test in selected:
                _, separator, suffix = test.id.partition("::")
                selectors.append(str(Path(test.file).resolve()) + (separator + suffix if separator else ""))
            return ["-q", *root_args, "--", *selectors]

        # Preserve pytest session/module fixture semantics for the default suite run.
        # Explicit isolation options use separate attempts below.
        if options.parallel == 1 and options.retries == 0 and options.timeout is None:
            payload = await self._invoke(
                selection(tests),
                None,
                options.env,
                on_test_complete,
            )
            rows = [TestResult.model_validate(row) for row in payload["results"]]
            by_id = {row.id: row for row in rows}
            if len(by_id) != len(rows) or set(by_id) != {test.id for test in tests}:
                raise RuntimeError("pytest did not execute exactly the requested tests")
            ordered = [by_id[test.id] for test in tests]
            for row in ordered:
                row.metadata["attempts"] = 1
            return ordered
        semaphore = asyncio.Semaphore(options.parallel)

        async def execute(test: TestCase) -> TestResult:
            async with semaphore:
                start = time.monotonic()
                for _attempt in range(options.retries + 1):
                    try:
                        payload = await self._invoke(
                            selection([test]), options.timeout, options.env
                        )
                        rows = [
                            TestResult.model_validate(row) for row in payload["results"]
                        ]
                        if len(rows) != 1 or rows[0].id != test.id:
                            raise RuntimeError(
                                f"pytest did not execute exactly the requested test: {test.id}"
                            )
                        result = rows[0]
                    except asyncio.TimeoutError:
                        result = TestResult(
                            id=test.id,
                            status=ResultStatus.TIMEOUT,
                            duration=0,
                            error=TestError(message="pytest attempt timed out"),
                        )
                    if result.status not in (ResultStatus.FAILED, ResultStatus.TIMEOUT):
                        break
                result.duration = (time.monotonic() - start) * 1000
                result.metadata["attempts"] = _attempt + 1
                if on_test_complete:
                    callback = on_test_complete(result)
                    if inspect.isawaitable(callback):
                        await callback
                return result

        tasks = [asyncio.create_task(execute(test)) for test in tests]
        try:
            return list(await asyncio.gather(*tasks))
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
