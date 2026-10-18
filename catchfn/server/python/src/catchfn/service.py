"""Validated durable bug reports using the shared adapter contract."""

from __future__ import annotations

import base64
import json
import math
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from superfunctions.db import (
    Adapter,
    CreateParams,
    DeleteManyParams,
    Direction,
    FindManyParams,
    FindOneParams,
    Operator,
    OrderBy,
    WhereClause,
)

from .schema import validate_table_name
from .types import BugReportEvent


class CatchFnValidationError(ValueError):
    pass


class CatchFnConflictError(ValueError):
    pass


_SENSITIVE = re.compile(
    r"password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|credit[_-]?card|card[_-]?number|cvv|ssn",
    re.IGNORECASE,
)
_CARD = re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b")


def _redact(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {
            name: "[REDACTED]" if _SENSITIVE.search(name) else _redact(item, name)
            for name, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item, key) for item in value]
    if isinstance(value, str):
        if re.search(r"url|href", key, re.IGNORECASE):
            parsed = urlsplit(value)
            if parsed.scheme in ("http", "https") and parsed.hostname:
                host = parsed.hostname
                if ":" in host:
                    host = "[" + host + "]"
                if parsed.port:
                    host += ":" + str(parsed.port)
                query = urlencode(
                    [
                        (name, "[REDACTED]" if _SENSITIVE.search(name) else item)
                        for name, item in parse_qsl(
                            parsed.query, keep_blank_values=True
                        )
                    ]
                )
                fragment = (
                    "[REDACTED]"
                    if _SENSITIVE.search(parsed.fragment)
                    else parsed.fragment
                )
                value = urlunsplit((parsed.scheme, host, parsed.path, query, fragment))
        return _CARD.sub("XXXX-XXXX-XXXX-XXXX", value)
    return value


def _json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def _tag(value: str) -> str:
    return "|" + base64.urlsafe_b64encode(value.encode()).decode().rstrip("=") + "|"


class CatchFnService:
    def __init__(
        self,
        db: Adapter,
        table_name: str = "catchfn_bugs",
        *,
        app: str | None = None,
        max_payload_size: int = 262144,
        retention_days: float = 30,
        now: Callable[[], float] | None = None,
    ):
        self.db = db
        self.table_name = validate_table_name(table_name)
        self.app = app
        self.max_payload_size = max_payload_size
        self.retention_days = retention_days
        self.now = now or (lambda: time.time() * 1000)
        if (
            isinstance(max_payload_size, bool)
            or not isinstance(max_payload_size, int)
            or max_payload_size < 1
        ):
            raise CatchFnValidationError("Invalid max_payload_size")
        if not math.isfinite(retention_days) or retention_days < 0:
            raise CatchFnValidationError("Invalid retention_days")

    def _where(self, extra: list[WhereClause] | None = None) -> list[WhereClause]:
        return ([WhereClause(field="app", value=self.app)] if self.app else []) + (
            extra or []
        )

    async def create_bug(self, report: BugReportEvent) -> BugReportEvent:
        value = _redact(
            report.model_dump(mode="json", exclude_none=True, exclude={"receivedAt"})
        )
        canonical = BugReportEvent.model_validate(value)
        payload = _json(value)
        if len(payload.encode("utf-8")) > self.max_payload_size:
            raise CatchFnValidationError("Bug report exceeds max_payload_size")
        app = value.get("app", {}).get("name", self.app or "default")
        if self.app and app != self.app:
            raise CatchFnValidationError("Application does not match service scope")
        existing = await self.get_bug(report.id)
        if existing:
            if _json(existing.model_dump(mode="json", exclude_none=True)) != payload:
                raise CatchFnConflictError(
                    "Bug id already exists with different content"
                )
            return existing
        try:
            await self.db.create(
                CreateParams(
                    model=self.table_name,
                    data={
                        "id": report.id,
                        "app": app,
                        "timestamp": report.timestamp,
                        "receivedAt": self.now(),
                        "severity": report.severity.value,
                        "tags": "".join(_tag(tag) for tag in report.tags or []),
                        "sessionId": value.get("sessionId"),
                        "replayId": value.get("replayId"),
                        "issueId": (report.integration or {}).get("issueId"),
                        "payload": payload,
                    },
                )
            )
        except Exception:
            existing = await self.get_bug(report.id)
            if (
                existing
                and _json(existing.model_dump(mode="json", exclude_none=True))
                == payload
            ):
                return existing
            if existing:
                raise CatchFnConflictError(
                    "Bug id already exists with different content"
                ) from None
            raise
        return canonical

    async def get_bug(self, bug_id: str) -> BugReportEvent | None:
        row = await self.db.find_one(
            FindOneParams(
                model=self.table_name,
                where=self._where([WhereClause(field="id", value=bug_id)]),
            )
        )
        if row is None:
            return None
        payload = row["payload"]
        return BugReportEvent.model_validate(
            json.loads(payload) if isinstance(payload, str) else payload
        )

    async def list_bugs(
        self, limit: int = 50, offset: int = 0, **filters: Any
    ) -> list[BugReportEvent]:
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 200
            or isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset < 0
        ):
            raise CatchFnValidationError("Invalid pagination")
        if self.app and filters.get("app") and filters["app"] != self.app:
            raise CatchFnValidationError("Application does not match service scope")
        where = self._where()
        for field in ("app", "severity", "sessionId", "replayId", "issueId"):
            if filters.get(field):
                where.append(WhereClause(field=field, value=filters[field]))
        for field, operator in (("from_time", Operator.GTE), ("to_time", Operator.LTE)):
            value = filters.get(field)
            if value is not None:
                if not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise CatchFnValidationError("Invalid time filter")
                where.append(
                    WhereClause(field="timestamp", operator=operator, value=value)
                )
        for tag in filters.get("tags", []):
            where.append(
                WhereClause(field="tags", operator=Operator.CONTAINS, value=_tag(tag))
            )
        rows = await self.db.find_many(
            FindManyParams(
                model=self.table_name,
                where=where,
                limit=limit,
                offset=offset,
                orderBy=[
                    OrderBy(field="timestamp", direction=Direction.DESC),
                    OrderBy(field="id", direction=Direction.ASC),
                ],
            )
        )
        return [
            BugReportEvent.model_validate(
                json.loads(row["payload"])
                if isinstance(row["payload"], str)
                else row["payload"]
            )
            for row in rows
        ]

    async def cleanup(self, retention_days: float | None = None) -> int:
        days = self.retention_days if retention_days is None else retention_days
        if not math.isfinite(days) or days < 0:
            raise CatchFnValidationError("Invalid retention_days")
        return await self.db.delete_many(
            DeleteManyParams(
                model=self.table_name,
                where=self._where(
                    [
                        WhereClause(
                            field="receivedAt",
                            operator=Operator.LT,
                            value=self.now() - days * 86400000,
                        )
                    ]
                ),
            )
        )
