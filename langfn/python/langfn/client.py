from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence, TypeVar, Union, cast
from uuid import uuid4

from pydantic import BaseModel

from .core.errors import AbortError, LangFnError, TimeoutError
from .core.types import (
    ChatRequest,
    ChatResponse,
    CompletionRequest,
    CompletionResponse,
    StreamEvent,
    ToolSpec,
)
from .models.base import ChatModel
from .observability.cost_meter import CostMeter
from .observability.budgets import Budgets
from .observability.tracer import Tracer
from .observability.span_types import SPAN_TYPES
from .structured.output import StructuredOutput
from .utils.cancel import CancellationToken
from .utils.concurrency import gather_with_concurrency
from .utils.retry import RetryConfig, retry_async
from .tools.base import Tool

TModel = TypeVar("TModel", bound=BaseModel)


@dataclass(frozen=True)
class ObservabilityConfig:
    enabled: bool = False
    tracer: Optional[Tracer] = None
    cost_meter: Optional[CostMeter] = None
    budgets: Optional[Budgets] = None


class LangFn:
    def __init__(
        self,
        *,
        model: ChatModel,
        observability: Optional[Union[ObservabilityConfig, dict[str, Any]]] = None,
    ):
        self._model = model
        self._trace_id = str(uuid4())

        if isinstance(observability, dict):
            self._observability = ObservabilityConfig(
                enabled=bool(observability.get("enabled", False)),
                tracer=cast(Optional[Tracer], observability.get("tracer")),
                cost_meter=cast(Optional[CostMeter], observability.get("cost_meter")),
                budgets=cast(Optional[Budgets], observability.get("budgets")),
            )
        else:
            self._observability = observability or ObservabilityConfig()

    def with_model(self, model: ChatModel) -> "LangFn":
        return LangFn(model=model, observability=self._observability)

    async def embed(self, texts: Union[str, List[str]]) -> Union[List[float], List[List[float]]]:
        if not hasattr(self, "_embeddings") or self._embeddings is None:
             # Try to create default embeddings if model is OpenAI
             from .rag.openai import OpenAIEmbeddings
             from .models.openai import OpenAIChatModel
             if isinstance(self._model, OpenAIChatModel):
                  self._embeddings = OpenAIEmbeddings(api_key=self._model.api_key)
             else:
                  raise LangFnError("Embeddings not configured for this client", code="NOT_CONFIGURED")
        
        if isinstance(texts, str):
             return await self._embeddings.embed_query(texts)
        return await self._embeddings.embed_documents(texts)

    async def feedback(self, trace_id: str, rating: float, comment: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> None:
        if self._observability.enabled and self._observability.tracer:
             # Logic to save feedback - currently just tracking via watchfn if available
             if self._observability.tracer._watch:
                  self._observability.tracer._watch.track("feedback", {
                       "trace_id": trace_id,
                       "rating": rating,
                       "comment": comment,
                       "metadata": metadata or {}
                  })

    async def get_traces(self, limit: int = 10) -> List[Dict[str, Any]]:
         # This would normally query the DB via @superfunctions/db
         # For now, placeholder
         return []

    def create_tool_agent(self, tools: Sequence[Tool[Any, Any]], max_iterations: int = 5):
        from .agents.tool_agent import ToolAgent
        return ToolAgent(lang=self, tools=tools, max_iterations=max_iterations)

    def create_react_agent(self, tools: Sequence[Tool[Any, Any]], max_iterations: int = 10, system_prompt: Optional[str] = None):
        from .agents.react import ReActAgent
        kwargs = {"model": self, "tools": tools, "max_iterations": max_iterations}
        if system_prompt:
            kwargs["system_prompt"] = system_prompt
        return ReActAgent(**kwargs)

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
        request = CompletionRequest(prompt=prompt, metadata=metadata or {})
        if not self._observability.enabled:
            return await self._complete_with_retry(
                request,
                timeout=timeout,
                cancel_token=cancel_token,
                structured_output=structured_output,
                retry=retry,
            )

        tracer = self._observability.tracer
        if tracer is None:
            return await self._complete_with_retry(
                request,
                timeout=timeout,
                cancel_token=cancel_token,
                structured_output=structured_output,
                retry=retry,
            )

        async with tracer.span(
            SPAN_TYPES["PROVIDER_CALL"],
            {"kind": "completion", "metadata": request.metadata},
        ):
            return await self._complete_with_retry(
                request,
                timeout=timeout,
                cancel_token=cancel_token,
                structured_output=structured_output,
                retry=retry,
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
        tools: Optional[Sequence[Tool[Any, Any]]] = None,
        tool_choice: Optional[Union[str, Dict[str, Any]]] = None,
    ) -> ChatResponse:
        request = ChatRequest(
            messages=list(messages),
            metadata=metadata or {},
            tools=[_tool_to_spec(t) for t in (tools or [])] or None,
            tool_choice=tool_choice,
        )
        if not self._observability.enabled or self._observability.tracer is None:
            return await self._chat_with_retry(
                request,
                timeout=timeout,
                cancel_token=cancel_token,
                structured_output=structured_output,
                retry=retry,
            )

        async with self._observability.tracer.span(
            SPAN_TYPES["PROVIDER_CALL"],
            {"kind": "chat", "metadata": request.metadata},
        ):
            return await self._chat_with_retry(
                request,
                timeout=timeout,
                cancel_token=cancel_token,
                structured_output=structured_output,
                retry=retry,
            )
    
    async def stream(
        self,
        prompt: str,
        *,
        timeout: Optional[float] = None,
        cancel_token: Optional[CancellationToken] = None,
        metadata: Optional[dict[str, Any]] = None,
    ):
        request = CompletionRequest(prompt=prompt, metadata=metadata or {})

        async def _iterate():
            async for event in self._model.stream(request):
                yield event

        iterator = _iterate()
        if cancel_token is not None and cancel_token.cancelled:
            raise AbortError()
        if timeout is None:
            async for event in _aiter_with_cancel(iterator, cancel_token=cancel_token):
                yield self._attach_trace(event)
            return

        try:
            async for event in _aiter_with_timeout(
                _aiter_with_cancel(iterator, cancel_token=cancel_token), timeout=timeout
            ):
                yield self._attach_trace(event)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(metadata={"timeout": timeout}) from exc

    async def stream_sse(self, prompt: str) -> AsyncIterator[str]:
        from .streaming.sse import to_sse
        async for chunk in to_sse(self, prompt):
            yield chunk

    async def complete_batch(
        self,
        prompts: Sequence[str],
        *,
        concurrency: int = 5,
        timeout: Optional[float] = None,
        partial_results: bool = True,
    ) -> List[Union[CompletionResponse, Exception]]:
        async def _one(p: str) -> CompletionResponse:
            return await self.complete(p, timeout=timeout)

        results = await gather_with_concurrency(concurrency, [_one(p) for p in prompts])
        if partial_results:
            return results

        errors = [r for r in results if isinstance(r, Exception)]
        if errors:
            raise errors[0]
        return cast(List[Union[CompletionResponse, Exception]], results)

    async def _complete_raw(
        self,
        request: CompletionRequest,
        *,
        timeout: Optional[float],
        cancel_token: Optional[CancellationToken],
        structured_output: Optional[StructuredOutput[TModel]],
    ) -> CompletionResponse:
        if cancel_token is not None and cancel_token.cancelled:
            raise AbortError()
        try:
            response = await _call_with_timeout_and_cancel(
                self._model.complete(request), timeout=timeout, cancel_token=cancel_token
            )
        except asyncio.CancelledError as exc:
            raise AbortError() from exc
        except asyncio.TimeoutError as exc:
            raise TimeoutError(metadata={"timeout": timeout}) from exc
        except LangFnError:
            raise
        except Exception as exc:
            raise LangFnError(str(exc), code="UNKNOWN") from exc

        response = response.model_copy(update={"trace_id": self._trace_id})
        response = self._attach_cost_to_completion(response)
        self._enforce_budgets(response.cost)

        if structured_output is not None:
            parsed = structured_output.parse(response.content)
            response = response.model_copy(update={"parsed": parsed})

        return response

    async def _chat_raw(
        self,
        request: ChatRequest,
        *,
        timeout: Optional[float],
        cancel_token: Optional[CancellationToken],
        structured_output: Optional[StructuredOutput[TModel]],
    ) -> ChatResponse:
        if cancel_token is not None and cancel_token.cancelled:
            raise AbortError()
        try:
            response = await _call_with_timeout_and_cancel(
                self._model.chat(request), timeout=timeout, cancel_token=cancel_token
            )
        except asyncio.CancelledError as exc:
            raise AbortError() from exc
        except asyncio.TimeoutError as exc:
            raise TimeoutError(metadata={"timeout": timeout}) from exc
        except LangFnError:
            raise
        except Exception as exc:
            raise LangFnError(str(exc), code="UNKNOWN") from exc

        response = response.model_copy(update={"trace_id": self._trace_id})
        response = self._attach_cost_to_chat(response)
        self._enforce_budgets(response.cost)

        if structured_output is not None:
            parsed = structured_output.parse(response.message.content)
            response = response.model_copy(update={"parsed": parsed})

        return response

    async def _complete_with_retry(
        self,
        request: CompletionRequest,
        *,
        timeout: Optional[float],
        cancel_token: Optional[CancellationToken],
        structured_output: Optional[StructuredOutput[TModel]],
        retry: Optional[RetryConfig],
    ) -> CompletionResponse:
        # Check cache
        cache = getattr(self, "_cache", None)
        if cache:
            cached = await cache.get(request.prompt, self._model.model, self._model.provider, request.metadata)
            if cached:
                return CompletionResponse(**cached)

        cfg = retry or RetryConfig(max_attempts=1)

        async def _one():
            return await self._complete_raw(
                request, timeout=timeout, cancel_token=cancel_token, structured_output=structured_output
            )

        response = await retry_async(_one, config=cfg)
        
        # Set cache
        if cache:
            await cache.set(request.prompt, self._model.model, self._model.provider, response.model_dump(), request.metadata)
            
        return response

    async def _chat_with_retry(
        self,
        request: ChatRequest,
        *,
        timeout: Optional[float],
        cancel_token: Optional[CancellationToken],
        structured_output: Optional[StructuredOutput[TModel]],
        retry: Optional[RetryConfig],
    ) -> ChatResponse:
        # Note: Chat caching is more complex due to message history. 
        # For v0.1 we only cache complete() as it's more straightforward.
        cfg = retry or RetryConfig(max_attempts=1)

        async def _one():
            return await self._chat_raw(
                request, timeout=timeout, cancel_token=cancel_token, structured_output=structured_output
            )

        return await retry_async(_one, config=cfg)

    def _attach_trace(self, event: StreamEvent) -> StreamEvent:
        return event.model_copy(update={"trace_id": self._trace_id})

    def _attach_cost_to_completion(self, response: CompletionResponse) -> CompletionResponse:
        meter = self._observability.cost_meter
        if meter is None or response.usage is None:
            return response
        cost = meter.estimate(provider=self._model.provider, model=self._model.model, usage=response.usage)
        return response.model_copy(update={"cost": cost})

    def _attach_cost_to_chat(self, response: ChatResponse) -> ChatResponse:
        meter = self._observability.cost_meter
        if meter is None or response.usage is None:
            return response
        cost = meter.estimate(provider=self._model.provider, model=self._model.model, usage=response.usage)
        return response.model_copy(update={"cost": cost})

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


def _tool_to_spec(tool: Tool[Any, Any]) -> ToolSpec:
    return ToolSpec(name=tool.name, description=tool.description, input_schema=tool.json_schema())


async def _call_with_timeout(awaitable, *, timeout: Optional[float]):
    if timeout is None:
        return await awaitable
    return await asyncio.wait_for(awaitable, timeout=timeout)


async def _call_with_timeout_and_cancel(awaitable, *, timeout: Optional[float], cancel_token):
    if cancel_token is None:
        return await _call_with_timeout(awaitable, timeout=timeout)

    task = asyncio.create_task(_call_with_timeout(awaitable, timeout=timeout))
    cancel_task = asyncio.create_task(cancel_token.wait())
    done, pending = await asyncio.wait({task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
    for p in pending:
        p.cancel()

    if cancel_task in done:
        task.cancel()
        raise AbortError()
    return await task


async def _aiter_with_timeout(aiter, *, timeout: float):
    while True:
        try:
            item = await asyncio.wait_for(aiter.__anext__(), timeout=timeout)
        except StopAsyncIteration:
            return
        yield item


async def _aiter_with_cancel(aiter, *, cancel_token: Optional[CancellationToken]):
    if cancel_token is None:
        async for item in aiter:
            yield item
        return

    while True:
        next_task = asyncio.create_task(aiter.__anext__())
        cancel_task = asyncio.create_task(cancel_token.wait())
        done, pending = await asyncio.wait({next_task, cancel_task}, return_when=asyncio.FIRST_COMPLETED)
        for p in pending:
            p.cancel()

        if cancel_task in done:
            next_task.cancel()
            raise AbortError()
        try:
            yield await next_task
        except StopAsyncIteration:
            return
