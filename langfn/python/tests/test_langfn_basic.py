import pytest

from langfn import LangFn
from langfn.models import MockChatModel
from langfn.observability import CostMeter
from langfn.observability.cost_meter import Price


@pytest.mark.asyncio
async def test_langfn_complete_attaches_cost_and_trace():
    model = MockChatModel(responses=["hello"], usage={"prompt_tokens": 10, "completion_tokens": 5})
    meter = CostMeter(prices={"mock": {"mock-1": Price(input_per_1k=1.0, output_per_1k=2.0)}})
    lang = LangFn(model=model, observability={"enabled": True, "cost_meter": meter})

    resp = await lang.complete("ignored")
    assert resp.content == "hello"
    assert resp.trace_id is not None
    assert resp.cost is not None
    assert resp.cost.total == pytest.approx((10 / 1000) * 1.0 + (5 / 1000) * 2.0)


@pytest.mark.asyncio
async def test_langfn_stream_unified_events():
    model = MockChatModel(responses=["abc"])
    lang = LangFn(model=model)
    events = [e async for e in lang.stream("ignored")]
    assert events[0].type == "content"
    assert events[-1].type == "end"
    assert all(e.trace_id is not None for e in events)

