import asyncio
from pathlib import Path
import pytest
from pydantic import ValidationError
from testfn.adapters.pytest import PytestAdapter
from testfn.core import RunOptions
from testfn.types import ResultStatus


@pytest.mark.asyncio
async def test_exact_ids_phases_globs_and_callbacks(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path("test sample.py").write_text("""import pytest
class TestNested:
    @pytest.mark.parametrize("value", [1, 2])
    def test_pass(self, value): assert value > 0
@pytest.fixture
def broken(): raise RuntimeError("setup error")
def test_setup(broken): pass
@pytest.fixture
def teardown():
    yield
    raise RuntimeError("teardown error")
def test_teardown(teardown): pass
@pytest.mark.skip(reason="skip")
def test_skip(): pass
""")
    adapter = PytestAdapter()
    discovered = await adapter.discover(["*.py"])
    seen = []
    results = await adapter.run(discovered, RunOptions(parallel=2), seen.append)
    assert [row.id for row in results] == [row.id for row in discovered]
    assert len(seen) == 5
    assert [row.status for row in results].count(ResultStatus.PASSED) == 2
    assert [row.status for row in results].count(ResultStatus.FAILED) == 2
    assert [row.status for row in results].count(ResultStatus.SKIPPED) == 1


@pytest.mark.asyncio
async def test_env_retry_timeout_and_cancellation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path("test_run.py").write_text("""import os, time
from pathlib import Path
def test_retry():
    assert os.environ["CUSTOM"] == "correct"
    p=Path("attempt")
    previous=p.exists()
    p.write_text("yes")
    assert previous
def test_slow():
    Path("started").write_text("yes")
    time.sleep(30)
    Path("late").write_text("bad")
""")
    adapter = PytestAdapter()
    tests = await adapter.discover(["test_run.py"])
    retry = await adapter.run(
        tests[:1], RunOptions(retries=1, env={"CUSTOM": "correct"})
    )
    assert retry[0].status == ResultStatus.PASSED
    assert retry[0].metadata["attempts"] == 2
    timeout = await adapter.run(tests[1:], RunOptions(timeout=1))
    assert timeout[0].status == ResultStatus.TIMEOUT
    Path("started").unlink(missing_ok=True)
    task = asyncio.create_task(adapter.run(tests[1:], RunOptions()))
    for _ in range(100):
        if Path("started").exists():
            break
        await asyncio.sleep(0.05)
    assert Path("started").exists()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not Path("late").exists()


@pytest.mark.asyncio
async def test_collection_errors_are_not_empty_success(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path("test_bad.py").write_text("invalid python !!")
    with pytest.raises(RuntimeError, match="pytest exited"):
        await PytestAdapter().discover(["test_bad.py"])
    assert await PytestAdapter().discover(["missing*.py"]) == []
    with pytest.raises(ValueError):
        await PytestAdapter().discover(["--help"])


@pytest.mark.parametrize(
    "kwargs",
    [{"parallel": 0}, {"retries": -1}, {"timeout": 0}, {"timeout": float("nan")}],
)
def test_invalid_execution_limits(kwargs):
    with pytest.raises(ValidationError):
        RunOptions(**kwargs)


@pytest.mark.asyncio
async def test_missing_report_cannot_pass_and_discovery_environment(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    Path("test_report.py").write_text(
        'import os\nassert os.environ["COLLECTION"] == "yes"\ndef test_exit(): os._exit(0)\n'
    )
    adapter = PytestAdapter()
    options = RunOptions(env={"COLLECTION": "yes"})
    tests = await adapter.discover_with_options(["test_report.py"], options)
    with pytest.raises(RuntimeError, match="valid result report"):
        await adapter.run(tests, options)


@pytest.mark.asyncio
async def test_default_run_preserves_session_fixture_scope(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path("test_session.py").write_text("""import pytest
from pathlib import Path
@pytest.fixture(scope="session")
def shared():
    p=Path("session-count")
    p.write_text(str(int(p.read_text())+1) if p.exists() else "1")
    return object()
def test_one(shared): assert shared is not None
def test_two(shared): assert shared is not None
""")
    adapter = PytestAdapter()
    results = await adapter.run(
        await adapter.discover(["test_session.py"]), RunOptions()
    )
    assert all(row.status == "passed" for row in results)
    assert Path("session-count").read_text() == "1"


@pytest.mark.asyncio
async def test_live_completion_before_remaining_suite_finishes(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    Path("test_live.py").write_text("""import time
from pathlib import Path
def test_first(): pass
def test_second():
    for _ in range(100):
        if Path("callback").exists(): return
        time.sleep(.02)
    assert False, "first completion was not streamed"
""")
    adapter = PytestAdapter()
    seen = []

    def completed(result):
        seen.append(result.id)
        Path("callback").write_text("seen")

    tests = await adapter.discover(["test_live.py"])
    rows = await adapter.run(tests, RunOptions(), completed)
    assert all(row.status == "passed" for row in rows)
    assert seen == [row.id for row in rows]


@pytest.mark.asyncio
@pytest.mark.parametrize("parallel", [1, 2])
async def test_project_root_is_preserved_when_running_from_outside(tmp_path, monkeypatch, parallel):
    project = tmp_path / "project"
    project.mkdir()
    (project / "pytest.ini").write_text("[pytest]\n")
    test_file = project / "test_nested.py"
    test_file.write_text("import pytest\nclass TestGroup:\n    @pytest.mark.parametrize('value', [1, 2])\n    def test_ok(self, value): assert value > 0\n")
    monkeypatch.chdir(tmp_path)
    adapter = PytestAdapter()
    tests = await adapter.discover([str(test_file)])
    assert tests[0].id.startswith("test_nested.py::TestGroup::")
    assert all(test.rootdir == str(project) for test in tests)
    seen = []
    results = await adapter.run(tests, RunOptions(parallel=parallel), seen.append)
    assert [result.id for result in results] == [test.id for test in tests]
    assert all(result.status == ResultStatus.PASSED for result in results)
    assert {result.id for result in seen} == {test.id for test in tests}
