"""Sendfn - Self-hosted communications platform SDK.

Sendfn provides email, push notifications, and SMS capabilities with:
- Email sending via AWS SES
- Push notifications via FCM (Android/Web) and APNS (iOS)
- SMS sending (with provider abstraction)
- Event tracking and webhook handling
- Suppression list management
- HTTP API (FastAPI integration)

Example:
    >>> from sendfn import Sendfn, SendfnConfig
    >>> from sendfn.database.memory import MemoryAdapter
    >>>
    >>> config = SendfnConfig(
    ...     database=MemoryAdapter(),
    ...     email=EmailConfig(
    ...         from_email="noreply@example.com",
    ...         aws_ses=AwsSesConfig(
    ...             access_key_id="...",
    ...             secret_access_key="...",
    ...             region="us-east-1"
    ...         )
    ...     )
    ... )
    >>> client = Sendfn(config)
    >>> await client.send_email(SendEmailParams(
    ...     user_id="user-123",
    ...     to="user@example.com",
    ...     subject="Hello",
    ...     html="<p>Hello World</p>"
    ... ))
"""

__version__ = "0.1.0"

from .client import Sendfn, SendfnConfig, create_sendfn
from .database.memory import MemoryAdapter
from .errors import (
    EmailProviderError,
    PushProviderError,
    SendfnError,
    SuppressionError,
    TemplateError,
)
from .models import (
    ApnsConfig,
    Attachment,
    AwsSesConfig,
    CommunicationEvent,
    DeviceToken,
    EmailConfig,
    EmailTemplate,
    EmailTransaction,
    FcmConfig,
    Platform,
    PushConfig,
    PushNotification,
    RegisterDeviceParams,
    SendEmailParams,
    SendfnOptions,
    SendPushParams,
    SendSmsParams,
    SmsTransaction,
    SuppressionList,
)

# Push providers
from .push import ApnsProvider, DeviceTokenManager, FcmProvider, PushService

# SMS providers
from .sms import ConsoleSmsProvider, SmsService

# Events and webhooks
from .events import AwsSesWebhookHandler, EventTracker

# HTTP API
from .http import create_sendfn_router, create_sendfn_routes

__all__ = [
    # Main client
    "Sendfn",
    "SendfnConfig",
    "create_sendfn",
    # Database
    "MemoryAdapter",
    # Models and types
    "ApnsConfig",
    "Attachment",
    "AwsSesConfig",
    "CommunicationEvent",
    "DeviceToken",
    "EmailConfig",
    "EmailTemplate",
    "EmailTransaction",
    "FcmConfig",
    "Platform",
    "PushConfig",
    "PushNotification",
    "RegisterDeviceParams",
    "SendEmailParams",
    "SendfnOptions",
    "SendPushParams",
    "SendSmsParams",
    "SmsTransaction",
    "SuppressionList",
    # Errors
    "SendfnError",
    "EmailProviderError",
    "PushProviderError",
    "SmsProviderError",
    "SuppressionError",
    "TemplateError",
    "DatabaseError",
    "ValidationError",
]
