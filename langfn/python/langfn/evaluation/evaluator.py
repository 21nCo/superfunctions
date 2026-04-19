from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from ..client import LangFn
from ..core.errors import ValidationError
from .dataset import DatasetItem, EvaluationDataset
from .metrics import EvaluationMetric, MetricResult, exact_match_metric, normalize_metric_result

EvaluationDatasetItem = DatasetItem


@dataclass
class EvaluationResult:
    accuracy: float
    avg_latency: float
    total_cost: float
    results: List[Dict[str, Any]]

    @property
    def pass_rate(self) -> float:
        return self.accuracy

    @property
    def avg_score(self) -> float:
        if not self.results:
            return 0.0
        return sum(float(result.get("score", 0.0)) for result in self.results) / len(self.results)

    def to_testfn_run(self, model_name: str = "langfn-eval") -> Dict[str, Any]:
        passed = sum(1 for item in self.results if item["passed"])
        return {
            "id": f"langfn-eval-{model_name}",
            "timestamp": time.time(),
            "summary": {
                "total": len(self.results),
                "passed": passed,
                "failed": len(self.results) - passed,
                "skipped": 0,
                "duration": sum(float(item["latency"]) for item in self.results),
            },
            "results": [
                {
                    "id": item["id"],
                    "status": "passed" if item["passed"] else "failed",
                    "duration": item["latency"],
                    "metadata": {
                        "input": item["input"],
                        "expected": item["expected"],
                        "output": item["output"],
                        "metrics": item["metrics"],
                        "trace_id": item.get("trace_id"),
                    },
                }
                for item in self.results
            ],
            "metadata": {
                "accuracy": self.accuracy,
                "avg_latency": self.avg_latency,
                "total_cost": self.total_cost,
            },
        }


@dataclass
class EvaluationCompareResult:
    accuracy: float
    per_model: Dict[str, EvaluationResult]
    best_model: Optional[str]
    testfn_exported: bool


class Evaluator:
    def __init__(self, *, lang: Optional[LangFn] = None):
        self._lang = lang

    async def evaluate(
        self,
        lang: Optional[LangFn],
        dataset: List[EvaluationDatasetItem | Dict[str, Any]],
        metrics: Optional[List[EvaluationMetric]] = None,
        export_hook: Optional[Callable[[Dict[str, Any]], Any]] = None,
        model_name: Optional[str] = None,
    ) -> EvaluationResult:
        resolved_lang = lang or self._lang
        if resolved_lang is None:
            raise ValidationError("Evaluator requires a LangFn instance")

        resolved_dataset = EvaluationDataset.from_items(dataset)
        resolved_metrics = metrics or [exact_match_metric()]
        results: List[Dict[str, Any]] = []
        total_score = 0.0
        total_latency = 0.0
        total_cost = 0.0

        for item in resolved_dataset.items:
            start_time = time.perf_counter()
            response = await resolved_lang.complete(item.input)
            latency = (time.perf_counter() - start_time) * 1000
            output = response.content
            metric_results: Dict[str, Dict[str, float | bool]] = {}
            for metric in resolved_metrics:
                resolved = normalize_metric_result(metric.evaluate(output, item.expected, item))
                metric_results[metric.name] = {"score": resolved.score, "passed": resolved.passed}

            primary = metric_results[resolved_metrics[0].name]
            score = float(primary["score"])
            passed = bool(primary["passed"])
            total_score += score
            total_latency += latency
            total_cost += float(response.cost.total if response.cost is not None else 0.0)
            results.append(
                {
                    "id": item.id,
                    "input": item.input,
                    "output": output,
                    "expected": item.expected,
                    "passed": passed,
                    "score": score,
                    "latency": latency,
                    "trace_id": response.trace_id,
                    "metrics": metric_results,
                }
            )

        evaluation = EvaluationResult(
            accuracy=total_score / len(results),
            avg_latency=total_latency / len(results),
            total_cost=total_cost,
            results=results,
        )

        if export_hook is not None:
            exported = export_hook(evaluation.to_testfn_run(model_name or "langfn-eval"))
            if hasattr(exported, "__await__"):
                await exported

        return evaluation

    async def run(
        self,
        dataset: List[EvaluationDatasetItem | Dict[str, Any]],
        *,
        lang: Optional[LangFn] = None,
        metrics: Optional[List[EvaluationMetric]] = None,
        export_hook: Optional[Callable[[Dict[str, Any]], Any]] = None,
        model_name: Optional[str] = None,
    ) -> EvaluationResult:
        return await self.evaluate(
            lang=lang,
            dataset=dataset,
            metrics=metrics,
            export_hook=export_hook,
            model_name=model_name,
        )

    async def compare(
        self,
        models: List[Dict[str, Any]],
        dataset: List[EvaluationDatasetItem | Dict[str, Any]],
        metrics: Optional[List[EvaluationMetric]] = None,
        export_hook: Optional[Callable[[Dict[str, Any]], Any]] = None,
    ) -> EvaluationCompareResult:
        if not models:
            raise ValidationError("compare() requires at least one model")

        per_model: Dict[str, EvaluationResult] = {}
        for model in models:
            name = str(model["name"])
            per_model[name] = await self.evaluate(
                lang=model["lang"],
                dataset=dataset,
                metrics=metrics,
                export_hook=export_hook,
                model_name=name,
            )

        ordered = sorted(per_model.items(), key=lambda entry: entry[1].accuracy, reverse=True)
        return EvaluationCompareResult(
            accuracy=sum(result.accuracy for result in per_model.values()) / len(per_model),
            per_model=per_model,
            best_model=ordered[0][0] if ordered else None,
            testfn_exported=export_hook is not None,
        )
