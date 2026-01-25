from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Generic, Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

from ..core.errors import SchemaValidationError
from ..utils.json import extract_first_json_object

TModel = TypeVar("TModel", bound=BaseModel)


@dataclass(frozen=True)
class StructuredOutput(Generic[TModel]):
    schema: Type[TModel]
    mode: str = "json"

    def parse(self, text: str) -> TModel:
        candidate = extract_first_json_object(text)
        if candidate is None:
            raise SchemaValidationError("No JSON object found in model output", metadata={"text": text})

        try:
            data = json.loads(candidate)
        except json.JSONDecodeError as exc:
            raise SchemaValidationError("Invalid JSON in model output", metadata={"text": candidate}) from exc

        try:
            return self.schema.model_validate(data)
        except ValidationError as exc:
            raise SchemaValidationError("Output does not match schema", metadata={"errors": exc.errors()}) from exc

