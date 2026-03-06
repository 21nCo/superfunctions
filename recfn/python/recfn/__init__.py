"""
RecFn Python client SDK for meeting recording and transcription.

Example usage:
    >>> from recfn import RecFn
    >>> client = RecFn(base_url="https://rec.example.com", api_key="sk-...")
    >>> res = await client.bots.create("https://zoom.us/j/123")
    >>> async for event_type, data in client.transcripts.stream("bot-123"):
    ...     if event_type == "segment":
    ...         print(data.text)
"""

__version__ = "0.1.0"
__author__ = "21n"
__license__ = "MIT"

from .client import RecFnHttpClient
from .recfn import RecFn
from .types import (
    Analytics,
    ApiError,
    Bot,
    BotConfig,
    Calendar,
    CalendarEvent,
    ChatMessage,
    MeetingMetadata,
    Participant,
    Recording,
    Segment,
    TopicSegment,
    Transcript,
    Webhook,
)

__all__ = [
    "__version__",
    "RecFn",
    "RecFnHttpClient",
    "Analytics",
    "ApiError",
    "Bot",
    "BotConfig",
    "Calendar",
    "CalendarEvent",
    "ChatMessage",
    "MeetingMetadata",
    "Participant",
    "Recording",
    "Segment",
    "TopicSegment",
    "Transcript",
    "Webhook",
]
