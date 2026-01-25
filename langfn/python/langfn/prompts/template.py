from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Sequence


@dataclass(frozen=True)
class PromptTemplate:
    template: str
    variables: Optional[Sequence[str]] = None

    def format(self, values: Dict[str, Any]) -> str:
        if self.variables is not None:
            missing = [v for v in self.variables if v not in values]
            if missing:
                raise KeyError(f"Missing template variables: {missing}")
        return self.template.format_map(values)

