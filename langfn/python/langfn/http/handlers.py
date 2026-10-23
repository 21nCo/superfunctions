from __future__ import annotations

from typing import Any

from superfunctions.http import Request, Response

from ..client import LangFn
from .validation import (
    LangFnRouteContext,
    ensure_langfn_context,
    error_response,
    parse_chat_body,
    parse_complete_body,
    parse_embed_body,
    parse_feedback_body,
    parse_stream_body,
    parse_traces_query,
    success_envelope,
    to_http_error,
)


class HttpHandlers:
    def __init__(self, lang: LangFn):
        self._lang = lang

    async def health(self, _request: Request, _context: LangFnRouteContext) -> Response:
        return Response(
            status=200,
            headers={"content-type": "application/json"},
            body=success_envelope({"status": "ok", "name": "langfn", "version": "0.1.0"}),
        )

    async def complete(self, request: Request, context: LangFnRouteContext) -> Response:
        try:
            context = ensure_langfn_context(context)
            body = parse_complete_body(await request.json())
            result = await self._lang.complete(
                body.prompt,
                metadata=context.merge_metadata(body.metadata),
            )
            return Response(
                status=200,
                headers={"content-type": "application/json"},
                body=success_envelope(
                    {
                        "content": result.content,
                        **({"usage": result.usage.model_dump()} if result.usage is not None else {}),
                        **({"cost": result.cost.model_dump()} if result.cost is not None else {}),
                    },
                    result.trace_id,
                ),
            )
        except Exception as exc:  # pragma: no cover - exercised in tests through normalize helper
            return error_response(*to_http_error(exc))

    async def chat(self, request: Request, context: LangFnRouteContext) -> Response:
        try:
            context = ensure_langfn_context(context)
            body = parse_chat_body(await request.json())
            result = await self._lang.chat(
                [message.model_dump(exclude_none=True) for message in body.messages],
                metadata=context.merge_metadata(body.metadata),
                tools=body.tools,
                tool_choice=body.tool_choice,
            )
            return Response(
                status=200,
                headers={"content-type": "application/json"},
                body=success_envelope(
                    {
                        "message": result.message.model_dump(exclude_none=True),
                        **(
                            {"tool_calls": [call.model_dump(exclude_none=True) for call in (result.tool_calls or [])]}
                            if result.tool_calls
                            else {}
                        ),
                        **({"usage": result.usage.model_dump()} if result.usage is not None else {}),
                        **({"cost": result.cost.model_dump()} if result.cost is not None else {}),
                    },
                    result.trace_id,
                ),
            )
        except Exception as exc:  # pragma: no cover - exercised in tests through normalize helper
            return error_response(*to_http_error(exc))

    async def stream(self, request: Request, context: LangFnRouteContext) -> Response:
        try:
            context = ensure_langfn_context(context)
            body = parse_stream_body(await request.json())
            metadata = context.merge_metadata(body.metadata)
            input_value: str | list[dict[str, Any]]
            if body.prompt is not None:
                input_value = body.prompt
            else:
                input_value = [message.model_dump(exclude_none=True) for message in body.messages]

            chunks: list[str] = []
            async for chunk in self._lang.stream_sse(input_value, metadata=metadata):
                chunks.append(chunk)
            return Response(
                status=200,
                headers={
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                },
                body="".join(chunks),
            )
        except Exception as exc:  # pragma: no cover - exercised in tests through normalize helper
            return error_response(*to_http_error(exc))

    async def embed(self, request: Request, _context: LangFnRouteContext) -> Response:
        try:
            body = parse_embed_body(await request.json())
            embeddings = await self._lang.embed(body.texts)
            return Response(
                status=200,
                headers={"content-type": "application/json"},
                body=success_envelope({"embeddings": embeddings}),
            )
        except Exception as exc:  # pragma: no cover - exercised in tests through normalize helper
            return error_response(*to_http_error(exc))

    async def traces(self, _request: Request, context: LangFnRouteContext) -> Response:
        try:
            context = ensure_langfn_context(context)
            query = parse_traces_query(context.query)
            traces = await self._lang.get_traces(limit=query.limit, query=query)
            return Response(
                status=200,
                headers={"content-type": "application/json"},
                body=success_envelope({"traces": traces}),
            )
        except Exception as exc:  # pragma: no cover - exercised in tests through normalize helper
            return error_response(*to_http_error(exc))

    async def feedback(self, request: Request, context: LangFnRouteContext) -> Response:
        try:
            context = ensure_langfn_context(context)
            body = parse_feedback_body(await request.json())
            await self._lang.feedback(
                trace_id=body.trace_id,
                rating=body.rating,
                comment=body.comment,
                metadata=context.merge_metadata(body.metadata, client_key=body.client_key),
            )
            return Response(
                status=200,
                headers={"content-type": "application/json"},
                body=success_envelope({"accepted": True}, body.trace_id),
            )
        except Exception as exc:  # pragma: no cover - exercised in tests through normalize helper
            return error_response(*to_http_error(exc))
