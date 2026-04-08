from __future__ import annotations

import sys
from pathlib import Path

import pytest
from sqlalchemy import Column, ForeignKey, Integer, MetaData, String, Table, create_engine, event


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package_root_str = str(PACKAGE_ROOT)
if package_root_str not in sys.path:
    sys.path.insert(0, package_root_str)

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


@pytest.fixture()
def weird_adapter():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    metadata = MetaData()
    Table(
        "weird",
        metadata,
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("keys", String),
        Column("values", String),
    )
    metadata.create_all(engine)
    return create_adapter(engine)


@pytest.fixture()
def no_pk_adapter():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    metadata = MetaData()
    Table(
        "events",
        metadata,
        Column("email", String),
        Column("name", String),
        Column("kind", String),
    )
    metadata.create_all(engine)
    return create_adapter(engine)


def _create_foreign_key_engine():
    engine = create_engine("sqlite+pysqlite:///:memory:")

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


@pytest.fixture()
def referential_adapter():
    engine = _create_foreign_key_engine()
    metadata = MetaData()
    Table(
        "parents",
        metadata,
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("name", String, unique=True),
    )
    Table(
        "children",
        metadata,
        Column("id", Integer, primary_key=True, autoincrement=True),
        Column("parent_id", Integer, ForeignKey("parents.id", ondelete="RESTRICT")),
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
async def test_find_many_respects_or_connectors(adapter) -> None:
    await adapter.create(model="users", data={"email": "alice@example.com", "name": "Alice"})
    await adapter.create(model="users", data={"email": "bob@example.com", "name": "Bob"})
    await adapter.create(model="users", data={"email": "cara@example.com", "name": "Cara"})

    rows = await adapter.find_many(
        model="users",
        where=[
            WhereClause(field="email", operator=Operator.EQ, value="alice@example.com"),
            WhereClause(field="email", operator=Operator.EQ, value="bob@example.com", connector="OR"),
        ],
    )

    assert sorted(row["email"] for row in rows) == ["alice@example.com", "bob@example.com"]


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


@pytest.mark.asyncio
async def test_create_preserves_duplicate_key_errors(adapter) -> None:
    await adapter.create(model="users", data={"email": "dupe@example.com", "name": "Alice"})

    with pytest.raises(DuplicateKeyError):
        await adapter.create(model="users", data={"email": "dupe@example.com", "name": "Bob"})


@pytest.mark.asyncio
async def test_update_many_preserves_constraint_errors(adapter) -> None:
    await adapter.create(model="users", data={"email": "alice@example.com", "name": "Alice"})
    await adapter.create(model="users", data={"email": "bob@example.com", "name": "Bob"})

    with pytest.raises(ConstraintViolationError):
        await adapter.update_many(
            model="users",
            where=[WhereClause(field="email", operator=Operator.EQ, value="bob@example.com")],
            data={"email": "alice@example.com"},
        )


@pytest.mark.asyncio
async def test_transaction_accepts_sync_callbacks(adapter) -> None:
    result = await adapter.transaction(lambda trx: "ok")

    assert result == "ok"


@pytest.mark.asyncio
async def test_field_lookups_use_column_keys_for_reserved_names(weird_adapter) -> None:
    await weird_adapter.create(model="weird", data={"keys": "alpha", "values": "one"})

    rows = await weird_adapter.find_many(
        model="weird",
        where=[WhereClause(field="keys", operator=Operator.EQ, value="alpha")],
        select=["keys", "values"],
    )

    assert rows == [{"keys": "alpha", "values": "one"}]


@pytest.mark.asyncio
async def test_update_without_primary_key_falls_back_to_existing_row_values(no_pk_adapter) -> None:
    await no_pk_adapter.create(model="events", data={"email": "a@example.com", "name": "same", "kind": "first"})
    await no_pk_adapter.create(model="events", data={"email": "b@example.com", "name": "same", "kind": "second"})

    updated = await no_pk_adapter.update(
        model="events",
        where=[WhereClause(field="name", operator=Operator.EQ, value="same")],
        data={"name": "changed"},
    )

    assert updated["email"] == "a@example.com"
    rows = await no_pk_adapter.find_many(model="events", where=[])
    assert sorted((row["email"], row["name"]) for row in rows) == [
        ("a@example.com", "changed"),
        ("b@example.com", "same"),
    ]


@pytest.mark.asyncio
async def test_delete_preserves_constraint_errors(referential_adapter) -> None:
    parent = await referential_adapter.create(model="parents", data={"name": "parent-1"})
    await referential_adapter.create(
        model="children",
        data={"parent_id": parent["id"], "name": "child-1"},
    )

    with pytest.raises(ConstraintViolationError):
        await referential_adapter.delete(
            model="parents",
            where=[WhereClause(field="id", operator=Operator.EQ, value=parent["id"])],
        )


@pytest.mark.asyncio
async def test_delete_many_preserves_constraint_errors(referential_adapter) -> None:
    parent = await referential_adapter.create(model="parents", data={"name": "parent-2"})
    await referential_adapter.create(
        model="children",
        data={"parent_id": parent["id"], "name": "child-2"},
    )

    with pytest.raises(ConstraintViolationError):
        await referential_adapter.delete_many(
            model="parents",
            where=[WhereClause(field="id", operator=Operator.EQ, value=parent["id"])],
        )
