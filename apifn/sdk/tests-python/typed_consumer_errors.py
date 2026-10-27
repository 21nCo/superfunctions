"""Misuse mypy must reject: each line's ignore is needed, which mypy --strict (warn_unused_ignores) checks."""

from __future__ import annotations

from example_tasks_sdk import TasksClient


async def misuse(client: TasksClient) -> None:
    await client.get_task(project_id=1, task_id="t")  # type: ignore[arg-type]
    await client.get_task(project_id="p")  # type: ignore[call-arg]
    await client.get_task("p", "t")  # type: ignore[call-arg]
    await client.create_task(project_id="p", body={"title": 1})  # type: ignore[typeddict-item]
    await client.list_tasks(project_id="p", status=["done"])  # type: ignore[list-item]
    task = await client.get_task(project_id="p", task_id="t")
    task["missing"]  # type: ignore[typeddict-item]
    TasksClient(credentials={"unknownScheme": "x"})  # type: ignore[arg-type]
