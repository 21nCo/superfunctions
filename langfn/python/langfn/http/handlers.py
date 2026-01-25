from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ValidationError
from superfunctions.http import BadRequestError, Request, Response, RouteContext

from ..client import LangFn


class CompleteBody(BaseModel):
    prompt: str
    metadata: Dict[str, Any] = {}


class ChatBody(BaseModel):
    messages: List[Dict[str, Any]]
    metadata: Dict[str, Any] = {}


class EmbedBody(BaseModel):
    texts: Union[str, List[str]]


class FeedbackBody(BaseModel):
    trace_id: str
    rating: float
    comment: Optional[str] = None
    metadata: Dict[str, Any] = {}


class HttpHandlers:
    def __init__(self, lang: LangFn):
        self._lang = lang

    async def health(self, _request: Request, _context: RouteContext) -> Response:
        return Response(status=200, body={"status": "ok", "name": "langfn", "version": "0.1.0"})

    async def complete(self, request: Request, _context: RouteContext) -> Response:
        try:
            body = CompleteBody.model_validate(await request.json())
        except ValidationError as exc:
            raise BadRequestError(details={"errors": exc.errors()})

        result = await self._lang.complete(body.prompt, metadata=body.metadata)
        return Response(
            status=200,
            body={
                "content": result.content,
                "trace_id": result.trace_id,
                "usage": result.usage.model_dump() if result.usage is not None else None,
                "cost": result.cost.model_dump() if result.cost is not None else None,
            },
        )

    async def chat(self, request: Request, _context: RouteContext) -> Response:
        try:
            body = ChatBody.model_validate(await request.json())
        except ValidationError as exc:
            raise BadRequestError(details={"errors": exc.errors()})

        result = await self._lang.chat(body.messages, metadata=body.metadata)
        return Response(
            status=200,
            body={
                "message": result.message.model_dump(),
                "tool_calls": [c.model_dump() for c in (result.tool_calls or [])] or None,
                "trace_id": result.trace_id,
                "usage": result.usage.model_dump() if result.usage is not None else None,
                "cost": result.cost.model_dump() if result.cost is not None else None,
            },
        )

    async def embed(self, request: Request, _context: RouteContext) -> Response:
        try:
            body = EmbedBody.model_validate(await request.json())
        except ValidationError as exc:
            raise BadRequestError(details={"errors": exc.errors()})

        result = await self._lang.embed(body.texts)
        return Response(status=200, body={"embeddings": result})

    async def traces(self, request: Request, _context: RouteContext) -> Response:
        limit = int(_context.query.get("limit", 10))
        result = await self._lang.get_traces(limit=limit)
        return Response(status=200, body={"traces": result})

    async def feedback(self, request: Request, _context: RouteContext) -> Response:
        try:
            body = FeedbackBody.model_validate(await request.json())
        except ValidationError as exc:
            raise BadRequestError(details={"errors": exc.errors()})

        await self._lang.feedback(
            trace_id=body.trace_id,
            rating=body.rating,
            comment=body.comment,
            metadata=body.metadata,
        )
        return Response(status=200, body={"status": "success"})

