# RecFn Python Client SDK

Python client for the RecFn meeting recording and transcription API.

## Installation

```bash
pip install recfn
```

Or from source:

```bash
cd recfn/python && pip install -e .
```

## Usage

```python
import asyncio
from recfn import RecFn

async def main():
    client = RecFn(base_url="https://rec.example.com", api_key="sk-your-api-key")

    # Create a bot to join a meeting
    res = await client.bots.create("https://zoom.us/j/123456789", platform="zoom")
    if not res.get("ok"):
        print("Error:", res.get("error"))
        return
    bot = res["data"]
    print(f"Bot created: {bot.id}")

    # List recordings
    res = await client.recordings.list(bot.id)
    if res.get("ok"):
        for rec in res["data"]["recordings"]:
            print(f"Recording: {rec.id} ({rec.duration}s)")

    # Stream real-time transcript
    async for event_type, data in client.transcripts.stream(bot.id):
        if event_type == "segment":
            print(f"[{data.speaker_id}] {data.text}")
        elif event_type == "participant_joined":
            print(f"Joined: {data.name}")
        elif event_type == "error":
            print(f"Error: {data}")

asyncio.run(main())
```

## API Resources

- **bots** — create, get, list, leave, delete
- **recordings** — list, get, download_url, download, upload
- **transcripts** — get, transcribe, search, stream (WebSocket)
- **participants** — list
- **chat** — list
- **analytics** — get
- **calendars** — create, list, delete, get_events
- **webhooks** — create, list, delete
- **metadata** — get

All methods return `{ok: True, data: ...}` or `{ok: False, error: {code, message, details}}`.

## Typed resources and streaming

The installed wheel includes `py.typed`. Resource properties such as `bots`,
`recordings`, and `transcripts` expose their concrete method signatures to type
checkers. Their factories still accept a `RecFnHttpClient`; each resource retains
that client's configuration. Response envelopes remain dynamic dictionaries and
stream event payloads retain their existing event-specific runtime shapes.

Collection defaults on aggregate entities and API errors are independently
allocated. Existing normalization for explicit `None` supplied by untyped callers
is retained. Transcript streams accept both text and binary JSON frames; malformed
UTF-8 or JSON frames are ignored, as are unsupported frame types and invalid
status/error shapes. This is not a general validation guarantee for arbitrary
entity payloads. Closing the stream retains the existing ping-task cleanup.

Run the configured checks with `python -m ruff check .`, `python -m mypy .`, and
`python -m pytest .`. The cross-language stream-schema test needs the repository's
built `@recfn/core`; installed-wheel tests may set `RECFN_CONTRACT_ROOT` to that
checkout. The strict consumer fixture is `tests/typing_consumer.py`.
