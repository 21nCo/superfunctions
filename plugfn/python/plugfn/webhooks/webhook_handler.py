"""Webhook handler for processing provider webhooks."""

import hmac
import hashlib
from typing import Any, Callable, Dict, List, Optional


class WebhookHandler:
    """Handles incoming webhooks from providers."""

    def __init__(self, provider_registry: Any, logger: Any):
        """Initialize webhook handler.

        Args:
            provider_registry: Provider registry
            logger: Logger instance
        """
        self.provider_registry = provider_registry
        self.logger = logger

        # Map of provider -> event -> handlers
        self._handlers: Dict[str, Dict[str, List[Callable]]] = {}

    def register_handler(
        self, provider: str, event: str, handler: Callable
    ) -> None:
        """Register a webhook handler.

        Args:
            provider: Provider name
            event: Event name (e.g., "issues.opened")
            handler: Async function to handle the event
        """
        if provider not in self._handlers:
            self._handlers[provider] = {}

        if event not in self._handlers[provider]:
            self._handlers[provider][event] = []

        self._handlers[provider][event].append(handler)

        self.logger.info(
            f"Registered webhook handler for {provider}.{event}",
        )

    def unregister_handler(
        self, provider: str, event: str, handler: Callable
    ) -> None:
        """Unregister a webhook handler.

        Args:
            provider: Provider name
            event: Event name
            handler: Handler function to remove
        """
        if (
            provider in self._handlers
            and event in self._handlers[provider]
            and handler in self._handlers[provider][event]
        ):
            self._handlers[provider][event].remove(handler)

            self.logger.info(
                f"Unregistered webhook handler for {provider}.{event}",
            )

    async def handle_webhook(
        self,
        provider: str,
        event: str,
        payload: Dict[str, Any],
        headers: Dict[str, str],
        secret: Optional[str] = None,
    ) -> List[Any]:
        """Handle an incoming webhook.

        Args:
            provider: Provider name
            event: Event name
            payload: Webhook payload
            headers: Request headers
            secret: Optional webhook secret for signature verification

        Returns:
            List of handler results

        Raises:
            ValueError: If signature verification fails
        """
        # Verify signature if secret provided
        if secret:
            self._verify_signature(provider, payload, headers, secret)

        # Get handlers for this event
        handlers = self._handlers.get(provider, {}).get(event, [])

        if not handlers:
            self.logger.warn(
                f"No handlers registered for {provider}.{event}",
            )
            return []

        # Execute all handlers
        import asyncio

        results = []
        for handler in handlers:
            try:
                result = await handler(payload)
                results.append(result)
            except Exception as e:
                self.logger.error(
                    f"Error in webhook handler for {provider}.{event}: {str(e)}",
                    {"error": str(e)},
                )
                results.append({"error": str(e)})

        return results

    def _verify_signature(
        self, provider: str, payload: Dict[str, Any], headers: Dict[str, str], secret: str
    ) -> None:
        """Verify webhook signature.

        Args:
            provider: Provider name
            payload: Webhook payload
            headers: Request headers
            secret: Webhook secret

        Raises:
            ValueError: If signature is invalid
        """
        # Provider-specific signature verification
        # This is a simplified example; real implementations vary by provider

        if provider == "github":
            signature_header = headers.get("x-hub-signature-256", "")
            if not signature_header:
                raise ValueError("Missing signature header")

            # Compute expected signature
            import json

            payload_bytes = json.dumps(payload).encode("utf-8")
            expected_signature = (
                "sha256="
                + hmac.new(
                    secret.encode("utf-8"), payload_bytes, hashlib.sha256
                ).hexdigest()
            )

            if not hmac.compare_digest(signature_header, expected_signature):
                raise ValueError("Invalid webhook signature")

        elif provider == "slack":
            signature_header = headers.get("x-slack-signature", "")
            timestamp = headers.get("x-slack-request-timestamp", "")

            if not signature_header or not timestamp:
                raise ValueError("Missing signature headers")

            # Verify timestamp to prevent replay attacks
            import time

            if abs(time.time() - int(timestamp)) > 60 * 5:
                raise ValueError("Request timestamp too old")

            # Compute expected signature
            import json

            sig_basestring = f"v0:{timestamp}:{json.dumps(payload)}"
            expected_signature = (
                "v0="
                + hmac.new(
                    secret.encode("utf-8"),
                    sig_basestring.encode("utf-8"),
                    hashlib.sha256,
                ).hexdigest()
            )

            if not hmac.compare_digest(signature_header, expected_signature):
                raise ValueError("Invalid webhook signature")

        # Add more provider-specific verification as needed
