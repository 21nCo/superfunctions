from typing import List, Optional, Dict, Any, Literal
from pydantic import BaseModel, Field
from datetime import datetime
import time

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
    id: Optional[str] = None
    tenant_id: str = Field(default="default", alias="tenantId")
    container_tags: List[str] = Field(default_factory=list, alias="containerTags")
    type: MemoryType = "conversational"
    content: str
    embedding: Optional[List[float]] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    is_latest: bool = Field(default=True, alias="isLatest")
    created_at: float = Field(default_factory=lambda: time.time() * 1000, alias="createdAt")
    updated_at: float = Field(default_factory=lambda: time.time() * 1000, alias="updatedAt")

    class Config:
        populate_by_name = True

class MemoryRelationship(BaseModel):
    id: Optional[str] = None
    from_id: str = Field(alias="fromId")
    to_id: str = Field(alias="toId")
    type: RelationType
    confidence: float = 1.0
    reasoning: Optional[str] = None
    created_at: float = Field(default_factory=lambda: time.time() * 1000, alias="createdAt")

    class Config:
        populate_by_name = True

class AddMemoryInput(BaseModel):
    content: str
    container_tags: List[str] = Field(default_factory=list, alias="containerTags")
    type: MemoryType = "conversational"
    metadata: Dict[str, Any] = Field(default_factory=dict)
    tenant_id: str = Field(default="default", alias="tenantId")

class SearchMemoryInput(BaseModel):
    q: str
    container_tags: List[str] = Field(default_factory=list, alias="containerTags")
    filters: Optional[Dict[str, Any]] = None
    limit: int = 10
    threshold: float = 0.7

class SearchMemoryResult(BaseModel):
    results: List[Memory]
    total_found: int = Field(alias="totalFound")