# TestFn Python SDK

Comprehensive self-hosted testing platform for developers.

## Overview

TestFn is a developer-first testing solution that combines test execution, analytics, and visual testing into a single self-hosted platform. This is the Python SDK for TestFn.

## Features

- ✅ **Test Execution**: Integration with `pytest` for discovery and execution.
- ✅ **Storage**: Persistent storage of test runs and results using SQLAlchemy (SQLite default).
- ✅ **Analytics**: Flaky test detection, performance regression analysis, and run metrics.
- ✅ **Reporters**: Console and JSON reporters for real-time and post-run output.
- ✅ **Visual Testing**: Pixel-by-pixel screenshot comparison and diff generation.

## Installation

```bash
pip install testfn
```

## Quick Start

### Basic Test Execution

```python
import asyncio
from testfn import test_fn

async def main():
    # Initialize runner
    runner = test_fn(framework="pytest")

    # Run tests matching a pattern
    run = await runner.run(["tests/**/*.py"])

    print(f"Passed {run.summary.passed} of {run.summary.total} tests")

if __name__ == "__main__":
    asyncio.run(main())
```

### Using Analytics

```python
from testfn import Storage, AnalyticsEngine

async def analyze():
    storage = Storage()
    analytics = AnalyticsEngine(storage)

    # Detect flaky tests
    flaky = await analytics.detect_flaky("tests/test_ui.py::test_login")
    print(f"Flaky Score: {flaky.flaky_score}")
    print(f"Recommendation: {flaky.recommendation}")

    # Find performance regressions
    regressions = await analytics.find_regressions(
        baseline_run_id="run-1",
        current_run_id="run-2"
    )
    for reg in regressions:
        print(f"Test {reg['test_id']} got {reg['change']:.1%} slower")
```

### Visual Testing

```python
from testfn import VisualTester

tester = VisualTester(baseline_dir="baselines", diff_dir="diffs")

# Compare two screenshots
passed, score, diff_path = tester.compare_screenshots(
    current_path="screenshots/current.png",
    name="homepage",
    threshold=0.1
)

if not passed:
    print(f"Visual regression detected! Diff at: {diff_path}")
```

## Development

```bash
# Setup virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -e .[dev]

# Run tests
pytest
```

## License

MIT

## Execution contract

Pytest runs with the current Python interpreter; pytest >=9.0.3 is a runtime
dependency. Pillow >=12.3.0 is required for patched image processing.
Discovery accepts paths, node IDs, and recursive glob patterns. Invalid collection
or a missing/malformed subprocess report raises an error rather than returning a
successful empty run. An unmatched glob returns zero discovered tests. Exact
pytest node IDs preserve class and parameter identities. Discovery records the pytest project root, so execution from a parent directory uses absolute file selectors while preserving those IDs. A single default session requires tests discovered under the same project root. Setup and teardown
failures count as failures.

`RunOptions(env={...}, parallel=1, retries=0, timeout=None)` controls execution.
Environment overrides also apply during collection. `timeout` is seconds per
isolated test attempt, including interpreter startup; `retries` counts additional
attempts after a failure or timeout. Parallel execution uses at most `parallel`
subprocesses. Explicit parallelism, retries, or timeouts isolate each test attempt,
so session/module fixtures run separately in those modes. The default options run
the full selection in one pytest session and preserve normal fixture scope.
Collection has a 60-second limit. Run duration is wall time; isolated result
duration includes startup and retries. `metadata.attempts` records attempts.

Cancellation kills and waits for the active pytest process. On POSIX it also kills
its process group; on Windows child-created grandchildren are not guaranteed to
be terminated. No run is persisted after cancellation or a subprocess protocol
error. Timeout results count as failures in summaries and analytics. Reporters
receive each final result once. Default suite execution streams completion after
each test teardown; isolated retry execution reports after the final attempt. Pytest `addopts` and inherited
`PYTEST_ADDOPTS` are disabled so flags cannot override the selected execution.

## Persistence and visual comparison

Artifacts are associated with both run ID and test ID, so repeated test IDs cannot
share artifacts across runs. New schemas use a composite foreign key. Existing
SQLite databases retain the old nullable `artifact_id` column until an explicit
schema migration; reads and writes use `run_id` plus `result_id`. Back up deployed
databases before migrating constraints. `Storage.close()` releases engine resources.
Runs are saved transactionally; duplicate run IDs raise rather than overwrite.

Visual comparison automatically creates a missing baseline. Existing baselines
are never silently updated. Names are simple filename stems, and symlink output
files are rejected. PNG writes use atomic replacement. Scores preserve mean RGB
difference and additionally detect alpha changes; the larger of RGB and alpha
differences is compared to a finite threshold from 0 to 1. Different image sizes
fail. Baselines and screenshots are trusted local files; this API does not fetch
URLs. The package includes `py.typed` for typed consumers.
