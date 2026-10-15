"""FastAPI adapter for BrowseFn."""

from typing import Any, Optional

try:
    from fastapi import APIRouter
    from superfunctions_fastapi import create_router
except ImportError:
    raise ImportError(
        "FastAPI and superfunctions-fastapi are required. Install with: pip install browsefn[fastapi]"
    )

from browsefn.http.router import create_browsefn_router

def mount_browsefn(
    app: Any,
    browse: Any,
    prefix: str = "/api/browsefn",
    auth: Optional[Any] = None,
) -> APIRouter:
    """Mount BrowseFn routes to a FastAPI app.

    Args:
        app: FastAPI app instance
        browse: BrowseFn instance
        prefix: URL prefix for BrowseFn routes
        auth: Optional auth dependency

    Returns:
        FastAPI router with BrowseFn routes
    """
    # Create generic routes
    routes = create_browsefn_router(browse)
    
    # Create FastAPI router from generic routes
    router = create_router(routes, prefix=prefix, tags=["browsefn"])
    
    # Mount to app
    app.include_router(router)
    
    return router
