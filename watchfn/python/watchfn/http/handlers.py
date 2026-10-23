import json
from superfunctions.http import Request, Response, RouteContext

class HttpHandlers:
    def __init__(self, watch):
        self.watch = watch

    async def health(self, request: Request, context: RouteContext) -> Response:
        return Response(status=200, body={"status": "ok", "version": "0.1.0"})

    async def ingest(self, request: Request, context: RouteContext) -> Response:
        try:
            body = await request.json()
            if isinstance(body, list):
                for event in body:
                    self.watch.track(event.get("name"), event.get("properties"))
            else:
                self.watch.track(body.get("name"), body.get("properties"))
            
            return Response(status=200, body={"success": True})
        except Exception as e:
            return Response(status=400, body={"error": str(e)})

    async def query(self, request: Request, context: RouteContext) -> Response:
        # Placeholder for query
        return Response(status=200, body={"results": []})
