"""Cross-language vector driver: reads one JSON case per stdin line and answers with one JSON line holding the
normalized outcome and the failure observations. The caller's server records the requests, so the TypeScript
and Python clients are compared against the same server."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from harness import run_case


async def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        message: dict[str, Any] = json.loads(line)
        options: dict[str, Any] = {}
        if "credentials" in message:
            options["credentials"] = message["credentials"]
        if "maxAttempts" in message:
            options["retry"] = {"max_attempts": message["maxAttempts"]}
        outcome, events = await run_case(message["baseUrl"], message["case"], **options)
        sys.stdout.write(json.dumps({"outcome": outcome, "events": events}) + "\n")
        sys.stdout.flush()


asyncio.run(main())
