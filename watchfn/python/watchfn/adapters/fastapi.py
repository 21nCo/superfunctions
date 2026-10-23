"""FastAPI adapter for WatchFn."""

from typing import Optional
from fastapi import FastAPI, Request, Response
from superfunctions_fastapi import create_router
from ..client import WatchFn
from ..http.routes import create_routes
import time


def create_fastapi_router(watch_fn: WatchFn, prefix: str = "/watch"):
    """Create FastAPI router for WatchFn."""
    routes = create_routes(watch_fn)
    return create_router(routes, prefix=prefix)


def create_fastapi_middleware(watch_fn: WatchFn):
    """Create FastAPI middleware for automatic request tracking."""
    
    async def middleware(request: Request, call_next):
        start_time = time.time()
        request_id = f"req_{int(time.time() * 1000)}_{id(request)}"
        
        # Store in request state
        request.state.watch_fn_start_time = start_time
        request.state.watch_fn_request_id = request_id
        
        try:
            response = await call_next(request)
            duration = (time.time() - start_time) * 1000  # Convert to ms
            
            watch_fn.track("http.request", {
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration": duration,
                "request_id": request_id,
                "user_agent": request.headers.get("user-agent"),
                "ip": request.client.host if request.client else None,
            })
            
            return response
        except Exception as e:
            duration = (time.time() - start_time) * 1000
            
            watch_fn.capture_exception(e, {
                "method": request.method,
                "path": request.url.path,
                "duration": duration,
                "request_id": request_id,
            })
            raise
    
    return middleware


def register_watch_fn(app: FastAPI, watch_fn: WatchFn, prefix: str = "/watch", track_requests: bool = True):
    """Register WatchFn with FastAPI app."""
    # Add middleware for tracking
    if track_requests:
        app.middleware("http")(create_fastapi_middleware(watch_fn))
    
    # Mount WatchFn routes
    router = create_fastapi_router(watch_fn, prefix)
    app.include_router(router)
