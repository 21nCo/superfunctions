"""Tests for Pydantic models and enums (TV-TYPE-*)."""

from __future__ import annotations

from typing import List, Union

import pytest
from pydantic import ValidationError

from cifn.types import (
    CreateRunResult,
    JobSpec,
    ListRunsResult,
    OnPush,
    OnTriggers,
    PipelineSpec,
    Run,
    RunStatus,
    RunStep,
    StepStatus,
    StepUsesType,
    TriggerType,
    UsesStep,
)

# --- TV-TYPE-001: Enum values match TypeScript literals ---


def test_trigger_type_enum_values() -> None:
    assert TriggerType.PUSH.value == "push"
    assert TriggerType.PULL_REQUEST.value == "pull_request"
    assert TriggerType.SCHEDULE.value == "schedule"
    assert TriggerType.WORKFLOW_DISPATCH.value == "workflow_dispatch"


def test_run_status_enum_values() -> None:
    assert RunStatus.QUEUED.value == "queued"
    assert RunStatus("queued") == RunStatus.QUEUED


def test_job_status_step_status_enum_values() -> None:
    assert StepStatus.PENDING.value == "pending"
    assert StepStatus.SKIPPED.value == "skipped"


def test_step_uses_type_enum_values() -> None:
    assert StepUsesType.CHECKOUT.value == "checkout"
    assert StepUsesType.ARTIFACT_UPLOAD.value == "artifact/upload"


def test_error_code_enum_values() -> None:
    from cifn.types import ErrorCode

    assert ErrorCode.RUN_NOT_FOUND.value == "RUN_NOT_FOUND"


def test_invalid_enum_value_raises() -> None:
    with pytest.raises(ValueError):
        RunStatus("invalid_status")


# --- TV-TYPE-002: PipelineSpec deserialization from camelCase JSON ---


def test_pipeline_spec_deserialization_from_camel_case() -> None:
    payload = {
        "name": "build-and-test",
        "on": {
            "push": {"branches": ["main"]},
            "workflow_dispatch": {},
        },
        "env": {"NODE_VERSION": "20"},
        "jobs": {
            "build": {
                "runs-on": "default",
                "steps": [
                    {"uses": "checkout"},
                    {"run": "npm ci"},
                    {"uses": "artifact/upload", "with": {"name": "dist", "path": "dist/"}},
                ],
            },
            "test": {
                "runs-on": "default",
                "needs": ["build"],
                "steps": [
                    {"uses": "checkout"},
                    {"uses": "testfn/run", "with": {"config": "vitest.config.ts"}},
                ],
            },
        },
    }
    spec = PipelineSpec.model_validate(payload)
    assert spec.name == "build-and-test"
    assert spec.on.push is not None
    assert spec.on.push.branches == ["main"]
    assert spec.on.workflow_dispatch == {}
    assert len(spec.jobs) == 2
    assert spec.jobs["build"].runs_on == "default"
    assert len(spec.jobs["build"].steps) == 3
    assert isinstance(spec.jobs["build"].steps[0], UsesStep)
    assert isinstance(spec.jobs["build"].steps[1], RunStep)
    assert spec.jobs["test"].needs == ["build"]


# --- TV-TYPE-003: PipelineSpec serialization to camelCase JSON ---


def test_pipeline_spec_serialization_to_camel_case() -> None:
    spec = PipelineSpec(
        name="test",
        on=OnTriggers(push=OnPush(branches=["main"])),
        jobs={"build": JobSpec(runs_on="default", steps=[RunStep(run="npm ci")])},
    )
    # exclude_none=True so optional None fields are excluded (SPEC: "None optional fields excluded")
    dumped = spec.model_dump(mode="json", by_alias=True, exclude_none=True)
    assert dumped["name"] == "test"
    assert "on" in dumped
    assert dumped["on"]["push"]["branches"] == ["main"]
    assert "jobs" in dumped
    assert dumped["jobs"]["build"]["runs-on"] == "default"
    assert dumped["jobs"]["build"]["steps"] == [{"run": "npm ci"}]
    assert "env" not in dumped


# --- TV-TYPE-004: Run deserialization from server response ---


def test_run_deserialization_from_server_response() -> None:
    from cifn.types import JobStatus

    payload = {
        "id": "run-abc-123",
        "pipelineRef": {"repo": "my/repo", "ref": "main"},
        "trigger": {"type": "push", "payload": {"branch": "main"}},
        "status": "running",
        "createdAt": "2026-02-15T10:00:00Z",
        "updatedAt": "2026-02-15T10:01:00Z",
        "jobs": [
            {
                "id": "job-1",
                "runId": "run-abc-123",
                "jobKey": "build",
                "status": "success",
                "steps": [
                    {
                        "id": "step-1",
                        "jobId": "job-1",
                        "stepKey": "step-0",
                        "status": "success",
                        "startedAt": "2026-02-15T10:00:01Z",
                        "completedAt": "2026-02-15T10:00:30Z",
                    }
                ],
                "startedAt": "2026-02-15T10:00:01Z",
                "completedAt": "2026-02-15T10:00:30Z",
            }
        ],
    }
    run = Run.model_validate(payload)
    assert run.id == "run-abc-123"
    assert run.status == RunStatus.RUNNING
    assert run.trigger.type == TriggerType.PUSH
    assert len(run.jobs) == 1
    assert run.jobs[0].job_key == "build"
    assert run.jobs[0].status == JobStatus.SUCCESS
    assert len(run.jobs[0].steps) == 1
    assert run.jobs[0].steps[0].step_key == "step-0"


# --- TV-TYPE-005: Run deserialization with missing optional fields ---


def test_run_deserialization_missing_optional_fields() -> None:
    payload = {
        "id": "run-xyz",
        "trigger": {"type": "workflow_dispatch"},
        "status": "queued",
        "createdAt": "2026-02-15T10:00:00Z",
        "updatedAt": "2026-02-15T10:00:00Z",
    }
    run = Run.model_validate(payload)
    assert run.pipeline_ref is None
    assert run.jobs == []
    assert run.status == RunStatus.QUEUED


# --- TV-TYPE-006: CreateRunResult deserialization ---


def test_create_run_result_deserialization() -> None:
    payload = {
        "runId": "run-new-1",
        "status": "queued",
        "createdAt": "2026-02-15T12:00:00Z",
    }
    result = CreateRunResult.model_validate(payload)
    assert result.run_id == "run-new-1"
    assert result.status == RunStatus.QUEUED
    assert result.created_at == "2026-02-15T12:00:00Z"


# --- TV-TYPE-007: ListRunsResult with pagination ---


def test_list_runs_result_with_pagination() -> None:
    payload = {
        "runs": [
            {
                "id": "r1",
                "trigger": {"type": "push"},
                "status": "success",
                "createdAt": "2026-02-15T10:00:00Z",
                "updatedAt": "2026-02-15T10:01:00Z",
            }
        ],
        "nextCursor": "cursor-abc",
    }
    result = ListRunsResult.model_validate(payload)
    assert len(result.runs) == 1
    assert result.next_cursor == "cursor-abc"


# --- TV-TYPE-008: Models accept both snake_case and camelCase ---


def test_create_run_result_populate_by_name_snake_case() -> None:
    a = CreateRunResult(run_id="r1", status="queued", created_at="2026-01-01T00:00:00Z")
    b = CreateRunResult(runId="r1", status="queued", createdAt="2026-01-01T00:00:00Z")
    assert a.run_id == b.run_id == "r1"
    assert a.status == b.status == RunStatus.QUEUED


# --- TV-TYPE-009: Step discriminated union ---


def test_step_discriminated_union() -> None:
    from pydantic import TypeAdapter

    adapter: TypeAdapter[List[Union[RunStep, UsesStep]]] = TypeAdapter(
        List[Union[RunStep, UsesStep]]
    )
    steps = adapter.validate_python(
        [
            {"run": "npm ci"},
            {"uses": "checkout"},
            {"uses": "artifact/upload", "with": {"name": "dist", "path": "dist/"}},
        ]
    )
    assert isinstance(steps[0], RunStep)
    assert steps[0].run == "npm ci"
    assert isinstance(steps[1], UsesStep)
    assert steps[1].uses == StepUsesType.CHECKOUT
    assert isinstance(steps[2], UsesStep)
    assert steps[2].with_params == {"name": "dist", "path": "dist/"}


# --- Response models (ListRunsResult, CancelRunResult, ArtifactList, JobLogs, etc.) ---


def test_cancel_run_result_deserialization() -> None:
    from cifn.types import CancelRunResult

    payload = {"runId": "run-abc", "status": "cancelled"}
    result = CancelRunResult.model_validate(payload)
    assert result.run_id == "run-abc"
    assert result.status == RunStatus.CANCELLED


def test_artifact_list_deserialization() -> None:
    from cifn.types import ArtifactList

    payload = {"artifacts": [{"name": "dist", "fileId": "file-1"}]}
    result = ArtifactList.model_validate(payload)
    assert len(result.artifacts) == 1
    assert result.artifacts[0].name == "dist"
    assert result.artifacts[0].file_id == "file-1"


def test_job_logs_deserialization() -> None:
    from cifn.types import JobLogs

    payload = {
        "lines": [{"line": "Building...", "timestamp": "2026-02-15T10:00:01Z", "stepKey": "step-0"}]
    }
    result = JobLogs.model_validate(payload)
    assert len(result.lines) == 1
    assert result.lines[0].line == "Building..."
    assert result.lines[0].step_key == "step-0"


def test_register_runner_result_deserialization() -> None:
    from cifn.types import RegisterRunnerResult

    payload = {"runnerId": "runner-1", "runnerSecret": "secret-abc"}
    result = RegisterRunnerResult.model_validate(payload)
    assert result.runner_id == "runner-1"
    assert result.runner_secret == "secret-abc"


def test_heartbeat_result_deserialization() -> None:
    from cifn.types import HeartbeatResult

    payload = {"job": {"runId": "r1", "jobKey": "build", "jobSpec": {}}}
    result = HeartbeatResult.model_validate(payload)
    assert result.job is not None
    assert result.job.get("runId") == "r1"


def test_heartbeat_result_job_none() -> None:
    from cifn.types import HeartbeatResult

    result = HeartbeatResult.model_validate({"job": None})
    assert result.job is None


# --- Missing optional fields default to None ---


def test_missing_optional_fields_default_none() -> None:
    spec = PipelineSpec.model_validate(
        {"name": "minimal", "on": {"push": {"branches": ["main"]}}, "jobs": {}}
    )
    assert spec.env is None
    # Minimal job
    job_payload = {"runs-on": "default", "steps": []}
    job = JobSpec.model_validate(job_payload)
    assert job.image is None
    assert job.needs is None
    assert job.if_condition is None
    assert job.env is None


# --- Negative: missing required field raises ValidationError ---


def test_missing_required_field_raises_validation_error() -> None:
    with pytest.raises(ValidationError):
        CreateRunResult(run_id="r1", status="queued")  # missing created_at
    with pytest.raises(ValidationError):
        PipelineSpec.model_validate({"name": "x"})  # missing on, jobs
    with pytest.raises(ValidationError):
        Run.model_validate(
            {"id": "r1", "status": "queued"}
        )  # missing trigger, createdAt, updatedAt


def test_step_with_neither_run_nor_uses_raises() -> None:
    from pydantic import TypeAdapter

    adapter: TypeAdapter[List[Union[RunStep, UsesStep]]] = TypeAdapter(
        List[Union[RunStep, UsesStep]]
    )
    with pytest.raises(ValidationError):
        adapter.validate_python([{"invalid": "step"}])


# --- Package import (TV-PKG-001, TV-PKG-003 partial for types only) ---


def test_version_import() -> None:
    from cifn import __version__

    assert __version__ == "0.0.1"


def test_types_importable_from_cifn() -> None:
    from cifn import PipelineSpec, Run, RunStatus

    assert Run is not None
    assert PipelineSpec is not None
    assert RunStatus.QUEUED.value == "queued"
