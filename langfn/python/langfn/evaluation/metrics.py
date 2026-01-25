from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MetricResult:
    score: float
    passed: bool


def exact_match(*, predicted: str, expected: str) -> MetricResult:
    p = predicted.strip()
    e = expected.strip()
    ok = p == e
    return MetricResult(score=1.0 if ok else 0.0, passed=ok)

