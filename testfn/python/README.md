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
    
    print(f"Pass rate: {run.summary.passed / run.summary.total * 100}%")

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