from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from superfunctions.db import Adapter


class TraceStorage:
    def __init__(self, db: Adapter):
        self._db = db
        self._table_name = "langfn_traces"

    async def save(self, trace_data: Dict[str, Any]) -> None:
        if "created_at" not in trace_data:
            trace_data["created_at"] = int(time.time() * 1000)
            
        await self._db.create(
            table=self._table_name,
            data=trace_data,
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

        return await self._db.find_many(
            table=self._table_name,
            where=where,
            limit=limit,
            offset=offset,
            order_by=[{"field": "created_at", "direction": "desc"}],
        )
