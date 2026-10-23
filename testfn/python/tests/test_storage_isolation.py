from pathlib import Path

from testfn.storage import Storage
from testfn.types import (
    Artifact,
    EnvironmentInfo,
    ResultStatus,
)
from testfn.types import (
    TestResult as Result,
)
from testfn.types import (
    TestRun as Run,
)
from testfn.types import (
    TestRunSummary as Summary,
)


def test_artifacts_isolated_for_same_test_across_runs(tmp_path: Path) -> None:
    database = f"sqlite:///{tmp_path}/runs.db"
    store = Storage(database)
    for i in range(2):
        store.save_run(
            Run(
                id=str(i),
                timestamp=i,
                environment=EnvironmentInfo(platform="test"),
                summary=Summary(total=1, passed=1, failed=0, skipped=0, duration=1),
                results=[
                    Result(
                        id="same-test",
                        status=ResultStatus.PASSED,
                        duration=1,
                        artifacts=[Artifact(type="log", path=f"run-{i}.log")],
                    )
                ],
            )
        )
    store.close()
    store = Storage(database)
    first, second = store.get_run("0"), store.get_run("1")
    assert first is not None and second is not None
    assert first.results[0].artifacts[0].path == "run-0.log"
    assert second.results[0].artifacts[0].path == "run-1.log"
    assert [
        len(result.artifacts) for result in store.get_test_history("same-test")
    ] == [1, 1]
    store.close()
