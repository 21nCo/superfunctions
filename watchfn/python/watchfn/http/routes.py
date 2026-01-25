from typing import List
from superfunctions.http import Route, HttpMethod
from .handlers import HttpHandlers

def create_routes(watch) -> List[Route]:
    handlers = HttpHandlers(watch)
    
    return [
        Route(
            method=HttpMethod.GET,
            path="/health",
            handler=handlers.health
        ),
        Route(
            method=HttpMethod.POST,
            path="/ingest",
            handler=handlers.ingest
        ),
        Route(
            method=HttpMethod.POST,
            path="/query",
            handler=handlers.query
        )
    ]
