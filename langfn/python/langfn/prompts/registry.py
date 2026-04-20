from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Sequence

from ..core.errors import LangFnError, ValidationError
from .template import PromptTemplate

if TYPE_CHECKING:
    from superfunctions.db import Adapter
    from superfunctions.db import FindManyParams, FindOneParams, UpsertParams, WhereClause
else:  # pragma: no cover - import lazily for smoke compatibility
    Adapter = Any  # type: ignore[assignment]
    FindManyParams = FindOneParams = UpsertParams = WhereClause = Any  # type: ignore[assignment]


@dataclass(frozen=True)
class PromptRecord:
    id: str
    name: str
    version: str
    template: str
    variables: Sequence[str] = field(default_factory=tuple)
    description: Optional[str] = None
    tags: Sequence[str] = field(default_factory=tuple)
    metadata: Mapping[str, Any] = field(default_factory=dict)
    created_at: int = 0
    updated_at: int = 0

    @classmethod
    def from_data(cls, data: Mapping[str, Any]) -> "PromptRecord":
        return cls(
            id=str(data.get("id") or ""),
            name=str(data.get("name") or ""),
            version=str(data.get("version") or ""),
            template=str(data.get("template") or ""),
            variables=tuple(data.get("variables") or ()),
            description=data.get("description"),
            tags=tuple(data.get("tags") or ()),
            metadata=dict(data.get("metadata") or {}),
            created_at=int(data.get("created_at") or data.get("createdAt") or 0),
            updated_at=int(data.get("updated_at") or data.get("updatedAt") or 0),
        )

    def to_prompt_template(self) -> PromptTemplate:
        return PromptTemplate(
            template=self.template,
            variables=self.variables,
            name=self.name,
            version=self.version,
            description=self.description,
            tags=self.tags,
            metadata=self.metadata,
        )


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
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PromptTemplate:
        _validate_semver(version)
        timestamp = int(time.time() * 1000)
        description = description if description is not None else prompt.description
        record = PromptRecord(
            id=f"{name}:{version}",
            name=name,
            version=version,
            template=prompt.template,
            variables=tuple(prompt.required_variables),
            description=description,
            tags=tuple(tags if tags is not None else prompt.tags),
            metadata=dict(metadata if metadata is not None else prompt.metadata),
            created_at=timestamp,
            updated_at=timestamp,
        )

        from superfunctions.db import UpsertParams, WhereClause

        await self._db.upsert(
            UpsertParams(
                model=self._table_name,
                where=[WhereClause(field="id", operator="eq", value=record.id)],
                create=_record_to_data(record),
                update=_record_to_data(record),
            )
        )
        return record.to_prompt_template()

    async def load(self, name: str, version: str = "latest") -> PromptTemplate:
        if version == "latest":
            record = await self._load_latest(name)
        else:
            record = await self._load_exact(name, version)

        if record is None:
            raise LangFnError(
                f"Prompt not found: {name}@{version}",
                code="NOT_FOUND",
                metadata={"name": name, "version": version},
            )
        return record.to_prompt_template()

    async def list(self, name: Optional[str] = None) -> List[PromptTemplate]:
        from superfunctions.db import FindManyParams, OrderBy, WhereClause

        where = [WhereClause(field="name", operator="eq", value=name)] if name else []
        records = await self._db.find_many(
            FindManyParams(
                model=self._table_name,
                where=where,
                order_by=[OrderBy(field="updated_at", direction="desc")],
            )
        )
        prompt_records = [PromptRecord.from_data(record) for record in records]
        prompt_records.sort(key=_prompt_sort_key, reverse=True)
        return [record.to_prompt_template() for record in prompt_records]

    async def _load_exact(self, name: str, version: str) -> Optional[PromptRecord]:
        _validate_semver(version)
        from superfunctions.db import FindOneParams, WhereClause

        record = await self._db.find_one(
            FindOneParams(
                model=self._table_name,
                where=[WhereClause(field="id", operator="eq", value=f"{name}:{version}")],
            )
        )
        return PromptRecord.from_data(record) if record else None

    async def _load_latest(self, name: str) -> Optional[PromptRecord]:
        from superfunctions.db import FindManyParams, WhereClause

        records = await self._db.find_many(
            FindManyParams(
                model=self._table_name,
                where=[WhereClause(field="name", operator="eq", value=name)],
            )
        )
        prompt_records = [PromptRecord.from_data(record) for record in records]
        valid_records = [record for record in prompt_records if _is_valid_semver(record.version)]
        if not valid_records:
            return None
        valid_records.sort(key=_prompt_sort_key, reverse=True)
        return valid_records[0]


def _record_to_data(record: PromptRecord) -> Dict[str, Any]:
    return {
        "id": record.id,
        "name": record.name,
        "version": record.version,
        "template": record.template,
        "variables": list(record.variables),
        "description": record.description,
        "tags": list(record.tags),
        "metadata": dict(record.metadata),
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


def _validate_semver(version: str) -> None:
    if not _is_valid_semver(version):
        raise ValidationError("Prompt registry versions must be semantic versions", metadata={"version": version})


def _is_valid_semver(version: str) -> bool:
    try:
        _parse_semver(version)
    except ValidationError:
        return False
    return True


def _parse_semver(version: str) -> tuple[int, int, int]:
    parts = version.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise ValidationError("Invalid semantic version", metadata={"version": version})
    return int(parts[0]), int(parts[1]), int(parts[2])


def _prompt_sort_key(record: PromptRecord) -> tuple[int, int, int, int]:
    major, minor, patch = _parse_semver(record.version)
    return major, minor, patch, record.updated_at
