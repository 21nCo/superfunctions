from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PYTHON_CORE_ROOT = PACKAGE_ROOT.parent / "python-core"

for path in (PACKAGE_ROOT, PYTHON_CORE_ROOT):
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)

from superfunctions.db import (  # noqa: E402
    ConstraintViolationError,
    DuplicateKeyError,
    Operator,
    QueryFailedError,
    WhereClause,
)
from superfunctions_sqlalchemy import create_adapter  # noqa: E402


@pytest.fixture()
def adapter():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    metadata = MetaData()
    Table(
        "users",
        metadata,
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("email", String, unique=True),
        Column("name", String),
    )
    metadata.create_all(engine)
    return create_adapter(engine)


@pytest.mark.asyncio
async def test_create_and_create_many_support_keyword_args_and_return_inserted_rows(adapter) -> None:
    created = await adapter.create(model="users", data={"email": "alice@example.com", "name": "Alice"})
    created_many = await adapter.create_many(
        model="users",
        data=[
            {"email": "bob@example.com", "name": "Bob"},
            {"email": "cara@example.com", "name": "Cara"},
        ],
    )

    assert created["id"] == 1
    assert [row["id"] for row in created_many] == [2, 3]


@pytest.mark.asyncio
async def test_update_reselects_using_primary_key_when_where_fields_change(adapter) -> None:
    created = await adapter.create(model="users", data={"email": "before@example.com", "name": "Alice"})

    updated = await adapter.update(
        model="users",
        where=[WhereClause(field="email", operator=Operator.EQ, value="before@example.com")],
        data={"email": "after@example.com"},
    )

    assert updated["id"] == created["id"]
    assert updated["email"] == "after@example.com"


@pytest.mark.asyncio
async def test_upsert_retries_update_after_duplicate_create(adapter, monkeypatch) -> None:
    async def fake_find_one(*args, **kwargs):
        return None

    async def fake_create(*args, **kwargs):
        raise DuplicateKeyError("duplicate")

    async def fake_update(*args, **kwargs):
        return {"id": 1, "email": "after@example.com"}

    monkeypatch.setattr(adapter, "find_one", fake_find_one)
    monkeypatch.setattr(adapter, "create", fake_create)
    monkeypatch.setattr(adapter, "update", fake_update)

    result = await adapter.upsert(
        model="users",
        where=[WhereClause(field="email", operator=Operator.EQ, value="before@example.com")],
        create={"email": "before@example.com", "name": "Alice"},
        update={"email": "after@example.com"},
    )

    assert result == {"id": 1, "email": "after@example.com"}


@pytest.mark.asyncio
async def test_find_many_supports_keyword_args(adapter) -> None:
    await adapter.create(model="users", data={"email": "alice@example.com", "name": "Alice"})
    rows = await adapter.find_many(
        model="users",
        where=[WhereClause(field="email", operator=Operator.EQ, value="alice@example.com")],
    )

    assert [row["email"] for row in rows] == ["alice@example.com"]


@pytest.mark.asyncio
async def test_update_many_requires_where_clause(adapter) -> None:
    await adapter.create(model="users", data={"email": "alice@example.com", "name": "Alice"})

    with pytest.raises(QueryFailedError, match="update_many requires a where clause"):
        await adapter.update_many(model="users", where=None, data={"name": "Updated"})


@pytest.mark.asyncio
async def test_find_many_rejects_unknown_where_fields(adapter) -> None:
    with pytest.raises(QueryFailedError, match="Unknown field in where clause"):
        await adapter.find_many(
            model="users",
            where=[WhereClause(field="missing", operator=Operator.EQ, value="x")],
        )


@pytest.mark.asyncio
async def test_update_touches_only_one_row_when_where_matches_multiple(adapter) -> None:
    await adapter.create(model="users", data={"email": "a@example.com", "name": "same"})
    await adapter.create(model="users", data={"email": "b@example.com", "name": "same"})

    updated = await adapter.update(
        model="users",
        where=[WhereClause(field="name", operator=Operator.EQ, value="same")],
        data={"name": "changed"},
    )

    assert updated["name"] == "changed"
    rows = await adapter.find_many(model="users", where=[])
    assert sorted(row["name"] for row in rows) == ["changed", "same"]


@pytest.mark.asyncio
async def test_create_many_preserves_constraint_errors(adapter) -> None:
    await adapter.create(model="users", data={"email": "dupe@example.com", "name": "Alice"})

    with pytest.raises((DuplicateKeyError, ConstraintViolationError)):
        await adapter.create_many(
            model="users",
            data=[
                {"email": "dupe@example.com", "name": "Bob"},
            ],
        )
