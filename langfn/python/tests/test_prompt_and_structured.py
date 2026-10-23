from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest
from pydantic import BaseModel

from langfn.core.errors import LangFnError, SchemaValidationError
from langfn.prompts import PromptRegistry, PromptTemplate
from langfn.structured import StructuredOutput
from superfunctions.db import FindManyParams, FindOneParams, UpsertParams


class OutputModel(BaseModel):
    label: str
    severity: int


class MemoryAdapter:
    def __init__(self) -> None:
        self.records: Dict[str, Dict[str, Any]] = {}

    async def upsert(self, params: UpsertParams) -> Dict[str, Any]:
        payload = dict(params.create)
        existing = self.records.get(payload["id"])
        if existing is not None:
            updated = dict(existing)
            updated.update(params.update)
            payload = updated
        self.records[payload["id"]] = payload
        return payload

    async def find_one(self, params: FindOneParams) -> Optional[Dict[str, Any]]:
        for record in self.records.values():
            if all(record.get(clause.field) == clause.value for clause in params.where):
                return dict(record)
        return None

    async def find_many(self, params: FindManyParams) -> List[Dict[str, Any]]:
        records = list(self.records.values())
        if params.where:
            filtered = []
            for record in records:
                if all(record.get(clause.field) == clause.value for clause in params.where):
                    filtered.append(dict(record))
            return filtered
        return [dict(record) for record in records]


def test_structured_output_extracts_json_and_preserves_field_details():
    parsed = StructuredOutput(schema=OutputModel).parse('prefix {"label":"bug","severity":2} suffix')
    assert parsed.label == "bug"
    assert parsed.severity == 2

    with pytest.raises(SchemaValidationError) as no_json:
        StructuredOutput(schema=OutputModel).parse("no object here")
    assert no_json.value.code == "SCHEMA_VALIDATION"
    assert no_json.value.metadata["errors"][0]["message"] == "No JSON object found"

    with pytest.raises(SchemaValidationError) as wrong_type:
        StructuredOutput(schema=OutputModel).parse('{"label":"bug","severity":"high"}')
    assert wrong_type.value.code == "SCHEMA_VALIDATION"
    assert wrong_type.value.metadata["errors"][0]["loc"] == ("severity",)


@pytest.mark.asyncio
async def test_prompt_registry_resolves_exact_and_latest_deterministically():
    adapter = MemoryAdapter()
    registry = PromptRegistry(adapter)

    await registry.save(
        "support-reply",
        PromptTemplate("v1", metadata={"channel": "email"}),
        "1.0.0",
        description="Support prompt",
    )
    await registry.save(
        "support-reply",
        PromptTemplate("v2"),
        "1.1.0",
    )

    exact = await registry.load("support-reply", "1.0.0")
    latest = await registry.load("support-reply", "latest")
    listed = await registry.list("support-reply")

    assert exact.version == "1.0.0"
    assert exact.metadata["channel"] == "email"
    assert latest.version == "1.1.0"
    assert [prompt.version for prompt in listed] == ["1.1.0", "1.0.0"]

    with pytest.raises(LangFnError) as not_found:
        await registry.load("support-reply", "9.9.9")
    assert not_found.value.code == "NOT_FOUND"
