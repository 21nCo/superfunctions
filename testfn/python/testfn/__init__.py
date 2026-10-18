from typing import Any

from .analytics import AnalyticsEngine, FlakyAnalysis, RunMetrics
from .core import FrameworkAdapter, RunOptions
from .reporters import ConsoleReporter, JsonReporter, Reporter
from .runner import Runner
from .storage import Storage
from .types import (
    Artifact,
    EnvironmentInfo,
    ResultStatus,
    TestCase,
    TestError,
    TestResult,
    TestRun,
    TestRunSummary,
)
from .visual import VisualTester

__all__ = [
    "test_fn",
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


def test_fn(framework: str = "pytest", **kwargs: Any) -> Runner:
    return Runner(framework=framework, **kwargs)
