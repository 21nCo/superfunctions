import json
from typing import Any, Dict

import pytest
from superfunctions.http import RouteContext

from langfn import LangFn
from langfn.core.errors import LangFnError, RateLimitError
from langfn.models import MockChatModel
from langfn.observability import Budgets, CostMeter
from langfn.observability.cost_meter import Price
from langfn.utils import RetryConfig


@pytest.mark.asyncio
async def test_budget_enforced_when_cost_known():
    model = MockChatModel(responses=["ok"], usage={"prompt_tokens": 1000, "completion_tokens": 0})
    meter = CostMeter(prices={"mock": {"mock-1": Price(input_per_1k=1.0, output_per_1k=0.0)}})
    lang = LangFn(
        model=model,
        observability={"enabled": True, "cost_meter": meter, "budgets": Budgets(per_request_usd=0.5)},
    )

    with pytest.raises(LangFnError) as e:
        await lang.complete("ignored")
    assert e.value.code == "BUDGET_EXCEEDED"


@pytest.mark.asyncio
async def test_retry_retries_rate_limits():
    class Flaky(MockChatModel):
        def __init__(self):
            super().__init__(responses=["ok"])
            self.calls = 0

        async def complete(self, request):  # type: ignore[override]
            self.calls += 1
            if self.calls == 1:
                raise RateLimitError(retry_after=0.0)
            return await super().complete(request)

    model = Flaky()
    lang = LangFn(model=model)
    resp = await lang.complete("x", retry=RetryConfig(max_attempts=2, base_delay_s=0.0, max_delay_s=0.0))
    assert resp.content == "ok"
    assert model.calls == 2


class _FakeRequest:
    def __init__(self, body: Dict[str, Any]):
        self._body = body

    @property
    def method(self) -> str:
        return "POST"

    @property
    def path(self) -> str:
        return "/complete"

    @property
    def headers(self) -> Dict[str, str]:
        return {"content-type": "application/json"}

    @property
    def query_params(self) -> Dict[str, Any]:
        return {}

    async def json(self) -> Any:
        return self._body

    async def body(self) -> bytes:
        return json.dumps(self._body).encode("utf-8")

    async def text(self) -> str:
        return json.dumps(self._body)


@pytest.mark.asyncio
async def test_http_complete_handler():
    from langfn.http.handlers import HttpHandlers

    lang = LangFn(model=MockChatModel(responses=["hello"]))
    handlers = HttpHandlers(lang)
    req = _FakeRequest({"prompt": "ignored"})
    ctx = RouteContext(params={}, query={}, headers={}, url="http://x/complete", method="POST")
    resp = await handlers.complete(req, ctx)
    assert resp.status == 200
    assert resp.body["content"] == "hello"

