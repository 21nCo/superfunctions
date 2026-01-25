"""Time utilities."""

import asyncio
import time
from typing import Optional, Dict, Any
from dataclasses import dataclass


@dataclass
class Duration:
    """Duration specification."""
    ms: int = 0
    seconds: int = 0
    minutes: int = 0
    hours: int = 0
    days: int = 0


def to_milliseconds(duration: Duration) -> int:
    """Convert duration to milliseconds."""
    total = duration.ms
    total += duration.seconds * 1000
    total += duration.minutes * 60 * 1000
    total += duration.hours * 60 * 60 * 1000
    total += duration.days * 24 * 60 * 60 * 1000
    return total


def from_milliseconds(ms: int) -> Duration:
    """Convert milliseconds to duration."""
    days = ms // (24 * 60 * 60 * 1000)
    ms %= (24 * 60 * 60 * 1000)
    
    hours = ms // (60 * 60 * 1000)
    ms %= (60 * 60 * 1000)
    
    minutes = ms // (60 * 1000)
    ms %= (60 * 1000)
    
    seconds = ms // 1000
    ms %= 1000
    
    return Duration(ms=ms, seconds=seconds, minutes=minutes, hours=hours, days=days)


def format_duration(duration: Duration) -> str:
    """Format duration as string."""
    parts = []
    if duration.days > 0:
        parts.append(f"{duration.days}d")
    if duration.hours > 0:
        parts.append(f"{duration.hours}h")
    if duration.minutes > 0:
        parts.append(f"{duration.minutes}m")
    if duration.seconds > 0:
        parts.append(f"{duration.seconds}s")
    if duration.ms > 0:
        parts.append(f"{duration.ms}ms")
    
    return ' '.join(parts) if parts else '0ms'


def parse_duration(duration_str: str) -> Duration:
    """Parse duration string like '1h30m'."""
    import re
    
    duration = Duration()
    
    # Match patterns like 1d, 2h, 30m, 45s, 100ms
    days = re.search(r'(\d+)d', duration_str)
    hours = re.search(r'(\d+)h', duration_str)
    minutes = re.search(r'(\d+)m(?!s)', duration_str)
    seconds = re.search(r'(\d+)s', duration_str)
    ms = re.search(r'(\d+)ms', duration_str)
    
    if days:
        duration.days = int(days.group(1))
    if hours:
        duration.hours = int(hours.group(1))
    if minutes:
        duration.minutes = int(minutes.group(1))
    if seconds:
        duration.seconds = int(seconds.group(1))
    if ms:
        duration.ms = int(ms.group(1))
    
    return duration


async def sleep(ms: int) -> None:
    """Sleep for milliseconds."""
    await asyncio.sleep(ms / 1000.0)


async def sleep_duration(duration: Duration) -> None:
    """Sleep for duration."""
    ms = to_milliseconds(duration)
    await sleep(ms)


async def timeout(coro: Any, ms: int) -> Any:
    """Run coroutine with timeout."""
    return await asyncio.wait_for(coro, timeout=ms / 1000.0)


def now() -> int:
    """Get current timestamp in milliseconds."""
    return int(time.time() * 1000)


def delay_until(timestamp: int) -> int:
    """Calculate delay until timestamp."""
    current = now()
    return max(0, timestamp - current)


def is_past(timestamp: int) -> bool:
    """Check if timestamp is in the past."""
    return timestamp < now()


def is_future(timestamp: int) -> bool:
    """Check if timestamp is in the future."""
    return timestamp > now()


def add_duration(timestamp: int, duration: Duration) -> int:
    """Add duration to timestamp."""
    return timestamp + to_milliseconds(duration)
