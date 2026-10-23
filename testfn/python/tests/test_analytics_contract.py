import pytest

from testfn.analytics import AnalyticsEngine, FlakyAnalysis, RunMetrics
from testfn.storage import Storage
from testfn.types import ResultStatus
from testfn.types import TestResult as Result


def test_nearest_rank_percentile_and_timeouts() -> None:
    values = [
        Result(id=str(i), status=ResultStatus.PASSED, duration=i) for i in range(1, 21)
    ]
    assert RunMetrics(values).p95_duration == 19
    assert RunMetrics(values[:2]).p95_duration == 2
    assert (
        RunMetrics([Result(id="slow", status=ResultStatus.TIMEOUT, duration=1)]).failed
        == 1
    )
    assert (
        FlakyAnalysis(
            "x", [Result(id="x", status=ResultStatus.SKIPPED, duration=0)]
        ).flaky_score
        == 0
    )


@pytest.mark.asyncio
async def test_missing_regression_runs_and_invalid_history_limits() -> None:
    storage = Storage("sqlite:///:memory:")
    with pytest.raises(ValueError):
        await AnalyticsEngine(storage).find_regressions("missing", "other")
    with pytest.raises(ValueError):
        storage.get_recent_runs(-1)
    with pytest.raises(ValueError):
        storage.get_test_history("x", -1)
    storage.close()


@pytest.mark.parametrize("status", ["passed", "failed", "skipped", "timeout"])
def test_result_accepts_wire_status(status: str) -> None:
    result = Result.model_validate({"id": "wire", "status": status, "duration": 1})
    assert result.status is ResultStatus(status)
