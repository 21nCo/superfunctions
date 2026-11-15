from __future__ import annotations

import httpx
import pytest

from billfn import (
    AsyncBillFnClient,
    BillableSubject,
    BillFnApiError,
    BillFnCheckoutCreateRequest,
    BillFnClient,
    BillFnEntitlementGrantSummary,
    BillFnEntitlementSnapshotGrant,
    BillFnEntitlementsResponseData,
)
from examples.mock_api import create_mock_handler

_mock_api_handler = create_mock_handler()


def _handler(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/entitlements"):
        assert request.url.params.get("principalId") == "user_123"
        return httpx.Response(
            200,
            json={
                "ok": True,
                "data": {
                    "billingAccount": {
                        "id": "ba_user_user_123",
                        "ownerType": "user",
                        "ownerId": "user_123",
                        "createdAt": "2026-04-20T00:00:00.000Z",
                        "updatedAt": "2026-04-20T00:00:00.000Z",
                    },
                    "entitlements": {
                        "id": "ent_ba_user_user_123",
                        "billingAccountId": "ba_user_user_123",
                        "planKey": "pro",
                        "status": "trialing",
                        "features": {"sync": True},
                        "limits": {"storage": 1000},
                        "effectiveAt": "2026-04-20T00:00:00.000Z",
                        "expiresAt": "2026-05-04T00:00:00.000Z",
                        "sourceEventId": "grant:grant_trial_ba_user_user_123",
                        "grant": {
                            "id": "grant_trial_ba_user_user_123",
                            "kind": "trial",
                            "expiresAt": "2026-05-04T00:00:00.000Z",
                        },
                        "createdAt": "2026-04-20T00:00:00.000Z",
                        "updatedAt": "2026-04-20T00:00:00.000Z",
                    },
                    "subscription": None,
                    "grants": [
                        {
                            "id": "grant_trial_ba_user_user_123",
                            "kind": "trial",
                            "planKey": "pro",
                            "status": "active",
                            "startsAt": "2026-04-20T00:00:00.000Z",
                            "expiresAt": "2026-05-04T00:00:00.000Z",
                            "revokedAt": None,
                        },
                        {
                            "id": "grant_comp_ba_user_user_123_1",
                            "kind": "comp",
                            "planKey": "pro",
                            "status": "revoked",
                            "startsAt": "2026-04-01T00:00:00.000Z",
                            "expiresAt": "2026-04-30T00:00:00.000Z",
                            "revokedAt": "2026-04-10T00:00:00.000Z",
                        },
                    ],
                },
                "meta": {"timestamp": "2026-04-20T00:00:00.000Z"},
            },
        )

    return _mock_api_handler(request)


def test_sync_client_parses_catalog_and_checkout() -> None:
    transport = httpx.MockTransport(_handler)
    http_client = httpx.Client(transport=transport)
    client = BillFnClient(base_url="https://billfn.example.test/billfn", client=http_client)

    catalog = client.get_catalog().unwrap()
    assert catalog.plans[0].plan_key == "pro"

    checkout = client.create_checkout(
        BillFnCheckoutCreateRequest(
            subject=BillableSubject(principal_id="user_123"),
            plan_key="pro",
            provider="dodo",
            interval="month",
        )
    ).unwrap()
    assert checkout.checkout_session.checkout_session_id == "chk_123"


def test_sync_client_default_base_url_is_absolute() -> None:
    seen_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_urls.append(str(request.url))
        return _handler(request)

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    client = BillFnClient(client=http_client)

    client.get_catalog()

    assert seen_urls == ["http://localhost:3000/billfn/catalog"]


def test_sync_client_passes_subject_query_and_raises_api_errors() -> None:
    transport = httpx.MockTransport(_handler)
    http_client = httpx.Client(transport=transport)
    client = BillFnClient(base_url="https://billfn.example.test/billfn", client=http_client)

    entitlements = client.get_entitlements(BillableSubject(principal_id="user_123")).unwrap()
    assert entitlements.billing_account.id == "ba_user_user_123"

    with pytest.raises(BillFnApiError) as error:
        client.sync_subscription({"subject": {"principalId": "user_123"}}).unwrap()

    assert error.value.code == "BILLFN_NOT_FOUND"


@pytest.mark.asyncio
async def test_async_client_parses_catalog() -> None:
    transport = httpx.MockTransport(_handler)
    http_client = httpx.AsyncClient(transport=transport)
    client = AsyncBillFnClient(base_url="https://billfn.example.test/billfn", client=http_client)

    catalog = (await client.get_catalog()).unwrap()
    assert catalog.plans[0].plan_key == "pro"

    await client.aclose()


def _assert_entitlement_grants(entitlements: BillFnEntitlementsResponseData) -> None:
    assert entitlements.entitlements is not None
    assert entitlements.entitlements.grant == BillFnEntitlementSnapshotGrant(
        id="grant_trial_ba_user_user_123", kind="trial", expires_at="2026-05-04T00:00:00.000Z"
    )
    assert [(grant.id, grant.kind, grant.status, grant.expires_at, grant.revoked_at) for grant in entitlements.grants] == [
        ("grant_trial_ba_user_user_123", "trial", "active", "2026-05-04T00:00:00.000Z", None),
        ("grant_comp_ba_user_user_123_1", "comp", "revoked", "2026-04-30T00:00:00.000Z", "2026-04-10T00:00:00.000Z"),
    ]
    assert isinstance(entitlements.grants[0], BillFnEntitlementGrantSummary)
    assert entitlements.model_dump(by_alias=True)["grants"][1]["revokedAt"] == "2026-04-10T00:00:00.000Z"


def test_sync_client_parses_entitlement_grants() -> None:
    http_client = httpx.Client(transport=httpx.MockTransport(_handler))
    client = BillFnClient(base_url="https://billfn.example.test/billfn", client=http_client)

    _assert_entitlement_grants(client.get_entitlements(BillableSubject(principal_id="user_123")).unwrap())


@pytest.mark.asyncio
async def test_async_client_parses_entitlement_grants() -> None:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
    client = AsyncBillFnClient(base_url="https://billfn.example.test/billfn", client=http_client)

    _assert_entitlement_grants((await client.get_entitlements(BillableSubject(principal_id="user_123"))).unwrap())

    await client.aclose()


def test_sync_client_reports_invalid_success_envelope() -> None:
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(
            200,
            json={
                "ok": True,
                "data": {
                    "plans": [
                        {
                            "productKey": "nucleus",
                            "planKey": 123,
                            "displayName": "Broken",
                            "features": {"sync": True},
                            "limits": {"storage": 1000},
                            "prices": [],
                        }
                    ]
                },
            },
        )
    )
    http_client = httpx.Client(transport=transport)
    client = BillFnClient(base_url="https://billfn.example.test/billfn", client=http_client)

    with pytest.raises(BillFnApiError) as error:
        client.get_catalog().unwrap()

    assert error.value.code == "BILLFN_INVALID_ENVELOPE"
