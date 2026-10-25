"""Operation-scoped HTTP support with completed memory/database admission."""
import asyncio
import hmac
import json
from datetime import datetime, timezone
from typing import cast
from superfunctions.auth import AuthProvider, AuthSession, validate_auth_session
from superfunctions.http import Request, Response, RouteContext
from ..models import Event
from ..storage.events import decode_event
from ..query import Query, QueryValidationError
from ..storage.memory_storage import MemoryStorage
from ..storage.database import DatabaseStorage


def reply(status, body):
    return Response(status=status, body=body, headers={"Cache-Control": "no-store"})


class HttpHandlers:
    def __init__(self, watch):
        self.watch = watch

    async def authorize(self, request, scope):
        config = self.watch.config.auth
        if config is None:
            return reply(401, {"error": "Unauthorized"})
        if config.provider is not None:
            try:
                session = await cast(AuthProvider, config.provider).authenticate(request)
            except Exception:
                return reply(503, {"error": "Authentication unavailable"})
            try:
                if not isinstance(session, AuthSession):
                    return reply(401, {"error": "Unauthorized"})
                session = validate_auth_session(session.model_dump(by_alias=True))
                if not session.id or not session.subject.actor_id:
                    return reply(401, {"error": "Unauthorized"})
                expiry = session.expires_at
                # Naive expiry has no unambiguous instant: fail closed.
                if expiry is not None and (expiry.tzinfo is None or expiry <= datetime.now(timezone.utc)):
                    return reply(401, {"error": "Unauthorized"})
                if scope not in (session.scopes or []):
                    return reply(403, {"error": "Forbidden"})
            except Exception:
                return reply(401, {"error": "Unauthorized"})
            return None
        if config.enabled is False:
            return None
        if not config.api_key:
            return reply(401, {"error": "Unauthorized"})
        headers = {key.lower(): value for key, value in request.headers.items()}
        expected = config.api_key.encode("utf-8")
        if any(hmac.compare_digest(value.encode("utf-8"), target) for value, target in [
            (headers.get("authorization", ""), b"Bearer " + expected),
            (headers.get("x-api-key", ""), expected),
        ]):
            return None
        return reply(401, {"error": "Unauthorized"})

    async def read_json(self, request, limit):
        headers = {key.lower(): value for key, value in request.headers.items()}
        declared = headers.get("content-length")
        if declared is not None:
            if not declared.isdecimal():
                raise ValueError("Invalid content length")
            if int(declared) > limit:
                raise OverflowError()
        raw = await request.body()
        if len(raw) > limit:
            raise OverflowError()
        def invalid_constant(_):
            raise ValueError("Invalid JSON constant")
        return json.loads(raw, parse_constant=invalid_constant)

    async def health(self, request: Request, context: RouteContext) -> Response:
        return reply(200, {"status": "ok", "version": "0.1.0"})

    async def ingest(self, request: Request, context: RouteContext) -> Response:
        denied = await self.authorize(request, "watchfn:ingest")
        if denied is not None:
            return denied
        try:
            body = await self.read_json(request, 8 * 1024 * 1024)
            values = body if isinstance(body, list) else body.get("events") if isinstance(body, dict) and "events" in body else [body]
            if not isinstance(values, list) or not 1 <= len(values) <= 500:
                raise ValueError()
            events = []
            for value in values:
                if isinstance(value, dict) and 'app' in value:
                    if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) > 65536: raise OverflowError()
                    event = decode_event(json.dumps(value, ensure_ascii=False, allow_nan=False))
                    if event.type != 'track' or event.model_dump().get('app') != {'name': self.watch.config.name}: raise ValueError()
                    events.append(event)
                    continue
                if not isinstance(value, dict) or set(value) - {"name", "properties", "context", "type"}:
                    raise ValueError()
                if value.get("type", "track") != "track" or not isinstance(value.get("name"), str) or not value["name"].strip():
                    raise ValueError()
                if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 65536:
                    raise OverflowError()
                if not isinstance(value.get("properties", {}), dict) or not isinstance(value.get("context", {}), dict):
                    raise ValueError()
                events.append(Event(**{**value, "type": "track"}))
        except OverflowError:
            return reply(413, {"error": "Request or event too large"})
        except Exception:
            return reply(400, {"error": "Invalid event batch"})
        if not self.watch.is_started or (not isinstance(self.watch.storage, (MemoryStorage, DatabaseStorage)) or (self.watch.config.storage == "database" and not isinstance(self.watch.storage, DatabaseStorage))):
            return reply(503, {"error": "Storage unavailable"})
        try:
            if isinstance(self.watch.storage, DatabaseStorage):
                await self.watch.storage.add_batch_async(events)
            else:
                self.watch.storage.add_batch(events)
        except OverflowError:
            return reply(413, {"error": "Event too large"})
        except Exception:
            return reply(503, {"error": "Storage unavailable"})
        return reply(202, {"accepted": len(events)})

    async def query(self, request: Request, context: RouteContext) -> Response:
        denied = await self.authorize(request, "watchfn:query")
        if denied is not None:
            return denied
        try:
            body = await self.read_json(request, 65536)
            Query(body)  # Validate before flushing programmatic events.
        except OverflowError:
            return reply(413, {"error": "Request body too large"})
        except Exception:
            return reply(400, {"error": "Invalid query"})
        if (not isinstance(self.watch.storage, (MemoryStorage, DatabaseStorage)) or (self.watch.config.storage == "database" and not isinstance(self.watch.storage, DatabaseStorage))):
            return reply(503, {"error": "Query unavailable"})
        try:
            results = await asyncio.to_thread(self.watch.query, body)
            if len(json.dumps({"results": results}, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 8 * 1024 * 1024:
                raise ValueError()
            return reply(200, {"results": results})
        except QueryValidationError:
            return reply(400, {"error": "Invalid query"})
        except Exception:
            return reply(503, {"error": "Query unavailable"})
