from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from superfunctions.db import Adapter, CreateParams, FindManyParams, FindOneParams, OrderBy, WhereClause

from ..core.errors import TraceNotFoundError


class TraceStorage:
    def __init__(self, db: Adapter):
        self._db = db
        self._trace_table_name = "langfn_traces"
        self._span_table_name = "langfn_trace_spans"
        self._feedback_table_name = "langfn_trace_feedback"

    async def save(self, trace_data: Dict[str, Any]) -> None:
        await self.save_trace(trace_data)

    async def save_trace(self, trace_data: Dict[str, Any]) -> Dict[str, Any]:
        record = {
            **trace_data,
            "trace_id": trace_data.get("trace_id") or trace_data.get("id"),
            "id": trace_data.get("id") or trace_data.get("trace_id"),
            "created_at": int(trace_data.get("created_at") or time.time() * 1000),
        }
        await self._db.create(CreateParams(model=self._trace_table_name, data=record))
        return record

    async def save_span(self, span_data: Dict[str, Any]) -> Dict[str, Any]:
        await self._db.create(CreateParams(model=self._span_table_name, data=span_data))
        return span_data

    async def save_feedback(self, feedback_data: Dict[str, Any]) -> Dict[str, Any]:
        trace_id = str(feedback_data["trace_id"])
        trace = await self.find_one(trace_id)
        if trace is None:
            raise TraceNotFoundError(metadata={"trace_id": trace_id})

        client_key = feedback_data.get("client_key")
        if client_key:
            existing = await self._db.find_one(
                FindOneParams(
                    model=self._feedback_table_name,
                    where=[
                        WhereClause(field="trace_id", operator="eq", value=trace_id),
                        WhereClause(field="client_key", operator="eq", value=client_key),
                    ],
                )
            )
            if existing is not None:
                return existing

        record = {**feedback_data, "created_at": int(feedback_data.get("created_at") or time.time() * 1000)}
        await self._db.create(CreateParams(model=self._feedback_table_name, data=record))
        return record

    async def list_feedback(self, trace_id: str) -> List[Dict[str, Any]]:
        return await self._db.find_many(
            FindManyParams(
                model=self._feedback_table_name,
                where=[WhereClause(field="trace_id", operator="eq", value=trace_id)],
                order_by=[OrderBy(field="created_at", direction="desc")],
            )
        )

    async def find_many(
        self,
        limit: int = 10,
        offset: int = 0,
        model: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        where = {}
        if model:
            where["model"] = model
        if provider:
            where["provider"] = provider

        clauses = [WhereClause(field=key, operator="eq", value=value) for key, value in where.items()]

        return await self._db.find_many(
            FindManyParams(
                model=self._trace_table_name,
                where=clauses,
                limit=limit,
                offset=offset,
                order_by=[OrderBy(field="created_at", direction="desc")],
            )
        )

    async def find_one(self, trace_id: str) -> Optional[Dict[str, Any]]:
        return await self._db.find_one(
            FindOneParams(
                model=self._trace_table_name,
                where=[WhereClause(field="trace_id", operator="eq", value=trace_id)],
            )
        )
