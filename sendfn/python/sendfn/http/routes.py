"""HTTP routes for sendfn using superfunctions.http abstractions.

This module defines framework-agnostic HTTP routes that can be used with
any HTTP framework (FastAPI, Flask, etc.) via superfunctions adapters.
"""

from typing import Any, Dict, Optional

from superfunctions.http import (
    HttpMethod,
    Request,
    Response,
    Route,
    RouteContext,
    UnauthorizedError,
)

from ..client import Sendfn


def create_sendfn_routes(
    sendfn_client: Sendfn,
    admin_key: Optional[str] = None,
) -> list[Route]:
    """Create framework-agnostic HTTP routes for sendfn.

    Args:
        sendfn_client: Initialized Sendfn client
        admin_key: Optional admin API key for authentication

    Returns:
        List of superfunctions.http.Route objects

    Example:
        ```python
        from superfunctions_fastapi import create_router
        from sendfn import Sendfn, SendfnConfig
        from sendfn.http import create_sendfn_routes

        client = Sendfn(SendfnConfig(database=adapter))
        routes = create_sendfn_routes(client, admin_key="secret")
        router = create_router(routes, prefix="/api")
        app.include_router(router)
        ```
    """

    def verify_admin(request: Request, context: RouteContext) -> None:
        """Verify admin API key from Authorization header."""
        if not admin_key:
            return  # No auth required

        auth_header = request.headers.get("authorization", "")
        if not auth_header.startswith("Bearer "):
            raise UnauthorizedError("Missing or invalid authorization header")

        token = auth_header[7:]  # Remove "Bearer " prefix
        if token != admin_key:
            raise UnauthorizedError("Invalid API key")

    # Email endpoints
    async def send_email_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Send an email."""
        verify_admin(request, context)

        from ..models import SendEmailParams

        body = await request.json()
        params = SendEmailParams.model_validate(body)
        transaction = await sendfn_client.send_email(params)

        return Response(
            status=201,
            body=transaction.model_dump(mode="json"),
        )

    async def send_bulk_email_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Send bulk emails."""
        verify_admin(request, context)

        from ..models import SendEmailParams

        body = await request.json()
        params = [SendEmailParams.model_validate(r) for r in body]
        transactions = await sendfn_client.send_bulk_email(params)

        return Response(
            status=201,
            body={
                "transactions": [t.model_dump(mode="json") for t in transactions],
                "count": len(transactions),
            },
        )

    # SMS endpoint
    async def send_sms_handler(request: Request, context: RouteContext) -> Response:
        """Send an SMS."""
        verify_admin(request, context)

        from ..models import SendSmsParams

        body = await request.json()
        params = SendSmsParams.model_validate(body)
        transaction = await sendfn_client.send_sms(params)

        return Response(
            status=201,
            body=transaction.model_dump(mode="json"),
        )

    # Push endpoints
    async def send_push_handler(request: Request, context: RouteContext) -> Response:
        """Send a push notification."""
        verify_admin(request, context)

        from ..models import SendPushParams

        body = await request.json()
        params = SendPushParams.model_validate(body)
        notification = await sendfn_client.send_push(params)

        return Response(
            status=201,
            body=notification.model_dump(mode="json"),
        )

    async def send_bulk_push_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Send bulk push notifications."""
        verify_admin(request, context)

        from ..models import SendPushParams

        body = await request.json()
        params = [SendPushParams.model_validate(n) for n in body]
        notifications = await sendfn_client.send_bulk_push(params)

        return Response(
            status=201,
            body={
                "notifications": [n.model_dump(mode="json") for n in notifications],
                "count": len(notifications),
            },
        )

    # Device management
    async def register_device_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Register a device token."""
        verify_admin(request, context)

        from ..models import RegisterDeviceParams

        body = await request.json()
        params = RegisterDeviceParams.model_validate(body)
        device = await sendfn_client.register_device(params)

        return Response(
            status=201,
            body=device.model_dump(mode="json"),
        )

    async def get_devices_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Get device tokens for a user."""
        verify_admin(request, context)

        user_id = context.params["user_id"]
        platform = context.query.get("platform")
        devices = await sendfn_client.get_devices(user_id, platform)  # type: ignore

        return Response(
            status=200,
            body={
                "devices": [d.model_dump(mode="json") for d in devices],
                "count": len(devices),
            },
        )

    # Event endpoints
    async def get_email_events_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Get events for an email transaction."""
        verify_admin(request, context)

        transaction_id = context.params["transaction_id"]
        events = await sendfn_client.get_email_events(transaction_id)

        return Response(
            status=200,
            body={
                "events": [e.model_dump(mode="json") for e in events],
                "count": len(events),
            },
        )

    async def get_push_events_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Get events for a push notification."""
        verify_admin(request, context)

        notification_id = context.params["notification_id"]
        events = await sendfn_client.get_push_events(notification_id)

        return Response(
            status=200,
            body={
                "events": [e.model_dump(mode="json") for e in events],
                "count": len(events),
            },
        )

    async def get_sms_events_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Get events for an SMS transaction."""
        verify_admin(request, context)

        transaction_id = context.params["transaction_id"]
        events = await sendfn_client.get_sms_events(transaction_id)

        return Response(
            status=200,
            body={
                "events": [e.model_dump(mode="json") for e in events],
                "count": len(events),
            },
        )

    # Suppression endpoints
    async def check_suppression_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Check if an email is suppressed."""
        verify_admin(request, context)

        email = context.params["email"]
        result = await sendfn_client.check_suppression_list(email)

        return Response(status=200, body=result)

    async def add_to_suppression_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Add an email to the suppression list."""
        verify_admin(request, context)

        body = await request.json()
        entry = await sendfn_client.add_to_suppression_list(
            email=body["email"],
            reason=body["reason"],
            source=body.get("source", "manual"),
            bounce_type=body.get("bounceType"),
            metadata=body.get("metadata"),
        )

        return Response(status=201, body=entry.model_dump(mode="json"))

    async def remove_from_suppression_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Remove an email from the suppression list."""
        verify_admin(request, context)

        email = context.params["email"]
        await sendfn_client.remove_from_suppression_list(email)

        return Response(
            status=200, body={"message": "Email removed from suppression list"}
        )

    # Webhook endpoint
    async def aws_ses_webhook_handler(
        request: Request, context: RouteContext
    ) -> Response:
        """Handle AWS SES SNS webhook."""
        body = await request.json()
        handlers = sendfn_client.get_webhook_handlers()
        await handlers["aws_ses"].handle_webhook(body)

        return Response(status=200, body={"message": "Webhook processed"})

    # Define routes
    return [
        # Email routes
        Route(method=HttpMethod.POST, path="/email", handler=send_email_handler),
        Route(
            method=HttpMethod.POST, path="/email/bulk", handler=send_bulk_email_handler
        ),
        # SMS routes
        Route(method=HttpMethod.POST, path="/sms", handler=send_sms_handler),
        # Push routes
        Route(method=HttpMethod.POST, path="/push", handler=send_push_handler),
        Route(
            method=HttpMethod.POST, path="/push/bulk", handler=send_bulk_push_handler
        ),
        # Device routes
        Route(method=HttpMethod.POST, path="/devices", handler=register_device_handler),
        Route(
            method=HttpMethod.GET, path="/devices/{user_id}", handler=get_devices_handler
        ),
        # Event routes
        Route(
            method=HttpMethod.GET,
            path="/events/email/{transaction_id}",
            handler=get_email_events_handler,
        ),
        Route(
            method=HttpMethod.GET,
            path="/events/push/{notification_id}",
            handler=get_push_events_handler,
        ),
        Route(
            method=HttpMethod.GET,
            path="/events/sms/{transaction_id}",
            handler=get_sms_events_handler,
        ),
        # Suppression routes
        Route(
            method=HttpMethod.GET,
            path="/suppression/{email}",
            handler=check_suppression_handler,
        ),
        Route(
            method=HttpMethod.POST,
            path="/suppression",
            handler=add_to_suppression_handler,
        ),
        Route(
            method=HttpMethod.DELETE,
            path="/suppression/{email}",
            handler=remove_from_suppression_handler,
        ),
        # Webhook route (no auth)
        Route(
            method=HttpMethod.POST,
            path="/webhooks/aws-ses",
            handler=aws_ses_webhook_handler,
        ),
    ]
