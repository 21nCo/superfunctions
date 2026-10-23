"""Flask adapter for WatchFn."""

from typing import Optional
from flask import Flask, Request, g, request
from superfunctions_flask import create_blueprint
from ..client import WatchFn
from ..http.routes import create_routes
import time


def create_flask_blueprint(watch_fn: WatchFn, prefix: str = "/watch", name: str = "watchfn"):
    """Create Flask blueprint for WatchFn."""
    routes = create_routes(watch_fn)
    return create_blueprint(routes, prefix=prefix, name=name)


def create_flask_middleware(watch_fn: WatchFn):
    """Create Flask before/after request handlers for tracking."""
    
    def before_request():
        g.watch_fn_start_time = time.time()
        g.watch_fn_request_id = f"req_{int(time.time() * 1000)}_{id(request)}"
    
    def after_request(response):
        if hasattr(g, "watch_fn_start_time"):
            duration = (time.time() - g.watch_fn_start_time) * 1000  # Convert to ms
            
            watch_fn.track("http.request", {
                "method": request.method,
                "path": request.path,
                "status_code": response.status_code,
                "duration": duration,
                "request_id": g.watch_fn_request_id,
                "user_agent": request.headers.get("User-Agent"),
                "ip": request.remote_addr,
            })
        
        return response
    
    def teardown_request(exception=None):
        if exception and hasattr(g, "watch_fn_start_time"):
            duration = (time.time() - g.watch_fn_start_time) * 1000
            
            watch_fn.capture_exception(exception, {
                "method": request.method,
                "path": request.path,
                "duration": duration,
                "request_id": g.watch_fn_request_id,
            })
    
    return before_request, after_request, teardown_request


def register_watch_fn(app: Flask, watch_fn: WatchFn, prefix: str = "/watch", track_requests: bool = True):
    """Register WatchFn with Flask app."""
    # Add middleware for tracking
    if track_requests:
        before, after, teardown = create_flask_middleware(watch_fn)
        app.before_request(before)
        app.after_request(after)
        app.teardown_request(teardown)
    
    # Register WatchFn blueprint
    blueprint = create_flask_blueprint(watch_fn, prefix)
    app.register_blueprint(blueprint)
