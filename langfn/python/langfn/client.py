from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, AsyncIterator, Dict, List, Optional, Sequence, TypeVar, Union, cast
from uuid import uuid4

from pydantic import BaseModel

from .core.errors import AbortError, LangFnError, TimeoutError, TraceNotFoundError, UnsupportedProviderError, ValidationError
from .core.types import (
    BatchError,
    BatchRequest,
    BatchResult,
    ChatRequest,
    ChatResponse,
    CompletionRequest,
    CompletionResponse,
    ContentEvent,
    EndEvent,
    ErrorEvent,
    FeedbackRequest,
    StreamEvent,
    ToolSpec,
    TraceQuery,
)
from .models import (
    AnthropicChatModel,
    ChatModel,
    CustomChatModel,
    GoogleChatModel,
    MistralChatModel,
    MockChatModel,
    OllamaChatModel,
    OpenAIChatModel,
)
from .observability.budgets import Budgets
from .observability.cost_meter import CostMeter
from .observability.span_types import SPAN_TYPES
from .observability.tracer import Tracer
from .observability.redaction import redact
from .observability.storage import TraceStorage
from .streaming.sse import normalize_stream, to_sse
from .structured.output import StructuredOutput
from .utils.cancel import CancellationToken
from .utils.concurrency import gather_with_concurrency
from .utils.retry import RetryConfig, retry_async

try:
    from .tools.base import Tool
except Exception:  # pragma: no cover
    Tool = Any  # type: ignore

TModel = TypeVar("TModel", bound=BaseModel)

if TYPE_CHECKING:
    from .observability.storage import TraceStorage


@dataclass(frozen=True)
class ObservabilityConfig:
    enabled: bool = False
    tracer: Optional[Tracer] = None
    cost_meter: Optional[CostMeter] = None
    budgets: Optional[Budgets] = None
    trace_storage: Optional["TraceStorage"] = None
    watchfn: Optional[Any] = None
    exporter: Optional[Any] = None
    otlp_exporter: Optional[Any] = None
    redaction_keys: Optional[list[str]] = None


class LangFn:
    def __init__(
        self,
        *,
        model: Optional[Union[ChatModel, str]] = None,
        observability: Optional[Union[ObservabilityConfig, dict[str, Any]]] = None,
        cache: Optional[Any] = None,
        security: Optional[Any] = None,
        retry: Optional[RetryConfig] = None,
        rate_limit: Optional[Any] = None,
        retriever: Optional[Any] = None,
        **provider_config: Any,
    ):
        self._model = self._coerce_model(model, **provider_config) if model is not None else None
        self._cache = cache
        self._security = security
        self._default_retry = retry
        self._rate_limit = rate_limit
        self._retriever = retriever
        self._embeddings = None
        self._observability = _normalize_observability(observability)
        self._tracer: Optional[Tracer] = None

    def with_model(self, provider: Union[ChatModel, str], **provider_config: Any) -> "LangFn":
        return LangFn(
            model=self._coerce_model(provider, **provider_config),
            observability=self._observability,
            cache=self._cache,
            security=self._security,
            retry=self._default_retry,
            rate_limit=self._rate_limit,
            retriever=self._retriever,
        )

    async def complete(
        self,
        prompt: str,
        *,
        timeout: Optional[float] = None,
        cancel_token: Optional[CancellationToken] = None,
        structured_output: Optional[StructuredOutput[TModel]] = None,
        metadata: Optional[dict[str, Any]] = None,
        retry: Optional[RetryConfig] = None,
    ) -> CompletionResponse:
        if not prompt:
            raise ValidationError("complete() requires a non-empty prompt")

        request = CompletionRequest(prompt=prompt, metadata=metadata or {})
        trace_id = str(uuid4())
        return await self._run_completion(
            request,
            timeout=timeout,
            cancel_token=cancel_token,
            structured_output=structured_output,
            retry=retry,
            trace_id=trace_id,
        )

    async def chat(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        timeout: Optional[float] = None,
        cancel_token: Optional[CancellationToken] = None,
        structured_output: Optional[StructuredOutput[TModel]] = None,
        metadata: Optional[dict[str, Any]] = None,
        retry: Optional[RetryConfig] = None,
        tools: Optional[Sequence[Any]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
    ) -> ChatResponse:
        if not messages:
            raise ValidationError("chat() requires at least one message")

        request = ChatRequest(
            messages=[dict(message) for message in messages],
            metadata=metadata or {},
            tools=[_tool_to_spec(tool) for tool in (tools or [])] or None,
            tool_choice=tool_choice,
        )
        trace_id = str(uuid4())
        return await self._run_chat(
            request,
            timeout=timeout,
            cancel_token=cancel_token,
            structured_output=structured_output,
            retry=retry,
            trace_id=trace_id,
        )

    async def stream(
        self,
        input: Union[str, Sequence[dict[str, Any]]],
        *,
        timeout: Optional[float] = None,
        cancel_token: Optional[CancellationToken] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> AsyncIterator[StreamEvent]:
        model = self._require_model()
        trace_id = str(uuid4())
        tracer = self._resolve_tracer()
        span_cm = tracer.span(
            SPAN_TYPES["PROVIDER_STREAM"],
            {"mode": "chat" if not isinstance(input, str) else "completion", "metadata": metadata or {}},
            trace_id=trace_id,
        ) if self._observability.enabled and tracer is not None else None
        streamed_content: list[str] = []
        latest_usage = None

        async with span_cm if span_cm is not None else _null_async_context():
            try:
                if isinstance(input, str):
                    request = CompletionRequest(prompt=input, metadata=metadata or {})
                    async for event in normalize_stream(
                        _aiter_with_timeout_and_cancel(
                            model.stream(request),
                            timeout=timeout,
                            cancel_token=cancel_token,
                        ),
                        trace_id,
                    ):
                        if event.type == "content":
                            streamed_content.append(event.delta)
                        elif event.type == "token_usage":
                            latest_usage = {
                                "prompt_tokens": event.prompt_tokens,
                                "completion_tokens": event.completion_tokens,
                            }
                        yield event
                else:
                    response = self._finalize_chat(
                        await retry_async(
                            lambda: _call_with_timeout_and_cancel(
                                model.chat(ChatRequest(messages=list(input), metadata=metadata or {})),
                                timeout=timeout,
                                cancel_token=cancel_token,
                            ),
                            config=self._default_retry or RetryConfig(max_attempts=1),
                        ),
                        structured_output=None,
                        trace_id=trace_id,
                    )
                    async def _response_stream():
                        yield ContentEvent(content=response.message.content, delta=response.message.content)
                        if response.usage is not None:
                            yield {
                                "type": "token_usage",
                                "prompt_tokens": response.usage.prompt_tokens,
                                "completion_tokens": response.usage.completion_tokens,
                            }
                        yield EndEvent(finish_reason="stop")

                    async for event in normalize_stream(_response_stream(), trace_id):
                        if event.type == "content":
                            streamed_content.append(event.delta)
                        elif event.type == "token_usage":
                            latest_usage = {
                                "prompt_tokens": event.prompt_tokens,
                                "completion_tokens": event.completion_tokens,
                            }
                        yield event

                usage = None
                if latest_usage is not None:
                    usage = response.usage if "response" in locals() and response.usage is not None else None
                    if usage is None:
                        from .core.types import TokenUsage
                        usage = TokenUsage.from_counts(
                            prompt_tokens=int(latest_usage["prompt_tokens"]),
                            completion_tokens=int(latest_usage["completion_tokens"]),
                        )

                await self._persist_trace(
                    CompletionResponse(
                        content="".join(streamed_content),
                        usage=usage,
                        cost=self._attach_cost(usage),
                        trace_id=trace_id,
                    ),
                    trace_id=trace_id,
                    kind="stream_chat" if not isinstance(input, str) else "stream_completion",
                    request_payload={"messages": list(input)} if not isinstance(input, str) else {"prompt": input},
                    metadata=metadata or {},
                )
            except LangFnError as exc:
                yield ErrorEvent(error={"code": exc.code, "message": str(exc)}, trace_id=trace_id)
            except Exception as exc:
                normalized = LangFnError(str(exc), code="UNKNOWN")
                yield ErrorEvent(error={"code": normalized.code, "message": str(normalized)}, trace_id=trace_id)

    async def stream_sse(
        self,
        input: Union[str, Sequence[dict[str, Any]]],
        *,
        timeout: Optional[float] = None,
        cancel_token: Optional[CancellationToken] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> AsyncIterator[str]:
        if isinstance(input, str):
            async for chunk in to_sse(self, input):
                yield chunk
            return

        async for event in self.stream(input, timeout=timeout, cancel_token=cancel_token, metadata=metadata):
            from .streaming.sse import to_sse_frame
            yield to_sse_frame(event)

    async def complete_batch(
        self,
        requests: Sequence[Union[BatchRequest, str]],
        *,
        concurrency: int = 5,
        timeout: Optional[float] = None,
        partial_results: bool = True,
        retry: Optional[RetryConfig] = None,
    ) -> List[BatchResult]:
        if not requests:
            return []
        if concurrency < 1:
            raise ValidationError("complete_batch() requires concurrency >= 1")

        normalized = [
            request if isinstance(request, BatchRequest) else BatchRequest(prompt=request)
            for request in requests
        ]

        async def _one(index: int, request: BatchRequest) -> CompletionResponse:
            return await self.complete(
                request.prompt,
                timeout=timeout,
                metadata=request.metadata,
                retry=retry,
            )

        outcomes = await gather_with_concurrency(
            concurrency,
            [_one(index, request) for index, request in enumerate(normalized)],
        )

        results: List[BatchResult] = []
        first_error: Optional[Exception] = None
        for index, outcome in enumerate(outcomes):
            if isinstance(outcome, Exception):
                if first_error is None:
                    first_error = outcome
                error = _coerce_error(outcome)
                results.append(
                    BatchResult(
                        ok=False,
                        index=index,
                        trace_id=None,
                        error=BatchError(code=error.code, message=str(error)),
                    )
                )
                continue

            results.append(
                BatchResult(
                    ok=True,
                    index=index,
                    content=outcome.content,
                    trace_id=outcome.trace_id,
                    response=outcome,
                )
            )

        if first_error is not None and not partial_results:
            raise _coerce_error(first_error)
        return results

    async def embed(self, texts: Union[str, List[str]]) -> Union[List[float], List[List[float]]]:
        model = self._require_model()
        if self._embeddings is None:
            from .models.openai import OpenAIChatModel
            from .rag.openai import OpenAIEmbeddings

            if isinstance(model, OpenAIChatModel):
                self._embeddings = OpenAIEmbeddings(api_key=model.api_key)
            else:
                raise ValidationError("embed() requires OpenAI embeddings or a configured embeddings provider")

        if isinstance(texts, str):
            return await self._embeddings.embed_query(texts)
        return await self._embeddings.embed_documents(texts)

    async def feedback(
        self,
        request: Optional[FeedbackRequest] = None,
        *,
        trace_id: Optional[str] = None,
        rating: Optional[float] = None,
        comment: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if request is None and (not trace_id or rating is None):
            raise ValidationError("feedback() requires trace_id")
        try:
            payload = request or FeedbackRequest.model_validate(
                {
                    "trace_id": trace_id,
                    "client_key": (metadata or {}).get("client_key"),
                    "rating": rating,
                    "comment": comment,
                    "metadata": metadata or {},
                }
            )
        except Exception as exc:
            raise ValidationError("feedback() requires trace_id and rating") from exc

        storage = self._observability.trace_storage
        record = self._redact_observability_payload(
            {
                "trace_id": payload.trace_id,
                "client_key": payload.client_key,
                "rating": payload.rating,
                "comment": payload.comment,
                "metadata": payload.metadata,
            }
        )
        if storage is not None and hasattr(storage, "save_feedback"):
            await storage.save_feedback(record)
        elif storage is not None and hasattr(storage, "find_one"):
            if await storage.find_one(payload.trace_id) is None:
                raise TraceNotFoundError(metadata={"trace_id": payload.trace_id})
        tracer = self._resolve_tracer()
        if tracer is not None:
            await tracer.emit("feedback", record)

    async def get_traces(
        self,
        query: Optional[TraceQuery] = None,
        *,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        resolved = query or TraceQuery(limit=limit or 10)
        storage = self._observability.trace_storage
        if storage is None:
            return []
        return await storage.find_many(
            limit=resolved.limit,
            model=resolved.model,
            provider=resolved.provider,
        )

    def create_tool_agent(self, tools: Optional[Sequence[Any]] = None, **config: Any):
        from .agents.tool_agent import ToolAgent

        return ToolAgent(lang=self, tools=list(tools or config.get("tools") or []), max_iterations=config.get("max_iterations", 5))

    def create_react_agent(self, tools: Optional[Sequence[Any]] = None, **config: Any):
        from .agents.react import ReActAgent

        kwargs = {
            "model": self,
            "tools": list(tools or config.get("tools") or []),
            "max_iterations": config.get("max_iterations", 10),
        }
        system_prompt = config.get("system_prompt")
        if system_prompt:
            kwargs["system_prompt"] = system_prompt
        return ReActAgent(**kwargs)

    def create_plan_execute_agent(self, **_config: Any):
        from .agents.plan_execute import PlanExecuteAgent

        return PlanExecuteAgent(
            lang=self,
            planner=_config.get("planner"),
            executor=_config.get("executor"),
            max_plan_steps=_config.get("max_plan_steps", 10),
            max_execution_steps=_config.get("max_execution_steps"),
        )

    def create_prompt_registry(self, config: Any):
        from .prompts.registry import PromptRegistry

        db = config.get("db") if isinstance(config, dict) else config
        return PromptRegistry(db=db)

    def create_rag_chain(self, **_config: Any):
        from .rag.base import RetrievalChain

        return RetrievalChain(
            retriever=_config["retriever"],
            generator=_config.get("generator"),
            lang=self,
        )

    async def _run_completion(
        self,
        request: CompletionRequest,
        *,
        timeout: Optional[float],
        cancel_token: Optional[CancellationToken],
        structured_output: Optional[StructuredOutput[TModel]],
        retry: Optional[RetryConfig],
        trace_id: str,
    ) -> CompletionResponse:
        async def execute() -> CompletionResponse:
            model = self._require_model()
            cached = await self._cache_get(request)
            if cached is not None:
                return self._finalize_completion(cached, structured_output=structured_output, trace_id=trace_id)

            try:
                raw = await _call_with_timeout_and_cancel(
                    model.complete(request),
                    timeout=timeout,
                    cancel_token=cancel_token,
                )
            except asyncio.CancelledError as exc:
                raise AbortError() from exc
            except asyncio.TimeoutError as exc:
                raise TimeoutError(metadata={"timeout": timeout}) from exc
            except LangFnError:
                raise
            except Exception as exc:
                raise LangFnError(str(exc), code="UNKNOWN") from exc

            finalized = self._finalize_completion(raw, structured_output=structured_output, trace_id=trace_id)
            await self._cache_set(request, finalized)
            await self._persist_trace(
                finalized,
                trace_id=trace_id,
                kind="completion",
                request_payload={"prompt": request.prompt},
                metadata=request.metadata,
            )
            return finalized

        return await self._run_with_observability(
            kind="completion",
            trace_id=trace_id,
            metadata=request.metadata,
            fn=lambda: retry_async(execute, config=retry or self._default_retry or RetryConfig(max_attempts=1)),
        )

    async def _run_chat(
        self,
        request: ChatRequest,
        *,
        timeout: Optional[float],
        cancel_token: Optional[CancellationToken],
        structured_output: Optional[StructuredOutput[TModel]],
        retry: Optional[RetryConfig],
        trace_id: str,
    ) -> ChatResponse:
        async def execute() -> ChatResponse:
            model = self._require_model()
            try:
                raw = await _call_with_timeout_and_cancel(
                    model.chat(request),
                    timeout=timeout,
                    cancel_token=cancel_token,
                )
            except asyncio.CancelledError as exc:
                raise AbortError() from exc
            except asyncio.TimeoutError as exc:
                raise TimeoutError(metadata={"timeout": timeout}) from exc
            except LangFnError:
                raise
            except Exception as exc:
                raise LangFnError(str(exc), code="UNKNOWN") from exc

            finalized = self._finalize_chat(raw, structured_output=structured_output, trace_id=trace_id)
            await self._persist_trace(
                finalized,
                trace_id=trace_id,
                kind="chat",
                request_payload={"messages": request.messages},
                metadata=request.metadata,
            )
            return finalized

        return await self._run_with_observability(
            kind="chat",
            trace_id=trace_id,
            metadata=request.metadata,
            fn=lambda: retry_async(execute, config=retry or self._default_retry or RetryConfig(max_attempts=1)),
        )

    async def _run_with_observability(self, *, kind: str, trace_id: str, metadata: Dict[str, Any], fn):
        tracer = self._resolve_tracer()
        if not self._observability.enabled or tracer is None:
            return await fn()

        async with tracer.span(
            SPAN_TYPES["PROVIDER_CALL"],
            {"kind": kind, "metadata": metadata},
            trace_id=trace_id,
        ):
            return await fn()

    def _finalize_completion(
        self,
        response: CompletionResponse,
        *,
        structured_output: Optional[StructuredOutput[TModel]],
        trace_id: str,
    ) -> CompletionResponse:
        finalized = response.model_copy(update={"trace_id": trace_id})
        finalized = self._attach_cost_to_completion(finalized)
        self._enforce_budgets(finalized.cost)
        if structured_output is not None:
            finalized = finalized.model_copy(update={"parsed": structured_output.parse(finalized.content)})
        return finalized

    def _finalize_chat(
        self,
        response: ChatResponse,
        *,
        structured_output: Optional[StructuredOutput[TModel]],
        trace_id: str,
    ) -> ChatResponse:
        finalized = response.model_copy(update={"trace_id": trace_id})
        finalized = self._attach_cost_to_chat(finalized)
        self._enforce_budgets(finalized.cost)
        if structured_output is not None:
            finalized = finalized.model_copy(update={"parsed": structured_output.parse(finalized.message.content)})
        return finalized

    async def _persist_trace(
        self,
        response: Union[CompletionResponse, ChatResponse],
        *,
        trace_id: Optional[str] = None,
        kind: str = "invocation",
        request_payload: Optional[Dict[str, Any]] = None,
        response_payload: Optional[Union[CompletionResponse, ChatResponse]] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        storage = self._observability.trace_storage
        model = self._model
        tracer = self._resolve_tracer()
        if model is None:
            return

        response_to_store = response_payload or response
        content = response_to_store.content if isinstance(response_to_store, CompletionResponse) else response_to_store.message.content
        record = self._redact_observability_payload(
            {
                "trace_id": trace_id or response_to_store.trace_id,
                "kind": kind,
                "provider": model.provider,
                "model": model.model,
                "input": _dump_jsonish(request_payload or {}),
                "output": content,
                "usage": response_to_store.usage.model_dump() if response_to_store.usage is not None else None,
                "cost": response_to_store.cost.model_dump() if response_to_store.cost is not None else None,
                "metadata": metadata or {},
            }
        )
        if storage is not None:
            await storage.save_trace(record) if hasattr(storage, "save_trace") else await storage.save(record)
        if tracer is not None:
            await tracer.emit("trace", record)

    async def _cache_get(self, request: CompletionRequest) -> Optional[CompletionResponse]:
        if self._cache is None:
            return None
        model = self._require_model()
        cached = await self._cache.get(request.prompt, model.model, model.provider, request.metadata)
        if cached is None:
            return None
        return cached if isinstance(cached, CompletionResponse) else CompletionResponse(**cached)

    async def _cache_set(self, request: CompletionRequest, response: CompletionResponse) -> None:
        if self._cache is None:
            return
        model = self._require_model()
        await self._cache.set(request.prompt, model.model, model.provider, response.model_dump(), request.metadata)

    def _attach_trace(self, event: StreamEvent, trace_id: str) -> StreamEvent:
        if hasattr(event, "model_copy"):
            return event.model_copy(update={"trace_id": trace_id})
        if isinstance(event, dict):
            kind = event.get("type")
            if kind == "content":
                return ContentEvent(
                    content=str(event.get("content", "")),
                    delta=str(event.get("delta", event.get("content", ""))),
                    trace_id=trace_id,
                )
            if kind == "end":
                return EndEvent(
                    finish_reason=str(event.get("finish_reason", "stop")),
                    trace_id=trace_id,
                )
        raise ValidationError("stream() yielded an unsupported event shape")

    def _attach_cost_to_completion(self, response: CompletionResponse) -> CompletionResponse:
        model = self._model
        meter = self._observability.cost_meter
        if meter is None or response.usage is None or model is None:
            return response
        cost = meter.estimate(provider=model.provider, model=model.model, usage=response.usage)
        return response.model_copy(update={"cost": cost})

    def _attach_cost_to_chat(self, response: ChatResponse) -> ChatResponse:
        model = self._model
        meter = self._observability.cost_meter
        if meter is None or response.usage is None or model is None:
            return response
        cost = meter.estimate(provider=model.provider, model=model.model, usage=response.usage)
        return response.model_copy(update={"cost": cost})

    def _attach_cost(self, usage):
        model = self._model
        meter = self._observability.cost_meter
        if meter is None or usage is None or model is None:
            return None
        return meter.estimate(provider=model.provider, model=model.model, usage=usage)

    def _enforce_budgets(self, cost) -> None:
        budgets = self._observability.budgets
        if budgets is None or cost is None:
            return
        if budgets.per_request_usd is not None and cost.total > budgets.per_request_usd:
            raise LangFnError(
                "Budget exceeded",
                code="BUDGET_EXCEEDED",
                metadata={"budget_per_request_usd": budgets.per_request_usd, "cost": cost.model_dump()},
            )

    def _require_model(self) -> ChatModel:
        if self._model is None:
            raise ValidationError("LangFn requires a model. Use LangFn(model=...) or with_model(...).")
        return self._model

    def _coerce_model(self, provider: Union[ChatModel, str], **config: Any) -> ChatModel:
        if isinstance(provider, ChatModel):
            return provider
        if not isinstance(provider, str):
            raise ValidationError("model must be a ChatModel instance or provider name")
        return _build_model(provider, **config)

    def _resolve_tracer(self) -> Optional[Tracer]:
        if not self._observability.enabled:
            return None
        if self._tracer is None:
            self._tracer = self._observability.tracer or Tracer(
                watch=self._observability.watchfn,
                storage=self._observability.trace_storage,
                exporter=self._observability.exporter,
                otlp_exporter=self._observability.otlp_exporter,
                redaction_keys=self._observability.redaction_keys or [],
            )
        return self._tracer

    def _redact_observability_payload(self, payload: Any) -> Any:
        tracer = self._resolve_tracer()
        if tracer is not None:
            return tracer.sanitize(payload)
        return redact(payload, keys=self._observability.redaction_keys or [])


def _normalize_observability(
    observability: Optional[Union[ObservabilityConfig, dict[str, Any]]],
) -> ObservabilityConfig:
    if isinstance(observability, ObservabilityConfig):
        return observability
    if isinstance(observability, dict):
        return ObservabilityConfig(
            enabled=bool(observability.get("enabled", False)),
            tracer=cast(Optional[Tracer], observability.get("tracer")),
            cost_meter=cast(Optional[CostMeter], observability.get("cost_meter")),
            budgets=cast(Optional[Budgets], observability.get("budgets")),
            trace_storage=cast(Optional[Any], observability.get("trace_storage")),
            watchfn=observability.get("watchfn"),
            exporter=observability.get("exporter"),
            otlp_exporter=observability.get("otlp_exporter"),
            redaction_keys=cast(Optional[list[str]], observability.get("redaction_keys")),
        )
    return ObservabilityConfig()


def _build_model(provider: str, **config: Any) -> ChatModel:
    if provider == "openai":
        return OpenAIChatModel(**config)
    if provider == "anthropic":
        return AnthropicChatModel(**config)
    if provider == "ollama":
        return OllamaChatModel(**config)
    if provider == "google":
        return GoogleChatModel(**config)
    if provider == "mistral":
        return MistralChatModel(**config)
    if provider == "mock":
        return MockChatModel(**config)
    if provider == "custom":
        return CustomChatModel(**config)
    raise UnsupportedProviderError(provider)


def _tool_to_spec(tool: Any) -> ToolSpec:
    if isinstance(tool, ToolSpec):
        return tool
    if hasattr(tool, "json_schema"):
        schema = tool.json_schema()
        return ToolSpec(
            name=schema.get("name") or getattr(tool, "name", ""),
            description=schema.get("description") or getattr(tool, "description", ""),
            input_schema=schema.get("parameters") or schema.get("input_schema") or {},
        )
    return ToolSpec(
        name=str(getattr(tool, "name", "")),
        description=str(getattr(tool, "description", "")),
        input_schema=dict(getattr(tool, "input_schema", {}) or {}),
    )


def _coerce_error(exc: Exception) -> LangFnError:
    if isinstance(exc, LangFnError):
        return exc
    return LangFnError(str(exc), code="UNKNOWN")


async def _call_with_timeout(awaitable, *, timeout: Optional[float]):
    if timeout is None:
        return await awaitable
    return await asyncio.wait_for(awaitable, timeout=timeout)


async def _call_with_timeout_and_cancel(awaitable, *, timeout: Optional[float], cancel_token: Optional[CancellationToken]):
    if cancel_token is not None and cancel_token.cancelled:
        raise AbortError()
    if cancel_token is None:
        return await _call_with_timeout(awaitable, timeout=timeout)

    task = asyncio.create_task(_call_with_timeout(awaitable, timeout=timeout))
    cancel_task = asyncio.create_task(cancel_token.wait())
    done, pending = await asyncio.wait({task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
    for pending_task in pending:
        pending_task.cancel()

    if cancel_task in done:
        task.cancel()
        raise AbortError()
    return await task


async def _aiter_with_timeout_and_cancel(
    aiter: AsyncIterator[StreamEvent],
    *,
    timeout: Optional[float],
    cancel_token: Optional[CancellationToken],
) -> AsyncIterator[StreamEvent]:
    while True:
        next_item = aiter.__anext__()
        if cancel_token is None:
            try:
                item = await _call_with_timeout(next_item, timeout=timeout)
            except StopAsyncIteration:
                return
            except asyncio.TimeoutError as exc:
                raise TimeoutError(metadata={"timeout": timeout}) from exc
            yield item
            continue

        stream_task = asyncio.create_task(_call_with_timeout(next_item, timeout=timeout))
        cancel_task = asyncio.create_task(cancel_token.wait())
        done, pending = await asyncio.wait({stream_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
        for pending_task in pending:
            pending_task.cancel()

        if cancel_task in done:
            stream_task.cancel()
            raise AbortError()

        try:
            yield await stream_task
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError as exc:
            raise TimeoutError(metadata={"timeout": timeout}) from exc


@asynccontextmanager
async def _null_async_context():
    yield


def _dump_jsonish(value: Any) -> str:
    if value is None:
        return "{}"
    if hasattr(value, "model_dump"):
        return str(value.model_dump())
    return str(value)
