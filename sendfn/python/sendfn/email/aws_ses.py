"""AWS SES email provider implementation."""

import asyncio
import re
from copy import deepcopy
from datetime import datetime
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Callable, Optional

from ..errors import EmailProviderError
from ..models import AwsSesConfig
from .provider import (
    EmailProviderCapabilities,
    SendEmailRequest,
    SendEmailResponse,
    decode_attachment_content,
)


class AwsSesProvider:
    """AWS SES email provider implementation."""

    def __init__(self, config: AwsSesConfig) -> None:
        """Initialize AWS SES provider.

        Args:
            config: AWS SES configuration
        """
        self.config = AwsSesConfig.model_validate(config.model_dump()).model_copy(deep=True)
        self._client: Optional[Any] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._pending: set[asyncio.Task[Any]] = set()
        self._initializing: Optional[asyncio.Task[Any]] = None
        self._closing = False
        self._close_task: Optional[asyncio.Task[None]] = None
        self._capabilities = EmailProviderCapabilities(
            supports_templates=False,
            supports_attachments=True,
            supports_bulk_send=True,
            supports_scheduling=False,
            max_recipients_per_email=50,
            max_attachment_size=10 * 1024 * 1024,
        )

    @property
    def name(self) -> str:
        """Provider name."""
        return "aws-ses"

    @property
    def capabilities(self) -> EmailProviderCapabilities:
        """Provider capabilities."""
        return self._capabilities

    def _assert_loop(self) -> None:
        loop = asyncio.get_running_loop()
        if self._loop is None:
            self._loop = loop
        elif self._loop is not loop:
            raise EmailProviderError(
                "AWS SES provider must remain on its owning event loop", retryable=False
            )

    @property
    def pending_operations(self) -> int:
        """SDK operations still owned, including those whose callers cancelled."""
        return len(self._pending)

    @staticmethod
    def _consume_error(task: asyncio.Task[Any]) -> None:
        if not task.cancelled():
            task.exception()  # Preserve await semantics without detached-error logging.

    def _start_work(self, operation: Callable[..., Any], **kwargs: Any) -> asyncio.Task[Any]:
        self._assert_loop()
        if self._closing:
            raise EmailProviderError("AWS SES provider is closing", retryable=False)
        task = asyncio.create_task(asyncio.to_thread(operation, **kwargs))
        self._pending.add(task)

        def completed(result: asyncio.Task[Any]) -> None:
            self._pending.discard(result)
            self._consume_error(result)

        task.add_done_callback(completed)
        return task

    def _create_client(self) -> Any:
        try:
            import boto3
            from botocore.config import Config
        except ImportError as error:
            raise EmailProviderError(
                "boto3 is required for AWS SES. Install with: pip install boto3"
            ) from error
        return boto3.client(
            "ses",
            aws_access_key_id=self.config.access_key_id,
            aws_secret_access_key=self.config.secret_access_key,
            region_name=self.config.region,
            endpoint_url=self.config.endpoint_url,
            config=Config(
                connect_timeout=self.config.connect_timeout,
                read_timeout=self.config.read_timeout,
                retries={"total_max_attempts": 1, "mode": "standard"},
            ),
        )

    async def initialize(self) -> None:
        """Create one tracked client; cancellation does not abandon construction."""
        self._assert_loop()
        if self._closing:
            raise EmailProviderError("AWS SES provider is closing", retryable=False)
        if self._client is not None:
            return
        if (
            self._initializing is not None
            and self._initializing.done()
            and not self._initializing.cancelled()
            and self._initializing.exception() is not None
        ):
            # Only a fully settled construction failure can be retried. Caller
            # cancellation leaves the shielded construction owned and reusable.
            self._initializing = None
        if self._initializing is None:
            self._initializing = self._start_work(self._create_client)
        client = await asyncio.shield(self._initializing)
        if self._closing:
            raise EmailProviderError("AWS SES provider is closing", retryable=False)
        self._client = client

    async def _invoke(self, operation: str, **kwargs: Any) -> Any:
        client = self._client
        if client is None:
            raise EmailProviderError("AWS SES provider is not initialized")
        return await asyncio.shield(self._start_work(getattr(client, operation), **kwargs))

    async def send_email(self, request: SendEmailRequest) -> SendEmailResponse:
        """Send a single email via AWS SES.

        Args:
            request: Email send request

        Returns:
            Email send response
        """
        request = deepcopy(request)
        await self.initialize()

        try:
            # If there are attachments, use raw email
            if request.attachments:
                return await self._send_raw_email(request)
            else:
                return await self._send_simple_email(request)
        except Exception as e:
            return SendEmailResponse(
                success=False,
                timestamp=datetime.utcnow(),
                error={
                    "code": self._error_code(e),
                    "message": str(e),
                    "retryable": self._is_retryable_error(e),
                },
            )

    async def send_bulk_email(self, requests: list[SendEmailRequest]) -> list[SendEmailResponse]:
        """Send multiple emails via AWS SES.

        Args:
            requests: List of email send requests

        Returns:
            List of email send responses
        """
        # AWS SES doesn't have a true bulk send API for different content
        # Send concurrently with a limit
        semaphore = asyncio.Semaphore(10)  # Max 10 concurrent sends

        async def send_with_semaphore(req: SendEmailRequest) -> SendEmailResponse:
            async with semaphore:
                return await self.send_email(req)

        responses = await asyncio.gather(
            *[send_with_semaphore(req) for req in requests],
            return_exceptions=False,
        )
        return list(responses)

    def validate_email(self, email: str) -> bool:
        """Validate an email address.

        Args:
            email: Email address to validate

        Returns:
            True if valid, False otherwise
        """
        pattern = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
        return bool(re.match(pattern, email))

    async def is_healthy(self) -> bool:
        """Check if AWS SES is healthy.

        Returns:
            True if healthy, False otherwise
        """
        if not self._client:
            return False

        try:
            # Try to get send quota as a health check
            await self._invoke("get_send_quota")
            return True
        except Exception:
            return False

    async def close(self) -> None:
        """Stop admission and drain SDK work before closing the client.

        Cancelling this await does not cancel the drain. Await close again on the
        owning loop to observe completion. Socket timeouts are not a hard overall
        deadline: DNS or a trickling peer can extend this wait.
        """
        self._assert_loop()
        if self._close_task is None:
            self._closing = True
            self._close_task = asyncio.create_task(self._drain_and_close())
            self._close_task.add_done_callback(self._consume_error)
        await asyncio.shield(self._close_task)

    async def _drain_and_close(self) -> None:
        if self._pending:
            await asyncio.gather(*tuple(self._pending), return_exceptions=True)
        client = self._client
        if client is None and self._initializing is not None:
            if not self._initializing.cancelled() and self._initializing.exception() is None:
                client = self._initializing.result()
        if client is not None:
            await asyncio.to_thread(client.close)
        self._client = None

    async def _send_simple_email(self, request: SendEmailRequest) -> SendEmailResponse:
        """Send a simple email without attachments."""
        destination = {"ToAddresses": request.to}
        if request.cc:
            destination["CcAddresses"] = request.cc
        if request.bcc:
            destination["BccAddresses"] = request.bcc

        message: dict[str, Any] = {
            "Subject": {"Data": request.subject, "Charset": "UTF-8"},
            "Body": {},
        }

        if request.html:
            message["Body"]["Html"] = {"Data": request.html, "Charset": "UTF-8"}
        if request.text:
            message["Body"]["Text"] = {"Data": request.text, "Charset": "UTF-8"}

        kwargs: dict[str, Any] = {
            "Source": request.from_email,
            "Destination": destination,
            "Message": message,
        }

        if request.reply_to:
            kwargs["ReplyToAddresses"] = [request.reply_to]

        if self.config.configuration_set_name:
            kwargs["ConfigurationSetName"] = self.config.configuration_set_name
        if request.tags:
            kwargs["Tags"] = [
                {"Name": name, "Value": value} for name, value in request.tags.items()
            ]

        response = await self._invoke("send_email", **kwargs)

        return SendEmailResponse(
            success=True,
            provider_message_id=response["MessageId"],
            timestamp=datetime.utcnow(),
        )

    async def _send_raw_email(self, request: SendEmailRequest) -> SendEmailResponse:
        """Send a raw email with attachments."""
        msg = MIMEMultipart()
        msg["Subject"] = request.subject
        msg["From"] = request.from_email
        msg["To"] = ", ".join(request.to)

        if request.cc:
            msg["Cc"] = ", ".join(request.cc)
        if request.reply_to:
            msg["Reply-To"] = request.reply_to

        # Keep alternative representations together before adding attachments.
        alternatives = MIMEMultipart("alternative")
        if request.text:
            alternatives.attach(MIMEText(request.text, "plain", "utf-8"))
        if request.html:
            alternatives.attach(MIMEText(request.html, "html", "utf-8"))
        msg.attach(alternatives)

        # Add attachments
        if request.attachments:
            for attachment in request.attachments:
                content = decode_attachment_content(attachment.content, attachment.encoding)
                part = MIMEApplication(content)
                part.add_header(
                    "Content-Disposition",
                    "attachment",
                    filename=attachment.filename,
                )
                if attachment.content_type:
                    part.set_type(attachment.content_type)
                msg.attach(part)

        # Build destinations
        destinations = request.to[:]
        if request.cc:
            destinations.extend(request.cc)
        if request.bcc:
            destinations.extend(request.bcc)

        kwargs: dict[str, Any] = {
            "Source": request.from_email,
            "Destinations": destinations,
            "RawMessage": {"Data": msg.as_string()},
        }

        if self.config.configuration_set_name:
            kwargs["ConfigurationSetName"] = self.config.configuration_set_name
        if request.tags:
            kwargs["Tags"] = [
                {"Name": name, "Value": value} for name, value in request.tags.items()
            ]

        response = await self._invoke("send_raw_email", **kwargs)

        return SendEmailResponse(
            success=True,
            provider_message_id=response["MessageId"],
            timestamp=datetime.utcnow(),
        )

    def _is_retryable_error(self, error: Exception) -> bool:
        """Check if an error is retryable.

        Args:
            error: Exception that occurred

        Returns:
            True if retryable, False otherwise
        """
        error_name = self._aws_error_name(error)
        retryable_errors = [
            "Throttling",
            "ThrottlingException",
            "ServiceUnavailable",
            "InternalFailure",
            "RequestTimeout",
        ]
        return error_name in retryable_errors

    def _aws_error_name(self, error: Exception) -> str:
        """Extract the stable AWS error code when boto-style response metadata exists."""
        response = getattr(error, "response", None)
        if isinstance(response, dict):
            error_block = response.get("Error")
            if isinstance(error_block, dict):
                code = error_block.get("Code")
                if isinstance(code, str) and code:
                    return code

        return type(error).__name__

    def _error_code(self, error: Exception) -> str:
        """Map provider exceptions to stable provider-facing codes."""
        error_name = self._aws_error_name(error)
        if error_name in {"Throttling", "ThrottlingException"}:
            return "THROTTLING"
        return error_name
