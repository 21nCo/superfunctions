"""FastAPI adapter for PlugFn."""

from typing import Any, Optional

try:
    from fastapi import APIRouter, Request, Response, HTTPException, Depends
    from fastapi.responses import JSONResponse
except ImportError:
    raise ImportError(
        "FastAPI is required for this adapter. Install it with: pip install plugfn[fastapi]"
    )


def mount_plugfn(
    app: Any,
    plug: Any,
    prefix: str = "/api/plugfn",
    auth: Optional[Any] = None,
) -> APIRouter:
    """Mount PlugFn routes to a FastAPI app.

    Args:
        app: FastAPI app instance
        plug: PlugFn instance
        prefix: URL prefix for PlugFn routes
        auth: Optional auth dependency

    Returns:
        FastAPI router with PlugFn routes

    Example:
        >>> from fastapi import FastAPI
        >>> from plugfn.adapters.fastapi import mount_plugfn
        >>>
        >>> app = FastAPI()
        >>> mount_plugfn(app, plug, prefix="/api/plugfn")
    """
    router = APIRouter(prefix=prefix, tags=["plugfn"])

    # OAuth authorization URL endpoint
    @router.get("/auth/{provider}")
    async def get_auth_url(
        provider: str,
        redirect_uri: str,
        user_id: Optional[str] = None,
        scopes: Optional[str] = None,
    ):
        """Get OAuth authorization URL for a provider."""
        try:
            # If user_id not provided, get from auth
            if not user_id and auth:
                user_id = await auth(request)

            scope_list = scopes.split(",") if scopes else None

            url = await plug.connections.get_auth_url(
                provider=provider,
                user_id=user_id,
                redirect_uri=redirect_uri,
                scopes=scope_list,
            )

            return {"url": url}

        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    # OAuth callback endpoint
    @router.get("/auth/{provider}/callback")
    async def handle_callback(provider: str, code: str, state: str):
        """Handle OAuth callback."""
        try:
            connection = await plug.connections.handle_callback(
                provider=provider, code=code, state=state
            )

            return {
                "success": True,
                "connection": {
                    "id": connection.id,
                    "provider": connection.provider,
                    "status": connection.status,
                },
            }

        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    # List connections
    @router.get("/connections")
    async def list_connections(
        provider: Optional[str] = None,
        user_id: Optional[str] = None,
    ):
        """List user connections."""
        try:
            if not user_id and auth:
                # Get user_id from auth
                pass

            connections = await plug.connections.list(
                user_id=user_id, provider=provider
            )

            return {
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

        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Disconnect
    @router.delete("/connections/{connection_id}")
    async def disconnect(connection_id: str, user_id: Optional[str] = None):
        """Disconnect a connection."""
        try:
            if not user_id and auth:
                # Get user_id from auth
                pass

            await plug.connections.disconnect(
                connection_id=connection_id, user_id=user_id
            )

            return {"success": True}

        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Webhook endpoint
    @router.post("/webhooks/{provider}/{event}")
    async def handle_webhook(provider: str, event: str, request: Request):
        """Handle incoming webhook."""
        try:
            payload = await request.json()
            headers = dict(request.headers)

            results = await plug.webhooks.handle(
                provider=provider, event=event, payload=payload, headers=headers
            )

            return {"success": True, "results": results}

        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    # List providers
    @router.get("/providers")
    async def list_providers():
        """List available providers."""
        try:
            providers = plug.providers.list()

            return {
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

        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Mount router to app
    app.include_router(router)

    return router
