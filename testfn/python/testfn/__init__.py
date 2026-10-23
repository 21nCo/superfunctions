from .types import (
    ResultStatus,
    TestError,
    Artifact,
    TestCase,
    TestResult,
    TestRunSummary,
    EnvironmentInfo,
    TestRun,
)
from .core import RunOptions, FrameworkAdapter
from .runner import Runner
from .storage import Storage
from .analytics import AnalyticsEngine, RunMetrics, FlakyAnalysis
from .reporters import Reporter, ConsoleReporter, JsonReporter
from .visual import VisualTester

__all__ = [
    "ResultStatus",
    "TestError",
    "Artifact",
    "TestCase",
    "TestResult",
    "TestRunSummary",
    "EnvironmentInfo",
    "TestRun",
    "RunOptions",
    "FrameworkAdapter",
    "Runner",
    "Storage",
    "AnalyticsEngine",
    "RunMetrics",
    "FlakyAnalysis",
    "Reporter",
    "ConsoleReporter",
    "JsonReporter",
    "VisualTester",
]

def test_fn(framework: str = "pytest", **kwargs):
    return Runner(framework=framework, **kwargs)