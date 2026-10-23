from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Budgets:
    per_request_usd: Optional[float] = None

