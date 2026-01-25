from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from ..client import LangFn


@dataclass
class EvaluationDatasetItem:
    input: str
    expected: str
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class EvaluationResult:
    accuracy: float
    avg_latency: float
    results: List[Dict[str, Any]]


class Evaluator:
    async def evaluate(
        self,
        lang: LangFn,
        dataset: List[EvaluationDatasetItem],
        metrics: Optional[List[str]] = None,
    ) -> EvaluationResult:
        results = []
        total_score = 0.0
        total_latency = 0.0

        for item in dataset:
            start_time = time.perf_counter()
            response = await lang.complete(item.input)
            latency = (time.perf_counter() - start_time) * 1000

            output = response.content
            passed = output.strip() == item.expected.strip()
            score = 1.0 if passed else 0.0

            total_score += score
            total_latency += latency

            results.append({
                "input": item.input,
                "output": output,
                "expected": item.expected,
                "passed": passed,
                "score": score,
                "latency": latency,
            })

        return EvaluationResult(
            accuracy=total_score / len(dataset) if dataset else 0,
            avg_latency=total_latency / len(dataset) if dataset else 0,
            results=results,
        )

    async def compare(
        self,
        models: List[Dict[str, Any]],  # List of {"name": str, "lang": LangFn}
        dataset: List[EvaluationDatasetItem],
    ) -> Dict[str, EvaluationResult]:
        comparisons = {}
        for model in models:
            comparisons[model["name"]] = await self.evaluate(
                lang=model["lang"],
                dataset=dataset,
            )
        return comparisons