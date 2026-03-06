"""Calendars resource."""

from __future__ import annotations

from typing import Optional

from ..client import RecFnHttpClient


def create_calendars_resource(client: RecFnHttpClient) -> object:
    """Create calendars resource."""

    class CalendarsResource:
        async def create(
            self,
            provider: str,
            access_token: str,
            *,
            refresh_token: Optional[str] = None,
            auto_schedule: Optional[bool] = None,
        ) -> dict:
            body: dict = {
                "provider": provider,
                "accessToken": access_token,
            }
            if refresh_token is not None:
                body["refreshToken"] = refresh_token
            if auto_schedule is not None:
                body["autoSchedule"] = auto_schedule
            return await client.request("POST", "/api/v1/calendars", body=body)

        async def list(self) -> dict:
            return await client.request("GET", "/api/v1/calendars")

        async def delete(self, calendar_id: str) -> dict:
            return await client.request(
                "DELETE",
                f"/api/v1/calendars/{calendar_id}",
            )

        async def get_events(
            self,
            calendar_id: str,
            *,
            from_: Optional[str] = None,
            to: Optional[str] = None,
        ) -> dict:
            params: list[str] = []
            if from_:
                params.append(f"from={from_}")
            if to:
                params.append(f"to={to}")
            qs = "&".join(params)
            path = f"/api/v1/calendars/{calendar_id}/events?{qs}" if qs else f"/api/v1/calendars/{calendar_id}/events"
            return await client.request("GET", path)

    return CalendarsResource()
