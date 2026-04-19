"""Memory adapter fidelity tests for phase 3."""

from datetime import datetime

import pytest
from superfunctions.db import CreateManyParams, CreateParams, FindManyParams, UpdateParams, WhereClause

from sendfn.database.memory import MemoryAdapter
from sendfn.errors import DatabaseError


@pytest.mark.asyncio
async def test_memory_adapter_rejects_duplicate_ids() -> None:
    """Duplicate primary keys should raise the shared unique-constraint error."""
    adapter = MemoryAdapter()

    await adapter.create(CreateParams(model="email_transactions", data={"id": "tx-1"}))

    with pytest.raises(DatabaseError) as exc_info:
        await adapter.create(CreateParams(model="email_transactions", data={"id": "tx-1"}))

    assert exc_info.value.code == "SENDFN_UNIQUE_CONSTRAINT"
    assert exc_info.value.retryable is False


@pytest.mark.asyncio
async def test_memory_adapter_preserves_lookup_update_and_range_filter_behavior() -> None:
    """Range filters and in-place updates should behave like production adapters."""
    adapter = MemoryAdapter()

    await adapter.create(
        CreateParams(
            model="communication_events",
            data={
                "id": "evt-1",
                "eventTimestamp": datetime(2026, 4, 1, 0, 0, 0),
                "status": "pending",
            },
        )
    )
    await adapter.create(
        CreateParams(
            model="communication_events",
            data={
                "id": "evt-2",
                "eventTimestamp": datetime(2026, 4, 2, 0, 0, 0),
                "status": "pending",
            },
        )
    )

    await adapter.update(
        UpdateParams(
            model="communication_events",
            where=[WhereClause(field="id", operator="eq", value="evt-1")],
            data={"status": "processed"},
        )
    )

    filtered = await adapter.find_many(
        FindManyParams(
            model="communication_events",
            where=[
                WhereClause(
                    field="eventTimestamp",
                    operator="gte",
                    value=datetime(2026, 4, 1, 0, 0, 0),
                ),
                WhereClause(
                    field="eventTimestamp",
                    operator="lt",
                    value=datetime(2026, 4, 2, 0, 0, 0),
                ),
            ],
            limit=1,
            offset=0,
        )
    )

    assert len(filtered) == 1
    assert filtered[0]["id"] == "evt-1"
    assert filtered[0]["status"] == "processed"


@pytest.mark.asyncio
async def test_memory_adapter_create_many_rejects_duplicate_ids_without_partial_writes() -> None:
    """Batch inserts should fail closed when duplicate primary keys are present."""
    adapter = MemoryAdapter()

    with pytest.raises(DatabaseError) as exc_info:
        await adapter.create_many(
            CreateManyParams(
                model="email_transactions",
                data=[
                    {"id": "tx-1"},
                    {"id": "tx-1"},
                ],
            )
        )

    assert exc_info.value.code == "SENDFN_UNIQUE_CONSTRAINT"
    assert await adapter.find_many(FindManyParams(model="email_transactions")) == []
