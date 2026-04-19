import asyncio

import pytest

from langfn import LangFn
from langfn.core.errors import RateLimitError, UnsupportedProviderError, ValidationError
from langfn.core.types import CompletionResponse
from langfn.models import MockChatModel
from langfn.observability import CostMeter
from langfn.observability.cost_meter import Price
from langfn.structured.output import StructuredOutput
from langfn.utils import RetryConfig
from pydantic import BaseModel


class SentimentPayload(BaseModel):
    sentiment: str
    confidence: float


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


@pytest.mark.asyncio
async def test_langfn_complete_supports_structured_output():
    lang = LangFn(model=MockChatModel(responses=['{"sentiment":"positive","confidence":0.9}']))

    resp = await lang.complete(
        "Return JSON",
        structured_output=StructuredOutput(SentimentPayload),
    )

    assert resp.trace_id is not None
    assert resp.parsed is not None
    assert resp.parsed.sentiment == "positive"
    assert resp.parsed.confidence == pytest.approx(0.9)


@pytest.mark.asyncio
async def test_langfn_factory_supports_first_party_and_custom_providers():
    providers = [
        ("openai", {}),
        ("anthropic", {}),
        ("ollama", {}),
        ("google", {}),
        ("mistral", {}),
    ]

    for provider, config in providers:
        lang = LangFn().with_model(provider, **config)
        assert lang._require_model().provider == provider

    custom = LangFn().with_model(
        "custom",
        complete_handler=lambda request: asyncio.sleep(0, result=CompletionResponse(content=f"custom:{request.prompt}")),
    )
    resp = await custom.complete("ping")
    assert resp.content == "custom:ping"


@pytest.mark.asyncio
async def test_langfn_invalid_provider_and_inputs_raise_canonical_errors():
    with pytest.raises(UnsupportedProviderError):
        LangFn().with_model("bogus")

    lang = LangFn(model=MockChatModel())

    with pytest.raises(ValidationError) as chat_error:
        await lang.chat([])
    assert chat_error.value.code == "VALIDATION_ERROR"

    with pytest.raises(ValidationError) as feedback_error:
        await lang.feedback(rating=1.0)
    assert feedback_error.value.code == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_langfn_complete_batch_preserves_order_and_partial_failures():
    attempts = {"a": 0}

    async def complete_handler(request):
        if request.prompt == "a":
            attempts["a"] += 1
            if attempts["a"] == 1:
                raise RateLimitError(retry_after=0.0)
            return CompletionResponse(content="a")
        if request.prompt == "b":
            await asyncio.sleep(0.05)
            return CompletionResponse(content="b")
        return CompletionResponse(content="c")

    lang = LangFn(model=MockChatModel(complete_handler=complete_handler))
    results = await lang.complete_batch(
        ["a", "b", "c"],
        timeout=0.01,
        partial_results=True,
        retry=RetryConfig(max_attempts=2, base_delay_s=0.0, max_delay_s=0.0),
    )

    assert [result.index for result in results] == [0, 1, 2]
    assert results[0].ok is True
    assert results[0].content == "a"
    assert results[1].ok is False
    assert results[1].error is not None
    assert results[1].error.code == "PROVIDER_TIMEOUT"
    assert results[2].ok is True
    assert results[2].content == "c"

    with pytest.raises(Exception) as batch_error:
        await lang.complete_batch(
            ["b"],
            timeout=0.01,
            partial_results=False,
            retry=RetryConfig(max_attempts=1, base_delay_s=0.0, max_delay_s=0.0),
        )
    assert getattr(batch_error.value, "code", None) == "PROVIDER_TIMEOUT"
