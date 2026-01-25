from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class ResultStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"
    TIMEOUT = "timeout"


class TestError(BaseModel):
    message: str
    stack: Optional[str] = None
    expected: Optional[Any] = None
    actual: Optional[Any] = None
    diff: Optional[str] = None


class Artifact(BaseModel):
    type: str  # 'screenshot', 'video', 'trace', 'log'
    path: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class TestCase(BaseModel):
    id: str
    file: str
    name: str
    suite: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class TestResult(BaseModel):
    id: str
    status: ResultStatus
    duration: float  # in milliseconds
    error: Optional[TestError] = None
    artifacts: List[Artifact] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class CoverageData(BaseModel):
    # Placeholder for coverage data
    pass


class TestRunSummary(BaseModel):
    total: int
    passed: int
    failed: int
    skipped: int
    duration: float
    coverage: Optional[CoverageData] = None


class BrowserInfo(BaseModel):
    name: str
    version: str
    headless: bool


class EnvironmentInfo(BaseModel):
    platform: str
    python_version: Optional[str] = None
    browser: Optional[BrowserInfo] = None
    ci: bool = False


class TestRun(BaseModel):
    id: str
    timestamp: float
    branch: Optional[str] = None
    commit: Optional[str] = None
    author: Optional[str] = None
    environment: EnvironmentInfo
    summary: TestRunSummary
    results: List[TestResult]
