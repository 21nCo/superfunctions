"""AWS SES webhook handler for processing SES notifications."""

from datetime import datetime
from typing import Any, Optional

from superfunctions.db import Adapter

from ..suppression.manager import SuppressionManager
from .tracker import EventTracker


class AwsSesWebhookHandler:
    """Handler for AWS SES SNS webhook notifications."""

    def __init__(
        self,
        db: Adapter,
        event_tracker: EventTracker,
        suppression_manager: SuppressionManager,
    ) -> None:
        """Initialize webhook handler.

        Args:
            db: Database adapter
            event_tracker: Event tracker instance
            suppression_manager: Suppression manager instance
        """
        self.db = db
        self.event_tracker = event_tracker
        self.suppression_manager = suppression_manager

    async def handle_webhook(self, sns_message: dict[str, Any]) -> None:
        """Handle an AWS SES SNS notification.

        Args:
            sns_message: SNS message body
        """
        # Parse message type from SNS
        message_type = sns_message.get("Type")

        if message_type != "Notification":
            # Subscription confirmation or other type
            return

        # Get the actual SES message from the notification
        import json

        try:
            message_str = sns_message.get("Message", "{}")
            message = json.loads(message_str)
        except json.JSONDecodeError:
            # Invalid JSON in message
            return

        # Get notification type
        notification_type = message.get("notificationType") or message.get("eventType")

        if not notification_type:
            return

        # Route to appropriate handler
        notification_type_lower = notification_type.lower()

        if notification_type_lower == "bounce":
            await self._handle_bounce(message)
        elif notification_type_lower == "complaint":
            await self._handle_complaint(message)
        elif notification_type_lower == "delivery":
            await self._handle_delivery(message)
        elif notification_type_lower == "send":
            await self._handle_send(message)
        elif notification_type_lower in ["open", "click"]:
            await self._handle_tracking_event(message, notification_type_lower)

    async def _handle_bounce(self, message: dict[str, Any]) -> None:
        """Handle bounce notification.

        Args:
            message: SES bounce message
        """
        bounce = message.get("bounce", {})
        mail = message.get("mail", {})

        bounce_type = bounce.get("bounceType", "")
        bounced_recipients = bounce.get("bouncedRecipients", [])

        # Update email transaction if message ID is available
        message_id = mail.get("messageId")
        if message_id:
            from ..database.helpers import get_email_transaction, update_email_transaction

            # Find transaction by provider message ID
            # Note: This would require a helper to find by providerMessageId
            # For now, we'll just record the event

        # Add permanent bounces to suppression list
        if bounce_type == "Permanent":
            for recipient in bounced_recipients:
                email = recipient.get("emailAddress")
                if email:
                    await self.suppression_manager.add_to_suppression_list(
                        email=email,
                        reason="bounce",
                        source="aws-ses",
                        bounce_type="permanent",
                        metadata={
                            "diagnosticCode": recipient.get("diagnosticCode"),
                            "status": recipient.get("status"),
                        },
                    )

        # Record bounce events for each recipient
        for recipient in bounced_recipients:
            email = recipient.get("emailAddress")
            if email and message_id:
                await self.event_tracker.record_event(
                    reference_id=message_id,
                    reference_type="email",
                    event_type="bounced",
                    provider="aws-ses",
                    provider_event_id=message.get("bounce", {}).get("feedbackId"),
                    recipient_email=email,
                    metadata={
                        "bounceType": bounce_type,
                        "bounceSubType": bounce.get("bounceSubType"),
                        "diagnosticCode": recipient.get("diagnosticCode"),
                    },
                )

    async def _handle_complaint(self, message: dict[str, Any]) -> None:
        """Handle complaint notification.

        Args:
            message: SES complaint message
        """
        complaint = message.get("complaint", {})
        mail = message.get("mail", {})
        message_id = mail.get("messageId")

        complained_recipients = complaint.get("complainedRecipients", [])

        # Add to suppression list
        for recipient in complained_recipients:
            email = recipient.get("emailAddress")
            if email:
                await self.suppression_manager.add_to_suppression_list(
                    email=email,
                    reason="complaint",
                    source="aws-ses",
                    metadata={
                        "complaintFeedbackType": complaint.get("complaintFeedbackType"),
                        "userAgent": complaint.get("userAgent"),
                    },
                )

        # Record complaint events
        for recipient in complained_recipients:
            email = recipient.get("emailAddress")
            if email and message_id:
                await self.event_tracker.record_event(
                    reference_id=message_id,
                    reference_type="email",
                    event_type="complained",
                    provider="aws-ses",
                    provider_event_id=complaint.get("feedbackId"),
                    recipient_email=email,
                    metadata={
                        "complaintFeedbackType": complaint.get("complaintFeedbackType"),
                        "complaintSubType": complaint.get("complaintSubType"),
                    },
                )

    async def _handle_delivery(self, message: dict[str, Any]) -> None:
        """Handle delivery notification.

        Args:
            message: SES delivery message
        """
        delivery = message.get("delivery", {})
        mail = message.get("mail", {})
        message_id = mail.get("messageId")

        recipients = delivery.get("recipients", [])

        # Record delivery events
        for email in recipients:
            if message_id:
                await self.event_tracker.record_event(
                    reference_id=message_id,
                    reference_type="email",
                    event_type="delivered",
                    provider="aws-ses",
                    provider_event_id=None,
                    recipient_email=email,
                    metadata={
                        "processingTimeMillis": delivery.get("processingTimeMillis"),
                        "smtpResponse": delivery.get("smtpResponse"),
                    },
                )

    async def _handle_send(self, message: dict[str, Any]) -> None:
        """Handle send notification.

        Args:
            message: SES send message
        """
        send = message.get("send", {})
        mail = message.get("mail", {})
        message_id = mail.get("messageId")
        destination = mail.get("destination", [])

        # Record send events
        for email in destination:
            if message_id:
                await self.event_tracker.record_event(
                    reference_id=message_id,
                    reference_type="email",
                    event_type="sent",
                    provider="aws-ses",
                    provider_event_id=None,
                    recipient_email=email,
                    metadata={},
                )

    async def _handle_tracking_event(
        self, message: dict[str, Any], event_type: str
    ) -> None:
        """Handle open/click tracking events.

        Args:
            message: SES tracking message
            event_type: 'open' or 'click'
        """
        event_data = message.get(event_type, {})
        mail = message.get("mail", {})
        message_id = mail.get("messageId")

        # Get IP address and user agent
        ip_address = event_data.get("ipAddress")
        user_agent = event_data.get("userAgent")
        link = event_data.get("link") if event_type == "click" else None

        # SES doesn't provide recipient email in tracking events
        # We would need to look it up from the transaction
        if message_id:
            await self.event_tracker.record_event(
                reference_id=message_id,
                reference_type="email",
                event_type="opened" if event_type == "open" else "clicked",
                provider="aws-ses",
                provider_event_id=None,
                recipient_email=None,  # Not provided by SES
                metadata={
                    "ipAddress": ip_address,
                    "userAgent": user_agent,
                    "link": link,
                },
            )
