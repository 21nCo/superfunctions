import statistics
from typing import List, Dict, Any, Optional
from .types import TestRun, TestResult, ResultStatus
from .storage import Storage

class RunMetrics:
    def __init__(self, results: List[TestResult]):
        self.total = len(results)
        self.passed = sum(1 for r in results if r.status == ResultStatus.PASSED)
        self.failed = sum(1 for r in results if r.status == ResultStatus.FAILED)
        self.success_rate = (self.passed / self.total) * 100 if self.total > 0 else 0
        
        durations = [r.duration for r in results]
        if durations:
            self.avg_duration = sum(durations) / len(durations)
            self.p50_duration = statistics.median(durations)
            self.p95_duration = sorted(durations)[int(len(durations) * 0.95)] if len(durations) >= 20 else self.avg_duration
        else:
            self.avg_duration = 0
            self.p50_duration = 0
            self.p95_duration = 0

class FlakyAnalysis:
    def __init__(self, test_id: str, results: List[TestResult]):
        self.test_id = test_id
        recent_results = [r.status == ResultStatus.PASSED for r in results]
        self.pass_rate = sum(recent_results) / len(recent_results) if recent_results else 0
        
        # Simple flaky score: if pass rate is between 20% and 80%, it's likely flaky
        self.flaky_score = 0
        if 0.2 < self.pass_rate < 0.8:
            self.flaky_score = 1 - abs(self.pass_rate - 0.5) * 2
        
        if self.flaky_score > 0.7:
            self.recommendation = "quarantine"
        elif self.flaky_score > 0.4:
            self.recommendation = "investigate"
        else:
            self.recommendation = "stable"

class AnalyticsEngine:
    def __init__(self, storage: Storage):
        self.storage = storage

    async def compute_metrics(self, run_id: str) -> RunMetrics:
        run = self.storage.get_run(run_id)
        if not run:
            raise ValueError(f"Run not found: {run_id}")
        return RunMetrics(run.results)

    async def detect_flaky(self, test_id: str, window_size: int = 10) -> FlakyAnalysis:
        history = self.storage.get_test_history(test_id, limit=window_size)
        return FlakyAnalysis(test_id, history)

    async def find_regressions(self, baseline_run_id: str, current_run_id: str) -> List[Dict[str, Any]]:
        baseline = self.storage.get_run(baseline_run_id)
        current = self.storage.get_run(current_run_id)
        
        if not baseline or not current:
            return []
        
        regressions = []
        baseline_map = {r.id: r for r in baseline.results}
        
        for r in current.results:
            b = baseline_map.get(r.id)
            if not b:
                continue
            
            if b.duration > 0:
                change = (r.duration - b.duration) / b.duration
                if change > 0.2 and (r.duration - b.duration) > 100:
                    regressions.append({
                        "test_id": r.id,
                        "baseline_duration": b.duration,
                        "current_duration": r.duration,
                        "change": change,
                        "significant": change > 0.5
                    })
        return regressions
