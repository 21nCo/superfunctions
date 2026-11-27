import time
from typing import Any, Literal

from pydantic import BaseModel, Field

MemoryType = Literal[
    "profile_static",
    "profile_dynamic",
    "conversational",
    "procedural",
    "document",
    "derived"
]

RelationType = Literal["updates", "extends", "contradicts", "derives", "related"]

class Memory(BaseModel):
    id: str | None = None
    tenant_id: str = Field(default="default", alias="tenantId")
    container_tags: list[str] = Field(default_factory=list, alias="containerTags")
    type: MemoryType = "conversational"
    content: str
    embedding: list[float] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    is_latest: bool = Field(default=True, alias="isLatest")
    created_at: float = Field(default_factory=lambda: time.time() * 1000, alias="createdAt")
    updated_at: float = Field(default_factory=lambda: time.time() * 1000, alias="updatedAt")

    class Config:
        populate_by_name = True

class MemoryRelationship(BaseModel):
    id: str | None = None
    from_id: str = Field(alias="fromId")
    to_id: str = Field(alias="toId")
    type: RelationType
    confidence: float = 1.0
    reasoning: str | None = None
    created_at: float = Field(default_factory=lambda: time.time() * 1000, alias="createdAt")

    class Config:
        populate_by_name = True

class AddMemoryInput(BaseModel):
    content: str
    container_tags: list[str] = Field(default_factory=list, alias="containerTags")
    type: MemoryType = "conversational"
    metadata: dict[str, Any] = Field(default_factory=dict)
    tenant_id: str = Field(default="default", alias="tenantId")

class SearchMemoryInput(BaseModel):
    q: str
    container_tags: list[str] = Field(default_factory=list, alias="containerTags")
    filters: dict[str, Any] | None = None
    limit: int = 10
    threshold: float = 0.7

class SearchMemoryResult(BaseModel):
    results: list[Memory]
    total_found: int = Field(alias="totalFound")