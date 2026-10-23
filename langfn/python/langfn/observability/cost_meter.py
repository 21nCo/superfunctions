from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

from ..core.types import Cost, TokenUsage


@dataclass(frozen=True)
class Price:
    input_per_1k: float
    output_per_1k: float


class CostMeter:
    def __init__(self, *, prices: Dict[str, Dict[str, Price]]):
        self._prices = prices

    def estimate(self, *, provider: str, model: str, usage: TokenUsage) -> Optional[Cost]:
        provider_prices = self._prices.get(provider)
        if provider_prices is None:
            return None
        price = provider_prices.get(model)
        if price is None:
            return None

        input_cost = (usage.prompt_tokens / 1000.0) * price.input_per_1k
        output_cost = (usage.completion_tokens / 1000.0) * price.output_per_1k
        return Cost(input=input_cost, output=output_cost, total=input_cost + output_cost)
