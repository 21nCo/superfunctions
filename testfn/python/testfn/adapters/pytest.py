import asyncio
import os
import tempfile
import xml.etree.ElementTree as ET
from typing import List, Optional, Any
from ..core import FrameworkAdapter, RunOptions
from ..types import TestCase, TestResult, ResultStatus, TestError


class PytestAdapter(FrameworkAdapter):
    @property
    def name(self) -> str:
        return "pytest"

    def supports(self, framework: str) -> bool:
        return framework == "pytest"

    async def discover(self, pattern: List[str]) -> List[TestCase]:
        cmd = ["pytest", "--collect-only", "-q"] + pattern

        process = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await process.communicate()

        test_cases = []
        output = stdout.decode().strip()

        # Pytest -q output is one nodeid per line
        for line in output.split("\n"):
            line = line.strip()
            if not line or "no tests collected" in line:
                continue

            # Filter out non-test lines (sometimes pytest prints extra info even in quiet mode)
            if "::" in line or line.endswith(".py"):
                # Basic nodeid parsing
                parts = line.split("::")
                file_path = parts[0]
                name = parts[-1] if len(parts) > 1 else "unknown"

                test_cases.append(
                    TestCase(
                        id=line,
                        file=file_path,
                        name=name,
                    )
                )
        return test_cases

    async def run(
        self,
        tests: List[TestCase],
        options: RunOptions,
        on_test_complete: Optional[Any] = None,
    ) -> List[TestResult]:
        if not tests:
            return []

        # Create a temp file for JUnit XML output
        fd, temp_xml = tempfile.mkstemp(suffix=".xml")
        os.close(fd)

        test_ids = [t.id for t in tests]
        cmd = ["pytest", f"--junitxml={temp_xml}", "-o", "junit_family=xunit2", "-q"] + test_ids

        try:
            process = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await process.communicate()

            # Parse results
            # with open(temp_xml, 'r') as f:
            #    print(f"XML: {f.read()}")
            return self._parse_junit_xml(temp_xml)
        finally:
            if os.path.exists(temp_xml):
                os.remove(temp_xml)

    def _parse_junit_xml(self, xml_path: str) -> List[TestResult]:
        results = []
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()

            # Handling both single testsuite and testsuites
            testcases = root.findall(".//testcase")

            for testcase in testcases:
                file_path = testcase.get("file")
                classname = testcase.get("classname")
                name = testcase.get("name")

                if not file_path and classname:
                    # Reconstruct file path from classname (heuristic)
                    file_path = classname.replace(".", "/") + ".py"

                # Check status
                status = ResultStatus.PASSED
                error = None

                failure = testcase.find("failure")
                error_elem = testcase.find("error")
                skipped = testcase.find("skipped")

                if failure is not None:
                    status = ResultStatus.FAILED
                    error = TestError(
                        message=failure.get("message", "Test failed"), stack=failure.text
                    )
                elif error_elem is not None:
                    status = ResultStatus.FAILED
                    error = TestError(
                        message=error_elem.get("message", "Test error"), stack=error_elem.text
                    )
                elif skipped is not None:
                    status = ResultStatus.SKIPPED

                duration = float(testcase.get("time", "0")) * 1000  # convert to ms

                # Construct a simplified ID for now
                result_id = f"{file_path}::{name}"

                results.append(
                    TestResult(id=result_id, status=status, duration=duration, error=error)
                )

        except ET.ParseError:
            pass  # Handle error

        return results
