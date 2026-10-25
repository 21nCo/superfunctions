"""Watch-owned JSON-text schema; applications apply migrations explicitly."""
import re
from superfunctions.db import FieldSchema, TableSchema


def get_watchfn_schema(table_name="watchfn_events"):
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,62}", table_name):
        raise ValueError("Invalid WatchFn table name")
    fields = [FieldSchema(name="id", type="string", primary_key=True, unique=True),
              FieldSchema(name="payload", type="text"),
              FieldSchema(name="logIndexFields", type="text", nullable=True)]
    for name in ["projectionVersion", "receivedAt", "eventTimestamp"]:
        fields.append(FieldSchema(name=name, type="bigint", nullable=True))
    for name in ["eventType", "eventApp", "eventSeverity", "eventIssueId", "eventSessionId", "eventReplayId"]:
        fields.append(FieldSchema(name=name, type="string", nullable=True))
    return TableSchema(name=table_name, fields=fields)
