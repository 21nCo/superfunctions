"""CiFn HTTP client and configuration."""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import httpx
from pydantic import BaseModel, ConfigDict

from cifn._sync import run_sync
from cifn.errors import (
    CiFnConnectionError,
    CiFnError,
    raise_for_error,
)
from cifn.types import (
    ArtifactList,
    CancelRunResult,
    CreateRunResult,
    HeartbeatResult,
    JobLogs,
    ListRunsResult,
    PipelineRef,
    PipelineSpec,
    RegisterRunnerResult,
    Run,
    RunStatus,
    TriggerInput,
)


class CiFnConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    base_url: str = "http://localhost:3100"
    api_key: Optional[str] = None
    token: Optional[str] = None
    timeout: float = 30.0
    verify_ssl: bool = True

    @property
    def effective_token(self) -> Optional[str]:
        """Return api_key or token; api_key takes precedence."""
        return self.api_key or self.token

    def __repr__(self) -> str:
        safe = self.model_dump()
        if safe.get("api_key"):
            safe["api_key"] = "***"
        if safe.get("token"):
            safe["token"] = "***"
        return f"CiFnConfig({safe})"


def create_cifn(config: CiFnConfig) -> "CiFnClient":
    """Create a CiFn client instance."""
    return CiFnClient(config)


class CiFnClient:
    """Async HTTP client for the CiFn control plane API."""

    def __init__(
        self,
        config: CiFnConfig,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self._config = config
        self._http = httpx.AsyncClient(
            base_url=config.base_url.rstrip("/"),
            timeout=config.timeout,
            verify=config.verify_ssl,
            transport=transport,
        )

    def _auth_headers(self) -> Dict[str, str]:
        h: Dict[str, str] = {}
        if self._config.effective_token:
            h["Authorization"] = f"Bearer {self._config.effective_token}"
        return h

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        use_auth: bool = True,
    ) -> Dict[str, Any]:
        request_headers = self._auth_headers() if use_auth else {}
        if headers:
            request_headers.update(headers)
        req = self._http.build_request(
            method, path, json=json, params=params, headers=request_headers or None
        )
        try:
            resp = await self._http.send(req)
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            raise CiFnConnectionError(str(e)) from e
        try:
            body = resp.json()
        except Exception as e:
            raise CiFnError(
                code="INTERNAL_ERROR",
                message="Invalid JSON response",
                http_status=resp.status_code,
            ) from e
        if not isinstance(body, dict) or "ok" not in body:
            raise CiFnError(
                code="INTERNAL_ERROR",
                message="Invalid response envelope",
                http_status=resp.status_code,
            )
        if body.get("ok") is True:
            return body.get("data") or {}
        err = body.get("error") or {}
        raise_for_error(
            code=err.get("code", "INTERNAL_ERROR"),
            message=err.get("message", "Unknown error"),
            details=err.get("details"),
            http_status=resp.status_code,
        )

    async def create_run(
        self,
        trigger: TriggerInput,
        pipeline_spec: Optional[PipelineSpec] = None,
        pipeline_ref: Optional[PipelineRef] = None,
    ) -> CreateRunResult:
        """POST /api/v1/runs"""
        payload: Dict[str, Any] = {
            "trigger": trigger.model_dump(mode="json", by_alias=True, exclude_none=True)
        }
        if pipeline_spec is not None:
            payload["pipelineSpec"] = pipeline_spec.model_dump(
                mode="json", by_alias=True, exclude_none=True
            )
        if pipeline_ref is not None:
            payload["pipelineRef"] = pipeline_ref.model_dump(
                mode="json", by_alias=True, exclude_none=True
            )
        data = await self._request("POST", "/api/v1/runs", json=payload)
        return CreateRunResult.model_validate(data)

    async def list_runs(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
        status: Optional[RunStatus] = None,
    ) -> ListRunsResult:
        """GET /api/v1/runs"""
        clamped = max(1, min(100, limit))
        params: Dict[str, Any] = {"limit": clamped}
        if cursor is not None:
            params["cursor"] = cursor
        if status is not None:
            params["status"] = status.value
        data = await self._request("GET", "/api/v1/runs", params=params)
        return ListRunsResult.model_validate(data)

    async def get_run(self, run_id: str) -> Run:
        """GET /api/v1/runs/:runId"""
        data = await self._request("GET", f"/api/v1/runs/{run_id}")
        return Run.model_validate(data)

    async def cancel_run(self, run_id: str) -> CancelRunResult:
        """POST /api/v1/runs/:runId/cancel"""
        data = await self._request("POST", f"/api/v1/runs/{run_id}/cancel")
        return CancelRunResult.model_validate(data)

    async def get_job_logs(self, run_id: str, job_key: str) -> JobLogs:
        """GET /api/v1/runs/:runId/jobs/:jobKey/logs"""
        data = await self._request("GET", f"/api/v1/runs/{run_id}/jobs/{job_key}/logs")
        return JobLogs.model_validate(data)

    async def get_artifacts(self, run_id: str) -> ArtifactList:
        """GET /api/v1/runs/:runId/artifacts"""
        data = await self._request("GET", f"/api/v1/runs/{run_id}/artifacts")
        return ArtifactList.model_validate(data)

    async def register_runner(
        self,
        token: str,
        labels: Optional[list[str]] = None,
    ) -> RegisterRunnerResult:
        """POST /api/v1/runners/register"""
        payload: Dict[str, Any] = {"token": token}
        if labels is not None:
            payload["labels"] = labels
        data = await self._request("POST", "/api/v1/runners/register", json=payload)
        return RegisterRunnerResult.model_validate(data)

    async def runner_heartbeat(
        self,
        runner_id: str,
        runner_secret: str,
    ) -> HeartbeatResult:
        """POST /api/v1/runners/heartbeat"""
        data = await self._request(
            "POST",
            "/api/v1/runners/heartbeat",
            json={"runnerId": runner_id},
            headers={"Authorization": f"Bearer {runner_secret}"},
        )
        return HeartbeatResult.model_validate(data)

    async def health(self) -> bool:
        """GET /health. Returns True if server is healthy, False otherwise. No auth."""
        try:
            resp = await self._http.get("/health")
            body = resp.json()
            return isinstance(body, dict) and body.get("ok") is True
        except Exception:
            return False

    # --- Sync wrappers ---

    def create_run_sync(
        self,
        trigger: TriggerInput,
        pipeline_spec: Optional[PipelineSpec] = None,
        pipeline_ref: Optional[PipelineRef] = None,
    ) -> CreateRunResult:
        """Synchronous wrapper for create_run."""
        return run_sync(self.create_run(trigger, pipeline_spec, pipeline_ref))

    def list_runs_sync(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
        status: Optional[RunStatus] = None,
    ) -> ListRunsResult:
        """Synchronous wrapper for list_runs."""
        return run_sync(self.list_runs(limit, cursor, status))

    def get_run_sync(self, run_id: str) -> Run:
        """Synchronous wrapper for get_run."""
        return run_sync(self.get_run(run_id))

    def cancel_run_sync(self, run_id: str) -> CancelRunResult:
        """Synchronous wrapper for cancel_run."""
        return run_sync(self.cancel_run(run_id))

    def get_job_logs_sync(self, run_id: str, job_key: str) -> JobLogs:
        """Synchronous wrapper for get_job_logs."""
        return run_sync(self.get_job_logs(run_id, job_key))

    def get_artifacts_sync(self, run_id: str) -> ArtifactList:
        """Synchronous wrapper for get_artifacts."""
        return run_sync(self.get_artifacts(run_id))

    def register_runner_sync(
        self,
        token: str,
        labels: Optional[list[str]] = None,
    ) -> RegisterRunnerResult:
        """Synchronous wrapper for register_runner."""
        return run_sync(self.register_runner(token, labels))

    def runner_heartbeat_sync(
        self,
        runner_id: str,
        runner_secret: str,
    ) -> HeartbeatResult:
        """Synchronous wrapper for runner_heartbeat."""
        return run_sync(self.runner_heartbeat(runner_id, runner_secret))

    def health_sync(self) -> bool:
        """Synchronous wrapper for health."""
        return run_sync(self.health())

    async def __aenter__(self) -> "CiFnClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self._http.aclose()

    def close(self) -> None:
        """Close the underlying HTTP client. Prefer `async with` when possible."""

        async def _aclose() -> None:
            await self._http.aclose()

        try:
            asyncio.run(_aclose())
        except RuntimeError:
            pass
