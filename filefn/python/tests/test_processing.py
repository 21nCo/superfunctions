from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from filefn.server import create_event_emitter
from filefn.server.processing.service import (
    ProcessingServiceConfig,
    ProcessorInput,
    ProcessorOutputArtifact,
    ProcessorResult,
    create_processing_service,
)


class FakeDB:
    def __init__(self) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {}

    def _table(self, model: str) -> List[Dict[str, Any]]:
        return self.tables.setdefault(model, [])

    @staticmethod
    def _matches(row: Dict[str, Any], where: Optional[List[Dict[str, Any]]]) -> bool:
        if not where:
            return True
        for clause in where:
            if clause.get("operator") != "eq":
                raise ValueError("FakeDB supports only eq operator")
            if row.get(clause["field"]) != clause.get("value"):
                return False
        return True

    async def create(self, model: str, data: Dict[str, Any], namespace: Optional[str] = None) -> Dict[str, Any]:
        row = dict(data)
        self._table(model).append(row)
        return dict(row)

    async def find_one(
        self,
        model: str,
        where: Optional[List[Dict[str, Any]]] = None,
        namespace: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        for row in self._table(model):
            if self._matches(row, where):
                return dict(row)
        return None

    async def find_many(
        self,
        model: str,
        where: Optional[List[Dict[str, Any]]] = None,
        order_by: Optional[List[Dict[str, Any]]] = None,
        limit: Optional[int] = None,
        namespace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        rows = [dict(row) for row in self._table(model) if self._matches(row, where)]

        if order_by:
            for order in reversed(order_by):
                reverse = order.get("direction", "asc") == "desc"
                rows.sort(key=lambda item: item.get(order["field"]), reverse=reverse)

        if limit is not None:
            rows = rows[:limit]
        return rows

    async def update(
        self,
        model: str,
        where: List[Dict[str, Any]],
        data: Dict[str, Any],
        namespace: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        for row in self._table(model):
            if self._matches(row, where):
                row.update(data)
                return dict(row)
        return None


class FakeStorage:
    def __init__(self, with_signing: bool = False) -> None:
        self.with_signing = with_signing
        self.objects: Dict[str, bytes] = {}
        self.put_calls: List[Dict[str, Any]] = []

    async def put_object(self, key: str, data: bytes, metadata: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        payload = bytes(data)
        self.objects[key] = payload
        self.put_calls.append({"key": key, "metadata": metadata or {}})
        return {
            "key": key,
            "size": len(payload),
            "etag": "etag",
            "lastModified": datetime.now(timezone.utc).isoformat(),
            "metadata": metadata or {},
        }

    async def open_download_stream(self, key: str):
        payload = self.objects.get(key, b"")

        async def _gen():
            yield payload

        return _gen()

    async def sign_download_url(self, key: str, expires_in_seconds: int) -> Dict[str, Any]:
        if not self.with_signing:
            raise RuntimeError("signing unavailable")
        return {"url": f"https://download.local/{key}", "headers": {}}


class ThumbnailLikeProcessor:
    name = "thumbnail"
    supportedMimeTypes = ["image/png"]

    async def process(self, input: ProcessorInput, get_data):
        raw = await get_data()
        return ProcessorResult(
            success=True,
            artifacts=[
                ProcessorOutputArtifact(
                    kind="thumbnail",
                    data=raw,
                    mimeType="image/png",
                    storageKey=f"{input.storageKey}.thumb.png",
                    metadata={"source": input.fileId},
                )
            ],
        )


class RecordingQueue:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.jobs: List[Dict[str, Any]] = []

    async def add(self, job: Any) -> Dict[str, Any]:
        if self.fail:
            raise RuntimeError("queue down")
        payload = dict(job)
        self.jobs.append(payload)
        return {"jobId": "job_001"}


class FlowProvider:
    def __init__(self, queue: RecordingQueue) -> None:
        self.queue = queue

    def get_queue(self, name: str):
        return self.queue


def _ctx(principal_id: Optional[str], tenant_id: Optional[str] = "org_123"):
    return SimpleNamespace(principalId=principal_id, tenantId=tenant_id, requestId="req_001")


async def _seed_file_and_artifact(db: FakeDB) -> None:
    now = datetime.now(timezone.utc).isoformat()
    await db.create(
        model="files",
        data={
            "fileId": "file_001",
            "currentVersionId": "ver_001",
            "ownerId": "user_123",
            "tenantId": "org_123",
            "visibility": "private",
            "policy": "user-avatar",
            "mimeType": "image/png",
            "size": 3,
            "name": "a.png",
            "metadata": {},
            "createdAt": now,
            "updatedAt": now,
        },
    )
    await db.create(
        model="fileArtifacts",
        data={
            "artifactId": "art_001",
            "fileId": "file_001",
            "versionId": "ver_001",
            "kind": "thumbnail",
            "storageKey": "org_123/user_123/file_001/ver_001-a.png.thumb.png",
            "mimeType": "image/png",
            "size": 3,
            "metadata": {},
            "createdAt": now,
        },
    )


@pytest.mark.asyncio
async def test_processing_uses_put_object_and_creates_artifacts() -> None:
    db = FakeDB()
    storage = FakeStorage()
    storage.objects["org_123/user_123/file_001/ver_001-a.png"] = b"abc"

    service = create_processing_service(
        ProcessingServiceConfig(
            db=db,
            storage=storage,
            events=create_event_emitter(),
            processors=[ThumbnailLikeProcessor()],
            namespace="filefn",
            enabled=True,
        )
    )

    result = await service.run_processing(
        ProcessorInput(
            fileId="file_001",
            versionId="ver_001",
            storageKey="org_123/user_123/file_001/ver_001-a.png",
            mimeType="image/png",
            size=3,
            fileName="a.png",
            tenantId="org_123",
        ),
        _ctx("user_123"),
    )

    assert result["artifactsCreated"] == 1
    assert len(storage.put_calls) == 1
    assert storage.put_calls[0]["key"].endswith(".thumb.png")


@pytest.mark.asyncio
async def test_processing_queue_enqueue_uses_deterministic_idempotency_key_and_surfaces_failures() -> None:
    ok_queue = RecordingQueue(fail=False)
    service_ok = create_processing_service(
        ProcessingServiceConfig(
            db=FakeDB(),
            storage=FakeStorage(),
            events=create_event_emitter(),
            processors=[ThumbnailLikeProcessor()],
            flow_fn=FlowProvider(ok_queue),
            namespace="filefn",
            enabled=True,
        )
    )

    queued = await service_ok.trigger_processing(
        {
            "fileId": "file_001",
            "versionId": "ver_001",
            "storageKey": "k",
            "mimeType": "image/png",
            "size": 3,
            "fileName": "a.png",
            "tenantId": "org_123",
        },
        _ctx("user_123"),
    )

    assert queued["enqueued"] is True
    assert ok_queue.jobs[0]["idempotencyKey"] == "filefn:processing:file_001:ver_001"

    bad_queue = RecordingQueue(fail=True)
    service_bad = create_processing_service(
        ProcessingServiceConfig(
            db=FakeDB(),
            storage=FakeStorage(),
            events=create_event_emitter(),
            processors=[ThumbnailLikeProcessor()],
            flow_fn=FlowProvider(bad_queue),
            namespace="filefn",
            enabled=True,
        )
    )

    with pytest.raises(Exception) as exc_info:
        await service_bad.trigger_processing(
            {
                "fileId": "file_001",
                "versionId": "ver_001",
                "storageKey": "k",
                "mimeType": "image/png",
                "size": 3,
                "fileName": "a.png",
                "tenantId": "org_123",
            },
            _ctx("user_123"),
        )
    assert getattr(exc_info.value, "code", "") == "FILEFN_PROCESSING_ENQUEUE_FAILED"


@pytest.mark.asyncio
async def test_artifact_access_authorization_and_proxy_descriptor_shape() -> None:
    db = FakeDB()
    await _seed_file_and_artifact(db)

    service = create_processing_service(
        ProcessingServiceConfig(
            db=db,
            storage=FakeStorage(with_signing=False),
            events=create_event_emitter(),
            processors=[],
            namespace="filefn",
            enabled=True,
        )
    )

    visible = await service.list_artifacts("file_001", _ctx("user_123"))
    assert len(visible) == 1

    with pytest.raises(Exception) as exc_forbidden:
        await service.list_artifacts("file_001", _ctx("user_999"))
    assert getattr(exc_forbidden.value, "code", "") == "FILEFN_FORBIDDEN"

    descriptor = await service.get_artifact_download_url("art_001", _ctx("user_123"), file_id="file_001")
    assert descriptor["url"] == "/proxy/files/file_001/artifacts/art_001/download"
    assert not descriptor["url"].startswith("proxy://")

    with pytest.raises(Exception) as exc_binding:
        await service.get_artifact_download_url("art_001", _ctx("user_123"), file_id="file_999")
    assert getattr(exc_binding.value, "code", "") == "FILEFN_NOT_FOUND"
