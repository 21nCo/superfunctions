"""Social OAuth plugin tests for authfn Python."""

from __future__ import annotations

import base64
import json
import os
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional

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
    AuthFnConfig,
    AuthFnHooks,
    InternalError,
    OAuthCallbackInvalidError,
    OAuthProviderUnsupportedError,
    OAuthStateReplayedError,
    PluginAbortedError,
    RateLimitedError,
    RedirectUriDisallowedError,
    ValidationError,
)
from authfn.plugins.multi_region import (
    MultiRegionPluginConfig,
    MultiRegionRegionConfig,
    authfn_multi_region_plugin,
)
from authfn.plugins.social_oauth import (
    SocialOAuthPluginConfig,
    SocialOAuthService,
    SocialProviderConfig,
    authfn_social_oauth_plugin,
)


def _test_oauth_key(_key_ref: str) -> bytes:
    return b"test-oauth-token-encryption-key-not-a-real-secret"

def create_id_token(claims: Dict[str, Any]) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "none", "typ": "JWT"}).encode("utf-8")
    ).decode("utf-8").rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode("utf-8")).decode("utf-8").rstrip("=")
    return f"{header}.{payload}.signature"


class MockResponse:
    def __init__(self, status: int, body: Any):
        self.status = status
        self.ok = 200 <= status < 300
        self._body = body

    async def text(self) -> str:
        if isinstance(self._body, str):
            return self._body
        return json.dumps(self._body)


class MockDatabaseAdapter:
    def __init__(self) -> None:
        self.storage: Dict[str, List[Dict[str, Any]]] = {
            "users": [],
            "oauth_states": [],
            "oauth_tokens": [],
            "oauth_accounts": [],
        }

    async def find_one(
        self,
        model: str,
        where: List[Dict[str, Any]],
        namespace: str,
    ) -> Optional[Dict[str, Any]]:
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

    async def update_many(
        self,
        model: str,
        where: List[Dict[str, Any]],
        data: Dict[str, Any],
        namespace: str,
    ) -> int:
        count = 0
        for row in self.storage.get(model, []):
            if _matches(row, where):
                row.update(data)
                count += 1
        return count

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
        from superfunctions.db.errors import NotFoundError as AdapterNotFoundError

        raise AdapterNotFoundError(f"row not found in {model}")

    async def delete_many(
        self,
        model: str,
        where: List[Dict[str, Any]],
        namespace: str,
    ) -> int:
        rows = self.storage.get(model, [])
        retained = [row for row in rows if not _matches(row, where)]
        deleted = len(rows) - len(retained)
        self.storage[model] = retained
        return deleted


def _matches(row: Dict[str, Any], clauses: List[Dict[str, Any]]) -> bool:
    for clause in clauses:
        operator = clause["operator"]
        field = clause["field"]
        value = clause["value"]
        if operator == "eq" and row.get(field) != value:
            return False
        if operator == "lt" and not (row.get(field) < value):
            return False
    return True


class FixedClock:
    def __init__(self, start: datetime) -> None:
        self.current = start

    def now(self) -> datetime:
        return self.current


class RuntimeResolver:
    def __init__(self, oauth: Dict[str, Dict[str, Any]]) -> None:
        self.oauth = oauth

    def resolve(self, _request: Any) -> Any:
        origin = "https://account.example.com"
        if _request is not None and getattr(_request, "url", None):
            origin = _request.url.split("/auth", 1)[0]
        return type(
            "ResolvedRuntime",
            (),
            {
                "issuer": origin,
                "base_url": origin,
                "baseUrl": origin,
                "oauth": self.oauth,
            },
        )()


class Request:
    def __init__(self, url: str) -> None:
        self.url = url
        self.headers: Dict[str, str] = {}


class EventRecorder:
    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []

    async def emit(self, event: Any) -> None:
        if hasattr(event, "model_dump"):
            self.events.append(event.model_dump(by_alias=True))
            return
        self.events.append(dict(event))


def build_google_fetcher() -> Any:
    async def fetcher(url: str, _init: Dict[str, Any]) -> MockResponse:
        if url != "https://oauth2.googleapis.com/token":
            raise AssertionError(f"unexpected url: {url}")
        return MockResponse(
            200,
            {
                "access_token": "google-access-token",
                "refresh_token": "google-refresh-token",
                "token_type": "Bearer",
                "scope": "openid email profile",
                "id_token": create_id_token(
                    {
                        "sub": "google-user-01",
                        "email": "ada@example.com",
                        "email_verified": True,
                        "name": "Ada Lovelace",
                    }
                ),
            },
        )

    return fetcher


def build_apple_fetcher(captured: Dict[str, str], *, missing_claims: bool = False) -> Any:
    async def fetcher(url: str, init: Dict[str, Any]) -> MockResponse:
        if url != "https://appleid.apple.com/auth/token":
            raise AssertionError(f"unexpected url: {url}")
        captured["body"] = init["body"]
        claims = {"sub": "apple-user-01", "email": "ada.apple@example.com", "name": "Ada Apple"}
        if missing_claims:
            claims = {"sub": "apple-user-02"}
        return MockResponse(
            200,
            {
                "access_token": "apple-access-token",
                "refresh_token": "apple-refresh-token",
                "token_type": "Bearer",
                "id_token": create_id_token(claims),
            },
        )

    return fetcher


def build_github_fetcher(*, fail_token_exchange: bool = False) -> Any:
    async def fetcher(url: str, _init: Dict[str, Any]) -> MockResponse:
        if url == "https://github.com/login/oauth/access_token":
            if fail_token_exchange:
                return MockResponse(
                    500,
                    {
                        "error": "server_error",
                        "error_description": "github-client-secret should stay hidden",
                    },
                )
            return MockResponse(
                200,
                {
                    "access_token": "github-access-token",
                    "token_type": "Bearer",
                    "scope": "read:user user:email",
                },
            )
        if url == "https://api.github.com/user":
            return MockResponse(200, {"id": 4242, "login": "ada", "name": "Ada Lovelace"})
        if url == "https://api.github.com/user/emails":
            return MockResponse(
                200,
                [{"email": "ada@example.com", "verified": True, "primary": True}],
            )
        raise AssertionError(f"unexpected url: {url}")

    return fetcher


def build_rate_limited_fetcher() -> Any:
    async def fetcher(url: str, _init: Dict[str, Any]) -> MockResponse:
        if url != "https://oauth2.googleapis.com/token":
            raise AssertionError(f"unexpected url: {url}")
        return MockResponse(
            429,
            {"error": "rate_limited", "error_description": "too many requests"},
        )

    return fetcher


@pytest.mark.asyncio
async def test_social_oauth_plugin_schema_and_routes() -> None:
    plugin = authfn_social_oauth_plugin()
    schema = plugin.schema(AuthFnConfig(database=object()))
    routes = plugin.routes(
        type(
            "Ctx",
            (),
            {"config": AuthFnConfig(database=object()), "namespace": "authfn", "base_path": "/auth"},
        )()
    )

    assert {table["modelName"] for table in schema} == {
        "oauth_states",
        "oauth_tokens",
        "oauth_accounts",
    }
    assert {route["path"] for route in routes} == {
        "/social/start",
        "/social/callback/:provider",
        "/social/disconnect/:provider",
    }


@pytest.mark.asyncio
async def test_google_start_callback_replay_and_redirect_hook() -> None:
    db = MockDatabaseAdapter()
    clock = FixedClock(datetime(2026, 3, 22, 0, 0, 0))

    async def after_callback(_ctx: Any, payload: Dict[str, Any]) -> None:
        payload["redirectTo"] = "https://app.example.com/alternate-post-auth"

    config = AuthFnConfig(
        database=db,
        namespace="authfn",
        hooks=AuthFnHooks(afterOAuthCallback=after_callback),
    )
    service = SocialOAuthService(
        config,
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            now=clock.now,
            fetcher=build_google_fetcher(),
            providers={
                "google": SocialProviderConfig(
                    client_id="google-client-id",
                    client_secret="google-client-secret",
                    allowlisted_return_to=[
                        "https://app.example.com/post-auth",
                        "https://app.example.com/alternate-post-auth",
                    ],
                )
            },
        ),
    )

    started = await service.start("google", return_to="https://app.example.com/post-auth")
    assert started["provider"] == "google"
    assert "https://accounts.google.com/o/oauth2/v2/auth" in started["redirectTo"]

    completed = await service.handle_callback(
        "google",
        code="abc123",
        state=started["stateId"],
    )
    assert completed["status"] == 303
    assert completed["redirectTo"] == "https://app.example.com/alternate-post-auth"

    state_row = db.storage["oauth_states"][0]
    rehydrated = await service.state_store.get(state_row["state_id"])
    assert rehydrated is not None
    assert rehydrated.code_verifier == state_row["code_verifier"]
    assert rehydrated.nonce == state_row["nonce"]

    linked = await db.find_one(
        model="oauth_accounts",
        where=[
            {"field": "provider", "operator": "eq", "value": "google"},
            {"field": "providerAccountId", "operator": "eq", "value": "google-user-01"},
        ],
        namespace="authfn",
    )
    assert linked is not None
    assert linked["email"] == "ada@example.com"
    assert len(db.storage["oauth_tokens"]) == 1
    assert "google-access-token" not in db.storage["oauth_tokens"][0]["encrypted_payload"]

    with pytest.raises(OAuthStateReplayedError):
        await service.handle_callback("google", code="abc123", state=started["stateId"])


@pytest.mark.asyncio
async def test_custom_profile_resolver_normalizes_numeric_provider_account_id() -> None:
    db = MockDatabaseAdapter()
    service = SocialOAuthService(
        AuthFnConfig(database=db, namespace="authfn"),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            fetcher=build_google_fetcher(),
            providers={
                "google": SocialProviderConfig(
                    client_id="google-client-id",
                    client_secret="google-client-secret",
                    profile_resolver=lambda _input: {
                        "providerAccountId": 4242,
                        "email": None,
                        "emailVerified": False,
                        "name": "Numeric Account",
                        "profile": {"id": 4242},
                    },
                )
            },
        ),
    )

    for _ in range(2):
        started = await service.start("google", callback_mode="json")
        await service.handle_callback("google", code="abc123", state=started["stateId"])

    assert len(db.storage["users"]) == 1
    assert len(db.storage["oauth_accounts"]) == 1
    assert db.storage["oauth_accounts"][0]["providerAccountId"] == "4242"


@pytest.mark.asyncio
async def test_callback_preserves_existing_legacy_provider_account_id() -> None:
    db = MockDatabaseAdapter()
    provider_account_id = "legacy-provider-".ljust(300, "x")
    db.storage["users"] = [
        {
            "id": "user_legacy_provider",
            "primaryEmail": "legacy-provider@example.com",
        }
    ]
    db.storage["oauth_accounts"] = [
        {
            "id": "oauth_legacy_provider",
            "userId": "user_legacy_provider",
            "provider": "google",
            "providerAccountId": provider_account_id,
            "connectionId": "legacy-provider-connection",
        }
    ]
    service = SocialOAuthService(
        AuthFnConfig(database=db, namespace="authfn"),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            fetcher=build_google_fetcher(),
            providers={
                "google": SocialProviderConfig(
                    client_id="google-client-id",
                    client_secret="google-client-secret",
                    profile_resolver=lambda _input: {
                        "providerAccountId": provider_account_id,
                        "email": "legacy-provider@example.com",
                        "emailVerified": True,
                        "name": "Legacy Provider",
                        "profile": {},
                    },
                )
            },
        ),
    )

    started = await service.start("google", callback_mode="json")
    completed = await service.handle_callback(
        "google", code="abc123", state=started["stateId"]
    )

    assert completed["userId"] == "user_legacy_provider"
    assert len(db.storage["oauth_accounts"]) == 1
    assert db.storage["oauth_accounts"][0]["providerAccountId"] == provider_account_id
    assert db.storage["oauth_accounts"][0]["connectionId"] == "legacy-provider-connection"
    assert db.storage["oauth_accounts"][0]["userId"] == "user_legacy_provider"


@pytest.mark.asyncio
async def test_custom_profile_resolver_rejects_null_provider_account_id() -> None:
    db = MockDatabaseAdapter()
    service = SocialOAuthService(
        AuthFnConfig(database=db, namespace="authfn"),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            fetcher=build_google_fetcher(),
            providers={
                "google": SocialProviderConfig(
                    client_id="google-client-id",
                    client_secret="google-client-secret",
                    profile_resolver=lambda _input: {
                        "providerAccountId": None,
                        "email": None,
                        "emailVerified": False,
                        "name": "Missing Account",
                        "profile": {},
                    },
                )
            },
        ),
    )

    started = await service.start("google", callback_mode="json")
    with pytest.raises(ValidationError, match="providerAccountId is required"):
        await service.handle_callback("google", code="abc123", state=started["stateId"])

    assert db.storage["oauth_accounts"] == []


@pytest.mark.asyncio
async def test_before_user_create_rejects_non_string_id() -> None:
    db = MockDatabaseAdapter()

    async def replace_user_id(_context: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {**payload, "id": None}

    service = SocialOAuthService(
        AuthFnConfig(
            database=db,
            namespace="authfn",
            hooks=AuthFnHooks(beforeUserCreate=replace_user_id),
        ),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            fetcher=build_google_fetcher(),
            providers={
                "google": SocialProviderConfig(
                    client_id="google-client-id",
                    client_secret="google-client-secret",
                )
            },
        ),
    )

    started = await service.start("google", callback_mode="json")
    with pytest.raises(PluginAbortedError, match="invalid id"):
        await service.handle_callback("google", code="abc123", state=started["stateId"])

    assert db.storage["users"] == []


@pytest.mark.asyncio
async def test_disallowed_redirect_and_unsupported_provider_raise_canonical_errors() -> None:
    service = SocialOAuthService(
        AuthFnConfig(database=MockDatabaseAdapter(), namespace="authfn"),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            fetcher=build_google_fetcher(),
            providers={
                "google": SocialProviderConfig(
                    client_id="google-client-id",
                    client_secret="google-client-secret",
                    allowlisted_return_to=["https://app.example.com/post-auth"],
                )
            },
        ),
    )

    with pytest.raises(RedirectUriDisallowedError):
        await service.start("google", return_to="https://evil.example.com/callback")

    with pytest.raises(OAuthProviderUnsupportedError):
        await service.start("discord", callback_mode="json")


@pytest.mark.asyncio
async def test_apple_runtime_secret_resolution_and_missing_claims() -> None:
    db = MockDatabaseAdapter()
    clock = FixedClock(datetime(2026, 3, 22, 0, 0, 0))
    captured: Dict[str, str] = {}

    config = AuthFnConfig(
        database=db,
        namespace="authfn",
        runtime=RuntimeResolver(
            {
                "apple": {
                    "clientId": "apple-client-id",
                    "clientSecretResolver": lambda _ctx: {"clientSecret": "generated-apple-client-secret"},
                    "allowlistedReturnTo": ["https://app.example.com/apple-post-auth"],
                }
            }
        ),
    )
    service = SocialOAuthService(
        config,
        SocialOAuthPluginConfig(encryption_key_resolver=_test_oauth_key, now=clock.now, fetcher=build_apple_fetcher(captured)),
    )

    started = await service.start("apple", return_to="https://app.example.com/apple-post-auth")
    completed = await service.handle_callback("apple", code="apple_code", state=started["stateId"])
    assert completed["status"] == 303
    assert completed["redirectTo"] == "https://app.example.com/apple-post-auth"
    assert "client_secret=generated-apple-client-secret" in captured["body"]

    bad_service = SocialOAuthService(
        config,
        SocialOAuthPluginConfig(encryption_key_resolver=_test_oauth_key, now=clock.now, fetcher=build_apple_fetcher({}, missing_claims=True)),
    )
    bad_started = await bad_service.start("apple", return_to="https://app.example.com/apple-post-auth")
    with pytest.raises(OAuthCallbackInvalidError):
        await bad_service.handle_callback("apple", code="apple_code", state=bad_started["stateId"])


@pytest.mark.asyncio
async def test_github_links_verified_user_json_mode_and_sanitizes_failures() -> None:
    db = MockDatabaseAdapter()
    clock = FixedClock(datetime(2026, 3, 22, 0, 0, 0))
    await db.create(
        model="users",
        data={
            "id": "legacy-user-".ljust(300, "x"),
            "primaryEmail": "ada@example.com",
            "emailVerifiedAt": clock.now(),
            "createdAt": clock.now(),
            "updatedAt": clock.now(),
        },
        namespace="authfn",
    )

    service = SocialOAuthService(
        AuthFnConfig(database=db, namespace="authfn"),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            now=clock.now,
            fetcher=build_github_fetcher(),
            providers={
                "github": SocialProviderConfig(
                    client_id="github-client-id",
                    client_secret="github-client-secret",
                    link_by_verified_email=True,
                )
            },
        ),
    )

    started = await service.start("github", callback_mode="json")
    completed = await service.handle_callback("github", code="github_code", state=started["stateId"])
    assert completed["status"] == 200
    assert completed["body"]["data"] == {"linked": True, "provider": "github"}

    linked = await db.find_one(
        model="oauth_accounts",
        where=[
            {"field": "provider", "operator": "eq", "value": "github"},
            {"field": "providerAccountId", "operator": "eq", "value": "4242"},
        ],
        namespace="authfn",
    )
    assert linked is not None
    assert linked["userId"] == "legacy-user-".ljust(300, "x")

    failing = SocialOAuthService(
        AuthFnConfig(database=MockDatabaseAdapter(), namespace="authfn"),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            now=clock.now,
            fetcher=build_github_fetcher(fail_token_exchange=True),
            providers={
                "github": SocialProviderConfig(
                    client_id="github-client-id",
                    client_secret="github-client-secret",
                )
            },
        ),
    )
    failing_start = await failing.start("github", callback_mode="json")
    with pytest.raises(InternalError) as exc_info:
        await failing.handle_callback("github", code="github_code", state=failing_start["stateId"])

    assert "github-client-secret" not in str(exc_info.value)
    assert str(exc_info.value) == "OAuth token exchange failed"


@pytest.mark.asyncio
async def test_social_oauth_registers_region_and_emits_observability_events() -> None:
    db = MockDatabaseAdapter()
    clock = FixedClock(datetime(2026, 3, 22, 0, 0, 0))
    events = EventRecorder()
    region_plugin = authfn_multi_region_plugin(
        MultiRegionPluginConfig(
            regions=[
                MultiRegionRegionConfig(
                    region_id="eu-west-1",
                    authority="https://eu.account.example.com",
                    hosts=["eu.account.example.com"],
                )
            ]
        )
    )
    config = AuthFnConfig(
        database=db,
        namespace="authfn",
        runtime=RuntimeResolver(
            {
                "google": {
                    "clientId": "google-client-id",
                    "clientSecret": "google-client-secret",
                    "allowlistedReturnTo": ["https://app.example.com/post-auth"],
                }
            }
        ),
        plugins=[region_plugin],
        observability={"emit": events.emit},
    )
    service = SocialOAuthService(
        config,
        SocialOAuthPluginConfig(encryption_key_resolver=_test_oauth_key, now=clock.now, fetcher=build_google_fetcher()),
    )

    started = await service.start(
        "google",
        return_to="https://app.example.com/post-auth",
        request=Request("https://eu.account.example.com/auth/social/start"),
    )
    await service.handle_callback(
        "google",
        code="abc123",
        state=started["stateId"],
        request=Request("https://eu.account.example.com/auth/social/callback/google"),
    )

    assert len(db.storage["region_profiles"]) == 1
    assert db.storage["region_profiles"][0]["regionId"] == "eu-west-1"
    assert {event["type"] for event in events.events} >= {
        "authfn.oauth.started",
        "authfn.oauth.completed",
    }


@pytest.mark.asyncio
async def test_social_oauth_maps_provider_rate_limits_to_canonical_error() -> None:
    service = SocialOAuthService(
        AuthFnConfig(database=MockDatabaseAdapter(), namespace="authfn"),
        SocialOAuthPluginConfig(
            encryption_key_resolver=_test_oauth_key,
            fetcher=build_rate_limited_fetcher(),
            providers={
                "google": SocialProviderConfig(
                    client_id="google-client-id",
                    client_secret="google-client-secret",
                )
            },
        ),
    )

    started = await service.start("google", callback_mode="json")
    with pytest.raises(RateLimitedError):
        await service.handle_callback("google", code="abc123", state=started["stateId"])


def _token_record(payload: str = "test-provider-token-payload") -> Dict[str, Any]:
    return {
        "tokenId": "tok_test_1",
        "tenantId": "tenant_test",
        "userId": "user_1",
        "providerId": "google",
        "connectionId": "conn_test_1",
        "encryptedPayload": payload,
        "keyRef": "oauth-default",
        "createdAt": "2026-11-21T00:00:00.000Z",
        "updatedAt": "2026-11-21T00:00:00.000Z",
    }


@pytest.mark.asyncio
async def test_token_vault_needs_a_secret_key_and_does_not_use_one_derived_from_the_namespace() -> None:
    from cryptography.fernet import Fernet, InvalidToken

    from authfn.plugins.social_oauth import DbEncryptedTokenVault, _legacy_fernet_key
    from authfn.types import ConfigError

    db = MockDatabaseAdapter()
    config = AuthFnConfig(database=db, namespace="authfn")
    no_key = DbEncryptedTokenVault(config, default_key_ref="oauth-default", now=datetime.utcnow)
    with pytest.raises(ConfigError):
        await no_key.put(_token_record())

    short_key = DbEncryptedTokenVault(
        config, default_key_ref="oauth-default", now=datetime.utcnow, key_resolver=lambda _ref: b"too-short"
    )
    with pytest.raises(ConfigError):
        await short_key.put(_token_record())

    vault = DbEncryptedTokenVault(
        config, default_key_ref="oauth-default", now=datetime.utcnow, key_resolver=_test_oauth_key
    )
    await vault.put(_token_record())
    stored = db.storage["oauth_tokens"][0]["encrypted_payload"].encode("utf-8")
    # Anyone who can read the table can compute the old key; it must not open the row.
    with pytest.raises(InvalidToken):
        Fernet(_legacy_fernet_key("authfn", "oauth-default")).decrypt(stored)


def _legacy_row(payload: bytes = b"test-provider-token-payload") -> Dict[str, Any]:
    from cryptography.fernet import Fernet

    from authfn.plugins.social_oauth import _legacy_fernet_key

    return {
        "token_id": "tok_test_1",
        "tenant_id": "tenant_test",
        "user_id": "user_1",
        "provider_id": "google",
        "connection_id": "conn_test_1",
        "encrypted_payload": Fernet(_legacy_fernet_key("authfn", "oauth-default")).encrypt(payload).decode("utf-8"),
        "key_ref": "oauth-default",
        "created_at": "2026-11-21T00:00:00.000Z",
        "updated_at": "2026-11-21T00:00:00.000Z",
        "expires_at": None,
    }


@pytest.mark.asyncio
async def test_migrate_legacy_tokens_re_encrypts_rows_written_with_the_old_derived_key() -> None:
    from cryptography.fernet import Fernet, InvalidToken

    from authfn.plugins.social_oauth import DbEncryptedTokenVault, _fernet_key_from_secret

    db = MockDatabaseAdapter()
    config = AuthFnConfig(database=db, namespace="authfn")
    await db.create(model="oauth_tokens", data=_legacy_row(), namespace="authfn")
    vault = DbEncryptedTokenVault(
        config, default_key_ref="oauth-default", now=datetime.utcnow, key_resolver=_test_oauth_key
    )
    # rotate_key only uses configured keys, so it cannot open a legacy row.
    with pytest.raises(InvalidToken):
        await vault.rotate_key("tok_test_1", "oauth-default")

    assert await vault.migrate_legacy_tokens() == 1
    migrated = db.storage["oauth_tokens"][0]["encrypted_payload"].encode("utf-8")
    key = _fernet_key_from_secret(_test_oauth_key("oauth-default"))
    assert Fernet(key).decrypt(migrated) == b"test-provider-token-payload"
    # Already migrated rows are left alone.
    assert await vault.migrate_legacy_tokens() == 0


@pytest.mark.asyncio
async def test_refuses_a_non_bytes_key_and_checks_the_key_before_a_sign_in_starts() -> None:
    from authfn.plugins.social_oauth import DbEncryptedTokenVault
    from authfn.types import ConfigError

    db = MockDatabaseAdapter()
    config = AuthFnConfig(database=db, namespace="authfn")
    integer_key = DbEncryptedTokenVault(
        config, default_key_ref="oauth-default", now=datetime.utcnow, key_resolver=lambda _ref: 32  # type: ignore[arg-type, return-value]
    )
    with pytest.raises(ConfigError):
        await integer_key.put(_token_record())

    service = SocialOAuthService(
        config,
        SocialOAuthPluginConfig(
            providers={"google": SocialProviderConfig(client_id="google-client-id", client_secret="test-google-secret")}
        ),
    )
    with pytest.raises(ConfigError):
        await service.start("google", return_to="https://app.example.com/post-auth")
    with pytest.raises(ConfigError):
        await service.handle_callback("google", code="test-code", state="test-state")
    assert db.storage.get("users", []) == []
    assert db.storage.get("oauth_states", []) == []


@pytest.mark.asyncio
async def test_migrates_legacy_rows_to_a_new_key_reference_and_skips_rows_changed_meanwhile() -> None:
    from cryptography.fernet import Fernet

    from authfn.plugins.social_oauth import DbEncryptedTokenVault, _fernet_key_from_secret

    def only_new_ref(key_ref: str) -> bytes:
        if key_ref != "oauth-new":
            raise KeyError(key_ref)
        return b"test-oauth-new-reference-key-not-a-real-secret"

    db = MockDatabaseAdapter()
    config = AuthFnConfig(database=db, namespace="authfn")
    await db.create(model="oauth_tokens", data=_legacy_row(), namespace="authfn")
    vault = DbEncryptedTokenVault(config, default_key_ref="oauth-new", now=datetime.utcnow, key_resolver=only_new_ref)
    assert await vault.migrate_legacy_tokens("oauth-new") == 1
    row = db.storage["oauth_tokens"][0]
    assert row["key_ref"] == "oauth-new"
    assert Fernet(_fernet_key_from_secret(only_new_ref("oauth-new"))).decrypt(
        row["encrypted_payload"].encode("utf-8")
    ) == b"test-provider-token-payload"

    # A row that changed after it was read is skipped, not overwritten.
    db2 = MockDatabaseAdapter()
    await db2.create(model="oauth_tokens", data=_legacy_row(), namespace="authfn")
    stale = [dict(item) for item in db2.storage["oauth_tokens"]]
    db2.storage["oauth_tokens"][0]["encrypted_payload"] = "test-replaced-after-read"
    original_find_many = db2.find_many

    async def stale_find_many(**kwargs: Any) -> List[Dict[str, Any]]:
        return stale if kwargs.get("model") == "oauth_tokens" else await original_find_many(**kwargs)

    db2.find_many = stale_find_many  # type: ignore[method-assign]
    vault2 = DbEncryptedTokenVault(
        AuthFnConfig(database=db2, namespace="authfn"), default_key_ref="oauth-default", now=datetime.utcnow, key_resolver=_test_oauth_key
    )
    assert await vault2.migrate_legacy_tokens() == 0
    assert db2.storage["oauth_tokens"][0]["encrypted_payload"] == "test-replaced-after-read"


@pytest.mark.asyncio
async def test_writes_with_the_key_checked_up_front_even_if_the_resolver_fails_later() -> None:
    from authfn.plugins.social_oauth import DbEncryptedTokenVault

    calls = {"count": 0}

    def flaky(key_ref: str) -> bytes:
        calls["count"] += 1
        if calls["count"] > 1:
            raise RuntimeError("test key service unavailable")
        return _test_oauth_key(key_ref)

    db = MockDatabaseAdapter()
    vault = DbEncryptedTokenVault(
        AuthFnConfig(database=db, namespace="authfn"), default_key_ref="", now=datetime.utcnow, key_resolver=flaky
    )
    request_vault = vault.for_request()
    record = _token_record()
    record["keyRef"] = "oauth-default"
    await request_vault.put(record)
    assert [row["key_ref"] for row in db.storage["oauth_tokens"]] == ["oauth-default"]


@pytest.mark.asyncio
async def test_migrates_a_legacy_row_stored_with_an_empty_key_reference() -> None:
    from cryptography.fernet import Fernet

    from authfn.plugins.social_oauth import DbEncryptedTokenVault, _legacy_fernet_key

    db = MockDatabaseAdapter()
    row = _legacy_row()
    row["key_ref"] = ""
    row["encrypted_payload"] = Fernet(_legacy_fernet_key("authfn", "")).encrypt(b"test-provider-token-payload").decode("utf-8")
    await db.create(model="oauth_tokens", data=row, namespace="authfn")
    vault = DbEncryptedTokenVault(
        AuthFnConfig(database=db, namespace="authfn"), default_key_ref="oauth-default", now=datetime.utcnow, key_resolver=_test_oauth_key
    )
    assert await vault.migrate_legacy_tokens() == 1
    assert [row["key_ref"] for row in db.storage["oauth_tokens"]] == ["oauth-default"]


@pytest.mark.asyncio
async def test_each_sign_in_resolves_the_current_key() -> None:
    from authfn.plugins.social_oauth import DbEncryptedTokenVault

    keys = {"current": b"test-oauth-first-key-not-a-real-secret-000"}
    db = MockDatabaseAdapter()
    vault = DbEncryptedTokenVault(
        AuthFnConfig(database=db, namespace="authfn"), default_key_ref="oauth-default", now=datetime.utcnow,
        key_resolver=lambda _ref: keys["current"],
    )
    vault.assert_configured()
    first = vault._cipher("oauth-default")
    keys["current"] = b"test-oauth-second-key-not-a-real-secret-00"
    vault.assert_configured()
    assert vault._cipher("oauth-default") is not first


@pytest.mark.asyncio
async def test_migration_needs_atomic_writes_and_each_callback_keeps_its_own_key() -> None:
    from authfn.plugins.social_oauth import DbEncryptedTokenVault
    from authfn.types import ConfigError

    class NoUpdateMany(MockDatabaseAdapter):
        update_many = None  # type: ignore[assignment]

    vault = DbEncryptedTokenVault(
        AuthFnConfig(database=NoUpdateMany(), namespace="authfn"), default_key_ref="oauth-default",
        now=datetime.utcnow, key_resolver=_test_oauth_key,
    )
    with pytest.raises(ConfigError):
        await vault.migrate_legacy_tokens()

    calls = {"count": 0}

    def flaky(key_ref: str) -> bytes:
        calls["count"] += 1
        if calls["count"] > 1:
            raise RuntimeError("test key service unavailable")
        return _test_oauth_key(key_ref)

    db = MockDatabaseAdapter()
    shared = DbEncryptedTokenVault(
        AuthFnConfig(database=db, namespace="authfn"), default_key_ref="oauth-default", now=datetime.utcnow, key_resolver=flaky
    )
    callback_vault = shared.for_request()
    # Another call on the shared service fails to resolve the key meanwhile...
    with pytest.raises(RuntimeError):
        shared.assert_configured()
    # ...but this callback still writes with the key it checked.
    await callback_vault.put(_token_record())
    assert len(db.storage["oauth_tokens"]) == 1


@pytest.mark.asyncio
async def test_rotation_uses_the_current_secret_after_a_callback_used_a_newer_one() -> None:
    from cryptography.fernet import Fernet

    from authfn.plugins.social_oauth import DbEncryptedTokenVault, _fernet_key_from_secret

    keys = {"current": b"test-oauth-first-key-not-a-real-secret-000"}
    db = MockDatabaseAdapter()
    shared = DbEncryptedTokenVault(
        AuthFnConfig(database=db, namespace="authfn"), default_key_ref="oauth-default", now=datetime.utcnow,
        key_resolver=lambda _ref: keys["current"],
    )
    # A sign-in starts with the first secret, which is then replaced.
    shared.assert_configured()
    keys["current"] = b"test-oauth-second-key-not-a-real-secret-00"
    callback_vault = shared.for_request()
    await callback_vault.put(_token_record())
    # The shared service holds no earlier secret, so it rotates the row.
    await shared.rotate_key("tok_test_1", "oauth-default")
    stored = db.storage["oauth_tokens"][0]["encrypted_payload"].encode("utf-8")
    assert Fernet(_fernet_key_from_secret(keys["current"])).decrypt(stored) == b"test-provider-token-payload"


@pytest.mark.asyncio
async def test_migration_stops_when_update_many_reports_no_row_count() -> None:
    from authfn.plugins.social_oauth import DbEncryptedTokenVault
    from authfn.types import ConfigError

    class StubCount(MockDatabaseAdapter):
        async def update_many(
            self,
            model: str,
            where: List[Dict[str, Any]],
            data: Dict[str, Any],
            namespace: str,
        ) -> Any:
            # Like the inherited Adapter.update_many stub: no count at all.
            return None

    db = StubCount()
    await db.create(model="oauth_tokens", data=_legacy_row(), namespace="authfn")
    before = dict(db.storage["oauth_tokens"][0])
    vault = DbEncryptedTokenVault(
        AuthFnConfig(database=db, namespace="authfn"), default_key_ref="oauth-default",
        now=datetime.utcnow, key_resolver=_test_oauth_key,
    )
    with pytest.raises(ConfigError):
        await vault.migrate_legacy_tokens()
    assert db.storage["oauth_tokens"][0] == before


@pytest.mark.asyncio
async def test_callback_reads_the_key_reference_once_for_its_check_and_its_write() -> None:
    db = MockDatabaseAdapter()
    clock = FixedClock(datetime(2026, 3, 22, 0, 0, 0))
    exchanged = {"done": False}
    google = build_google_fetcher()

    async def fetcher(url: str, init: Dict[str, Any]) -> MockResponse:
        response = await google(url, init)
        exchanged["done"] = True
        return response

    def resolver(key_ref: str) -> bytes:
        # The key service goes down once the provider exchange has happened.
        if exchanged["done"]:
            raise RuntimeError("test key service unavailable")
        return _test_oauth_key(key_ref)

    plugin_config = SocialOAuthPluginConfig(
        encryption_key_resolver=resolver,
        encryption_key_ref="test-ref-a",
        now=clock.now,
        fetcher=fetcher,
        providers={
            "google": SocialProviderConfig(
                client_id="google-client-id",
                client_secret="test-google-secret",
                allowlisted_return_to=["https://app.example.com/post-auth"],
            )
        },
    )
    service = SocialOAuthService(AuthFnConfig(database=db, namespace="authfn"), plugin_config)
    started = await service.start("google", return_to="https://app.example.com/post-auth")
    # The application switches to a new key reference before the callback.
    plugin_config.encryption_key_ref = "test-ref-b"
    completed = await service.handle_callback("google", code="abc123", state=started["stateId"])
    assert completed["status"] == 303
    assert db.storage["oauth_tokens"][0]["key_ref"] == "test-ref-b"

    # Resetting it to empty means the default reference, for both the check
    # and the write.
    exchanged["done"] = False
    second = await service.start("google", return_to="https://app.example.com/post-auth")
    plugin_config.encryption_key_ref = ""
    completed = await service.handle_callback("google", code="abc123", state=second["stateId"])
    assert completed["status"] == 303
    assert [row["key_ref"] for row in db.storage["oauth_tokens"]] == ["oauth-default"]


def test_authfn_refuses_to_start_social_oauth_without_a_token_key() -> None:
    from authfn import AuthFn
    from authfn.plugins.social_oauth import authfn_social_oauth_plugin
    from authfn.types import ConfigError

    with pytest.raises(ConfigError):
        AuthFn(
            AuthFnConfig(
                database=MockDatabaseAdapter(),
                namespace="authfn",
                plugins=[authfn_social_oauth_plugin(SocialOAuthPluginConfig())],
            )
        )
    # With a key it starts.
    AuthFn(
        AuthFnConfig(
            database=MockDatabaseAdapter(),
            namespace="authfn",
            plugins=[authfn_social_oauth_plugin(SocialOAuthPluginConfig(encryption_key_resolver=_test_oauth_key))],
        )
    )


@pytest.mark.asyncio
async def test_rotate_key_to_an_empty_reference_stores_the_default_name() -> None:
    from cryptography.fernet import Fernet

    from authfn.plugins.social_oauth import DbEncryptedTokenVault, _fernet_key_from_secret

    db = MockDatabaseAdapter()
    vault = DbEncryptedTokenVault(
        AuthFnConfig(database=db, namespace="authfn"), default_key_ref="oauth-default", now=datetime.utcnow,
        key_resolver=_test_oauth_key,
    )
    record = _token_record()
    record["keyRef"] = "oauth-other"
    await vault.put(record)
    await vault.rotate_key("tok_test_1", "")
    row = db.storage["oauth_tokens"][0]
    assert row["key_ref"] == "oauth-default"
    assert Fernet(_fernet_key_from_secret(_test_oauth_key("oauth-default"))).decrypt(
        row["encrypted_payload"].encode("utf-8")
    ) == b"test-provider-token-payload"
