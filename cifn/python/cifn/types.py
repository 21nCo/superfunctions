"""Pydantic models and enums for CiFn control plane API."""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

# --- Enums ---


class TriggerType(str, Enum):
    PUSH = "push"
    PULL_REQUEST = "pull_request"
    SCHEDULE = "schedule"
    WORKFLOW_DISPATCH = "workflow_dispatch"


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILURE = "failure"
    SKIPPED = "skipped"


class StepStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILURE = "failure"
    SKIPPED = "skipped"


class StepUsesType(str, Enum):
    CHECKOUT = "checkout"
    CACHE_RESTORE = "cache/restore"
    CACHE_SAVE = "cache/save"
    ARTIFACT_UPLOAD = "artifact/upload"
    ARTIFACT_DOWNLOAD = "artifact/download"
    TESTFN_RUN = "testfn/run"
    HOSTFN_DEPLOY = "hostfn/deploy"


class ErrorCode(str, Enum):
    BAD_REQUEST = "BAD_REQUEST"
    UNAUTHORIZED = "UNAUTHORIZED"
    RUNNER_TOKEN_INVALID = "RUNNER_TOKEN_INVALID"
    PIPELINE_INVALID = "PIPELINE_INVALID"
    RUN_CREATE_FAILED = "RUN_CREATE_FAILED"
    RUN_NOT_FOUND = "RUN_NOT_FOUND"
    RUN_ALREADY_FINISHED = "RUN_ALREADY_FINISHED"
    RUNNER_NOT_FOUND = "RUNNER_NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# --- Pipeline configuration ---


class PipelineRef(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    repo: str
    ref: str
    config_path: Optional[str] = Field(None, alias="configPath")


class TriggerInput(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type: TriggerType
    payload: Optional[Dict[str, Any]] = None


class OnPush(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    branches: List[str]


class OnPullRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    branches: List[str]


class OnSchedule(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    cron: str


class OnTriggers(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    push: Optional[OnPush] = None
    pull_request: Optional[OnPullRequest] = None
    schedule: Optional[List[OnSchedule]] = None
    workflow_dispatch: Optional[Dict[str, Any]] = None


class RunStep(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    run: str
    if_condition: Optional[str] = Field(None, alias="if")


class UsesStep(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    uses: StepUsesType
    with_params: Optional[Dict[str, Any]] = Field(None, alias="with")
    if_condition: Optional[str] = Field(None, alias="if")


# Union for step specs: try RunStep first (has "run"), then UsesStep (has "uses")
StepSpec = Union[RunStep, UsesStep]


class JobSpec(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    runs_on: str = Field(alias="runs-on")
    image: Optional[str] = None
    needs: Optional[List[str]] = None
    if_condition: Optional[str] = Field(None, alias="if")
    env: Optional[Dict[str, str]] = None
    steps: List[Union[RunStep, UsesStep]]


class PipelineSpec(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: Optional[str] = None
    on: OnTriggers
    env: Optional[Dict[str, str]] = None
    jobs: Dict[str, JobSpec]


# --- Runtime objects ---


class Step(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    job_id: str = Field(alias="jobId")
    step_key: str = Field(alias="stepKey")
    status: StepStatus
    started_at: Optional[str] = Field(None, alias="startedAt")
    completed_at: Optional[str] = Field(None, alias="completedAt")


class Job(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    run_id: str = Field(alias="runId")
    job_key: str = Field(alias="jobKey")
    status: JobStatus
    steps: List[Step]
    started_at: Optional[str] = Field(None, alias="startedAt")
    completed_at: Optional[str] = Field(None, alias="completedAt")


class Run(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    pipeline_ref: Optional[PipelineRef] = Field(None, alias="pipelineRef")
    trigger: TriggerInput
    status: RunStatus
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    jobs: List[Job] = []


# --- Response models ---


class CreateRunResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    run_id: str = Field(alias="runId")
    status: RunStatus
    created_at: str = Field(alias="createdAt")


class ListRunsResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    runs: List[Run]
    next_cursor: Optional[str] = Field(None, alias="nextCursor")


class CancelRunResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    run_id: str = Field(alias="runId")
    status: RunStatus


class Artifact(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    file_id: Optional[str] = Field(None, alias="fileId")
    url: Optional[str] = None


class ArtifactList(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    artifacts: List[Artifact]


class JobLogLine(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    line: str
    timestamp: str
    step_key: str = Field(alias="stepKey")


class JobLogs(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    lines: List[JobLogLine]


class RegisterRunnerResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    runner_id: str = Field(alias="runnerId")
    runner_secret: str = Field(alias="runnerSecret")


class HeartbeatResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    job: Optional[Dict[str, Any]] = None
