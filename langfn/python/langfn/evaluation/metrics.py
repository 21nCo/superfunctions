from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..core.errors import ValidationError


@dataclass(frozen=True)
class MetricResult:
    score: float
    passed: bool


@dataclass(frozen=True)
class EvaluationMetric:
    name: str
    evaluate: Callable[[str, str, object], MetricResult | bool | float]


def exact_match(*, predicted: str, expected: str) -> MetricResult:
    passed = predicted.strip() == expected.strip()
    return MetricResult(score=1.0 if passed else 0.0, passed=passed)


def exact_match_metric() -> EvaluationMetric:
    return EvaluationMetric(
        name="exact_match",
        evaluate=lambda predicted, expected, _item: exact_match(predicted=predicted, expected=expected),
    )


def create_metric(name: str, evaluate: Callable[[str, str, object], MetricResult | bool | float]) -> EvaluationMetric:
    if not name.strip():
        raise ValidationError("evaluation metric name must be non-empty")
    return EvaluationMetric(name=name, evaluate=evaluate)


def normalize_metric_result(result: MetricResult | bool | float) -> MetricResult:
    if isinstance(result, MetricResult):
        return result
    if isinstance(result, bool):
        return MetricResult(score=1.0 if result else 0.0, passed=result)
    return MetricResult(score=float(result), passed=float(result) >= 1.0)
