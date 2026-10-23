# Phase 17: Python client SDK

## Phase goal
Implement the Python client SDK with feature parity to the TypeScript SDK, including async WebSocket streaming.

## In scope
- RecFn Python class with namespaced methods: bots, recordings, transcripts, participants, chat, analytics, calendars, webhooks.
- HTTP client using httpx.
- Async WebSocket streaming using websockets library.
- Typed return values (dataclasses or Pydantic models).
- Error handling: return result objects, don't raise for expected errors.
- Published to PyPI as `recfn`.

## Out of scope
- Desktop. CLI.

## Deliverables
- `recfn/python/pyproject.toml`
- `recfn/python/recfn/__init__.py` — RecFn class, barrel export
- `recfn/python/recfn/client.py` — HTTP client (httpx wrapper)
- `recfn/python/recfn/types.py` — all entity types (dataclasses)
- `recfn/python/recfn/resources/bots.py`
- `recfn/python/recfn/resources/recordings.py`
- `recfn/python/recfn/resources/transcripts.py`
- `recfn/python/recfn/resources/participants.py`
- `recfn/python/recfn/resources/chat.py`
- `recfn/python/recfn/resources/analytics.py`
- `recfn/python/recfn/resources/calendars.py`
- `recfn/python/recfn/resources/webhooks.py`
- `recfn/python/recfn/ws.py` — async WebSocket stream
- `recfn/python/tests/test_client.py`
- `recfn/python/tests/test_ws.py`

## Requirements covered
- SDK-002

## Implementation tasks
1. Create `recfn/python/` with pyproject.toml (deps: httpx, websockets).
2. Define types.py: dataclasses for Bot, Recording, Transcript, Segment, Participant, etc. Result envelope type.
3. Implement client.py: httpx-based HTTP client with auth header, JSON parsing, envelope handling.
4. Implement each resource module: bots (create, get, list, leave, delete), recordings, transcripts (get with format, transcribe, search), participants, chat, analytics, calendars, webhooks.
5. Implement ws.py: async generator for WebSocket streaming. `async for segment in client.transcripts.stream(bot_id)`.
6. Implement error handling: return Result objects with ok/data/error fields.
7. Write tests: mock HTTP responses with httpx mock, verify typed returns, test WebSocket.

## Verification steps
- `cd recfn/python && pip install -e . && pytest` — all tests pass.
- Tests cover: TV-SDK-002.

## Stop condition
- Python SDK has feature parity with TypeScript SDK. All methods return typed results. WebSocket streaming works. Tests pass. Report: "Phase 17 complete; Python SDK ready for Phase 18."
