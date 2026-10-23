import asyncio
import json
import sys
from typing import Any, Dict, List, Optional
import httpx

from .types import LogEvent, Sink

class SinkConsole:
    def __init__(self, json: bool = False, color: bool = True):
        self.json = json
        self.color = color

    def __call__(self, batch: List[LogEvent]) -> None:
        for event in batch:
            if self.json:
                print(json.dumps(event, default=str))
            else:
                self._print_pretty(event)

    def _print_pretty(self, event: LogEvent) -> None:
        level = event["level"]
        msg = event["msg"]
        ts = event["ts"]
        name = event["name"]
        
        # Simple coloring
        color_code = ""
        reset = ""
        if self.color:
            reset = "\033[0m"
            if level == "trace": color_code = "\033[90m" # Gray
            elif level == "debug": color_code = "\033[34m" # Blue
            elif level == "info": color_code = "\033[32m" # Green
            elif level == "warn": color_code = "\033[33m" # Yellow
            elif level == "error": color_code = "\033[31m" # Red
            elif level == "fatal": color_code = "\033[35m" # Magenta
        
        # Context string
        ctx_str = ""
        if "ctx" in event and event["ctx"]:
            ctx_items = []
            for k, v in event["ctx"].items():
                ctx_items.append(f"{k}={v}")
            ctx_str = " " + " ".join(ctx_items)
            
        print(f"{color_code}[{ts}] {level.upper()} ({name}): {msg}{reset}{ctx_str}")

    async def flush(self) -> None:
        pass


class SinkHttp:
    def __init__(
        self,
        url: str,
        auth_token: Optional[str] = None,
        batch_size: int = 10,
        flush_interval_ms: int = 1000, # Not used in simple sync version yet
        timeout: float = 5.0,
    ):
        self.url = url
        self.auth_token = auth_token
        self.batch_size = batch_size
        self.timeout = timeout
        self.buffer: List[LogEvent] = []
        self._client = httpx.AsyncClient(timeout=timeout)
        self._lock = asyncio.Lock()

    def __call__(self, batch: List[LogEvent]) -> Any:
        # We need to handle this carefully.
        # If called from sync code, we can't use async lock.
        # But this is designed to be used in async context primarily if using HTTP.
        # If we are strictly sync, we should use a sync HTTP client.
        # However, making Logger sync means we bridge the gap.
        
        # For now, we return a coroutine that does the work, and Logger schedules it.
        # But we also want to batch locally.
        
        # A simple approach: simple in-memory append (thread-safeish in Python for simple list append)
        # Then check size.
        
        self.buffer.extend(batch)
        if len(self.buffer) >= self.batch_size:
            return self.flush()
        return None

    async def flush(self) -> None:
        if not self.buffer:
            return
            
        # Swap buffer
        current_batch = self.buffer
        self.buffer = []
        
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
            
        try:
            # Send batch
            await self._client.post(self.url, json=current_batch, headers=headers)
        except Exception as e:
            # In a real system we would retry or log to stderr
            print(f"Error flushing logs to {self.url}: {e}", file=sys.stderr)
            # Put back in buffer? risk of infinite loop. Drop for now.

    async def close(self) -> None:
        await self._client.aclose()
