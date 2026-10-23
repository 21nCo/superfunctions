from __future__ import annotations

import string
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional, Sequence

from ..core.errors import ValidationError


def _extract_variables(template: str) -> tuple[str, ...]:
    formatter = string.Formatter()
    names: list[str] = []
    for _, field_name, _, _ in formatter.parse(template):
        if field_name and field_name not in names:
            names.append(field_name)
    return tuple(names)


def _normalize_values(values: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> Dict[str, Any]:
    payload = dict(values or {})
    payload.update(kwargs)
    return payload


@dataclass(frozen=True)
class PromptTemplate:
    template: str
    variables: Optional[Sequence[str]] = None
    name: Optional[str] = None
    version: Optional[str] = None
    description: Optional[str] = None
    tags: Sequence[str] = field(default_factory=tuple)
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        resolved = tuple(self.variables) if self.variables is not None else _extract_variables(self.template)
        object.__setattr__(self, "variables", resolved)

    def format(self, values: Optional[Mapping[str, Any]] = None, **kwargs: Any) -> str:
        payload = _normalize_values(values, **kwargs)
        missing = [name for name in self.required_variables if name not in payload]
        if missing:
            raise ValidationError(
                f"Missing template variables: {missing}",
                metadata={"missing": missing, "variables": list(self.required_variables)},
            )

        try:
            return self.template.format_map(payload)
        except KeyError as exc:
            missing_name = str(exc).strip("'")
            raise ValidationError(
                f"Missing template variable: {missing_name}",
                metadata={"missing": [missing_name], "variables": list(self.required_variables)},
            ) from exc

    @property
    def required_variables(self) -> tuple[str, ...]:
        return tuple(self.variables or ())
