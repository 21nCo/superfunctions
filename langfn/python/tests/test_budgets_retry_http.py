import asyncio
import json
from typing import Any, Dict

import pytest
from superfunctions.http import RouteContext
from superfunctions.db import CreateParams, FindManyParams, FindOneParams

from langfn import LangFn
from langfn.core.errors import (
    LangFnError,
    NotConfiguredError,
    RateLimitError,
    ToolDisabledError,
    ToolPolicyViolationError,
)
from langfn.models import MockChatModel, OpenAIChatModel
from langfn.observability import Budgets, CostMeter, TraceStorage
from langfn.observability.cost_meter import Price
from langfn.tools import (
    ApiCallTool,
    CodeExecTool,
    ToolContext,
    ToolPolicy,
    WebSearchTool,
    calculator,
    redact_sensitive_fields,
    sanitize_output,
)
from langfn.utils import RetryConfig


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
async def test_budget_enforced_when_cost_known():
    model = MockChatModel(responses=["ok"], usage={"prompt_tokens": 1000, "completion_tokens": 0})
    meter = CostMeter(prices={"mock": {"mock-1": Price(input_per_1k=1.0, output_per_1k=0.0)}})
    lang = LangFn(
        model=model,
        observability={"enabled": True, "cost_meter": meter, "budgets": Budgets(per_request_usd=0.5)},
    )

    with pytest.raises(LangFnError) as error:
        await lang.complete("ignored")
    assert error.value.code == "BUDGET_EXCEEDED"


@pytest.mark.asyncio
async def test_stream_emits_canonical_terminal_error_and_redacts_exports():
    adapter = InMemoryAdapter()
    storage = TraceStorage(adapter)

    class Watch:
        def __init__(self):
            self.events = []

        def track(self, name, payload):
            self.events.append((name, payload))

    class Exporter:
        def __init__(self):
            self.events = []

        async def export(self, name, payload=None):
            self.events.append((name, payload or {}))

    class Otlp:
        def __init__(self):
            self.events = []

        async def export(self, payload):
            self.events.append(payload)

    async def slow_stream(_request):
        await asyncio.sleep(0.05)
        yield {"type": "content", "content": "late", "delta": "late"}

    watch = Watch()
    exporter = Exporter()
    otlp = Otlp()
    lang = LangFn(
        model=MockChatModel(streams=[]),
        observability={
            "enabled": True,
            "trace_storage": storage,
            "watchfn": watch,
            "exporter": exporter,
            "otlp_exporter": otlp,
            "redaction_keys": ["api_key", "email"],
        },
    ).with_model("custom", stream_handler=slow_stream)

    events = [event async for event in lang.stream("ignored", timeout=0.01, metadata={"api_key": "secret", "email": "user@example.com"})]
    assert len(events) == 1
    assert events[0].type == "error"
    assert events[0].error["code"] == "PROVIDER_TIMEOUT"
    assert "***REDACTED***" in json.dumps(watch.events)
    assert "***REDACTED***" in json.dumps(exporter.events)
    assert "***REDACTED***" in json.dumps(otlp.events)


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


@pytest.mark.asyncio
async def test_builtin_tool_policy_and_security_helpers():
    assert calculator("2 + 2") == "4"

    with pytest.raises(ToolPolicyViolationError) as calculator_error:
        calculator("__import__('os').system('rm -rf /')")
    assert calculator_error.value.code == "TOOL_POLICY_VIOLATION"

    context = ToolContext(metadata={}, policy=ToolPolicy())
    with pytest.raises(ToolPolicyViolationError) as api_error:
        await ApiCallTool().run({"url": "http://169.254.169.254/latest/meta-data"}, context=context)
    assert api_error.value.code == "TOOL_POLICY_VIOLATION"

    with pytest.raises(ToolDisabledError) as code_error:
        await CodeExecTool().run({"code": "print('hi')"}, context=context)
    assert code_error.value.code == "TOOL_DISABLED"

    with pytest.raises(NotConfiguredError) as search_error:
        await WebSearchTool().run({"query": "langfn"}, context=context)
    assert search_error.value.code == "NOT_CONFIGURED"

    assert redact_sensitive_fields({"authorization": "Bearer secret", "ssn": "111-22-3333"}) == {
        "authorization": "***REDACTED***",
        "ssn": "***REDACTED***",
    }
    assert sanitize_output("<script>alert(1)</script>") == "safe string"

    with pytest.raises(NotConfiguredError) as secret_error:
        OpenAIChatModel(api_key_ref="OPENAI_API_KEY")._client()
    assert secret_error.value.code == "NOT_CONFIGURED"


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
    assert resp.body["ok"] is True
    assert resp.body["data"]["content"] == "hello"
