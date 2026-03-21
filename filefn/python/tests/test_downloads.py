from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from filefn.server import create_event_emitter
from filefn.server.files.service import FileServiceConfig, create_file_service
from filefn.server.shares.service import CreateShareLinkInput, SharesServiceConfig, create_shares_service


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

    async def sign_download_url(self, key: str, expires_in_seconds: int) -> Dict[str, Any]:
        if not self.with_signing:
            raise RuntimeError("signing not supported")
        return {"url": f"https://download.local/{key}", "headers": {}}

    async def open_download_stream(self, key: str):
        async def _gen():
            yield b"bytes"

        return _gen()

    async def delete_object(self, key: str) -> None:
        return None


def _ctx(principal_id: Optional[str], tenant_id: Optional[str] = "org_123"):
    return SimpleNamespace(principalId=principal_id, tenantId=tenant_id, requestId="req_001")


async def _seed_file_rows(db: FakeDB) -> None:
    now = datetime.now(timezone.utc).isoformat()
    await db.create(
        model="files",
        data={
            "fileId": "file_0001",
            "currentVersionId": "ver_0001",
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
        model="fileVersions",
        data={
            "versionId": "ver_0001",
            "fileId": "file_0001",
            "storageKey": "org_123/user_123/file_0001/ver_0001-a.png",
            "mimeType": "image/png",
            "size": 3,
            "checksumSha256Base64": None,
            "tenantId": "org_123",
            "createdAt": now,
        },
    )
    await db.create(
        model="fileVersions",
        data={
            "versionId": "ver_other_file",
            "fileId": "file_9999",
            "storageKey": "org_123/user_123/file_9999/ver_other_file-a.png",
            "mimeType": "image/png",
            "size": 3,
            "checksumSha256Base64": None,
            "tenantId": "org_123",
            "createdAt": now,
        },
    )


@pytest.mark.asyncio
async def test_file_download_urls_are_real_and_enforce_version_binding() -> None:
    db = FakeDB()
    await _seed_file_rows(db)

    file_service = create_file_service(
        FileServiceConfig(
            db=db,
            storage=FakeStorage(with_signing=False),
            events=create_event_emitter(),
            namespace="filefn",
        )
    )

    good = await file_service.get_download_url("file_0001", "ver_0001", _ctx("user_123"))
    assert good["url"] == "/proxy/files/file_0001/versions/ver_0001/download"
    assert not good["url"].startswith("proxy://")

    with pytest.raises(Exception) as exc_info:
        await file_service.get_download_url("file_0001", "ver_other_file", _ctx("user_123"))
    assert getattr(exc_info.value, "code", "") == "FILEFN_NOT_FOUND"

    with pytest.raises(Exception) as exc_file:
        await file_service.get_file("file_0001", _ctx("user_123"), version_id="ver_other_file")
    assert getattr(exc_file.value, "code", "") == "FILEFN_NOT_FOUND"


@pytest.mark.asyncio
async def test_share_download_returns_http_descriptor_and_increments_after_descriptor() -> None:
    db = FakeDB()
    await _seed_file_rows(db)

    shares_service = create_shares_service(
        SharesServiceConfig(
            db=db,
            storage=FakeStorage(with_signing=False),
            namespace="filefn",
        )
    )

    create_res = await shares_service.create_share_link(
        CreateShareLinkInput(fileId="file_0001", versionId="ver_0001"),
        _ctx("user_123"),
    )

    token = create_res["token"]
    descriptor = await shares_service.download_via_share_link(token, _ctx(None), is_authenticated=False)

    assert descriptor["url"] == f"/proxy/share-links/{token}/download"
    assert descriptor["url"].startswith("/")

    share_rows = await db.find_many("fileShares", where=[])
    assert share_rows[0]["downloads"] == 1


@pytest.mark.asyncio
async def test_share_download_binding_mismatch_is_not_found_and_downloads_not_incremented() -> None:
    db = FakeDB()
    await _seed_file_rows(db)

    shares_service = create_shares_service(
        SharesServiceConfig(
            db=db,
            storage=FakeStorage(with_signing=False),
            namespace="filefn",
        )
    )

    token = "shr_live_bad"
    await db.create(
        model="fileShares",
        data={
            "tokenHash": shares_service._hash_token(token),  # parity check for token hashing path
            "fileId": "file_0001",
            "versionId": "ver_other_file",
            "expiresAt": None,
            "requiresAuth": False,
            "maxDownloads": None,
            "downloads": 0,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "revokedAt": None,
        },
    )

    with pytest.raises(Exception) as exc_info:
        await shares_service.download_via_share_link(token, _ctx(None), is_authenticated=False)
    assert getattr(exc_info.value, "code", "") == "FILEFN_NOT_FOUND"

    share_rows = await db.find_many("fileShares", where=[])
    assert share_rows[0]["downloads"] == 0
