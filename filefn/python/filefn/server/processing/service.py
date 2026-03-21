import asyncio
from datetime import datetime, timezone
import random
from typing import Any, Callable, Dict, List, Optional, Protocol

from pydantic import BaseModel

from .. import errors
from ..events import (
    FileFnEventEmitter,
    ProcessingCompletedEvent,
    ProcessingFailedEvent,
    ProcessingStartedEvent,
)
from ..models import FileProviderContext, FileRecord, Visibility


class ProcessorInput(BaseModel):
    fileId: str
    versionId: str
    storageKey: str
    mimeType: str
    size: int
    fileName: str
    tenantId: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class ProcessorOutputArtifact(BaseModel):
    kind: str
    data: bytes
    mimeType: str
    storageKey: str
    metadata: Optional[Dict[str, Any]] = None


class ProcessorResult(BaseModel):
    success: bool
    artifacts: List[ProcessorOutputArtifact]
    error: Optional[str] = None


class Processor(Protocol):
    name: str
    supportedMimeTypes: List[str]

    async def process(self, input: ProcessorInput, get_data: Callable[[], Any]) -> ProcessorResult: ...


class FlowFnQueue(Protocol):
    async def add(self, job: Any) -> Dict[str, Any]: ...


class FlowFnProvider(Protocol):
    def get_queue(self, name: str) -> Optional[FlowFnQueue]: ...


class ProcessingServiceConfig(BaseModel):
    db: Any
    storage: Any
    events: FileFnEventEmitter
    processors: List[Any] = []
    flow_fn: Optional[Any] = None
    namespace: str = "filefn"
    enabled: bool = True

    class Config:
        arbitrary_types_allowed = True


class FileArtifactRecord(BaseModel):
    artifactId: str
    fileId: str
    versionId: str
    kind: str
    storageKey: str
    mimeType: str
    size: int
    metadata: Optional[Dict[str, Any]] = None
    createdAt: str


def _generate_id() -> str:
    return f"art_{datetime.now(timezone.utc).timestamp()}_{random.randint(0, 10000)}"


def _supports_processor(processor: Processor, mime_type: str) -> bool:
    if "*/*" in processor.supportedMimeTypes:
        return True
    return mime_type in processor.supportedMimeTypes


class ProcessingService:
    def __init__(self, config: ProcessingServiceConfig):
        self.db = config.db
        self.storage = config.storage
        self.events = config.events
        self.processors = config.processors
        self.flow_fn = config.flow_fn
        self.namespace = config.namespace
        self.enabled = config.enabled
        self.queue_name = "filefn.processing"

    def is_enabled(self) -> bool:
        return self.enabled and len(self.processors) > 0

    async def trigger_processing(self, input: Dict[str, Any], ctx: FileProviderContext) -> Dict[str, Any]:
        if not self.enabled or not self.processors:
            return {"enqueued": False}

        self.events.emit(
            "processing.started",
            ProcessingStartedEvent(
                timestamp=datetime.now(timezone.utc).isoformat(),
                requestId=ctx.requestId,
                fileId=input["fileId"],
                versionId=input["versionId"],
            ),
        )

        if self.flow_fn:
            queue = self.flow_fn.get_queue(self.queue_name)
            if queue:
                try:
                    idempotency_key = f"filefn:processing:{input['fileId']}:{input['versionId']}"
                    result = await queue.add(
                        {
                            "fileId": input["fileId"],
                            "versionId": input["versionId"],
                            "storageKey": input["storageKey"],
                            "mimeType": input["mimeType"],
                            "size": input["size"],
                            "fileName": input["fileName"],
                            "tenantId": input.get("tenantId"),
                            "idempotencyKey": idempotency_key,
                        }
                    )
                    return {"enqueued": True, "jobId": result.get("jobId")}
                except Exception:
                    raise errors.processing_enqueue_failed()

        asyncio.create_task(self._safe_run_processing(ProcessorInput(**input), ctx))
        return {"enqueued": False}

    async def _safe_run_processing(self, input: ProcessorInput, ctx: FileProviderContext) -> None:
        try:
            await self.run_processing(input, ctx)
        except Exception as exc:
            self.events.emit(
                "processing.failed",
                ProcessingFailedEvent(
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    requestId=ctx.requestId,
                    fileId=input.fileId,
                    versionId=input.versionId,
                    error=str(exc),
                ),
            )

    async def run_processing(self, input: ProcessorInput, ctx: FileProviderContext) -> Dict[str, Any]:
        applicable_processors = [p for p in self.processors if _supports_processor(p, input.mimeType)]
        if not applicable_processors:
            return {"artifactsCreated": 0, "errors": []}

        data_cache: Optional[bytes] = None

        async def get_data() -> bytes:
            nonlocal data_cache
            if data_cache is not None:
                return data_cache

            stream = await self.storage.open_download_stream(key=input.storageKey)
            chunks: List[bytes] = []
            async for chunk in stream:
                chunks.append(chunk)
            data_cache = b"".join(chunks)
            return data_cache

        processing_errors: List[str] = []
        artifacts_created = 0

        for processor in applicable_processors:
            try:
                result = await processor.process(input, get_data)
                if not result.success:
                    if result.error:
                        processing_errors.append(f"{processor.name}: {result.error}")
                    continue

                for artifact in result.artifacts:
                    await self.storage.put_object(
                        key=artifact.storageKey,
                        data=artifact.data,
                        metadata={"contentType": artifact.mimeType},
                    )

                    existing_artifact_data = await self.db.find_one(
                        model="fileArtifacts",
                        where=[
                            {"field": "fileId", "operator": "eq", "value": input.fileId},
                            {"field": "versionId", "operator": "eq", "value": input.versionId},
                            {"field": "kind", "operator": "eq", "value": artifact.kind},
                        ],
                        namespace=self.namespace,
                    )

                    if existing_artifact_data:
                        await self.db.update(
                            model="fileArtifacts",
                            where=[
                                {
                                    "field": "artifactId",
                                    "operator": "eq",
                                    "value": existing_artifact_data["artifactId"],
                                }
                            ],
                            data={
                                "storageKey": artifact.storageKey,
                                "mimeType": artifact.mimeType,
                                "size": len(artifact.data),
                                "metadata": artifact.metadata or {},
                            },
                            namespace=self.namespace,
                        )
                    else:
                        await self.db.create(
                            model="fileArtifacts",
                            data={
                                "artifactId": _generate_id(),
                                "fileId": input.fileId,
                                "versionId": input.versionId,
                                "kind": artifact.kind,
                                "storageKey": artifact.storageKey,
                                "mimeType": artifact.mimeType,
                                "size": len(artifact.data),
                                "metadata": artifact.metadata or {},
                                "createdAt": datetime.now(timezone.utc).isoformat(),
                            },
                            namespace=self.namespace,
                        )
                    artifacts_created += 1
            except Exception as exc:
                processing_errors.append(f"{processor.name}: {str(exc)}")

        self.events.emit(
            "processing.completed",
            ProcessingCompletedEvent(
                timestamp=datetime.now(timezone.utc).isoformat(),
                requestId=ctx.requestId,
                fileId=input.fileId,
                versionId=input.versionId,
                artifactsCreated=artifacts_created,
            ),
        )

        return {"artifactsCreated": artifacts_created, "errors": processing_errors}

    async def _get_readable_file(self, file_id: str, ctx: FileProviderContext) -> FileRecord:
        file_data = await self.db.find_one(
            model="files",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            namespace=self.namespace,
        )
        if not file_data:
            raise errors.not_found("File")

        file = FileRecord(**file_data)
        if file.visibility == Visibility.PUBLIC:
            return file
        if file.ownerId == ctx.principalId:
            return file
        if file.visibility == Visibility.SHARED and file.tenantId and file.tenantId == ctx.tenantId:
            return file

        raise errors.forbidden()

    async def list_artifacts(self, file_id: str, ctx: FileProviderContext) -> List[Dict[str, Any]]:
        await self._get_readable_file(file_id, ctx)
        artifacts = await self.db.find_many(
            model="fileArtifacts",
            where=[{"field": "fileId", "operator": "eq", "value": file_id}],
            order_by=[{"field": "createdAt", "direction": "desc"}],
            namespace=self.namespace,
        )
        return artifacts

    async def get_artifact_download_url(
        self,
        artifact_id: str,
        ctx: FileProviderContext,
        file_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        artifact_data = await self.db.find_one(
            model="fileArtifacts",
            where=[{"field": "artifactId", "operator": "eq", "value": artifact_id}],
            namespace=self.namespace,
        )
        if not artifact_data:
            raise errors.not_found("Artifact")

        artifact = FileArtifactRecord(**artifact_data)
        if file_id and artifact.fileId != file_id:
            raise errors.not_found("Artifact")

        await self._get_readable_file(artifact.fileId, ctx)

        if hasattr(self.storage, "sign_download_url"):
            try:
                result = await self.storage.sign_download_url(key=artifact.storageKey, expires_in_seconds=900)
                return {"url": result["url"], "headers": result.get("headers")}
            except Exception:
                pass

        return {"url": f"/proxy/files/{artifact.fileId}/artifacts/{artifact.artifactId}/download"}


def create_processing_service(config: ProcessingServiceConfig) -> ProcessingService:
    return ProcessingService(config)
