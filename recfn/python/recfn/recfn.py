"""RecFn main client class."""

from __future__ import annotations

from .client import RecFnHttpClient
from .resources.analytics import create_analytics_resource
from .resources.bots import create_bots_resource
from .resources.calendars import create_calendars_resource
from .resources.chat import create_chat_resource
from .resources.metadata import create_metadata_resource
from .resources.participants import create_participants_resource
from .resources.recordings import create_recordings_resource
from .resources.transcripts import create_transcripts_resource
from .resources.webhooks import create_webhooks_resource


class RecFn:
    """RecFn Python client SDK.

    Wraps all REST API and WebSocket endpoints with typed methods.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
    ) -> None:
        self._client = RecFnHttpClient(base_url=base_url, api_key=api_key, timeout=timeout)
        self.bots = create_bots_resource(self._client)
        self.recordings = create_recordings_resource(self._client)
        self.transcripts = create_transcripts_resource(self._client)
        self.participants = create_participants_resource(self._client)
        self.chat = create_chat_resource(self._client)
        self.analytics = create_analytics_resource(self._client)
        self.calendars = create_calendars_resource(self._client)
        self.webhooks = create_webhooks_resource(self._client)
        self.metadata = create_metadata_resource(self._client)
