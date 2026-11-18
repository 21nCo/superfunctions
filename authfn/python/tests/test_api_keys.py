"""API key plugin tests for authfn Python."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock

import pytest

TESTS_DIR = os.path.dirname(__file__)
AUTHFN_PYTHON_ROOT = os.path.abspath(os.path.join(TESTS_DIR, ".."))
PYTHON_CORE_ROOT = os.path.abspath(
    os.path.join(TESTS_DIR, "..", "..", "..", "packages", "python-core")
)

for path in (AUTHFN_PYTHON_ROOT, PYTHON_CORE_ROOT):
    if path not in sys.path:
        sys.path.insert(0, path)

from authfn import (
    ApiKeyRevokedError,
    AuthFnConfig,
    ExpiredCredentialsError,
    ValidationError,
)
from authfn.plugins.api_keys import ApiKeyPluginConfig, ApiKeyService, authfn_api_key_plugin


class MockDatabaseAdapter:
    def __init__(self) -> None:
        self.storage: Dict[str, List[Dict[str, Any]]] = {"api_keys": []}
        self.find_one_calls: List[Dict[str, Any]] = []

    async def find_one(
        self,
        model: str,
        where: List[Dict[str, Any]],
        namespace: str,
    ) -> Optional[Dict[str, Any]]:
        self.find_one_calls.append({"model": model, "where": where, "namespace": namespace})
        for row in self.storage.get(model, []):
            if _matches(row, where):
                return row
        return None

    async def find_many(
        self,
        model: str,
        where: List[Dict[str, Any]],
        order_by: Optional[List[Dict[str, Any]]] = None,
        namespace: str = "authfn",
    ) -> List[Dict[str, Any]]:
        rows = [row for row in self.storage.get(model, []) if _matches(row, where)]
        if order_by:
            for entry in reversed(order_by):
                reverse = entry["direction"] == "desc"
                rows.sort(key=lambda item: item.get(entry["field"]), reverse=reverse)
        return rows

    async def create(self, model: str, data: Dict[str, Any], namespace: str) -> Dict[str, Any]:
        self.storage.setdefault(model, []).append(dict(data))
        return self.storage[model][-1]

    async def update(
        self,
        model: str,
        where: List[Dict[str, Any]],
        data: Dict[str, Any],
        namespace: str,
    ) -> Dict[str, Any]:
        for row in self.storage.get(model, []):
            if _matches(row, where):
                row.update(data)
                return row
        raise AssertionError(f"row not found in {model}")


def _matches(row: Dict[str, Any], clauses: List[Dict[str, Any]]) -> bool:
    for clause in clauses:
        operator = clause["operator"]
        field = clause["field"]
        value = clause["value"]
        if operator == "eq" and row.get(field) != value:
            return False
    return True


class MockRequest:
    def __init__(self, headers: Dict[str, str]) -> None:
        self.headers = headers


@pytest.mark.asyncio
async def test_api_key_plugin_schema_and_routes() -> None:
    plugin = authfn_api_key_plugin()
    schema = plugin.schema(AuthFnConfig(database=object()))
    routes = plugin.routes(
        type(
            "Ctx",
            (),
            {"config": AuthFnConfig(database=object()), "namespace": "authfn", "base_path": "/auth"},
        )()
    )

    assert schema[0]["modelName"] == "api_keys"
    assert {route["path"] for route in routes} == {"/api-keys", "/api-keys/:keyId"}
    assert {route["method"] for route in routes} == {"POST", "GET", "DELETE"}


@pytest.mark.asyncio
async def test_create_list_authenticate_and_revoke_api_keys() -> None:
    db = MockDatabaseAdapter()
    db.storage["users"] = [{"id": "user_1"}]
    service = ApiKeyService(
        AuthFnConfig(database=db, namespace="authfn"),
        ApiKeyPluginConfig(now=lambda: datetime(2026, 3, 22, 0, 0, 0)),
    )

    created = await service.create_key(
        user_id="user_1",
        name="server-to-server",
        scopes=["read"],
    )
    assert created["keyId"].startswith("key_")
    assert created["secret"].startswith("ak_")
    assert db.storage["api_keys"][0]["secretHash"] != created["secret"]

    listed = await service.list_keys(user_id="user_1")
    assert listed == [
        {
            "id": created["keyId"],
            "userId": "user_1",
            "name": "server-to-server",
            "scopes": ["read"],
            "metadata": {},
            "expiresAt": None,
            "revokedAt": None,
            "lastUsedAt": None,
            "createdAt": datetime(2026, 3, 22, 0, 0, 0),
            "updatedAt": datetime(2026, 3, 22, 0, 0, 0),
        }
    ]

    authenticated = await service.authenticate(
        MockRequest({"authorization": f"Bearer {created['secret']}"})
    )
    assert authenticated is not None
    assert authenticated.type == "api-key"
    assert authenticated.methods == ["api-key"]

    await service.revoke_key(key_id=created["keyId"], user_id="user_1")
    with pytest.raises(ApiKeyRevokedError):
        await service.authenticate(MockRequest({"authorization": f"Bearer {created['secret']}"}))


@pytest.mark.asyncio
async def test_create_api_key_rejects_oversized_user_id_before_persistence() -> None:
    db = MockDatabaseAdapter()
    service = ApiKeyService(AuthFnConfig(database=db, namespace="authfn"))

    with pytest.raises(ValidationError, match="userId must contain at most 255 characters"):
        await service.create_key(user_id="u" * 256, name="oversized-user")

    assert db.storage["api_keys"] == []


@pytest.mark.asyncio
async def test_create_api_key_allows_persisted_legacy_user_id() -> None:
    db = MockDatabaseAdapter()
    user_id = "legacy-user-".ljust(300, "x")
    db.storage["users"] = [{"id": user_id}]
    service = ApiKeyService(
        AuthFnConfig(database=db, namespace="authfn"),
        ApiKeyPluginConfig(now=lambda: datetime(2026, 3, 22, 0, 0, 0)),
    )

    created = await service.create_key(user_id=user_id, name="legacy-key")

    assert created["record"]["userId"] == user_id
    assert len(db.storage["api_keys"]) == 1


@pytest.mark.asyncio
async def test_create_api_key_rejects_legacy_user_id_wider_than_reference_column() -> None:
    db = MockDatabaseAdapter()
    user_id = "legacy-user-".ljust(768, "x")
    db.storage["users"] = [{"id": user_id}]
    db.find_one = AsyncMock(side_effect=AssertionError("oversized ID reached the database"))
    service = ApiKeyService(AuthFnConfig(database=db, namespace="authfn"))

    with pytest.raises(ValidationError) as exc_info:
        await service.create_key(user_id=user_id, name="too-wide-legacy-key")

    assert exc_info.value.details == {
        "fieldName": "userId",
        "maxLength": 767,
        "actualLength": 768,
    }
    assert db.storage["api_keys"] == []
    db.find_one.assert_not_awaited()


NOW = datetime(2026, 3, 22, 0, 0, 0)
LATER = datetime(2026, 3, 23, 0, 0, 0)


async def _owned_key_setup(
    *,
    owner: Optional[Dict[str, Any]] = None,
    user_id: Optional[str] = "user_owner",
    metadata: Optional[Dict[str, Any]] = None,
    namespace: str = "tenant_ns",
) -> Any:
    db = MockDatabaseAdapter()
    db.storage["users"] = [owner] if owner is not None else []
    clock = {"now": NOW}
    service = ApiKeyService(
        AuthFnConfig(database=db, namespace=namespace),
        ApiKeyPluginConfig(now=lambda: clock["now"]),
    )
    created = await service.create_key(
        user_id=user_id, name="owned", scopes=["read"], metadata=metadata
    )
    clock["now"] = LATER
    request = MockRequest({"authorization": f"Bearer {created['secret']}"})
    return db, service, created, request


@pytest.mark.asyncio
async def test_owned_api_key_session_acts_as_owner_and_carries_credential() -> None:
    db, service, created, request = await _owned_key_setup(owner={"id": "user_owner"})

    session = await service.authenticate(request)

    assert session is not None
    assert session.type == "api-key"
    assert session.actor_type == "user"
    assert session.actor_id == "user_owner"
    assert session.subject is not None
    assert session.subject.actor_type == "user"
    assert session.subject.actor_id == "user_owner"
    assert session.credential is not None
    assert session.credential.type == "api-key"
    assert session.credential.id == created["keyId"]
    assert session.id == created["keyId"]
    assert session.metadata == {"ownerUserId": "user_owner", "scopes": ["read"]}
    assert session.model_dump(by_alias=True)["credential"] == {
        "type": "api-key",
        "id": created["keyId"],
    }
    assert db.storage["api_keys"][0]["lastUsedAt"] == LATER.replace(tzinfo=timezone.utc)
    owner_lookups = [call for call in db.find_one_calls if call["model"] == "users"]
    assert owner_lookups == [
        {
            "model": "users",
            "where": [{"field": "id", "operator": "eq", "value": "user_owner"}],
            "namespace": "tenant_ns",
        }
    ]


@pytest.mark.asyncio
async def test_unowned_api_key_keeps_api_key_actor_and_carries_credential() -> None:
    db, service, created, request = await _owned_key_setup(user_id=None)

    session = await service.authenticate(request)

    assert session is not None
    assert session.actor_type == "api-key"
    assert session.actor_id == created["keyId"]
    assert session.subject is not None
    assert session.subject.actor_type == "api-key"
    assert session.subject.actor_id == created["keyId"]
    assert session.credential is not None
    assert session.credential.id == created["keyId"]
    assert session.metadata == {"ownerUserId": None, "scopes": ["read"]}
    assert not any(call["model"] == "users" for call in db.find_one_calls)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "owner",
    [
        pytest.param(None, id="deleted-owner"),
        pytest.param({"id": "user_owner", "metadata": {"disabled": True}}, id="disabled-owner"),
    ],
)
async def test_api_key_of_deleted_or_disabled_owner_fails_without_touching_key(
    owner: Optional[Dict[str, Any]],
) -> None:
    db, service, _created, request = await _owned_key_setup(owner=owner)

    assert await service.authenticate(request) is None
    key = db.storage["api_keys"][0]
    assert key["lastUsedAt"] is None
    assert key["updatedAt"] == NOW


@pytest.mark.asyncio
@pytest.mark.parametrize("disabled", ["true", 1, False, None])
async def test_api_key_owner_is_disabled_only_by_metadata_disabled_true(disabled: Any) -> None:
    _db, service, _created, request = await _owned_key_setup(
        owner={"id": "user_owner", "metadata": {"disabled": disabled}}
    )

    session = await service.authenticate(request)

    assert session is not None
    assert session.actor_id == "user_owner"


@pytest.mark.asyncio
async def test_api_key_authenticates_again_after_owner_is_re_enabled() -> None:
    owner = {"id": "user_owner", "metadata": {"disabled": True}}
    db, service, _created, request = await _owned_key_setup(owner=owner)
    assert await service.authenticate(request) is None
    assert db.storage["api_keys"][0]["lastUsedAt"] is None

    owner["metadata"] = {"disabled": False}
    session = await service.authenticate(request)

    assert session is not None
    assert session.actor_type == "user"
    assert session.actor_id == "user_owner"
    assert db.storage["api_keys"][0]["lastUsedAt"] == LATER.replace(tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_stored_key_metadata_cannot_override_owner_or_scopes() -> None:
    _db, service, _created, request = await _owned_key_setup(
        owner={"id": "user_owner"},
        metadata={"ownerUserId": "user_forged", "scopes": ["admin"], "label": "ci"},
    )

    session = await service.authenticate(request)

    assert session is not None
    assert session.actor_id == "user_owner"
    assert session.metadata == {
        "label": "ci",
        "ownerUserId": "user_owner",
        "scopes": ["read"],
    }

    _db, unowned_service, _created, unowned_request = await _owned_key_setup(
        user_id=None, metadata={"ownerUserId": "user_forged"}
    )
    unowned = await unowned_service.authenticate(unowned_request)
    assert unowned is not None
    assert unowned.actor_type == "api-key"
    assert unowned.metadata is not None
    assert unowned.metadata["ownerUserId"] is None


@pytest.mark.asyncio
async def test_revoked_and_expired_owned_keys_fail_before_owner_lookup() -> None:
    db, service, created, request = await _owned_key_setup(owner={"id": "user_owner"})
    await service.revoke_key(key_id=created["keyId"])
    with pytest.raises(ApiKeyRevokedError):
        await service.authenticate(request)

    expired_db = MockDatabaseAdapter()
    expired_db.storage["users"] = [{"id": "user_owner"}]
    expired_service = ApiKeyService(
        AuthFnConfig(database=expired_db, namespace="authfn"),
        ApiKeyPluginConfig(now=lambda: LATER),
    )
    expired = await expired_service.create_key(
        user_id="user_owner", name="expired", expires_at=NOW
    )
    with pytest.raises(ExpiredCredentialsError):
        await expired_service.authenticate(
            MockRequest({"authorization": f"Bearer {expired['secret']}"})
        )
    for adapter in (db, expired_db):
        assert not any(call["model"] == "users" for call in adapter.find_one_calls)
        assert adapter.storage["api_keys"][0]["lastUsedAt"] is None
