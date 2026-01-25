"""Email service orchestration."""

import asyncio
from datetime import datetime
from typing import Optional

from superfunctions.db import Adapter

from ..database import helpers as db_helpers
from ..errors import EmailProviderError, SuppressionError, TemplateError
from ..events.tracker import EventTracker
from ..models import EmailConfig, EmailTransaction, SendEmailParams
from ..suppression.manager import SuppressionManager
from .provider import EmailProvider, SendEmailRequest
from .templates import TemplateEngine, TemplateRegistry


class EmailService:
    """Email service orchestration."""

    def __init__(
        self,
        provider: EmailProvider,
        db: Adapter,
        template_engine: TemplateEngine,
        template_registry: TemplateRegistry,
        suppression_manager: SuppressionManager,
        event_tracker: EventTracker,
        config: EmailConfig,
        retry_attempts: int = 3,
        retry_delay: int = 1000,
    ) -> None:
        """Initialize the email service.

        Args:
            provider: Email provider
            db: Database adapter
            template_engine: Template engine
            template_registry: Template registry
            suppression_manager: Suppression manager
            event_tracker: Event tracker
            config: Email configuration
            retry_attempts: Number of retry attempts
            retry_delay: Delay between retries in milliseconds
        """
        self.provider = provider
        self.db = db
        self.template_engine = template_engine
        self.template_registry = template_registry
        self.suppression_manager = suppression_manager
        self.event_tracker = event_tracker
        self.config = config
        self.retry_attempts = retry_attempts
        self.retry_delay = retry_delay

    async def send_email(self, params: SendEmailParams) -> EmailTransaction:
        """Send an email.

        Args:
            params: Email send parameters

        Returns:
            Email transaction

        Raises:
            SuppressionError: If recipient is suppressed
            TemplateError: If template rendering fails
            EmailProviderError: If email sending fails
        """
        # Normalize recipients
        to_list = [params.to] if isinstance(params.to, str) else params.to
        
        # Check suppression list
        if self.suppression_manager.enabled:
            for email in to_list:
                await self.suppression_manager.check_and_raise(email)

        # Render template if templateId is provided
        subject = params.subject
        html = params.html
        text = params.text

        if params.template_id:
            template = self.template_registry.get(params.template_id)
            if not template:
                raise TemplateError(f"Template not found: {params.template_id}")

            template_data = params.template_data or {}
            
            # Validate template data
            validation = self.template_engine.validate(template, template_data)
            if not validation["valid"]:
                raise TemplateError(f"Template validation failed: {validation['errors']}")

            # Render template
            subject = self.template_engine.render(template.subject, template_data)
            html = self.template_engine.render(template.html, template_data)
            if template.text:
                text = self.template_engine.render(template.text, template_data)

        # Validate we have subject and html
        if not subject or not html:
            raise EmailProviderError("Email must have subject and html content")

        # Create email transaction (status: pending)
        transaction_data = {
            "userId": params.user_id,
            "to": to_list[0],  # Store first recipient
            "from": self.config.from_email,
            "subject": subject,
            "templateId": params.template_id,
            "templateData": params.template_data,
            "provider": self.provider.name,
            "providerMessageId": None,
            "status": "pending",
            "sentAt": None,
            "deliveredAt": None,
            "bouncedAt": None,
            "complainedAt": None,
            "metadata": params.metadata or {},
        }
        transaction = await db_helpers.create_email_transaction(self.db, transaction_data)

        # Build email request
        from_email = self.config.from_email
        if self.config.from_name:
            from_email = f"{self.config.from_name} <{self.config.from_email}>"

        request = SendEmailRequest(
            from_email=from_email,
            to=to_list,
            subject=subject,
            html=html,
            text=text,
            cc=params.cc if isinstance(params.cc, list) else ([params.cc] if params.cc else None),
            bcc=params.bcc if isinstance(params.bcc, list) else ([params.bcc] if params.bcc else None),
            attachments=params.attachments,
            reply_to=self.config.reply_to,
            tags={"userId": params.user_id} if params.tags is None else {**params.tags, "userId": params.user_id},
            metadata=params.metadata,
        )

        # Send email with retry logic
        response = await self._send_with_retry(request)

        # Update transaction based on response
        if response.success:
            transaction = await db_helpers.update_email_transaction(
                self.db,
                str(transaction.id),
                {
                    "status": "sent",
                    "providerMessageId": response.provider_message_id,
                    "sentAt": datetime.utcnow(),
                },
            )

            # Record sent event
            await self.event_tracker.record_event(
                reference_id=str(transaction.id),
                reference_type="email",
                event_type="sent",
                provider=self.provider.name,
                provider_event_id=response.provider_message_id,
                recipient_email=to_list[0],
            )
        else:
            transaction = await db_helpers.update_email_transaction(
                self.db,
                str(transaction.id),
                {
                    "status": "failed",
                    "metadata": {
                        **transaction.metadata,
                        "error": response.error,
                    },
                },
            )

            # Record failed event
            await self.event_tracker.record_event(
                reference_id=str(transaction.id),
                reference_type="email",
                event_type="failed",
                provider=self.provider.name,
                recipient_email=to_list[0],
                metadata=response.error,
            )

            raise EmailProviderError(f"Email sending failed: {response.error}")

        return transaction

    async def send_bulk_email(
        self, recipients: list[SendEmailParams]
    ) -> list[EmailTransaction]:
        """Send bulk emails.

        Args:
            recipients: List of email send parameters

        Returns:
            List of email transactions
        """
        # Send emails concurrently
        tasks = [self.send_email(params) for params in recipients]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Convert exceptions to failed transactions
        transactions = []
        for result in results:
            if isinstance(result, EmailTransaction):
                transactions.append(result)
            elif isinstance(result, Exception):
                # Log error but continue
                print(f"Bulk email error: {result}")

        return transactions

    async def get_email_status(self, transaction_id: str) -> Optional[EmailTransaction]:
        """Get email transaction status.

        Args:
            transaction_id: Transaction ID

        Returns:
            Email transaction or None
        """
        return await db_helpers.get_email_transaction(self.db, transaction_id)

    async def _send_with_retry(self, request: SendEmailRequest):
        """Send email with retry logic.

        Args:
            request: Email send request

        Returns:
            Email send response
        """
        last_error = None
        
        for attempt in range(self.retry_attempts):
            try:
                response = await self.provider.send_email(request)
                
                if response.success:
                    return response
                
                # Check if error is retryable
                if response.error and not response.error.get("retryable", False):
                    return response
                
                last_error = response.error
                
            except Exception as e:
                last_error = {"code": type(e).__name__, "message": str(e), "retryable": True}
            
            # Wait before retry (exponential backoff)
            if attempt < self.retry_attempts - 1:
                delay = (self.retry_delay / 1000) * (2 ** attempt)
                await asyncio.sleep(delay)
        
        # All retries failed
        from .provider import SendEmailResponse
        return SendEmailResponse(
            success=False,
            timestamp=datetime.utcnow(),
            error=last_error or {"code": "UnknownError", "message": "All retries failed", "retryable": False},
        )
