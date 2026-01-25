from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from superfunctions.db import Adapter
from .template import PromptTemplate


class PromptRecord:
    def __init__(self, data: Dict[str, Any]):
        self.id = data.get("id")
        self.name = data.get("name")
        self.version = data.get("version")
        self.template = data.get("template")
        self.variables = data.get("variables", [])
        self.description = data.get("description")
        self.tags = data.get("tags", [])
        self.created_at = data.get("created_at")
        self.updated_at = data.get("updated_at")


class PromptRegistry:
    def __init__(self, db: Adapter):
        self._db = db
        self._table_name = "langfn_prompts"

    async def save(
        self,
        name: str,
        prompt: PromptTemplate,
        version: str,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> None:
        record = {
            "id": f"{name}:{version}",
            "name": name,
            "version": version,
            "template": prompt._template,
            "variables": prompt._variables or [],
            "description": description,
            "tags": tags or [],
            "created_at": int(time.time() * 1000),
            "updated_at": int(time.time() * 1000),
        }

        await self._db.upsert(
            table=self._table_name,
            where={"id": record["id"]},
            data=record,
        )

    async def load(self, name: str, version: Optional[str] = None) -> Optional[PromptTemplate]:
        where = {"name": name}
        if version:
            where["id"] = f"{name}:{version}"

        record_data = await self._db.find_one(
            table=self._table_name,
            where=where,
            order_by=[{"field": "created_at", "direction": "desc"}],
        )

        if not record_data:
            return None

        return PromptTemplate(
            template=record_data["template"],
            variables=record_data.get("variables"),
        )
