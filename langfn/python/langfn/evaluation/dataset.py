from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field
from pydantic import ValidationError as PydanticValidationError

from ..core.errors import ValidationError


class DatasetItem(BaseModel):
    input: str
    expected: str
    metadata: Dict[str, Any] = Field(default_factory=dict)
    id: Optional[str] = None


class EvaluationDataset(BaseModel):
    items: List[DatasetItem]

    @classmethod
    def from_items(cls, items: List[DatasetItem | Dict[str, Any]]) -> "EvaluationDataset":
        try:
            normalized = [item if isinstance(item, DatasetItem) else DatasetItem.model_validate(item) for item in items]
        except PydanticValidationError as exc:
            raise ValidationError("evaluation dataset items are invalid", metadata={"errors": exc.errors()}) from exc
        if not normalized:
            raise ValidationError("evaluation dataset must contain at least one item")
        with_ids = [
            item.model_copy(update={"id": item.id or f"dataset-item-{index + 1}"})
            for index, item in enumerate(normalized)
        ]
        return cls(items=with_ids)
