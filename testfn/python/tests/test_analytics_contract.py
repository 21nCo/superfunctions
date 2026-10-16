import pytest
from testfn.analytics import RunMetrics, AnalyticsEngine, FlakyAnalysis
from testfn.storage import Storage
from testfn.types import TestResult as Result


def test_nearest_rank_percentile_and_timeouts():
    values = [Result(id=str(i), status="passed", duration=i) for i in range(1, 21)]
    assert RunMetrics(values).p95_duration == 19
    assert RunMetrics(values[:2]).p95_duration == 2
    assert RunMetrics([Result(id="slow", status="timeout", duration=1)]).failed == 1
    assert (
        FlakyAnalysis("x", [Result(id="x", status="skipped", duration=0)]).flaky_score
        == 0
    )


@pytest.mark.asyncio
async def test_missing_regression_runs_and_invalid_history_limits():
    storage = Storage("sqlite:///:memory:")
    with pytest.raises(ValueError):
        await AnalyticsEngine(storage).find_regressions("missing", "other")
    with pytest.raises(ValueError):
        storage.get_recent_runs(-1)
    with pytest.raises(ValueError):
        storage.get_test_history("x", -1)
    storage.close()
