import asyncio
from typing import Any, Dict, List, Optional, Protocol, Union, Callable
from pydantic import BaseModel
from datetime import datetime, timezone
import random

from superfunctions.db import Adapter
from ..protocols import StorageAdapter
from ..models import FileProviderContext
from ..events import FileFnEventEmitter, ProcessingStartedEvent, ProcessingCompletedEvent, ProcessingFailedEvent
from .. import errors

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
    async def process(self, input: ProcessorInput, get_data: Callable[[], Any]) -> ProcessorResult: ... # get_data returns Awaitable[bytes]

class FlowFnQueue(Protocol):
    async def add(self, job: Any) -> Dict[str, Any]: ... # returns {jobId: str}

class FlowFnProvider(Protocol):
    def get_queue(self, name: str) -> Optional[FlowFnQueue]: ...

class ProcessingServiceConfig(BaseModel):
    db: Any # Adapter
    storage: Any # StorageAdapter
    events: FileFnEventEmitter
    processors: List[Processor] = []
    flow_fn: Optional[FlowFnProvider] = None
    namespace: str = 'filefn'
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
    return f"art_{datetime.now().timestamp()}_{random.randint(0, 10000)}"

def _supports_processor(processor: Processor, mime_type: str) -> bool:
    if '*/*' in processor.supportedMimeTypes:
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
        self.queue_name = 'filefn.processing'

    def is_enabled(self) -> bool:
        return self.enabled and len(self.processors) > 0

    async def trigger_processing(self, input: Dict[str, Any], ctx: FileProviderContext) -> Dict[str, Any]:
        if not self.enabled or not self.processors:
            return {'enqueued': False}

        self.events.emit('processing.started', ProcessingStartedEvent(
            timestamp=datetime.now(timezone.utc).isoformat(),
            requestId=ctx.requestId,
            fileId=input['fileId'],
            versionId=input['versionId']
        ))

        if self.flow_fn:
            queue = self.flow_fn.get_queue(self.queue_name)
            if queue:
                try:
                    result = await queue.add({
                        'fileId': input['fileId'],
                        'versionId': input['versionId'],
                        'storageKey': input['storageKey'],
                        'mimeType': input['mimeType'],
                        'size': input['size'],
                        'fileName': input['fileName'],
                        'tenantId': input.get('tenantId'),
                    })
                    return {'enqueued': True, 'jobId': result.get('jobId')}
                except:
                    raise errors.processing_enqueue_failed()

        # In-process execution (background)
        asyncio.create_task(self._safe_run_processing(ProcessorInput(**input), ctx))
        
        return {'enqueued': False}

    async def _safe_run_processing(self, input: ProcessorInput, ctx: FileProviderContext):
        try:
            await self.run_processing(input, ctx)
        except Exception:
             self.events.emit('processing.failed', ProcessingFailedEvent(
                timestamp=datetime.now(timezone.utc).isoformat(),
                requestId=ctx.requestId,
                fileId=input.fileId,
                versionId=input.versionId
             ))

    async def run_processing(self, input: ProcessorInput, ctx: FileProviderContext) -> Dict[str, Any]:
        applicable_processors = [p for p in self.processors if _supports_processor(p, input.mimeType)]

        if not applicable_processors:
            return {'artifactsCreated': 0, 'errors': []}

        data_cache: Optional[bytes] = None

        async def get_data() -> bytes:
            nonlocal data_cache
            if data_cache is not None:
                return data_cache
            
            if hasattr(self.storage, 'open_download_stream'):
                stream = await self.storage.open_download_stream(key=input.storageKey)
                chunks = []
                async for chunk in stream:
                    chunks.append(chunk)
                data_cache = b''.join(chunks)
            else:
                 # Try get_object if stream not supported? But TS says throw.
                 raise Exception('Storage adapter does not support streaming downloads')
            
            return data_cache

        processing_errors = []
        artifacts_created = 0

        for processor in applicable_processors:
            try:
                result = await processor.process(input, get_data)

                if not result.success:
                    if result.error:
                        processing_errors.append(f"{processor.name}: {result.error}")
                    continue

                for artifact in result.artifacts:
                    if hasattr(self.storage, 'upload_object'):
                         # Use upload_object which takes bytes/stream usually
                         await self.storage.upload_object(
                             key=artifact.storageKey,
                             data=artifact.data,
                             contentType=artifact.mimeType
                         )
                    else:
                         raise Exception('Storage adapter does not support upload_object')

                    existing_artifact_data = await self.db.find_one(
                        model='fileArtifacts',
                        where=[
                            {'field': 'fileId', 'operator': 'eq', 'value': input.fileId},
                            {'field': 'versionId', 'operator': 'eq', 'value': input.versionId},
                            {'field': 'kind', 'operator': 'eq', 'value': artifact.kind},
                        ],
                        namespace=self.namespace
                    )

                    if existing_artifact_data:
                        await self.db.update(
                            model='fileArtifacts',
                            where=[{'field': 'artifactId', 'operator': 'eq', 'value': existing_artifact_data['artifactId']}],
                            data={
                                'storageKey': artifact.storageKey,
                                'mimeType': artifact.mimeType,
                                'size': len(artifact.data),
                                'metadata': artifact.metadata or {},
                            },
                            namespace=self.namespace
                        )
                    else:
                        artifact_id = _generate_id()
                        await self.db.create(
                            model='fileArtifacts',
                            data={
                                'artifactId': artifact_id,
                                'fileId': input.fileId,
                                'versionId': input.versionId,
                                'kind': artifact.kind,
                                'storageKey': artifact.storageKey,
                                'mimeType': artifact.mimeType,
                                'size': len(artifact.data),
                                'metadata': artifact.metadata or {},
                                'createdAt': datetime.now(timezone.utc).isoformat(),
                            },
                            namespace=self.namespace
                        )
                    artifacts_created += 1

            except Exception as e:
                processing_errors.append(f"{processor.name}: {str(e)}")

        self.events.emit('processing.completed', ProcessingCompletedEvent(
            timestamp=datetime.now(timezone.utc).isoformat(),
            requestId=ctx.requestId,
            fileId=input.fileId,
            versionId=input.versionId,
            artifactsCreated=artifacts_created
        ))

        return {'artifactsCreated': artifacts_created, 'errors': processing_errors}

    async def list_artifacts(self, file_id: str, ctx: FileProviderContext) -> List[Dict[str, Any]]:
        artifacts = await self.db.find_many(
            model='fileArtifacts',
            where=[{'field': 'fileId', 'operator': 'eq', 'value': file_id}],
            order_by=[{'field': 'createdAt', 'direction': 'desc'}],
            namespace=self.namespace
        )
        return artifacts

    async def get_artifact_download_url(self, artifact_id: str, ctx: FileProviderContext) -> Dict[str, Any]:
        artifact_data = await self.db.find_one(
            model='fileArtifacts',
            where=[{'field': 'artifactId', 'operator': 'eq', 'value': artifact_id}],
            namespace=self.namespace
        )

        if not artifact_data:
            raise errors.not_found('Artifact')
        
        artifact = FileArtifactRecord(**artifact_data)

        if hasattr(self.storage, 'sign_download_url'):
            result = await self.storage.sign_download_url(
                key=artifact.storageKey,
                expires_in_seconds=900
            )
            return {'url': result['url'], 'headers': result.get('headers')}
        
        return {'url': f"proxy://{artifact.storageKey}"}

def create_processing_service(config: ProcessingServiceConfig) -> ProcessingService:
    return ProcessingService(config)
