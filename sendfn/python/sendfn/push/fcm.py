"""FCM (Firebase Cloud Messaging) provider for push notifications."""

from datetime import datetime
from typing import Any, Optional

import firebase_admin
from firebase_admin import credentials, messaging

from ..errors import PushProviderError
from ..models import FcmConfig
from .provider import (
    PushProvider,
    PushProviderCapabilities,
    SendPushRequest,
    SendPushResponse,
)


class FcmProvider:
    """Firebase Cloud Messaging provider for Android and web push notifications."""

    def __init__(self, config: FcmConfig) -> None:
        """Initialize FCM provider.

        Args:
            config: FCM configuration
        """
        self.config = config
        self._app: Optional[firebase_admin.App] = None

    @property
    def name(self) -> str:
        """Provider name."""
        return "fcm"

    @property
    def platform(self) -> str:
        """Platform (android/web)."""
        return "android"

    @property
    def capabilities(self) -> PushProviderCapabilities:
        """Provider capabilities."""
        return PushProviderCapabilities(
            max_payload_size=4096,
            supports_batching=True,  # FCM supports multicast
            supports_scheduling=False,
            supports_images=True,
            supports_silent_push=True,
        )

    async def initialize(self) -> None:
        """Initialize Firebase app."""
        # Prevent multiple initializations
        if len(firebase_admin._apps) > 0:
            self._app = firebase_admin._apps.get("[DEFAULT]")
        else:
            # Load service account key
            if isinstance(self.config.service_account_key, str):
                # Path to JSON file
                cred = credentials.Certificate(self.config.service_account_key)
            else:
                # Dict with service account data
                cred = credentials.Certificate(self.config.service_account_key)

            # Initialize app
            self._app = firebase_admin.initialize_app(
                cred,
                options={"projectId": self.config.project_id} if self.config.project_id else None,
            )

    async def send_push(self, request: SendPushRequest) -> SendPushResponse:
        """Send a push notification via FCM.

        Args:
            request: Push send request

        Returns:
            Push send response
        """
        if not self._app:
            await self.initialize()

        # Build FCM multicast message
        # Convert all data values to strings (FCM requirement)
        data_str: dict[str, str] = {}
        if request.data:
            for key, value in request.data.items():
                data_str[key] = str(value) if not isinstance(value, str) else value

        message = messaging.MulticastMessage(
            tokens=request.device_tokens,
            notification=messaging.Notification(
                title=request.title,
                body=request.body,
                image=request.image_url,
            ),
            data=data_str if data_str else None,
            android=messaging.AndroidConfig(
                priority=request.priority,
                ttl=datetime.timedelta(seconds=request.ttl) if request.ttl else None,
                collapse_key=request.collapse_key,
                notification=messaging.AndroidNotification(
                    sound=request.sound or "default",
                ),
            ),
        )

        try:
            # Send multicast message
            response = messaging.send_each_for_multicast(message)

            # Process results
            invalid_tokens: list[str] = []
            results: list[dict[str, Any]] = []

            for idx, send_response in enumerate(response.responses):
                token = request.device_tokens[idx]

                if not send_response.success:
                    # Check if token is invalid
                    if send_response.exception:
                        error_code = getattr(send_response.exception, "code", None)
                        if error_code in [
                            "messaging/registration-token-not-registered",
                            "messaging/invalid-registration-token",
                            "messaging/invalid-argument",
                        ]:
                            invalid_tokens.append(token)

                results.append(
                    {
                        "token": token,
                        "success": send_response.success,
                        "error": (
                            send_response.exception.message
                            if send_response.exception
                            else None
                        ),
                    }
                )

            return SendPushResponse(
                success=response.failure_count == 0,
                success_count=response.success_count,
                failed_count=response.failure_count,
                invalid_tokens=invalid_tokens,
                results=results,
                timestamp=datetime.now(),
            )

        except Exception as error:
            raise PushProviderError(f"FCM Error: {str(error)}") from error

    async def send_bulk_push(
        self, requests: list[SendPushRequest]
    ) -> list[SendPushResponse]:
        """Send multiple push notifications.

        Args:
            requests: List of push send requests

        Returns:
            List of push send responses
        """
        results: list[SendPushResponse] = []
        for request in requests:
            results.append(await self.send_push(request))
        return results

    def validate_token(self, token: str) -> bool:
        """Validate a device token.

        Args:
            token: Device token to validate

        Returns:
            True if valid, False otherwise
        """
        # Basic validation - FCM tokens are non-empty strings
        return bool(token and isinstance(token, str))

    async def is_healthy(self) -> bool:
        """Check if the provider is healthy.

        Returns:
            True if healthy, False otherwise
        """
        # Hard to check without sending a test message
        return self._app is not None

    async def close(self) -> None:
        """Close the provider connection."""
        if self._app:
            firebase_admin.delete_app(self._app)
            self._app = None
