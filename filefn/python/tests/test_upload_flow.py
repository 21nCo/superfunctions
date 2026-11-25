from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from filefn.server import create_event_emitter, create_routed_storage_adapter, errors
from filefn.server.policies import Policy, create_nucleus_policies, create_policy_registry
from filefn.server.upload_sessions.service import (
    CreateSessionInput,
    UploadSessionService,
    UploadSessionServiceConfig,
    create_upload_session_service,
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

    async def delete(
        self,
        model: str,
        where: List[Dict[str, Any]],
        namespace: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        rows = self._table(model)
        for idx, row in enumerate(rows):
            if self._matches(row, where):
                removed = rows.pop(idx)
                return dict(removed)
        return None

    async def delete_many(
        self,
        model: str,
        where: List[Dict[str, Any]],
        namespace: Optional[str] = None,
    ) -> int:
        rows = self._table(model)
        before = len(rows)
        self.tables[model] = [row for row in rows if not self._matches(row, where)]
        return before - len(self.tables[model])


class FakeStorage:
    def __init__(self, capabilities: Optional[Dict[str, bool]] = None) -> None:
        self.capabilities = capabilities or {}
        self.objects: Dict[str, bytes] = {}
        self.multipart: Dict[str, Dict[str, Any]] = {}
        self.aborted_uploads: List[str] = []
        self.calls: List[str] = []
        self.name = "fake"

    @staticmethod
    def _coerce_bytes(data: Any) -> bytes:
        if isinstance(data, bytes):
            return data
        if hasattr(data, "read"):
            payload = data.read()
            if isinstance(payload, bytes):
                return payload
        return bytes(data)

    async def get_object(self, key: str, target: Optional[str] = None) -> Dict[str, Any]:
        data = self.objects[key]
        return {
            "key": key,
            "size": len(data),
            "etag": "etag",
            "lastModified": datetime.now(timezone.utc).isoformat(),
            "metadata": {},
        }

    async def put_object(
        self,
        key: str,
        data: Any,
        metadata: Optional[Dict[str, str]] = None,
        target: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload = self._coerce_bytes(data)
        self.objects[key] = payload
        if target:
            self.calls.append(f"{self.name}:put:{target}:{key}")
        return {
            "key": key,
            "size": len(payload),
            "etag": f"etag-{len(payload)}",
            "lastModified": datetime.now(timezone.utc).isoformat(),
            "metadata": metadata or {},
        }

    async def delete_object(self, key: str, target: Optional[str] = None) -> None:
        self.objects.pop(key, None)
        if target:
            self.calls.append(f"{self.name}:delete:{target}:{key}")

    async def open_download_stream(self, key: str, target: Optional[str] = None):
        payload = self.objects.get(key, b"")
        if target:
            self.calls.append(f"{self.name}:download:{target}:{key}")

        async def _gen():
            yield payload

        return _gen()

    async def sign_download_url(self, key: str, expires_in_seconds: int, target: Optional[str] = None) -> Dict[str, Any]:
        return {"url": f"https://download.local/{key}", "headers": {}}

    async def create_multipart_upload(
        self,
        key: str,
        metadata: Optional[Dict[str, str]] = None,
        content_type: Optional[str] = None,
        target: Optional[str] = None,
    ) -> str:
        upload_id = f"mp-{len(self.multipart) + 1}"
        self.multipart[upload_id] = {"key": key, "parts": {}}
        self.calls.append(f"{self.name}:multipart:{target or 'default'}:{key}")
        return upload_id

    async def sign_multipart_upload_part_url(
        self,
        key: str,
        upload_id: str,
        part_number: int,
        expires_in_seconds: int,
        constraints: Optional[Dict[str, Any]] = None,
        target: Optional[str] = None,
    ) -> Dict[str, Any]:
        return {"url": f"https://upload.local/{upload_id}/{part_number}", "headers": {}}

    async def upload_part(
        self,
        key: str,
        upload_id: str,
        part_number: int,
        data: bytes,
        target: Optional[str] = None,
    ) -> str:
        self.multipart.setdefault(upload_id, {"key": key, "parts": {}})["parts"][part_number] = bytes(data)
        return f"etag-{part_number}"

    async def complete_multipart_upload(
        self,
        key: str,
        upload_id: str,
        parts: list[Dict[str, Any]],
        target: Optional[str] = None,
    ) -> Dict[str, Any]:
        self.objects[key] = self.objects.get(key, b"")
        if target:
            self.calls.append(f"{self.name}:complete:{target}:{key}")
        return {
            "key": key,
            "size": len(self.objects[key]),
            "etag": "etag-final",
            "lastModified": datetime.now(timezone.utc).isoformat(),
            "metadata": {},
        }

    async def abort_multipart_upload(self, key: str, upload_id: str, target: Optional[str] = None) -> None:
        self.aborted_uploads.append(upload_id)


class FakeDedup:
    def __init__(self, db: FakeDB, enabled: bool) -> None:
        self.db = db
        self.enabled = enabled

    def is_enabled(self) -> bool:
        return self.enabled

    async def compute_and_check_duplicate(
        self,
        storage_key: str,
        tenant_id: Optional[str],
        storage_target: Optional[str],
        storage: FakeStorage,
    ):
        if not self.enabled:
            return SimpleNamespace(
                isDuplicate=False,
                existingStorageKey=None,
                checksumSha256Base64="",
            )

        stream = await storage.open_download_stream(storage_key, target=storage_target)
        chunks: List[bytes] = []
        async for chunk in stream:
            chunks.append(chunk)
        payload = b"".join(chunks)
        checksum = base64.b64encode(hashlib.sha256(payload).digest()).decode("ascii")

        versions = await self.db.find_many("fileVersions", where=[])
        for version in versions:
            if version.get("checksumSha256Base64") != checksum:
                continue
            if version.get("tenantId") != tenant_id:
                continue
            return SimpleNamespace(
                isDuplicate=True,
                existingStorageKey=version.get("storageKey"),
                checksumSha256Base64=checksum,
            )

        return SimpleNamespace(
            isDuplicate=False,
            existingStorageKey=None,
            checksumSha256Base64=checksum,
        )


def _ctx(
    principal_id: Optional[str] = "user_123",
    tenant_id: Optional[str] = "org_123",
    upload_session_token: Optional[str] = None,
):
    ctx = SimpleNamespace(principalId=principal_id, tenantId=tenant_id, requestId="req_001")
    if upload_session_token:
        ctx.uploadSessionToken = upload_session_token
    return ctx


def _make_service(
    db: Optional[FakeDB] = None,
    storage: Optional[FakeStorage] = None,
    dedup_enabled: bool = False,
    chunk_size: int = 3,
    allow_anonymous_uploads: bool = True,
) -> UploadSessionService:
    db = db or FakeDB()
    storage = storage or FakeStorage({"proxyStreamingUpload": True})
    dedup = FakeDedup(db=db, enabled=dedup_enabled)

    return create_upload_session_service(
        UploadSessionServiceConfig(
            db=db,
            storage=storage,
            policies=create_policy_registry(
                [
                    Policy(
                        name="user-avatar",
                        contentTypes=["image/png", "image/jpeg"],
                        maxSizeBytes=20_000_000,
                        visibility="private",
                    )
                ]
            ),
            events=create_event_emitter(),
            dedup=dedup,
            namespace="filefn",
            allow_anonymous_uploads=allow_anonymous_uploads,
            default_chunk_size_bytes=chunk_size,
            upload_session_ttl_seconds=3600,
        )
    )


@pytest.mark.asyncio
async def test_upload_mode_selection_is_capability_gated() -> None:
    service_a = _make_service(storage=FakeStorage({"signedUploadUrls": True, "multipart": True}))
    result_a = await service_a.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png"),
        _ctx(),
    )
    assert result_a["uploadMode"] == "multipart-signed-url"

    service_b = _make_service(storage=FakeStorage({"proxyStreamingUpload": True}))
    result_b = await service_b.create_session(
        CreateSessionInput(policy="user-avatar", fileName="b.png", size=3, mimeType="image/png"),
        _ctx(),
    )
    assert result_b["uploadMode"] == "proxy"

    service_c = _make_service(storage=FakeStorage({"signedUploadUrls": True, "multipart": False, "proxyStreamingUpload": False}))
    with pytest.raises(Exception) as exc_info:
        await service_c.create_session(
            CreateSessionInput(policy="user-avatar", fileName="c.png", size=3, mimeType="image/png"),
            _ctx(),
        )
    assert getattr(exc_info.value, "code", "") == "FILEFN_NO_SUPPORTED_UPLOAD_MODE"


@pytest.mark.asyncio
async def test_status_shape_uses_recorded_parts_canonical_fields() -> None:
    db = FakeDB()
    storage = FakeStorage({"proxyStreamingUpload": True})
    service = _make_service(db=db, storage=storage)

    session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="resume.png", size=3, mimeType="image/png"),
        _ctx(),
    )

    await service.complete_part(session["uploadSessionId"], 1, "etag-1", 3, _ctx())
    status = await service.get_session_status(session["uploadSessionId"], _ctx())

    assert status["fileId"] == session["fileId"]
    assert status["recordedParts"] == [1]
    assert status["chunkSizeBytes"] == 3
    assert status["fileSize"] == 3
    assert status["totalParts"] == 1
    assert status["status"] in {"pending", "in_progress"}
    assert "expiresAt" in status
    assert "uploadedParts" not in status


@pytest.mark.asyncio
async def test_upload_session_binding_for_authenticated_and_anonymous_flows() -> None:
    service = _make_service()

    auth_session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="auth.png", size=3, mimeType="image/png"),
        _ctx(principal_id="user_123", tenant_id="org_123"),
    )

    await service.get_session_status(auth_session["uploadSessionId"], _ctx("user_123", "org_123"))

    for method in (
        lambda: service.get_session_status(auth_session["uploadSessionId"], _ctx("user_999", "org_123")),
        lambda: service.sign_part(auth_session["uploadSessionId"], 1, 3, _ctx("user_999", "org_123")),
        lambda: service.complete_part(auth_session["uploadSessionId"], 1, "etag", 3, _ctx("user_999", "org_123")),
        lambda: service.complete_session(auth_session["uploadSessionId"], _ctx("user_999", "org_123")),
        lambda: service.abort_session(auth_session["uploadSessionId"], _ctx("user_999", "org_123")),
    ):
        with pytest.raises(Exception) as exc_info:
            await method()
        assert getattr(exc_info.value, "code", "") == "FILEFN_FORBIDDEN"

    anon_session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="anon.png", size=3, mimeType="image/png"),
        _ctx(principal_id=None, tenant_id="org_123"),
    )
    token = anon_session.get("uploadSessionToken")
    assert isinstance(token, str) and token

    with pytest.raises(Exception) as exc_missing:
        await service.get_session_status(anon_session["uploadSessionId"], _ctx(principal_id=None, tenant_id="org_123"))
    assert getattr(exc_missing.value, "code", "") == "FILEFN_SESSION_TOKEN_REQUIRED"

    with pytest.raises(Exception) as exc_invalid:
        await service.get_session_status(
            anon_session["uploadSessionId"],
            _ctx(principal_id=None, tenant_id="org_123", upload_session_token="wrong-token"),
        )
    assert getattr(exc_invalid.value, "code", "") == "FILEFN_SESSION_TOKEN_INVALID"

    status = await service.get_session_status(
        anon_session["uploadSessionId"],
        _ctx(principal_id=None, tenant_id="org_123", upload_session_token=token),
    )
    assert status["uploadSessionId"] == anon_session["uploadSessionId"]


@pytest.mark.asyncio
async def test_anonymous_init_retry_gets_a_fresh_session_and_persists_hash_only() -> None:
    # FILE-30 F-11: anonymous callers share one scope, so their init is never
    # replayed; a retry gets its own session and token.
    db = FakeDB()
    service = _make_service(db=db)
    init = CreateSessionInput(
        policy="user-avatar",
        fileName="anon-replay.png",
        size=3,
        mimeType="image/png",
        idempotencyKey="idem_anon_001",
    )

    first = await service.create_session(init, _ctx(principal_id=None, tenant_id=None))
    replay = await service.create_session(init, _ctx(principal_id=None, tenant_id=None))

    assert first["uploadSessionId"] != replay["uploadSessionId"]
    assert first["uploadSessionToken"] != replay["uploadSessionToken"]

    session_row = await db.find_one(
        model="uploadSessions",
        where=[{"field": "uploadSessionId", "operator": "eq", "value": first["uploadSessionId"]}],
        namespace="filefn",
    )
    assert session_row is not None
    assert session_row["uploadSessionToken"] is None
    assert session_row["sessionTokenHash"] == service._hash_session_token(first["uploadSessionToken"])
    assert session_row["idempotencyKey"] is None


@pytest.mark.asyncio
async def test_idempotency_keys_are_scoped_to_the_caller() -> None:
    service = _make_service()
    alice = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png", idempotencyKey="shared"),
        _ctx(principal_id="alice"),
    )
    bob = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="b.png", size=3, mimeType="image/png", idempotencyKey="shared"),
        _ctx(principal_id="bob"),
    )
    assert alice["uploadSessionId"] != bob["uploadSessionId"]

@pytest.mark.asyncio
async def test_create_session_respects_anonymous_upload_policy() -> None:
    service = _make_service(allow_anonymous_uploads=False)

    with pytest.raises(Exception) as exc_info:
        await service.create_session(
            CreateSessionInput(policy="user-avatar", fileName="anon-disabled.png", size=3, mimeType="image/png"),
            _ctx(principal_id=None, tenant_id="org_123"),
        )
    assert getattr(exc_info.value, "code", "") == "FILEFN_AUTH_REQUIRED"


@pytest.mark.asyncio
async def test_completion_persists_upload_metadata() -> None:
    db = FakeDB()
    storage = FakeStorage({"proxyStreamingUpload": True})
    service = _make_service(db=db, storage=storage)
    metadata = {"source": "nucleus", "isMeta": True}

    session = await service.create_session(
        CreateSessionInput(
            policy="user-avatar",
            fileName="meta.png",
            size=3,
            mimeType="image/png",
            metadata=metadata,
        ),
        _ctx(),
    )

    await service.record_proxy_part(session["uploadSessionId"], 1, b"abc", _ctx())
    completed = await service.complete_session(session["uploadSessionId"], _ctx())
    file_row = await db.find_one(
        model="files",
        where=[{"field": "fileId", "operator": "eq", "value": completed["fileId"]}],
        namespace="filefn",
    )

    assert file_row is not None
    assert file_row["metadata"] == metadata


@pytest.mark.asyncio
async def test_proxy_part_recording_idempotency_conflict_and_complete_idempotency() -> None:
    service = _make_service()

    session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="proxy.png", size=3, mimeType="image/png"),
        _ctx(),
    )

    first = await service.record_proxy_part(session["uploadSessionId"], 1, b"abc", _ctx())
    second = await service.record_proxy_part(session["uploadSessionId"], 1, b"abc", _ctx())

    assert first["recorded"] is True
    assert second["recorded"] is True

    with pytest.raises(Exception) as exc_conflict:
        await service.record_proxy_part(session["uploadSessionId"], 1, b"xyz", _ctx())
    assert getattr(exc_conflict.value, "code", "") == "FILEFN_PART_CONFLICT"

    completed_once = await service.complete_session(session["uploadSessionId"], _ctx())
    completed_twice = await service.complete_session(session["uploadSessionId"], _ctx())

    assert completed_once["fileId"] == completed_twice["fileId"]
    assert completed_once["versionId"] == completed_twice["versionId"]

    incomplete_session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="incomplete.png", size=6, mimeType="image/png"),
        _ctx(),
    )
    await service.record_proxy_part(incomplete_session["uploadSessionId"], 1, b"abc", _ctx())
    with pytest.raises(Exception) as exc_incomplete:
        await service.complete_session(incomplete_session["uploadSessionId"], _ctx())
    assert getattr(exc_incomplete.value, "code", "") == "FILEFN_UPLOAD_INCOMPLETE"


@pytest.mark.asyncio
async def test_proxy_part_retry_checks_stored_bytes_for_legacy_etags() -> None:
    db = FakeDB()
    service = _make_service(db=db)
    session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="proxy.png", size=3, mimeType="image/png"),
        _ctx(),
    )
    session_id = session["uploadSessionId"]
    await service.record_proxy_part(session_id, 1, b"abc", _ctx())
    legacy_etag = "01234567" * 4
    await db.update(
        model="uploadParts",
        where=[{"field": "uploadSessionId", "operator": "eq", "value": session_id}],
        data={"etag": legacy_etag},
        namespace="filefn",
    )

    retry = await service.record_proxy_part(session_id, 1, b"abc", _ctx())
    assert retry == {"etag": legacy_etag, "size": 3, "recorded": True}
    with pytest.raises(Exception) as conflict:
        await service.record_proxy_part(session_id, 1, b"xyz", _ctx())
    assert getattr(conflict.value, "code", "") == "FILEFN_PART_CONFLICT"


@pytest.mark.asyncio
async def test_complete_session_validates_uploaded_size_matches_declared_size() -> None:
    service = _make_service()
    session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="size-mismatch.png", size=6, mimeType="image/png"),
        _ctx(),
    )

    await service.record_proxy_part(session["uploadSessionId"], 1, b"abc", _ctx())
    await service.record_proxy_part(session["uploadSessionId"], 2, b"xy", _ctx())

    with pytest.raises(Exception) as exc_info:
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert getattr(exc_info.value, "code", "") == "FILEFN_UPLOAD_SIZE_MISMATCH"


@pytest.mark.asyncio
async def test_complete_session_uses_high_entropy_version_ids() -> None:
    service = _make_service()

    first = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="first.png", size=3, mimeType="image/png"),
        _ctx(),
    )
    second = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="second.png", size=3, mimeType="image/png"),
        _ctx(),
    )

    await service.record_proxy_part(first["uploadSessionId"], 1, b"abc", _ctx())
    await service.record_proxy_part(second["uploadSessionId"], 1, b"xyz", _ctx())

    completed_first = await service.complete_session(first["uploadSessionId"], _ctx())
    completed_second = await service.complete_session(second["uploadSessionId"], _ctx())

    assert completed_first["versionId"].startswith("ver_")
    assert completed_second["versionId"].startswith("ver_")
    assert "." not in completed_first["versionId"]
    assert completed_first["versionId"] != completed_second["versionId"]


@pytest.mark.asyncio
async def test_garbage_collection_removes_expired_sessions_and_preserves_completed() -> None:
    db = FakeDB()
    storage = FakeStorage({"proxyStreamingUpload": True})
    service = _make_service(db=db, storage=storage)

    now = datetime.now(timezone.utc)
    expired = (now - timedelta(hours=1)).isoformat()
    future = (now + timedelta(hours=1)).isoformat()

    await db.create(
        model="uploadSessions",
        data={
            "uploadSessionId": "upl_expired",
            "status": "in_progress",
            "policy": "user-avatar",
            "fileId": "file_a",
            "fileName": "a.png",
            "mimeType": "image/png",
            "size": 3,
            "uploadMode": "proxy",
            "chunkSizeBytes": 3,
            "totalParts": 1,
            "storageKey": "org_123/user_123/file_a/ver_a-a.png",
            "storageUploadId": None,
            "ownerId": "user_123",
            "tenantId": "org_123",
            "expiresAt": expired,
            "createdAt": now.isoformat(),
        },
    )
    await db.create(
        model="uploadParts",
        data={"uploadSessionId": "upl_expired", "partNumber": 1, "etag": "etag-1", "size": 3},
    )
    storage.objects["org_123/user_123/file_a/ver_a-a.png.parts/1"] = b"abc"

    await db.create(
        model="uploadSessions",
        data={
            "uploadSessionId": "upl_completed",
            "status": "completed",
            "policy": "user-avatar",
            "fileId": "file_b",
            "fileName": "b.png",
            "mimeType": "image/png",
            "size": 3,
            "uploadMode": "proxy",
            "chunkSizeBytes": 3,
            "totalParts": 1,
            "storageKey": "org_123/user_123/file_b/ver_b-b.png",
            "storageUploadId": None,
            "ownerId": "user_123",
            "tenantId": "org_123",
            "expiresAt": future,
            "createdAt": now.isoformat(),
        },
    )

    result = await service.garbage_collect_expired_sessions()

    assert result["deletedSessions"] == 1
    assert result["preservedCompletedSessions"] == 1
    assert await db.find_one("uploadSessions", [{"field": "uploadSessionId", "operator": "eq", "value": "upl_expired"}]) is None
    assert await db.find_one("uploadSessions", [{"field": "uploadSessionId", "operator": "eq", "value": "upl_completed"}]) is not None
    assert "org_123/user_123/file_a/ver_a-a.png.parts/1" not in storage.objects


@pytest.mark.asyncio
async def test_dedupe_reuses_storage_within_tenant_but_not_cross_tenant() -> None:
    db = FakeDB()
    storage = FakeStorage({"proxyStreamingUpload": True})
    service = _make_service(db=db, storage=storage, dedup_enabled=True)

    first = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png"),
        _ctx("user_123", "org_123"),
    )
    await service.record_proxy_part(first["uploadSessionId"], 1, b"abc", _ctx("user_123", "org_123"))
    completed_first = await service.complete_session(first["uploadSessionId"], _ctx("user_123", "org_123"))

    second = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="b.png", size=3, mimeType="image/png"),
        _ctx("user_123", "org_123"),
    )
    await service.record_proxy_part(second["uploadSessionId"], 1, b"abc", _ctx("user_123", "org_123"))
    completed_second = await service.complete_session(second["uploadSessionId"], _ctx("user_123", "org_123"))

    third = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="c.png", size=3, mimeType="image/png"),
        _ctx("user_999", "org_999"),
    )
    await service.record_proxy_part(third["uploadSessionId"], 1, b"abc", _ctx("user_999", "org_999"))
    completed_third = await service.complete_session(third["uploadSessionId"], _ctx("user_999", "org_999"))

    first_version = await db.find_one(
        "fileVersions",
        [{"field": "fileId", "operator": "eq", "value": completed_first["fileId"]}],
    )
    second_version = await db.find_one(
        "fileVersions",
        [{"field": "fileId", "operator": "eq", "value": completed_second["fileId"]}],
    )
    third_version = await db.find_one(
        "fileVersions",
        [{"field": "fileId", "operator": "eq", "value": completed_third["fileId"]}],
    )

    assert first_version is not None and second_version is not None and third_version is not None
    assert second_version["storageKey"] == first_version["storageKey"]
    assert third_version["storageKey"] != first_version["storageKey"]


@pytest.mark.asyncio
async def test_routed_storage_routes_durable_and_temporary_uploads() -> None:
    db = FakeDB()
    durable = FakeStorage({"signedUploadUrls": True, "multipart": True, "proxyStreamingDownload": True})
    durable.name = "durable"
    temporary = FakeStorage({"signedUploadUrls": True, "multipart": True, "proxyStreamingDownload": True})
    temporary.name = "temporary"
    storage = create_routed_storage_adapter(
        {"durable": durable, "temporary": temporary},
        default_target="durable",
    )
    service = create_upload_session_service(
        UploadSessionServiceConfig(
            db=db,
            storage=storage,
            policies=create_policy_registry(
                [
                    Policy(name="durable-policy", contentTypes=["image/png"], storageTarget="durable"),
                    Policy(name="temporary-policy", contentTypes=["image/png"], storageTarget="temporary"),
                ]
            ),
            events=create_event_emitter(),
            namespace="filefn",
        )
    )

    await service.create_session(
        CreateSessionInput(policy="durable-policy", fileName="a.png", size=3, mimeType="image/png"),
        _ctx("user_123", "org_123"),
    )
    await service.create_session(
        CreateSessionInput(policy="temporary-policy", fileName="b.png", size=3, mimeType="image/png"),
        _ctx("user_123", "org_123"),
    )

    assert any(call.startswith("durable:multipart:") for call in durable.calls)
    assert any(call.startswith("temporary:multipart:") for call in temporary.calls)


@pytest.mark.asyncio
async def test_nucleus_policy_bundle_enforces_size_and_wildcard_types() -> None:
    registry = create_policy_registry(create_nucleus_policies())
    durable = registry.get("nucleus-durable-default")
    temporary = registry.get("nucleus-temporary-default")

    assert durable is not None and temporary is not None
    assert durable.maxSizeBytes == 104857600
    assert durable.renderProfile == "nucleus"
    assert durable.storageTarget == "durable"
    assert temporary.storageTarget == "temporary"

    service = _make_service(db=FakeDB(), storage=FakeStorage({"signedUploadUrls": True, "multipart": True}))
    service.policies = registry

    ok = await service.create_session(
        CreateSessionInput(
            policy="nucleus-durable-default",
            fileName="document.pdf",
            size=104857600,
            mimeType="application/pdf",
        ),
        _ctx("user_123", "org_123"),
    )
    assert ok["uploadSessionId"].startswith("upl_")

    with pytest.raises(Exception) as exc_size:
        await service.create_session(
            CreateSessionInput(
                policy="nucleus-durable-default",
                fileName="too-big.pdf",
                size=104857601,
                mimeType="application/pdf",
            ),
            _ctx("user_123", "org_123"),
        )
    assert getattr(exc_size.value, "code", "") == "FILEFN_POLICY_MAX_SIZE_EXCEEDED"

    with pytest.raises(Exception) as exc_mime:
        await service.create_session(
            CreateSessionInput(
                policy="nucleus-temporary-default",
                fileName="notes.zip",
                size=10,
                mimeType="application/zip",
            ),
            _ctx("user_123", "org_123"),
        )
    assert getattr(exc_mime.value, "code", "") == "FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "file_name",
    [
        "../../../../t1/alice/file_a/ver_a-a.png",
        "..",
        ".",
        "a/b.png",
        "a\\b.png",
        "bad\x00name.png",
        "   ",
        "a" * 256,
        # 254 ASCII characters and one emoji: 256 UTF-16 code units.
        "a" * 254 + "\U0001f600",
    ],
)
async def test_create_session_rejects_unsafe_file_names(file_name: str) -> None:
    # FILE-30 F-01: a traversal name used to land in the storage key unchanged.
    service = _make_service()
    with pytest.raises(Exception) as exc_info:
        await service.create_session(
            CreateSessionInput(policy="user-avatar", fileName=file_name, size=3, mimeType="image/png"),
            _ctx(),
        )
    assert getattr(exc_info.value, "code", "") == "FILEFN_INVALID_REQUEST"


@pytest.mark.asyncio
async def test_create_session_rejects_negative_size() -> None:
    service = _make_service()
    with pytest.raises(Exception) as exc_info:
        await service.create_session(
            CreateSessionInput(policy="user-avatar", fileName="a.png", size=-5, mimeType="image/png"),
            _ctx(),
        )
    assert getattr(exc_info.value, "code", "") == "FILEFN_INVALID_REQUEST"


@pytest.mark.asyncio
async def test_default_storage_key_sanitizes_tenant_and_principal() -> None:
    db = FakeDB()
    service = _make_service(db=db)
    await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a..b.png", size=3, mimeType="image/png"),
        _ctx(principal_id="../alice", tenant_id="t1/.."),
    )
    key = db.tables["uploadSessions"][0]["storageKey"]
    assert key.startswith("t1%2F../%2E%2E%2Falice/")
    assert all(segment not in (".", "..", "") for segment in key.split("/"))
    # Dots inside a name are kept.
    assert key.endswith("-a..b.png")


def test_unsafe_storage_key_reason() -> None:
    from filefn.server.policies import sanitize_storage_key_segment, unsafe_storage_key_reason

    # The same encoding as the TypeScript server, so distinct IDs never share a segment.
    assert sanitize_storage_key_segment("../a/b") == "%2E%2E%2Fa%2Fb"
    assert sanitize_storage_key_segment(".") == "%2E"
    assert sanitize_storage_key_segment("") == "%20"
    assert sanitize_storage_key_segment("team/east") != sanitize_storage_key_segment("team_east")
    assert sanitize_storage_key_segment("a%b") == "a%25b"
    assert unsafe_storage_key_reason("a/../b") == "dot segment"
    assert unsafe_storage_key_reason("acme.com/a..b") is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override",
    [
        {"mimeType": "text"},
        {"mimeType": "text/plain\x00"},
        {"metadata": {"blob": "x" * (17 * 1024)}},
        {"idempotencyKey": "k" * 256},
        {"size": 2**53},
        {"size": 1.5},
    ],
)
async def test_create_session_validates_init_fields_like_typescript(override: Dict[str, Any]) -> None:
    service = _make_service()
    fields: Dict[str, Any] = {"policy": "user-avatar", "fileName": "a.png", "size": 3, "mimeType": "image/png"}
    fields.update(override)
    with pytest.raises(Exception) as exc_info:
        await service.create_session(CreateSessionInput(**fields), _ctx())
    assert getattr(exc_info.value, "code", "") == "FILEFN_INVALID_REQUEST"


def test_create_session_input_refuses_coerced_sizes() -> None:
    from pydantic import ValidationError

    for size in ("12", True, None):
        with pytest.raises(ValidationError):
            CreateSessionInput(policy="user-avatar", fileName="a.png", size=size, mimeType="image/png")


def test_default_storage_key_keeps_version_id_underscores() -> None:
    from filefn.server.policies import PolicyStoragePathContext, compute_storage_path

    policy = Policy(name="p")
    a = compute_storage_path(policy, PolicyStoragePathContext(fileName="x", fileId="file_1", versionId="ver_a__b"))
    b = compute_storage_path(policy, PolicyStoragePathContext(fileName="x", fileId="file_1", versionId="ver_a_b"))
    assert a == "file_1/ver_a__b-x"
    assert a != b



def _nested(depth: int, leaf: Any) -> Any:
    value: Any = leaf
    for _ in range(depth):
        value = [value]
    return value


def test_metadata_size_counts_numbers_like_javascript() -> None:
    from filefn.server.upload_sessions.service import _js_json

    # Expected strings are what JSON.stringify returns for the same values.
    assert _js_json({"n": 1.0, "m": [2.0, 2.5], "t": True, "z": None}) == '{"n":1,"m":[2,2.5],"t":true,"z":null}'
    assert _js_json([1e-7, 1.5e-7, 0.000001, 1e21, 1e20, 5e-324, -0.0, 123.456]) == (
        "[1e-7,1.5e-7,0.000001,1e+21,100000000000000000000,5e-324,0,123.456]"
    )
    # Integers are counted with every digit (they are stored as sent).
    assert _js_json({"n": 10**21, "k": 2**53}) == '{"n":1000000000000000000000,"k":9007199254740992}'
    assert _js_json({"s": "a\"b\n\u00e9"}) == '{"s":"a\\"b\\n\u00e9"}'


@pytest.mark.asyncio
async def test_create_session_accepts_integral_float_size() -> None:
    service = _make_service()
    result = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3.0, mimeType="image/png"),
        _ctx(),
    )
    assert result["uploadSessionId"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override",
    [
        {"fileName": "a\ud800.png"},
        {"fileName": "\ufeff"},
        {"mimeType": "text/plain; x=\ud800"},
        {"metadata": {"note": "x\udfff"}},
        {"metadata": {"\ud800": 1}},
        {"metadata": {"a": _nested(70, "\ud800")}},
        {"metadata": {"a": _nested(40, "ok")}},
        {"idempotencyKey": "k\ud800"},
    ],
)
async def test_create_session_rejects_lone_surrogates(override: Dict[str, Any]) -> None:
    # A lone surrogate is valid JSON but cannot be stored as text; both servers refuse it.
    service = _make_service()
    fields: Dict[str, Any] = {"policy": "user-avatar", "fileName": "a.png", "size": 3, "mimeType": "image/png"}
    fields.update(override)
    with pytest.raises(Exception) as exc_info:
        await service.create_session(CreateSessionInput(**fields), _ctx())
    assert getattr(exc_info.value, "code", "") == "FILEFN_INVALID_REQUEST"


@pytest.mark.asyncio
async def test_core_create_upload_session_maps_type_errors_to_invalid_request() -> None:
    from filefn.server.core import FileFn

    fake = SimpleNamespace(upload_service=_make_service())
    for size in ("12", True):
        with pytest.raises(Exception) as exc_info:
            await FileFn.create_upload_session(  # type: ignore[arg-type]
                fake, {"policy": "user-avatar", "fileName": "a.png", "size": size, "mimeType": "image/png"}, _ctx()
            )
        assert getattr(exc_info.value, "code", "") == "FILEFN_INVALID_REQUEST"


def test_metadata_number_format_ignores_decimal_context() -> None:
    import decimal

    from filefn.server.upload_sessions.service import _js_json

    with decimal.localcontext() as context:
        context.prec = 3
        assert _js_json([1.23456, 100.0, 1e-7]) == "[1.23456,100,1e-7]"


@pytest.mark.asyncio
async def test_metadata_with_huge_integers_is_counted_at_full_length() -> None:
    service = _make_service()
    with pytest.raises(Exception) as exc_info:
        await service.create_session(
            CreateSessionInput(
                policy="user-avatar", fileName="a.png", size=3, mimeType="image/png",
                metadata={"huge": [int("9" * 1000)] * 20},
            ),
            _ctx(),
        )
    assert getattr(exc_info.value, "code", "") == "FILEFN_INVALID_REQUEST"


@pytest.mark.asyncio
async def test_metadata_numbers_are_stored_as_sent() -> None:
    db = FakeDB()
    service = _make_service(db=db)
    huge = int("9" * 100)
    await service.create_session(
        CreateSessionInput(
            policy="user-avatar",
            fileName="a.png",
            size=3,
            mimeType="image/png",
            metadata={"big": 10**21, "huge": [huge] * 2, "safe": 2**53},
        ),
        _ctx(),
    )
    # Stored exactly as sent; only the size count uses JavaScript's numbers.
    stored = db.tables["uploadSessions"][0]["metadata"]
    assert stored == {"big": 10**21, "huge": [huge] * 2, "safe": 2**53}


@pytest.mark.asyncio
async def test_create_session_accepts_any_http_token_media_type() -> None:
    service = _make_service()
    service.policies.register(Policy(name="any"))
    result = await service.create_session(
        CreateSessionInput(policy="any", fileName="a.bin", size=3, mimeType="application/x-example~v1"),
        _ctx(),
    )
    assert result["uploadSessionId"]


@pytest.mark.asyncio
async def test_idempotent_replay_hashes_metadata_as_sent() -> None:
    # The fingerprint uses the metadata as sent, so a session created before
    # number normalisation still matches its retry.
    db = FakeDB()
    service = _make_service(db=db)
    init = CreateSessionInput(
        policy="user-avatar",
        fileName="a.png",
        size=3,
        mimeType="image/png",
        metadata={"n": 9007199254740993},
        idempotencyKey="retry-key",
    )
    first = await service.create_session(init, _ctx())
    replay = await service.create_session(init, _ctx())
    assert replay["uploadSessionId"] == first["uploadSessionId"]
    expected = service._hash_payload(init, _ctx())
    assert db.tables["uploadSessions"][0]["idempotencyPayloadHash"] == expected


@pytest.mark.asyncio
async def test_long_registered_policy_names_still_work() -> None:
    service = _make_service()
    long_name = "p" * 300
    service.policies.register(Policy(name=long_name))
    result = await service.create_session(
        CreateSessionInput(policy=long_name, fileName="a.bin", size=3, mimeType="application/octet-stream"),
        _ctx(),
    )
    assert result["uploadSessionId"]


@pytest.mark.asyncio
async def test_parts_are_bounded_by_the_declared_size() -> None:
    # FILE-30 F-05 (Python): a part may carry at most what the session allows.
    multipart = _make_service(storage=FakeStorage({"signedUploadUrls": True, "multipart": True}))
    created = await multipart.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png"), _ctx()
    )
    for bad, code in [(4, "FILEFN_PART_TOO_LARGE"), (0, "FILEFN_INVALID_REQUEST")]:
        with pytest.raises(Exception) as exc_info:
            await multipart.sign_part(created["uploadSessionId"], 1, bad, _ctx())
        assert getattr(exc_info.value, "code", "") == code
    assert (await multipart.sign_part(created["uploadSessionId"], 1, 3, _ctx()))["url"]

    proxy = _make_service()
    created = await proxy.create_session(
        CreateSessionInput(policy="user-avatar", fileName="b.png", size=3, mimeType="image/png"), _ctx()
    )
    with pytest.raises(Exception) as exc_info:
        await proxy.record_proxy_part(created["uploadSessionId"], 1, b"abcd", _ctx())
    assert getattr(exc_info.value, "code", "") == "FILEFN_PART_TOO_LARGE"


def test_long_key_parts_are_shortened_like_typescript() -> None:
    from types import SimpleNamespace

    from filefn.server.policies import compute_storage_path

    key = compute_storage_path(
        SimpleNamespace(storagePath=None),
        SimpleNamespace(tenantId="t" * 200, principalId="p", fileId="f", versionId="ver_1", fileName="n" * 200 + ".pdf"),
    )
    tenant, _, _, last = key.split("/")
    assert len(tenant.encode()) <= 120 and "%~" in tenant
    assert last.startswith("ver_1-") and last.endswith(".pdf") and "%~" in last


class StatStorage(FakeStorage):
    """Multipart storage that stores `actual_size` bytes, can stat, and consumes upload IDs."""

    def __init__(self, actual_size: int, fail_stats: int = 0) -> None:
        super().__init__({"signedUploadUrls": True, "multipart": True})
        self.actual_size = actual_size
        self.fail_stats = fail_stats

    async def complete_multipart_upload(self, key: str, upload_id: str, parts: list, target: Optional[str] = None):
        if upload_id not in self.multipart:
            raise RuntimeError("NoSuchUpload")
        del self.multipart[upload_id]
        self.objects[key] = b"x" * self.actual_size
        return {"key": key}

    async def stat_object(self, key: str, target: Optional[str] = None) -> Dict[str, Any]:
        if self.fail_stats:
            self.fail_stats -= 1
            raise RuntimeError("transient stat failure")
        if key not in self.objects:
            raise KeyError(key)
        return {"key": key, "size": len(self.objects[key])}


async def _multipart_session(service: UploadSessionService, size: int = 3) -> Dict[str, Any]:
    session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=size, mimeType="image/png"), _ctx()
    )
    for part_number in range(1, session["totalParts"] + 1):
        part_size = min(3, size - (part_number - 1) * 3)
        await service.complete_part(session["uploadSessionId"], part_number, f"etag-{part_number}", part_size, _ctx())
    return session


@pytest.mark.asyncio
async def test_multipart_size_mismatch_deletes_only_the_session_object_and_aborts() -> None:
    db = FakeDB()
    storage = StatStorage(actual_size=50)
    service = _make_service(db=db, storage=storage)
    session = await _multipart_session(service)
    key = db.tables["uploadSessions"][0]["storageKey"]
    with pytest.raises(errors.FileFnError) as mismatch:
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert mismatch.value.code == "FILEFN_UPLOAD_SIZE_MISMATCH"
    assert key not in storage.objects
    assert db.tables["uploadSessions"][0]["status"] == "aborted"
    assert not db.tables.get("files") and not db.tables.get("fileVersions")
    # A retry is refused before storage is touched again.
    with pytest.raises(errors.FileFnError) as aborted:
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert aborted.value.code == "FILEFN_UPLOAD_ABORTED"


@pytest.mark.asyncio
async def test_multipart_retry_after_a_failed_stat_verifies_the_finalized_object() -> None:
    db = FakeDB()
    storage = StatStorage(actual_size=3, fail_stats=1)
    service = _make_service(db=db, storage=storage)
    session = await _multipart_session(service)
    with pytest.raises(errors.FileFnError) as unreadable:
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert unreadable.value.code == "FILEFN_STORAGE_ERROR"
    # The upload ID is consumed; the retry finds the session's own object and checks its size.
    result = await service.complete_session(session["uploadSessionId"], _ctx())
    assert result["versionId"] in db.tables["uploadSessions"][0]["storageKey"]


@pytest.mark.asyncio
async def test_routed_storage_forwards_stat_object() -> None:
    from filefn.server.routed_storage import create_routed_storage_adapter

    db = FakeDB()
    inner = StatStorage(actual_size=50)
    routed = create_routed_storage_adapter({"durable": inner}, default_target="durable")
    routed.capabilities = inner.capabilities  # type: ignore[attr-defined]
    service = _make_service(db=db, storage=routed)  # type: ignore[arg-type]
    session = await _multipart_session(service)
    with pytest.raises(errors.FileFnError) as mismatch:
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert mismatch.value.code == "FILEFN_UPLOAD_SIZE_MISMATCH"


@pytest.mark.asyncio
async def test_policy_storage_path_must_include_the_version_id() -> None:
    service = create_upload_session_service(
        UploadSessionServiceConfig(
            db=FakeDB(),
            storage=FakeStorage({"proxyStreamingUpload": True}),
            policies=create_policy_registry(
                [Policy(name="shared", storagePath=lambda c: f"{c.tenantId}/{c.fileId}/{c.fileName}")]
            ),
            events=create_event_emitter(),
            namespace="filefn",
            default_chunk_size_bytes=3,
            upload_session_ttl_seconds=3600,
        )
    )
    with pytest.raises(errors.FileFnError) as refused:
        await service.create_session(CreateSessionInput(policy="shared", fileName="a.png", size=3, mimeType="image/png"), _ctx())
    assert refused.value.code == "FILEFN_STORAGE_PATH_NOT_PER_VERSION"
    assert refused.value.status == 500


@pytest.mark.asyncio
async def test_zero_byte_upload_signs_its_empty_part_and_parts_need_integer_sizes() -> None:
    service = _make_service(storage=FakeStorage({"signedUploadUrls": True, "multipart": True}))
    empty = await service.create_session(CreateSessionInput(policy="user-avatar", fileName="a.png", size=0, mimeType="image/png"), _ctx())
    signed = await service.sign_part(empty["uploadSessionId"], 1, 0, _ctx())
    assert signed["url"]
    other = await service.create_session(CreateSessionInput(policy="user-avatar", fileName="b.png", size=3, mimeType="image/png"), _ctx())
    with pytest.raises(errors.FileFnError):
        await service.sign_part(other["uploadSessionId"], 1, 0, _ctx())
    # A whole-number float is the same JSON number as the integer.
    assert (await service.complete_part(other["uploadSessionId"], 1, "etag-1", 3.0, _ctx()))["recorded"]  # type: ignore[arg-type]
    for bad in ["3", None, True, -1, 1.5]:
        with pytest.raises(errors.FileFnError) as invalid:
            await service.complete_part(other["uploadSessionId"], 1, "etag-1", bad, _ctx())  # type: ignore[arg-type]
        assert invalid.value.code == "FILEFN_INVALID_REQUEST"


@pytest.mark.parametrize(
    "mime_type,ok",
    [
        ("image/png", True),
        ('image/png; name="a b"', True),
        ("image/png; charset=utf-8", True),
        ("image/png;", True),
        ("image/png;\u20ac", False),
        ("image/png; foo", False),
        ('image/png;"x', False),
        ("image/png; a=b c", False),
    ],
)
def test_mime_type_grammar_matches_typescript(mime_type: str, ok: bool) -> None:
    from filefn.server.upload_sessions.service import _MIME_TYPE

    assert bool(_MIME_TYPE.fullmatch(mime_type)) is ok


def test_drive_qualified_keys_are_unsafe() -> None:
    from filefn.server.policies import unsafe_storage_key_reason

    assert unsafe_storage_key_reason("C:/Windows/x") == "absolute key"
    assert unsafe_storage_key_reason("c:") == "absolute key"
    assert unsafe_storage_key_reason("C:x/y") == "absolute key"
    assert unsafe_storage_key_reason("ab:c/x") is None
    # Default keys stay usable: a drive-like segment start is encoded.
    from filefn.server.policies import sanitize_storage_key_segment

    assert sanitize_storage_key_segment("a:b") == "a%3Ab"
    assert sanitize_storage_key_segment("ab:c") == "ab:c"


class FailOnceSessionUpdate(FakeDB):
    """Fails the first write of status `completed`, after the version row is written."""

    failed = False

    async def update(self, model: str, where: List[Dict[str, Any]], data: Dict[str, Any], namespace: Optional[str] = None):
        if model == "uploadSessions" and data.get("status") == "completed" and not self.failed:
            self.failed = True
            raise RuntimeError("database timeout")
        return await super().update(model, where, data, namespace)


async def _proxy_session_published_without_completed() -> Any:
    """A proxy session whose completion published its version, then failed to write `completed`."""
    db = FailOnceSessionUpdate()
    service = _make_service(db=db)
    session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png"), _ctx()
    )
    await service.record_proxy_part(session["uploadSessionId"], 1, b"abc", _ctx())
    with pytest.raises(RuntimeError):
        await service.complete_session(session["uploadSessionId"], _ctx())
    return db, service, session


@pytest.mark.asyncio
async def test_retry_after_the_version_was_written_finishes_the_session() -> None:
    db = FailOnceSessionUpdate()
    storage = StatStorage(actual_size=3)
    service = _make_service(db=db, storage=storage)
    session = await _multipart_session(service)
    with pytest.raises(RuntimeError):
        await service.complete_session(session["uploadSessionId"], _ctx())
    result = await service.complete_session(session["uploadSessionId"], _ctx())
    assert db.tables["uploadSessions"][0]["status"] == "completed"
    assert [row["versionId"] for row in db.tables["fileVersions"]] == [result["versionId"]]


@pytest.mark.asyncio
async def test_proxy_retry_after_the_version_was_written_cleans_up_after_completed_status() -> None:
    db, service, session = await _proxy_session_published_without_completed()
    session_id = session["uploadSessionId"]
    part_key, = set(service.storage.objects) - {db.tables["fileVersions"][0]["storageKey"]}
    legacy_etag = "01234567" * 4
    db.tables["uploadParts"][0]["etag"] = legacy_etag
    retry = await service.record_proxy_part(session_id, 1, b"abc", _ctx())
    assert retry["etag"] == legacy_etag

    result = await service.complete_session(session_id, _ctx())
    assert part_key not in service.storage.objects
    assert db.tables["uploadSessions"][0]["status"] == "completed"
    assert [row["versionId"] for row in db.tables["fileVersions"]] == [result["versionId"]]


@pytest.mark.asyncio
async def test_expiry_sweep_keeps_a_published_session_for_its_retry() -> None:
    db, service, session = await _proxy_session_published_without_completed()
    db.tables["uploadSessions"][0]["expiresAt"] = "2001-01-01T00:00:00+00:00"
    await service.garbage_collect_expired_sessions()
    # The session survives untouched; the client's retry finishes it normally.
    assert db.tables["uploadSessions"][0]["status"] != "completed"
    result = await service.complete_session(session["uploadSessionId"], _ctx())
    assert db.tables["uploadSessions"][0]["status"] == "completed"
    assert [row["versionId"] for row in db.tables["fileVersions"]] == [result["versionId"]]


@pytest.mark.asyncio
async def test_retry_after_expiry_still_finishes_a_published_version() -> None:
    db, service, session = await _proxy_session_published_without_completed()
    # The file is live; the session expired before the client retried.
    db.tables["uploadSessions"][0]["expiresAt"] = "2001-01-01T00:00:00+00:00"
    result = await service.complete_session(session["uploadSessionId"], _ctx())
    assert db.tables["uploadSessions"][0]["status"] == "completed"
    assert [row["versionId"] for row in db.tables["fileVersions"]] == [result["versionId"]]


@pytest.mark.asyncio
async def test_legacy_session_sharing_a_published_key_must_restart() -> None:
    db = FakeDB()
    storage = StatStorage(actual_size=3)
    service = _make_service(db=db, storage=storage)
    session = await _multipart_session(service)
    row = db.tables["uploadSessions"][0]
    # A pre-upgrade session: no version ID of its own, and a key a published version uses.
    row["completionVersionId"] = None
    await db.create(model="fileVersions", data={"versionId": "ver_old", "fileId": "file_other", "storageKey": row["storageKey"], "size": 3})
    with pytest.raises(errors.FileFnError) as restart:
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert restart.value.code == "FILEFN_INVALID_REQUEST"
    assert row["status"] == "aborted"
    assert row["storageKey"] not in storage.objects


@pytest.mark.asyncio
async def test_metadata_with_non_finite_numbers_is_refused() -> None:
    service = _make_service()
    with pytest.raises(errors.FileFnError) as refused:
        await service.create_session(
            CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png", metadata={"x": float("inf")}),
            _ctx(),
        )
    assert refused.value.code == "FILEFN_INVALID_REQUEST"


@pytest.mark.asyncio
async def test_pending_to_in_progress_never_overwrites_an_aborted_session() -> None:
    db = FakeDB()
    service = _make_service(db=db)
    session = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png"), _ctx()
    )
    db.tables["uploadSessions"][0]["status"] = "aborted"
    await service._set_status_if(session["uploadSessionId"], "pending", "in_progress")
    assert db.tables["uploadSessions"][0]["status"] == "aborted"


@pytest.mark.asyncio
async def test_expiry_sweep_deletes_an_unpublished_object_whose_delete_failed() -> None:
    class DeleteFailsOnce(StatStorage):
        failed = False

        async def delete_object(self, key: str, target: Optional[str] = None) -> None:
            if not self.failed:
                self.failed = True
                raise RuntimeError("storage unavailable")
            await super().delete_object(key, target)

    db = FakeDB()
    storage = DeleteFailsOnce(actual_size=50)
    service = _make_service(db=db, storage=storage)
    session = await _multipart_session(service)
    key = db.tables["uploadSessions"][0]["storageKey"]
    with pytest.raises(errors.FileFnError):
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert key in storage.objects
    db.tables["uploadSessions"][0]["expiresAt"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await service.garbage_collect_expired_sessions()
    assert key not in storage.objects
    assert not db.tables["uploadSessions"]


@pytest.mark.asyncio
async def test_refused_session_keeps_its_object_for_the_sweep_and_replays_ask_for_a_new_key() -> None:
    class DeleteFails(StatStorage):
        async def delete_object(self, key: str, target: Optional[str] = None) -> None:
            raise RuntimeError("storage unavailable")

    db = FakeDB()
    storage = DeleteFails(actual_size=50)
    service = _make_service(db=db, storage=storage)
    init = CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png", idempotencyKey="key-1")
    session = await service.create_session(init, _ctx())
    await service.complete_part(session["uploadSessionId"], 1, "etag-1", 3, _ctx())
    with pytest.raises(errors.FileFnError):
        await service.complete_session(session["uploadSessionId"], _ctx())
    assert db.tables["uploadSessions"][0]["status"] == "refused"
    status = await service.get_session_status(session["uploadSessionId"], _ctx())
    assert status["status"] == "aborted"
    # An abort leaves it refused, so the sweep still deletes the object.
    await service.abort_session(session["uploadSessionId"], _ctx())
    assert db.tables["uploadSessions"][0]["status"] == "refused"
    with pytest.raises(errors.FileFnError) as replay:
        await service.create_session(init, _ctx())
    assert replay.value.code == "FILEFN_UPLOAD_ABORTED"
    # The sweep keeps the row while the delete keeps failing.
    db.tables["uploadSessions"][0]["expiresAt"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await service.garbage_collect_expired_sessions()
    assert db.tables["uploadSessions"]


@pytest.mark.asyncio
async def test_abort_and_sweep_never_overwrite_a_session_refused_meanwhile() -> None:
    db = FakeDB()

    class RefusesDuringCleanup(StatStorage):
        async def abort_multipart_upload(self, key: str, upload_id: str, target: Optional[str] = None) -> None:
            # A completion refuses the session while abort or the sweep is mid-way.
            db.tables["uploadSessions"][0]["status"] = "refused"

    storage = RefusesDuringCleanup(actual_size=3)
    service = _make_service(db=db, storage=storage)
    session = await _multipart_session(service)
    await service.abort_session(session["uploadSessionId"], _ctx())
    assert db.tables["uploadSessions"][0]["status"] == "refused"

    db.tables["uploadSessions"][0]["status"] = "in_progress"
    db.tables["uploadSessions"][0]["expiresAt"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await service.garbage_collect_expired_sessions()
    assert [row["status"] for row in db.tables["uploadSessions"]] == ["refused"]


@pytest.mark.asyncio
async def test_init_body_shape_null_metadata_and_mime_controls_match_typescript() -> None:
    from filefn.server.core import FileFn

    service = _make_service()
    with pytest.raises(errors.FileFnError) as null_metadata:
        await service.create_session(
            CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png", metadata=None), _ctx()
        )
    assert null_metadata.value.code == "FILEFN_INVALID_REQUEST"
    # Quoted obs-text such as U+0085 is allowed by the grammar, as in TypeScript.
    from filefn.server.upload_sessions.service import _validate_upload_init

    _validate_upload_init(CreateSessionInput(policy="any", fileName="b.png", size=3, mimeType='image/png; name="a\u0085b"'))

    fake = object.__new__(FileFn)
    fake.upload_service = service  # type: ignore[attr-defined]
    with pytest.raises(errors.FileFnError) as not_object:
        await fake.create_upload_session([1, 2], _ctx())  # type: ignore[arg-type]
    assert not_object.value.code == "FILEFN_INVALID_REQUEST"


def test_explicit_surrogate_pairs_are_read_as_code_points_in_keys() -> None:
    from filefn.server.policies import sanitize_storage_key_segment

    assert sanitize_storage_key_segment("😀") == "\U0001F600"

def test_nobody_owns_an_anonymous_file() -> None:
    # FILE-30 F-02: every unauthenticated caller shares the principal `anonymous`.
    from filefn.server.authz.ownership import is_file_owner

    anon_file = SimpleNamespace(ownerId="anonymous")
    assert not is_file_owner(anon_file, SimpleNamespace(principalId="anonymous"))
    assert not is_file_owner(anon_file, SimpleNamespace(principalId=None))
    assert is_file_owner(SimpleNamespace(ownerId="alice"), SimpleNamespace(principalId="alice"))
    assert not is_file_owner(SimpleNamespace(ownerId=None), SimpleNamespace(principalId=""))


@pytest.mark.asyncio
async def test_legacy_raw_idempotency_key_replays_for_its_owner_only() -> None:
    db = FakeDB()
    service = _make_service(db=db)
    init = CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png", idempotencyKey="legacy")
    first = await service.create_session(init, _ctx(principal_id="alice"))
    db.tables["uploadSessions"][0]["idempotencyKey"] = "legacy"
    replay = await service.create_session(init, _ctx(principal_id="alice"))
    assert replay["uploadSessionId"] == first["uploadSessionId"]


@pytest.mark.asyncio
async def test_session_without_owner_is_refused() -> None:
    db = FakeDB()
    service = _make_service(db=db)
    created = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="a.png", size=3, mimeType="image/png"),
        _ctx(principal_id="alice"),
    )
    db.tables["uploadSessions"][0]["ownerId"] = None
    with pytest.raises(Exception) as exc_info:
        await service.get_session_status(created["uploadSessionId"], _ctx(principal_id="mallory"))
    assert getattr(exc_info.value, "code", "") == "FILEFN_FORBIDDEN"


@pytest.mark.asyncio
async def test_a_second_completion_rechecks_write_access_to_a_file_created_meanwhile() -> None:
    # FILE-30 F-02 (Python): two anonymous sessions for one client-chosen fileId;
    # after the first creates the file, the second may not replace it.
    from filefn.server.authz.ownership import is_file_owner

    db = FakeDB()
    service = _make_service(db=db)

    class OwnerOnly:
        async def can_write_file(self, file_id: str, ctx: Any) -> bool:
            row = await db.find_one(model="files", where=[{"field": "fileId", "operator": "eq", "value": file_id}])
            return row is None or is_file_owner(SimpleNamespace(**row), ctx)

    service.file_write_checker = OwnerOnly()
    anon = _ctx(principal_id=None, tenant_id=None)
    sessions = []
    for name in ("a.png", "b.png"):
        created = await service.create_session(
            CreateSessionInput(policy="user-avatar", fileName=name, size=3, mimeType="image/png", fileId="file_shared01"), anon
        )
        token_ctx = _ctx(principal_id=None, tenant_id=None, upload_session_token=created["uploadSessionToken"])
        await service.record_proxy_part(created["uploadSessionId"], 1, b"abc", token_ctx)
        sessions.append((created["uploadSessionId"], token_ctx))

    await service.complete_session(sessions[0][0], sessions[0][1])
    with pytest.raises(Exception) as exc_info:
        await service.complete_session(sessions[1][0], sessions[1][1])
    assert getattr(exc_info.value, "code", "") == "FILEFN_FORBIDDEN"

    # A file replaced between the check and the update is not overwritten.
    owner = _ctx(principal_id="owner_1")
    created = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="c.png", size=3, mimeType="image/png", fileId="file_owned001"), owner
    )
    await service.record_proxy_part(created["uploadSessionId"], 1, b"abc", owner)
    await service.complete_session(created["uploadSessionId"], owner)
    second = await service.create_session(
        CreateSessionInput(policy="user-avatar", fileName="d.png", size=3, mimeType="image/png", fileId="file_owned001"), owner
    )
    await service.record_proxy_part(second["uploadSessionId"], 1, b"abc", owner)
    original_update = db.update

    async def racing_update(model: str, where: Any, data: Any, namespace: Any = None) -> Any:
        if model == "files":
            # Another writer replaced the row after the authorization.
            for row in db._table("files"):
                if row["fileId"] == "file_owned001":
                    row["currentVersionId"] = "ver_other"
        return await original_update(model=model, where=where, data=data, namespace=namespace)

    db.update = racing_update  # type: ignore[method-assign]
    # The conditional update misses once (the row moved); the owner is
    # re-authorized against the new row and the replacement goes through.
    result = await service.complete_session(second["uploadSessionId"], owner)
    row = next(r for r in db._table("files") if r["fileId"] == "file_owned001")
    assert row["currentVersionId"] == result["versionId"]


@pytest.mark.asyncio
async def test_storage_path_without_the_version_id_is_refused() -> None:
    db = FakeDB()
    service = _make_service(db=db)
    service.policies.register(Policy(name="flat", storagePath=lambda ctx: f"{ctx.fileId}/{ctx.fileName}"))
    with pytest.raises(Exception) as exc_info:
        await service.create_session(
            CreateSessionInput(policy="flat", fileName="a.png", size=3, mimeType="image/png"), _ctx()
        )
    assert getattr(exc_info.value, "code", "") == "FILEFN_STORAGE_PATH_NOT_PER_VERSION"
