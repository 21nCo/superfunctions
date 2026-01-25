from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class DatasetItem(BaseModel):
    input: str
    expected: str
    metadata: Dict[str, Any] = Field(default_factory=dict)

    id: Optional[str] = None

