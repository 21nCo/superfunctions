import pytest

from langfn.evaluation import DatasetItem, Evaluator
from langfn.graph import StateGraph
from langfn.models import MockChatModel
from langfn.observability import Tracer
from langfn.observability.span_types import SPAN_TYPES
from langfn import LangFn


@pytest.mark.asyncio
async def test_state_graph_conditional_edges():
    graph = StateGraph(initial_state={"value": 0, "next": "inc"})

    async def inc(state):
        return {**state, "value": state["value"] + 1, "next": "end" if state["value"] >= 0 else "inc"}

    graph.add_node("agent", inc)
    graph.add_conditional_edge("agent", lambda s: "__end__" if s["next"] == "end" else "agent")
    graph.set_entry_point("agent")
    app = graph.compile()

    result = await app.invoke()
    assert result["value"] == 1


@pytest.mark.asyncio
async def test_evaluator_exact_match():
    model = MockChatModel(responses=["4", "Paris"])
    lang = LangFn(model=model)
    evaluator = Evaluator(lang=lang)
    res = await evaluator.run(
        [
            DatasetItem(input="2+2?", expected="4"),
            DatasetItem(input="capital?", expected="Paris"),
        ]
    )
    assert res.pass_rate == 1.0
    assert res.avg_score == 1.0


@pytest.mark.asyncio
async def test_tracer_redacts_metadata_and_exports():
    class Exporter:
        def __init__(self):
            self.events = []

        async def export(self, name, metadata=None):
            self.events.append((name, metadata or {}))

    exporter = Exporter()
    tracer = Tracer(exporter=exporter, redaction_keys=["api_key"])
    model = MockChatModel(responses=["ok"])
    lang = LangFn(model=model, observability={"enabled": True, "tracer": tracer})

    await lang.complete("x", metadata={"api_key": "secret", "other": 1})
    assert exporter.events[0][0] == SPAN_TYPES["PROVIDER_CALL"]
    assert exporter.events[0][1]["metadata"]["api_key"] == "***REDACTED***"
    assert exporter.events[0][1]["metadata"]["other"] == 1
