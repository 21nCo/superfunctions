"""Entity types and API result envelope for RecFn."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional


# Enums / type aliases
Platform = Literal["zoom", "meet", "teams"]
BotStatus = Literal[
    "creating", "joining", "joined", "recording", "leaving", "left", "done", "error"
]
ConsentStatus = Literal["granted", "denied", "pending", "unknown"]
ParticipantRole = Literal["host", "attendee", "bot"]
RecordingFormat = Literal["mp4", "wav", "opus", "webm"]
TranscriptStatus = Literal["processing", "ready", "error"]
TranscriptExportFormat = Literal["json", "srt", "vtt", "text"]
CalendarProvider = Literal["google", "outlook"]


@dataclass
class BotConfig:
    """Bot configuration."""

    display_name: Optional[str] = None
    join_timeout: Optional[int] = None
    auto_leave_on_empty: Optional[bool] = None
    auto_leave_empty_timeout: Optional[int] = None
    consent_message: Optional[str] = None
    enable_real_time_transcript: Optional[bool] = None
    asr_provider: Optional[str] = None
    recording_format: Optional[Literal["mp4", "audio_only"]] = None
    language: Optional[str] = None


@dataclass
class Bot:
    """Meeting bot entity."""

    id: str
    namespace: str
    meeting_url: str
    platform: str
    status: str
    config: Dict[str, Any]
    error_message: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class AggregateBotDetail(Bot):
    """Aggregate bot detail including nested related resources."""

    participants: List["Participant"] = None
    recordings: List["Recording"] = None
    metadata: Optional["MeetingMetadata"] = None
    chat_messages: List["ChatMessage"] = None

    def __post_init__(self) -> None:
        if self.participants is None:
            self.participants = []
        if self.recordings is None:
            self.recordings = []
        if self.chat_messages is None:
            self.chat_messages = []


@dataclass
class Recording:
    """Recording entity."""

    id: str
    bot_id: str
    format: str
    duration: float
    storage_ref: str
    size: int
    download_url: Optional[str] = None
    created_at: str = ""


@dataclass
class Segment:
    """Transcript segment."""

    speaker_id: str
    start_time: float
    end_time: float
    text: str
    confidence: float


@dataclass
class Transcript:
    """Transcript entity."""

    id: str
    recording_id: str
    language: str
    status: str
    segments: List[Segment]
    created_at: str = ""


@dataclass
class Participant:
    """Meeting participant."""

    id: str
    bot_id: str
    name: str
    email: Optional[str] = None
    role: str = "attendee"
    joined_at: str = ""
    left_at: Optional[str] = None
    consent: str = "unknown"


@dataclass
class ChatMessage:
    """Chat message."""

    participant_id: str
    text: str
    timestamp: str


@dataclass
class MeetingMetadata:
    """Meeting metadata."""

    id: str
    bot_id: str
    title: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    platform: str = ""
    chat_messages: List[ChatMessage] = None

    def __post_init__(self) -> None:
        if self.chat_messages is None:
            self.chat_messages = []


@dataclass
class TopicSegment:
    """Topic segment for analytics."""

    topic: str
    start_time: float
    end_time: float
    keywords: List[str]


@dataclass
class Analytics:
    """Recording analytics."""

    recording_id: str
    total_duration: float
    talk_time: dict[str, float]
    silence_percentage: float
    topic_segments: Optional[List[TopicSegment]] = None


@dataclass
class Calendar:
    """Calendar integration."""

    id: str
    provider: str
    auto_schedule: bool
    created_at: str = ""


@dataclass
class CalendarEvent:
    """Calendar event."""

    id: str
    calendar_id: str
    title: str
    start_time: str
    end_time: str
    meeting_url: Optional[str] = None
    bot_id: Optional[str] = None


@dataclass
class Webhook:
    """Webhook configuration."""

    id: str
    url: str
    events: List[str]
    secret: Optional[str] = None
    created_at: str = ""


# API result types
@dataclass
class ApiError:
    """API error details."""

    code: str
    message: str
    details: Dict[str, Any] = None

    def __post_init__(self) -> None:
        if self.details is None:
            self.details = {}


# Result is either ok+data or error; use TypedDict or Union for type hints
# We use a simple approach: ApiResult is a dict with ok/data or ok/error
def _parse_segment(d: dict[str, Any]) -> Segment:
    return Segment(
        speaker_id=d.get("speakerId", ""),
        start_time=float(d.get("startTime", 0)),
        end_time=float(d.get("endTime", 0)),
        text=d.get("text", ""),
        confidence=float(d.get("confidence", 0)),
    )


def _parse_bot(d: dict[str, Any]) -> Bot:
    return Bot(
        id=d.get("id", ""),
        namespace=d.get("namespace", ""),
        meeting_url=d.get("meetingUrl", ""),
        platform=d.get("platform", ""),
        status=d.get("status", ""),
        config=d.get("config", {}),
        error_message=d.get("errorMessage"),
        created_at=d.get("createdAt", ""),
        updated_at=d.get("updatedAt", ""),
    )


def _parse_recording(d: dict[str, Any]) -> Recording:
    return Recording(
        id=d.get("id", ""),
        bot_id=d.get("botId", ""),
        format=d.get("format", ""),
        duration=float(d.get("duration", 0)),
        storage_ref=d.get("storageRef", ""),
        size=int(d.get("size", 0)),
        download_url=d.get("downloadUrl"),
        created_at=d.get("createdAt", ""),
    )


def _parse_transcript(d: dict[str, Any]) -> Transcript:
    segs = [ _parse_segment(s) for s in d.get("segments", []) ]
    return Transcript(
        id=d.get("id", ""),
        recording_id=d.get("recordingId", ""),
        language=d.get("language", ""),
        status=d.get("status", ""),
        segments=segs,
        created_at=d.get("createdAt", ""),
    )


def _parse_participant(d: dict[str, Any]) -> Participant:
    return Participant(
        id=d.get("id", ""),
        bot_id=d.get("botId", ""),
        name=d.get("name", ""),
        email=d.get("email"),
        role=d.get("role", "attendee"),
        joined_at=d.get("joinedAt", ""),
        left_at=d.get("leftAt"),
        consent=d.get("consent", "unknown"),
    )


def _parse_chat_message(d: dict[str, Any]) -> ChatMessage:
    return ChatMessage(
        participant_id=d.get("participantId", ""),
        text=d.get("text", ""),
        timestamp=d.get("timestamp", ""),
    )


def _parse_metadata(d: dict[str, Any]) -> MeetingMetadata:
    return MeetingMetadata(
        id=d.get("id", ""),
        bot_id=d.get("botId", ""),
        title=d.get("title"),
        start_time=d.get("startTime"),
        end_time=d.get("endTime"),
        platform=d.get("platform", ""),
        chat_messages=[_parse_chat_message(m) for m in d.get("chatMessages", [])],
    )


def _parse_aggregate_bot_detail(d: dict[str, Any]) -> AggregateBotDetail:
    bot = _parse_bot(d)
    return AggregateBotDetail(
        id=bot.id,
        namespace=bot.namespace,
        meeting_url=bot.meeting_url,
        platform=bot.platform,
        status=bot.status,
        config=bot.config,
        error_message=bot.error_message,
        created_at=bot.created_at,
        updated_at=bot.updated_at,
        participants=[_parse_participant(p) for p in d.get("participants", [])],
        recordings=[_parse_recording(r) for r in d.get("recordings", [])],
        metadata=_parse_metadata(d["metadata"]) if isinstance(d.get("metadata"), dict) else None,
        chat_messages=[_parse_chat_message(m) for m in d.get("chatMessages", [])],
    )
