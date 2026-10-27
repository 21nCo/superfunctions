"""Type-checked with mypy --strict against the installed package: the generated types are precise."""

from __future__ import annotations

from example_tasks_sdk import (
    ApiFailureKind,
    ApiHttpError,
    ClientFailureObservation,
    GetTaskErrorBody,
    Problem,
    Task,
    TaskPage,
    TasksClient,
    TasksClientCredentials,
    TaskStatus,
    Transport,
    TransportRequest,
    TransportResponse,
    ValidationProblem,
    is_declared_error,
)
from typing_extensions import assert_type


async def transport(request: TransportRequest) -> TransportResponse:
    return TransportResponse(status=204, headers=[])


def observe(event: ClientFailureObservation) -> None:
    assert_type(event["failure"]["kind"], ApiFailureKind)


async def consume() -> None:
    credentials: TasksClientCredentials = {"bearerAuth": "token", "basicAuth": {"username": "ada", "password": "pw"}, "apiKeyQuery": lambda: "k"}
    chosen: Transport = transport
    async with TasksClient(credentials=credentials, transport=chosen, on_failure=observe, timeout=5.0, retry={"max_attempts": 2}) as client:
        task = await client.get_task(project_id="p", task_id="t")
        assert_type(task, Task)
        status: TaskStatus = task["status"]
        assert status in ("open", "closed")
        page = await client.list_tasks(project_id="p", tags=["a"], status=["open"], filter={"owner": "me"}, limit=10, request_options={"timeout": 1.0})
        assert_type(page, TaskPage)
        assert_type(page["items"], list[Task])
        assert_type(await client.export_tasks(project_id="p"), str)
        assert_type(await client.download_attachment(project_id="p", task_id="t"), bytes)
        assert_type(await client.delete_task(project_id="p", task_id="t"), None)
        created = await client.create_task(project_id="p", body={"title": "Write"}, idempotency_key="k")
        assert_type(created, Task)
        try:
            await client.get_task(project_id="p", task_id="missing")
        except ApiHttpError as error:
            if is_declared_error(error, "tasks.get"):
                assert_type(error.body, GetTaskErrorBody)
                problem: Problem = error.body
                assert problem["title"]
            if is_declared_error(error, "tasks.create"):
                body: Problem | ValidationProblem = error.body
                assert body["status"]

