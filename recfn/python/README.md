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
