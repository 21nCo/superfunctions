from abc import ABC, abstractmethod
from typing import List, Optional, Any
from pydantic import BaseModel
from .types import TestCase, TestResult


class RunOptions(BaseModel):
    parallel: int = 1
    timeout: Optional[float] = None
    retries: int = 0
    env: dict[str, str] = {}


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
