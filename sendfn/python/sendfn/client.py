"""Main Sendfn client."""

from typing import Any, Optional

from superfunctions.db import Adapter

from .email.aws_ses import AwsSesProvider
from .email.service import EmailService
from .email.templates import TemplateEngine, TemplateRegistry
from .errors import SendfnError
from .events.tracker import EventTracker
from .events.webhook_handler import AwsSesWebhookHandler
from .models import (
    ApnsConfig,
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
from .push.apns import ApnsProvider
from .push.device_manager import DeviceTokenManager
from .push.fcm import FcmProvider
from .push.service import PushService
from .sms.console import ConsoleSmsProvider
from .sms.provider import SmsProvider
from .sms.service import SmsService
from .suppression.manager import SuppressionManager


class SendfnConfig:
    """Sendfn configuration."""

    def __init__(
        self,
        database: Adapter,
        email: Optional[EmailConfig] = None,
        push: Optional[PushConfig] = None,
        sms_provider: Optional[SmsProvider] = None,
        options: Optional[SendfnOptions] = None,
    ) -> None:
        """Initialize configuration.

        Args:
            database: Database adapter
            email: Email configuration
            push: Push notification configuration
            sms_provider: SMS provider instance
            options: Sendfn options
        """
        self.database = database
        self.email = email
        self.push = push
        self.sms_provider = sms_provider
        self.options = options or SendfnOptions()


class Sendfn:
    """Main Sendfn client."""

    def __init__(self, config: SendfnConfig) -> None:
        """Initialize Sendfn client.

        Args:
            config: Sendfn configuration
        """
        self.config = config
        
        # Use database adapter directly
        self.db = config.database
        
        # Initialize event tracker
        self.event_tracker = EventTracker(
            self.db,
            enabled=config.options.event_tracking if config.options else True,
        )
        
        # Initialize suppression manager
        self.suppression_manager = SuppressionManager(
            self.db,
            enabled=config.options.suppression_enabled if config.options else True,
        )
        
        # Initialize email service if configured
        self.email_service: Optional[EmailService] = None
        if config.email:
            self._initialize_email_service(config.email)
        
        # Template registry
        self.template_registry = TemplateRegistry()
        
        # Initialize device manager
        self.device_manager = DeviceTokenManager(self.db)
        
        # Initialize push service if configured
        self.push_service: Optional[PushService] = None
        if config.push:
            self._initialize_push_service(config.push)
        
        # Initialize SMS service if configured
        self.sms_service: Optional[SmsService] = None
        if config.sms_provider:
            self._initialize_sms_service(config.sms_provider)
        
        # Initialize webhook handler
        self.webhook_handler = AwsSesWebhookHandler(
            self.db,
            self.event_tracker,
            self.suppression_manager,
        )

    def _initialize_email_service(self, email_config: EmailConfig) -> None:
        """Initialize email service.

        Args:
            email_config: Email configuration
        """
        # Create email provider (AWS SES)
        if email_config.aws_ses:
            provider = AwsSesProvider(email_config.aws_ses)
        else:
            raise SendfnError("Email provider configuration required")
        
        # Create template engine
        template_engine = TemplateEngine()
        
        # Create email service
        self.email_service = EmailService(
            provider=provider,
            db=self.db,
            template_engine=template_engine,
            template_registry=self.template_registry,
            suppression_manager=self.suppression_manager,
            event_tracker=self.event_tracker,
            config=email_config,
            retry_attempts=self.config.options.retry_attempts if self.config.options else 3,
            retry_delay=self.config.options.retry_delay if self.config.options else 1000,
        )

    def _initialize_push_service(self, push_config: PushConfig) -> None:
        """Initialize push service.

        Args:
            push_config: Push notification configuration
        """
        providers: dict[Platform, Any] = {}
        
        # Initialize FCM if configured
        if "fcm" in push_config.providers:
            fcm_config = push_config.providers["fcm"]
            if isinstance(fcm_config, FcmConfig):
                fcm_provider = FcmProvider(fcm_config)
                providers["android"] = fcm_provider
                providers["web"] = fcm_provider
        
        # Initialize APNS if configured
        if "apns" in push_config.providers:
            apns_config = push_config.providers["apns"]
            if isinstance(apns_config, ApnsConfig):
                providers["ios"] = ApnsProvider(apns_config)
        
        # Create push service
        self.push_service = PushService(
            providers=providers,
            db=self.db,
            device_manager=self.device_manager,
        )

    def _initialize_sms_service(self, sms_provider: SmsProvider) -> None:
        """Initialize SMS service.

        Args:
            sms_provider: SMS provider instance
        """
        self.sms_service = SmsService(
            provider=sms_provider,
            db=self.db,
        )

    # --- Email Methods ---

    async def send_email(self, params: SendEmailParams) -> EmailTransaction:
        """Send an email.

        Args:
            params: Email send parameters

        Returns:
            Email transaction

        Raises:
            SendfnError: If email service is not configured
        """
        if not self.email_service:
            raise SendfnError("Email service not configured")
        
        return await self.email_service.send_email(params)

    async def send_bulk_email(
        self, recipients: list[SendEmailParams]
    ) -> list[EmailTransaction]:
        """Send bulk emails.

        Args:
            recipients: List of email send parameters

        Returns:
            List of email transactions
        """
        if not self.email_service:
            raise SendfnError("Email service not configured")
        
        return await self.email_service.send_bulk_email(recipients)

    # --- SMS Methods ---

    async def send_sms(self, params: SendSmsParams) -> SmsTransaction:
        """Send an SMS.

        Args:
            params: SMS send parameters

        Returns:
            SMS transaction

        Raises:
            SendfnError: If SMS service is not configured
        """
        if not self.sms_service:
            raise SendfnError("SMS service not configured")
        
        return await self.sms_service.send_sms(params)

    # --- Push Methods ---

    async def send_push(self, params: SendPushParams) -> PushNotification:
        """Send a push notification.

        Args:
            params: Push send parameters

        Returns:
            Push notification

        Raises:
            SendfnError: If push service is not configured
        """
        if not self.push_service:
            raise SendfnError("Push service not configured")
        
        return await self.push_service.send_push(params)

    async def send_bulk_push(
        self, notifications: list[SendPushParams]
    ) -> list[PushNotification]:
        """Send bulk push notifications.

        Args:
            notifications: List of push send parameters

        Returns:
            List of push notifications

        Raises:
            SendfnError: If push service is not configured
        """
        if not self.push_service:
            raise SendfnError("Push service not configured")
        
        return await self.push_service.send_bulk_push(notifications)

    # --- Device Management ---

    async def register_device(self, params: RegisterDeviceParams) -> DeviceToken:
        """Register a device token.

        Args:
            params: Device registration parameters

        Returns:
            Device token
        """
        return await self.device_manager.register_device(params)

    async def get_devices(
        self, user_id: str, platform: Optional[Platform] = None
    ) -> list[DeviceToken]:
        """Get device tokens for a user.

        Args:
            user_id: User ID
            platform: Optional platform filter

        Returns:
            List of device tokens
        """
        return await self.device_manager.get_active_devices(user_id, platform)

    async def deactivate_device(self, token: str) -> None:
        """Deactivate a device token.

        Args:
            token: Device token
        """
        await self.device_manager.deactivate_tokens([token])

    # --- Template Management ---

    async def register_template(self, template: EmailTemplate) -> None:
        """Register an email template.

        Args:
            template: Email template
        """
        self.template_registry.register(template)

    async def get_template(self, template_id: str) -> Optional[EmailTemplate]:
        """Get an email template by ID.

        Args:
            template_id: Template ID

        Returns:
            Email template or None
        """
        return self.template_registry.get(template_id)

    async def list_templates(self) -> list[EmailTemplate]:
        """List all registered templates.

        Returns:
            List of email templates
        """
        return self.template_registry.list()

    # --- Event Queries ---

    async def get_email_events(self, transaction_id: str) -> list[CommunicationEvent]:
        """Get events for an email transaction.

        Args:
            transaction_id: Email transaction ID

        Returns:
            List of communication events
        """
        return await self.event_tracker.get_events_by_reference(transaction_id, "email")

    async def get_push_events(self, notification_id: str) -> list[CommunicationEvent]:
        """Get events for a push notification.

        Args:
            notification_id: Push notification ID

        Returns:
            List of communication events
        """
        return await self.event_tracker.get_events_by_reference(notification_id, "push")

    async def get_sms_events(self, transaction_id: str) -> list[CommunicationEvent]:
        """Get events for an SMS transaction.

        Args:
            transaction_id: SMS transaction ID

        Returns:
            List of communication events
        """
        return await self.event_tracker.get_events_by_reference(transaction_id, "sms")

    # --- Suppression Management ---

    async def check_suppression_list(self, email: str) -> dict:
        """Check if an email is suppressed.

        Args:
            email: Email address

        Returns:
            Dictionary with suppression status and entry
        """
        is_suppressed = await self.suppression_manager.is_suppressed(email)
        entry = None
        if is_suppressed:
            entry = await self.suppression_manager.get_suppression_entry(email)
        
        return {
            "suppressed": is_suppressed,
            "entry": entry,
        }

    async def add_to_suppression_list(
        self,
        email: str,
        reason: str,
        source: str = "manual",
        bounce_type: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> SuppressionList:
        """Add an email to the suppression list.

        Args:
            email: Email address
            reason: Suppression reason
            source: Source of suppression
            bounce_type: Type of bounce
            metadata: Additional metadata

        Returns:
            Suppression list entry
        """
        return await self.suppression_manager.add_to_suppression_list(
            email=email,
            reason=reason,  # type: ignore
            source=source,
            bounce_type=bounce_type,
            metadata=metadata,
        )

    async def remove_from_suppression_list(self, email: str) -> None:
        """Remove an email from the suppression list.

        Args:
            email: Email address
        """
        await self.suppression_manager.remove_from_suppression_list(email)

    # --- Webhook Handlers ---

    def get_webhook_handlers(self) -> dict[str, AwsSesWebhookHandler]:
        """Get webhook handlers.

        Returns:
            Dictionary of webhook handlers
        """
        return {
            "aws_ses": self.webhook_handler,
        }


def create_sendfn(config: SendfnConfig) -> Sendfn:
    """Create a Sendfn client instance.

    Args:
        config: Sendfn configuration

    Returns:
        Sendfn client instance
    """
    return Sendfn(config)
