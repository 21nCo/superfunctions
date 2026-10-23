from abc import ABC, abstractmethod
from typing import Any, List, Optional

from pydantic import BaseModel, Field

from .types import TestCase, TestResult


class RunOptions(BaseModel):
    parallel: int = Field(default=1, ge=1, le=256)
    timeout: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    retries: int = Field(default=0, ge=0, le=100)
    env: dict[str, str] = Field(default_factory=dict)


class FrameworkAdapter(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        pass

    @abstractmethod
    async def discover(self, pattern: List[str]) -> List[TestCase]:
        """Discover tests matching the pattern."""
        pass

    @abstractmethod
    async def run(
        self,
        tests: List[TestCase],
        options: RunOptions,
        on_test_complete: Optional[Any] = None,
    ) -> List[TestResult]:
        """Run the specified tests."""
        pass

    @abstractmethod
    def supports(self, framework: str) -> bool:
        """Check if this adapter supports the given framework."""
        pass
