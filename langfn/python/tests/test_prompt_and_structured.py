import pytest
from pydantic import BaseModel

from langfn import LangFn
from langfn.models import MockChatModel
from langfn.structured import StructuredOutput


class Out(BaseModel):
    sentiment: str
    confidence: float


@pytest.mark.asyncio
async def test_structured_output_extracts_json():
    model = MockChatModel(responses=["prefix {\"sentiment\":\"pos\",\"confidence\":0.9} suffix"])
    lang = LangFn(model=model)
    resp = await lang.complete("ignored", structured_output=StructuredOutput(schema=Out))
    assert resp.parsed.sentiment == "pos"
    assert resp.parsed.confidence == 0.9


@pytest.mark.asyncio
async def test_complete_batch_partial_results():
    model = MockChatModel(responses=["a", "b", "c"])
    lang = LangFn(model=model)
    results = await lang.complete_batch(["p1", "p2", "p3"], concurrency=2)
    assert [r.content for r in results if not isinstance(r, Exception)] == ["a", "b", "c"]

