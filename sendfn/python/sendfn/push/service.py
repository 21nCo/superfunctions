"""Push notification service orchestration."""

from datetime import datetime
from typing import Optional

from superfunctions.db import Adapter

from ..errors import PushProviderError
from ..models import Platform, PushNotification, SendPushParams
from .device_manager import DeviceTokenManager
from .provider import PushProvider


class PushService:
    """Push notification service that coordinates providers and device management."""

    def __init__(
        self,
        providers: dict[Platform, PushProvider],
        db: Adapter,
        device_manager: DeviceTokenManager,
    ) -> None:
        """Initialize push service.

        Args:
            providers: Map of platform to push providers (FCM, APNS)
            db: Database adapter
            device_manager: Device token manager
        """
        self.providers = providers
        self.db = db
        self.device_manager = device_manager

    async def send_push(self, params: SendPushParams) -> PushNotification:
        """Send a push notification.

        Args:
            params: Push send parameters

        Returns:
            Push notification record
        """
        from ..database.helpers import (
            create_push_notification,
            get_push_notification,
            record_event,
            update_push_notification,
        )

        # Normalize user IDs
        user_ids = params.user_id if isinstance(params.user_id, list) else [params.user_id]

        # Resolve user IDs to device tokens
        tokens: list[str] = []
        platform_tokens: dict[Platform, list[str]] = {}

        for user_id in user_ids:
            devices = await self.device_manager.get_active_devices(user_id)
            for device in devices:
                tokens.append(device.token)
                if device.platform not in platform_tokens:
                    platform_tokens[device.platform] = []
                platform_tokens[device.platform].append(device.token)

        # If no devices found, create failed notification
        if not tokens:
            notification = await create_push_notification(
                self.db,
                {
                    "userId": ",".join(user_ids),
                    "title": params.title,
                    "body": params.body,
                    "data": params.data,
                    "deviceTokens": [],
                    "platform": "web",  # Default
                    "provider": "none",
                    "status": "failed",
                    "sentCount": 0,
                    "failedCount": 0,
                    "sentAt": None,
                    "metadata": {"error": "No active devices found"},
                },
            )
            return notification

        # Send to each platform
        last_notification: Optional[PushNotification] = None

        for platform, p_tokens in platform_tokens.items():
            provider = self.providers.get(platform)

            if not provider:
                continue

            # Create notification record
            notification = await create_push_notification(
                self.db,
                {
                    "userId": ",".join(user_ids),
                    "title": params.title,
                    "body": params.body,
                    "data": params.data,
                    "deviceTokens": p_tokens,
                    "platform": platform,
                    "provider": provider.name,
                    "status": "pending",
                    "sentCount": 0,
                    "failedCount": 0,
                    "sentAt": None,
                    "metadata": params.metadata or {},
                },
            )

            try:
                # Send via provider
                from .provider import SendPushRequest

                response = await provider.send_push(
                    SendPushRequest(
                        device_tokens=p_tokens,
                        title=params.title,
                        body=params.body,
                        data=params.data,
                        image_url=params.image_url,
                        badge=params.badge,
                        sound=params.sound,
                        priority=params.priority,
                        ttl=params.ttl,
                        collapse_key=params.collapse_key,
                        category=params.category,
                    )
                )

                # Update record
                await update_push_notification(
                    self.db,
                    str(notification.id),
                    {
                        "status": "sent" if response.success else "failed",
                        "sentCount": response.success_count,
                        "failedCount": response.failed_count,
                        "sentAt": response.timestamp,
                        "metadata": {
                            **(params.metadata or {}),
                            "results": response.results,
                        },
                    },
                )

                # Handle invalid tokens
                if response.invalid_tokens:
                    await self.device_manager.deactivate_tokens(response.invalid_tokens)

                # Record event
                await record_event(
                    self.db,
                    {
                        "referenceId": str(notification.id),
                        "referenceType": "push",
                        "eventType": "sent" if response.success else "failed",
                        "provider": provider.name,
                        "providerEventId": None,
                        "recipientEmail": None,
                        "recipientPhone": None,
                        "deviceToken": None,  # Multiple tokens
                        "metadata": {
                            "successCount": response.success_count,
                            "failedCount": response.failed_count,
                        },
                        "eventTimestamp": response.timestamp,
                    },
                )

                # Get updated notification
                last_notification = await get_push_notification(self.db, str(notification.id))

            except Exception as error:
                # Update notification as failed
                await update_push_notification(
                    self.db,
                    str(notification.id),
                    {
                        "status": "failed",
                        "metadata": {**(params.metadata or {}), "error": str(error)},
                    },
                )

                # Record failed event
                await record_event(
                    self.db,
                    {
                        "referenceId": str(notification.id),
                        "referenceType": "push",
                        "eventType": "failed",
                        "provider": provider.name,
                        "providerEventId": None,
                        "recipientEmail": None,
                        "recipientPhone": None,
                        "deviceToken": None,
                        "metadata": {"error": str(error)},
                        "eventTimestamp": datetime.now(),
                    },
                )

                raise error

        if not last_notification:
            raise PushProviderError("Failed to process push for any platform")

        return last_notification

    async def send_bulk_push(
        self, notifications: list[SendPushParams]
    ) -> list[PushNotification]:
        """Send multiple push notifications.

        Args:
            notifications: List of push send parameters

        Returns:
            List of push notification records
        """
        results: list[PushNotification] = []
        for notification in notifications:
            results.append(await self.send_push(notification))
        return results
