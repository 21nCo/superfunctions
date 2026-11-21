"""Two-factor plugin tests for authfn Python."""

from __future__ import annotations

import hashlib
import hmac
import os
import sys
from datetime import datetime, timedelta
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

from authfn import AuthFnConfig, TwoFactorInvalidCodeError
from authfn.plugins.two_factor import (
    BASE32_ALPHABET,
    TwoFactorPluginConfig,
    TwoFactorService,
    authfn_two_factor_plugin,
)
from authfn.types import ConfigError, ValidationError

from .support import InMemoryDatabaseAdapter

TEST_2FA_KEY = b"authfn-python-two-factor-test-key"


class MockDatabaseAdapter(InMemoryDatabaseAdapter):
    def __init__(self) -> None:
        super().__init__()
        for model in ("two_factor_enrollments", "two_factor_recovery_codes", "two_factor_challenges"):
            self.storage[model] = []


def _decode_base32(secret: str) -> bytes:
    bits = 0
    buffer = 0
    decoded: List[int] = []
    for char in secret.replace("=", "").upper():
        index = BASE32_ALPHABET.find(char)
        if index < 0:
            continue
        buffer = (buffer << 5) | index
        bits += 5
        if bits >= 8:
            decoded.append((buffer >> (bits - 8)) & 0xFF)
            bits -= 8
    return bytes(decoded)


def _generate_totp(secret: str, now: datetime, digits: int = 6, period_seconds: int = 30) -> str:
    counter = int(now.timestamp() // period_seconds)
    payload = counter.to_bytes(8, "big")
    digest = hmac.new(_decode_base32(secret), payload, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary = (
        ((digest[offset] & 0x7F) << 24)
        | ((digest[offset + 1] & 0xFF) << 16)
        | ((digest[offset + 2] & 0xFF) << 8)
        | (digest[offset + 3] & 0xFF)
    )
    return str(binary % (10**digits)).zfill(digits)


@pytest.mark.asyncio
async def test_two_factor_rejects_oversized_user_ids_before_persistence() -> None:
    db = MockDatabaseAdapter()
    service = TwoFactorService(
        AuthFnConfig(database=db, namespace="authfn"),
        TwoFactorPluginConfig(encryption_key_resolver=lambda _ref: TEST_2FA_KEY),
    )

    with pytest.raises(ValidationError, match="userId must contain at most 255 characters"):
        await service.enroll(user_id="u" * 256)
    with pytest.raises(ValidationError, match="userId must contain at most 255 characters"):
        await service.begin_sign_in_challenge(
            user_id="u" * 256,
            primary_method="password",
        )

    assert db.storage["two_factor_enrollments"] == []
    assert db.storage["two_factor_challenges"] == []


@pytest.mark.asyncio
async def test_two_factor_challenge_allows_persisted_legacy_user_id() -> None:
    db = MockDatabaseAdapter()
    now = datetime(2026, 3, 22)
    legacy_user_id = "legacy-user-".ljust(300, "x")
    db.storage["users"] = [{"id": legacy_user_id}]
    db.storage["two_factor_enrollments"] = [
        {
            "id": "tfa_legacy",
            "userId": legacy_user_id,
            "secretEncrypted": "legacy-secret",
            "confirmedAt": now,
            "createdAt": now,
            "updatedAt": now,
        }
    ]
    service = TwoFactorService(
        AuthFnConfig(database=db, namespace="authfn"),
        TwoFactorPluginConfig(now=lambda: now),
    )

    challenge = await service.begin_sign_in_challenge(
        user_id=legacy_user_id,
        primary_method="password",
    )

    assert challenge is not None
    assert challenge["userId"] == legacy_user_id


@pytest.mark.asyncio
async def test_two_factor_enrollment_allows_persisted_legacy_user_id() -> None:
    db = MockDatabaseAdapter()
    legacy_user_id = "legacy-user-".ljust(300, "x")
    db.storage["users"] = [{"id": legacy_user_id}]
    service = TwoFactorService(
        AuthFnConfig(database=db, namespace="authfn"),
        TwoFactorPluginConfig(encryption_key_resolver=lambda _ref: TEST_2FA_KEY),
    )

    await service.enroll(user_id=legacy_user_id)

    assert db.storage["two_factor_enrollments"][0]["userId"] == legacy_user_id


@pytest.mark.asyncio
async def test_two_factor_plugin_schema_and_routes() -> None:
    plugin = authfn_two_factor_plugin()
    schema = plugin.schema(AuthFnConfig(database=object()))
    routes = plugin.routes(
        type(
            "Ctx",
            (),
            {"config": AuthFnConfig(database=object()), "namespace": "authfn", "base_path": "/auth"},
        )()
    )

    assert {table["modelName"] for table in schema} == {
        "two_factor_enrollments",
        "two_factor_recovery_codes",
        "two_factor_challenges",
    }
    assert {route["path"] for route in routes} == {
        "/2fa/enroll",
        "/2fa/confirm",
        "/2fa/challenge",
        "/2fa/disable",
    }


@pytest.mark.asyncio
async def test_enroll_confirm_challenge_recovery_and_disable() -> None:
    db = MockDatabaseAdapter()
    now = datetime(2026, 3, 22, 0, 0, 0)
    service = TwoFactorService(
        AuthFnConfig(database=db, namespace="authfn"),
        TwoFactorPluginConfig(
            issuer="authfn-tests",
            now=lambda: now,
            recovery_code_count=3,
            encryption_key_resolver=lambda _key_ref: TEST_2FA_KEY,
        ),
    )

    enrolled = await service.enroll(user_id="user_1", primary_email="ada@example.com")
    assert enrolled["secret"]
    assert len(enrolled["recoveryCodes"]) == 3
    assert db.storage["two_factor_enrollments"][0]["secretEncrypted"] != enrolled["secret"]
    assert db.storage["two_factor_recovery_codes"][0]["codeHash"].startswith("pbkdf2-sha256$")

    await service.confirm(
        user_id="user_1",
        code=_generate_totp(enrolled["secret"], now),
    )
    assert db.storage["two_factor_enrollments"][0]["confirmedAt"] == now

    challenge = await service.begin_sign_in_challenge(
        user_id="user_1",
        primary_method="password",
    )
    assert challenge is not None
    satisfied = await service.complete_sign_in_challenge(
        challenge_id=challenge["id"],
        code=_generate_totp(enrolled["secret"], now),
        primary_email="ada@example.com",
    )
    assert satisfied["twoFactorSatisfied"] is True
    assert satisfied["session"].methods == ["password", "two-factor"]

    recovery_challenge = await service.begin_sign_in_challenge(
        user_id="user_1",
        primary_method="password",
    )
    recovery = enrolled["recoveryCodes"][0]
    recovery_result = await service.complete_sign_in_challenge(
        challenge_id=recovery_challenge["id"],
        code=recovery,
        primary_email="ada@example.com",
    )
    assert recovery_result["usedRecoveryCode"] is True

    reused = await service.begin_sign_in_challenge(
        user_id="user_1",
        primary_method="password",
    )
    with pytest.raises(TwoFactorInvalidCodeError):
        await service.complete_sign_in_challenge(
            challenge_id=reused["id"],
            code=recovery,
            primary_email="ada@example.com",
        )

    disabled = await service.disable(
        user_id="user_1",
        code=_generate_totp(enrolled["secret"], now),
    )
    assert disabled == {"disabled": True}
    assert await service.begin_sign_in_challenge(user_id="user_1", primary_method="password") is None


@pytest.mark.asyncio
async def test_two_factor_requires_explicit_encryption_key_resolver() -> None:
    service = TwoFactorService(
        AuthFnConfig(database=MockDatabaseAdapter(), namespace="authfn"),
        TwoFactorPluginConfig(),
    )

    with pytest.raises(ValidationError) as error:
        await service.enroll(user_id="user_1", primary_email="ada@example.com")

    assert "encryption_key_resolver" in str(error.value)


TEST_NOW = datetime(2026, 3, 22, 0, 0, 0)


def _two_factor_service(db: MockDatabaseAdapter, *, recovery_code_count: int) -> TwoFactorService:
    return TwoFactorService(
        AuthFnConfig(database=db, namespace="authfn"),
        TwoFactorPluginConfig(
            issuer="authfn-tests",
            now=lambda: TEST_NOW,
            recovery_code_count=recovery_code_count,
            encryption_key_resolver=lambda _key_ref: TEST_2FA_KEY,
        ),
    )


async def _enrolled_service(
    db: MockDatabaseAdapter, *, recovery_code_count: int
) -> "tuple[TwoFactorService, Dict[str, Any]]":
    """A service with user_1 enrolled and confirmed at TEST_NOW."""
    service = _two_factor_service(db, recovery_code_count=recovery_code_count)
    enrolled = await service.enroll(user_id="user_1", primary_email="ada@example.com")
    await service.confirm(user_id="user_1", code=_generate_totp(enrolled["secret"], TEST_NOW))
    return service, enrolled


async def _assert_code_refused_and_one_unused(
    service: TwoFactorService, db: MockDatabaseAdapter, challenge_id: str, code: str
) -> None:
    with pytest.raises(TwoFactorInvalidCodeError):
        await service.complete_sign_in_challenge(
            challenge_id=challenge_id,
            code=code,
            primary_email="ada@example.com",
        )
    unused = [row for row in db.storage["two_factor_recovery_codes"] if row.get("usedAt") is None]
    assert len(unused) == 1


@pytest.mark.asyncio
async def test_accepts_recovery_codes_hashed_by_the_typescript_kernel() -> None:
    db = MockDatabaseAdapter()
    now = TEST_NOW
    service, enrolled = await _enrolled_service(db, recovery_code_count=1)
    enrollment_id = db.storage["two_factor_enrollments"][0]["id"]
    # Shapes the TypeScript kernel stores: salted with the enrollment id since
    # AUTH-32, and the code alone before it.
    salted_code = "TEST0-TEST0-TEST0-TEST1"
    legacy_code = "TEST0-TEST2"
    for row_id, stored in (
        ("recovery_test_salted", f"authfn-recovery:{enrollment_id}:TEST0TEST0TEST0TEST1"),
        ("recovery_test_legacy", "TEST0TEST2"),
    ):
        db.storage["two_factor_recovery_codes"].append(
            {
                "id": row_id,
                "enrollmentId": enrollment_id,
                "codeHash": hashlib.sha256(stored.encode("utf-8")).hexdigest(),
                "usedAt": None,
                "createdAt": now,
            }
        )

    for code in (salted_code, legacy_code):
        challenge = await service.begin_sign_in_challenge(user_id="user_1", primary_method="password")
        result = await service.complete_sign_in_challenge(
            challenge_id=challenge["id"],
            code=code.lower(),
            primary_email="ada@example.com",
        )
        assert result["usedRecoveryCode"] is True

    # A salted hash only matches its own enrollment.
    db.storage["two_factor_recovery_codes"].append(
        {
            "id": "recovery_test_other",
            "enrollmentId": enrollment_id,
            "codeHash": hashlib.sha256(b"authfn-recovery:other-enrollment:TEST0TEST0TEST0TEST3").hexdigest(),
            "usedAt": None,
            "createdAt": now,
        }
    )
    challenge = await service.begin_sign_in_challenge(user_id="user_1", primary_method="password")
    with pytest.raises(TwoFactorInvalidCodeError):
        await service.complete_sign_in_challenge(
            challenge_id=challenge["id"],
            code="TEST0-TEST0-TEST0-TEST3",
            primary_email="ada@example.com",
        )


@pytest.mark.asyncio
async def test_spends_a_recovery_code_only_while_it_is_unused() -> None:
    db = MockDatabaseAdapter()
    now = TEST_NOW
    service, enrolled = await _enrolled_service(db, recovery_code_count=1)
    enrollment_id = db.storage["two_factor_enrollments"][0]["id"]
    recovery = enrolled["recoveryCodes"][0]

    # Another request spent the code after this one read it as unused.
    stale_rows = [dict(row) for row in db.storage["two_factor_recovery_codes"]]
    db.storage["two_factor_recovery_codes"][0]["usedAt"] = now
    original_find_many = db.find_many

    async def stale_find_many(**kwargs: Any) -> List[Dict[str, Any]]:
        if kwargs.get("model") == "two_factor_recovery_codes":
            return stale_rows
        return await original_find_many(**kwargs)

    db.find_many = stale_find_many  # type: ignore[method-assign]
    assert await service._consume_recovery_code(enrollment_id, recovery) is False


@pytest.mark.asyncio
async def test_finishes_a_challenge_once_and_keeps_the_losing_recovery_code() -> None:
    db = MockDatabaseAdapter()
    service, enrolled = await _enrolled_service(db, recovery_code_count=2)
    challenge = await service.begin_sign_in_challenge(user_id="user_1", primary_method="password")
    stale_challenge = dict(challenge)

    first = await service.complete_sign_in_challenge(
        challenge_id=challenge["id"],
        code=enrolled["recoveryCodes"][0],
        primary_email="ada@example.com",
    )
    assert first["usedRecoveryCode"] is True

    # A second request that read the challenge before the first finished it.
    original_find_one = db.find_one

    async def stale_find_one(**kwargs: Any) -> Optional[Dict[str, Any]]:
        if kwargs.get("model") == "two_factor_challenges":
            return stale_challenge
        return await original_find_one(**kwargs)

    db.find_one = stale_find_one  # type: ignore[method-assign]
    await _assert_code_refused_and_one_unused(service, db, challenge["id"], enrolled["recoveryCodes"][1])


@pytest.mark.asyncio
async def test_refuses_an_adapter_without_conditional_writes() -> None:
    class NoUpdateMany(MockDatabaseAdapter):
        update_many = None  # type: ignore[assignment]

    db = NoUpdateMany()
    service = _two_factor_service(db, recovery_code_count=1)
    # Refused before anything is stored, so no enrollment is left that could
    # never finish a sign-in.
    with pytest.raises(ConfigError):
        await service.enroll(user_id="user_1", primary_email="ada@example.com")
    assert db.storage["two_factor_enrollments"] == []


@pytest.mark.asyncio
async def test_keeps_the_challenge_used_when_a_failed_spend_may_have_applied() -> None:
    db = MockDatabaseAdapter()
    service, enrolled = await _enrolled_service(db, recovery_code_count=2)
    challenge = await service.begin_sign_in_challenge(user_id="user_1", primary_method="password")

    original_update_many = db.update_many

    async def lost_response(**kwargs: Any) -> int:
        count = await original_update_many(**kwargs)
        if kwargs.get("model") == "two_factor_recovery_codes":
            raise RuntimeError("test response lost after the write")
        return count

    db.update_many = lost_response  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        await service.complete_sign_in_challenge(
            challenge_id=challenge["id"],
            code=enrolled["recoveryCodes"][0],
            primary_email="ada@example.com",
        )
    db.update_many = original_update_many  # type: ignore[method-assign]
    # The code was spent, so the challenge stays used: another code cannot be
    # spent on it.
    await _assert_code_refused_and_one_unused(service, db, challenge["id"], enrolled["recoveryCodes"][1])


def test_refuses_to_start_two_factor_on_an_adapter_without_conditional_writes() -> None:
    from authfn import AuthFn

    class NoUpdateMany(MockDatabaseAdapter):
        update_many = None  # type: ignore[assignment]

    with pytest.raises(ConfigError):
        AuthFn(
            AuthFnConfig(
                database=NoUpdateMany(),
                namespace="authfn",
                plugins=[
                    authfn_two_factor_plugin(
                        TwoFactorPluginConfig(encryption_key_resolver=lambda _key_ref: TEST_2FA_KEY)
                    )
                ],
            )
        )


@pytest.mark.asyncio
async def test_keeps_the_challenge_used_when_the_spend_count_is_unknown() -> None:
    db = MockDatabaseAdapter()
    service, enrolled = await _enrolled_service(db, recovery_code_count=2)
    challenge = await service.begin_sign_in_challenge(user_id="user_1", primary_method="password")
    original_update_many = db.update_many

    async def unreported(**kwargs: Any) -> int:
        count = await original_update_many(**kwargs)
        return -1 if kwargs.get("model") == "two_factor_recovery_codes" else count

    db.update_many = unreported  # type: ignore[method-assign]
    with pytest.raises(TwoFactorInvalidCodeError):
        await service.complete_sign_in_challenge(
            challenge_id=challenge["id"],
            code=enrolled["recoveryCodes"][0],
            primary_email="ada@example.com",
        )
    db.update_many = original_update_many  # type: ignore[method-assign]
    with pytest.raises(TwoFactorInvalidCodeError):
        await service.complete_sign_in_challenge(
            challenge_id=challenge["id"],
            code=enrolled["recoveryCodes"][1],
            primary_email="ada@example.com",
        )


@pytest.mark.asyncio
async def test_does_not_finish_a_challenge_that_expires_before_it_is_claimed() -> None:
    db = MockDatabaseAdapter()
    clock = {"now": TEST_NOW}
    service = TwoFactorService(
        AuthFnConfig(database=db, namespace="authfn"),
        TwoFactorPluginConfig(
            issuer="authfn-tests",
            now=lambda: clock["now"],
            recovery_code_count=1,
            encryption_key_resolver=lambda _key_ref: TEST_2FA_KEY,
        ),
    )
    enrolled = await service.enroll(user_id="user_1", primary_email="ada@example.com")
    await service.confirm(user_id="user_1", code=_generate_totp(enrolled["secret"], TEST_NOW))
    challenge = await service.begin_sign_in_challenge(user_id="user_1", primary_method="password")
    original_find_one = db.find_one

    async def slow_find_one(**kwargs: Any) -> Optional[Dict[str, Any]]:
        row = await original_find_one(**kwargs)
        if kwargs.get("model") == "two_factor_enrollments":
            # The challenge expires while the request reads the enrollment.
            clock["now"] = TEST_NOW + timedelta(hours=1)
        return row

    db.find_one = slow_find_one  # type: ignore[method-assign]
    with pytest.raises(TwoFactorInvalidCodeError):
        await service.complete_sign_in_challenge(
            challenge_id=challenge["id"],
            code=enrolled["recoveryCodes"][0],
            primary_email="ada@example.com",
        )
    unused = [row for row in db.storage["two_factor_recovery_codes"] if row.get("usedAt") is None]
    assert len(unused) == 1
