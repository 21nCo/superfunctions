"""Function-owned schema; applications choose when to run migrations."""

import re
from typing import Any


def validate_table_name(table_name: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", table_name):
        raise ValueError("Invalid table name")
    return table_name


def get_sqlalchemy_table(metadata: Any, table_name: str = "catchfn_bugs") -> Any:
    from sqlalchemy import Column, Float, Index, MetaData, String, Table, Text

    validate_table_name(table_name)
    if not isinstance(metadata, MetaData):
        raise TypeError("metadata must be SQLAlchemy MetaData")
    return Table(
        table_name,
        metadata,
        Column("id", String(200), primary_key=True),
        Column("app", String(200), nullable=False),
        Column("timestamp", Float, nullable=False),
        Column("receivedAt", Float, nullable=False),
        Column("severity", String(20), nullable=False),
        Column("tags", Text, nullable=False),
        Column("sessionId", String(200)),
        Column("replayId", String(200)),
        Column("issueId", String(200)),
        Column("payload", Text, nullable=False),
        Index(table_name + "_app_time", "app", "timestamp"),
        Index(table_name + "_app_severity", "app", "severity"),
        Index(table_name + "_session", "sessionId"),
        Index(table_name + "_replay", "replayId"),
        Index(table_name + "_issue", "issueId"),
    )
