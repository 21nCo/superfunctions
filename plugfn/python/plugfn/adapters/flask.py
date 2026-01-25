"""Flask adapter for PlugFn."""

from typing import Any, Optional
import asyncio

try:
    from flask import Blueprint, request, jsonify
except ImportError:
    raise ImportError(
        "Flask is required for this adapter. Install it with: pip install plugfn[flask]"
    )


def mount_plugfn(
    app: Any,
    plug: Any,
    prefix: str = "/api/plugfn",
    auth: Optional[Any] = None,
) -> Blueprint:
    """Mount PlugFn routes to a Flask app.

    Args:
        app: Flask app instance
        plug: PlugFn instance
        prefix: URL prefix for PlugFn routes
        auth: Optional auth function

    Returns:
        Flask blueprint with PlugFn routes

    Example:
        >>> from flask import Flask
        >>> from plugfn.adapters.flask import mount_plugfn
        >>>
        >>> app = Flask(__name__)
        >>> mount_plugfn(app, plug, prefix="/api/plugfn")
    """
    bp = Blueprint("plugfn", __name__, url_prefix=prefix)

    # Helper to run async functions
    def run_async(coro):
        """Run an async coroutine in a sync context."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    # OAuth authorization URL endpoint
    @bp.route("/auth/<provider>", methods=["GET"])
    def get_auth_url(provider: str):
        """Get OAuth authorization URL for a provider."""
        try:
            redirect_uri = request.args.get("redirect_uri")
            user_id = request.args.get("user_id")
            scopes = request.args.get("scopes")

            if not redirect_uri:
                return jsonify({"error": "redirect_uri is required"}), 400

            scope_list = scopes.split(",") if scopes else None

            url = run_async(
                plug.connections.get_auth_url(
                    provider=provider,
                    user_id=user_id,
                    redirect_uri=redirect_uri,
                    scopes=scope_list,
                )
            )

            return jsonify({"url": url})

        except Exception as e:
            return jsonify({"error": str(e)}), 400

    # OAuth callback endpoint
    @bp.route("/auth/<provider>/callback", methods=["GET"])
    def handle_callback(provider: str):
        """Handle OAuth callback."""
        try:
            code = request.args.get("code")
            state = request.args.get("state")

            if not code or not state:
                return jsonify({"error": "code and state are required"}), 400

            connection = run_async(
                plug.connections.handle_callback(
                    provider=provider, code=code, state=state
                )
            )

            return jsonify(
                {
                    "success": True,
                    "connection": {
                        "id": connection.id,
                        "provider": connection.provider,
                        "status": connection.status,
                    },
                }
            )

        except Exception as e:
            return jsonify({"error": str(e)}), 400

    # List connections
    @bp.route("/connections", methods=["GET"])
    def list_connections():
        """List user connections."""
        try:
            user_id = request.args.get("user_id")
            provider = request.args.get("provider")

            connections = run_async(
                plug.connections.list(user_id=user_id, provider=provider)
            )

            return jsonify(
                {
                    "connections": [
                        {
                            "id": c.id,
                            "provider": c.provider,
                            "name": c.name,
                            "status": c.status,
                            "connected_at": c.connected_at.isoformat(),
                        }
                        for c in connections
                    ]
                }
            )

        except Exception as e:
            return jsonify({"error": str(e)}), 400

    # Disconnect
    @bp.route("/connections/<connection_id>", methods=["DELETE"])
    def disconnect(connection_id: str):
        """Disconnect a connection."""
        try:
            user_id = request.args.get("user_id")

            run_async(
                plug.connections.disconnect(
                    connection_id=connection_id, user_id=user_id
                )
            )

            return jsonify({"success": True})

        except Exception as e:
            return jsonify({"error": str(e)}), 400

    # Webhook endpoint
    @bp.route("/webhooks/<provider>/<event>", methods=["POST"])
    def handle_webhook(provider: str, event: str):
        """Handle incoming webhook."""
        try:
            payload = request.get_json()
            headers = dict(request.headers)

            results = run_async(
                plug.webhooks.handle(
                    provider=provider, event=event, payload=payload, headers=headers
                )
            )

            return jsonify({"success": True, "results": results})

        except Exception as e:
            return jsonify({"error": str(e)}), 400

    # List providers
    @bp.route("/providers", methods=["GET"])
    def list_providers():
        """List available providers."""
        try:
            providers = plug.providers.list()

            return jsonify(
                {
                    "providers": [
                        {
                            "name": p.name,
                            "display_name": p.display_name,
                            "description": p.description,
                            "auth_type": p.auth_type,
                            "version": p.version,
                        }
                        for p in providers
                    ]
                }
            )

        except Exception as e:
            return jsonify({"error": str(e)}), 400

    # Register blueprint
    app.register_blueprint(bp)

    return bp
