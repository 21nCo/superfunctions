"""Storage-backed diagnostics for resources registered on a FlowFn instance."""

import asyncio
import math
import time
from dataclasses import asdict
from typing import Any

from flowfn.monitoring.health import HealthChecker


async def runtime_health(
    adapter: Any,
    queues: dict[str, Any],
    streams: dict[str, Any],
    workflows: list[Any],
    checker: HealthChecker,
    closed: bool,
    timeout: float,
) -> dict[str, Any]:
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Health timeout must be finite and positive")
    result: dict[str, Any] = {
        "healthy": False,
        "timestamp": int(time.time() * 1000),
        "checks": [],
        "adapter": {"type": "unknown", "connected": False, "latency": None},
        "queues": [],
        "streams": [],
        "workflows": [],
    }
    if closed:
        result["checks"].append(
            {"name": "lifecycle", "status": "fail", "message": "FlowFn is closing or closed"}
        )
        return result

    async def collect() -> None:
        baseline = asdict(await checker.check())
        result.update(baseline)
        started = time.monotonic()
        try:
            probe = getattr(adapter, "health_probe", None)
            if probe is None:
                raise RuntimeError("Adapter does not implement health_probe")
            info = await probe()
            result["adapter"] = {**info, "latency": (time.monotonic() - started) * 1000}
            if not info.get("connected"):
                raise RuntimeError("Adapter is disconnected")
            server_time = info["server_time"]
        except Exception as error:
            result["healthy"] = False
            result["adapter"]["connected"] = False
            result["checks"].append({"name": "adapter", "status": "fail", "message": str(error)})
            return

        async def inspect_queue(name: str, queue: Any) -> None:
            try:
                stats = await adapter.get_queue_stats(name)
                result["queues"].append(
                    {
                        "name": name,
                        "healthy": True,
                        **stats.model_dump(),
                        "workers": sum(not task.done() for task in queue._workers),
                    }
                )
            except Exception as error:
                result["healthy"] = False
                result["queues"].append({"name": name, "healthy": False, "error": str(error)})

        async def inspect_stream(name: str) -> None:
            try:
                info = await adapter.get_stream_info(name)
                result["streams"].append({"healthy": True, **info.model_dump()})
            except Exception as error:
                result["healthy"] = False
                result["streams"].append({"name": name, "healthy": False, "error": str(error)})

        async def inspect_workflow(name: str) -> None:
            try:
                executions = await adapter.list_workflow_states(name)
                running = [item for item in executions if item.status.value == "running"]
                stalled = sum(
                    item.lease_expires_at is None or item.lease_expires_at <= server_time
                    for item in running
                )
                result["workflows"].append(
                    {
                        "name": name,
                        "healthy": stalled == 0,
                        "running": len(running),
                        "stalled": stalled,
                    }
                )
                if stalled:
                    result["healthy"] = False
            except Exception as error:
                result["healthy"] = False
                result["workflows"].append({"name": name, "healthy": False, "error": str(error)})

        await asyncio.gather(
            *(inspect_queue(name, queue) for name, queue in list(queues.items())),
            *(inspect_stream(name) for name in list(streams)),
            *(inspect_workflow(name) for name in {workflow.name for workflow in workflows}),
        )

    try:
        await asyncio.wait_for(collect(), timeout)
    except asyncio.TimeoutError:
        result["healthy"] = False
        result["checks"].append(
            {"name": "timeout", "status": "fail", "message": "Health probe deadline exceeded"}
        )
    return result
