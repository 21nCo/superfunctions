import pytest
import os
import shutil
from testfn.runner import Runner
from testfn.types import ResultStatus
from testfn.storage import Storage
from testfn.analytics import AnalyticsEngine


@pytest.mark.asyncio
async def test_runner_execution():
    # Use a temporary DB for testing
    db_path = "test_testfn.db"
    if os.path.exists(db_path):
        os.remove(db_path)
    
    storage = Storage(database_url=f"sqlite:///{db_path}")
    runner = Runner(storage=storage)

    # Path to fixture
    fixture_path = "tests/fixtures/dummy.py"

    # Ensure fixture exists
    assert os.path.exists(fixture_path), f"Fixture not found at {os.path.abspath(fixture_path)}"

    run_result = await runner.run([fixture_path])

    assert run_result.summary.total == 3
    assert run_result.summary.passed == 1
    assert run_result.summary.failed == 1
    assert run_result.summary.skipped == 1

    # Verify results
    results_map = {r.id.split("::")[-1]: r for r in run_result.results}

    assert "test_success" in results_map
    assert results_map["test_success"].status == ResultStatus.PASSED

    # Verify storage
    saved_run = storage.get_run(run_result.id)
    assert saved_run is not None
    assert saved_run.summary.total == 3

    # Verify analytics
    analytics = AnalyticsEngine(storage)
    metrics = await analytics.compute_metrics(run_result.id)
    assert metrics.total == 3
    assert metrics.passed == 1
    assert metrics.success_rate == (1/3) * 100

    # Cleanup
    if os.path.exists(db_path):
        os.remove(db_path)

@pytest.mark.asyncio
async def test_flaky_detection():
    db_path = "test_flaky.db"
    if os.path.exists(db_path):
        os.remove(db_path)
    
    storage = Storage(database_url=f"sqlite:///{db_path}")
    analytics = AnalyticsEngine(storage)
    
    # Manually save some runs to simulate history
    from testfn.types import TestRun, TestRunSummary, EnvironmentInfo, TestResult
    import time
    import uuid

    test_id = "test_flaky_id"
    
    for i in range(10):
        status = ResultStatus.PASSED if i % 2 == 0 else ResultStatus.FAILED
        run = TestRun(
            id=str(uuid.uuid4()),
            timestamp=time.time(),
            environment=EnvironmentInfo(platform="test"),
            summary=TestRunSummary(total=1, passed=1 if status == ResultStatus.PASSED else 0, failed=1 if status == ResultStatus.FAILED else 0, skipped=0, duration=100),
            results=[TestResult(id=test_id, status=status, duration=100)]
        )
        storage.save_run(run)
    
    flaky = await analytics.detect_flaky(test_id)
    assert flaky.flaky_score > 0.5
    assert flaky.recommendation in ["investigate", "quarantine"]

    # Cleanup
    if os.path.exists(db_path):
        os.remove(db_path)