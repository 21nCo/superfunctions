import pytest
from pydantic import BaseModel

from langfn import AgentMaxIterationsError, GraphInterruptError, GraphMaxStepsError, ValidationError
from langfn.core.errors import TraceNotFoundError
from langfn.agents import MultiAgentCoordinator, PlanExecuteAgent, ReActAgent
from langfn.evaluation import DatasetItem, Evaluator, create_metric
from langfn.graph import InMemoryCheckpointStore, StateGraph
from langfn.models import MockChatModel
from langfn.observability import TraceStorage, Tracer
from langfn.observability.span_types import SPAN_TYPES
from langfn.tools import Tool, ToolContext
from langfn import LangFn
from superfunctions.db import CreateParams, FindManyParams, FindOneParams


class InMemoryAdapter:
    def __init__(self):
        self.tables = {
            "langfn_traces": [],
            "langfn_trace_spans": [],
            "langfn_trace_feedback": [],
        }

    async def create(self, params: CreateParams):
        self.tables[params.model].append(dict(params.data))
        return dict(params.data)

    async def find_one(self, params: FindOneParams):
        for row in self.tables[params.model]:
            if all(row.get(clause.field) == clause.value for clause in params.where):
                return dict(row)
        return None

    async def find_many(self, params: FindManyParams):
        rows = [
            dict(row)
            for row in self.tables[params.model]
            if all(row.get(clause.field) == clause.value for clause in params.where)
        ]
        if params.order_by:
            field = params.order_by[0].field
            reverse = params.order_by[0].direction == "desc"
            rows.sort(key=lambda row: row.get(field, 0), reverse=reverse)
        return rows


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
async def test_state_graph_checkpoint_resume_and_max_steps():
    graph = StateGraph(initial_state={"count": 0, "done": False})

    async def increment(state):
        return {**state, "count": state["count"] + 1}

    async def decide(state):
        return {**state, "done": True}

    graph.add_node("increment", increment)
    graph.add_node("decide", decide)
    graph.add_edge("increment", "decide")
    graph.add_conditional_edge("decide", lambda state: "__end__" if state["done"] else "increment")
    graph.add_interrupt("increment")
    graph.set_entry_point("increment")
    app = graph.compile()
    store = InMemoryCheckpointStore()

    with pytest.raises(GraphInterruptError) as interrupted:
        await app.invoke(checkpoint_store=store)
    checkpoint_id = interrupted.value.metadata["checkpoint_id"]
    resumed = await app.resume(checkpoint_id, checkpoint_store=store, max_steps=3)
    assert resumed["count"] == 1
    assert resumed["done"] is True

    looping = StateGraph(initial_state={"count": 0})
    looping.add_node("loop", lambda state: _async({**state, "count": state["count"] + 1}))
    looping.add_edge("loop", "loop")
    looping.set_entry_point("loop")
    with pytest.raises(GraphMaxStepsError) as overflow:
        await looping.compile().invoke(max_steps=2)
    assert overflow.value.code == "GRAPH_MAX_STEPS"


class AddArgs(BaseModel):
    a: int
    b: int


async def add(args: AddArgs, _ctx: ToolContext) -> str:
    return str(args.a + args.b)


@pytest.mark.asyncio
async def test_react_agent_preserves_tool_turns_and_limits():
    calls = 0

    async def chat_handler(_request):
        nonlocal calls
        calls += 1
        if calls == 1:
            from langfn.core.types import ChatResponse, Message, ToolCall

            return ChatResponse(
                message=Message(role="assistant", content=""),
                tool_calls=[ToolCall(id="call_1", name="add", arguments={"a": 2, "b": 3})],
            )
        from langfn.core.types import ChatResponse, Message

        return ChatResponse(message=Message(role="assistant", content="5"))

    agent = ReActAgent(
        model=LangFn(model=MockChatModel(chat_handler=chat_handler)),
        tools=[Tool(name="add", description="Add", args_schema=AddArgs, execute=add)],
        max_iterations=3,
    )
    result = await agent.run("What is 2 + 3?")
    assert result.output == "5"
    assert any(message["role"] == "tool" and message["tool_call_id"] == "call_1" for message in result.messages)

    async def looping_handler(_request):
        from langfn.core.types import ChatResponse, Message, ToolCall

        return ChatResponse(
            message=Message(role="assistant", content=""),
            tool_calls=[ToolCall(id="call_1", name="add", arguments={"a": 2, "b": 3})],
        )

    limited = ReActAgent(
        model=LangFn(model=MockChatModel(chat_handler=looping_handler)),
        tools=[Tool(name="add", description="Add", args_schema=AddArgs, execute=add)],
        max_iterations=1,
    )
    with pytest.raises(AgentMaxIterationsError) as error:
        await limited.run("What is 2 + 3?")
    assert error.value.code == "AGENT_MAX_ITERATIONS"


@pytest.mark.asyncio
async def test_plan_execute_and_multi_agent_coordination():
    planner = PlanExecuteAgent(
        planner=lambda _goal: _async(["summarize doc 1", "summarize doc 2", "compare summaries"]),
        executor=lambda step, _ctx: _async(f"done:{step}"),
        max_plan_steps=5,
        max_execution_steps=5,
    )
    result = await planner.run("Summarize two documents and compare them")
    assert result.plan == ["summarize doc 1", "summarize doc 2", "compare summaries"]
    assert "done:compare summaries" in result.output

    async def coordinator(_task, context):
        if len(context["decisions"]) == 0:
            return "researcher"
        if len(context["decisions"]) == 1:
            return "writer"
        return "__end__"

    class EchoAgent:
        def __init__(self, prefix: str):
            self.prefix = prefix

        async def run(self, task: str):
            return f"{self.prefix}:{task}"

    multi = MultiAgentCoordinator(
        agents={"researcher": EchoAgent("research"), "writer": EchoAgent("draft")},
        coordinator=coordinator,
        max_iterations=3,
    )
    coordinated = await multi.run("Research then draft")
    assert coordinated.decisions == ["researcher", "writer"]
    assert coordinated.output.startswith("draft:")

    empty_plan = PlanExecuteAgent(
        planner=lambda _goal: _async([]),
        executor=lambda step, _ctx: _async(step),
    )
    with pytest.raises(ValidationError) as error:
        await empty_plan.run("fail")
    assert error.value.code == "VALIDATION_ERROR"

    zero_limit = PlanExecuteAgent(
        planner=lambda _goal: _async(["step 1"]),
        executor=lambda step, _ctx: _async(step),
        max_execution_steps=0,
    )
    with pytest.raises(AgentMaxIterationsError) as zero_error:
        await zero_limit.run("blocked")
    assert zero_error.value.metadata["max_execution_steps"] == 0


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
async def test_evaluator_compare_and_testfn_export():
    exported = []
    evaluator = Evaluator()
    exact = LangFn(model=MockChatModel(responses=["4", "Paris"]))
    partial = LangFn(model=MockChatModel(responses=["4", "Lyon"]))

    result = await evaluator.compare(
        models=[
            {"name": "mockA", "lang": exact},
            {"name": "mockB", "lang": partial},
        ],
        dataset=[
            DatasetItem(input="2+2", expected="4"),
            DatasetItem(input="capital of France", expected="Paris"),
        ],
        metrics=[create_metric("exact_match", lambda predicted, expected, _item: predicted.strip() == expected.strip())],
        export_hook=lambda payload: exported.append(payload),
    )

    assert result.best_model == "mockA"
    assert result.per_model["mockA"].accuracy == 1.0
    assert result.per_model["mockB"].accuracy == 0.5
    assert result.testfn_exported is True
    assert len(exported) == 2


@pytest.mark.asyncio
async def test_evaluator_empty_dataset_is_validation_error():
    evaluator = Evaluator(lang=LangFn(model=MockChatModel()))
    with pytest.raises(ValidationError) as error:
        await evaluator.run([])
    assert error.value.code == "VALIDATION_ERROR"


@pytest.mark.asyncio
async def test_evaluator_invalid_dataset_item_is_validation_error():
    evaluator = Evaluator(lang=LangFn(model=MockChatModel()))
    with pytest.raises(ValidationError) as error:
        await evaluator.run([{"input": "missing expected"}])
    assert error.value.code == "VALIDATION_ERROR"


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
    assert exporter.events[0][1]["metadata"]["metadata"]["api_key"] == "***REDACTED***"
    assert exporter.events[0][1]["metadata"]["metadata"]["other"] == 1


@pytest.mark.asyncio
async def test_observability_persists_fresh_traces_and_idempotent_feedback():
    adapter = InMemoryAdapter()
    storage = TraceStorage(adapter)
    tracer = Tracer(storage=storage)
    lang = LangFn(
        model=MockChatModel(responses=["one", "two"]),
        observability={"enabled": True, "tracer": tracer, "trace_storage": storage},
    )

    first = await lang.complete("first")
    second = await lang.complete("second")

    assert first.trace_id != second.trace_id

    traces = await lang.get_traces()
    assert len(traces) == 2

    await lang.feedback(trace_id=second.trace_id, rating=5, metadata={"client_key": "web-1"})
    await lang.feedback(trace_id=second.trace_id, rating=5, metadata={"client_key": "web-1"})
    assert len(await storage.list_feedback(second.trace_id)) == 1

    with pytest.raises(TraceNotFoundError) as error:
        await lang.feedback(trace_id="missing-trace", rating=1)
    assert error.value.code == "TRACE_NOT_FOUND"


async def _async(value):
    return value
